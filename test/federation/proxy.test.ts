// Members' bots as Vory profiles: a client connected to alpha chats with beta's bot as if it were local.
// Prompts and events pass through alpha, beta's approval requests are asked by alpha, the chat is listed
// in alpha's catalogue, a dropped link recovers, and an offline member is reported.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { Core } from "../../src/app.ts";
import type { BotConfig } from "../../src/config.ts";
import { type HermesServer, startHermesServer } from "../../src/hermes/server.ts";
import { HermesClient } from "../hermes/client.ts";
import { TOKEN, tempDir, testConfig, testCore } from "../helpers.ts";

type Gw = { core: Core; server: HermesServer; faux: ReturnType<typeof fauxProvider>; port: number };

async function gateway(dir: string, name: string, bots: BotConfig[]): Promise<Gw> {
	const d = join(dir, name);
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }], tokensPerSecond: 400 });
	const models = createModels();
	models.setProvider(faux.provider);
	const core = await testCore(d, { models, config: testConfig(d, bots, { node: { name } }) });
	const server = await startHermesServer(core, { host: "127.0.0.1", port: 0 });
	return { core, server, faux, port: server.port };
}

test("a client on alpha chats with beta's bot through alpha", async () => {
	const { dir, cleanup } = await tempDir();
	const a = await gateway(dir, "alpha", [{ name: "main", default: true }]);
	const b = await gateway(dir, "beta", [{ name: "nasbot", default: true, description: "Runs on the NAS" }]);
	let vory: HermesClient | undefined;
	try {
		const { code } = a.core.members.invite();
		await b.core.members.join(code);
		await a.core.roster.sync();

		const rest = (path: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${a.port}${path}`, { ...init, headers: { "X-Hermes-Session-Token": TOKEN, "content-type": "application/json" } });
		const profiles = (await (await rest("/api/profiles")).json()) as { profiles: { name: string; display_name: string; description: string }[] };
		assert.deepEqual(
			profiles.profiles.map((p) => [p.name, p.display_name, p.description]),
			[
				["main", "Main", ""],
				["nasbot-beta", "Nasbot (beta)", "Runs on the NAS"],
			],
		);
		// Forwarded to beta, which refuses until its owner allows bot edits (test/federation/vory-remote.test.ts).
		assert.equal((await rest("/api/profiles/nasbot-beta/soul", { method: "PUT", body: JSON.stringify({ content: "x" }) })).status, 403);

		vory = await HermesClient.connect(a.port, TOKEN);
		await vory.waitEvent("gateway.ready");
		await vory.call("client.capabilities", { server_requests: true });
		const listed = await vory.call<{ profiles: { name: string }[] }>("profiles.list");
		assert.deepEqual(listed.profiles.map((p) => p.name), ["main", "nasbot-beta"]);

		const created = await vory.call<{ session_id: string; info: { profile_name: string } }>("session.create", { profile: "nasbot-beta" });
		const sid = created.session_id;
		assert.equal(created.info.profile_name, "nasbot-beta");
		assert.ok(b.core.sessions.get(sid), "the conversation lives on beta under the same id");
		assert.equal(b.core.sessions.get(sid)?.source, `member:${a.core.members.self().id}:owner`, "marked as the owner's relayed chat");
		assert.equal(a.core.sessions.get(sid)?.remote_node, b.core.members.self().id);

		// A turn with an approval: beta asks, alpha's client answers.
		b.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "sudo apt-get install -y cowsay" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("I did not install cowsay. The pool is healthy.")]),
		]);
		let asked = 0;
		vory.onRequest = (method, params) => {
			asked++;
			assert.equal(method, "approval");
			assert.equal(params.session_id, sid);
			assert.match(String(params.description), /on beta/);
			return { choice: "deny" };
		};
		const submitted = await vory.call<{ status: string }>("prompt.submit", { session_id: sid, text: "Install cowsay and check the pool" });
		assert.equal(submitted.status, "streaming");
		await vory.waitEvent("message.start", sid, 10000);
		const done = await vory.waitEvent("message.complete", sid, 20000);
		assert.equal(done.payload.text, "I did not install cowsay. The pool is healthy.");
		assert.ok(vory.eventsOf("message.delta", sid).length > 0, "streamed");
		assert.equal(asked, 1, "beta's approval request reached the client on alpha");
		const tool = vory.eventsOf("tool.complete", sid).find((e) => e.payload.name === "bash");
		assert.match(String(tool?.payload.result_text), /did not approve/);
		assert.equal(a.core.approvals.pendingFor(sid).length, 0);

		// alpha's catalogue knows the chat; its messages come from beta.
		const list = (await (await rest("/api/sessions?profile=nasbot-beta&order=recent")).json()) as { sessions: { id: string; title: string; preview: string }[] };
		assert.equal(list.sessions.length, 1);
		assert.equal(list.sessions[0]!.id, sid);
		assert.match(list.sessions[0]!.title, /Install cowsay/);
		assert.match(list.sessions[0]!.preview, /pool is healthy/);
		const msgs = (await (await rest(`/api/sessions/${sid}/messages?profile=nasbot-beta`)).json()) as { messages: { role: string; text: string }[] };
		assert.deepEqual(
			msgs.messages.filter((m) => m.role !== "tool").map((m) => m.role),
			["user", "assistant", "assistant"].slice(0, msgs.messages.filter((m) => m.role !== "tool").length),
		);
		assert.ok(msgs.messages.some((m) => m.role === "assistant" && /pool is healthy/.test(m.text)));

		// The link to beta drops; the next turn still arrives.
		b.server.dropConnections();
		await new Promise((r) => setTimeout(r, 300));
		b.faux.setResponses([fauxAssistantMessage([fauxText("Still here.")])]);
		await vory.call("prompt.submit", { session_id: sid, text: "still there?" });
		const again = await vory.waitFor((f) => f.method === "event" && (f.params as { type: string; payload: { text?: string } }).type === "message.complete" && (f.params as { payload: { text?: string } }).payload.text === "Still here.", 20000);
		assert.ok(again);

		// Resume from alpha's side shows beta's transcript.
		const resumed = await vory.call<{ messages: unknown[]; info: { profile_name: string } }>("session.resume", { session_id: sid });
		assert.equal(resumed.info.profile_name, "nasbot-beta");
		assert.ok(resumed.messages.length >= 4);

		// Deleting on alpha deletes on beta.
		assert.equal((await rest(`/api/sessions/${sid}`, { method: "DELETE" })).status, 200);
		assert.equal(b.core.db.get<{ deleted: number }>("SELECT deleted FROM sessions WHERE id = ?", sid)?.deleted, 1);

		// beta offline: a new chat with its bot says so.
		await b.server.close();
		await assert.rejects(vory.call("session.create", { profile: "nasbot-beta" }), /beta is offline/);
	} finally {
		await vory?.close();
		await b.server.close();
		await a.server.close();
		await a.core.close();
		await b.core.close();
		await cleanup();
	}
});
