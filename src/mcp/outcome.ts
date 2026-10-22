// What happened to one MCP request, worked out from the error pi-mcp raised (shapes pinned in
// test/upstream/mcp-contract.test.ts). The point is the `sent` column: "no" only when the server
// provably did not run the request (it was never sent, or the server refused it); "unknown" whenever
// the request may have reached the tool. Nothing here retries anything.
import { McpAbortError, McpAuthRequiredError, McpConnectionClosedError, McpError, McpHttpError, McpSessionExpiredError, McpTimeoutError } from "@earendil-works/pi-mcp";

export type OutcomeKind =
	| "ok"
	/** Not connected (and a quick reconnect failed): never sent. */
	| "offline"
	/** The connection could not be made when sending: never sent. */
	| "not_sent"
	/** The server refused the gateway's credentials (or a key is missing): not run. */
	| "auth"
	/** The server refused the request (rate limit, bad request, unknown tool, invalid arguments): not run. */
	| "rejected"
	/** The server ran the tool and reports that it failed (`isError: true`). */
	| "tool_error"
	/** The server answered with an error that does not say whether the tool ran. */
	| "server_error"
	/** The connection dropped after the request was sent. */
	| "lost"
	| "timeout"
	/** The owner interrupted the run after the request was sent. */
	| "cancelled"
	/** The server is set up wrong (protocol version, URL), so nothing is sent. */
	| "misconfigured"
	/** The session expired; the request was not processed and may be sent once more on a new session. */
	| "session_expired";

export type Sent = "no" | "yes" | "unknown";

export type Classified = { kind: OutcomeKind; sent: Sent; message: string; httpStatus?: number; rpcCode?: number };

/** Network errors raised before a request could leave this machine. */
const NOT_SENT_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EHOSTUNREACH", "ENETUNREACH", "EAI_AGAIN", "EADDRNOTAVAIL", "UND_ERR_CONNECT_TIMEOUT", "ERR_INVALID_URL"]);

/** JSON-RPC errors that mean the server did not run the request. */
const REFUSED_RPC = new Set([-32700, -32600, -32601, -32602]);

function causeCode(error: unknown): string {
	const cause = (error as { cause?: { code?: unknown } } | undefined)?.cause;
	return typeof cause?.code === "string" ? cause.code : "";
}

function causeMessage(error: unknown): string {
	const cause = (error as { cause?: { message?: unknown } } | undefined)?.cause;
	return typeof cause?.message === "string" ? cause.message : "";
}

export function errorText(error: unknown): string {
	if (error instanceof TypeError && error.message === "fetch failed") return causeCode(error) || causeMessage(error) || "network error";
	return error instanceof Error ? error.message : String(error);
}

/**
 * Classifies a failed request. `aborted` tells an owner interrupt from our own deadline, which pi-mcp
 * reports the same way (an aborted signal).
 */
export function classify(error: unknown, aborted: "owner" | "deadline" | undefined = undefined): Classified {
	const message = errorText(error);
	if (aborted === "deadline" || error instanceof McpTimeoutError) return { kind: "timeout", sent: "unknown", message };
	if (aborted === "owner" || error instanceof McpAbortError) return { kind: "cancelled", sent: "unknown", message };
	if (error instanceof McpSessionExpiredError) return { kind: "session_expired", sent: "no", message, httpStatus: 404 };
	if (error instanceof McpAuthRequiredError) return { kind: "auth", sent: "no", message, httpStatus: 401 };
	if (error instanceof McpHttpError) {
		const s = error.status;
		if (s === 403) return { kind: "auth", sent: "no", message, httpStatus: s };
		if (s === 429 || s === 400 || s === 404 || s === 405 || s === 406 || s === 415) return { kind: "rejected", sent: "no", message, httpStatus: s };
		return { kind: "server_error", sent: "unknown", message, httpStatus: s };
	}
	if (error instanceof McpError) {
		// pi-mcp turns a response stream that broke before the answer into this internal error.
		if (error.code === -32603 && error.message.startsWith("MCP response stream failed")) return { kind: "lost", sent: "unknown", message, rpcCode: error.code };
		if (REFUSED_RPC.has(error.code)) return { kind: "rejected", sent: "no", message, rpcCode: error.code };
		return { kind: "server_error", sent: "unknown", message, rpcCode: error.code };
	}
	// Closed while the request was pending (we only send on a connected client).
	if (error instanceof McpConnectionClosedError) return { kind: "lost", sent: "unknown", message };
	if (error instanceof TypeError && error.message === "fetch failed") {
		const code = causeCode(error);
		if (NOT_SENT_CODES.has(code) || /bad port|invalid url/i.test(causeMessage(error))) return { kind: "not_sent", sent: "no", message };
		return { kind: "lost", sent: "unknown", message };
	}
	return { kind: "server_error", sent: "unknown", message };
}

/** Kinds after which the server should be treated as unreachable. */
export function meansUnreachable(kind: OutcomeKind): boolean {
	return kind === "not_sent" || kind === "lost";
}

/**
 * The sentence the model reads for a failed call. `readOnly` tools change nothing either way, so the
 * "it may have run" warning becomes an invitation to try again.
 */
export function modelText(o: { kind: OutcomeKind; message: string }, ctx: { server: string; tool: string; readOnly: boolean; timeoutS?: number; since?: number; reason?: string }): string {
	const s = ctx.server;
	const maybeRan = ctx.readOnly ? "This tool only reads, so nothing changed either way; you may try again." : "It may or may not have run. Do not repeat it blindly: check first (for example with a tool that reads the current state), or ask the owner.";
	switch (o.kind) {
		case "offline":
		case "not_sent": {
			const since = ctx.since ? ` (unreachable since ${new Date(ctx.since).toISOString().slice(0, 16).replace("T", " ")} UTC)` : "";
			return `The MCP server "${s}" is offline${since}${ctx.reason ? `: ${ctx.reason}` : ""}. The call was not sent, so nothing changed. Tell the owner if this is needed now, or try again later.`;
		}
		case "auth":
			return `The MCP server "${s}" refused the gateway's credentials (${o.message}). Nothing changed. The owner needs to update the key for "${s}".`;
		case "misconfigured":
			return `The MCP server "${s}" is not usable: ${o.message}. The call was not sent, so nothing changed. The owner needs to fix its settings.`;
		case "rejected":
			return `The MCP server "${s}" refused the call to ${ctx.tool} without running it: ${o.message}`;
		case "server_error":
			return `The MCP server "${s}" reported an error for ${ctx.tool}: ${o.message}. ${maybeRan}`;
		case "lost":
			return `The connection to the MCP server "${s}" dropped after the call to ${ctx.tool} was sent (${o.message}). ${maybeRan}`;
		case "timeout":
			return `The MCP server "${s}" did not answer the call to ${ctx.tool}${ctx.timeoutS ? ` within ${ctx.timeoutS} s` : ""}. A cancel was sent, but the server may still finish it. ${maybeRan}`;
		case "cancelled":
			return `The call to ${ctx.tool} on "${s}" was interrupted after it was sent. ${maybeRan}`;
		case "session_expired":
			return `The MCP server "${s}" ended the session before running ${ctx.tool}. Nothing changed; try again.`;
		default:
			return o.message;
	}
}
