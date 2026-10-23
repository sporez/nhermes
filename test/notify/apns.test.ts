// Push straight to Apple: the app registers its device, approvals and finished turns go to Apple's servers (a
// local HTTP/2 stand-in here) with a provider token signed by the owner's key, a settled approval replaces its
// banner quietly, a token Apple calls gone is removed, and nothing a known secret is in what leaves.
import assert from "node:assert/strict";
import { generateKeyPairSync, type KeyObject, verify } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { Core } from "../../src/app.ts";
import { registerSecret } from "../../src/log.ts";
import { type GatewayServer, startServer } from "../../src/server.ts";
import { ApiSocketClient, http } from "../api/client.ts";
import { tempDir, testConfig, testCore } from "../helpers.ts";
import { FakeApns } from "./fake-apns.ts";

const TOKEN_A = "a1".repeat(32);
const TOKEN_GONE = "b2".repeat(32);
let apple: FakeApns;
let publicKey: KeyObject;
let core: Core;
let server: GatewayServer;
let cleanup: () => Promise<void>;
const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
const models = createModels();
models.setProvider(faux.provider);

before(async () => {
	const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
	publicKey = keys.publicKey;
	// As secrets.env holds it: the .p8 file base64-encoded.
	process.env.APNS_TEST_KEY = Buffer.from(keys.privateKey.export({ type: "pkcs8", format: "pem" }) as string).toString("base64");
	apple = await FakeApns.start();
	const t = await tempDir();
	cleanup = t.cleanup;
	const config = testConfig(t.dir, undefined, { apns: { keyId: "KEY1234567", teamId: "TEAM123456", keyEnv: "APNS_TEST_KEY" } });
	core = await testCore(t.dir, { models, config, apnsHosts: { production: apple.url, development: apple.url }, pushSettleMs: 10 });
	server = await startServer(core, { host: "127.0.0.1", port: 0, federationPort: null });
});

after(async () => {
	await server.close();
	await core.close();
	await apple.close();
	delete process.env.APNS_TEST_KEY;
	await cleanup();
});

const api = () => http(server.port);

test("the app registers its device; the hello says push is on; the token is never listed back", async () => {
	const h = await api()<{ features: string[] }>("GET /");
	assert.ok(h.features.includes("push.apns"));
	const r = await api()<{ device: { id: string; tokenEnd: string; platform: string; environment: string; bundleId: string }; pushEnabled: boolean }>("POST /devices", {
		token: TOKEN_A,
		platform: "ios",
		environment: "development",
		bundleId: "com.example.nhermes",
		name: "Phone",
	});
	assert.equal(r.pushEnabled, true);
	assert.equal(r.device.tokenEnd, TOKEN_A.slice(-6));
	// Registering again (every connection does) keeps the same device.
	const again = await api()<{ device: { id: string } }>("POST /devices", { token: TOKEN_A.toUpperCase(), platform: "ios", environment: "development", bundleId: "com.example.nhermes" });
	assert.equal(again.device.id, r.device.id);
	const list = await api()<{ items: { id: string; name: string }[] }>("GET /devices");
	assert.deepEqual(list.items.map((d) => [d.id, d.name]), [[r.device.id, "Phone"]]);
	assert.ok(!JSON.stringify(list).includes(TOKEN_A), "the whole token never comes back");
	await assert.rejects(api()("POST /devices", { token: "not-hex", platform: "ios", environment: "development", bundleId: "com.example.nhermes" }), (e: { code: string }) => e.code === "invalid_params");
	const t = await api()<{ ok: boolean }>(`POST /devices/${r.device.id}/test`);
	assert.equal(t.ok, true);
	const test = await apple.next((s) => s.body.nh.kind === "test");
	assert.equal(test.headers["apns-topic"], "com.example.nhermes");
});

test("an approval goes to Apple with a signed provider token, and is replaced quietly once answered", async () => {
	const app = await ApiSocketClient.connect(server.port);
	const { session } = await app.call<{ session: { id: string } }>("sessions.create", {});
	await app.call("sessions.subscribe", { id: session.id });
	faux.setResponses([fauxAssistantMessage([fauxToolCall("bash", { command: "rm -rf ./tmpdir" })], { stopReason: "toolUse" }), fauxAssistantMessage([fauxText("Cleaned.")])]);
	await app.call("sessions.submit", { id: session.id, text: "clean tmpdir" });
	const ask = await app.waitEvent("approval.requested");
	const approvalId = (ask.data.approval as { id: string }).id;
	const push = await apple.next((s) => s.body.nh.approvalId === approvalId && s.body.nh.kind === "approval");
	assert.equal(push.headers[":path"], `/3/device/${TOKEN_A}`);
	assert.equal(push.headers["apns-push-type"], "alert");
	assert.equal(push.headers["apns-priority"], "10");
	assert.equal(push.headers["apns-collapse-id"], `approval-${approvalId}`);
	assert.equal(push.body.aps.category, "NH_APPROVAL");
	assert.equal(push.body.aps["interruption-level"], "time-sensitive");
	assert.equal(push.body.nh.sessionId, session.id);
	assert.equal(push.body.nh.gateway, core.members.self().id);
	// The provider token: ES256 over header.claims, signed with the owner's key.
	const [h, c, sig] = String(push.headers.authorization).replace(/^bearer /, "").split(".") as [string, string, string];
	assert.deepEqual(JSON.parse(Buffer.from(h, "base64url").toString()), { alg: "ES256", kid: "KEY1234567" });
	assert.equal(JSON.parse(Buffer.from(c, "base64url").toString()).iss, "TEAM123456");
	assert.ok(verify("sha256", Buffer.from(`${h}.${c}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(sig, "base64url")));

	await app.call("approvals.answer", { id: approvalId, choice: "once" });
	const settled = await apple.next((s) => s.body.nh.approvalId === approvalId && s.body.nh.kind === "settled");
	assert.equal(settled.headers["apns-collapse-id"], `approval-${approvalId}`, "it replaces the approval's banner");
	assert.equal(settled.headers["apns-priority"], "5");
	assert.equal(settled.body.aps["interruption-level"], "passive");
	assert.equal(settled.body.aps.sound, undefined);
	const done = await apple.next((s) => s.body.nh.kind === "turn" && s.body.nh.sessionId === session.id);
	assert.match(done.body.aps.alert.body, /Cleaned\./);
	await app.close();
});

test("a token Apple calls gone is removed; scheduled results and the notify tool go out; no secret leaves", async () => {
	const gone = await api()<{ device: { id: string } }>("POST /devices", { token: TOKEN_GONE, platform: "macos", environment: "production", bundleId: "com.example.nhermes" });
	apple.gone.add(TOKEN_GONE);
	const secret = "apns-test-secret-value-9f2e";
	registerSecret(secret);
	await core.localNotifier.send({ title: "Backup", message: `finished with ${secret}` });
	await apple.next((s) => String(s.headers[":path"]).endsWith(TOKEN_GONE));
	const notice = await apple.next((s) => String(s.headers[":path"]).endsWith(TOKEN_A) && s.body.aps.alert.title === "Backup");
	assert.equal(notice.body.aps.category, "NH_TURN");
	assert.ok(!JSON.stringify(apple.sent).includes(secret), "known secrets are removed before Apple sees anything");
	assert.equal(core.devices.get(gone.device.id), undefined);
	const { items } = await api()<{ items: { id: string }[] }>("GET /devices");
	assert.equal(items.length, 1, "only the device that works is left");
	await api()(`DELETE /devices/${items[0]!.id}`);
	assert.equal((await api()<{ items: unknown[] }>("GET /devices")).items.length, 0);
});

test("Vory's old notification registrations are removed when the gateway starts", async () => {
	const t = await tempDir();
	const config = testConfig(t.dir);
	mkdirSync(join(config.dataDir, "vory", "push", "devices"), { recursive: true });
	writeFileSync(join(config.dataDir, "vory", "push", "devices", "phone.json"), "{}");
	const c = await testCore(t.dir, { models, config });
	try {
		assert.equal(existsSync(join(config.dataDir, "vory")), false);
	} finally {
		await c.close();
		await t.cleanup();
	}
});
