// A client for the /api/v1 client API in tests: HTTP calls and a WebSocket that speaks the frames the way
// the app's NHermesKit does (docs/API.md).
import type { ConnectionOptions } from "node:tls";
import WebSocket from "ws";
import { TOKEN } from "../helpers.ts";

export type ApiEvent = { event: string; sessionId?: string; seq?: number; at: number; data: Record<string, unknown> };
type Reply = { id: string | number | null; result?: unknown; error?: { code: string; message: string; details?: unknown } };

export class ApiCallError extends Error {
	readonly code: string;
	readonly status: number | undefined;
	constructor(code: string, message: string, status?: number) {
		super(message);
		this.code = code;
		this.status = status;
	}
}

/** HTTP: `call("GET /sessions", {botId})` sends query parameters for GET and DELETE, a JSON body otherwise. */
export function http(port: number, token: string | null = TOKEN) {
	return async <T = Record<string, unknown>>(route: string, params: Record<string, unknown> = {}): Promise<T> => {
		const [method = "GET", path = "/"] = route.split(" ");
		const url = new URL(`http://127.0.0.1:${port}/api/v1${path === "/" ? "" : path}`);
		const hasBody = method !== "GET" && method !== "DELETE";
		if (!hasBody) for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
		const res = await fetch(url, {
			method,
			headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(hasBody ? { "content-type": "application/json" } : {}) },
			...(hasBody ? { body: JSON.stringify(params) } : {}),
		});
		const body = (await res.json()) as { error?: { code: string; message: string } };
		if (!res.ok) throw new ApiCallError(body.error?.code ?? "?", body.error?.message ?? res.statusText, res.status);
		return body as T;
	};
}

export class ApiSocketClient {
	readonly ws: WebSocket;
	readonly events: ApiEvent[] = [];
	closeCode: number | undefined;
	private nextId = 1;
	private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
	private readonly watchers: { pred: (e: ApiEvent) => boolean; resolve: (e: ApiEvent) => void }[] = [];

	private constructor(ws: WebSocket) {
		this.ws = ws;
		ws.on("message", (data) => {
			const f = JSON.parse(data.toString()) as ApiEvent & Reply;
			if (typeof f.event === "string") return this.onEvent(f);
			if (typeof f.id === "number") {
				const p = this.pending.get(f.id);
				this.pending.delete(f.id);
				if (p) f.error ? p.reject(new ApiCallError(f.error.code, f.error.message)) : p.resolve(f.result);
			}
		});
		ws.on("close", (code) => {
			this.closeCode = code;
			for (const p of this.pending.values()) p.reject(new Error("socket closed"));
			this.pending.clear();
		});
	}

	/** Opens the socket and waits for hello. `tls`: a member on the encrypted port (no token). */
	static async connect(port: number, token: string | null = TOKEN, tls?: ConnectionOptions): Promise<ApiSocketClient> {
		const ws = new WebSocket(`${tls ? "wss" : "ws"}://127.0.0.1:${port}/api/v1/ws`, { headers: token ? { authorization: `Bearer ${token}` } : {}, ...tls });
		const c = new ApiSocketClient(ws);
		await new Promise<void>((resolve, reject) => {
			ws.once("open", () => resolve());
			ws.once("error", reject);
		});
		return c;
	}

	private onEvent(e: ApiEvent): void {
		this.events.push(e);
		for (const w of [...this.watchers]) {
			if (w.pred(e)) {
				this.watchers.splice(this.watchers.indexOf(w), 1);
				w.resolve(e);
			}
		}
	}

	call<T = Record<string, unknown>>(op: string, params: Record<string, unknown> = {}): Promise<T> {
		const id = this.nextId++;
		return new Promise<T>((resolve, reject) => {
			this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
			this.ws.send(JSON.stringify({ id, op, params }));
		});
	}

	/** Sends raw text as one frame (malformed-frame tests). */
	sendRaw(text: string): void {
		this.ws.send(text);
	}

	waitEvent(pred: string | ((e: ApiEvent) => boolean), timeoutMs = 5000): Promise<ApiEvent> {
		const match = typeof pred === "string" ? (e: ApiEvent) => e.event === pred : pred;
		const hit = this.events.find(match);
		if (hit) return Promise.resolve(hit);
		return new Promise((resolve, reject) => {
			const t = setTimeout(() => reject(new Error(`timeout; events: ${this.events.map((e) => e.event).join(",")}`)), timeoutMs);
			this.watchers.push({ pred: match, resolve: (e) => (clearTimeout(t), resolve(e)) });
		});
	}

	eventsOf(name: string, sessionId?: string): ApiEvent[] {
		return this.events.filter((e) => e.event === name && (sessionId === undefined || e.sessionId === sessionId));
	}

	close(): Promise<void> {
		return new Promise((resolve) => {
			if (this.ws.readyState === WebSocket.CLOSED) return resolve();
			this.ws.once("close", () => resolve());
			this.ws.close();
		});
	}
}
