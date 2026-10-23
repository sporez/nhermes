// The client API at /api/v1 (docs/API.md): HTTP requests and WebSocket connections, both dispatched from one
// operation table. Authentication happens before (src/server.ts); this module gets the caller. Behaviour
// stays in core/; the operations only translate.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { WebSocket } from "ws";
import type { Core } from "../app.ts";
import { RawBody, readJson, sendJson, sendRaw } from "../http.ts";
import { logger } from "../log.ts";
import { ApiError, apiError } from "./errors.ts";
import { ChatFeeds, globalFeed } from "./events.ts";
import { approvalOps } from "./ops/approvals.ts";
import { attachmentOps } from "./ops/attachments.ts";
import { botOps } from "./ops/bots.ts";
import { chatOps } from "./ops/chat.ts";
import { gatewayOps } from "./ops/gateway.ts";
import { manageOps } from "./ops/manage.ts";
import { modelOps } from "./ops/models.ts";
import { roomOps } from "./ops/rooms.ts";
import { sessionOps } from "./ops/sessions.ts";
import { type Caller, OpTable } from "./ops.ts";
import { ApiSocket, type GlobalFeed } from "./socket.ts";

const log = logger("api");

export const API_PREFIX = "/api/v1";

export type ClientApiOptions = { heartbeatMs?: number };

export class ClientApi {
	readonly ops: OpTable;
	private readonly core: Core;
	private readonly heartbeatMs: number;
	private readonly feeds: ChatFeeds;
	private readonly globalFeed: GlobalFeed;

	constructor(core: Core, o: ClientApiOptions = {}) {
		this.core = core;
		this.heartbeatMs = o.heartbeatMs ?? 30_000;
		this.ops = new OpTable([
			...gatewayOps,
			...sessionOps,
			...chatOps,
			...attachmentOps,
			...approvalOps,
			...modelOps,
			...botOps,
			...manageOps,
			...roomOps,
		]);
		this.feeds = new ChatFeeds(core);
		this.globalFeed = globalFeed(core);
	}

	/** Whether a path belongs to this API. */
	static owns(pathname: string): boolean {
		return pathname === API_PREFIX || pathname.startsWith(`${API_PREFIX}/`);
	}

	async handle(req: IncomingMessage, res: ServerResponse, url: URL, caller: Caller): Promise<void> {
		try {
			const path = url.pathname.slice(API_PREFIX.length) || "/";
			const { op, params } = this.ops.route(req.method ?? "GET", path);
			const raw: Record<string, unknown> = Object.fromEntries(url.searchParams);
			if (!op.rawBody) {
				const body = await readJson(req);
				if (body !== undefined && (typeof body !== "object" || body === null || Array.isArray(body))) throw new ApiError("invalid_params", "The body must be a JSON object.");
				Object.assign(raw, body);
			}
			Object.assign(raw, params);
			const result = await this.ops.call(op, raw, { core: this.core, caller, request: req });
			if (result instanceof RawBody) return sendRaw(res, result);
			sendJson(res, 200, result ?? {});
		} catch (error) {
			const e = apiError(error);
			if (!e) log.error("request failed", { method: req.method, path: url.pathname, error: error instanceof Error ? error.message : String(error) });
			const out = e ?? new ApiError("internal", "Something went wrong on the gateway; its log has the details.");
			sendJson(res, out.status, { error: out.toJSON() });
		}
	}

	close(): void {
		this.feeds.close();
	}

	connect(ws: WebSocket, caller: Caller): ApiSocket {
		return new ApiSocket(ws, { core: this.core, ops: this.ops, caller, sessionFeed: this.feeds, globalFeed: this.globalFeed, heartbeatMs: this.heartbeatMs });
	}
}
