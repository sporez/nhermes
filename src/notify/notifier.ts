// Notifications: a small interface with Pushover as the first transport. Messages are trimmed and never
// carry secrets the logger knows about.
import { logger, redact } from "../log.ts";

const log = logger("notify");

/** `sessionId` and `bot` let a transport that can open a chat (Vory) open the one this is about. */
export type Notification = { title: string; message: string; priority?: -1 | 0 | 1; url?: string; urlTitle?: string; sessionId?: string; bot?: string };

export interface Notifier {
	readonly name: string;
	send(n: Notification): Promise<void>;
}

/** A transport that may have nowhere to send right now (Vory with no device registered). */
export interface OptionalNotifier extends Notifier {
	ready(): boolean;
}

/**
 * Every transport that can deliver right now gets the notification; with none, it is recorded as
 * not sent, as NullNotifier does. `name` is "none" while nothing can deliver.
 */
export class FanoutNotifier implements OptionalNotifier {
	private readonly transports: (Notifier | OptionalNotifier)[];
	private readonly fallback = new NullNotifier();

	constructor(transports: (Notifier | OptionalNotifier)[]) {
		this.transports = transports;
	}

	private active(): Notifier[] {
		return this.transports.filter((t) => !("ready" in t) || t.ready());
	}

	ready(): boolean {
		return this.active().length > 0;
	}

	get name(): string {
		const names = this.active().map((t) => t.name);
		return names.length ? names.join("+") : "none";
	}

	async send(n: Notification): Promise<void> {
		const active = this.active();
		if (active.length === 0) return this.fallback.send(n);
		const results = await Promise.allSettled(active.map((t) => t.send(n)));
		const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
		// One transport delivering is enough; all of them failing is the caller's error.
		if (failed.length === active.length) throw failed[0]!.reason;
		for (const f of failed) log.warn("notification transport failed", { error: String(f.reason).slice(0, 300) });
	}
}

export class NotifyError extends Error {
	override name = "NotifyError";
}

/** https://pushover.net/api — POST /1/messages.json with token, user, title, message. */
export class PushoverNotifier implements Notifier {
	readonly name = "pushover";
	private readonly user: string;
	private readonly token: string;
	private readonly endpoint: string;

	constructor(opts: { user: string; token: string; endpoint?: string }) {
		this.user = opts.user;
		this.token = opts.token;
		this.endpoint = opts.endpoint ?? "https://api.pushover.net/1/messages.json";
	}

	async send(n: Notification): Promise<void> {
		const body = new URLSearchParams({
			token: this.token,
			user: this.user,
			title: redact(n.title).slice(0, 250),
			message: redact(n.message).slice(0, 1024) || "(empty)",
			priority: String(n.priority ?? 0),
		});
		if (n.url) body.set("url", n.url.slice(0, 512));
		if (n.urlTitle) body.set("url_title", n.urlTitle.slice(0, 100));
		const res = await fetch(this.endpoint, { method: "POST", body, signal: AbortSignal.timeout(15_000) });
		if (!res.ok) {
			const detail = await res.text().catch(() => "");
			throw new NotifyError(`Pushover answered ${res.status}: ${redact(detail).slice(0, 300)}`);
		}
		log.info("notification sent", { via: this.name, title: n.title.slice(0, 80) });
	}
}

/** Used when no transport is configured: records instead of sending, and says so. */
export class NullNotifier implements Notifier {
	readonly name = "none";
	readonly sent: Notification[] = [];
	async send(n: Notification): Promise<void> {
		this.sent.push(n);
		log.warn("notification not sent: no transport configured (set PUSHOVER_USER_KEY and PUSHOVER_APP_TOKEN, or set up notifications in Vory)", { title: n.title.slice(0, 80) });
	}
}
