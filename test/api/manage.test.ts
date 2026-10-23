// The client API's gateway upkeep: settings, keys (never a value back, never the token), scheduled tasks,
// logs, usage, the bots' workspace files (read-only, nothing outside), a chat's file for a chat with a
// member's bot, and software with its actions (updates replaced, as in the Hermes maintenance test).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import type { Core } from "../../src/app.ts";
import type { BotConfig } from "../../src/config.ts";
import { logger, setLogLevel } from "../../src/log.ts";
import { ApiClient } from "../../src/remote/api-client.ts";
import { type GatewayServer, startServer } from "../../src/server.ts";
import { pngBytes, TOKEN, tempDir, testConfig, testCore } from "../helpers.ts";
import { ApiSocketClient, http } from "./client.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, encoding: "utf8" }).trim();
type Obj = Record<string, any>;

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

	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }, { id: "faux-2" }], tokensPerSecond: 2000 });
	const models = createModels();
	models.setProvider(faux.provider);
	let restarts = 0;
	const config = testConfig(t.dir, [{ name: "main", displayName: "Main", default: true }, { name: "ops", displayName: "Ops" }]);
	writeFileSync(config.configPath, `server:\n  host: 127.0.0.1\n  port: 0\ndefaults:\n  model: faux/faux-1\nbots:\n  - name: main\n    default: true\n  - name: ops\n`);
	const core = await testCore(t.dir, { models, config, updates: { codeDir: code, installPackages: () => {}, restart: () => void restarts++, managed: opts.managed ?? true } });
	const server = await startServer(core, { host: "127.0.0.1", port: 0, federationPort: null });
	const call = http(server.port);
	return {
		...t,
		core,
		faux,
		server,
		call,
		restarts: () => restarts,
		close: async () => {
			await server.close();
			await core.close();
			await t.cleanup();
		},
	};
}

const finishedOf = (sid: string) => (e: { event: string; sessionId?: string }) => e.event === "turn.finished" && e.sessionId === sid;
const code = async (p: Promise<unknown>) => p.then(() => "ok", (e: { code: string }) => e.code);

test("gateway settings: read, change, restart-only ones reported, bad values refused", async () => {
	const g = await setup();
	try {
		const s = await g.call<Obj>("GET /gateway/settings");
		assert.equal(s.timeZone, "America/New_York");
		assert.deepEqual(s.defaults, { model: "faux/faux-1", thinking: "medium", approvals: "smart", approvalTimeoutS: 30 });
		assert.deepEqual(s.hiddenModelProviders, ["openrouter"]);
		assert.equal(s.groundRules, null);

		const r = await g.call<Obj>("PATCH /gateway/settings", { defaults: { thinking: "high", model: "faux/faux-2" }, groundRules: "Be brief.", hiddenModelProviders: ["openrouter", "other"], review: { allowThreshold: 0.9 }, timeZone: "Europe/London" });
		assert.equal(r.settings.defaults.thinking, "high");
		assert.equal(r.settings.defaults.model, "faux/faux-2");
		assert.equal(r.settings.groundRules, "Be brief.");
		assert.deepEqual(r.settings.hiddenModelProviders, ["openrouter", "other"]);
		assert.equal(r.settings.review.allowThreshold, 0.9);
		assert.ok(r.restartNeeded.includes("timezone"), "the time zone applies after a restart");
		assert.deepEqual((await g.call<Obj>("GET /gateway/settings")).defaults.thinking, "high");
		assert.equal((await g.call<Obj>("PATCH /gateway/settings", { groundRules: null })).settings.groundRules, null);

		for (const bad of [{ defaults: { thinking: "max" } }, { defaults: { model: "nope/none" } }, { defaults: { approvals: "sometimes" } }, { defaults: { approvalTimeoutS: -1 } }, { review: { allowThreshold: 0.1 } }]) {
			await assert.rejects(g.call("PATCH /gateway/settings", bad), (e: { code: string }) => e.code === "invalid_params", JSON.stringify(bad));
		}
	} finally {
		await g.close();
	}
});

test("logs: the last lines, capped", async () => {
	const g = await setup();
	try {
		setLogLevel("info");
		logger("test").info("hello from the api test", { n: 1 });
		setLogLevel("error");
		const { lines } = await g.call<{ lines: string[] }>("GET /gateway/logs", { lines: 50 });
		assert.ok(lines.length <= 50);
		assert.ok(lines.some((l) => l.includes("hello from the api test")));
		assert.ok((await g.call<{ lines: string[] }>("GET /gateway/logs")).lines.length <= 200);
		await assert.rejects(g.call("GET /gateway/logs", { lines: 501 }), (e: { code: string }) => e.code === "invalid_params");
	} finally {
		await g.close();
	}
});

test("keys: listed without values, set and removed, the gateway token refused", async () => {
	const g = await setup();
	try {
		const secret = "sk-test-secret-value-1234567890";
		const set = await g.call<Obj>("PUT /keys/TEST_API_KEY_X", { value: secret });
		assert.equal(set.key.name, "TEST_API_KEY_X");
		assert.equal(set.key.set, true);
		assert.equal(set.key.hint, "…7890");
		assert.equal(typeof set.restartNeeded, "boolean");
		const list = await g.call<{ items: Obj[]; nextCursor: null }>("GET /keys");
		assert.equal(list.nextCursor, null);
		const mine = list.items.find((k) => k.name === "TEST_API_KEY_X")!;
		assert.deepEqual(Object.keys(mine).sort(), ["description", "hint", "name", "set", "usedBy"]);
		assert.ok(!JSON.stringify([set, list]).includes(secret), "no value ever comes back");
		assert.ok(list.items.some((k) => k.name === "NHERMES_TOKEN" && k.set), "the token is listed, as set");
		assert.ok(!JSON.stringify(list).includes(TOKEN));
		assert.match(readFileSync(g.core.config.secretsPath, "utf8"), /TEST_API_KEY_X=/);

		const removed = await g.call<Obj>("DELETE /keys/TEST_API_KEY_X");
		assert.equal(removed.key.set, false);
		assert.equal(removed.key.hint, null);
		await assert.rejects(g.call("DELETE /keys/TEST_API_KEY_X"), (e: { code: string }) => e.code === "not_found");
		await assert.rejects(g.call("PUT /keys/TEST_API_KEY_X", { value: "two\nlines" }), (e: { code: string }) => e.code === "invalid_params");

		for (const route of ["PUT /keys/NHERMES_TOKEN", "DELETE /keys/NHERMES_TOKEN"] as const) {
			await assert.rejects(g.call(route, { value: "a-new-token-0123456789" }), (e: { code: string; message: string }) => e.code === "not_allowed" && /panel|nhermes/.test(e.message), route);
		}
		assert.equal(process.env.NHERMES_TOKEN, TOKEN);
	} finally {
		delete process.env.TEST_API_KEY_X;
		await g.close();
	}
});

test("jobs: create, edit, run at once, pause, resume, runs and delete", async () => {
	const g = await setup();
	const ws = await ApiSocketClient.connect(g.server.port);
	try {
		const { job } = await g.call<{ job: Obj }>("POST /jobs", { name: "Morning brief", prompt: "Summarize alerts", schedule: "0 7 * * 1-5", botId: "ops" });
		assert.equal(job.botId, "ops");
		assert.equal(job.state, "active");
		assert.equal(job.scheduleDetail.kind, "cron");
		assert.equal(job.scheduleDetail.timezone, "America/New_York");
		assert.equal(typeof job.schedule, "string");
		assert.ok(job.nextRunAt > Date.now());
		assert.equal(job.lastRunAt, null);
		await ws.waitEvent("jobs.changed");

		await assert.rejects(g.call("POST /jobs", { name: "x", prompt: "y", schedule: "whenever" }), (e: { code: string }) => e.code === "invalid_params");
		await assert.rejects(g.call("POST /jobs", { prompt: "y", schedule: "every 5m" }), (e: { code: string }) => e.code === "invalid_params");
		await assert.rejects(g.call("POST /jobs", { name: "x", prompt: "y", schedule: "every 5m", botId: "nobody" }), (e: { code: string }) => e.code === "invalid_params");

		const dflt = (await g.call<{ job: Obj }>("POST /jobs", { name: "Default bot", prompt: "ping", schedule: "every 1h" })).job;
		assert.equal(dflt.botId, "main");
		assert.deepEqual((await g.call<{ items: Obj[] }>("GET /jobs", { botId: "ops" })).items.map((j) => j.id), [job.id]);
		assert.equal((await g.call<{ items: Obj[] }>("GET /jobs")).items.length, 2);

		const edited = (await g.call<{ job: Obj }>("PATCH /jobs/" + job.id, { schedule: "30 6 * * *", context: "continue", skills: ["a"], model: null })).job;
		assert.equal(edited.context, "continue");
		assert.deepEqual(edited.skills, ["a"]);
		assert.equal((await g.call<{ job: Obj }>("GET /jobs/" + job.id)).job.schedule, edited.schedule);
		await assert.rejects(g.call("PATCH /jobs/" + job.id, { context: "forever" }), (e: { code: string }) => e.code === "invalid_params");
		await assert.rejects(g.call("GET /jobs/nope"), (e: { code: string }) => e.code === "not_found");

		const paused = (await g.call<{ job: Obj }>("POST /jobs/" + job.id + "/pause")).job;
		assert.deepEqual([paused.state, paused.enabled, paused.nextRunAt], ["paused", false, null]);
		const resumed = (await g.call<{ job: Obj }>("POST /jobs/" + job.id + "/resume")).job;
		assert.deepEqual([resumed.state, resumed.enabled], ["active", true]);

		// Run now answers as soon as the run has started; the end shows in the runs.
		g.faux.setResponses([fauxAssistantMessage([fauxText("No alerts overnight.")])]);
		const { run } = await g.call<{ run: Obj }>("POST /jobs/" + job.id + "/run");
		assert.equal(run.jobId, job.id);
		assert.equal(run.trigger, "manual");
		assert.ok(["running", "ok"].includes(run.status));
		assert.ok(run.sessionId, "the run's chat");
		await g.core.scheduler.waitRun(run.id, 10_000);
		const { items } = await g.call<{ items: Obj[] }>("GET /jobs/" + job.id + "/runs", { limit: 5 });
		assert.equal(items[0]!.status, "ok");
		assert.match(items[0]!.summary, /No alerts overnight/);
		assert.equal(typeof items[0]!.finishedAt, "number");
		const after = (await g.call<{ job: Obj }>("GET /jobs/" + job.id)).job;
		assert.deepEqual([after.lastStatus, after.lastError], ["ok", null]);
		assert.equal(after.sessionId, run.sessionId);

		assert.deepEqual(await g.call("DELETE /jobs/" + job.id), { deleted: true, id: job.id });
		await assert.rejects(g.call("GET /jobs/" + job.id), (e: { code: string }) => e.code === "not_found");
	} finally {
		await ws.close();
		await g.close();
	}
});

test("usage: totals after a chat, by day and model; one bot; a bot with no chats", async () => {
	const g = await setup();
	const app = await ApiSocketClient.connect(g.server.port);
	try {
		const empty = await g.call<Obj>("GET /gateway/usage");
		assert.deepEqual([empty.days, empty.daily, empty.totals.calls], [30, [], 0]);
		const { session } = (await app.call("sessions.create", { botId: "main" })) as { session: { id: string } };
		await app.call("sessions.subscribe", { id: session.id });
		g.faux.setResponses([fauxAssistantMessage([fauxText("Hello there.")])]);
		await app.call("sessions.submit", { id: session.id, text: "hi" });
		await app.waitEvent(finishedOf(session.id), 20000);

		const all = await g.call<Obj>("GET /gateway/usage", { days: 7 });
		assert.equal(all.days, 7);
		assert.ok(all.totals.calls >= 1 && all.totals.input > 0 && all.totals.output > 0);
		assert.equal(all.totals.sessions, 1);
		assert.equal(all.daily.length, 1);
		assert.equal(all.daily[0].calls, all.totals.calls);
		assert.match(all.daily[0].day, /^\d{4}-\d\d-\d\d$/);
		assert.deepEqual(all.byModel.map((m: Obj) => m.model), ["faux/faux-1"]);
		assert.equal(typeof all.totals.cost, "number");
		assert.equal((await g.call<Obj>("GET /gateway/usage", { botId: "main" })).totals.calls, all.totals.calls);
		assert.equal((await g.call<Obj>("GET /gateway/usage", { botId: "ops" })).totals.calls, 0);
		await assert.rejects(g.call("GET /gateway/usage", { botId: "nobody" }), (e: { code: string }) => e.code === "bot_not_found");
		await assert.rejects(g.call("GET /gateway/usage", { days: 0 }), (e: { code: string }) => e.code === "invalid_params");
	} finally {
		await app.close();
		await g.close();
	}
});

test("files: the bots' workspaces, read-only, nothing outside them, nothing through a link", async () => {
	const g = await setup();
	const app = await ApiSocketClient.connect(g.server.port);
	try {
		const ws = g.core.bots.require("main").workspace;
		mkdirSync(join(ws, "sub"), { recursive: true });
		writeFileSync(join(ws, "notes.txt"), "hello files");
		writeFileSync(join(ws, "pic.png"), pngBytes(4, 4));
		const outside = join(dirname(ws), "outside.txt");
		writeFileSync(outside, "private");
		symlinkSync(outside, join(ws, "escape.txt"));

		const roots = await g.call<{ items: Obj[]; path: string }>("GET /files");
		assert.equal(roots.path, "/");
		assert.deepEqual(roots.items.map((e) => e.botId).sort(), ["main", "ops"]);
		assert.equal((await g.call<Obj>("GET /files", { path: "/" })).items.length, 2);
		const dir = await g.call<{ items: Obj[]; parent: string }>("GET /files", { path: ws });
		assert.equal(dir.parent, "/");
		assert.deepEqual(dir.items.filter((e) => e.name !== "escape.txt").map((e) => [e.name, e.isDirectory]), [["sub", true], ["notes.txt", false], ["pic.png", false]].filter(([n]) => dir.items.some((e) => e.name === n)));
		assert.equal(dir.items.find((e) => e.name === "notes.txt")!.mime, "text/plain");
		assert.equal(dir.items.find((e) => e.name === "notes.txt")!.size, 11);
		assert.equal((await g.call<Obj>("GET /files", { path: join(ws, "sub") })).parent, ws);

		const res = await fetch(`http://127.0.0.1:${g.server.port}/api/v1/files/content?path=${encodeURIComponent(join(ws, "notes.txt"))}`, { headers: { authorization: `Bearer ${TOKEN}` } });
		assert.equal(res.status, 200);
		assert.match(res.headers.get("content-type") ?? "", /text\/plain/);
		assert.equal(await res.text(), "hello files");
		// Over the socket the bytes are base64.
		const viaSocket = (await app.call("files.content", { path: join(ws, "pic.png") })) as { name: string; mime: string; data: string };
		assert.deepEqual([viaSocket.name, viaSocket.mime], ["pic.png", "image/png"]);
		assert.deepEqual(Buffer.from(viaSocket.data, "base64"), readFileSync(join(ws, "pic.png")));

		const denied = (e: { code: string }) => e.code === "not_allowed";
		await assert.rejects(g.call("GET /files/content", { path: join(ws, "escape.txt") }), denied, "a link out of the workspace");
		await assert.rejects(g.call("GET /files/content", { path: join(ws, "..", "outside.txt") }), denied);
		await assert.rejects(g.call("GET /files/content", { path: outside }), denied);
		await assert.rejects(g.call("GET /files/content", { path: "/etc/hosts" }), denied);
		await assert.rejects(g.call("GET /files", { path: g.dir }), denied);
		await assert.rejects(g.call("GET /files/content", { path: join(ws, "missing.txt") }), (e: { code: string }) => e.code === "not_found");
		await assert.rejects(g.call("GET /files/content", { path: "notes.txt" }), (e: { code: string }) => e.code === "invalid_params");
		await assert.rejects(g.call("GET /files/content", { path: join(ws, "sub") }), (e: { code: string }) => e.code === "invalid_params");
		await assert.rejects(g.call("PUT /files/content", { path: join(ws, "x") }), (e: { code: string }) => e.code === "method_not_allowed");

		// A chat's file: relative to the chat's bot's workspace, or absolute inside it; another bot's workspace is out.
		const { session } = (await app.call("sessions.create", { botId: "main" })) as { session: { id: string } };
		const url = (path: string) => `http://127.0.0.1:${g.server.port}/api/v1/sessions/${session.id}/files/content?path=${encodeURIComponent(path)}`;
		const rel = await fetch(url("pic.png"), { headers: { authorization: `Bearer ${TOKEN}` } });
		assert.equal(rel.status, 200);
		assert.equal(rel.headers.get("content-type"), "image/png");
		assert.deepEqual(Buffer.from(await rel.arrayBuffer()), readFileSync(join(ws, "pic.png")));
		assert.equal((await fetch(url(join(ws, "notes.txt")), { headers: { authorization: `Bearer ${TOKEN}` } })).status, 200);
		const other = g.core.bots.require("ops").workspace;
		writeFileSync(join(other, "ops.txt"), "ops only");
		assert.equal((await fetch(url(join(other, "ops.txt")), { headers: { authorization: `Bearer ${TOKEN}` } })).status, 403, "another bot's workspace");
		assert.equal((await fetch(url("escape.txt"), { headers: { authorization: `Bearer ${TOKEN}` } })).status, 403);
		assert.equal((await fetch(url("../ops/ops.txt"), { headers: { authorization: `Bearer ${TOKEN}` } })).status, 403);
		assert.equal((await fetch(url("gone.png"), { headers: { authorization: `Bearer ${TOKEN}` } })).status, 404);
		assert.equal(await code(app.call("sessions.file", { id: "nope", path: "pic.png" })), "session_not_found");
	} finally {
		await app.close();
		await g.close();
	}
});

test("software and actions: status, check, update and restart (running until a new process answers), doctor", async () => {
	const g = await setup();
	try {
		const before = await g.call<Obj>("GET /software");
		assert.deepEqual([before.canUpdate, before.canRestart, before.reason], [true, true, null]);
		assert.equal(typeof before.version, "string");
		assert.equal(before.commit.subject, "first");

		const check = (await g.call<{ action: Obj }>("POST /actions", { kind: "check" })).action;
		assert.deepEqual([check.kind, check.status, check.exitCode], ["check", "done", 0]);
		assert.match(check.lines.join("\n"), /second/);
		assert.equal((await g.call<Obj>("GET /software")).behind, 1);
		assert.deepEqual((await g.call<{ action: Obj }>("GET /actions/" + check.id)).action, check);

		const up = (await g.call<{ action: Obj }>("POST /actions", { kind: "update" })).action;
		assert.equal(up.status, "running", "running until the gateway comes back");
		assert.equal(up.finishedAt, null);
		await new Promise((r) => setTimeout(r, 700));
		assert.equal(g.restarts(), 1);
		g.core.db.run("UPDATE settings SET value = json_set(value, '$.boot', 'earlier') WHERE key = ?", `actions.run.${up.id}`);
		const done = (await g.call<{ action: Obj }>("GET /actions/" + up.id)).action;
		assert.deepEqual([done.status, done.exitCode], ["done", 0]);
		assert.match(done.lines.join("\n"), /Updated .* → .* \(second\)[\s\S]*Back up/);
		assert.equal(typeof done.finishedAt, "number");
		await assert.rejects(g.call("POST /actions", { kind: "update" }), (e: { code: string }) => e.code === "conflict", "already up to date");

		const restart = (await g.call<{ action: Obj }>("POST /actions", { kind: "restart" })).action;
		assert.equal(restart.status, "running");
		await new Promise((r) => setTimeout(r, 700));
		assert.equal(g.restarts(), 2);

		const doctor = (await g.call<{ action: Obj }>("POST /actions", { kind: "doctor" })).action;
		assert.equal(doctor.kind, "doctor");
		let seen = doctor;
		for (let i = 0; i < 100 && seen.status === "running"; i++) {
			await new Promise((r) => setTimeout(r, 100));
			seen = (await g.call<{ action: Obj }>("GET /actions/" + doctor.id)).action;
		}
		assert.notEqual(seen.status, "running");
		assert.match(seen.lines.join("\n"), /✓ config\.yaml loads/);

		await assert.rejects(g.call("POST /actions", { kind: "rollback" }), (e: { code: string }) => e.code === "invalid_params");
		await assert.rejects(g.call("POST /actions", {}), (e: { code: string }) => e.code === "invalid_params");
		await assert.rejects(g.call("GET /actions/nope"), (e: { code: string }) => e.code === "not_found");
	} finally {
		await g.close();
	}
});

test("software: a gateway no service manager restarts says why", async () => {
	const g = await setup({ managed: false });
	try {
		const s = await g.call<Obj>("GET /software");
		assert.deepEqual([s.canUpdate, s.canRestart], [true, false]);
		assert.match(s.reason, /systemd or launchd/);
		await assert.rejects(g.call("POST /actions", { kind: "restart" }), (e: { code: string }) => e.code === "conflict");
	} finally {
		await g.close();
	}
});

// ---- A chat with a member's bot ----

type Gw = { core: Core; server: GatewayServer; port: number };

async function gateway(dir: string, name: string, bots: BotConfig[]): Promise<Gw> {
	const d = join(dir, name);
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }], tokensPerSecond: 400 });
	const models = createModels();
	models.setProvider(faux.provider);
	const core = await testCore(d, { models, config: testConfig(d, bots, { node: { name } }) });
	const server = await startServer(core, { host: "127.0.0.1", port: 0 });
	return { core, server, port: server.port };
}

test("a file of a chat with a member's bot opens through the owner; a member sees only its own chats' files", async () => {
	const { dir, cleanup } = await tempDir();
	const a = await gateway(dir, "alpha", [{ name: "main", default: true }]);
	const b = await gateway(dir, "beta", [{ name: "nasbot", default: true }]);
	const { code: invite } = a.core.members.invite();
	await b.core.members.join(invite);
	await a.core.roster.sync();
	const app = await ApiSocketClient.connect(a.port);
	const target = b.core.members.target(a.core.members.self().id)!;
	const asMember = await ApiClient.open(target, "alpha");
	try {
		const { session } = (await app.call("sessions.create", { botId: "nasbot-beta" })) as { session: { id: string } };
		const ws = b.core.bots.require("nasbot").workspace;
		mkdirSync(ws, { recursive: true });
		const png = pngBytes(6, 6);
		writeFileSync(join(ws, "pool.png"), png);
		writeFileSync(join(dirname(ws), "outside.txt"), "private");
		symlinkSync(join(dirname(ws), "outside.txt"), join(ws, "link.txt"));

		const open = (path: string) => fetch(`http://127.0.0.1:${a.port}/api/v1/sessions/${session.id}/files/content?path=${encodeURIComponent(path)}`, { headers: { authorization: `Bearer ${TOKEN}` } });
		const res = await open("pool.png");
		assert.equal(res.status, 200);
		assert.equal(res.headers.get("content-type"), "image/png");
		assert.deepEqual(Buffer.from(await res.arrayBuffer()), png, "beta answers for its own bot");
		const viaSocket = (await app.call("sessions.file", { id: session.id, path: "pool.png" })) as { mime: string; data: string };
		assert.deepEqual([viaSocket.mime, Buffer.from(viaSocket.data, "base64").equals(png)], ["image/png", true]);
		assert.equal((await open("link.txt")).status, 403, "beta refuses a link out of its workspace");
		assert.equal((await open("../outside.txt")).status, 403);
		assert.equal((await open("missing.png")).status, 404);

		// Beta, as a member of alpha, has no part in the owner's chats; and no owner-only operation.
		const owners = await http(a.port)<{ session: { id: string } }>("POST /sessions", {});
		await assert.rejects(asMember.call("sessions.file", { id: owners.session.id, path: "x.png" }), (e: { code: string }) => e.code === "session_not_found");
		for (const op of ["files.list", "gateway.settings", "keys.list", "jobs.list", "actions.start"]) {
			await assert.rejects(asMember.call(op, {}), (e: { code: string }) => e.code === "unknown_op", op);
		}
	} finally {
		asMember.close();
		await app.close();
		for (const g of [a, b]) {
			await g.server.close();
			await g.core.close();
		}
		await cleanup();
	}
});
