// Web and HTTP tools. Credentials never pass through the model: a request names `{{secret:NAME}}` and
// the gateway substitutes the value of environment variable NAME if the bot's config lists it under
// `secrets:`. Known secret values are scrubbed from what the tool returns.
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import type { Feature, LateServices } from "../app.ts";
import { redact, registerSecret } from "../log.ts";
import { isOwnPanel, PANEL_REFUSED } from "./own-gateway.ts";

const MAX_BODY_BYTES = 5 * 1024 * 1024;

export function htmlToText(html: string): string {
	return html
		.replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, " ")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/(p|div|h[1-6]|li|tr|section|article|header|footer|pre|blockquote|table|ul|ol)>/gi, "\n")
		.replace(/<(p|div|h[1-6]|tr|section|article|header|footer|pre|blockquote|table|ul|ol)(\s[^>]*)?>/gi, "\n")
		.replace(/<\/(td|th)>/gi, " | ")
		.replace(/<li[^>]*>/gi, "- ")
		.replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, label: string) => `${label.replace(/<[^>]+>/g, "")} (${href})`)
		.replace(/<[^>]+>/g, "")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/[ \t]+/g, " ")
		.replace(/^ +| +$/gm, "")
		.replace(/\n\s*\n\s*\n+/g, "\n\n")
		.trim();
}

async function readLimited(res: Response, signal: AbortSignal): Promise<{ text: string; truncated: boolean }> {
	const reader = res.body?.getReader();
	if (!reader) return { text: "", truncated: false };
	const chunks: Uint8Array[] = [];
	let size = 0;
	let truncated = false;
	while (!signal.aborted) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.length;
		if (size > MAX_BODY_BYTES) {
			truncated = true;
			await reader.cancel();
			break;
		}
		chunks.push(value);
	}
	return { text: Buffer.concat(chunks).toString("utf8"), truncated };
}

type Outgoing = {
	url: string;
	method: string;
	headers: Record<string, string>;
	body?: string;
	/** Lower-case names of headers whose value carried a substituted secret. */
	secretHeaders: Set<string>;
	secretInUrl: boolean;
	secretInBody: boolean;
	signal: AbortSignal;
	ownPorts: () => number[];
};

const MAX_REDIRECTS = 20;
const BODY_HEADERS = ["content-type", "content-length", "content-encoding", "content-language", "content-location"];
const originOf = (url: string) => new URL(url).origin;

/**
 * fetch with redirects followed here, so each hop is checked against the gateway's own panel and a
 * redirect to another origin never takes a key along: headers that carried a secret (and Authorization,
 * Cookie, Proxy-Authorization, as fetch does) are dropped, and a 307/308 that would resend a key in the
 * body or URL is not followed.
 */
export async function fetchChecked(req: Outgoing): Promise<{ res: Response; note?: string }> {
	let { url, method, body } = req;
	let headers = { ...req.headers };
	let secretInUrl = req.secretInUrl;
	for (let hop = 0; ; hop++) {
		if (await isOwnPanel(url, req.ownPorts())) throw new Error(PANEL_REFUSED);
		const res = await fetch(url, { method, headers, body, signal: req.signal, redirect: "manual" });
		const location = res.headers.get("location");
		if (![301, 302, 303, 307, 308].includes(res.status) || !location) return { res };
		if (hop >= MAX_REDIRECTS) throw new Error("too many redirects");
		const next = new URL(location, url).toString();
		const keep = res.status === 307 || res.status === 308;
		const crossOrigin = originOf(next) !== originOf(url);
		if (crossOrigin && keep && (secretInUrl || (body !== undefined && req.secretInBody))) {
			return { res, note: `not following a redirect to ${originOf(next)} with a key in the request` };
		}
		await res.body?.cancel().catch(() => undefined);
		const toGet = res.status === 303 ? method !== "HEAD" : (res.status === 301 || res.status === 302) && method === "POST";
		if (toGet) {
			method = "GET";
			body = undefined;
			headers = Object.fromEntries(Object.entries(headers).filter(([k]) => !BODY_HEADERS.includes(k.toLowerCase())));
		}
		if (crossOrigin) {
			headers = Object.fromEntries(Object.entries(headers).filter(([k]) => !req.secretHeaders.has(k.toLowerCase()) && !["authorization", "cookie", "proxy-authorization"].includes(k.toLowerCase())));
		}
		secretInUrl = false;
		url = next;
	}
}

export function webFeature(late: LateServices): Feature {
	const allowedSecrets = (conversationId: number): Set<string> => {
		const bot = late.sessions().botOf(conversationId);
		const names = bot?.config.secrets ?? [];
		for (const n of names) registerSecret(process.env[n]);
		return new Set(names);
	};
	const hasSecret = (value: string): boolean => /\{\{secret:[A-Z0-9_]+\}\}/.test(value);
	const substitute = (value: string, allowed: Set<string>): string =>
		value.replace(/\{\{secret:([A-Z0-9_]+)\}\}/g, (_m, name: string) => {
			if (!allowed.has(name)) throw new Error(`secret ${name} is not available to this bot (add it to the bot's secrets list)`);
			const v = process.env[name];
			if (!v) throw new Error(`secret ${name} is not set on the gateway`);
			return v;
		});

	const webFetch = defineTool({
		name: "web_fetch",
		description: "Fetch a web page or text resource over HTTP(S) and return it as readable text (HTML is converted). Use max_chars to limit length.",
		parameters: Type.Object({
			url: Type.String(),
			raw: Type.Optional(Type.Boolean({ description: "Return the body as-is instead of converting HTML to text" })),
			max_chars: Type.Optional(Type.Number()),
		}),
		replay: "safe",
		execute: async (args, _api, ctx) => {
			const signal = AbortSignal.any([AbortSignal.timeout(30_000), ...(ctx.abortSignal ? [ctx.abortSignal] : [])]);
			const { res } = await fetchChecked({
				url: args.url,
				method: "GET",
				headers: { "user-agent": "nHermes/0.1 (+personal assistant)", accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.5" },
				secretHeaders: new Set(),
				secretInUrl: false,
				secretInBody: false,
				signal,
				ownPorts: late.ownPorts,
			});
			const { text, truncated } = await readLimited(res, signal);
			const type = res.headers.get("content-type") ?? "";
			const body = !args.raw && type.includes("html") ? htmlToText(text) : text;
			const limit = Math.min(args.max_chars ?? 20_000, 100_000);
			const out = body.length > limit ? `${body.slice(0, limit)}\n… [${body.length - limit} more characters]` : body;
			return {
				output: [{ type: "text", text: `${res.status} ${res.statusText} ${res.url}\n\n${out}${truncated ? "\n[body over 5 MB, cut]" : ""}` }],
				isError: !res.ok,
			};
		},
	});

	const httpRequest = defineTool({
		name: "http_request",
		description:
			"Make an HTTP request to an API (any method). Put credentials as {{secret:NAME}} in headers or body; the gateway fills " +
			"them in from its own configuration and never shows them. Returns status, content type and body.",
		parameters: Type.Object({
			method: Type.String({ description: "GET, POST, PUT, PATCH, DELETE, …" }),
			url: Type.String(),
			headers: Type.Optional(Type.Record(Type.String(), Type.String())),
			body: Type.Optional(Type.String()),
			timeout_s: Type.Optional(Type.Number()),
		}),
		execute: async (args, api, ctx) => {
			const allowed = allowedSecrets(api.conversationId as number);
			const headers: Record<string, string> = {};
			const secretHeaders = new Set<string>();
			for (const [k, v] of Object.entries(args.headers ?? {})) {
				headers[k] = substitute(v, allowed);
				if (hasSecret(v)) secretHeaders.add(k.toLowerCase());
			}
			const url = substitute(args.url, allowed);
			const timeout = Math.min(Math.max(args.timeout_s ?? 30, 1), 300) * 1000;
			const signal = AbortSignal.any([AbortSignal.timeout(timeout), ...(ctx.abortSignal ? [ctx.abortSignal] : [])]);
			const { res, note } = await fetchChecked({
				url,
				method: args.method.toUpperCase(),
				headers,
				body: args.body === undefined ? undefined : substitute(args.body, allowed),
				secretHeaders,
				secretInUrl: hasSecret(args.url),
				secretInBody: args.body !== undefined && hasSecret(args.body),
				signal,
				ownPorts: late.ownPorts,
			});
			const { text, truncated } = await readLimited(res, signal);
			const out = text.length > 50_000 ? `${text.slice(0, 50_000)}\n… [${text.length - 50_000} more characters]` : text;
			return {
				output: [{ type: "text", text: redact(`${res.status} ${res.statusText}\ncontent-type: ${res.headers.get("content-type") ?? ""}\n\n${out}${truncated ? "\n[body over 5 MB, cut]" : ""}${note ? `\n[${note}]` : ""}`) }],
				isError: res.status >= 400,
			};
		},
	});

	return { groups: new Map([["web", [webFetch, httpRequest] as ToolRegistration[]]]) };
}
