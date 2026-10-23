// Scheduled jobs. A job targets one bot and owns one session (kind "job"); each run starts that
// session from a fresh context, so its history stays readable while runs stay independent.
//
// Guarantees and limits:
// - An occurrence starts at most once: job_runs has UNIQUE(job_id, occurrence) and the Durable
//   submission uses requestId "job:<id>:<occurrence>". Neither makes the run's side effects
//   exactly-once: a tool interrupted by a crash is not replayed unless it is replay-safe (Pi Durable),
//   and the model sees that it was interrupted.
// - A run in progress at shutdown continues after restart (Durable resumes it); the scheduler waits on
//   the same submission again.
// - Overlap: an occurrence that comes due while the previous run is going is recorded as "skipped".
// - Missed: occurrences that passed while the gateway was down collapse into one decision: run once
//   (trigger "catch_up") if within the job's catch-up window, else record "missed".
import { randomBytes } from "node:crypto";
import type { Engine } from "../engine/engine.ts";
import { logger } from "../log.ts";
import type { Notifier } from "../notify/notifier.ts";
import type { AppDb } from "../store/db.ts";
import type { Bots } from "./bots.ts";
import type { Hub, SessionEvent } from "./events.ts";
import { describeSpec, nextRun, parseSchedule, ScheduleError, type ScheduleSpec } from "./schedule.ts";
import type { Sessions } from "./sessions.ts";

const log = logger("scheduler");

export type NotifyPolicy = "never" | "always" | "on_error" | "on_change" | "agent";
export type Deliver = "session" | "chat";
export type UnattendedApprovals = "deny" | "allow" | "ask";
export type JobContext = "fresh" | "continue";

export type JobRow = {
	id: string;
	name: string;
	bot: string;
	prompt: string;
	schedule_kind: ScheduleSpec["kind"];
	schedule: string;
	timezone: string;
	model: string | null;
	skills: string;
	notify: NotifyPolicy;
	deliver: Deliver;
	context: JobContext;
	approvals: UnattendedApprovals;
	catch_up_s: number;
	enabled: number;
	session_id: string | null;
	next_run_at: number | null;
	created_at: number;
	updated_at: number;
};

export type RunStatus = "running" | "ok" | "error" | "interrupted" | "skipped" | "missed";

export type RunRow = {
	id: number;
	job_id: string;
	occurrence: string;
	trigger: "schedule" | "catch_up" | "manual";
	status: RunStatus;
	started_at: number;
	finished_at: number | null;
	submission_id: number | null;
	summary: string;
	error: string;
	notified: number;
};

export type JobInput = {
	id?: string;
	name: string;
	bot: string;
	prompt: string;
	/** A cron expression, "every 30m", or "at <ISO>". */
	schedule: string;
	timezone?: string;
	model?: string | null;
	skills?: string[];
	notify?: NotifyPolicy;
	deliver?: Deliver;
	/** "continue" keeps one thread across runs; "fresh" (default) resets it before each. */
	context?: JobContext;
	approvals?: UnattendedApprovals;
	catchUpS?: number;
	enabled?: boolean;
};

export class JobError extends Error {
	override name = "JobError";
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

const NOTIFY: NotifyPolicy[] = ["never", "always", "on_error", "on_change", "agent"];
const DENIED_UNATTENDED = "nobody is attending this run";

function slug(name: string): string {
	const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "job";
	return `${base}-${randomBytes(2).toString("hex")}`;
}

export function specOf(job: Pick<JobRow, "schedule_kind" | "schedule">): ScheduleSpec {
	if (job.schedule_kind === "every") return { kind: "every", seconds: Number(job.schedule) };
	if (job.schedule_kind === "at") return { kind: "at", at: Number(job.schedule) };
	return { kind: "cron", expr: job.schedule };
}

export type SchedulerDeps = {
	db: AppDb;
	engine: Engine;
	sessions: Sessions;
	bots: Bots;
	hub: Hub;
	notifier: Notifier;
	defaultTimezone: string;
	modelExists: (ref: string) => boolean;
};

export class Scheduler {
	private readonly d: SchedulerDeps;
	private timer: NodeJS.Timeout | undefined;
	private readonly following = new Map<number, Promise<RunRow>>();
	private readonly blocked = new Map<number, number>();
	private ticking = false;
	private stopped = false;

	constructor(deps: SchedulerDeps) {
		this.d = deps;
	}

	// ── Jobs ────────────────────────────────────────────────────────────────────────────────

	get(id: string): JobRow | undefined {
		return this.d.db.get<JobRow>("SELECT * FROM jobs WHERE id = ?", id);
	}

	require(id: string): JobRow {
		const job = this.get(id) ?? this.d.db.get<JobRow>("SELECT * FROM jobs WHERE name = ?", id);
		if (!job) throw new JobError(404, "Job not found");
		return job;
	}

	list(bot?: string): JobRow[] {
		return bot ? this.d.db.all<JobRow>("SELECT * FROM jobs WHERE bot = ? ORDER BY created_at", bot) : this.d.db.all<JobRow>("SELECT * FROM jobs ORDER BY created_at");
	}

	runs(jobId: string, limit = 20): RunRow[] {
		return this.d.db.all<RunRow>("SELECT * FROM job_runs WHERE job_id = ? ORDER BY id DESC LIMIT ?", jobId, Math.min(limit, 200));
	}

	lastRun(jobId: string): RunRow | undefined {
		return this.d.db.get<RunRow>("SELECT * FROM job_runs WHERE job_id = ? AND status NOT IN ('skipped', 'missed') ORDER BY id DESC LIMIT 1", jobId);
	}

	isRunning(jobId: string): boolean {
		return this.d.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM job_runs WHERE job_id = ? AND status = 'running'", jobId)!.n > 0;
	}

	private validate(input: Partial<JobInput>): void {
		if (input.bot !== undefined && !this.d.bots.get(input.bot)) throw new JobError(400, `unknown bot "${input.bot}"`);
		if (input.bot !== undefined && this.d.bots.get(input.bot)!.isPeer) throw new JobError(400, `${input.bot} is on another machine; schedule the task there`);
		if (input.notify !== undefined && !NOTIFY.includes(input.notify)) throw new JobError(400, `notify must be one of ${NOTIFY.join(", ")}`);
		if (input.deliver !== undefined && !["session", "chat"].includes(input.deliver)) throw new JobError(400, "deliver must be session or chat");
		if (input.context !== undefined && !["fresh", "continue"].includes(input.context)) throw new JobError(400, "context must be fresh or continue");
		if (input.approvals !== undefined && !["deny", "allow", "ask"].includes(input.approvals)) throw new JobError(400, "approvals must be deny, allow or ask");
		if (input.model && !this.d.modelExists(input.model)) throw new JobError(400, `unknown model "${input.model}"`);
		if (input.prompt !== undefined && !input.prompt.trim()) throw new JobError(400, "prompt is required");
		if (input.timezone !== undefined) {
			try {
				new Intl.DateTimeFormat("en-US", { timeZone: input.timezone });
			} catch {
				throw new JobError(400, `unknown time zone "${input.timezone}"`);
			}
		}
	}

	private spec(schedule: string, timezone: string): ScheduleSpec {
		try {
			return parseSchedule(schedule, timezone);
		} catch (error) {
			if (error instanceof ScheduleError) throw new JobError(400, error.message);
			throw error;
		}
	}

	create(input: JobInput): JobRow {
		this.validate(input);
		const tz = input.timezone ?? this.d.defaultTimezone;
		const spec = this.spec(input.schedule, tz);
		const now = Date.now() / 1000;
		const id = input.id ?? slug(input.name);
		if (this.get(id)) throw new JobError(409, `a job with id "${id}" exists`);
		const stored = spec.kind === "cron" ? spec.expr : spec.kind === "every" ? String(spec.seconds) : String(spec.at);
		// A one-shot already due runs at the next tick; anything else from its next occurrence.
		const next = spec.kind === "at" ? spec.at : nextRun(spec, tz, now, now);
		this.d.db.run(
			`INSERT INTO jobs (id, name, bot, prompt, schedule_kind, schedule, timezone, model, skills, notify, deliver, context, approvals, catch_up_s, enabled, next_run_at, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			id,
			input.name.trim(),
			input.bot,
			input.prompt.trim(),
			spec.kind,
			stored,
			tz,
			input.model ?? null,
			JSON.stringify(input.skills ?? []),
			input.notify ?? "on_error",
			input.deliver ?? "session",
			input.context ?? "fresh",
			input.approvals ?? "deny",
			input.catchUpS ?? 6 * 3600,
			input.enabled === false ? 0 : 1,
			next ?? null,
			now,
			now,
		);
		this.changed();
		log.info("job created", { id, bot: input.bot, schedule: describeSpec(spec) });
		return this.get(id)!;
	}

	update(id: string, patch: Partial<JobInput>): JobRow {
		const job = this.require(id);
		this.validate(patch);
		const tz = patch.timezone ?? job.timezone;
		const fields: Record<string, string | number | null> = {};
		if (patch.name !== undefined) fields.name = patch.name.trim();
		if (patch.bot !== undefined) fields.bot = patch.bot;
		if (patch.prompt !== undefined) fields.prompt = patch.prompt.trim();
		if (patch.model !== undefined) fields.model = patch.model || null;
		if (patch.skills !== undefined) fields.skills = JSON.stringify(patch.skills);
		if (patch.notify !== undefined) fields.notify = patch.notify;
		if (patch.deliver !== undefined) fields.deliver = patch.deliver;
		if (patch.context !== undefined) fields.context = patch.context;
		if (patch.approvals !== undefined) fields.approvals = patch.approvals;
		if (patch.catchUpS !== undefined) fields.catch_up_s = patch.catchUpS;
		if (patch.timezone !== undefined) fields.timezone = tz;
		if (patch.schedule !== undefined || patch.timezone !== undefined) {
			const spec = patch.schedule !== undefined ? this.spec(patch.schedule, tz) : specOf(job);
			const now = Date.now() / 1000;
			fields.schedule_kind = spec.kind;
			fields.schedule = spec.kind === "cron" ? spec.expr : spec.kind === "every" ? String(spec.seconds) : String(spec.at);
			fields.next_run_at = (spec.kind === "at" ? spec.at : nextRun(spec, tz, now, job.created_at)) ?? null;
		}
		if (patch.enabled !== undefined) Object.assign(fields, this.enabledFields(job, patch.enabled));
		fields.updated_at = Date.now() / 1000;
		const keys = Object.keys(fields);
		this.d.db.run(`UPDATE jobs SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`, ...keys.map((k) => fields[k]!), job.id);
		this.changed();
		return this.get(job.id)!;
	}

	private enabledFields(job: JobRow, enabled: boolean): Record<string, number | null> {
		if (!enabled) return { enabled: 0 };
		// Resuming computes the next occurrence from now: paused time is not caught up.
		const spec = specOf(job);
		const now = Date.now() / 1000;
		return { enabled: 1, next_run_at: (spec.kind === "at" ? (spec.at > now ? spec.at : null) : nextRun(spec, job.timezone, now, job.created_at)) ?? null };
	}

	setEnabled(id: string, enabled: boolean): JobRow {
		return this.update(id, { enabled });
	}

	delete(id: string): boolean {
		const job = this.require(id);
		this.d.db.run("DELETE FROM jobs WHERE id = ?", job.id);
		this.changed();
		return true;
	}

	private changed(): void {
		this.d.hub.publishGlobal({ type: "cron.changed" });
	}

	// ── Running ─────────────────────────────────────────────────────────────────────────────

	async start(tickMs = 15_000): Promise<void> {
		this.stopped = false;
		for (const run of this.d.db.all<RunRow>("SELECT * FROM job_runs WHERE status = 'running'")) {
			log.info("resuming run after restart", { job: run.job_id, run: run.id });
			void this.recover(run);
		}
		await this.tick();
		this.timer = setInterval(() => void this.tick(), tickMs);
		this.timer.unref();
	}

	async stop(): Promise<void> {
		this.stopped = true;
		if (this.timer) clearInterval(this.timer);
	}

	async tick(now = Date.now() / 1000): Promise<void> {
		if (this.ticking || this.stopped) return;
		this.ticking = true;
		try {
			const due = this.d.db.all<JobRow>("SELECT * FROM jobs WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?", now);
			for (const job of due) {
				const occurrence = new Date(job.next_run_at! * 1000).toISOString();
				const overdue = now - job.next_run_at!;
				const spec = specOf(job);
				const next = nextRun(spec, job.timezone, Math.max(now, job.next_run_at!), job.created_at) ?? null;
				this.d.db.run("UPDATE jobs SET next_run_at = ?, enabled = CASE WHEN ? IS NULL AND schedule_kind = 'at' THEN 0 ELSE enabled END WHERE id = ?", next, next, job.id);
				if (this.isRunning(job.id)) {
					this.record(job.id, occurrence, "schedule", "skipped", "the previous run was still going");
				} else if (overdue > job.catch_up_s) {
					this.record(job.id, occurrence, "schedule", "missed", `the gateway was not running at ${occurrence}`);
				} else {
					await this.startRun(job, occurrence, overdue > 90 ? "catch_up" : "schedule");
				}
			}
			if (due.length > 0) this.changed();
		} catch (error) {
			log.error("tick failed", { error: String(error) });
		} finally {
			this.ticking = false;
		}
	}

	private record(jobId: string, occurrence: string, trigger: RunRow["trigger"], status: RunStatus, error: string): void {
		const now = Date.now() / 1000;
		this.d.db.run("INSERT OR IGNORE INTO job_runs (job_id, occurrence, trigger, status, started_at, finished_at, error) VALUES (?, ?, ?, ?, ?, ?, ?)", jobId, occurrence, trigger, status, now, now, error);
	}

	/** Run now (the client API's jobs.run, the schedule_run tool, the CLI). Resolves when the run has started. */
	async trigger(id: string): Promise<RunRow> {
		const job = this.require(id);
		if (this.isRunning(job.id)) throw new JobError(409, "Job is already running");
		const run = await this.startRun(job, `manual:${new Date().toISOString()}`, "manual");
		if (!run) throw new JobError(409, "Job is already running");
		return run;
	}

	/** Waits for a run to finish (resolves with the final row). */
	async waitRun(runId: number, timeoutMs?: number): Promise<RunRow> {
		const p = this.following.get(runId);
		const row = this.d.db.get<RunRow>("SELECT * FROM job_runs WHERE id = ?", runId)!;
		if (!p) return row;
		if (timeoutMs === undefined) return p;
		return Promise.race([p, new Promise<RunRow>((r) => setTimeout(() => r(this.d.db.get<RunRow>("SELECT * FROM job_runs WHERE id = ?", runId)!), timeoutMs).unref())]);
	}

	private jobPrompt(job: JobRow, occurrence: string): string {
		const when = occurrence.startsWith("manual:") ? `run by hand at ${occurrence.slice(7)}` : `scheduled for ${occurrence}`;
		const agentNotify = job.notify === "agent" ? "\n\nIf the result is something the owner should know about now, call the notify tool with a short message; otherwise do not." : "";
		const thread = job.context === "continue" ? " Earlier runs of this task are above in this thread: use them (what you already reported, what changed since) and do not repeat what the owner was already told unless it changed." : "";
		return `[Scheduled task "${job.name}" (${when}).${thread} Nobody is watching this run: work autonomously, and finish with a short report of what you found or did.]${agentNotify}\n\n${job.prompt}`;
	}

	private ensureSession(job: JobRow) {
		const existing = job.session_id ? this.d.sessions.get(job.session_id) : undefined;
		if (existing && existing.bot === job.bot) return Promise.resolve(existing);
		return this.d.sessions.create(job.bot, { kind: "job", title: job.name, source: "cron", jobId: job.id, skills: JSON.parse(job.skills) as string[] }).then((row) => {
			this.d.db.run("UPDATE jobs SET session_id = ? WHERE id = ?", row.id, job.id);
			return row;
		});
	}

	private async startRun(job: JobRow, occurrence: string, trigger: RunRow["trigger"]): Promise<RunRow | undefined> {
		const now = Date.now() / 1000;
		const inserted = this.d.db.run("INSERT OR IGNORE INTO job_runs (job_id, occurrence, trigger, status, started_at) VALUES (?, ?, ?, 'running', ?)", job.id, occurrence, trigger, now);
		if (inserted.changes === 0) return undefined; // this occurrence already started (or was recorded)
		const run = this.d.db.get<RunRow>("SELECT * FROM job_runs WHERE job_id = ? AND occurrence = ?", job.id, occurrence)!;
		try {
			const session = await this.ensureSession(job);
			this.d.db.run("UPDATE sessions SET skills = ? WHERE id = ?", job.skills, session.id);
			if (job.model) {
				const i = job.model.indexOf("/");
				await this.d.engine.configure(session.conversation_id, { model: { provider: job.model.slice(0, i), modelId: job.model.slice(i + 1) } });
			} else {
				await this.d.sessions.followBot(session.id);
			}
			await this.d.sessions.live(session.id);
			// "continue" keeps the thread (switching from fresh continues from the last run, which the session still holds)
			if (job.context !== "continue") await this.d.engine.reset(session.conversation_id);
			const subId = await this.submissionOf(session.conversation_id, `job:${job.id}:${occurrence}`, job, occurrence);
			this.d.db.run("UPDATE sessions SET last_active = ? WHERE id = ?", Date.now() / 1000, session.id);
			this.d.db.run("UPDATE job_runs SET submission_id = ? WHERE id = ?", subId, run.id);
			log.info("run started", { job: job.id, run: run.id, trigger });
		} catch (error) {
			this.finish(run.id, "error", "", `could not start: ${error instanceof Error ? error.message : String(error)}`);
			return this.d.db.get<RunRow>("SELECT * FROM job_runs WHERE id = ?", run.id);
		}
		this.follow(run.id);
		this.changed();
		return this.d.db.get<RunRow>("SELECT * FROM job_runs WHERE id = ?", run.id);
	}

	/** The submission for a run: submitting again with the same request id returns the existing one. */
	private async submissionOf(convId: number, requestId: string, job: JobRow, occurrence: string): Promise<number> {
		const r = await this.d.engine.submit(convId, this.jobPrompt(job, occurrence), { requestId, whenBusy: "followUp" });
		return r.submissionId;
	}

	private async recover(run: RunRow): Promise<void> {
		const job = this.get(run.job_id);
		if (!job) return this.finish(run.id, "error", "", "the job was deleted");
		if (run.submission_id === null) {
			// Stopped between recording the run and submitting it: submit now (deduplicated by request id).
			const session = await this.ensureSession(job);
			const subId = await this.submissionOf(session.conversation_id, `job:${job.id}:${run.occurrence}`, job, run.occurrence);
			this.d.db.run("UPDATE job_runs SET submission_id = ? WHERE id = ?", subId, run.id);
		}
		this.follow(run.id);
	}

	private follow(runId: number): void {
		if (this.following.has(runId)) return;
		const p = this.followRun(runId).finally(() => this.following.delete(runId));
		this.following.set(runId, p);
	}

	private async followRun(runId: number): Promise<RunRow> {
		const run = this.d.db.get<RunRow>("SELECT * FROM job_runs WHERE id = ?", runId)!;
		const job = this.get(run.job_id);
		const session = job?.session_id ? this.d.sessions.get(job.session_id) : undefined;
		let off: (() => void) | undefined;
		if (session) {
			await this.d.sessions.live(session.id);
			off = this.d.hub.subscribe(session.id, (_sid, e: SessionEvent) => {
				if (e.type === "tool.finished" && e.isError && e.resultText.includes(DENIED_UNATTENDED)) this.blocked.set(runId, (this.blocked.get(runId) ?? 0) + 1);
			});
		}
		try {
			const rec = await this.d.engine.waitSubmission(run.submission_id!);
			if (rec.type === "input" && rec.status === "done" && session) {
				const text = await this.d.engine.answerText(session.conversation_id, rec.answer as number);
				const denied = this.blocked.get(runId) ?? 0;
				this.finish(runId, "ok", text, denied ? `${denied} action(s) needed approval and were not run` : "");
			} else if (rec.status === "unanswered") {
				this.finish(runId, rec.reason === "aborted" ? "interrupted" : "error", "", typeof rec.detail === "string" ? rec.detail : rec.reason);
			} else {
				this.finish(runId, "error", "", `unexpected submission state ${rec.status}`);
			}
		} catch (error) {
			if (this.stopped) return this.d.db.get<RunRow>("SELECT * FROM job_runs WHERE id = ?", runId)!;
			this.finish(runId, "error", "", error instanceof Error ? error.message : String(error));
		} finally {
			off?.();
			this.blocked.delete(runId);
		}
		const final = this.d.db.get<RunRow>("SELECT * FROM job_runs WHERE id = ?", runId)!;
		if (job) await this.afterRun(job, final);
		return final;
	}

	private finish(runId: number, status: RunStatus, summary: string, error: string): void {
		this.d.db.run("UPDATE job_runs SET status = ?, summary = ?, error = ?, finished_at = ? WHERE id = ? AND status = 'running'", status, summary, error, Date.now() / 1000, runId);
		this.changed();
	}

	private async afterRun(job: JobRow, run: RunRow): Promise<void> {
		log.info("run finished", { job: job.id, run: run.id, status: run.status });
		if (job.deliver === "chat") {
			const chat = this.d.sessions.list(job.bot, { limit: 1, offset: 0, archived: "exclude", order: "recent", kinds: ["chat"] }).rows[0];
			if (chat) {
				const body = run.status === "ok" ? run.summary : `failed: ${run.error}`;
				await this.d.engine.writeNotice(chat.conversation_id, `Scheduled task "${job.name}": ${body.slice(0, 1500)}`, { at: String(Date.now() / 1000), job: job.id });
				this.d.hub.publish(chat.id, { type: "notice", message: `Scheduled task "${job.name}" finished` });
			}
		}
		if (this.shouldNotify(job, run)) {
			const failed = run.status !== "ok";
			const title = failed ? `${job.name} ${run.status === "interrupted" ? "was interrupted" : "failed"}` : run.error ? `${job.name}: needs approval` : job.name;
			const message = failed ? run.error || "The run did not finish." : `${run.summary}${run.error ? `\n\n(${run.error})` : ""}`;
			try {
				await this.d.notifier.send({ title, message, priority: failed ? 1 : 0, sessionId: job.session_id ?? undefined, bot: job.bot });
				this.d.db.run("UPDATE job_runs SET notified = 1 WHERE id = ?", run.id);
			} catch (error) {
				log.error("notification failed", { job: job.id, error: String(error) });
			}
		}
	}

	private shouldNotify(job: JobRow, run: RunRow): boolean {
		const bad = run.status !== "ok" || run.error !== "";
		switch (job.notify) {
			case "never":
				return false;
			case "always":
				return true;
			case "on_error":
			case "agent":
				return bad;
			case "on_change": {
				if (bad) return true;
				const prev = this.d.db.get<{ summary: string }>("SELECT summary FROM job_runs WHERE job_id = ? AND status = 'ok' AND id < ? ORDER BY id DESC LIMIT 1", job.id, run.id);
				const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
				return !prev || norm(prev.summary) !== norm(run.summary);
			}
		}
	}

	/** When the task whose run this is comes due again (ms): a question asked in the run waits no longer. */
	questionDeadline(sessionId: string): number | undefined {
		const row = this.d.sessions.get(sessionId);
		const next = row?.kind === "job" && row.job_id ? this.get(row.job_id)?.next_run_at : undefined;
		return typeof next === "number" ? next * 1000 : undefined;
	}

	/** How a job session answers approvals with nobody there. */
	approvalsFor(sessionId: string): UnattendedApprovals | undefined {
		const row = this.d.sessions.get(sessionId);
		if (row?.kind !== "job" || !row.job_id) return undefined;
		return this.get(row.job_id)?.approvals ?? "deny";
	}
}
