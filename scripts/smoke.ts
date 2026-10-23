// Live smoke test against a running gateway: one real model turn over the client API's socket (/api/v1/ws).
// usage: node scripts/smoke.ts [port|host:port] [prompt]   (token from NHERMES_TOKEN, bot from NH_BOT)
import { ApiClient } from "../src/remote/api-client.ts";

const target = process.argv[2] ?? "9119";
const prompt = process.argv[3] ?? "Reply with exactly the single word: pong";
const token = process.env.NHERMES_TOKEN;
if (!token) throw new Error("set NHERMES_TOKEN");

const url = `http://${target.includes(":") ? target : `127.0.0.1:${target}`}`;
const c = await ApiClient.open({ url, token }, target);
const events: { event: string; sessionId?: string; data: Record<string, unknown> }[] = [];
c.onEvent((e) => {
	events.push(e);
	if (e.event === "approval.requested") {
		const a = e.data.approval as { id: string; command: string };
		console.log(`approval: ${a.command} → once`);
		void c.call("approvals.answer", { id: a.id, choice: "once" });
	}
});
const { session } = await c.call<{ session: { id: string; model: { provider: string; id: string } } }>("sessions.create", process.env.NH_BOT ? { botId: process.env.NH_BOT } : {});
const sid = session.id;
console.log(`session ${sid} on ${session.model.provider}/${session.model.id}`);
const t0 = Date.now();
const ended = c.waitEvent((e) => e.event === "turn.finished" && e.sessionId === sid);
await c.call("sessions.subscribe", { id: sid });
await c.call("sessions.submit", { id: sid, text: prompt });
const done = await ended;
const mine = events.filter((e) => e.sessionId === sid);
const deltas = mine.filter((e) => e.event === "item.delta");
const tools = mine.filter((e) => e.event === "item.finished" && (e.data.item as { type: string }).type === "tool").map((e) => (e.data.item as { name: string; preview: string }));
const text = mine.filter((e) => e.event === "item.finished" && (e.data.item as { type: string }).type === "text").map((e) => (e.data.item as { text: string }).text);
console.log(`status=${String(done.data.status)} deltas=${deltas.length} tools=[${tools.map((t) => `${t.name}(${t.preview})`).join(", ")}] ${(Date.now() - t0) / 1000}s`);
console.log(`text: ${text.join("\n\n").slice(0, 500)}`);
if (done.data.error) console.log(`error: ${String(done.data.error)}`);
console.log(`usage: ${JSON.stringify(done.data.usage)}`);
c.close();
