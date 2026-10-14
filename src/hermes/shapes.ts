// Canonical objects → Hermes wire shapes (field names per Hermes's generated contract, restricted to
// what Vory decodes). Pure functions; no state.
import type { Bot } from "../core/bots.ts";
import type { ApprovalRequest, UsageSummary } from "../core/events.ts";
import type { SessionRow } from "../core/sessions.ts";
import { describeSpec } from "../core/schedule.ts";
import { type JobRow, type RunRow, specOf } from "../core/scheduler.ts";

export const VERSION = "0.1.0";

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json | undefined };

export function usageJson(u: UsageSummary): Record<string, Json> {
	const pct = u.contextMax > 0 ? Math.min(100, Math.round((u.contextUsed / u.contextMax) * 100)) : 0;
	return {
		model: u.model,
		input: u.input,
		output: u.output,
		reasoning: u.reasoning,
		total: u.total,
		calls: u.calls,
		compressions: 0,
		context_used: u.contextUsed,
		context_max: u.contextMax,
		context_percent: pct,
		context_estimated: false,
		cache_read: u.cacheRead,
		cache_write: u.cacheWrite,
		cost_usd: Math.round(u.costUsd * 10000) / 10000,
		cost_status: "estimated",
	};
}

/** Durable thinking level → Hermes reasoning effort word. */
export function effortOf(thinking: string): string {
	return thinking === "off" ? "none" : thinking;
}

/** Hermes reasoning effort word → Durable thinking level. */
export function thinkingOf(effort: string): string | undefined {
	const e = effort.trim().toLowerCase();
	if (e === "none" || e === "off" || e === "disabled") return "off";
	if (e === "max" || e === "ultra") return "xhigh";
	if (["minimal", "low", "medium", "high", "xhigh"].includes(e)) return e;
	return undefined;
}

export function sessionInfo(args: {
	bot: Bot;
	model?: { provider: string; modelId: string };
	thinking: string;
	title: string;
	running: boolean;
	storedId: string;
	yolo: boolean;
	usage?: UsageSummary;
}): Record<string, Json> {
	const info: Record<string, Json> = {
		model: args.model?.modelId ?? "",
		provider: args.model?.provider ?? "",
		reasoning_effort: effortOf(args.thinking),
		service_tier: "",
		fast: false,
		yolo: args.yolo,
		approval_mode: args.bot.approvals.mode,
		cwd: args.bot.workspace,
		running: args.running,
		title: args.title,
		stored_session_id: args.storedId,
		version: VERSION,
		profile_name: args.bot.name,
		lazy: false,
	};
	if (args.usage) info.usage = usageJson(args.usage);
	return info;
}

export function storedSession(row: SessionRow, model: string, running: boolean): Record<string, Json> {
	return {
		id: row.id,
		title: row.title || null,
		preview: row.preview || null,
		source: row.kind === "job" ? "cron" : row.kind === "delegate" ? "delegate" : row.source,
		model,
		started_at: row.created_at,
		ended_at: null,
		last_active: row.last_active,
		message_count: row.message_count,
		is_active: running,
		archived: row.archived === 1,
		pinned: row.pinned === 1,
		profile: row.bot,
		is_default_profile: false,
		cwd: null,
	};
}

export function profileJson(bot: Bot, skillCount: number): Record<string, Json> {
	return {
		name: bot.name,
		path: bot.workspace,
		is_default: bot.isDefault,
		model: bot.model.modelId,
		provider: bot.model.provider,
		has_env: true,
		skill_count: skillCount,
		gateway_running: true,
		description: bot.description,
		description_auto: false,
		display_name: bot.displayName,
		bot_title: "",
	};
}

export function approvalParams(r: ApprovalRequest): Record<string, Json> {
	return {
		session_id: r.sessionId,
		request_id: r.requestId,
		command: r.command,
		description: r.description,
		choices: r.choices,
		allow_permanent: true,
		allow_session: true,
		tool_name: r.toolName,
		pattern_key: r.patternKey,
		pattern_keys: [r.patternKey],
	};
}

/** Server→client request id for an approval: the same on every socket, so any client may answer. */
export function srqId(requestId: string): string {
	return `srq-${requestId}`;
}

const iso = (t: number | null | undefined) => (t ? new Date(t * 1000).toISOString().replace(/\.\d{3}Z$/, "Z") : null);

/** A job as Hermes's cron routes list it (`hermes_cli/web_routers/cron.py`). */
export function cronJobJson(job: JobRow, last: RunRow | undefined, running: boolean): Record<string, Json> {
	const spec = specOf(job);
	return {
		job_id: job.id,
		id: job.id,
		name: job.name,
		schedule: describeSpec(spec),
		schedule_detail: { kind: spec.kind, timezone: job.timezone },
		timezone: job.timezone,
		prompt: job.prompt,
		prompt_preview: job.prompt.slice(0, 160),
		deliver: job.deliver,
		notify: job.notify,
		approvals: job.approvals,
		model: job.model,
		skills: JSON.parse(job.skills) as string[],
		enabled: job.enabled === 1,
		state: running ? "running" : job.enabled === 1 ? (job.next_run_at ? "active" : "completed") : "paused",
		next_run_at: job.enabled === 1 ? iso(job.next_run_at) : null,
		last_run_at: iso(last?.started_at),
		last_status: last ? (last.status === "running" ? "running" : last.status) : null,
		last_error: last?.error || null,
		profile: job.bot,
		session_id: job.session_id,
	};
}

export function cronRunJson(run: RunRow, job: JobRow | undefined): Record<string, Json> {
	return {
		run_id: run.id,
		job_id: run.job_id,
		trigger: run.trigger,
		status: run.status,
		started_at: iso(run.started_at),
		finished_at: iso(run.finished_at),
		summary: run.summary,
		error: run.error || null,
		notified: run.notified === 1,
		session_id: job?.session_id ?? null,
	};
}
