// Live check: a real model's risky tool call becomes an approval request; we answer it and report.
// usage: NHERMES_TOKEN=... node scripts/approval-smoke.ts host:port <once|deny> "<prompt>"
import { ApiClient } from "../src/remote/api-client.ts";

const [where = "9119", choice = "deny", prompt = "Install the package cowsay with apt."] = process.argv.slice(2);
const url = `http://${where.includes(":") ? where : `127.0.0.1:${where}`}`;
const c = await ApiClient.open({ url, token: process.env.NHERMES_TOKEN! }, where);
const { session } = await c.call<{ session: { id: string } }>("sessions.create", process.env.NH_BOT ? { botId: process.env.NH_BOT } : {});
const sid = session.id;
const items: { type: string; name?: string; text?: string; result?: { text: string } | null }[] = [];
c.onEvent((e) => {
	if (e.event === "approval.requested") {
		const a = e.data.approval as { id: string; sessionId: string; toolName: string; patternKey: string; command: string };
		if (a.sessionId !== sid) return;
		console.log(`APPROVAL tool=${a.toolName} pattern=${a.patternKey} command=${a.command} → ${choice}`);
		void c.call("approvals.answer", { id: a.id, choice });
	} else if (e.event === "item.finished" && e.sessionId === sid) items.push(e.data.item as (typeof items)[number]);
});
const ended = c.waitEvent((e) => e.event === "turn.finished" && e.sessionId === sid);
await c.call("sessions.subscribe", { id: sid });
await c.call("sessions.submit", { id: sid, text: prompt }, 240_000);
const done = await ended;
for (const t of items.filter((i) => i.type === "tool")) console.log(`TOOL ${t.name}: ${(t.result?.text ?? "").slice(0, 160).replace(/\n/g, " ")}`);
console.log(`ANSWER (${String(done.data.status)}): ${items.filter((i) => i.type === "text").map((i) => i.text).join("\n\n").slice(0, 400)}`);
c.close();
