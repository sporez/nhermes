// Vory's cron screens: list, edit ({updates}), pause/resume, Run now (held until done; 409 while running),
// run history, delete, and the cron.changed event.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { startHermesServer } from "../../src/hermes/server.ts";
import { TOKEN, tempDir, testCore } from "../helpers.ts";
import { HermesClient } from "./client.ts";

test("cron REST surface", async () => {
	const { dir, cleanup } = await tempDir();
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }], tokensPerSecond: 2000 });
	const models = createModels();
	models.setProvider(faux.provider);
	const core = await testCore(dir, { models });
	const server = await startHermesServer(core, { host: "127.0.0.1", port: 0 });
	const url = `http://127.0.0.1:${server.port}`;
	const h = { "X-Hermes-Session-Token": TOKEN, "content-type": "application/json" };
	const call = async (method: string, path: string, body?: unknown) => {
		const r = await fetch(url + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
		return { status: r.status, json: (await r.json()) as Record<string, unknown> };
	};
	const ws = await HermesClient.connect(server.port, TOKEN);
	try {
		await ws.waitEvent("gateway.ready");
		const created = await call("POST", "/api/cron/jobs?profile=ops", { name: "Morning brief", prompt: "Summarize overnight alerts", schedule: "0 7 * * 1-5" });
		assert.equal(created.status, 200);
		const id = created.json.job_id as string;
		assert.equal(created.json.profile, "ops");
		assert.equal(created.json.schedule, "0 7 * * 1-5");
		assert.equal(created.json.state, "active");
		await ws.waitEvent("cron.changed");

		const list = await call("GET", "/api/cron/jobs");
		assert.deepEqual((list.json.jobs as { job_id: string }[]).map((j) => j.job_id), [id]);

		// Vory's detail screen saves changed fields as {updates: {...}}; read-only fields from its raw editor are ignored.
		const edited = await call("PUT", `/api/cron/jobs/${id}`, { updates: { schedule: "30 6 * * *", prompt: "Summarize alerts and failed jobs", last_status: "ok" } });
		assert.equal(edited.status, 200);
		assert.equal(edited.json.schedule, "30 6 * * *");
		assert.equal(edited.json.prompt, "Summarize alerts and failed jobs");
		assert.equal((await call("PUT", `/api/cron/jobs/${id}`, { updates: { schedule: "whenever" } })).status, 400);
		assert.equal(created.json.context, "fresh");
		assert.equal((await call("PUT", `/api/cron/jobs/${id}`, { updates: { context: "continue" } })).json.context, "continue");
		assert.equal((await call("GET", `/api/cron/jobs/${id}`)).json.context, "continue");
		assert.equal((await call("PUT", `/api/cron/jobs/${id}`, { updates: { context: "forever" } })).status, 400);

		assert.equal((await call("POST", `/api/cron/jobs/${id}/pause`)).json.state, "paused");
		assert.equal((await call("GET", `/api/cron/jobs/${id}`)).json.next_run_at, null);
		const resumed = await call("POST", `/api/cron/jobs/${id}/resume`);
		assert.equal(resumed.json.state, "active");
		assert.ok(resumed.json.next_run_at);

		faux.setResponses([fauxAssistantMessage([fauxText("No alerts overnight.")])]);
		const ran = await call("POST", `/api/cron/jobs/${id}/trigger`);
		assert.equal(ran.status, 200);
		assert.equal(ran.json.last_status, "ok", "the reply is the job after the run");
		assert.ok(ran.json.last_run_at);
		const runs = await call("GET", `/api/cron/jobs/${id}/runs`);
		const first = (runs.json.runs as { status: string; summary: string; trigger: string; session_id: string }[])[0]!;
		assert.deepEqual([first.status, first.summary, first.trigger], ["ok", "No alerts overnight.", "manual"]);
		// The run's session shows up in Vory's chat list for that bot.
		const sessions = await call("GET", "/api/sessions?profile=ops&order=recent");
		assert.equal((sessions.json.sessions as { id: string; source: string }[])[0]!.source, "cron");

		// A second Run now while one is going is refused (the first streams for about a second).
		faux.setResponses([fauxAssistantMessage([fauxText("long ".repeat(2000))])]);
		const p1 = call("POST", `/api/cron/jobs/${id}/trigger`);
		await new Promise((r) => setTimeout(r, 100));
		assert.equal((await call("GET", `/api/cron/jobs/${id}`)).json.state, "running");
		const second = await call("POST", `/api/cron/jobs/${id}/trigger`);
		assert.equal(second.status, 409);
		assert.equal((await p1).json.last_status, "ok");

		assert.equal((await call("DELETE", `/api/cron/jobs/${id}`)).status, 200);
		assert.equal((await call("GET", `/api/cron/jobs/${id}`)).status, 404);
	} finally {
		await ws.close();
		await server.close();
		await core.close();
		await cleanup();
	}
});
