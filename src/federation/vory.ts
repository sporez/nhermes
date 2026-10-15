// Vory's settings screens for a member's bot. Vory talks to one gateway; when the selected profile is a
// bot on another machine, its Tools, Skills, Config, instructions, model and usage requests go over the
// member link to the machine that owns the bot, which answers them with its own Vory handlers for its
// own bot. Reads are always answered; changes only when that machine allows bot edits from members
// (its panel: Network), as the panel's remote bot editor requires.
import type { Core } from "../app.ts";
import type { Bot } from "../core/bots.ts";
import { HttpError, obj, type Req, Router } from "../hermes/http.ts";
import { restRoutes } from "../hermes/rest.ts";
import { logger } from "../log.ts";
import { ownBots } from "../panel/views.ts";
import { FederationError } from "./members.ts";

const log = logger("vory-remote");

/** The Vory requests that follow a member's bot, and whether each one changes it. */
const FORWARDED: { method: string; re: RegExp; write: boolean; nameInPath?: boolean }[] = [
	{ method: "GET", re: /^\/api\/tools\/toolsets$/, write: false },
	{ method: "PUT", re: /^\/api\/tools\/toolsets\/[^/]+$/, write: true },
	{ method: "GET", re: /^\/api\/skills$/, write: false },
	{ method: "PUT", re: /^\/api\/skills\/toggle$/, write: true },
	{ method: "GET", re: /^\/api\/config$/, write: false },
	{ method: "GET", re: /^\/api\/config\/schema$/, write: false },
	{ method: "PUT", re: /^\/api\/config$/, write: true },
	{ method: "GET", re: /^\/api\/profiles\/[^/]+\/soul$/, write: false, nameInPath: true },
	{ method: "PUT", re: /^\/api\/profiles\/[^/]+\/(soul|description|model)$/, write: true, nameInPath: true },
	{ method: "POST", re: /^\/api\/model\/set$/, write: true },
	{ method: "GET", re: /^\/api\/analytics\/usage$/, write: false },
];

const rule = (method: string, path: string) => FORWARDED.find((f) => f.method === method && f.re.test(path));

type Forward = { method: string; path: string; query: Record<string, string>; body?: unknown };

/**
 * On the gateway Vory is connected to: answers a request about a member's bot by asking that member.
 * Returns undefined when the request is not one of these or is about a bot of this machine.
 */
export async function forwardVory(core: Core, method: string, url: URL, body: unknown): Promise<unknown> {
	const f = rule(method, url.pathname);
	if (!f) return undefined;
	const name = f.nameInPath ? decodeURIComponent(url.pathname.split("/")[3]!) : (url.searchParams.get("profile") ?? (obj(body).profile as string | undefined));
	const bot: Bot | undefined = name ? core.bots.get(name) : undefined;
	if (!bot?.remote) return undefined;
	const m = core.members.byName(bot.remote.node);
	if (!m) throw new HttpError(404, `no member named "${bot.remote.node}"`);
	const query = Object.fromEntries([...url.searchParams].filter(([k]) => k !== "profile" && k !== "token"));
	const path = f.nameInPath ? url.pathname.replace(/^(\/api\/profiles\/)[^/]+/, `$1${encodeURIComponent(bot.remote.bot)}`) : url.pathname;
	const forward: Forward = { method, path, query, ...(body === undefined ? {} : { body }) };
	try {
		const r = await core.members.call(m, `/federation/manage/vory/${encodeURIComponent(bot.remote.bot)}`, forward, "POST", 30_000);
		if (f.write) void core.roster.sync().catch(() => {});
		return r;
	} catch (error) {
		if (error instanceof FederationError) throw new HttpError(error.status === 401 ? 502 : error.status, error.status === 401 ? `${bot.remote.node} no longer accepts this machine; join it to the network again` : error.message);
		throw error;
	}
}

/** On the machine that owns the bot: runs a member's forwarded Vory request with this machine's own handlers. */
export function voryMemberRoutes(core: Core): Router {
	const r = new Router();
	const rest = restRoutes(core);
	r.on("POST", "/federation/manage/vory/:bot", async (q: Req) => {
		if (!q.member) throw new HttpError(401, "Unauthorized");
		const b = obj(q.body);
		const method = String(b.method ?? "");
		const path = String(b.path ?? "");
		const f = rule(method, path);
		if (!f) throw new HttpError(400, `${method} ${path} is not something a member can ask for`);
		const bot = ownBots(core).find((x) => x.name === q.params.bot);
		if (!bot) throw new HttpError(404, `no bot named "${q.params.bot}" on ${core.members.self().name}`);
		if (f.nameInPath && decodeURIComponent(path.split("/")[3]!) !== bot.name) throw new HttpError(400, "the path names another bot");
		if (f.write && !core.members.acceptsBotEdits()) {
			throw new HttpError(403, `${core.members.self().name} does not accept bot edits from other machines; turn on "Let other machines edit this machine's bots" in its panel (Network)`);
		}
		const matched = rest.match(method, path);
		if (!matched || matched === "method") throw new HttpError(404, "Not Found");
		const query = new URLSearchParams(Object.entries(obj(b.query)).map(([k, v]) => [k, String(v)]));
		query.set("profile", bot.name);
		const forwardedBody = b.body && typeof b.body === "object" && !Array.isArray(b.body) ? { ...(b.body as object), profile: bot.name } : b.body;
		const result = await matched.handler({ method, path, query, params: matched.params, body: forwardedBody, raw: q.raw });
		if (f.write) log.info("bot changed from Vory on a member", { bot: bot.name, change: `${method} ${path}`, by: q.member.name });
		return result;
	});
	return r;
}
