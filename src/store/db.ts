// The application database (ours; Pi Durable owns durable.sqlite). Forward-only migrations.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

const MIGRATIONS: readonly string[] = [
	// 1: sessions catalogue, approval rules, per-bot overrides
	`
	CREATE TABLE sessions (
		id TEXT PRIMARY KEY,
		conversation_id INTEGER NOT NULL UNIQUE,
		bot TEXT NOT NULL,
		kind TEXT NOT NULL DEFAULT 'chat',
		title TEXT NOT NULL DEFAULT '',
		title_source TEXT NOT NULL DEFAULT 'auto',
		preview TEXT NOT NULL DEFAULT '',
		source TEXT NOT NULL DEFAULT 'ios',
		created_at REAL NOT NULL,
		last_active REAL NOT NULL,
		message_count INTEGER NOT NULL DEFAULT 0,
		model_calls INTEGER NOT NULL DEFAULT 0,
		archived INTEGER NOT NULL DEFAULT 0,
		pinned INTEGER NOT NULL DEFAULT 0,
		deleted INTEGER NOT NULL DEFAULT 0,
		parent_id TEXT,
		job_id TEXT
	);
	CREATE INDEX sessions_bot_recent ON sessions(bot, deleted, last_active DESC);
	CREATE TABLE approval_rules (
		scope TEXT NOT NULL,
		rule TEXT NOT NULL,
		created_at REAL NOT NULL,
		PRIMARY KEY (scope, rule)
	);
	CREATE TABLE bot_overrides (
		bot TEXT PRIMARY KEY,
		json TEXT NOT NULL
	);
	CREATE TABLE audit (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		at REAL NOT NULL,
		bot TEXT,
		session_id TEXT,
		kind TEXT NOT NULL,
		detail TEXT NOT NULL
	);
	`,
];

export type Row = Record<string, SQLInputValue>;

export class AppDb {
	readonly db: DatabaseSync;
	readonly path: string;

	constructor(path: string) {
		this.path = path;
		if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
		this.db = new DatabaseSync(path);
		this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
		this.migrate();
	}

	private migrate(): void {
		this.db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
		const row = this.db.prepare("SELECT version FROM schema_version").get() as { version: number } | undefined;
		let version = row?.version ?? 0;
		if (!row) this.db.prepare("INSERT INTO schema_version (version) VALUES (0)").run();
		while (version < MIGRATIONS.length) {
			const sql = MIGRATIONS[version]!;
			this.tx(() => {
				this.db.exec(sql);
				this.db.prepare("UPDATE schema_version SET version = ?").run(version + 1);
			});
			version++;
		}
	}

	get schemaVersion(): number {
		return (this.db.prepare("SELECT version FROM schema_version").get() as { version: number }).version;
	}

	tx<T>(fn: () => T): T {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const out = fn();
			this.db.exec("COMMIT");
			return out;
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	all<T>(sql: string, ...params: SQLInputValue[]): T[] {
		return this.db.prepare(sql).all(...params) as T[];
	}

	get<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
		return this.db.prepare(sql).get(...params) as T | undefined;
	}

	run(sql: string, ...params: SQLInputValue[]): { changes: number; lastInsertRowid: number } {
		const r = this.db.prepare(sql).run(...params);
		return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
	}

	/** Consistent online copy (used by backup). */
	vacuumInto(target: string): void {
		this.db.prepare("VACUUM INTO ?").run(target);
	}

	close(): void {
		this.db.close();
	}
}

export const MIGRATION_COUNT = MIGRATIONS.length;
