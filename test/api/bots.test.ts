// Bot settings on the client API: creating, cloning, editing and removing bots, their settings, skills, prompt
// and approval rules, tool groups, MCP servers (and that no key value is ever in an answer), and a member's
// bot edited on its own machine only once that machine allows it.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { type Core, createCore } from "../../src/app.ts";
import { loadConfig } from "../../src/config.ts";
import { type GatewayServer, startServer } from "../../src/server.ts";
import { fauxModels, TOKEN, tempDir } from "../helpers.ts";
import { FakeMcpServer } from "../mcp/server.ts";
import { ApiCallError, http } from "./client.ts";

const SECRET = "api-bots-test-key-0123456789";

type Gw = { core: Core; server: GatewayServer; api: ReturnType<typeof http> };

async function gateway(root: string, name: string, bots: string, extra = ""): Promise<Gw> {
	const dir = join(root, name);
	mkdirSync(dir, { recursive: true });
	const path = join(dir, "config.yaml");
	writeFileSync(path, `server:\n  host: 127.0.0.1\n  port: 0\nnode:\n  name: ${name}\ndefaults:\n  model: faux/faux-1\nbots:\n${bots}${extra}`);
	const core = await createCore(loadConfig(path), { models: fauxModels().models, mcpTuning: { probeGapMs: 0, backoffBaseMs: 20, backoffCapMs: 80 } });
	const server = await startServer(core, { host: "127.0.0.1", port: 0 });
	return { core, server, api: http(server.port) };
}

const fails = async (p: Promise<unknown>, code: string, message?: RegExp) => {
	await assert.rejects(p, (e: unknown) => e instanceof ApiCallError && e.code === code && (message === undefined || message.test(e.message)));
};

type Bot = { id: string; name: string; displayName: string; description: string; model: { provider: string; id: string }; thinking: string; toolGroups: string[]; private: boolean; trusted: boolean; isDefault: boolean; kind: string };
type Server = { name: string; url: string; headers: { name: string; value: string | null }[]; botIds: string[]; enabledForBot?: boolean; status: { state: string; since: number | null }; toolList?: { name: string }[] };

test("bots: create, clone, update and delete a local bot; the default bot stays", async () => {
	process.env.NHERMES_TOKEN = TOKEN;
	const { dir, cleanup } = await tempDir();
	const g = await gateway(dir, "alpha", "  - name: main\n    default: true\n    tools: [memory]\n    instructions: Be brief.\n    description: The main bot\n    displayName: Main\n");
	try {
		const created = await g.api<{ bot: Bot }>("POST /bots", { name: "helper", displayName: "Helper", description: "Helps", model: "faux/faux-1", tools: ["memory", "files"] });
		assert.deepEqual([created.bot.id, created.bot.displayName, created.bot.toolGroups, created.bot.isDefault], ["helper", "Helper", ["memory", "files"], false]);
		await fails(g.api("POST /bots", { name: "helper" }), "invalid_params", /already exists/);
		await fails(g.api("POST /bots", { name: "Bad Name" }), "invalid_params", /lowercase/);
		await fails(g.api("POST /bots", { name: "odd", model: "faux/nope" }), "invalid_params", /no model/);

		const clone = await g.api<{ bot: Bot }>("POST /bots", { name: "twin", cloneFrom: "main", description: "A twin" });
		assert.deepEqual([clone.bot.toolGroups, clone.bot.description, clone.bot.isDefault, clone.bot.displayName], [["memory"], "A twin", false, "Twin"]);
		assert.equal(g.core.bots.get("twin")!.instructions, "Be brief.");
		await fails(g.api("POST /bots", { name: "x", cloneFrom: "nope" }), "bot_not_found");

		const updated = await g.api<{ bot: Bot }>("PATCH /bots/helper", { displayName: "Helper 2", thinking: "low", private: true, tools: ["memory"] });
		assert.deepEqual([updated.bot.displayName, updated.bot.thinking, updated.bot.private, updated.bot.toolGroups], ["Helper 2", "low", true, ["memory"]]);
		const cleared = await g.api<{ bot: Bot }>("PATCH /bots/helper", { description: null });
		assert.equal(cleared.bot.description, "");
		await fails(g.api("PATCH /bots/helper", {}), "invalid_params", /Nothing to change/);
		await fails(g.api("PATCH /bots/helper", { tools: ["nonsense"] }), "invalid_params", /unknown tool group/);
		await fails(g.api("PATCH /bots/helper", { model: "faux/nope" }), "invalid_params");
		await fails(g.api("PATCH /bots/nope", { displayName: "x" }), "bot_not_found");

		await fails(g.api("DELETE /bots/main"), "conflict", /default/);
		assert.deepEqual(await g.api("DELETE /bots/helper"), { deleted: true });
		assert.equal(g.core.bots.get("helper"), undefined);
		await fails(g.api("DELETE /bots/helper"), "bot_not_found");
	} finally {
		await g.server.close();
		await g.core.close();
		await cleanup();
	}
});

test("bots: settings, skills, prompt, approval rules and tool groups", async () => {
	process.env.NHERMES_TOKEN = TOKEN;
	const { dir, cleanup } = await tempDir();
	const g = await gateway(dir, "alpha", "  - name: main\n    default: true\n    tools: [memory, skills]\n    instructions: Be brief.\n");
	try {
		const s = await g.api<{ botId: string; config: Record<string, unknown>; effective: { model: string; tools: string[]; instructions: string; instructionsFrom: string; peer?: boolean }; editableKeys: string[]; choices: { models: string[]; toolGroups: string[] } }>("GET /bots/main/settings");
		assert.equal(s.botId, "main");
		assert.deepEqual([s.effective.model, s.effective.tools, s.effective.instructions, s.effective.instructionsFrom], ["faux/faux-1", ["memory", "skills"], "Be brief.", "config"]);
		assert.equal(s.effective.peer, undefined);
		assert.ok(s.editableKeys.includes("workspace") && s.choices.models.includes("faux/faux-1") && s.choices.toolGroups.includes("memory"));

		const skills = await g.api<{ items: { name: string; active: boolean }[]; toolGroupOn: boolean }>("GET /bots/main/skills");
		assert.equal(skills.toolGroupOn, true);
		await fails(g.api("PUT /bots/main/skills/nope", { enabled: true }), "not_found");
		await fails(g.api("PUT /bots/main/skills/nope", {}), "invalid_params");

		const prompt = await g.api<{ prompt: { instructions: string; identity: string; groundRules: string; full: string; tools: string[] } }>("GET /bots/main/prompt");
		assert.equal(prompt.prompt.instructions, "Be brief.");
		assert.match(prompt.prompt.full, /Be brief\./);

		assert.deepEqual(await g.api("GET /bots/main/rules"), { items: [], nextCursor: null });
		const rule = "git push *";
		assert.deepEqual(await g.api("POST /bots/main/rules", { rule }), { rule: { rule } });
		await g.api("POST /bots/main/rules", { rule: "npm test" });
		assert.deepEqual((await g.api<{ items: { rule: string }[] }>("GET /bots/main/rules")).items.map((r) => r.rule).sort(), ["git push *", "npm test"]);
		assert.deepEqual(await g.api("DELETE /bots/main/rules", { rule }), { deleted: true });
		assert.deepEqual(await g.api("DELETE /bots/main/rules", { rule }), { deleted: false });
		assert.deepEqual(g.core.approvals.rules("bot:main"), ["npm test"]);
		await fails(g.api("POST /bots/main/rules", { rule: "  " }), "invalid_params");

		const groups = await g.api<{ items: { name: string; label: string; description: string; tools: string[] }[] }>("GET /tool-groups");
		const files = groups.items.find((x) => x.name === "files")!;
		assert.deepEqual([files.label, files.tools.includes("read")], ["File Operations", true]);
	} finally {
		await g.server.close();
		await g.core.close();
		await cleanup();
	}
});

test("mcp: servers of this gateway are listed, created, edited, tested, switched per bot and removed; no key value is in any answer", async () => {
	process.env.NHERMES_TOKEN = TOKEN;
	process.env.TEST_API_KEY = SECRET;
	const fake = await FakeMcpServer.start([{ name: "list_events", annotations: { readOnlyHint: true } }, { name: "add_event" }], { token: SECRET });
	const { dir, cleanup } = await tempDir();
	const g = await gateway(dir, "alpha", "  - name: main\n    default: true\n    tools: [memory]\n");
	const seen: string[] = [];
	const call = async <T>(route: string, params: Record<string, unknown> = {}) => {
		const r = await g.api<T>(route, params);
		seen.push(JSON.stringify(r));
		return r;
	};
	try {
		await fails(g.api("POST /mcp/servers", { name: "cal", url: fake.url, headers: { Authorization: `Bearer ${SECRET}` } }), "invalid_params", /Keys/);
		await fails(g.api("POST /mcp/servers", { name: "cal", url: fake.url, color: "blue" }), "invalid_params");
		const added = await call<{ server: Server }>("POST /mcp/servers", { name: "cal", url: fake.url, description: "Calendar", headers: { Authorization: "Bearer {{secret:TEST_API_KEY}}" } });
		assert.deepEqual(added.server.headers, [{ name: "Authorization", value: "Bearer {{secret:TEST_API_KEY}}" }]);
		await new Promise<void>((resolve) => {
			const check = () => (g.core.mcp.status()[0]?.state === "online" ? resolve() : undefined);
			check();
			g.core.mcp.onStateChanged(check);
		});

		const list = await call<{ items: Server[]; nextCursor: null }>("GET /mcp/servers", { botId: "main" });
		assert.deepEqual([list.items[0]!.name, list.items[0]!.enabledForBot, list.items[0]!.status.state, typeof list.items[0]!.status.since], ["cal", false, "online", "number"]);
		assert.equal((await call<{ items: Server[] }>("GET /mcp/servers")).items[0]!.enabledForBot, undefined);

		const got = await call<{ server: Server }>("GET /mcp/servers/cal");
		assert.deepEqual(got.server.toolList!.map((t) => t.name), ["list_events", "add_event"]);
		const edited = await call<{ server: Server & { description: string } }>("PATCH /mcp/servers/cal", { description: "Work calendar", tools: { exclude: ["add_*"] } });
		assert.equal(edited.server.description, "Work calendar");
		await fails(g.api("PATCH /mcp/servers/nope", { enabled: false }), "not_found");

		const tested = await call<{ ok: boolean; toolCount: number }>("POST /mcp/servers/cal/test");
		assert.deepEqual([tested.ok, tested.toolCount], [true, 2]);
		const refreshed = await call<{ ok: boolean; server: Server }>("POST /mcp/servers/cal/refresh");
		assert.deepEqual([refreshed.ok, refreshed.server.name], [true, "cal"]);
		await fails(g.api("POST /mcp/servers/cal/explode"), "invalid_params");

		const on = await call<{ server: Server }>("PUT /mcp/servers/cal/bots/main", { enabled: true });
		assert.deepEqual([on.server.enabledForBot, on.server.botIds], [true, ["main"]]);
		assert.deepEqual(g.core.bots.get("main")!.toolGroups, ["memory", "mcp:cal"]);
		assert.equal((await call<{ server: Server }>("PUT /mcp/servers/cal/bots/main", { enabled: false })).server.enabledForBot, false);
		assert.deepEqual(g.core.bots.get("main")!.toolGroups, ["memory"]);
		await fails(g.api("PUT /mcp/servers/nope/bots/main", { enabled: true }), "not_found");
		await fails(g.api("PUT /mcp/servers/cal/bots/nope", { enabled: true }), "bot_not_found");

		await g.api("PUT /mcp/servers/cal/bots/main", { enabled: true });
		const groups = await call<{ items: { name: string; label: string; description: string; tools: string[] }[] }>("GET /tool-groups");
		const cal = groups.items.find((x) => x.name === "mcp:cal")!;
		assert.deepEqual([cal.label, cal.description], ["MCP: cal", "Work calendar"]);

		assert.deepEqual(await g.api("DELETE /mcp/servers/cal"), { deleted: true });
		assert.deepEqual(g.core.bots.get("main")!.toolGroups, ["memory"]);
		assert.deepEqual((await g.api<{ items: Server[] }>("GET /mcp/servers")).items, []);
		for (const text of seen) assert.ok(!text.includes(SECRET), "a key value appeared in an answer");
	} finally {
		await g.server.close();
		await g.core.close();
		await fake.stop();
		delete process.env.TEST_API_KEY;
		await cleanup();
	}
});

test("a member's bot is edited on its own machine, once that machine allows it", async () => {
	process.env.NHERMES_TOKEN = TOKEN;
	let offline = false;
	const fake = await FakeMcpServer.start([{ name: "ping" }]);
	const { dir, cleanup } = await tempDir();
	const a = await gateway(dir, "alpha", "  - name: main\n    default: true\n");
	const b = await gateway(dir, "beta", "  - name: nasbot\n    default: true\n    description: Runs on the NAS\n    tools: [memory, skills]\n    workspace: nas-space\n", `mcp:\n  servers:\n    cal:\n      url: ${fake.url}\n`);
	try {
		await b.core.members.join(a.core.members.invite().code);
		await Promise.all([a.core.roster.sync(), b.core.roster.sync()]);
		const id = "nasbot-beta";

		// Off by default on beta: every edit and every look is refused with beta's own message.
		await fails(a.api(`PATCH /bots/${id}`, { description: "Changed" }), "not_allowed", /beta does not accept bot edits/);
		await fails(a.api(`GET /bots/${id}/settings`), "not_allowed");
		await fails(a.api(`GET /bots/${id}/skills`), "not_allowed");
		await fails(a.api(`GET /bots/${id}/prompt`), "not_allowed");
		await fails(a.api("GET /mcp/servers", { botId: id }), "not_allowed");
		assert.equal(b.core.bots.get("nasbot")!.description, "Runs on the NAS");

		b.core.members.setAcceptsBotEdits(true);
		const updated = await a.api<{ bot: Bot }>(`PATCH /bots/${id}`, { description: "Changed", displayName: "Nas" });
		assert.deepEqual([updated.bot.id, updated.bot.description, updated.bot.displayName, updated.bot.kind], [id, "Changed", "Nas", "member"]);
		assert.equal(b.core.bots.get("nasbot")!.description, "Changed");
		// Settings that point at that machine's files stay there.
		await fails(a.api(`PATCH /bots/${id}`, { workspace: "/tmp/x" }), "invalid_params", /only on beta/);
		await fails(a.api(`PATCH /bots/${id}`, {}), "invalid_params", /Nothing to change/);
		await fails(a.api(`PATCH /bots/${id}`, { tools: ["nonsense"] }), "invalid_params");

		const s = await a.api<{ botId: string; effective: { description: string; tools: string[] }; config: Record<string, unknown>; editableKeys: string[]; choices: { models: string[] } }>(`GET /bots/${id}/settings`);
		assert.deepEqual([s.botId, s.effective.description, s.effective.tools], [id, "Changed", ["memory", "skills"]]);
		assert.equal(s.config.workspace, undefined, "files stay on that machine");
		assert.ok(!s.editableKeys.includes("workspace") && s.choices.models.includes("faux/faux-1"));

		assert.equal((await a.api<{ toolGroupOn: boolean }>(`GET /bots/${id}/skills`)).toolGroupOn, true);
		await fails(a.api(`PUT /bots/${id}/skills/nope`, { enabled: true }), "not_found");
		assert.equal((await a.api<{ prompt: { identity: string } }>(`GET /bots/${id}/prompt`)).prompt.identity.includes("nasbot"), true);
		await fails(a.api(`GET /bots/${id}/rules`), "not_available", /beta/);
		await fails(a.api(`POST /bots/${id}/rules`, { rule: "ls" }), "not_available");

		// Beta's MCP servers, and its bot's switch for one.
		const list = await a.api<{ items: Server[] }>("GET /mcp/servers", { botId: id });
		assert.deepEqual(list.items.map((x) => [x.name, x.enabledForBot]), [["cal", false]]);
		assert.deepEqual((await a.api<{ items: Server[] }>("GET /mcp/servers")).items, [], "without a bot it is this gateway's own");
		const on = await a.api<{ server: Server }>("PUT /mcp/servers/cal/bots/" + id, { enabled: true });
		assert.equal(on.server.enabledForBot, true);
		assert.deepEqual(b.core.bots.get("nasbot")!.toolGroups, ["memory", "skills", "mcp:cal"]);
		const edited = await a.api<{ server: Server & { description: string } }>("PATCH /mcp/servers/cal", { botId: id, description: "From alpha" });
		assert.equal(edited.server.description, "From alpha");

		await fails(a.api(`DELETE /bots/${id}`), "conflict", /default/);
		const extra = await b.core.settings.addBot({ name: "spare" });
		assert.deepEqual(extra.added, ["spare"]);
		await a.core.roster.sync();
		assert.deepEqual(await a.api("DELETE /bots/spare-beta"), { deleted: true });
		assert.equal(b.core.bots.get("spare"), undefined);

		// Offline: the member being unreachable is reported as such.
		await b.server.close();
		offline = true;
		await fails(a.api(`PATCH /bots/${id}`, { description: "Again" }), "member_offline");
	} finally {
		if (!offline) await b.server.close();
		await a.server.close();
		await a.core.close();
		await b.core.close();
		await fake.stop();
		await cleanup();
	}
});
