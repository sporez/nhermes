// Vory's own notifications, kept until the nHermes app has its own (docs/CLIENT-API.md phase E). Vory can no
// longer connect to this gateway (the Hermes API it spoke is gone), but devices it registered before still get
// notifications: each one's file under `<data dir>/vory/push/devices/` holds its relay URL, install id, secret
// and payload key. We encrypt each notification with that device's key (AES-256-GCM) and post it to the Vory
// push relay, which forwards it to Apple; the relay sees device tokens and ciphertext only. Nothing registers
// new devices any more.
import { createCipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Bots } from "../core/bots.ts";
import type { Hub, SessionEvent } from "../core/events.ts";
import type { SessionRow, Sessions } from "../core/sessions.ts";
import { logger, redact } from "../log.ts";
import type { Notification, OptionalNotifier } from "./notifier.ts";

const log = logger("vory-push");

const LA_MAX_AGE_S = 8 * 3600;

type Kind = "approval" | "clarify" | "turn" | "cron" | "error" | "settled" | "test";

type Device = {
	device_id: string;
	platform: string;
	apns_token?: string;
	registered_at?: string;
	gateway?: string;
	connection_id?: string;
	device_name?: string;
	payload_key?: string;
	relay?: { url?: string; install_id?: string; secret?: string };
	live_activity_token?: string;
	live_activity_started_at?: number;
	live_activity_session_id?: string;
	live_activities?: { session_id?: string; token?: string; started_at?: number }[];
};

type Open = { sessionId: string; bot: string; title: string; reached: Set<string> };

export type VoryPushOptions = {
	/** Where Vory's device registrations are kept (`<data dir>/vory`). */
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
	private lastError: string | null = null;
	/** What the relay answered last (it passes on Apple's status), for the app's test diagnostics. */
	private lastResponse = "";
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

	/** Sends only while Vory's notifications were set up (its Companion installed) and a device is registered. */
	ready(): boolean {
		return this.installedVersion() !== undefined && this.devices().length > 0;
	}

	private installedVersion(): string | undefined {
		const file = join(this.o.dir, "plugins", "vory-push", "plugin.yaml");
		if (!existsSync(file)) return undefined;
		return /version:\s*"?([^"\n]+)"?/.exec(readFileSync(file, "utf8"))?.[1]?.trim() ?? "?";
	}

	// ── Notifier: scheduled tasks and the notify tool ───────────────────────────────────────

	async send(n: Notification): Promise<void> {
		const row = n.sessionId ? this.o.sessions()?.get(n.sessionId) : undefined;
		const botName = n.bot ?? row?.bot;
		const bot = botName ? (this.o.bots.get(botName)?.displayName ?? botName) : undefined;
		const kind: Kind = n.priority === 1 ? "error" : row?.kind === "job" ? "cron" : "turn";
		// No session_id at all when there is no chat: Vory opens any string it finds there, "" included,
		// and an empty id fails as "session_id is required" (OpenChamber alerts, forwarded notifications).
		const reached = await this.pushAll(kind, bot ? `${bot} · ${n.title}` : n.title, n.message.slice(0, 300), {
			...(n.sessionId ? { session_id: n.sessionId } : {}),
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
		const { row, profile, bot, title } = this.about(r.sessionId, r.bot);
		if (drivenElsewhere(row)) return;
		const what = r.description || r.command || "A command is waiting for your decision";
		const reached = await this.pushAll(
			"approval",
			`${bot} · approval needed`,
			`${title}: ${what.slice(0, 180)}`,
			{ session_id: r.sessionId, profile, request_id: r.requestId, card_id: `srq-${r.requestId}` },
			{ collapse: r.requestId },
		);
		this.open.set(r.requestId, { sessionId: r.sessionId, bot, title, reached });
	}

	/** The approval is no longer waiting: its banner is replaced, quietly, on every device it reached. */
	private async settle(requestId: string, reason: "answered" | "timeout" | "cancelled"): Promise<void> {
		const o = this.open.get(requestId);
		if (!o) return;
		this.open.delete(requestId);
		const targets = o.reached;
		if (targets.size === 0) return;
		const answered = reason === "answered";
		await this.pushAll(
			"settled",
			answered ? `${o.bot} · approval answered` : o.bot,
			answered ? `${o.title}: answered.` : `${o.title}: no longer waiting for an answer.`,
			{ session_id: o.sessionId, profile: this.about(o.sessionId).profile, request_id: requestId },
			{ collapse: requestId, only: targets },
		);
	}

	/**
	 * A turn of a member's bot finished, in a chat this gateway runs for its client (src/federation/chats.ts).
	 * The member does not notify for it; this gateway does, as for its own bots.
	 */
	remoteFinished(sid: string, p: Record<string, unknown>): void {
		if (!this.installedVersion()) return;
		const u = (p.usage ?? {}) as Record<string, unknown>;
		const n = (v: unknown) => (typeof v === "number" ? v : 0);
		const status = p.status === "error" || p.status === "interrupted" ? p.status : "complete";
		const usage = { output: n(u.output), contextUsed: n(u.context_used), contextMax: n(u.context_max) };
		this.turnFinished(sid, { text: typeof p.text === "string" ? p.text : "", status, error: typeof p.error === "string" ? p.error : undefined, usage }).catch((error) =>
			log.warn("push failed", { error: String(error).slice(0, 300) }),
		);
	}

	private async turnFinished(sid: string, e: { text: string; status: string; error?: string; usage: { output: number; contextUsed: number; contextMax: number } }): Promise<void> {
		const { row, profile, bot, title } = this.about(sid);
		// Jobs notify through the scheduler (their own notify policy); delegations answer in their parent chat.
		if (!row || row.kind !== "chat" || drivenElsewhere(row)) return;
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

	// ── sending ─────────────────────────────────────────────────────────────────────────────

	/** Sends to every device (or `only` those); returns the ids of the devices the relay accepted it for. */
	private async pushAll(kind: Kind, title: string, body: string, meta: Record<string, string>, opts: { collapse?: string; only?: Set<string> } = {}): Promise<Set<string>> {
		const quiet = kind === "settled";
		const category = { approval: "HERMES_APPROVAL", clarify: "HERMES_CLARIFY", error: "HERMES_ERROR", settled: "HERMES_INFO" }[kind as string] ?? "HERMES_TURN";
		const interruption = quiet ? "passive" : kind === "approval" || kind === "clarify" ? "time-sensitive" : "active";
		const reached = new Set<string>();
		await Promise.all(
			this.devices().map(async (d) => {
				if (opts.only && !opts.only.has(d.device_id)) return;
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
			const detail = (await res.text().catch(() => "")).slice(0, 200);
			this.lastResponse = `relay ${res.status}: ${detail.slice(0, 160)}`;
			if (res.ok) {
				this.lastError = null;
				return true;
			}
			this.lastError = `relay ${res.status}: ${detail}`;
			log.warn("relay refused", { device: d.device_name ?? d.device_id.slice(0, 12), status: res.status, detail });
		} catch (error) {
			this.lastError = this.lastResponse = `relay unreachable: ${error instanceof Error ? error.message : String(error)}`;
			log.warn("relay unreachable", { error: this.lastError });
		}
		return false;
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

/**
 * A chat another gateway in the network started here (its client chats with our bot through it, or one
 * of its bots delegated to ours). That gateway notifies for it, so a phone registered on both gets
 * each notification once.
 */
function drivenElsewhere(row: SessionRow | undefined): boolean {
	return row?.source.startsWith("member:") ?? false;
}

/** AES-256-GCM with the device's key: base64(nonce ‖ ciphertext ‖ tag), as the app's extension opens it. */
export function encrypt(keyB64: string, obj: unknown): string {
	const nonce = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", Buffer.from(keyB64, "base64"), nonce);
	const ct = Buffer.concat([cipher.update(JSON.stringify(obj), "utf8"), cipher.final()]);
	return Buffer.concat([nonce, ct, cipher.getAuthTag()]).toString("base64");
}
