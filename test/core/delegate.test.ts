// Delegation between bots: foreground (answer as tool result), background (answer posted back later),
// and approvals inside a delegated task reaching the chat the owner is in.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { collect, fauxModels, tempDir, testCore } from "../helpers.ts";

test("foreground delegation: ops answers in its own session, main gets the result", async () => {
	const { dir, cleanup } = await tempDir();
	const { models, faux } = fauxModels();
	const core = await testCore(dir, { models });
	try {
		const s = await core.sessions.create("main");
		const c = collect(core.hub, s.id);
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("delegate", { bot: "ops", task: "Check disk usage on the NAS" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("The NAS is at 61% disk usage.")]), // ops, in the child session
			fauxAssistantMessage([fauxText("Ops says the NAS is at 61%.")]), // main again
		]);
		await core.sessions.submit(s.id, "ask ops about the NAS disk");
		const done = await c.until((e) => e.type === "run.finished", 10000);
		if (done.type !== "run.finished") return;
		assert.equal(done.text, "Ops says the NAS is at 61%.");
		const tool = c.events.find((e) => e.type === "tool.finished");
		if (tool?.type !== "tool.finished") throw new Error("no tool.finished");
		assert.equal(tool.isError, false, tool.resultText);
		assert.match(tool.resultText, /ops answered .*61% disk usage/s);

		const opsSessions = core.sessions.list("ops", { limit: 10, offset: 0, archived: "include", order: "recent" });
		assert.equal(opsSessions.total, 1);
		const child = opsSessions.rows[0]!;
		assert.equal(child.kind, "delegate");
		assert.equal(child.parent_id, s.id);
		const rows = await core.sessions.rows(child.id);
		assert.deepEqual(rows.map((r) => r.text), ["Check disk usage on the NAS", "The NAS is at 61% disk usage."]);
		// The child ran as ops: its persona section is ops's instructions.
		const sys = await core.engine.contextStats(child.conversation_id);
		assert.ok(sys.system > 0);
		assert.equal(core.sessions.list("main", { limit: 10, offset: 0, archived: "include", order: "recent" }).total, 1, "main has only its own chat");
	} finally {
		await core.close();
		await cleanup();
	}
});

test("background delegation: the answer arrives later as a new message in the caller's chat", async () => {
	const { dir, cleanup } = await tempDir();
	const { models, faux } = fauxModels();
	const core = await testCore(dir, { models });
	try {
		const s = await core.sessions.create("main");
		const c = collect(core.hub, s.id);
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("delegate", { bot: "ops", task: "Rotate the logs", wait: false })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("Working on it.")]),
			fauxAssistantMessage([fauxText("Working on it.")]),
			fauxAssistantMessage([fauxText("Ops reports the logs were rotated.")]),
		]);
		await core.sessions.submit(s.id, "have ops rotate logs in the background");
		const first = await c.until((e) => e.type === "run.finished", 10000);
		assert.equal(first.type, "run.finished");
		// A second run starts on the caller's side when the report is posted.
		const second = await c.until((e) => e.type === "run.started" && e.prompt.startsWith("[Result from bot \"ops\""), 10000);
		assert.equal(second.type, "run.started");
		await c.until((e) => e.type === "run.finished" && e !== first, 10000);
		const rows = await core.sessions.rows(s.id);
		assert.ok(rows.some((r) => r.role === "user" && r.text.startsWith('[Result from bot "ops"')));
		const ops = core.sessions.list("ops", { limit: 10, offset: 0, archived: "include", order: "recent" });
		assert.equal(ops.rows[0]?.kind, "delegate");
	} finally {
		await core.close();
		await cleanup();
	}
});

test("an approval inside a delegated task is asked in the root chat", async () => {
	const { dir, cleanup } = await tempDir();
	const { models, faux } = fauxModels();
	const core = await testCore(dir, { models });
	try {
		const s = await core.sessions.create("main");
		const c = collect(core.hub, s.id);
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("delegate", { bot: "ops", task: "wipe the scratch disk" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("bash", { command: "wipefs -a /dev/sdz" })], { stopReason: "toolUse" }), // ops
			fauxAssistantMessage([fauxText("I was not allowed to wipe it.")]), // ops
			fauxAssistantMessage([fauxText("Ops was not allowed.")]), // main
		]);
		await core.sessions.submit(s.id, "get ops to wipe the scratch disk");
		const asked = await c.until((e) => e.type === "approval.requested", 10000);
		if (asked.type !== "approval.requested") return;
		assert.equal(asked.request.sessionId, s.id, "asked in the chat the owner is in");
		assert.equal(asked.request.bot, "ops");
		assert.match(asked.request.description, /delegated task/);
		core.approvals.answer(asked.request.requestId, "deny");
		const done = await c.until((e) => e.type === "run.finished", 10000);
		if (done.type !== "run.finished") return;
		assert.equal(done.text, "Ops was not allowed.");
	} finally {
		await core.close();
		await cleanup();
	}
});

test("privileges do not escalate through delegation: an untrusted bot's task run by a trusted bot still asks", async () => {
	const { dir, cleanup } = await tempDir();
	const { models, faux } = fauxModels();
	const core = await testCore(dir, { models });
	try {
		const s = await core.sessions.create("main"); // untrusted
		const c = collect(core.hub, s.id);
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("delegate", { bot: "ops", task: "install cowsay" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("bash", { command: "sudo apt-get install -y cowsay" })], { stopReason: "toolUse" }), // ops (trusted)
			fauxAssistantMessage([fauxText("Not allowed.")]),
			fauxAssistantMessage([fauxText("Ops could not install it.")]),
		]);
		await core.sessions.submit(s.id, "get cowsay installed somehow");
		const asked = await c.until((e) => e.type === "approval.requested", 10000);
		if (asked.type !== "approval.requested") return;
		assert.equal(asked.request.sessionId, s.id);
		assert.equal(asked.request.bot, "ops");
		core.approvals.answer(asked.request.requestId, "deny");
		await c.until((e) => e.type === "run.finished", 10000);
		// The same command started directly in an ops chat runs without asking (ops is trusted).
		const o = await core.sessions.create("ops");
		const co = collect(core.hub, o.id);
		faux.setResponses([fauxAssistantMessage([fauxToolCall("bash", { command: "echo sudo-ok" })], { stopReason: "toolUse" }), fauxAssistantMessage([fauxText("ok")])]);
		await core.sessions.submit(o.id, "go");
		await co.until((e) => e.type === "run.finished", 10000);
		assert.equal(co.events.some((e) => e.type === "approval.requested"), false);
	} finally {
		await core.close();
		await cleanup();
	}
});
