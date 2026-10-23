// Admin API for the CLI (the gateway token, as Bearer). The CLI never opens the databases itself: the running
// gateway is their only owner, so backups are made here with consistent online copies.
import { execFileSync } from "node:child_process";
import { chmodSync, closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Core } from "./app.ts";
import { type BotConfig, ConfigError } from "./config.ts";
import { SecretError } from "./core/secrets.ts";
import { UpdateError } from "./core/updates.ts";
import type { BotPatch, GatewayPatch } from "./core/settings.ts";
import { loginCall, remoteLoginRoutes } from "./federation/logins.ts";
import { mcpAction, mcpCall, mcpDetail, mcpEdit, mcpList, mcpPatch } from "./mcp/manage.ts";
import { PanelAuth } from "./panel/auth.ts";
import { HttpError, obj, Router } from "./http.ts";
import { logger } from "./log.ts";

const log = logger("admin");

/** Consistent copy of a live SQLite file (WAL-safe) through a separate read connection. */
function snapshotSqlite(src: string, dest: string): void {
	const db = new DatabaseSync(src, { readOnly: true });
	try {
		db.prepare("VACUUM INTO ?").run(dest);
	} finally {
		db.close();
	}
}

/** Writes a .tar.gz with data/ (databases as snapshots), config.yaml, skills/ and bots/. */
export function makeBackup(core: Core, out: string, includeSecrets: boolean): { path: string; bytes: number } {
	const stage = mkdtempSync(join(tmpdir(), "nhermes-backup-"));
	try {
		const data = join(stage, "data");
		mkdirSync(data, { recursive: true });
		snapshotSqlite(join(core.config.dataDir, "durable.sqlite"), join(data, "durable.sqlite"));
		core.db.vacuumInto(join(data, "app.sqlite"));
		if (!includeSecrets) {
			// Member pair secrets are credentials (also queued introductions and the key that signs panel
			// cookies): without --secrets a restored machine joins again. The panel password hash stays.
			const copy = new DatabaseSync(join(data, "app.sqlite"));
			try {
				copy.exec("UPDATE members SET secret = '', prev_secret = NULL, prev_until = NULL; DELETE FROM invites; DELETE FROM member_outbox; DELETE FROM settings WHERE key = 'panel.cookieKey';");
			} finally {
				copy.close();
			}
		}
		for (const sub of ["workspaces", "ssh", "browser"]) {
			const from = join(core.config.dataDir, sub);
			if (existsSync(from)) cpSync(from, join(data, sub), { recursive: true, filter: (p) => !/\/(Cache|Code Cache|GPUCache|Service Worker\/CacheStorage)(\/|$)/.test(p) && !/Singleton(Lock|Socket|Cookie)$/.test(p) });
		}
		const conf = join(stage, "config");
		mkdirSync(conf);
		cpSync(core.config.configPath, join(conf, "config.yaml"));
		for (const sub of ["skills", "bots"]) {
			const from = join(core.config.configDir, sub);
			if (existsSync(from)) cpSync(from, join(conf, sub), { recursive: true });
		}
		const secrets = join(core.config.configDir, "secrets.env");
		if (includeSecrets && existsSync(secrets)) cpSync(secrets, join(conf, "secrets.env"));
		mkdirSync(dirname(out), { recursive: true });
		// Owner-only from the first byte: the file exists with mode 0600 before tar writes to it.
		closeSync(openSync(out, "w", 0o600));
		execFileSync("tar", ["-czf", out, "-C", stage, "data", "config"]);
		chmodSync(out, 0o600);
		const bytes = Number(execFileSync("wc", ["-c", out]).toString().trim().split(/\s+/)[0]);
		log.info("backup written", { path: out, bytes, includeSecrets });
		return { path: out, bytes };
	} finally {
		rmSync(stage, { recursive: true, force: true });
	}
}

/**
 * Restores a backup into an (offline) installation: the current data directory is kept aside as
 * <dataDir>.pre-restore-<time>, config files are restored only when `withConfig`.
 */
export function restoreBackup(file: string, dataDir: string, configDir: string, withConfig: boolean): { previous?: string } {
	const stage = mkdtempSync(join(tmpdir(), "nhermes-restore-"));
	try {
		execFileSync("tar", ["-xzf", file, "-C", stage]);
		if (!existsSync(join(stage, "data", "durable.sqlite"))) throw new Error(`${basename(file)} is not an nhermes backup`);
		let previous: string | undefined;
		if (existsSync(dataDir)) {
			previous = `${dataDir}.pre-restore-${new Date().toISOString().replace(/[:.]/g, "-")}`;
			renameSync(dataDir, previous);
		}
		cpSync(join(stage, "data"), dataDir, { recursive: true });
		if (withConfig) cpSync(join(stage, "config"), configDir, { recursive: true });
		return { previous };
	} finally {
		rmSync(stage, { recursive: true, force: true });
	}
}

export function adminRoutes(core: Core): Router {
	const r = new Router();
	r.on("GET", "/admin/status", () => ({
		bots: core.bots.list().map((b) => ({ name: b.name, model: `${b.model.provider}/${b.model.modelId}`, host: b.config.host?.ssh.host ?? null, tools: b.toolGroups })),
		running: core.sessions.runningCount(),
		jobs: core.scheduler.list().map((j) => ({ id: j.id, bot: j.bot, enabled: j.enabled === 1, next: j.next_run_at, last: core.scheduler.lastRun(j.id)?.status ?? null })),
		schema: core.db.schemaVersion,
		notifier: core.notifier.name,
	}));
	r.on("POST", "/admin/backup", (q) => {
		const b = obj(q.body);
		const out = typeof b.out === "string" && b.out ? b.out : join(core.config.dataDir, "..", `nhermes-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.tar.gz`);
		return makeBackup(core, out, b.includeSecrets === true);
	});
	r.on("POST", "/admin/hosts/:bot/scan", async (q) => {
		const bot = core.bots.get(q.params.bot!);
		if (!bot?.config.host) throw new HttpError(404, "bot has no host");
		return core.hosts.scan(bot);
	});
	r.on("POST", "/admin/hosts/:bot/trust", async (q) => {
		const bot = core.bots.get(q.params.bot!);
		if (!bot?.config.host) throw new HttpError(404, "bot has no host");
		const lines = obj(q.body).lines;
		if (!Array.isArray(lines) || lines.some((l) => typeof l !== "string")) throw new HttpError(400, "lines required");
		await core.hosts.trust(bot, lines as string[]);
		core.hosts.reset(bot.name);
		return { ok: true };
	});
	r.on("GET", "/admin/memory/:bot", (q) => {
		const bot = core.bots.get(q.params.bot!);
		if (!bot) throw new HttpError(404, "unknown bot");
		const query = q.query.get("q");
		return { items: query ? core.memory.search(bot, query, { limit: 50 }) : core.memory.list(bot, { limit: 200 }) };
	});
	r.on("POST", "/admin/memory/:bot", (q) => {
		const bot = core.bots.get(q.params.bot!);
		if (!bot) throw new HttpError(404, "unknown bot");
		const b = obj(q.body);
		if (typeof b.text !== "string") throw new HttpError(400, "text required");
		return core.memory.add(bot, { body: b.text, title: typeof b.title === "string" ? b.title : undefined, pinned: b.pinned === true, space: typeof b.space === "string" ? b.space : undefined, source: "owner" });
	});
	r.on("DELETE", "/admin/memory/:bot/:id", (q) => {
		const bot = core.bots.get(q.params.bot!);
		if (!bot) throw new HttpError(404, "unknown bot");
		return { deleted: core.memory.forget(bot, Number(q.params.id)) };
	});

	// Configuration: read, reload, and edit config.yaml through the running gateway.
	r.on("GET", "/admin/config", () => configView(core));
	r.on("POST", "/admin/reload", () => settingsCall(() => core.settings.reload()));
	r.on("POST", "/admin/bots", (q) => {
		const b = obj(q.body);
		if (typeof b.name !== "string") throw new HttpError(400, "name required");
		const fields = botFields(b, true) as BotConfig;
		return settingsCall(() => core.settings.addBot({ ...fields, name: b.name as string }));
	});
	r.on("PATCH", "/admin/bots/:name", (q) => settingsCall(() => core.settings.editBot(q.params.name!, botFields(obj(q.body), false))));
	r.on("DELETE", "/admin/bots/:name", (q) => settingsCall(() => core.settings.removeBot(q.params.name!)));
	r.on("PATCH", "/admin/gateway", (q) => settingsCall(() => core.settings.setGateway(obj(q.body) as GatewayPatch)));
	r.on("GET", "/admin/software", () => core.updates.status());
	r.on("POST", "/admin/software/check", () => updateCall(() => core.updates.check()));
	r.on("POST", "/admin/software/update", () => updateCall(() => core.updates.update()));
	r.on("POST", "/admin/software/rollback", () => updateCall(() => core.updates.rollback()));
	r.on("GET", "/admin/secrets", () => ({ secrets: core.secrets.list() }));
	r.on("PUT", "/admin/secrets/:name", (q) => secretCall(() => core.secrets.set(q.params.name!, String(obj(q.body).value ?? ""))));
	r.on("DELETE", "/admin/secrets/:name", (q) => secretCall(() => core.secrets.remove(q.params.name!)));
	r.on("POST", "/admin/secrets/token/new", () => secretCall(() => core.secrets.newToken()));
	r.on("GET", "/admin/logins", async () => ({ providers: await core.logins.list() }));
	r.on("POST", "/admin/logins", (q) => {
		const provider = obj(q.body).provider;
		if (typeof provider !== "string" || !provider) throw new HttpError(400, "provider required");
		return loginCall(() => core.logins.start(provider, "cli"));
	});
	r.on("GET", "/admin/logins/:id", (q) => loginCall(() => core.logins.get(q.params.id!)));
	r.on("POST", "/admin/logins/:id/answer", (q) => {
		const value = obj(q.body).value;
		if (typeof value !== "string") throw new HttpError(400, "value required");
		return loginCall(() => core.logins.answer(q.params.id!, value));
	});
	r.on("DELETE", "/admin/logins/providers/:provider", (q) => loginCall(() => core.logins.logout(q.params.provider!, "cli")));
	r.on("DELETE", "/admin/logins/:id", (q) => loginCall(() => core.logins.cancel(q.params.id!, "cli")));
	remoteLoginRoutes(core, r, "/admin/remote");
	// MCP servers (`nhermes mcp`), the same calls the panel makes (src/mcp/manage.ts).
	r.on("GET", "/admin/mcp", () => mcpList(core));
	r.on("GET", "/admin/mcp/:name", (q) => mcpCall(() => mcpDetail(core, q.params.name!)));
	r.on("POST", "/admin/mcp", (q) => {
		const b = obj(q.body);
		if (typeof b.name !== "string" || !b.name) throw new HttpError(400, "name is required");
		return mcpCall(() => core.settings.addMcpServer(b.name as string, mcpPatch(b)));
	});
	r.on("PATCH", "/admin/mcp/:name", (q) => mcpCall(() => mcpEdit(core, q.params.name!, () => core.settings.editMcpServer(q.params.name!, mcpPatch(obj(q.body))))));
	r.on("DELETE", "/admin/mcp/:name", (q) => mcpCall(() => mcpEdit(core, q.params.name!, () => core.settings.removeMcpServer(q.params.name!))));
	r.on("POST", "/admin/mcp/:name/:action", (q) => mcpCall(() => mcpAction(core, q.params.name!, q.params.action!)));
	r.on("POST", "/admin/panel/password", (q) => {
		const p = obj(q.body).password;
		try {
			new PanelAuth(core.db).setPassword(typeof p === "string" && p ? p : null);
		} catch (error) {
			throw new HttpError(400, error instanceof Error ? error.message : String(error));
		}
		return { ok: true, passwordSet: typeof p === "string" && p !== "" };
	});
	return r;
}

/** Keys a bot entry may carry (the name is the route's or the create body's). */
const BOT_KEYS = new Set<string>([
	"displayName",
	"description",
	"default",
	"instructions",
	"soulFile",
	"model",
	"thinking",
	"tools",
	"skills",
	"sharedMemory",
	"recentChats",
	"approvals",
	"trusted",
	"private",
	"workspace",
	"host",
	"peer",
	"secrets",
	"browser",
	"desktop",
	"openchamber",
]);

function botFields(body: Record<string, unknown>, creating: boolean): BotPatch {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(body)) {
		if (k === "name" && creating) continue;
		if (!BOT_KEYS.has(k)) throw new HttpError(400, `unknown bot setting "${k}"`);
		out[k] = v;
	}
	return out as BotPatch;
}

function updateCall<T>(fn: () => T): T {
	try {
		return fn();
	} catch (error) {
		if (error instanceof UpdateError) throw new HttpError(error.status, error.message);
		throw error;
	}
}

function secretCall<T>(fn: () => T): T {
	try {
		return fn();
	} catch (error) {
		if (error instanceof SecretError) throw new HttpError(error.status, error.message);
		throw error;
	}
}

function settingsCall<T>(fn: () => T): T {
	try {
		return fn();
	} catch (error) {
		if (error instanceof ConfigError) throw new HttpError(400, error.message);
		throw error;
	}
}

/** The gateway's settings and every bot: its config entry, what is in effect, and runtime overrides. */
export function configView(core: Pick<Core, "config" | "toolGroups" | "bots">) {
	const c = core.config;
	return {
		configPath: c.configPath,
		gateway: { server: c.server, defaults: c.defaults, timezone: c.timezone },
		toolGroups: [...core.toolGroups.keys()],
		bots: core.bots.list().map((b) => ({
			name: b.name,
			config: b.config,
			effective: {
				displayName: b.displayName,
				description: b.description,
				model: `${b.model.provider}/${b.model.modelId}`,
				thinking: b.thinking,
				tools: b.toolGroups,
				approvals: b.approvals.mode,
				recentChats: b.recentChats,
				trusted: b.trusted,
				private: b.private,
				default: b.isDefault,
				peer: b.isPeer,
				instructions: b.instructions,
				instructionsFrom: core.bots.overrides(b.name).instructions !== undefined ? "override" : b.config.instructions ? "config" : existsSync(core.bots.soulPath(b.config)) ? "soul file" : "default",
			},
			overrides: core.bots.overrides(b.name),
		})),
	};
}
