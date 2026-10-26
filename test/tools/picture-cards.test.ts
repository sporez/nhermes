// Picture cards (src/tools/cards.ts, src/core/attachments.ts keepPicture): a screenshot a tool returned, shown by
// its handle, or a picture file on the bot's machine, shown by path. The picture is kept as an attachment of the
// chat that the card names; it counts as sent, so it can't be withdrawn.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall, Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import { IMAGE_MAX_BYTES } from "../../src/core/attachments.ts";
import { cardHandle, findCardSource, pictureLine } from "../../src/core/cards.ts";
import type { SessionEvent } from "../../src/core/events.ts";
import type { EntryRecord } from "../../src/engine/engine.ts";
import { collect, fauxModels, mcpServerConfig, pngBytes, tempDir, testConfig, testCore } from "../helpers.ts";
import { FakeMcpServer } from "../mcp/server.ts";

const PNG = pngBytes(12, 9);
const shot = defineTool({
	name: "shot",
	description: "Takes a picture",
	parameters: Type.Object({}),
	replay: "safe",
	execute: async (_a, api) => ({ output: [{ type: "text", text: `A picture.\n\n${pictureLine(api.callId)}` }, { type: "image", data: PNG.toString("base64"), mimeType: "image/png" }] }),
});

async function setup() {
	const t = await tempDir();
	const { models, faux } = fauxModels();
	const config = testConfig(t.dir, [{ name: "main", default: true, instructions: "test", tools: ["shots"] }]);
	const core = await testCore(t.dir, { models, config, features: () => [{ groups: new Map([["shots", [shot]]]) }] });
	const workspace = core.bots.require("main").workspace!;
	mkdirSync(workspace, { recursive: true });
	return {
		core,
		faux,
		workspace,
		cleanup: async () => {
			await core.close();
			await t.cleanup();
		},
	};
}

const ask = (...calls: ReturnType<typeof fauxToolCall>[]) => fauxAssistantMessage(calls, { stopReason: "toolUse" });
const call = (name: string, args: Parameters<typeof fauxToolCall>[1], id: string) => fauxToolCall(name, args, { id });

async function run(s: Awaited<ReturnType<typeof setup>>, steps: ReturnType<typeof fauxAssistantMessage>[]) {
	const session = await s.core.sessions.create("main");
	const c = collect(s.core.hub, session.id);
	s.faux.setResponses(steps);
	await s.core.sessions.submit(session.id, "go");
	await c.until((e) => e.type === "run.finished", 10000);
	return { session, events: c.events };
}

const finished = (events: SessionEvent[], id: string) => events.find((e) => e.type === "tool.finished" && e.callId === id) as Extract<SessionEvent, { type: "tool.finished" }>;
const cardOf = async (s: Awaited<ReturnType<typeof setup>>, sessionId: string) => (await s.core.sessions.turns(sessionId)).turns.at(-1)!.items.find((i) => i.type === "card");

test("a tool result with a picture ends with the line that names its handle", async () => {
	const s = await setup();
	try {
		const r = await run(s, [ask(call("shot", {}, "call_shot")), fauxAssistantMessage([fauxText("ok")])]);
		assert.equal(finished(r.events, "call_shot").resultText, `A picture.\n\n(The owner can be shown this picture: show {from: "${cardHandle("call_shot")}"})`);
	} finally {
		await s.cleanup();
	}
});

test("show from a picture result makes an image card whose attachment serves the exact bytes, and it can't be withdrawn", async () => {
	const s = await setup();
	try {
		const r = await run(s, [
			ask(call("shot", {}, "call_shot")),
			fauxAssistantMessage([fauxText("Here."), call("show", { from: cardHandle("call_shot"), caption: "The screen" }, "call_show")], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("SHOULD NOT BE ASKED")]),
		]);
		assert.equal(s.faux.state.callCount, 2);
		assert.equal(finished(r.events, "call_show").resultText, "Shown to the owner as a picture: The screen. They can see it; don't repeat what it shows, add only what the picture doesn't say.");
		const card = await cardOf(s, r.session.id);
		assert.ok(card?.type === "card" && card.kind === "image");
		assert.equal(card.caption, "The screen");
		assert.deepEqual("source" in card ? card.source : undefined, { item: "call_shot", name: "shot", args: {} });
		const att = (card.data as { attachment: { id: string; kind: string; name: string; mime: string; size: number } }).attachment;
		assert.deepEqual({ kind: att.kind, name: att.name, mime: att.mime, size: att.size }, { kind: "image", name: "shot.png", mime: "image/png", size: PNG.length });
		const served = s.core.attachments.content(att.id)!;
		assert.equal(served.sessionId, r.session.id);
		assert.ok(readFileSync(served.path).equals(PNG));
		assert.equal(s.core.attachments.withdraw(r.session.id, att.id), false, "kept as already sent");
		assert.ok(readFileSync(served.path).equals(PNG));
	} finally {
		await s.cleanup();
	}
});

test("show with only on a picture is refused plainly", async () => {
	const s = await setup();
	try {
		const r = await run(s, [
			ask(call("shot", {}, "call_shot")),
			ask(call("show", { from: cardHandle("call_shot"), only: ["a"], caption: "x" }, "call_only")),
			fauxAssistantMessage([fauxText("ok")]),
		]);
		const out = finished(r.events, "call_only");
		assert.match(out.resultText, /only picks items from a result with a list; a picture is shown whole/);
		assert.equal(await cardOf(s, r.session.id), undefined);
	} finally {
		await s.cleanup();
	}
});

test("show {card: image, path} reads a picture file on the bot's machine", async () => {
	const s = await setup();
	try {
		const path = join(s.workspace, "chart.png");
		writeFileSync(path, PNG);
		const r = await run(s, [ask(call("show", { card: { kind: "image", path }, caption: "The chart" }, "call_show")), fauxAssistantMessage([fauxText("ok")])]);
		const card = await cardOf(s, r.session.id);
		assert.ok(card?.type === "card" && card.kind === "image");
		assert.equal("source" in card, false, "a file has no source result");
		const att = (card.data as { attachment: { id: string; name: string } }).attachment;
		assert.equal(att.name, "chart.png");
		assert.ok(readFileSync(s.core.attachments.content(att.id)!.path).equals(PNG));
		assert.equal(r.events.some((e) => e.type === "run.finished" && e.text === "[Card: The chart]"), true, "the caption stands in where cards aren't drawn");
	} finally {
		await s.cleanup();
	}
});

test("a file that is not a picture, a missing file and a file over the size limit are refused", async () => {
	const s = await setup();
	try {
		writeFileSync(join(s.workspace, "notes.txt"), "just words");
		writeFileSync(join(s.workspace, "big.png"), Buffer.concat([PNG, Buffer.alloc(IMAGE_MAX_BYTES)]));
		const show = (path: string, id: string) => call("show", { card: { kind: "image", path }, caption: "x" }, id);
		const r = await run(s, [ask(show(join(s.workspace, "notes.txt"), "c1"), show(join(s.workspace, "big.png"), "c2"), show(join(s.workspace, "nope.png"), "c3")), fauxAssistantMessage([fauxText("ok")])]);
		assert.match(finished(r.events, "c1").resultText, /not a picture this gateway can show \(PNG, JPEG, GIF, WebP or BMP\)/);
		assert.match(finished(r.events, "c2").resultText, /larger than 25 MB, too big to show/);
		assert.match(finished(r.events, "c3").resultText, /Can't read .*nope\.png/);
		assert.equal(await cardOf(s, r.session.id), undefined);
	} finally {
		await s.cleanup();
	}
});

test("an MCP result with a picture offers it, and show from it keeps the picture", async () => {
	const t = await tempDir();
	const mcp = await FakeMcpServer.start([{ name: "snap", description: "A picture", inputSchema: { type: "object", properties: {} } }]);
	mcp.behavior.set("snap", { text: "taken", image: { data: PNG.toString("base64"), mimeType: "image/png" } });
	const { models, faux } = fauxModels();
	const config = testConfig(t.dir, [{ name: "main", default: true, instructions: "test", tools: ["mcp:cam"] }], { mcp: { servers: [mcpServerConfig("cam", mcp.url, { tools: { include: ["*"], exclude: [], readOnly: ["*"] } })] } });
	const core = await testCore(t.dir, { models, config });
	try {
		await new Promise<void>((resolve) => {
			const check = () => (core.mcp.status().find((x) => x.name === "cam")?.state === "online" ? resolve() : undefined);
			check();
			core.mcp.onStateChanged(check);
		});
		const session = await core.sessions.create("main");
		const c = collect(core.hub, session.id);
		faux.setResponses([ask(call("mcp__cam__snap", {}, "call_snap")), fauxAssistantMessage([fauxText("Here."), call("show", { from: cardHandle("call_snap"), caption: "Camera" }, "call_show")], { stopReason: "toolUse" })]);
		await core.sessions.submit(session.id, "go");
		await c.until((e) => e.type === "run.finished", 10000);
		assert.equal(finished(c.events, "call_snap").resultText, `taken\n\n${pictureLine("call_snap")}`);
		const card = (await core.sessions.turns(session.id)).turns.at(-1)!.items.find((i) => i.type === "card");
		assert.ok(card?.type === "card" && card.kind === "image");
		const att = (card.data as { attachment: { id: string } }).attachment;
		assert.ok(readFileSync(core.attachments.content(att.id)!.path).equals(PNG));
	} finally {
		await core.close();
		await mcp.stop();
		await t.cleanup();
	}
});

test("a picture whose data is gone from the chat is refused with a plain instruction", () => {
	const entries = [
		{ model: [{ role: "assistant", content: [{ type: "toolCall", id: "call_old", name: "shot", arguments: {} }] }] },
		{ model: [{ role: "toolResult", toolCallId: "call_old", content: [{ type: "text", text: `A picture.\n\n${pictureLine("call_old")}` }] }] },
	] as unknown as EntryRecord[];
	assert.throws(() => findCardSource(entries, cardHandle("call_old")), /picture of the result .* is no longer in this chat\. Take the picture again/);
});
