// Chats with a member's bot on the client API: the app on alpha talks to beta's bot through alpha. Calls and
// events pass through with alpha's ids, beta's approvals are asked on alpha, uploads land on beta, a dropped
// link tells the app to subscribe again, and an offline member is reported.
import assert from "node:assert/strict";
import { request as httpsRequest } from "node:https";
import { join } from "node:path";
import { test } from "node:test";
import { createModels, fauxAssistantMessage, fauxProvider, type FauxResponseFactory, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { Core } from "../../src/app.ts";
import type { BotConfig } from "../../src/config.ts";
import { ApiClient } from "../../src/remote/api-client.ts";
import { type GatewayServer, startServer } from "../../src/server.ts";
import { pngBytes, TOKEN, tempDir, testConfig, testCore } from "../helpers.ts";
import { ApiSocketClient, http } from "./client.ts";

type Gw = { core: Core; server: GatewayServer; faux: ReturnType<typeof fauxProvider>; port: number };

async function gateway(dir: string, name: string, bots: BotConfig[], modelIds = ["faux-1"]): Promise<Gw> {
	const d = join(dir, name);
	const faux = fauxProvider({ provider: "faux", models: modelIds.map((id) => ({ id, reasoning: true })), tokensPerSecond: 400 });
	const models = createModels();
	models.setProvider(faux.provider);
	const core = await testCore(d, { models, config: testConfig(d, bots, { node: { name } }) });
	const server = await startServer(core, { host: "127.0.0.1", port: 0 });
	return { core, server, faux, port: server.port };
}

async function network(nasbot: Partial<BotConfig> = {}, betaModels?: string[]) {
	const { dir, cleanup } = await tempDir();
	const a = await gateway(dir, "alpha", [{ name: "main", default: true }]);
	const b = await gateway(dir, "beta", [{ name: "nasbot", default: true, description: "Runs on the NAS", ...nasbot }], betaModels);
	const { code } = a.core.members.invite();
	await b.core.members.join(code);
	await a.core.roster.sync();
	return {
		a,
		b,
		close: async () => {
			for (const g of [a, b]) {
				await g.server.close();
				await g.core.close();
			}
			await cleanup();
		},
	};
}

type Session = { id: string; botId: string; title: string; pinned: boolean; running: boolean };
type Turn = { id: string; status: string; user: { content: { type: string; text?: string; attachment?: { id: string } }[] }; items: { type: string; text?: string; status?: string }[] };
const finished = (sid: string) => (e: { event: string; sessionId?: string }) => e.event === "turn.finished" && e.sessionId === sid;

test("the app on alpha chats with beta's bot: calls, events, approvals and history go through alpha", async () => {
	const n = await network();
	const app = await ApiSocketClient.connect(n.a.port);
	try {
		const { items: bots } = await http(n.a.port)<{ items: { id: string; name: string; displayName: string; kind: string; node: { name: string; online: boolean } | null }[] }>("GET /bots");
		const nas = bots.find((x) => x.id === "nasbot-beta")!;
		assert.deepEqual([nas.name, nas.displayName, nas.kind, nas.node?.name, nas.node?.online], ["nasbot", "Nasbot", "member", "beta", true]);

		const { session } = await app.call<{ session: Session }>("sessions.create", { botId: "nasbot-beta" });
		const sid = session.id;
		assert.equal(session.botId, "nasbot-beta");
		assert.equal(n.b.core.sessions.get(sid)?.source, `member:${n.a.core.members.self().id}:owner`, "beta keeps it as the owner's relayed chat");
		assert.equal(n.a.core.sessions.get(sid)?.remote_node, n.b.core.members.self().id);
		const snap = await app.call<{ session: Session; seq: number; turns: { items: Turn[] } }>("sessions.subscribe", { id: sid });
		assert.equal(snap.session.botId, "nasbot-beta");

		n.b.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "sudo apt-get install -y cowsay" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("I did not install cowsay. The pool is healthy.")]),
		]);
		await app.call("sessions.submit", { id: sid, text: "Install cowsay and check the pool" });
		const ask = await app.waitEvent("approval.requested", 10000);
		const approval = ask.data.approval as { id: string; sessionId: string; botId: string; description: string };
		assert.equal(approval.sessionId, sid);
		assert.equal(approval.botId, "nasbot-beta");
		assert.match(approval.description, /^from beta: /);
		await app.call("approvals.answer", { id: approval.id, choice: "deny" });
		const done = await app.waitEvent(finished(sid), 20000);
		assert.equal(done.data.status, "complete");
		const text = app.events.filter((e) => e.sessionId === sid && e.event === "item.delta").map((e) => e.data.text).join("");
		assert.equal(text, "I did not install cowsay. The pool is healthy.", "beta's reply streamed to the app through alpha");
		assert.equal(n.b.core.approvals.allPending().length, 0, "beta got the answer");

		const turns = await http(n.a.port)<{ items: Turn[] }>(`GET /sessions/${sid}/turns`);
		const turn = turns.items.at(-1)!;
		assert.deepEqual(turn.items.map((i) => [i.type, i.status ?? ""]), [["tool", "blocked"], ["text", ""]]);
		const listed = await http(n.a.port)<{ items: Session[] }>("GET /sessions", { botId: "nasbot-beta" });
		const row = listed.items.find((s) => s.id === sid)!;
		assert.equal(row.title, "Install cowsay and check the pool");
		assert.equal(row.running, false);
		const models = await http(n.a.port)<{ current: { provider: string } }>("GET /models", { botId: "nasbot-beta" });
		assert.equal(models.current.provider, "faux");

		// Pins are alpha's; the title goes to both; Bypass is beta's to refuse.
		const { session: renamed } = await http(n.a.port)<{ session: Session }>(`PATCH /sessions/${sid}`, { title: "NAS check", pinned: true });
		assert.deepEqual([renamed.title, renamed.pinned], ["NAS check", true]);
		assert.equal(n.b.core.sessions.get(sid)?.title, "NAS check");
		await assert.rejects(http(n.a.port)(`PATCH /sessions/${sid}`, { yolo: true }), (e: { code: string }) => e.code === "not_allowed");

		await http(n.a.port)(`DELETE /sessions/${sid}`);
		assert.equal(n.a.core.sessions.get(sid), undefined);
		await new Promise<void>((resolve) => {
			const check = () => (n.b.core.sessions.get(sid) === undefined ? resolve() : setImmediate(check));
			check();
		});
	} finally {
		await app.close();
		await n.close();
	}
});

test("a chat with beta's bot shows beta's reasoning and model, and a change made from alpha sticks", async () => {
	const n = await network({ thinking: "high" }, ["faux-1", "faux-nas"]);
	const app = await ApiSocketClient.connect(n.a.port);
	type Chat = Session & { model: { provider: string; id: string }; thinking: string };
	try {
		const { items: bots } = await http(n.a.port)<{ items: { id: string; thinking: string }[] }>("GET /bots");
		assert.equal(bots.find((x) => x.id === "nasbot-beta")?.thinking, "high", "beta's bot keeps its own level, not alpha's default");
		const { session } = await app.call<{ session: Chat }>("sessions.create", { botId: "nasbot-beta" });
		assert.equal(session.thinking, "high");
		const sid = session.id;

		const { session: changed } = await http(n.a.port)<{ session: Chat }>(`PATCH /sessions/${sid}`, { thinking: "low", model: { provider: "faux", id: "faux-nas" } });
		assert.deepEqual([changed.thinking, changed.model.id], ["low", "faux-nas"], "a model only beta has is beta's to accept");
		const onBeta = await n.b.core.engine.agentModel(n.b.core.sessions.require(sid).conversation_id);
		assert.deepEqual([onBeta.thinking, onBeta.model?.modelId], ["low", "faux-nas"]);
		const { session: got } = await http(n.a.port)<{ session: Chat }>(`GET /sessions/${sid}`);
		assert.deepEqual([got.thinking, got.model.id], ["low", "faux-nas"]);
		const listed = await http(n.a.port)<{ items: Chat[] }>("GET /sessions", { botId: "nasbot-beta" });
		assert.equal(listed.items.find((s) => s.id === sid)?.thinking, "low");
		const snap = await app.call<{ session: Chat }>("sessions.subscribe", { id: sid });
		assert.deepEqual([snap.session.thinking, snap.session.model.id], ["low", "faux-nas"]);
	} finally {
		await app.close();
		await n.close();
	}
});

test("uploads into a chat with beta's bot are kept on beta and open through alpha", async () => {
	const n = await network();
	const app = await ApiSocketClient.connect(n.a.port);
	try {
		const { session } = await app.call<{ session: Session }>("sessions.create", { botId: "nasbot-beta" });
		await app.call("sessions.subscribe", { id: session.id });
		const png = pngBytes(10, 10);
		const up = await fetch(`http://127.0.0.1:${n.a.port}/api/v1/sessions/${session.id}/attachments`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "x-filename": "pool.png" }, body: new Uint8Array(png) });
		const { attachment } = (await up.json()) as { attachment: { id: string; kind: string } };
		assert.equal(attachment.kind, "image");
		const seen: string[] = [];
		const recording: FauxResponseFactory = (context) => {
			const last = context.messages.at(-1);
			if (last?.role === "user" && Array.isArray(last.content)) for (const p of last.content) seen.push(p.type);
			return fauxAssistantMessage("A grey square.");
		};
		n.b.faux.setResponses([recording]);
		await app.call("sessions.submit", { id: session.id, content: [{ type: "text", text: "what is it?" }, { type: "attachment", id: attachment.id }] });
		await app.waitEvent(finished(session.id), 20000);
		assert.ok(seen.includes("image"), "beta's model saw the picture");
		const down = await fetch(`http://127.0.0.1:${n.a.port}/api/v1/sessions/${session.id}/attachments/${attachment.id}/content`, { headers: { authorization: `Bearer ${TOKEN}` } });
		assert.equal(down.status, 200);
		assert.deepEqual(Buffer.from(await down.arrayBuffer()), png);
	} finally {
		await app.close();
		await n.close();
	}
});

test("a dropped link tells the app to subscribe again; an offline member is reported", async () => {
	const n = await network();
	const app = await ApiSocketClient.connect(n.a.port);
	try {
		const { session } = await app.call<{ session: Session }>("sessions.create", { botId: "nasbot-beta" });
		await app.call("sessions.subscribe", { id: session.id });
		n.b.server.dropConnections();
		const stale = await app.waitEvent((e) => e.event === "session.stale" && e.sessionId === session.id, 10000);
		assert.equal(stale.sessionId, session.id);
		const again = await app.call<{ session: Session }>("sessions.subscribe", { id: session.id });
		assert.equal(again.session.id, session.id);

		await n.b.server.close();
		await assert.rejects(app.call("sessions.submit", { id: session.id, text: "hello?" }), (e: { code: string }) => e.code === "member_offline");
	} finally {
		await app.close();
		await n.close().catch(() => undefined);
	}
});

test("a member on the encrypted port reaches only member operations, this machine's shareable bots and its own chats", async () => {
	const { dir, cleanup } = await tempDir();
	const a = await gateway(dir, "alpha", [{ name: "main", default: true }, { name: "secret", private: true }]);
	const b = await gateway(dir, "beta", [{ name: "nasbot", default: true }]);
	const { code } = a.core.members.invite();
	await b.core.members.join(code);
	const target = b.core.members.target(a.core.members.self().id)!;
	const asMember = await ApiClient.open(target, "alpha");
	try {
		assert.deepEqual((asMember.hello.caller as { kind: string }).kind, "member");
		const { items } = await asMember.call<{ items: { id: string }[] }>("bots.list", {});
		assert.deepEqual(items.map((x) => x.id), ["main"], "a private bot is not shared");
		await assert.rejects(asMember.call("bots.get", { id: "secret" }), (e: { code: string }) => e.code === "bot_not_found");
		await assert.rejects(asMember.call("sessions.list", {}), (e: { code: string }) => e.code === "unknown_op");
		const owners = await http(a.port)<{ session: Session }>("POST /sessions", {});
		await assert.rejects(asMember.call("sessions.subscribe", { id: owners.session.id }), (e: { code: string }) => e.code === "session_not_found");
		await assert.rejects(asMember.call("sessions.submit", { id: owners.session.id, text: "hi" }), (e: { code: string }) => e.code === "session_not_found");
		const mine = await asMember.call<{ session: Session & { source: string } }>("sessions.create", {});
		assert.equal(mine.session.source, `member:${b.core.members.self().id}`, "work a member started is never trusted");
		await assert.rejects(asMember.call("sessions.update", { id: mine.session.id, yolo: true }), (e: { code: string }) => e.code === "not_allowed");
		// The owner's API is not on the encrypted port.
		const res = await new Promise<number>((resolve) => {
			const req = httpsRequest({ host: "127.0.0.1", port: a.server.pskPort!, path: "/api/v1/sessions", ...target.tls }, (r) => resolve(r.statusCode ?? 0));
			req.on("error", () => resolve(0));
			req.end();
		});
		assert.equal(res, 404);
	} finally {
		asMember.close();
		for (const g of [a, b]) {
			await g.server.close();
			await g.core.close();
		}
		await cleanup();
	}
});
