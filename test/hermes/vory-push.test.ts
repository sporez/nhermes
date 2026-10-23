// Vory's own notifications: the app's Companion setup (files API, plugin enable, heartbeat) and what
// reaches the push relay, decrypted the way the app's notification extension opens it.
import assert from "node:assert/strict";
import { createDecipheriv, createHash, randomBytes } from "node:crypto";
import { test } from "node:test";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { startServer } from "../../src/server.ts";
import { TOKEN, tempDir, testCore } from "../helpers.ts";
import { HermesClient } from "./client.ts";

type Sent = { url: string; body: Record<string, unknown> };

function decrypt(keyB64: string, enc: string): Record<string, unknown> {
	const raw = Buffer.from(enc, "base64");
	const d = createDecipheriv("aes-256-gcm", Buffer.from(keyB64, "base64"), raw.subarray(0, 12));
	d.setAuthTag(raw.subarray(raw.length - 16));
	return JSON.parse(Buffer.concat([d.update(raw.subarray(12, raw.length - 16)), d.final()]).toString("utf8"));
}

const dataUrl = (v: string | object) => `data:application/octet-stream;base64,${Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64")}`;

async function until<T>(fn: () => T | undefined, ms = 5000): Promise<T> {
	const end = Date.now() + ms;
	for (;;) {
		const v = fn();
		if (v !== undefined) return v;
		if (Date.now() > end) throw new Error("timed out");
		await new Promise((r) => setTimeout(r, 25));
	}
}

test("without a fetch override the relay is called with the real fetch", async () => {
	const { dir, cleanup } = await tempDir();
	const real = globalThis.fetch;
	const calls: string[] = [];
	globalThis.fetch = (async (url: string) => (calls.push(url), new Response("{}", { status: 200 }))) as typeof fetch;
	const { models } = (await import("../helpers.ts")).fauxModels();
	const core = await testCore(dir, { models }); // as the app builds it: voryFetch undefined
	try {
		const home = core.bots.get("main")!.workspace;
		core.vory.write(`${home}/plugins/vory-push/plugin.yaml`, Buffer.from('version: "1.0.37"\n'));
		core.vory.write(
			`${home}/push/devices/A.json`,
			Buffer.from(JSON.stringify({ device_id: "A", platform: "ios", apns_token: "t", relay: { url: "https://relay.example", install_id: "i", secret: "s" }, payload_key: randomBytes(32).toString("base64") })),
		);
		await core.notifier.send({ title: "t", message: "m" });
		assert.deepEqual(calls, ["https://relay.example/v1/push"]);
	} finally {
		globalThis.fetch = real;
		await core.close();
		await cleanup();
	}
});

test("Vory notifications through the push relay", async () => {
	const { dir, cleanup } = await tempDir();
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }], tokensPerSecond: 4000 });
	const models = createModels();
	models.setProvider(faux.provider);
	const sent: Sent[] = [];
	const voryFetch = (async (url: string, init: RequestInit) => {
		sent.push({ url, body: JSON.parse(String(init.body)) });
		return new Response('{"ok":true}', { status: 200 });
	}) as typeof fetch;
	const core = await testCore(dir, { models, voryFetch });
	const server = await startServer(core, { host: "127.0.0.1", port: 0 });
	const base = `http://127.0.0.1:${server.port}`;
	const call = async (method: string, path: string, body?: unknown) => {
		const r = await fetch(base + path, { method, headers: { "X-Hermes-Session-Token": TOKEN, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
		return { status: r.status, json: (await r.json()) as Record<string, unknown> };
	};
	const read = async (path: string) => {
		const r = await call("GET", `/api/files/read?path=${encodeURIComponent(path)}`);
		return r.status === 200 ? Buffer.from(String(r.json.data_url).split(",")[1]!, "base64").toString("utf8") : undefined;
	};
	const upload = (path: string, v: string | object) => call("POST", "/api/files/upload", { path, data_url: dataUrl(v), overwrite: true });
	const home = core.bots.get("main")!.workspace;
	const opsHome = core.bots.get("ops")!.workspace;
	const device = (id: string, key: string, extra: object = {}) => ({
		schema: 1,
		device_id: id,
		platform: "ios",
		app: "Vory",
		bundle_id: "com.vorantx.vory",
		apns_token: `tok-${id}`,
		apns_environment: "production",
		connection_id: "11111111-2222-3333-4444-555555555555",
		gateway: "https://gw.example",
		device_name: id,
		registered_at: new Date().toISOString(),
		relay: { url: "https://relay.example/", install_id: `inst-${id}`, secret: `secret-${id}` },
		payload_key: key,
		...extra,
	});
	const keyA = randomBytes(32).toString("base64");
	const keyB = randomBytes(32).toString("base64");
	const alerts = (inst: string, key: string) =>
		sent
			.filter((s) => s.body.install_id === inst && s.body.push_type === "alert")
			.map((s) => ({ collapse_id: s.body.collapse_id as string | undefined, alert: decrypt(key, String(s.body.enc)) }));
	const ws = await HermesClient.connect(server.port, TOKEN);
	try {
		await ws.waitEvent("gateway.ready");

		// Uploads take only the Companion's files (the Files browser is read-only, test/hermes/manage.test.ts).
		assert.equal((await upload(`${home}/notes.txt`, "hi")).status, 403);
		assert.equal((await upload(`${home}/push/../../escape.json`, "{}")).status, 403);
		assert.equal((await upload("/etc/push/devices/x.json", "{}")).status, 403);
		assert.equal(await read(`${home}/plugins/vory-push/plugin.yaml`), undefined, "not installed yet");
		const before = JSON.parse((await read(`${home}/push/status.json`))!);
		assert.equal(before.version, "1.0.12");
		assert.equal(before.connected, true);

		// The phone registers; nothing is sent until the Companion is installed from Vory.
		assert.equal((await upload(`${home}/push/devices/A.json`, device("A", keyA))).status, 200);
		assert.equal(JSON.parse((await read(`${home}/push/devices/A.json`))!).device_id, "A");
		const { session_id: sid } = await ws.call<{ session_id: string }>("session.create", {});
		faux.setResponses([fauxAssistantMessage([fauxText("First answer.")])]);
		await ws.call("prompt.submit", { session_id: sid, text: "hello" });
		await ws.waitEvent("message.complete", sid);
		await new Promise((r) => setTimeout(r, 100));
		assert.equal(sent.length, 0);
		assert.equal(core.notifier.name, "none");

		// Install: plugin files land in the store (under any bot's home), enable answers ok, the heartbeat follows the files.
		const script = "# hermes_push.py as the app ships it\n";
		await upload(`${opsHome}/plugins/vory-push/plugin.yaml`, 'name: vory-push\nversion: "1.0.40"\n');
		await upload(`${home}/plugins/vory-push/hermes_push.py`, script);
		assert.deepEqual((await call("POST", "/api/dashboard/agent-plugins/vory-push/enable")).json, { ok: true });
		assert.equal((await call("POST", "/api/dashboard/agent-plugins/other/enable")).status, 404);
		const hb = JSON.parse((await read(`${home}/push/status.json`))!);
		assert.equal(hb.version, "1.0.40");
		assert.equal(hb.script_sha256, createHash("sha256").update(script).digest("hex"));
		assert.equal(hb.devices, 1);
		assert.equal(core.notifier.name, "vory");

		// The app's test button.
		await upload(`${home}/push/test-request.json`, { nonce: "n-123" });
		const testPush = await until(() => alerts("inst-A", keyA)[0]);
		assert.equal((testPush.alert.hermes as Record<string, unknown>).kind, "test");
		assert.equal(sent[0]!.url, "https://relay.example/v1/push");
		assert.equal(sent[0]!.body.secret, "secret-A");
		assert.equal(JSON.parse((await read(`${home}/push/status.json`))!).last_test_nonce, "n-123");

		// A finished turn: the reply as a notification that opens the chat, and the Live Activity ends.
		await upload(`${home}/push/devices/B.json`, device("B", keyB, { live_activities: [{ session_id: sid, token: "la-tok", started_at: Date.now() / 1000 - 5 }] }));
		sent.length = 0;
		faux.setResponses([fauxAssistantMessage([fauxText("The disk is 40% full.")])]);
		await ws.call("prompt.submit", { session_id: sid, text: "check the disk" });
		await ws.waitEvent("message.complete", sid);
		const turn = await until(() => alerts("inst-A", keyA)[0]);
		assert.equal(turn.alert.title, "Main");
		assert.match(String(turn.alert.body), /The disk is 40% full\./);
		assert.equal(turn.alert.category, "HERMES_TURN");
		assert.equal(turn.collapse_id, `turn-${sid}`);
		const h = turn.alert.hermes as Record<string, string>;
		assert.deepEqual([h.kind, h.session_id, h.profile, h.text, h.connection_id, h.gateway], ["turn", sid, "main", "The disk is 40% full.", "11111111-2222-3333-4444-555555555555", "https://gw.example"]);
		await until(() => alerts("inst-B", keyB)[0]);
		const la = await until(() => sent.find((s) => s.body.push_type === "liveactivity"));
		assert.deepEqual([la.body.install_id, la.body.token, la.body.event], ["inst-B", "la-tok", "update"]);
		assert.equal((la.body.content_state as { phase: string }).phase, "done");

		// An approval reaches both devices; once answered on A, B's banner is replaced quietly.
		await ws.call("client.capabilities", { server_requests: true });
		sent.length = 0;
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "rm -rf ./tmpdir; echo cleaned" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("Cleaned.")]),
		]);
		await ws.call("prompt.submit", { session_id: sid, text: "clean tmpdir" });
		const req = await ws.waitFor((f) => typeof f.id === "string" && f.method === "approval");
		const rid = (req.params as { request_id: string }).request_id;
		const ask = await until(() => alerts("inst-A", keyA).find((a) => (a.alert.hermes as Record<string, string>).kind === "approval"));
		assert.equal(ask.alert.category, "HERMES_APPROVAL");
		assert.equal(ask.alert.interruption, "time-sensitive");
		assert.equal(ask.collapse_id, rid);
		assert.equal((ask.alert.hermes as Record<string, string>).request_id, rid);
		assert.equal((ask.alert.hermes as Record<string, string>).card_id, req.id);
		await until(() => alerts("inst-B", keyB).find((a) => (a.alert.hermes as Record<string, string>).kind === "approval"));
		await upload(`${home}/push/answers/${rid}.json`, { device_id: "A", session_id: sid, at: Date.now() / 1000 });
		ws.respond(req.id as string, { choice: "once" });
		await ws.waitEvent("message.complete", sid);
		const settled = await until(() => alerts("inst-B", keyB).find((a) => (a.alert.hermes as Record<string, string>).kind === "settled"), 6000);
		assert.equal(settled.collapse_id, rid);
		assert.equal(settled.alert.interruption, "passive");
		assert.equal(alerts("inst-A", keyA).filter((a) => (a.alert.hermes as Record<string, string>).kind === "settled").length, 0, "the device that answered keeps its own");

		// The notify tool and scheduled tasks go through the same devices.
		sent.length = 0;
		await core.notifier.send({ title: "Backup failed", message: "nas: disk full", priority: 1, sessionId: sid, bot: "main" });
		const note = alerts("inst-A", keyA)[0]!;
		assert.equal(note.alert.title, "Main · Backup failed");
		assert.equal(note.alert.category, "HERMES_ERROR");
		// One about no chat (an OpenChamber alert) names none, so tapping it does not open an empty one.
		sent.length = 0;
		await core.notifier.send({ title: "OpenChamber", message: "A thread finished" });
		const loose = alerts("inst-A", keyA)[0]!;
		assert.equal("session_id" in (loose.alert.hermes as Record<string, unknown>), false);
		assert.equal(loose.alert.thread_id, "");

		// Uninstall: disabled, nothing more is sent.
		assert.deepEqual((await call("POST", "/api/dashboard/agent-plugins/vory-push/disable")).json, { ok: true });
		assert.equal(await read(`${home}/plugins/vory-push/plugin.yaml`), undefined);
		assert.equal((await call("DELETE", "/api/files", { path: `${home}/push/devices/A.json`, recursive: false })).status, 200);
		assert.equal(await read(`${home}/push/devices/A.json`), undefined);
		assert.equal(core.notifier.name, "none");
	} finally {
		await ws.close();
		await server.close();
		await core.close();
		await cleanup();
	}
});
