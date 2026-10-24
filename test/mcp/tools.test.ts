// MCP tools in bots (src/tools/mcp.ts): the `mcp:<server>` group, calls through a real chat with the faux
// model, approvals for tools that are not read-only, what the model is told when a server is offline or a
// call may have run, tool lists that change, deferred exposure with tool_search, redaction, and a restart
// in the middle of a call.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { BotConfig, McpServerConfig } from "../../src/config.ts";
import { decide } from "../../src/core/policy.ts";
import type { SessionEvent } from "../../src/core/events.ts";
import { registerSecret } from "../../src/log.ts";
import { collect, fauxModels, mcpServerConfig, tempDir, testConfig, testCore } from "../helpers.ts";
import { FakeMcpServer } from "./server.ts";

const FAST = { connectBudgetMs: 2000, probeBudgetMs: 1500, probeGapMs: 0, pingTimeoutMs: 500, backoffBaseMs: 20, backoffCapMs: 80 };

const TOOLS = [
	{ name: "list_events", description: "List calendar events", inputSchema: { type: "object", properties: { day: { type: "string" } } } },
	{ name: "add_event", description: "Add an event", inputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] } },
];

type Finished = Extract<SessionEvent, { type: "tool.finished" }>;

async function setup(server: (url: string) => McpServerConfig, bots?: BotConfig[], fake?: FakeMcpServer, tuning: Record<string, number> = {}) {
	const t = await tempDir();
	const mcp = fake ?? (await FakeMcpServer.start(TOOLS));
	const { models, faux } = fauxModels();
	const config = testConfig(t.dir, bots ?? [{ name: "main", default: true, instructions: "test", tools: ["memory", "mcp:cal"] }, { name: "other", instructions: "test", tools: ["memory"] }], { mcp: { servers: [server(mcp.url)] } });
	const core = await testCore(t.dir, { models, config, mcpTuning: { ...FAST, ...tuning } });
	await online(core, "cal");
	return {
		core,
		faux,
		mcp,
		config,
		dir: t.dir,
		cleanup: async () => {
			await core.close();
			await mcp.stop();
			await t.cleanup();
		},
	};
}

function online(core: Awaited<ReturnType<typeof testCore>>, name: string): Promise<void> {
	return new Promise((resolve) => {
		const check = () => (core.mcp.status().find((s) => s.name === name)?.state === "online" ? resolve() : undefined);
		check();
		core.mcp.onStateChanged(check);
	});
}

async function run(s: Awaited<ReturnType<typeof setup>>, bot: string, steps: ReturnType<typeof fauxAssistantMessage>[]) {
	const session = await s.core.sessions.create(bot);
	const c = collect(s.core.hub, session.id);
	s.faux.setResponses([...steps, fauxAssistantMessage([fauxText("done")])]);
	await s.core.sessions.submit(session.id, "go");
	await c.until((e) => e.type === "run.finished", 10000);
	return { session, finished: c.events.filter((e): e is Finished => e.type === "tool.finished"), events: c.events };
}

const call = (name: string, args: Record<string, string> = {}) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });

test("a bot with mcp:cal calls its tools; a bot without the group has none; the prompt names the server", async () => {
	const s = await setup((url) => mcpServerConfig("cal", url, { description: "The owner's calendar", tools: { include: ["*"], exclude: [], readOnly: ["list_*"] } }));
	try {
		assert.deepEqual(s.core.toolGroups.get("mcp:cal")?.map((t) => t.name), ["mcp__cal__list_events", "mcp__cal__add_event"]);
		const r = await run(s, "main", [call("mcp__cal__list_events", { day: "today" })]);
		assert.equal(r.finished[0]?.isError, false);
		assert.equal(r.finished[0]?.resultText, "list_events ok");
		assert.deepEqual(s.mcp.calls.map((c) => [c.name, c.args]), [["list_events", { day: "today" }]]);
		const agent = await s.core.engine.agentModel(s.core.sessions.require(r.session.id).conversation_id);
		assert.ok(agent.tools.includes("mcp__cal__add_event"));
		const prompt = await s.core.deps.promptParts.at(-1)!(s.core.bots.require("main"), r.session.id);
		assert.match(prompt ?? "", /- cal: "The owner's calendar"\./);

		const other = await run(s, "other", [call("mcp__cal__list_events")]);
		assert.equal(other.finished[0]?.isError, true);
		assert.match(other.finished[0]?.resultText ?? "", /not available/);
		assert.equal(s.mcp.calls.length, 1, "a bot without the group never reaches the server");
		assert.equal(await s.core.deps.promptParts.at(-1)!(s.core.bots.require("other"), ""), undefined);
	} finally {
		await s.cleanup();
	}
});

test("a server's structured result is kept with the call for clients, beside the text the model gets, with no handle when the app has no card for it", async () => {
	const s = await setup((url) => mcpServerConfig("cal", url, { tools: { include: ["*"], exclude: [], readOnly: ["list_*"] } }));
	try {
		s.mcp.behavior.set("list_events", { text: "2 events", structured: { events: [{ title: "Dentist" }, { title: "Lunch" }] } });
		const r = await run(s, "main", [call("mcp__cal__list_events", { day: "today" })]);
		assert.equal(r.finished[0]?.resultText, "2 events");
		const { turns } = await s.core.sessions.turns(r.session.id);
		const item = turns.at(-1)!.items.find((i) => i.type === "tool");
		assert.ok(item?.type === "tool");
		assert.deepEqual(item.json, { events: [{ title: "Dentist" }, { title: "Lunch" }] });
		assert.equal(item.result, "2 events");
	} finally {
		await s.cleanup();
	}
});

test("a tool that is not read-only asks first (and runs once approved); a read-only one does not", async () => {
	const s = await setup((url) => mcpServerConfig("cal", url, { tools: { include: ["*"], exclude: [], readOnly: ["list_events"] } }));
	try {
		const session = await s.core.sessions.create("main");
		const c = collect(s.core.hub, session.id);
		s.faux.setResponses([call("mcp__cal__list_events"), call("mcp__cal__add_event", { title: "Dentist" }), fauxAssistantMessage([fauxText("done")])]);
		await s.core.sessions.submit(session.id, "add it");
		const asked = await c.until((e) => e.type === "approval.requested", 10000);
		if (asked.type !== "approval.requested" || asked.request.kind !== "approval") return assert.fail("an approval was asked");
		assert.equal(asked.request.toolName, "mcp__cal__add_event");
		assert.match(asked.request.description, /add_event on the MCP server "cal"/);
		assert.match(asked.request.command, /Dentist/, "the card shows the arguments");
		assert.deepEqual(s.mcp.calls.map((x) => x.name), ["list_events"], "nothing sent before the answer");
		s.core.approvals.answer(asked.request.requestId, "once");
		await c.until((e) => e.type === "run.finished", 10000);
		assert.deepEqual(s.mcp.calls.map((x) => x.name), ["list_events", "add_event"]);
		assert.equal(c.events.filter((e) => e.type === "approval.requested").length, 1);
	} finally {
		await s.cleanup();
	}
});

test("policy: MCP tools by approval mode, trusted bots, the server's hints and glob rules", () => {
	const bot = (mode: "smart" | "manual" | "off", extra: Record<string, unknown> = {}) => ({ name: "b", displayName: "B", trusted: false, approvals: { mode, ask: [], deny: [], allow: [] }, ...extra }) as unknown as Parameters<typeof decide>[1]["bot"];
	const lookup = (name: string) => (name === "mcp__cal__add" ? { server: "cal", tool: "add", readOnly: false } : name === "mcp__cal__list" ? { server: "cal", tool: "list", readOnly: true } : undefined);
	const ctx = (b: ReturnType<typeof bot>) => ({ bot: b, sessionRules: [], botRules: [], yolo: false, mcpTool: lookup });
	const add = { name: "mcp__cal__add", arguments: { title: "x" } };
	const list = { name: "mcp__cal__list", arguments: {} };
	assert.equal(decide(list, ctx(bot("smart"))).action, "allow");
	assert.equal(decide(list, ctx(bot("manual"))).action, "allow");
	const smart = decide(add, ctx(bot("smart")));
	assert.equal(smart.action, "ask");
	assert.equal(smart.reviewable, true, "Jev may answer in smart mode");
	assert.equal(smart.patternKey, "tool:mcp__cal__add");
	assert.equal(decide(add, ctx(bot("manual"))).reviewable, false);
	assert.equal(decide(add, ctx(bot("off"))).action, "allow");
	assert.equal(decide(add, ctx(bot("smart", { trusted: true }))).action, "ask", "trusted bots ask too");
	assert.equal(decide(add, { ...ctx(bot("smart")), botRules: ["tool:mcp__cal__add"] }).action, "allow", "an always answer covers that tool");
	assert.equal(decide(add, ctx(bot("smart", { approvals: { mode: "smart", ask: [], deny: [], allow: ["tool:mcp__cal__*"] } }))).action, "allow");
	assert.equal(decide(add, ctx(bot("smart", { approvals: { mode: "off", ask: [], deny: ["tool:mcp__*"], allow: [] } }))).action, "deny");
	assert.equal(decide({ name: "mcp__cal_x__add", arguments: {} }, ctx(bot("smart", { approvals: { mode: "smart", ask: [], deny: [], allow: ["tool:mcp__cal__*"] } }))).action, "allow", "an unknown tool is not an MCP tool here");
});

test("offline server: its tools stay declared, a call says it was not sent, and the run goes on with other tools", async () => {
	// preflightIdleMs 0: the call pings first, so the server's absence is found before anything is sent.
	const s = await setup((url) => mcpServerConfig("cal", url, { tools: { include: ["*"], exclude: [], readOnly: ["list_*"] } }), undefined, undefined, { preflightIdleMs: 0 });
	try {
		await s.mcp.stop();
		const r = await run(s, "main", [call("mcp__cal__list_events"), call("remember", { text: "the calendar was offline" })]);
		assert.equal(r.finished[0]?.isError, true);
		assert.match(r.finished[0]?.resultText ?? "", /"cal" is offline.*The call was not sent, so nothing changed/s);
		assert.equal(r.finished[1]?.isError, false, "another tool in the same run still works");
		assert.ok(s.core.toolGroups.get("mcp:cal")?.some((t) => t.name === "mcp__cal__list_events"), "still declared");
		const agent = await s.core.engine.agentModel(s.core.sessions.require(r.session.id).conversation_id);
		assert.ok(agent.tools.includes("mcp__cal__list_events"));
	} finally {
		await s.cleanup();
	}
});

test("a write whose connection drops may have run: the model is told so, and it is never sent again", async () => {
	const s = await setup((url) => mcpServerConfig("cal", url, { tools: { include: ["*"], exclude: [], readOnly: ["list_*"] } }), [{ name: "main", default: true, instructions: "t", tools: ["mcp:cal"], approvals: { mode: "off" } }]);
	try {
		s.mcp.behavior.set("add_event", { drop: true });
		s.mcp.behavior.set("list_events", { drop: true });
		const r = await run(s, "main", [call("mcp__cal__add_event", { title: "x" }), call("mcp__cal__list_events")]);
		assert.equal(r.finished[0]?.isError, true);
		assert.match(r.finished[0]?.resultText ?? "", /may or may not have run\. Do not repeat it blindly/);
		assert.match(r.finished[1]?.resultText ?? "", /only reads, so nothing changed either way; you may try again/);
		assert.equal(s.mcp.callsOf("add_event").length, 1);
		await online(s.core, "cal");
		assert.equal(s.mcp.callsOf("add_event").length, 1, "not replayed after reconnecting");
	} finally {
		await s.cleanup();
	}
});

test("a server's changed tool list reaches chats: new tools are callable, removed ones are not", async () => {
	const s = await setup((url) => mcpServerConfig("cal", url), [{ name: "main", default: true, instructions: "t", tools: ["mcp:cal"], approvals: { mode: "off" } }]);
	try {
		const changed = new Promise<void>((resolve) => s.core.mcp.onToolsChanged(() => resolve()));
		await s.core.mcp.reconnect("cal");
		s.mcp.tools = [TOOLS[0]!, { name: "find_contact", description: "Find a contact" }];
		await s.core.mcp.refresh("cal");
		await changed;
		assert.deepEqual(s.core.toolGroups.get("mcp:cal")?.map((t) => t.name), ["mcp__cal__list_events", "mcp__cal__find_contact"]);
		const r = await run(s, "main", [call("mcp__cal__find_contact"), call("mcp__cal__add_event", { title: "x" })]);
		assert.equal(r.finished[0]?.resultText, "find_contact ok");
		assert.equal(r.finished[1]?.isError, true);
		assert.match(r.finished[1]?.resultText ?? "", /not available/);
		assert.equal(s.mcp.callsOf("add_event").length, 0);
	} finally {
		await s.cleanup();
	}
});

test("include/exclude narrow what bots get; a disabled server declares nothing but its group stays valid", async () => {
	const s = await setup((url) => mcpServerConfig("cal", url, { tools: { include: ["*"], exclude: ["add_*"], readOnly: [] } }));
	try {
		assert.deepEqual(s.core.toolGroups.get("mcp:cal")?.map((t) => t.name), ["mcp__cal__list_events"]);
		// What Settings does after an edit (this test's config has no file to write).
		s.core.config.mcp.servers = [{ ...s.core.config.mcp.servers[0]!, enabled: false }];
		s.core.mcp.apply();
		s.core.mcpTools.republish();
		assert.deepEqual(s.core.toolGroups.get("mcp:cal"), []);
		assert.equal(s.core.mcp.status()[0]?.state, "disabled");
		const r = await run(s, "main", [call("mcp__cal__list_events")]);
		assert.match(r.finished[0]?.resultText ?? "", /not available/);
		assert.match((await s.core.deps.promptParts.at(-1)!(s.core.bots.require("main"), "")) ?? "", /turned off by the owner/);
	} finally {
		await s.cleanup();
	}
});

test("deferred exposure: the tools are found with tool_search and then called", async () => {
	const s = await setup((url) => mcpServerConfig("cal", url, { exposure: "deferred", tools: { include: ["*"], exclude: [], readOnly: ["list_*"] } }));
	try {
		const session = await s.core.sessions.create("main");
		const conv = s.core.sessions.require(session.id).conversation_id;
		const c = collect(s.core.hub, session.id);
		s.faux.setResponses([call("tool_search", { query: "calendar events list" }), call("mcp__cal__list_events"), fauxAssistantMessage([fauxText("done")])]);
		await s.core.sessions.submit(session.id, "what's on today?");
		await c.until((e) => e.type === "run.finished", 10000);
		const finished = c.events.filter((e): e is Finished => e.type === "tool.finished");
		assert.match(finished[0]?.resultText ?? "", /mcp__cal__list_events/);
		assert.equal(finished[1]?.resultText, "list_events ok");
		const agent = await s.core.engine.agentModel(conv);
		assert.ok(agent.tools.includes("tool_search"));
		const prompt = await s.core.deps.promptParts.at(-1)!(s.core.bots.require("main"), session.id);
		assert.match(prompt ?? "", /find them with tool_search/);
	} finally {
		await s.cleanup();
	}
});

test("a key the server echoes back is redacted from the result and the transcript", async () => {
	const key = "mcp-key-0123456789abcdef";
	process.env.TEST_MCP_ECHO_KEY = key;
	registerSecret(key);
	const fake = await FakeMcpServer.start(TOOLS);
	fake.behavior.set("list_events", { text: `your key is ${key}` });
	const s = await setup((url) => mcpServerConfig("cal", url, { headers: { "X-Api-Key": "{{secret:TEST_MCP_ECHO_KEY}}" }, tools: { include: ["*"], exclude: [], readOnly: ["*"] } }), undefined, fake);
	try {
		assert.equal(fake.lastHeaders["x-api-key"], key);
		const r = await run(s, "main", [call("mcp__cal__list_events")]);
		assert.equal(r.finished[0]?.resultText, "your key is [redacted]");
		assert.ok(!JSON.stringify(await s.core.sessions.rows(r.session.id)).includes(key));
		assert.deepEqual(
			s.core.secrets.list().find((x) => x.name === "TEST_MCP_ECHO_KEY")?.usedBy,
			["mcp:cal"],
		);
	} finally {
		delete process.env.TEST_MCP_ECHO_KEY;
		await s.cleanup();
	}
});

test("restart mid-call: a write is not run again (the model hears it was interrupted); a read-only call is", async () => {
	const t = await tempDir();
	const fake = await FakeMcpServer.start(TOOLS);
	try {
		for (const [tool, readOnly] of [["add_event", false], ["list_events", true]] as const) {
			fake.calls.length = 0;
			fake.behavior.set(tool, { hang: true });
			const { models, faux } = fauxModels();
			const config = testConfig(t.dir, [{ name: "main", default: true, instructions: "t", tools: ["mcp:cal"], approvals: { mode: "off" } }], { mcp: { servers: [mcpServerConfig("cal", fake.url, { tools: { include: ["*"], exclude: [], readOnly: readOnly ? [tool] : [] } })] } });
			let core = await testCore(t.dir, { models, config, mcpTuning: FAST });
			await online(core, "cal");
			const session = await core.sessions.create("main");
			faux.setResponses([call(`mcp__cal__${tool}`, { title: "x" })]);
			const arrived = fake.next("call");
			await core.sessions.submit(session.id, "go");
			await arrived;
			await core.close();

			fake.behavior.set(tool, { text: `${tool} after restart` });
			const again = fauxModels();
			again.faux.setResponses([fauxAssistantMessage([fauxText("done")])]);
			core = await testCore(t.dir, { models: again.models, config, mcpTuning: FAST });
			await core.engine.waitForIdle(core.sessions.require(session.id).conversation_id);
			const rows = JSON.stringify(await core.sessions.rows(session.id));
			if (readOnly) {
				assert.equal(fake.callsOf(tool).length, 2, "a read-only call runs again after the restart");
				assert.match(rows, /list_events after restart/);
			} else {
				assert.equal(fake.callsOf(tool).length, 1, "a write is never sent twice");
				assert.match(rows, /interrupted/i);
			}
			await core.close();
		}
	} finally {
		await fake.stop();
		await t.cleanup();
	}
});

test("a call that hangs holds up only its own chat: another bot answers meanwhile", async () => {
	const s = await setup((url) => mcpServerConfig("cal", url, { timeoutS: 30 }), [
		{ name: "main", default: true, instructions: "t", tools: ["mcp:cal"], approvals: { mode: "off" } },
		{ name: "other", instructions: "t", tools: ["memory"] },
	]);
	try {
		s.mcp.behavior.set("add_event", { hang: true });
		const stuck = await s.core.sessions.create("main");
		const arrived = s.mcp.next("call");
		s.faux.setResponses([call("mcp__cal__add_event", { title: "x" })]);
		await s.core.sessions.submit(stuck.id, "add");
		await arrived;

		const free = await s.core.sessions.create("other");
		const c = collect(s.core.hub, free.id);
		s.faux.setResponses([fauxAssistantMessage([fauxText("hello from other")])]);
		await s.core.sessions.submit(free.id, "hi");
		const done = await c.until((e) => e.type === "run.finished", 5000);
		assert.ok(done.type === "run.finished" && done.text.includes("hello from other"));
		assert.equal(s.core.sessions.isRunning(stuck.id), true, "the MCP call is still waiting");
		await s.core.sessions.interrupt(stuck.id);
	} finally {
		await s.cleanup();
	}
});
