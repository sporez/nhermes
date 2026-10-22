// MCP servers in config.yaml: parsing and its defaults, and the Settings edits that add, change and remove
// a server (comments kept, a removed server's group taken off every bot, connections following live).
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createCore } from "../../src/app.ts";
import { loadConfig } from "../../src/config.ts";
import { setLogLevel, setLogSink } from "../../src/log.ts";
import { fauxModels, TOKEN, tempDir } from "../helpers.ts";
import { FakeMcpServer } from "./server.ts";

const BASE = `server:
  host: 127.0.0.1
  port: 0
defaults:
  model: faux/faux-1
bots:
  - name: main
    default: true
    tools: [memory, mcp:cal] # calendar too
  - name: ops
    tools: [files]
`;

test("config: an MCP server's defaults, and the mistakes it refuses", async () => {
	const { dir, cleanup } = await tempDir();
	process.env.NHERMES_TOKEN = TOKEN;
	const path = join(dir, "config.yaml");
	const lines: string[] = [];
	setLogSink((l) => lines.push(l));
	setLogLevel("warn");
	try {
		writeFileSync(path, `${BASE}mcp:\n  servers:\n    cal:\n      url: http://198.51.100.7:8080/mcp\n      headers:\n        Authorization: "Bearer {{secret:CAL_KEY}}"\n`);
		const c = loadConfig(path);
		assert.deepEqual(c.mcp.servers, [
			{ name: "cal", url: "http://198.51.100.7:8080/mcp", description: undefined, enabled: true, headers: { Authorization: "Bearer {{secret:CAL_KEY}}" }, exposure: "direct", timeoutS: 60, maxTimeoutS: 300, healthCheckS: 60, tools: { include: ["*"], exclude: [], readOnly: [] }, trustReadOnlyHint: false },
		]);
		assert.ok(lines.some((l) => l.includes("plain http://")), "plain http to another machine warns");

		const bad = (server: string, re: RegExp) => {
			writeFileSync(path, `${BASE}mcp:\n  servers:\n${server}`);
			assert.throws(() => loadConfig(path), re);
		};
		bad("    Cal:\n      url: https://mcp.example.com/mcp\n", /name must match/);
		bad("    cal:\n      description: no url\n", /url is required/);
		bad("    cal:\n      url: ftp://mcp.example.com/\n", /http:\/\/ or https:\/\//);
		bad("    cal:\n      url: https://user:pw@mcp.example.com/mcp\n", /must not carry a user or password/);
		bad("    cal:\n      url: https://mcp.example.com/mcp\n      exposure: lazy\n", /direct or deferred/);
		bad("    cal:\n      url: https://mcp.example.com/mcp\n      timeoutS: 0\n", /timeoutS must be a number/);
		bad("    cal:\n      url: https://mcp.example.com/mcp\n      timeoutS: 120\n      maxTimeoutS: 60\n", /maxTimeoutS must be at least timeoutS/);

		// A bot listing a server that does not exist loads (with a warning): MCP never stops the gateway from starting.
		lines.length = 0;
		writeFileSync(path, BASE);
		assert.deepEqual(loadConfig(path).mcp.servers, []);
		assert.ok(lines.some((l) => l.includes("lists mcp:cal")));
	} finally {
		setLogSink((line) => process.stderr.write(`${line}\n`));
		setLogLevel("error");
		await cleanup();
	}
});

test("settings: add, edit and remove an MCP server; removing takes its group off every bot; connections follow", async () => {
	const { dir, cleanup } = await tempDir();
	process.env.NHERMES_TOKEN = TOKEN;
	const path = join(dir, "config.yaml");
	writeFileSync(path, `# Household gateway\n${BASE.replace("tools: [memory, mcp:cal] # calendar too", "tools: [memory]")}`);
	const fake = await FakeMcpServer.start([{ name: "list" }]);
	const { models } = fauxModels();
	const core = await createCore(loadConfig(path), { models, openchamberSettingsPath: join(dir, "oc.json") });
	try {
		assert.throws(() => core.settings.editBot("main", { tools: ["memory", "mcp:cal"] }), /unknown tool group mcp:cal/);
		core.settings.addMcpServer("cal", { url: fake.url, description: "The owner's calendar", tools: { readOnly: ["list"] } });
		assert.throws(() => core.settings.addMcpServer("cal", { url: fake.url }), /already exists/);
		assert.throws(() => core.settings.addMcpServer("Bad", { url: fake.url }), /must match/);
		core.settings.editBot("main", { tools: ["memory", "mcp:cal"] });
		assert.equal(core.config.mcp.servers[0]?.description, "The owner's calendar");
		await new Promise<void>((resolve) => {
			const check = () => (core.mcp.status()[0]?.state === "online" ? resolve() : undefined);
			check();
			core.mcp.onStateChanged(check);
		});

		core.settings.editMcpServer("cal", { timeoutS: 30, tools: { exclude: ["secret_*"] }, description: null });
		const s = core.config.mcp.servers[0]!;
		assert.equal(s.timeoutS, 30);
		assert.equal(s.description, undefined);
		assert.deepEqual(s.tools, { include: ["*"], exclude: ["secret_*"], readOnly: ["list"] });
		assert.equal(core.mcp.status()[0]?.state, "online", "a timeout change keeps the connection");
		const yaml = readFileSync(path, "utf8");
		assert.match(yaml, /# Household gateway/, "comments survive");
		assert.doesNotMatch(yaml, /description:/);

		core.settings.editMcpServer("cal", { enabled: false });
		assert.equal(core.mcp.status()[0]?.state, "disabled");

		core.settings.removeMcpServer("cal");
		assert.deepEqual(core.config.mcp.servers, []);
		assert.deepEqual(core.bots.get("main")?.toolGroups, ["memory"]);
		assert.doesNotMatch(readFileSync(path, "utf8"), /mcp/);
		assert.deepEqual(core.mcp.status(), []);
		assert.throws(() => core.settings.removeMcpServer("cal"), /unknown MCP server/);
	} finally {
		await core.close();
		await fake.stop();
		await cleanup();
	}
});
