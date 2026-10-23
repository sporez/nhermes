// Pins the parts of Pi Durable 1.2.0 this project relies on. Run first after any Pi upgrade.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, Type } from "@earendil-works/pi-ai";
import {
	type AgentEvent,
	createRegistry,
	defineExtension,
	defineTool,
	Harness,
	hook,
	section,
	ToolTask,
	watchEvents,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

const ctx = BACKGROUND_CONTEXT;

function setup() {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const model = faux.getModel();
	return { faux, models, ref: { provider: model.provider, modelId: model.id } };
}

test("sqlite harness: submit, stream events, answer, reopen sees the transcript", async () => {
	const dir = await mkdtemp(join(tmpdir(), "nh-durable-"));
	try {
		const { faux, models, ref } = setup();
		const registry = createRegistry();
		registry.install(defineExtension({ name: "persona", sections: [section("persona", () => "You are terse.")] }));
		faux.setResponses([fauxAssistantMessage([fauxText("Hello there, Neil.")])]);
		let harness = await Harness.open(await openNodeSqliteStorage(join(dir, "d.sqlite")), { models, registry }, ctx);
		const conv = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: ref } }, ctx);
		const stream = await watchEvents(harness, conv.id, ctx);
		const events: AgentEvent[] = [];
		stream.start(async (batch) => {
			events.push(...batch);
		});
		const sub = await conv.submit({ type: "input", content: "hi", requestId: "r1" }, ctx);
		const settled = await sub.wait(ctx);
		assert.equal(settled.status, "done");
		await harness.waitForIdle(ctx);
		await stream.stop();
		const types = events.map((e) => e.type);
		assert.ok(types.includes("run_start"), `run_start in ${types}`);
		assert.ok(types.includes("run_end"), `run_end in ${types}`);
		assert.ok(types.includes("message_end"));
		// Same requestId returns the same submission (idempotent admission).
		const again = await conv.submit({ type: "input", content: "hi", requestId: "r1" }, ctx);
		assert.equal(again.id, sub.id);
		await harness.close(ctx);

		harness = await Harness.open(await openNodeSqliteStorage(join(dir, "d.sqlite")), { models, registry }, ctx);
		const reopened = await harness.conversation(conv.id, ctx);
		assert.ok(reopened);
		const page = await reopened.entries({}, 50, undefined, ctx);
		const kinds = page.items.map((e) => e.kind);
		assert.ok(kinds.includes("pi.user") && kinds.includes("pi.assistant"), `${kinds}`);
		await harness.close(ctx);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("beforeTool hook can wait asynchronously and block before the tool runs", async () => {
	const { faux, models, ref } = setup();
	let ran = 0;
	const danger = defineTool({
		name: "danger",
		description: "does something risky",
		parameters: Type.Object({ what: Type.String() }),
		execute: async () => {
			ran++;
			return { output: [{ type: "text", text: "done" }] };
		},
	});
	let asked = 0;
	const guard = defineExtension({
		name: "guard",
		hooks: [
			hook(ToolTask, {
				beforeTool: async (call) => {
					asked++;
					await new Promise((r) => setTimeout(r, 20));
					return call.name === "danger" ? { block: "denied by owner" } : undefined;
				},
			}),
		],
	});
	const registry = createRegistry();
	registry.install(defineExtension({ name: "tools", tools: [danger] }));
	registry.install(guard);
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("danger", { what: "x" })], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxText("ok, I will not.")]),
	]);
	const { MemoryStorage } = await import("@earendil-works/pi-durable");
	const harness = await Harness.open(new MemoryStorage(), { models, registry }, ctx);
	const conv = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: ref } }, ctx);
	const settled = await (await conv.submit({ type: "input", content: "do it" }, ctx)).wait(ctx);
	assert.equal(settled.status, "done");
	assert.equal(asked, 1);
	assert.equal(ran, 0);
	const page = await conv.entries({}, 50, undefined, ctx);
	const result = page.items.find((e) => e.kind === "pi.tool-result");
	assert.ok(result, "tool result entry exists");
	assert.match(JSON.stringify(result), /denied by owner/);
	await harness.close(ctx);
});

test("transcript records what the client API's turns are built from", async () => {
	const { faux, models, ref } = setup();
	const lookup = defineTool({
		name: "lookup",
		description: "looks something up",
		parameters: Type.Object({ q: Type.String() }),
		replay: "safe",
		execute: async () => ({ output: [{ type: "text", text: "found it" }], details: { structured: { items: [1, 2] } } }),
	});
	const registry = createRegistry();
	registry.install(defineExtension({ name: "tools", tools: [lookup] }));
	faux.setResponses([
		fauxAssistantMessage([fauxText("Looking."), fauxToolCall("lookup", { q: "x" })], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxText("Done.")]),
	]);
	const { MemoryStorage } = await import("@earendil-works/pi-durable");
	const harness = await Harness.open(new MemoryStorage(), { models, registry }, ctx);
	const conv = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: ref } }, ctx);
	const stream = await watchEvents(harness, conv.id, ctx);
	const events: AgentEvent[] = [];
	stream.start(async (batch) => {
		events.push(...batch);
	});
	await (await conv.submit({ type: "input", content: "find x" }, ctx)).wait(ctx);
	await harness.waitForIdle(ctx);
	// A write entry is appended after the run, with its data, and the model never sees it.
	await (await conv.submit({ type: "write", entry: { kind: "nh.run", data: { turn: 1, status: "complete" } } }, ctx)).wait(ctx);
	await stream.stop();
	const entries = (await conv.entries({ order: "ascending" }, 50, undefined, ctx)).items;
	type M = { role: string; timestamp?: number; content: { type: string; id?: string; name?: string; arguments?: unknown }[]; toolCallId?: string; isError?: boolean; durationMs?: number; details?: unknown };
	const msgs = entries.map((e) => e.model?.[0] as M | undefined);
	const user = entries.findIndex((e) => (e.model?.[0] as M | undefined)?.role === "user");
	assert.ok(user >= 0 && typeof msgs[user]!.timestamp === "number", "user messages carry a timestamp");
	// The user message's entry is announced at message_end, so a live turn can be named by it.
	const userEnd = events.find((e) => e.type === "message_end" && (e.entry.model?.[0] as M | undefined)?.role === "user");
	assert.equal(userEnd?.type === "message_end" ? userEnd.entry.id : undefined, entries[user]!.id);
	const call = msgs.flatMap((m) => m?.content ?? []).find((b) => b.type === "toolCall");
	assert.ok(call?.id && call.name === "lookup", "tool calls carry their id and name");
	assert.deepEqual(call.arguments, { q: "x" });
	const result = msgs.find((m) => m?.role === "toolResult");
	assert.equal(result?.toolCallId, call.id);
	assert.equal(result?.isError, false);
	assert.equal(typeof result?.durationMs, "number", "tool results carry their duration");
	assert.deepEqual(result?.details, { structured: { items: [1, 2] } }, "a tool's details are kept with its result");
	const start = events.find((e) => e.type === "tool_execution_start");
	assert.equal(start?.type === "tool_execution_start" ? start.toolCallId : undefined, call.id, "live tool events use the same call id");
	const run = entries.at(-1)!;
	assert.equal(run.kind, "nh.run");
	assert.deepEqual(run.data, { turn: 1, status: "complete" });
	assert.equal(run.model, undefined);
	await harness.close(ctx);
});
