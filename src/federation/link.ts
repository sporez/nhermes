// A lasting Hermes WebSocket to one network member, authenticated with the pair secret. Chats with that
// member's bots go through it: calls, the member's events for those chats, and its approval requests
// (answered by a handler here). It reconnects on its own; after a reconnect, the chats being watched are
// resumed so the member sends their events again.
import WebSocket from "ws";
import { logger } from "../log.ts";
import { HEARTBEAT_MS } from "../remote/peer.ts";

const log = logger("link");

type Frame = { id?: string | number | null; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { code: number; message: string } };
export type LinkEvent = { type: string; session_id: string; payload?: Record<string, unknown> };

export class LinkError extends Error {
	readonly code: number;
	constructor(code: number, message: string) {
		super(message);
		this.code = code;
	}
}

export type LinkOptions = {
	url: string;
	headers: () => Record<string, string>;
	/** The member's name, for messages. */
	name: string;
	onEvent: (e: LinkEvent) => void;
	/** A server→client request from the member (approval); the result is sent back. */
	onRequest: (method: string, params: Record<string, unknown>) => Promise<unknown>;
	/** Sessions to resume after a reconnect. */
	watched: () => string[];
};

export class MemberLink {
	private readonly o: LinkOptions;
	private ws: WebSocket | undefined;
	private ready: Promise<void> | undefined;
	private nextId = 1;
	private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
	private closed = false;
	private retry: ReturnType<typeof setTimeout> | undefined;
	private failures = 0;

	constructor(o: LinkOptions) {
		this.o = o;
	}

	async call<T = Record<string, unknown>>(method: string, params: Record<string, unknown>, timeoutMs = 60_000): Promise<T> {
		await this.connect();
		return this.rpc<T>(method, params, timeoutMs);
	}

	private rpc<T>(method: string, params: Record<string, unknown>, timeoutMs = 60_000): Promise<T> {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return Promise.reject(new LinkError(4503, `${this.o.name} is offline (the connection dropped)`));
		const id = this.nextId++;
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new LinkError(-32000, `${this.o.name} did not answer in time`));
			}, timeoutMs);
			this.pending.set(id, {
				resolve: (v) => (clearTimeout(timer), resolve(v as T)),
				reject: (e) => (clearTimeout(timer), reject(e)),
			});
			this.ws!.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
		});
	}

	/** Opens the socket if needed. Fails at once (with a clear message) when the member cannot be reached. */
	connect(): Promise<void> {
		if (this.closed) return Promise.reject(new LinkError(-32000, "link closed"));
		this.ready ??= this.open().catch((error: unknown) => {
			this.ready = undefined;
			throw error;
		});
		return this.ready;
	}

	private open(): Promise<void> {
		const url = `${this.o.url.replace(/^http/, "ws").replace(/\/$/, "")}/api/ws`;
		const ws = new WebSocket(url, { handshakeTimeout: 10_000, headers: this.o.headers() });
		return new Promise<void>((resolve, reject) => {
			let opened = false;
			const fail = (why: string) => reject(new LinkError(4503, `${this.o.name} is offline (${why})`));
			ws.on("message", (data) => {
				for (const line of data.toString().split("\n")) {
					if (!line.trim()) continue;
					let f: Frame;
					try {
						f = JSON.parse(line) as Frame;
					} catch {
						continue;
					}
					if (!opened && f.method === "event" && (f.params as LinkEvent | undefined)?.type === "gateway.ready") {
						opened = true;
						this.ws = ws;
						this.failures = 0;
						void this.afterOpen().then(resolve, reject);
						continue;
					}
					this.onFrame(f);
				}
			});
			ws.on("close", (code) => {
				if (!opened) return fail(code === 4401 ? "it no longer accepts this machine" : `closed ${code}`);
				this.onClose();
			});
			ws.on("error", (e) => {
				if (!opened) fail(e.message);
			});
		});
	}

	private async afterOpen(): Promise<void> {
		await this.rpc("client.capabilities", { server_requests: true });
		// A member that froze never closes the socket: ping it, and drop the socket when it stops answering.
		const ws = this.ws!;
		let waiting = false;
		const beat = setInterval(() => {
			if (waiting || this.ws !== ws) return;
			waiting = true;
			this.rpc("ping", {}, Math.min(15_000, HEARTBEAT_MS))
				.catch(() => {
					if (this.ws !== ws) return;
					log.warn("member stopped answering; dropping the connection", { member: this.o.name });
					ws.terminate();
				})
				.finally(() => (waiting = false));
		}, HEARTBEAT_MS);
		beat.unref();
		ws.on("close", () => clearInterval(beat));
		for (const id of this.o.watched()) {
			await this.rpc("session.resume", { session_id: id }).catch((e: unknown) => log.debug("resume after reconnect failed", { member: this.o.name, session: id, error: String(e) }));
		}
	}

	private onFrame(f: Frame): void {
		if (f.method === "event") return this.o.onEvent(f.params as LinkEvent);
		if (typeof f.id === "string" && f.method) {
			const id = f.id;
			void this.o.onRequest(f.method, f.params ?? {}).then(
				(result) => result !== undefined && this.ws?.send(JSON.stringify({ jsonrpc: "2.0", id, result })),
				(error: unknown) => log.warn("member request failed", { member: this.o.name, method: f.method, error: String(error) }),
			);
			return;
		}
		if (typeof f.id === "number") {
			const p = this.pending.get(f.id);
			this.pending.delete(f.id);
			if (p) f.error ? p.reject(new LinkError(f.error.code, f.error.message)) : p.resolve(f.result);
		}
	}

	private onClose(): void {
		this.ws = undefined;
		this.ready = undefined;
		for (const p of this.pending.values()) p.reject(new LinkError(4503, `${this.o.name} is offline (the connection dropped)`));
		this.pending.clear();
		if (this.closed || this.o.watched().length === 0) return;
		// Someone is watching a chat there: come back as soon as the member does.
		const delay = Math.min(30_000, 500 * 2 ** Math.min(this.failures++, 6));
		this.retry = setTimeout(() => void this.connect().catch(() => this.onClose()), delay);
		this.retry.unref();
	}

	close(): void {
		this.closed = true;
		if (this.retry) clearTimeout(this.retry);
		this.ws?.close();
	}
}
