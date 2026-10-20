// Provider login sessions on this machine: drives Pi's own OAuth flows (Models.login) in the background so
// the CLI, the panel and members can show a device code or link, answer a prompt, and cancel. The gateway
// is the only writer of the credential store (ModelRuntime.login persists it and refreshes the model lists).
// Sessions live in memory only. A prompt's answer is never stored; a secret answer is also registered for
// log redaction. Every string that comes from Pi is redacted before it is kept.
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { AuthEvent, AuthInteraction, AuthPrompt, Models } from "@earendil-works/pi-ai";
import { logger, redact, registerSecret } from "../log.ts";
import type { AppDb } from "../store/db.ts";

const log = logger("logins");

export type LoginStatus = { kind: "oauth"; expires?: number } | { kind: "key"; source: string } | { kind: "none" };
export type LoginProvider = {
	id: string;
	name: string;
	oauth: { label?: string; subscription: boolean } | null;
	apiKey: boolean;
	status: LoginStatus;
	lastError?: string;
	/** Id of the open login session for this provider, if any. */
	open?: string;
};
export type LoginPrompt = {
	type: "text" | "secret" | "select" | "manual_code";
	message: string;
	placeholder?: string;
	options?: { id: string; label: string; description?: string }[];
};
export type LoginEvent = { at: number } & (
	| { type: "info"; message: string; links?: { url: string; label?: string }[] }
	| { type: "auth_url"; url: string; instructions?: string }
	| { type: "device_code"; userCode: string; verificationUri: string; expiresInSeconds?: number }
	| { type: "progress"; message: string }
);
export type LoginState = "waiting" | "prompt" | "done" | "failed" | "cancelled";
export type LoginSession = {
	id: string;
	provider: string;
	state: LoginState;
	events: LoginEvent[];
	prompt?: LoginPrompt;
	startedAt: number;
	finishedAt?: number;
	message?: string;
};

export class LoginError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

/** What ModelRuntime adds over Pi's Models for side-effect-free status (absent on a plain Models). */
type StatusSource = {
	isUsingOAuth?(providerId: string): boolean;
	getProviderAuthStatus?(providerId: string): { configured: boolean; source?: string; label?: string };
};

export type LoginsOptions = {
	models: Models;
	db: AppDb;
	/** Pi's credential file, read only for the (non-secret) expiry of a stored OAuth login. */
	authPath?: string;
	now?: () => number;
	/** Timer hooks, replaceable so tests need no real waiting. */
	setTimer?: (fn: () => void, ms: number) => unknown;
	clearTimer?: (handle: unknown) => void;
	/** Without a device code's expiry, a login is abandoned after this long. */
	timeoutMs?: number;
	/** How long a finished session stays readable. */
	keepMs?: number;
};

const MAX_OPEN = 4;
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const DEVICE_CODE_MARGIN_MS = 30_000;
const DEFAULT_KEEP_MS = 10 * 60_000;

type Entry = {
	session: LoginSession;
	controller: AbortController;
	pending?: { prompt: LoginPrompt; resolve: (value: string) => void; reject: (reason: unknown) => void };
	timer?: unknown;
	/** Why the flow was stopped from here, so the abort is reported as that and not as a Pi error. */
	stopped?: { state: "cancelled" | "failed"; message: string };
};

const text = (s: string): string => redact(s);

export class Logins {
	private readonly models: Models;
	private readonly db: AppDb;
	private readonly authPath?: string;
	private readonly now: () => number;
	private readonly setTimer: (fn: () => void, ms: number) => unknown;
	private readonly clearTimer: (handle: unknown) => void;
	private readonly timeoutMs: number;
	private readonly keepMs: number;
	private readonly entries = new Map<string, Entry>();
	private readonly lastErrors = new Map<string, string>();

	constructor(o: LoginsOptions) {
		this.models = o.models;
		this.db = o.db;
		this.authPath = o.authPath;
		this.now = o.now ?? (() => Date.now());
		this.setTimer = o.setTimer ?? ((fn, ms) => {
			const t = setTimeout(fn, ms);
			t.unref();
			return t;
		});
		this.clearTimer = o.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
		this.timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.keepMs = o.keepMs ?? DEFAULT_KEEP_MS;
	}

	/** Providers that can be signed in to (OAuth) or hold a key, with their status. Makes no network call. */
	async list(): Promise<LoginProvider[]> {
		this.sweep();
		const out: LoginProvider[] = [];
		for (const p of this.models.getProviders()) {
			const oauth = p.auth.oauth?.login ? { label: p.auth.oauth.loginLabel, subscription: p.auth.oauth.isSubscription === true } : null;
			const apiKey = p.auth.apiKey !== undefined;
			if (!oauth && !apiKey) continue;
			const entry: LoginProvider = { id: p.id, name: p.name, oauth, apiKey, status: this.status(p.id) };
			const err = this.lastErrors.get(p.id);
			if (err) entry.lastError = err;
			const open = this.openFor(p.id);
			if (open) entry.open = open.session.id;
			out.push(entry);
		}
		return out;
	}

	/** Stored or ambient credentials only; never refreshes a token. */
	private status(providerId: string): LoginStatus {
		const src = this.models as unknown as StatusSource;
		try {
			if (src.isUsingOAuth?.(providerId)) return { kind: "oauth", expires: this.storedExpiry(providerId) };
			const s = src.getProviderAuthStatus?.(providerId);
			if (s?.configured) return { kind: "key", source: s.label ?? s.source ?? "configured" };
		} catch {
			// an unreadable status reads as not signed in
		}
		return { kind: "none" };
	}

	private storedExpiry(providerId: string): number | undefined {
		if (!this.authPath) return undefined;
		try {
			const file = JSON.parse(readFileSync(this.authPath, "utf8")) as Record<string, { type?: unknown; expires?: unknown }>;
			const c = file[providerId];
			return c?.type === "oauth" && typeof c.expires === "number" ? c.expires : undefined;
		} catch {
			return undefined;
		}
	}

	/** The stable id OpenAI's ChatGPT flow sends as this installation's agent host id. */
	private deviceId(): string {
		const key = "logins.deviceId";
		const have = this.db.get<{ value: string }>("SELECT value FROM settings WHERE key = ?", key)?.value;
		if (have) return have;
		const id = randomUUID();
		this.db.run("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING", key, id);
		return this.db.get<{ value: string }>("SELECT value FROM settings WHERE key = ?", key)?.value ?? id;
	}

	private isOpen(e: Entry): boolean {
		return e.session.state === "waiting" || e.session.state === "prompt";
	}

	private openFor(provider: string): Entry | undefined {
		for (const e of this.entries.values()) if (e.session.provider === provider && this.isOpen(e)) return e;
		return undefined;
	}

	private sweep(): void {
		const cutoff = this.now() - this.keepMs;
		for (const [id, e] of this.entries) if (e.session.finishedAt !== undefined && e.session.finishedAt <= cutoff) this.entries.delete(id);
	}

	/** Starts a login in the background. `by`: "panel", "cli" or "member:<name>". */
	start(provider: string, by: string): LoginSession {
		this.sweep();
		const p = this.models.getProviders().find((x) => x.id === provider);
		if (!p) throw new LoginError(404, `unknown provider "${provider}"`);
		if (!p.auth.oauth?.login) throw new LoginError(400, `${p.name} has no sign-in; set its key under Keys instead`);
		if (this.openFor(provider)) throw new LoginError(409, `a login for ${p.name} is already open`);
		if ([...this.entries.values()].filter((e) => this.isOpen(e)).length >= MAX_OPEN) throw new LoginError(429, "too many logins are open; finish or cancel one first");

		const entry: Entry = { session: { id: randomUUID(), provider, state: "waiting", events: [], startedAt: this.now() }, controller: new AbortController() };
		this.entries.set(entry.session.id, entry);
		this.armTimer(entry, this.timeoutMs);
		log.info("login started", { provider, by });

		const interaction: AuthInteraction = {
			signal: entry.controller.signal,
			notify: (event) => this.notify(entry, event),
			prompt: (prompt) => this.ask(entry, prompt),
		};
		void this.models.login(provider, "oauth", interaction, { getDeviceId: () => this.deviceId() }).then(
			() => {
				this.lastErrors.delete(provider);
				this.finish(entry, "done", `Signed in to ${text(p.name)}`);
				log.info("login finished", { provider, by, outcome: "done" });
			},
			(error: unknown) => {
				if (entry.stopped) {
					this.finish(entry, entry.stopped.state, entry.stopped.message);
					log.info("login finished", { provider, by, outcome: entry.stopped.state });
					return;
				}
				const message = text(error instanceof Error ? error.message : String(error)) || "sign-in failed";
				this.lastErrors.set(provider, message);
				this.finish(entry, "failed", message);
				log.warn("login finished", { provider, by, outcome: "failed", error: message });
			},
		);
		return this.view(entry);
	}

	get(id: string): LoginSession {
		this.sweep();
		const e = this.entries.get(id);
		if (!e) throw new LoginError(404, "unknown login");
		return this.view(e);
	}

	/** Answers the pending prompt. A secret answer is registered for redaction and kept nowhere. */
	answer(id: string, value: string): LoginSession {
		const e = this.entries.get(id);
		if (!e) throw new LoginError(404, "unknown login");
		const pending = e.pending;
		if (!pending || e.session.state !== "prompt") throw new LoginError(409, "this login is not waiting for an answer");
		if (pending.prompt.type === "select" && !pending.prompt.options?.some((o) => o.id === value)) throw new LoginError(400, "choose one of the offered options");
		if (pending.prompt.type === "secret" || pending.prompt.type === "manual_code") registerSecret(value);
		e.pending = undefined;
		e.session.state = "waiting";
		e.session.prompt = undefined;
		pending.resolve(value);
		return this.view(e);
	}

	cancel(id: string, by = "panel"): LoginSession {
		const e = this.entries.get(id);
		if (!e) throw new LoginError(404, "unknown login");
		if (this.isOpen(e)) {
			this.stop(e, "cancelled", "Cancelled");
			log.info("login cancelled", { provider: e.session.provider, by });
		}
		return this.view(e);
	}

	/** Removes the stored login for a provider (and stops an open login for it). */
	async logout(provider: string, by = "panel"): Promise<{ ok: true }> {
		const p = this.models.getProviders().find((x) => x.id === provider);
		if (!p) throw new LoginError(404, `unknown provider "${provider}"`);
		const open = this.openFor(provider);
		if (open) this.stop(open, "cancelled", "Cancelled");
		await this.models.logout(provider);
		this.lastErrors.delete(provider);
		log.info("logout", { provider, by });
		return { ok: true };
	}

	/** Cancels every open login (shutdown). */
	close(): void {
		for (const e of this.entries.values()) if (this.isOpen(e)) this.stop(e, "cancelled", "Cancelled");
	}

	private view(e: Entry): LoginSession {
		const s = e.session;
		return { ...s, events: s.events.map((x) => ({ ...x })), prompt: s.prompt ? { ...s.prompt, options: s.prompt.options?.map((o) => ({ ...o })) } : undefined };
	}

	private armTimer(e: Entry, ms: number): void {
		if (e.timer !== undefined) this.clearTimer(e.timer);
		e.timer = this.setTimer(() => {
			if (this.isOpen(e)) this.stop(e, "failed", "Timed out waiting for the sign-in to finish");
		}, ms);
	}

	/** Ends the flow from this side: the abort makes Pi's login reject, which then reports `stopped`. */
	private stop(e: Entry, state: "cancelled" | "failed", message: string): void {
		e.stopped = { state, message };
		const pending = e.pending;
		e.pending = undefined;
		pending?.reject(new Error(message));
		e.controller.abort(new Error(message));
		// Mark it at once: a flow that ignores the abort must not stay open.
		this.finish(e, state, message);
	}

	private finish(e: Entry, state: LoginState, message: string): void {
		if (e.timer !== undefined) this.clearTimer(e.timer);
		e.timer = undefined;
		if (e.session.finishedAt !== undefined) return;
		e.session.state = state;
		e.session.message = message;
		e.session.prompt = undefined;
		e.session.finishedAt = this.now();
	}

	private notify(e: Entry, event: AuthEvent): void {
		if (!this.isOpen(e)) return;
		const at = this.now();
		switch (event.type) {
			case "info":
				e.session.events.push({ at, type: "info", message: text(event.message), ...(event.links ? { links: event.links.map((l) => ({ url: text(l.url), ...(l.label ? { label: text(l.label) } : {}) })) } : {}) });
				break;
			case "auth_url":
				e.session.events.push({ at, type: "auth_url", url: text(event.url), ...(event.instructions ? { instructions: text(event.instructions) } : {}) });
				break;
			case "device_code":
				e.session.events.push({ at, type: "device_code", userCode: text(event.userCode), verificationUri: text(event.verificationUri), ...(event.expiresInSeconds ? { expiresInSeconds: event.expiresInSeconds } : {}) });
				if (event.expiresInSeconds) this.armTimer(e, event.expiresInSeconds * 1000 + DEVICE_CODE_MARGIN_MS);
				break;
			case "progress":
				e.session.events.push({ at, type: "progress", message: text(event.message) });
				break;
		}
	}

	private ask(e: Entry, prompt: AuthPrompt): Promise<string> {
		if (!this.isOpen(e)) return Promise.reject(new Error("login is over"));
		const shown: LoginPrompt = {
			type: prompt.type,
			message: text(prompt.message),
			...("placeholder" in prompt && prompt.placeholder ? { placeholder: text(prompt.placeholder) } : {}),
			...(prompt.type === "select" ? { options: prompt.options.map((o) => ({ id: o.id, label: text(o.label), ...(o.description ? { description: text(o.description) } : {}) })) } : {}),
		};
		return new Promise<string>((resolve, reject) => {
			const pending = { prompt: shown, resolve, reject };
			e.pending = pending;
			e.session.state = "prompt";
			e.session.prompt = shown;
			// The flow withdraws a prompt it no longer needs (a callback won the race against a pasted code).
			prompt.signal?.addEventListener(
				"abort",
				() => {
					if (e.pending !== pending) return;
					e.pending = undefined;
					if (this.isOpen(e)) {
						e.session.state = "waiting";
						e.session.prompt = undefined;
					}
					reject(new Error("prompt withdrawn"));
				},
				{ once: true },
			);
		});
	}
}
