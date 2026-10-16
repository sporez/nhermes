// Runtime configuration: reloading config.yaml, and edits through the admin API that keep the file's
// comments, are checked before they replace it, and reach running sessions.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { adminRoutes } from "../../src/admin.ts";
import { createCore } from "../../src/app.ts";
import { loadConfig } from "../../src/config.ts";
import { startHermesServer } from "../../src/hermes/server.ts";
import { collect, fauxModels, TOKEN, tempDir } from "../helpers.ts";

const CONFIG = `# Household gateway
server:
  host: 127.0.0.1
  port: 0
defaults:
  model: faux/faux-1 # the cheap one
bots:
  - name: main
    default: true
    instructions: You are main.
  # infrastructure
  - name: ops
    description: Infrastructure
    tools: [files, shell]
`;

async function setup() {
	const t = await tempDir();
	process.env.NHERMES_TOKEN = TOKEN;
	const path = join(t.dir, "config.yaml");
	writeFileSync(path, CONFIG);
	const { models, faux } = fauxModels();
	const core = await createCore(loadConfig(path), { models });
	return { ...t, path, core, faux };
}

test("reload picks up a hand-edited bot; a broken file keeps the running configuration", async () => {
	const { path, core, cleanup } = await setup();
	try {
		writeFileSync(path, `${CONFIG}  - name: research\n    description: Reads papers\n`);
		const r = core.settings.reload();
		assert.deepEqual(r, { added: ["research"], removed: [], changed: [], restartNeeded: [] });
		assert.equal(core.bots.get("research")?.description, "Reads papers");
		await core.sessions.create("research");

		writeFileSync(path, `${CONFIG}  - name: Bad Name\n`);
		assert.throws(() => core.settings.reload(), /name must match/);
		assert.deepEqual(core.bots.names(), ["main", "ops", "research"]);

		writeFileSync(path, CONFIG.replace("port: 0", "port: 9999"));
		assert.deepEqual(core.settings.reload().restartNeeded, ["server"]);
		assert.deepEqual(core.bots.names(), ["main", "ops"]);
	} finally {
		await core.close();
		await cleanup();
	}
});

test("bot edits keep comments, clear shadowing overrides and reach existing sessions", async () => {
	const { path, core, faux, cleanup } = await setup();
	try {
		const s = await core.sessions.create("ops");
		core.bots.setOverrides("ops", { model: "faux/faux-2" });
		assert.equal(core.bots.get("ops")!.model.modelId, "faux-2");

		core.settings.editBot("ops", { model: "faux/faux-1", tools: ["files", "shell", "web"], private: true, description: null });
		const text = readFileSync(path, "utf8");
		assert.match(text, /# Household gateway/);
		assert.match(text, /# the cheap one/);
		assert.match(text, /# infrastructure/);
		assert.match(text, /tools:.*web/s);
		assert.doesNotMatch(text, /Infrastructure/);
		const ops = core.bots.get("ops")!;
		assert.equal(ops.model.modelId, "faux-1", "the override no longer shadows the edit");
		assert.equal(ops.private, true);

		const c = collect(core.hub, s.id);
		faux.setResponses([fauxAssistantMessage([fauxText("ok")])]);
		await core.sessions.submit(s.id, "hi");
		await c.until((e) => e.type === "run.finished", 10000);
		const agent = await core.engine.agentModel(s.conversation_id);
		assert.ok(agent.tools.includes("web_fetch"), `the existing session got the new tools: ${agent.tools.join(", ")}`);

		assert.throws(() => core.settings.editBot("ops", { tools: ["files", "teleport"] }), /unknown tool group teleport/);
		assert.match(readFileSync(path, "utf8"), /tools:.*web/s, "a refused edit leaves the file alone");

		core.settings.editBot("ops", { default: true });
		assert.equal(core.bots.defaultBot().name, "ops");
		assert.equal(loadConfig(path).bots.filter((b) => b.default).length, 1);
	} finally {
		await core.close();
		await cleanup();
	}
});

test("overrides an older version kept in app.sqlite move into config.yaml at startup", async () => {
	const { dir, path, core, cleanup } = await setup();
	let next: Awaited<ReturnType<typeof createCore>> | undefined;
	try {
		core.bots.setOverrides("ops", { model: "faux/faux-2", thinking: "low", disabledSkills: ["x"] });
		await core.close();
		next = await createCore(loadConfig(path), { models: fauxModels().models });
		const ops = loadConfig(path).bots.find((b) => b.name === "ops")!;
		assert.equal(ops.model, "faux/faux-2");
		assert.equal(ops.thinking, "low");
		assert.match(readFileSync(path, "utf8"), /# infrastructure/, "comments kept");
		assert.deepEqual(next.bots.overrides("ops"), { disabledSkills: ["x"] }, "skill toggles stay where they were");
		assert.equal(next.bots.require("ops").model.modelId, "faux-2");
		assert.ok(readFileSync(join(dir, "config.yaml.prev"), "utf8").includes("name: ops"), "the file before the move is kept");
	} finally {
		await next?.close();
		await cleanup();
	}
});

test("add and remove bots; instructions kept in a SOUL file stay there", async () => {
	const { dir, path, core, cleanup } = await setup();
	try {
		core.settings.addBot({ name: "research", description: "Reads papers", tools: ["web", "memory"] });
		assert.equal(core.bots.get("research")?.description, "Reads papers");
		assert.throws(() => core.settings.addBot({ name: "research" }), /already exists/);
		assert.throws(() => core.settings.removeBot("main"), /default bot cannot be removed/);

		mkdirSync(join(dir, "bots", "research"), { recursive: true });
		writeFileSync(join(dir, "bots", "research", "SOUL.md"), "Old soul.\n");
		core.settings.editBot("research", { instructions: "New soul." });
		assert.equal(readFileSync(join(dir, "bots", "research", "SOUL.md"), "utf8"), "New soul.\n");
		assert.doesNotMatch(readFileSync(path, "utf8"), /New soul/);
		assert.equal(core.bots.get("research")!.instructions, "New soul.");

		core.settings.removeBot("research");
		assert.equal(core.bots.get("research"), undefined);
		assert.doesNotMatch(readFileSync(path, "utf8"), /research/);
	} finally {
		await core.close();
		await cleanup();
	}
});

test("admin API: config view, bot edits, unknown settings refused", async () => {
	const { core, cleanup } = await setup();
	const server = await startHermesServer(core, { host: "127.0.0.1", port: 0, extraRouters: [adminRoutes(core)] });
	const call = (method: string, path: string, body?: unknown) =>
		fetch(`http://127.0.0.1:${server.port}${path}`, { method, headers: { "X-Hermes-Session-Token": TOKEN, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
	try {
		const view = (await (await call("GET", "/admin/config")).json()) as { bots: { name: string; effective: { instructionsFrom: string } }[]; toolGroups: string[] };
		assert.deepEqual(view.bots.map((b) => b.name), ["main", "ops"]);
		assert.equal(view.bots[0]!.effective.instructionsFrom, "config");
		assert.ok(view.toolGroups.includes("delegate"));

		const ok = await call("PATCH", "/admin/bots/ops", { thinking: "high" });
		assert.equal(ok.status, 200);
		assert.equal(core.bots.get("ops")!.thinking, "high");
		assert.equal((await call("PATCH", "/admin/bots/ops", { name: "x" })).status, 400);
		assert.equal((await call("PATCH", "/admin/bots/ops", { thinking: "galaxy" })).status, 400);
		assert.equal((await call("POST", "/admin/bots", { name: "notes", description: "Notes" })).status, 200);
		assert.equal((await call("DELETE", "/admin/bots/notes")).status, 200);
		assert.equal((await call("POST", "/admin/reload")).status, 200);
	} finally {
		await server.close();
		await core.close();
		await cleanup();
	}
});
