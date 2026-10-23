// The web control panel's API: open on the LAN without a password, closed behind a login cookie with
// one; changes only from the panel's own page (custom header, matching Origin, a local Host name); and
// the minimal session, memory, approval, bot and skill controls it offers.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { adminRoutes } from "../../src/admin.ts";
import { createCore } from "../../src/app.ts";
import { loadConfig } from "../../src/config.ts";
import { startServer } from "../../src/server.ts";
import { setThrottleClock } from "../../src/panel/auth.ts";
import { localHost } from "../../src/panel/panel.ts";
import { collect, fauxModels, TOKEN, tempDir } from "../helpers.ts";

async function setup() {
	const t = await tempDir();
	process.env.NHERMES_TOKEN = TOKEN;
	const path = join(t.dir, "config.yaml");
	writeFileSync(path, `server:\n  host: 127.0.0.1\n  port: 0\ndefaults:\n  model: faux/faux-1\nbots:\n  - name: main\n    default: true\n    sharedMemory: [household]\n  - name: ops\n    description: Infrastructure\n`);
	const { models, faux } = fauxModels();
	const core = await createCore(loadConfig(path), { models });
	const server = await startServer(core, { host: "127.0.0.1", port: 0, extraRouters: [adminRoutes(core)] });
	const base = `http://127.0.0.1:${server.port}`;
	let cookie = "";
	const panel = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
		const res = await fetch(`${base}/panel/api${path}`, {
			method,
			headers: { ...(method === "GET" ? {} : { "content-type": "application/json", "x-nhermes-panel": "1" }), ...(cookie ? { cookie } : {}), ...headers },
			body: body === undefined ? (method === "GET" ? undefined : "{}") : JSON.stringify(body),
		});
		const set = res.headers.get("set-cookie");
		if (set) cookie = set.split(";")[0]!;
		return { status: res.status, json: (await res.json()) as Record<string, unknown> & { detail?: string } };
	};
	return { ...t, path, core, server, base, faux, panel, forgetCookie: () => (cookie = "") };
}

test("the panel is open without a password, and only its own page can change things", async () => {
	const { core, server, base, panel, path, cleanup } = await setup();
	try {
		const page = await fetch(`${base}/panel/`);
		assert.equal(page.status, 200);
		assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'self'/);
		assert.equal((await fetch(`${base}/panel/panel.js`)).status, 200);
		assert.match(await page.text(), /src="\/panel\/panel\.js"/, "absolute paths: the page also works at /panel");
		const bare = await fetch(`${base}/panel`, { redirect: "manual" });
		assert.equal(bare.status, 301);
		assert.equal(bare.headers.get("location"), "/panel/");
		assert.equal((await fetch(`${base}/panel/config.yaml`)).status, 404);
		assert.equal((await fetch(`${base}/panel/%2e%2e%2fconfig.yaml`)).status, 404);
		const root = await fetch(`${base}/`, { redirect: "manual" });
		assert.equal(root.status, 302);
		assert.equal(root.headers.get("location"), "/panel/");

		const state = await panel("GET", "/state");
		assert.equal(state.status, 200);
		assert.deepEqual((state.json.bots as { name: string }[]).map((b) => b.name), ["main", "ops"]);
		assert.equal(JSON.stringify(state.json).includes(TOKEN), false, "the gateway token never reaches the browser");
		// The panel does not open the gateway's own API.
		assert.equal((await fetch(`${base}/api/profiles`)).status, 401);

		// Writes need the panel header, a matching Origin, JSON, and a local Host.
		assert.equal((await fetch(`${base}/panel/api/reload`, { method: "POST" })).status, 403);
		assert.equal((await panel("POST", "/reload", {}, { origin: "http://evil.example" })).status, 403);
		assert.equal((await panel("POST", "/reload", {}, { origin: base })).status, 200);
		assert.equal((await fetch(`${base}/panel/api/reload`, { method: "POST", headers: { "x-nhermes-panel": "1", "content-type": "text/plain" }, body: "x" })).status, 415);
		assert.equal(localHost("evil.example.com"), false);
		assert.equal(localHost("10.0.0.20:9119"), true);
		assert.equal(localHost("hermes:9119"), true);
		assert.equal(localHost("hermes.local"), true);
		assert.equal(localHost("hermes.tail1234.ts.net"), true);
		assert.equal(localHost("[fd7a::1]:9119"), true);
		assert.equal(localHost("panel.example.com", "http://panel.example.com:9119"), true);
		assert.equal(localHost("192.0.2.7"), true);
		assert.equal(localHost("localhost:9119"), true);
		assert.equal(localHost("hermes.home.arpa:9119"), true);
		assert.equal(localHost("nas.internal"), true);
		assert.equal(localHost("[::1]"), true);
		for (const bad of ["evil.com:1:2", "evil.com:80:lan", "host\u0000.lan", "300.300.300.300", "host:abc", "host:123456", "[evil.com]:80", "[::1", "a b", "host.lan/x", "user@host.lan", ""]) assert.equal(localHost(bad), false, JSON.stringify(bad));

		// A bot edit goes to config.yaml through the same settings service.
		const edited = await panel("PATCH", "/bots/ops", { description: "Machines", private: true });
		assert.equal(edited.status, 200, edited.json.detail);
		assert.equal(core.bots.get("ops")!.private, true);
		assert.equal((await panel("PATCH", "/bots/ops", { tools: ["teleport"] })).status, 400);
		// Recent chats: shown to the editor, saved to config.yaml, validated, removed with null.
		const effectiveOf = async (name: string) => ((await panel("GET", "/state")).json.bots as { name: string; effective: { recentChats: number } }[]).find((b) => b.name === name)!.effective;
		assert.equal((await effectiveOf("ops")).recentChats, 5);
		assert.equal((await panel("PATCH", "/bots/ops", { recentChats: 2 })).status, 200);
		assert.equal((await effectiveOf("ops")).recentChats, 2);
		assert.match(readFileSync(path, "utf8"), /recentChats: 2/);
		assert.equal((await panel("PATCH", "/bots/ops", { recentChats: 99 })).status, 400);
		assert.equal((await panel("PATCH", "/bots/ops", { recentChats: null })).status, 200);
		assert.equal((await effectiveOf("ops")).recentChats, 5);

		// The system prompt: shown in parts; the ground rules are editable for every bot and resettable.
		const prompt = (await panel("GET", "/bots/main/prompt")).json as { groundRules: string; groundRulesCustom: boolean; full: string; identity: string };
		assert.match(prompt.groundRules, /do not fake a capability you were not given/);
		assert.equal(prompt.groundRulesCustom, false);
		assert.ok(prompt.full.includes(prompt.identity) && prompt.full.includes(prompt.groundRules));
		assert.equal((await panel("PATCH", "/gateway", { groundRules: "Never touch the router.\nAsk before buying anything." })).status, 200);
		assert.match(readFileSync(path, "utf8"), /groundRules: \|\n\s+Never touch the router\.\n\s+Ask before buying anything\./);
		const custom = (await panel("GET", "/bots/ops/prompt")).json as { groundRules: string; groundRulesCustom: boolean };
		assert.deepEqual([custom.groundRules, custom.groundRulesCustom], ["Never touch the router.\nAsk before buying anything.", true]);
		assert.equal((await panel("PATCH", "/gateway", { groundRules: null })).status, 200);
		assert.equal(((await panel("GET", "/bots/ops/prompt")).json as { groundRulesCustom: boolean }).groundRulesCustom, false);
		assert.doesNotMatch(readFileSync(path, "utf8"), /groundRules/);
	} finally {
		await server.close();
		await core.close();
		await cleanup();
	}
});

test("panel: every skill a bot could use, switched on and off per bot", async () => {
	const { dir, core, server, panel, path, cleanup } = await setup();
	try {
		const skill = (root: string, name: string) => {
			mkdirSync(join(root, name), { recursive: true });
			writeFileSync(join(root, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} skill\n---\n\nDo it.\n`);
		};
		skill(join(dir, "skills"), "release-notes");
		skill(join(dir, "bots", "ops", "skills"), "proxmox-health");
		type List = { toolGroupOn: boolean; allGlobal: boolean; skills: { name: string; source: string; active: boolean }[] };
		const list = async (bot: string) => (await panel("GET", `/bots/${bot}/skills`)).json as List;
		let ops = await list("ops");
		assert.deepEqual([ops.toolGroupOn, ops.allGlobal], [true, false]);
		assert.deepEqual(ops.skills.map((s) => [s.name, s.source, s.active]), [["proxmox-health", "bot", true], ["release-notes", "global", false]]);
		assert.deepEqual((await list("main")).skills.map((s) => s.name), ["release-notes"], "another bot's own skills are not listed");

		assert.equal((await panel("PUT", "/bots/ops/skills/release-notes", { enabled: true })).status, 200);
		assert.equal((await panel("PUT", "/bots/ops/skills/proxmox-health", { enabled: false })).status, 200);
		ops = await list("ops");
		assert.deepEqual(ops.skills.map((s) => [s.name, s.active]), [["proxmox-health", false], ["release-notes", true]]);
		assert.deepEqual(core.bots.overrides("ops"), { disabledSkills: ["proxmox-health"], enabledSkills: ["release-notes"] });
		assert.equal((await panel("PUT", "/bots/ops/skills/nope", { enabled: true })).status, 404);
		assert.equal((await panel("PUT", "/bots/ops/skills/release-notes", {})).status, 400);
		assert.equal((await panel("GET", "/bots/ghost/skills")).status, 404);

		// "Every global skill" is skills: ["*"] in config.yaml; a skill switched off stays off.
		skill(join(dir, "skills"), "backup-check");
		core.skills.invalidate();
		assert.equal((await panel("PATCH", "/bots/main/skills", {})).status, 405);
		assert.equal((await panel("PATCH", "/bots/main", { skills: ["*"] })).status, 200);
		assert.match(readFileSync(path, "utf8"), /name: main[\s\S]*skills:\s+- "\*"\n\s+- name: ops/);
		assert.equal((await panel("PUT", "/bots/main/skills/backup-check", { enabled: false })).status, 200);
		const main = await list("main");
		assert.equal(main.allGlobal, true);
		assert.deepEqual(main.skills.map((s) => [s.name, s.active]), [["backup-check", false], ["release-notes", true]]);
		assert.equal((await panel("PATCH", "/bots/main", { skills: null })).status, 200);
		assert.deepEqual((await list("main")).skills.map((s) => s.active), [false, false]);
	} finally {
		await server.close();
		await core.close();
		await cleanup();
	}
});

test("with a password the panel needs a login cookie", async () => {
	const { core, server, base, panel, forgetCookie, cleanup } = await setup();
	let now = 1_000_000;
	setThrottleClock(() => now);
	try {
		const set = await fetch(`${base}/admin/panel/password`, { method: "POST", headers: { "X-Hermes-Session-Token": TOKEN, "content-type": "application/json" }, body: JSON.stringify({ password: "hunter22" }) });
		assert.equal(set.status, 200);
		assert.deepEqual((await panel("GET", "/session")).json, { passwordSet: true, signedIn: false });
		assert.equal((await panel("GET", "/state")).status, 401);
		assert.equal((await panel("POST", "/login", { password: "wrong-one" })).status, 401);
		// A failed login makes the same address wait before trying again (1 s, then 2 s, ...).
		const early = await panel("POST", "/login", { password: "hunter22" });
		assert.equal(early.status, 429);
		assert.match(String(early.json.detail), /wait \d+ seconds/);
		now += 1500;
		assert.equal((await panel("POST", "/login", { password: "wrong-two" })).status, 401);
		now += 1500;
		assert.equal((await panel("POST", "/login", { password: "hunter22" })).status, 429, "the second wait is 2 s");
		now += 1000;
		assert.equal((await panel("POST", "/login", { password: "hunter22" })).status, 200);
		assert.equal((await panel("GET", "/state")).status, 200);
		assert.equal((await panel("POST", "/password", { password: "abc" })).status, 400, "too short");

		// Changing the password signs other browsers out; this one gets a new cookie.
		const old = (await panel("GET", "/session")).json;
		assert.equal(old.signedIn, true);
		await panel("POST", "/logout");
		forgetCookie();
		assert.equal((await panel("GET", "/state")).status, 401);
		await panel("POST", "/login", { password: "hunter22" });
		assert.equal((await panel("POST", "/password", { password: null })).status, 200);
		forgetCookie();
		assert.equal((await panel("GET", "/state")).status, 200, "no password: open again");
	} finally {
		setThrottleClock(Date.now);
		await server.close();
		await core.close();
		await cleanup();
	}
});

test("the login cookie is Secure only when a proxy says the browser used HTTPS", async () => {
	const { core, server, base, cleanup } = await setup();
	try {
		await fetch(`${base}/admin/panel/password`, { method: "POST", headers: { "X-Hermes-Session-Token": TOKEN, "content-type": "application/json" }, body: JSON.stringify({ password: "hunter22" }) });
		const login = (extra: Record<string, string>) => fetch(`${base}/panel/api/login`, { method: "POST", headers: { "content-type": "application/json", "x-nhermes-panel": "1", ...extra }, body: JSON.stringify({ password: "hunter22" }) });
		assert.ok(!(await login({})).headers.get("set-cookie")!.includes("Secure"));
		assert.ok((await login({ "x-forwarded-proto": "https" })).headers.get("set-cookie")!.includes("; Secure"));
	} finally {
		await server.close();
		await core.close();
		await cleanup();
	}
});

test("sessions, memory and approvals from the panel", async () => {
	const { core, server, panel, faux, cleanup } = await setup();
	try {
		// Memory: a bot's own and a shared space.
		const added = await panel("POST", "/memory", { owner: "main", body: "The Wi-Fi password is on the fridge.", pinned: true });
		assert.equal(added.status, 200, added.json.detail);
		await panel("POST", "/memory", { owner: "shared:household", body: "Trash goes out on Tuesday." });
		const mine = await panel("GET", "/memory?owner=main");
		assert.deepEqual((mine.json.items as { body: string }[]).map((m) => m.body), ["The Wi-Fi password is on the fridge."]);
		const found = await panel("GET", "/memory?owner=shared:household&q=trash");
		assert.equal((found.json.items as unknown[]).length, 1);
		const id = (added.json as { id: number }).id;
		assert.equal((await panel("PATCH", `/memory/${id}`, { owner: "main", pinned: false, body: "The Wi-Fi password is in the drawer." })).status, 200);
		assert.equal(core.memory.get(id)!.body, "The Wi-Fi password is in the drawer.");
		assert.equal((await panel("PATCH", `/memory/${id}`, { owner: "ops", pinned: true })).status, 403, "another bot's memory");
		assert.deepEqual((await panel("DELETE", `/memory/${id}?owner=main`)).json, { deleted: true });

		// A run that waits for an approval: listed in Status, answered from the panel, then the chat is listed.
		const s = await core.sessions.create("ops");
		const ev = collect(core.hub, s.id);
		faux.setResponses([fauxAssistantMessage([fauxToolCall("bash", { command: "sudo reboot" })], { stopReason: "toolUse" }), fauxAssistantMessage([fauxText("Not rebooted.")])]);
		await core.sessions.submit(s.id, "Reboot the server");
		await ev.until((e) => e.type === "approval.requested", 10000);
		const status = await panel("GET", "/status");
		const pending = status.json.approvals as { id: string; command: string }[];
		assert.equal(pending.length, 1);
		assert.equal(pending[0]!.command, "sudo reboot");
		assert.deepEqual((await panel("POST", `/approvals/${pending[0]!.id}`, { choice: "deny" })).json, { answered: true });
		await ev.until((e) => e.type === "run.finished", 10000);

		// Scheduled jobs: their options ride on the line; paused and deleted from the panel.
		const job = core.scheduler.create({ name: "Watch disks", bot: "ops", prompt: "check", schedule: "every 1h", timezone: "UTC", context: "continue", deliver: "chat", notify: "on_change" });
		const jobsNow = async () => (await panel("GET", "/status")).json.jobs as Record<string, unknown>[];
		assert.deepEqual(
			(({ schedule, timezone, context, deliver, notify, enabled }) => ({ schedule, timezone, context, deliver, notify, enabled }))((await jobsNow())[0]!),
			{ schedule: "every 1h", timezone: "UTC", context: "continue", deliver: "chat", notify: "on_change", enabled: true },
		);
		assert.equal((await panel("POST", `/jobs/${job.id}/pause`)).status, 200);
		assert.equal((await jobsNow())[0]!.enabled, false);
		assert.deepEqual((await panel("DELETE", `/jobs/${job.id}`)).json, { deleted: true });
		assert.deepEqual(await jobsNow(), []);
		assert.equal((await panel("DELETE", `/jobs/${job.id}`)).status, 404);

		const list = await panel("GET", "/sessions?bot=ops");
		const rows = list.json.sessions as { id: string; title: string; running: boolean; usage: { total: number; calls: number } | null }[];
		assert.equal(rows.length, 1);
		assert.equal(rows[0]!.running, false);
		assert.ok(rows[0]!.usage && rows[0]!.usage.total > 0, "the chat's spend rides on its line");
		assert.deepEqual(rows[0]!.usage, await core.sessions.spend(s.id));
		// The next chat started with that one in its Recent chats, and the list shows it.
		const s2 = await core.sessions.create("ops");
		const ev2 = collect(core.hub, s2.id);
		faux.setResponses([fauxAssistantMessage([fauxText("Hello.")])]);
		await core.sessions.submit(s2.id, "hi");
		await ev2.until((e) => e.type === "run.finished", 10000);
		const both = (await panel("GET", "/sessions?bot=ops")).json.sessions as { id: string; recap: string | null }[];
		assert.match(both.find((r) => r.id === s2.id)!.recap ?? "", /Recent chats:[\s\S]*Reboot the server/);
		assert.equal(both.find((r) => r.id === s.id)!.recap, null, "the first chat had none to see");
		await core.sessions.delete(s2.id);
		assert.equal((await panel("PATCH", `/sessions/${s.id}`, { title: "Reboot attempt", archived: true })).status, 200);
		assert.equal(core.sessions.get(s.id)!.title, "Reboot attempt");
		assert.equal(((await panel("GET", "/sessions?bot=ops")).json.sessions as unknown[]).length, 0, "archived are hidden by default");
		assert.deepEqual((await panel("POST", `/sessions/${s.id}/stop`)).json, { stopped: false });
		assert.deepEqual((await panel("DELETE", `/sessions/${s.id}`)).json, { deleted: true });
		assert.equal((await panel("PATCH", `/sessions/nope`, { title: "x" })).status, 404);
	} finally {
		await server.close();
		await core.close();
		await cleanup();
	}
});

test("panel: keys are write-only, review settings and the review log", async () => {
	const { core, server, panel, path, cleanup } = await setup();
	try {
		const set = await panel("PUT", "/secrets/OPENROUTER_API_KEY", { value: "sk-or-panel-0123456789abcdef" });
		assert.equal(set.status, 200, set.json.detail);
		const listed = await panel("GET", "/secrets");
		assert.equal(JSON.stringify(listed.json).includes("sk-or-panel"), false, "no value comes back");
		assert.ok((listed.json.secrets as { name: string; set: boolean }[]).some((s) => s.name === "OPENROUTER_API_KEY" && s.set));
		assert.deepEqual((await panel("POST", "/secrets/OPENROUTER_API_KEY/hint")).json, { hint: "…cdef" });
		const state = (await panel("GET", "/state")).json as { review: { active: boolean; keySet: boolean; allowThreshold: number } };
		assert.deepEqual([state.review.keySet, state.review.active, state.review.allowThreshold], [true, true, 0.8]);
		assert.equal((await panel("PATCH", "/gateway", { review: { allowThreshold: 0.9 } })).status, 200);
		assert.equal(core.config.review.allowThreshold, 0.9);
		assert.match(readFileSync(path, "utf8"), /review:\n\s+jev:\n\s+allowThreshold: 0\.9/);
		assert.equal((await panel("PATCH", "/gateway", { review: { allowThreshold: 2 } })).status, 400);
		const reviews = (await panel("GET", "/reviews")).json as { reviews: unknown[]; active: boolean };
		assert.deepEqual([reviews.reviews.length, reviews.active], [0, true]);
		assert.equal((await panel("DELETE", "/secrets/OPENROUTER_API_KEY")).status, 200);
		assert.equal(((await panel("GET", "/state")).json as { review: { active: boolean } }).review.active, false);
	} finally {
		delete process.env.OPENROUTER_API_KEY;
		await server.close();
		await core.close();
		await cleanup();
	}
});

test("panel: connecting a client shows addresses and, on request, the token", async () => {
	const { core, server, base, panel, cleanup } = await setup();
	try {
		const r = (await panel("GET", "/connect")).json as { addresses: { label: string; url: string }[]; tokenEnv: string };
		assert.equal(r.tokenEnv, "NHERMES_TOKEN");
		assert.deepEqual(r.addresses.map((a) => a.url), [`http://127.0.0.1:${core.config.server.port}`]);
		assert.match(r.addresses[0]!.label, /This machine only/);
		assert.equal(JSON.stringify(r).includes(TOKEN), false, "the token is not part of the address list");
		// The token comes only from a deliberate request from the panel page.
		assert.equal((await fetch(`${base}/panel/api/connect/token`, { method: "POST" })).status, 403);
		assert.deepEqual((await panel("POST", "/connect/token")).json, { token: TOKEN, newTokenAfterRestart: false });
	} finally {
		await server.close();
		await core.close();
		await cleanup();
	}
});

test("panel: providers can be left out of model pickers; OpenRouter is by default", async () => {
	const { core, server, panel, path, cleanup } = await setup();
	try {
		let state = (await panel("GET", "/state")).json as { models: string[]; modelProviders: { name: string; shown: boolean }[] };
		assert.deepEqual(core.config.modelLists.hide, ["openrouter"]);
		assert.deepEqual(state.modelProviders.map((p) => [p.name, p.shown]), [["faux", true]]);
		assert.ok(state.models.includes("faux/faux-2"));
		assert.equal((await panel("PATCH", "/gateway", { modelLists: { hide: ["openrouter", "faux"] } })).status, 200);
		assert.match(readFileSync(path, "utf8"), /models:\n\s+hide: \[ openrouter, faux \]/);
		state = (await panel("GET", "/state")).json as typeof state;
		assert.deepEqual(state.models, ["faux/faux-1"], "only the model in use stays");
		const { modelOptions } = await import("../../src/hermes/rest.ts");
		const opts = await modelOptions(core, { provider: "faux", modelId: "faux-1" });
		assert.deepEqual(opts.providers.map((p) => [p.slug, p.models]), [["faux", ["faux-1"]]]);
	} finally {
		await server.close();
		await core.close();
		await cleanup();
	}
});
