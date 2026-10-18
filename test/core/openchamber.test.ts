import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { condenseMessages, type Message, OpenChamber } from "../../src/openchamber/client.ts";
import { redact } from "../../src/log.ts";
import { tempDir } from "../helpers.ts";

const TOKEN = "oc-token-0123456789abcdef";

type Seen = { method: string; url: string; auth?: string; body?: unknown };

/** A fake OpenChamber: `routes` maps "METHOD /path" (query ignored) to the JSON it answers with. */
async function fakeServer(routes: Record<string, (seen: Seen) => unknown>) {
	const seen: Seen[] = [];
	const server = createServer(async (req: IncomingMessage, res) => {
		let raw = "";
		for await (const c of req) raw += c;
		const s: Seen = { method: req.method!, url: req.url!, auth: req.headers.authorization, body: raw ? JSON.parse(raw) : undefined };
		seen.push(s);
		if (s.auth !== `Bearer ${TOKEN}`) {
			res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "UI authentication required", locked: true }));
			return;
		}
		const route = routes[`${s.method} ${s.url.split("?")[0]}`];
		if (!route) {
			res.writeHead(404).end(JSON.stringify({ message: "no route" }));
			return;
		}
		const out = route(s);
		if (out === undefined) res.writeHead(204).end();
		else res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(out));
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
	const port = (server.address() as AddressInfo).port;
	return { port, seen, base: `http://127.0.0.1:${port}`, close: () => server.close() };
}

async function settingsFile(dir: string, port: number, token = TOKEN): Promise<string> {
	await mkdir(dir, { recursive: true });
	const path = join(dir, "settings.json");
	await writeFile(path, JSON.stringify({ desktopLocalPort: port, desktopLocalClientToken: token }));
	return path;
}

test("client reads port and token from the settings file on each call and sends the bearer", async () => {
	const { dir, cleanup } = await tempDir();
	const a = await fakeServer({ "GET /api/session/active": () => ({ data: { ses_1: { type: "running" } } }) });
	try {
		const settingsPath = await settingsFile(dir, a.port);
		const oc = new OpenChamber({ settingsPath });
		assert.deepEqual(await oc.get("/api/session/active"), { data: { ses_1: { type: "running" } } });
		assert.equal(a.seen[0]!.auth, `Bearer ${TOKEN}`);
		// Rewritten settings (OpenChamber restarted on another port) are picked up without a new client.
		const b = await fakeServer({ "GET /api/session/active": () => ({ data: {} }) });
		await settingsFile(dir, b.port);
		assert.deepEqual(await oc.get("/api/session/active"), { data: {} });
		assert.equal(b.seen.length, 1);
		b.close();
		assert.equal(redact(`leak ${TOKEN}`), "leak [redacted]");
	} finally {
		a.close();
		await cleanup();
	}
});

test("client explains a missing settings file, a refused connection and a rejected token", async () => {
	const { dir, cleanup } = await tempDir();
	const s = await fakeServer({});
	try {
		await assert.rejects(new OpenChamber({ settingsPath: join(dir, "nope.json") }).get("/health"), /settings file .* does not exist/);
		const settingsPath = await settingsFile(dir, s.port, "wrong-token-0123456789");
		await assert.rejects(new OpenChamber({ settingsPath }).get("/api/session"), /OpenChamber rejected the token/);
		s.close();
		await assert.rejects(new OpenChamber({ settingsPath }).get("/api/session"), /OpenChamber is not running on this Mac/);
		// A per-bot override wins over the settings file.
		process.env.TEST_OC_TOKEN = TOKEN;
		const o = await fakeServer({ "GET /api/session": () => ({ data: [] }) });
		try {
			assert.deepEqual(await new OpenChamber({ settingsPath, config: { url: o.base, tokenEnv: "TEST_OC_TOKEN" } }).get("/api/session"), { data: [] });
		} finally {
			o.close();
			delete process.env.TEST_OC_TOKEN;
		}
	} finally {
		await cleanup();
	}
});

test("condenseMessages keeps text, one line per tool call, drops reasoning, and caps the total", () => {
	const msgs: Message[] = [
		{ id: "m1", type: "user", text: "fix the bug" },
		{
			id: "m2",
			type: "assistant",
			content: [
				{ type: "reasoning", text: "secret thoughts" },
				{ type: "text", text: "Looking." },
				{ type: "tool", name: "read", state: { status: "completed", input: { filePath: "/a/b.ts" } } },
				{ type: "tool", name: "bash", state: { status: "error", input: { command: "npm test" }, error: { message: "exit 1" } } },
			],
		},
	];
	const out = condenseMessages(msgs);
	assert.match(out, /USER: fix the bug/);
	assert.match(out, /· read \/a\/b\.ts → ok/);
	assert.match(out, /· bash npm test → error: exit 1/);
	assert.doesNotMatch(out, /secret thoughts/);
	const long = Array.from({ length: 50 }, (_, i): Message => ({ id: `m${i}`, type: "user", text: "x".repeat(1000) }));
	const capped = condenseMessages(long, 5000);
	assert.ok(capped.length < 5200);
	assert.match(capped, /earlier lines left out/);
});
