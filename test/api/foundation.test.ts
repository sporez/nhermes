// The client API's plumbing: Bearer auth on HTTP and the socket, hello, the error object, and the same
// operation over both transports. The Hermes API keeps answering beside it.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Core } from "../../src/app.ts";
import type { MemberRow } from "../../src/federation/members.ts";
import { type GatewayServer, startServer } from "../../src/server.ts";
import { fauxModels, TOKEN, tempDir, testCore } from "../helpers.ts";
import { ApiCallError, ApiSocketClient, http } from "./client.ts";

let core: Core;
let server: GatewayServer;
let cleanup: () => Promise<void>;

before(async () => {
	const t = await tempDir();
	cleanup = t.cleanup;
	core = await testCore(t.dir, { models: fauxModels().models });
	server = await startServer(core, { host: "127.0.0.1", port: 0, federationPort: null });
});

after(async () => {
	await server.close();
	await core.close();
	await cleanup();
});

const refused = (p: Promise<unknown>) => p.then(() => assert.fail("expected an error"), (e: unknown) => e as ApiCallError);

test("auth: Bearer only; no token, a wrong one or the Hermes header gets 401 unauthorized", async () => {
	for (const token of [null, "wrong-token-wrong-token"]) {
		const e = await refused(http(server.port, token)("GET /"));
		assert.equal(e.status, 401);
		assert.equal(e.code, "unauthorized");
	}
	const hermes = await fetch(`http://127.0.0.1:${server.port}/api/v1`, { headers: { "X-Hermes-Session-Token": TOKEN } });
	assert.equal(hermes.status, 401);
	const bad = await ApiSocketClient.connect(server.port, "nope-nope-nope-nope");
	await new Promise((r) => bad.ws.once("close", r));
	assert.equal(bad.closeCode, 4401);
	// A token in the URL is not accepted on the new socket.
	const query = await ApiSocketClient.connect(server.port, null);
	await new Promise((r) => query.ws.once("close", r));
	assert.equal(query.closeCode, 4401);
});

test("hello: over HTTP and as the socket's first frame, with version, features and limits", async () => {
	const h = await http(server.port)<{ api: number; gateway: { id: string; name: string; version: string }; bootId: string; features: string[]; limits: Record<string, number>; caller: { kind: string } }>("GET /");
	assert.equal(h.api, 1);
	assert.equal(typeof h.gateway.id, "string");
	assert.equal(typeof h.gateway.version, "string");
	assert.ok(Array.isArray(h.features));
	assert.equal(typeof h.limits.toolResultChars, "number");
	assert.deepEqual(h.caller, { kind: "owner" });
	const c = await ApiSocketClient.connect(server.port);
	const first = await c.waitEvent(() => true);
	assert.equal(first.event, "hello");
	assert.equal(typeof first.at, "number");
	assert.equal((first.data as { bootId: string }).bootId, h.bootId);
	await c.close();
});

test("the same operation answers over HTTP and the socket", async () => {
	const c = await ApiSocketClient.connect(server.port);
	const viaSocket = await c.call<{ pong: boolean }>("ping");
	const viaHttp = await http(server.port)<{ pong: boolean }>("GET /ping");
	assert.equal(viaSocket.pong, true);
	assert.equal(viaHttp.pong, true);
	await c.close();
});

test("errors: unknown operation, nothing at a path, wrong method, a malformed frame", async () => {
	const c = await ApiSocketClient.connect(server.port);
	assert.equal((await refused(c.call("projects.list"))).code, "unknown_op");
	const missing = await refused(http(server.port)("GET /nothing-here"));
	assert.equal(missing.status, 404);
	assert.equal(missing.code, "not_found");
	const wrong = await refused(http(server.port)("DELETE /ping"));
	assert.equal(wrong.status, 405);
	assert.equal(wrong.code, "method_not_allowed");
	c.sendRaw("not json");
	await new Promise<void>((resolve) => {
		c.ws.once("message", (d) => {
			const f = JSON.parse(d.toString()) as { id: unknown; error: { code: string } };
			assert.equal(f.id, null);
			assert.equal(f.error.code, "invalid_params");
			resolve();
		});
	});
	await c.close();
});

test("a network member may call only operations marked for members", async () => {
	const member = { node_id: "node-b", name: "b" } as MemberRow;
	const cx = { core, caller: { kind: "member" as const, member } };
	const hello = server.api.ops.get("gateway.hello")!;
	assert.equal(((await server.api.ops.call(hello, {}, cx)) as { caller: { kind: string } }).caller.kind, "member");
	const ownerOnly = { name: "test.ownerOnly", handle: () => ({ ok: true }) };
	const e = await refused(server.api.ops.call(ownerOnly, {}, cx));
	assert.equal(e.code, "unknown_op");
});

test("the Hermes API answers beside it", async () => {
	const status = await (await fetch(`http://127.0.0.1:${server.port}/api/status`)).json();
	assert.equal(typeof (status as { version: string }).version, "string");
	assert.equal((await fetch(`http://127.0.0.1:${server.port}/api/health`)).status, 200);
});
