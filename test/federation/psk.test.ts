// Encrypted links between members (TLS-PSK keyed by the pair secret, src/federation/psk.ts): joining is
// encrypted with the invite's key, the main port serves no member routes at all, pair secrets are replaced
// over the encrypted link (the old one opens nothing after its grace period), a machine without an
// encrypted port cannot join or be introduced, and the encrypted port moves up when its default is taken.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import type { Core } from "../../src/app.ts";
import * as membersModule from "../../src/federation/members.ts";
import { clientTls, inviteId, inviteKey, pairKey, pskRequest } from "../../src/federation/psk.ts";
import { federationAdminRoutes } from "../../src/federation/routes.ts";
import { type HermesServer, startHermesServer } from "../../src/hermes/server.ts";
import { fauxModels, tempDir, testConfig, testCore } from "../helpers.ts";

type Gw = { core: Core; server: HermesServer; url: string };

async function gateway(dir: string, name: string, opts: { now?: () => number; port?: number; federationPort?: number | null } = {}): Promise<Gw> {
	const d = join(dir, name);
	const core = await testCore(d, { models: fauxModels().models, config: testConfig(d, [{ name: `${name}bot`, default: true }], { node: { name } }), members: opts.now ? { now: opts.now } : undefined });
	const server = await startHermesServer(core, { host: "127.0.0.1", port: opts.port ?? 0, federationPort: opts.federationPort, extraRouters: [federationAdminRoutes(core)] }).catch(async (error: unknown) => {
		await core.close();
		throw error;
	});
	return { core, server, url: `http://127.0.0.1:${server.port}` };
}

async function close(...gs: Gw[]) {
	for (const g of gs) {
		await g.server.close();
		await g.core.close();
	}
}

const { decodeInvite } = membersModule;

/** A free TCP port, and a server holding another one. */
async function freePort(): Promise<number> {
	const s = createServer();
	await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
	const port = (s.address() as { port: number }).port;
	await new Promise<void>((r) => s.close(() => r()));
	return port;
}
async function hold(port: number): Promise<Server> {
	const s = createServer();
	await new Promise<void>((r) => s.listen(port, "127.0.0.1", () => r()));
	return s;
}

test("joining is encrypted, and the main port serves no member routes", async () => {
	const { dir, cleanup } = await tempDir();
	const [a, b] = [await gateway(dir, "alpha"), await gateway(dir, "beta")];
	try {
		const { code } = a.core.members.invite();
		assert.equal(decodeInvite(code).pskPort, a.server.pskPort, "the code carries the encrypted port");
		await b.core.members.join(code);
		const alpha = b.core.members.byName("alpha")!;
		const beta = a.core.members.byName("beta")!;
		assert.equal(alpha.psk_port, a.server.pskPort);
		assert.equal(beta.psk_port, b.server.pskPort, "the joiner told the inviter its encrypted port");
		assert.deepEqual(b.core.members.list().map((m) => m.encrypted), [true]);

		// Calls go encrypted; the same member's headers on the main port open nothing (the header login is gone).
		assert.deepEqual(await b.core.members.call(alpha, "/federation/ping", undefined, "GET"), { name: "alpha", from: "beta" });
		assert.equal("NODE_HEADER" in membersModule || "SECRET_HEADER" in membersModule, false);
		const headers = { "x-nhermes-node": b.core.members.self().id, "x-nhermes-member-secret": alpha.secret };
		assert.equal((await fetch(`${a.url}/federation/ping`, { headers })).status, 404);
		assert.equal((await fetch(`${a.url}/federation/hello`)).status, 404);

		// The encrypted port serves members only: no panel, no owner API, no unknown key.
		const tls = clientTls(`m:${b.core.members.self().id}:${"0".repeat(12)}`, Buffer.alloc(32));
		await assert.rejects(pskRequest(`https://127.0.0.1:${a.server.pskPort}`, tls, "GET", "/federation/ping", undefined, 5000), /unknown psk identity/);
		const good = clientTls(`m:${b.core.members.self().id}:${(await import("../../src/federation/psk.ts")).keyId(alpha.secret)}`, pairKey(alpha.secret));
		assert.equal((await pskRequest(`https://127.0.0.1:${a.server.pskPort}`, good, "GET", "/api/profiles", undefined, 5000)).status, 404);
		assert.equal((await pskRequest(`https://127.0.0.1:${a.server.pskPort}`, good, "GET", "/panel/api/state", undefined, 5000)).status, 404);

		// A spent code is refused in the handshake, and said so plainly.
		const c = await gateway(dir, "gamma");
		try {
			await assert.rejects(c.core.members.join(code), /wrong, expired or already used/);
		} finally {
			await close(c);
		}
	} finally {
		await close(a, b);
		await cleanup();
	}
});

test("pair secrets are replaced over the encrypted link; the old one stops working after its grace", async () => {
	const { dir, cleanup } = await tempDir();
	let clock = Date.now();
	const now = () => clock;
	const [a, b] = [await gateway(dir, "alpha", { now }), await gateway(dir, "beta", { now })];
	try {
		await b.core.members.join(a.core.members.invite().code);
		const before = a.core.members.byName("beta")!.secret;
		// Nothing replaces it on its own; the panel's "Regenerate key" does, from either side.
		await a.core.members.maintain();
		await b.core.members.maintain();
		assert.equal(a.core.members.byName("beta")!.secret, before);
		assert.equal(a.core.members.byName("beta")!.rotated, 0);
		await a.core.members.rotate("beta");
		const after = a.core.members.byName("beta")!.secret;
		assert.notEqual(after, before);
		assert.equal(b.core.members.byName("alpha")!.secret, after, "both sides hold the new secret");
		assert.equal(a.core.members.byName("beta")!.rotated, 1);
		assert.equal(b.core.members.byName("alpha")!.rotated, 1);
		await a.core.members.maintain();
		assert.equal(a.core.members.byName("beta")!.secret, after, "replaced once");

		// The old secret still opens the encrypted port for a while, then nothing.
		const old = { ...b.core.members.byName("alpha")!, secret: before };
		assert.deepEqual(await b.core.members.call(old, "/federation/ping", undefined, "GET"), { name: "alpha", from: "beta" });
		clock += 11 * 60_000;
		await assert.rejects(b.core.members.call(old, "/federation/ping", undefined, "GET"), /no longer accepts this machine/);
		assert.deepEqual(await b.core.members.call(b.core.members.byName("alpha")!, "/federation/ping", undefined, "GET"), { name: "alpha", from: "beta" });

		// The panel's "Regenerate key" does the same on demand, from either side.
		await b.core.members.rotate("alpha");
		assert.notEqual(a.core.members.byName("beta")!.secret, after);
		assert.equal(a.core.members.byName("beta")!.secret, b.core.members.byName("alpha")!.secret);

		// A new secret is never accepted on the main port.
		const plain = await fetch(`${a.url}/federation/rotate`, { method: "POST", headers: { "x-nhermes-node": b.core.members.self().id, "x-nhermes-member-secret": a.core.members.byName("beta")!.secret, "content-type": "application/json" }, body: JSON.stringify({ secret: "x".repeat(32) }) });
		assert.equal(plain.status, 404);
	} finally {
		await close(a, b);
		await cleanup();
	}
});

test("a machine without an encrypted port cannot join or be introduced", async () => {
	const { dir, cleanup } = await tempDir();
	const old = await gateway(dir, "old", { federationPort: null });
	const [a, b] = [await gateway(dir, "alpha"), await gateway(dir, "beta")];
	// A server that records whether anything reaches it, standing in for a machine of an older version.
	let connections = 0;
	const listener = createServer((socket) => (connections++, socket.destroy()));
	await new Promise<void>((r) => listener.listen(0, "127.0.0.1", () => r()));
	try {
		// A code without the encrypted port is refused before any request is sent.
		const noPort = decodeInvite(old.core.members.invite().code);
		assert.equal(noPort.pskPort, undefined);
		const code = membersModule.encodeInvite({ url: `http://127.0.0.1:${(listener.address() as { port: number }).port}`, secret: noPort.secret });
		await assert.rejects(b.core.members.join(code), /older version of nHermes; update that machine and make a new code/);
		await assert.rejects(b.core.members.preview(code), /older version of nHermes/);
		assert.equal(connections, 0, "no request was made");
		assert.deepEqual(b.core.members.list(), []);

		// A joiner that reports no encrypted port is refused, and the code stays usable.
		const invite = decodeInvite(a.core.members.invite().code);
		const h = createHash("sha256").update(invite.secret).digest("hex");
		const join = (extra: Record<string, unknown>) =>
			pskRequest(`https://127.0.0.1:${a.server.pskPort}`, clientTls(`i:${inviteId(h)}`, inviteKey(h)), "POST", "/federation/join", { invite: invite.secret, node_id: "11111111-2222-3333-4444-555555555555", name: "delta", url: "http://192.0.2.7:8642", ...extra }, 5000);
		assert.equal((await join({})).status, 400);
		assert.equal((await join({ psk_port: "9999" })).status, 400);
		assert.deepEqual(a.core.members.list(), []);

		// A member cannot introduce a newcomer without an encrypted port either.
		await b.core.members.join(a.core.members.invite().code);
		const beta = b.core.members.byName("alpha")!;
		const newcomer = { node_id: "66666666-7777-8888-9999-000000000000", name: "gamma", url: "http://192.0.2.8:8642", secret: "s".repeat(32) };
		await assert.rejects(b.core.members.call(beta, "/federation/introduce", newcomer), /no encrypted port/);
		assert.deepEqual(a.core.members.list().map((m) => m.name), ["beta"]);
		await b.core.members.call(beta, "/federation/introduce", { ...newcomer, psk_port: 9999 });
		assert.deepEqual(a.core.members.list().map((m) => m.name), ["beta", "gamma"]);

		// A row without an encrypted port (from an older version) cannot be reached, and says what to do.
		a.core.db.run("UPDATE members SET psk_port = NULL WHERE name = 'gamma'");
		await assert.rejects(a.core.members.call(a.core.members.byName("gamma")!, "/federation/ping", undefined, "GET"), /gamma has no encrypted link; remove it and join it again/);
		assert.throws(() => a.core.members.target(a.core.members.byName("gamma")!.node_id), /remove it and join it again/);
	} finally {
		listener.close();
		await close(old, a, b);
		await cleanup();
	}
});

test("the encrypted port is main + 1000, or the next free one; a configured port is used as given", async () => {
	const { dir, cleanup } = await tempDir();
	const main = await freePort();
	const blocker = await hold(main + 1000);
	let g: Gw | undefined;
	try {
		g = await gateway(dir, "alpha", { port: main });
		assert.equal(g.server.pskPort, main + 1001);
		assert.equal(g.core.members.hello().psk_port, main + 1001);
		await close(g);
		g = undefined;
		await assert.rejects(gateway(dir, "beta", { port: main, federationPort: main + 1000 }), /EADDRINUSE/);
	} finally {
		if (g) await close(g);
		blocker.close();
		await cleanup();
	}
});
