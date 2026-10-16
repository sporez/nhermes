// Encrypted links between members (TLS-PSK keyed by the pair secret, src/federation/psk.ts): joining is
// encrypted with the invite's key, a member that has reached us encrypted can no longer use plain HTTP,
// pair secrets are replaced over the encrypted link (the old one opens nothing after its grace period),
// an older gateway without an encrypted port still works in the clear, and the encrypted port moves up
// when its default is taken.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import type { Core } from "../../src/app.ts";
import { decodeInvite, NODE_HEADER, SECRET_HEADER } from "../../src/federation/members.ts";
import { clientTls, pairKey, pskRequest } from "../../src/federation/psk.ts";
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

const plainPing = (to: Gw, from: Gw, secret: string) => fetch(`${to.url}/federation/ping`, { headers: { [NODE_HEADER]: from.core.members.self().id, [SECRET_HEADER]: secret } }).then((r) => r.status);

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

test("joining is encrypted, and a member that reached us encrypted is refused in the clear", async () => {
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

		// Calls go encrypted; after that, the same member's plain requests are refused.
		assert.deepEqual(await b.core.members.call(alpha, "/federation/ping", undefined, "GET"), { name: "alpha", from: "beta" });
		assert.equal(a.core.members.byName("beta")!.psk_inbound, 1);
		assert.equal(await plainPing(a, b, alpha.secret), 403);

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
		// The lower node id replaces it on its maintenance tick; the other side never does.
		const [low, high] = a.core.members.self().id < b.core.members.self().id ? [a, b] : [b, a];
		await high.core.members.maintain();
		assert.equal(a.core.members.byName("beta")!.secret, before, "the higher id waits");
		await low.core.members.maintain();
		const after = a.core.members.byName("beta")!.secret;
		assert.notEqual(after, before);
		assert.equal(b.core.members.byName("alpha")!.secret, after, "both sides hold the new secret");
		assert.equal(a.core.members.byName("beta")!.rotated, 1);
		assert.equal(b.core.members.byName("alpha")!.rotated, 1);
		await low.core.members.maintain();
		assert.equal(a.core.members.byName("beta")!.secret, after, "replaced once");

		// The old secret still opens the encrypted port for a while, then nothing.
		const old = { ...b.core.members.byName("alpha")!, secret: before };
		assert.deepEqual(await b.core.members.call(old, "/federation/ping", undefined, "GET"), { name: "alpha", from: "beta" });
		clock += 11 * 60_000;
		await assert.rejects(b.core.members.call(old, "/federation/ping", undefined, "GET"), /no longer accepts this machine/);
		assert.deepEqual(await b.core.members.call(b.core.members.byName("alpha")!, "/federation/ping", undefined, "GET"), { name: "alpha", from: "beta" });

		// The panel's "Regenerate key" does the same on demand, from either side.
		await high.core.members.rotate(high === a ? "beta" : "alpha");
		assert.notEqual(a.core.members.byName("beta")!.secret, after);
		assert.equal(a.core.members.byName("beta")!.secret, b.core.members.byName("alpha")!.secret);

		// A new secret is never accepted in the clear.
		const plain = await fetch(`${a.url}/federation/rotate`, { method: "POST", headers: { [NODE_HEADER]: b.core.members.self().id, [SECRET_HEADER]: a.core.members.byName("beta")!.secret, "content-type": "application/json" }, body: JSON.stringify({ secret: "x".repeat(32) }) });
		assert.equal(plain.status, 403);
	} finally {
		await close(a, b);
		await cleanup();
	}
});

test("an older gateway without an encrypted port still joins and talks in the clear; the owner can refuse that", async () => {
	const { dir, cleanup } = await tempDir();
	const old = await gateway(dir, "old", { federationPort: null });
	const b = await gateway(dir, "beta");
	try {
		const { code } = old.core.members.invite();
		assert.equal(decodeInvite(code).pskPort, undefined);
		await b.core.members.join(code);
		// An older version would not know about beta's encrypted port either (its first roster sync, which
		// runs in the background after the join, used it).
		await old.core.roster.sync();
		await new Promise((r) => setTimeout(r, 200));
		old.core.db.run("UPDATE members SET psk_port = NULL");
		b.core.db.run("UPDATE members SET psk_inbound = 0");
		const m = b.core.members.byName("old")!;
		assert.equal(m.psk_port, null);
		assert.deepEqual(b.core.members.list().map((x) => x.encrypted), [false]);
		assert.deepEqual(await b.core.members.call(m, "/federation/ping", undefined, "GET"), { name: "old", from: "beta" });
		const secret = old.core.members.byName("beta")!.secret;
		assert.equal(await plainPing(b, old, secret), 200);
		// beta looks for an encrypted port and finds none (an older version answers no /federation/moved,
		// so this comes last: here it would teach "old" beta's port).
		await b.core.members.maintain();
		assert.equal(b.core.members.byName("old")!.psk_port, null, "nothing to upgrade to");
		assert.equal(b.core.members.byName("old")!.rotated, 0);

		// beta's owner refuses plain requests from every member.
		b.core.db.run("UPDATE members SET psk_inbound = 0");
		b.core.members.setRequiresPsk(true);
		assert.equal(await plainPing(b, old, secret), 403);
	} finally {
		await close(old, b);
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
