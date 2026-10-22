// Vory's MCP Servers screen (`/api/mcp/servers`, src/hermes/mcp.ts): the list per profile in the shape Vory
// decodes, the toggle as that bot's access, Test, Remove, 404s, and the MCP groups on the Tools page.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createCore } from "../../src/app.ts";
import { loadConfig } from "../../src/config.ts";
import { startHermesServer } from "../../src/hermes/server.ts";
import { fauxModels, TOKEN, tempDir } from "../helpers.ts";
import { FakeMcpServer } from "./server.ts";

test("Vory: MCP servers per profile, the toggle grants the bot the server, Test and Remove", async () => {
	const t = await tempDir();
	process.env.NHERMES_TOKEN = TOKEN;
	const fake = await FakeMcpServer.start([{ name: "list_events" }, { name: "add_event" }]);
	const path = join(t.dir, "config.yaml");
	writeFileSync(path, `server:\n  host: 127.0.0.1\n  port: 0\ndefaults:\n  model: faux/faux-1\nmcp:\n  servers:\n    cal:\n      url: ${fake.url}\n      description: The calendar\nbots:\n  - name: main\n    default: true\n    tools: [memory, mcp:cal]\n  - name: ops\n    tools: [files]\n`);
	const { models } = fauxModels();
	const core = await createCore(loadConfig(path), { models });
	const server = await startHermesServer(core, { host: "127.0.0.1", port: 0 });
	const api = async (method: string, p: string, body?: unknown) => {
		const res = await fetch(`http://127.0.0.1:${server.port}${p}`, { method, headers: { "X-Hermes-Session-Token": TOKEN, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
		return { status: res.status, json: (await res.json()) as Record<string, any> };
	};
	try {
		await new Promise<void>((resolve) => {
			const check = () => (core.mcp.status()[0]?.state === "online" ? resolve() : undefined);
			check();
			core.mcp.onStateChanged(check);
		});
		const main = await api("GET", "/api/mcp/servers?profile=main");
		assert.equal(main.status, 200);
		const s = main.json.servers[0];
		assert.deepEqual([s.name, s.url, s.transport, s.enabled, s.command, s.args], ["cal", fake.url, "http", true, null, []]);
		assert.equal(s.state, "online");
		assert.equal(s.tool_count, 2);
		assert.equal((await api("GET", "/api/mcp/servers?profile=ops")).json.servers[0].enabled, false);

		assert.equal((await api("PUT", "/api/mcp/servers/cal/enabled?profile=ops", { enabled: true })).status, 200);
		assert.deepEqual(core.bots.get("ops")?.toolGroups, ["files", "mcp:cal"]);
		assert.equal((await api("GET", "/api/mcp/servers?profile=ops")).json.servers[0].enabled, true);
		assert.equal((await api("PUT", "/api/mcp/servers/cal/enabled", { enabled: false, profile: "ops" })).status, 200);
		assert.deepEqual(core.bots.get("ops")?.toolGroups, ["files"]);
		assert.deepEqual(core.bots.get("main")?.toolGroups, ["memory", "mcp:cal"], "only the selected profile changes");
		assert.equal((await api("PUT", "/api/mcp/servers/cal/enabled?profile=ops", { enabled: "yes" })).status, 400);
		assert.equal((await api("PUT", "/api/mcp/servers/nope/enabled?profile=ops", { enabled: true })).status, 404);

		const toolsets = (await api("GET", "/api/tools/toolsets?profile=main")).json as unknown as { name: string; label: string; description: string; enabled: boolean; tools: string[] }[];
		const group = toolsets.find((x) => x.name === "mcp:cal");
		assert.deepEqual([group?.label, group?.description, group?.enabled, group?.tools], ["MCP: cal", "The calendar", true, ["mcp__cal__list_events", "mcp__cal__add_event"]]);

		const tested = await api("POST", "/api/mcp/servers/cal/test");
		assert.deepEqual([tested.json.ok, tested.json.status, tested.json.tool_count], [true, "connected", 2]);
		await fake.stop();
		const down = await api("POST", "/api/mcp/servers/cal/test");
		assert.equal(down.json.ok, false);
		assert.ok(down.json.error);
		assert.equal((await api("POST", "/api/mcp/servers/nope/test")).status, 404);

		assert.equal((await api("DELETE", "/api/mcp/servers/cal")).status, 200);
		assert.deepEqual((await api("GET", "/api/mcp/servers?profile=main")).json.servers, []);
		assert.deepEqual(core.bots.get("main")?.toolGroups, ["memory"]);
		assert.equal((await api("DELETE", "/api/mcp/servers/cal")).status, 404);
	} finally {
		await server.close();
		await core.close();
		await fake.stop();
		await t.cleanup();
	}
});
