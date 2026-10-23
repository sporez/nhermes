// Minimal HTTP plumbing shared by the routes: JSON bodies, errors, a tiny router.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { MemberRow } from "./federation/members.ts";

export class HttpError extends Error {
	readonly status: number;
	constructor(status: number, detail: string) {
		super(detail);
		this.status = status;
	}
}

export type Req = {
	method: string;
	path: string;
	query: URLSearchParams;
	params: Record<string, string>;
	body: unknown;
	raw: IncomingMessage;
	/** The network member a `/federation/*` request comes from (checked by the server). */
	member?: MemberRow;
	/** The TLS-PSK handshake identity when the request came over the encrypted port (src/federation/psk.ts). */
	psk?: string;
};

export type Handler = (req: Req) => unknown | Promise<unknown>;

/** A handler result sent as bytes rather than JSON (file downloads). */
export class RawBody {
	readonly data: Buffer;
	readonly type: string;
	readonly filename: string;
	constructor(data: Buffer, type: string, filename: string) {
		this.data = data;
		this.type = type;
		this.filename = filename;
	}
}

export function sendRaw(res: ServerResponse, body: RawBody): void {
	res.writeHead(200, {
		"content-type": body.type,
		"content-length": body.data.length,
		"cache-control": "no-store",
		"content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(body.filename)}`,
		"x-content-type-options": "nosniff",
	});
	res.end(body.data);
}

type Route = { method: string; re: RegExp; keys: string[]; handler: Handler };

export class Router {
	private readonly routes: Route[] = [];

	on(method: string, pattern: string, handler: Handler): this {
		const keys: string[] = [];
		const re = new RegExp(
			"^" +
				pattern.replace(/\//g, "\\/").replace(/:(\w+)/g, (_m, k: string) => {
					keys.push(k);
					return "([^/]+)";
				}) +
				"$",
		);
		this.routes.push({ method, re, keys, handler });
		return this;
	}

	match(method: string, path: string): { handler: Handler; params: Record<string, string> } | "method" | undefined {
		let pathMatched = false;
		for (const r of this.routes) {
			const m = r.re.exec(path);
			if (!m) continue;
			pathMatched = true;
			if (r.method !== method) continue;
			const params: Record<string, string> = {};
			r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1]!)));
			return { handler: r.handler, params };
		}
		return pathMatched ? "method" : undefined;
	}
}

const MAX_BODY = 1024 * 1024;

export async function readJson(req: IncomingMessage): Promise<unknown> {
	if (req.method === "GET" || req.method === "HEAD") return undefined;
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		size += (chunk as Buffer).length;
		if (size > MAX_BODY) throw new HttpError(413, "Request body too large");
		chunks.push(chunk as Buffer);
	}
	if (size === 0) return undefined;
	const text = Buffer.concat(chunks).toString("utf8");
	const type = req.headers["content-type"] ?? "";
	if (!type.includes("json") && !text.trimStart().startsWith("{") && !text.trimStart().startsWith("[")) return text;
	try {
		return JSON.parse(text);
	} catch {
		throw new HttpError(400, "Invalid JSON body");
	}
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
	const data = JSON.stringify(body);
	res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-length": Buffer.byteLength(data) });
	res.end(data);
}

export function obj(v: unknown): Record<string, unknown> {
	return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
