// The scheduler tools (src/tools/schedule.ts) return the client API's own Job and Run shapes beside their text,
// so the bot can show them as cards, and `show` of one carries the same Job that `GET /jobs` lists.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { cardHandle } from "../../src/core/cards.ts";
import type { SessionEvent } from "../../src/core/events.ts";
import type { LateServices } from "../../src/app.ts";
import { startServer } from "../../src/server.ts";
import { scheduleFeature } from "../../src/tools/schedule.ts";
import { http } from "../api/client.ts";
import { collect, fauxModels, tempDir, testCore } from "../helpers.ts";

const call = (name: string, args: Parameters<typeof fauxToolCall>[1], id: string) => fauxToolCall(name, args, { id });
const step = (...calls: ReturnType<typeof fauxToolCall>[]) => fauxAssistantMessage(calls, { stopReason: "toolUse" });
type Obj = Record<string, unknown>;

test("each scheduler tool returns its Job or Run beside its text with a named handle, and showing a schedule_list result carries what GET /jobs lists", async () => {
	const t = await tempDir();
	const { models, faux } = fauxModels();
	const core = await testCore(t.dir, { models });
	const server = await startServer(core, { host: "127.0.0.1", port: 0, federationPort: null });
	try {
		const session = await core.sessions.create("main", { title: "Tasks" });
		const existing = core.scheduler.create({ name: "Brief", prompt: "Summarize", schedule: "every 1h", bot: "main" });
		const c = collect(core.hub, session.id);
		faux.setResponses([
			step(call("schedule_create", { name: "Made", prompt: "Look", schedule: "every 6h" }, "k_create")),
			step(call("schedule_update", { id: existing.id, enabled: false }, "k_update"), call("schedule_history", { id: existing.id }, "k_hist")),
			step(call("schedule_list", {}, "k_list")),
			fauxAssistantMessage([fauxText("Here."), call("show", { from: cardHandle("k_list"), caption: "Tasks" }, "k_show")], { stopReason: "toolUse" }),
		]);
		await core.sessions.submit(session.id, "go");
		await c.until((e) => e.type === "run.finished", 10000);
		const text = (id: string) => (c.events.find((e) => e.type === "tool.finished" && e.callId === id) as Extract<SessionEvent, { type: "tool.finished" }>).resultText;
		const line = (id: string, card: string) => new RegExp(`\\n\\n\\(The owner can be shown this as a ${card} card: show \\{from: "${cardHandle(id)}"\\}\\)$`);
		assert.match(text("k_create"), line("k_create", "Scheduled task"));
		assert.match(text("k_update"), line("k_update", "Scheduled task"));
		assert.match(text("k_hist"), line("k_hist", "Scheduled task"));
		assert.match(text("k_list"), line("k_list", "Scheduled tasks"));

		const { turns } = await core.sessions.turns(session.id);
		const json = (id: string) => (turns.at(-1)!.items.find((i) => i.type === "tool" && i.id === id) as unknown as { json: Obj }).json;
		const api = http(server.port);
		const listed = (await api<{ items: Obj[] }>("GET /jobs")).items;
		assert.deepEqual((json("k_list").jobs as Obj[]), listed, "schedule_list returns the jobs GET /jobs lists");
		assert.equal(listed.length, 2);
		assert.equal((json("k_create").job as Obj).name, "Made");
		assert.equal((json("k_update").job as Obj).enabled, false);

		// Run it now, straight through the tool (a real run would use up the model's scripted answers), then read its history.
		faux.setResponses([fauxAssistantMessage([fauxText("ok")])]);
		const late = { sessions: () => ({ botOf: () => undefined }) } as unknown as LateServices;
		type Tool = { execute: (a: unknown, api: unknown) => Promise<{ output: { text: string }[]; details: { structured: Obj } }> };
		const tools = scheduleFeature(late, () => core.scheduler, () => core.notifier).groups!.get("schedule") as unknown as (Tool & { name: string })[];
		const tool = (name: string) => tools.find((t) => t.name === name)!;
		const ran = await tool("schedule_run").execute({ id: existing.id }, { callId: "k_run", conversationId: 1 });
		assert.match(ran.output[0]!.text, line("k_run", "Scheduled task"));
		const apiJob = (await api<{ job: Obj }>(`GET /jobs/${existing.id}`)).job;
		const ranJob = ran.details.structured.job as Obj;
		assert.deepEqual(Object.keys(ranJob), Object.keys(apiJob), "the API's Job shape");
		assert.equal(ranJob.id, apiJob.id);
		const histTool = await tool("schedule_history").execute({ id: existing.id }, { callId: "k_hist2", conversationId: 1 });
		const hist = histTool.details.structured as { job: Obj; runs: Obj[] };
		assert.equal(hist.job.id, existing.id);
		const apiRuns = (await api<{ items: Obj[] }>(`GET /jobs/${existing.id}/runs`)).items;
		assert.deepEqual(hist.runs.map((r) => Object.keys(r)), apiRuns.map((r) => Object.keys(r)), "the runs are the API's Run shape");
		assert.deepEqual(hist.runs.map((r) => r.id), apiRuns.map((r) => r.id));
		assert.ok(hist.runs.length >= 1 && hist.runs.every((r) => r.jobId === existing.id));

		const card = turns.at(-1)!.items.find((i) => i.type === "card");
		assert.ok(card?.type === "card" && card.kind === "result");
		assert.equal(card.source.name, "schedule_list");
		assert.deepEqual(((card.data as Obj).jobs as Obj[])[0], listed[0]);
	} finally {
		await server.close();
		await core.close();
		await t.cleanup();
	}
});
