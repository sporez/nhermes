// The client API's chats against the real server: turns live and in history with the same ids, following a
// chat mid-answer, approvals heard and answered on any device, chat settings, commands and redaction.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxThinking, fauxToolCall, Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import type { Core } from "../../src/app.ts";
import type { MemberRow } from "../../src/federation/members.ts";
import { DEFAULT_TOOL_GROUPS } from "../../src/core/bots.ts";
import { registerSecret } from "../../src/log.ts";
import { type GatewayServer, startServer } from "../../src/server.ts";
import { tempDir, testConfig, testCore } from "../helpers.ts";
import { type ApiEvent, ApiSocketClient, http } from "./client.ts";

const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1", reasoning: true }, { id: "faux-2" }], tokensPerSecond: 400 });
const models = createModels();
models.setProvider(faux.provider);
let core: Core;
let server: GatewayServer;
let cleanup: () => Promise<void>;

// A tool that returns structured data beside its text, as an MCP server's structuredContent arrives.
const probe = defineTool({
	name: "probe",
	description: "returns a list",
	parameters: Type.Object({ what: Type.String() }),
	replay: "safe",
	execute: async () => ({ output: [{ type: "text", text: "two items" }], details: { structured: { items: ["a", "b"] } } }),
});

before(async () => {
	const t = await tempDir();
	cleanup = t.cleanup;
	const config = testConfig(t.dir, [
		{ name: "main", displayName: "Main", default: true, instructions: "You are the main test bot.", tools: [...DEFAULT_TOOL_GROUPS, "probe"] },
		{ name: "ops", displayName: "Ops", instructions: "You are the ops test bot.", trusted: true },
	]);
	core = await testCore(t.dir, { models, config, features: () => [{ groups: new Map([["probe", [probe]]]), extensions: [] }] });
	server = await startServer(core, { host: "127.0.0.1", port: 0, federationPort: null });
});

after(async () => {
	await server.close();
	await core.close();
	await cleanup();
});

const api = () => http(server.port);
const socket = () => ApiSocketClient.connect(server.port);
type Session = { id: string; botId: string; title: string; running: boolean; model: { provider: string; id: string }; thinking: string; yolo: boolean; messageCount: number };
type Item = { type: string; id: string; text?: string; name?: string; status?: string; args?: Record<string, unknown>; durationMs?: number | null; isError?: boolean; result?: { text: string; truncated: boolean; length: number; json?: unknown } | null };
type Turn = { id: string; status: string; startedAt: number; endedAt: number | null; user: { content: { type: string; text?: string }[]; requestId?: string } | null; items: Item[] };
const chatEvents = (c: ApiSocketClient, sid: string) => c.events.filter((e) => e.sessionId === sid);
const finished = (sid: string) => (e: ApiEvent) => e.event === "turn.finished" && e.sessionId === sid;

async function newChat(c: ApiSocketClient, params: Record<string, unknown> = {}): Promise<string> {
	const { session } = await c.call<{ session: Session }>("sessions.create", params);
	await c.call("sessions.subscribe", { id: session.id });
	return session.id;
}

test("a turn streams as turn.started → item events → turn.finished, and history names the same turn and items", async () => {
	const c = await socket();
	const sid = await newChat(c);
	faux.setResponses([fauxAssistantMessage([fauxThinking("Let me think."), fauxText("Hello Neil, the gateway is working.")])]);
	const r = await c.call<{ status: string }>("sessions.submit", { id: sid, text: "say hello", requestId: "req-1" });
	assert.equal(r.status, "started");
	const done = await c.waitEvent(finished(sid));
	assert.equal(done.data.status, "complete");
	const events = chatEvents(c, sid);
	const names = events.map((e) => e.event);
	assert.equal(names[0], "turn.started", names.join(","));
	const seqs = events.map((e) => e.seq!);
	assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), "seq only grows");
	const turnId = (events[0]!.data.turn as Turn).id;
	assert.deepEqual((events[0]!.data.turn as Turn).user?.content, [{ type: "text", text: "say hello" }]);
	const text = events.filter((e) => e.event === "item.delta" && e.data.itemId === `${turnId}.1t`).map((e) => e.data.text).join("");
	assert.equal(text, "Hello Neil, the gateway is working.");
	const finishedItems = events.filter((e) => e.event === "item.finished").map((e) => (e.data.item as Item).id);
	assert.deepEqual(finishedItems, [`${turnId}.1r`, `${turnId}.1t`]);

	const page = await api()<{ items: Turn[]; nextCursor: string | null }>(`GET /sessions/${sid}/turns`);
	assert.equal(page.nextCursor, null);
	const turn = page.items.at(-1)!;
	assert.equal(turn.id, turnId);
	assert.equal(turn.status, "complete");
	assert.ok(turn.endedAt! >= turn.startedAt, "the run record gives the turn its end");
	assert.deepEqual(turn.items.map((i) => [i.type, i.id]), [["reasoning", `${turnId}.1r`], ["text", `${turnId}.1t`]]);
	assert.equal(turn.items[1]!.text, "Hello Neil, the gateway is working.");
	assert.equal((events[0]!.data.turn as Turn).user?.requestId, "req-1", "the turn names the message's requestId live");
	assert.equal(turn.user?.requestId, "req-1", "and in history");
	// The same requestId is the same message: nothing is sent twice.
	const again = await c.call<{ submission: string }>("sessions.submit", { id: sid, text: "say hello", requestId: "req-1" });
	assert.equal(again.submission, "done");
	assert.equal((await api()<{ items: Turn[] }>(`GET /sessions/${sid}/turns`)).items.length, 1);
	await c.close();
});

test("a message that waited behind a run names its requestId when its turn starts, and in a later snapshot", async () => {
	const c = await socket();
	const sid = await newChat(c);
	faux.setResponses([fauxAssistantMessage([fauxText("word ".repeat(200).trim())]), fauxAssistantMessage([fauxText("Second.")])]);
	await c.call("sessions.submit", { id: sid, text: "first" });
	await c.waitEvent((e) => e.event === "item.delta" && e.sessionId === sid);
	const queued = await c.call<{ status: string }>("sessions.submit", { id: sid, text: "second", requestId: "req-queued" });
	assert.equal(queued.status, "queued");
	await c.waitEvent((e) => finished(sid)(e) && chatEvents(c, sid).filter((x) => x.event === "turn.finished").length === 2, 15000);
	const started = chatEvents(c, sid).filter((e) => e.event === "turn.started").map((e) => (e.data.turn as Turn).user);
	assert.deepEqual(started.map((u) => u?.requestId), [undefined, "req-queued"], "a message sent without one names none");
	const c2 = await socket();
	const snap = await c2.call<{ turns: { items: Turn[] } }>("sessions.subscribe", { id: sid });
	assert.deepEqual(snap.turns.items.map((t) => t.user?.requestId), [undefined, "req-queued"]);
	await c.close();
	await c2.close();
});

test("tool calls are items with their arguments, result, duration and status; replies split by them are separate items", async () => {
	const c = await socket();
	const sid = await newChat(c);
	faux.setResponses([
		fauxAssistantMessage([fauxText("Checking."), fauxToolCall("probe", { what: "list" })], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxText("There are two.")]),
	]);
	await c.call("sessions.submit", { id: sid, text: "how many?" });
	await c.waitEvent(finished(sid));
	const live = chatEvents(c, sid).filter((e) => e.event === "item.finished").map((e) => e.data.item as Item);
	const tool = live.find((i) => i.type === "tool")!;
	assert.equal(tool.name, "probe");
	assert.deepEqual(tool.args, { what: "list" });
	assert.equal(tool.status, "done");
	assert.equal(tool.isError, false);
	assert.equal(tool.result?.text, "two items");
	assert.deepEqual(tool.result?.json, { items: ["a", "b"] });
	assert.equal(typeof tool.durationMs, "number");
	const updated = chatEvents(c, sid).find((e) => e.event === "item.updated" && (e.data.item as Item).id === tool.id);
	assert.ok(updated, "a running tool is announced when it starts");

	const turn = (await api()<{ items: Turn[] }>(`GET /sessions/${sid}/turns`)).items.at(-1)!;
	assert.deepEqual(turn.items.map((i) => i.type), ["text", "tool", "text"]);
	assert.deepEqual(turn.items.map((i) => i.id), live.map((i) => i.id), "history and live name the items alike");
	const histTool = turn.items[1]!;
	assert.deepEqual(histTool.result?.json, { items: ["a", "b"] });
	assert.equal(histTool.durationMs, tool.durationMs);
	const full = await api()<{ text: string; json: unknown }>(`GET /sessions/${sid}/items/${tool.id}/result`);
	assert.equal(full.text, "two items");
	await c.close();
});

test("following a chat mid-answer: the snapshot holds the partial reply, and later deltas extend the same item", async () => {
	const c1 = await socket();
	const sid = await newChat(c1);
	const long = "word ".repeat(400).trim();
	faux.setResponses([fauxAssistantMessage([fauxText(long)])]);
	await c1.call("sessions.submit", { id: sid, text: "tell me a long story" });
	await c1.waitEvent((e) => e.event === "item.delta" && e.sessionId === sid);
	await c1.close();

	const c2 = await socket();
	const snap = await c2.call<{ session: Session; seq: number; turns: { items: Turn[] } }>("sessions.subscribe", { id: sid });
	assert.equal(snap.session.running, true);
	const turn = snap.turns.items.at(-1)!;
	assert.equal(turn.status, "running");
	assert.equal(turn.endedAt, null);
	const partial = turn.items.find((i) => i.type === "text")!;
	assert.ok(long.startsWith(partial.text!), "the partial is a prefix of the answer");
	await c2.waitEvent(finished(sid), 15000);
	const later = chatEvents(c2, sid).filter((e) => e.seq! > snap.seq && e.event === "item.delta");
	assert.ok(later.every((e) => e.data.itemId === partial.id));
	assert.equal(partial.text + later.map((e) => e.data.text).join(""), long, "snapshot + later deltas = the whole answer");
	await c2.close();
});

test("approvals reach every device, whoever answers; the answer is enforced and announced", async () => {
	const a = await socket();
	const b = await socket(); // not following the chat
	const sid = await newChat(a);
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("bash", { command: "rm -rf ./tmpdir; echo cleaned" })], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxText("Done cleaning.")]),
	]);
	await a.call("sessions.submit", { id: sid, text: "clean tmpdir" });
	const onB = await b.waitEvent("approval.requested");
	const approval = onB.data.approval as { id: string; sessionId: string; patternKey: string; toolCallId: string; choices: string[] };
	assert.equal(approval.sessionId, sid);
	assert.equal(approval.patternKey, "rm -rf");
	await a.waitEvent("approval.requested");
	const listed = await api()<{ items: { id: string }[] }>("GET /approvals", { sessionId: sid });
	assert.deepEqual(listed.items.map((x) => x.id), [approval.id]);
	const snap = await b.call<{ approvals: { id: string }[] }>("sessions.subscribe", { id: sid });
	assert.deepEqual(snap.approvals.map((x) => x.id), [approval.id]);
	await a.call("approvals.answer", { id: approval.id, choice: "once" });
	const resolved = await b.waitEvent("approval.resolved");
	assert.deepEqual(resolved.data, { id: approval.id, sessionId: sid, choice: "once", reason: "answered" });
	await a.waitEvent(finished(sid));
	const tool = chatEvents(a, sid).map((e) => e.data.item as Item | undefined).find((i) => i?.type === "tool" && i.status === "done");
	assert.equal(tool?.id, approval.toolCallId, "the card names the tool call it holds");
	assert.match(tool!.result!.text, /cleaned/);
	await assert.rejects(a.call("approvals.answer", { id: approval.id, choice: "once" }), (e: { code: string }) => e.code === "approval_not_found");
	await a.close();
	await b.close();
});

test("a denied call is a blocked tool item, and an interrupt ends the turn as interrupted", async () => {
	const c = await socket();
	const sid = await newChat(c);
	faux.setResponses([fauxAssistantMessage([fauxToolCall("bash", { command: "rm -rf ./x" })], { stopReason: "toolUse" }), fauxAssistantMessage([fauxText("I did not.")])]);
	await c.call("sessions.submit", { id: sid, text: "delete x" });
	const ask = await c.waitEvent("approval.requested");
	await c.call("approvals.answer", { id: (ask.data.approval as { id: string }).id, choice: "deny" });
	await c.waitEvent(finished(sid));
	const blocked = chatEvents(c, sid).map((e) => e.data.item as Item | undefined).find((i) => i?.type === "tool" && i.status !== "running");
	assert.equal(blocked?.status, "blocked");
	assert.equal(blocked?.isError, true);

	faux.setResponses([fauxAssistantMessage([fauxToolCall("bash", { command: "mkfs.ext4 /dev/sdz" })], { stopReason: "toolUse" }), fauxAssistantMessage([fauxText("ok")])]);
	await c.call("sessions.submit", { id: sid, text: "format it" });
	const second = await c.waitEvent((e) => e.event === "approval.requested" && (e.data.approval as { id: string }).id !== (ask.data.approval as { id: string }).id);
	assert.equal((await c.call<{ interrupted: boolean }>("sessions.interrupt", { id: sid })).interrupted, true);
	const withdrawn = await c.waitEvent((e) => e.event === "approval.resolved" && e.data.id === (second.data.approval as { id: string }).id);
	assert.equal(withdrawn.data.reason, "cancelled");
	const end = await c.waitEvent((e) => finished(sid)(e) && e.data.status === "interrupted");
	assert.equal(end.data.status, "interrupted");
	const turns = (await api()<{ items: Turn[] }>(`GET /sessions/${sid}/turns`)).items;
	assert.equal(turns.at(-1)!.status, "interrupted");
	await c.close();
});

test("chat settings: title, pin, archive, model, reasoning and Bypass, announced as session.updated", async () => {
	const c = await socket();
	const sid = await newChat(c);
	const { session } = await api()<{ session: Session }>(`PATCH /sessions/${sid}`, { title: "Plans", pinned: true, model: "faux/faux-2", thinking: "low", yolo: true });
	assert.equal(session.title, "Plans");
	assert.deepEqual(session.model, { provider: "faux", id: "faux-2" });
	assert.equal(session.thinking, "low");
	assert.equal(session.yolo, true);
	const updated = await c.waitEvent((e) => e.event === "session.updated" && (e.data.session as Session).id === sid && (e.data.session as Session).yolo);
	assert.equal((updated.data.session as Session).title, "Plans");
	await assert.rejects(api()(`PATCH /sessions/${sid}`, { model: "faux/nope" }), (e: { code: string }) => e.code === "invalid_params");
	await assert.rejects(api()(`PATCH /sessions/${sid}`, { thinking: "max" }), (e: { code: string }) => e.code === "invalid_params");
	const found = await api()<{ items: Session[] }>("GET /sessions", { q: "Plans" });
	assert.deepEqual(found.items.map((s) => s.id), [sid]);
	await api()(`PATCH /sessions/${sid}`, { archived: true });
	assert.ok(!(await api()<{ items: Session[] }>("GET /sessions")).items.some((s) => s.id === sid), "archived chats are left out by default");
	assert.ok((await api()<{ items: Session[] }>("GET /sessions", { archived: "only" })).items.some((s) => s.id === sid));
	await api()(`DELETE /sessions/${sid}`);
	const gone = await c.waitEvent((e) => e.event === "session.deleted" && e.data.id === sid);
	assert.equal(gone.data.botId, "main");
	await assert.rejects(api()(`GET /sessions/${sid}`), (e: { code: string; status: number }) => e.code === "session_not_found" && e.status === 404);
	await c.close();
});

test("bots, models and commands", async () => {
	const { items: bots } = await api()<{ items: { id: string; kind: string; node: unknown; isDefault: boolean; model: { provider: string } }[] }>("GET /bots");
	assert.deepEqual(bots.map((b) => [b.id, b.kind, b.node, b.isDefault]), [["main", "local", null, true], ["ops", "local", null, false]]);
	const m = await api()<{ providers: { id: string; models: { id: string; thinkingLevels: string[] }[] }[]; current: { provider: string; id: string } }>("GET /models", { botId: "main" });
	const fauxProv = m.providers.find((p) => p.id === "faux")!;
	assert.deepEqual(fauxProv.models.map((x) => x.id), ["faux-1", "faux-2"]);
	assert.ok(fauxProv.models[0]!.thinkingLevels.includes("xhigh"));
	assert.deepEqual(fauxProv.models[1]!.thinkingLevels, ["off"]);
	assert.deepEqual(m.current, { provider: "faux", id: "faux-1" });

	const c = await socket();
	const sid = await newChat(c);
	const { items } = await c.call<{ items: { name: string; kind: string }[] }>("sessions.commands", { id: sid });
	assert.ok(items.some((x) => x.name === "compact" && x.kind === "builtin"));
	const usage = await c.call<{ kind: string; text: string }>("sessions.command", { id: sid, name: "/usage" });
	assert.equal(usage.kind, "output");
	assert.match(usage.text, /Model faux\/faux-1/);
	await assert.rejects(c.call("sessions.command", { id: sid, name: "nope" }), (e: { code: string }) => e.code === "invalid_params");
	const ctx = await c.call<{ parts: { id: string }[]; max: number }>("sessions.context", { id: sid });
	assert.deepEqual(ctx.parts.map((p) => p.id), ["system", "tools", "conversation", "free"]);
	await c.close();
});

test("turns, items, events and approvals never carry a registered secret", async () => {
	const secret = "api-secret-\"quoted\"-value-7c1d";
	registerSecret(secret);
	const c = await socket();
	const sid = await newChat(c);
	faux.setResponses([
		fauxAssistantMessage([fauxThinking(`thinking about ${secret}`), fauxText(`here: ${secret}`), fauxToolCall("bash", { command: `echo '${secret}'; rm -rf ./tmpdir` })], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxText("done")]),
	]);
	await c.call("sessions.submit", { id: sid, text: `remember ${secret}` });
	const ask = await c.waitEvent("approval.requested");
	await c.call("approvals.answer", { id: (ask.data.approval as { id: string }).id, choice: "once" });
	await c.waitEvent(finished(sid));
	for (const e of c.events) assert.ok(!JSON.stringify(e).includes("api-secret"), JSON.stringify(e));
	const turns = await api()(`GET /sessions/${sid}/turns`);
	assert.ok(!JSON.stringify(turns).includes("api-secret"), "history is redacted");
	await c.close();
});

test("a network member sees only the chats it started, cannot list chats, and cannot switch approvals off", async () => {
	const member = { node_id: "node-b", name: "b" } as MemberRow;
	const cx = { core, caller: { kind: "member" as const, member } };
	const op = (name: string) => server.api.ops.get(name)!;
	const own = (await server.api.ops.call(op("sessions.create"), {}, cx)) as { session: Session & { source: string } };
	assert.equal(own.session.source, "member:node-b");
	const owners = await api()<{ session: Session }>("POST /sessions", {});
	await assert.rejects(server.api.ops.call(op("sessions.get"), { id: owners.session.id }, cx), (e: { code: string }) => e.code === "session_not_found");
	await assert.rejects(server.api.ops.call(op("sessions.list"), {}, cx), (e: { code: string }) => e.code === "unknown_op");
	await assert.rejects(server.api.ops.call(op("sessions.update"), { id: own.session.id, yolo: true }, cx), (e: { code: string }) => e.code === "not_allowed");
	const { items } = (await server.api.ops.call(op("bots.list"), {}, cx)) as { items: { id: string }[] };
	assert.deepEqual(items.map((b) => b.id), ["main", "ops"]);
	await assert.rejects(server.api.ops.call(op("approvals.answer"), { id: "nope", choice: "once" }, cx), (e: { code: string }) => e.code === "approval_not_found");
});

test("a client back soon after a drop gets only the events it missed, then the rest live", async () => {
	const c1 = await socket();
	const sid = await newChat(c1);
	const long = "word ".repeat(400).trim();
	faux.setResponses([fauxAssistantMessage([fauxText(long)])]);
	await c1.call("sessions.submit", { id: sid, text: "a long one" });
	await c1.waitEvent((e) => e.event === "item.delta" && e.sessionId === sid);
	const seen = chatEvents(c1, sid);
	const lastSeq = seen.at(-1)!.seq!;
	const before = seen.filter((e) => e.event === "item.delta").map((e) => e.data.text).join("");
	await c1.close();

	const c2 = await socket();
	const back = await c2.call<{ seq: number; replay?: ApiEvent[]; turns?: unknown }>("sessions.subscribe", { id: sid, afterSeq: lastSeq });
	assert.ok(back.replay, "the missed events, not a snapshot");
	assert.equal(back.turns, undefined);
	assert.ok(back.replay.every((e) => e.seq! > lastSeq));
	await c2.waitEvent(finished(sid), 15000);
	const live = chatEvents(c2, sid).filter((e) => e.seq! > back.seq);
	const text = [...back.replay, ...live].filter((e) => e.event === "item.delta").map((e) => e.data.text).join("");
	assert.equal(before + text, long, "what was seen + what was missed + what followed = the whole answer");
	// A seq the gateway no longer covers gets a snapshot.
	const c3 = await socket();
	const fresh = await c3.call<{ replay?: unknown; turns?: { items: unknown[] } }>("sessions.subscribe", { id: sid, afterSeq: 999_999 });
	assert.equal(fresh.replay, undefined);
	assert.ok(fresh.turns!.items.length >= 1);
	await c2.close();
	await c3.close();
});
