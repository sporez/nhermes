// Schedule parsing and next-run computation. Cron expressions run in the job's time zone (croner):
// on a spring-forward day a time that does not exist runs once, an hour later; on a fall-back day a
// repeated time runs once. "every" intervals are anchored to the job's creation time. "at" is one-shot.
import { Cron } from "croner";

export type ScheduleSpec = { kind: "cron"; expr: string } | { kind: "every"; seconds: number } | { kind: "at"; at: number };

export class ScheduleError extends Error {
	override name = "ScheduleError";
}

const UNITS: Record<string, number> = { s: 1, sec: 1, m: 60, min: 60, h: 3600, hr: 3600, d: 86400, day: 86400, w: 604800 };

/** Accepts a cron expression, "every 30m" / "every 2h" / "every 1d", or "at <ISO date-time>". */
export function parseSchedule(text: string, timezone: string): ScheduleSpec {
	const t = text.trim();
	const every = /^every\s+(\d+)\s*(s|sec|m|min|h|hr|d|day|w)s?$/i.exec(t);
	if (every) {
		const seconds = Number(every[1]) * UNITS[every[2]!.toLowerCase()]!;
		if (seconds < 60) throw new ScheduleError("the shortest interval is 1 minute");
		return { kind: "every", seconds };
	}
	const at = /^at\s+(.+)$/i.exec(t);
	if (at) {
		const when = parseLocal(at[1]!.trim(), timezone);
		if (Number.isNaN(when)) throw new ScheduleError(`cannot read the time "${at[1]}"; use an ISO date-time like 2026-10-15T09:00`);
		return { kind: "at", at: when / 1000 };
	}
	try {
		new Cron(t, { timezone, paused: true });
	} catch (error) {
		throw new ScheduleError(`not a schedule: "${t}" (${error instanceof Error ? error.message : String(error)}). Use a cron expression, "every 30m", or "at 2026-10-15T09:00".`);
	}
	if (t.split(/\s+/).length === 6 && !/^0\s/.test(t)) throw new ScheduleError("seconds-level cron schedules are not supported");
	return { kind: "cron", expr: t };
}

/** An ISO date-time; without an offset it is read in `timezone`. Returns epoch milliseconds. */
export function parseLocal(text: string, timezone: string): number {
	if (/[zZ]$|[+-]\d\d:?\d\d$/.test(text)) return Date.parse(text);
	const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(text);
	if (!m) return Number.NaN;
	const [y, mo, d, h, mi, s] = m.slice(1).map((x) => Number(x ?? 0)) as [number, number, number, number, number, number];
	// Find the UTC instant whose wall-clock time in `timezone` is the given one.
	let guess = Date.UTC(y, mo - 1, d, h, mi, s);
	for (let i = 0; i < 3; i++) {
		const parts = wallClock(guess, timezone);
		const diff = Date.UTC(y, mo - 1, d, h, mi, s) - Date.UTC(parts.y, parts.mo - 1, parts.d, parts.h, parts.mi, parts.s);
		if (diff === 0) break;
		guess += diff;
	}
	return guess;
}

function wallClock(ms: number, timezone: string) {
	const f = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
	const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
	return { y: Number(p.year), mo: Number(p.month), d: Number(p.day), h: Number(p.hour), mi: Number(p.minute), s: Number(p.second) };
}

/** The first run strictly after `after` (epoch seconds), or undefined when there is none (a past "at"). */
export function nextRun(spec: ScheduleSpec, timezone: string, after: number, anchor: number): number | undefined {
	switch (spec.kind) {
		case "cron": {
			const next = new Cron(spec.expr, { timezone, paused: true }).nextRun(new Date(after * 1000));
			return next ? next.getTime() / 1000 : undefined;
		}
		case "every": {
			const n = Math.floor((after - anchor) / spec.seconds) + 1;
			return anchor + Math.max(1, n) * spec.seconds;
		}
		case "at":
			return spec.at > after ? spec.at : undefined;
	}
}

export function describeSpec(spec: ScheduleSpec): string {
	switch (spec.kind) {
		case "cron":
			return spec.expr;
		case "every": {
			const s = spec.seconds;
			return s % 86400 === 0 ? `every ${s / 86400}d` : s % 3600 === 0 ? `every ${s / 3600}h` : `every ${Math.round(s / 60)}m`;
		}
		case "at":
			return `at ${new Date(spec.at * 1000).toISOString()}`;
	}
}
