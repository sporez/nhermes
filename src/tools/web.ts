// Web and HTTP tools. Credentials never pass through the model: a request names `{{secret:NAME}}` and
// the gateway substitutes the value of environment variable NAME if the bot's config lists it under
// `secrets:`. Known secret values are scrubbed from what the tool returns.
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import type { Feature, LateServices } from "../app.ts";
import { redact, registerSecret } from "../log.ts";

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

export function webFeature(late: LateServices): Feature {
	const allowedSecrets = (conversationId: number): Set<string> => {
		const bot = late.sessions().botOf(conversationId);
		const names = bot?.config.secrets ?? [];
		for (const n of names) registerSecret(process.env[n]);
		return new Set(names);
	};
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
			const res = await fetch(args.url, { signal, redirect: "follow", headers: { "user-agent": "nhermes/0.1 (+personal assistant)", accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.5" } });
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
			for (const [k, v] of Object.entries(args.headers ?? {})) headers[k] = substitute(v, allowed);
			const url = substitute(args.url, allowed);
			const timeout = Math.min(Math.max(args.timeout_s ?? 30, 1), 300) * 1000;
			const signal = AbortSignal.any([AbortSignal.timeout(timeout), ...(ctx.abortSignal ? [ctx.abortSignal] : [])]);
			const res = await fetch(url, { method: args.method.toUpperCase(), headers, body: args.body === undefined ? undefined : substitute(args.body, allowed), signal });
			const { text, truncated } = await readLimited(res, signal);
			const out = text.length > 50_000 ? `${text.slice(0, 50_000)}\n… [${text.length - 50_000} more characters]` : text;
			return {
				output: [{ type: "text", text: redact(`${res.status} ${res.statusText}\ncontent-type: ${res.headers.get("content-type") ?? ""}\n\n${out}${truncated ? "\n[body over 5 MB, cut]" : ""}`) }],
				isError: res.status >= 400,
			};
		},
	});

	return { groups: new Map([["web", [webFetch, httpRequest] as ToolRegistration[]]]) };
}
