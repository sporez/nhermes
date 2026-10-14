// Mode B: an independent agent (another gateway with its own store) reached by delegation over the
// Hermes WebSocket: answers come back, its approvals are asked in the central owner's chat, and a
// dropped connection mid-run recovers without submitting the task twice.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { startHermesServer } from "../../src/hermes/server.ts";
import { collect, fauxModels, TOKEN, tempDir, testConfig, testCore } from "../helpers.ts";

test("delegating to a peer gateway: answer, relayed approval, reconnect without duplicates", async () => {
	const { dir, cleanup } = await tempDir();
	// The peer: its own data dir, its own bot.
	const pf = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }], tokensPerSecond: 300 });
	const pm = createModels();
	pm.setProvider(pf.provider);
	const peerCore = await testCore(join(dir, "peer"), { models: pm, config: testConfig(join(dir, "peer"), [{ name: "nasbot", default: true, instructions: "You run on the NAS." }]) });
	const peer = await startHermesServer(peerCore, { host: "127.0.0.1", port: 0 });
	process.env.TEST_PEER_TOKEN = TOKEN;
	const c = fauxModels();
	const central = await testCore(join(dir, "central"), {
		models: c.models,
		config: testConfig(join(dir, "central"), [
			{ name: "main", default: true, instructions: "main" },
			{ name: "nas", description: "Agent on the NAS", peer: { url: `http://127.0.0.1:${peer.port}`, tokenEnv: "TEST_PEER_TOKEN", profile: "nasbot" } },
		]),
	});
	try {
		await assert.rejects(central.sessions.create("nas"), /another machine/);
		const s = await central.sessions.create("main");
		const ev = collect(central.hub, s.id);
		c.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("delegate", { bot: "nas", task: "Wipe the old scratch disk and report pool health" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("The NAS reports the pool is healthy.")]),
		]);
		pf.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "wipefs -a /dev/sdz" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("Pool tank is ONLINE. " + "detail ".repeat(150))]),
		]);
		await central.sessions.submit(s.id, "ask the NAS agent to clean up and check health");
		// The peer's approval is asked in the central owner's chat.
		const asked = await ev.until((e) => e.type === "approval.requested", 15000);
		if (asked.type !== "approval.requested") return;
		assert.equal(asked.request.sessionId, s.id);
		assert.equal(asked.request.bot, "nas");
		assert.match(asked.request.description, /another machine/);
		central.approvals.answer(asked.request.requestId, "deny");
		// Drop the connection while the peer streams its answer: the central side reconnects and resumes.
		await new Promise((r) => setTimeout(r, 150));
		peer.dropConnections();
		const done = await ev.until((e) => e.type === "run.finished", 30000);
		if (done.type !== "run.finished") return;
		assert.equal(done.text, "The NAS reports the pool is healthy.");
		const tool = ev.events.find((e) => e.type === "tool.finished" && e.name === "delegate");
		assert.ok(tool?.type === "tool.finished" && /nas answered .*Pool tank is ONLINE/s.test(tool.resultText), JSON.stringify(tool));
		// On the peer: one session, the task submitted once, the dangerous command never ran.
		const remote = peerCore.sessions.list("nasbot", { limit: 10, offset: 0, archived: "include", order: "recent" });
		assert.equal(remote.total, 1);
		const rows = await peerCore.sessions.rows(remote.rows[0]!.id);
		assert.equal(rows.filter((r) => r.role === "user").length, 1);
		assert.match(rows.find((r) => r.role === "tool")!.text, /did not approve/);
	} finally {
		await central.close();
		await peer.close();
		await peerCore.close();
		await cleanup();
		delete process.env.TEST_PEER_TOKEN;
	}
});
