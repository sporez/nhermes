// Watches OpenChamber's event stream and tells the owner when a thread needs them or is done: a new
// permission request, a new question, or a top-level thread that finished or failed. One SSE
// subscription for the whole gateway; the token is re-read on every (re)connect, and a Mac without
// OpenChamber running just retries quietly with a growing delay.
import type { Notifier } from "../notify/notifier.ts";
import { logger, redact } from "../log.ts";
import { clip, OpenChamber, type SessionInfo } from "./client.ts";
import type { BotConfig } from "../config.ts";

const log = logger("openchamber");

export type WatcherOptions = {
	/** The `openchamber:` config of every bot; the first with `watch: true` decides the address. */
	configs: () => (NonNullable<BotConfig["openchamber"]> | undefined)[];
	notifier: () => Notifier;
	settingsPath?: string;
	/** One notification per thread per kind inside this window. */
	debounceMs?: number;
	retryMinMs?: number;
	retryMaxMs?: number;
};

type Evt = { type?: string; data?: Record<string, unknown> };

export class OpenChamberWatcher {
	private readonly o: WatcherOptions;
	private abort?: AbortController;
	private loop?: Promise<void>;
	private readonly titles = new Map<string, SessionInfo>();
	private readonly lastSent = new Map<string, number>();

	constructor(o: WatcherOptions) {
		this.o = o;
	}

	private config(): NonNullable<BotConfig["openchamber"]> | undefined {
		return this.o.configs().find((c) => c?.watch);
	}

	/** Starts the subscription if some bot asks for it; a no-op otherwise. */
	start(): void {
		if (this.loop || !this.config()) return;
		this.abort = new AbortController();
		this.loop = this.run(this.abort.signal);
	}

	async stop(): Promise<void> {
		this.abort?.abort();
		await this.loop;
		this.loop = undefined;
	}

	private async run(signal: AbortSignal): Promise<void> {
		const min = this.o.retryMinMs ?? 2_000;
		const max = this.o.retryMaxMs ?? 60_000;
		let delay = min;
		let lastError = "";
		while (!signal.aborted) {
			try {
				const connected = await this.connect(signal);
				if (connected) delay = min;
				lastError = "";
			} catch (error) {
				if (signal.aborted) break;
				const msg = redact(String((error as Error).message ?? error));
				// Said once per outage, so an OpenChamber that is simply closed leaves one line.
				if (msg !== lastError) log.info("OpenChamber event stream unavailable, retrying", { error: msg.slice(0, 200) });
				lastError = msg;
			}
			if (signal.aborted) break;
			await new Promise<void>((r) => {
				const t = setTimeout(r, delay);
				signal.addEventListener("abort", () => (clearTimeout(t), r()), { once: true });
			});
			delay = Math.min(delay * 2, max);
		}
	}

	/** One subscription until it ends; true once the server said hello. */
	private async connect(signal: AbortSignal): Promise<boolean> {
		const cfg = this.config();
		if (!cfg) return false;
		const oc = new OpenChamber({ config: cfg, settingsPath: this.o.settingsPath });
		const { base, token } = oc.resolve();
		let res: Response;
		try {
			res = await fetch(`${base}/api/event`, { signal, headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" } });
		} catch (error) {
			if (signal.aborted) throw error;
			throw new Error("OpenChamber is not running or not reachable");
		}
		if (!res.ok || !res.body) throw new Error(`OpenChamber answered ${res.status} to the event stream`);
		log.info("watching OpenChamber events");
		const decoder = new TextDecoder();
		let buf = "";
		try {
			for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
				buf += decoder.decode(chunk, { stream: true });
				let i: number;
				while ((i = buf.search(/\r?\n\r?\n/)) >= 0) {
					const block = buf.slice(0, i);
					buf = buf.slice(i).replace(/^\r?\n\r?\n/, "");
					const data = block.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).replace(/^ /, "")).join("\n");
					if (!data) continue;
					let evt: Evt;
					try {
						evt = JSON.parse(data);
					} catch {
						continue;
					}
					await this.handle(oc, evt).catch((error) => log.warn("OpenChamber event not handled", { type: evt.type, error: redact(String(error)).slice(0, 200) }));
				}
			}
		} catch (error) {
			if (signal.aborted) throw error;
		}
		return true;
	}

	private async session(oc: OpenChamber, id: string): Promise<SessionInfo | undefined> {
		const known = this.titles.get(id);
		if (known) return known;
		try {
			const s = (await oc.get<{ data: SessionInfo }>(`/api/session/${id}`)).data;
			this.titles.set(id, s);
			return s;
		} catch {
			return undefined;
		}
	}

	private async handle(oc: OpenChamber, evt: Evt): Promise<void> {
		const d = evt.data ?? {};
		const sessionID = typeof d.sessionID === "string" ? d.sessionID : typeof (d.form as { sessionID?: string } | undefined)?.sessionID === "string" ? (d.form as { sessionID: string }).sessionID : undefined;
		if (!sessionID) return;
		let kind: string;
		let line: (title: string) => string;
		switch (evt.type) {
			case "permission.asked": {
				const action = typeof d.action === "string" ? d.action : "do something";
				const res = Array.isArray(d.resources) ? (d.resources as unknown[]).filter((x): x is string => typeof x === "string").join(", ") : "";
				kind = "permission";
				line = (t) => `${t} wants to ${action}${res ? ` on ${clip(res, 200)}` : ""}`;
				break;
			}
			case "form.created": {
				// The form's own title is often just "Questions"; its fields carry the actual questions.
				const f = d.form as { title?: string; fields?: { title?: string }[] } | undefined;
				const asked = f?.fields?.map((x) => x.title).filter(Boolean).join("; ") || f?.title || "a question";
				kind = "form";
				line = (t) => `${t} asks: ${clip(asked, 200)}`;
				break;
			}
			case "session.execution.succeeded":
			case "session.execution.failed": {
				const failed = evt.type === "session.execution.failed";
				const err = (d.error as { message?: string } | undefined)?.message;
				kind = failed ? "failed" : "done";
				line = (t) => (failed ? `${t} failed${err ? `: ${clip(err, 200)}` : ""}` : `${t} finished`);
				break;
			}
			default:
				return;
		}
		const info = await this.session(oc, sessionID);
		if (kind === "done" || kind === "failed") {
			if (!info || info.parentID) return; // delegated sub-threads report through their parent
			this.titles.delete(sessionID);
		}
		const now = Date.now();
		const key = `${sessionID}:${kind}`;
		if (now - (this.lastSent.get(key) ?? -Infinity) < (this.o.debounceMs ?? 60_000)) return;
		this.lastSent.set(key, now);
		for (const [k, t] of this.lastSent) if (now - t > 10 * 60_000) this.lastSent.delete(k);
		await this.o.notifier().send({ title: "OpenChamber", message: line(info?.title || "A thread"), priority: kind === "done" ? 0 : 1 });
	}
}
