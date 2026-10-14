// The network's bots. Each member publishes its shareable bots (local, not private); every member
// fetches the others' lists on a timer and after membership changes, and keeps the last known list so an
// offline member's bots stay listed as unreachable. Remote bots appear locally as `<bot>-<node>`.
import { logger } from "../log.ts";
import type { AppDb } from "../store/db.ts";
import type { Bot } from "../core/bots.ts";
import type { Members } from "./members.ts";

const log = logger("roster");

const BOT_NAME = /^[a-z0-9][a-z0-9-]{0,40}$/;

export type RemoteBot = { nodeId: string; node: string; bot: string; displayName: string; description: string; model: string; reachable: boolean };

type Published = { name: string; display_name: string; description: string; model: string };

/** Text from another machine that ends up in prompts: one line, printable, bounded. */
function clean(text: unknown, max: number): string {
	return String(text ?? "")
		.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, max);
}

/** The local bots other members may use. */
export function shareable(bots: readonly Bot[]): Bot[] {
	return bots.filter((b) => !b.private && !b.isPeer);
}

export function publish(bots: readonly Bot[]): { bots: Published[] } {
	return { bots: shareable(bots).map((b) => ({ name: b.name, display_name: b.displayName, description: b.description, model: `${b.model.provider}/${b.model.modelId}` })) };
}

export class Roster {
	private readonly db: AppDb;
	private readonly members: Members;
	private syncing: Promise<void> | undefined;

	constructor(db: AppDb, members: Members) {
		this.db = db;
		this.members = members;
	}

	list(): RemoteBot[] {
		const members = new Map(this.members.list().map((m) => [m.node_id, m]));
		return this.db
			.all<{ node_id: string; bot: string; display_name: string; description: string; model: string }>("SELECT * FROM remote_bots ORDER BY node_id, bot")
			.flatMap((r) => {
				const m = members.get(r.node_id);
				if (!m) return [];
				return [{ nodeId: r.node_id, node: m.name, bot: r.bot, displayName: r.display_name, description: r.description, model: r.model, reachable: m.reachable }];
			});
	}

	/** Fetches every member's list (one round at a time). A member that does not answer keeps its last list. */
	sync(): Promise<void> {
		const round = (this.syncing ?? Promise.resolve()).then(() => this.fetchAll());
		this.syncing = round;
		return round;
	}

	private async fetchAll(): Promise<void> {
		this.db.run("DELETE FROM remote_bots WHERE node_id NOT IN (SELECT node_id FROM members)");
		await Promise.allSettled(this.members.list().map((view) => this.fetchOne(view.node_id)));
	}

	private async fetchOne(nodeId: string): Promise<void> {
		const m = this.members.get(nodeId);
		if (!m) return;
		try {
			const r = await this.members.call<{ bots?: Published[] }>(m, "/federation/roster", undefined, "GET");
			const rows = (r.bots ?? []).filter((b) => typeof b.name === "string" && BOT_NAME.test(b.name)).slice(0, 100);
			this.db.tx(() => {
				this.db.run("DELETE FROM remote_bots WHERE node_id = ?", m.node_id);
				for (const b of rows) {
					this.db.run(
						"INSERT INTO remote_bots (node_id, bot, display_name, description, model, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
						m.node_id,
						b.name,
						clean(b.display_name, 60) || b.name,
						clean(b.description, 300),
						clean(b.model, 120),
						Date.now() / 1000,
					);
				}
			});
		} catch (error) {
			log.debug("roster not fetched", { member: m.name, error: error instanceof Error ? error.message : String(error) });
		}
	}
}
