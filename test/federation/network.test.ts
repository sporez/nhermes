// The network's bots: a member's shareable bots appear on the others as `<bot>-<node>`, delegation
// reaches them with the pair secret (approvals asked in the chat that started it, and never trusted on
// the owning machine), a member's WebSocket stays within its own chats, and an offline member is
// reported as offline.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { Core } from "../../src/app.ts";
import type { BotConfig } from "../../src/config.ts";
import { federationAdminRoutes } from "../../src/federation/routes.ts";
import { type HermesServer, startHermesServer } from "../../src/hermes/server.ts";
import { HermesClient } from "../hermes/client.ts";
import { collect, tempDir, testConfig, testCore } from "../helpers.ts";

type Gw = { core: Core; server: HermesServer; faux: ReturnType<typeof fauxProvider>; port: number };

async function gateway(dir: string, name: string, bots: BotConfig[]): Promise<Gw> {
	const d = join(dir, name);
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }], tokensPerSecond: 500 });
	const models = createModels();
	models.setProvider(faux.provider);
	const core = await testCore(d, { models, config: testConfig(d, bots, { node: { name } }) });
	const server = await startHermesServer(core, { host: "127.0.0.1", port: 0, extraRouters: [federationAdminRoutes(core)] });
	return { core, server, faux, port: server.port };
}

async function link(a: Gw, b: Gw): Promise<void> {
	const { code } = a.core.members.invite();
	await b.core.members.join(code);
	await Promise.all([a.core.roster.sync(), b.core.roster.sync()]);
}

test("a member's bots are delegated to with approvals in the caller's chat and no trust carried over", async () => {
	const { dir, cleanup } = await tempDir();
	const a = await gateway(dir, "alpha", [{ name: "main", default: true, description: "Home assistant" }]);
	const b = await gateway(dir, "beta", [
		{ name: "nasbot", default: true, description: "Runs on the NAS", trusted: true },
		{ name: "vault", description: "Keeps secrets", private: true },
	]);
	try {
		await link(a, b);
		assert.deepEqual(a.core.bots.names(), ["main", "nasbot-beta"]);
		assert.deepEqual(b.core.bots.names(), ["nasbot", "vault", "main-alpha"]);
		const remote = a.core.bots.get("nasbot-beta")!;
		assert.equal(remote.displayName, "Nasbot (beta)");
		assert.deepEqual(remote.remote, { nodeId: b.core.members.self().id, node: "beta", bot: "nasbot", reachable: true });
		await assert.rejects(a.core.sessions.create("nasbot-beta"), /another machine/);

		const s = await a.core.sessions.create("main");
		const ev = collect(a.core.hub, s.id);
		let prompt = "";
		a.faux.setResponses([
			(context) => {
				prompt = JSON.stringify(context.messages);
				return fauxAssistantMessage([fauxToolCall("delegate", { bot: "nasbot-beta", task: "Install cowsay on the NAS" })], { stopReason: "toolUse" });
			},
			fauxAssistantMessage([fauxText("The NAS bot was not allowed to install it.")]),
		]);
		// nasbot is trusted at home, but this task comes from a member: sudo still asks.
		b.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "sudo apt-get install -y cowsay" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("I was not allowed to install cowsay.")]),
		]);
		await a.core.sessions.submit(s.id, "@nasbot-beta install cowsay");
		const asked = await ev.until((e) => e.type === "approval.requested", 15000);
		if (asked.type !== "approval.requested") return;
		assert.equal(asked.request.sessionId, s.id, "asked in the chat on alpha");
		assert.equal(asked.request.bot, "nasbot-beta");
		a.core.approvals.answer(asked.request.requestId, "deny");
		const done = await ev.until((e) => e.type === "run.finished", 20000);
		if (done.type !== "run.finished") return;
		assert.equal(done.text, "The NAS bot was not allowed to install it.");
		const tool = ev.events.find((e) => e.type === "tool.finished" && e.name === "delegate");
		assert.ok(tool?.type === "tool.finished" && /nasbot-beta answered \(on beta/.test(tool.resultText), JSON.stringify(tool));

		assert.ok(prompt.includes(JSON.stringify('- nasbot-beta: "Runs on the NAS" (on the machine "beta"; wait: true only)').slice(1, -1)), prompt);
		assert.match(prompt, /addresses one of them with @name/);
		assert.doesNotMatch(prompt, /vault/);

		const onB = b.core.sessions.list("nasbot", { limit: 10, offset: 0, archived: "include", order: "recent" });
		assert.equal(onB.total, 1);
		assert.equal(onB.rows[0]!.source, `member:${a.core.members.self().id}`);
	} finally {
		for (const g of [a, b]) {
			await g.server.close();
			await g.core.close();
		}
		await cleanup();
	}
});

test("a member's WebSocket reaches only shareable bots and its own chats; offline members are reported", async () => {
	const { dir, cleanup } = await tempDir();
	const a = await gateway(dir, "alpha", [{ name: "main", default: true }]);
	const b = await gateway(dir, "beta", [
		{ name: "nasbot", default: true },
		{ name: "vault", private: true },
	]);
	let ws: HermesClient | undefined;
	try {
		await link(a, b);
		const ownerChat = await b.core.sessions.create("nasbot");
		const m = a.core.members.byName("beta")!;
		ws = await HermesClient.connect(b.port, undefined, a.core.members.headersFor(m));
		await ws.waitEvent("gateway.ready");
		const profiles = await ws.call<{ profiles: { name: string }[] }>("profiles.list");
		assert.deepEqual(profiles.profiles.map((p) => p.name), ["nasbot"]);
		await assert.rejects(ws.call("session.create", { profile: "vault" }), /profile not found/);
		await assert.rejects(ws.call("session.resume", { session_id: ownerChat.id }), /session not found/);
		await assert.rejects(ws.call("session.list", {}), /unknown method/);
		const mine = await ws.call<{ session_id: string }>("session.create", { profile: "nasbot" });
		await assert.rejects(ws.call("config.set", { session_id: mine.session_id, key: "yolo", value: "on" }), /cannot switch approvals off/);
		const resumed = await ws.call<{ session_id: string }>("session.resume", { session_id: mine.session_id });
		assert.equal(resumed.session_id, mine.session_id);
		await ws.close();
		ws = undefined;
		// A wrong secret is refused like a wrong token.
		const bad = await HermesClient.connect(b.port, undefined, { ...a.core.members.headersFor(m), "x-nhermes-member-secret": "nope-nope-nope-nope" });
		await new Promise((r) => bad.ws.once("close", r));
		assert.equal(bad.closeCode, 4401);

		// beta goes offline: its bots stay listed, marked offline, and delegating says so at once.
		await b.server.close();
		await a.core.roster.sync();
		assert.equal(a.core.bots.get("nasbot-beta")!.remote!.reachable, false);
		const s = await a.core.sessions.create("main");
		const ev = collect(a.core.hub, s.id);
		a.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("delegate", { bot: "nasbot-beta", task: "check the pool" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("beta is offline.")]),
		]);
		await a.core.sessions.submit(s.id, "ask the nas");
		await ev.until((e) => e.type === "run.finished", 15000);
		const tool = ev.events.find((e) => e.type === "tool.finished");
		assert.ok(tool?.type === "tool.finished" && tool.isError && /beta is offline/.test(tool.resultText), JSON.stringify(tool));
	} finally {
		await ws?.close();
		await a.server.close();
		await a.core.close();
		await b.core.close();
		await cleanup();
	}
});
