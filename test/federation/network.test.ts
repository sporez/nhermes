// The network's bots: a member's shareable bots appear on the others as `<bot>-<node>`, delegation
// reaches them over the encrypted port (TLS-PSK keyed by the pair secret) (approvals asked in the chat that started it, and never trusted on
// the owning machine), a member's WebSocket stays within its own chats, and an offline member is
// reported as offline.
import assert from "node:assert/strict";
import { createConnection, createServer, type Socket as NetSocket } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { Core } from "../../src/app.ts";
import type { BotConfig } from "../../src/config.ts";
import { federationAdminRoutes } from "../../src/federation/routes.ts";
import { type GatewayServer, startServer } from "../../src/server.ts";
import { setPeerHeartbeat } from "../../src/remote/api-client.ts";
import { HermesClient } from "../hermes/client.ts";
import { collect, pngBytes, tempDir, testConfig, testCore } from "../helpers.ts";

type Gw = { core: Core; server: GatewayServer; faux: ReturnType<typeof fauxProvider>; port: number };

async function gateway(dir: string, name: string, bots: BotConfig[]): Promise<Gw> {
	const d = join(dir, name);
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }], tokensPerSecond: 500 });
	const models = createModels();
	models.setProvider(faux.provider);
	const core = await testCore(d, { models, config: testConfig(d, bots, { node: { name } }) });
	const server = await startServer(core, { host: "127.0.0.1", port: 0, extraRouters: [federationAdminRoutes(core)] });
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

		assert.ok(prompt.includes(JSON.stringify('- nasbot-beta: "Runs on the NAS" (on the machine "beta")').slice(1, -1)), prompt);
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
		// Member headers on the main port's WebSocket open nothing: members come in on the encrypted port only.
		const memberHeaders = { "x-nhermes-node": a.core.members.self().id, "x-nhermes-member-secret": m.secret };
		const plain = await HermesClient.connect(b.port, undefined, memberHeaders);
		await new Promise((r) => plain.ws.once("close", r));
		assert.equal(plain.closeCode, 4401);
		const t = a.core.members.target(m.node_id)!;
		ws = await HermesClient.connect(b.server.pskPort!, undefined, {}, t.tls);
		await ws.waitEvent("gateway.ready");
		const profiles = await ws.call<{ profiles: { name: string }[] }>("profiles.list");
		assert.deepEqual(profiles.profiles.map((p) => p.name), ["nasbot"]);
		await assert.rejects(ws.call("session.create", { profile: "vault" }), /profile not found/);
		await assert.rejects(ws.call("session.resume", { session_id: ownerChat.id }), /session not found/);
		await assert.rejects(ws.call("session.list", {}), /unknown method/);
		const mine = await ws.call<{ session_id: string }>("session.create", { profile: "nasbot" });
		await assert.rejects(ws.call("config.set", { session_id: mine.session_id, key: "yolo", value: "on" }), /cannot switch approvals off/);
		// Uploads only into its own chats.
		const png = pngBytes(2, 2).toString("base64");
		await assert.rejects(ws.call("image.attach_bytes", { session_id: ownerChat.id, content_base64: png }), /session not found/);
		await assert.rejects(ws.call("file.attach", { session_id: ownerChat.id, data_url: `data:text/plain;base64,${png}` }), /session not found/);
		assert.equal(b.core.attachments.pending(ownerChat.id), 0);
		assert.equal((await ws.call<{ count: number }>("image.attach_bytes", { session_id: mine.session_id, content_base64: png })).count, 1);
		const resumed = await ws.call<{ session_id: string }>("session.resume", { session_id: mine.session_id });
		assert.equal(resumed.session_id, mine.session_id);
		await ws.close();
		ws = undefined;
		// A wrong secret is refused: in the handshake on the encrypted port, like a wrong token on the main one.
		await assert.rejects(HermesClient.connect(b.server.pskPort!, undefined, {}, { ...t.tls, pskCallback: () => ({ identity: `m:${a.core.members.self().id}:000000000000`, psk: Buffer.alloc(32) }) }));
		const bad = await HermesClient.connect(b.port, undefined, { ...memberHeaders, "x-nhermes-member-secret": "nope-nope-nope-nope" });
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

test("removing a member closes its open connections", async () => {
	const { dir, cleanup } = await tempDir();
	const a = await gateway(dir, "alpha", [{ name: "main", default: true }]);
	const b = await gateway(dir, "beta", [{ name: "nasbot", default: true }]);
	let ws: HermesClient | undefined;
	try {
		await link(a, b);
		const t = a.core.members.target(b.core.members.self().id)!;
		ws = await HermesClient.connect(b.server.pskPort!, undefined, {}, t.tls);
		await ws.waitEvent("gateway.ready");
		const mine = await ws.call<{ session_id: string }>("session.create", { profile: "nasbot" });
		assert.ok(mine.session_id);

		// beta removes alpha: the connection alpha already had open is closed, and nothing more is accepted on it.
		const closed = new Promise<number>((r) => ws!.ws.once("close", r));
		await b.core.members.remove("alpha");
		assert.equal(await closed, 4401);
		const sendError = await new Promise<Error | undefined>((r) => ws!.ws.send(JSON.stringify({ jsonrpc: "2.0", id: 99, method: "prompt.submit", params: { session_id: mine.session_id, text: "hello" } }), r));
		assert.match(String(sendError), /not open/);
		assert.equal(b.core.sessions.isRunning(mine.session_id), false);
		assert.deepEqual(b.core.members.list(), []);
		ws = undefined;
	} finally {
		await ws?.close();
		for (const g of [a, b]) {
			await g.server.close();
			await g.core.close();
		}
		await cleanup();
	}
});

test("wait: false to a member's bot returns at once; the answer arrives later as a new message", async () => {
	const { dir, cleanup } = await tempDir();
	const a = await gateway(dir, "alpha", [{ name: "main", default: true }]);
	const b = await gateway(dir, "beta", [{ name: "nasbot", default: true }]);
	try {
		await link(a, b);
		const s = await a.core.sessions.create("main");
		const ev = collect(a.core.hub, s.id);
		a.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("delegate", { bot: "nasbot-beta", task: "Scrub the pool and report", wait: false })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("I asked the NAS bot; I'll tell you when it reports.")]),
			fauxAssistantMessage([fauxText("The NAS bot says the scrub is clean.")]),
		]);
		// beta takes its time: the caller's turn must not wait for it.
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		b.faux.setResponses([async () => (await gate, fauxAssistantMessage([fauxText("Scrub finished: 0 errors.")]))]);
		await a.core.sessions.submit(s.id, "have the NAS bot scrub the pool");
		const first = await ev.until((e) => e.type === "run.finished", 15000);
		if (first.type !== "run.finished") return;
		assert.equal(first.text, "I asked the NAS bot; I'll tell you when it reports.");
		const tool = ev.events.find((e) => e.type === "tool.finished" && e.name === "delegate");
		assert.ok(tool?.type === "tool.finished" && !tool.isError && /answer will arrive as a new message/.test(tool.resultText), JSON.stringify(tool));

		release();
		const second = await ev.until((e) => e.type === "run.started" && e.prompt.startsWith('[Result from bot "nasbot-beta"'), 20000);
		if (second.type !== "run.started") return;
		assert.match(second.prompt, /Scrub finished: 0 errors\./);
		await ev.until((e) => e.type === "run.finished" && e !== first, 15000);
		const onB = b.core.sessions.list("nasbot", { limit: 10, offset: 0, archived: "include", order: "recent" });
		assert.equal(onB.total, 1);
		assert.equal((await b.core.sessions.rows(onB.rows[0]!.id)).filter((r) => r.role === "user").length, 1, "submitted once");
	} finally {
		for (const g of [a, b]) {
			await g.server.close();
			await g.core.close();
		}
		await cleanup();
	}
});

test("a background task to a member's bot survives a restart of the calling gateway", async () => {
	const { dir, cleanup } = await tempDir();
	const a = await gateway(dir, "alpha", [{ name: "main", default: true }]);
	const b = await gateway(dir, "beta", [{ name: "nasbot", default: true }]);
	let a2: Core | undefined;
	try {
		await link(a, b);
		const s = await a.core.sessions.create("main");
		const ev = collect(a.core.hub, s.id);
		a.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("delegate", { bot: "nasbot-beta", task: "Long job", wait: false })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("Started.")]),
		]);
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		b.faux.setResponses([async () => (await gate, fauxAssistantMessage([fauxText("Long job done.")]))]);
		await a.core.sessions.submit(s.id, "start the long job");
		await ev.until((e) => e.type === "run.finished", 15000);
		// Wait until beta has the task, then stop alpha while beta is still working.
		for (let i = 0; i < 100 && !b.core.sessions.list("nasbot", { limit: 1, offset: 0, archived: "include", order: "recent" }).rows.some((r) => b.core.sessions.isRunning(r.id)); i++) await new Promise((r) => setTimeout(r, 50));
		await a.server.close();
		await a.core.close();

		const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }], tokensPerSecond: 500 });
		const models = createModels();
		models.setProvider(faux.provider);
		faux.setResponses([fauxAssistantMessage([fauxText("The long job is done.")])]);
		a2 = await testCore(join(dir, "alpha"), { models, config: testConfig(join(dir, "alpha"), [{ name: "main", default: true }], { node: { name: "alpha" } }) });
		await a2.roster.sync();
		const ev2 = collect(a2.hub, s.id);
		await a2.sessions.live(s.id);
		release();
		const reported = await ev2.until((e) => e.type === "run.started" && e.prompt.startsWith('[Result from bot "nasbot-beta"'), 30000);
		if (reported.type !== "run.started") return;
		assert.match(reported.prompt, /Long job done\./);
		const onB = b.core.sessions.list("nasbot", { limit: 10, offset: 0, archived: "include", order: "recent" });
		assert.equal(onB.total, 1, "one chat on beta");
		assert.equal((await b.core.sessions.rows(onB.rows[0]!.id)).filter((r) => r.role === "user").length, 1, "the task was sent once");
	} finally {
		await a2?.close();
		await b.server.close();
		await b.core.close();
		await cleanup();
	}
});

test("a member that freezes mid-task is noticed, and a task it lost is reported instead of waited on", async () => {
	const { dir, cleanup } = await tempDir();
	const a = await gateway(dir, "alpha", [{ name: "main", default: true }]);
	const b = await gateway(dir, "beta", [{ name: "nasbot", default: true }]);
	// A relay between alpha and beta that can freeze its connections without closing them.
	const pairs: [NetSocket, NetSocket][] = [];
	const relay = createServer((down) => {
		const up = createConnection(b.server.pskPort!, "127.0.0.1");
		down.pipe(up);
		up.pipe(down);
		pairs.push([down, up]);
	});
	await new Promise<void>((r) => relay.listen(0, "127.0.0.1", () => r()));
	const relayPort = (relay.address() as { port: number }).port;
	setPeerHeartbeat(300);
	let releaseB = () => {};
	try {
		await link(a, b);
		a.core.db.run("UPDATE members SET psk_port = ? WHERE name = 'beta'", relayPort);
		const s = await a.core.sessions.create("main");
		const ev = collect(a.core.hub, s.id);
		a.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("delegate", { bot: "nasbot-beta", task: "Long job", wait: false })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("Started.")]),
			fauxAssistantMessage([fauxText("The NAS lost the job.")]),
		]);
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		releaseB = () => release();
		b.faux.setResponses([async () => (await gate, fauxAssistantMessage([fauxText("too late")]))]);
		await a.core.sessions.submit(s.id, "start the long job");
		await ev.until((e) => e.type === "run.finished", 15000);
		let remote: string | undefined;
		for (let i = 0; i < 100 && !remote; i++) {
			remote = b.core.sessions.list("nasbot", { limit: 1, offset: 0, archived: "include", order: "recent" }).rows.find((r) => b.core.sessions.isRunning(r.id))?.id;
			if (!remote) await new Promise((r) => setTimeout(r, 50));
		}
		assert.ok(remote, "beta is working on it");
		// beta freezes (connections stay open, nothing moves) and comes back without the chat.
		for (const [down, up] of pairs) {
			down.unpipe(up);
			up.unpipe(down);
			down.pause();
			up.pause();
		}
		b.core.db.run("UPDATE sessions SET deleted = 1 WHERE id = ?", remote);
		const reported = await ev.until((e) => e.type === "run.started" && e.prompt.startsWith("[nasbot-beta could not finish"), 20000);
		if (reported.type !== "run.started") return;
		assert.match(reported.prompt, /no longer has this task.*nothing was sent again/);
	} finally {
		setPeerHeartbeat(30_000);
		releaseB();
		for (const [down, up] of pairs) (down.destroy(), up.destroy());
		relay.close();
		for (const g of [a, b]) {
			await g.server.close();
			await g.core.close();
		}
		await cleanup();
	}
});
