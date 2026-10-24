// The client API's wire shapes of a scheduled task and one of its runs (docs/API.md "Scheduled tasks"). The API's
// operations and the scheduler tools (src/tools/schedule.ts) both use them, so a bot's `schedule_*` result and
// `GET /jobs` carry the same Job. Times leave as Unix milliseconds.
import { describeSpec } from "./schedule.ts";
import { type JobRow, type RunRow, type Scheduler, specOf } from "./scheduler.ts";

export const ms = (seconds: number | null | undefined): number | null => (seconds ? Math.round(seconds * 1000) : null);

export function jobJson(scheduler: Scheduler, job: JobRow) {
	const spec = specOf(job);
	const last = scheduler.lastRun(job.id);
	const running = scheduler.isRunning(job.id);
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
