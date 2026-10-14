// Tools for scheduled tasks and notifications: the same Scheduler the Vory cron screens use.
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import type { Feature, LateServices } from "../app.ts";
import type { JobRow, Scheduler } from "../core/scheduler.ts";
import { describeSpec, ScheduleError } from "../core/schedule.ts";
import { specOf } from "../core/scheduler.ts";
import type { Notifier } from "../notify/notifier.ts";

function text(t: string) {
	return { output: [{ type: "text" as const, text: t }] };
}

export function describeJob(s: Scheduler, j: JobRow): string {
	const last = s.lastRun(j.id);
	const next = j.next_run_at ? new Date(j.next_run_at * 1000).toISOString() : "none";
	return `${j.id} "${j.name}" bot=${j.bot} schedule="${describeSpec(specOf(j))}" tz=${j.timezone} ${j.enabled ? "enabled" : "paused"} next=${next} notify=${j.notify}${last ? ` last=${last.status}` : ""}`;
}

const NotifyPolicy = Type.Union([Type.Literal("never"), Type.Literal("always"), Type.Literal("on_error"), Type.Literal("on_change"), Type.Literal("agent")]);

export function scheduleFeature(late: LateServices, scheduler: () => Scheduler, notifier: () => Notifier): Feature {
	const botOf = (conversationId: number) => {
		const bot = late.sessions().botOf(conversationId);
		if (!bot) throw new Error("this conversation has no bot");
		return bot;
	};
	const wrap = <T>(fn: () => T): T => {
		try {
			return fn();
		} catch (error) {
			if (error instanceof ScheduleError || (error as { status?: number }).status) throw new Error((error as Error).message);
			throw error;
		}
	};

	const create = defineTool({
		name: "schedule_create",
		description:
			"Create a scheduled task that runs a prompt without anyone connected. schedule is a cron expression (\"0 7 * * 1-5\"), " +
			"\"every 30m\" / \"every 6h\" / \"every 1d\", or \"at 2026-10-15T09:00\" for once. Times use the time zone given or the owner's. " +
			"notify: never | always | on_error (default) | on_change | agent (the run decides by calling notify).",
		parameters: Type.Object({
			name: Type.String(),
			prompt: Type.String({ description: "What the run should do, self-contained" }),
			schedule: Type.String(),
			timezone: Type.Optional(Type.String()),
			bot: Type.Optional(Type.String({ description: "Which bot runs it (default: you)" })),
			notify: Type.Optional(NotifyPolicy),
			skills: Type.Optional(Type.Array(Type.String())),
			model: Type.Optional(Type.String({ description: "provider/model override" })),
			deliver: Type.Optional(Type.Union([Type.Literal("session"), Type.Literal("chat")])),
		}),
		execute: async (args, api) => {
			const bot = botOf(api.conversationId as number);
			const job = wrap(() =>
				scheduler().create({ name: args.name, prompt: args.prompt, schedule: args.schedule, timezone: args.timezone, bot: args.bot ?? bot.name, notify: args.notify, skills: args.skills, model: args.model, deliver: args.deliver }),
			);
			return text(`Created ${describeJob(scheduler(), job)}`);
		},
	});
	const list = defineTool({
		name: "schedule_list",
		description: "List scheduled tasks (all bots, or one) with their next and last run.",
		parameters: Type.Object({ bot: Type.Optional(Type.String()) }),
		replay: "safe",
		execute: async (args) => {
			const jobs = scheduler().list(args.bot);
			return text(jobs.length ? jobs.map((j) => describeJob(scheduler(), j)).join("\n") : "No scheduled tasks.");
		},
	});
	const update = defineTool({
		name: "schedule_update",
		description: "Change a scheduled task: name, prompt, schedule, timezone, notify, enabled (pause/resume).",
		parameters: Type.Object({
			id: Type.String(),
			name: Type.Optional(Type.String()),
			prompt: Type.Optional(Type.String()),
			schedule: Type.Optional(Type.String()),
			timezone: Type.Optional(Type.String()),
			notify: Type.Optional(NotifyPolicy),
			enabled: Type.Optional(Type.Boolean()),
		}),
		execute: async (args) => {
			const { id, ...patch } = args;
			return text(`Updated ${describeJob(scheduler(), wrap(() => scheduler().update(id, patch)))}`);
		},
	});
	const remove = defineTool({
		name: "schedule_delete",
		description: "Delete a scheduled task by id.",
		parameters: Type.Object({ id: Type.String() }),
		execute: async (args) => {
			wrap(() => scheduler().delete(args.id));
			return text(`Deleted ${args.id}.`);
		},
	});
	const runNow = defineTool({
		name: "schedule_run",
		description: "Start a scheduled task now (its result goes to the task's own session).",
		parameters: Type.Object({ id: Type.String() }),
		execute: async (args) => {
			const run = await scheduler().trigger(args.id);
			return text(`Started run ${run.id} of ${args.id}.`);
		},
	});
	const history = defineTool({
		name: "schedule_history",
		description: "Recent runs of a scheduled task with their status and summary.",
		parameters: Type.Object({ id: Type.String(), limit: Type.Optional(Type.Number()) }),
		replay: "safe",
		execute: async (args) => {
			const runs = scheduler().runs(scheduler().require(args.id).id, args.limit ?? 10);
			return text(
				runs.length
					? runs.map((r) => `#${r.id} ${new Date(r.started_at * 1000).toISOString()} ${r.trigger} ${r.status}${r.error ? ` (${r.error})` : ""}${r.summary ? `: ${r.summary.slice(0, 200)}` : ""}`).join("\n")
					: "No runs yet.",
			);
		},
	});
	const notify = defineTool({
		name: "notify",
		description: "Send the owner a push notification (Pushover). For things that matter now; keep it short.",
		parameters: Type.Object({ title: Type.String(), message: Type.String(), priority: Type.Optional(Type.Union([Type.Literal(-1), Type.Literal(0), Type.Literal(1)])) }),
		execute: async (args) => {
			await notifier().send({ title: args.title, message: args.message, priority: args.priority });
			return text(notifier().name === "none" ? "No notification transport is configured; the message was not delivered." : "Notification sent.");
		},
	});
	return {
		groups: new Map([
			["schedule", [create, list, update, remove, runNow, history] as ToolRegistration[]],
			["notify", [notify] as ToolRegistration[]],
		]),
	};
}
