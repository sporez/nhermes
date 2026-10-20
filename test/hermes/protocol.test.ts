// Hermes wire protocol against the real server: auth, handshake, streaming order, reconnection
// mid-answer, approvals as server→client requests, fan-out, REST shapes.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import type { Core } from "../../src/app.ts";
import { registerSecret } from "../../src/log.ts";
import { type HermesServer, startHermesServer } from "../../src/hermes/server.ts";
import { TOKEN, tempDir, testCore } from "../helpers.ts";
import { type Ev, HermesClient } from "./client.ts";

const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1", reasoning: true }, { id: "faux-2" }], tokensPerSecond: 400 });
const models = createModels();
models.setProvider(faux.provider);
let core: Core;
let server: HermesServer;
let cleanup: () => Promise<void>;

before(async () => {
	const t = await tempDir();
	cleanup = t.cleanup;
	core = await testCore(t.dir, { models });
	server = await startHermesServer(core, { host: "127.0.0.1", port: 0 });
});

after(async () => {
	await server.close();
	await core.close();
	await cleanup();
});

const base = () => `http://127.0.0.1:${server.port}`;
const get = (path: string, token: string | null = TOKEN) => fetch(base() + path, { headers: token ? { "X-Hermes-Session-Token": token } : {} });

async function ready(): Promise<HermesClient> {
	const c = await HermesClient.connect(server.port, TOKEN);
	await c.waitEvent("gateway.ready");
	return c;
}

test("auth: public status, 401 without token, WS close 4401 with a wrong token", async () => {
	const status = await (await get("/api/status", null)).json();
	assert.equal(status.auth_required, false);
	assert.equal(typeof status.version, "string");
	assert.equal((await get("/api/profiles", null)).status, 401);
	assert.equal((await get("/api/profiles", "wrong-token-wrong-token")).status, 401);
	assert.equal((await get("/api/profiles")).status, 200);
	const bad = await HermesClient.connect(server.port, "nope-nope-nope-nope");
	await new Promise((r) => bad.ws.once("close", r));
	assert.equal(bad.closeCode, 4401);
});

test("handshake: gateway.ready first, ping, capabilities", async () => {
	const c = await HermesClient.connect(server.port, TOKEN);
	const first = await c.waitFor(() => true);
	assert.equal(first.method, "event");
	assert.equal((first.params as Ev).type, "gateway.ready");
	assert.deepEqual(await c.call("ping"), { pong: true });
	assert.deepEqual(await c.call("client.capabilities", { server_requests: true }), { server_requests: ["approval"] });
	const err = await c.call("projects.list").catch((e: { code: number }) => e);
	assert.equal((err as { code: number }).code, -32601);
	await c.close();
});

test("a turn streams message.start → deltas → message.complete in order, and REST lists it", async () => {
	const c = await ready();
	const created = await c.call<{ session_id: string; stored_session_id: string; info: Record<string, unknown> }>("session.create", { cols: 80 });
	const sid = created.session_id;
	assert.equal(created.stored_session_id, sid);
	assert.equal(created.info.profile_name, "main");
	faux.setResponses([fauxAssistantMessage([fauxText("Hello Neil, the gateway is working.")])]);
	const r = await c.call<{ status: string }>("prompt.submit", { session_id: sid, text: "vory-e2e say hello" });
	assert.equal(r.status, "streaming");
	const complete = await c.waitEvent("message.complete", sid);
	const types = c.events.filter((e) => e.session_id === sid).map((e) => e.type);
	const iStart = types.indexOf("message.start");
	const iDelta = types.indexOf("message.delta");
	assert.ok(iStart >= 0 && iStart < iDelta && iDelta < types.indexOf("message.complete"), types.join(","));
	const streamed = c.eventsOf("message.delta", sid).map((e) => e.payload.text).join("");
	assert.equal(streamed, "Hello Neil, the gateway is working.");
	assert.equal(complete.payload.text, streamed);
	assert.equal(complete.payload.status, "complete");
	assert.ok((complete.payload.usage as { output: number }).output > 0);
	await c.waitEvent("session.title", sid);

	const list = await (await get("/api/sessions?order=recent&limit=8")).json();
	const row = list.sessions.find((s: { id: string }) => s.id === sid);
	assert.equal(row.title, "vory-e2e say hello");
	assert.equal(row.profile, "main");
	assert.equal(row.message_count, 2);
	assert.equal((await get(`/api/sessions/${sid}?profile=ops`)).status, 404);
	assert.equal((await get(`/api/sessions/${sid}?profile=main`)).status, 200);
	const msgs = await (await get(`/api/sessions/${sid}/messages?order=latest&limit=60&profile=main`)).json();
	assert.deepEqual(msgs.messages.map((m: { role: string }) => m.role), ["user", "assistant"]);
	const usage = await c.call<{ calls: number; context_max: number }>("session.usage", { session_id: sid });
	assert.ok(usage.calls >= 1);
	await c.close();
});

test("reconnecting mid-answer: resume returns the inflight partial, then the rest streams", async () => {
	const c1 = await ready();
	const { session_id: sid } = await c1.call<{ session_id: string }>("session.create", {});
	const long = "word ".repeat(400).trim();
	faux.setResponses([fauxAssistantMessage([fauxText(long)])]);
	await c1.call("prompt.submit", { session_id: sid, text: "tell me a long story" });
	await c1.waitEvent("message.delta", sid);
	await c1.close(); // the phone goes away mid-answer

	const c2 = await ready();
	const snap = await c2.call<{ running: boolean; inflight: { user: string; assistant: string; streaming: boolean } | null; messages: { role: string }[] }>("session.resume", { session_id: sid });
	assert.equal(snap.running, true);
	assert.equal(snap.inflight?.user, "tell me a long story");
	assert.ok(long.startsWith(snap.inflight!.assistant), "partial is a prefix of the answer");
	const done = await c2.waitEvent("message.complete", sid, 15000);
	const after = c2.eventsOf("message.delta", sid).map((e) => e.payload.text).join("");
	assert.equal(snap.inflight!.assistant + after, long, "snapshot partial + later deltas = the whole answer");
	assert.equal(done.payload.text, long);
	await c2.close();
});

test("approvals: a dangerous call becomes a server request; the answer is enforced", async () => {
	const c = await ready();
	await c.call("client.capabilities", { server_requests: true });
	const { session_id: sid } = await c.call<{ session_id: string }>("session.create", {});
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("bash", { command: "rm -rf ./tmpdir; echo cleaned" })], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxText("Done cleaning.")]),
	]);
	await c.call("prompt.submit", { session_id: sid, text: "clean tmpdir" });
	const req = await c.waitFor((f) => typeof f.id === "string" && f.method === "approval");
	assert.equal((req.params as { session_id: string }).session_id, sid);
	assert.equal((req.params as { pattern_key: string }).pattern_key, "rm -rf");
	const pending = await c.call<{ approvals: { request_id: string }[] }>("approval.pending", { session_id: sid });
	assert.equal(pending.approvals.length, 1);
	// A second device resuming now sees the open request.
	const watcher = await ready();
	const snap = await watcher.call<{ open_requests: { id: string; method: string }[] }>("session.resume", { session_id: sid });
	assert.equal(snap.open_requests[0]?.id, req.id);
	c.respond(req.id as string, { choice: "once" });
	const tool = await c.waitEvent("tool.complete", sid);
	assert.match(String(tool.payload.result_text), /cleaned/);
	await c.waitEvent("message.complete", sid);
	await watcher.waitEvent("message.complete", sid);
	assert.equal((await c.call<{ approvals: unknown[] }>("approval.pending", { session_id: sid })).approvals.length, 0);
	assert.equal(watcher.eventsOf("request.cancel").length, 0, "answered elsewhere is not a withdrawal");
	await c.close();
	await watcher.close();
});

test("live events and approval cards never carry a registered secret", async () => {
	const secret = "live-secret-\"quoted\"-value-9f3a";
	registerSecret(secret);
	const c = await ready();
	await c.call("client.capabilities", { server_requests: true });
	const { session_id: sid } = await c.call<{ session_id: string }>("session.create", {});
	faux.setResponses([
		fauxAssistantMessage([fauxThinking(`thinking about ${secret}`), fauxToolCall("bash", { command: `echo '${secret}'; rm -rf ./tmpdir` })], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxText("done")]),
	]);
	await c.call("prompt.submit", { session_id: sid, text: "go" });
	const req = await c.waitFor((f) => typeof f.id === "string" && f.method === "approval");
	assert.ok(!JSON.stringify(req).includes("live-secret"), "approval card is redacted");
	assert.match(String((req.params as { command: string }).command), /\[redacted\]/);
	const watcher = await ready();
	const snap = await watcher.call("session.resume", { session_id: sid });
	assert.ok(!JSON.stringify(snap).includes("live-secret"), "resume snapshot is redacted");
	c.respond(req.id as string, { choice: "once" });
	await c.waitEvent("message.complete", sid);
	for (const f of c.frames) assert.ok(!JSON.stringify(f).includes("live-secret"), JSON.stringify(f));
	const audit = core.db.all<{ detail: string }>("SELECT detail FROM audit WHERE session_id = ?", sid);
	assert.ok(audit.length > 0);
	for (const a of audit) assert.ok(!a.detail.includes("live-secret"), "stored audit text is redacted");
	await c.close();
	await watcher.close();
});

test("interrupt withdraws a pending approval and ends the turn as interrupted", async () => {
	const c = await ready();
	await c.call("client.capabilities", { server_requests: true });
	const { session_id: sid } = await c.call<{ session_id: string }>("session.create", {});
	faux.setResponses([fauxAssistantMessage([fauxToolCall("bash", { command: "mkfs.ext4 /dev/sdz" })], { stopReason: "toolUse" }), fauxAssistantMessage([fauxText("ok")])]);
	await c.call("prompt.submit", { session_id: sid, text: "format it" });
	const req = await c.waitFor((f) => typeof f.id === "string" && f.method === "approval");
	const r = await c.call<{ interrupted: boolean }>("session.interrupt", { session_id: sid });
	assert.equal(r.interrupted, true);
	const cancel = await c.waitEvent("request.cancel", sid);
	assert.equal(cancel.payload.id, req.id);
	const done = await c.waitEvent("message.complete", sid);
	assert.equal(done.payload.status, "interrupted");
	await c.close();
});

test("model switch and reasoning effort are session-scoped", async () => {
	const c = await ready();
	const { session_id: sid } = await c.call<{ session_id: string }>("session.create", {});
	const r = await c.call<{ info: { model: string; provider: string } }>("config.set", { key: "model", value: "faux-2 --provider faux --session", session_id: sid });
	assert.equal(r.info.model, "faux-2");
	const e = await c.call<{ info: { reasoning_effort: string } }>("config.set", { key: "reasoning", value: "low", session_id: sid, scope: "session" });
	assert.equal(e.info.reasoning_effort, "low");
	const bad = await c.call("config.set", { key: "model", value: "nope --provider faux --session", session_id: sid }).catch((x: Error) => x);
	assert.ok(bad instanceof Error);
	const opts = await (await get("/api/model/options")).json();
	assert.ok(opts.providers.some((p: { slug: string; models: string[] }) => p.slug === "faux" && p.models.includes("faux-2")));
	await c.close();
});

test("REST surface Vory's E2E checks answers with real values", async () => {
	const profiles = await (await get("/api/profiles")).json();
	assert.deepEqual(profiles.profiles.map((p: { name: string }) => p.name), ["main", "ops"]);
	assert.equal(profiles.profiles[0].is_default, true);
	const schema = await (await get("/api/config/schema")).json();
	assert.equal(schema.fields["approvals.mode"].type, "select");
	const toolsets = await (await get("/api/tools/toolsets")).json();
	assert.ok(toolsets.some((t: { name: string; enabled: boolean }) => t.name === "shell" && t.enabled));
	const env = await (await get("/api/env")).json();
	assert.equal(env.NHERMES_TOKEN.is_set, false); // tests pass the token in code, not the environment
	assert.equal((await get("/api/kanban/whatever")).status, 404);
	const soul = await (await get("/api/profiles/main/soul")).json();
	assert.equal(soul.content, "You are the main test bot.");
});
