// What a new bot's config entry is made of: the name rule, and a copy of another bot's settings. Shared by
// Vory's "new profile" and the client API's bots.create so both clone the same way.
import type { BotConfig } from "../config.ts";
import type { Bot } from "./bots.ts";

export const BOT_NAME = /^[a-z0-9][a-z0-9-]{0,40}$/;
export const BOT_NAME_RULE = "use lowercase letters, digits and dashes, starting with a letter or digit (max 41 characters)";

/** A copy of `from`'s settings and instructions under a new name: not its name, default flag, display name, workspace, SOUL file or peer. */
export function cloneEntry(from: Bot, name: string): BotConfig {
	const { name: _n, default: _d, displayName: _dn, workspace: _w, soulFile: _s, peer: _p, ...rest } = from.config;
	return { ...rest, name, instructions: from.instructions };
}
