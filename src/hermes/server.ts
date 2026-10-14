// The Hermes-compatible HTTP + WebSocket server. Auth is the Hermes session-token mode:
// `X-Hermes-Session-Token` on HTTP, `?token=` on the WebSocket. Wrong or missing: 401 / close 4401.
import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import type { Core } from "../app.ts";
import { UnknownBot } from "../core/bots.ts";
import { UnknownSession } from "../core/sessions.ts";
import { type MemberRow, NODE_HEADER, SECRET_HEADER } from "../federation/members.ts";
import { federationRoutes, OPEN_FEDERATION_PATHS } from "../federation/routes.ts";
import { Panel } from "../panel/panel.ts";
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

function header(req: IncomingMessage, name: string): string | undefined {
	const v = req.headers[name];
	return typeof v === "string" ? v : undefined;
}

export type HermesServer = { server: Server; port: number; close(): Promise<void>; dropConnections(): void };

/** Extra route sets (the admin API) mounted before the Hermes routes. */
export async function startHermesServer(core: Core, opts: { host: string; port: number; extraRouters?: Router[] }): Promise<HermesServer> {
	const federation = federationRoutes(core);
	const panel = new Panel(core);
	const routers = [...(opts.extraRouters ?? []), restRoutes(core)];
	const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
	const server = createServer(async (req, res) => {
		const url = new URL(req.url ?? "/", "http://localhost");
		const method = req.method ?? "GET";
		// The web control panel has its own access rules (src/panel/panel.ts).
		if (url.pathname === "/panel" || url.pathname.startsWith("/panel/")) return panel.handle(req, res, url);
		if (url.pathname === "/" && method === "GET" && core.config.panel.enabled) {
			res.writeHead(302, { location: "/panel/" });
			return void res.end();
		}
		try {
			// Members reach only /federation/*, with their pair secret; everything else takes the gateway token.
			let member: MemberRow | undefined;
			const isFederation = url.pathname.startsWith("/federation/");
			if (isFederation) {
				if (!OPEN_FEDERATION_PATHS.has(url.pathname)) {
					member = core.members.verify(header(req, NODE_HEADER), header(req, SECRET_HEADER));
					if (!member) throw new HttpError(401, "Unauthorized");
				}
			} else if (!PUBLIC.has(url.pathname) && !tokenMatches(requestToken(req, url), core.config.token)) {
				throw new HttpError(401, "Unauthorized");
			}
			let matched: ReturnType<Router["match"]>;
			for (const r of isFederation ? [federation] : routers) {
				matched = r.match(method, url.pathname);
				if (matched) break;
			}
			if (matched === undefined) throw new HttpError(404, "Not Found");
			if (matched === "method") throw new HttpError(405, "Method Not Allowed");
			const body = await readJson(req);
			const result = await matched.handler({ method, path: url.pathname, query: url.searchParams, params: matched.params, body, raw: req, member });
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
			if (tokenMatches(requestToken(req, url), core.config.token)) return void new Connection(ws, core);
			// A network member drives this gateway's shareable bots, within the limits Connection sets for it.
			const member = core.members.verify(header(req, NODE_HEADER), header(req, SECRET_HEADER));
			if (member) return void new Connection(ws, core, member);
			ws.close(4401, "invalid session token");
		});
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(opts.port, opts.host, () => resolve());
	});
	const port = (server.address() as AddressInfo).port;
	core.members.setListenPort(port);
	log.info("listening", { host: opts.host, port });
	return {
		server,
		port,
		dropConnections: () => {
			for (const c of wss.clients) c.terminate();
		},
		close: () =>
			new Promise<void>((resolve) => {
				for (const c of wss.clients) c.terminate();
				wss.close();
				server.close(() => resolve());
				server.closeAllConnections();
			}),
	};
}
