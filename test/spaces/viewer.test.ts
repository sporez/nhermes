// Live views of spaces (src/spaces/viewer.ts): the link behind a `space` card, served through the gateway with no
// token, to a fake viewer standing in for the one inside a space (an HTTP server and a WebSocket on loopback).
// Only the viewer's page, its gRPC calls and the media socket pass; cookies and the token never reach the space;
// a watched space is not deleted as idle; a closed space ends its views; every followed chat with the bot hears
// about its spaces; and the app on one gateway lists and watches a space on a member through that gateway.
import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import type { Core } from "../../src/app.ts";
import type { BotConfig } from "../../src/config.ts";
import type { CuaRun } from "../../src/spaces/cua.ts";
import { parseViewLink } from "../../src/spaces/spaces.ts";
import { type GatewayServer, startServer } from "../../src/server.ts";
import { ApiCallError, type ApiEvent, ApiSocketClient, http } from "../api/client.ts";
import { TOKEN, tempDir, testConfig, testCore } from "../helpers.ts";

type Seen = { method: string; url: string; headers: IncomingHttpHeaders };

/** What a space's viewer port answers: records every request, echoes on the media socket. */
async function fakeViewer() {
	const seen: Seen[] = [];
	const sockets: WebSocket[] = [];
	const server: Server = createServer((req, res) => {
		seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers });
		res.writeHead(200, { "content-type": "text/html", "set-cookie": "space=1", "access-control-allow-origin": "https://evil.example.com" });
		res.end(`viewer ${req.method} ${req.url}`);
	});
	const wss = new WebSocketServer({ server });
	wss.on("connection", (ws, req) => {
		seen.push({ method: "WS", url: req.url ?? "", headers: req.headers });
		sockets.push(ws);
		ws.on("message", (m) => ws.send(`echo ${m.toString()}`));
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	return {
		port: (server.address() as AddressInfo).port,
		seen,
		sockets,
		close: async () => {
			for (const s of wss.clients) s.terminate();
			wss.close();
			await new Promise<void>((r) => server.close(() => r()));
		},
	};
}

/** A cua holding sandboxes in memory whose `sb view` points at the fake viewer. */
function memoryCua(viewerPort: () => number) {
	const boxes = new Set<string>();
	const views: string[][] = [];
	const expires = { at: () => Math.floor(Date.now() / 1000) + 600 };
	const run: CuaRun = async (args) => {
		const [, cmd] = args;
		if (cmd === "create") boxes.add(args[args.indexOf("--name") + 1]!);
		else if (cmd === "ls") return { code: 0, stdout: JSON.stringify([...boxes].map((name) => ({ name }))), stderr: "" };
		else if (cmd === "rm") boxes.delete(args.at(-1)!);
		else if (cmd === "view") {
			views.push(args);
			if (!boxes.has(args[2]!)) return { code: 1, stdout: "", stderr: "no such sandbox" };
			return { code: 0, stdout: JSON.stringify({ name: args[2], url: `http://127.0.0.1:${viewerPort()}/viewer/#ticket=T-${views.length}&clipboard=0`, expires_at_unix: expires.at() }), stderr: "" };
		} else return { code: 2, stdout: "", stderr: "unsupported" };
		return { code: 0, stdout: "{}", stderr: "" };
	};
	return { run, views, expires };
}

type Gw = { core: Core; server: GatewayServer; port: number; cua: ReturnType<typeof memoryCua>; skew: { ms: number } };

async function gateway(dir: string, name: string, bots: BotConfig[], viewerPort: () => number): Promise<Gw> {
	const d = join(dir, name);
	const cua = memoryCua(viewerPort);
	const skew = { ms: 0 };
	const config = testConfig(d, bots, { node: { name }, spaces: { cua: "cua", image: "linux", perBot: 2, total: 3, idleMinutes: 30 } });
	const core = await testCore(d, { config, spaces: { run: cua.run, now: () => Date.now() + skew.ms } });
	const server = await startServer(core, { host: "127.0.0.1", port: 0 });
	return { core, server, port: server.port, cua, skew };
}

async function setup() {
	const t = await tempDir();
	const viewer = await fakeViewer();
	const g = await gateway(t.dir, "alpha", [{ name: "main", default: true }, { name: "other" }], () => viewer.port);
	return {
		...g,
		viewer,
		close: async () => {
			await g.server.close();
			await g.core.close();
			await viewer.close();
			await t.cleanup();
		},
	};
}

type View = { view: { path: string; expiresAt: number } };
const base = (port: number) => `http://127.0.0.1:${port}`;
const page = (path: string) => path.slice(0, path.indexOf("#"));
const keyed = (path: string) => page(path).replace(/\/viewer\/$/, "");

function socket(url: string): Promise<WebSocket> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(url);
		ws.once("open", () => resolve(ws));
		ws.once("error", reject);
		ws.once("unexpected-response", (_req, res) => reject(new Error(`status ${res.statusCode}`)));
	});
}
const closed = (ws: WebSocket) => new Promise<void>((r) => (ws.readyState === WebSocket.CLOSED ? r() : ws.once("close", () => r())));
const reply = (ws: WebSocket) => new Promise<string>((r) => ws.once("message", (m) => r(m.toString())));

type Listed = { id: string; openedAt: number; watching: number; controlling: number };
/** The chat's `n`th `spaces.changed`: its list, as id and the view counts. */
async function changed(c: ApiSocketClient, sessionId: string, n: number): Promise<string[]> {
	const nth = (e: ApiEvent) => e.event === "spaces.changed" && e.sessionId === sessionId && c.eventsOf("spaces.changed", sessionId).length >= n;
	await c.waitEvent(nth);
	const e = c.eventsOf("spaces.changed", sessionId)[n - 1]!;
	return (e.data.spaces as Listed[]).map((x) => `${x.id} ${x.watching}/${x.controlling}`);
}

test("a view's link is made on request, watch only or with control, and only for the chat's bot's own space", async () => {
	const s = await setup();
	try {
		const { id: space, name } = await s.core.spaces.open("main");
		const chat = await s.core.sessions.create("main");
		const api = http(s.port);
		const watch = await api<View>(`POST /sessions/${chat.id}/spaces/${space}/view`);
		assert.match(watch.view.path, /^\/spaces\/view\/[A-Za-z0-9_-]{24}\/viewer\/#ticket=T-1&clipboard=0$/);
		assert.ok(watch.view.expiresAt > Date.now());
		assert.deepEqual(s.cua.views[0], ["sb", "view", name, "--view-only", "--no-open", "--ttl", "600", "--json"]);
		const control = await api<View>(`POST /sessions/${chat.id}/spaces/${space}/view`, { control: true });
		assert.deepEqual(s.cua.views[1]?.slice(3, 5), ["--files", "none"]);
		assert.notEqual(keyed(control.view.path), keyed(watch.view.path), "each view has its own key");

		// Another bot's chat, a space that does not exist, and no token.
		const other = await s.core.sessions.create("other");
		await assert.rejects(api(`POST /sessions/${other.id}/spaces/${space}/view`), (e: ApiCallError) => e.code === "not_found");
		await assert.rejects(api(`POST /sessions/${chat.id}/spaces/s-0000/view`), (e: ApiCallError) => e.code === "not_found");
		await assert.rejects(http(s.port, null)(`POST /sessions/${chat.id}/spaces/${space}/view`), (e: ApiCallError) => e.status === 401);
		assert.equal(s.cua.views.length, 2, "nothing more was asked of cua");
	} finally {
		await s.close();
	}
});

test("only the viewer's page, its calls and the media socket reach the space, sandboxed, without cookies or the token", async () => {
	const s = await setup();
	try {
		const { id: space } = await s.core.spaces.open("main");
		const chat = await s.core.sessions.create("main");
		const { view } = await http(s.port)<View>(`POST /sessions/${chat.id}/spaces/${space}/view`);
		const at = keyed(view.path);

		const r = await fetch(`${base(s.port)}${page(view.path)}?v=2`, { headers: { cookie: "nh_panel=secret", authorization: `Bearer ${TOKEN}`, "x-forwarded-for": "10.0.0.9" } });
		assert.equal(r.status, 200);
		assert.equal(await r.text(), "viewer GET /viewer/?v=2");
		assert.equal(r.headers.get("content-security-policy"), "sandbox allow-scripts");
		assert.equal(r.headers.get("access-control-allow-origin"), "*");
		assert.equal(r.headers.get("set-cookie"), null);
		const got = s.viewer.seen.at(-1)!;
		assert.equal(got.headers.cookie, undefined);
		assert.equal(got.headers.authorization, undefined);
		assert.equal(got.headers["x-forwarded-for"], undefined);
		assert.equal(got.headers.host, `127.0.0.1:${s.viewer.port}`);

		const rpc = await fetch(`${base(s.port)}${at}/cua.env.v1.StreamService/OpenMedia`, { method: "POST", headers: { "content-type": "application/grpc-web+proto", "x-cua-env-authorization": "Bearer T-1" }, body: "\0\0\0\0\0" });
		assert.equal(rpc.status, 200);
		assert.equal(s.viewer.seen.at(-1)?.headers["x-cua-env-authorization"], "Bearer T-1");
		const preflight = await fetch(`${base(s.port)}${at}/cua.env.v1.StreamService/OpenMedia`, { method: "OPTIONS", headers: { "access-control-request-headers": "x-grpc-web, x-cua-env-authorization" } });
		assert.equal(preflight.status, 204);
		assert.equal(preflight.headers.get("access-control-allow-headers"), "x-grpc-web, x-cua-env-authorization");

		const before = s.viewer.seen.length;
		for (const [method, path] of [
			["POST", "/cua.env.v1.ProcessService/StartProcess"],
			["POST", "/cua.env.v1.FilesystemService/ReadFile"],
			["POST", "/cua.env.v1.ComputerService/Screenshot"],
			["POST", "/mcp"],
			["GET", "/files/x"],
			["GET", "/health"],
			["GET", "/viewer/../mcp"],
			["GET", "/viewer/%2e%2e/mcp"],
			["POST", "/viewer/"],
			["GET", "/cua.env.v1.StreamService/OpenMedia"],
		] as const) {
			const res = await fetch(`${base(s.port)}${at}${path}`, { method, ...(method === "POST" ? { body: "x" } : {}) });
			assert.equal(res.status, 404, `${method} ${path}`);
		}
		const wrongKey = await fetch(`${base(s.port)}/spaces/view/${"A".repeat(24)}/viewer/`);
		assert.equal(wrongKey.status, 404);
		await assert.rejects(socket(`ws://127.0.0.1:${s.port}${at}/tunnel?ticket=x`), /404/);
		assert.equal(s.viewer.seen.length, before, "none of them reached the space");

		const ws = await socket(`ws://127.0.0.1:${s.port}${at}/media?ticket=M`);
		ws.send("hello");
		assert.equal(await reply(ws), "echo hello");
		assert.equal(s.viewer.seen.at(-1)?.url, "/media?ticket=M");
		ws.close();
	} finally {
		await s.close();
	}
});

test("a watched space is not deleted as idle; closing a space ends its views", async () => {
	const s = await setup();
	try {
		const { id: space } = await s.core.spaces.open("main");
		const chat = await s.core.sessions.create("main");
		const { view } = await http(s.port)<View>(`POST /sessions/${chat.id}/spaces/${space}/view`);
		const ws = await socket(`ws://127.0.0.1:${s.port}${keyed(view.path)}/media?ticket=M`);
		assert.equal(s.core.spaces.list()[0]?.watching, 1);
		assert.equal(s.core.spaces.controlled(space), false, "watching is not control");
		const { view: control } = await http(s.port)<View>(`POST /sessions/${chat.id}/spaces/${space}/view`, { control: true });
		const hands = await socket(`ws://127.0.0.1:${s.port}${keyed(control.path)}/media?ticket=M`);
		assert.deepEqual([s.core.spaces.list()[0]?.watching, s.core.spaces.controlled(space)], [2, true], "a control view's socket holds the space for the owner");
		hands.close();
		await closed(hands);
		await new Promise<void>((r) => setImmediate(r));
		assert.equal(s.core.spaces.controlled(space), false, "closing it hands the space back");

		s.skew.ms = 31 * 60_000;
		assert.deepEqual(await s.core.spaces.deleteIdle(), [], "watched: kept");
		ws.close();
		await closed(ws);
		await new Promise<void>((r) => setImmediate(r));
		assert.equal(s.core.spaces.list()[0]?.watching, 0);
		assert.deepEqual(await s.core.spaces.deleteIdle(), [], "the idle clock restarted when the viewer left");

		const again = await socket(`ws://127.0.0.1:${s.port}${keyed(view.path)}/media?ticket=M`);
		await s.core.spaces.close("main", space);
		await closed(again);
		assert.equal((await fetch(`${base(s.port)}${page(view.path)}`)).status, 404);
		await assert.rejects(http(s.port)(`POST /sessions/${chat.id}/spaces/${space}/view`), (e: ApiCallError) => e.code === "not_found");
	} finally {
		await s.close();
	}
});

test("every followed chat with the bot is told when its spaces open, close and are watched; the list is asked for too", async () => {
	const s = await setup();
	const c = await ApiSocketClient.connect(s.port);
	try {
		const one = await s.core.sessions.create("main");
		const two = await s.core.sessions.create("main");
		const other = await s.core.sessions.create("other");
		for (const id of [one.id, two.id, other.id]) await c.call("sessions.subscribe", { id });
		const api = http(s.port);
		assert.deepEqual(await api(`GET /sessions/${one.id}/spaces`), { spaces: [] });

		const { id: first } = await s.core.spaces.open("main");
		assert.deepEqual(await changed(c, one.id, 1), [`${first} 0/0`]);
		assert.deepEqual(await changed(c, two.id, 1), [`${first} 0/0`], "a space is the bot's, so each of its chats hears");
		const { id: second } = await s.core.spaces.open("main");
		assert.deepEqual(await changed(c, one.id, 2), [`${first} 0/0`, `${second} 0/0`], "the whole list, oldest first");

		const { view } = await api<View>(`POST /sessions/${one.id}/spaces/${second}/view`, { control: true });
		const ws = await socket(`ws://127.0.0.1:${s.port}${keyed(view.path)}/media?ticket=M`);
		assert.deepEqual(await changed(c, one.id, 3), [`${first} 0/0`, `${second} 1/1`]);
		const listed = await api<{ spaces: Listed[] }>(`GET /sessions/${two.id}/spaces`);
		assert.deepEqual(Object.keys(listed.spaces[0]!).sort(), ["controlling", "id", "openedAt", "watching"], "no sandbox name or idle clock");
		assert.ok(listed.spaces[0]!.openedAt <= Date.now());
		ws.close();
		assert.deepEqual(await changed(c, one.id, 4), [`${first} 0/0`, `${second} 0/0`], "the view closing is told too");

		await s.core.spaces.close("main", first);
		assert.deepEqual(await changed(c, two.id, 5), [`${second} 0/0`]);
		assert.deepEqual(c.eventsOf("spaces.changed", other.id), [], "another bot's chat hears nothing");
		assert.deepEqual(await api(`GET /sessions/${other.id}/spaces`), { spaces: [] });
		await assert.rejects(http(s.port, null)(`GET /sessions/${one.id}/spaces`), (e: ApiCallError) => e.status === 401);
	} finally {
		await c.close();
		await s.close();
	}
});

test("the owner closes a space from any chat with its bot; the bot is told who closed it", async () => {
	const s = await setup();
	const c = await ApiSocketClient.connect(s.port);
	try {
		const chat = await s.core.sessions.create("main");
		const other = await s.core.sessions.create("other");
		await c.call("sessions.subscribe", { id: chat.id });
		const { id: space } = await s.core.spaces.open("main");
		const { id: kept } = await s.core.spaces.open("main");
		const api = http(s.port);
		await assert.rejects(api(`DELETE /sessions/${other.id}/spaces/${space}`), (e: ApiCallError) => e.code === "not_found", "not another bot's chat");
		await assert.rejects(http(s.port, null)(`DELETE /sessions/${chat.id}/spaces/${space}`), (e: ApiCallError) => e.status === 401);

		assert.deepEqual(await api(`DELETE /sessions/${chat.id}/spaces/${space}`), {});
		assert.deepEqual(await changed(c, chat.id, 3), [`${kept} 0/0`]);
		await assert.rejects(s.core.spaces.use("main", space, async () => 1), /The owner closed space .*Your open spaces: s-/);
		await assert.rejects(api(`DELETE /sessions/${chat.id}/spaces/${space}`), (e: ApiCallError) => e.code === "not_found", "already closed");
		assert.equal(s.core.spaces.list().length, 1);
	} finally {
		await c.close();
		await s.close();
	}
});

test("an expired view opens nothing new", async () => {
	const s = await setup();
	try {
		const { id: space } = await s.core.spaces.open("main");
		const chat = await s.core.sessions.create("main");
		s.cua.expires.at = () => Math.floor(Date.now() / 1000) - 1;
		const { view } = await http(s.port)<View>(`POST /sessions/${chat.id}/spaces/${space}/view`);
		assert.equal((await fetch(`${base(s.port)}${page(view.path)}`)).status, 404);
		await assert.rejects(socket(`ws://127.0.0.1:${s.port}${keyed(view.path)}/media?ticket=M`), /404/);
	} finally {
		await s.close();
	}
});

test("cua's view is used only when it is a viewer on this host's loopback with a ticket", () => {
	const ok = parseViewLink(JSON.stringify({ url: "http://127.0.0.1:32773/viewer/#ticket=abc&clipboard=0", expires_at_unix: 2000000000 }));
	assert.deepEqual(ok, { port: 32773, fragment: "ticket=abc&clipboard=0", expiresAt: 2000000000000 });
	for (const url of ["http://192.0.2.4:32773/viewer/#ticket=abc", "https://127.0.0.1:1/viewer/#ticket=abc", "http://127.0.0.1:1/mcp#ticket=abc", "http://127.0.0.1:1/viewer/", "not a url"]) {
		assert.equal(parseViewLink(JSON.stringify({ url })), undefined, url);
	}
	assert.equal(parseViewLink("not json"), undefined);
});

test("the app on alpha watches a space of beta's bot through alpha", async () => {
	const t = await tempDir();
	const viewer = await fakeViewer();
	const a = await gateway(t.dir, "alpha", [{ name: "main", default: true }], () => viewer.port);
	const b = await gateway(t.dir, "beta", [{ name: "nasbot", default: true }, { name: "hidden", private: true }], () => viewer.port);
	const c = await ApiSocketClient.connect(a.port);
	try {
		const { code } = a.core.members.invite();
		await b.core.members.join(code);
		await a.core.roster.sync();
		const api = http(a.port);
		const { session } = await api<{ session: { id: string } }>("POST /sessions", { botId: "nasbot-beta" });
		await c.call("sessions.subscribe", { id: session.id });
		const { id: space } = await b.core.spaces.open("nasbot");
		assert.deepEqual(await changed(c, session.id, 1), [`${space} 0/0`], "beta's news of its bot's space reaches the app on alpha");
		assert.deepEqual((await api<{ spaces: Listed[] }>(`GET /sessions/${session.id}/spaces`)).spaces.map((x) => x.id), [space]);

		const { view } = await api<View>(`POST /sessions/${session.id}/spaces/${space}/view`, { control: true });
		assert.match(view.path, /^\/spaces\/view\/[A-Za-z0-9_-]{24}\/viewer\/#ticket=T-1&clipboard=0$/, "a path on alpha, with beta's ticket");
		assert.deepEqual(b.cua.views[0]?.slice(3, 5), ["--files", "none"]);

		const r = await fetch(`${base(a.port)}${page(view.path)}`, { headers: { cookie: "nh_panel=secret" } });
		assert.equal(r.status, 200);
		assert.equal(await r.text(), "viewer GET /viewer/");
		assert.equal(r.headers.get("content-security-policy"), "sandbox allow-scripts");
		assert.equal(viewer.seen.at(-1)?.headers.cookie, undefined);
		const blocked = await fetch(`${base(a.port)}${keyed(view.path)}/cua.env.v1.ProcessService/StartProcess`, { method: "POST", body: "x" });
		assert.equal(blocked.status, 404);

		const ws = await socket(`ws://127.0.0.1:${a.port}${keyed(view.path)}/media?ticket=M`);
		ws.send("hi");
		assert.equal(await reply(ws), "echo hi");
		assert.equal(b.core.spaces.list()[0]?.watching, 1, "beta, which holds the space, counts the viewer");
		await b.core.spaces.close("nasbot", space);
		await closed(ws);

		// Beta serves a member's view only to the member it was made for, and only on the encrypted port.
		const { id: second } = await b.core.spaces.open("nasbot");
		const elsewhere = await b.core.viewer.open("nasbot", second, { control: false, member: "some-other-node" });
		assert.match(elsewhere.path, /^\/federation\/spaces\/view\//);
		const stolen = a.core.viewer.relay(b.core.members.self().id, elsewhere.path, elsewhere.expiresAt);
		assert.equal((await fetch(`${base(a.port)}${page(stolen.path)}`)).status, 404, "alpha cannot use a view made for another member");
		assert.equal((await fetch(`${base(b.port)}${page(elsewhere.path)}`)).status, 404, "not on beta's main port");
		const mine = await api<View>(`POST /sessions/${session.id}/spaces/${second}/view`);
		assert.equal((await fetch(`${base(a.port)}${page(mine.view.path)}`)).status, 200);

		// The owner closes beta's bot's space from alpha.
		await api(`DELETE /sessions/${session.id}/spaces/${second}`);
		assert.deepEqual(b.core.spaces.list(), []);
	} finally {
		await c.close();
		for (const g of [a, b]) {
			await g.server.close();
			await g.core.close();
		}
		await viewer.close();
		await t.cleanup();
	}
});
