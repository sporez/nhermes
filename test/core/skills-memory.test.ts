// SKILL.md skills per bot and per job, and memory: persistence, search, and sharing boundaries.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { startHermesServer } from "../../src/hermes/server.ts";
import { MemoryAccessError } from "../../src/memory/memory.ts";
import { collect, fauxModels, TOKEN, tempDir, testConfig, testCore } from "../helpers.ts";

function writeSkill(dir: string, name: string, description: string, body: string, extra?: Record<string, string>) {
	mkdirSync(join(dir, name), { recursive: true });
	writeFileSync(join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`);
	for (const [f, c] of Object.entries(extra ?? {})) writeFileSync(join(dir, name, f), c);
}

test("skills: per-bot and opted-in global skills are active; the skill tool loads the body; toggles persist", async () => {
	const { dir, cleanup } = await tempDir();
	const { models, faux } = fauxModels();
	writeSkill(join(dir, "skills"), "backup-check", "Check last night's backups and report failures", "1. Run `zfs list -t snapshot`.\n2. Report anything older than 24h.", { "notes.md": "extra notes" });
	writeSkill(join(dir, "skills"), "release-notes", "Draft release notes", "Write release notes.");
	writeSkill(join(dir, "bots", "ops", "skills"), "proxmox-health", "Check Proxmox node health", "Run pvesh get /nodes.");
	const config = testConfig(dir, [
		{ name: "main", default: true, instructions: "main", skills: ["backup-check"] },
		{ name: "ops", instructions: "ops" },
	]);
	const core = await testCore(dir, { models, config });
	try {
		const main = core.bots.require("main");
		const ops = core.bots.require("ops");
		const mainActive = core.skills.active(main).map((s) => s.name).sort();
		assert.deepEqual(mainActive, ["backup-check"]);
		assert.deepEqual(core.skills.active(ops).map((s) => s.name), ["proxmox-health"], "ops does not get global skills it did not opt into");

		const s = await core.sessions.create("main");
		const c = collect(core.hub, s.id);
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("skill", { name: "backup-check" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("skill", { name: "backup-check", file: "../../../config.yaml" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("skill", { name: "release-notes" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("Following the backup-check skill.")]),
		]);
		await core.sessions.submit(s.id, "check the backups");
		await c.until((e) => e.type === "run.finished");
		const results = c.events.filter((e) => e.type === "tool.finished") as { resultText: string; isError: boolean }[];
		assert.match(results[0]!.resultText, /zfs list -t snapshot/);
		assert.match(results[0]!.resultText, /notes\.md/);
		assert.equal(results[1]!.isError, true, "no path escape");
		assert.equal(results[2]!.isError, true, "inactive skill is not loadable");
		assert.equal(core.skills.usage("main").get("backup-check"), 1);
		// The prompt lists the active skill by name and description only.
		const prompt = (await Promise.all(core.deps.promptParts.map((p) => p(main, s.id)))).join("\n");
		assert.match(prompt, /- backup-check: Check last night's backups/);
		assert.doesNotMatch(prompt, /zfs list/);
		assert.doesNotMatch(prompt, /release-notes/);

		// A job session can attach a skill its bot does not have.
		const job = await core.sessions.create("ops", { kind: "job", skills: ["release-notes"] });
		assert.deepEqual(core.skills.active(ops, ["release-notes"]).map((x) => x.name).sort(), ["proxmox-health", "release-notes"]);
		const jobPrompt = (await Promise.all(core.deps.promptParts.map((p) => p(ops, job.id)))).join("\n");
		assert.match(jobPrompt, /release-notes/);

		// Vory's Skills screen: list per bot, toggle, and the change persists as a bot override.
		const server = await startHermesServer(core, { host: "127.0.0.1", port: 0 });
		try {
			const h = { "X-Hermes-Session-Token": TOKEN, "content-type": "application/json" };
			const url = `http://127.0.0.1:${server.port}`;
			const list = (await (await fetch(`${url}/api/skills?profile=ops`, { headers: h })).json()) as { name: string; enabled: boolean }[];
			assert.deepEqual(list.map((x) => [x.name, x.enabled]).sort(), [["backup-check", false], ["proxmox-health", true], ["release-notes", false]]);
			const r = await fetch(`${url}/api/skills/toggle`, { method: "PUT", headers: h, body: JSON.stringify({ name: "backup-check", enabled: true, profile: "ops" }) });
			assert.equal(r.status, 200);
			await fetch(`${url}/api/skills/toggle`, { method: "PUT", headers: h, body: JSON.stringify({ name: "proxmox-health", enabled: false, profile: "ops" }) });
			assert.deepEqual(core.skills.active(core.bots.require("ops")).map((x) => x.name), ["backup-check"]);
			assert.deepEqual(core.bots.overrides("ops"), { disabledSkills: ["proxmox-health"], enabledSkills: ["backup-check"] });
		} finally {
			await server.close();
		}
	} finally {
		await core.close();
		await cleanup();
	}
});

test("memory: remember and recall through tools, survive a restart, and stay per bot unless shared", async () => {
	const { dir, cleanup } = await tempDir();
	const config = testConfig(dir, [
		{ name: "main", default: true, instructions: "main", sharedMemory: ["household"] },
		{ name: "ha", instructions: "home assistant bot", sharedMemory: ["household"] },
		{ name: "ops", instructions: "ops" },
	]);
	const a = fauxModels();
	let core = await testCore(dir, { models: a.models, config });
	try {
		const s = await core.sessions.create("main");
		const c = collect(core.hub, s.id);
		a.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("remember", { text: "Neil's NAS is a TrueNAS box at 10.0.0.20 with a pool called tank.", tags: ["nas"], pinned: true })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("remember", { text: "The thermostat schedule is 68F at night.", space: "household" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("Noted both.")]),
		]);
		await core.sessions.submit(s.id, "remember my NAS details and the thermostat schedule");
		await c.until((e) => e.type === "run.finished");
		await core.close();

		const b = fauxModels();
		core = await testCore(dir, { models: b.models, config });
		const main = core.bots.require("main");
		const ha = core.bots.require("ha");
		const ops = core.bots.require("ops");
		// A new session of main finds it (new conversation, same bot memory).
		const s2 = await core.sessions.create("main");
		const c2 = collect(core.hub, s2.id);
		b.faux.setResponses([fauxAssistantMessage([fauxToolCall("recall", { query: "nas pool" })], { stopReason: "toolUse" }), fauxAssistantMessage([fauxText("It is tank.")])]);
		await core.sessions.submit(s2.id, "what is my NAS pool called?");
		await c2.until((e) => e.type === "run.finished");
		const recalled = c2.events.find((e) => e.type === "tool.finished") as { resultText: string };
		assert.match(recalled.resultText, /pool called tank/);
		assert.match(recalled.resultText, /\(pinned\)/);
		// Provenance points at the session it came from.
		const item = core.memory.search(main, "TrueNAS")[0]!;
		assert.equal(item.source, `session:${s.id}`);
		// Pinned memory is in the prompt for every session of main.
		const prompt = (await Promise.all(core.deps.promptParts.map((p) => p(main, s2.id)))).join("\n");
		assert.match(prompt, /TrueNAS box/);

		// Boundaries: ops sees nothing of main's; ha sees the shared household space but not main's private item.
		assert.equal(core.memory.search(ops, "NAS thermostat").length, 0);
		const haHits = core.memory.search(ha, "thermostat NAS");
		assert.deepEqual(haHits.map((m) => m.owner), ["shared:household"]);
		assert.throws(() => core.memory.search(ops, "x", { space: "household" }), MemoryAccessError);
		assert.throws(() => core.memory.forget(ops, item.id), MemoryAccessError);

		// Editing and forgetting.
		core.memory.update(main, item.id, { pinned: false });
		assert.doesNotMatch((await Promise.all(core.deps.promptParts.map((p) => p(main, s2.id)))).join("\n"), /TrueNAS box/);
		assert.ok(core.memory.forget(main, item.id));
		assert.equal(core.memory.search(main, "TrueNAS").length, 0);
	} finally {
		await core.close();
		await cleanup();
	}
});
