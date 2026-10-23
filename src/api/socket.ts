// One client WebSocket on /api/v1/ws (docs/API.md "WebSocket"). Frames are JSON objects: a call
// `{id, op, params}` is answered with `{id, result}` or `{id, error}`; the gateway sends events as
// `{event, sessionId?, seq?, at, data}`, starting with `hello`. The gateway pings at the protocol level and
// drops a client that stops answering. Holds only per-socket bookkeeping: which chats it follows.
import type { WebSocket } from "ws";
import type { Core } from "../app.ts";
import { logger } from "../log.ts";
import { ApiError, apiError } from "./errors.ts";
import { hello } from "./ops/gateway.ts";
import type { Caller, OpTable, SocketHandle } from "./ops.ts";

const log = logger("api-ws");

/** An event frame (docs/API.md "Events"); also what src/remote/api-client.ts receives from another gateway. */
export type ApiEvent = { event: string; sessionId?: string; seq?: number; at: number; data: Record<string, unknown> };

/** Feeds a socket the events of one chat; returns how to stop. Supplied by the chat operations (src/api/events.ts). */
export type SessionFeed = (sessionId: string, send: (e: ApiEvent) => void, caller: Caller) => () => void;
/** Feeds a socket the gateway-wide events its caller may see; returns how to stop. */
export type GlobalFeed = (send: (e: ApiEvent) => void, caller: Caller) => () => void;

export class ApiSocket implements SocketHandle {
	private readonly ws: WebSocket;
	private readonly core: Core;
	private readonly ops: OpTable;
	private readonly caller: Caller;
	private readonly sessionFeed: SessionFeed;
	private readonly following = new Map<string, () => void>();
	private readonly offGlobal: () => void;
	private readonly beat: NodeJS.Timeout;
	private alive = true;
	private closed = false;

	constructor(ws: WebSocket, o: { core: Core; ops: OpTable; caller: Caller; sessionFeed: SessionFeed; globalFeed: GlobalFeed; heartbeatMs: number }) {
		this.ws = ws;
		this.core = o.core;
		this.ops = o.ops;
		this.caller = o.caller;
		this.sessionFeed = o.sessionFeed;
		ws.on("message", (data) => {
			for (const line of data.toString().split("\n")) if (line.trim()) void this.onFrame(line);
		});
		ws.on("pong", () => (this.alive = true));
		ws.on("close", () => this.dispose());
		ws.on("error", () => this.dispose());
		// A client that froze never closes its socket: ping it, and drop it when two pings go unanswered.
		this.beat = setInterval(() => {
			if (!this.alive) return void ws.terminate();
			this.alive = false;
			ws.ping();
		}, o.heartbeatMs);
		this.beat.unref();
		this.send({ event: "hello", at: Date.now(), data: hello(this.core, this.caller) });
		this.offGlobal = o.globalFeed((e) => this.send(e), this.caller);
	}

	subscribe(sessionId: string): void {
		if (this.following.has(sessionId)) return;
		this.following.set(sessionId, this.sessionFeed(sessionId, (e) => this.send(e), this.caller));
	}

	unsubscribe(sessionId: string): void {
		this.following.get(sessionId)?.();
		this.following.delete(sessionId);
	}

	private dispose(): void {
		if (this.closed) return;
		this.closed = true;
		clearInterval(this.beat);
		this.offGlobal();
		for (const off of this.following.values()) off();
		this.following.clear();
	}

	private send(frame: ApiEvent | Record<string, unknown>): void {
		if (this.closed || this.ws.readyState !== this.ws.OPEN) return;
		this.ws.send(JSON.stringify(frame));
	}

	private async onFrame(line: string): Promise<void> {
		let frame: Record<string, unknown>;
		try {
			const parsed: unknown = JSON.parse(line);
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
			frame = parsed as Record<string, unknown>;
		} catch {
			return this.send({ id: null, error: new ApiError("invalid_params", "A frame must be one JSON object.").toJSON() });
		}
		const id = frame.id ?? null;
		try {
			if (typeof frame.op !== "string") throw new ApiError("invalid_params", "A call names its operation in op.");
			const op = this.ops.get(frame.op);
			if (!op) throw new ApiError("unknown_op", `Unknown operation ${frame.op}.`);
			const result = await this.ops.call(op, frame.params, { core: this.core, caller: this.caller, socket: this });
			this.send({ id, result: result ?? {} });
		} catch (error) {
			const e = apiError(error);
			if (!e) log.warn("operation failed", { op: String(frame.op), error: error instanceof Error ? error.message : String(error) });
			this.send({ id, error: (e ?? new ApiError("internal", "Something went wrong on the gateway; its log has the details.")).toJSON() });
		}
	}
}
