// MCP server connections (src/mcp/connection.ts, src/mcp/servers.ts): availability per server, recovery
// with backoff, the on-demand reconnect, keys, tool snapshots and their change log, and the outcome of
// calls that fail in each way. Timings are shrunk through `tuning`; tests wait on state changes and on the
// fake server's own signals.
import assert from "node:assert/strict";
import { createServer as createTcpServer, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import type { McpServerConfig } from "../../src/config.ts";
import type { McpState } from "../../src/mcp/connection.ts";
import { McpServers } from "../../src/mcp/servers.ts";
import { setLogLevel, setLogSink } from "../../src/log.ts";
import { AppDb } from "../../src/store/db.ts";
import { mcpServerConfig, tempDir } from "../helpers.ts";
import { closedPort, FakeMcpServer } from "./server.ts";

const FAST = { connectBudgetMs: 2000, probeBudgetMs: 1500, probeGapMs: 0, pingTimeoutMs: 500, pingMisses: 2, backoffBaseMs: 20, backoffCapMs: 80, slowRetryMs: 30 * 60_000 };

async function setup(configs: McpServerConfig[], tuning: Partial<typeof FAST> = {}) {
	const t = await tempDir();
	const db = new AppDb(join(t.dir, "app.sqlite"));
	const state = { configs };
	const make = () => new McpServers({ db, servers: () => state.configs, version: "test", tuning: { ...FAST, ...tuning }, random: () => 1 });
	const servers = make();
	return {
		db,
		state,
		servers,
		make,
		cleanup: async () => {
			await servers.close();
			db.close();
			await t.cleanup();
		},
	};
}

/** Resolves once `server` is in `state` (checked now and on every state change). */
function reach(servers: McpServers, name: string, state: McpState, timeoutMs = 5000): Promise<void> {
	return new Promise((resolve, reject) => {
		const current = () => servers.status().find((s) => s.name === name)?.state;
		if (current() === state) return resolve();
		const t = setTimeout(() => (off(), reject(new Error(`${name} never reached ${state} (is ${current()})`))), timeoutMs);
		const off = servers.onStateChanged((n) => {
			if (n === name && current() === state) {
				clearTimeout(t);
				off();
				resolve();
			}
		});
	});
}

test("connects, lists the tools, keeps them in app.sqlite, and a restart knows them before connecting", async () => {
	const fake = await FakeMcpServer.start([{ name: "list_events", description: "Lists events" }, { name: "add_event" }]);
	const s = await setup([mcpServerConfig("cal", fake.url)]);
	try {
		s.servers.start();
		await reach(s.servers, "cal", "online");
		const st = s.servers.status()[0]!;
		assert.equal(st.toolCount, 2);
		assert.equal(st.fresh, true);
		assert.equal(st.serverInfo?.name, "fake-mcp");
		assert.equal(st.protocolVersion, "2025-11-25");
		assert.deepEqual(s.servers.changes("cal")[0]?.added, ["list_events", "add_event"]);
		const r = await s.servers.call("cal", "list_events", { day: "today" }, { readOnly: true });
		assert.ok(r.ok);
		assert.deepEqual(fake.calls.map((c) => [c.name, c.args]), [["list_events", { day: "today" }]]);
		await s.servers.close();
		await fake.stop();

		// A new process with the server gone: the tools are known at once, from the snapshot, and not fresh.
		const again = s.make();
		assert.deepEqual(again.snapshot("cal")?.tools.map((t) => t.name), ["list_events", "add_event"]);
		again.start();
		await reach(again, "cal", "offline");
		const st2 = again.status()[0]!;
		assert.equal(st2.toolCount, 2);
		assert.equal(st2.fresh, false);
		// Refused, or reset when a pooled connection to the old server is tried first.
		assert.match(st2.lastError ?? "", /ECONNREFUSED|ECONNRESET/);
		await again.close();
	} finally {
		await fake.stop();
		await s.cleanup();
	}
});

test("a server down at startup is offline, calls fail fast without sending, and it is used once it comes back", async () => {
	const port = await closedPort();
	const s = await setup([mcpServerConfig("cal", `http://127.0.0.1:${port}/mcp`)], { backoffBaseMs: 60_000, backoffCapMs: 60_000, probeGapMs: 0 });
	let fake: FakeMcpServer | undefined;
	try {
		s.servers.start();
		await reach(s.servers, "cal", "offline");
		const st = s.servers.status()[0]!;
		assert.ok(st.nextAttemptAt && st.nextAttemptAt - Date.now() > 20_000, "backs off instead of retrying at once");
		const down = await s.servers.call("cal", "add_event", {}, { readOnly: false });
		assert.ok(!down.ok);
		assert.equal(down.outcome.kind, "offline");
		assert.equal(down.outcome.sent, "no");

		// It wakes up before the backoff timer: the next call's quick attempt finds it.
		fake = await FakeMcpServer.start([{ name: "add_event" }], { port });
		const up = await s.servers.call("cal", "add_event", { title: "x" }, { readOnly: false });
		assert.ok(up.ok, JSON.stringify(up));
		assert.equal(s.servers.status()[0]!.state, "online");
		assert.equal(fake.callsOf("add_event").length, 1);
	} finally {
		await fake?.stop();
		await s.cleanup();
	}
});

test("a server that goes away is noticed by the health check, logged once, and recovers with backoff", async () => {
	const lines: string[] = [];
	setLogSink((l) => lines.push(l));
	setLogLevel("info");
	const fake = await FakeMcpServer.start([{ name: "t" }]);
	const s = await setup([mcpServerConfig("cal", fake.url, { healthCheckS: 0.05 })]);
	try {
		s.servers.start();
		await reach(s.servers, "cal", "online");
		await fake.stop();
		await reach(s.servers, "cal", "offline");
		// Several more attempts fail while it is away (backoff 20-80 ms); still one warning.
		for (let i = 0; i < 3; i++) {
			const before = s.servers.status()[0]!.since;
			await new Promise<void>((resolve) => {
				const off = s.servers.onStateChanged(() => {
					if (s.servers.status()[0]!.since !== before) (off(), resolve());
				});
			});
		}
		assert.equal(lines.filter((l) => l.includes("mcp server offline")).length, 1);
		await fake.listen();
		await reach(s.servers, "cal", "online");
		assert.ok(lines.some((l) => l.includes("mcp server is back")));
		assert.ok((await s.servers.call("cal", "t", {}, { readOnly: true })).ok);
	} finally {
		setLogSink((line) => process.stderr.write(`${line}\n`));
		setLogLevel("error");
		await fake.stop();
		await s.cleanup();
	}
});

test("two servers: one that never answers does not hold up the other", async () => {
	// Accepts connections and never answers.
	const held: Socket[] = [];
	const silent = createTcpServer((sock) => held.push(sock));
	await new Promise<void>((r) => silent.listen(0, "127.0.0.1", () => r()));
	const silentUrl = `http://127.0.0.1:${(silent.address() as AddressInfo).port}/mcp`;
	const fake = await FakeMcpServer.start([{ name: "t" }]);
	const s = await setup([mcpServerConfig("stuck", silentUrl), mcpServerConfig("ok", fake.url)], { connectBudgetMs: 60_000, probeBudgetMs: 200 });
	try {
		s.servers.start();
		await reach(s.servers, "ok", "online");
		assert.equal(s.servers.status().find((x) => x.name === "stuck")!.state, "connecting");
		assert.ok((await s.servers.call("ok", "t", {}, { readOnly: true })).ok);
		const started = Date.now();
		const stuck = await s.servers.call("stuck", "t", {}, { readOnly: true });
		assert.ok(!stuck.ok && stuck.outcome.kind === "offline");
		assert.ok(Date.now() - started < 2000, "a call to the stuck server gives up within its probe budget");
	} finally {
		for (const sock of held) sock.destroy();
		silent.close();
		await fake.stop();
		await s.cleanup();
	}
});

test("keys: a missing or refused key is needs_key with a slow retry, and setting the key reconnects", async () => {
	const fake = await FakeMcpServer.start([{ name: "t" }], { token: "right-token-0123456789" });
	const s = await setup([mcpServerConfig("cal", fake.url, { headers: { Authorization: "Bearer {{secret:TEST_MCP_KEY}}" } })]);
	delete process.env.TEST_MCP_KEY;
	try {
		s.servers.start();
		await reach(s.servers, "cal", "needs_key");
		assert.match(s.servers.status()[0]!.lastError ?? "", /TEST_MCP_KEY is not set/);
		assert.equal(fake.initializes, 0, "nothing is sent without the key");

		process.env.TEST_MCP_KEY = "wrong-token-0123456789";
		s.servers.keyChanged("TEST_MCP_KEY");
		await reach(s.servers, "cal", "needs_key");
		await new Promise<void>((resolve) => {
			const check = () => (s.servers.status()[0]!.lastError?.includes("authentication") ? resolve() : undefined);
			check();
			s.servers.onStateChanged(check);
		});
		const st = s.servers.status()[0]!;
		assert.ok(st.nextAttemptAt && st.nextAttemptAt - Date.now() > 29 * 60_000, "a refused key is retried slowly");
		const r = await s.servers.call("cal", "t", {}, { readOnly: false });
		assert.ok(!r.ok && r.outcome.kind === "auth" && r.outcome.sent === "no");
		assert.equal(fake.calls.length, 0);

		process.env.TEST_MCP_KEY = "right-token-0123456789";
		s.servers.keyChanged("TEST_MCP_KEY");
		await reach(s.servers, "cal", "online");
		assert.ok((await s.servers.call("cal", "t", {}, { readOnly: false })).ok);
		assert.equal(fake.lastHeaders.authorization, "Bearer right-token-0123456789");
	} finally {
		delete process.env.TEST_MCP_KEY;
		await fake.stop();
		await s.cleanup();
	}
});

test("tools/list_changed refreshes the list; the change log records added, removed and changed tools", async () => {
	const fake = await FakeMcpServer.start([{ name: "a", description: "one" }, { name: "b" }]);
	const s = await setup([mcpServerConfig("cal", fake.url)]);
	try {
		const stream = fake.next("get");
		s.servers.start();
		await reach(s.servers, "cal", "online");
		await stream;
		const changed = new Promise<string>((resolve) => s.servers.onToolsChanged(resolve));
		fake.setTools([{ name: "a", description: "two" }, { name: "c" }]);
		assert.equal(await changed, "cal");
		assert.deepEqual(s.servers.snapshot("cal")?.tools.map((t) => t.name), ["a", "c"]);
		const last = s.servers.changes("cal")[0]!;
		assert.deepEqual([last.added, last.removed, last.changed], [["c"], ["b"], ["a"]]);
	} finally {
		await fake.stop();
		await s.cleanup();
	}
});

test("a server that cannot announce tool changes has its list taken again by the health check; one that can is only pinged", async () => {
	const quiet = await FakeMcpServer.start([{ name: "list_events" }]);
	quiet.listChanged = false;
	const announcing = await FakeMcpServer.start([{ name: "a" }]);
	const s = await setup([mcpServerConfig("cal", quiet.url, { healthCheckS: 0.05 }), mcpServerConfig("other", announcing.url, { healthCheckS: 0.05 })]);
	try {
		s.servers.start();
		await Promise.all([reach(s.servers, "cal", "online"), reach(s.servers, "other", "online")]);
		// The access the server grants changed, and it says nothing: the next health check finds the new tools.
		const changed = new Promise<string>((resolve, reject) => {
			const t = setTimeout(() => reject(new Error("the new tool list never arrived")), 5000);
			s.servers.onToolsChanged((n) => n === "cal" && (clearTimeout(t), resolve(n)));
		});
		quiet.setTools([{ name: "list_events" }, { name: "add_event" }]);
		assert.equal(await changed, "cal");
		assert.deepEqual(s.servers.snapshot("cal")?.tools.map((t) => t.name), ["list_events", "add_event"]);
		assert.deepEqual(s.servers.changes("cal")[0]?.added, ["add_event"]);
		for (let i = 0; i < 3; i++) await announcing.next("ping");
		assert.equal(announcing.lists, 1);
	} finally {
		await quiet.stop();
		await announcing.stop();
		await s.cleanup();
	}
});

test("a changed URL is a different server: its old tool list is dropped", async () => {
	const fake = await FakeMcpServer.start([{ name: "a" }]);
	const s = await setup([mcpServerConfig("cal", fake.url)]);
	try {
		s.servers.start();
		await reach(s.servers, "cal", "online");
		s.state.configs = [mcpServerConfig("cal", `http://127.0.0.1:${await closedPort()}/mcp`)];
		s.servers.apply();
		assert.equal(s.servers.snapshot("cal"), undefined);
		await reach(s.servers, "cal", "offline");
		s.state.configs = [];
		s.servers.apply();
		assert.deepEqual(s.servers.status(), []);
	} finally {
		await fake.stop();
		await s.cleanup();
	}
});

test("calls: an expired session is resent once on a new session; a dropped, failed or timed-out call is never resent", async () => {
	const fake = await FakeMcpServer.start([{ name: "add" }, { name: "slow" }]);
	const s = await setup([mcpServerConfig("cal", fake.url, { timeoutS: 0.3 })]);
	try {
		s.servers.start();
		await reach(s.servers, "cal", "online");
		fake.expireSessions();
		const resent = await s.servers.call("cal", "add", { n: 1 }, { readOnly: false });
		assert.ok(resent.ok, JSON.stringify(resent));
		assert.equal(fake.callsOf("add").length, 1, "the expired session's request never reached the tool");
		assert.equal(fake.initializes, 2);

		fake.behavior.set("add", { drop: true });
		const lost = await s.servers.call("cal", "add", { n: 2 }, { readOnly: false });
		assert.ok(!lost.ok);
		assert.equal(lost.outcome.kind, "lost");
		assert.equal(lost.outcome.sent, "unknown");
		assert.equal(fake.callsOf("add").length, 2);
		await reach(s.servers, "cal", "online");

		fake.behavior.set("add", { toolError: "no such calendar" });
		const toolError = await s.servers.call("cal", "add", {}, { readOnly: false });
		assert.ok(toolError.ok && toolError.result.isError === true, "an isError result is the tool's own answer");

		fake.behavior.set("add", { status: 500, body: "boom" });
		const failed = await s.servers.call("cal", "add", {}, { readOnly: false });
		assert.ok(!failed.ok && failed.outcome.kind === "server_error" && failed.outcome.sent === "unknown");

		fake.behavior.set("add", { rpcError: { code: -32602, message: "title is required" } });
		const rejected = await s.servers.call("cal", "add", {}, { readOnly: false });
		assert.ok(!rejected.ok && rejected.outcome.kind === "rejected" && rejected.outcome.sent === "no");

		fake.behavior.set("slow", { hang: true });
		const cancel = fake.next("cancel");
		const timedOut = await s.servers.call("cal", "slow", {}, { readOnly: false });
		assert.ok(!timedOut.ok && timedOut.outcome.kind === "timeout");
		await cancel;
		assert.equal(fake.callsOf("slow").length, 1);

		const owner = new AbortController();
		const interrupted = s.servers.call("cal", "slow", {}, { readOnly: false, signal: owner.signal });
		await fake.next("call");
		owner.abort();
		const r = await interrupted;
		assert.ok(!r.ok && r.outcome.kind === "cancelled");
		assert.equal(fake.callsOf("add").length, 5, "every call reached the server exactly once");

		// Nothing waits to be replayed: reconnecting sends no tool call.
		await s.servers.reconnect("cal");
		assert.equal(fake.calls.length, 7);
	} finally {
		await fake.stop();
		await s.cleanup();
	}
});

test("a server that refuses the handshake with 400 is reported as set up wrong (maybe a newer protocol), not offline", async () => {
	const http = await import("node:http");
	const server = http.createServer((_req, res) => {
		res.writeHead(400);
		res.end("missing MCP-Protocol-Version");
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
	const s = await setup([mcpServerConfig("new", `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`)]);
	try {
		s.servers.start();
		await reach(s.servers, "new", "failed");
		assert.match(s.servers.status()[0]!.lastError ?? "", /2026-07-28/);
		const r = await s.servers.call("new", "t", {}, { readOnly: true });
		assert.ok(!r.ok && r.outcome.kind === "misconfigured");
	} finally {
		server.close();
		await s.cleanup();
	}
});

test("a URL that points at the gateway itself is refused before anything is sent", async () => {
	const t = await tempDir();
	const db = new AppDb(join(t.dir, "app.sqlite"));
	const servers = new McpServers({ db, servers: () => [mcpServerConfig("self", "http://127.0.0.1:9119/mcp")], version: "test", refuse: async (url) => (url.includes(":9119") ? "the URL points at this gateway itself" : undefined) });
	try {
		servers.start();
		await reach(servers, "self", "failed");
		assert.match(servers.status()[0]!.lastError ?? "", /this gateway itself/);
	} finally {
		await servers.close();
		db.close();
		await t.cleanup();
	}
});
