// The gateway's listeners. The main port serves the panel, the client API (`/api/v1`, src/api/), the admin
// routes the CLI uses, and `/api/health` (no token) for installers and service checks. Everything else takes
// the gateway token as `Authorization: Bearer`. Wrong or missing: 401 / close 4401. Live views of spaces
// (`/spaces/view/<key>/…`, src/spaces/viewer.ts) take no token: a browser opening a link cannot send one, so their
// random key and Cua's ticket are the credential. A second listener, the encrypted port, serves only network
// members over TLS-PSK (src/federation/psk.ts): `/federation/*` (with the views made for that member) and the
// client API's socket, identified by the handshake.
import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createTlsServer } from "node:https";
import type { AddressInfo, Socket } from "node:net";
import type { Duplex } from "node:stream";
import { type WebSocket, WebSocketServer } from "ws";
import type { Core } from "./app.ts";
import { UnknownBot } from "./core/bots.ts";
import { UnknownSession } from "./core/sessions.ts";
import type { MemberRow } from "./federation/members.ts";
import { loginRoutes } from "./federation/logins.ts";
import { manageRoutes } from "./federation/manage.ts";
import { PSK_TLS } from "./federation/psk.ts";
import { federationRoutes, KEY_CHANGING_PATHS, KEY_CHANGING_PREFIXES, OPEN_FEDERATION_PATHS } from "./federation/routes.ts";
import { Panel } from "./panel/panel.ts";
import { MEMBER_VIEW_PREFIX, VIEW_PREFIX } from "./spaces/viewer.ts";
import { API_PREFIX, ClientApi, type ClientApiOptions } from "./api/server.ts";
import { logger } from "./log.ts";
import { HttpError, RawBody, readJson, type Router, sendJson, sendRaw } from "./http.ts";
import { VERSION } from "./version.ts";

const log = logger("http");

function tokenMatches(given: string | null | undefined, expected: string): boolean {
	if (!given) return false;
	const a = Buffer.from(given);
	const b = Buffer.from(expected);
	return a.length === b.length && timingSafeEqual(a, b);
}

function bearerToken(req: IncomingMessage): string | null {
	const auth = req.headers.authorization;
	return typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7) : null;
}

export type GatewayServer = { server: Server; port: number; pskPort: number | null; api: ClientApi; close(): Promise<void>; dropConnections(): void };

/** How many ports up from the default the encrypted listener tries before giving up. */
const PSK_PORT_TRIES = 10;

/**
 * Extra route sets (the admin API) take the gateway token. `federationPort`: the encrypted port
 * as configured (used as given); without it, main port + 1000 or the next free one; null turns it off.
 */
export async function startServer(core: Core, opts: { host: string; port: number; federationPort?: number | null; extraRouters?: Router[]; api?: ClientApiOptions }): Promise<GatewayServer> {
	const federation = [federationRoutes(core), manageRoutes(core), loginRoutes(core)];
	const panel = new Panel(core);
	const api = new ClientApi(core, opts.api);
	const routers = opts.extraRouters ?? [];
	const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
	// The handshake identity of each encrypted connection, for its requests.
	const identities = new WeakMap<object, string>();
	// Member sockets are authenticated once, at the upgrade: close them when the member is forgotten or the key they used stops working.
	const memberSockets = new Map<WebSocket, string>();
	core.members.onRevoke(() => {
		for (const [ws, identity] of memberSockets) if (!core.members.pskKey(identity)) ws.close(4401, "no longer a member");
	});

	const handle = async (req: IncomingMessage, res: ServerResponse, psk?: string) => {
		const url = new URL(req.url ?? "/", "http://localhost");
		const method = req.method ?? "GET";
		const encrypted = psk !== undefined;
		const view = viewCaller(url.pathname, psk);
		if (view === null) return sendJson(res, 401, { detail: "Unauthorized" });
		if (view) return core.viewer.serve(req, res, url.pathname, url.search, view);
		// The encrypted port is for members only.
		if (!encrypted) {
			// The web control panel has its own access rules (src/panel/panel.ts).
			if (url.pathname === "/panel" || url.pathname.startsWith("/panel/")) return panel.handle(req, res, url);
			if (url.pathname === "/" && method === "GET" && core.config.panel.enabled) {
				res.writeHead(302, { location: "/panel/" });
				return void res.end();
			}
		}
		if (!encrypted && url.pathname === "/api/health" && method === "GET") return sendJson(res, 200, { ok: true, version: VERSION });
		if (!encrypted && ClientApi.owns(url.pathname)) {
			if (!tokenMatches(bearerToken(req), core.config.token)) return sendJson(res, 401, { error: { code: "unauthorized", message: "This gateway needs its token (Authorization: Bearer)." } });
			return api.handle(req, res, url, { kind: "owner" });
		}
		try {
			// Members reach only /federation/*, and only on the encrypted port; everything else takes the gateway token.
			let member: MemberRow | undefined;
			const isFederation = url.pathname.startsWith("/federation/");
			if (encrypted !== isFederation) throw new HttpError(404, "Not Found");
			if (isFederation) {
				if (encrypted && psk.startsWith("i:")) {
					// A joiner's connection, keyed by its invite: it can only join.
					if (url.pathname !== "/federation/join" && url.pathname !== "/federation/hello") throw new HttpError(401, "Unauthorized");
				} else if (!OPEN_FEDERATION_PATHS.has(url.pathname)) {
					member = core.members.pskMember(psk!);
					if (!member) throw new HttpError(401, "Unauthorized");
					// The previous key only keeps links alive during the grace; it cannot change the pair.
					if ((KEY_CHANGING_PATHS.has(url.pathname) || KEY_CHANGING_PREFIXES.some((p) => url.pathname.startsWith(p))) && core.members.usesReplacedKey(psk!)) throw new HttpError(403, "this connection uses a replaced key; reconnect");
				}
			} else if (!tokenMatches(bearerToken(req), core.config.token)) {
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

	/** Whom a space view is for: the owner on the main port, a member on the encrypted one; null for a forgotten member; undefined when the path is no view. */
	const viewCaller = (pathname: string, psk: string | undefined): { member?: string } | null | undefined => {
		if (psk === undefined) return pathname.startsWith(VIEW_PREFIX) ? {} : undefined;
		if (!pathname.startsWith(MEMBER_VIEW_PREFIX)) return undefined;
		const member = core.members.pskMember(psk);
		return member ? { member: member.node_id } : null;
	};

	const upgrade = (req: IncomingMessage, socket: Duplex, head: Buffer, psk?: string) => {
		const url = new URL(req.url ?? "/", "http://localhost");
		const view = viewCaller(url.pathname, psk);
		if (view === null) return void socket.end("HTTP/1.1 401 Unauthorized\r\nconnection: close\r\n\r\n");
		if (view) return core.viewer.upgrade(req, socket, head, url.pathname, url.search, view);
		if (url.pathname === `${API_PREFIX}/ws`) {
			return wss.handleUpgrade(req, socket, head, (ws) => {
				if (psk !== undefined) {
					const member = core.members.pskMember(psk);
					if (!member) return void ws.close(4401, "not a member");
					memberSockets.set(ws, psk);
					ws.on("close", () => memberSockets.delete(ws));
					return void api.connect(ws, { kind: "member", member });
				}
				if (!tokenMatches(bearerToken(req), core.config.token)) return void ws.close(4401, "invalid token");
				api.connect(ws, { kind: "owner" });
			});
		}
		socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
		socket.destroy();
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
					// A client that never finishes the handshake must not hold a socket open.
					handshakeTimeout: 10_000,
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
		api,
		dropConnections: () => {
			for (const c of wss.clients) c.terminate();
		},
		close: () =>
			new Promise<void>((resolve) => {
				for (const c of wss.clients) c.terminate();
				wss.close();
				api.close();
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
