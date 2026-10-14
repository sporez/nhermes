// The Hermes-compatible HTTP + WebSocket server. Auth is the Hermes session-token mode:
// `X-Hermes-Session-Token` on HTTP, `?token=` on the WebSocket. Wrong or missing: 401 / close 4401.
import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import type { Core } from "../app.ts";
import { UnknownBot } from "../core/bots.ts";
import { UnknownSession } from "../core/sessions.ts";
import { logger } from "../log.ts";
import { HttpError, readJson, type Router, sendJson } from "./http.ts";
import { restRoutes } from "./rest.ts";
import { Connection } from "./ws.ts";

const log = logger("http");

const PUBLIC = new Set(["/api/status", "/api/health"]);

function tokenMatches(given: string | null | undefined, expected: string): boolean {
	if (!given) return false;
	const a = Buffer.from(given);
	const b = Buffer.from(expected);
	return a.length === b.length && timingSafeEqual(a, b);
}

function requestToken(req: IncomingMessage, url: URL): string | null {
	const header = req.headers["x-hermes-session-token"];
	if (typeof header === "string") return header;
	const auth = req.headers.authorization;
	if (typeof auth === "string" && auth.startsWith("Bearer ")) return auth.slice(7);
	return url.searchParams.get("token");
}

export type HermesServer = { server: Server; port: number; close(): Promise<void> };

/** Extra route sets (the admin API) mounted before the Hermes routes. */
export async function startHermesServer(core: Core, opts: { host: string; port: number; extraRouters?: Router[] }): Promise<HermesServer> {
	const routers = [...(opts.extraRouters ?? []), restRoutes(core)];
	const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
	const server = createServer(async (req, res) => {
		const url = new URL(req.url ?? "/", "http://localhost");
		const method = req.method ?? "GET";
		try {
			if (!PUBLIC.has(url.pathname) && !tokenMatches(requestToken(req, url), core.config.token)) {
				throw new HttpError(401, "Unauthorized");
			}
			let matched: ReturnType<Router["match"]>;
			for (const r of routers) {
				matched = r.match(method, url.pathname);
				if (matched) break;
			}
			if (matched === undefined) throw new HttpError(404, "Not Found");
			if (matched === "method") throw new HttpError(405, "Method Not Allowed");
			const body = await readJson(req);
			const result = await matched.handler({ method, path: url.pathname, query: url.searchParams, params: matched.params, body, raw: req });
			sendJson(res, 200, result ?? {});
		} catch (error) {
			if (error instanceof HttpError) return sendJson(res, error.status, { detail: error.message });
			if (error instanceof UnknownSession) return sendJson(res, 404, { detail: "Session not found" });
			if (error instanceof UnknownBot) return sendJson(res, 404, { detail: error.message });
			log.error("request failed", { method, path: url.pathname, error: error instanceof Error ? error.message : String(error) });
			sendJson(res, 500, { detail: "Internal server error" });
		}
	});

	server.on("upgrade", (req, socket, head) => {
		const url = new URL(req.url ?? "/", "http://localhost");
		if (url.pathname !== "/api/ws") {
			socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
			socket.destroy();
			return;
		}
		wss.handleUpgrade(req, socket, head, (ws) => {
			if (!tokenMatches(requestToken(req, url), core.config.token)) {
				ws.close(4401, "invalid session token");
				return;
			}
			new Connection(ws, core);
		});
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(opts.port, opts.host, () => resolve());
	});
	const port = (server.address() as AddressInfo).port;
	log.info("listening", { host: opts.host, port });
	return {
		server,
		port,
		close: () =>
			new Promise<void>((resolve) => {
				for (const c of wss.clients) c.terminate();
				wss.close();
				server.close(() => resolve());
				server.closeAllConnections();
			}),
	};
}
