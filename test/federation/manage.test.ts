// Editing a member's bots from another member's panel: refused until the owning machine allows it, then
// the same edits its own panel makes (config.yaml written there), limited to the editor's fields and to
// that machine's own bots; a refusal does not mark the member unreachable, and an offline member's bots
// stay listed, view only.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createCore, type Core } from "../../src/app.ts";
import { loadConfig } from "../../src/config.ts";
import { type GatewayServer, startServer } from "../../src/server.ts";
import { fauxModels, TOKEN, tempDir } from "../helpers.ts";

type Gw = { core: Core; server: GatewayServer; url: string; path: string; dir: string };
type Res = { status: number; json: Record<string, unknown> & { detail?: string } };

async function gateway(root: string, name: string, bots: string): Promise<Gw> {
	const dir = join(root, name);
	mkdirSync(dir, { recursive: true });
	const path = join(dir, "config.yaml");
	writeFileSync(path, `server:\n  host: 127.0.0.1\n  port: 0\nnode:\n  name: ${name}\ndefaults:\n  model: faux/faux-1\nbots:\n${bots}`);
	const core = await createCore(loadConfig(path), { models: fauxModels().models });
	const server = await startServer(core, { host: "127.0.0.1", port: 0 });
	return { core, server, url: `http://127.0.0.1:${server.port}`, path, dir };
}

async function panel(g: Gw, method: string, path: string, body?: unknown): Promise<Res> {
	const res = await fetch(`${g.url}/panel/api${path}`, {
		method,
		headers: method === "GET" ? {} : { "content-type": "application/json", "x-nhermes-panel": "1" },
		body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
	});
	return { status: res.status, json: (await res.json()) as Res["json"] };
}

type Member = { node: string; reachable: boolean; editable: boolean; error?: string; bots?: { name: string; config: Record<string, unknown>; effective: Record<string, unknown> }[]; models?: string[]; toolGroups?: string[] };
const members = async (g: Gw) => ((await panel(g, "GET", "/remote")).json.members as Member[]);

test("a member's bots are edited from another panel once that machine allows it", async () => {
	process.env.NHERMES_TOKEN = TOKEN;
	const { dir, cleanup } = await tempDir();
	const a = await gateway(dir, "alpha", "  - name: main\n    default: true\n");
	const b = await gateway(dir, "beta", "  - name: nasbot\n    default: true\n    description: Runs on the NAS\n    secrets: [NAS_KEY]\n  - name: vault\n    private: true\n");
	try {
		await b.core.members.join(a.core.members.invite().code);
		await Promise.all([a.core.roster.sync(), b.core.roster.sync()]);
		assert.deepEqual(a.core.bots.names(), ["main", "nasbot-beta"]);

		// Off by default: listed view only, edits refused, and the refusal is not an outage.
		let [beta] = await members(a);
		assert.equal(beta!.editable, false);
		assert.equal(beta!.reachable, true);
		assert.match(beta!.error!, /beta does not accept bot edits/);
		const refused = await panel(a, "PATCH", "/remote/beta/bots/nasbot", { description: "Changed" });
		assert.equal(refused.status, 403);
		assert.equal(b.core.bots.get("nasbot")!.description, "Runs on the NAS");
		assert.equal(a.core.members.list()[0]!.reachable, true);
		// The main port serves no member routes.
		assert.equal((await fetch(`${b.url}/federation/manage`)).status, 404);

		// beta's owner allows it in beta's panel.
		assert.equal((await panel(b, "PATCH", "/network/settings", { acceptBotEdits: true })).status, 200);
		assert.equal((await panel(b, "GET", "/network")).json.acceptsBotEdits, true);
		assert.equal(b.core.members.acceptsSecrets(), false, "keys stay a separate choice");

		[beta] = await members(a);
		assert.equal(beta!.editable, true, beta!.error);
		assert.deepEqual(beta!.bots!.map((x) => x.name), ["nasbot", "vault"], "beta's own bots, private ones included, not its remote ones");
		assert.ok(beta!.models!.includes("faux/faux-1"));
		assert.ok(beta!.toolGroups!.includes("shell"));
		assert.equal("secrets" in beta!.bots![0]!.config, false, "key names stay on beta");

		// An edit is written to beta's config.yaml by beta.
		const edited = await panel(a, "PATCH", "/remote/beta/bots/nasbot", { description: "Watches the NAS", instructions: "Be brief.", thinking: "low" });
		assert.equal(edited.status, 200, edited.json.detail);
		assert.deepEqual(edited.json.changed, ["nasbot"]);
		const nasbot = b.core.bots.get("nasbot")!;
		assert.equal(nasbot.description, "Watches the NAS");
		assert.equal(nasbot.instructions, "Be brief.");
		assert.match(readFileSync(b.path, "utf8"), /description: Watches the NAS/);
		await a.core.roster.sync();
		assert.equal(a.core.bots.get("nasbot-beta")!.description, "Watches the NAS");

		// Only the editor's fields, only beta's own bots.
		const host = await panel(a, "PATCH", "/remote/beta/bots/nasbot", { host: { ssh: { host: "evil", user: "root" } } });
		assert.equal(host.status, 400);
		assert.match(host.json.detail!, /only be changed on the bot's own machine/);
		assert.equal((await panel(a, "PATCH", "/remote/beta/bots/main-alpha", { description: "x" })).status, 404);
		assert.equal((await panel(a, "PATCH", "/remote/beta/bots/nasbot", { tools: ["teleport"] })).status, 400);
		assert.equal((await panel(a, "PATCH", "/remote/gamma/bots/nasbot", { description: "x" })).status, 404);
		assert.equal(a.core.members.list()[0]!.reachable, true, "beta's refusals are answers");

		// Create and remove.
		assert.equal((await panel(a, "POST", "/remote/beta/bots", { name: "helper", description: "Helps" })).status, 200);
		assert.equal(b.core.bots.get("helper")!.description, "Helps");
		assert.equal((await panel(a, "POST", "/remote/beta/bots", { name: "sneaky", workspace: "/" })).status, 400);
		assert.equal(b.core.bots.get("sneaky"), undefined);
		assert.equal((await panel(a, "DELETE", "/remote/beta/bots/helper")).status, 200);
		assert.equal(b.core.bots.get("helper"), undefined);

		// Skills and the system prompt.
		mkdirSync(join(b.dir, "skills", "release-notes"), { recursive: true });
		writeFileSync(join(b.dir, "skills", "release-notes", "SKILL.md"), "---\nname: release-notes\ndescription: release notes skill\n---\n\nDo it.\n");
		assert.equal((await panel(a, "PATCH", "/remote/beta/bots/nasbot", { skills: ["*"] })).status, 200);
		const skills = (await panel(a, "GET", "/remote/beta/bots/nasbot/skills")).json as { allGlobal: boolean; skills: { name: string; active: boolean }[] };
		assert.equal(skills.allGlobal, true);
		assert.deepEqual(skills.skills.map((s) => [s.name, s.active]), [["release-notes", true]]);
		assert.equal((await panel(a, "PUT", "/remote/beta/bots/nasbot/skills/release-notes", { enabled: false })).status, 200);
		assert.equal(b.core.skills.catalog(b.core.bots.get("nasbot")!).find((s) => s.name === "release-notes")!.active, false);
		assert.equal((await panel(a, "PUT", "/remote/beta/bots/nasbot/skills/nope", { enabled: false })).status, 404);
		const prompt = (await panel(a, "GET", "/remote/beta/bots/nasbot/prompt")).json as { instructions: string; full: string };
		assert.equal(prompt.instructions, "Be brief.");
		assert.ok(prompt.full.includes("Be brief."));

		// Turned off again: refused.
		assert.equal((await panel(b, "PATCH", "/network/settings", { acceptBotEdits: false })).status, 200);
		assert.equal((await panel(a, "PATCH", "/remote/beta/bots/nasbot", { description: "x" })).status, 403);

		// Offline: listed as unreachable, not editable.
		await b.server.close();
		[beta] = await members(a);
		assert.equal(beta!.editable, false);
		assert.equal(beta!.reachable, false);
		assert.equal((await panel(a, "GET", "/state")).status, 200);
	} finally {
		for (const g of [a, b]) {
			await g.server.close().catch(() => {});
			await g.core.close();
		}
		await cleanup();
	}
});

test("a member that no longer knows this machine is not a panel sign-in", async () => {
	process.env.NHERMES_TOKEN = TOKEN;
	const { dir, cleanup } = await tempDir();
	const a = await gateway(dir, "alpha", "  - name: main\n    default: true\n");
	const b = await gateway(dir, "beta", "  - name: nasbot\n    default: true\n");
	try {
		await b.core.members.join(a.core.members.invite().code);
		b.core.db.run("UPDATE members SET secret = 'wrong'");
		const r = await panel(a, "PATCH", "/remote/beta/bots/nasbot", { description: "x" });
		assert.equal(r.status, 502);
		assert.match(r.json.detail!, /no longer accepts this machine/);
	} finally {
		for (const g of [a, b]) {
			await g.server.close();
			await g.core.close();
		}
		await cleanup();
	}
});
