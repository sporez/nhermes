// Self-aware bots: the `about` prompt section, read-only self tools, own-setup edits, gateway-wide edits
// for trusted bots, and the approval rules around them.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createCore } from "../../src/app.ts";
import { decide } from "../../src/core/policy.ts";
import { loadConfig } from "../../src/config.ts";
import { INSTALL_DIR } from "../../src/tools/self.ts";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { collect, fauxModels, TOKEN, tempDir, testConfig, testCore } from "../helpers.ts";

async function setup(bots = testConfig("/x").bots) {
	const t = await tempDir();
	const { models, faux } = fauxModels();
	const core = await testCore(t.dir, { models, config: testConfig(t.dir, bots) });
	return { ...t, core, faux };
}

test("about: the prompt section shows live settings and the docs map, only for bots with the self group", async () => {
	const { core, cleanup } = await setup([
		{ name: "main", default: true, instructions: "m", model: "faux/faux-2", skills: [] },
		{ name: "plain", tools: ["files"] },
	]);
	try {
		const main = core.bots.require("main");
		const prompt = await core.deps.promptParts.reduce(async (acc, p) => `${await acc}\n${(await p(main, "")) ?? ""}`, Promise.resolve(""));
		assert.match(prompt, /About you and nHermes/);
		assert.match(prompt, /model faux\/faux-2, thinking medium/);
		assert.match(prompt, new RegExp(`${INSTALL_DIR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/docs/OPERATIONS\\.md`));
		assert.match(prompt, /scheduled jobs: 0/);
		const plain = core.bots.require("plain");
		for (const p of core.deps.promptParts) assert.doesNotMatch((await p(plain, "")) ?? "", /About you and nHermes/);
	} finally {
		await core.close();
		await cleanup();
	}
});

test("self tools: self_info shows the bot's own entry without secrets; trusted-only views are refused otherwise; nhermes_docs is confined", async () => {
	const { core, faux, cleanup } = await setup([
		{ name: "main", default: true, instructions: "m", secrets: ["MY_KEY"] },
		{ name: "ops", instructions: "o", trusted: true },
	]);
	try {
		const run = async (bot: string, calls: [string, Parameters<typeof fauxToolCall>[1]][]) => {
			const s = await core.sessions.create(bot);
			const c = collect(core.hub, s.id);
			faux.setResponses([...calls.map(([n, a]) => fauxAssistantMessage([fauxToolCall(n, a)], { stopReason: "toolUse" })), fauxAssistantMessage([fauxText("done")])]);
			await core.sessions.submit(s.id, "go");
			await c.until((e) => e.type === "run.finished");
			return c.events.filter((e) => e.type === "tool.finished") as { resultText: string; isError: boolean }[];
		};
		const r = await run("main", [["self_info", {}], ["self_info", { gateway: true }], ["nhermes_docs", {}], ["nhermes_docs", { file: "docs/OPERATIONS.md" }], ["nhermes_docs", { file: "../../etc/passwd" }], ["nhermes_docs", { file: "package.json" }]]);
		assert.match(r[0]!.resultText, /"name": "main"/);
		assert.doesNotMatch(r[0]!.resultText, new RegExp(TOKEN));
		assert.equal(r[1]!.isError, true);
		assert.match(r[2]!.resultText, /docs\/OPERATIONS\.md/);
		assert.equal(r[3]!.isError, false);
		assert.equal(r[4]!.isError, true);
		assert.equal(r[5]!.isError, true);
		const [list] = await run("main", [["self_models", {}]]);
		assert.equal(list!.isError, false);
		assert.match(list!.resultText, /- faux\/faux-1 \(current\)[^\n]*reasoning/);
		assert.match(list!.resultText, /- faux\/faux-2\b/);
		assert.equal(decide({ name: "self_models", arguments: {} }, { bot: core.bots.require("main"), sessionRules: [], botRules: [], yolo: false }).action, "allow");
		const t = await run("ops", [["self_info", { gateway: true }]]);
		assert.equal(t[0]!.isError, false);
		assert.doesNotMatch(t[0]!.resultText, new RegExp(TOKEN));
		assert.match(t[0]!.resultText, /"name": "main"/);
	} finally {
		await core.close();
		await cleanup();
	}
});

const YAML = `server:
  host: 127.0.0.1
  port: 0
defaults:
  model: faux/faux-1
bots:
  - name: main
    default: true
    instructions: You are main.
  - name: ops
    description: Infrastructure
    trusted: true
`;

/** A gateway built from a real config.yaml (so edits can be written), with every approval card answered "once". */
async function setupFile(yaml = YAML) {
	const t = await tempDir();
	process.env.NHERMES_TOKEN = TOKEN;
	const path = join(t.dir, "config.yaml");
	writeFileSync(path, yaml);
	const { models, faux } = fauxModels();
	const core = await createCore(loadConfig(path), { models, updates: { codeDir: t.dir } });
	const cards: { toolName: string; description: string; command: string; choices: string[] }[] = [];
	const answer = (choice: "once" | "deny" = "once") => core.hub.subscribeAll((_sid, e) => {
		if (e.type === "approval.requested") {
			cards.push(e.request);
			core.approvals.answer(e.request.requestId, choice);
		}
	});
	const off = answer();
	const run = async (bot: string, calls: [string, Parameters<typeof fauxToolCall>[1]][], opts: Parameters<typeof core.sessions.create>[1] = {}) => {
		const s = await core.sessions.create(bot, opts);
		const c = collect(core.hub, s.id);
		faux.setResponses([...calls.map(([n, a]) => fauxAssistantMessage([fauxToolCall(n, a)], { stopReason: "toolUse" })), fauxAssistantMessage([fauxText("done")])]);
		await core.sessions.submit(s.id, "go");
		await c.until((e) => e.type === "run.finished");
		return c.events.filter((e) => e.type === "tool.finished") as { resultText: string; isError: boolean }[];
	};
	return { ...t, path, core, faux, cards, run, off, answer };
}

test("self_update: allowed fields change config.yaml (kept as .prev); privileged fields and unknown models are refused", async () => {
	const { core, path, run, cleanup } = await setupFile();
	try {
		const r = await run("main", [["self_update", { description: "Answers questions", thinking: "low" }], ["self_update", { tools: ["files", "shell"] }], ["self_update", { trusted: true }], ["self_update", { model: "nope/none" }], ["self_update", {}]]);
		assert.equal(r[0]!.isError, false, r[0]!.resultText);
		assert.equal(core.bots.require("main").description, "Answers questions");
		assert.equal(core.bots.require("main").thinking, "low");
		assert.match(readFileSync(path, "utf8"), /description: Answers questions/);
		assert.match(readFileSync(`${path}.prev`, "utf8"), /name: main\n {4}default: true\n {4}instructions: You are main\.\n/);
		assert.doesNotMatch(readFileSync(`${path}.prev`, "utf8"), /Answers questions/);
		for (const i of [1, 2, 3, 4]) assert.equal(r[i]!.isError, true);
		assert.match(r[1]!.resultText, /cannot change tools/);
		assert.equal(core.bots.require("main").trusted, false);
		const audit = core.db.all<{ kind: string; bot: string }>("SELECT kind, bot FROM audit WHERE kind LIKE 'config.%'");
		assert.deepEqual(audit.map((a) => [a.kind, a.bot]), [["config.self_update", "main"]]);
	} finally {
		await core.close();
		await cleanup();
	}
});

test("self skills: written into the bot's own folder after validation; traversal and bad skills are refused; delete works", async () => {
	const { core, dir, run, cleanup } = await setupFile();
	try {
		const md = "---\nname: tidy\ndescription: Tidy the workspace\n---\n\nDelete temp files.\n";
		const r = await run("main", [
			["self_skill_write", { name: "tidy", skillMd: md, files: { "scripts/run.sh": "echo hi" } }],
			["self_skill_write", { name: "../evil", skillMd: md }],
			["self_skill_write", { name: "tidy", skillMd: md, files: { "../../config.yaml": "x" } }],
			["self_skill_write", { name: "tidy", skillMd: md, files: { "/etc/x": "x" } }],
			["self_skill_write", { name: "bad", skillMd: "no frontmatter" }],
			["self_skill_write", { name: "big", skillMd: md.replace("tidy", "big") + "x".repeat(70_000) }],
			["self_skill_delete", { name: "tidy" }],
			["self_skill_delete", { name: "../tidy" }],
		]);
		assert.equal(r[0]!.isError, false, r[0]!.resultText);
		assert.equal(r.slice(1, 6).every((x) => x.isError), true, r.map((x) => x.resultText).join("\n"));
		assert.equal(existsSync(join(dir, "config.yaml.evil")), false);
		assert.equal(r[6]!.isError, false, r[6]!.resultText);
		assert.equal(r[7]!.isError, true);
		assert.equal(existsSync(join(dir, "bots", "main", "skills", "tidy")), false);
	} finally {
		await core.close();
		await cleanup();
	}
});

test("gateway tools: offered to trusted bots only; edits any bot and the gateway; leaves out sharedMemory, secrets, server", async () => {
	const { core, path, dir, run, cleanup } = await setupFile();
	try {
		const names = (bot: string) => (core.agentFor(core.bots.require(bot)).tools as unknown as { name: string }[]).map((t) => t.name);
		assert.ok(names("ops").includes("gateway_bot_update") && names("ops").includes("gateway_software"));
		assert.ok(names("main").includes("self_update") && !names("main").some((n) => n.startsWith("gateway_")));
		const md = "---\nname: backup-check\ndescription: Check backups\n---\n\nLook.\n";
		const r = await run("ops", [
			["gateway_bot_update", { name: "main", patch: { description: "Front desk", trusted: false, tools: ["files", "self"] } }],
			["gateway_bot_update", { name: "main", patch: { sharedMemory: ["all"] } }],
			["gateway_bot_update", { name: "main", patch: { secrets: ["X"] } }],
			["gateway_bot_add", { config: { name: "research", description: "Reads papers", tools: ["files"] } }],
			["gateway_bot_remove", { name: "ops" }],
			["gateway_bot_remove", { name: "research" }],
			["gateway_update", { patch: { timezone: "Europe/London", defaults: { thinking: "high" } } }],
			["gateway_update", { patch: { server: { port: 1 } } }],
			["gateway_skill_write", { name: "backup-check", skillMd: md }],
			["gateway_skill_write", { name: "backup-check", skillMd: md, bot: "main" }],
			["gateway_skill_delete", { name: "backup-check" }],
			["gateway_software", { action: "status" }],
			["gateway_software", { action: "update" }],
			["gateway_reload", {}],
		]);
		const out = r.map((x, i) => `${i}: ${x.isError ? "ERR " : ""}${x.resultText}`).join("\n");
		const ok = (i: number) => assert.equal(r[i]!.isError, false, out);
		const bad = (i: number) => assert.equal(r[i]!.isError, true, out);
		ok(0);
		assert.equal(core.bots.require("main").description, "Front desk");
		assert.deepEqual(core.bots.require("main").toolGroups, ["files", "self"]);
		bad(1);
		bad(2);
		ok(3);
		bad(4);
		ok(5);
		assert.equal(core.bots.get("research"), undefined);
		ok(6);
		assert.match(readFileSync(path, "utf8"), /timezone: Europe\/London/);
		bad(7);
		ok(8);
		ok(9);
		assert.equal(existsSync(join(dir, "bots", "main", "skills", "backup-check", "SKILL.md")), true, "the bot-folder skill was not deleted");
		ok(10);
		assert.equal(existsSync(join(dir, "skills", "backup-check")), false);
		ok(11);
		assert.match(r[11]!.resultText, /"updatable": false/);
		bad(12);
		assert.match(r[12]!.resultText, /not a git checkout/);
		ok(13);
		assert.deepEqual(core.db.all<{ kind: string }>("SELECT kind FROM audit WHERE kind LIKE 'config.%'").map((a) => a.kind), ["config.gateway_bot_update", "config.gateway_bot_add", "config.gateway_bot_remove", "config.gateway_update", "config.gateway_skill_write", "config.gateway_skill_write", "config.gateway_skill_delete", "config.gateway_reload"]);
	} finally {
		await core.close();
		await cleanup();
	}
});

test("config tools: always a card for the owner (even with approvals off), never \"always\", with a diff; deny changes nothing", async () => {
	const { core, path, cards, run, off, answer, cleanup } = await setupFile(`${YAML}    approvals: { mode: off }\n`);
	try {
		const r = await run("ops", [["gateway_bot_update", { name: "main", patch: { description: "Front desk" } }]]);
		assert.equal(r[0]!.isError, false);
		assert.equal(cards.length, 1, "asked although the bot's approvals are off");
		assert.deepEqual(cards[0]!.choices, ["once", "session", "deny"]);
		assert.match(cards[0]!.command, /Change bot "main"/);
		assert.match(cards[0]!.command, /description: \(unset\) → Front desk/);
		// A trusted bot's ordinary calls are untouched.
		assert.equal(decide({ name: "self_info", arguments: {} }, { bot: core.bots.require("ops"), sessionRules: [], botRules: [], yolo: true }).action, "allow");
		// The decision is never reviewable, yolo does not skip it, and a bot rule does not cover it.
		const d = decide({ name: "self_update", arguments: { description: "x" } }, { bot: core.bots.require("main"), sessionRules: [], botRules: ["config:self_update"], yolo: true, reviewActive: true });
		assert.equal(d.action, "ask");
		assert.equal(d.reviewable, false);
		assert.equal(d.noAlways, true);
		off();
		const stop = answer("deny");
		const denied = await run("main", [["self_update", { description: "Hacked" }]]);
		stop();
		assert.equal(denied[0]!.isError, true);
		assert.notEqual(core.bots.require("main").description, "Hacked");
		assert.equal(cards.length, 2);
		// An "always" answer to a card that did not offer it counts as "session".
		const s = await core.sessions.create("main");
		const ask = core.approvals.ask({ sessionId: s.id, bot: "main", toolName: "self_update", command: "x", description: "x", patternKey: "config:self_update", noAlways: true }, new AbortController().signal);
		core.approvals.answer(core.approvals.pendingFor(s.id)[0]!.requestId, "always");
		assert.equal(await ask, "session");
		assert.deepEqual(core.approvals.rules("bot:main"), []);
		assert.deepEqual(core.approvals.rules(`session:${s.id}`), ["config:self_update"]);
		// A once-only card (approving an OpenChamber request) offers once/deny, and a wider answer stores nothing.
		const once = core.approvals.ask({ sessionId: s.id, bot: "main", toolName: "oc_approve", command: "x", description: "x", patternKey: "tool:oc_approve", onceOnly: true }, new AbortController().signal);
		const card = core.approvals.pendingFor(s.id)[0]!;
		assert.deepEqual(card.choices, ["once", "deny"]);
		core.approvals.answer(card.requestId, "session");
		assert.equal(await once, "once");
		assert.deepEqual(core.approvals.rules(`session:${s.id}`), ["config:self_update"]);
	} finally {
		await core.close();
		await cleanup();
	}
});

test("config tools: trusted-only tools are refused through an untrusted chain or a member; jobs cannot change config", async () => {
	const { core, cards, run, cleanup } = await setupFile();
	try {
		const parent = await core.sessions.create("main");
		const viaUntrusted = await run("ops", [["gateway_bot_update", { name: "main", patch: { description: "x" } }], ["self_info", { gateway: true }]], { parentId: parent.id });
		assert.deepEqual(viaUntrusted.map((x) => x.isError), [true, true]);
		const fromMember = await run("ops", [["gateway_update", { patch: { timezone: "UTC" } }], ["self_update", { description: "x" }]], { source: "member:abc" });
		assert.deepEqual(fromMember.map((x) => x.isError), [true, true]);
		const job = await run("ops", [["gateway_reload", {}], ["self_update", { description: "x" }], ["self_info", {}]], { kind: "job" });
		assert.deepEqual(job.map((x) => x.isError), [true, true, false]);
		assert.equal(cards.length, 0, "refused, not asked");
		assert.notEqual(core.bots.require("main").description, "x");
		// An untrusted bot that is somehow given a gateway tool call is refused too.
		const direct = await run("main", [["gateway_reload", {}]]);
		assert.equal(direct[0]!.isError, true);
		assert.equal(cards.length, 0);
	} finally {
		await core.close();
		await cleanup();
	}
});

test("config tools: the owner's chat relayed by a member is asked when this machine accepts bot edits", async () => {
	const { core, cards, run, cleanup } = await setupFile();
	try {
		const relayed = { source: "member:abc:owner" };
		const off = await run("main", [["self_update", { description: "Relayed" }]], relayed);
		assert.equal(off[0]!.isError, true, "refused while bot edits are off");
		assert.equal(cards.length, 0);
		core.members.setAcceptsBotEdits(true);
		const on = await run("main", [["self_update", { description: "Relayed" }], ["gateway_update", { patch: { timezone: "UTC" } }]], relayed);
		assert.deepEqual(on.map((x) => x.isError), [false, true], "self tools asked; gateway tools still need trust");
		assert.deepEqual(cards.map((c) => c.toolName), ["self_update"]);
		assert.equal(core.bots.require("main").description, "Relayed");
		// Delegated work from a member stays refused whatever the setting.
		const delegated = await run("main", [["self_update", { description: "Delegated" }]], { source: "member:abc" });
		assert.equal(delegated[0]!.isError, true);
		assert.equal(cards.length, 1);
	} finally {
		await core.close();
		await cleanup();
	}
});

test("ground rules: configuration is changed only through the self and gateway tools", async () => {
	const { groundRules } = await import("../../src/agent/extensions.ts");
	const text = groundRules(["/etc/nh", "/var/nh"]);
	assert.match(text, /Do not touch them with files or the shell/);
	assert.match(text, /only through the self and gateway tools[^"]*ask the owner/);
	assert.match(text, /`\/etc\/nh` and `\/var\/nh`/);
});
