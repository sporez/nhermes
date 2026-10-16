// Memory tools and the prompt part that keeps pinned memories in front of the bot (so they survive
// compaction). Everything else is reached through `recall`. Also the bot's recent chats: a new chat is
// told about the latest few (fixed when it starts, so its prompt stays cacheable), and chat_search and
// chat_read reach the rest.
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { NOT_THE_OWNER } from "../agent/extensions.ts";
import type { Feature, LateServices } from "../app.ts";
import type { Bot } from "../core/bots.ts";
import type { SessionRow } from "../core/sessions.ts";
import type { TranscriptRow } from "../core/transcript.ts";
import { formatItem, type MemoryStore } from "../memory/memory.ts";

const PINNED_BUDGET = 2500;
/** Characters kept of a recent chat's last question and last answer in the prompt. */
const RECAP_SNIPPET = 200;
/** Latest chats whose whole transcript chat_search reads (older ones match on title and last answer only). */
const SEARCH_DEPTH = 40;
/** Characters of transcript chat_read returns per page. */
const READ_PAGE = 16_000;
/** Characters kept of one message in chat_read. */
const READ_MESSAGE = 2_000;

function clip(s: string, n: number): string {
	const one = s.replace(/\s+/g, " ").trim();
	return one.length <= n ? one : `${one.slice(0, n)}…`;
}

const ownerWords = (rows: TranscriptRow[]) => rows.filter((r) => r.role === "user" && r.text.trim() && !NOT_THE_OWNER.test(r.text));

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

	const day = (t: number) => new Intl.DateTimeFormat("en-CA", { timeZone: late.config.timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(t * 1000));
	const heading = (c: SessionRow) => `${day(c.last_active)} ${JSON.stringify(c.title || "(untitled)")} (id ${c.id})`;

	/** The bot's latest chats as one prompt section, or "" when it has none. */
	const recap = async (bot: Bot, except: string): Promise<string> => {
		const sessions = late.sessions();
		const chats = sessions.ownerChats(bot.name, { limit: bot.recentChats, except });
		if (chats.length === 0) return "";
		const lines: string[] = [];
		for (const c of chats) {
			const asked = ownerWords(await sessions.rows(c.id)).at(-1)?.text ?? "";
			lines.push(`- ${heading(c)}: last asked ${JSON.stringify(clip(asked, RECAP_SNIPPET))}; last answer ${JSON.stringify(clip(c.preview, RECAP_SNIPPET))}`);
		}
		return (
			"Recent chats: your latest conversations with the owner, newest first, as they stood when this chat began. " +
			"A new chat often picks up one of them; when this one seems to, read it with chat_read before answering, and use chat_search for older ones.\n" +
			lines.join("\n")
		);
	};

	const search = defineTool({
		name: "chat_search",
		description: `Search your earlier chats with the owner by words. Reads the whole text of your latest ${SEARCH_DEPTH} chats, and titles and last answers of older ones. Returns chat ids for chat_read.`,
		parameters: Type.Object({ query: Type.String(), limit: Type.Optional(Type.Number()) }),
		replay: "safe",
		execute: async (args, api) => {
			const bot = botOf(api.conversationId as number);
			const sessions = late.sessions();
			const here = sessionOf(api.conversationId as number);
			const words = args.query.toLowerCase().split(/\s+/).filter(Boolean);
			if (words.length === 0) return text("Give some words to search for.");
			const limit = Math.min(Math.max(1, args.limit ?? 8), 20);
			const hits: string[] = [];
			const seen = new Set<string>();
			for (const c of sessions.ownerChats(bot.name, { limit: SEARCH_DEPTH, except: here })) {
				seen.add(c.id);
				const rows = (await sessions.rows(c.id)).filter((r) => (r.role === "user" || r.role === "assistant") && r.text.trim());
				const all = `${c.title}\n${rows.map((r) => r.text).join("\n")}`.toLowerCase();
				if (!words.every((w) => all.includes(w))) continue;
				const where = rows.find((r) => r.text.toLowerCase().includes(words[0]!));
				const at = where ? Math.max(0, where.text.toLowerCase().indexOf(words[0]!) - 80) : 0;
				hits.push(`- ${heading(c)}: ${JSON.stringify(clip(where ? where.text.slice(at) : c.preview, 240))}`);
				if (hits.length >= limit) break;
			}
			if (hits.length < limit) {
				for (const c of sessions.ownerChats(bot.name, { limit: 200, except: here, search: words.join(" ") })) {
					if (seen.has(c.id)) continue;
					hits.push(`- ${heading(c)}: ${JSON.stringify(clip(c.preview, 240))}`);
					if (hits.length >= limit) break;
				}
			}
			return text(hits.length === 0 ? "No earlier chats match." : hits.join("\n"));
		},
	});

	const read = defineTool({
		name: "chat_read",
		description: "Read one of your earlier chats with the owner by id (from Recent chats or chat_search). Page 1 is the latest part; ask for page 2 and on for earlier parts.",
		parameters: Type.Object({ id: Type.String(), page: Type.Optional(Type.Number()) }),
		replay: "safe",
		execute: async (args, api) => {
			const bot = botOf(api.conversationId as number);
			const sessions = late.sessions();
			const chat = sessions.ownerChat(bot.name, args.id);
			if (!chat) return text(`No chat ${args.id} of yours to read.`);
			const rows = (await sessions.rows(chat.id)).filter((r) => (r.role === "user" || r.role === "assistant") && r.text.trim());
			const parts = rows.map((r) => `${r.role === "user" ? "Owner" : "You"}: ${r.text.length > READ_MESSAGE ? `${r.text.slice(0, READ_MESSAGE)}…` : r.text}`);
			// Pages from the end, whole messages each.
			const pages: string[][] = [];
			let page: string[] = [];
			let size = 0;
			for (const p of [...parts].reverse()) {
				if (size + p.length > READ_PAGE && page.length > 0) {
					pages.push(page);
					page = [];
					size = 0;
				}
				page.unshift(p);
				size += p.length;
			}
			if (page.length > 0) pages.push(page);
			const n = Math.max(1, Math.floor(args.page ?? 1));
			const head = `Chat ${heading(chat)}, page ${Math.min(n, pages.length || 1)} of ${pages.length || 1}${n < pages.length ? " (earlier parts on the next pages)" : ""}:`;
			if (pages.length === 0) return text(`${head}\n(no messages)`);
			if (n > pages.length) return text(`Chat ${chat.id} has ${pages.length} page(s).`);
			return text(`${head}\n\n${pages[n - 1]!.join("\n\n")}`);
		},
	});

	const tools = [remember, recall, forget, update, list, search, read] as ToolRegistration[];
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
			async (bot, sessionId) => {
				if (!bot.toolGroups.includes("memory") || bot.recentChats === 0) return undefined;
				// "" is the prompt a new chat would get (the panel's prompt view): worked out, not kept.
				if (sessionId === "") return (await recap(bot, "")) || undefined;
				const sessions = late.sessions();
				const row = sessions.get(sessionId);
				if (!row || row.kind !== "chat") return undefined;
				if (row.source.startsWith("member:") && !row.source.endsWith(":owner")) return undefined;
				if (row.recap !== null) return row.recap || undefined;
				const section = await recap(bot, row.id);
				sessions.setRecap(row.id, section);
				return section || undefined;
			},
		],
	};
}
