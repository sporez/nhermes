// Gateway restarts: an interrupted run continues after reopening the same data directory; a tool call
// waiting for approval is asked again and never ran in between.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { collect, tempDir, testConfig, testCore } from "../helpers.ts";

function models(tokensPerSecond?: number) {
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1", reasoning: true }, { id: "faux-2" }], tokensPerSecond });
	const m = createModels();
	m.setProvider(faux.provider);
	return { faux, models: m };
}

test("a run interrupted by a restart continues and completes after reopening", async () => {
	const { dir, cleanup } = await tempDir();
	const config = testConfig(dir);
	try {
		const a = models(200);
		let core = await testCore(dir, { models: a.models, config });
		const s = await core.sessions.create("main");
		a.faux.setResponses([fauxAssistantMessage([fauxText("first attempt ".repeat(200))])]);
		const c = collect(core.hub, s.id);
		await core.sessions.submit(s.id, "write something long");
		await c.until((e) => e.type === "text.delta");
		await core.close(); // gateway stops mid-answer

		const b = models();
		b.faux.setResponses([fauxAssistantMessage([fauxText("Recovered answer.")])]);
		core = await testCore(dir, { models: b.models, config });
		const row = core.sessions.require(s.id);
		assert.equal(row.title, "write something long", "catalogue survives");
		const c2 = collect(core.hub, s.id);
		const done = await c2.until((e) => e.type === "run.finished", 10000);
		if (done.type !== "run.finished") return;
		assert.equal(done.status, "complete");
		assert.match(done.text, /Recovered answer\./);
		const snap = await core.sessions.snapshot(s.id);
		assert.equal(snap.running, false);
		assert.equal(snap.rows.filter((r) => r.role === "user").length, 1, "the prompt is not duplicated");
		await core.close();
	} finally {
		await cleanup();
	}
});

test("an approval pending at restart is asked again and the tool had not run", async () => {
	const { dir, cleanup } = await tempDir();
	const config = testConfig(dir);
	try {
		const a = models();
		let core = await testCore(dir, { models: a.models, config });
		const s = await core.sessions.create("main");
		const marker = join(core.bots.require("main").workspace, "formatted.txt");
		a.faux.setResponses([fauxAssistantMessage([fauxToolCall("bash", { command: `mkfs.ext4 /dev/null-test; touch ${marker}` })], { stopReason: "toolUse" })]);
		const c = collect(core.hub, s.id);
		await core.sessions.submit(s.id, "format the disk");
		await c.until((e) => e.type === "approval.requested");
		await core.close();
		assert.equal(existsSync(marker), false);

		const b = models();
		b.faux.setResponses([fauxAssistantMessage([fauxText("Not formatting without approval.")])]);
		core = await testCore(dir, { models: b.models, config });
		const c2 = collect(core.hub, s.id);
		// The hook re-runs after restart: the same question is asked again.
		const asked = await c2.until((e) => e.type === "approval.requested", 10000);
		if (asked.type !== "approval.requested") return;
		assert.equal(asked.request.patternKey, "mkfs");
		core.approvals.answer(asked.request.requestId, "deny");
		const done = await c2.until((e) => e.type === "run.finished", 10000);
		assert.equal(done.type, "run.finished");
		assert.equal(existsSync(marker), false, "the denied tool never ran");
		await core.close();
	} finally {
		await cleanup();
	}
});
