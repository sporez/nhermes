// Sessions: conversations that belong to a bot. A session id is a Hermes-style string mapped to a
// Durable conversation id; the catalogue row (title, preview, counts, flags) is ours. Deleting a
// session never touches its bot.
import { randomBytes } from "node:crypto";
import type { AgentChange, ConvId, Engine, SubmitOptions } from "../engine/engine.ts";
import { logger } from "../log.ts";
import type { AppDb } from "../store/db.ts";
import type { Approvals } from "./approvals.ts";
import type { Bot, Bots } from "./bots.ts";
import type { Hub, UsageSummary } from "./events.ts";
import { LiveSession } from "./live.ts";
import { projectTranscript, type TranscriptRow } from "./transcript.ts";

const log = logger("sessions");

/** `room`: a bot's own session for one group chat thread (src/core/rooms.ts); not listed in clients. */
export type SessionKind = "chat" | "job" | "delegate" | "room";

export type SessionRow = {
	id: string;
	conversation_id: number;
	bot: string;
	kind: SessionKind;
	title: string;
	title_source: string;
	preview: string;
	source: string;
	created_at: number;
	last_active: number;
	message_count: number;
	model_calls: number;
	archived: number;
	pinned: number;
	deleted: number;
	parent_id: string | null;
	job_id: string | null;
	skills: string;
	model_override: number;
	thinking_override: number;
	/** Node id of the member that holds this chat's conversation (a chat with a member's bot). */
	remote_node: string | null;
	/** The "recent chats" prompt section as this chat first saw it; null until then. */
	recap: string | null;
};

/** How chats with a member's bot are run (src/federation/proxy.ts). */
export type RemoteSessionHooks = { running: (id: string) => boolean; deleted: (row: SessionRow) => Promise<void> };

/** A bot's chats with the owner (`Sessions.ownerChats`); its one parameter is the bot. */
const OWNER_CHAT =
	"bot = ? AND deleted = 0 AND archived = 0 AND kind = 'chat' AND remote_node IS NULL AND message_count > 0 AND (source NOT LIKE 'member:%' OR source LIKE 'member:%:owner')";

export type ListOptions = { limit: number; offset: number; archived: "exclude" | "only" | "include"; order: "recent" | "created"; kinds?: SessionKind[]; exceptKinds?: SessionKind[]; exceptUnless?: string[]; search?: string };

export type Snapshot = {
	session: SessionRow;
	rows: TranscriptRow[];
	running: boolean;
	turnStartedAt: number;
	inflight?: { user: string; assistant: string; streaming: boolean };
};

type Block = { type: string };
type Msg = { role: string; content: string | Block[]; usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning?: number; totalTokens: number; cost?: { total: number } } };

/** One model call's usage (input counts cache writes; cost in USD). */
export type UsageEvent = { at: number; model: string; input: number; output: number; cacheRead: number; reasoning: number; cost: number };
/** A chat's totals to date: input excludes cache reads and writes; models are `provider/modelId`. */
export type SessionSpend = { models: string[]; input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number; total: number; calls: number; costUsd: number };

function sameNames(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && [...a].sort().join("\n") === [...b].sort().join("\n");
}

function sessionIdNow(): string {
	const d = new Date();
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}_${randomBytes(3).toString("hex")}`;
}

export function autoTitle(prompt: string): string {
	const one = prompt.replace(/\s+/g, " ").trim();
	if (one.length <= 60) return one;
	const cut = one.slice(0, 60);
	const space = cut.lastIndexOf(" ");
	return (space > 30 ? cut.slice(0, space) : cut) + "…";
}

export class Sessions {
	private readonly lives = new Map<string, LiveSession>();
	private readonly byConvCache = new Map<number, string>();
	private readonly engine: Engine;
	private readonly db: AppDb;
	private readonly bots: Bots;
	private readonly hub: Hub;
	private readonly approvals: Approvals;
	private readonly agentFor: (bot: Bot) => AgentChange;
	private remote: RemoteSessionHooks | undefined;

	constructor(engine: Engine, db: AppDb, bots: Bots, hub: Hub, approvals: Approvals, agentFor: (bot: Bot) => AgentChange) {
		this.agentFor = agentFor;
		this.engine = engine;
		this.db = db;
		this.bots = bots;
		this.hub = hub;
		this.approvals = approvals;
	}

	get(id: string): SessionRow | undefined {
		return this.db.get<SessionRow>("SELECT * FROM sessions WHERE id = ? AND deleted = 0", id);
	}

	require(id: string): SessionRow {
		const row = this.get(id);
		if (!row) throw new UnknownSession(id);
		return row;
	}

	byConversation(convId: ConvId): SessionRow | undefined {
		const cached = this.byConvCache.get(convId);
		const row = cached ? this.get(cached) : this.db.get<SessionRow>("SELECT * FROM sessions WHERE conversation_id = ?", convId);
		if (row) this.byConvCache.set(convId, row.id);
		return row;
	}

	botOf(convId: ConvId): Bot | undefined {
		const row = this.byConversation(convId);
		return row ? this.bots.get(row.bot) : undefined;
	}

	async create(botName: string, opts: { kind?: SessionKind; source?: string; title?: string; parentId?: string; jobId?: string; skills?: string[] } = {}): Promise<SessionRow> {
		const bot = this.bots.require(botName);
		if (bot.isPeer) throw new Error(`${bot.name} is an agent on another machine; delegate to it instead`);
		const convId = await this.engine.create(this.agentFor(bot));
		return this.register(convId, bot.name, opts);
	}

	setRemoteHooks(hooks: RemoteSessionHooks): void {
		this.remote = hooks;
	}

	/** Catalogues a chat whose conversation lives on a member, under the id it has there. */
	registerRemote(id: string, botName: string, nodeId: string, opts: { source?: string; title?: string; kind?: SessionKind } = {}): SessionRow {
		const existing = this.get(id);
		if (existing) return existing;
		const now = Date.now() / 1000;
		const placeholder = Math.min(0, this.db.get<{ m: number | null }>("SELECT MIN(conversation_id) AS m FROM sessions")?.m ?? 0) - 1;
		this.db.run(
			`INSERT INTO sessions (id, conversation_id, bot, kind, title, title_source, source, created_at, last_active, remote_node)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			id,
			placeholder,
			botName,
			opts.kind ?? "chat",
			opts.title ?? "",
			opts.title ? "given" : "auto",
			opts.source ?? "ios",
			now,
			now,
			nodeId,
		);
		this.hub.publishGlobal({ type: "sessions.changed", bot: botName });
		return this.require(id);
	}

	/** Keeps a member chat's catalogue row current from what passes through (prompts, answers, titles). */
	recordRemote(id: string, e: { prompt?: string; answer?: string; title?: string }): void {
		if (e.prompt !== undefined) this.onUserPlaced(id, e.prompt, false);
		if (e.answer !== undefined) this.onRunFinished(id, e.answer);
		if (e.title !== undefined && e.title.trim()) this.db.run("UPDATE sessions SET title = ? WHERE id = ?", e.title.trim(), id);
	}

	/** Records a conversation created elsewhere (a delegation's child) as a session of `botName`. */
	register(convId: ConvId, botName: string, opts: { kind?: SessionKind; source?: string; title?: string; parentId?: string; jobId?: string; skills?: string[] } = {}): SessionRow {
		const existing = this.db.get<SessionRow>("SELECT * FROM sessions WHERE conversation_id = ?", convId);
		if (existing) return existing;
		const id = sessionIdNow();
		const now = Date.now() / 1000;
		this.db.run(
			`INSERT INTO sessions (id, conversation_id, bot, kind, title, title_source, source, created_at, last_active, parent_id, job_id, skills)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			id,
			convId,
			botName,
			opts.kind ?? "chat",
			opts.title ?? "",
			opts.title ? "given" : "auto",
			opts.source ?? "ios",
			now,
			now,
			opts.parentId ?? null,
			opts.jobId ?? null,
			JSON.stringify(opts.skills ?? []),
		);
		this.byConvCache.set(convId, id);
		this.hub.publishGlobal({ type: "sessions.changed", bot: botName });
		return this.require(id);
	}

	list(botName: string, o: ListOptions): { rows: SessionRow[]; total: number } {
		const where = ["bot = ?", "deleted = 0"];
		const params: (string | number)[] = [botName];
		if (o.archived === "exclude") where.push("archived = 0");
		if (o.archived === "only") where.push("archived = 1");
		if (o.kinds && o.kinds.length > 0) {
			where.push(`kind IN (${o.kinds.map(() => "?").join(",")})`);
			params.push(...o.kinds);
		}
		// exceptUnless: sessions listed even though their kind is left out (one waiting for an approval).
		if (o.exceptKinds && o.exceptKinds.length > 0) {
			const ids = o.exceptUnless ?? [];
			where.push(`(kind NOT IN (${o.exceptKinds.map(() => "?").join(",")})${ids.length ? ` OR id IN (${ids.map(() => "?").join(",")})` : ""})`);
			params.push(...o.exceptKinds, ...ids);
		}
		if (o.search) {
			where.push("(title LIKE ? OR preview LIKE ?)");
			params.push(`%${o.search}%`, `%${o.search}%`);
		}
		const clause = where.join(" AND ");
		const order = o.order === "recent" ? "pinned DESC, last_active DESC" : "created_at DESC";
		const rows = this.db.all<SessionRow>(`SELECT * FROM sessions WHERE ${clause} ORDER BY ${order} LIMIT ? OFFSET ?`, ...params, o.limit, o.offset);
		const total = this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM sessions WHERE ${clause}`, ...params)?.n ?? 0;
		return { rows, total };
	}

	/**
	 * A bot's chats with the owner, latest first: its own chats here, or the owner's relayed from a member.
	 * Not jobs, delegated tasks, archived chats, chats with a member's bot, or work a member started.
	 */
	ownerChats(botName: string, opts: { limit: number; except?: string; search?: string }): SessionRow[] {
		const where = [OWNER_CHAT, "id != ?"];
		const params: (string | number)[] = [botName, opts.except ?? ""];
		if (opts.search) {
			where.push("(title LIKE ? OR preview LIKE ?)");
			params.push(`%${opts.search}%`, `%${opts.search}%`);
		}
		return this.db.all<SessionRow>(`SELECT * FROM sessions WHERE ${where.join(" AND ")} ORDER BY last_active DESC LIMIT ?`, ...params, opts.limit);
	}

	/** One of `ownerChats`, by id. */
	ownerChat(botName: string, id: string): SessionRow | undefined {
		return this.db.get<SessionRow>(`SELECT * FROM sessions WHERE ${OWNER_CHAT} AND id = ?`, botName, id);
	}

	setRecap(id: string, recap: string): void {
		this.db.run("UPDATE sessions SET recap = ? WHERE id = ?", recap, id);
	}

	update(id: string, patch: { title?: string; archived?: boolean; pinned?: boolean }): SessionRow {
		const row = this.require(id);
		if (patch.title !== undefined) this.db.run("UPDATE sessions SET title = ?, title_source = 'given' WHERE id = ?", patch.title.trim(), id);
		if (patch.archived !== undefined) this.db.run("UPDATE sessions SET archived = ? WHERE id = ?", patch.archived ? 1 : 0, id);
		if (patch.pinned !== undefined) this.db.run("UPDATE sessions SET pinned = ? WHERE id = ?", patch.pinned ? 1 : 0, id);
		if (patch.title !== undefined) this.hub.publish(id, { type: "title", title: patch.title.trim() });
		this.hub.publishGlobal({ type: "sessions.changed", bot: row.bot });
		return this.require(id);
	}

	/**
	 * Removes a session from the catalogue and stops any run in it. The Durable transcript remains in
	 * durable.sqlite (Pi Durable has no conversation delete); `nhermes purge` is the place to add one.
	 */
	async delete(id: string): Promise<boolean> {
		const row = this.get(id);
		if (!row) return false;
		if (row.remote_node) {
			this.approvals.cancelSession(id);
			this.db.run("UPDATE sessions SET deleted = 1 WHERE id = ?", id);
			this.hub.publishGlobal({ type: "sessions.changed", bot: row.bot });
			await this.remote?.deleted(row);
			return true;
		}
		if (await this.engine.isBusy(row.conversation_id)) {
			this.approvals.cancelSession(id);
			await this.engine.abort(row.conversation_id);
		}
		this.db.run("UPDATE sessions SET deleted = 1 WHERE id = ?", id);
		await this.lives.get(id)?.detach();
		this.lives.delete(id);
		this.hub.publishGlobal({ type: "sessions.changed", bot: row.bot });
		return true;
	}

	/** Whether a run is going (from the live projection; every running session has one attached). */
	isRunning(id: string): boolean {
		if (this.remote && this.get(id)?.remote_node) return this.remote.running(id);
		return this.lives.get(id)?.running ?? false;
	}

	runningCount(): number {
		let n = 0;
		for (const l of this.lives.values()) if (l.running) n++;
		return n;
	}

	/** The live projection of a session, attached to its Durable event stream. */
	async live(id: string): Promise<LiveSession> {
		const row = this.require(id);
		let live = this.lives.get(id);
		if (!live) {
			live = new LiveSession(id, row.conversation_id, this.engine, this.hub, {
				onUserPlaced: (sid, text) => this.onUserPlaced(sid, text),
				onAssistant: (sid) => void this.db.run("UPDATE sessions SET model_calls = model_calls + 1 WHERE id = ?", sid),
				onRunFinished: (sid, text) => this.onRunFinished(sid, text),
				usage: (sid) => this.usage(sid),
			});
			this.lives.set(id, live);
		}
		await live.attach();
		return live;
	}

	/** Re-attach live projections for conversations that were mid-run when the process stopped. */
	async attachBusy(): Promise<number> {
		let n = 0;
		for (const convId of await this.engine.busyConversations()) {
			const row = this.byConversation(convId);
			if (row && !row.deleted) {
				await this.live(row.id);
				n++;
			}
		}
		return n;
	}

	/**
	 * Brings a session's model, reasoning level and tools in line with its bot, unless the chat chose its
	 * own model or level (Vory's per-chat switch). Called before each prompt, so changing a bot in config,
	 * the panel or Vory reaches its existing sessions.
	 */
	async followBot(id: string): Promise<void> {
		const row = this.require(id);
		const bot = this.bots.get(row.bot);
		if (!bot) return;
		const current = await this.engine.agentModel(row.conversation_id);
		const wanted = this.agentFor(bot).tools;
		const change: { model?: { provider: string; modelId: string }; thinkingLevel?: AgentChange["thinkingLevel"]; tools?: AgentChange["tools"] } = {};
		if (!row.model_override && (current.model?.provider !== bot.model.provider || current.model?.modelId !== bot.model.modelId)) change.model = bot.model;
		if (!row.thinking_override && current.thinking !== bot.thinking) change.thinkingLevel = bot.thinking as AgentChange["thinkingLevel"];
		if (Array.isArray(wanted) && !sameNames(current.tools, wanted.map((t) => t.name))) change.tools = wanted;
		if (change.model || change.thinkingLevel || change.tools) await this.engine.configure(row.conversation_id, change);
	}

	markOverride(id: string, what: "model" | "thinking"): void {
		this.db.run(`UPDATE sessions SET ${what === "model" ? "model_override" : "thinking_override"} = 1 WHERE id = ?`, id);
	}

	async submit(id: string, text: string, opts: SubmitOptions = {}): Promise<{ status: "streaming" | "queued" | "steered"; submission: string }> {
		const row = this.require(id);
		const busyNow = this.lives.get(id)?.running ?? false;
		if (!busyNow) await this.followBot(id);
		const live = await this.live(id);
		const busy = live.running || (await this.engine.isBusy(row.conversation_id));
		const r = await this.engine.submit(row.conversation_id, text, opts);
		this.db.run("UPDATE sessions SET last_active = ? WHERE id = ?", Date.now() / 1000, id);
		if (r.status === "done" || r.status === "unanswered") return { status: "streaming", submission: r.status };
		if (!busy) return { status: "streaming", submission: r.status };
		return { status: opts.whenBusy === "steer" ? "steered" : r.status === "queued" ? "queued" : "streaming", submission: r.status };
	}

	async interrupt(id: string): Promise<boolean> {
		const row = this.require(id);
		this.approvals.cancelSession(id);
		const busy = await this.engine.isBusy(row.conversation_id);
		if (busy) await this.engine.abort(row.conversation_id);
		return busy;
	}

	async snapshot(id: string): Promise<Snapshot> {
		const session = this.require(id);
		const live = await this.live(id);
		const rows = projectTranscript(await this.engine.entries(session.conversation_id));
		const running = live.running;
		const snap: Snapshot = { session, rows, running, turnStartedAt: running ? live.turnStartedAt : 0 };
		if (running) {
			const partial = live.partialText;
			snap.inflight = { user: live.prompt, assistant: partial, streaming: live.isStreaming };
		}
		return snap;
	}

	async rows(id: string): Promise<TranscriptRow[]> {
		return projectTranscript(await this.engine.entries(this.require(id).conversation_id));
	}

	/** Each model call's usage in a chat, with when it happened and on which model (for usage analytics). */
	async usageEvents(id: string): Promise<UsageEvent[]> {
		const out: UsageEvent[] = [];
		for (const e of await this.engine.entries(this.require(id).conversation_id)) {
			const m = e.model?.[0] as (Msg & { timestamp?: number; provider?: string; model?: string }) | undefined;
			if (m?.role !== "assistant" || !m.usage || m.usage.totalTokens <= 0) continue;
			out.push({
				at: (m.timestamp ?? 0) / 1000,
				model: m.provider && m.model ? `${m.provider}/${m.model}` : (m.model ?? ""),
				input: m.usage.input + m.usage.cacheWrite,
				output: m.usage.output,
				cacheRead: m.usage.cacheRead,
				reasoning: m.usage.reasoning ?? 0,
				cost: m.usage.cost?.total ?? 0,
			});
		}
		return out;
	}

	/** A chat's spend to date from its usage ledger alone (cheap enough for a list of chats). */
	async spend(id: string): Promise<SessionSpend> {
		const row = this.require(id);
		const state = await this.engine.usage(row.conversation_id);
		const sum: SessionSpend = { models: Object.keys(state.models), input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0, calls: row.model_calls, costUsd: 0 };
		for (const u of Object.values(state.models) as { input: number; output: number; reasoning?: number; cacheRead: number; cacheWrite: number; totalTokens: number; cost?: { total: number } }[]) {
			sum.input += u.input;
			sum.output += u.output;
			sum.reasoning += u.reasoning ?? 0;
			sum.cacheRead += u.cacheRead;
			sum.cacheWrite += u.cacheWrite;
			sum.total += u.totalTokens;
			sum.costUsd += u.cost?.total ?? 0;
		}
		return sum;
	}

	async usage(id: string): Promise<UsageSummary> {
		const row = this.require(id);
		const [state, agent, recent] = await Promise.all([
			this.engine.usage(row.conversation_id),
			this.engine.agentModel(row.conversation_id),
			this.engine.latestEntries(row.conversation_id, 40),
		]);
		const sum = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 };
		for (const u of Object.values(state.models) as { input: number; output: number; reasoning?: number; cacheRead: number; cacheWrite: number; totalTokens: number; cost?: { total: number } }[]) {
			sum.input += u.input;
			sum.output += u.output;
			sum.reasoning += u.reasoning ?? 0;
			sum.cacheRead += u.cacheRead;
			sum.cacheWrite += u.cacheWrite;
			sum.total += u.totalTokens;
			sum.cost += u.cost?.total ?? 0;
		}
		let contextUsed = 0;
		for (const e of recent) {
			const m = e.model?.[0] as Msg | undefined;
			if (m?.role === "assistant" && m.usage && m.usage.totalTokens > 0) {
				contextUsed = m.usage.input + m.usage.cacheRead + m.usage.cacheWrite + m.usage.output;
				break;
			}
		}
		return {
			model: agent.model ? `${agent.model.provider}/${agent.model.modelId}` : "",
			input: sum.input,
			output: sum.output,
			reasoning: sum.reasoning,
			cacheRead: sum.cacheRead,
			cacheWrite: sum.cacheWrite,
			total: sum.total,
			calls: this.get(id)?.model_calls ?? row.model_calls,
			contextUsed,
			contextMax: agent.contextWindow,
			costUsd: sum.cost,
		};
	}

	private onUserPlaced(id: string, text: string, announceTitle = true): void {
		const row = this.get(id);
		if (!row) return;
		const now = Date.now() / 1000;
		this.db.run("UPDATE sessions SET last_active = ? WHERE id = ?", now, id);
		if (!row.title && row.title_source === "auto" && text.trim()) {
			const title = autoTitle(text);
			this.db.run("UPDATE sessions SET title = ? WHERE id = ?", title, id);
			if (announceTitle) this.hub.publish(id, { type: "title", title });
		}
		if (!row.preview) this.db.run("UPDATE sessions SET preview = ? WHERE id = ?", text.replace(/\s+/g, " ").slice(0, 200), id);
	}

	private onRunFinished(id: string, text: string): void {
		const row = this.get(id);
		if (!row) return;
		const preview = text.trim() ? text.replace(/\s+/g, " ").slice(0, 200) : row.preview;
		// message_count: user prompts and answers in the transcript (two per finished run).
		this.db.run("UPDATE sessions SET last_active = ?, preview = ?, message_count = message_count + 2 WHERE id = ?", Date.now() / 1000, preview, id);
		this.hub.publishGlobal({ type: "sessions.changed", bot: row.bot });
		log.debug("run finished", { session: id });
	}
}

export class UnknownSession extends Error {
	override name = "UnknownSession";
	readonly sessionId: string;
	constructor(id: string) {
		super(`session not found: ${id}`);
		this.sessionId = id;
	}
}
