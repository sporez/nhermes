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
