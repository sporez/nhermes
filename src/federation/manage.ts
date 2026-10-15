// Editing this gateway's bots from another member's panel. Only when this gateway's owner allowed it
// (Network: "Let other machines edit this machine's bots"). The member's panel sends the same edits this
// gateway's own panel would, and they run through the same services here: this machine's config.yaml is
// written by this machine. Settings that point at this machine's files, hosts or credentials stay local.
import type { Core } from "../app.ts";
import { type BotConfig, ConfigError } from "../config.ts";
import type { Bot } from "../core/bots.ts";
import type { BotPatch } from "../core/settings.ts";
import { HttpError, obj, type Req, Router } from "../hermes/http.ts";
import { logger } from "../log.ts";
import { editorView, ownBots, promptView, skillsView } from "../panel/views.ts";
import type { MemberRow } from "./members.ts";

const log = logger("manage");

/** The bot settings a member may change: what the panel's bot editor sends. */
export const MEMBER_BOT_KEYS = new Set<string>(["displayName", "description", "model", "thinking", "tools", "skills", "sharedMemory", "approvals", "trusted", "private", "default", "instructions"]);

function fields(body: Record<string, unknown>, creating: boolean): BotPatch {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(body)) {
		if (k === "name" && creating) continue;
		if (!MEMBER_BOT_KEYS.has(k)) throw new HttpError(400, `"${k}" can only be changed on the bot's own machine`);
		out[k] = v;
	}
	return out as BotPatch;
}

function settingsCall<T>(fn: () => T): T {
	try {
		return fn();
	} catch (error) {
		if (error instanceof ConfigError) throw new HttpError(400, error.message);
		throw error;
	}
}

export function manageRoutes(core: Core): Router {
	const r = new Router();
	const allowed = (q: Req): MemberRow => {
		if (!q.member) throw new HttpError(401, "Unauthorized");
		if (!core.members.acceptsBotEdits()) throw new HttpError(403, `${core.members.self().name} does not accept bot edits from other machines; turn that on in its panel (Network)`);
		return q.member;
	};
	const bot = (name: string): Bot => {
		const b = ownBots(core).find((x) => x.name === name);
		if (!b) throw new HttpError(404, `no bot named "${name}" on ${core.members.self().name}`);
		return b;
	};
	const changed = (q: Req, what: string, name: string, keys: string[] = []) => log.info(`bot ${what} by a member`, { bot: name, fields: keys, by: q.member!.name });

	r.on("GET", "/federation/manage", async (q) => {
		allowed(q);
		const view = await editorView(core);
		// The member's editor gets the settings it can change; hosts, workspaces and key names stay here.
		const bots = view.bots.map((b) => ({ ...b, config: Object.fromEntries(Object.entries(b.config).filter(([k]) => k === "name" || MEMBER_BOT_KEYS.has(k))) }));
		return { node: core.members.self().name, ...view, bots };
	});
	r.on("POST", "/federation/manage/bots", (q) => {
		allowed(q);
		const b = obj(q.body);
		if (typeof b.name !== "string" || !b.name) throw new HttpError(400, "name is required");
		const f = fields(b, true);
		const result = settingsCall(() => core.settings.addBot({ ...(f as BotConfig), name: b.name as string }));
		changed(q, "created", b.name, Object.keys(f));
		return result;
	});
	r.on("PATCH", "/federation/manage/bots/:name", (q) => {
		allowed(q);
		const name = bot(q.params.name!).name;
		const f = fields(obj(q.body), false);
		const result = settingsCall(() => core.settings.editBot(name, f));
		changed(q, "edited", name, Object.keys(f));
		return result;
	});
	r.on("DELETE", "/federation/manage/bots/:name", (q) => {
		allowed(q);
		const name = bot(q.params.name!).name;
		const result = settingsCall(() => core.settings.removeBot(name));
		changed(q, "removed", name);
		return result;
	});
	r.on("GET", "/federation/manage/bots/:name/skills", (q) => (allowed(q), skillsView(core, bot(q.params.name!))));
	r.on("PUT", "/federation/manage/bots/:name/skills/:skill", (q) => {
		allowed(q);
		const enabled = obj(q.body).enabled;
		if (typeof enabled !== "boolean") throw new HttpError(400, "enabled must be true or false");
		const b = bot(q.params.name!);
		try {
			core.skills.setEnabled(core.bots, b, q.params.skill!, enabled);
		} catch (error) {
			if (error instanceof Error && error.name === "UnknownSkill") throw new HttpError(404, error.message);
			throw error;
		}
		changed(q, enabled ? "skill on" : "skill off", b.name, [q.params.skill!]);
		return { ok: true, enabled };
	});
	r.on("GET", "/federation/manage/bots/:name/prompt", (q) => (allowed(q), promptView(core, bot(q.params.name!))));
	return r;
}
