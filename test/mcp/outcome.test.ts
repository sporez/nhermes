// The outcome of a failed MCP request (src/mcp/outcome.ts): "not sent" only when the server provably did not
// run it, "unknown" whenever it may have; and the sentence the model reads for each.
import assert from "node:assert/strict";
import { test } from "node:test";
import { McpAbortError, McpAuthRequiredError, McpConnectionClosedError, McpError, McpHttpError, McpSessionExpiredError, McpTimeoutError } from "@earendil-works/pi-mcp";
import { classify, modelText } from "../../src/mcp/outcome.ts";

const net = (code: string) => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(code), { code }) });

test("classify: what did and did not reach the tool", () => {
	const kinds = (e: unknown, aborted?: "owner" | "deadline") => {
		const c = classify(e, aborted);
		return `${c.kind}/${c.sent}`;
	};
	assert.equal(kinds(net("ECONNREFUSED")), "not_sent/no");
	assert.equal(kinds(net("ENOTFOUND")), "not_sent/no");
	assert.equal(kinds(net("UND_ERR_CONNECT_TIMEOUT")), "not_sent/no");
	assert.equal(kinds(net("ECONNRESET")), "lost/unknown");
	assert.equal(kinds(net("UND_ERR_SOCKET")), "lost/unknown");
	assert.equal(kinds(new McpConnectionClosedError()), "lost/unknown");
	assert.equal(kinds(new McpError(-32603, "MCP response stream failed: terminated")), "lost/unknown");
	assert.equal(kinds(new McpError(-32603, "database locked")), "server_error/unknown");
	assert.equal(kinds(new McpError(-32602, "bad args")), "rejected/no");
	assert.equal(kinds(new McpError(-32601, "no such method")), "rejected/no");
	assert.equal(kinds(new McpHttpError(429, "slow down")), "rejected/no");
	assert.equal(kinds(new McpHttpError(403, "forbidden")), "auth/no");
	assert.equal(kinds(new McpHttpError(502, "bad gateway")), "server_error/unknown");
	assert.equal(kinds(new McpSessionExpiredError()), "session_expired/no");
	assert.equal(kinds(new McpTimeoutError(60_000)), "timeout/unknown");
	assert.equal(kinds(new McpAbortError(), "deadline"), "timeout/unknown");
	assert.equal(kinds(new McpAbortError(), "owner"), "cancelled/unknown");
	const auth = new McpAuthRequiredError(new Response(null, { status: 401 }));
	assert.equal(kinds(auth), "auth/no");
});

test("modelText: a write of unknown outcome warns against repeating it; a read-only tool invites a retry", () => {
	const lost = { kind: "lost" as const, message: "ECONNRESET" };
	const write = modelText(lost, { server: "cal", tool: "add_event", readOnly: false });
	assert.match(write, /may or may not have run/);
	assert.match(write, /Do not repeat it blindly/);
	const read = modelText(lost, { server: "cal", tool: "list_events", readOnly: true });
	assert.match(read, /nothing changed either way; you may try again/);
	const offline = modelText({ kind: "offline", message: "ECONNREFUSED" }, { server: "cal", tool: "add_event", readOnly: false, since: Date.UTC(2026, 9, 21, 21, 4) });
	assert.match(offline, /"cal" is offline \(unreachable since 2026-10-21 21:04 UTC\)/);
	assert.match(offline, /was not sent, so nothing changed/);
	assert.match(modelText({ kind: "timeout", message: "" }, { server: "cal", tool: "add_event", readOnly: false, timeoutS: 60 }), /within 60 s.*may still finish/);
	assert.match(modelText({ kind: "auth", message: "401" }, { server: "cal", tool: "t", readOnly: false }), /update the key/);
});
