// Live check: a real model's risky tool call becomes an approval request; we answer it and report.
// usage: NHERMES_TOKEN=... node scripts/approval-smoke.ts host:port <once|deny> "<prompt>"
import { HermesClient } from "../test/hermes/client.ts";

const [where = "9119", choice = "deny", prompt = "Install the package cowsay with apt."] = process.argv.slice(2);
const c = await HermesClient.connect(where, process.env.NHERMES_TOKEN!);
await c.waitEvent("gateway.ready");
await c.call("client.capabilities", { server_requests: true });
c.onRequest = (method, params) => {
	console.log(`APPROVAL ${method}: tool=${String(params.tool_name)} pattern=${String(params.pattern_key)} command=${String(params.command)} → ${choice}`);
	return { choice };
};
const { session_id: sid } = await c.call<{ session_id: string }>("session.create", process.env.NH_BOT ? { profile: process.env.NH_BOT } : {});
await c.call("prompt.submit", { session_id: sid, text: prompt });
const done = await c.waitEvent("message.complete", sid, 240_000);
for (const t of c.eventsOf("tool.complete", sid)) console.log(`TOOL ${String(t.payload.name)}: ${String(t.payload.result_text).slice(0, 160).replace(/\n/g, " ")}`);
console.log(`ANSWER (${String(done.payload.status)}): ${String(done.payload.text).slice(0, 400)}`);
await c.close();
