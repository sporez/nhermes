// MCP servers in a network (docs/MCP.md, "Network"): a server belongs to the machine that configures it, and
// other machines reach its tools only by delegating to a bot there (the call goes out from that machine,
// a write's approval comes back to the chat that started it). Any panel, and Vory for a member's profile,
// manage a member's servers once that machine allows bot edits; key values never travel.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { createCore, type Core } from "../../src/app.ts";
import { loadConfig } from "../../src/config.ts";
import { type HermesServer, startHermesServer } from "../../src/hermes/server.ts";
import { collect, TOKEN, tempDir } from "../helpers.ts";
import { FakeMcpServer } from "../mcp/server.ts";

type Gw = { core: Core; server: HermesServer; faux: ReturnType<typeof fauxProvider>; url: string; path: string };

async function gateway(root: string, name: string, yaml: string): Promise<Gw> {
	const dir = join(root, name);
	mkdirSync(dir, { recursive: true });
	const path = join(dir, "config.yaml");
	writeFileSync(path, `server:\n  host: 127.0.0.1\n  port: 0\nnode:\n  name: ${name}\ndefaults:\n  model: faux/faux-1\n${yaml}`);
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }], tokensPerSecond: 500 });
	const models = createModels();
	models.setProvider(faux.provider);
	const core = await createCore(loadConfig(path), { models, mcpTuning: { probeGapMs: 0, backoffBaseMs: 20, backoffCapMs: 80 } });
	const server = await startHermesServer(core, { host: "127.0.0.1", port: 0 });
	return { core, server, faux, url: `http://127.0.0.1:${server.port}`, path };
}

async function online(core: Core, name: string): Promise<void> {
	await new Promise<void>((resolve) => {
		const check = () => (core.mcp.status().find((s) => s.name === name)?.state === "online" ? resolve() : undefined);
		check();
		core.mcp.onStateChanged(check);
	});
}

async function http(base: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
	const res = await fetch(`${base}${path}`, { method, headers: { ...(method === "GET" ? {} : { "content-type": "application/json" }), ...headers }, body: method === "GET" ? undefined : JSON.stringify(body ?? {}) });
	const text = await res.text();
	return { status: res.status, text, json: JSON.parse(text) as Record<string, any> };
}
const panel = (g: Gw, method: string, path: string, body?: unknown) => http(g.url, method, `/panel/api${path}`, body, method === "GET" ? {} : { "x-nhermes-panel": "1" });
const vory = (g: Gw, method: string, path: string, body?: unknown) => http(g.url, method, path, body, { "X-Hermes-Session-Token": TOKEN });

async function network(root: string, fake: FakeMcpServer) {
	process.env.NHERMES_TOKEN = TOKEN;
	process.env.TEST_FED_MCP_KEY = "fed-mcp-key-0123456789";
	const a = await gateway(root, "alpha", "bots:\n  - name: main\n    default: true\n    tools: [delegate]\n");
	const b = await gateway(root, "beta", `mcp:\n  servers:\n    cal:\n      url: ${fake.url}\n      headers:\n        Authorization: "Bearer {{secret:TEST_FED_MCP_KEY}}"\n      tools:\n        readOnly: ["list_*"]\nbots:\n  - name: nasbot\n    default: true\n    description: Has the calendar\n    tools: [mcp:cal]\n`);
	await b.core.members.join(a.core.members.invite().code);
	await Promise.all([a.core.roster.sync(), b.core.roster.sync()]);
	await online(b.core, "cal");
	return { a, b };
}

async function close(...gws: Gw[]) {
	for (const g of gws) {
		await g.server.close();
		await g.core.close();
	}
}

test("a member's MCP tools are used by delegating to its bot: the call goes out from that machine, a write asks in the caller's chat", async () => {
	const { dir, cleanup } = await tempDir();
	const fake = await FakeMcpServer.start([{ name: "list_events" }, { name: "add_event" }], { token: "fed-mcp-key-0123456789" });
	const { a, b } = await network(dir, fake);
	try {
		assert.deepEqual(a.core.mcp.status(), [], "alpha has no MCP server of its own");
		assert.equal(a.core.toolGroups.has("mcp:cal"), false);

		const s = await a.core.sessions.create("main");
		const ev = collect(a.core.hub, s.id);
		a.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("delegate", { bot: "nasbot-beta", task: "Put the dentist on Friday" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("It is on the calendar.")]),
		]);
		b.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("mcp__cal__list_events", { day: "friday" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("mcp__cal__add_event", { title: "Dentist" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("Added the dentist on Friday.")]),
		]);
		await a.core.sessions.submit(s.id, "@nasbot-beta put the dentist on Friday");
		const asked = await ev.until((e) => e.type === "approval.requested", 15000);
		if (asked.type !== "approval.requested") return;
		assert.equal(asked.request.sessionId, s.id, "asked in the chat on alpha");
		assert.equal(asked.request.bot, "nasbot-beta");
		assert.match(asked.request.description, /add_event on the MCP server "cal"/);
		assert.deepEqual(fake.calls.map((c) => c.name), ["list_events"], "the read-only call ran without asking; the write waits");
		a.core.approvals.answer(asked.request.requestId, "once");
		const done = await ev.until((e) => e.type === "run.finished", 20000);
		assert.ok(done.type === "run.finished" && done.text === "It is on the calendar.");
		assert.deepEqual(fake.calls.map((c) => [c.name, c.args]), [["list_events", { day: "friday" }], ["add_event", { title: "Dentist" }]]);
		assert.equal(fake.lastHeaders.authorization, "Bearer fed-mcp-key-0123456789", "beta's key, used on beta");
		const onB = b.core.sessions.list("nasbot", { limit: 10, offset: 0, archived: "include", order: "recent" });
		assert.equal(onB.rows[0]!.source, `member:${a.core.members.self().id}`);
	} finally {
		await close(a, b);
		await fake.stop();
		delete process.env.TEST_FED_MCP_KEY;
		await cleanup();
	}
});

test("a member's MCP servers are managed from another panel and from Vory once that machine allows bot edits", async () => {
	const { dir, cleanup } = await tempDir();
	const fake = await FakeMcpServer.start([{ name: "list_events" }, { name: "add_event" }], { token: "fed-mcp-key-0123456789" });
	const { a, b } = await network(dir, fake);
	try {
		// Off by default: refused, and Vory's toggle for the member's bot too.
		const refused = await panel(a, "GET", "/remote/beta/mcp");
		assert.equal(refused.status, 403);
		assert.match(refused.json.detail, /does not accept bot edits/);
		assert.equal((await vory(a, "PUT", "/api/mcp/servers/cal/enabled?profile=nasbot-beta", { enabled: false })).status, 403);
		const readOnly = await vory(a, "GET", "/api/mcp/servers?profile=nasbot-beta");
		assert.equal(readOnly.status, 200, "Vory's list is a read, answered either way");
		assert.deepEqual(readOnly.json.servers.map((s: { name: string; enabled: boolean }) => [s.name, s.enabled]), [["cal", true]]);

		assert.equal((await panel(b, "PATCH", "/network/settings", { acceptBotEdits: true })).status, 200);
		const list = await panel(a, "GET", "/remote/beta/mcp");
		assert.equal(list.status, 200, list.text);
		assert.equal(list.json.node, "beta");
		assert.deepEqual(list.json.servers[0].headers, [{ name: "Authorization", value: "Bearer {{secret:TEST_FED_MCP_KEY}}" }]);
		assert.equal(list.json.servers[0].status.state, "online");
		assert.ok(!list.text.includes("fed-mcp-key-0123456789"), "the key value never travels");
		assert.equal((await panel(a, "GET", "/remote/beta/mcp/cal")).json.toolList.length, 2);
		assert.equal((await panel(a, "GET", "/remote/beta/mcp/nope")).status, 404);

		const literal = await panel(a, "POST", "/remote/beta/mcp", { name: "notes", url: "https://notes.example.com/mcp", headers: { Authorization: "Bearer abc0123456789" } });
		assert.equal(literal.status, 400);
		const added = await panel(a, "POST", "/remote/beta/mcp", { name: "notes", url: "https://notes.example.com/mcp", description: "Notes" });
		assert.equal(added.status, 200, added.text);
		assert.match(readFileSync(b.path, "utf8"), /notes:\n\s+url: https:\/\/notes\.example\.com\/mcp/, "written to beta's config.yaml by beta");
		assert.equal((await panel(a, "PATCH", "/remote/beta/mcp/notes", { enabled: false })).status, 200);
		assert.equal(b.core.mcp.status().find((s) => s.name === "notes")?.state, "disabled");
		assert.equal((await panel(a, "POST", "/remote/beta/mcp/cal/test")).json.ok, true);
		assert.equal((await panel(a, "DELETE", "/remote/beta/mcp/notes")).status, 200);
		assert.deepEqual(b.core.config.mcp.servers.map((s) => s.name), ["cal"]);

		// Vory with the member's bot selected: its toggle changes nasbot on beta.
		assert.equal((await vory(a, "PUT", "/api/mcp/servers/cal/enabled?profile=nasbot-beta", { enabled: false })).status, 200);
		assert.deepEqual(b.core.bots.get("nasbot")?.toolGroups, []);
		assert.equal((await vory(a, "GET", "/api/mcp/servers?profile=nasbot-beta")).json.servers[0].enabled, false);
		assert.equal((await vory(a, "POST", "/api/mcp/servers/cal/test?profile=nasbot-beta")).json.tool_count, 2);
	} finally {
		await close(a, b);
		await fake.stop();
		delete process.env.TEST_FED_MCP_KEY;
		await cleanup();
	}
});
