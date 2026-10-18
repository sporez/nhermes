import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { OpenChamberWatcher } from "../../src/openchamber/watcher.ts";
import type { Notification, Notifier } from "../../src/notify/notifier.ts";
import { tempDir } from "../helpers.ts";

const TOKEN = "oc-token-0123456789abcdef";

async function fake() {
	const streams: ServerResponse[] = [];
	let connects = 0;
	const sessions: Record<string, unknown> = {
		ses_a: { id: "ses_a", title: "Fix login" },
		ses_child: { id: "ses_child", parentID: "ses_a", title: "sub" },
	};
	const server = createServer((req, res) => {
		if (req.headers.authorization !== `Bearer ${TOKEN}`) return void res.writeHead(401).end();
		if (req.url === "/api/event") {
			connects++;
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.write(`data: ${JSON.stringify({ type: "server.connected", data: {} })}\n\n`);
			streams.push(res);
			return;
		}
		const m = /^\/api\/session\/(\w+)$/.exec(req.url!);
		if (m && sessions[m[1]!]) return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: sessions[m[1]!] }));
		res.writeHead(404).end("{}");
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
	const port = (server.address() as AddressInfo).port;
	return {
		port,
		connects: () => connects,
		send: (type: string, data: unknown) => streams.at(-1)!.write(`id: x\ndata: ${JSON.stringify({ id: "evt", type, data })}\n\n`),
		drop: () => streams.splice(0).forEach((s) => s.destroy()),
		close: () => (streams.forEach((s) => s.destroy()), server.close()),
	};
}

const until = async (fn: () => boolean) => {
	for (let i = 0; i < 200 && !fn(); i++) await new Promise((r) => setTimeout(r, 20));
	assert.ok(fn(), "condition not reached");
};

async function setup(watch: boolean) {
	const { dir, cleanup } = await tempDir();
	const s = await fake();
	const settingsPath = join(dir, "settings.json");
	await writeFile(settingsPath, JSON.stringify({ desktopLocalPort: s.port, desktopLocalClientToken: TOKEN }));
	const sent: Notification[] = [];
	const notifier: Notifier = { name: "test", send: async (n) => void sent.push(n) };
	const w = new OpenChamberWatcher({ configs: () => [{ watch }], notifier: () => notifier, settingsPath, retryMinMs: 20, retryMaxMs: 40, debounceMs: 60_000 });
	return { s, w, sent, done: async () => (await w.stop(), s.close(), await cleanup()) };
}

test("a permission request notifies once with the thread title; a duplicate inside the window does not", async () => {
	const t = await setup(true);
	try {
		t.w.start();
		await until(() => t.s.connects() === 1);
		const p = { id: "per_1", sessionID: "ses_a", action: "run", resources: ["npm test"] };
		t.s.send("permission.asked", p);
		await until(() => t.sent.length === 1);
		assert.equal(t.sent[0]!.message, "Fix login wants to run on npm test");
		t.s.send("permission.asked", { ...p, id: "per_2" });
		// The form's generic title gives way to the question its field asks.
		t.s.send("form.created", { form: { id: "frm_1", sessionID: "ses_a", title: "Questions", fields: [{ key: "q0", title: "Which branch?" }] } });
		await until(() => t.sent.length === 2);
		assert.equal(t.sent[1]!.message, "Fix login asks: Which branch?");
		assert.equal(t.sent.length, 2);
	} finally {
		await t.done();
	}
});

test("a top-level thread finishing notifies, a delegated one does not", async () => {
	const t = await setup(true);
	try {
		t.w.start();
		await until(() => t.s.connects() === 1);
		t.s.send("session.execution.succeeded", { sessionID: "ses_child" });
		t.s.send("session.execution.failed", { sessionID: "ses_a", error: { message: "boom" } });
		await until(() => t.sent.length === 1);
		assert.equal(t.sent[0]!.message, "Fix login failed: boom");
		assert.equal(t.sent.length, 1);
	} finally {
		await t.done();
	}
});

test("the watcher reconnects after the server drops the stream", async () => {
	const t = await setup(true);
	try {
		t.w.start();
		await until(() => t.s.connects() === 1);
		t.s.drop();
		await until(() => t.s.connects() === 2);
		t.s.send("session.execution.succeeded", { sessionID: "ses_a" });
		await until(() => t.sent.length === 1);
		assert.equal(t.sent[0]!.message, "Fix login finished");
	} finally {
		await t.done();
	}
});

test("without watch: true there is no subscription", async () => {
	const t = await setup(false);
	try {
		t.w.start();
		await new Promise((r) => setTimeout(r, 150));
		assert.equal(t.s.connects(), 0);
	} finally {
		await t.done();
	}
});
