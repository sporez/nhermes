// Signing a member's machine in to a model provider from another panel: refused until that machine allows
// it, then the flow runs on the owning machine (codes and prompts travel, the credential never does); a
// replaced pair key cannot use it, the main port serves no member routes, and an unreachable member is a
// clean error. Also the switch in Network and the admin API's forwarding for `nhermes auth --machine`.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { AuthInteraction, Models } from "@earendil-works/pi-ai";
import { adminRoutes } from "../../src/admin.ts";
import { createCore, type Core } from "../../src/app.ts";
import { loadConfig } from "../../src/config.ts";
import { type GatewayServer, startServer } from "../../src/server.ts";
import { setLogLevel, setLogSink } from "../../src/log.ts";
import { fauxModels, TOKEN, tempDir } from "../helpers.ts";

type Gw = { core: Core; server: GatewayServer; url: string; saved: string[] };
type Res = { status: number; json: Record<string, unknown> & { detail?: string } };

const lines: string[] = [];
beforeEach(() => {
	lines.length = 0;
	setLogLevel("info");
	setLogSink((l) => void lines.push(l));
});
afterEach(() => {
	setLogLevel("error");
	setLogSink((l) => process.stderr.write(l + "\n"));
});

const SECRET = "sk-remote-secret-0123456789";
const oauth = { name: "xAI", loginLabel: "Sign in to xAI", isSubscription: true, login: async () => ({}), refresh: async () => ({}), toAuth: async () => ({}) };

/** Real faux Models with one OAuth provider whose login shows a code, asks a secret and "saves" it. */
function fakeModels(saved: string[]): Models {
	const { models } = fauxModels();
	const over: Record<string, unknown> = {
		getProviders: () => [{ id: "xai", name: "xAI", auth: { oauth } }],
		login: async (_p: string, _t: string, i: AuthInteraction) => {
			i.notify({ type: "device_code", userCode: "ABCD-1234", verificationUri: "https://example.com/device", expiresInSeconds: 600 });
			saved.push(await i.prompt({ type: "secret", message: "Paste the key" }));
			return { type: "oauth" };
		},
		logout: async () => {},
	};
	return new Proxy(models, { get: (t, k, r) => (typeof k === "string" && k in over ? over[k] : Reflect.get(t, k, r)) });
}

async function gateway(root: string, name: string): Promise<Gw> {
	const dir = join(root, name);
	mkdirSync(dir, { recursive: true });
	const path = join(dir, "config.yaml");
	writeFileSync(path, `server:\n  host: 127.0.0.1\n  port: 0\nnode:\n  name: ${name}\ndefaults:\n  model: faux/faux-1\nbots:\n  - name: ${name}bot\n    default: true\n`);
	const saved: string[] = [];
	const core = await createCore(loadConfig(path), { models: fakeModels(saved) });
	const server = await startServer(core, { host: "127.0.0.1", port: 0, extraRouters: [adminRoutes(core)] });
	return { core, server, url: `http://127.0.0.1:${server.port}`, saved };
}

async function panel(g: Gw, method: string, path: string, body?: unknown): Promise<Res> {
	const res = await fetch(`${g.url}/panel/api${path}`, {
		method,
		headers: method === "GET" ? {} : { "content-type": "application/json", "x-nhermes-panel": "1" },
		body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
	});
	return { status: res.status, json: (await res.json()) as Res["json"] };
}

async function admin(g: Gw, method: string, path: string, body?: unknown): Promise<Res> {
	const res = await fetch(`${g.url}${path}`, { method, headers: { "x-hermes-session-token": TOKEN, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
	return { status: res.status, json: (await res.json()) as Res["json"] };
}

const flush = () => new Promise<void>((r) => setImmediate(r));

async function pair() {
	process.env.NHERMES_TOKEN = TOKEN;
	const { dir, cleanup } = await tempDir();
	const a = await gateway(dir, "alpha");
	const b = await gateway(dir, "beta");
	await b.core.members.join(a.core.members.invite().code);
	return { a, b, cleanup: async () => (await a.server.close(), await b.server.close().catch(() => {}), await a.core.close(), await b.core.close(), await cleanup()) };
}

test("a member's machine is signed in from another panel once that machine allows it", async () => {
	const { a, b, cleanup } = await pair();
	try {
		// Off by default: refused with a plain message, on every route.
		for (const [method, path] of [["GET", "/remote/beta/logins"], ["POST", "/remote/beta/logins"], ["DELETE", "/remote/beta/logins/providers/xai"]] as const) {
			const refused = await panel(a, method, path, { provider: "xai" });
			assert.equal(refused.status, 403, path);
			assert.match(refused.json.detail!, /^beta doesn't let other machines sign it in; turn on "Let other machines sign this machine in to model providers" in its Network tab$/);
		}
		assert.deepEqual(b.saved, [], "nothing started on beta");

		assert.equal((await panel(b, "PATCH", "/network/settings", { acceptLogins: true })).json.acceptsLogins, true);
		const providers = (await panel(a, "GET", "/remote/beta/logins")).json.providers as { id: string }[];
		assert.deepEqual(providers.map((p) => p.id), ["xai"]);

		const started = await panel(a, "POST", "/remote/beta/logins", { provider: "xai" });
		assert.equal(started.status, 200);
		const id = started.json.id as string;
		assert.equal(started.json.state, "prompt");
		assert.deepEqual((started.json.events as { type: string; userCode?: string }[]).map((e) => e.userCode ?? e.type), ["ABCD-1234"]);
		assert.equal((started.json.prompt as { type: string }).type, "secret");
		// The session lives on beta and says who started it.
		assert.ok(lines.some((l) => l.includes("member:alpha")), "beta logs the member's name");

		const answered = await panel(a, "POST", `/remote/beta/logins/${id}/answer`, { value: SECRET });
		assert.equal(answered.status, 200);
		await flush();
		const done = await panel(a, "GET", `/remote/beta/logins/${id}`);
		assert.equal(done.json.state, "done");
		assert.deepEqual(b.saved, [SECRET], "beta's own Models received the answer");
		assert.deepEqual(a.saved, []);
		for (const body of [JSON.stringify(started.json), JSON.stringify(answered.json), JSON.stringify(done.json)]) assert.ok(!body.includes(SECRET));
		assert.ok(!lines.join("\n").includes(SECRET), "no log line holds the answer");

		// Cancel and log out are forwarded too.
		const second = await panel(a, "POST", "/remote/beta/logins", { provider: "xai" });
		assert.equal((await panel(a, "DELETE", `/remote/beta/logins/${second.json.id}`)).json.state, "cancelled");
		assert.equal((await panel(a, "DELETE", "/remote/beta/logins/providers/xai")).status, 200);

		// Back off: refused again.
		await panel(b, "PATCH", "/network/settings", { acceptLogins: false });
		assert.equal((await panel(a, "GET", "/remote/beta/logins")).status, 403);
	} finally {
		await cleanup();
	}
});

test("the switch round-trips through the panel and a bad value is refused", async () => {
	const { a, cleanup } = await pair();
	try {
		assert.equal((await panel(a, "GET", "/network")).json.acceptsLogins, false);
		assert.equal((await panel(a, "PATCH", "/network/settings", { acceptLogins: true })).json.acceptsLogins, true);
		assert.equal((await panel(a, "GET", "/network")).json.acceptsLogins, true);
		assert.equal((await panel(a, "PATCH", "/network/settings", { acceptLogins: "yes" })).status, 400);
		// Independent of the other two switches.
		assert.equal(a.core.members.acceptsBotEdits(), false);
		assert.equal(a.core.members.acceptsSecrets(), false);
	} finally {
		await cleanup();
	}
});

test("the local panel and the admin API sign in this machine; the admin API forwards to a member", async () => {
	const { a, b, cleanup } = await pair();
	try {
		b.core.members.setAcceptsLogins(true);
		const local = await panel(a, "POST", "/logins", { provider: "xai" });
		assert.equal(local.status, 200);
		assert.equal((await panel(a, "DELETE", `/logins/${local.json.id}`)).json.state, "cancelled");

		const remote = await admin(a, "POST", "/admin/remote/beta/logins", { provider: "xai" });
		assert.equal(remote.status, 200);
		const id = remote.json.id as string;
		assert.equal((await admin(a, "POST", `/admin/remote/beta/logins/${id}/answer`, { value: SECRET })).status, 200);
		await flush();
		assert.equal((await admin(a, "GET", `/admin/remote/beta/logins/${id}`)).json.state, "done");
		assert.deepEqual(b.saved, [SECRET]);
		assert.equal((await admin(a, "GET", "/admin/remote/nope/logins")).status, 404);
		b.core.members.setAcceptsLogins(false);
		assert.equal((await admin(a, "GET", "/admin/remote/beta/logins")).status, 403);
	} finally {
		await cleanup();
	}
});

test("a connection on a replaced key cannot reach sign-ins, and the main port serves no member route", async () => {
	const { a, b, cleanup } = await pair();
	try {
		a.core.members.setAcceptsLogins(true);
		const before = b.core.members.byName("alpha")!.secret;
		await a.core.members.rotate("beta");
		const old = { ...b.core.members.byName("alpha")!, secret: before };
		for (const [method, path] of [["GET", "/federation/logins"], ["POST", "/federation/logins"], ["GET", "/federation/logins/x"]] as const) {
			await assert.rejects(b.core.members.call(old, path, { provider: "xai" }, method), /uses a replaced key; reconnect/, path);
		}
		assert.deepEqual(a.saved, [], "nothing started on alpha");
		assert.equal((await fetch(`${a.url}/federation/logins`)).status, 404);
	} finally {
		await cleanup();
	}
});

test("a member that goes away mid-login is a clean error on the other panel", async () => {
	const { a, b, cleanup } = await pair();
	try {
		b.core.members.setAcceptsLogins(true);
		const id = (await panel(a, "POST", "/remote/beta/logins", { provider: "xai" })).json.id as string;
		await b.server.close();
		const gone = await panel(a, "GET", `/remote/beta/logins/${id}`);
		assert.equal(gone.status, 502);
		assert.match(gone.json.detail!, /not reachable/);
	} finally {
		await cleanup();
	}
});
