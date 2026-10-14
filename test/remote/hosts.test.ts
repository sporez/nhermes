// Mode A remote execution through the real pi-env daemon. SSH is replaced by a local daemon
// connection (same protocol and RemoteExecutionEnv); real SSH hosts are verified separately.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { Connection, localDaemon } from "@earendil-works/pi-env";
import { collect, fauxModels, tempDir, testConfig, testCore } from "../helpers.ts";

test("a bot with a host runs its shell tool through the pi-env daemon, and survives the daemon dying", async () => {
	const { dir, cleanup } = await tempDir();
	const { models, faux } = fauxModels();
	const config = testConfig(dir, [
		{ name: "main", default: true, instructions: "main" },
		{ name: "nas", instructions: "You manage the NAS.", trusted: true, host: { ssh: { host: "nas.invalid", user: "neil", cwd: dir } } },
	]);
	let connection: Connection | undefined;
	const core = await testCore(dir, {
		models,
		config,
		connectHost: () => (connection = new Connection({ command: [localDaemon()] })),
	});
	try {
		const s = await core.sessions.create("nas");
		const c = collect(core.hub, s.id);
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "echo daemon-pid=$PPID && pwd" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("ran it")]),
		]);
		await core.sessions.submit(s.id, "where are you?");
		const t1 = await c.until((e) => e.type === "tool.finished");
		if (t1.type !== "tool.finished") return;
		assert.equal(t1.isError, false, t1.resultText);
		assert.match(t1.resultText, /daemon-pid=\d+/);
		assert.ok(t1.resultText.includes(dir.replace(/^\/private/, "")) || t1.resultText.includes(dir), t1.resultText);
		await c.until((e) => e.type === "run.finished");

		// The remote side goes away (VM reboot, daemon killed). The call that finds the connection gone fails
		// with an explanation (it is not retried blindly: the command may have run); the next call reconnects.
		const pid = (await connection!.info()).pid;
		process.kill(pid, "SIGKILL");
		const c2 = collect(core.hub, s.id);
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "echo first-after-kill" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("bash", { command: "echo back-again" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("ok")]),
		]);
		await core.sessions.submit(s.id, "again");
		await c2.until((e) => e.type === "run.finished");
		const results = c2.events.filter((e) => e.type === "tool.finished") as { isError: boolean; resultText: string }[];
		const ok = results.find((r) => /back-again/.test(r.resultText));
		assert.ok(ok && !ok.isError, JSON.stringify(results));
		const failed = results.find((r) => r.isError);
		assert.ok(failed, "the call that found the connection gone reports it");
		assert.match(failed.resultText, /connection to nas\.invalid was lost.*may or may not have run/s);
		assert.notEqual((await connection!.info()).pid, pid, "a new daemon process");
	} finally {
		await core.close();
		await cleanup();
	}
});

test("high-impact commands on a trusted host bot still ask; routine ones do not", async () => {
	const { dir, cleanup } = await tempDir();
	const { models, faux } = fauxModels();
	const config = testConfig(dir, [{ name: "nas", default: true, instructions: "nas", trusted: true, host: { ssh: { host: "nas.invalid", cwd: dir } } }]);
	const core = await testCore(dir, { models, config, connectHost: () => new Connection({ command: [localDaemon()] }) });
	try {
		const s = await core.sessions.create("nas");
		const c = collect(core.hub, s.id);
		faux.setResponses([
			// rm -rf in a working dir is routine for a trusted bot; zpool destroy is not.
			fauxAssistantMessage([fauxToolCall("bash", { command: "mkdir -p junk && rm -rf junk && echo cleaned" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("bash", { command: "zpool destroy tank" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("done")]),
		]);
		await core.sessions.submit(s.id, "tidy up and destroy tank");
		const asked = await c.until((e) => e.type === "approval.requested");
		if (asked.type !== "approval.requested") return;
		assert.equal(asked.request.patternKey, "zfs destroy");
		const firstTool = c.events.find((e) => e.type === "tool.finished");
		assert.ok(firstTool?.type === "tool.finished" && /cleaned/.test(firstTool.resultText), "rm -rf ran without asking");
		core.approvals.answer(asked.request.requestId, "deny");
		await c.until((e) => e.type === "run.finished");
	} finally {
		await core.close();
		await cleanup();
	}
});
