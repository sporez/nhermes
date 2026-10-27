// The live view of a space: Cua's own viewer (a page, gRPC-web calls and one WebSocket, all relative to the page)
// served through the gateway, so the owner watches or takes control from the one gateway the app talks to.
//
// Each view is a grant under a random key: `/spaces/view/<key>/…` on the main port for the owner (a browser
// opening a link cannot send the gateway token, so the key and Cua's ticket in the fragment are the credential),
// or `/federation/spaces/view/<key>/…` on the encrypted port for the one member it was made for. A grant forwards
// to the space's viewer port on this host's loopback, or, when the space is on a member, to that member's
// encrypted route. Only the viewer's page, the gRPC methods a viewer ticket may call (minus files) and the media
// socket pass; cookies and authorization never do. Every response carries `Content-Security-Policy: sandbox`,
// so the page (served from inside a space, which bots use freely) runs in an opaque origin and can never act as
// the panel. A key opens new connections until its ticket expires and lives on while one of its sockets is open.
import { randomBytes } from "node:crypto";
import http, { type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from "node:http";
import https from "node:https";
import net from "node:net";
import type { Duplex } from "node:stream";
import tls, { type ConnectionOptions } from "node:tls";
import { logger } from "../log.ts";
import type { Spaces } from "./spaces.ts";

const log = logger("space-view");

/** Where the owner's views are served on the main port. */
export const VIEW_PREFIX = "/spaces/view/";
/** Where a member's views are served on the encrypted port. */
export const MEMBER_VIEW_PREFIX = "/federation/spaces/view/";

/** The gRPC methods a Cua viewer ticket may call, without the file ones (views are made with files off). */
const VIEWER_METHODS: ReadonlySet<string> = new Set([
	"/cua.env.v1.SystemService/GetCapabilities",
	"/cua.env.v1.SystemService/Health",
	"/cua.env.v1.StreamService/ListTargets",
	"/cua.env.v1.StreamService/OpenMedia",
	"/cua.env.v1.StreamService/SetPreferences",
	"/cua.env.v1.StreamService/RequestKeyframe",
	"/cua.env.v1.StreamService/CloseMedia",
	"/cua.env.v1.ComputerService/ListDisplays",
	"/cua.env.v1.ComputerService/GetClipboard",
	"/cua.env.v1.ComputerService/SetClipboard",
	"/cua.env.v1.PresenceService/Join",
	"/cua.env.v1.PresenceService/UpdateCursor",
	"/cua.env.v1.PresenceService/Leave",
]);
const MEDIA_PATH = "/media";
const PAGE = /^\/viewer(\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*\/?$/;
const KEY = /^[A-Za-z0-9_-]{24}$/;

/** Request headers that reach the space; everything else (cookies, authorization, forwarding headers) is dropped. */
const PASS_HEADERS = [
	"accept",
	"accept-language",
	"content-type",
	"content-length",
	"user-agent",
	"x-grpc-web",
	"x-user-agent",
	"grpc-timeout",
	"x-cua-env-authorization",
	"if-none-match",
	"if-modified-since",
	"sec-websocket-key",
	"sec-websocket-version",
	"sec-websocket-protocol",
	"sec-websocket-extensions",
];

const RESPONSE_HEADERS = {
	"content-security-policy": "sandbox allow-scripts",
	"access-control-allow-origin": "*",
	"access-control-expose-headers": "grpc-status, grpc-message, grpc-status-details-bin",
	"referrer-policy": "no-referrer",
	"x-content-type-options": "nosniff",
	"cache-control": "no-store",
};

type Upstream = { host: string; port: number; prefix: string; tls?: ConnectionOptions };

type Grant = {
	upstream: Upstream;
	expiresAt: number;
	/** The local space it shows; absent when the space is on a member. */
	space?: string;
	/** The view takes the owner's input: while its socket is open, the bot's desktop input there is refused. */
	control?: boolean;
	/** The member this grant was made for: only it may use it, and only on the encrypted port. */
	member?: string;
	sockets: Set<Duplex>;
};

/** Who is asking: the owner on the main port, or a member (by node id) on the encrypted port. */
export type ViewCaller = { member?: string };

export type SpaceViewerDeps = {
	spaces: Spaces;
	/** A member's encrypted address and TLS options, for views of its spaces. */
	memberTarget(nodeId: string): { url: string; tls: ConnectionOptions } | undefined;
	now?: () => number;
};

export class SpaceViewer {
	private readonly grants = new Map<string, Grant>();
	private readonly d: SpaceViewerDeps;
	private readonly now: () => number;

	constructor(deps: SpaceViewerDeps) {
		this.d = deps;
		this.now = deps.now ?? Date.now;
		deps.spaces.onRemoved((id) => {
			for (const [key, g] of this.grants) if (g.space === id) this.drop(key);
		});
	}

	/**
	 * A view of one of a bot's spaces on this gateway: the path to open (relative to the gateway's address, its
	 * fragment holding Cua's ticket) and when it stops opening new connections. With `member`, the view is that
	 * member's, served on the encrypted port.
	 */
	async open(bot: string, space: string, opts: { control: boolean; member?: string }): Promise<{ path: string; expiresAt: number }> {
		const link = await this.d.spaces.viewLink(bot, space, opts.control);
		const key = this.grant({ upstream: { host: "127.0.0.1", port: link.port, prefix: "" }, expiresAt: link.expiresAt, space, control: opts.control, ...(opts.member ? { member: opts.member } : {}) });
		log.info("space view opened", { space, bot, control: opts.control, ...(opts.member ? { member: opts.member } : {}) });
		return { path: `${opts.member ? MEMBER_VIEW_PREFIX : VIEW_PREFIX}${key}/viewer/#${link.fragment}`, expiresAt: link.expiresAt };
	}

	/** Serves a member's view (the path it answered, on its encrypted route) to the owner here; returns the path here. */
	relay(nodeId: string, memberPath: string, expiresAt: number): { path: string; expiresAt: number } {
		const m = new RegExp(`^${MEMBER_VIEW_PREFIX}([A-Za-z0-9_-]{24})/viewer/#(.+)$`).exec(memberPath);
		const target = this.d.memberTarget(nodeId);
		if (!m || !target) throw new Error("The other machine gave a view nHermes could not use.");
		const u = new URL(target.url);
		const key = this.grant({ upstream: { host: u.hostname.replace(/^\[|\]$/g, ""), port: Number(u.port), prefix: `${MEMBER_VIEW_PREFIX}${m[1]}`, tls: target.tls }, expiresAt });
		return { path: `${VIEW_PREFIX}${key}/viewer/#${m[2]}`, expiresAt };
	}

	/** An HTTP request under VIEW_PREFIX (owner) or MEMBER_VIEW_PREFIX (`caller.member` set). */
	serve(req: IncomingMessage, res: ServerResponse, pathname: string, search: string, caller: ViewCaller): void {
		const found = this.route(pathname, caller);
		const method = req.method ?? "GET";
		if (!found) return void notFound(res);
		const { grant, rest } = found;
		const rpc = VIEWER_METHODS.has(rest);
		if (rpc && method === "OPTIONS") {
			res.writeHead(204, { ...RESPONSE_HEADERS, "access-control-allow-methods": "POST", "access-control-allow-headers": allowHeaders(req), "access-control-max-age": "600" });
			return void res.end();
		}
		if (!(rpc && method === "POST") && !(PAGE.test(rest) && (method === "GET" || method === "HEAD"))) return void notFound(res);
		const { upstream } = grant;
		const options = {
			host: upstream.host,
			port: upstream.port,
			method,
			path: upstream.prefix + rest + (rpc ? "" : search),
			headers: passHeaders(req, upstream),
			agent: false as const,
			...(upstream.tls ?? {}),
		};
		const up = (upstream.tls ? https : http).request(options, (r) => {
			const headers: OutgoingHttpHeaders = {};
			for (const [k, v] of Object.entries(r.headers)) if (k !== "set-cookie" && !k.startsWith("access-control-") && v !== undefined) headers[k] = v;
			res.writeHead(r.statusCode ?? 502, { ...headers, ...RESPONSE_HEADERS });
			r.pipe(res);
		});
		up.on("error", () => {
			if (!res.headersSent) res.writeHead(502, RESPONSE_HEADERS);
			res.end();
		});
		res.on("close", () => up.destroy());
		req.pipe(up);
	}

	/** A WebSocket upgrade under the same prefixes: only the media socket passes. */
	upgrade(req: IncomingMessage, socket: Duplex, head: Buffer, pathname: string, search: string, caller: ViewCaller): void {
		const found = this.route(pathname, caller);
		if (!found || found.rest !== MEDIA_PATH || req.method !== "GET") {
			socket.end("HTTP/1.1 404 Not Found\r\nconnection: close\r\n\r\n");
			return;
		}
		const { grant } = found;
		const { upstream } = grant;
		const lines = [`GET ${upstream.prefix}${MEDIA_PATH}${search} HTTP/1.1`];
		for (const [k, v] of Object.entries(passHeaders(req, upstream))) lines.push(`${k}: ${String(v)}`);
		lines.push("connection: Upgrade", "upgrade: websocket");
		const up = upstream.tls ? tls.connect({ ...upstream.tls, host: upstream.host, port: upstream.port }) : net.connect(upstream.port, upstream.host);
		const release = grant.space ? this.d.spaces.watch(grant.space, { control: grant.control === true }) : undefined;
		grant.sockets.add(socket);
		const done = () => {
			grant.sockets.delete(socket);
			release?.();
			up.destroy();
			socket.destroy();
		};
		up.once(upstream.tls ? "secureConnect" : "connect", () => {
			up.write(`${lines.join("\r\n")}\r\n\r\n`);
			if (head.length) up.write(head);
			up.pipe(socket);
			socket.pipe(up);
		});
		up.on("error", done);
		up.on("close", done);
		socket.on("error", done);
		socket.on("close", done);
	}

	/** Closes the open views a member made over a key that no longer works (it left, or its key was replaced). */
	dropMember(stillValid: (nodeId: string) => boolean): void {
		for (const [key, g] of this.grants) if (g.member && !stillValid(g.member)) this.drop(key);
	}

	close(): void {
		for (const key of [...this.grants.keys()]) this.drop(key);
	}

	private grant(g: Omit<Grant, "sockets">): string {
		this.prune();
		let key = randomBytes(18).toString("base64url");
		while (this.grants.has(key)) key = randomBytes(18).toString("base64url");
		this.grants.set(key, { ...g, sockets: new Set() });
		return key;
	}

	/** The grant a path names, for this caller, and the rest of the path after its key. */
	private route(pathname: string, caller: ViewCaller): { grant: Grant; rest: string } | undefined {
		const prefix = caller.member ? MEMBER_VIEW_PREFIX : VIEW_PREFIX;
		if (!pathname.startsWith(prefix)) return undefined;
		const tail = pathname.slice(prefix.length);
		const slash = tail.indexOf("/");
		const key = slash < 0 ? tail : tail.slice(0, slash);
		if (!KEY.test(key)) return undefined;
		const grant = this.grants.get(key);
		if (!grant || grant.member !== caller.member) return undefined;
		if (grant.expiresAt <= this.now() && grant.sockets.size === 0) {
			this.drop(key);
			return undefined;
		}
		return { grant, rest: slash < 0 ? "/" : tail.slice(slash) };
	}

	private prune(): void {
		const now = this.now();
		for (const [key, g] of this.grants) if (g.expiresAt <= now && g.sockets.size === 0) this.grants.delete(key);
	}

	private drop(key: string): void {
		const g = this.grants.get(key);
		if (!g) return;
		this.grants.delete(key);
		for (const s of g.sockets) s.destroy();
	}
}

function passHeaders(req: IncomingMessage, upstream: Upstream): OutgoingHttpHeaders {
	const out: OutgoingHttpHeaders = { host: `${upstream.host.includes(":") ? `[${upstream.host}]` : upstream.host}:${upstream.port}` };
	for (const name of PASS_HEADERS) {
		const v = req.headers[name];
		if (v !== undefined) out[name] = v;
	}
	return out;
}

/** The headers a preflight asks for, kept to header-name characters. */
function allowHeaders(req: IncomingMessage): string {
	const asked = req.headers["access-control-request-headers"];
	return typeof asked === "string" ? asked.replace(/[^A-Za-z0-9,\- ]/g, "").slice(0, 500) : "";
}

function notFound(res: ServerResponse): void {
	res.writeHead(404, { "content-type": "text/plain; charset=utf-8", ...RESPONSE_HEADERS });
	res.end("This view has ended. Open the space again from the chat.");
}
