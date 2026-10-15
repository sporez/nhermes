// Federation membership: three gateways join one network through invites (the second joiner is
// introduced to the first), member-only routes check the pair secret, bad codes are refused, and
// removal and leaving reach every member.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import type { Core } from "../../src/app.ts";
import { encodeInvite, NODE_HEADER, SECRET_HEADER } from "../../src/federation/members.ts";
import { federationAdminRoutes } from "../../src/federation/routes.ts";
import { type HermesServer, startHermesServer } from "../../src/hermes/server.ts";
import { fauxModels, TOKEN, tempDir, testConfig, testCore } from "../helpers.ts";

type Gw = { core: Core; server: HermesServer; url: string; admin: (method: string, path: string, body?: unknown) => Promise<Response> };

async function gateway(dir: string, name: string, now?: () => number): Promise<Gw> {
	const d = join(dir, name);
	const core = await testCore(d, { models: fauxModels().models, config: testConfig(d, [{ name: `${name}bot`, default: true }], { node: { name } }), members: now ? { now } : undefined });
	const server = await startHermesServer(core, { host: "127.0.0.1", port: 0, extraRouters: [federationAdminRoutes(core)] });
	const url = `http://127.0.0.1:${server.port}`;
	const admin = (method: string, path: string, body?: unknown) =>
		fetch(`${url}${path}`, { method, headers: { "X-Hermes-Session-Token": TOKEN, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
	return { core, server, url, admin };
}

async function invite(g: Gw): Promise<string> {
	return ((await (await g.admin("POST", "/admin/federation/invite")).json()) as { code: string }).code;
}

const names = (g: Gw) => g.core.members.list().map((m) => m.name);

async function close(...gs: Gw[]) {
	for (const g of gs) {
		await g.server.close();
		await g.core.close();
	}
}

test("joining any member joins the whole network; removal and leaving reach everyone", async () => {
	const { dir, cleanup } = await tempDir();
	const [a, b, c] = [await gateway(dir, "alpha"), await gateway(dir, "beta"), await gateway(dir, "gamma")];
	try {
		assert.equal(a.core.members.self().url, a.url);

		// beta joins through alpha, after previewing the code.
		const code1 = await invite(a);
		const preview = (await (await b.admin("POST", "/admin/federation/preview", { code: code1 })).json()) as { name: string; members: number };
		assert.deepEqual(preview, { name: "alpha", url: a.url, members: 1 });
		const joined = await b.admin("POST", "/admin/federation/join", { code: code1 });
		assert.equal(joined.status, 200, await joined.clone().text());
		assert.deepEqual(names(a), ["beta"]);
		assert.deepEqual(names(b), ["alpha"]);

		// The code is single-use.
		const again = await c.admin("POST", "/admin/federation/join", { code: code1 });
		assert.equal(again.status, 403);
		assert.match(((await again.json()) as { detail: string }).detail, /wrong, expired or already used/);

		// gamma joins through beta and is introduced to alpha.
		assert.equal((await c.admin("POST", "/admin/federation/join", { code: await invite(b) })).status, 200);
		await b.core.members.flush();
		assert.deepEqual(names(c), ["alpha", "beta"]);
		assert.deepEqual(names(a), ["beta", "gamma"]);
		assert.deepEqual(names(b), ["alpha", "gamma"]);

		// Each pair can reach the other with its own secret.
		for (const [from, to] of [[a, c], [c, a], [b, c]] as const) {
			const m = from.core.members.byName(to.core.members.self().name)!;
			assert.deepEqual(await from.core.members.call(m, "/federation/ping", undefined, "GET"), { name: to.core.members.self().name, from: from.core.members.self().name });
		}
		// A wrong secret, or no member headers, is refused; the gateway token does not open member routes.
		const ping = (headers: Record<string, string>) => fetch(`${a.url}/federation/ping`, { headers }).then((r) => r.status);
		assert.equal(await ping({ [NODE_HEADER]: c.core.members.self().id, [SECRET_HEADER]: "wrong-secret-0123456789" }), 401);
		assert.equal(await ping({ "X-Hermes-Session-Token": TOKEN }), 401);
		// ...and a member secret does not open the owner's API.
		const secret = c.core.members.byName("alpha")!.secret;
		assert.equal((await fetch(`${a.url}/api/profiles`, { headers: { [NODE_HEADER]: c.core.members.self().id, [SECRET_HEADER]: secret } })).status, 401);

		// Already in a network: joining another one is refused.
		assert.equal((await c.admin("POST", "/admin/federation/join", { code: await invite(a) })).status, 409);

		// alpha removes gamma: everyone forgets it, and gamma drops its links.
		assert.equal((await a.admin("DELETE", "/admin/members/gamma")).status, 200);
		assert.deepEqual(names(a), ["beta"]);
		assert.deepEqual(names(b), ["alpha"]);
		assert.deepEqual(names(c), []);

		// beta leaves.
		assert.equal((await b.admin("POST", "/admin/federation/leave")).status, 200);
		assert.deepEqual(names(a), []);
		assert.deepEqual(names(b), []);
	} finally {
		await close(a, b, c);
		await cleanup();
	}
});

test("expired codes, name clashes and an offline member during an introduction", async () => {
	const { dir, cleanup } = await tempDir();
	let clock = Date.now();
	const a = await gateway(dir, "alpha", () => clock);
	const b = await gateway(dir, "beta");
	const twin = await gateway(join(dir, "other"), "beta");
	const c = await gateway(dir, "gamma");
	try {
		const old = await invite(a);
		clock += 11 * 60_000;
		assert.equal((await b.admin("POST", "/admin/federation/join", { code: old })).status, 403);
		assert.equal((await b.admin("POST", "/admin/federation/join", { code: "hello" })).status, 400);
		assert.equal((await b.admin("POST", "/admin/federation/join", { code: encodeInvite({ url: a.url, secret: "guess" }) })).status, 403);

		assert.equal((await b.admin("POST", "/admin/federation/join", { code: await invite(a) })).status, 200);
		const clash = await twin.admin("POST", "/admin/federation/join", { code: await invite(a) });
		assert.equal(clash.status, 409);
		assert.match(((await clash.json()) as { detail: string }).detail, /already named "beta"/);

		// beta is offline when gamma joins: alpha keeps the introduction and delivers it later.
		await b.server.close();
		assert.equal((await c.admin("POST", "/admin/federation/join", { code: await invite(a) })).status, 200);
		await a.core.members.flush();
		assert.deepEqual(names(b), ["alpha"]);
		assert.equal(a.core.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM member_outbox")!.n, 1);
		b.server = await startHermesServer(b.core, { host: "127.0.0.1", port: Number(new URL(b.url).port), extraRouters: [federationAdminRoutes(b.core)] });
		await a.core.members.flush();
		assert.deepEqual(names(b), ["alpha", "gamma"]);
		assert.equal(a.core.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM member_outbox")!.n, 0);
	} finally {
		await close(a, b, twin, c);
		await cleanup();
	}
});

test("a key set in one panel can go to other machines that accept keys", async () => {
	const { dir, cleanup } = await tempDir();
	const [a, b, c] = [await gateway(dir, "alpha"), await gateway(dir, "beta"), await gateway(dir, "gamma")];
	const panel = (g: Gw, method: string, path: string, body?: unknown) =>
		fetch(`${g.url}/panel/api${path}`, { method, headers: { "content-type": "application/json", "x-nhermes-panel": "1" }, body: JSON.stringify(body ?? {}) });
	try {
		await b.core.members.join((await (await a.admin("POST", "/admin/federation/invite")).json() as { code: string }).code);
		await c.core.members.join((await (await a.admin("POST", "/admin/federation/invite")).json() as { code: string }).code);
		await a.core.members.flush();
		// beta accepts keys from members; gamma does not.
		assert.equal((await panel(b, "PATCH", "/network/settings", { acceptSecrets: true })).status, 200);
		const r = await panel(a, "PUT", "/secrets/SHARED_TEST_KEY", { value: "shared-value-0123456789", alsoOn: ["beta", "gamma"] });
		assert.equal(r.status, 200);
		const body = (await r.json()) as { members: { name: string; ok: boolean; error?: string }[] };
		assert.deepEqual(body.members.map((m) => [m.name, m.ok]), [["beta", true], ["gamma", false]]);
		assert.match(body.members[1]!.error!, /does not accept keys/);
		assert.ok(b.core.secrets.list().some((s) => s.name === "SHARED_TEST_KEY" && s.set));
		assert.equal(c.core.secrets.list().some((s) => s.name === "SHARED_TEST_KEY"), false);
		// The gateway token never travels.
		assert.equal((await panel(a, "PUT", "/secrets/NHERMES_TOKEN", { value: "x".repeat(24), alsoOn: ["beta"] })).status, 400);
	} finally {
		delete process.env.SHARED_TEST_KEY;
		await close(a, b, c);
		await cleanup();
	}
});
