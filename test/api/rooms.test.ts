// Group chats on the client API: create a room of two bots, send, each bot answers in turn, the log events are
// pushed to the app as they are filed, the log reads from any point, and disbanding closes the room.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { startServer } from "../../src/server.ts";
import { tempDir, testCore } from "../helpers.ts";
import { ApiSocketClient, http } from "./client.ts";

const botOf = (ctx: unknown) => (JSON.stringify(ctx).includes("ops test bot") ? "ops" : "main");

type Room = { id: string; name: string; members: { id: string; botId: string; handle: string; displayName: string }[]; latestSeq: number; disbandedAt: number | null };
type Ev = { roomId: string; seq: number; id: string; kind: string; actor: { kind: string; id: string }; data: Record<string, unknown>; at: number };

test("a group chat: create, send, each bot answers, events arrive live, the log reads from any point, disband", async () => {
	const { dir, cleanup } = await tempDir();
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1", reasoning: true }] });
	const models = createModels();
	models.setProvider(faux.provider);
	const core = await testCore(dir, { models });
	const server = await startServer(core, { host: "127.0.0.1", port: 0, federationPort: null });
	const app = await ApiSocketClient.connect(server.port);
	const api = http(server.port);
	try {
		await assert.rejects(api("POST /rooms", { name: "Solo", members: [{ botId: "main" }] }), (e: { code: string }) => e.code === "invalid_params");
		const { room } = await api<{ room: Room }>("POST /rooms", { id: "room-abc123", name: "Main, Ops", members: [{ botId: "main" }, { botId: "ops" }] });
		assert.equal(room.id, "room-abc123");
		assert.deepEqual(room.members.map((m) => [m.id, m.botId, m.handle, m.displayName]), [["main", "main", "main", "Main"], ["ops", "ops", "ops", "Ops"]]);
		const created = await app.waitEvent("room.updated");
		assert.equal((created.data.room as Room).id, "room-abc123");
		assert.deepEqual((await api<{ items: Room[] }>("GET /rooms")).items.map((r) => r.id), ["room-abc123"]);

		const reply = (ctx: unknown) => fauxAssistantMessage([fauxText(botOf(ctx) === "main" ? "Main here. @ops can you check the disks?" : "Disks are at 40%.")]);
		faux.setResponses([reply, reply]);
		const { event } = await api<{ event: Ev }>("POST /rooms/room-abc123/messages", { text: "status check please", eventId: "evt-001" });
		assert.equal(event.kind, "message.user");
		assert.equal(event.data.threadId, "main");
		await core.rooms.idle("room-abc123");
		await app.waitEvent((e) => e.event === "room.event" && (e.data.event as Ev).kind === "room.activity");
		const live = app.eventsOf("room.event").map((e) => e.data.event as Ev);
		const kinds = live.map((e) => `${e.kind}${e.data.memberId ? `:${e.data.memberId}` : ""}`);
		assert.deepEqual(kinds, ["message.user", "turn.started:main", "message.member:main", "turn.settled:main", "turn.started:ops", "message.member:ops", "turn.settled:ops", "room.activity"]);
		assert.deepEqual(live.map((e) => e.seq), [1, 2, 3, 4, 5, 6, 7, 8]);
		const said = live[2]!;
		assert.equal(said.data.text, "Main here. @ops can you check the disks?");
		assert.equal(said.data.discussionEventId, "evt-001", "payload keys are camelCase on the wire");

		const after = await api<{ items: Ev[]; latestSeq: number; hasMore: boolean }>("GET /rooms/room-abc123/events", { afterSeq: 5 });
		assert.deepEqual(after.items.map((e) => e.seq), [6, 7, 8]);
		assert.equal(after.latestSeq, 8);
		assert.equal(after.hasMore, false);
		// The same event id is the same message.
		const again = await api<{ event: Ev }>("POST /rooms/room-abc123/messages", { text: "status check please", eventId: "evt-001" });
		assert.equal(again.event.seq, 1);

		const { room: gone } = await api<{ room: Room }>("DELETE /rooms/room-abc123");
		assert.ok(gone.disbandedAt);
		await app.waitEvent((e) => e.event === "room.updated" && (e.data.room as Room).disbandedAt !== null);
		await assert.rejects(api("POST /rooms/room-abc123/messages", { text: "hello?" }), (e: { code: string }) => e.code === "conflict");
		await assert.rejects(api("GET /rooms/room-nope"), (e: { code: string }) => e.code === "not_found");
		assert.deepEqual((await api<{ items: Room[] }>("GET /rooms")).items, []);
		assert.equal((await api<{ items: Room[] }>("GET /rooms", { includeDisbanded: true })).items.length, 1);
	} finally {
		await app.close();
		await server.close();
		await core.close();
		await cleanup();
	}
});
