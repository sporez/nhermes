// Admin API for the CLI (same token as Vory). The CLI never opens the databases itself: the running
// gateway is their only owner, so backups are made here with consistent online copies.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Core } from "./app.ts";
import { HttpError, obj, Router } from "./hermes/http.ts";
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
		execFileSync("tar", ["-czf", out, "-C", stage, "data", "config"]);
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
	return r;
}
