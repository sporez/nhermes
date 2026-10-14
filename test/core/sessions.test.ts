import assert from "node:assert/strict";
import { test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import { collect, fauxModels, tempDir, testCore } from "../helpers.ts";

test("a chat turn streams, finishes, and is listed with a title", async () => {
	const { dir, cleanup } = await tempDir();
	const { models, faux } = fauxModels();
	const core = await testCore(dir, { models });
	try {
		const s = await core.sessions.create("main");
		const c = collect(core.hub, s.id);
		faux.setResponses([fauxAssistantMessage([fauxThinking("thinking about it"), fauxText("The answer is 42.")])]);
		const r = await core.sessions.submit(s.id, "What is the answer to everything?");
		assert.equal(r.status, "streaming");
		const done = await c.until((e) => e.type === "run.finished");
		assert.equal(done.type, "run.finished");
		if (done.type !== "run.finished") return;
		assert.equal(done.status, "complete");
		assert.equal(done.text, "The answer is 42.");
		const deltas = c.events.filter((e) => e.type === "text.delta").map((e) => (e as { text: string }).text).join("");
		assert.equal(deltas, "The answer is 42.");
		assert.ok(c.events.some((e) => e.type === "reasoning.delta"));
		assert.ok(c.events.findIndex((e) => e.type === "run.started") < c.events.findIndex((e) => e.type === "text.delta"));
		const row = core.sessions.require(s.id);
		assert.equal(row.title, "What is the answer to everything?");
		assert.equal(row.message_count, 2);
		const snap = await core.sessions.snapshot(s.id);
		assert.equal(snap.running, false);
		assert.deepEqual(
			snap.rows.map((r) => [r.role, r.text]),
			[
				["user", "What is the answer to everything?"],
				["assistant", "The answer is 42."],
			],
		);
		assert.equal(snap.rows[1]!.reasoning, "thinking about it");
		const listed = core.sessions.list("main", { limit: 10, offset: 0, archived: "exclude", order: "recent" });
		assert.equal(listed.total, 1);
		assert.equal(core.sessions.list("ops", { limit: 10, offset: 0, archived: "exclude", order: "recent" }).total, 0);
		const usage = await core.sessions.usage(s.id);
		assert.ok(usage.output > 0);
		assert.equal(usage.model, "faux/faux-1");
	} finally {
		await core.close();
		await cleanup();
	}
});

test("a dangerous shell call asks for approval; 'once' runs it, 'deny' blocks it", async () => {
	const { dir, cleanup } = await tempDir();
	const { models, faux } = fauxModels();
	const core = await testCore(dir, { models });
	try {
		const s = await core.sessions.create("main");
		const c = collect(core.hub, s.id);
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "rm -rf ./scratch && echo removed" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("Removed it.")]),
		]);
		await core.sessions.submit(s.id, "clean up scratch");
		const asked = await c.until((e) => e.type === "approval.requested");
		if (asked.type !== "approval.requested") return;
		assert.equal(asked.request.toolName, "bash");
		assert.equal(asked.request.patternKey, "rm -rf");
		assert.equal(core.approvals.pendingFor(s.id).length, 1);
		assert.ok(core.approvals.answer(asked.request.requestId, "once"));
		const finished = await c.until((e) => e.type === "tool.finished");
		if (finished.type !== "tool.finished") return;
		assert.match(finished.resultText, /removed/);
		await c.until((e) => e.type === "run.finished");

		// Second time: deny → the tool never runs and the model is told.
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "rm -rf ./other && echo removed-other" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("Understood, leaving it.")]),
		]);
		const c2 = collect(core.hub, s.id);
		await core.sessions.submit(s.id, "and the other one");
		const asked2 = await c2.until((e) => e.type === "approval.requested");
		if (asked2.type !== "approval.requested") return;
		core.approvals.answer(asked2.request.requestId, "deny");
		const fin2 = await c2.until((e) => e.type === "tool.finished");
		if (fin2.type !== "tool.finished") return;
		assert.equal(fin2.isError, true);
		assert.match(fin2.resultText, /did not approve/);
		assert.doesNotMatch(fin2.resultText, /removed-other/);
	} finally {
		await core.close();
		await cleanup();
	}
});
