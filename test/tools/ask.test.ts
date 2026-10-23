// Questions (src/tools/ask.ts, src/core/questions.ts): the bot's `ask` waits on the approvals path, in Waiting for
// You and the chat's snapshot, until the owner answers by values or by typing in the chat, dismisses it, stops
// the run, or the timeout passes; the answer is the call's result and the bot carries on in the same turn; the
// call is a `question` card item live and in history; a restart asks again; a member's bot's question is asked
// on the gateway the app is connected to; and a question notifies.
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createModels, type FauxResponseFactory, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { Core } from "../../src/app.ts";
import { type GatewayServer, startServer } from "../../src/server.ts";
import { type ApiEvent, ApiSocketClient, http } from "../api/client.ts";
import { FakeApns } from "../notify/fake-apns.ts";
import { collect, tempDir, testConfig, testCore } from "../helpers.ts";

const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }], tokensPerSecond: 400 });
const models = createModels();
models.setProvider(faux.provider);
let core: Core;
let server: GatewayServer;
let apple: FakeApns;
let cleanup: () => Promise<void>;

before(async () => {
	process.env.APNS_ASK_TEST_KEY = Buffer.from(generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" }) as string).toString("base64");
	apple = await FakeApns.start();
	const t = await tempDir();
	cleanup = t.cleanup;
	const config = testConfig(t.dir, [{ name: "main", displayName: "Main", default: true, instructions: "test", tools: [] }], { apns: { keyId: "KEY1234567", teamId: "TEAM123456", keyEnv: "APNS_ASK_TEST_KEY" } });
	core = await testCore(t.dir, { models, config, apnsHosts: { production: apple.url, development: apple.url }, pushSettleMs: 10 });
	server = await startServer(core, { host: "127.0.0.1", port: 0, federationPort: null });
	core.devices.register({ token: "d4".repeat(32), platform: "ios", environment: "development", bundleId: "com.example.nhermes", name: "Phone" });
});

after(async () => {
	await server.close();
	await core.close();
	await apple.close();
	delete process.env.APNS_ASK_TEST_KEY;
	await cleanup();
});

const api = () => http(server.port);
const QUESTIONS = [
	{ id: "cuisine", prompt: "Which cuisine?", kind: "single", options: [{ id: "thai", label: "Thai" }, { id: "pizza", label: "Pizza", detail: "the place on Main St" }], other: true },
	{ id: "time", prompt: "What time?", kind: "text" },
];
const askCall = (id = "call_ask", questions: unknown = QUESTIONS) => fauxAssistantMessage([fauxText("Let me check with you."), fauxToolCall("ask", { caption: "Dinner plans", questions } as never, { id })], { stopReason: "toolUse" });
/** The model's second reply: what the `ask` result said, so a test can read what the model was told. */
const told: string[] = [];
const replyWithAnswer: FauxResponseFactory = (context) => {
	const last = context.messages.at(-1) as { role: string; content: { type: string; text?: string }[] };
	const text = last.role === "toolResult" ? last.content.map((b) => b.text ?? "").join("") : "";
	told.push(text);
	return fauxAssistantMessage([fauxText(`Planned. (${text.split("\n")[0]})`)]);
};

type Approval = { id: string; sessionId: string; botId: string; kind: string; toolName: string; description: string; caption: string; questions: unknown[]; choices: string[]; toolCallId: string | null; command?: string };
type Item = { type: string; id: string; kind?: string; caption?: string; data?: { questions: unknown[]; answers: unknown }; name?: string; status?: string; result?: { text: string } };

async function start(c: ApiSocketClient, steps: (ReturnType<typeof fauxAssistantMessage> | FauxResponseFactory)[]) {
	const { session } = await c.call<{ session: { id: string } }>("sessions.create", {});
	await c.call("sessions.subscribe", { id: session.id });
	faux.setResponses(steps);
	told.length = 0;
	await c.call("sessions.submit", { id: session.id, text: "plan dinner" });
	const asked = await c.waitEvent((e) => e.event === "approval.requested" && (e.data.approval as Approval).sessionId === session.id, 10000);
	return { sid: session.id, approval: asked.data.approval as Approval };
}
const finished = (sid: string) => (e: ApiEvent) => e.event === "turn.finished" && e.sessionId === sid;
const lastTurn = async (sid: string) => (await api()<{ items: { status: string; items: Item[] }[] }>(`GET /sessions/${sid}/turns`)).items.at(-1)!;

test("a question waits in Waiting for You and the snapshot; values answer it and the bot carries on in the same turn", async () => {
	const a = await ApiSocketClient.connect(server.port);
	const b = await ApiSocketClient.connect(server.port);
	try {
		const { sid, approval } = await start(a, [askCall(), replyWithAnswer]);
		assert.equal(approval.kind, "question");
		assert.equal(approval.toolName, "ask");
		assert.equal(approval.caption, "Dinner plans");
		assert.equal(approval.description, "Dinner plans");
		assert.deepEqual(approval.questions, QUESTIONS);
		assert.deepEqual(approval.choices, ["answer", "dismiss"]);
		assert.equal(approval.toolCallId, "call_ask");
		assert.equal(approval.command, undefined, "a question carries no command");
		// Another device hears it too, and finds it in Waiting for You and in the chat's snapshot.
		const onB = await b.waitEvent("approval.requested");
		assert.equal((onB.data.approval as Approval).id, approval.id);
		assert.deepEqual((await api()<{ items: { id: string }[] }>("GET /approvals")).items.map((x) => x.id), [approval.id]);
		const snap = await b.call<{ approvals: Approval[]; turns: { items: { items: Item[] }[] } }>("sessions.subscribe", { id: sid });
		assert.deepEqual(snap.approvals.map((x) => [x.id, x.kind]), [[approval.id, "question"]]);
		assert.ok(!snap.turns.items.at(-1)!.items.some((i) => i.id === "call_ask"), "while it waits, the question is the request, not a tool step");
		assert.ok(!a.events.some((e) => e.event === "item.started" && (e.data.item as Item).id === "call_ask"), "no tool step was announced for it");

		// Wrong shapes are refused plainly, and the question keeps waiting.
		for (const bad of [{ values: { nope: "x" } }, { values: { time: 5 } }, { values: {} }, { values: { cuisine: ["thai"] } }, { choice: "once" }, {}]) {
			await assert.rejects(a.call("approvals.answer", { id: approval.id, ...bad }), (e: { code: string }) => e.code === "invalid_params", JSON.stringify(bad));
		}
		assert.equal(core.approvals.allPending().length, 1);

		await a.call("approvals.answer", { id: approval.id, values: { cuisine: "thai", time: " 7:30 " } });
		const resolved = await b.waitEvent("approval.resolved");
		assert.deepEqual(resolved.data, { id: approval.id, sessionId: sid, choice: "answer", reason: "answered" });
		await assert.rejects(b.call("approvals.answer", { id: approval.id, values: { cuisine: "pizza" } }), (e: { code: string }) => e.code === "approval_not_found", "the first answer wins");
		await a.waitEvent(finished(sid), 10000);
		assert.equal(told[0], "The owner answered:\nWhich cuisine? Thai\nWhat time? \"7:30\"");

		// Live and in history: the answered card where the call was, then the reply, all in one turn.
		const card = { type: "card", id: "call_ask", kind: "question", caption: "Dinner plans", data: { questions: QUESTIONS, answers: { cuisine: "thai", time: "7:30" } } };
		const live = a.events.filter((e) => e.event === "item.finished" && (e.data.item as Item).id === "call_ask").map((e) => e.data.item as Item & { at?: number });
		assert.equal(live.length, 1);
		const { at: _at, ...liveCard } = live[0]!;
		assert.deepEqual(liveCard, card);
		const turn = await lastTurn(sid);
		assert.equal(turn.status, "complete");
		assert.deepEqual(turn.items.map((i) => [i.type, i.id]), [["text", turn.items[0]!.id], ["card", "call_ask"], ["text", turn.items[2]!.id]]);
		const { at: _at2, ...historyCard } = turn.items[1] as Item & { at?: number };
		assert.deepEqual(historyCard, card);
		assert.equal(turn.items[2]!.type === "text" && (turn.items[2] as { text?: string }).text, "Planned. (The owner answered:)");
		// Transcript rows (reports, other tools) read it as its caption, questions and answers.
		const rows = await core.sessions.rows(sid);
		assert.ok(rows.some((r) => r.role === "tool" && r.name === "ask" && r.text === "[Question: Dinner plans]\nWhich cuisine? Thai\nWhat time? \"7:30\""));
	} finally {
		await a.close();
		await b.close();
	}
});

test("dismissed: the bot is told the owner didn't answer, and the card shows no answers", async () => {
	const a = await ApiSocketClient.connect(server.port);
	try {
		const { sid, approval } = await start(a, [askCall(), replyWithAnswer]);
		await a.call("approvals.answer", { id: approval.id, choice: "dismiss" });
		const resolved = await a.waitEvent("approval.resolved");
		assert.deepEqual([resolved.data.choice, resolved.data.reason], ["dismiss", "answered"]);
		await a.waitEvent(finished(sid), 10000);
		assert.match(told[0]!, /^The owner dismissed the question without answering\. Don't ask it again/);
		const card = (await lastTurn(sid)).items.find((i) => i.type === "card")!;
		assert.equal(card.kind, "question");
		assert.equal(card.data?.answers, null);
	} finally {
		await a.close();
	}
});

test("a question nobody answers ends at the question timeout", async () => {
	const a = await ApiSocketClient.connect(server.port);
	const before = core.config.defaults.questionTimeoutS;
	core.config.defaults.questionTimeoutS = 0.2;
	try {
		const { sid } = await start(a, [askCall(), replyWithAnswer]);
		const resolved = await a.waitEvent("approval.resolved", 5000);
		assert.deepEqual([resolved.data.choice, resolved.data.reason], ["dismiss", "timeout"]);
		await a.waitEvent(finished(sid), 10000);
		assert.match(told[0]!, /^The owner didn't answer in time\./);
		assert.equal((await lastTurn(sid)).items.find((i) => i.type === "card")?.data?.answers, null);
	} finally {
		core.config.defaults.questionTimeoutS = before;
		await a.close();
	}
});

test("stopping the run withdraws the question", async () => {
	const a = await ApiSocketClient.connect(server.port);
	try {
		const { sid } = await start(a, [askCall(), fauxAssistantMessage([fauxText("SHOULD NOT RUN")])]);
		await a.call("sessions.interrupt", { id: sid });
		const resolved = await a.waitEvent("approval.resolved");
		assert.deepEqual([resolved.data.choice, resolved.data.reason], ["dismiss", "cancelled"]);
		const done = await a.waitEvent(finished(sid), 10000);
		assert.equal(done.data.status, "interrupted");
		assert.equal(core.approvals.allPending().length, 0);
		assert.ok(!(await lastTurn(sid)).items.some((i) => i.type === "text" && (i as { text?: string }).text === "SHOULD NOT RUN"));
	} finally {
		await a.close();
	}
});

test("words typed in the chat while a question waits answer it, and are not queued as a new message", async () => {
	const a = await ApiSocketClient.connect(server.port);
	try {
		const { sid, approval } = await start(a, [askCall(), replyWithAnswer]);
		const r = await a.call<{ status: string; approvalId: string }>("sessions.submit", { id: sid, text: "around 8, anything but pizza" });
		assert.deepEqual(r, { status: "answered", approvalId: approval.id });
		await a.waitEvent(finished(sid), 10000);
		assert.equal(told[0], "The owner answered:\nWhich cuisine? (no answer)\nWhat time? \"around 8, anything but pizza\"", "the first text question takes the words");
		const turns = (await api()<{ items: { user: unknown }[] }>(`GET /sessions/${sid}/turns`)).items;
		assert.equal(turns.filter((t) => t.user).length, 1, "the words were the answer, not another turn");
		// With no text question, the typed words go to the one that takes the owner's own words, and a question
		// with neither still takes them.
		const choiceOnly = [{ id: "day", prompt: "Which day?", kind: "multiple", options: [{ id: "sat", label: "Saturday" }, { id: "sun", label: "Sunday" }] }];
		const second = await start(a, [askCall("call_ask2", choiceOnly), replyWithAnswer]);
		await assert.rejects(a.call("approvals.answer", { id: second.approval.id, values: { day: ["mon"] } }), (e: { code: string; message: string }) => e.code === "invalid_params" && /"mon" is not an option of "day"/.test(e.message));
		assert.equal((await a.call<{ status: string }>("sessions.submit", { id: second.sid, text: "either" })).status, "answered");
		await a.waitEvent(finished(second.sid), 10000);
		assert.equal(told[0], "The owner answered:\nWhich day? \"either\"");
	} finally {
		await a.close();
	}
});

test("questions the model gets wrong are refused plainly, as a failed step it can fix", async () => {
	const a = await ApiSocketClient.connect(server.port);
	try {
		const { session } = await a.call<{ session: { id: string } }>("sessions.create", {});
		await a.call("sessions.subscribe", { id: session.id });
		const dup = [{ id: "q", prompt: "One?", kind: "text" }, { id: "q", prompt: "Two?", kind: "text" }];
		const noOptions = [{ id: "q", prompt: "Pick", kind: "single" }];
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("ask", { caption: "x", questions: dup } as never, { id: "bad1" }), fauxToolCall("ask", { caption: "x", questions: noOptions } as never, { id: "bad2" }), fauxToolCall("ask", { caption: " ", questions: [{ id: "q", prompt: "P", kind: "text" }] } as never, { id: "bad3" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("ok")]),
		]);
		await a.call("sessions.submit", { id: session.id, text: "ask badly" });
		await a.waitEvent(finished(session.id), 10000);
		const steps = (await lastTurn(session.id)).items.filter((i) => i.type === "tool");
		assert.deepEqual(steps.map((i) => [i.id, i.name, i.status]), [["bad1", "ask", "failed"], ["bad2", "ask", "failed"], ["bad3", "ask", "failed"]]);
		assert.match(steps[0]!.result!.text, /Two questions have the id "q"/);
		assert.match(steps[1]!.result!.text, /needs at least two options/);
		assert.match(steps[2]!.result!.text, /Give the question a caption/);
		assert.equal(core.approvals.allPending().length, 0);
	} finally {
		await a.close();
	}
});

test("a question notifies at once, without approval actions, and its banner is replaced once answered", async () => {
	const a = await ApiSocketClient.connect(server.port);
	try {
		const { sid, approval } = await start(a, [askCall(), replyWithAnswer]);
		const push = await apple.next((s) => s.body.nh.approvalId === approval.id && s.body.nh.kind === "question");
		assert.equal(push.body.aps.category, "NH_QUESTION");
		assert.equal(push.body.aps["interruption-level"], "time-sensitive");
		assert.equal(push.body.aps.alert.title, "Main · has a question");
		assert.equal(push.body.aps.alert.body, "plan dinner: Dinner plans\nWhich cuisine?\nWhat time?");
		assert.equal(push.body.nh.sessionId, sid, "tapping it opens the chat");
		assert.equal(push.headers["apns-collapse-id"], `approval-${approval.id}`);
		await a.call("approvals.answer", { id: approval.id, values: { cuisine: "pizza" } });
		const settled = await apple.next((s) => s.body.nh.approvalId === approval.id && s.body.nh.kind === "settled");
		assert.equal(settled.body.aps.alert.title, "Main · question answered");
		await a.waitEvent(finished(sid), 10000);
	} finally {
		await a.close();
	}
});

test("in a scheduled run, a question waits no longer than the task's next occurrence", async () => {
	const job = core.scheduler.create({ name: "Dinner", bot: "main", prompt: "plan dinner", schedule: "every 1h", notify: "never" });
	// The next occurrence is moments away; the question timeout (30 s here) is not what ends it.
	core.db.run("UPDATE jobs SET next_run_at = ? WHERE id = ?", Date.now() / 1000 + 0.3, job.id);
	faux.setResponses([askCall(), replyWithAnswer]);
	told.length = 0;
	const events: { type: string; reason?: string; kind?: string }[] = [];
	const off = core.hub.subscribeAll((_sid, e) => {
		if (e.type === "approval.requested") events.push({ type: e.type, kind: e.request.kind });
		if (e.type === "approval.resolved") events.push({ type: e.type, reason: e.reason });
	});
	try {
		const run = await core.scheduler.trigger(job.id);
		const done = await core.scheduler.waitRun(run.id, 10000);
		assert.equal(done.status, "ok");
		assert.deepEqual(events, [{ type: "approval.requested", kind: "question" }, { type: "approval.resolved", reason: "timeout" }]);
		assert.match(told[0]!, /^The owner didn't answer in time\./);
	} finally {
		off();
		core.scheduler.delete(job.id);
	}
});

test("a question waiting at a restart is asked again, and its answer reaches the bot", async () => {
	const { dir, cleanup } = await tempDir();
	const config = testConfig(dir);
	try {
		const one = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
		const m1 = createModels();
		m1.setProvider(one.provider);
		let c = await testCore(dir, { models: m1, config });
		const s = await c.sessions.create("main");
		one.setResponses([askCall()]);
		const e1 = collect(c.hub, s.id);
		await c.sessions.submit(s.id, "plan dinner");
		const first = await e1.until((e) => e.type === "approval.requested");
		assert.ok(first.type === "approval.requested" && first.request.kind === "question");
		await c.close();

		const two = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
		const m2 = createModels();
		m2.setProvider(two.provider);
		two.setResponses([replyWithAnswer]);
		told.length = 0;
		c = await testCore(dir, { models: m2, config });
		const e2 = collect(c.hub, s.id);
		const again = await e2.until((e) => e.type === "approval.requested", 10000);
		assert.ok(again.type === "approval.requested" && again.request.kind === "question");
		assert.deepEqual(again.request.questions, QUESTIONS, "the same question, asked again");
		assert.ok(c.approvals.answer(again.request.requestId, "answer", { cuisine: "thai" }));
		const done = await e2.until((e) => e.type === "run.finished", 10000);
		assert.ok(done.type === "run.finished" && done.status === "complete");
		assert.equal(told[0], "The owner answered:\nWhich cuisine? Thai\nWhat time? (no answer)");
		await c.close();
	} finally {
		await cleanup();
	}
});

test("a member's bot asks: the question is asked on the gateway the app is connected to, and answered back there", async () => {
	const { dir, cleanup } = await tempDir();
	const gw = async (name: string, bots: Parameters<typeof testConfig>[1]) => {
		const d = join(dir, name);
		const f = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }], tokensPerSecond: 400 });
		const m = createModels();
		m.setProvider(f.provider);
		const c = await testCore(d, { models: m, config: testConfig(d, bots, { node: { name } }) });
		const s = await startServer(c, { host: "127.0.0.1", port: 0 });
		return { core: c, server: s, faux: f };
	};
	const alpha = await gw("alpha", [{ name: "main", default: true }]);
	const beta = await gw("beta", [{ name: "nasbot", default: true }]);
	const app = await ApiSocketClient.connect(alpha.server.port);
	try {
		await beta.core.members.join(alpha.core.members.invite().code);
		await alpha.core.roster.sync();
		const { session } = await app.call<{ session: { id: string } }>("sessions.create", { botId: "nasbot-beta" });
		const sid = session.id;
		await app.call("sessions.subscribe", { id: sid });
		told.length = 0;
		beta.faux.setResponses([askCall(), replyWithAnswer]);
		await app.call("sessions.submit", { id: sid, text: "plan dinner" });
		const asked = await app.waitEvent("approval.requested", 10000);
		const q = asked.data.approval as Approval;
		assert.equal(q.kind, "question");
		assert.equal(q.sessionId, sid);
		assert.equal(q.botId, "nasbot-beta");
		assert.equal(q.description, "from beta: Dinner plans");
		assert.deepEqual(q.questions, QUESTIONS);
		assert.equal(beta.core.approvals.allPending().length, 1, "beta's bot waits on its own question");
		await app.call("approvals.answer", { id: q.id, values: { cuisine: "pizza", time: "8" } });
		await app.waitEvent(finished(sid), 20000);
		assert.equal(told[0], "The owner answered:\nWhich cuisine? Pizza\nWhat time? \"8\"");
		assert.equal(beta.core.approvals.allPending().length + alpha.core.approvals.allPending().length, 0);
		const turn = (await http(alpha.server.port)<{ items: { items: Item[] }[] }>(`GET /sessions/${sid}/turns`)).items.at(-1)!;
		assert.deepEqual(turn.items.find((i) => i.type === "card")?.data?.answers, { cuisine: "pizza", time: "8" }, "history through alpha shows it answered");
	} finally {
		await app.close();
		for (const g of [alpha, beta]) {
			await g.server.close();
			await g.core.close();
		}
		await cleanup();
	}
});
