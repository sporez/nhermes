// The client API's operation table (docs/API.md "Operations"). Each operation is declared once: its name,
// its HTTP route under /api/v1 (absent for socket-only ones), whether a network member may call it, and its
// handler. HTTP and the WebSocket both dispatch from this table, so every operation behaves the same over
// either, and the member rules are checked here for every call.
import type { IncomingMessage } from "node:http";
import type { Core } from "../app.ts";
import type { MemberRow } from "../federation/members.ts";
import { Router } from "../http.ts";
import { ApiError } from "./errors.ts";
import { Params } from "./params.ts";

/** Who is calling: the owner (the gateway token), or a network member (its pair secret on the encrypted port). */
export type Caller = { kind: "owner" } | { kind: "member"; member: MemberRow };

/** What a socket offers the operations that need one (subscriptions). */
export type SocketHandle = {
	subscribe(sessionId: string): void;
	unsubscribe(sessionId: string): void;
};

export type OpContext = {
	core: Core;
	caller: Caller;
	/** Set when the call came over the WebSocket. */
	socket?: SocketHandle;
	/** Set when the call came over HTTP (an upload reads its body from it). */
	request?: IncomingMessage;
};

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type Op = {
	name: string;
	/** `METHOD /path` under /api/v1, with `:name` path parameters. Absent: socket only. */
	http?: `${HttpMethod} /${string}`;
	/** A network member may call it (its own chats and this machine's shareable bots only). */
	members?: boolean;
	/** The HTTP body is not JSON: the handler reads `request` itself (uploads). */
	rawBody?: boolean;
	handle(p: Params, cx: OpContext): unknown;
};

export class OpTable {
	private readonly byName = new Map<string, Op>();
	private readonly router = new Router();

	constructor(ops: readonly Op[]) {
		for (const op of ops) {
			if (this.byName.has(op.name)) throw new Error(`operation ${op.name} is declared twice`);
			this.byName.set(op.name, op);
			if (op.http) {
				const [method, path] = op.http.split(" ") as [HttpMethod, string];
				this.router.on(method, path, () => op);
			}
		}
	}

	names(): string[] {
		return [...this.byName.keys()];
	}

	get(name: string): Op | undefined {
		return this.byName.get(name);
	}

	/** The operation an HTTP request names, with its path parameters. */
	route(method: string, path: string): { op: Op; params: Record<string, string> } {
		const m = this.router.match(method, path);
		if (m === undefined) throw new ApiError("not_found", `Nothing at ${path}.`);
		if (m === "method") throw new ApiError("method_not_allowed", `${method} is not allowed on ${path}.`);
		return { op: m.handler(undefined as never) as Op, params: m.params };
	}

	/** Runs an operation after the caller checks. */
	async call(op: Op, raw: unknown, cx: OpContext): Promise<unknown> {
		if (cx.caller.kind === "member" && !op.members) throw new ApiError("unknown_op", `Unknown operation ${op.name}.`);
		return op.handle(new Params(raw), cx);
	}
}
