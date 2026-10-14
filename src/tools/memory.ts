// Memory tools and the prompt part that keeps pinned memories in front of the bot (so they survive
// compaction). Everything else is reached through `recall`.
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import type { Feature, LateServices } from "../app.ts";
import type { Bot } from "../core/bots.ts";
import { formatItem, type MemoryStore } from "../memory/memory.ts";

const PINNED_BUDGET = 2500;

function text(t: string) {
	return { output: [{ type: "text" as const, text: t }] };
}

export function memoryFeature(late: LateServices, store: MemoryStore): Feature {
	const botOf = (conversationId: number): Bot => {
		const bot = late.sessions().botOf(conversationId);
		if (!bot) throw new Error("this conversation has no bot");
		return bot;
	};
	const sessionOf = (conversationId: number) => late.sessions().byConversation(conversationId)?.id ?? "unknown";

	const remember = defineTool({
		name: "remember",
		description:
			"Save a durable memory: a fact about the owner, their preferences, systems or decisions, or a Markdown note. " +
			"Use pinned for a few things that should always be in mind. Use space to write to a shared space you have access to.",
		parameters: Type.Object({
			text: Type.String({ description: "What to remember, self-contained" }),
			title: Type.Optional(Type.String()),
			kind: Type.Optional(Type.Union([Type.Literal("fact"), Type.Literal("note")])),
			tags: Type.Optional(Type.Array(Type.String())),
			pinned: Type.Optional(Type.Boolean()),
			space: Type.Optional(Type.String({ description: "Shared space name, if writing to shared knowledge" })),
		}),
		execute: async (args, api) => {
			const bot = botOf(api.conversationId as number);
			const item = store.add(bot, { body: args.text, title: args.title, kind: args.kind, tags: args.tags, pinned: args.pinned, space: args.space, source: `session:${sessionOf(api.conversationId as number)}` });
			return text(`Saved memory #${item.id}${item.owner !== bot.name ? ` in ${item.owner}` : ""}.`);
		},
	});

	const recall = defineTool({
		name: "recall",
		description: "Search your memories (and shared spaces you can read) by keywords. Returns the best matches with their ids.",
		parameters: Type.Object({
			query: Type.String(),
			limit: Type.Optional(Type.Number()),
			space: Type.Optional(Type.String()),
		}),
		replay: "safe",
		execute: async (args, api) => {
			const bot = botOf(api.conversationId as number);
			const hits = store.search(bot, args.query, { limit: args.limit, space: args.space });
			return text(hits.length === 0 ? "No matching memories." : hits.map(formatItem).join("\n"));
		},
	});

	const forget = defineTool({
		name: "forget",
		description: "Delete a memory by id (from recall or memory_list).",
		parameters: Type.Object({ id: Type.Number() }),
		execute: async (args, api) => {
			const bot = botOf(api.conversationId as number);
			return text(store.forget(bot, args.id) ? `Forgot #${args.id}.` : `No memory #${args.id}.`);
		},
	});

	const update = defineTool({
		name: "memory_update",
		description: "Change a memory's text, title or pinned flag.",
		parameters: Type.Object({ id: Type.Number(), text: Type.Optional(Type.String()), title: Type.Optional(Type.String()), pinned: Type.Optional(Type.Boolean()) }),
		execute: async (args, api) => {
			const bot = botOf(api.conversationId as number);
			const m = store.update(bot, args.id, { body: args.text, title: args.title, pinned: args.pinned });
			return text(`Updated ${formatItem(m)}`);
		},
	});

	const list = defineTool({
		name: "memory_list",
		description: "List recent memories (pinned first).",
		parameters: Type.Object({ limit: Type.Optional(Type.Number()), space: Type.Optional(Type.String()) }),
		replay: "safe",
		execute: async (args, api) => {
			const bot = botOf(api.conversationId as number);
			const items = store.list(bot, { limit: args.limit ?? 20, space: args.space });
			return text(items.length === 0 ? "No memories yet." : items.map(formatItem).join("\n"));
		},
	});

	const tools = [remember, recall, forget, update, list] as ToolRegistration[];
	return {
		groups: new Map([["memory", tools]]),
		promptParts: [
			(bot) => {
				if (!bot.toolGroups.includes("memory")) return undefined;
				const pinned = store.list(bot, { pinnedOnly: true, limit: 40 });
				const lines: string[] = [];
				let used = 0;
				for (const m of pinned) {
					const line = `- ${formatItem(m)}`;
					if (used + line.length > PINNED_BUDGET) break;
					lines.push(line);
					used += line.length;
				}
				const spaces = bot.sharedMemory.length ? ` Shared spaces you can use: ${bot.sharedMemory.join(", ")}.` : "";
				const head = `Memory: you keep durable memories across conversations. Use recall to look things up before saying you don't know, and remember to save durable facts the owner tells you.${spaces}`;
				return lines.length ? `${head}\nPinned:\n${lines.join("\n")}` : head;
			},
		],
	};
}
