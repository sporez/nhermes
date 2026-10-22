// Managing MCP servers from the panel and the admin API (`nhermes mcp`): add, edit, test, remove, the
// tool view, 404 for an unknown server, and that key values never come back (a header that carries a
// credential must reference a key; one written into config.yaml by hand is hidden). The doctor reports
// an offline server as a warning only.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { adminRoutes } from "../../src/admin.ts";
import { createCore } from "../../src/app.ts";
import { loadConfig } from "../../src/config.ts";
import { runDoctor } from "../../src/core/doctor.ts";
import { startHermesServer } from "../../src/hermes/server.ts";
import { fauxModels, TOKEN, tempDir } from "../helpers.ts";
import { closedPort, FakeMcpServer } from "./server.ts";

const SECRET = "manage-test-key-0123456789";

async function setup(extra = "") {
	const t = await tempDir();
	process.env.NHERMES_TOKEN = TOKEN;
	process.env.TEST_MANAGE_KEY = SECRET;
	const fake = await FakeMcpServer.start([{ name: "list_events", description: "Lists events", annotations: { readOnlyHint: true } }, { name: "add_event" }, { name: "secret_dump" }], { token: SECRET });
	const path = join(t.dir, "config.yaml");
	writeFileSync(path, `server:\n  host: 127.0.0.1\n  port: 0\ndefaults:\n  model: faux/faux-1\nbots:\n  - name: main\n    default: true\n    tools: [memory]\n${extra}`);
	const { models } = fauxModels();
	const core = await createCore(loadConfig(path), { models, mcpTuning: { probeGapMs: 0, backoffBaseMs: 20, backoffCapMs: 80 } });
	const server = await startHermesServer(core, { host: "127.0.0.1", port: 0, extraRouters: [adminRoutes(core)] });
	const base = `http://127.0.0.1:${server.port}`;
	const send = async (url: string, method: string, body: unknown, headers: Record<string, string>) => {
		const res = await fetch(url, { method, headers: { ...(method === "GET" ? {} : { "content-type": "application/json" }), ...headers }, body: method === "GET" ? undefined : JSON.stringify(body ?? {}) });
		const text = await res.text();
		return { status: res.status, text, json: JSON.parse(text) as Record<string, any> };
	};
	return {
		core,
		fake,
		path,
		panel: (method: string, p: string, body?: unknown) => send(`${base}/panel/api${p}`, method, body, method === "GET" ? {} : { "x-nhermes-panel": "1" }),
		admin: (method: string, p: string, body?: unknown) => send(`${base}${p}`, method, body, { "X-Hermes-Session-Token": TOKEN }),
		cleanup: async () => {
			await server.close();
			await core.close();
			await fake.stop();
			delete process.env.TEST_MANAGE_KEY;
			await t.cleanup();
		},
	};
}

test("panel: add, look at, edit, test and remove an MCP server; key values never come back", async () => {
	const s = await setup();
	try {
		const literal = await s.panel("POST", "/mcp", { name: "cal", url: s.fake.url, headers: { Authorization: `Bearer ${SECRET}` } });
		assert.equal(literal.status, 400);
		assert.match(literal.json.detail, /put the value in Keys/);
		assert.equal((await s.panel("POST", "/mcp", { name: "cal", url: s.fake.url, color: "blue" })).status, 400);

		const added = await s.panel("POST", "/mcp", { name: "cal", url: s.fake.url, description: "Calendar", headers: { Authorization: "Bearer {{secret:TEST_MANAGE_KEY}}" }, tools: { readOnly: ["list_*"], exclude: ["secret_*"] } });
		assert.equal(added.status, 200, added.text);
		assert.doesNotMatch(readFileSync(s.path, "utf8"), new RegExp(SECRET), "the key value is not written to config.yaml");
		await new Promise<void>((resolve) => {
			const check = () => (s.core.mcp.status()[0]?.state === "online" ? resolve() : undefined);
			check();
			s.core.mcp.onStateChanged(check);
		});

		const list = await s.panel("GET", "/mcp");
		assert.ok(!list.text.includes(SECRET));
		const v = list.json.servers[0];
		assert.deepEqual(v.headers, [{ name: "Authorization", value: "Bearer {{secret:TEST_MANAGE_KEY}}" }]);
		assert.deepEqual(v.secrets, [{ name: "TEST_MANAGE_KEY", set: true }]);
		assert.equal(v.status.state, "online");
		assert.deepEqual([v.toolCount, v.exposedCount, v.readOnlyCount], [3, 2, 1]);
		assert.deepEqual(v.bots, []);

		const detail = await s.panel("GET", "/mcp/cal");
		const tools = Object.fromEntries((detail.json.toolList as { name: string; modelName: string | null; readOnly: string | false }[]).map((t) => [t.name, [t.modelName, t.readOnly]]));
		assert.deepEqual(tools, { list_events: ["mcp__cal__list_events", "owner"], add_event: ["mcp__cal__add_event", false], secret_dump: [null, false] });
		assert.equal(detail.json.changes.length, 1);

		const edited = await s.panel("PATCH", "/mcp/cal", { trustReadOnlyHint: true, tools: { readOnly: [] } });
		assert.equal(edited.status, 200, edited.text);
		const hinted = await s.panel("GET", "/mcp/cal");
		assert.deepEqual(hinted.json.toolList.find((t: { name: string }) => t.name === "list_events").readOnly, "hint");

		const tested = await s.panel("POST", "/mcp/cal/test");
		assert.equal(tested.json.ok, true);
		assert.equal(tested.json.toolCount, 3);
		assert.equal((await s.panel("POST", "/mcp/cal/explode")).status, 400);
		assert.equal((await s.panel("GET", "/mcp/nope")).status, 404);
		assert.equal((await s.panel("PATCH", "/mcp/nope", { enabled: false })).status, 404);

		assert.equal((await s.panel("PATCH", "/bots/main", { tools: ["memory", "mcp:cal"] })).status, 200);
		assert.deepEqual((await s.panel("GET", "/mcp")).json.servers[0].bots, ["main"]);
		assert.equal((await s.panel("DELETE", "/mcp/cal")).status, 200);
		assert.deepEqual(s.core.bots.get("main")?.toolGroups, ["memory"]);
		assert.deepEqual((await s.panel("GET", "/mcp")).json.servers, []);
	} finally {
		await s.cleanup();
	}
});

test("a credential written into config.yaml by hand is hidden; the admin API answers like the panel; the doctor only warns", async () => {
	const port = await closedPort();
	const s = await setup(`mcp:\n  servers:\n    away:\n      url: http://127.0.0.1:${port}/mcp\n      headers:\n        X-Api-Key: handwritten-key-0123456789\n        X-Client: nhermes\n`);
	try {
		await new Promise<void>((resolve) => {
			const check = () => (s.core.mcp.status()[0]?.state === "offline" ? resolve() : undefined);
			check();
			s.core.mcp.onStateChanged(check);
		});
		const list = await s.admin("GET", "/admin/mcp");
		assert.equal(list.status, 200);
		assert.ok(!list.text.includes("handwritten-key-0123456789"));
		assert.deepEqual(list.json.servers[0].headers, [{ name: "X-Api-Key", value: null }, { name: "X-Client", value: "nhermes" }]);
		assert.equal(list.json.servers[0].status.state, "offline");
		assert.equal((await s.admin("GET", "/admin/mcp/nope")).status, 404);
		assert.equal((await s.admin("POST", "/admin/mcp", { url: "https://x.example.com/mcp" })).status, 400);
		const added = await s.admin("POST", "/admin/mcp", { name: "cal", url: s.fake.url, headers: { Authorization: "Bearer {{secret:TEST_MANAGE_KEY}}" } });
		assert.equal(added.status, 200, added.text);
		assert.equal((await s.admin("PATCH", "/admin/mcp/cal", { enabled: false })).status, 200);
		assert.equal(s.core.mcp.status().find((x) => x.name === "cal")?.state, "disabled");

		const report = await runDoctor(s.core);
		const line = report.findings.find((f) => f.text.includes("MCP server away"));
		assert.equal(line?.level, "warn");
		assert.match(line?.text ?? "", /offline/);
		assert.ok(report.findings.some((f) => f.level === "ok" && f.text === "MCP server cal is turned off"));
	} finally {
		await s.cleanup();
	}
});
