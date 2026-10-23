// Vory notifications across the network: the gateway the phone is connected to notifies for the chats it
// runs, its members' bots included; the member running the bot stays quiet for them, so a phone
// registered with Vory notifications on both gets each notification once.
import assert from "node:assert/strict";
import { createDecipheriv, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { Core } from "../../src/app.ts";
import type { BotConfig } from "../../src/config.ts";
import { type GatewayServer, startServer } from "../../src/server.ts";
import { tempDir, testConfig, testCore } from "../helpers.ts";
import { ApiSocketClient } from "../api/client.ts";

type Push = { kind: string; title: string; body: string; hermes: Record<string, string> };
type Gw = { core: Core; server: GatewayServer; faux: ReturnType<typeof fauxProvider>; port: number; pushes: Push[]; live: string[] };

const KEY = randomBytes(32).toString("base64");

function decrypt(enc: string): Record<string, unknown> {
	const raw = Buffer.from(enc, "base64");
	const d = createDecipheriv("aes-256-gcm", Buffer.from(KEY, "base64"), raw.subarray(0, 12));
	d.setAuthTag(raw.subarray(raw.length - 16));
	return JSON.parse(Buffer.concat([d.update(raw.subarray(12, raw.length - 16)), d.final()]).toString("utf8"));
}

async function gateway(dir: string, name: string, bots: BotConfig[]): Promise<Gw> {
	const d = join(dir, name);
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }], tokensPerSecond: 400 });
	const models = createModels();
	models.setProvider(faux.provider);
	const pushes: Push[] = [];
	const live: string[] = [];
	const voryFetch = (async (_url: string, init: RequestInit) => {
		const body = JSON.parse(String(init.body)) as Record<string, unknown>;
		if (body.push_type === "alert") {
			const a = decrypt(String(body.enc)) as { title: string; body: string; hermes: Record<string, string> };
			pushes.push({ kind: a.hermes.kind!, title: a.title, body: a.body, hermes: a.hermes });
		} else if (body.push_type === "liveactivity") live.push(String(body.event));
		return new Response("{}", { status: 200 });
	}) as typeof fetch;
	const core = await testCore(d, { models, voryFetch, config: testConfig(d, bots, { node: { name } }) });
	const server = await startServer(core, { host: "127.0.0.1", port: 0 });
	return { core, server, faux, port: server.port, pushes, live };
}

/** The phone, set up with Vory notifications on this gateway (one relay registration, as on a real phone). */
function registerPhone(g: Gw, sessionForActivity?: string): void {
	const home = join(g.core.config.dataDir, "vory");
	mkdirSync(join(home, "plugins", "vory-push"), { recursive: true });
	mkdirSync(join(home, "push", "devices"), { recursive: true });
	writeFileSync(join(home, "plugins", "vory-push", "plugin.yaml"), 'version: "1.0.37"\n');
	const device = {
		device_id: "phone",
		platform: "ios",
		apns_token: "tok",
		registered_at: new Date().toISOString(),
		relay: { url: "https://relay.example", install_id: "inst-phone", secret: "s".repeat(48) },
		payload_key: KEY,
		...(sessionForActivity ? { live_activities: [{ session_id: sessionForActivity, token: "la", started_at: Date.now() / 1000 }] } : {}),
	};
	writeFileSync(join(home, "push", "devices", "phone.json"), JSON.stringify(device));
}

async function until<T>(fn: () => T | undefined, ms = 5000): Promise<T> {
	const end = Date.now() + ms;
	for (;;) {
		const v = fn();
		if (v !== undefined) return v;
		if (Date.now() > end) throw new Error("timed out");
		await new Promise((r) => setTimeout(r, 25));
	}
}

test("a member's bot: the connected gateway notifies, the member does not", async () => {
	const { dir, cleanup } = await tempDir();
	const a = await gateway(dir, "alpha", [{ name: "main", default: true }]);
	const b = await gateway(dir, "beta", [{ name: "nasbot", default: true }]);
	let vory: ApiSocketClient | undefined;
	let local: ApiSocketClient | undefined;
	try {
		const { code } = a.core.members.invite();
		await b.core.members.join(code);
		await a.core.roster.sync();
		registerPhone(b);

		vory = await ApiSocketClient.connect(a.port);
		const { session } = await vory.call<{ session: { id: string } }>("sessions.create", { botId: "nasbot-beta" });
		const sid = session.id;
		await vory.call("sessions.subscribe", { id: sid });
		registerPhone(a, sid);

		b.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "sudo apt-get install -y cowsay" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("Skipped cowsay. The pool is healthy.")]),
		]);
		await vory.call("sessions.submit", { id: sid, text: "Install cowsay and check the pool" });
		const asked = await vory.waitEvent("approval.requested", 20000);
		await vory.call("approvals.answer", { id: (asked.data.approval as { id: string }).id, choice: "deny" });
		await vory.waitEvent((e) => e.event === "turn.finished" && e.sessionId === sid, 20000);

		// alpha: the approval and the reply, both opening the chat with beta's bot, and the Live Activity finished.
		const ask = await until(() => a.pushes.find((p) => p.kind === "approval"));
		assert.equal(ask.title, "Nasbot (beta) · approval needed");
		assert.match(ask.body, /from beta: /);
		assert.deepEqual([ask.hermes.session_id, ask.hermes.profile], [sid, "nasbot-beta"]);
		const reply = await until(() => a.pushes.find((p) => p.kind === "turn"));
		assert.equal(reply.title, "Nasbot (beta)");
		assert.match(reply.body, /The pool is healthy\./);
		assert.deepEqual([reply.hermes.session_id, reply.hermes.profile, reply.hermes.text], [sid, "nasbot-beta", "Skipped cowsay. The pool is healthy."]);
		await until(() => (a.live.includes("update") ? true : undefined));

		// beta ran the turn and asked the approval, but alpha drives the chat: beta sends nothing.
		await new Promise((r) => setTimeout(r, 300));
		assert.deepEqual(b.pushes, []);
		assert.equal(a.pushes.filter((p) => p.kind === "approval").length, 1);
		assert.equal(a.pushes.filter((p) => p.kind === "turn").length, 1);

		// A chat beta's own client starts is still beta's to notify.
		local = await ApiSocketClient.connect(b.port);
		const { session: ownSession } = await local.call<{ session: { id: string } }>("sessions.create", {});
		const own = ownSession.id;
		await local.call("sessions.subscribe", { id: own });
		b.faux.setResponses([fauxAssistantMessage([fauxText("Local answer.")])]);
		await local.call("sessions.submit", { id: own, text: "hello" });
		await local.waitEvent((e) => e.event === "turn.finished" && e.sessionId === own);
		const mine = await until(() => b.pushes.find((p) => p.kind === "turn"));
		assert.equal(mine.hermes.session_id, own);
	} finally {
		await vory?.close();
		await local?.close();
		await b.server.close();
		await a.server.close();
		await a.core.close();
		await b.core.close();
		await cleanup();
	}
});
