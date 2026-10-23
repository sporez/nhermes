// A chat's conversation (docs/API.md "Turns", "Live events", "Chat operations"): its turns, following it
// live, sending to it, steering, stopping, compacting, usage and context, and chat commands.
import { CommandError, commandCatalog, runCommand } from "../../core/commands.ts";
import { ApiError } from "../errors.ts";
import { localSession } from "../lookup.ts";
import { identifyAttachments } from "./attachments.ts";
import type { Op, OpContext } from "../ops.ts";
import type { Params } from "../params.ts";
import { approvalJson, sessionJson, turnJson, usageJson } from "../shapes/chat.ts";

const PAGE = 50;

/** A page of turns, newest last, ending before the turn `cursor` names. */
async function turnsPage(cx: OpContext, id: string, cursor: string | undefined, limit: number) {
	const { turns } = await cx.core.sessions.turns(id);
	identifyAttachments(cx.core, id, turns);
	let end = turns.length;
	if (cursor) {
		end = turns.findIndex((t) => t.id === cursor);
		if (end < 0) throw new ApiError("invalid_params", "cursor is not a turn of this chat.");
	}
	const start = Math.max(0, end - limit);
	return { items: turns.slice(start, end).map(turnJson), nextCursor: start > 0 ? turns[start]!.id : null };
}

/**
 * The chat's state and its live events from here on. The snapshot is read so that no event of the chat
 * lands between the read and the subscription; events already sent with a seq at or below the snapshot's
 * are older than it (docs/API.md "Following a chat").
 */
async function subscribe(p: Params, cx: OpContext) {
	if (!cx.socket) throw new ApiError("invalid_params", "Following a chat needs the WebSocket.");
	const row = localSession(cx, p.str("id"));
	const limit = p.optInt("limit", { min: 1, max: 500 }) ?? PAGE;
	const { hub, approvals } = cx.core;
	for (let attempt = 0; ; attempt++) {
		const before = hub.seq(row.id);
		const [turns, session] = await Promise.all([turnsPage(cx, row.id, undefined, limit), sessionJson(cx.core, cx.core.sessions.require(row.id))]);
		if (hub.seq(row.id) !== before && attempt < 4) continue;
		// Subscribed in the same synchronous step as the read is checked: later events follow it.
		cx.socket.subscribe(row.id);
		return { session, seq: hub.seq(row.id), turns, approvals: approvals.pendingFor(row.id).map(approvalJson) };
	}
}

/** A message: `text`, or `content` blocks (text, and attachments by id). */
function message(p: Params): { text: string; ids: string[] } {
	const content = p.raw.content;
	if (content === undefined || content === null) return { text: p.optStr("text") ?? "", ids: [] };
	if (!Array.isArray(content)) throw new ApiError("invalid_params", "content must be a list of blocks.");
	const words: string[] = [];
	const ids: string[] = [];
	for (const b of content as Record<string, unknown>[]) {
		if (b?.type === "text" && typeof b.text === "string") words.push(b.text);
		else if (b?.type === "attachment") {
			const id = typeof b.id === "string" ? b.id : typeof (b.attachment as { id?: unknown } | undefined)?.id === "string" ? (b.attachment as { id: string }).id : undefined;
			if (!id) throw new ApiError("invalid_params", "An attachment block names its upload's id.");
			ids.push(id);
		}
	}
	return { text: words.join("\n\n"), ids };
}

async function submit(p: Params, cx: OpContext) {
	const row = localSession(cx, p.str("id"));
	const { text, ids } = message(p);
	if (!text.trim() && ids.length === 0) throw new ApiError("invalid_params", "A message needs words or an attachment.");
	cx.socket?.subscribe(row.id);
	const requestId = p.optStr("requestId");
	const r = await cx.core.attachments.submitWith(row.id, text, ids, (content) => cx.core.sessions.submit(row.id, content, { requestId, whenBusy: "followUp" }));
	// `submission`: whether Durable placed it, queued it, or (a retry with the same requestId) already answered it.
	return { status: r.status === "queued" ? "queued" : "started", submission: r.submission };
}

export const chatOps: Op[] = [
	{
		name: "sessions.turns",
		http: "GET /sessions/:id/turns",
		members: true,
		handle: (p, cx) => turnsPage(cx, localSession(cx, p.str("id")).id, p.optStr("cursor"), p.optInt("limit", { min: 1, max: 500 }) ?? PAGE),
	},
	{ name: "sessions.subscribe", members: true, handle: subscribe },
	{
		name: "sessions.unsubscribe",
		members: true,
		handle: (p, cx) => {
			cx.socket?.unsubscribe(p.str("id"));
			return { unsubscribed: true };
		},
	},
	{ name: "sessions.submit", http: "POST /sessions/:id/submit", members: true, handle: submit },
	{
		name: "sessions.steer",
		http: "POST /sessions/:id/steer",
		members: true,
		handle: async (p, cx) => {
			const row = localSession(cx, p.str("id"));
			const r = await cx.core.sessions.submit(row.id, p.str("text"), { whenBusy: "steer" });
			return { status: r.status === "steered" ? "steered" : "started" };
		},
	},
	{
		name: "sessions.interrupt",
		http: "POST /sessions/:id/interrupt",
		members: true,
		handle: async (p, cx) => ({ interrupted: await cx.core.sessions.interrupt(localSession(cx, p.str("id")).id) }),
	},
	{
		name: "sessions.compact",
		http: "POST /sessions/:id/compact",
		members: true,
		handle: async (p, cx) => {
			const row = localSession(cx, p.str("id"));
			await cx.core.engine.compact(row.conversation_id, p.optStr("instructions") || undefined);
			return { started: true };
		},
	},
	{ name: "sessions.usage", http: "GET /sessions/:id/usage", members: true, handle: async (p, cx) => ({ usage: usageJson(await cx.core.sessions.usage(localSession(cx, p.str("id")).id)) }) },
	{
		name: "sessions.context",
		http: "GET /sessions/:id/context",
		members: true,
		handle: async (p, cx) => {
			const row = localSession(cx, p.str("id"));
			const [stats, usage] = await Promise.all([cx.core.engine.contextStats(row.conversation_id), cx.core.sessions.usage(row.id)]);
			// The total is the provider's own count from the last call; the estimate only splits it up.
			const estimated = usage.contextUsed <= 0;
			const used = estimated ? stats.system + stats.tools + stats.conversation : usage.contextUsed;
			const fixed = stats.system + stats.tools;
			const scale = fixed > used ? used / fixed : 1;
			const system = Math.round(stats.system * scale);
			const tools = Math.round(stats.tools * scale);
			const max = usage.contextMax;
			return {
				parts: [
					{ id: "system", label: "System prompt", tokens: system },
					{ id: "tools", label: "Tools", tokens: tools },
					{ id: "conversation", label: "Conversation", tokens: Math.max(0, used - system - tools) },
					{ id: "free", label: "Free", tokens: Math.max(0, max - used) },
				],
				used,
				max,
				percent: max > 0 ? Math.min(100, Math.round((used / max) * 100)) : 0,
				estimated,
				model: usage.model,
			};
		},
	},
	{
		name: "sessions.commands",
		http: "GET /sessions/:id/commands",
		members: true,
		handle: (p, cx) => {
			const row = localSession(cx, p.str("id"));
			return { items: commandCatalog(cx.core, cx.core.bots.require(row.bot)) };
		},
	},
	{
		name: "sessions.command",
		http: "POST /sessions/:id/commands",
		members: true,
		handle: async (p, cx) => {
			const row = localSession(cx, p.str("id"));
			try {
				return await runCommand(cx.core, cx.core.bots.require(row.bot), row.id, p.str("name").replace(/^\//, ""), p.optStr("args")?.trim() ?? "");
			} catch (error) {
				if (error instanceof CommandError) throw new ApiError("invalid_params", error.message);
				throw error;
			}
		},
	},
];
