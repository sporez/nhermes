// Live smoke test against a running gateway: one real model turn over /api/ws.
// usage: node scripts/smoke.ts [port|host:port] [prompt]   (token from NHERMES_TOKEN, bot from NH_BOT)
import { HermesClient } from "../test/hermes/client.ts";

const target = process.argv[2] ?? "9119";
const prompt = process.argv[3] ?? "Reply with exactly the single word: pong";
const token = process.env.NHERMES_TOKEN;
if (!token) throw new Error("set NHERMES_TOKEN");

const c = await HermesClient.connect(target, token);
await c.waitEvent("gateway.ready");
await c.call("client.capabilities", { server_requests: true });
c.onRequest = (method, params) => {
	console.log(`server request ${method}: ${String(params.command)} → once`);
	return { choice: "once" };
};
const created = await c.call<{ session_id: string; info: { model: string; provider: string } }>("session.create", process.env.NH_BOT ? { profile: process.env.NH_BOT } : {});
const sid = created.session_id;
console.log(`session ${sid} on ${created.info.provider}/${created.info.model}`);
const t0 = Date.now();
await c.call("prompt.submit", { session_id: sid, text: prompt });
const done = await c.waitEvent("message.complete", sid, 180_000);
const deltas = c.eventsOf("message.delta", sid);
const tools = c.eventsOf("tool.start", sid).map((e) => `${e.payload.name}(${e.payload.context})`);
console.log(`status=${done.payload.status} deltas=${deltas.length} tools=[${tools.join(", ")}] ${(Date.now() - t0) / 1000}s`);
console.log(`text: ${String(done.payload.text).slice(0, 500)}`);
if (done.payload.error) console.log(`error: ${done.payload.error}`);
console.log(`usage: ${JSON.stringify(done.payload.usage)}`);
await c.close();
