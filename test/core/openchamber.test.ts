import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { condenseMessages, type Message, OpenChamber } from "../../src/openchamber/client.ts";
import { redact } from "../../src/log.ts";
import { openchamberFeature } from "../../src/tools/openchamber.ts";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { collect, fauxModels, tempDir, testConfig, testCore } from "../helpers.ts";

const TOKEN = "oc-token-0123456789abcdef";

type Seen = { method: string; url: string; auth?: string; body?: unknown };

/** A fake OpenChamber: `routes` maps "METHOD /path" (query ignored) to the JSON it answers with. */
async function fakeServer(routes: Record<string, (seen: Seen) => unknown>) {
	const seen: Seen[] = [];
	const server = createServer(async (req: IncomingMessage, res) => {
		let raw = "";
		for await (const c of req) raw += c;
		const s: Seen = { method: req.method!, url: req.url!, auth: req.headers.authorization, body: raw ? JSON.parse(raw) : undefined };
		seen.push(s);
		if (s.auth !== `Bearer ${TOKEN}`) {
			res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "UI authentication required", locked: true }));
			return;
		}
		const route = routes[`${s.method} ${s.url.split("?")[0]}`];
		if (!route) {
			res.writeHead(404).end(JSON.stringify({ message: "no route" }));
			return;
		}
		const out = route(s);
		if (out === undefined) res.writeHead(204).end();
		else res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(out));
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
	const port = (server.address() as AddressInfo).port;
	return { port, seen, base: `http://127.0.0.1:${port}`, close: () => server.close() };
}

async function settingsFile(dir: string, port: number, token = TOKEN): Promise<string> {
	await mkdir(dir, { recursive: true });
	const path = join(dir, "settings.json");
	await writeFile(path, JSON.stringify({ desktopLocalPort: port, desktopLocalClientToken: token }));
	return path;
}

test("client reads port and token from the settings file on each call and sends the bearer", async () => {
	const { dir, cleanup } = await tempDir();
	const a = await fakeServer({ "GET /api/session/active": () => ({ data: { ses_1: { type: "running" } } }) });
	try {
		const settingsPath = await settingsFile(dir, a.port);
		const oc = new OpenChamber({ settingsPath });
		assert.deepEqual(await oc.get("/api/session/active"), { data: { ses_1: { type: "running" } } });
		assert.equal(a.seen[0]!.auth, `Bearer ${TOKEN}`);
		// Rewritten settings (OpenChamber restarted on another port) are picked up without a new client.
		const b = await fakeServer({ "GET /api/session/active": () => ({ data: {} }) });
		await settingsFile(dir, b.port);
		assert.deepEqual(await oc.get("/api/session/active"), { data: {} });
		assert.equal(b.seen.length, 1);
		b.close();
		assert.equal(redact(`leak ${TOKEN}`), "leak [redacted]");
	} finally {
		a.close();
		await cleanup();
	}
});

test("client explains a missing settings file, a refused connection and a rejected token", async () => {
	const { dir, cleanup } = await tempDir();
	const s = await fakeServer({});
	try {
		await assert.rejects(new OpenChamber({ settingsPath: join(dir, "nope.json") }).get("/health"), /settings file .* does not exist/);
		const settingsPath = await settingsFile(dir, s.port, "wrong-token-0123456789");
		await assert.rejects(new OpenChamber({ settingsPath }).get("/api/session"), /OpenChamber rejected the token/);
		s.close();
		await assert.rejects(new OpenChamber({ settingsPath }).get("/api/session"), /OpenChamber is not running on this Mac/);
		// A per-bot override wins over the settings file.
		process.env.TEST_OC_TOKEN = TOKEN;
		const o = await fakeServer({ "GET /api/session": () => ({ data: [] }) });
		try {
			assert.deepEqual(await new OpenChamber({ settingsPath, config: { url: o.base, tokenEnv: "TEST_OC_TOKEN" } }).get("/api/session"), { data: [] });
		} finally {
			o.close();
			delete process.env.TEST_OC_TOKEN;
		}
	} finally {
		await cleanup();
	}
});

test("condenseMessages keeps text, one line per tool call, drops reasoning, and caps the total", () => {
	const msgs: Message[] = [
		{ id: "m1", type: "user", text: "fix the bug" },
		{
			id: "m2",
			type: "assistant",
			content: [
				{ type: "reasoning", text: "secret thoughts" },
				{ type: "text", text: "Looking." },
				{ type: "tool", name: "read", state: { status: "completed", input: { filePath: "/a/b.ts" } } },
				{ type: "tool", name: "bash", state: { status: "error", input: { command: "npm test" }, error: { message: "exit 1" } } },
			],
		},
	];
	const out = condenseMessages(msgs);
	assert.match(out, /USER: fix the bug/);
	assert.match(out, /· read \/a\/b\.ts → ok/);
	assert.match(out, /· bash npm test → error: exit 1/);
	assert.doesNotMatch(out, /secret thoughts/);
	const long = Array.from({ length: 50 }, (_, i): Message => ({ id: `m${i}`, type: "user", text: "x".repeat(1000) }));
	const capped = condenseMessages(long, 5000);
	assert.ok(capped.length < 5200);
	assert.match(capped, /earlier lines left out/);
});

/** Runs the model's tool calls against a core whose bot has the openchamber tools; returns each result's text. */
async function runTools(settingsPath: string, calls: [string, Record<string, unknown>][], bot: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }[]> {
	const { dir, cleanup } = await tempDir();
	const { models, faux } = fauxModels();
	const config = testConfig(dir, [{ name: "oc", default: true, instructions: "x", tools: ["openchamber"], approvals: { mode: "off" }, ...bot }]);
	const core = await testCore(dir, { models, config, features: (late) => [openchamberFeature(late, { settingsPath })] });
	try {
		const s = await core.sessions.create("oc");
		const c = collect(core.hub, s.id);
		faux.setResponses([...calls.map(([name, args]) => fauxAssistantMessage([fauxToolCall(name, args as never)], { stopReason: "toolUse" })), fauxAssistantMessage([fauxText("done")])]);
		await core.sessions.submit(s.id, "go");
		await c.until((e) => e.type === "run.finished");
		return (c.events.filter((e) => e.type === "tool.finished") as { resultText: string; isError: boolean }[]).map((e) => ({ text: e.resultText, isError: e.isError }));
	} finally {
		await core.close();
		await cleanup();
	}
}

const session = (id: string, title: string, directory: string, extra = {}) => ({ id, title, location: { directory }, time: { created: 1, updated: 1792346855799 }, model: { providerID: "p", id: "m" }, agent: "build", ...extra });

test("oc_sessions lists threads with status; oc_read pages back to the requested turns; the token never shows", async () => {
	const { dir, cleanup } = await tempDir();
	const user = (i: number): Message => ({ id: `u${i}`, type: "user", text: `question ${i}` });
	const asst = (i: number): Message => ({ id: `a${i}`, type: "assistant", content: [{ type: "text", text: `answer ${i}` }, { type: "tool", name: "bash", state: { status: "completed", input: { command: `echo ${i}` } } }] });
	// Newest first, two messages per page, so three turns need two pages.
	const pages: Record<string, { data: Message[]; cursor: { next?: string } }> = {
		first: { data: [asst(4), user(4), asst(3), user(3)], cursor: { next: "p2" } },
		p2: { data: [asst(2), user(2), asst(1), user(1)], cursor: {} },
	};
	const fake = await fakeServer({
		"GET /api/session": (s) => ({ data: [session("ses_a1", "Fix login", "/w/a"), session("ses_b2", "Docs", "/w/b")], q: s.url }),
		"GET /api/session/active": () => ({ data: { ses_a1: { type: "running" } } }),
		"GET /api/session/ses_a1": () => ({ data: session("ses_a1", "Fix login", "/w/a") }),
		"GET /api/session/ses_a1/message": (s) => pages[new URL(s.url, "http://x").searchParams.get("cursor") ?? "first"],
	});
	try {
		const settingsPath = await settingsFile(dir, fake.port);
		const [list, readOut, bad] = await runTools(settingsPath, [["oc_sessions", {}], ["oc_read", { session: "ses_a1", turns: 3 }], ["oc_read", { session: "../x" }]]);
		assert.match(list!.text, /ses_a1 "Fix login" \/w\/a RUNNING/);
		assert.match(list!.text, /ses_b2 "Docs" \/w\/b idle/);
		assert.match(fake.seen.find((s) => s.url.startsWith("/api/session?"))!.url, /parentID=null/);
		assert.match(readOut!.text, /Thread "Fix login"/);
		assert.match(readOut!.text, /USER: question 2[\s\S]*ASSISTANT: answer 2[\s\S]*USER: question 4/);
		assert.doesNotMatch(readOut!.text, /question 1/);
		assert.match(readOut!.text, /earlier turns not shown/);
		assert.equal(bad!.isError, true);
		assert.ok(!JSON.stringify([list, readOut, bad]).includes(TOKEN));
		const second = fake.seen.filter((s) => s.url.includes("/message"))[1]!.url;
		assert.match(second, /cursor=p2/);
		assert.doesNotMatch(second, /order=/, "a cursor carries its own order");
	} finally {
		fake.close();
		await cleanup();
	}
});

test("oc_waiting finds permissions and forms across folders and names the thread", async () => {
	const { dir, cleanup } = await tempDir();
	const fake = await fakeServer({
		"GET /api/session": () => ({ data: [session("ses_a1", "Fix login", "/w/a"), session("ses_b2", "Docs", "/w/b")] }),
		"GET /api/session/active": () => ({ data: { ses_a1: { type: "running" } } }),
		"GET /api/permission/request": (s) => (decodeURIComponent(s.url).includes("location[directory]=/w/b") ? { data: [{ id: "per_1", sessionID: "ses_b2", action: "bash", resources: ["rm -rf build"], message: "wants to run a command" }] } : { data: [] }),
		"GET /api/session/ses_a1/permission": () => ({ data: [] }),
		"GET /api/session/ses_b2/permission": () => ({ data: [{ id: "per_1", sessionID: "ses_b2", action: "bash", resources: ["rm -rf build"] }] }),
		"GET /api/session/ses_a1/form": () => ({ data: [{ id: "frm_9", sessionID: "ses_a1", title: "Which database?", fields: [{ key: "db", type: "string", required: true, options: [{ value: "pg", label: "Postgres" }] }] }] }),
		"GET /api/session/ses_b2/form": () => ({ data: [] }),
	});
	try {
		const [out] = await runTools(await settingsFile(dir, fake.port), [["oc_waiting", {}]]);
		const lines = out!.text.split("\n");
		assert.equal(lines.filter((l) => l.startsWith("PERMISSION")).length, 1, "the same request found twice is listed once");
		assert.match(out!.text, /PERMISSION request=per_1 session=ses_b2 thread="Docs": wants to bash on rm -rf build/);
		assert.match(out!.text, /QUESTION form=frm_9 session=ses_a1 thread="Fix login": Which database\?/);
		assert.match(out!.text, /db .*\[string, required\] options: pg \(Postgres\)/);
		assert.ok(fake.seen.some((s) => decodeURIComponent(s.url).includes("location[directory]=/w/a")), "asked per folder");
	} finally {
		fake.close();
		await cleanup();
	}
});

test("oc_diff spans the whole thread (or its latest turn), summarises files and returns one patch on request", async () => {
	const { dir, cleanup } = await tempDir();
	const fake = await fakeServer({
		"GET /api/session/ses_a1/diff": () => ({ data: [{ file: "a.ts", patch: "@@ -1 +1 @@\n-x\n+y", additions: 1, deletions: 1, status: "modified" }] }),
		"GET /api/session/ses_a1/message": (s) =>
			s.url.includes("order=asc") ? { data: [{ id: "msg_u1", type: "user" }], cursor: {} } : { data: [{ id: "msg_a3", type: "assistant" }, { id: "msg_u3", type: "user" }], cursor: {} },
	});
	try {
		const [sum, patch, missing, last] = await runTools(await settingsFile(dir, fake.port), [
			["oc_diff", { session: "ses_a1" }],
			["oc_diff", { session: "ses_a1", file: "a.ts" }],
			["oc_diff", { session: "ses_a1", file: "zzz" }],
			["oc_diff", { session: "ses_a1", last_turn: true }],
		]);
		assert.match(sum!.text, /modified a\.ts \+1 −1/);
		assert.match(patch!.text, /\+y/);
		assert.equal(missing!.isError, true);
		assert.match(last!.text, /a\.ts/);
		const diffs = fake.seen.filter((s) => s.url.includes("/diff")).map((s) => s.url.split("?")[1]);
		assert.equal(diffs[0], "from=msg_u1&to=msg_u3");
		assert.equal(diffs[3], "from=msg_u3&to=msg_u3");
	} finally {
		fake.close();
		await cleanup();
	}
});

test("oc_approve posts the decision for a waiting request and refuses one that is not in that thread", async () => {
	const { dir, cleanup } = await tempDir();
	const fake = await fakeServer({
		"GET /api/session/ses_a1": () => ({ data: session("ses_a1", "Fix login", "/w/a") }),
		"GET /api/session/ses_a1/permission": () => ({ data: [{ id: "per_1", sessionID: "ses_a1", action: "bash", resources: ["npm test"] }] }),
		"POST /api/session/ses_a1/permission/per_1/reply": () => undefined,
		"POST /api/session/ses_a1/permission/per_2/reply": () => undefined,
	});
	try {
		const [ok, rej, other, always] = await runTools(await settingsFile(dir, fake.port), [
			["oc_approve", { session: "ses_a1", request: "per_1", decision: "once" }],
			["oc_approve", { session: "ses_a1", request: "per_1", decision: "reject", reason: "not now" }],
			["oc_approve", { session: "ses_a1", request: "per_2", decision: "once" }],
			["oc_approve", { session: "ses_a1", request: "per_1", decision: "always" }],
		]);
		assert.match(ok!.text, /Allowed once: bash on npm test in "Fix login"/);
		assert.match(rej!.text, /Rejected/);
		assert.equal(other!.isError, true);
		assert.match(other!.text, /no waiting permission request per_2/);
		assert.equal(always!.isError, true, "the schema has no always");
		const posts = fake.seen.filter((s) => s.method === "POST");
		assert.deepEqual(posts.map((p) => p.body), [{ decision: "once" }, { decision: "reject", message: "not now" }]);
		assert.ok(posts.every((p) => p.url === "/api/session/ses_a1/permission/per_1/reply"));
	} finally {
		fake.close();
		await cleanup();
	}
});

test("oc_answer, oc_stop and oc_prompt post what they say", async () => {
	const { dir, cleanup } = await tempDir();
	const fake = await fakeServer({
		"GET /api/session/ses_a1": () => ({ data: session("ses_a1", "Fix login", "/w/a") }),
		"GET /api/session/ses_a1/form": () => ({ data: [{ id: "frm_9", sessionID: "ses_a1", title: "Which database?", fields: [] }] }),
		"POST /api/session/ses_a1/form/frm_9/reply": () => undefined,
		"POST /api/session/ses_a1/interrupt": () => ({ interrupted: true }),
		"POST /api/session/ses_a1/prompt": () => undefined,
	});
	try {
		const out = await runTools(await settingsFile(dir, fake.port), [
			["oc_answer", { session: "ses_a1", form: "frm_9", answers: { db: "pg", tags: ["a", "b"] } }],
			["oc_answer", { session: "ses_a1", form: "frm_1", answers: {} }],
			["oc_stop", { session: "ses_a1" }],
			["oc_prompt", { session: "ses_a1", text: "carry on" }],
		]);
		assert.match(out[0]!.text, /Answered "Which database\?" in "Fix login"/);
		assert.equal(out[1]!.isError, true);
		assert.match(out[2]!.text, /Interrupted "Fix login"/);
		assert.match(out[3]!.text, /Sent to "Fix login": carry on/);
		const bodies = fake.seen.filter((s) => s.method === "POST").map((p) => [p.url, p.body]);
		assert.deepEqual(bodies, [
			["/api/session/ses_a1/form/frm_9/reply", { answer: { db: "pg", tags: ["a", "b"] } }],
			["/api/session/ses_a1/interrupt", {}],
			["/api/session/ses_a1/prompt", { text: "carry on" }],
		]);
	} finally {
		fake.close();
		await cleanup();
	}
});

test("oc_start refuses without a model, and sends the configured model and agent", async () => {
	const { dir, cleanup } = await tempDir();
	const fake = await fakeServer({
		"POST /api/session": () => ({ data: session("ses_new", "Try it", dir) }),
		"POST /api/session/ses_new/prompt": () => undefined,
	});
	try {
		const settingsPath = await settingsFile(dir, fake.port);
		const [none] = await runTools(settingsPath, [["oc_start", { directory: dir, title: "Try it", prompt: "do it" }]]);
		assert.equal(none!.isError, true);
		assert.match(none!.text, /no model/);
		assert.equal(fake.seen.length, 0, "nothing was sent");
		const [ok, nodir] = await runTools(
			settingsPath,
			[["oc_start", { directory: dir, title: "Try it", prompt: "do it" }], ["oc_start", { directory: join(dir, "missing"), title: "x", prompt: "y", model: "a/b" }]],
			{ openchamber: { model: "claude-code/claude-opus-5-5[1m]", agent: "build" } },
		);
		assert.match(ok!.text, /Started "Try it" \(ses_new\)/);
		assert.equal(nodir!.isError, true);
		const [create, send] = fake.seen.filter((s) => s.method === "POST");
		assert.deepEqual(create!.body, { title: "Try it", location: { directory: dir }, model: { providerID: "claude-code", id: "claude-opus-5-5[1m]" }, agent: "build" });
		assert.deepEqual(send!.body, { text: "do it" });
	} finally {
		fake.close();
		await cleanup();
	}
});

test("oc_start follows the defaults picked in OpenChamber, read at each start", async () => {
	const { dir, cleanup } = await tempDir();
	const fake = await fakeServer({
		"POST /api/session": () => ({ data: session("ses_new", "Try it", dir) }),
		"POST /api/session/ses_new/prompt": () => undefined,
	});
	try {
		const settingsPath = join(dir, "settings.json");
		const write = (extra: object) => writeFile(settingsPath, JSON.stringify({ desktopLocalPort: fake.port, desktopLocalClientToken: TOKEN, ...extra }));
		await write({ defaultModel: "claude-code/claude-opus-5-5[1m]", defaultVariant: "medium", defaultAgent: "build" });
		const [ok] = await runTools(settingsPath, [["oc_start", { directory: dir, title: "Try it", prompt: "do it" }]]);
		assert.match(ok!.text, /claude-opus-5-5\[1m\] \(medium\), agent build/);
		// The user changes the default in OpenChamber: the next thread follows it.
		await write({ defaultModel: "claude-code/claude-sonnet-5-5[1m]", defaultVariant: "high", defaultAgent: "build" });
		// A model named in the call does not take OpenChamber's variant, which belongs to its default model.
		await runTools(settingsPath, [["oc_start", { directory: dir, title: "Try it", prompt: "do it" }], ["oc_start", { directory: dir, title: "Try it", prompt: "do it", model: "openai/gpt-6-sol" }]]);
		const creates = fake.seen.filter((s) => s.method === "POST" && s.url === "/api/session").map((s) => (s.body as { model: unknown }).model);
		assert.deepEqual(creates, [
			{ providerID: "claude-code", id: "claude-opus-5-5[1m]", variant: "medium" },
			{ providerID: "claude-code", id: "claude-sonnet-5-5[1m]", variant: "high" },
			{ providerID: "openai", id: "gpt-6-sol" },
		]);
	} finally {
		fake.close();
		await cleanup();
	}
});
