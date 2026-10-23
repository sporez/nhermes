// Push notifications across the network: the gateway the phone is connected to notifies for the chats it runs,
// its members' bots included; the member running the bot stays quiet for them, so a phone registered with both
// gets each notification once. A chat the member's own client starts is still the member's to notify.
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { join } from "node:path";
import { test } from "node:test";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { Core } from "../../src/app.ts";
import type { BotConfig } from "../../src/config.ts";
import { type GatewayServer, startServer } from "../../src/server.ts";
import { ApiSocketClient } from "../api/client.ts";
import { FakeApns } from "../notify/fake-apns.ts";
import { tempDir, testConfig, testCore } from "../helpers.ts";

type Gw = { core: Core; server: GatewayServer; faux: ReturnType<typeof fauxProvider>; apple: FakeApns; port: number };

async function gateway(dir: string, name: string, bots: BotConfig[]): Promise<Gw> {
	const d = join(dir, name);
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }], tokensPerSecond: 400 });
	const models = createModels();
	models.setProvider(faux.provider);
	const apple = await FakeApns.start();
	const config = testConfig(d, bots, { node: { name }, apns: { keyId: "KEY1234567", teamId: "TEAM123456", keyEnv: "APNS_FED_TEST_KEY" } });
	const core = await testCore(d, { models, config, apnsHosts: { production: apple.url, development: apple.url }, pushSettleMs: 10 });
	const server = await startServer(core, { host: "127.0.0.1", port: 0 });
	return { core, server, faux, apple, port: server.port };
}

/** The same phone, registered with a gateway. */
function registerPhone(g: Gw): void {
	g.core.devices.register({ token: "c3".repeat(32), platform: "ios", environment: "development", bundleId: "com.example.nhermes", name: "Phone" });
}

test("a member's bot: the connected gateway notifies, the member does not", async () => {
	process.env.APNS_FED_TEST_KEY = Buffer.from(generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" }) as string).toString("base64");
	const { dir, cleanup } = await tempDir();
	const a = await gateway(dir, "alpha", [{ name: "main", default: true }]);
	const b = await gateway(dir, "beta", [{ name: "nasbot", default: true }]);
	let app: ApiSocketClient | undefined;
	let local: ApiSocketClient | undefined;
	try {
		await b.core.members.join(a.core.members.invite().code);
		await a.core.roster.sync();
		registerPhone(a);
		registerPhone(b);

		app = await ApiSocketClient.connect(a.port);
		const { session } = await app.call<{ session: { id: string } }>("sessions.create", { botId: "nasbot-beta" });
		const sid = session.id;
		await app.call("sessions.subscribe", { id: sid });
		b.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "sudo apt-get install -y cowsay" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("Skipped cowsay. The pool is healthy.")]),
		]);
		await app.call("sessions.submit", { id: sid, text: "Install cowsay and check the pool" });
		const asked = await app.waitEvent("approval.requested", 20000);
		await app.call("approvals.answer", { id: (asked.data.approval as { id: string }).id, choice: "deny" });

		// alpha: the approval and the reply, both opening the chat with beta's bot.
		const ask = await a.apple.next((s) => s.body.nh.kind === "approval");
		assert.match(ask.body.aps.alert.title, /Nasbot.* · approval needed/);
		assert.match(ask.body.aps.alert.body, /from beta: /);
		assert.deepEqual([ask.body.nh.sessionId, ask.body.nh.botId], [sid, "nasbot-beta"]);
		const reply = await a.apple.next((s) => s.body.nh.kind === "turn");
		assert.match(reply.body.aps.alert.body, /The pool is healthy\./);
		assert.deepEqual([reply.body.nh.sessionId, reply.body.nh.botId], [sid, "nasbot-beta"]);

		// A chat beta's own client starts is still beta's to notify.
		local = await ApiSocketClient.connect(b.port);
		const { session: own } = await local.call<{ session: { id: string } }>("sessions.create", {});
		await local.call("sessions.subscribe", { id: own.id });
		b.faux.setResponses([fauxAssistantMessage([fauxText("Local answer.")])]);
		await local.call("sessions.submit", { id: own.id, text: "hello" });
		const mine = await b.apple.next((s) => s.body.nh.kind === "turn");
		assert.equal(mine.body.nh.sessionId, own.id);
		// beta ran alpha's turn and asked its approval before this chat began, yet sent nothing about it.
		assert.deepEqual(b.apple.sent.map((s) => s.body.nh.sessionId), [own.id]);
		assert.equal(a.apple.sent.filter((s) => s.body.nh.kind === "approval").length, 1);
		assert.equal(a.apple.sent.filter((s) => s.body.nh.kind === "turn").length, 1);
	} finally {
		await app?.close();
		await local?.close();
		for (const g of [b, a]) {
			await g.server.close();
			await g.core.close();
			await g.apple.close();
		}
		delete process.env.APNS_FED_TEST_KEY;
		await cleanup();
	}
});
