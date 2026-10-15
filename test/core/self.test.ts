// Self-aware bots: the `about` prompt section, read-only self tools, own-setup edits, gateway-wide edits
// for trusted bots, and the approval rules around them.
import assert from "node:assert/strict";
import { test } from "node:test";
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
		const t = await run("ops", [["self_info", { gateway: true }]]);
		assert.equal(t[0]!.isError, false);
		assert.doesNotMatch(t[0]!.resultText, new RegExp(TOKEN));
		assert.match(t[0]!.resultText, /"name": "main"/);
	} finally {
		await core.close();
		await cleanup();
	}
});
