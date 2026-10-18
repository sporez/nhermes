// Group chats as Vory drives them (groups.* over the socket): create, send, the room log a member turn
// writes, settling, notifications, approvals in a turn, disbanding, and a restart in the middle of a turn.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { Core } from "../../src/app.ts";
import type { RoomEvent } from "../../src/core/room-plan.ts";
import { startHermesServer } from "../../src/hermes/server.ts";
import type { Notification, Notifier } from "../../src/notify/notifier.ts";
import { TOKEN, tempDir, testConfig, testCore } from "../helpers.ts";
import { HermesClient } from "./client.ts";

class Recorder implements Notifier {
	readonly name = "recorder";
	readonly sent: Notification[] = [];
	async send(n: Notification) {
		this.sent.push(n);
	}
}

function models(tokensPerSecond?: number) {
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1", reasoning: true }, { id: "faux-2" }], tokensPerSecond });
	const m = createModels();
	m.setProvider(faux.provider);
	return { faux, models: m };
}

/** Which test bot a model call is for (from its instructions). */
const botOf = (ctx: unknown) => (JSON.stringify(ctx).includes("ops test bot") ? "ops" : "main");

/** Vory's member list for a new group chat (GroupChats.create in Vory/Bots/BotsView.swift). */
const voryMembers = [
	{ member_id: "main", handle: "main", profile: "main", display_name: "Main" },
	{ member_id: "ops", handle: "ops", profile: "ops", display_name: "Ops" },
];

async function until<T>(fn: () => T | undefined | false, ms = 5000): Promise<T> {
	const end = Date.now() + ms;
	for (;;) {
		const v = fn();
		if (v) return v;
		if (Date.now() > end) throw new Error("timed out");
		await new Promise((r) => setTimeout(r, 20));
	}
}

const kinds = (events: RoomEvent[]) => events.map((e) => `${e.kind}${e.payload.member_id ? `:${e.payload.member_id}` : ""}`);

async function rpcError(p: Promise<unknown>): Promise<{ code: number; message: string }> {
	try {
		await p;
	} catch (error) {
		return error as { code: number; message: string };
	}
	throw new Error("expected an error");
}

test("a group chat: create, send, each bot answers in turn, the room settles and notifies", async () => {
	const { dir, cleanup } = await tempDir();
	const { faux, models: m } = models();
	const notifier = new Recorder();
	const core = await testCore(dir, { models: m, notifier });
	const server = await startHermesServer(core, { host: "127.0.0.1", port: 0 });
	const ws = await HermesClient.connect(server.port, TOKEN);
	try {
		await ws.waitEvent("gateway.ready");
		const caps = await ws.call("groups.capabilities", { profile: "ops" });
		assert.equal(caps.driver, true);
		assert.deepEqual(caps.methods, ["groups.capabilities", "groups.list", "groups.create", "groups.send", "groups.log", "groups.disband"]);

		assert.equal((await rpcError(ws.call("groups.create", { name: "Solo", members: voryMembers.slice(0, 1) }))).code, 4110, "one bot is a chat, not a group");
		assert.match((await rpcError(ws.call("groups.create", { name: "X", members: [...voryMembers, { profile: "nobody" }] }))).message, /no bot named "nobody"/);

		const created = await ws.call<{ room: { room_id: string; members: unknown[]; latest_seq: number } }>("groups.create", { room_id: "room-abc123", name: "Main, Ops", members: voryMembers });
		assert.equal(created.room.room_id, "room-abc123");
		assert.deepEqual(created.room.members, voryMembers);
		assert.equal(created.room.latest_seq, 0);
		const again = await ws.call<{ room: { room_id: string } }>("groups.create", { room_id: "room-abc123", name: "Main, Ops", members: voryMembers });
		assert.equal(again.room.room_id, "room-abc123", "the same room id is the same room");
		const listed = await ws.call<{ rooms: { room_id: string; name: string }[] }>("groups.list", { limit: 50 });
		assert.deepEqual(listed.rooms.map((r) => r.room_id), ["room-abc123"]);

		assert.equal((await rpcError(ws.call("groups.send", { room_id: "room-abc123", event_id: "evt-1", payload: { text: "hi" } }))).code, -32602, "thread_id is required");
		assert.equal((await rpcError(ws.call("groups.send", { room_id: "room-nope", event_id: "evt-1", payload: { text: "hi", thread_id: "main" } }))).code, 4111);

		const prompts: Record<string, string[]> = { main: [], ops: [] };
		const reply = (ctx: unknown) => {
			const bot = botOf(ctx);
			const msgs = (ctx as { messages: { role: string; content: unknown }[] }).messages;
			prompts[bot]!.push(JSON.stringify(msgs[msgs.length - 1]?.content));
			return fauxAssistantMessage([fauxText(bot === "main" ? "Main here. @ops can you check the disks?" : "Disks are at 40%.")]);
		};
		faux.setResponses([reply, reply]);
		const sent = await ws.call<{ event: RoomEvent; accepted: boolean }>("groups.send", { room_id: "room-abc123", event_id: "evt-001", payload: { text: "status check please", thread_id: "main" } });
		assert.equal(sent.accepted, true);
		assert.equal(sent.event.kind, "message.user");
		await core.rooms.idle("room-abc123");

		const log = await ws.call<{ events: RoomEvent[]; cursor: number; latest_seq: number; has_more: boolean }>("groups.log", { room_id: "room-abc123", since_seq: 0, limit: 200 });
		assert.deepEqual(kinds(log.events), [
			"message.user",
			"turn.started:main",
			"message.member:main",
			"turn.settled:main",
			"turn.started:ops",
			"message.member:ops",
			"turn.settled:ops",
			"room.activity",
		]);
		assert.equal(log.latest_seq, 8);
		assert.equal(log.has_more, false);
		const [user, started, said, settled] = log.events;
		assert.equal(said!.actor.kind, "member");
		assert.equal(said!.actor.id, "main");
		assert.equal(said!.payload.text, "Main here. @ops can you check the disks?");
		assert.equal(said!.payload.discussion_event_id, user!.event_id);
		assert.equal(started!.payload.round_index, 0);
		assert.equal(settled!.payload.message_event_id, said!.event_id);
		assert.equal(settled!.payload.passed, false);
		assert.deepEqual(log.events[7]!.payload.status, "settled");
		assert.equal(log.events[7]!.payload.discussion_event_id, user!.event_id);
		assert.match(prompts.ops![0]!, /User \(user\): status check please/);
		assert.match(prompts.ops![0]!, /@main: Main here/, "ops reads what main said");
		assert.match(prompts.ops![0]!, /exactly \\"\(pass\)\\"/);

		// Paging, and the same message sent twice is filed once.
		const page = await ws.call<{ events: RoomEvent[]; cursor: number; has_more: boolean }>("groups.log", { room_id: "room-abc123", since_seq: 2, limit: 3 });
		assert.deepEqual(page.events.map((e) => e.seq), [3, 4, 5]);
		assert.equal(page.cursor, 5);
		assert.equal(page.has_more, true);
		const resent = await ws.call<{ event: RoomEvent }>("groups.send", { room_id: "room-abc123", event_id: "evt-001", payload: { text: "status check please", thread_id: "main" } });
		assert.equal(resent.event.seq, 1);
		await core.rooms.idle("room-abc123");
		assert.equal((await ws.call<{ latest_seq: number }>("groups.log", { room_id: "room-abc123", since_seq: 8 })).latest_seq, 8);

		// One notification for the settled exchange, none per turn.
		assert.equal(notifier.sent.length, 1);
		assert.equal(notifier.sent[0]!.title, "Main, Ops (2 replies)");
		assert.match(notifier.sent[0]!.message, /^Ops: Disks are at 40%\./);

		// Each bot's room session is a session of that bot, left out of Vory's chat list.
		const rows = core.db.all<{ bot: string; kind: string; title: string }>("SELECT bot, kind, title FROM sessions ORDER BY bot").map((r) => ({ ...r }));
		assert.deepEqual(rows, [
			{ bot: "main", kind: "room", title: "Group: Main, Ops" },
			{ bot: "ops", kind: "room", title: "Group: Main, Ops" },
		]);
		// Nor is a delegated task's session; it still opens by id.
		const delegated = await core.sessions.create("ops", { kind: "delegate", source: "delegate", title: "From main: check disks" });
		const h = { "X-Hermes-Session-Token": TOKEN };
		const listedSessions = (await (await fetch(`http://127.0.0.1:${server.port}/api/sessions?profile=ops`, { headers: h })).json()) as { sessions: unknown[]; total: number };
		assert.deepEqual([listedSessions.sessions.length, listedSessions.total], [0, 0]);
		assert.equal((await fetch(`http://127.0.0.1:${server.port}/api/sessions/${delegated.id}?profile=ops`, { headers: h })).status, 200);

		// @ops asks ops alone; "(pass)" adds nothing to the room.
		faux.setResponses([() => fauxAssistantMessage([fauxText("(pass)")])]);
		await ws.call("groups.send", { room_id: "room-abc123", event_id: "evt-002", payload: { text: "@ops anything else?", thread_id: "main" } });
		await core.rooms.idle("room-abc123");
		const tail = (await ws.call<{ events: RoomEvent[] }>("groups.log", { room_id: "room-abc123", since_seq: 8 })).events;
		assert.deepEqual(kinds(tail), ["message.user", "turn.started:ops", "turn.settled:ops", "room.activity"]);
		assert.equal(tail[2]!.payload.passed, true);
		assert.equal(notifier.sent.length, 1, "nothing new to tell");

		// Disbanding: gone from the list, closed to new messages, its log kept.
		await ws.call("groups.disband", { room_id: "room-abc123" });
		assert.deepEqual((await ws.call<{ rooms: unknown[] }>("groups.list", {})).rooms, []);
		assert.equal((await rpcError(ws.call("groups.send", { room_id: "room-abc123", event_id: "evt-003", payload: { text: "hello?", thread_id: "main" } }))).code, 4111);
		const kept = await ws.call<{ events: RoomEvent[] }>("groups.log", { room_id: "room-abc123", since_seq: 0, include_disbanded: true });
		assert.equal(kept.events.at(-1)!.kind, "room.disbanded");
	} finally {
		await ws.close();
		await server.close();
		await core.close();
		await cleanup();
	}
});

test("a turn that needs approval says so in the room, is asked in the bot's room session, and goes on when answered", async () => {
	const { dir, cleanup } = await tempDir();
	const { faux, models: m } = models();
	const core = await testCore(dir, { models: m, notifier: new Recorder() });
	try {
		core.rooms.create({ room_id: "r1", name: "Ops room", members: voryMembers });
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "sudo du -sh /var" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("/var is 2 GB.")]),
		]);
		core.rooms.send({ room_id: "r1", event_id: "e1", payload: { text: "@main how big is /var?", thread_id: "main" } });
		const session = await until(() => core.db.get<{ session_id: string }>("SELECT session_id FROM room_sessions WHERE member_id = 'main'")?.session_id);
		const request = await until(() => core.approvals.pendingFor(session)[0]);
		assert.equal(request.bot, "main");
		const waiting = await until(() => core.rooms.log({ room_id: "r1" }).events.find((e) => e.kind === "room.activity"));
		assert.equal(waiting.payload.status, "Main is waiting for your approval");
		assert.equal(waiting.payload.member_id, "main");
		core.approvals.answer(request.requestId, "once");
		await core.rooms.idle("r1");
		const events = core.rooms.log({ room_id: "r1" }).events;
		assert.deepEqual(kinds(events), ["message.user", "turn.started:main", "room.activity:main", "message.member:main", "turn.settled:main", "room.activity"]);
		assert.equal(events[3]!.payload.text, "/var is 2 GB.");
		// The reviewer reads the owner's words from the room, not the turn prompt with other bots' words in it.
		assert.deepEqual(core.rooms.ownerMessages(session), ["@main how big is /var?"]);
	} finally {
		await core.close();
		await cleanup();
	}
});

test("bots on another machine cannot join a group chat yet", async () => {
	const { dir, cleanup } = await tempDir();
	const bots = [...testConfig(dir).bots, { name: "nas", description: "Agent on the NAS", peer: { url: "http://127.0.0.1:9", tokenEnv: "TEST_PEER_TOKEN" } }];
	const core = await testCore(dir, { models: models().models, config: testConfig(dir, bots) });
	try {
		assert.throws(() => core.rooms.create({ name: "Mixed", members: [{ profile: "main" }, { profile: "nas" }] }), /on another machine; group chats take bots on this gateway only for now/);
		assert.throws(() => core.rooms.create({ name: "Twice", members: [{ profile: "main" }, { profile: "main" }] }), /in the list twice/);
	} finally {
		await core.close();
		await cleanup();
	}
});

test("a gateway restart in the middle of a turn: the turn finishes once and the room goes on", async () => {
	const { dir, cleanup } = await tempDir();
	const config = testConfig(dir);
	try {
		const a = models(200);
		let core: Core = await testCore(dir, { models: a.models, config, notifier: new Recorder() });
		core.rooms.create({ room_id: "r2", name: "Pair", members: voryMembers });
		a.faux.setResponses([fauxAssistantMessage([fauxText("long answer ".repeat(200))])]);
		core.rooms.send({ room_id: "r2", event_id: "e1", payload: { text: "write up the plan", thread_id: "main" } });
		await until(() => core.db.get("SELECT 1 AS x FROM room_turns"));
		await new Promise((r) => setTimeout(r, 100));
		assert.deepEqual(kinds(core.rooms.log({ room_id: "r2" }).events), ["message.user", "turn.started:main"], "main is still answering");
		await core.close(); // stops mid-answer

		const b = models();
		const reply = (ctx: unknown) => fauxAssistantMessage([fauxText(botOf(ctx) === "main" ? "Main's plan." : "Ops agrees.")]);
		b.faux.setResponses([reply, reply]);
		core = await testCore(dir, { models: b.models, config, notifier: new Recorder() });
		await until(() => core.rooms.log({ room_id: "r2" }).events.some((e) => e.kind === "room.activity"), 10000);
		const events = core.rooms.log({ room_id: "r2" }).events;
		assert.deepEqual(kinds(events), ["message.user", "turn.started:main", "message.member:main", "turn.settled:main", "turn.started:ops", "message.member:ops", "turn.settled:ops", "room.activity"]);
		assert.match(String(events[2]!.payload.text), /Main's plan\./);
		const main = core.db.get<{ session_id: string }>("SELECT session_id FROM room_sessions WHERE member_id = 'main'")!.session_id;
		assert.equal((await core.sessions.rows(main)).filter((r) => r.role === "user").length, 1, "the turn was not sent twice");
		assert.equal(core.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM room_turns")!.n, 0);
		await core.close();
	} finally {
		await cleanup();
	}
});
