// Provider login sessions: states, limits, prompts, redaction, cancel, timeout, logout, and the admin API.
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import type { AuthInteraction, Models } from "@earendil-works/pi-ai";
import { adminRoutes } from "../../src/admin.ts";
import { LoginError, Logins } from "../../src/core/logins.ts";
import { startServer } from "../../src/server.ts";
import { registerSecret, setLogLevel, setLogSink } from "../../src/log.ts";
import { AppDb } from "../../src/store/db.ts";
import { fauxModels, testCore, tempDir, TOKEN } from "../helpers.ts";

type Flow = (i: AuthInteraction) => Promise<unknown>;

const lines: string[] = [];
beforeEach(() => {
	lines.length = 0;
	setLogLevel("info");
	setLogSink((l) => void lines.push(l));
});
afterEach(() => {
	setLogLevel("error");
	setLogSink((l) => process.stderr.write(l + "\n"));
});

/** Lets pending promise callbacks run (no timers involved). */
const flush = () => new Promise<void>((r) => setImmediate(r));

const oauth = (name: string) => ({ name, loginLabel: `Sign in to ${name}`, isSubscription: true, login: async () => ({}), refresh: async () => ({}), toAuth: async () => ({}) });

/** Wraps real faux Models: providers, login and logout are ours; everything else is the real thing. */
function fakeModels(flows: Record<string, Flow>, status: Record<string, unknown> = {}) {
	const { models } = fauxModels();
	const calls = { login: [] as { provider: string; options: unknown }[], logout: [] as string[] };
	const providers = [
		{ id: "xai", name: "xAI", auth: { oauth: oauth("xAI") } },
		{ id: "kimi", name: "Kimi", auth: { oauth: oauth("Kimi") } },
		{ id: "a", name: "A", auth: { oauth: oauth("A") } },
		{ id: "b", name: "B", auth: { oauth: oauth("B") } },
		{ id: "c", name: "C", auth: { oauth: oauth("C") } },
		{ id: "keyonly", name: "Key only", auth: { apiKey: { name: "k" } } },
		{ id: "ambient", name: "Ambient", auth: {} },
	];
	const over: Record<string, unknown> = {
		getProviders: () => providers,
		login: async (provider: string, _type: string, interaction: AuthInteraction, options: unknown) => {
			calls.login.push({ provider, options });
			await flows[provider]!(interaction);
			return { type: "oauth" };
		},
		logout: async (provider: string) => void calls.logout.push(provider),
		...status,
	};
	const proxy = new Proxy(models, {
		get: (t, k, r) => (typeof k === "string" && k in over ? over[k] : Reflect.get(t, k, r)),
	});
	return { models: proxy as Models, calls };
}

function harness(flows: Record<string, Flow>, extra: Partial<ConstructorParameters<typeof Logins>[0]> = {}) {
	const { models, calls } = fakeModels(flows);
	const timers: { fn: () => void; ms: number; live: boolean }[] = [];
	let clock = 1_000_000;
	const logins = new Logins({
		models,
		db: new AppDb(":memory:"),
		now: () => clock,
		setTimer: (fn, ms) => {
			const t = { fn, ms, live: true };
			timers.push(t);
			return t;
		},
		clearTimer: (h) => void ((h as { live: boolean }).live = false),
		...extra,
	});
	return { logins, calls, timers, advance: (ms: number) => void (clock += ms) };
}

const deviceFlow: Flow = async (i) => {
	i.notify({ type: "device_code", userCode: "ABCD-1234", verificationUri: "https://example.com/device", expiresInSeconds: 600 });
	i.notify({ type: "progress", message: "Waiting for approval" });
	const key = await i.prompt({ type: "secret", message: "Paste the key" });
	assert.ok(key);
	const pasted = await i.prompt({ type: "manual_code", message: "Paste the address" });
	assert.ok(pasted);
};

test("a login shows its events and prompts, takes answers, and finishes", async () => {
	const { logins, calls } = harness({ xai: deviceFlow });
	const s = logins.start("xai", "cli");
	assert.equal(s.state, "prompt");
	assert.deepEqual(s.events.map((e) => e.type), ["device_code", "progress"]);
	assert.equal(s.prompt?.type, "secret");
	assert.equal(typeof (calls.login[0]!.options as { getDeviceId(): string }).getDeviceId(), "string");
	assert.equal((calls.login[0]!.options as { getDeviceId(): string }).getDeviceId(), (calls.login[0]!.options as { getDeviceId(): string }).getDeviceId());

	const secret = "sk-secret-value-0123456789";
	assert.equal(logins.answer(s.id, secret).state, "waiting");
	await flush();
	assert.equal(logins.get(s.id).state, "prompt");
	assert.equal(logins.get(s.id).prompt?.type, "manual_code");
	logins.answer(s.id, "http://127.0.0.1:1455/cb?code=abcdefgh1234");
	await flush();
	const done = logins.get(s.id);
	assert.equal(done.state, "done");
	assert.equal(done.message, "Signed in to xAI");
	assert.ok(done.finishedAt);
	assert.equal(done.prompt, undefined);
	// Neither the secret nor the pasted address is kept anywhere the session or the log can show it.
	assert.ok(!JSON.stringify(done).includes(secret));
	assert.ok(!lines.join("\n").includes(secret));
	assert.ok(lines.some((l) => l.includes("login started") && l.includes('"by":"cli"')));
});

test("a failure is reported in plain words with secrets redacted, and remembered per provider", async () => {
	registerSecret("tok-leaky-0123456789");
	const { logins } = harness({
		xai: async () => {
			throw new Error("bad response containing tok-leaky-0123456789");
		},
	});
	const s = logins.start("xai", "panel");
	await flush();
	const g = logins.get(s.id);
	assert.equal(g.state, "failed");
	assert.ok(g.message?.includes("[redacted]") && !g.message.includes("tok-leaky"));
	assert.ok(!lines.join("\n").includes("tok-leaky"));
	const xai = (await logins.list()).find((p) => p.id === "xai")!;
	assert.equal(xai.lastError, g.message);
	assert.equal(xai.open, undefined);
});

test("cancel aborts a hanging flow", async () => {
	let aborted = false;
	const { logins } = harness({
		xai: (i) =>
			new Promise((_, reject) =>
				i.signal!.addEventListener("abort", () => {
					aborted = true;
					reject(i.signal!.reason);
				}),
			),
	});
	const s = logins.start("xai", "panel");
	assert.equal(s.state, "waiting");
	assert.equal(logins.cancel(s.id).state, "cancelled");
	await flush();
	assert.equal(aborted, true);
	assert.equal(logins.get(s.id).state, "cancelled");
	assert.equal(logins.cancel(s.id).state, "cancelled");
	// A cancelled login leaves no last error behind.
	assert.equal((await logins.list()).find((p) => p.id === "xai")!.lastError, undefined);
});

test("a login that outlasts its time fails, and a device code sets the time to its expiry", async () => {
	const { logins, timers } = harness({
		xai: (i) => new Promise((_, reject) => i.signal!.addEventListener("abort", () => reject(i.signal!.reason))),
		kimi: async (i) => {
			i.notify({ type: "device_code", userCode: "WXYZ", verificationUri: "https://example.com/d", expiresInSeconds: 120 });
			await new Promise((_, reject) => i.signal!.addEventListener("abort", () => reject(i.signal!.reason)));
		},
	});
	const s = logins.start("xai", "cli");
	const first = timers.filter((t) => t.live);
	assert.equal(first.length, 1);
	assert.equal(first[0]!.ms, 10 * 60_000);
	first[0]!.fn();
	await flush();
	assert.equal(logins.get(s.id).state, "failed");
	assert.match(logins.get(s.id).message!, /timed out/i);

	const k = logins.start("kimi", "cli");
	const live = timers.filter((t) => t.live);
	assert.equal(live.length, 1);
	assert.equal(live[0]!.ms, 120_000 + 30_000);
	live[0]!.fn();
	await flush();
	assert.equal(logins.get(k.id).state, "failed");
});

test("limits: unknown and key-only providers, one per provider, four at a time", async () => {
	const hang: Flow = (i) => new Promise((_, reject) => i.signal!.addEventListener("abort", () => reject(i.signal!.reason)));
	const { logins } = harness({ xai: hang, kimi: hang, a: hang, b: hang, c: hang });
	const status = (fn: () => unknown) => {
		try {
			fn();
		} catch (error) {
			return error instanceof LoginError ? error.status : -1;
		}
		return 0;
	};
	assert.equal(status(() => logins.start("nope", "cli")), 404);
	assert.equal(status(() => logins.start("keyonly", "cli")), 400);
	assert.equal(status(() => logins.start("ambient", "cli")), 400);
	const first = logins.start("xai", "cli");
	assert.equal(status(() => logins.start("xai", "cli")), 409);
	logins.start("kimi", "cli");
	logins.start("a", "cli");
	logins.start("b", "cli");
	assert.equal(status(() => logins.start("c", "cli")), 429);
	logins.cancel(first.id);
	logins.start("c", "cli");
	assert.equal(status(() => logins.get("missing")), 404);
	assert.equal(status(() => logins.cancel("missing")), 404);
	assert.equal(status(() => logins.answer("missing", "x")), 404);
	assert.equal((await logins.list()).find((p) => p.id === "c")!.open !== undefined, true);
	logins.close();
	await flush();
});

test("answers are checked against the pending prompt", async () => {
	const { logins } = harness({
		xai: async (i) => {
			const choice = await i.prompt({ type: "select", message: "Which account?", options: [{ id: "personal", label: "Personal" }, { id: "work", label: "Work", description: "Team" }] });
			assert.equal(choice, "work");
		},
	});
	const s = logins.start("xai", "cli");
	assert.deepEqual(s.prompt?.options?.map((o) => o.id), ["personal", "work"]);
	assert.throws(() => logins.answer(s.id, "other"), (e: unknown) => e instanceof LoginError && e.status === 400);
	assert.equal(logins.get(s.id).state, "prompt");
	logins.answer(s.id, "work");
	await flush();
	assert.equal(logins.get(s.id).state, "done");
	assert.throws(() => logins.answer(s.id, "work"), (e: unknown) => e instanceof LoginError && e.status === 409);
});

test("a prompt the flow withdraws no longer waits for an answer", async () => {
	const { logins } = harness({
		xai: async (i) => {
			const ac = new AbortController();
			const pending = i.prompt({ type: "manual_code", message: "Paste", signal: ac.signal });
			ac.abort();
			await pending.catch(() => {});
		},
	});
	const s = logins.start("xai", "cli");
	await flush();
	assert.equal(logins.get(s.id).state, "done");
});

test("logout calls through, stops an open login, and unknown providers are 404", async () => {
	const hang: Flow = (i) => new Promise((_, reject) => i.signal!.addEventListener("abort", () => reject(i.signal!.reason)));
	const { logins, calls } = harness({ xai: hang });
	const s = logins.start("xai", "cli");
	assert.deepEqual(await logins.logout("xai", "cli"), { ok: true });
	assert.deepEqual(calls.logout, ["xai"]);
	await flush();
	assert.equal(logins.get(s.id).state, "cancelled");
	await assert.rejects(() => logins.logout("nope"), (e: unknown) => e instanceof LoginError && e.status === 404);
});

test("finished sessions are dropped after a while", async () => {
	const { logins, advance } = harness({ xai: async () => {} });
	const s = logins.start("xai", "cli");
	await flush();
	assert.equal(logins.get(s.id).state, "done");
	advance(9 * 60_000);
	assert.equal(logins.get(s.id).state, "done");
	advance(2 * 60_000);
	assert.throws(() => logins.get(s.id), (e: unknown) => e instanceof LoginError && e.status === 404);
});

test("the list shows login methods and a status that needs no network", async () => {
	const { models } = fakeModels({}, {
		isUsingOAuth: (id: string) => id === "xai",
		getProviderAuthStatus: (id: string) => (id === "keyonly" ? { configured: true, source: "environment", label: "KEY_ENV" } : { configured: false }),
	});
	const logins = new Logins({ models, db: new AppDb(":memory:") });
	const list = await logins.list();
	assert.deepEqual(list.map((p) => p.id), ["xai", "kimi", "a", "b", "c", "keyonly"]);
	const by = new Map(list.map((p) => [p.id, p]));
	assert.deepEqual(by.get("xai")!.status, { kind: "oauth", expires: undefined });
	assert.deepEqual(by.get("xai")!.oauth, { label: "Sign in to xAI", subscription: true });
	assert.deepEqual(by.get("keyonly")!.status, { kind: "key", source: "KEY_ENV" });
	assert.equal(by.get("keyonly")!.apiKey, true);
	assert.equal(by.get("keyonly")!.oauth, null);
	assert.deepEqual(by.get("kimi")!.status, { kind: "none" });
});

test("the admin API starts, answers, reads, cancels and logs out", async () => {
	const { dir, cleanup } = await tempDir();
	const { models, calls } = fakeModels({
		xai: async (i) => {
			i.notify({ type: "auth_url", url: "https://example.com/auth", instructions: "Open it" });
			await i.prompt({ type: "manual_code", message: "Paste the address" });
		},
		kimi: (i) => new Promise((_, reject) => i.signal!.addEventListener("abort", () => reject(i.signal!.reason))),
	});
	const core = await testCore(dir, { models });
	const server = await startServer(core, { host: "127.0.0.1", port: 0, extraRouters: [adminRoutes(core)] });
	const call = async (method: string, path: string, body?: unknown) => {
		const res = await fetch(`http://127.0.0.1:${server.port}${path}`, { method, headers: { "X-Hermes-Session-Token": TOKEN, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
		return { status: res.status, json: (await res.json()) as Record<string, any> };
	};
	try {
		assert.equal((await call("GET", "/admin/logins")).json.providers.length, 6);
		assert.equal((await call("POST", "/admin/logins", {})).status, 400);
		assert.equal((await call("POST", "/admin/logins", { provider: "nope" })).status, 404);
		const started = await call("POST", "/admin/logins", { provider: "xai" });
		assert.equal(started.status, 200);
		assert.equal(started.json.state, "prompt");
		assert.equal((await call("POST", "/admin/logins", { provider: "xai" })).status, 409);
		assert.equal((await call("POST", `/admin/logins/${started.json.id}/answer`, {})).status, 400);
		assert.equal((await call("POST", `/admin/logins/${started.json.id}/answer`, { value: "http://127.0.0.1:1/cb?code=abcdefgh" })).status, 200);
		await flush();
		assert.equal((await call("GET", `/admin/logins/${started.json.id}`)).json.state, "done");
		assert.equal((await call("GET", "/admin/logins/missing")).status, 404);
		const k = await call("POST", "/admin/logins", { provider: "kimi" });
		assert.equal((await call("DELETE", `/admin/logins/${k.json.id}`)).json.state, "cancelled");
		assert.equal((await call("DELETE", "/admin/logins/providers/xai")).status, 200);
		assert.deepEqual(calls.logout, ["xai"]);
		assert.equal((await call("DELETE", "/admin/logins/providers/nope")).status, 404);
	} finally {
		await server.close();
		await core.close();
		await cleanup();
	}
});
