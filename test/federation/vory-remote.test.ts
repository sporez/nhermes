// Vory's settings for a member's bot: the gateway Vory is connected to forwards them to the machine that
// owns the bot, which answers with its own handlers. Reads always; changes only once that machine allows
// bot edits from members; its config.yaml is written by it.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createCore, type Core } from "../../src/app.ts";
import { loadConfig } from "../../src/config.ts";
import { type HermesServer, startHermesServer } from "../../src/hermes/server.ts";
import { fauxModels, TOKEN, tempDir } from "../helpers.ts";

type Gw = { core: Core; server: HermesServer; url: string; path: string };

async function gateway(root: string, name: string, bots: string): Promise<Gw> {
	const dir = join(root, name);
	mkdirSync(dir, { recursive: true });
	const path = join(dir, "config.yaml");
	writeFileSync(path, `server:\n  host: 127.0.0.1\n  port: 0\nnode:\n  name: ${name}\ndefaults:\n  model: faux/faux-1\nbots:\n${bots}`);
	const core = await createCore(loadConfig(path), { models: fauxModels().models });
	const server = await startHermesServer(core, { host: "127.0.0.1", port: 0 });
	return { core, server, url: `http://127.0.0.1:${server.port}`, path };
}

const vory = async (g: Gw, method: string, path: string, body?: unknown) => {
	const res = await fetch(`${g.url}${path}`, { method, headers: { "X-Hermes-Session-Token": TOKEN, ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
	return { status: res.status, json: (await res.json()) as any };
};

test("Vory's settings screens follow a member's bot to its machine", async () => {
	process.env.NHERMES_TOKEN = TOKEN;
	const { dir, cleanup } = await tempDir();
	const a = await gateway(dir, "alpha", "  - name: main\n    default: true\n");
	const b = await gateway(dir, "beta", "  - name: nasbot\n    default: true\n    instructions: Watch the NAS.\n    tools: [files, shell]\n");
	try {
		await b.core.members.join(a.core.members.invite().code);
		await Promise.all([a.core.roster.sync(), b.core.roster.sync()]);
		const p = "profile=nasbot-beta";

		// Reads come from beta, even while beta does not accept edits.
		const tools = (await vory(a, "GET", `/api/tools/toolsets?${p}`)).json as { name: string; enabled: boolean }[];
		assert.deepEqual(tools.filter((t) => t.enabled).map((t) => t.name), ["files", "shell"]);
		assert.equal((await vory(a, "GET", "/api/profiles/nasbot-beta/soul")).json.content, "Watch the NAS.");
		assert.equal((await vory(a, "GET", `/api/config?${p}`)).json.config.approvals.mode, "smart");
		assert.ok(Array.isArray((await vory(a, "GET", `/api/skills?${p}`)).json));
		assert.equal((await vory(a, "GET", `/api/analytics/usage?${p}`)).json.totals.total_api_calls, 0);
		// alpha's own bot is answered by alpha.
		assert.ok(((await vory(a, "GET", "/api/tools/toolsets?profile=main")).json as { enabled: boolean }[]).some((t) => t.enabled));

		// Changes are refused until beta's owner allows them; the reason names where to turn it on.
		const refused = await vory(a, "PUT", `/api/tools/toolsets/web?${p}`, { enabled: true });
		assert.equal(refused.status, 403);
		assert.match(refused.json.detail, /beta does not accept bot edits[\s\S]*Network/);
		assert.deepEqual(b.core.bots.require("nasbot").toolGroups, ["files", "shell"]);
		assert.equal(a.core.members.list()[0]!.reachable, true, "a refusal is not an outage");

		b.core.members.setAcceptsBotEdits(true);
		assert.equal((await vory(a, "PUT", `/api/tools/toolsets/web?${p}`, { enabled: true })).status, 200);
		assert.deepEqual(b.core.bots.require("nasbot").toolGroups, ["files", "shell", "web"]);
		assert.match(readFileSync(b.path, "utf8"), /tools:[\s\S]*web/, "beta wrote its own config.yaml");
		assert.equal((await vory(a, "PUT", "/api/profiles/nasbot-beta/soul", { content: "Watch the NAS closely." })).status, 200);
		assert.equal(b.core.bots.require("nasbot").instructions, "Watch the NAS closely.");
		assert.equal((await vory(a, "PUT", `/api/config?${p}`, { config: { approvals: { mode: "manual" }, agent: { reasoning_effort: "low" } } })).status, 200);
		assert.deepEqual([b.core.bots.require("nasbot").approvals.mode, b.core.bots.require("nasbot").thinking], ["manual", "low"]);
		assert.equal((await vory(a, "POST", `/api/model/set?${p}`, { scope: "main", provider: "faux", model: "faux-2" })).status, 200);
		assert.equal(b.core.bots.require("nasbot").model.modelId, "faux-2");
		assert.equal((await vory(a, "PUT", `/api/config?${p}`, { config: { memory: { x: 1 } } })).status, 400, "beta's own validation answers");

		// Only the listed requests, only beta's own bots, only with the pair secret.
		const m = a.core.members.list()[0]!;
		const row = a.core.members.byName(m.name)!;
		await assert.rejects(a.core.members.call(row, "/federation/manage/vory/nasbot", { method: "DELETE", path: "/api/sessions/x" }), /not something a member can ask for/);
		await assert.rejects(a.core.members.call(row, "/federation/manage/vory/ghost", { method: "GET", path: "/api/skills" }), /no bot named "ghost"/);
		await assert.rejects(a.core.members.call(row, "/federation/manage/vory/nasbot", { method: "PUT", path: "/api/profiles/other/soul", body: { content: "x" } }), /names another bot/);
		assert.equal((await fetch(`${b.url}/federation/manage/vory/nasbot`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ method: "GET", path: "/api/skills" }) })).status, 404);
	} finally {
		await a.server.close();
		await b.server.close();
		await a.core.close();
		await b.core.close();
		await cleanup();
	}
});
