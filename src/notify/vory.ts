// Vory's own notifications, sent the way its Companion plugin sends them (vory/server/hermes-push), so
// the stock app needs nothing but this gateway. The app registers each device with the Vory push
// relay and writes a device file (relay URL, install id, secret, payload key) under
// `<bot home>/push/devices/` through the files API; we encrypt each notification with that device's
// key (AES-256-GCM) and post it to the relay, which forwards it to Apple. The relay sees device
// tokens and ciphertext only.
//
// The Companion's files live in one store under the data dir, whichever bot's home the app names:
// they hold relay secrets, so they stay out of bot workspaces. Installing the Companion from Vory
// uploads its plugin files here; they are kept (so the app sees the version it ships) and never run.
// The heartbeat Vory reads (`push/status.json`) is made up on each read.
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Bots } from "../core/bots.ts";
import type { Hub, SessionEvent } from "../core/events.ts";
import type { Sessions } from "../core/sessions.ts";
import { srqId } from "../hermes/shapes.ts";
import { logger, redact } from "../log.ts";
import type { Notification, OptionalNotifier } from "./notifier.ts";

const log = logger("vory-push");

/** Files Vory reads and writes for its Companion, relative to a bot's home. */
const ALLOWED = [
	/^push\/(devices|answers|origins|goals)\/[A-Za-z0-9._-]+\.json$/,
	/^push\/(hermes-push\.conf|hermes_push\.py|install\.sh|test-request\.json|status\.json)$/,
	/^plugins\/vory-push\/(plugin\.yaml|hermes_push\.py|__init__\.py)$/,
];
/** Folders the app may remove whole (uninstall). */
const REMOVABLE_DIRS = new Set(["push", "plugins/vory-push"]);
const MAX_FILE = 512 * 1024;
/** What the heartbeat reports before the app has installed a Companion: new enough that the app
 * expects files to be picked up in place (1.0.12+), so it never asks for a gateway restart. */
const BASE_VERSION = "1.0.12";
const LA_MAX_AGE_S = 8 * 3600;
const ORIGIN_WINDOW_S = 12 * 3600;
const MARKER_TTL_S = 12 * 3600;

type Kind = "approval" | "clarify" | "turn" | "cron" | "error" | "settled" | "test";

type Device = {
	device_id: string;
	platform: string;
	apns_token?: string;
	registered_at?: string;
	gateway?: string;
	connection_id?: string;
	device_name?: string;
	mute_desktop_origin?: boolean;
	payload_key?: string;
	relay?: { url?: string; install_id?: string; secret?: string };
	live_activity_token?: string;
	live_activity_started_at?: number;
	live_activity_session_id?: string;
	live_activities?: { session_id?: string; token?: string; started_at?: number }[];
};

type Open = { sessionId: string; bot: string; title: string; reached: Set<string> };

export class VoryPushError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

export type VoryPushOptions = {
	/** Where the Companion's files are kept (`<data dir>/vory`). */
	dir: string;
	hub: Hub;
	bots: Bots;
	sessions: () => Sessions | undefined;
	fetch?: typeof fetch;
	/** How long after an approval is answered its banners are replaced (the answering device's marker lands first). */
	settleDelayMs?: number;
	/** How long a finished Live Activity stays in the Island before it is ended. */
	finishIslandMs?: number;
};

export class VoryPush implements OptionalNotifier {
	readonly name = "vory";
	private readonly o: Required<Omit<VoryPushOptions, "fetch">> & { fetch: typeof fetch };
	private readonly open = new Map<string, Open>();
	private readonly timers = new Set<NodeJS.Timeout>();
	private lastTest: Record<string, unknown> = {};
	private lastError: string | null = null;
	private off?: () => void;

	constructor(opts: VoryPushOptions) {
		// Options left undefined (no test override) keep the defaults rather than replacing them.
		this.o = {
			...opts,
			settleDelayMs: opts.settleDelayMs ?? 2500,
			finishIslandMs: opts.finishIslandMs ?? 30_000,
			fetch: opts.fetch ?? ((input, init) => globalThis.fetch(input, init)),
		};
		mkdirSync(this.o.dir, { recursive: true, mode: 0o700 });
	}

	start(): void {
		this.off ??= this.o.hub.subscribeAll((sid, e) => this.onEvent(sid, e));
	}

	stop(): void {
		this.off?.();
		this.off = undefined;
		for (const t of this.timers) clearTimeout(t);
		this.timers.clear();
	}

	// ── the files API Vory uses ─────────────────────────────────────────────────────────────

	/** A path the app sent, as a path in the store; undefined when it is not one of the Companion's. */
	private rel(path: string, dirsOk = false): string | undefined {
		const p = resolve(path);
		for (const bot of this.o.bots.list()) {
			if (bot.remote || bot.isPeer || !bot.workspace) continue;
			const home = resolve(bot.workspace);
			if (!p.startsWith(home + "/")) continue;
			const rel = p.slice(home.length + 1);
			if (ALLOWED.some((re) => re.test(rel)) || (dirsOk && REMOVABLE_DIRS.has(rel))) return rel;
		}
		return undefined;
	}

	read(path: string): Buffer | undefined {
		const rel = this.rel(path);
		if (!rel) return undefined;
		if (rel === "push/status.json") return Buffer.from(JSON.stringify(this.heartbeat()));
		const file = join(this.o.dir, rel);
		return existsSync(file) ? readFileSync(file) : undefined;
	}

	write(path: string, data: Buffer): void {
		const rel = this.rel(path);
		if (!rel) throw new VoryPushError(403, "This gateway keeps only Vory's notification files");
		if (data.length > MAX_FILE) throw new VoryPushError(413, "File too large");
		if (rel === "push/status.json") throw new VoryPushError(403, "status.json is written by the gateway");
		if (rel === "push/test-request.json") {
			// Answered at once rather than kept: the Companion looks for this file every few seconds.
			let nonce = "";
			try {
				nonce = String((JSON.parse(data.toString("utf8")) as { nonce?: unknown }).nonce ?? "");
			} catch {
				// a request without a nonce still gets its test
			}
			void this.sendTest(nonce || randomBytes(8).toString("hex"));
			return;
		}
		const file = join(this.o.dir, rel);
		mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
		writeFileSync(file, data, { mode: 0o600 });
		if (/^push\/(answers|origins|goals)\//.test(rel)) this.prune(dirname(file));
		if (rel.startsWith("push/devices/")) log.info("device registered", { device: rel.slice(13, 25) });
		if (rel === "plugins/vory-push/plugin.yaml") log.info("Vory notifications installed", { version: this.installedVersion() });
	}

	remove(path: string, recursive: boolean): void {
		const rel = this.rel(path, recursive);
		if (!rel) throw new VoryPushError(403, "This gateway keeps only Vory's notification files");
		rmSync(join(this.o.dir, rel), { recursive, force: true });
		if (rel === "push/test-request.json") return;
		log.info("removed", { path: rel });
	}

	/** Vory's "enable plugin": the files are already in place, and nothing needs loading. */
	enable(): { ok: boolean; error?: string } {
		if (!this.installedVersion()) return { ok: false, error: "Install the Vory Companion from the app first." };
		return { ok: true };
	}

	/** Vory's "disable plugin" (its uninstall): no Companion, so nothing more is sent. */
	disable(): { ok: boolean } {
		rmSync(join(this.o.dir, "plugins", "vory-push"), { recursive: true, force: true });
		log.info("Vory notifications disabled");
		return { ok: true };
	}

	installedVersion(): string | undefined {
		const file = join(this.o.dir, "plugins", "vory-push", "plugin.yaml");
		if (!existsSync(file)) return undefined;
		return /version:\s*"?([^"\n]+)"?/.exec(readFileSync(file, "utf8"))?.[1]?.trim() ?? "?";
	}

	/** What Vory reads as the Companion's heartbeat: always fresh, since this process is the Companion. */
	heartbeat(): Record<string, unknown> {
		const script = join(this.o.dir, "plugins", "vory-push", "hermes_push.py");
		const sha = existsSync(script) ? createHash("sha256").update(readFileSync(script)).digest("hex") : undefined;
		return {
			version: this.installedVersion() ?? BASE_VERSION,
			...(sha ? { script_sha256: sha } : {}),
			pid: process.pid,
			profile: "default",
			updated_at: Date.now() / 1000,
			connected: true,
			transport: "nhermes",
			attached: 0,
			devices: this.devices().length,
			...(this.lastError ? { error: this.lastError } : {}),
			...this.lastTest,
		};
	}

	// ── devices ─────────────────────────────────────────────────────────────────────────────

	/** Registered devices that can be reached through the relay, newest registration per token. */
	devices(): Device[] {
		const dir = join(this.o.dir, "push", "devices");
		if (!existsSync(dir)) return [];
		const rows: { d: Device; at: string; mtime: number }[] = [];
		for (const f of readdirSync(dir)) {
			if (!f.endsWith(".json")) continue;
			try {
				const file = join(dir, f);
				const d = JSON.parse(readFileSync(file, "utf8")) as Device;
				if (!["ios", "macos"].includes(d.platform) || !d.payload_key || !d.relay?.install_id || !d.relay.secret) continue;
				if (!/^https:\/\//.test(d.relay.url ?? "")) continue;
				rows.push({ d, at: d.registered_at ?? "", mtime: statSync(file).mtimeMs });
			} catch {
				// a half-written or foreign file is not a device
			}
		}
		rows.sort((a, b) => (a.at === b.at ? b.mtime - a.mtime : a.at < b.at ? 1 : -1));
		const seen = new Set<string>();
		return rows
			.filter(({ d }) => {
				const key = `${d.platform}:${d.apns_token ?? d.device_id}`;
				if (seen.has(key)) return false;
				seen.add(key);
				return true;
			})
			.map((r) => r.d);
	}

	/** Sends only once the Companion is installed from Vory and a device has registered. */
	ready(): boolean {
		return this.installedVersion() !== undefined && this.devices().length > 0;
	}

	// ── Notifier: scheduled tasks and the notify tool ───────────────────────────────────────

	async send(n: Notification): Promise<void> {
		const row = n.sessionId ? this.o.sessions()?.get(n.sessionId) : undefined;
		const botName = n.bot ?? row?.bot;
		const bot = botName ? (this.o.bots.get(botName)?.displayName ?? botName) : undefined;
		const kind: Kind = n.priority === 1 ? "error" : row?.kind === "job" ? "cron" : "turn";
		const reached = await this.pushAll(kind, bot ? `${bot} · ${n.title}` : n.title, n.message.slice(0, 300), {
			session_id: n.sessionId ?? "",
			...(botName ? { profile: botName } : {}),
			title: n.title,
			text: n.message.slice(0, 1200),
		});
		if (reached.size === 0) throw new Error(this.lastError ?? "no Vory device accepted the notification");
	}

	// ── events ──────────────────────────────────────────────────────────────────────────────

	private onEvent(sid: string, e: SessionEvent): void {
		if (e.type !== "approval.requested" && e.type !== "approval.resolved" && e.type !== "run.finished") return;
		if (!this.installedVersion()) return;
		const run = async () => {
			if (e.type === "approval.requested") await this.approvalRequested(e.request);
			else if (e.type === "approval.resolved") this.later(this.o.settleDelayMs, () => this.settle(e.requestId, e.reason));
			else await this.turnFinished(sid, e);
		};
		run().catch((error) => log.warn("push failed", { error: String(error).slice(0, 300) }));
	}

	private about(sessionId: string, fallbackBot = "") {
		const row = this.o.sessions()?.get(sessionId);
		const name = row?.bot ?? fallbackBot;
		return { row, profile: name, bot: this.o.bots.get(name)?.displayName ?? (name || "nHermes"), title: row?.title || "New chat" };
	}

	private async approvalRequested(r: Extract<SessionEvent, { type: "approval.requested" }>["request"]): Promise<void> {
		const { profile, bot, title } = this.about(r.sessionId, r.bot);
		const what = r.description || r.command || "A command is waiting for your decision";
		const reached = await this.pushAll(
			"approval",
			`${bot} · approval needed`,
			`${title}: ${what.slice(0, 180)}`,
			{ session_id: r.sessionId, profile, request_id: r.requestId, card_id: srqId(r.requestId) },
			{ collapse: r.requestId },
		);
		this.open.set(r.requestId, { sessionId: r.sessionId, bot, title, reached });
	}

	/** The approval is no longer waiting: its banner is replaced, quietly, on every device but the one that answered. */
	private async settle(requestId: string, reason: "answered" | "timeout" | "cancelled"): Promise<void> {
		const o = this.open.get(requestId);
		if (!o) return;
		this.open.delete(requestId);
		const by = this.answeredBy(requestId, srqId(requestId));
		const targets = new Set([...o.reached].filter((d) => d !== by));
		if (targets.size === 0) return;
		const answered = reason === "answered";
		await this.pushAll(
			"settled",
			answered ? `${o.bot} · approval answered` : o.bot,
			answered ? `${o.title}: answered on another device.` : `${o.title}: no longer waiting for an answer.`,
			{ session_id: o.sessionId, profile: this.about(o.sessionId).profile, request_id: requestId },
			{ collapse: requestId, only: targets },
		);
	}

	private async turnFinished(sid: string, e: Extract<SessionEvent, { type: "run.finished" }>): Promise<void> {
		const { row, profile, bot, title } = this.about(sid);
		// Jobs notify through the scheduler (their own notify policy); delegations answer in their parent chat.
		if (!row || row.kind !== "chat") return;
		const failed = e.status === "error";
		await this.finishLiveActivities(sid, failed ? "error" : "done", e.usage);
		if (e.status === "interrupted") return;
		if (failed) {
			const err = e.error || "The turn failed.";
			await this.pushAll("error", `${bot} · turn failed`, `${title}: ${err.slice(0, 300)}`, { session_id: sid, profile, title, text: err.slice(0, 1200) }, { collapse: `turn-${sid}` });
			return;
		}
		const text = e.text.trim() || "Done";
		await this.pushAll("turn", bot, `${title}: ${text.slice(0, 300)}`, { session_id: sid, profile, title, text: text.slice(0, 1200) }, { collapse: `turn-${sid}` });
	}

	private async sendTest(nonce: string): Promise<void> {
		const reached = await this.pushAll("test", "Vory", "Test notification from your gateway ✓", { nonce, session_id: "" }, { collapse: "vory-test" });
		this.lastTest = { last_test_nonce: nonce, last_test_devices: reached.size, last_test_at: Date.now() / 1000, last_test_detail: this.lastError ?? "relay 200" };
		log.info("test notification sent", { devices: reached.size });
	}

	// ── sending ─────────────────────────────────────────────────────────────────────────────

	/** Sends to every device (or `only` those); returns the ids of the devices the relay accepted it for. */
	private async pushAll(kind: Kind, title: string, body: string, meta: Record<string, string>, opts: { collapse?: string; only?: Set<string> } = {}): Promise<Set<string>> {
		const quiet = kind === "settled";
		const category = { approval: "HERMES_APPROVAL", clarify: "HERMES_CLARIFY", error: "HERMES_ERROR", settled: "HERMES_INFO" }[kind as string] ?? "HERMES_TURN";
		const interruption = quiet ? "passive" : kind === "approval" || kind === "clarify" ? "time-sensitive" : "active";
		const fromMac = meta.session_id ? this.origin(meta.session_id)?.platform === "macos" : false;
		const reached = new Set<string>();
		await Promise.all(
			this.devices().map(async (d) => {
				if (opts.only && !opts.only.has(d.device_id)) return;
				// A phone that asked for quiet while a Mac drives the chat (Settings › Notifications).
				if (fromMac && d.platform === "ios" && d.mute_desktop_origin && !quiet) return;
				const alert = {
					title: redact(title).slice(0, 120),
					body: redact(body),
					category,
					thread_id: meta.session_id ?? "",
					interruption,
					hermes: {
						kind,
						...(d.gateway ? { gateway: d.gateway } : {}),
						...(d.connection_id ? { connection_id: d.connection_id } : {}),
						...Object.fromEntries(Object.entries(meta).map(([k, v]) => [k, k === "text" ? redact(v) : v])),
					},
				};
				const ok = await this.relay(d, {
					push_type: "alert",
					enc: encrypt(d.payload_key!, alert),
					collapse_id: opts.collapse?.slice(0, 64),
					thread_id: alert.thread_id,
					interruption,
				});
				if (ok) reached.add(d.device_id);
			}),
		);
		if (reached.size > 0) log.info("push sent", { kind, devices: reached.size });
		return reached;
	}

	/** The finished turn's Live Activity: switched to Finished (or Failed), then ended a little later. */
	private async finishLiveActivities(sid: string, phase: "done" | "error", usage: { output: number; contextUsed: number; contextMax: number }): Promise<void> {
		const now = Math.floor(Date.now() / 1000);
		for (const d of this.devices()) {
			if (d.platform !== "ios") continue;
			const entries = Array.isArray(d.live_activities)
				? d.live_activities
				: d.live_activity_token
					? [{ session_id: d.live_activity_session_id, token: d.live_activity_token, started_at: d.live_activity_started_at }]
					: [];
			for (const a of entries) {
				if (!a?.token || (a.session_id && a.session_id !== sid)) continue;
				if (now - Number(a.started_at ?? 0) > LA_MAX_AGE_S) continue;
				const state = {
					phase,
					detail: phase === "done" ? "Turn finished" : "The turn failed",
					outputTokens: usage.output || 0,
					contextPercent: usage.contextMax ? Math.round((usage.contextUsed / usage.contextMax) * 100) : null,
					contextUsed: usage.contextUsed || null,
					contextMax: usage.contextMax || null,
					needsAttention: false,
					startedAtUnix: Number(a.started_at ?? now),
					endedAtUnix: now,
				};
				const ok = await this.relay(d, { push_type: "liveactivity", token: a.token, content_state: state, event: "update" });
				if (!ok) continue;
				// Ending at once would take it out of the Island before it is seen; it lingers on the Lock Screen a minute.
				this.later(this.o.finishIslandMs, () =>
					this.relay(d, { push_type: "liveactivity", token: a.token, content_state: state, event: "end", dismissal_date: Math.floor(Date.now() / 1000) + 60 }).then(() => undefined),
				);
			}
		}
	}

	private async relay(d: Device, body: Record<string, unknown>): Promise<boolean> {
		const url = d.relay!.url!.replace(/\/+$/, "") + "/v1/push";
		try {
			const res = await this.o.fetch(url, {
				method: "POST",
				headers: { "content-type": "application/json", "user-agent": "nhermes-vory-push" },
				body: JSON.stringify({ install_id: d.relay!.install_id, secret: d.relay!.secret, ...body }),
				signal: AbortSignal.timeout(20_000),
			});
			if (res.ok) {
				this.lastError = null;
				return true;
			}
			const detail = (await res.text().catch(() => "")).slice(0, 200);
			this.lastError = `relay ${res.status}: ${detail}`;
			log.warn("relay refused", { device: d.device_name ?? d.device_id.slice(0, 12), status: res.status, detail });
		} catch (error) {
			this.lastError = `relay unreachable: ${error instanceof Error ? error.message : String(error)}`;
			log.warn("relay unreachable", { error: this.lastError });
		}
		return false;
	}

	// ── markers the app writes ──────────────────────────────────────────────────────────────

	private marker(dir: string, id: string): Record<string, unknown> | undefined {
		const file = join(this.o.dir, "push", dir, `${id.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
		try {
			const m = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
			return Date.now() / 1000 - Number(m.at ?? 0) < MARKER_TTL_S ? m : undefined;
		} catch {
			return undefined;
		}
	}

	private answeredBy(...ids: string[]): string | undefined {
		for (const id of ids) {
			const by = this.marker("answers", id)?.device_id;
			if (typeof by === "string" && by) return by;
		}
		return undefined;
	}

	/** Which device prompted the chat last, within the window the app means it for. */
	private origin(sessionId: string): { platform?: string } | undefined {
		const m = this.marker("origins", sessionId);
		return m && Date.now() / 1000 - Number(m.at ?? 0) < ORIGIN_WINDOW_S ? (m as { platform?: string }) : undefined;
	}

	private prune(dir: string): void {
		const now = Date.now();
		for (const f of readdirSync(dir)) {
			try {
				if (now - statSync(join(dir, f)).mtimeMs > MARKER_TTL_S * 1000) unlinkSync(join(dir, f));
			} catch {
				// gone already
			}
		}
	}

	private later(ms: number, fn: () => Promise<void>): void {
		const t = setTimeout(() => {
			this.timers.delete(t);
			fn().catch((error) => log.warn("push failed", { error: String(error).slice(0, 300) }));
		}, ms);
		t.unref?.();
		this.timers.add(t);
	}
}

/** AES-256-GCM with the device's key: base64(nonce ‖ ciphertext ‖ tag), as the app's extension opens it. */
export function encrypt(keyB64: string, obj: unknown): string {
	const nonce = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", Buffer.from(keyB64, "base64"), nonce);
	const ct = Buffer.concat([cipher.update(JSON.stringify(obj), "utf8"), cipher.final()]);
	return Buffer.concat([nonce, ct, cipher.getAuthTag()]).toString("base64");
}
