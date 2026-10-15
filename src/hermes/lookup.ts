// Which bot a Hermes request is about (its `profile`), shared by the REST route modules.
import type { Core } from "../app.ts";
import type { Bot } from "../core/bots.ts";
import { HttpError } from "./http.ts";

export function botFor(core: Core, profile: string | null | undefined): Bot {
	if (!profile || profile === "current" || (profile === "default" && !core.bots.get("default"))) return core.bots.defaultBot();
	const bot = core.bots.get(profile);
	if (!bot || (bot.isPeer && !bot.remote)) throw new HttpError(404, `Profile '${profile}' not found`);
	return bot;
}

/** A member's bot is changed on its own machine. */
export function localOnly(bot: Bot): void {
	if (bot.remote) throw new HttpError(409, `${bot.displayName} belongs to ${bot.remote.node}; change it there`);
}
