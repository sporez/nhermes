// Which bot a Hermes request is about (its `profile`), and which of the bots' files it may reach, shared by
// the REST route modules.
import { realpathSync } from "node:fs";
import { sep } from "node:path";
import type { Core } from "../app.ts";
import type { Bot } from "../core/bots.ts";
import { HttpError } from "../http.ts";

export function botFor(core: Core, profile: string | null | undefined): Bot {
	if (!profile || profile === "current" || (profile === "default" && !core.bots.get("default"))) return core.bots.defaultBot();
	const bot = core.bots.get(profile);
	if (!bot || (bot.isPeer && !bot.remote)) throw new HttpError(404, `Profile '${profile}' not found`);
	return bot;
}

/** Each local bot's workspace, resolved. */
export function workspaceRoots(core: Core): { bot: Bot; real: string }[] {
	return core.bots
		.list()
		.filter((b) => !b.isPeer && b.workspace)
		.map((b) => ({ bot: b, real: realpathSync(b.workspace) }));
}

/** A path inside one of the bots' workspaces, links resolved: 404 when missing, 403 anywhere else. */
export function insideWorkspace(core: Core, path: string): { real: string; root: { bot: Bot; real: string } } {
	let real: string;
	try {
		real = realpathSync(path);
	} catch {
		throw new HttpError(404, `${path} does not exist`);
	}
	const root = workspaceRoots(core).find((x) => real === x.real || real.startsWith(x.real + sep));
	if (!root) throw new HttpError(403, "only the bots' workspace folders can be browsed");
	return { real, root };
}

/** A member's bot is changed on its own machine. */
export function localOnly(bot: Bot): void {
	if (bot.remote) throw new HttpError(409, `${bot.displayName} belongs to ${bot.remote.node}; change it there`);
}
