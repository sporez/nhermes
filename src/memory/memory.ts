// Durable agent memory, separate from conversation history (which Pi Durable owns). Each item has one
// owner: a bot name, or "shared:<space>" for a shared space. A bot reads and writes its own items and
// the shared spaces its config lists; nothing is merged across bots automatically. Search is SQLite FTS5.
import type { AppDb } from "../store/db.ts";

export type MemoryKind = "fact" | "note";

export type MemoryItem = {
	id: number;
	owner: string;
	kind: MemoryKind;
	title: string;
	body: string;
	tags: string;
	source: string;
	pinned: number;
	created_at: number;
	updated_at: number;
};

export class MemoryAccessError extends Error {
	override name = "MemoryAccessError";
}

export const sharedOwner = (space: string) => `shared:${space}`;

/** Turns free text into an FTS5 query: each word as a prefix term, OR-ed, so partial matches still rank. */
export function ftsQuery(text: string): string {
	const words = text
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.filter((w) => w.length > 1)
		.slice(0, 12);
	return words.map((w) => `"${w}"*`).join(" OR ");
}

export class MemoryStore {
	private readonly db: AppDb;

	constructor(db: AppDb) {
		this.db = db;
	}

	/** Owners a bot may read and write: itself and its shared spaces. */
	scopes(bot: { name: string; sharedMemory: string[] }): string[] {
		return [bot.name, ...bot.sharedMemory.map(sharedOwner)];
	}

	private check(bot: { name: string; sharedMemory: string[] }, owner: string): void {
		if (!this.scopes(bot).includes(owner)) throw new MemoryAccessError(`no access to memory "${owner}"`);
	}

	add(bot: { name: string; sharedMemory: string[] }, item: { body: string; title?: string; kind?: MemoryKind; tags?: string[]; pinned?: boolean; space?: string; source?: string }): MemoryItem {
		const owner = item.space ? sharedOwner(item.space) : bot.name;
		this.check(bot, owner);
		const now = Date.now() / 1000;
		const r = this.db.run(
			"INSERT INTO memories (owner, kind, title, body, tags, source, pinned, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
			owner,
			item.kind ?? "fact",
			(item.title ?? "").trim(),
			item.body.trim(),
			(item.tags ?? []).join(" "),
			item.source ?? "",
			item.pinned ? 1 : 0,
			now,
			now,
		);
		return this.get(r.lastInsertRowid)!;
	}

	get(id: number): MemoryItem | undefined {
		return this.db.get<MemoryItem>("SELECT * FROM memories WHERE id = ?", id);
	}

	update(bot: { name: string; sharedMemory: string[] }, id: number, patch: { body?: string; title?: string; pinned?: boolean; tags?: string[] }): MemoryItem {
		const item = this.get(id);
		if (!item) throw new MemoryAccessError(`no memory #${id}`);
		this.check(bot, item.owner);
		this.db.run(
			"UPDATE memories SET body = ?, title = ?, pinned = ?, tags = ?, updated_at = ? WHERE id = ?",
			patch.body?.trim() ?? item.body,
			patch.title?.trim() ?? item.title,
			patch.pinned === undefined ? item.pinned : patch.pinned ? 1 : 0,
			patch.tags ? patch.tags.join(" ") : item.tags,
			Date.now() / 1000,
			id,
		);
		return this.get(id)!;
	}

	forget(bot: { name: string; sharedMemory: string[] }, id: number): boolean {
		const item = this.get(id);
		if (!item) return false;
		this.check(bot, item.owner);
		return this.db.run("DELETE FROM memories WHERE id = ?", id).changes > 0;
	}

	search(bot: { name: string; sharedMemory: string[] }, query: string, opts: { limit?: number; space?: string } = {}): MemoryItem[] {
		const owners = opts.space ? [sharedOwner(opts.space)] : this.scopes(bot);
		for (const o of owners) this.check(bot, o);
		const limit = Math.min(opts.limit ?? 8, 50);
		const marks = owners.map(() => "?").join(",");
		const q = ftsQuery(query);
		if (!q) return this.list(bot, { limit, space: opts.space });
		return this.db.all<MemoryItem>(
			`SELECT m.* FROM memories_fts f JOIN memories m ON m.id = f.rowid
			 WHERE memories_fts MATCH ? AND m.owner IN (${marks})
			 ORDER BY bm25(memories_fts, 3.0, 1.0, 2.0), m.updated_at DESC LIMIT ?`,
			q,
			...owners,
			limit,
		);
	}

	list(bot: { name: string; sharedMemory: string[] }, opts: { limit?: number; space?: string; pinnedOnly?: boolean } = {}): MemoryItem[] {
		const owners = opts.space ? [sharedOwner(opts.space)] : this.scopes(bot);
		for (const o of owners) this.check(bot, o);
		const marks = owners.map(() => "?").join(",");
		return this.db.all<MemoryItem>(
			`SELECT * FROM memories WHERE owner IN (${marks}) ${opts.pinnedOnly ? "AND pinned = 1" : ""} ORDER BY pinned DESC, updated_at DESC LIMIT ?`,
			...owners,
			Math.min(opts.limit ?? 50, 500),
		);
	}

	count(bot: { name: string; sharedMemory: string[] }): number {
		const owners = this.scopes(bot);
		return this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM memories WHERE owner IN (${owners.map(() => "?").join(",")})`, ...owners)?.n ?? 0;
	}
}

export function formatItem(m: MemoryItem): string {
	const where = m.owner.startsWith("shared:") ? ` [${m.owner}]` : "";
	const title = m.title ? `${m.title}: ` : "";
	return `#${m.id}${where}${m.pinned ? " (pinned)" : ""} ${title}${m.body}`;
}
