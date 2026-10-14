// A small Hermes JSON-RPC client for tests: speaks the wire format the way Vory's GatewaySocket does.
import WebSocket from "ws";

export type Frame = { jsonrpc: "2.0"; id?: string | number | null; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { code: number; message: string } };
export type Ev = { type: string; session_id: string; payload: Record<string, unknown> };

export class HermesClient {
	readonly ws: WebSocket;
	readonly frames: Frame[] = [];
	readonly events: Ev[] = [];
	private nextId = 1;
	private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
	private readonly watchers: { pred: (f: Frame) => boolean; resolve: (f: Frame) => void }[] = [];
	/** How to answer server→client requests; undefined leaves them open. */
	onRequest: ((method: string, params: Record<string, unknown>) => unknown) | undefined;
	closeCode: number | undefined;

	private constructor(ws: WebSocket) {
		this.ws = ws;
		ws.on("message", (data) => {
			for (const line of data.toString().split("\n")) if (line.trim()) this.onFrame(JSON.parse(line) as Frame);
		});
		ws.on("close", (code) => {
			this.closeCode = code;
			for (const p of this.pending.values()) p.reject(new Error("socket closed"));
			this.pending.clear();
		});
	}

	/** `where`: a port on 127.0.0.1, or "host:port". */
	static async connect(where: number | string, token: string | undefined, headers?: Record<string, string>): Promise<HermesClient> {
		const q = token === undefined ? "" : `?token=${encodeURIComponent(token)}`;
		const hostPort = /^\d+$/.test(String(where)) ? `127.0.0.1:${where}` : String(where);
		const ws = new WebSocket(`ws://${hostPort}/api/ws${q}`, { headers });
		const c = new HermesClient(ws);
		await new Promise<void>((resolve, reject) => {
			ws.once("open", () => resolve());
			ws.once("error", reject);
		});
		return c;
	}

	private onFrame(f: Frame): void {
		this.frames.push(f);
		if (f.method === "event") this.events.push(f.params as Ev);
		if (typeof f.id === "number" && !f.method) {
			const p = this.pending.get(f.id);
			this.pending.delete(f.id);
			if (p) f.error ? p.reject(Object.assign(new Error(f.error.message), { code: f.error.code })) : p.resolve(f.result);
		}
		if (typeof f.id === "string" && f.method && this.onRequest) {
			const result = this.onRequest(f.method, f.params ?? {});
			if (result !== undefined) this.ws.send(JSON.stringify({ jsonrpc: "2.0", id: f.id, result }));
		}
		for (const w of [...this.watchers]) {
			if (w.pred(f)) {
				this.watchers.splice(this.watchers.indexOf(w), 1);
				w.resolve(f);
			}
		}
	}

	call<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
		const id = this.nextId++;
		return new Promise<T>((resolve, reject) => {
			this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
			this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
		});
	}

	respond(id: string, result: unknown): void {
		this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, result }));
	}

	waitFor(pred: (f: Frame) => boolean, timeoutMs = 5000): Promise<Frame> {
		const hit = this.frames.find(pred);
		if (hit) return Promise.resolve(hit);
		return new Promise((resolve, reject) => {
			const t = setTimeout(() => reject(new Error(`timeout; frames: ${this.frames.map((f) => (f.method === "event" ? (f.params as Ev).type : (f.method ?? `reply#${f.id}`))).join(",")}`)), timeoutMs);
			this.watchers.push({ pred, resolve: (f) => (clearTimeout(t), resolve(f)) });
		});
	}

	waitEvent(type: string, sessionId?: string, timeoutMs = 5000): Promise<Ev> {
		return this.waitFor((f) => f.method === "event" && (f.params as Ev).type === type && (sessionId === undefined || (f.params as Ev).session_id === sessionId), timeoutMs).then((f) => f.params as Ev);
	}

	eventsOf(type: string, sessionId?: string): Ev[] {
		return this.events.filter((e) => e.type === type && (sessionId === undefined || e.session_id === sessionId));
	}

	close(): Promise<void> {
		return new Promise((resolve) => {
			if (this.ws.readyState === WebSocket.CLOSED) return resolve();
			this.ws.once("close", () => resolve());
			this.ws.close();
		});
	}
}
