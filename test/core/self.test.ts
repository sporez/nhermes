// Self-aware bots: the `about` prompt section, read-only self tools, own-setup edits, gateway-wide edits
// for trusted bots, and the approval rules around them.
import assert from "node:assert/strict";
import { test } from "node:test";
import { INSTALL_DIR } from "../../src/tools/self.ts";
import { fauxModels, tempDir, testConfig, testCore } from "../helpers.ts";

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
