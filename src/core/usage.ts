// Usage analytics from the chats' model calls: tokens and cost per day and per model, over a number of days.
// A chat's calls are read from its history once and again only when the chat changed (the cache). A member's
// bot keeps its chats on its own machine, so only local bots count. Shared by the Hermes analytics route and
// the client API.
import type { Core } from "../app.ts";
import type { UsageEvent } from "./sessions.ts";

export type UsageSum = { input: number; output: number; cacheRead: number; reasoning: number; cost: number; calls: number; sessions: number };
export type UsageReport = {
	days: number;
	daily: (UsageSum & { day: string })[];
	byModel: (UsageSum & { model: string })[];
	totals: UsageSum;
};

type Acc = Omit<UsageSum, "sessions"> & { sessions: Set<string> };

const cache = new Map<string, { key: string; events: UsageEvent[] }>();

export async function usageReport(core: Core, botNames: readonly string[], days: number): Promise<UsageReport> {
	const since = Date.now() / 1000 - days * 86_400;
	const dayOf = new Intl.DateTimeFormat("en-CA", { timeZone: core.config.timezone, year: "numeric", month: "2-digit", day: "2-digit" });
	const blank = (): Acc => ({ input: 0, output: 0, cacheRead: 0, reasoning: 0, cost: 0, calls: 0, sessions: new Set() });
	const daily = new Map<string, Acc>();
	const byModel = new Map<string, Acc>();
	const total = blank();
	const into = <K>(m: Map<K, Acc>, k: K) => m.get(k) ?? m.set(k, blank()).get(k)!;
	for (const botName of botNames) {
		for (let offset = 0; ; offset += 500) {
			const { rows } = core.sessions.list(botName, { limit: 500, offset, archived: "include", order: "recent" });
			for (const row of rows) {
				if (row.remote_node || row.last_active < since) continue;
				const key = `${row.message_count}:${row.last_active}`;
				let hit = cache.get(row.id);
				if (hit?.key !== key) {
					hit = { key, events: await core.sessions.usageEvents(row.id) };
					cache.set(row.id, hit);
				}
				for (const e of hit.events) {
					if (e.at < since) continue;
					for (const s of [into(daily, dayOf.format(e.at * 1000)), into(byModel, e.model), total]) {
						s.input += e.input;
						s.output += e.output;
						s.cacheRead += e.cacheRead;
						s.reasoning += e.reasoning;
						s.cost += e.cost;
						s.calls += 1;
						s.sessions.add(row.id);
					}
				}
			}
			if (rows.length < 500) break;
		}
	}
	const cost = (n: number) => Math.round(n * 1e6) / 1e6;
	const sum = (s: Acc): UsageSum => ({ input: s.input, output: s.output, cacheRead: s.cacheRead, reasoning: s.reasoning, cost: cost(s.cost), calls: s.calls, sessions: s.sessions.size });
	return {
		days,
		daily: [...daily.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, s]) => ({ day, ...sum(s) })),
		byModel: [...byModel.entries()].sort(([, a], [, b]) => b.input + b.output - (a.input + a.output)).map(([model, s]) => ({ model, ...sum(s) })),
		totals: sum(total),
	};
}
