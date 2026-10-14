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
	for (const s of secrets) if (out.includes(s)) out = out.split(s).join("[redacted]");
	return out;
}

export function setLogLevel(level: Level): void {
	minLevel = level;
}

/** Test hook: capture log lines instead of writing them to stderr. */
export function setLogSink(next: (line: string) => void): void {
	sink = next;
}

function write(level: Level, scope: string, msg: string, fields?: Record<string, unknown>): void {
	if (ORDER[level] < ORDER[minLevel]) return;
	const record: Record<string, unknown> = { t: new Date().toISOString(), level, scope, msg };
	if (fields) {
		for (const [k, v] of Object.entries(fields)) {
			record[k] = v instanceof Error ? { name: v.name, message: v.message } : v;
		}
	}
	sink(redact(JSON.stringify(record)));
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
