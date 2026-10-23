// A provider whose OAuth sign-in can no longer be refreshed: the failure is recorded (and shown in the
// Logins list), the owner is told once per episode, bots on that provider are marked in the panel state,
// and a new sign-in or a working call clears it. Ordinary model errors are not sign-in failures.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fauxAssistantMessage, fauxText, type Models } from "@earendil-works/pi-ai";
import { adminRoutes } from "../../src/admin.ts";
import { Logins } from "../../src/core/logins.ts";
import { startServer } from "../../src/server.ts";
import type { Notification, Notifier } from "../../src/notify/notifier.ts";
import { AppDb } from "../../src/store/db.ts";
import { collect, fauxModels, tempDir, testConfig, testCore } from "../helpers.ts";

class Recorder implements Notifier {
	readonly name = "recorder";
	readonly sent: Notification[] = [];
	async send(n: Notification) {
		this.sent.push(n);
	}
}

const REFRESH = "OAuth refresh failed for faux";

/** The faux provider, presented as one that is signed in to with OAuth; `signedIn` is its stored-credential status. */
function oauthFaux(signedIn: { value: boolean }) {
	const { models, faux } = fauxModels();
	const oauth = { name: "Faux", loginLabel: "Sign in to Faux", isSubscription: true, login: async () => ({}), refresh: async () => ({}), toAuth: async () => ({}) };
	const over: Record<string, unknown> = {
		getProviders: () => [{ id: "faux", name: "Faux", auth: { oauth } }],
		getProvider: (id: string) => (id === "faux" ? { id: "faux", name: "Faux", auth: { oauth } } : undefined),
		isUsingOAuth: () => signedIn.value,
		login: async () => ({ type: "oauth" }),
	};
	const proxy = new Proxy(models, { get: (t, k, r) => (typeof k === "string" && k in over ? over[k] : Reflect.get(t, k, r)) });
	return { models: proxy as Models, faux };
}

test("only an OAuth refresh failure is a sign-in failure, and it is told once per episode", async () => {
	const told: string[] = [];
	const { models } = oauthFaux({ value: true });
	const logins = new Logins({ models, db: new AppDb(":memory:"), onNeedsSignIn: (p) => void told.push(p.name) });
	const lastError = async () => (await logins.list())[0]!.lastError;

	logins.modelOutcome({ provider: "faux", stopReason: "error", errorMessage: "429 rate limit exceeded" });
	logins.modelOutcome({ provider: "faux", stopReason: "error", errorMessage: "Provider is not configured: faux" });
	logins.modelOutcome({ provider: "faux", stopReason: "aborted", errorMessage: REFRESH });
	assert.deepEqual(told, []);

	logins.modelOutcome({ provider: "faux", stopReason: "error", errorMessage: REFRESH });
	logins.modelOutcome({ provider: "faux", stopReason: "error", errorMessage: "OAuth auth derivation failed for faux" });
	assert.deepEqual(told, ["Faux"], "the second failure of the same episode is not told again");
	assert.match((await lastError()) ?? "", /OAuth/);
	// A working call ends the episode; the next failure is told again.
	logins.modelOutcome({ provider: "faux", stopReason: "stop" });
	assert.equal(await lastError(), undefined);
	logins.modelOutcome({ provider: "faux", stopReason: "error", errorMessage: REFRESH });
	assert.deepEqual(told, ["Faux", "Faux"]);
});

test("signing in again clears the failure, and the told mark survives a restart", async () => {
	const told: string[] = [];
	const { models } = oauthFaux({ value: true });
	const db = new AppDb(":memory:");
	const make = () => new Logins({ models, db, onNeedsSignIn: (p) => void told.push(p.id) });
	let logins = make();
	logins.recordFailure("faux", REFRESH);
	logins = make();
	logins.recordFailure("faux", REFRESH);
	assert.deepEqual(told, ["faux"], "a restart does not repeat the notification");
	assert.ok(logins.signInNeeded("faux"));

	const s = logins.start("faux", "panel");
	await new Promise<void>((r) => setImmediate(r));
	assert.equal(logins.get(s.id).state, "done");
	assert.equal((await logins.list())[0]!.lastError, undefined);
	logins.recordFailure("faux", REFRESH);
	assert.deepEqual(told, ["faux", "faux"], "a fresh failure after signing in is a new episode");
});

test("a model call that fails to refresh notifies once, names the machine, and marks the bots in the panel state", async () => {
	const { dir, cleanup } = await tempDir();
	const signedIn = { value: true };
	const { models, faux } = oauthFaux(signedIn);
	const notifier = new Recorder();
	const core = await testCore(dir, { models, notifier, config: testConfig(dir) });
	const server = await startServer(core, { host: "127.0.0.1", port: 0, extraRouters: [adminRoutes(core)] });
	const state = async () => ((await (await fetch(`http://127.0.0.1:${server.port}/panel/api/state`)).json()) as { bots: { name: string; signIn?: { provider: string; name: string; reason: string } }[] }).bots;
	try {
		assert.deepEqual((await state()).map((b) => b.signIn), [undefined, undefined], "a working sign-in marks nothing");

		const s = await core.sessions.create("main");
		const c = collect(core.hub, s.id);
		for (let i = 0; i < 2; i++) {
			faux.setResponses([fauxAssistantMessage([], { stopReason: "error", errorMessage: REFRESH })]);
			await core.sessions.submit(s.id, `try ${i}`);
			await c.until((e) => e.type === "run.finished" && c.events.filter((x) => x.type === "run.finished").length === i + 1);
		}
		assert.equal(notifier.sent.length, 1);
		assert.equal(notifier.sent[0]!.message, `Faux on ${core.members.self().name} needs signing in again. Open the panel's Logins tab.`);
		const marked = await state();
		assert.deepEqual(marked.map((b) => b.signIn), [{ provider: "faux", name: "Faux", reason: "needs signing in again" }, { provider: "faux", name: "Faux", reason: "needs signing in again" }]);

		// An ordinary error on the same provider changes nothing; a working call clears the mark.
		faux.setResponses([fauxAssistantMessage([fauxText("fine")])]);
		await core.sessions.submit(s.id, "again");
		await c.until((e) => e.type === "run.finished" && c.events.filter((x) => x.type === "run.finished").length === 3);
		assert.deepEqual((await state()).map((b) => b.signIn), [undefined, undefined]);

		// Not signed in at all is marked too, without any failure.
		signedIn.value = false;
		assert.equal((await state())[0]!.signIn?.reason, "not signed in");
	} finally {
		await server.close();
		await core.close();
		await cleanup();
	}
});
