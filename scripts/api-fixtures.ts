// Records real answers and event streams of the client API (docs/API.md) for a client's contract tests, from
// two throwaway gateways in one network with a scripted model: no keys, no network beyond 127.0.0.1, nothing
// kept. Usage: node scripts/api-fixtures.ts <output folder>. One JSON file per answer, and `events.jsonl` with
// the socket frames of a turn that streams, reasons, calls a tool, asks for an approval and finishes;
// `events-card.jsonl` is a turn that reads a list and shows it as a card; `turns-card.json` holds that turn and
// four more in the same chat: a card the bot built (`list`), a scheduler result shown (`schedule_list`), a `chart` and
// an `html` card;
// `events-question.jsonl` and `turns-question.json` a turn that asks the owner a question and carries on with
// the answer (`approvals-question.json`, `subscribe-question.json` while it waits), and `submit-answered.json` a
// typed reply taken as a question's answer.
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxThinking, fauxToolCall, Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import { createCore } from "../src/app.ts";
import { DEFAULT_TOOL_GROUPS } from "../src/core/bots.ts";
import { cardableLine, cardHandle } from "../src/core/cards.ts";
import { setLogLevel } from "../src/log.ts";
import { startServer } from "../src/server.ts";
import { ApiSocketClient, http } from "../test/api/client.ts";
import { pngBytes, TOKEN, tempDir, testConfig } from "../test/helpers.ts";

const out = resolve(process.argv[2] ?? "");
if (!process.argv[2]) {
	console.error("usage: node scripts/api-fixtures.ts <output folder>");
	process.exit(2);
}
mkdirSync(out, { recursive: true });
setLogLevel("error");
const save = (name: string, value: unknown) => writeFileSync(join(out, name), `${JSON.stringify(value, null, 2)}\n`);

// A tool that keeps structured data beside its text, as an MCP server's structuredContent arrives, and offers it as a card.
const reminders = defineTool({
	name: "mcp__bridge__reminders_list",
	description: "Lists reminders",
	parameters: Type.Object({ list: Type.String() }),
	replay: "safe",
	execute: async (_args, api) => ({
		output: [{ type: "text", text: `2 reminders\n\n${cardableLine(api.callId, "Reminders")}` }],
		details: { structured: { reminders: [{ id: "r1", title: "Milk", completed: false }, { id: "r2", title: "Eggs", completed: false }] } },
	}),
});

const { dir, cleanup } = await tempDir();
const gateway = async (name: string, bots: Parameters<typeof testConfig>[1]) => {
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1", reasoning: true }, { id: "faux-2" }], tokensPerSecond: 400 });
	const models = createModels();
	models.setProvider(faux.provider);
	const d = join(dir, name);
	const core = await createCore(testConfig(d, bots, { node: { name } }), { models, renderPdf: async () => [pngBytes(10, 14)], features: () => [{ groups: new Map([["reminders", [reminders]]]) }] });
	const server = await startServer(core, { host: "127.0.0.1", port: 0 });
	return { core, server, faux, api: http(server.port) };
};

const a = await gateway("alpha", [
	{ name: "main", displayName: "Main", default: true, description: "The everyday bot", instructions: "You are the main test bot.", tools: [...DEFAULT_TOOL_GROUPS, "reminders"] },
	{ name: "ops", displayName: "Ops", description: "Runs the servers", instructions: "You are the ops test bot.", trusted: true },
]);
const b = await gateway("beta", [{ name: "nasbot", displayName: "Nasbot", default: true, description: "Runs on the NAS" }]);
try {
	const { code } = a.core.members.invite();
	await b.core.members.join(code);
	await a.core.roster.sync();
	const app = await ApiSocketClient.connect(a.server.port);

	save("hello.json", await a.api("GET /"));
	save("bots.json", await a.api("GET /bots"));
	save("models.json", await a.api("GET /models", { botId: "main" }));

	// A turn that reasons, calls a tool that asks for approval, and answers.
	const { session } = await app.call<{ session: { id: string } }>("sessions.create", { botId: "main" });
	save("session-create.json", { session });
	await app.call("sessions.subscribe", { id: session.id });
	a.faux.setResponses([
		fauxAssistantMessage([fauxThinking("The owner wants the temp folder cleaned."), fauxText("Cleaning it now."), fauxToolCall("bash", { command: "rm -rf ./tmpdir; echo cleaned" })], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxText("Done: the **temp folder** is clean.")]),
	]);
	const png = pngBytes(12, 12);
	const up = await fetch(`http://127.0.0.1:${a.server.port}/api/v1/sessions/${session.id}/attachments`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "x-filename": "screen.png" }, body: new Uint8Array(png) });
	const uploaded = (await up.json()) as { attachment: { id: string } };
	save("attachment-upload.json", uploaded);
	await app.call("sessions.submit", { id: session.id, content: [{ type: "text", text: "Clean the temp folder" }, { type: "attachment", id: uploaded.attachment.id }], requestId: "fixture-1" });
	const ask = await app.waitEvent("approval.requested", 10000);
	save("approvals.json", await a.api("GET /approvals"));
	await app.call("approvals.answer", { id: (ask.data.approval as { id: string }).id, choice: "once" });
	await app.waitEvent((e) => e.event === "turn.finished" && e.sessionId === session.id, 15000);
	writeFileSync(join(out, "events.jsonl"), `${app.events.map((e) => JSON.stringify(e)).join("\n")}\n`);
	save("turns.json", await a.api(`GET /sessions/${session.id}/turns`));
	save("subscribe.json", await app.call("sessions.subscribe", { id: session.id }));
	save("sessions.json", await a.api("GET /sessions", { botId: "main" }));
	save("session.json", await a.api(`GET /sessions/${session.id}`));
	save("session-usage.json", await a.api(`GET /sessions/${session.id}/usage`));
	save("session-context.json", await a.api(`GET /sessions/${session.id}/context`));
	save("commands.json", await a.api(`GET /sessions/${session.id}/commands`));
	save("command-usage.json", await a.api(`POST /sessions/${session.id}/commands`, { name: "usage" }));
	save("session-update.json", await a.api(`PATCH /sessions/${session.id}`, { title: "Temp cleanup", pinned: true, model: "faux/faux-2", thinking: "low" }));
	try {
		await a.api("GET /sessions/nope");
	} catch (error) {
		save("error-session-not-found.json", { error: { code: (error as { code: string }).code, message: (error as Error).message } });
	}

	// A turn that shows a card: the bot reads a list, then answers and shows it in the same message.
	const { session: cardChat } = await app.call<{ session: { id: string } }>("sessions.create", { botId: "main" });
	await app.call("sessions.subscribe", { id: cardChat.id });
	const handle = cardHandle("call_reminders");
	a.faux.setResponses([
		fauxAssistantMessage([fauxToolCall("mcp__bridge__reminders_list", { list: "Groceries" }, { id: "call_reminders" })], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxText("Two things to buy."), fauxToolCall("show", { from: handle, caption: "Groceries: 2 reminders" }, { id: "call_show" })], { stopReason: "toolUse" }),
	]);
	const before = app.events.length;
	await app.call("sessions.submit", { id: cardChat.id, content: [{ type: "text", text: "What's on my grocery list?" }], requestId: "fixture-2" });
	await app.waitEvent((e) => e.event === "turn.finished" && e.sessionId === cardChat.id, 15000);
	writeFileSync(join(out, "events-card.jsonl"), `${app.events.slice(before).filter((e) => e.sessionId === cardChat.id).map((e) => JSON.stringify(e)).join("\n")}\n`);

	// More turns in the same chat: a card the bot builds, a scheduler result shown, a chart and an html card.
	const finishedTurns = () => app.events.filter((e) => e.event === "turn.finished" && e.sessionId === cardChat.id).length;
	const turn = async (text: string, requestId: string, responses: ReturnType<typeof fauxAssistantMessage>[]) => {
		a.faux.setResponses(responses);
		const n = finishedTurns();
		await app.call("sessions.submit", { id: cardChat.id, content: [{ type: "text", text }], requestId });
		await app.waitEvent((e) => e.event === "turn.finished" && e.sessionId === cardChat.id && finishedTurns() > n, 15000);
	};
	const shows = (text: string, card: unknown, caption: string) => fauxAssistantMessage([fauxText(text), fauxToolCall("show", { card, caption } as never, { id: "call_show" })], { stopReason: "toolUse" });
	await turn("What should I pack?", "fixture-2a", [
		shows("Here is a packing list.", { kind: "list", title: "Packing", items: [{ title: "Passport", done: true }, { title: "Charger", detail: "USB-C" }, { title: "Guidebook", url: "https://example.com/guide" }] }, "Packing: 3 items"),
	]);
	const brief = a.core.scheduler.create({ name: "Morning brief", prompt: "Summarize the news", schedule: "0 7 * * 1-5", bot: "main" });
	await turn("What are my scheduled tasks?", "fixture-2b", [
		fauxAssistantMessage([fauxToolCall("schedule_list", {}, { id: "call_sched" })], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxText("One task."), fauxToolCall("show", { from: cardHandle("call_sched"), caption: "Scheduled: 1 task" }, { id: "call_show" })], { stopReason: "toolUse" }),
	]);
	a.core.scheduler.delete(brief.id); // so jobs.json below stays the one task it is about
	await turn("Chart my sales", "fixture-2c", [
		shows("Sales rose.", { kind: "chart", title: "Sales", type: "line", x: { kind: "date", label: "Day" }, y: { label: "Revenue", unit: "USD" }, series: [{ name: "2026", points: [{ x: "2026-10-01", y: 120 }, { x: "2026-10-02", y: 150.5 }, { x: "2026-10-03", y: 140 }] }] }, "Sales, 3 days"),
	]);
	await turn("Draw how a request flows", "fixture-2d", [
		shows("The flow, left to right.", { kind: "html", title: "Request flow", aspect: 2.5, html: '<style>.n{fill:var(--nh-surface);stroke:var(--nh-stroke)}text{fill:var(--nh-text);font-size:12px}</style><svg viewBox="0 0 200 80" width="100%"><rect class="n" x="5" y="25" width="70" height="30" rx="6"/><text x="22" y="44">Client</text><rect class="n" x="125" y="25" width="70" height="30" rx="6"/><text x="138" y="44">Gateway</text><path d="M75 40H125" stroke="var(--nh-accent)" fill="none"/></svg><script>stolen()</script>' }, "Request flow"),
	]);
	save("turns-card.json", await a.api(`GET /sessions/${cardChat.id}/turns`));

	// A turn that asks the owner a question, waits for the answer, and carries on with it.
	const questions = [
		{ id: "cuisine", prompt: "Which cuisine?", kind: "single", options: [{ id: "thai", label: "Thai" }, { id: "pizza", label: "Pizza", detail: "the place on Main St" }], other: true },
		{ id: "sides", prompt: "Any sides?", kind: "multiple", options: [{ id: "rice", label: "Rice" }, { id: "salad", label: "Salad" }, { id: "soup", label: "Soup" }] },
		{ id: "time", prompt: "What time?", kind: "text" },
	];
	const { session: askChat } = await app.call<{ session: { id: string } }>("sessions.create", { botId: "main" });
	await app.call("sessions.subscribe", { id: askChat.id });
	a.faux.setResponses([
		fauxAssistantMessage([fauxText("A couple of things first."), fauxToolCall("ask", { caption: "Dinner plans", questions } as never, { id: "call_ask" })], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxText("Thai with rice at 7:30: I'll book a table.")]),
	]);
	const beforeAsk = app.events.length;
	await app.call("sessions.submit", { id: askChat.id, content: [{ type: "text", text: "Plan dinner" }], requestId: "fixture-3" });
	const question = await app.waitEvent((e) => e.event === "approval.requested" && (e.data.approval as { sessionId: string }).sessionId === askChat.id, 10000);
	save("approvals-question.json", await a.api("GET /approvals"));
	save("subscribe-question.json", await app.call("sessions.subscribe", { id: askChat.id }));
	await app.call("approvals.answer", { id: (question.data.approval as { id: string }).id, values: { cuisine: "thai", sides: ["rice"], time: "7:30" } });
	await app.waitEvent((e) => e.event === "turn.finished" && e.sessionId === askChat.id, 15000);
	writeFileSync(join(out, "events-question.jsonl"), `${app.events.slice(beforeAsk).filter((e) => e.sessionId === askChat.id || (e.event.startsWith("approval.") && (e.data.sessionId ?? (e.data.approval as { sessionId?: string } | undefined)?.sessionId) === askChat.id)).map((e) => JSON.stringify(e)).join("\n")}\n`);
	save("turns-question.json", await a.api(`GET /sessions/${askChat.id}/turns`));
	// A reply typed while a question waits is its answer.
	a.faux.setResponses([
		fauxAssistantMessage([fauxToolCall("ask", { caption: "Dessert", questions: [{ id: "what", prompt: "Anything for dessert?", kind: "text" }] } as never, { id: "call_ask2" })], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxText("Mango sticky rice it is.")]),
	]);
	await app.call("sessions.submit", { id: askChat.id, text: "Plan dessert too", requestId: "fixture-4" });
	await app.waitEvent((e) => e.event === "approval.requested" && (e.data.approval as { toolCallId?: string }).toolCallId === "call_ask2", 10000);
	save("submit-answered.json", await app.call("sessions.submit", { id: askChat.id, text: "mango sticky rice" }));
	await app.waitEvent((e) => e.event === "turn.finished" && e.sessionId === askChat.id && app.events.filter((x) => x.event === "turn.finished" && x.sessionId === askChat.id).length === 2, 15000);

	// A chat with beta's bot through alpha.
	const remote = await app.call<{ session: { id: string } }>("sessions.create", { botId: "nasbot-beta" });
	save("session-member.json", remote);

	// Scheduled tasks, group chats, settings and upkeep.
	const job = await a.api<{ job: { id: string } }>("POST /jobs", { name: "Morning check", prompt: "Check the disks", schedule: "every 1d", botId: "ops" });
	save("job.json", job);
	save("jobs.json", await a.api("GET /jobs"));
	save("rooms-create.json", await a.api("POST /rooms", { name: "Main, Ops", members: [{ botId: "main" }, { botId: "ops" }] }));
	save("rooms.json", await a.api("GET /rooms"));
	save("gateway-settings.json", await a.api("GET /gateway/settings"));
	save("keys.json", await a.api("GET /keys"));
	save("tool-groups.json", await a.api("GET /tool-groups"));
	save("bot-settings.json", await a.api("GET /bots/main/settings"));
	save("software.json", await a.api("GET /software"));
	save("usage.json", await a.api("GET /gateway/usage", { days: 7 }));
	await app.close();
	console.log(`fixtures written to ${out}`);
} finally {
	for (const g of [a, b]) {
		await g.server.close();
		await g.core.close();
	}
	await cleanup();
}
