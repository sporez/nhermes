// A controllable MCP server for tests: Streamable HTTP (protocol 2025-11-25) on node:http and port 0.
// It answers initialize (with a session id), tools/list (in pages), tools/call, ping, the GET stream
// (for tools/list_changed) and DELETE. Tests stop it and start it again on the same port, require a
// bearer token, expire the session, change the tool list, and choose per tool how a call behaves.
// Every request it receives is counted and emitted, so a test can wait on it and prove that nothing
// was retried or replayed.
import { EventEmitter } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";

export type FakeTool = {
	name: string;
	title?: string;
	description?: string;
	inputSchema?: Record<string, unknown>;
	annotations?: Record<string, unknown>;
};

/** How one call is answered. */
export type Behavior =
	| { text: string }
	| { toolError: string }
	| { rpcError: { code: number; message: string } }
	| { status: number; body?: string }
	/** Never answers (until the server stops). */
	| { hang: true }
	/** Closes the connection after the request arrived, without answering. */
	| { drop: true }
	/** Opens an SSE response stream for the answer, then closes the connection without answering. */
	| { sseDrop: true }
	| { delayMs: number; text: string };

export type Call = { name: string; args: Record<string, unknown>; session: string | undefined };

type Rpc = { jsonrpc: "2.0"; id?: string | number; method?: string; params?: Record<string, unknown> };

export class FakeMcpServer {
	readonly events = new EventEmitter();
	readonly calls: Call[] = [];
	readonly cancelled: (string | number)[] = [];
	pings = 0;
	initializes = 0;
	lists = 0;
	tools: FakeTool[];
	/** Behavior by tool name; default `{ text: "<name> ok" }`. */
	readonly behavior = new Map<string, Behavior | ((args: Record<string, unknown>) => Behavior)>();
	/** When set, every request needs `Authorization: Bearer <token>`. */
	token: string | undefined;
	/** Tools per tools/list page. */
	pageSize = 100;
	/** Answer GET with an SSE stream (true) or 405. */
	getStream = true;
	protocolVersion = "2025-11-25";
	/** Headers of the last request (to check what the client sent). */
	lastHeaders: Record<string, string | string[] | undefined> = {};
	private server: Server | undefined;
	private port = 0;
	private sessions = new Set<string>();
	private nextSession = 1;
	private sockets = new Set<Socket>();
	private streams = new Set<ServerResponse>();
	private hanging = new Set<ServerResponse>();

	private constructor(tools: FakeTool[]) {
		this.tools = tools;
	}

	static async start(tools: FakeTool[] = [], opts: { token?: string; port?: number } = {}): Promise<FakeMcpServer> {
		const s = new FakeMcpServer(tools);
		s.token = opts.token;
		s.port = opts.port ?? 0;
		await s.listen();
		return s;
	}

	get url(): string {
		return `http://127.0.0.1:${this.port}/mcp`;
	}

	get running(): boolean {
		return this.server !== undefined;
	}

	/** Starts listening again on the same port (after `stop()`). */
	async listen(): Promise<void> {
		if (this.server) return;
		const server = createServer((req, res) => void this.handle(req, res));
		server.on("connection", (socket) => {
			this.sockets.add(socket);
			socket.on("close", () => this.sockets.delete(socket));
		});
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(this.port, "127.0.0.1", () => resolve());
		});
		this.port = (server.address() as AddressInfo).port;
		this.server = server;
		this.events.emit("listening");
	}

	/** Goes away like a machine that went offline: closes every connection and stops listening. Sessions are forgotten. */
	async stop(): Promise<void> {
		const server = this.server;
		if (!server) return;
		this.server = undefined;
		for (const s of this.sockets) s.destroy();
		this.sockets.clear();
		this.streams.clear();
		this.hanging.clear();
		this.sessions.clear();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		this.events.emit("stopped");
	}

	/** Forgets every session, so the next request carrying one gets 404. */
	expireSessions(): void {
		this.sessions.clear();
	}

	/** Replaces the tool list and tells open GET streams (tools/list_changed). */
	setTools(tools: FakeTool[]): void {
		this.tools = tools;
		for (const res of this.streams) res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })}\n\n`);
	}

	/** Resolves with the next request of this kind ("call", "cancel", "ping", "initialize", "list", "get"). */
	next<T = unknown>(event: string): Promise<T> {
		return new Promise((resolve) => this.events.once(event, resolve));
	}

	callsOf(name: string): Call[] {
		return this.calls.filter((c) => c.name === name);
	}

	private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		this.lastHeaders = req.headers;
		const body = await new Promise<string>((resolve) => {
			let data = "";
			req.on("data", (c: Buffer) => (data += c.toString("utf8")));
			req.on("end", () => resolve(data));
			req.on("error", () => resolve(data));
		});
		if (this.token && req.headers.authorization !== `Bearer ${this.token}`) {
			res.writeHead(401, { "www-authenticate": 'Bearer realm="test"' });
			res.end();
			return;
		}
		const session = typeof req.headers["mcp-session-id"] === "string" ? req.headers["mcp-session-id"] : undefined;
		if (req.method === "DELETE") {
			if (session) this.sessions.delete(session);
			res.writeHead(200);
			res.end();
			return;
		}
		if (req.method === "GET") {
			this.events.emit("get");
			if (!this.getStream) {
				res.writeHead(405);
				res.end();
				return;
			}
			if (!session || !this.sessions.has(session)) {
				res.writeHead(404);
				res.end();
				return;
			}
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
			res.write(": open\n\n");
			this.streams.add(res);
			res.on("close", () => this.streams.delete(res));
			return;
		}
		let msg: Rpc;
		try {
			msg = JSON.parse(body) as Rpc;
		} catch {
			res.writeHead(400);
			res.end("bad json");
			return;
		}
		if (msg.method === "initialize") {
			this.initializes++;
			const id = `session-${this.nextSession++}`;
			this.sessions.add(id);
			this.events.emit("initialize");
			this.json(res, { jsonrpc: "2.0", id: msg.id, result: { protocolVersion: this.protocolVersion, capabilities: { tools: { listChanged: true } }, serverInfo: { name: "fake-mcp", version: "1.0.0" }, instructions: "Fake server for tests." } }, { "mcp-session-id": id });
			return;
		}
		if (!session || !this.sessions.has(session)) {
			res.writeHead(session ? 404 : 400);
			res.end(session ? "session expired" : "no session");
			return;
		}
		if (msg.id === undefined) {
			if (msg.method === "notifications/cancelled") {
				const requestId = msg.params?.requestId as string | number;
				this.cancelled.push(requestId);
				this.events.emit("cancel", requestId);
			}
			res.writeHead(202);
			res.end();
			return;
		}
		if (msg.method === "ping") {
			this.pings++;
			this.events.emit("ping");
			this.json(res, { jsonrpc: "2.0", id: msg.id, result: {} });
			return;
		}
		if (msg.method === "tools/list") {
			this.lists++;
			this.events.emit("list");
			const start = Number((msg.params?.cursor as string | undefined) ?? 0);
			const page = this.tools.slice(start, start + this.pageSize).map((t) => ({ ...t, inputSchema: t.inputSchema ?? { type: "object", properties: {} } }));
			const next = start + this.pageSize < this.tools.length ? String(start + this.pageSize) : undefined;
			this.json(res, { jsonrpc: "2.0", id: msg.id, result: { tools: page, ...(next ? { nextCursor: next } : {}) } });
			return;
		}
		if (msg.method === "tools/call") {
			const name = String(msg.params?.name ?? "");
			const args = (msg.params?.arguments as Record<string, unknown> | undefined) ?? {};
			const call: Call = { name, args, session };
			this.calls.push(call);
			this.events.emit("call", call);
			const entry = this.behavior.get(name);
			const b: Behavior = typeof entry === "function" ? entry(args) : (entry ?? { text: `${name} ok` });
			if ("hang" in b) {
				this.hanging.add(res);
				return;
			}
			if ("drop" in b) {
				req.socket.destroy();
				return;
			}
			if ("sseDrop" in b) {
				res.writeHead(200, { "content-type": "text/event-stream" });
				res.write(": working\n\n", () => req.socket.destroy());
				return;
			}
			if ("status" in b) {
				res.writeHead(b.status);
				res.end(b.body ?? "");
				return;
			}
			if ("rpcError" in b) {
				this.json(res, { jsonrpc: "2.0", id: msg.id, error: b.rpcError });
				return;
			}
			if ("delayMs" in b) await new Promise((r) => setTimeout(r, b.delayMs));
			if (!this.running) return;
			const result = "toolError" in b ? { content: [{ type: "text", text: b.toolError }], isError: true } : { content: [{ type: "text", text: b.text }] };
			this.json(res, { jsonrpc: "2.0", id: msg.id, result });
			return;
		}
		this.json(res, { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
	}

	private json(res: ServerResponse, body: unknown, headers: Record<string, string> = {}): void {
		if (res.destroyed) return;
		res.writeHead(200, { "content-type": "application/json", ...headers });
		res.end(JSON.stringify(body));
	}
}

/** A local port nothing listens on (bound, then released). */
export async function closedPort(): Promise<number> {
	const s = createServer();
	await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
	const port = (s.address() as AddressInfo).port;
	await new Promise<void>((r) => s.close(() => r()));
	return port;
}
