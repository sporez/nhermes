// Notifications a member raises on its own reach a member that has a transport; one that has its own never
// forwards, and a network where nobody can deliver fails instead of looping.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import type { Core, LateServices } from "../../src/app.ts";
import { type HermesServer, startHermesServer } from "../../src/hermes/server.ts";
import { type Notification, type Notifier, NotifyError } from "../../src/notify/notifier.ts";
import { scheduleFeature } from "../../src/tools/schedule.ts";
import { tempDir, testConfig, testCore } from "../helpers.ts";

type Gw = { core: Core; server: HermesServer; sent: Notification[] };

class Recorder implements Notifier {
	readonly name = "recorder";
	readonly sent: Notification[] = [];
	async send(n: Notification): Promise<void> {
		this.sent.push(n);
	}
}

/** `transport` gives the gateway a local notifier; without it the gateway has none. */
async function gateway(dir: string, name: string, bot: string, transport: boolean): Promise<Gw> {
	const d = join(dir, name);
	const rec = new Recorder();
	const core = await testCore(d, { ...(transport ? { notifier: rec } : {}), config: testConfig(d, [{ name: bot, default: true }], { node: { name } }) });
	const server = await startHermesServer(core, { host: "127.0.0.1", port: 0 });
	return { core, server, sent: rec.sent };
}

async function pair(a: Gw, b: Gw): Promise<void> {
	const { code } = a.core.members.invite();
	await b.core.members.join(code);
	await a.core.roster.sync();
	await b.core.roster.sync();
}

test("a gateway with no transport forwards to a member that has one", async () => {
	const { dir, cleanup } = await tempDir();
	const a = await gateway(dir, "alpha", "main", true);
	const b = await gateway(dir, "beta", "chamber", false);
	try {
		await pair(a, b);
		assert.equal(b.core.notifier.name, "network");
		await b.core.notifier.send({ title: "Done", message: "all good", priority: 1, sessionId: "beta-session", bot: "chamber" });
		assert.equal(a.sent.length, 1);
		const got = a.sent[0]!;
		assert.deepEqual([got.title, got.message, got.priority, got.bot], ["Done", "all good", 1, "chamber-beta"]);
		assert.equal(got.sessionId, undefined);
	} finally {
		await a.server.close();
		await b.server.close();
		await cleanup();
	}
});

test("members with no transport answer 409 and the send fails without looping", async () => {
	const { dir, cleanup } = await tempDir();
	const a = await gateway(dir, "alpha", "main", false);
	const b = await gateway(dir, "beta", "chamber", false);
	try {
		await pair(a, b);
		await assert.rejects(b.core.notifier.send({ title: "x", message: "y" }), (e: unknown) => e instanceof NotifyError && /alpha: no transport/.test(e.message));
		// The receiver used its local notifier only: it did not forward back to beta.
		assert.equal(a.core.localNotifier.name, "none");
	} finally {
		await a.server.close();
		await b.server.close();
		await cleanup();
	}
});

test("a gateway with its own transport does not forward", async () => {
	const { dir, cleanup } = await tempDir();
	const a = await gateway(dir, "alpha", "main", true);
	const b = await gateway(dir, "beta", "chamber", true);
	try {
		await pair(a, b);
		await b.core.localNotifier.send({ title: "own", message: "m" });
		assert.equal(a.sent.length, 0);
		assert.equal(b.sent.length, 1);
	} finally {
		await a.server.close();
		await b.server.close();
		await cleanup();
	}
});

test("the notify tool reports sent when forwarding is possible", async () => {
	const { dir, cleanup } = await tempDir();
	const a = await gateway(dir, "alpha", "main", true);
	const b = await gateway(dir, "beta", "chamber", false);
	const alone = await gateway(dir, "solo", "solo", false);
	try {
		await pair(a, b);
		const run = async (g: Gw) => {
			const late = { sessions: () => ({ byConversation: () => undefined }) } as unknown as LateServices;
			const tool = scheduleFeature(late, () => g.core.scheduler, () => g.core.notifier).groups?.get("notify")?.[0] as unknown as {
				execute: (a: unknown, api: unknown) => Promise<{ output: { text: string }[] }>;
			};
			return (await tool!.execute({ title: "t", message: "m" }, { conversationId: 1 })).output[0]!.text;
		};
		assert.equal(await run(b), "Notification sent.");
		assert.equal(a.sent.length, 1);
		assert.match(await run(alone), /No notification transport/);
	} finally {
		await a.server.close();
		await b.server.close();
		await alone.server.close();
		await cleanup();
	}
});
