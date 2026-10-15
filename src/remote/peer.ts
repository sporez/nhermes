// Mode B: an independent agent on another machine is another Neil Hermes gateway (its own Durable
// store, tools and memory). The central gateway reaches it over the same Hermes JSON-RPC WebSocket
// Vory uses, so there is no second protocol. Delegation to a peer is idempotent (prompt.submit's
// idempotency_key becomes the peer's Durable request id) and survives a dropped connection: the
// client reconnects and resumes the remote session. Approval requests from the peer are handed to a
// callback (the central gateway asks its owner).
import WebSocket from "ws";
import { logger } from "../log.ts";

const log = logger("peer");

type Frame = { id?: string | number | null; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { code: number; message: string } };

/** A gateway to reach: with the owner's token (configured peer) or a member's identifying headers. */
export type PeerTarget = { url: string; token?: string; headers?: Record<string, string>; profile?: string };
export type PeerApproval = (params: Record<string, unknown>) => Promise<"once" | "session" | "always" | "deny">;

class Socket {
	private ws: WebSocket | undefined;
	private nextId = 1;
	private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
	readonly events: { type: string; session_id: string; payload: Record<string, unknown> }[] = [];
	private readonly listeners = new Set<() => void>();
	closed = false;

	static async open(t: PeerTarget, onRequest: (method: string, params: Record<string, unknown>) => Promise<unknown>): Promise<Socket> {
		const s = new Socket();
		const url = `${t.url.replace(/^http/, "ws").replace(/\/$/, "")}/api/ws${t.token ? `?token=${encodeURIComponent(t.token)}` : ""}`;
		const ws = new WebSocket(url, { handshakeTimeout: 15_000, headers: t.headers });
		s.ws = ws;
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`peer ${t.url}: no gateway.ready`)), 20_000);
			ws.on("message", (data) => {
				for (const line of data.toString().split("\n")) {
					if (!line.trim()) continue;
					const f = JSON.parse(line) as Frame;
					if (f.method === "event" && (f.params as { type?: string }).type === "gateway.ready") {
						clearTimeout(timer);
						resolve();
					}
					s.onFrame(f, onRequest);
				}
			});
			ws.on("close", (code) => {
				s.closed = true;
				clearTimeout(timer);
				for (const p of s.pending.values()) p.reject(new Error(`peer connection closed (${code})`));
				s.pending.clear();
				for (const l of s.listeners) l();
				reject(new Error(code === 4401 ? `peer ${t.url} rejected the token` : `peer ${t.url} closed (${code})`));
			});
			ws.on("error", (e) => {
				clearTimeout(timer);
				reject(e);
			});
		});
		await s.call("client.capabilities", { server_requests: true });
		return s;
	}

	private onFrame(f: Frame, onRequest: (method: string, params: Record<string, unknown>) => Promise<unknown>): void {
		if (f.method === "event") {
			this.events.push(f.params as never);
			for (const l of this.listeners) l();
			return;
		}
		if (typeof f.id === "string" && f.method) {
			const id = f.id;
			void onRequest(f.method, f.params ?? {}).then((result) => {
				if (result !== undefined) this.ws?.send(JSON.stringify({ jsonrpc: "2.0", id, result }));
			});
			return;
		}
		if (typeof f.id === "number") {
			const p = this.pending.get(f.id);
			this.pending.delete(f.id);
			if (p) f.error ? p.reject(new Error(f.error.message)) : p.resolve(f.result);
		}
	}

	call<T = Record<string, unknown>>(method: string, params: Record<string, unknown>): Promise<T> {
		const id = this.nextId++;
		return new Promise<T>((resolve, reject) => {
			if (this.closed || !this.ws) return reject(new Error("peer connection closed"));
			this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
			this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
		});
	}

	/** Resolves with the matching event, or rejects when the socket closes or the signal aborts. */
	waitEvent(pred: (e: Socket["events"][number]) => boolean, signal?: AbortSignal): Promise<Socket["events"][number]> {
		return new Promise((resolve, reject) => {
			const check = () => {
				const hit = this.events.find(pred);
				if (hit) return done(() => resolve(hit));
				if (this.closed) return done(() => reject(new Error("peer connection closed")));
				if (signal?.aborted) return done(() => reject(new Error("cancelled")));
			};
			const done = (fn: () => void) => {
				this.listeners.delete(check);
				signal?.removeEventListener("abort", check);
				fn();
			};
			this.listeners.add(check);
			signal?.addEventListener("abort", check);
			check();
		});
	}

	close(): void {
		this.ws?.close();
	}
}

/** Starts an empty chat with the peer's bot and returns its id (the first step of a background task). */
export async function createPeerSession(t: PeerTarget): Promise<string> {
	const s = await Socket.open(t, async () => undefined);
	try {
		const created = await s.call<{ session_id: string }>("session.create", t.profile ? { profile: t.profile, source: "peer" } : { source: "peer" });
		return created.session_id;
	} finally {
		s.close();
	}
}

/**
 * Runs one task on a peer and returns its answer. `sessionId` (when given) is a remote session from an
 * earlier attempt of the same task; `key` deduplicates the submission there.
 */
export async function runOnPeer(
	t: PeerTarget,
	task: string,
	opts: {
		key: string;
		sessionId?: string;
		onSession?: (id: string) => Promise<void>;
		onApproval: PeerApproval;
		signal?: AbortSignal;
		timeoutMs?: number;
		/** When the very first connection fails, give up at once with this message instead of retrying. */
		failFast?: string;
		/** Connection attempts before giving up (default 20, about ten minutes of the peer being away). */
		maxAttempts?: number;
	},
): Promise<{ sessionId: string; text: string }> {
	const deadline = Date.now() + (opts.timeoutMs ?? 30 * 60_000);
	const onRequest = async (method: string, params: Record<string, unknown>) => (method === "approval" ? { choice: await opts.onApproval(params) } : undefined);
	let sessionId = opts.sessionId;
	let submitted = false;
	for (let attempt = 0; ; attempt++) {
		if (opts.signal?.aborted) throw new Error("cancelled");
		if (Date.now() > deadline) throw new Error("the peer did not answer in time");
		let s: Socket | undefined;
		try {
			s = await Socket.open(t, onRequest);
			if (!sessionId) {
				const created = await s.call<{ session_id: string }>("session.create", t.profile ? { profile: t.profile, source: "peer" } : { source: "peer" });
				sessionId = created.session_id;
				await opts.onSession?.(sessionId);
			}
			const snap = await s.call<{ running: boolean; messages: { role: string; text: string }[] }>("session.resume", { session_id: sessionId });
			const lastAnswer = () => [...snap.messages].reverse().find((m) => m.role === "assistant" && m.text)?.text;
			if (!submitted || attempt === 0) {
				// Idempotent on the peer: the same key returns the same submission.
				const r = await s.call<{ status: string; submission_status?: string }>("prompt.submit", { session_id: sessionId, text: task, idempotency_key: opts.key });
				submitted = true;
				log.debug("submitted to peer", { url: t.url, session: sessionId, status: r.status });
				if (r.submission_status === "done" && lastAnswer()) return { sessionId, text: lastAnswer()! };
			}
			if (!snap.running && attempt > 0 && lastAnswer()) return { sessionId, text: lastAnswer()! };
			const done = await s.waitEvent((e) => e.type === "message.complete" && e.session_id === sessionId, opts.signal);
			if (done.payload.status === "error") throw new Error(`the peer's run failed: ${String(done.payload.error ?? "")}`);
			return { sessionId, text: String(done.payload.text ?? "") };
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			if (attempt === 0 && s === undefined && opts.failFast && !/rejected the token/.test(msg)) throw new Error(opts.failFast);
			if (/rejected the token|run failed|cancelled/.test(msg) || attempt >= (opts.maxAttempts ?? 20)) throw error;
			log.warn("peer connection problem; retrying", { url: t.url, attempt, error: msg });
			await new Promise((r) => setTimeout(r, Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5))));
		} finally {
			s?.close();
		}
	}
}
