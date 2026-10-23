// The bots' workspace folders as something to browse (read-only): which paths lie inside one, with links
// resolved so no link or `..` leads out, and the file types they are served as. Shared by the Hermes Files
// screen and the client API; both answer an HttpError (403 anywhere else, 404 when missing).
import { realpathSync } from "node:fs";
import { extname, sep } from "node:path";
import type { Core } from "../app.ts";
import { HttpError } from "../http.ts";
import type { Bot } from "./bots.ts";

/** The largest file the Files screens hand over. */
export const FILE_MAX = 50 * 1024 * 1024;

export const FILE_MIME: Record<string, string> = {
	".txt": "text/plain", ".md": "text/markdown", ".json": "application/json", ".yaml": "text/yaml", ".yml": "text/yaml", ".csv": "text/csv",
	".html": "text/html", ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
	".webp": "image/webp", ".svg": "image/svg+xml", ".mp3": "audio/mpeg", ".mp4": "video/mp4", ".zip": "application/zip",
};

export function mimeOf(path: string): string | undefined {
	return FILE_MIME[extname(path).toLowerCase()];
}

/** Each local bot's workspace, resolved. */
export function workspaceRoots(core: Core): { bot: Bot; real: string }[] {
	return core.bots
		.list()
		.filter((b) => !b.isPeer && b.workspace)
		.map((b) => ({ bot: b, real: realpathSync(b.workspace) }));
}

/** A path inside one of the bots' workspaces (only `botName`'s when given), links resolved: 404 when missing, 403 anywhere else. */
export function insideWorkspace(core: Core, path: string, botName?: string): { real: string; root: { bot: Bot; real: string } } {
	let real: string;
	try {
		real = realpathSync(path);
	} catch {
		throw new HttpError(404, `${path} does not exist`);
	}
	const root = workspaceRoots(core).find((x) => (botName === undefined || x.bot.name === botName) && (real === x.real || real.startsWith(x.real + sep)));
	if (!root) throw new HttpError(403, "only the bots' workspace folders can be browsed");
	return { real, root };
}
