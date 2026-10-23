// Records real answers and event streams of the client API (docs/API.md) for a client's contract tests, from
// two throwaway gateways in one network with a scripted model: no keys, no network beyond 127.0.0.1, nothing
// kept. Usage: node scripts/api-fixtures.ts <output folder>. One JSON file per answer, and `events.jsonl` with
// the socket frames of a turn that streams, reasons, calls a tool, asks for an approval and finishes;
// `events-card.jsonl` and `turns-card.json` are a turn that reads a list and shows it as a card.
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
		output: [{ type: "text", text: `2 reminders\n\n${cardableLine(api.callId)}` }],
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
	save("turns-card.json", await a.api(`GET /sessions/${cardChat.id}/turns`));

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
