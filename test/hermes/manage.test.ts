// Vory's settings and maintenance screens: update/restart/doctor with the action status Vory polls,
// logs, per-bot config writes, tool groups, the default model, keys, creating and removing bots, usage
// analytics from real turns, and a read-only Files browser that stays inside the bots' workspaces.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { createCore } from "../../src/app.ts";
import { loadConfig } from "../../src/config.ts";
import { startHermesServer } from "../../src/hermes/server.ts";
import { logger, setLogLevel } from "../../src/log.ts";
import { collect, fauxModels, TOKEN, tempDir } from "../helpers.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, encoding: "utf8" }).trim();

async function setup(opts: { managed?: boolean } = {}) {
	const t = await tempDir();
	process.env.NHERMES_TOKEN = TOKEN;
	// A checkout with an upstream that is one commit ahead.
	const origin = join(t.dir, "origin.git");
	const dev = join(t.dir, "dev");
	const code = join(t.dir, "code");
	mkdirSync(dev);
	git(t.dir, "init", "-q", "--bare", "-b", "main", origin);
	git(dev, "init", "-q", "-b", "main");
	writeFileSync(join(dev, "README.md"), "one");
	git(dev, "add", ".");
	git(dev, "commit", "-q", "-m", "first");
	git(dev, "remote", "add", "origin", origin);
	git(dev, "push", "-q", "origin", "main");
	git(t.dir, "clone", "-q", origin, code);
	writeFileSync(join(dev, "README.md"), "two");
	git(dev, "commit", "-q", "-am", "second");
	git(dev, "push", "-q", "origin", "main");

	const path = join(t.dir, "config.yaml");
	writeFileSync(path, `server:\n  host: 127.0.0.1\n  port: 0\ndefaults:\n  model: faux/faux-1\nbots:\n  - name: main\n    default: true\n  - name: ops\n    description: Infrastructure\n    tools: [files, shell, memory]\n`);
	const { models, faux } = fauxModels();
	let restarts = 0;
	const core = await createCore(loadConfig(path), { models, updates: { codeDir: code, installPackages: () => {}, restart: () => void restarts++, managed: opts.managed ?? true } });
	const server = await startHermesServer(core, { host: "127.0.0.1", port: 0 });
	const base = `http://127.0.0.1:${server.port}`;
	const api = async (method: string, p: string, body?: unknown) => {
		const res = await fetch(`${base}${p}`, { method, headers: { "X-Hermes-Session-Token": TOKEN, ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
		const type = res.headers.get("content-type") ?? "";
		return { status: res.status, json: (type.includes("json") ? await res.json() : {}) as Record<string, any>, res };
	};
	const close = async () => {
		await server.close();
		await core.close();
		await t.cleanup();
	};
	return { ...t, path, core, faux, api, close, restarts: () => restarts };
}

test("maintenance: check, update and restart with the status Vory polls; doctor; logs", async () => {
	const { core, api, close, restarts } = await setup();
	try {
		const check = (await api("GET", "/api/hermes/update/check?force=true")).json;
		assert.deepEqual([check.install_method, check.behind, check.update_available, check.can_apply], ["git", 1, true, true]);
		assert.deepEqual(check.commits.map((c: { summary: string }) => c.summary), ["second"]);
		assert.deepEqual((await api("GET", "/api/actions/hermes-update/status")).json.running, false, "nothing ran yet");

		const up = await api("POST", "/api/hermes/update");
		assert.equal(up.status, 200, up.json.detail);
		let st = (await api("GET", "/api/actions/hermes-update/status")).json;
		assert.equal(st.running, true, "running until the gateway comes back");
		await new Promise((r) => setTimeout(r, 700));
		assert.equal(restarts(), 1);
		// A new process answers: the action is done.
		core.db.run("UPDATE settings SET value = json_set(value, '$.boot', 'earlier') WHERE key = 'actions.hermes-update'");
		st = (await api("GET", "/api/actions/hermes-update/status")).json;
		assert.deepEqual([st.running, st.exit_code, st.receipt.outcome], [false, 0, "success"]);
		assert.match(st.lines.join("\n"), /Updated .* → .* \(second\)[\s\S]*Back up/);
		assert.equal((await api("POST", "/api/hermes/update")).status, 409, "already up to date");

		assert.equal((await api("POST", "/api/gateway/restart")).status, 200);
		assert.equal((await api("GET", "/api/actions/gateway-restart/status")).json.running, true);
		await new Promise((r) => setTimeout(r, 700));
		assert.equal(restarts(), 2);

		const doc = (await api("POST", "/api/ops/doctor")).json;
		assert.match(doc.output, /✓ config\.yaml loads/);
		assert.match(doc.output, /main: model faux\/faux-1/);
		const ds = (await api("GET", "/api/actions/doctor/status")).json;
		assert.equal(ds.output, doc.output);
		assert.equal((await api("GET", "/api/actions/nope/status")).status, 404);

		setLogLevel("info");
		logger("test").info("hello from the test", { n: 1 });
		setLogLevel("error");
		const logs = (await api("GET", "/api/logs?file=agent&lines=50")).json;
		assert.ok(logs.lines.some((l: string) => /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d INFO \[test\] hello from the test \{"n":1\}$/.test(l)), "lines start with a timestamp Vory groups by");
	} finally {
		await close();
	}
});

test("maintenance: a gateway no service manager restarts refuses restart and says so", async () => {
	const { api, close } = await setup({ managed: false });
	try {
		const r = await api("POST", "/api/gateway/restart");
		assert.equal(r.status, 409);
		assert.match(r.json.detail, /not run by systemd or launchd/);
		assert.equal((await api("GET", "/api/hermes/update/check")).json.can_apply, false);
	} finally {
		await close();
	}
});

test("config, tool groups, model and keys are written for the selected bot", async () => {
	const { core, path, api, close } = await setup();
	try {
		let cfg = (await api("GET", "/api/config?profile=ops")).json.config;
		assert.deepEqual([cfg.model, cfg.approvals.mode, cfg.agent.reasoning_effort, cfg.dashboard.ws_orphan_reap_grace_s], ["faux/faux-1", "smart", "medium", 0]);

		assert.equal((await api("PUT", "/api/config?profile=ops", { config: { approvals: { mode: "manual" } } })).status, 200);
		assert.match(readFileSync(path, "utf8"), /name: ops[\s\S]*approvals:\s+mode: manual/);
		assert.equal((await api("PUT", "/api/config?profile=ops", { config: { agent: { reasoning_effort: "high" }, model: "faux/faux-2" } })).status, 200);
		const ops = core.bots.require("ops");
		assert.deepEqual([ops.thinking, ops.model.modelId], ["high", "faux-2"]);
		assert.equal(core.bots.require("main").thinking, "medium", "only the selected bot");

		core.approvals.addRule("bot:ops", "apt install *");
		core.approvals.addRule("bot:ops", "web_fetch");
		assert.deepEqual((await api("GET", "/api/config?profile=ops")).json.config.command_allowlist.sort(), ["apt install *", "web_fetch"]);
		assert.equal((await api("PUT", "/api/config?profile=ops", { config: { command_allowlist: ["web_fetch"] } })).status, 200);
		assert.deepEqual(core.approvals.rules("bot:ops"), ["web_fetch"]);

		assert.equal((await api("PUT", "/api/config", { config: { dashboard: { ws_orphan_reap_grace_s: 0 } } })).status, 200);
		assert.equal((await api("PUT", "/api/config", { config: { dashboard: { ws_orphan_reap_grace_s: 600 } } })).status, 400);
		assert.equal((await api("PUT", "/api/config", { config: { memory: { provider: "x" } } })).status, 400);
		assert.equal((await api("PUT", "/api/config", { config: { model: "faux/nope" } })).status, 400);

		// Tool groups: Vory's Tools toggles.
		assert.equal((await api("PUT", "/api/tools/toolsets/web?profile=ops", { enabled: true })).status, 200);
		assert.deepEqual(core.bots.require("ops").toolGroups, ["files", "shell", "memory", "web"]);
		assert.equal((await api("PUT", "/api/tools/toolsets/shell?profile=ops", { enabled: false })).status, 200);
		cfg = (await api("GET", "/api/tools/toolsets?profile=ops")).json;
		assert.equal((cfg as unknown as { name: string; enabled: boolean }[]).find((t) => t.name === "shell")!.enabled, false);
		assert.equal((await api("PUT", "/api/tools/toolsets/teleport?profile=ops", { enabled: true })).status, 404);

		// The Model page's "Change default model".
		assert.equal((await api("POST", "/api/model/set?profile=main", { scope: "main", provider: "faux", model: "faux-2" })).status, 200);
		assert.equal(core.bots.require("main").model.modelId, "faux-2");
		assert.equal((await api("POST", "/api/model/set", { scope: "auxiliary", task: "vision", provider: "faux", model: "faux-2" })).status, 400);

		// Keys: set and clear; never the gateway token.
		assert.equal((await api("PUT", "/api/env", { key: "BRAVE_API_KEY", value: "brave-0123456789" })).status, 200);
		assert.equal((await api("GET", "/api/env")).json.BRAVE_API_KEY.is_set, true);
		assert.equal((await api("DELETE", "/api/env", { key: "BRAVE_API_KEY" })).status, 200);
		assert.equal((await api("PUT", "/api/env", { key: "NHERMES_TOKEN", value: "x".repeat(32) })).status, 403);
		assert.equal((await api("PUT", "/api/env", { key: "bad name", value: "x" })).status, 400);
	} finally {
		delete process.env.BRAVE_API_KEY;
		await close();
	}
});

test("bots are created (optionally from another's settings) and removed", async () => {
	const { core, path, api, close } = await setup();
	try {
		assert.equal((await api("POST", "/api/profiles", { name: "ops2", clone_from: "ops" })).status, 200);
		const clone = core.bots.require("ops2");
		assert.deepEqual([clone.toolGroups, clone.description, clone.isDefault], [["files", "shell", "memory"], "Infrastructure", false]);
		assert.equal((await api("POST", "/api/profiles", { name: "ops2" })).status, 400, "taken");
		assert.equal((await api("POST", "/api/profiles", { name: "Bad Name" })).status, 400);
		assert.equal((await api("DELETE", "/api/profiles/ops2")).status, 200);
		assert.doesNotMatch(readFileSync(path, "utf8"), /ops2/);
		assert.equal((await api("DELETE", "/api/profiles/main")).status, 400, "the default bot stays");
	} finally {
		await close();
	}
});

test("usage analytics come from the chats' model calls", async () => {
	const { core, faux, api, close } = await setup();
	try {
		const s = await core.sessions.create("main");
		const ev = collect(core.hub, s.id);
		faux.setResponses([fauxAssistantMessage([fauxText("Hello there, how can I help?")])]);
		await core.sessions.submit(s.id, "hi");
		await ev.until((e) => e.type === "run.finished");
		const a = (await api("GET", "/api/analytics/usage?days=7&profile=main")).json;
		assert.equal(a.period_days, 7);
		assert.equal(a.daily.length, 1);
		assert.equal(a.totals.total_api_calls, 1);
		assert.equal(a.totals.total_sessions, 1);
		assert.ok(a.totals.total_output > 0 && a.totals.total_input > 0);
		assert.deepEqual(a.by_model.map((m: { model: string }) => m.model), ["faux/faux-1"]);
		assert.equal((await api("GET", "/api/analytics/usage?profile=ops")).json.totals.total_api_calls, 0, "per bot");
	} finally {
		await close();
	}
});

test("files: the bots' workspaces, read-only, nothing outside them", async () => {
	const { dir, core, api, close } = await setup();
	try {
		const ws = core.bots.require("main").workspace;
		mkdirSync(join(ws, "notes"));
		writeFileSync(join(ws, "notes", "todo.md"), "# Todo\n");
		writeFileSync(join(dir, "outside.txt"), "secret");
		symlinkSync(join(dir, "outside.txt"), join(ws, "escape.txt"));

		const root = (await api("GET", "/api/files")).json;
		assert.equal(root.path, "/");
		assert.ok(root.entries.some((e: { path: string; is_directory: boolean }) => e.path === ws && e.is_directory));
		const top = (await api("GET", `/api/files?path=${encodeURIComponent(ws)}`)).json;
		assert.equal(top.parent, "/");
		assert.deepEqual(top.entries.map((e: { name: string }) => e.name), ["notes", "escape.txt"]);
		const notes = (await api("GET", `/api/files?path=${encodeURIComponent(join(ws, "notes"))}`)).json;
		assert.equal(notes.parent, ws);

		const dl = await api("GET", `/api/files/download?path=${encodeURIComponent(join(ws, "notes", "todo.md"))}`);
		assert.equal(dl.status, 200);
		assert.equal(await dl.res.text(), "# Todo\n");
		assert.match(dl.res.headers.get("content-disposition") ?? "", /todo\.md/);

		assert.equal((await api("GET", `/api/files/download?path=${encodeURIComponent(join(ws, "escape.txt"))}`)).status, 403, "a link out of the workspace");
		assert.equal((await api("GET", `/api/files?path=${encodeURIComponent(dir)}`)).status, 403);
		assert.equal((await api("GET", `/api/files/download?path=${encodeURIComponent(join(ws, "..", "..", "..", "outside.txt"))}`)).status, 403);
		assert.equal((await api("POST", "/api/files/upload-stream", {})).status, 403);
	} finally {
		await close();
	}
});
