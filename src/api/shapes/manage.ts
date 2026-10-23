// Wire shapes of the gateway upkeep resources (docs/API.md "Gateway"): settings, keys, scheduled tasks,
// workspace files, software and actions. Times leave as Unix milliseconds. No key value is in any of them,
// only whether it is set and the last characters that tell keys apart.
import type { Core } from "../../app.ts";
import type { ActionRecord } from "../../core/actions.ts";
import { type JobRow, type RunRow, specOf } from "../../core/scheduler.ts";
import { describeSpec } from "../../core/schedule.ts";
import type { SecretInfo } from "../../core/secrets.ts";
import type { SoftwareStatus } from "../../core/updates.ts";
import { VERSION } from "../../version.ts";

export const ms = (seconds: number | null | undefined): number | null => (seconds ? Math.round(seconds * 1000) : null);

export function gatewaySettingsJson(core: Core) {
	const c = core.config;
	return {
		timeZone: c.timezone,
		defaults: { model: c.defaults.model, thinking: c.defaults.thinking, approvals: c.defaults.approvals, approvalTimeoutS: c.defaults.approvalTimeoutS },
		hiddenModelProviders: c.modelLists.hide,
		groundRules: c.groundRules ?? null,
		review: { enabled: c.review.enabled, allowThreshold: c.review.allowThreshold, timeoutMs: c.review.timeoutMs, keyEnv: c.review.keyEnv },
	};
}

export function keyJson(core: Core, k: SecretInfo) {
	let hint: string | null = null;
	if (k.set) {
		try {
			hint = core.secrets.hint(k.name);
		} catch {
			// Set in the file but not in this process's environment yet.
		}
	}
	return { name: k.name, set: k.set, description: k.description, usedBy: k.usedBy, hint };
}

export function jobJson(core: Core, job: JobRow) {
	const spec = specOf(job);
	const last = core.scheduler.lastRun(job.id);
	const running = core.scheduler.isRunning(job.id);
	return {
		id: job.id,
		name: job.name,
		botId: job.bot,
		prompt: job.prompt,
		schedule: describeSpec(spec),
		scheduleDetail: { kind: spec.kind, timezone: job.timezone },
		timezone: job.timezone,
		deliver: job.deliver,
		notify: job.notify,
		context: job.context,
		approvals: job.approvals,
		model: job.model,
		skills: JSON.parse(job.skills) as string[],
		enabled: job.enabled === 1,
		state: running ? "running" : job.enabled === 1 ? (job.next_run_at ? "active" : "completed") : "paused",
		nextRunAt: job.enabled === 1 ? ms(job.next_run_at) : null,
		lastRunAt: ms(last?.started_at),
		lastStatus: last?.status ?? null,
		lastError: last?.error || null,
		sessionId: job.session_id,
		createdAt: ms(job.created_at),
		updatedAt: ms(job.updated_at),
	};
}

export function runJson(run: RunRow, job: JobRow | undefined) {
	return {
		id: run.id,
		jobId: run.job_id,
		trigger: run.trigger,
		status: run.status,
		startedAt: ms(run.started_at),
		finishedAt: ms(run.finished_at),
		summary: run.summary,
		error: run.error || null,
		notified: run.notified === 1,
		sessionId: job?.session_id ?? null,
	};
}

export function softwareJson(core: Core, s: SoftwareStatus) {
	const restartReason = core.updates.canRestart ? null : "This gateway is not run by systemd or launchd, so it cannot restart itself; do it on its machine.";
	return {
		version: VERSION,
		commit: s.current ? { hash: s.current.hash, subject: s.current.subject, date: ms(s.current.date) } : null,
		branch: s.branch ?? null,
		behind: s.available.length,
		commits: s.available.map((c) => ({ hash: c.hash, subject: c.subject, date: ms(c.date) })),
		lastCheck: ms(s.lastCheck),
		canUpdate: s.updatable,
		canRestart: core.updates.canRestart,
		reason: (!s.updatable ? s.reason : restartReason) ?? null,
		running: core.sessions.runningCount(),
	};
}

export function actionJson(id: string, a: ActionRecord) {
	const done = a.finishedAt !== undefined;
	return {
		id,
		kind: a.kind ?? null,
		status: !done ? "running" : (a.exitCode ?? 0) === 0 ? "done" : "failed",
		startedAt: ms(a.startedAt),
		finishedAt: ms(a.finishedAt),
		exitCode: a.exitCode ?? null,
		lines: a.lines,
	};
}
