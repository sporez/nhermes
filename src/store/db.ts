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
	// 2: memory (with FTS5), skill usage, skills attached to a session (jobs)
	`
	CREATE TABLE memories (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		owner TEXT NOT NULL,
		kind TEXT NOT NULL DEFAULT 'fact',
		title TEXT NOT NULL DEFAULT '',
		body TEXT NOT NULL,
		tags TEXT NOT NULL DEFAULT '',
		source TEXT NOT NULL DEFAULT '',
		pinned INTEGER NOT NULL DEFAULT 0,
		created_at REAL NOT NULL,
		updated_at REAL NOT NULL
	);
	CREATE INDEX memories_owner ON memories(owner, pinned, updated_at DESC);
	CREATE VIRTUAL TABLE memories_fts USING fts5(title, body, tags, content='memories', content_rowid='id', tokenize='porter unicode61');
	CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
		INSERT INTO memories_fts(rowid, title, body, tags) VALUES (new.id, new.title, new.body, new.tags);
	END;
	CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
		INSERT INTO memories_fts(memories_fts, rowid, title, body, tags) VALUES ('delete', old.id, old.title, old.body, old.tags);
	END;
	CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN
		INSERT INTO memories_fts(memories_fts, rowid, title, body, tags) VALUES ('delete', old.id, old.title, old.body, old.tags);
		INSERT INTO memories_fts(rowid, title, body, tags) VALUES (new.id, new.title, new.body, new.tags);
	END;
	CREATE TABLE skill_usage (
		bot TEXT NOT NULL,
		skill TEXT NOT NULL,
		count INTEGER NOT NULL DEFAULT 0,
		last_used REAL,
		PRIMARY KEY (bot, skill)
	);
	ALTER TABLE sessions ADD COLUMN skills TEXT NOT NULL DEFAULT '[]';
	`,
	// 3: scheduled jobs and their run history
	`
	CREATE TABLE jobs (
		id TEXT PRIMARY KEY,
		name TEXT NOT NULL,
		bot TEXT NOT NULL,
		prompt TEXT NOT NULL,
		schedule_kind TEXT NOT NULL,
		schedule TEXT NOT NULL,
		timezone TEXT NOT NULL,
		model TEXT,
		skills TEXT NOT NULL DEFAULT '[]',
		notify TEXT NOT NULL DEFAULT 'on_error',
		deliver TEXT NOT NULL DEFAULT 'session',
		approvals TEXT NOT NULL DEFAULT 'deny',
		catch_up_s INTEGER NOT NULL DEFAULT 21600,
		enabled INTEGER NOT NULL DEFAULT 1,
		session_id TEXT,
		next_run_at REAL,
		created_at REAL NOT NULL,
		updated_at REAL NOT NULL
	);
	CREATE TABLE job_runs (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		job_id TEXT NOT NULL,
		occurrence TEXT NOT NULL,
		trigger TEXT NOT NULL,
		status TEXT NOT NULL,
		started_at REAL NOT NULL,
		finished_at REAL,
		submission_id INTEGER,
		summary TEXT NOT NULL DEFAULT '',
		error TEXT NOT NULL DEFAULT '',
		notified INTEGER NOT NULL DEFAULT 0,
		UNIQUE (job_id, occurrence)
	);
	CREATE INDEX job_runs_job ON job_runs(job_id, id DESC);
	`,
	// 4: a session follows its bot's model and reasoning level unless the chat chose its own
	`
	ALTER TABLE sessions ADD COLUMN model_override INTEGER NOT NULL DEFAULT 0;
	ALTER TABLE sessions ADD COLUMN thinking_override INTEGER NOT NULL DEFAULT 0;
	`,
	// 5: federation: this gateway's identity, the other members, open invites, and messages to members
	// that could not be delivered yet
	`
	CREATE TABLE node (
		id TEXT PRIMARY KEY,
		name TEXT NOT NULL,
		created_at REAL NOT NULL
	);
	CREATE TABLE members (
		node_id TEXT PRIMARY KEY,
		name TEXT NOT NULL UNIQUE,
		url TEXT NOT NULL,
		secret TEXT NOT NULL,
		joined_at REAL NOT NULL,
		last_seen REAL,
		last_error TEXT
	);
	CREATE TABLE invites (
		secret_hash TEXT PRIMARY KEY,
		expires_at REAL NOT NULL,
		used_by TEXT
	);
	CREATE TABLE member_outbox (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		node_id TEXT NOT NULL,
		path TEXT NOT NULL,
		body TEXT NOT NULL,
		created_at REAL NOT NULL,
		attempts INTEGER NOT NULL DEFAULT 0
	);
	`,
	// 6: the last known bots of each member (kept while a member is offline)
	`
	CREATE TABLE remote_bots (
		node_id TEXT NOT NULL,
		bot TEXT NOT NULL,
		display_name TEXT NOT NULL,
		description TEXT NOT NULL,
		model TEXT NOT NULL,
		updated_at REAL NOT NULL,
		PRIMARY KEY (node_id, bot)
	);
	`,
	// 7: chats with a member's bot: catalogued here, the conversation lives on the member (same id there).
	// Their conversation_id is a negative placeholder; they have no Durable conversation on this gateway.
	`
	ALTER TABLE sessions ADD COLUMN remote_node TEXT;
	`,
	// 8: small gateway settings kept out of config.yaml (the panel password hash and cookie key)
	`
	CREATE TABLE settings (
		key TEXT PRIMARY KEY,
		value TEXT NOT NULL
	);
	`,
	// 9: Jev permission reviews (what it was asked, what it answered, what the owner then chose)
	`
	CREATE TABLE reviews (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		at REAL NOT NULL,
		session_id TEXT NOT NULL,
		attention_id TEXT NOT NULL,
		bot TEXT NOT NULL,
		tool TEXT NOT NULL,
		command TEXT NOT NULL,
		reasons TEXT NOT NULL,
		outcome TEXT NOT NULL,
		p_allow REAL,
		p_deny REAL,
		confidence REAL,
		detail TEXT NOT NULL DEFAULT '',
		elapsed_ms INTEGER NOT NULL DEFAULT 0,
		owner_choice TEXT
	);
	CREATE INDEX reviews_recent ON reviews(id DESC);
	`,
	// 10: a job can keep one thread across runs ("continue") instead of starting each from a fresh context
	`
	ALTER TABLE jobs ADD COLUMN context TEXT NOT NULL DEFAULT 'fresh';
	`,
	// 11: members talk TLS-PSK on their encrypted port (src/federation/psk.ts): the port, the previous
	// secret and until when it is still accepted (while a new one settles), whether the member has reached
	// us encrypted, and whether the pair secret was replaced since it travelled in clear
	`
	ALTER TABLE members ADD COLUMN psk_port INTEGER;
	ALTER TABLE members ADD COLUMN prev_secret TEXT;
	ALTER TABLE members ADD COLUMN prev_until REAL;
	ALTER TABLE members ADD COLUMN psk_inbound INTEGER NOT NULL DEFAULT 0;
	ALTER TABLE members ADD COLUMN rotated INTEGER NOT NULL DEFAULT 0;
	`,
	// 12: the bot's latest chats as a new chat first saw them (src/tools/memory.ts), kept so its prompt
	// stays the same for the life of the chat; NULL until its first prompt. Chats that already exist keep
	// the prompt they had.
	`
	ALTER TABLE sessions ADD COLUMN recap TEXT;
	UPDATE sessions SET recap = '';
	`,
	// 13: group chats (src/core/rooms.ts): a room, its members (JSON), and its log of typed events, each
	// numbered in order within its room; a client's message id is unique within its room. room_sessions
	// holds each member's own session for a room thread; room_turns the submission of a turn in progress,
	// so a restart waits for that turn instead of losing it.
	`
	CREATE TABLE rooms (
		id TEXT PRIMARY KEY,
		name TEXT NOT NULL,
		members TEXT NOT NULL,
		created_at REAL NOT NULL,
		updated_at REAL NOT NULL,
		disbanded_at REAL
	);
	CREATE TABLE room_events (
		room_id TEXT NOT NULL REFERENCES rooms(id),
		seq INTEGER NOT NULL,
		event_id TEXT NOT NULL,
		kind TEXT NOT NULL,
		actor TEXT NOT NULL,
		payload TEXT NOT NULL,
		created_at REAL NOT NULL,
		PRIMARY KEY (room_id, seq),
		UNIQUE (room_id, event_id)
	);
	CREATE TABLE room_sessions (
		room_id TEXT NOT NULL REFERENCES rooms(id),
		thread_id TEXT NOT NULL,
		member_id TEXT NOT NULL,
		session_id TEXT NOT NULL,
		PRIMARY KEY (room_id, thread_id, member_id)
	);
	CREATE TABLE room_turns (
		room_id TEXT NOT NULL REFERENCES rooms(id),
		turn_id TEXT NOT NULL,
		session_id TEXT NOT NULL,
		submission_id INTEGER NOT NULL,
		PRIMARY KEY (room_id, turn_id)
	);
	`,
	// 14: a turn run on another machine is sent again after a restart (the other machine drops the repeat by
	// its key), so its prompt is kept with it
	`
	ALTER TABLE room_turns ADD COLUMN prompt TEXT;
	`,
	// 15: MCP servers (src/mcp/servers.ts): the last tool list each server gave, so its tools are known while
	// it is offline and after a restart, and a short log of what changed between lists
	`
	CREATE TABLE mcp_snapshots (
		server TEXT PRIMARY KEY,
		url TEXT NOT NULL,
		discovered_at REAL NOT NULL,
		connected_at REAL,
		server_info TEXT NOT NULL DEFAULT '{}',
		protocol_version TEXT NOT NULL DEFAULT '',
		instructions TEXT NOT NULL DEFAULT '',
		tools TEXT NOT NULL DEFAULT '[]'
	);
	CREATE TABLE mcp_changes (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		server TEXT NOT NULL,
		at REAL NOT NULL,
		added TEXT NOT NULL DEFAULT '[]',
		removed TEXT NOT NULL DEFAULT '[]',
		changed TEXT NOT NULL DEFAULT '[]'
	);
	CREATE INDEX mcp_changes_server ON mcp_changes(server, id DESC);
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
