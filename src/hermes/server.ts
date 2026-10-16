// The Hermes-compatible HTTP + WebSocket server. Auth is the Hermes session-token mode:
// `X-Hermes-Session-Token` on HTTP, `?token=` on the WebSocket. Wrong or missing: 401 / close 4401.
// A second listener, the encrypted port, serves only network members over TLS-PSK
// (src/federation/psk.ts): `/federation/*` and the member WebSocket, identified by the handshake.
import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createTlsServer } from "node:https";
import type { AddressInfo, Socket } from "node:net";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import type { Core } from "../app.ts";
import { UnknownBot } from "../core/bots.ts";
import { UnknownSession } from "../core/sessions.ts";
import { type MemberRow, NODE_HEADER, SECRET_HEADER } from "../federation/members.ts";
import { manageRoutes } from "../federation/manage.ts";
import { forwardVory, voryMemberRoutes } from "../federation/vory.ts";
import { PSK_TLS } from "../federation/psk.ts";
import { federationRoutes, OPEN_FEDERATION_PATHS } from "../federation/routes.ts";
import { Panel } from "../panel/panel.ts";
import { logger } from "../log.ts";
import { HttpError, RawBody, readJson, type Router, sendJson, sendRaw } from "./http.ts";
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

export type HermesServer = { server: Server; port: number; pskPort: number | null; close(): Promise<void>; dropConnections(): void };

/** How many ports up from the default the encrypted listener tries before giving up. */
const PSK_PORT_TRIES = 10;

/**
 * Extra route sets (the admin API) mounted before the Hermes routes. `federationPort`: the encrypted port
 * as configured (used as given); without it, main port + 1000 or the next free one; null turns it off.
 */
export async function startHermesServer(core: Core, opts: { host: string; port: number; federationPort?: number | null; extraRouters?: Router[] }): Promise<HermesServer> {
	const federation = [federationRoutes(core), manageRoutes(core), voryMemberRoutes(core)];
	const panel = new Panel(core);
	const routers = [...(opts.extraRouters ?? []), restRoutes(core)];
	const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
	// The handshake identity of each encrypted connection, for its requests.
	const identities = new WeakMap<object, string>();

	/** A plain request from a member is refused once it has reached us encrypted, or when the owner refuses them all. */
	const plainMember = (req: IncomingMessage): MemberRow | undefined => {
		const member = core.members.verify(header(req, NODE_HEADER), header(req, SECRET_HEADER));
		if (member && (member.psk_inbound || core.members.requiresPsk())) throw new HttpError(403, `${core.members.self().name} takes requests from ${member.name} only on its encrypted port`);
		return member;
	};

	const handle = async (req: IncomingMessage, res: ServerResponse, psk?: string) => {
		const url = new URL(req.url ?? "/", "http://localhost");
		const method = req.method ?? "GET";
		const encrypted = psk !== undefined;
		// The encrypted port is for members only.
		if (!encrypted) {
			// The web control panel has its own access rules (src/panel/panel.ts).
			if (url.pathname === "/panel" || url.pathname.startsWith("/panel/")) return panel.handle(req, res, url);
			if (url.pathname === "/" && method === "GET" && core.config.panel.enabled) {
				res.writeHead(302, { location: "/panel/" });
				return void res.end();
			}
		}
		try {
			// Members reach only /federation/*; everything else takes the gateway token.
			let member: MemberRow | undefined;
			const isFederation = url.pathname.startsWith("/federation/");
			if (encrypted && !isFederation) throw new HttpError(404, "Not Found");
			if (isFederation) {
				if (encrypted && psk.startsWith("i:")) {
					// A joiner's connection, keyed by its invite: it can only join.
					if (url.pathname !== "/federation/join" && url.pathname !== "/federation/hello") throw new HttpError(401, "Unauthorized");
				} else if (!OPEN_FEDERATION_PATHS.has(url.pathname)) {
					member = encrypted ? core.members.pskMember(psk) : plainMember(req);
					if (!member) throw new HttpError(401, "Unauthorized");
				}
			} else if (!PUBLIC.has(url.pathname) && !tokenMatches(requestToken(req, url), core.config.token)) {
				throw new HttpError(401, "Unauthorized");
			}
			let matched: ReturnType<Router["match"]>;
			for (const r of isFederation ? federation : routers) {
				matched = r.match(method, url.pathname);
				if (matched) break;
			}
			if (matched === undefined) throw new HttpError(404, "Not Found");
			if (matched === "method") throw new HttpError(405, "Method Not Allowed");
			const body = await readJson(req);
			// Settings of a member's bot are answered by the member that owns it.
			const forwarded = isFederation ? undefined : await forwardVory(core, method, url, body);
			if (forwarded !== undefined) return sendJson(res, 200, forwarded);
			const result = await matched.handler({ method, path: url.pathname, query: url.searchParams, params: matched.params, body, raw: req, member, psk });
			if (result instanceof RawBody) return sendRaw(res, result);
			sendJson(res, 200, result ?? {});
		} catch (error) {
			if (error instanceof HttpError) return sendJson(res, error.status, { detail: error.message });
			if (error instanceof UnknownSession) return sendJson(res, 404, { detail: "Session not found" });
			if (error instanceof UnknownBot) return sendJson(res, 404, { detail: error.message });
			log.error("request failed", { method, path: url.pathname, error: error instanceof Error ? error.message : String(error) });
			sendJson(res, 500, { detail: "Internal server error" });
		}
	};

	const upgrade = (req: IncomingMessage, socket: Duplex, head: Buffer, psk?: string) => {
		const url = new URL(req.url ?? "/", "http://localhost");
		if (url.pathname !== "/api/ws") {
			socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
			socket.destroy();
			return;
		}
		wss.handleUpgrade(req, socket, head, (ws) => {
			// A network member drives this gateway's shareable bots, within the limits Connection sets for it.
			if (psk !== undefined) {
				const member = core.members.pskMember(psk);
				return void (member ? new Connection(ws, core, member) : ws.close(4401, "not a member"));
			}
			if (tokenMatches(requestToken(req, url), core.config.token)) return void new Connection(ws, core);
			let member: MemberRow | undefined;
			try {
				member = plainMember(req);
			} catch {
				return void ws.close(4403, "use the encrypted port");
			}
			if (member) return void new Connection(ws, core, member);
			ws.close(4401, "invalid session token");
		});
	};

	const server = createServer((req, res) => void handle(req, res));
	server.on("upgrade", (req, socket, head) => upgrade(req, socket, head));
	await listen(server, opts.port, opts.host);
	const port = (server.address() as AddressInfo).port;
	core.members.setListenPort(port);
	log.info("listening", { host: opts.host, port });

	const tls =
		opts.federationPort === null
			? undefined
			: createTlsServer({
					...PSK_TLS,
					pskCallback: (socket, identity) => {
						const key = core.members.pskKey(identity);
						if (key) identities.set(socket, identity);
						return key;
					},
				});
	let pskPort: number | null = null;
	if (tls) {
		tls.on("request", (req, res) => void handle(req, res, identities.get(req.socket)));
		tls.on("upgrade", (req, socket, head) => upgrade(req, socket, head, identities.get(req.socket as Socket)));
		tls.on("tlsClientError", (error) => log.debug("encrypted handshake refused", { error: error.message }));
		pskPort = await listenFree(tls, opts.federationPort ?? undefined, opts.port === 0 ? 0 : port + 1000, opts.host).catch((error: unknown) => {
			// Do not leave the main port open behind a failed start.
			server.close();
			server.closeAllConnections();
			throw error;
		});
		core.members.setPskPort(pskPort);
		log.info("listening encrypted (members)", { host: opts.host, port: pskPort });
	}
	return {
		server,
		port,
		pskPort,
		dropConnections: () => {
			for (const c of wss.clients) c.terminate();
		},
		close: () =>
			new Promise<void>((resolve) => {
				for (const c of wss.clients) c.terminate();
				wss.close();
				let open = tls ? 2 : 1;
				const done = () => --open === 0 && resolve();
				server.close(done);
				server.closeAllConnections();
				if (tls) {
					tls.close(done);
					tls.closeAllConnections();
				}
			}),
	};
}

function listen(server: Server, port: number, host: string): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, host, () => {
			server.off("error", reject);
			resolve();
		});
	});
}

/** A configured port is used as given; the default one moves up to the next free port. */
async function listenFree(server: Server, configured: number | undefined, fallback: number, host: string): Promise<number> {
	if (configured !== undefined) {
		await listen(server, configured, host);
		return (server.address() as AddressInfo).port;
	}
	for (let i = 0; ; i++) {
		try {
			await listen(server, fallback === 0 ? 0 : fallback + i, host);
			return (server.address() as AddressInfo).port;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE" || fallback === 0 || i + 1 >= PSK_PORT_TRIES) throw error;
			log.info("encrypted port taken; trying the next", { port: fallback + i });
		}
	}
}
