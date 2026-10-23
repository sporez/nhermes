// Group chats with a member's bot: the room lives on alpha (where Vory is connected), beta's bot answers on
// beta in a room session there (work alpha started: not trusted there, its approvals asked on alpha), and an
// offline member's turn fails instead of hanging the room.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { Core } from "../../src/app.ts";
import type { BotConfig } from "../../src/config.ts";
import type { RoomEvent } from "../../src/core/room-plan.ts";
import { type GatewayServer, startServer } from "../../src/server.ts";
import type { Notification, Notifier } from "../../src/notify/notifier.ts";
import { HermesClient } from "../hermes/client.ts";
import { TOKEN, tempDir, testConfig, testCore } from "../helpers.ts";

type Gw = { core: Core; server: GatewayServer; faux: ReturnType<typeof fauxProvider>; port: number };

class Recorder implements Notifier {
	readonly name = "recorder";
	readonly sent: Notification[] = [];
	async send(n: Notification) {
		this.sent.push(n);
	}
}

async function gateway(dir: string, name: string, bots: BotConfig[]): Promise<Gw> {
	const d = join(dir, name);
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }], tokensPerSecond: 2000 });
	const models = createModels();
	models.setProvider(faux.provider);
	const core = await testCore(d, { models, notifier: new Recorder(), config: testConfig(d, bots, { node: { name } }) });
	const server = await startServer(core, { host: "127.0.0.1", port: 0 });
	return { core, server, faux, port: server.port };
}

test("alpha restarts while beta's bot is answering: the answer is filed once, the turn not sent again", async () => {
	const { dir, cleanup } = await tempDir();
	let a = await gateway(dir, "alpha", [{ name: "main", default: true }]);
	const b = await gateway(dir, "beta", [{ name: "nasbot", default: true }]);
	try {
		const { code } = a.core.members.invite();
		await b.core.members.join(code);
		await a.core.roster.sync();
		a.core.rooms.create({ room_id: "net-2", name: "Pair", members: [{ profile: "main" }, { profile: "nasbot-beta" }] });
		let calls = 0;
		b.faux.setResponses([
			async () => {
				calls++;
				await new Promise((r) => setTimeout(r, 600));
				return fauxAssistantMessage([fauxText("Beta's careful answer.")]);
			},
		]);
		a.core.rooms.send({ room_id: "net-2", event_id: "e1", payload: { text: "@nasbot-beta report please", thread_id: "main" } });
		await until(() => calls > 0);
		await a.server.close();
		await a.core.close(); // alpha goes away while beta is still answering

		const d = join(dir, "alpha");
		const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
		const models = createModels();
		models.setProvider(faux.provider);
		const core = await testCore(d, { models, notifier: new Recorder(), config: testConfig(d, [{ name: "main", default: true }], { node: { name: "alpha" } }) });
		a = { ...a, core, server: await startServer(core, { host: "127.0.0.1", port: 0 }) };
		await until(() => core.rooms.log({ room_id: "net-2" }).events.some((e) => e.kind === "room.activity"));
		const events = core.rooms.log({ room_id: "net-2" }).events;
		assert.deepEqual(kinds(events), ["message.user", "turn.started:nasbot-beta", "message.member:nasbot-beta", "turn.settled:nasbot-beta", "room.activity"]);
		assert.equal(events[2]!.payload.text, "Beta's careful answer.");
		assert.equal(calls, 1, "beta answered once");
		const sid = core.db.get<{ session_id: string }>("SELECT session_id FROM room_sessions WHERE member_id = 'nasbot-beta'")!.session_id;
		assert.equal((await b.core.sessions.rows(sid)).filter((r) => r.role === "user").length, 1, "the turn reached beta once");
	} finally {
		await a.server.close().catch(() => undefined);
		await b.server.close();
		await a.core.close().catch(() => undefined);
		await b.core.close();
		await cleanup();
	}
});

async function until<T>(fn: () => T | undefined | false, ms = 10000): Promise<T> {
	const end = Date.now() + ms;
	for (;;) {
		const v = fn();
		if (v) return v;
		if (Date.now() > end) throw new Error("timed out");
		await new Promise((r) => setTimeout(r, 25));
	}
}

const kinds = (events: RoomEvent[]) => events.map((e) => `${e.kind}${e.payload.member_id ? `:${e.payload.member_id}` : ""}`);

test("a member's bot takes its turns in a group chat on its own machine", async () => {
	const { dir, cleanup } = await tempDir();
	const a = await gateway(dir, "alpha", [{ name: "main", default: true, instructions: "You are alpha's main bot." }]);
	const b = await gateway(dir, "beta", [{ name: "nasbot", default: true, instructions: "You are beta's NAS bot." }]);
	try {
		const { code } = a.core.members.invite();
		await b.core.members.join(code);
		await a.core.roster.sync();
		const alphaId = a.core.members.self().id;
		const betaId = b.core.members.self().id;

		const room = a.core.rooms.create({ room_id: "net-1", name: "Main, Nasbot", members: [{ profile: "main" }, { profile: "nasbot-beta" }] });
		assert.deepEqual(room.members.map((m) => [m.member_id, m.handle, m.display_name]), [
			["main", "main", "Main"],
			["nasbot-beta", "nasbot-beta", "Nasbot (beta)"],
		]);

		const betaPrompts: string[] = [];
		a.faux.setResponses([fauxAssistantMessage([fauxText("Alpha checked the router. @nasbot-beta how are the disks?")])]);
		b.faux.setResponses([
			(ctx: unknown) => {
				const msgs = (ctx as { messages: { content: unknown }[] }).messages;
				betaPrompts.push(JSON.stringify(msgs[msgs.length - 1]?.content));
				return fauxAssistantMessage([fauxText("Disks on the NAS are at 40%.")]);
			},
		]);
		a.core.rooms.send({ room_id: "net-1", event_id: "e1", payload: { text: "status check", thread_id: "main" } });
		await a.core.rooms.idle("net-1");
		const events = a.core.rooms.log({ room_id: "net-1" }).events;
		assert.deepEqual(kinds(events), ["message.user", "turn.started:main", "message.member:main", "turn.settled:main", "turn.started:nasbot-beta", "message.member:nasbot-beta", "turn.settled:nasbot-beta", "room.activity"]);
		assert.equal(events[5]!.payload.text, "Disks on the NAS are at 40%.");
		assert.match(betaPrompts[0]!, /You are @nasbot-beta, one participant with @main/);
		assert.match(betaPrompts[0]!, /@main: Alpha checked the router/);

		// The conversation lives on beta as a room session alpha's work started; alpha catalogues it, unlisted.
		const sid = a.core.db.get<{ session_id: string }>("SELECT session_id FROM room_sessions WHERE member_id = 'nasbot-beta'")!.session_id;
		const there = b.core.sessions.get(sid)!;
		assert.deepEqual([there.bot, there.kind, there.source, there.title], ["nasbot", "room", `member:${alphaId}`, "Group: Main, Nasbot"]);
		const here = a.core.sessions.get(sid)!;
		assert.deepEqual([here.bot, here.kind, here.remote_node], ["nasbot-beta", "room", betaId]);
		const rest = (path: string) => fetch(`http://127.0.0.1:${a.port}${path}`, { headers: { "X-Hermes-Session-Token": TOKEN } });
		const listed = async () => ((await (await rest("/api/sessions?profile=nasbot-beta")).json()) as { sessions: { id: string }[] }).sessions.map((s) => s.id);
		assert.deepEqual(await listed(), []);

		// Work alpha started is not trusted on beta: sudo is asked, and the card is alpha's.
		b.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "sudo du -sh /srv" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("/srv is 3 TB.")]),
		]);
		a.core.rooms.send({ room_id: "net-1", event_id: "e2", payload: { text: "@nasbot-beta how big is /srv?", thread_id: "main" } });
		const request = await until(() => a.core.approvals.pendingFor(sid)[0]);
		assert.equal(request.bot, "nasbot-beta");
		assert.match(request.description, /^from beta: /);
		assert.equal(b.core.approvals.pendingFor(sid).length, 1, "beta waits for alpha's answer");
		const waiting = await until(() => a.core.rooms.log({ room_id: "net-1" }).events.find((e) => e.kind === "room.activity" && String(e.payload.status).includes("waiting")));
		assert.equal(waiting.payload.status, 'Nasbot (beta) is waiting for your approval: open "Group: Main, Nasbot" in Chats');
		assert.deepEqual(await listed(), [sid], "listed while its approval waits");
		// Vory opens it from Chats (through alpha's member link) and finds one card, alpha's.
		const vory = await HermesClient.connect(a.port, TOKEN);
		try {
			await vory.waitEvent("gateway.ready");
			await vory.call("client.capabilities", { server_requests: true });
			const resumed = await vory.call<{ open_requests: { params: { request_id?: string } }[]; messages: unknown[] }>("session.resume", { session_id: sid, profile: "nasbot-beta" });
			assert.equal(resumed.open_requests.length, 1);
			await new Promise((r) => setTimeout(r, 200));
			assert.equal(a.core.approvals.pendingFor(sid).length, 1, "still one card after the member link attached");
		} finally {
			await vory.close();
		}
		a.core.approvals.answer(request.requestId, "once");
		await a.core.rooms.idle("net-1");
		const tail = a.core.rooms.log({ room_id: "net-1", since_seq: 8 }).events;
		assert.deepEqual(kinds(tail), ["message.user", "turn.started:nasbot-beta", "room.activity:nasbot-beta", "message.member:nasbot-beta", "turn.settled:nasbot-beta", "room.activity"]);
		assert.equal(tail[3]!.payload.text, "/srv is 3 TB.");
		assert.equal(a.core.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM room_turns")!.n, 0);

		// beta goes away: its turn fails at once and the room settles.
		await b.server.close();
		a.core.rooms.send({ room_id: "net-1", event_id: "e3", payload: { text: "@nasbot-beta still there?", thread_id: "main" } });
		await a.core.rooms.idle("net-1");
		const last = a.core.rooms.log({ room_id: "net-1", since_seq: 14 }).events;
		assert.deepEqual(kinds(last), ["message.user", "turn.started:nasbot-beta", "turn.failed:nasbot-beta", "room.activity"]);
		assert.match(String(last[2]!.payload.error), /beta is offline/);
	} finally {
		await a.server.close();
		await b.server.close().catch(() => undefined);
		await a.core.close();
		await b.core.close();
		await cleanup();
	}
});
