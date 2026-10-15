// The web control panel at /panel: static files (src/panel/static) and a JSON API under /panel/api that
// calls the gateway's services in-process. The gateway token never reaches the browser. Without a panel
// password anyone on the LAN can use it (the owner's choice); with one, a login cookie is required.
// Either way, every change must come from the panel's own page: a custom header that cross-site pages
// cannot send without a CORS preflight (never granted), a matching Origin, and a Host that is an address
// or a local name (so a public DNS name pointed at this machine cannot reach it from a browser).
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join } from "node:path";
import { configView } from "../admin.ts";
import { groundRules, personaParts, personaText } from "../agent/extensions.ts";
import type { Core } from "../app.ts";
import { type BotConfig, ConfigError } from "../config.ts";
import type { Bot } from "../core/bots.ts";
import type { BotPatch, GatewayPatch } from "../core/settings.ts";
import { LinkError } from "../federation/link.ts";
import { FederationError } from "../federation/members.ts";
import { HttpError, obj, readJson, Router, sendJson } from "../hermes/http.ts";
import { logger } from "../log.ts";
import { MemoryAccessError } from "../memory/memory.ts";
import { PanelAuth } from "./auth.ts";

const log = logger("panel");
const STATIC_DIR = join(import.meta.dirname, "static");
const FILES: Record<string, string> = { "": "index.html", "index.html": "index.html", "panel.css": "panel.css", "panel.js": "panel.js" };
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8" };
const OPEN = new Set(["/panel/api/session", "/panel/api/login"]);

/** Host names a browser on the LAN or tailnet uses for this machine. */
export function localHost(hostHeader: string | undefined, nodeUrl?: string): boolean {
	if (!hostHeader) return false;
	const host = hostHeader.replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
	if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":")) return true;
	if (host === "localhost" || !host.includes(".")) return true;
	if (/\.(local|lan|home|home\.arpa|internal|ts\.net)$/.test(host)) return true;
	return nodeUrl !== undefined && new URL(nodeUrl).hostname.toLowerCase() === host;
}

function str(v: unknown, what: string): string {
	if (typeof v !== "string" || !v.trim()) throw new HttpError(400, `${what} is required`);
	return v;
}

export class Panel {
	private readonly core: Core;
	readonly auth: PanelAuth;
	private readonly api: Router;

	constructor(core: Core) {
		this.core = core;
		this.auth = new PanelAuth(core.db);
		this.api = this.routes();
	}

	async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
		const method = req.method ?? "GET";
		try {
			if (!this.core.config.panel.enabled) throw new HttpError(404, "Not Found");
			if (!localHost(req.headers.host, this.core.config.node.url)) throw new HttpError(403, "open the panel by this machine's address or local name");
			if (url.pathname === "/panel") {
				res.writeHead(301, { location: "/panel/" });
				return void res.end();
			}
			if (!url.pathname.startsWith("/panel/api/")) return this.file(res, url.pathname);
			if (method !== "GET") this.checkWrite(req);
			if (!OPEN.has(url.pathname) && !this.auth.allowed(req.headers.cookie)) throw new HttpError(401, "sign in to the panel");
			const matched = this.api.match(method, url.pathname);
			if (matched === undefined) throw new HttpError(404, "Not Found");
			if (matched === "method") throw new HttpError(405, "Method Not Allowed");
			const body = await readJson(req);
			const result = await matched.handler({ method, path: url.pathname, query: url.searchParams, params: matched.params, body, raw: req });
			if (result && typeof result === "object" && "setCookie" in result) {
				const { setCookie, ...rest } = result as { setCookie: string };
				res.setHeader("set-cookie", setCookie);
				return sendJson(res, 200, rest);
			}
			sendJson(res, 200, result ?? {});
		} catch (error) {
			const e = translate(error);
			if (e.status >= 500) log.error("panel request failed", { method, path: url.pathname, error: e.message });
			sendJson(res, e.status, { detail: e.message });
		}
	}

	/** A change must come from the panel's own page (see the file comment). */
	private checkWrite(req: IncomingMessage): void {
		if (req.headers["x-nhermes-panel"] !== "1") throw new HttpError(403, "changes must come from the panel page");
		const origin = req.headers.origin;
		if (origin !== undefined && origin !== `http://${req.headers.host}` && origin !== `https://${req.headers.host}`) throw new HttpError(403, "changes must come from the panel page");
		const type = req.headers["content-type"] ?? "";
		if (req.headers["content-length"] !== "0" && req.headers["content-length"] !== undefined && !type.includes("application/json")) throw new HttpError(415, "send JSON");
	}

	private file(res: ServerResponse, path: string): void {
		const name = FILES[path.replace(/^\/panel\/?/, "")];
		if (!name) throw new HttpError(404, "Not Found");
		const data = readFileSync(join(STATIC_DIR, name));
		res.writeHead(200, {
			"content-type": TYPES[extname(name)] ?? "application/octet-stream",
			"cache-control": "no-store",
			"content-security-policy": "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
			"x-content-type-options": "nosniff",
			"referrer-policy": "no-referrer",
		});
		res.end(data);
	}

	private bot(name: string): Bot {
		const bot = this.core.bots.get(name);
		if (!bot) throw new HttpError(404, `no bot named "${name}"`);
		return bot;
	}

	/** Who a memory belongs to: a local bot, or a shared space ("shared:<space>"). */
	private memoryScope(owner: string): { scope: { name: string; sharedMemory: string[] }; space?: string } {
		if (owner.startsWith("shared:")) {
			const space = owner.slice(7);
			return { scope: { name: "(panel)", sharedMemory: [space] }, space };
		}
		const bot = this.bot(owner);
		if (bot.remote) throw new HttpError(409, `${bot.displayName}'s memory is on ${bot.remote.node}`);
		return { scope: { name: bot.name, sharedMemory: [] } };
	}

	private routes(): Router {
		const r = new Router();
		const c = this.core;
		const auth = this.auth;

		// Sign-in
		r.on("GET", "/panel/api/session", (q) => ({ passwordSet: auth.passwordSet, signedIn: auth.allowed(q.raw.headers.cookie) }));
		r.on("POST", "/panel/api/login", (q) => {
			if (!auth.checkPassword(str(obj(q.body).password ?? "-", "password"))) throw new HttpError(401, "wrong password");
			return { ok: true, setCookie: PanelAuth.cookie(auth.issue()) };
		});
		r.on("POST", "/panel/api/logout", () => ({ ok: true, setCookie: PanelAuth.clearCookie() }));
		r.on("POST", "/panel/api/password", (q) => {
			const p = obj(q.body).password;
			auth.setPassword(typeof p === "string" && p ? p : null);
			return { ok: true, passwordSet: auth.passwordSet, setCookie: auth.passwordSet ? PanelAuth.cookie(auth.issue()) : PanelAuth.clearCookie() };
		});

		// Overview, bots and gateway settings
		r.on("GET", "/panel/api/state", async () => {
			const view = configView(c);
			const models = (await c.models.getAvailable()).map((m) => `${m.provider}/${m.id}`);
			return {
				node: c.members.self(),
				gateway: view.gateway,
				configPath: view.configPath,
				toolGroups: view.toolGroups,
				models,
				bots: view.bots.filter((b) => !c.bots.get(b.name)?.remote),
				remoteBots: c.bots.list().filter((b) => b.remote).map((b) => ({ name: b.name, displayName: b.displayName, description: b.description, node: b.remote!.node, reachable: b.remote!.reachable, model: `${b.model.provider}/${b.model.modelId}` })),
				spaces: [...new Set(c.config.bots.flatMap((b) => b.sharedMemory ?? []))].sort(),
				panel: { passwordSet: auth.passwordSet },
			};
		});
		r.on("POST", "/panel/api/reload", () => c.settings.reload());
		r.on("POST", "/panel/api/bots", (q) => {
			const b = obj(q.body);
			return c.settings.addBot({ ...(b as BotConfig), name: str(b.name, "name") });
		});
		r.on("PATCH", "/panel/api/bots/:name", (q) => c.settings.editBot(q.params.name!, obj(q.body) as BotPatch));
		r.on("DELETE", "/panel/api/bots/:name", (q) => c.settings.removeBot(q.params.name!));
		// The bot's system prompt as a new chat gets it: the editable parts (its instructions; the ground
		// rules, shared by all bots) and the generated ones. Tool descriptions are added by the engine.
		r.on("GET", "/panel/api/bots/:name/prompt", async (q) => {
			const bot = this.bot(q.params.name!);
			if (bot.remote) throw new HttpError(409, `${bot.displayName}'s prompt is on ${bot.remote.node}`);
			const p = await personaParts(c.deps, bot, "");
			return {
				...p,
				groundRulesCustom: c.config.groundRules !== undefined,
				builtInGroundRules: groundRules([...new Set([c.config.configDir, c.config.dataDir])]),
				tools: bot.toolGroups,
				full: await personaText(c.deps, bot, ""),
			};
		});
		r.on("PATCH", "/panel/api/gateway", (q) => c.settings.setGateway(obj(q.body) as GatewayPatch));

		// Network
		r.on("GET", "/panel/api/network", () => ({ self: c.members.self(), members: c.members.list() }));
		r.on("POST", "/panel/api/network/invite", (q) => {
			const url = obj(q.body).url;
			return c.members.invite({ url: typeof url === "string" && url ? url : undefined });
		});
		r.on("POST", "/panel/api/network/preview", (q) => c.members.preview(str(obj(q.body).code, "code")));
		r.on("POST", "/panel/api/network/join", async (q) => ({ members: await c.members.join(str(obj(q.body).code, "code")) }));
		r.on("POST", "/panel/api/network/leave", async () => (await c.members.leave(), { ok: true }));
		r.on("DELETE", "/panel/api/network/members/:name", async (q) => (await c.members.remove(q.params.name!), { ok: true }));
		r.on("POST", "/panel/api/network/refresh", async () => (await Promise.all([c.members.flush(), c.roster.sync()]), { ok: true }));

		// Sessions (minimal: list, rename, archive, stop, delete; reading chats stays in Vory)
		r.on("GET", "/panel/api/sessions", (q) => {
			const name = q.query.get("bot");
			const archived = (q.query.get("archived") ?? "exclude") as "exclude" | "only" | "include";
			const bots = name ? [this.bot(name)] : c.bots.list().filter((b) => !b.isPeer || b.remote);
			const rows = bots.flatMap((b) => c.sessions.list(b.name, { limit: 100, offset: 0, archived, order: "recent" }).rows);
			rows.sort((a, b) => b.last_active - a.last_active);
			return {
				sessions: rows.slice(0, 200).map((s) => ({
					id: s.id,
					bot: s.bot,
					kind: s.kind,
					title: s.title,
					preview: s.preview,
					source: s.source,
					lastActive: s.last_active,
					messages: s.message_count,
					archived: s.archived === 1,
					pinned: s.pinned === 1,
					running: c.sessions.isRunning(s.id),
					remote: s.remote_node !== null,
				})),
			};
		});
		r.on("PATCH", "/panel/api/sessions/:id", (q) => {
			const b = obj(q.body);
			const s = c.sessions.update(q.params.id!, {
				title: typeof b.title === "string" ? b.title : undefined,
				archived: typeof b.archived === "boolean" ? b.archived : undefined,
				pinned: typeof b.pinned === "boolean" ? b.pinned : undefined,
			});
			return { ok: true, title: s.title, archived: s.archived === 1, pinned: s.pinned === 1 };
		});
		r.on("POST", "/panel/api/sessions/:id/stop", async (q) => {
			const id = q.params.id!;
			c.sessions.require(id);
			if (c.proxy.isProxy(id)) return { stopped: (await c.proxy.forward(id, "session.interrupt", { session_id: id })).interrupted === true };
			return { stopped: await c.sessions.interrupt(id) };
		});
		r.on("DELETE", "/panel/api/sessions/:id", async (q) => ({ deleted: await c.sessions.delete(q.params.id!) }));

		// Memory (minimal: search, view, add, edit, pin, delete)
		r.on("GET", "/panel/api/memory", (q) => {
			const { scope, space } = this.memoryScope(str(q.query.get("owner"), "owner"));
			const term = q.query.get("q")?.trim();
			return { items: term ? c.memory.search(scope, term, { limit: 50, space }) : c.memory.list(scope, { limit: 300, space }) };
		});
		r.on("POST", "/panel/api/memory", (q) => {
			const b = obj(q.body);
			const { scope, space } = this.memoryScope(str(b.owner, "owner"));
			return c.memory.add(scope, { body: str(b.body, "body"), title: typeof b.title === "string" ? b.title : undefined, pinned: b.pinned === true, space, source: "owner" });
		});
		r.on("PATCH", "/panel/api/memory/:id", (q) => {
			const b = obj(q.body);
			const { scope } = this.memoryScope(str(b.owner, "owner"));
			return c.memory.update(scope, Number(q.params.id), {
				body: typeof b.body === "string" ? b.body : undefined,
				title: typeof b.title === "string" ? b.title : undefined,
				pinned: typeof b.pinned === "boolean" ? b.pinned : undefined,
			});
		});
		r.on("DELETE", "/panel/api/memory/:id", (q) => {
			const { scope } = this.memoryScope(str(q.query.get("owner"), "owner"));
			return { deleted: c.memory.forget(scope, Number(q.params.id)) };
		});

		// Status: what is running, what waits for the owner, scheduled jobs
		r.on("GET", "/panel/api/status", () => ({
			running: c.sessions.runningCount(),
			approvals: c.approvals.allPending().map((a) => ({ id: a.requestId, sessionId: a.sessionId, bot: a.bot, tool: a.toolName, command: a.command, description: a.description, createdAt: a.createdAt })),
			jobs: c.scheduler.list().map((j) => {
				const last = c.scheduler.lastRun(j.id);
				return { id: j.id, name: j.name, bot: j.bot, enabled: j.enabled === 1, nextRunAt: j.next_run_at, running: c.scheduler.isRunning(j.id), lastStatus: last?.status ?? null, lastError: last?.error || null, lastRunAt: last?.started_at ?? null };
			}),
		}));
		r.on("POST", "/panel/api/approvals/:id", (q) => {
			const choice = obj(q.body).choice;
			if (choice !== "once" && choice !== "session" && choice !== "always" && choice !== "deny") throw new HttpError(400, "choice must be once, session, always or deny");
			return { answered: c.approvals.answer(q.params.id!, choice) };
		});
		r.on("POST", "/panel/api/jobs/:id/:action", (q) => {
			const id = q.params.id!;
			if (q.params.action === "pause") c.scheduler.setEnabled(id, false);
			else if (q.params.action === "resume") c.scheduler.setEnabled(id, true);
			else throw new HttpError(404, "Not Found");
			return { ok: true };
		});
		return r;
	}
}

function translate(error: unknown): { status: number; message: string } {
	if (error instanceof HttpError) return { status: error.status, message: error.message };
	if (error instanceof ConfigError) return { status: 400, message: error.message };
	if (error instanceof FederationError) return { status: error.status, message: error.message };
	if (error instanceof LinkError) return { status: 502, message: error.message };
	if (error instanceof MemoryAccessError) return { status: 403, message: error.message };
	if (error instanceof Error && error.name === "UnknownSession") return { status: 404, message: "Session not found" };
	if (error instanceof Error && error.name === "JobError") return { status: (error as Error & { status: number }).status ?? 400, message: error.message };
	if (error instanceof Error && /panel password/.test(error.message)) return { status: 400, message: error.message };
	return { status: 500, message: error instanceof Error ? error.message : String(error) };
}
