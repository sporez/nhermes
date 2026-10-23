// Bots and chats as a catalogue (docs/API.md "Bots", "Sessions"): listing, opening, creating, renaming,
// pinning, archiving, deleting, and a chat's own model, reasoning and Bypass switch.
import { THINKING_LEVELS, type ThinkingLevel } from "../../config.ts";
import type { SessionKind } from "../../core/sessions.ts";
import { memberSource } from "../../federation/members.ts";
import { ApiError } from "../errors.ts";
import { botOf, localSession, sessionOf, visibleBots } from "../lookup.ts";
import type { Op, OpContext } from "../ops.ts";
import type { Params } from "../params.ts";
import { botJson, sessionJson } from "../shapes/chat.ts";

/** Kinds a chat list leaves out unless asked: a bot's own session for a group chat and a delegated task. */
const UNLISTED: SessionKind[] = ["room", "delegate"];
const KINDS: SessionKind[] = ["chat", "job", "delegate", "room"];

function ownerOnly(cx: OpContext, what: string): void {
	if (cx.caller.kind === "member") throw new ApiError("not_allowed", `A network member cannot ${what}.`);
}

/** `provider/id` or `{provider, id}`, checked against the models this gateway has. */
function modelParam(cx: OpContext, p: Params): { provider: string; modelId: string } | undefined {
	const raw = p.raw.model;
	if (raw === undefined || raw === null) return undefined;
	let provider = "";
	let id = "";
	if (typeof raw === "string") {
		const i = raw.indexOf("/");
		provider = i > 0 ? raw.slice(0, i) : "";
		id = i > 0 ? raw.slice(i + 1) : raw;
	} else if (typeof raw === "object" && !Array.isArray(raw)) {
		const o = raw as Record<string, unknown>;
		provider = typeof o.provider === "string" ? o.provider : "";
		id = typeof o.id === "string" ? o.id : "";
	}
	if (!provider || !id || !cx.core.models.getModel(provider, id)) throw new ApiError("invalid_params", `There is no model ${provider ? `${provider}/` : ""}${id} on this gateway.`);
	return { provider, modelId: id };
}

async function list(p: Params, cx: OpContext) {
	ownerOnly(cx, "list chats");
	const botId = p.optStr("botId");
	const bot = botId ? botOf(cx, botId) : undefined;
	const limit = p.optInt("limit", { min: 1, max: 200 }) ?? 50;
	const offset = Number(p.optStr("cursor") ?? "0");
	if (!Number.isInteger(offset) || offset < 0) throw new ApiError("invalid_params", "cursor is not one this gateway gave out.");
	const q = p.optStr("q")?.trim();
	const archived = p.optEnum("archived", ["exclude", "only", "include"] as const) ?? (q ? "include" : "exclude");
	const order = p.optEnum("order", ["recent", "created"] as const) ?? "recent";
	const kinds = p.optList("kinds") as SessionKind[] | undefined;
	if (kinds?.some((k) => !KINDS.includes(k))) throw new ApiError("invalid_params", `kinds must be among: ${KINDS.join(", ")}.`);
	// A hidden session with an approval waiting is listed, so its card can be reached from the chat list.
	const waiting = [...new Set(cx.core.approvals.allPending().map((a) => a.sessionId))];
	const visible = new Set(visibleBots(cx).map((b) => b.name));
	const { rows, total } = cx.core.sessions.list(bot?.name, { limit, offset, archived, order, search: q || undefined, ...(kinds ? { kinds } : { exceptKinds: UNLISTED, exceptUnless: waiting }) });
	const items = await Promise.all(rows.filter((r) => visible.has(r.bot)).map((r) => sessionJson(cx.core, r)));
	return { items, total, nextCursor: offset + rows.length < total ? String(offset + rows.length) : null };
}

async function create(p: Params, cx: OpContext) {
	const bot = botOf(cx, p.optStr("botId"));
	const title = p.optStr("title")?.trim() || undefined;
	const kind = p.optEnum("kind", ["chat", "room"] as const) ?? "chat";
	if (kind === "room" && cx.caller.kind === "owner") throw new ApiError("invalid_params", "A group chat's sessions are made by the group chat itself.");
	if (bot.remote) throw new ApiError("not_available", "Chats with another machine's bots are not available on this API yet.");
	const source = cx.caller.kind === "member" ? memberSource(cx.caller.member.node_id, p.optBool("relay") === true) : (p.optStr("source") ?? "app");
	const row = await cx.core.sessions.create(bot.name, { kind, source, title });
	await cx.core.sessions.live(row.id);
	return { session: await sessionJson(cx.core, row) };
}

async function update(p: Params, cx: OpContext) {
	const id = p.str("id");
	const row = sessionOf(cx, id);
	const title = p.optStr("title");
	if (title !== undefined && !title.trim()) throw new ApiError("invalid_params", "A title cannot be empty.");
	const pinned = p.optBool("pinned");
	const archived = p.optBool("archived");
	const yolo = p.optBool("yolo");
	const model = modelParam(cx, p);
	const thinking = p.optEnum("thinking", THINKING_LEVELS as readonly ThinkingLevel[]);
	if (cx.caller.kind === "member" && (yolo !== undefined || pinned !== undefined || archived !== undefined)) throw new ApiError("not_allowed", "A network member can change only a chat's title, model and reasoning.");
	if ((model || thinking) && row.remote_node) throw new ApiError("not_available", "Chats with another machine's bots are not available on this API yet.");
	if (title !== undefined || pinned !== undefined || archived !== undefined) cx.core.sessions.update(id, { title, pinned, archived });
	if (yolo !== undefined) cx.core.approvals.setYolo(id, yolo);
	if (model) {
		await cx.core.engine.configure(row.conversation_id, { model });
		cx.core.sessions.markOverride(id, "model");
	}
	if (thinking) {
		await cx.core.engine.configure(row.conversation_id, { thinkingLevel: thinking as never });
		cx.core.sessions.markOverride(id, "thinking");
	}
	if (yolo !== undefined || model || thinking) cx.core.hub.publishGlobal({ type: "sessions.changed", bot: row.bot, sessionId: id });
	return { session: await sessionJson(cx.core, cx.core.sessions.require(id)) };
}

export const sessionOps: Op[] = [
	{ name: "bots.list", http: "GET /bots", members: true, handle: (_p, cx) => ({ items: visibleBots(cx).map((b) => botJson(cx.core, b)) }) },
	{ name: "bots.get", http: "GET /bots/:id", members: true, handle: (p, cx) => ({ bot: botJson(cx.core, botOf(cx, p.str("id"))) }) },
	{ name: "sessions.list", http: "GET /sessions", handle: list },
	{ name: "sessions.get", http: "GET /sessions/:id", members: true, handle: async (p, cx) => ({ session: await sessionJson(cx.core, sessionOf(cx, p.str("id"))) }) },
	{ name: "sessions.create", http: "POST /sessions", members: true, handle: create },
	{ name: "sessions.update", http: "PATCH /sessions/:id", members: true, handle: update },
	{
		name: "sessions.delete",
		http: "DELETE /sessions/:id",
		members: true,
		handle: async (p, cx) => {
			const row = sessionOf(cx, p.str("id"));
			cx.socket?.unsubscribe(row.id);
			await cx.core.sessions.delete(row.id);
			return { deleted: true };
		},
	},
	{
		name: "sessions.toolResult",
		http: "GET /sessions/:id/items/:itemId/result",
		members: true,
		handle: async (p, cx) => {
			const row = localSession(cx, p.str("id"));
			const itemId = p.str("itemId");
			const { turns } = await cx.core.sessions.turns(row.id);
			for (const t of turns) for (const item of t.items) if (item.type === "tool" && item.id === itemId) return { text: item.result, ...(item.json !== undefined ? { json: item.json } : {}) };
			throw new ApiError("not_found", "That chat has no tool call with that id.");
		},
	},
];
