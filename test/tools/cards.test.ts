// Cards (src/core/cards.ts, src/tools/cards.ts): the handle on a result that can be a card, the `show` tool
// resolving it from the chat's transcript, the run ending with the reply that shows it, the card as a turn
// item live and in history, and the captions where cards are not drawn.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall, Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import { cardableLine, cardableResult, cardFor, cardHandle, cardNotesOf, genericCardFor, findCardSource, narrowCardData, withCardNotes } from "../../src/core/cards.ts";
import type { SessionEvent } from "../../src/core/events.ts";
import type { EntryRecord } from "../../src/engine/engine.ts";
import { collect, fauxModels, mcpServerConfig, tempDir, testConfig, testCore } from "../helpers.ts";
import { FakeMcpServer } from "../mcp/server.ts";

const FAST = { connectBudgetMs: 2000, probeBudgetMs: 1500, probeGapMs: 0, pingTimeoutMs: 500, backoffBaseMs: 20, backoffCapMs: 80 };
const TOOLS = [
	{ name: "mac_calendar_list_events", description: "List calendar events", inputSchema: { type: "object", properties: {} } },
	{ name: "plain", description: "No structured data", inputSchema: { type: "object", properties: {} } },
	{ name: "broken", description: "Fails with data", inputSchema: { type: "object", properties: {} } },
	{ name: "lookup", description: "Structured data the app has no card for", inputSchema: { type: "object", properties: {} } },
	{ name: "pairs", description: "Structured data of a flat shape", inputSchema: { type: "object", properties: {} } },
	{ name: "mac_weather_get", description: "Weather", inputSchema: { type: "object", properties: {} } },
];
const EVENTS = { events: [{ id: "e1", title: "Dentist" }, { id: "e2", title: "Lunch" }, { id: "e3", title: "Run" }], total: 3 };

async function setup() {
	const t = await tempDir();
	const mcp = await FakeMcpServer.start(TOOLS);
	mcp.behavior.set("mac_calendar_list_events", { text: "3 events", structured: EVENTS });
	mcp.behavior.set("plain", { text: "just text" });
	mcp.behavior.set("lookup", { text: "51.4, -0.1", structured: { place: { latitude: 51.4, longitude: -0.1 } } });
	mcp.behavior.set("pairs", { text: "51.4, -0.1", structured: { latitude: 51.4, longitude: -0.1 } });
	mcp.behavior.set("mac_weather_get", { text: "Sunny", structured: { temperature: 21, conditions: "sunny" } });
	const { models, faux } = fauxModels();
	const config = testConfig(t.dir, [{ name: "main", default: true, instructions: "test", tools: ["mcp:cal"] }], { mcp: { servers: [mcpServerConfig("cal", mcp.url, { tools: { include: ["*"], exclude: [], readOnly: ["*"] } })] } });
	const core = await testCore(t.dir, { models, config, mcpTuning: FAST });
	await new Promise<void>((resolve) => {
		const check = () => (core.mcp.status().find((s) => s.name === "cal")?.state === "online" ? resolve() : undefined);
		check();
		core.mcp.onStateChanged(check);
	});
	return {
		core,
		faux,
		cleanup: async () => {
			await core.close();
			await mcp.stop();
			await t.cleanup();
		},
	};
}

const tool = (name: string, args: Parameters<typeof fauxToolCall>[1], id: string) => fauxToolCall(name, args, { id });
const ask = (...calls: ReturnType<typeof fauxToolCall>[]) => fauxAssistantMessage(calls, { stopReason: "toolUse" });

async function run(s: Awaited<ReturnType<typeof setup>>, steps: ReturnType<typeof fauxAssistantMessage>[]) {
	const session = await s.core.sessions.create("main");
	const c = collect(s.core.hub, session.id);
	s.faux.setResponses(steps);
	await s.core.sessions.submit(session.id, "go");
	const done = (await c.until((e) => e.type === "run.finished", 10000)) as Extract<SessionEvent, { type: "run.finished" }>;
	return { session, events: c.events, done };
}

const resultText = (events: SessionEvent[], id: string) => (events.find((e) => e.type === "tool.finished" && e.callId === id) as Extract<SessionEvent, { type: "tool.finished" }> | undefined)?.resultText ?? "";

test("a kept, non-error structured result the app draws ends with its handle; one without structured data, with an error or that the app does not draw does not", async () => {
	const s = await setup();
	try {
		const r = await run(s, [ask(tool("mcp__cal__mac_calendar_list_events", {}, "call_a"), tool("mcp__cal__plain", {}, "call_b"), tool("mcp__cal__broken", {}, "call_c"), tool("mcp__cal__lookup", {}, "call_d"), tool("mcp__cal__pairs", {}, "call_e"), tool("mcp__cal__mac_weather_get", {}, "call_f")), fauxAssistantMessage([fauxText("ok")])]);
		assert.equal(resultText(r.events, "call_a"), `3 events\n\n(The owner can be shown this as a Calendar card: show {from: "${cardHandle("call_a")}"})`);
		assert.equal(cardHandle("call_a"), `c${createHash("sha256").update("call_a").digest("hex").slice(0, 5)}`);
		assert.equal(resultText(r.events, "call_b"), "just text");
		assert.doesNotMatch(resultText(r.events, "call_c"), /card/);
		assert.equal(resultText(r.events, "call_d"), "51.4, -0.1");
		assert.equal(resultText(r.events, "call_e"), `51.4, -0.1\n\n(The owner can be shown this as a Facts card: show {from: "${cardHandle("call_e")}"})`, "a flat result no dedicated card covers is a Facts card");
		assert.match(resultText(r.events, "call_f"), /as a Weather card: show \{from: "c[0-9a-f]{5}"\}\)$/);
	} finally {
		await s.cleanup();
	}
});

test("show with the reply puts a filtered card on screen and ends the run with no further model call", async () => {
	const s = await setup();
	try {
		const handle = cardHandle("call_list");
		const r = await run(s, [
			ask(tool("mcp__cal__mac_calendar_list_events", {}, "call_list")),
			fauxAssistantMessage([fauxText("Two things today."), tool("show", { from: handle, only: ["e1", "e3"], caption: "Today: 2 events" }, "call_show")], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("SHOULD NOT BE ASKED")]),
		]);
		assert.equal(s.faux.state.callCount, 2, "the run ended after the reply that showed the card");
		assert.equal(resultText(r.events, "call_show"), "Shown to the owner as a card: Today: 2 events (Dentist, Run). They can see it; don't repeat what it shows, add only what the card doesn't say.");

		const data = { events: [{ id: "e1", title: "Dentist" }, { id: "e3", title: "Run" }], total: 3 };
		const card = { type: "card", id: "call_show", kind: "result", caption: "Today: 2 events", source: { item: "call_list", name: "mcp__cal__mac_calendar_list_events", args: {} }, data, filtered: true };
		// History.
		const { turns } = await s.core.sessions.turns(r.session.id);
		const items = turns.at(-1)!.items;
		assert.deepEqual(items.filter((i) => i.type === "card").map(({ at: _at, ...rest }) => rest), [card]);
		assert.ok(!items.some((i) => i.type === "tool" && i.name === "show"), "the show call is the card, not also a tool step");
		// Live: the same item, and no step for the show call before it.
		const live = r.events.filter((e) => (e.type === "item.started" || e.type === "item.finished") && e.item.id === "call_show");
		assert.deepEqual(live.map((e) => [e.type, e.type === "item.started" || e.type === "item.finished" ? e.item.type : ""]), [["item.started", "card"], ["item.finished", "card"]]);
		const finished = live.at(-1)!;
		assert.ok(finished.type === "item.finished" && finished.item.type === "card");
		const { at: _at, ...liveCard } = finished.item;
		assert.deepEqual(liveCard, card);
		// The run's text carries the caption where cards are not drawn.
		assert.equal(r.done.text, "Two things today.\n\n[Card: Today: 2 events]");
		// The text of the answer (job summaries, group chats) and the transcript rows do too.
		const conv = s.core.sessions.require(r.session.id).conversation_id;
		const entries = await s.core.engine.entries(conv);
		const answer = entries.find((e) => (e.model?.[0] as { role?: string; content?: { name?: string }[] } | undefined)?.content?.some?.((b) => b.name === "show"));
		assert.equal(await s.core.engine.answerText(conv, answer!.id as number), "Two things today.\n\n[Card: Today: 2 events]");
		assert.ok((await s.core.sessions.rows(r.session.id)).some((row) => row.role === "tool" && row.name === "show" && row.text === "[Card: Today: 2 events]"));
	} finally {
		await s.cleanup();
	}
});

test("show without only keeps the whole result; a batch with other tools continues", async () => {
	const s = await setup();
	try {
		const r = await run(s, [
			ask(tool("mcp__cal__mac_calendar_list_events", {}, "call_list")),
			ask(tool("show", { from: cardHandle("call_list"), caption: "All" }, "call_show"), tool("mcp__cal__plain", {}, "call_plain")),
			fauxAssistantMessage([fauxText("Anything else?")]),
		]);
		assert.equal(s.faux.state.callCount, 3);
		const { turns } = await s.core.sessions.turns(r.session.id);
		const card = turns.at(-1)!.items.find((i) => i.type === "card");
		assert.ok(card?.type === "card" && card.kind === "result");
		assert.deepEqual(card.data, EVENTS);
		assert.equal(card.filtered, undefined, "a whole result is not marked filtered");
	} finally {
		await s.cleanup();
	}
});

test("show tells the model plainly when it cannot, and the failed call stays a visible tool step", async () => {
	const s = await setup();
	try {
		const r = await run(s, [
			ask(tool("mcp__cal__mac_calendar_list_events", {}, "call_list"), tool("mcp__cal__plain", {}, "call_plain")),
			ask(
				tool("show", { from: "cffff0", caption: "x" }, "s_unknown"),
				tool("show", { from: cardHandle("call_plain"), caption: "x" }, "s_nodata"),
				tool("show", { from: cardHandle("call_list"), only: ["zzz"], caption: "x" }, "s_nomatch"),
			),
			fauxAssistantMessage([fauxText("sorry")]),
		]);
		assert.match(resultText(r.events, "s_unknown"), /No result in this chat has the handle "cffff0"/);
		assert.match(resultText(r.events, "s_nodata"), /nothing to draw as a card/);
		assert.match(resultText(r.events, "s_nomatch"), /None of those ids are in the result\. It has: e1, e2, e3/);
		const { turns } = await s.core.sessions.turns(r.session.id);
		const items = turns.at(-1)!.items;
		assert.equal(items.filter((i) => i.type === "card").length, 0);
		assert.deepEqual(items.filter((i) => i.type === "tool" && i.name === "show").map((i) => i.type === "tool" && i.status), ["failed", "failed", "failed"]);
		// Live: a failed call is announced when it ends, as a tool step.
		const started = r.events.filter((e) => e.type === "item.started" && e.item.type === "tool" && e.item.name === "show");
		assert.equal(started.length, 3);
		assert.ok(r.events.indexOf(started[0]!) > r.events.findIndex((e) => e.type === "tool.finished" && e.callId === "call_plain"));
	} finally {
		await s.cleanup();
	}
});

test("narrowing keeps listed items in every list with ids, or in the data itself", () => {
	assert.deepEqual(narrowCardData([{ id: "a" }, { id: "b" }], ["b"]), [{ id: "b" }]);
	assert.deepEqual(narrowCardData({ one: [{ id: "a" }, { id: "b" }], two: [{ id: "b" }, { id: "c" }], note: [1, 2], n: 1 }, ["b"]), { one: [{ id: "b" }], two: [{ id: "b" }], note: [1, 2], n: 1 });
	assert.throws(() => narrowCardData({ one: [{ id: "a" }] }, ["x"]), /None of those ids/);
	assert.throws(() => narrowCardData({ n: 1 }, ["x"]), /no items with ids/);
});

test("two results in a chat with the same handle are refused", () => {
	const seen = new Map<string, string>();
	let pair: [string, string] | undefined;
	for (let i = 0; !pair; i++) {
		const h = cardHandle(`call_${i}`);
		const other = seen.get(h);
		if (other) pair = [other, `call_${i}`];
		else seen.set(h, `call_${i}`);
	}
	const result = (id: string) => ({ id: 1, model: [{ role: "toolResult", toolCallId: id, details: { structured: { items: [] } } }] }) as unknown as EntryRecord;
	assert.throws(() => findCardSource([result(pair[0]), result(pair[1])], cardHandle(pair[0])), /more than one result/);
	assert.equal(findCardSource([result(pair[0])], cardHandle(pair[0])).source.item, pair[0]);
});

test("captions stand in for cards in a reply's text", () => {
	const content = [{ type: "text", text: "Done." }, { type: "toolCall", id: "x", name: "show", arguments: { from: "c1", caption: " Groceries: 5 reminders " } }, { type: "toolCall", id: "y", name: "bash", arguments: { caption: "no" } }];
	assert.deepEqual(cardNotesOf(content), ["[Card: Groceries: 5 reminders]"]);
	assert.equal(withCardNotes("Done.", content), "Done.\n\n[Card: Groceries: 5 reminders]");
	assert.equal(withCardNotes("Done.", [{ type: "text", text: "Done." }]), "Done.");
});

// A tool that keeps structured data and offers it as a card, for the chats below.
const probe = defineTool({
	name: "probe",
	description: "returns a list",
	parameters: Type.Object({}),
	replay: "safe",
	execute: async (_args, api) => ({ output: [{ type: "text" as const, text: `one item\n\n${cardableLine(api.callId)}` }], details: { structured: { items: [{ id: "i1", title: "Milk" }] } } }),
});

test("a delegated bot's card reaches the caller as its caption", async () => {
	const { dir, cleanup } = await tempDir();
	const { models, faux } = fauxModels();
	const config = testConfig(dir, [
		{ name: "main", default: true, instructions: "main", tools: ["delegate"] },
		{ name: "ops", instructions: "ops", tools: ["probe"] },
	]);
	const core = await testCore(dir, { models, config, features: () => [{ groups: new Map([["probe", [probe]]]) }] });
	try {
		const s = await core.sessions.create("main");
		const c = collect(core.hub, s.id);
		faux.setResponses([
			fauxAssistantMessage([tool("delegate", { bot: "ops", task: "list it" }, "call_delegate")], { stopReason: "toolUse" }),
			ask(tool("probe", {}, "call_probe")), // ops
			fauxAssistantMessage([fauxText("Here is the list."), tool("show", { from: cardHandle("call_probe"), caption: "Shopping: 1 item" }, "call_show")], { stopReason: "toolUse" }), // ops, ends its run
			fauxAssistantMessage([fauxText("Ops showed it.")]),
		]);
		await core.sessions.submit(s.id, "ask ops");
		await c.until((e) => e.type === "run.finished", 10000);
		assert.match(resultText(c.events, "call_delegate"), /ops answered .*:\n\nHere is the list\.\n\n\[Card: Shopping: 1 item\]$/s);
	} finally {
		await core.close();
		await cleanup();
	}
});

test("the generic shape rule: a List needs a top-level array of objects that all have a string id and a title or name; Facts are a flat object of 1 to 30 short scalars", () => {
	const item = (o: Record<string, unknown> = {}) => ({ id: "a", title: "T", ...o });
	// List.
	assert.equal(genericCardFor({ items: [item()] }), "List");
	assert.equal(genericCardFor({ total: 2, tasks: [{ id: "a", name: "N" }, item()] }), "List");
	assert.equal(genericCardFor({ items: [item()], other: [item()] }), null, "two arrays are no list");
	assert.equal(genericCardFor({ items: [item()], meta: { a: { b: 1 } } }), "List", "other keys may hold anything");
	assert.equal(genericCardFor({ items: [] }), null, "an empty array is no list");
	assert.equal(genericCardFor({ items: [item(), { id: "b" }] }), null, "every element needs a title or name");
	assert.equal(genericCardFor({ items: [item({ id: 5 })] }), null, "ids are strings");
	assert.equal(genericCardFor({ items: [item(), "x"] }), null);
	assert.equal(genericCardFor([item()]), null, "a bare array is not an object holding one");
	// Facts.
	assert.equal(genericCardFor({ a: "x", b: 1.5, c: true, d: null }), "Facts");
	assert.equal(genericCardFor({ a: "x".repeat(200) }), "Facts");
	assert.equal(genericCardFor({ a: "x".repeat(201) }), null);
	assert.equal(genericCardFor({ a: Number.POSITIVE_INFINITY }), null);
	assert.equal(genericCardFor({ a: { b: 1 } }), null, "no nesting");
	assert.equal(genericCardFor({ a: ["x"] }), null);
	assert.equal(genericCardFor({}), null);
	assert.equal(genericCardFor({ a: null }), null, "nothing but nulls says nothing");
	assert.equal(genericCardFor(Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, i]))), "Facts");
	assert.equal(genericCardFor(Object.fromEntries(Array.from({ length: 31 }, (_, i) => [`k${i}`, i]))), null);
	assert.equal(genericCardFor("text"), null);
	assert.equal(genericCardFor(null), null);
});

test("cardFor: a dedicated card by tool name (MCP by its own name on any server), else the shape's, else none", () => {
	assert.equal(cardFor("mcp__bridge__mac_reminders_list_reminders", { x: [] }), "Reminders");
	assert.equal(cardFor("mcp__bridge__mac_maps_travel_time", { a: [{}] }), "Travel time");
	assert.equal(cardFor("mcp__bridge__mac_bridge_status", {}), "MacBridge status");
	assert.equal(cardFor("schedule_list", { jobs: [] }), "Scheduled tasks");
	assert.equal(cardFor("schedule_history", { job: {}, runs: [] }), "Scheduled task");
	assert.equal(cardFor("web_fetch", { url: "https://example.com/", status: 200 }), "Page");
	assert.equal(cardFor("mcp__other__web_fetch", { url: "https://example.com/", status: 200 }), "Facts", "an MCP server's tool of that name is not the gateway's");
	assert.equal(cardFor("mcp__notes__list", { notes: [{ id: "1", title: "Milk" }] }), "List");
	assert.equal(cardFor("mcp__notes__list", { nested: { a: 1 } }), null);
	assert.equal(cardFor("mcp__bridge__mac_weather_get", undefined), null);
});

test("cardableResult keeps structured data up to 256 KB and adds the named handle line only for a result that is not an error and becomes a card", () => {
	const line = (card: string) => `(The owner can be shown this as a ${card} card: show {from: "${cardHandle("c1")}"})`;
	assert.deepEqual(cardableResult("c1", "mcp__s__mac_weather_get", { t: 1 }), { structured: { t: 1 }, line: line("Weather") });
	assert.deepEqual(cardableResult("c1", "mcp__s__mac_weather_get", { t: 1 }, true), { structured: { t: 1 } }, "never a handle on an error");
	assert.deepEqual(cardableResult("c1", "x", { a: { b: 1 } }), { structured: { a: { b: 1 } } }, "no card, no line");
	assert.deepEqual(cardableResult("c1", "x", undefined), {});
	assert.deepEqual(cardableResult("c1", "x", { big: "x".repeat(256 * 1024) }), {}, "over 256 KB is not kept");
	assert.equal(cardableLine("c1"), `(The owner can be shown this as a card: show {from: "${cardHandle("c1")}"})`);
});
