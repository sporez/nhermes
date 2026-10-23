// Vory's push relay, as one transport of src/notify/push.ts, kept until the nHermes app's own notifications
// replace it (docs/CLIENT-API.md phase E). Vory can no longer connect to this gateway (the Hermes API it spoke
// is gone), but devices it registered before still get notifications: each one's file under
// `<data dir>/vory/push/devices/` holds its relay URL, install id, secret and payload key. We encrypt each
// notification with that device's key (AES-256-GCM) and post it to the Vory push relay, which forwards it to
// Apple; the relay sees device tokens and ciphertext only. Nothing registers new devices any more.
import { createCipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { logger, redact } from "../log.ts";
import type { PushKind, PushMessage, PushTransport, TurnUsage } from "./push.ts";

const log = logger("vory-push");

const LA_MAX_AGE_S = 8 * 3600;

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

export type VoryRelayOptions = {
	/** Where Vory's device registrations are kept (`<data dir>/vory`). */
	dir: string;
	fetch?: typeof fetch;
	/** How long a finished Live Activity stays in the Island before it is ended. */
	finishIslandMs?: number;
};

/** Vory's names for the kinds (what its app reads in the payload). */
const VORY_KIND: Record<PushKind, string> = { approval: "approval", settled: "settled", turn: "turn", error: "error", cron: "cron", notice: "turn", test: "test" };

export class VoryRelay implements PushTransport {
	readonly name = "vory";
	private readonly o: { dir: string; fetch: typeof fetch; finishIslandMs: number };
	private readonly timers = new Set<NodeJS.Timeout>();

	constructor(opts: VoryRelayOptions) {
		this.o = { dir: opts.dir, finishIslandMs: opts.finishIslandMs ?? 30_000, fetch: opts.fetch ?? ((input, init) => globalThis.fetch(input, init)) };
		mkdirSync(this.o.dir, { recursive: true, mode: 0o700 });
	}

	stop(): void {
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

	// ── sending ─────────────────────────────────────────────────────────────────────────────

	/** Sends to every device (or `only` those); returns the ids of the devices the relay accepted it for. */
	async push(m: PushMessage, only?: ReadonlySet<string>): Promise<Set<string>> {
		const kind = VORY_KIND[m.kind];
		const quiet = m.kind === "settled";
		const category = { approval: "HERMES_APPROVAL", error: "HERMES_ERROR", settled: "HERMES_INFO" }[kind] ?? "HERMES_TURN";
		const interruption = quiet ? "passive" : m.kind === "approval" ? "time-sensitive" : "active";
		// No session_id at all when there is no chat: Vory opens any string it finds there, "" included.
		const meta: Record<string, string> = {
			...(m.sessionId ? { session_id: m.sessionId } : {}),
			...(m.botId ? { profile: m.botId } : {}),
			...(m.approvalId ? { request_id: m.approvalId, ...(m.kind === "approval" ? { card_id: `srq-${m.approvalId}` } : {}) } : {}),
			...(m.text ? { title: m.title, text: redact(m.text) } : {}),
		};
		const reached = new Set<string>();
		await Promise.all(
			this.devices().map(async (d) => {
				if (only && !only.has(d.device_id)) return;
				const alert = {
					title: redact(m.title).slice(0, 120),
					body: redact(m.body),
					category,
					thread_id: m.sessionId ?? "",
					interruption,
					hermes: { kind, ...(d.gateway ? { gateway: d.gateway } : {}), ...(d.connection_id ? { connection_id: d.connection_id } : {}), ...meta },
				};
				const ok = await this.relay(d, {
					push_type: "alert",
					enc: encrypt(d.payload_key!, alert),
					collapse_id: m.collapse?.replace(/^approval-/, "").slice(0, 64),
					thread_id: alert.thread_id,
					interruption,
				});
				if (ok) reached.add(d.device_id);
			}),
		);
		return reached;
	}

	/** A chat's turn ended: its Live Activity switches to Finished (or Failed), then ends a little later. */
	turnEnded(sid: string, phase: "done" | "error", usage: TurnUsage): Promise<void> {
		return this.finishLiveActivities(sid, phase, usage);
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
			if (res.ok) return true;
			log.warn("relay refused", { device: d.device_name ?? d.device_id.slice(0, 12), status: res.status, detail });
		} catch (error) {
			log.warn("relay unreachable", { error: error instanceof Error ? error.message : String(error) });
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

/** AES-256-GCM with the device's key: base64(nonce ‖ ciphertext ‖ tag), as the app's extension opens it. */
export function encrypt(keyB64: string, obj: unknown): string {
	const nonce = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", Buffer.from(keyB64, "base64"), nonce);
	const ct = Buffer.concat([cipher.update(JSON.stringify(obj), "utf8"), cipher.final()]);
	return Buffer.concat([nonce, ct, cipher.getAuthTag()]).toString("base64");
}
