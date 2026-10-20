// Structured JSON-lines logging. Known secret values are replaced before anything is written.

type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const secrets = new Set<string>();
let minLevel: Level = (process.env.NHERMES_LOG_LEVEL as Level | undefined) ?? "info";
let sink: (line: string) => void = (line) => process.stderr.write(line + "\n");

/** Registers a value that must never appear in logs (tokens, API keys). Short values are ignored. */
export function registerSecret(value: string | undefined): void {
	if (value && value.length >= 8) secrets.add(value);
}

export function redact(text: string): string {
	let out = text;
	for (const s of secrets) {
		if (out.includes(s)) out = out.split(s).join("[redacted]");
		// The same value inside a JSON string is escaped (quotes, backslashes, non-ASCII).
		const escaped = JSON.stringify(s).slice(1, -1);
		if (escaped !== s && out.includes(escaped)) out = out.split(escaped).join("[redacted]");
	}
	return out;
}

export function setLogLevel(level: Level): void {
	minLevel = level;
}

/** Test hook: capture log lines instead of writing them to stderr. */
export function setLogSink(next: (line: string) => void): void {
	sink = next;
}

// The last lines written, for Vory's System screen (the journal or launchd log keeps the rest).
const RECENT_MAX = 500;
const recent: string[] = [];

/** The most recent log lines, oldest first, as `2026-10-15 21:30:05 INFO [scope] msg {fields}`. */
export function recentLogs(limit = 200): string[] {
	return recent.slice(-limit);
}

function write(level: Level, scope: string, msg: string, fields?: Record<string, unknown>): void {
	if (ORDER[level] < ORDER[minLevel]) return;
	const t = new Date().toISOString();
	const record: Record<string, unknown> = { t, level, scope, msg };
	if (fields) {
		for (const [k, v] of Object.entries(fields)) {
			record[k] = v instanceof Error ? { name: v.name, message: v.message } : v;
		}
	}
	sink(redact(JSON.stringify(record)));
	const rest = fields && Object.keys(fields).length > 0 ? ` ${JSON.stringify(Object.fromEntries(Object.keys(fields).map((k) => [k, record[k]])))}` : "";
	recent.push(redact(`${t.slice(0, 10)} ${t.slice(11, 19)} ${level.toUpperCase()} [${scope}] ${msg}${rest}`));
	if (recent.length > RECENT_MAX) recent.splice(0, recent.length - RECENT_MAX);
}

export type Logger = {
	debug(msg: string, fields?: Record<string, unknown>): void;
	info(msg: string, fields?: Record<string, unknown>): void;
	warn(msg: string, fields?: Record<string, unknown>): void;
	error(msg: string, fields?: Record<string, unknown>): void;
};

export function logger(scope: string): Logger {
	return {
		debug: (m, f) => write("debug", scope, m, f),
		info: (m, f) => write("info", scope, m, f),
		warn: (m, f) => write("warn", scope, m, f),
		error: (m, f) => write("error", scope, m, f),
	};
}
