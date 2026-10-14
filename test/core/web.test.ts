import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { collect, fauxModels, tempDir, testConfig, testCore } from "../helpers.ts";

test("web_fetch reads pages as text; http_request fills secrets in and never returns them", async () => {
	const { dir, cleanup } = await tempDir();
	const secret = "sk-live-0123456789abcdefghij";
	process.env.TEST_HA_TOKEN = secret;
	process.env.TEST_OTHER_TOKEN = "other-secret-value-123456";
	const server = createServer((req, res) => {
		if (req.url === "/page") {
			res.writeHead(200, { "content-type": "text/html" });
			res.end("<html><head><title>x</title><script>evil()</script></head><body><h1>Status</h1><p>All <b>green</b>.</p></body></html>");
			return;
		}
		res.writeHead(req.headers.authorization === `Bearer ${secret}` ? 200 : 401, { "content-type": "application/json" });
		res.end(JSON.stringify({ seen: req.headers.authorization ?? null, state: "on" }));
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	const { models, faux } = fauxModels();
	const config = testConfig(dir, [{ name: "ha", default: true, instructions: "home", secrets: ["TEST_HA_TOKEN"] }]);
	const core = await testCore(dir, { models, config });
	try {
		const s = await core.sessions.create("ha");
		const c = collect(core.hub, s.id);
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("web_fetch", { url: `${base}/page` })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("http_request", { method: "GET", url: `${base}/api/states`, headers: { Authorization: "Bearer {{secret:TEST_HA_TOKEN}}" } })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("http_request", { method: "GET", url: `${base}/api/states`, headers: { Authorization: "Bearer {{secret:TEST_OTHER_TOKEN}}" } })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("done")]),
		]);
		await core.sessions.submit(s.id, "check");
		await c.until((e) => e.type === "run.finished");
		const results = c.events.filter((e) => e.type === "tool.finished") as { resultText: string; isError: boolean }[];
		assert.match(results[0]!.resultText, /Status\s+All green\./);
		assert.doesNotMatch(results[0]!.resultText, /evil/);
		assert.equal(results[1]!.isError, false);
		assert.match(results[1]!.resultText, /"state":"on"/);
		assert.match(results[1]!.resultText, /Bearer \[redacted\]/, "the echoed credential is scrubbed");
		assert.ok(!results.some((r) => r.resultText.includes(secret)));
		assert.equal(results[2]!.isError, true);
		assert.match(results[2]!.resultText, /not available to this bot/);
		// Nor is it anywhere in the transcript.
		const rows = await core.sessions.rows(s.id);
		assert.ok(!JSON.stringify(rows).includes(secret));
	} finally {
		server.close();
		await core.close();
		await cleanup();
		delete process.env.TEST_HA_TOKEN;
		delete process.env.TEST_OTHER_TOKEN;
	}
});
