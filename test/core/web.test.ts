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
		assert.match(results[0]!.resultText, /\n\n\(The owner can be shown this as a Page card: show \{from: "c[0-9a-f]{5}"\}\)$/);
		const { turns } = await core.sessions.turns(s.id);
		const fetched = turns.at(-1)!.items.find((i) => i.type === "tool" && i.name === "web_fetch") as unknown as { json: unknown };
		assert.deepEqual(fetched.json, { url: `${base}/page`, status: 200, title: "x" }, "the page's own details beside the text");
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

test("shells never see the gateway's secrets, and tool output never carries a known secret", async () => {
	const { dir, cleanup } = await tempDir();
	process.env.TEST_GATEWAY_API_KEY = "nw-secret-value-0123456789";
	const { registerSecret } = await import("../../src/log.ts");
	registerSecret(process.env.TEST_GATEWAY_API_KEY);
	const { models, faux } = fauxModels();
	const core = await testCore(dir, { models });
	try {
		const s = await core.sessions.create("main");
		const c = collect(core.hub, s.id);
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "env | grep -i -E 'key|token' ; echo HOME=$HOME" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("bash", { command: "echo leaked:nw-secret-value-0123456789" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("done")]),
		]);
		await core.sessions.submit(s.id, "show env");
		await c.until((e) => e.type === "run.finished");
		const out = (c.events.filter((e) => e.type === "tool.finished") as { resultText: string }[]).map((r) => r.resultText);
		assert.doesNotMatch(out[0]!, /TEST_GATEWAY_API_KEY|nw-secret-value/);
		assert.match(out[0]!, /HOME=\//);
		assert.match(out[1]!, /leaked:\[redacted\]/);
		assert.ok(!JSON.stringify(await core.sessions.rows(s.id)).includes("nw-secret-value"));
	} finally {
		await core.close();
		await cleanup();
		delete process.env.TEST_GATEWAY_API_KEY;
	}
});

type Hit = { url: string; method: string; headers: Record<string, string | string[] | undefined>; body: string };

async function listening(handler: (req: Hit, res: import("node:http").ServerResponse, hits: Hit[]) => void) {
	const hits: Hit[] = [];
	const server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => {
			const hit = { url: req.url ?? "", method: req.method ?? "", headers: req.headers, body: Buffer.concat(chunks).toString() };
			hits.push(hit);
			handler(hit, res, hits);
		});
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
	return { hits, port: (server.address() as AddressInfo).port, close: () => server.close() };
}

async function runTools(calls: { name: string; args: Record<string, string | Record<string, string>> }[], setup: (core: Awaited<ReturnType<typeof testCore>>) => void = () => {}) {
	const { dir, cleanup } = await tempDir();
	process.env.TEST_KEY = "key-0123456789abcdefghij";
	const { models, faux } = fauxModels();
	const config = testConfig(dir, [{ name: "ha", default: true, instructions: "home", secrets: ["TEST_KEY"] }]);
	const core = await testCore(dir, { models, config });
	try {
		setup(core);
		const s = await core.sessions.create("ha");
		const c = collect(core.hub, s.id);
		faux.setResponses([...calls.map((x) => fauxAssistantMessage([fauxToolCall(x.name, x.args)], { stopReason: "toolUse" })), fauxAssistantMessage([fauxText("done")])]);
		await core.sessions.submit(s.id, "go");
		await c.until((e) => e.type === "run.finished");
		return (c.events.filter((e) => e.type === "tool.finished") as { resultText: string; isError: boolean }[]).map((r) => ({ text: r.resultText, isError: r.isError }));
	} finally {
		await core.close();
		await cleanup();
		delete process.env.TEST_KEY;
	}
}

test("a bot's web tools cannot reach this gateway's own panel, directly or by redirect", async () => {
	const own = await listening((_h, res) => {
		res.writeHead(200);
		res.end("panel");
	});
	const other = await listening((h, res) => {
		if (h.url === "/to-panel") {
			res.writeHead(302, { location: `http://localhost:${own.port}/PANEL/api/connect/token` });
			res.end();
			return;
		}
		res.writeHead(200);
		res.end("fine");
	});
	try {
		const r = await runTools(
			[
				{ name: "http_request", args: { method: "POST", url: `http://127.0.0.1:${own.port}/panel/api/connect/token`, headers: { "x-nhermes-panel": "1" } } },
				{ name: "web_fetch", args: { url: `http://localhost:${own.port}/panel` } },
				{ name: "http_request", args: { method: "GET", url: `http://127.0.0.1:${other.port}/panel/x` } },
				{ name: "http_request", args: { method: "GET", url: `http://127.0.0.1:${own.port}/api/ping` } },
				{ name: "http_request", args: { method: "GET", url: `http://127.0.0.1:${other.port}/to-panel` } },
			],
			(core) => core.members.setListenPort(own.port),
		);
		assert.equal(r[0]!.isError, true);
		assert.match(r[0]!.text, /control panel can't be used from a bot's tools/);
		assert.match(r[1]!.text, /control panel can't be used/);
		assert.match(r[2]!.text, /^200/, "another port is not the panel");
		assert.match(r[3]!.text, /^200/, "/api on the own port still works");
		assert.match(r[4]!.text, /control panel can't be used/);
		assert.deepEqual(own.hits.map((h) => h.url), ["/api/ping"], "nothing else reached the own server");
	} finally {
		own.close();
		other.close();
	}
});

test("http_request keeps keys on the host they were meant for when a redirect leaves it", async () => {
	const target = await listening((_h, res) => {
		res.writeHead(200);
		res.end("target");
	});
	const origin = await listening((h, res) => {
		const send = (status: number, location: string) => {
			res.writeHead(status, { location });
			res.end();
		};
		if (h.url === "/cross") return send(302, `http://localhost:${target.port}/landing`);
		if (h.url === "/cross307") return send(307, `http://localhost:${target.port}/landing`);
		if (h.url === "/same") return send(302, "/landing");
		res.writeHead(200);
		res.end("origin landing");
	});
	try {
		const key = "key-0123456789abcdefghij";
		const o = `http://127.0.0.1:${origin.port}`;
		const r = await runTools([
			{ name: "http_request", args: { method: "GET", url: `${o}/cross`, headers: { "x-api-key": "{{secret:TEST_KEY}}", "x-plain": "yes" } } },
			{ name: "http_request", args: { method: "GET", url: `${o}/same`, headers: { "x-api-key": "{{secret:TEST_KEY}}" } } },
			{ name: "http_request", args: { method: "POST", url: `${o}/cross307`, body: "token={{secret:TEST_KEY}}" } },
			{ name: "http_request", args: { method: "POST", url: `${o}/cross307`, body: "plain" } },
		]);
		assert.match(r[0]!.text, /^200[\s\S]*target/, "an ordinary redirect is followed");
		assert.equal(target.hits[0]!.headers["x-api-key"], undefined);
		assert.equal(target.hits[0]!.headers["x-plain"], "yes");
		const same = origin.hits.find((h) => h.url === "/landing")!;
		assert.equal(same.headers["x-api-key"], key, "same-origin redirects behave as before");
		assert.match(r[1]!.text, /origin landing/);
		assert.match(r[2]!.text, /^307[\s\S]*not following a redirect to http:\/\/localhost:\d+ with a key in the request/);
		assert.match(r[3]!.text, /^200[\s\S]*target/);
		assert.equal(target.hits.length, 2, "the keyed 307 never reached the second host");
		assert.equal(target.hits[1]!.body, "plain", "a keyless 307 resends its body");
	} finally {
		origin.close();
		target.close();
	}
});
