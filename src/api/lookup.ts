// Which bot or chat a call names, as the caller may see it: the owner sees every bot this gateway lists
// (its own and the members'), a network member only this machine's shareable bots and the chats it started.
import type { Bot } from "../core/bots.ts";
import type { SessionRow } from "../core/sessions.ts";
import { shareable } from "../federation/roster.ts";
import { ApiError } from "./errors.ts";
import { memberOwns } from "./events.ts";
import type { OpContext } from "./ops.ts";

/** The bots a caller sees: the owner every local and member bot (not configured `peer:` agents), a member the shareable ones. */
export function visibleBots(cx: OpContext): Bot[] {
	const all = cx.core.bots.list();
	return cx.caller.kind === "member" ? shareable(all) : all.filter((b) => !b.isPeer || b.remote);
}

/** The bot an id names, or the default bot when none is given. */
export function botOf(cx: OpContext, id: string | undefined): Bot {
	if (!id) {
		const bot = cx.core.bots.defaultBot();
		if (cx.caller.kind === "member" && bot.private) throw new ApiError("bot_not_found", "This machine shares no default bot.");
		return bot;
	}
	const bot = visibleBots(cx).find((b) => b.name === id);
	if (!bot) throw new ApiError("bot_not_found", `No bot with id ${id}.`);
	return bot;
}

/** The chat an id names, if the caller may see it. */
export function sessionOf(cx: OpContext, id: string): SessionRow {
	const row = cx.core.sessions.get(id);
	if (!row || !memberOwns(row, cx.caller)) throw new ApiError("session_not_found", `No chat with id ${id}.`);
	return row;
}

/** A chat whose conversation is on this machine (a chat with a member's bot is answered by that member). */
export function localSession(cx: OpContext, id: string): SessionRow {
	const row = sessionOf(cx, id);
	if (row.remote_node) throw new ApiError("not_available", "Chats with another machine's bots are not available on this API yet.");
	return row;
}
