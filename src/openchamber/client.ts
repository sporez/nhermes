// Client for OpenChamber's local server (a desktop UI over OpenCode v2). The address and bearer token are
// resolved on every call, from the bot's `openchamber:` config or OpenChamber's own settings file, so a
// restart of OpenChamber (new port or token) needs nothing here. The token never leaves this module:
// it is registered as a secret so logs and tool output are scrubbed of it.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BotConfig } from "../config.ts";
import { registerSecret } from "../log.ts";

export const DEFAULT_SETTINGS_PATH = join(homedir(), ".config", "openchamber", "settings.json");

export type OpenChamberOptions = {
	/** The bot's `openchamber:` config. */
	config?: BotConfig["openchamber"];
	/** OpenChamber's settings file (tests point this elsewhere). */
	settingsPath?: string;
	timeoutMs?: number;
};

/** An error whose message is safe and useful to show the model. */
export class OpenChamberError extends Error {}

export class OpenChamber {
	private readonly opts: OpenChamberOptions;

	constructor(opts: OpenChamberOptions = {}) {
		this.opts = opts;
	}

	/** Base URL and token for this call. */
	resolve(): { base: string; token: string } {
		const cfg = this.opts.config ?? {};
		const path = this.opts.settingsPath ?? DEFAULT_SETTINGS_PATH;
		let settings: { desktopLocalPort?: number; desktopLocalClientToken?: string } | undefined;
		const fromSettings = () => {
			if (settings) return settings;
			try {
				settings = JSON.parse(readFileSync(path, "utf8"));
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new OpenChamberError(`OpenChamber's settings file ${path} does not exist (is OpenChamber installed on this Mac?)`);
				throw new OpenChamberError(`could not read OpenChamber's settings file ${path}`);
			}
			return settings!;
		};
		let base = cfg.url?.replace(/\/+$/, "");
		if (!base) {
			const port = fromSettings().desktopLocalPort;
			if (!port) throw new OpenChamberError(`OpenChamber's settings file ${path} has no desktopLocalPort`);
			base = `http://127.0.0.1:${port}`;
		}
		let token: string | undefined;
		if (cfg.tokenEnv) {
			token = process.env[cfg.tokenEnv];
			if (!token) throw new OpenChamberError(`environment variable ${cfg.tokenEnv} (the OpenChamber token) is not set on the gateway`);
		} else {
			token = fromSettings().desktopLocalClientToken;
			if (!token) throw new OpenChamberError(`OpenChamber's settings file ${path} has no desktopLocalClientToken`);
		}
		registerSecret(token);
		return { base, token };
	}

	/** The model, variant and agent the user picked as defaults in OpenChamber; empty when its settings file is unreadable. */
	defaults(): { model?: string; variant?: string; agent?: string } {
		try {
			const s = JSON.parse(readFileSync(this.opts.settingsPath ?? DEFAULT_SETTINGS_PATH, "utf8")) as Record<string, unknown>;
			const pick = (v: unknown) => (typeof v === "string" && v ? v : undefined);
			return { model: pick(s.defaultModel), variant: pick(s.defaultVariant), agent: pick(s.defaultAgent) };
		} catch {
			return {};
		}
	}

	async request<T = unknown>(method: "GET" | "POST", path: string, o: { query?: Record<string, string | undefined>; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
		const { base, token } = this.resolve();
		const qs = Object.entries(o.query ?? {}).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${encodeURIComponent(v!).replace(/%2F/g, "/")}`);
		const url = `${base}${path}${qs.length ? `?${qs.join("&")}` : ""}`;
		const signal = AbortSignal.any([AbortSignal.timeout(this.opts.timeoutMs ?? 15_000), ...(o.signal ? [o.signal] : [])]);
		let res: Response;
		try {
			res = await fetch(url, {
				method,
				signal,
				headers: { authorization: `Bearer ${token}`, ...(o.body !== undefined ? { "content-type": "application/json" } : {}) },
				body: o.body === undefined ? undefined : JSON.stringify(o.body),
			});
		} catch (error) {
			const code = (error as { cause?: { code?: string } }).cause?.code;
			if (code === "ECONNREFUSED" || code === "ECONNRESET") throw new OpenChamberError("OpenChamber is not running on this Mac");
			if ((error as Error).name === "TimeoutError") throw new OpenChamberError("OpenChamber did not answer in time");
			if ((error as Error).name === "AbortError") throw error;
			throw new OpenChamberError(`could not reach OpenChamber: ${(error as Error).message}`);
		}
		if (res.status === 401) throw new OpenChamberError("OpenChamber rejected the token");
		const text = await res.text();
		if (!res.ok) {
			let detail = text.slice(0, 300);
			try {
				const j = JSON.parse(text) as { message?: string; error?: string };
				detail = j.message ?? j.error ?? detail;
			} catch {}
			throw new OpenChamberError(`OpenChamber answered ${res.status}${detail ? `: ${detail}` : ""}`);
		}
		return (text ? JSON.parse(text) : undefined) as T;
	}

	get<T = unknown>(path: string, query?: Record<string, string | undefined>, signal?: AbortSignal): Promise<T> {
		return this.request<T>("GET", path, { query, signal });
	}

	post<T = unknown>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
		return this.request<T>("POST", path, { body: body ?? {}, signal });
	}
}

// --- Shapes (only the fields the tools read) ---

export type ModelRef = { id: string; providerID: string; variant?: string };
export type SessionInfo = {
	id: string;
	parentID?: string;
	title?: string;
	agent?: string;
	model?: ModelRef;
	location?: { directory?: string };
	time?: { created?: number; updated?: number };
};
export type Page<T> = { data: T[]; cursor?: { previous?: string; next?: string } };

type Part = { type: string; text?: string; name?: string; state?: { status?: string; input?: unknown; error?: { message?: string } } };
export type Message = { id: string; type: string; text?: string; time?: { created?: number }; content?: Part[]; command?: string; status?: string; error?: { message?: string } };

export function clip(text: string, max: number): string {
	const t = text.replace(/\s+$/g, "");
	return t.length > max ? `${t.slice(0, max)}… [${t.length - max} more characters]` : t;
}

/** A tool call's input as one short line. */
function briefInput(input: unknown): string {
	if (!input || typeof input !== "object") return "";
	const o = input as Record<string, unknown>;
	const pick = ["command", "filePath", "path", "file", "pattern", "url", "query", "description", "prompt"].find((k) => typeof o[k] === "string");
	const v = pick ? (o[pick] as string) : JSON.stringify(o);
	return clip(v.replace(/\s+/g, " "), 100);
}

const TEXT_CAP = 1500;
export const READ_CAP = 12_000;

/** One message as lines: text kept up to a cap, tool calls one line each, reasoning dropped. */
function condenseMessage(m: Message): string[] {
	switch (m.type) {
		case "user":
			return [`USER: ${clip(m.text ?? "", TEXT_CAP)}`];
		case "synthetic":
		case "system":
			return m.text ? [`[${m.type}] ${clip(m.text, 300)}`] : [];
		case "shell":
			return [`[shell] ${clip(m.command ?? "", 100)} (${m.status ?? "?"})`];
		case "assistant": {
			const out: string[] = [];
			for (const p of m.content ?? []) {
				if (p.type === "text" && p.text?.trim()) out.push(`ASSISTANT: ${clip(p.text, TEXT_CAP)}`);
				else if (p.type === "tool") {
					const st = p.state?.status;
					const mark = st === "completed" ? "ok" : st === "error" ? `error: ${clip(p.state?.error?.message ?? "", 80)}` : (st ?? "?");
					out.push(`  · ${p.name} ${briefInput(p.state?.input)} → ${mark}`);
				}
			}
			if (m.error?.message) out.push(`  ! ${clip(m.error.message, 200)}`);
			return out;
		}
		default:
			return [];
	}
}

/** Messages oldest-first as a transcript, capped overall; when over the cap the oldest lines go. */
export function condenseMessages(messages: Message[], cap = READ_CAP): string {
	const lines = messages.flatMap(condenseMessage);
	let total = 0;
	let from = lines.length;
	while (from > 0 && total + lines[from - 1]!.length + 1 <= cap) total += lines[--from]!.length + 1;
	const body = lines.slice(from).join("\n");
	return from > 0 ? `[${from} earlier lines left out]\n${body}` : body;
}

export function when(ms: number | undefined): string {
	return ms ? new Date(ms).toISOString().slice(0, 16).replace("T", " ") + "Z" : "?";
}

/** Splits "provider/model" into OpenCode's model ref; the model id may itself contain "/". */
export function modelRef(ref: string, variant?: string): ModelRef {
	const i = ref.indexOf("/");
	if (i < 1 || i === ref.length - 1) throw new OpenChamberError(`model must be "provider/model", got "${ref}"`);
	return { providerID: ref.slice(0, i), id: ref.slice(i + 1), ...(variant ? { variant } : {}) };
}
