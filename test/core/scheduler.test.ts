// Scheduled runs without a client: execution, history, duplicate prevention, overlap, missed runs,
// restarts mid-run, unattended approvals, and notifications.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { Notification, Notifier } from "../../src/notify/notifier.ts";
import { fauxModels, tempDir, testConfig, testCore } from "../helpers.ts";

class Recorder implements Notifier {
	readonly name = "recorder";
	readonly sent: Notification[] = [];
	async send(n: Notification) {
		this.sent.push(n);
	}
}

async function until<T>(fn: () => T | undefined, ms = 5000): Promise<T> {
	const end = Date.now() + ms;
	for (;;) {
		const v = fn();
		if (v !== undefined && v !== false) return v;
		if (Date.now() > end) throw new Error("timed out");
		await new Promise((r) => setTimeout(r, 20));
	}
}

test("a due job runs in its own session without a client and records history; the next tick does not repeat it", async () => {
	const { dir, cleanup } = await tempDir();
	const { models, faux } = fauxModels();
	const notifier = new Recorder();
	const core = await testCore(dir, { models, notifier });
	try {
		const job = core.scheduler.create({ name: "Disk check", bot: "ops", prompt: "Check disk usage", schedule: "every 1h", notify: "always" });
		assert.ok(job.next_run_at! > Date.now() / 1000);
		faux.setResponses([fauxAssistantMessage([fauxText("All disks below 70%.")])]);
		const due = job.next_run_at! + 1;
		await core.scheduler.tick(due);
		await core.scheduler.tick(due); // a second tick at the same time starts nothing new
		const run = await until(() => core.scheduler.runs(job.id).find((r) => r.status !== "running"));
		assert.equal(run.status, "ok");
		assert.equal(run.trigger, "schedule");
		assert.equal(run.summary, "All disks below 70%.");
		assert.equal(core.scheduler.runs(job.id).length, 1);
		const after = core.scheduler.get(job.id)!;
		assert.equal(after.next_run_at, job.next_run_at! + 3600);
		const session = core.sessions.require(after.session_id!);
		assert.equal(session.kind, "job");
		assert.equal(session.bot, "ops");
		assert.equal(session.title, "Disk check");
		await until(() => notifier.sent.length > 0 || undefined);
		assert.deepEqual(notifier.sent[0], { title: "Disk check", message: "All disks below 70%.", priority: 0, sessionId: session.id, bot: "ops" });

		// A second run starts from a fresh context but in the same session.
		faux.setResponses([fauxAssistantMessage([fauxText("Still fine.")])]);
		await core.scheduler.trigger(job.id);
		await until(() => core.scheduler.runs(job.id).length === 2 && core.scheduler.runs(job.id)[0]!.status === "ok" ? true : undefined);
		const rows = await core.sessions.rows(session.id);
		assert.equal(rows.filter((r) => r.role === "user").length, 2, "both runs' prompts are in the session's history");
		const stats = await core.engine.contextStats(session.conversation_id);
		assert.ok(stats.conversation < 400, `the model sees only the latest run (${stats.conversation} tokens)`);
	} finally {
		await core.close();
		await cleanup();
	}
});

test("context: continue keeps one thread across runs; fresh (default) starts each run empty; bad values are rejected", async () => {
	const { dir, cleanup } = await tempDir();
	const { models, faux } = fauxModels();
	const core = await testCore(dir, { models, notifier: new Recorder() });
	try {
		const seen: string[] = [];
		const reply = (text: string) => (ctx: unknown) => {
			seen.push(JSON.stringify(ctx));
			return fauxAssistantMessage([fauxText(text)]);
		};
		const runTwice = async (context: "fresh" | "continue") => {
			const job = core.scheduler.create({ name: `Watch ${context}`, bot: "main", prompt: "check", schedule: "every 1h", context });
			assert.equal(job.context, context);
			seen.length = 0;
			faux.setResponses([reply(`first-${context}-marker`), reply("second")]);
			for (const n of [1, 2]) {
				await core.scheduler.trigger(job.id);
				await until(() => core.scheduler.runs(job.id).filter((r) => r.status === "ok").length === n || undefined);
			}
			return seen[1]!;
		};
		assert.ok((await runTwice("continue")).includes("first-continue-marker"), "the second run sees the first run");
		assert.ok(!(await runTwice("fresh")).includes("first-fresh-marker"), "a fresh run does not");
		assert.equal(core.scheduler.create({ name: "Default", bot: "main", prompt: "x", schedule: "every 1h" }).context, "fresh");
		assert.throws(() => core.scheduler.create({ name: "Bad", bot: "main", prompt: "x", schedule: "every 1h", context: "forever" as never }), /context must be/);
		const job = core.scheduler.list()[0]!;
		assert.throws(() => core.scheduler.update(job.id, { context: "x" as never }), /context must be/);
		assert.equal(core.scheduler.update(job.id, { context: "fresh" }).context, "fresh");
	} finally {
		await core.close();
		await cleanup();
	}
});

test("overlap is skipped, long-missed occurrences are recorded as missed, recent ones caught up once", async () => {
	const { dir, cleanup } = await tempDir();
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }], tokensPerSecond: 50 });
	const models = createModels();
	models.setProvider(faux.provider);
	const core = await testCore(dir, { models, notifier: new Recorder() });
	try {
		const job = core.scheduler.create({ name: "Slow", bot: "main", prompt: "work", schedule: "every 1h", catchUpS: 1800 });
		faux.setResponses([fauxAssistantMessage([fauxText("slow answer ".repeat(60))]), fauxAssistantMessage([fauxText("caught up")])]);
		const t0 = job.next_run_at!;
		await core.scheduler.tick(t0 + 1);
		assert.equal(core.scheduler.runs(job.id)[0]!.status, "running");
		// The next occurrence comes due while the first still runs.
		await core.scheduler.tick(t0 + 3600 + 1);
		assert.equal(core.scheduler.runs(job.id)[0]!.status, "skipped");
		await until(() => core.scheduler.runs(job.id).find((r) => r.trigger === "schedule" && r.status === "ok"), 15000);

		// Down for 3 hours: the due occurrence is beyond the 30 min catch-up window → missed, and only one decision.
		const before = core.scheduler.runs(job.id).length;
		const due = core.scheduler.get(job.id)!.next_run_at!;
		await core.scheduler.tick(due + 3 * 3600);
		const runs = core.scheduler.runs(job.id);
		assert.equal(runs.length, before + 1);
		assert.equal(runs[0]!.status, "missed");
		assert.ok(core.scheduler.get(job.id)!.next_run_at! > due + 3 * 3600, "next is in the future, not a backlog");

		// Missed by 10 minutes: within the window → one catch-up run.
		const due2 = core.scheduler.get(job.id)!.next_run_at!;
		await core.scheduler.tick(due2 + 600);
		const caught = await until(() => core.scheduler.runs(job.id).find((r) => r.trigger === "catch_up" && r.status !== "running"), 15000);
		assert.equal(caught.status, "ok");
		assert.equal(caught.summary, "caught up");
	} finally {
		await core.close();
		await cleanup();
	}
});

test("a run in progress at shutdown finishes after restart, once", async () => {
	const { dir, cleanup } = await tempDir();
	const config = testConfig(dir);
	const a = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }], tokensPerSecond: 100 });
	const ma = createModels();
	ma.setProvider(a.provider);
	let core = await testCore(dir, { models: ma, config, notifier: new Recorder() });
	try {
		const job = core.scheduler.create({ name: "Report", bot: "main", prompt: "write the report", schedule: "every 1d" });
		a.setResponses([fauxAssistantMessage([fauxText("partial report ".repeat(100))])]);
		await core.scheduler.trigger(job.id);
		await new Promise((r) => setTimeout(r, 150));
		await core.close();

		const b = fauxModels();
		b.faux.setResponses([fauxAssistantMessage([fauxText("Report finished after restart.")])]);
		core = await testCore(dir, { models: b.models, config, notifier: new Recorder() });
		await core.scheduler.start(60_000);
		const run = await until(() => core.scheduler.runs(job.id).find((r) => r.status !== "running"), 15000);
		assert.equal(run.status, "ok");
		assert.match(run.summary, /Report finished after restart\./);
		assert.equal(core.scheduler.runs(job.id).length, 1);
		const rows = await core.sessions.rows(core.scheduler.get(job.id)!.session_id!);
		assert.equal(rows.filter((r) => r.role === "user").length, 1, "the prompt was submitted once");
	} finally {
		await core.close();
		await cleanup();
	}
});

test("unattended: an action that needs approval is denied, the run reports it, and the owner is notified", async () => {
	const { dir, cleanup } = await tempDir();
	const { models, faux } = fauxModels();
	const notifier = new Recorder();
	const core = await testCore(dir, { models, notifier });
	try {
		const job = core.scheduler.create({ name: "Cleanup", bot: "main", prompt: "free disk space", schedule: "every 1d", notify: "on_error" });
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "rm -rf /var/cache/old && echo freed" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("I could not delete the cache without approval.")]),
		]);
		await core.scheduler.trigger(job.id);
		const run = await until(() => core.scheduler.runs(job.id).find((r) => r.status !== "running"));
		assert.equal(run.status, "ok");
		assert.match(run.error, /1 action\(s\) needed approval/);
		assert.equal(core.approvals.pendingFor(core.scheduler.get(job.id)!.session_id!).length, 0, "nothing left waiting");
		await until(() => notifier.sent[0]);
		assert.equal(notifier.sent[0]!.title, "Cleanup: needs approval");
	} finally {
		await core.close();
		await cleanup();
	}
});

test("a failed run notifies with priority; deliver: chat posts a notice into the bot's chat", async () => {
	const { dir, cleanup } = await tempDir();
	const { models, faux } = fauxModels();
	const notifier = new Recorder();
	const core = await testCore(dir, { models, notifier });
	try {
		const chat = await core.sessions.create("main");
		const job = core.scheduler.create({ name: "Brief", bot: "main", prompt: "brief me", schedule: "0 7 * * *", deliver: "chat", notify: "on_error" });
		faux.setResponses([fauxAssistantMessage([fauxText("Two meetings today.")])]);
		await core.scheduler.trigger(job.id);
		await until(() => core.scheduler.runs(job.id).find((r) => r.status !== "running"));
		await new Promise((r) => setTimeout(r, 50));
		const chatRows = await core.sessions.rows(chat.id);
		assert.ok(chatRows.some((r) => r.role === "system" && r.text.includes('Scheduled task "Brief": Two meetings today.')), JSON.stringify(chatRows));
		assert.equal(notifier.sent.length, 0, "on_error: a good run does not notify");

		faux.setResponses([fauxAssistantMessage([], { stopReason: "error", errorMessage: "provider exploded" })]);
		await core.scheduler.trigger(job.id);
		const failed = await until(() => core.scheduler.runs(job.id).find((r) => r.status === "error"), 15000);
		assert.match(failed.error, /provider exploded|model/);
		await until(() => notifier.sent[0]);
		assert.equal(notifier.sent[0]!.priority, 1);
		assert.match(notifier.sent[0]!.title, /Brief failed/);
	} finally {
		await core.close();
		await cleanup();
	}
});
