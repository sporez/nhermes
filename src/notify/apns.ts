// Push notifications straight to Apple (APNs), one transport of src/notify/push.ts: token authentication with
// the owner's `.p8` key (config.yaml `push.apns: {keyId, teamId}`, the key itself in secrets.env under
// `keyEnv`, APNS_AUTH_KEY by default), HTTP/2 to Apple's servers for each device's environment. No relay sits
// between: Apple sees the notification's text, as with any direct notification, so known secrets are removed
// first. A token Apple says is gone (410, BadDeviceToken) is removed from the devices.
import { createPrivateKey, type KeyObject, sign } from "node:crypto";
import { connect, type ClientHttp2Session } from "node:http2";
import { logger, redact } from "../log.ts";
import type { ApnsEnvironment, DeviceRow, Devices } from "./devices.ts";
import type { PushKind, PushMessage, PushTransport } from "./push.ts";

const log = logger("apns");

export type ApnsConfig = { keyId: string; teamId: string; keyEnv: string };

export const APNS_HOSTS: Record<ApnsEnvironment, string> = { production: "https://api.push.apple.com", development: "https://api.sandbox.push.apple.com" };

/** A provider token is good for an hour; Apple refuses one refreshed more often than every 20 minutes. */
const TOKEN_TTL_MS = 40 * 60_000;
const MAX_PAYLOAD = 4096;
/** Reasons that mean the token will never work again here. */
const GONE = new Set(["BadDeviceToken", "Unregistered", "DeviceTokenNotForTopic"]);

/** The notification categories the app registers (its actions: Approve once and Deny on an approval). */
export const CATEGORY: Record<PushKind, string> = { approval: "NH_APPROVAL", settled: "NH_INFO", turn: "NH_TURN", error: "NH_ERROR", cron: "NH_TURN", notice: "NH_TURN", test: "NH_INFO" };

export type ApnsOptions = {
	config: ApnsConfig | undefined;
	devices: Devices;
	/** This gateway's id, in each payload, so a client that knows several gateways answers the right one. */
	gatewayId: () => string;
	/** Apple's servers by environment (tests point them at a local server). */
	hosts?: Record<ApnsEnvironment, string>;
};

export class ApnsTransport implements PushTransport {
	readonly name = "apns";
	private readonly o: ApnsOptions & { hosts: Record<ApnsEnvironment, string> };
	private readonly sessions = new Map<string, ClientHttp2Session>();
	private jwt: { value: string; at: number } | undefined;
	private key: { raw: string; key: KeyObject } | undefined;

	constructor(o: ApnsOptions) {
		this.o = { ...o, hosts: o.hosts ?? APNS_HOSTS };
	}

	/** Whether the key is set up (whatever the devices): what the client API's hello announces. */
	configured(): boolean {
		return this.signingKey() !== undefined;
	}

	ready(): boolean {
		return this.configured() && this.o.devices.list().length > 0;
	}

	close(): void {
		for (const s of this.sessions.values()) s.close();
		this.sessions.clear();
	}

	async push(m: PushMessage, only?: ReadonlySet<string>): Promise<Set<string>> {
		const reached = new Set<string>();
		const devices = this.o.devices.list().filter((d) => !only || only.has(d.id));
		await Promise.all(
			devices.map(async (d) => {
				const r = await this.deliver(d, m);
				if (r.ok) reached.add(d.id);
			}),
		);
		return reached;
	}

	/** Sends one notification to one device; answers whether Apple took it, and why not. */
	async deliver(d: DeviceRow, m: PushMessage): Promise<{ ok: boolean; error?: string }> {
		const quiet = m.kind === "settled";
		const payload = {
			aps: {
				alert: { title: redact(m.title).slice(0, 120), body: redact(m.body).slice(0, 1000) },
				...(quiet ? {} : { sound: "default" }),
				category: CATEGORY[m.kind],
				"thread-id": m.sessionId ?? "nhermes",
				"interruption-level": quiet ? "passive" : m.kind === "approval" ? "time-sensitive" : "active",
			},
			nh: {
				kind: m.kind,
				gateway: this.o.gatewayId(),
				...(m.sessionId ? { sessionId: m.sessionId } : {}),
				...(m.botId ? { botId: m.botId } : {}),
				...(m.approvalId ? { approvalId: m.approvalId } : {}),
			},
		};
		let body = JSON.stringify(payload);
		if (Buffer.byteLength(body) > MAX_PAYLOAD) {
			payload.aps.alert.body = payload.aps.alert.body.slice(0, 200);
			body = JSON.stringify(payload);
		}
		const now = Math.floor(Date.now() / 1000);
		const headers: Record<string, string> = {
			":method": "POST",
			":path": `/3/device/${d.token}`,
			"apns-topic": d.bundle_id,
			"apns-push-type": "alert",
			"apns-priority": quiet ? "5" : "10",
			// An approval no one could answer an hour later is not worth showing then.
			"apns-expiration": String(now + (m.kind === "approval" ? 3600 : 86_400)),
			...(m.collapse ? { "apns-collapse-id": m.collapse.slice(0, 64) } : {}),
		};
		for (let attempt = 0; attempt < 2; attempt++) {
			const token = this.providerToken();
			if (!token) return { ok: false, error: "the APNs key is not set up on this gateway" };
			let r: { status: number; reason?: string };
			try {
				r = await this.request(d.environment, { ...headers, authorization: `bearer ${token}` }, body);
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				this.o.devices.failed(d.id, `Apple's servers did not answer: ${msg}`);
				log.warn("apns unreachable", { error: msg });
				return { ok: false, error: `Apple's servers did not answer: ${msg}` };
			}
			if (r.status === 200) {
				this.o.devices.delivered(d.id);
				return { ok: true };
			}
			// A refreshed provider token fixes these; anything else is the device's or the setup's.
			if (r.status === 403 && (r.reason === "ExpiredProviderToken" || r.reason === "InvalidProviderToken") && attempt === 0) {
				this.jwt = undefined;
				continue;
			}
			if (r.status === 410 || (r.reason && GONE.has(r.reason))) {
				this.o.devices.remove(d.id);
				log.info("device removed: Apple no longer takes its token", { device: d.name || d.id, reason: r.reason ?? String(r.status) });
				return { ok: false, error: `Apple no longer takes this device's token (${r.reason ?? r.status}); it was removed` };
			}
			const why = `Apple refused it: ${r.status}${r.reason ? ` ${r.reason}` : ""}`;
			this.o.devices.failed(d.id, why);
			log.warn("apns refused", { device: d.name || d.id, status: r.status, reason: r.reason });
			return { ok: false, error: why };
		}
		return { ok: false, error: "Apple refused the provider token; check push.apns keyId and teamId and the key" };
	}

	private request(env: ApnsEnvironment, headers: Record<string, string>, body: string): Promise<{ status: number; reason?: string }> {
		return new Promise((resolve, reject) => {
			const session = this.session(env);
			const req = session.request(headers);
			req.setTimeout(15_000, () => req.close());
			let status = 0;
			let data = "";
			req.on("response", (h) => (status = Number(h[":status"] ?? 0)));
			req.setEncoding("utf8");
			req.on("data", (c: string) => (data += c));
			req.on("end", () => {
				let reason: string | undefined;
				try {
					reason = data ? (JSON.parse(data) as { reason?: string }).reason : undefined;
				} catch {
					// a body that is not JSON has no reason to report
				}
				if (status === 0) return reject(new Error("no answer"));
				resolve({ status, ...(reason ? { reason } : {}) });
			});
			req.on("error", reject);
			req.end(body);
		});
	}

	private session(env: ApnsEnvironment): ClientHttp2Session {
		const origin = this.o.hosts[env];
		const open = this.sessions.get(origin);
		if (open && !open.closed && !open.destroyed) return open;
		const s = connect(origin);
		s.on("error", (error) => log.debug("apns connection closed", { error: error.message }));
		const drop = () => this.sessions.get(origin) === s && this.sessions.delete(origin);
		s.on("close", drop);
		s.on("goaway", drop);
		// An idle connection must not keep the process alive.
		s.unref();
		this.sessions.set(origin, s);
		return s;
	}

	private signingKey(): KeyObject | undefined {
		const c = this.o.config;
		const raw = c ? process.env[c.keyEnv]?.trim() : undefined;
		if (!c || !raw) return undefined;
		if (this.key?.raw === raw) return this.key.key;
		try {
			this.key = { raw, key: parseKey(raw) };
			this.jwt = undefined;
			return this.key.key;
		} catch (error) {
			log.warn(`the APNs key in ${c.keyEnv} could not be read`, { error: error instanceof Error ? error.message : String(error) });
			return undefined;
		}
	}

	/** The ES256 provider token Apple's servers take, made again every 40 minutes. */
	private providerToken(): string | undefined {
		const key = this.signingKey();
		const c = this.o.config;
		if (!key || !c) return undefined;
		if (this.jwt && Date.now() - this.jwt.at < TOKEN_TTL_MS) return this.jwt.value;
		const part = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
		const input = `${part({ alg: "ES256", kid: c.keyId })}.${part({ iss: c.teamId, iat: Math.floor(Date.now() / 1000) })}`;
		const signature = sign("sha256", Buffer.from(input), { key, dsaEncoding: "ieee-p1363" }).toString("base64url");
		this.jwt = { value: `${input}.${signature}`, at: Date.now() };
		return this.jwt.value;
	}
}

/** The `.p8` key as secrets.env holds it: its text (newlines as `\n`), or the file base64-encoded. */
export function parseKey(raw: string): KeyObject {
	const text = raw.includes("BEGIN") ? raw.replace(/\\n/g, "\n") : Buffer.from(raw, "base64").toString("utf8");
	if (text.includes("BEGIN")) return createPrivateKey(text);
	return createPrivateKey({ key: Buffer.from(raw, "base64"), format: "der", type: "pkcs8" });
}
