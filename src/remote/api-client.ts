// A client of another gateway's /api/v1 socket (docs/API.md "WebSocket"): what a peer agent, a delegation to a
// member's bot, a member bot's group chat turn and the owner's chats with member bots use to reach the
// machine that runs the bot. Connects with the owner's token (a configured `peer:`) or as a member (TLS-PSK),
// waits for hello, makes calls, and keeps the events it receives for waiters. It pings the other machine, and
// drops a connection that stops answering, so a wait on a machine that froze still ends.
import type { ConnectionOptions } from "node:tls";
import WebSocket from "ws";
import type { ApiEvent } from "../api/socket.ts";
import { logger } from "../log.ts";

const log = logger("api-client");

/** How often a connection to another machine checks that it is still there (tests shorten it). */
export let HEARTBEAT_MS = 30_000;
export function setPeerHeartbeat(ms: number): void {
	HEARTBEAT_MS = ms;
}


/** A gateway to reach: with the owner's token (configured peer), or as a member (TLS-PSK). */
export type GatewayTarget = { url: string; token?: string; headers?: Record<string, string>; tls?: ConnectionOptions };

/** A refused call, with the other gateway's error code (`session_not_found`, …), or `offline` for a lost link. */
export class RemoteError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.code = code;
	}
}

export class ApiClient {
	private ws: WebSocket | undefined;
	private nextId = 1;
	private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
	private readonly listeners = new Set<(e: ApiEvent) => void>();
	private readonly closers = new Set<(code: number) => void>();
	hello: Record<string, unknown> = {};
	closed = false;

	/** Opens a socket to `t` and waits for its hello. `name`: the machine, for messages. */
	static async open(t: GatewayTarget, name: string): Promise<ApiClient> {
		const c = new ApiClient();
		const url = `${t.url.replace(/^http/, "ws").replace(/\/$/, "")}/api/v1/ws`;
		// The token goes in a header, never in the URL (URLs end up in logs and proxies).
		const ws = new WebSocket(url, { handshakeTimeout: 15_000, headers: { ...t.headers, ...(t.token ? { authorization: `Bearer ${t.token}` } : {}) }, ...t.tls });
		c.ws = ws;
		await new Promise<void>((resolve, reject) => {
			let open = false;
			const timer = setTimeout(() => reject(new RemoteError("offline", `${name} did not answer`)), 20_000);
			ws.on("unexpected-response", (_req, res) => {
				clearTimeout(timer);
				reject(new RemoteError("offline", res.statusCode === 404 ? `${name} runs an older nHermes; update it` : `${name} answered ${res.statusCode}`));
				ws.terminate();
			});
			ws.on("message", (data) => {
				let f: ApiEvent & { id?: unknown; result?: unknown; error?: { code: string; message: string } };
				try {
					f = JSON.parse(data.toString()) as typeof f;
				} catch {
					return;
				}
				if (!open && f.event === "hello") {
					open = true;
					c.hello = f.data;
					clearTimeout(timer);
					resolve();
					return;
				}
				c.onFrame(f);
			});
			ws.on("close", (code) => {
				c.closed = true;
				clearTimeout(timer);
				for (const p of c.pending.values()) p.reject(new RemoteError("offline", `${name} is offline (the connection dropped)`));
				c.pending.clear();
				for (const fn of c.closers) fn(code);
				if (!open) reject(new RemoteError(code === 4401 ? "unauthorized" : "offline", code === 4401 ? `${name} rejected this machine's credentials` : `${name} closed the connection (${code})`));
			});
			ws.on("error", (e) => {
				clearTimeout(timer);
				if (!open) reject(new RemoteError("offline", `${name} is offline (${e.message})`));
			});
		});
		c.startHeartbeat(name);
		return c;
	}

	private startHeartbeat(name: string): void {
		let waiting = false;
		const beat = setInterval(() => {
			if (waiting || this.closed) return;
			waiting = true;
			const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("no answer to ping")), Math.min(15_000, HEARTBEAT_MS)).unref());
			Promise.race([this.call("ping", {}), timeout])
				.catch(() => {
					if (this.closed) return;
					log.warn("the other machine stopped answering; dropping the connection", { machine: name });
					this.ws?.terminate();
				})
				.finally(() => (waiting = false));
		}, HEARTBEAT_MS);
		beat.unref();
		this.onClose(() => clearInterval(beat));
	}

	private onFrame(f: ApiEvent & { id?: unknown; result?: unknown; error?: { code: string; message: string } }): void {
		if (typeof f.event === "string") {
			for (const l of [...this.listeners]) l(f);
			return;
		}
		if (typeof f.id === "number") {
			const p = this.pending.get(f.id);
			this.pending.delete(f.id);
			if (p) f.error ? p.reject(new RemoteError(f.error.code, f.error.message)) : p.resolve(f.result);
		}
	}

	call<T = Record<string, unknown>>(op: string, params: Record<string, unknown>, timeoutMs = 60_000): Promise<T> {
		const id = this.nextId++;
		return new Promise<T>((resolve, reject) => {
			if (this.closed || !this.ws || this.ws.readyState !== WebSocket.OPEN) return reject(new RemoteError("offline", "the connection to the other machine is closed"));
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new RemoteError("offline", "the other machine did not answer in time"));
			}, timeoutMs);
			timer.unref();
			this.pending.set(id, { resolve: (v) => (clearTimeout(timer), resolve(v as T)), reject: (e) => (clearTimeout(timer), reject(e)) });
			this.ws.send(JSON.stringify({ id, op, params }));
		});
	}

	/** Every event from now on; returns how to stop. */
	onEvent(fn: (e: ApiEvent) => void): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	onClose(fn: (code: number) => void): () => void {
		this.closers.add(fn);
		return () => this.closers.delete(fn);
	}

	/** Resolves with the first matching event from now on; rejects when the socket closes or the signal aborts. */
	waitEvent(pred: (e: ApiEvent) => boolean, signal?: AbortSignal): Promise<ApiEvent> {
		return new Promise((resolve, reject) => {
			if (this.closed) return reject(new RemoteError("offline", "the connection to the other machine is closed"));
			const finish = (fn: () => void) => {
				off();
				offClose();
				signal?.removeEventListener("abort", aborted);
				fn();
			};
			const off = this.onEvent((e) => pred(e) && finish(() => resolve(e)));
			const offClose = this.onClose(() => finish(() => reject(new RemoteError("offline", "the connection to the other machine dropped"))));
			const aborted = () => finish(() => reject(new RemoteError("cancelled", "cancelled")));
			if (signal?.aborted) return aborted();
			signal?.addEventListener("abort", aborted, { once: true });
		});
	}

	close(): void {
		this.ws?.close();
	}

	terminate(): void {
		this.ws?.terminate();
	}
}
