// Group chats: a room of 2-6 bots and one shared log of typed events, kept on the gateway it was created
// on. The log is the state. After each change a room's driver replays it (planNextTurn,
// src/core/room-plan.ts) and runs at most one member turn at a time: `turn.started`, the turn's prompt in
// that member's own room session (kind "room", one per room thread), then its reply as `message.member`
// with `turn.settled`, or `turn.failed`. A discussion ends with `room.activity` settled or bounded.
//
// A member's bot on another machine answers there, in a room session made on that machine (as work this
// gateway started, so it is not trusted there and its approvals come back here), reached with runOnPeer like
// a delegated task. Its session is catalogued here too, so a client opens it through this gateway.
//
// Restarts: each turn is submitted under the key `room:<room>:<turn>` and kept in room_turns (the local
// submission, or the prompt sent to the other machine), so after a restart the driver waits for the turn
// already running instead of sending it again. Approvals are asked in the member's room session as in any
// chat (Jev reviews what it may for local bots); the room log says who is waiting, and while it waits
// the session is listed in the chat list.
import { randomBytes } from "node:crypto";
import type { Engine } from "../engine/engine.ts";
import type { Members } from "../federation/members.ts";
import type { MemberChats } from "../federation/chats.ts";
import { logger, redact } from "../log.ts";
import type { Notifier } from "../notify/notifier.ts";
import { createPeerSession, type PeerTarget, runOnPeer } from "../remote/peer.ts";
import type { AppDb } from "../store/db.ts";
import { type Approvals, fromMachine } from "./approvals.ts";
import type { Bot, Bots } from "./bots.ts";
import type { Hub } from "./events.ts";
import { planNextTurn, type RoomEvent, type RoomInfo, type RoomMember, isPass, turnCoordinates } from "./room-plan.ts";
import type { SessionRow, Sessions } from "./sessions.ts";

const log = logger("rooms");

export const MIN_MEMBERS = 2;
export const MAX_MEMBERS = 6;
const MAX_NAME = 200;
const MAX_TEXT_BYTES = 64 * 1024;
const MAX_LOG_LIMIT = 500;
const MAX_LIST_LIMIT = 200;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const GATEWAY = { kind: "gateway", id: "gateway" };

/** A request the client got wrong (or a room it cannot use); `code` is the JSON-RPC error code. */
export class RoomError extends Error {
	readonly code: number;
	constructor(code: number, message: string) {
		super(message);
		this.code = code;
	}
}

export type RoomJson = { room_id: string; name: string; members: RoomMember[]; created_at: number; updated_at: number; disbanded_at: number | null; latest_seq: number };

type RoomRow = { id: string; name: string; members: string; created_at: number; updated_at: number; disbanded_at: number | null };
type EventRow = { room_id: string; seq: number; event_id: string; kind: string; actor: string; payload: string; created_at: number };
type Append = { kind: string; actor: { kind: string; id: string }; payload: Record<string, unknown>; eventId?: string };

export type RoomsDeps = {
	db: AppDb;
	engine: Engine;
	sessions: Sessions;
	bots: Bots;
	hub: Hub;
	notifier: Notifier;
	approvals: Approvals;
	members: Members;
	memberChats: MemberChats;
};

type Coords = ReturnType<typeof turnCoordinates>;

export class Rooms {
	private readonly d: RoomsDeps;
	/** The driver of each room that has one going, and the rooms that changed while it went. */
	private readonly drivers = new Map<string, Promise<void>>();
	private readonly again = new Set<string>();
	/** Turns running on another machine, by `<room>\0<turn>`: stopped by disbanding or shutting down. */
	private readonly remoteTurns = new Map<string, AbortController>();
	/** Events filed in the transaction going on, announced when it commits. */
	private readonly unannounced = new Map<string, RoomEvent[]>();
	private stopped = false;

	constructor(deps: RoomsDeps) {
		this.d = deps;
	}

	// ── Requests ────────────────────────────────────────────────────────────────────────────

	list(o: { limit?: number; offset?: number; includeDisbanded?: boolean } = {}): { rooms: RoomJson[]; next_offset: number | null } {
		const limit = clamp(o.limit, 50, 1, MAX_LIST_LIMIT);
		const offset = clamp(o.offset, 0, 0, 1_000_000);
		const rows = this.d.db.all<RoomRow>(
			`SELECT * FROM rooms ${o.includeDisbanded ? "" : "WHERE disbanded_at IS NULL"} ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
			limit,
			offset,
		);
		return { rooms: rows.map((r) => this.json(r)), next_offset: rows.length === limit ? offset + limit : null };
	}

	/** One room, disbanded ones too; undefined when there is none. */
	get(id: string): RoomJson | undefined {
		const row = this.row(id, true);
		return row ? this.json(row) : undefined;
	}

	/** Creates a room of this gateway's bots; the same `room_id` again returns the room it made. */
	create(input: { room_id?: unknown; name?: unknown; members?: unknown }): RoomJson {
		const id = input.room_id === undefined || input.room_id === null || input.room_id === "" ? `room-${randomBytes(5).toString("hex")}` : identifier(input.room_id, "room_id", 4110);
		const existing = this.row(id, true);
		if (existing) {
			if (existing.disbanded_at !== null) throw new RoomError(4110, `room ${id} was disbanded`);
			return this.json(existing);
		}
		const name = typeof input.name === "string" ? input.name.trim() : "";
		if (!name) throw new RoomError(4110, "name is required");
		if (name.length > MAX_NAME) throw new RoomError(4110, `name is longer than ${MAX_NAME} characters`);
		const members = this.roster(input.members);
		const now = Date.now() / 1000;
		this.d.db.run("INSERT INTO rooms (id, name, members, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", id, name, JSON.stringify(members), now, now);
		log.info("room created", { room: id, members: members.map((m) => m.profile) });
		this.d.hub.publishGlobal({ type: "rooms.changed", roomId: id, events: [] });
		return this.json(this.row(id)!);
	}

	/** Files the owner's message; the same `event_id` again returns the message already filed. */
	send(input: { room_id?: unknown; event_id?: unknown; payload?: unknown }): RoomEvent {
		const room = this.require(input.room_id, 4111);
		if (room.disbanded_at !== null) throw new RoomError(4111, "this group chat was disbanded");
		const eventId = identifier(input.event_id, "event_id", 4111);
		const p = input.payload;
		if (!p || typeof p !== "object" || Array.isArray(p)) throw new RoomError(-32602, "payload must be an object with text and thread_id");
		const fields = Object.keys(p).sort().join(",");
		if (fields !== "text,thread_id") throw new RoomError(-32602, `payload must have exactly text and thread_id (got ${fields || "nothing"})`);
		const { text, thread_id } = p as { text: unknown; thread_id: unknown };
		if (typeof text !== "string" || !text.trim()) throw new RoomError(-32602, "payload text must be a non-empty string");
		if (Buffer.byteLength(text) > MAX_TEXT_BYTES) throw new RoomError(-32602, "payload text is longer than 64 KB");
		const thread = identifier(thread_id, "thread_id", -32602);
		const filed = this.d.db.get<EventRow>("SELECT * FROM room_events WHERE room_id = ? AND event_id = ?", room.id, eventId);
		if (filed) return event(filed);
		const [sent] = this.append(room.id, [{ kind: "message.user", actor: { kind: "user", id: "user" }, payload: { text, thread_id: thread }, eventId }]);
		this.kick(room.id);
		return sent!;
	}

	log(input: { room_id?: unknown; since_seq?: unknown; limit?: unknown; include_disbanded?: unknown }): { events: RoomEvent[]; cursor: number; latest_seq: number; has_more: boolean } {
		const room = this.require(input.room_id, 4112);
		if (room.disbanded_at !== null && input.include_disbanded !== true) throw new RoomError(4112, "this group chat was disbanded");
		const since = clamp(input.since_seq, 0, 0, Number.MAX_SAFE_INTEGER);
		const limit = clamp(input.limit, 100, 1, MAX_LOG_LIMIT);
		const rows = this.d.db.all<EventRow>("SELECT * FROM room_events WHERE room_id = ? AND seq > ? ORDER BY seq LIMIT ?", room.id, since, limit);
		const latest = this.latestSeq(room.id);
		const cursor = rows.length ? rows[rows.length - 1]!.seq : since;
		return { events: rows.map(event), cursor, latest_seq: latest, has_more: cursor < latest };
	}

	/** Stops the turn going, files `room.disbanded` and closes the room for good; its log and sessions stay. */
	async disband(roomId: unknown): Promise<{ tombstone: { room_id: string; disbanded_at: number } }> {
		const room = this.require(roomId, 4113);
		if (room.disbanded_at === null) {
			const now = Date.now() / 1000;
			this.commit(room.id, () => {
				this.d.db.run("UPDATE rooms SET disbanded_at = ? WHERE id = ?", now, room.id);
				this.appendIn(room.id, [{ kind: "room.disbanded", actor: GATEWAY, payload: {} }]);
			});
			for (const t of this.d.db.all<{ turn_id: string; session_id: string }>("SELECT turn_id, session_id FROM room_turns WHERE room_id = ?", room.id)) {
				const row = this.d.sessions.get(t.session_id);
				this.remoteTurns.get(`${room.id}\0${t.turn_id}`)?.abort();
				if (row?.remote_node) await this.d.memberChats.forward(row, "sessions.interrupt", {}).catch(() => undefined);
				else if (row) await this.d.sessions.interrupt(row.id).catch(() => false);
			}
			log.info("room disbanded", { room: room.id });
		}
		return { tombstone: { room_id: room.id, disbanded_at: this.row(room.id, true)!.disbanded_at! } };
	}

	/**
	 * The owner's own messages in the room thread a member session belongs to, latest last; undefined for
	 * a session that is not a room member's. For the reviewer: a turn's prompt also carries other bots' words.
	 */
	ownerMessages(sessionId: string, limit = 8): string[] | undefined {
		const at = this.d.db.get<{ room_id: string; thread_id: string }>("SELECT room_id, thread_id FROM room_sessions WHERE session_id = ?", sessionId);
		if (!at) return undefined;
		return this.events(at.room_id)
			.filter((e) => e.kind === "message.user" && e.payload.thread_id === at.thread_id)
			.map((e) => String(e.payload.text))
			.slice(-limit);
	}

	// ── Driving ─────────────────────────────────────────────────────────────────────────────

	/** Picks up every open room with work left (after a restart). */
	start(): void {
		this.stopped = false;
		for (const r of this.d.db.all<{ id: string }>("SELECT id FROM rooms WHERE disbanded_at IS NULL")) this.kick(r.id);
	}

	/**
	 * Stops starting turns. A local turn keeps running in Durable; the wait for one on another machine is
	 * dropped (it keeps running there). Both are picked up after a restart.
	 */
	async stop(): Promise<void> {
		this.stopped = true;
		for (const c of this.remoteTurns.values()) c.abort();
	}

	/** Resolves once the room has nothing more to do right now (tests). */
	async idle(roomId: string): Promise<void> {
		while (this.drivers.has(roomId)) await this.drivers.get(roomId);
	}

	private kick(roomId: string): void {
		if (this.stopped) return;
		if (this.drivers.has(roomId)) return void this.again.add(roomId);
		const p = this.drive(roomId)
			.catch((error) => log.error("room driver failed", { room: roomId, error: String(error) }))
			.finally(() => {
				this.drivers.delete(roomId);
				if (this.again.delete(roomId)) this.kick(roomId);
			});
		this.drivers.set(roomId, p);
	}

	private async drive(roomId: string): Promise<void> {
		// Each discussion is bounded (3 rounds, 10 messages); the step limit only guards against a planner bug.
		for (let steps = 0; !this.stopped; steps++) {
			if (steps >= 1000) return void log.error("room driver stopped after 1000 steps", { room: roomId });
			const room = this.row(roomId);
			if (!room) return;
			const info: RoomInfo = { room_id: room.id, name: room.name, members: JSON.parse(room.members) as RoomMember[] };
			const events = this.events(roomId);
			const decision = planNextTurn(info, events);
			const current = decision.status === "task" ? decision.task.turnId : undefined;
			// Turns a restart left open that are no longer the next one (a newer message took over): finish
			// them from what was kept of them, or close them if nothing was.
			const open = openTurns(events).filter((t) => t.payload.turn_id !== current);
			if (open.length > 0) {
				for (const t of open) {
					const coords = t.payload as Coords;
					const member = info.members.find((m) => m.member_id === coords.member_id);
					const seenThrough = Number(/\.s(\d+)\./.exec(coords.turn_id)?.[1] ?? t.seq);
					await this.turn(info, member, coords, seenThrough, undefined);
				}
				continue;
			}
			if (decision.status === "idle") return;
			if (decision.status === "task") {
				const coords = turnCoordinates(decision.task);
				if (!events.some((e) => e.kind === "turn.started" && e.payload.turn_id === coords.turn_id)) {
					this.append(roomId, [{ kind: "turn.started", actor: GATEWAY, payload: coords }]);
				}
				await this.turn(info, decision.task.member, coords, decision.task.seenThroughSeq, decision.task.prompt);
				continue;
			}
			this.append(roomId, [{ kind: "room.activity", actor: GATEWAY, payload: { status: decision.status, reason_code: decision.reason, thread_id: decision.threadId, discussion_event_id: decision.discussionEventId } }]);
			await this.notifySettled(info, decision.discussionEventId);
		}
	}

	/**
	 * Runs one member turn to its end and files the outcome. `prompt` is undefined for a turn a restart left
	 * open that is no longer the next one: it is finished from what room_turns kept of it, or closed.
	 */
	private async turn(room: RoomInfo, member: RoomMember | undefined, coords: Coords, seenThrough: number, prompt: string | undefined): Promise<void> {
		const failed = (error: unknown): Append[] => [{ kind: "turn.failed", actor: GATEWAY, payload: { ...coords, error: oneLine(error), seen_through_seq: seenThrough } }];
		let outcome: Append[];
		try {
			const bot = member ? this.d.bots.get(member.profile) : undefined;
			if (!member || !bot || (bot.isPeer && !bot.remote)) throw new Error(`${member?.display_name || coords.member_id} is no longer a bot in this network`);
			const text = bot.remote ? await this.remoteTurn(room, member, bot, coords, prompt) : await this.localTurn(room, member, coords, prompt);
			if (text === undefined) return; // shutting down: picked up after the restart
			if (isPass(text)) {
				outcome = [{ kind: "turn.settled", actor: GATEWAY, payload: { ...coords, passed: true, seen_through_seq: seenThrough } }];
			} else {
				const messageId = newEventId();
				outcome = [
					{ kind: "message.member", actor: { kind: "member", id: member.member_id }, payload: { ...coords, text: cut(text) }, eventId: messageId },
					{ kind: "turn.settled", actor: GATEWAY, payload: { ...coords, passed: false, message_event_id: messageId, seen_through_seq: seenThrough } },
				];
			}
		} catch (error) {
			if (this.stopped) return;
			outcome = failed(error);
		}
		this.closeTurn(room.room_id, coords.turn_id, outcome);
	}

	/** A turn of a bot on this gateway: its answer (redacted), or undefined when shutting down. */
	private async localTurn(room: RoomInfo, member: RoomMember, coords: Coords, prompt: string | undefined): Promise<string | undefined> {
		const kept = this.d.db.get<{ session_id: string; submission_id: number }>("SELECT session_id, submission_id FROM room_turns WHERE room_id = ? AND turn_id = ?", room.room_id, coords.turn_id);
		let session: SessionRow;
		let submission: number;
		if (kept && kept.submission_id > 0) {
			const row = this.d.sessions.get(kept.session_id);
			if (!row) throw new Error("this turn's session was deleted");
			session = row;
			submission = kept.submission_id;
		} else {
			if (prompt === undefined) throw new Error("the gateway restarted before this turn began");
			session = await this.memberSession(room, coords.thread_id, member);
			await this.d.sessions.followBot(session.id);
			await this.d.sessions.live(session.id);
			const r = await this.d.engine.submit(session.conversation_id, prompt, { requestId: `room:${room.room_id}:${coords.turn_id}`, whenBusy: "followUp" });
			submission = r.submissionId;
			this.d.db.run("INSERT OR REPLACE INTO room_turns (room_id, turn_id, session_id, submission_id) VALUES (?, ?, ?, ?)", room.room_id, coords.turn_id, session.id, submission);
			this.d.db.run("UPDATE sessions SET last_active = ? WHERE id = ?", Date.now() / 1000, session.id);
		}
		await this.d.sessions.live(session.id);
		const off = this.watchApprovals(room, member, session, coords);
		try {
			const rec = await this.d.engine.waitSubmission(submission);
			if (rec.type === "input" && rec.status === "done") return redact(await this.d.engine.answerText(session.conversation_id, rec.answer as number)).trim();
			if (rec.status === "unanswered") throw new Error(rec.reason === "aborted" ? "stopped" : typeof rec.detail === "string" && rec.detail ? rec.detail : rec.reason);
			throw new Error(`unexpected submission state ${rec.status}`);
		} catch (error) {
			if (this.stopped) return undefined;
			throw error;
		} finally {
			off();
		}
	}

	/**
	 * A turn of a member's bot, run on its machine in its room session there (made on its first turn). The
	 * prompt is kept so a restart sends it again under the same key, which the other machine drops as a
	 * repeat. Its approvals are asked here, in this gateway's entry for that session.
	 */
	private async remoteTurn(room: RoomInfo, member: RoomMember, bot: Bot, coords: Coords, prompt: string | undefined): Promise<string | undefined> {
		const remote = bot.remote!;
		const target = this.d.members.target(remote.nodeId);
		if (!target) throw new Error(`${remote.node} is no longer a member of the network`);
		const peer: PeerTarget = { ...target, profile: remote.bot };
		const kept = this.d.db.get<{ session_id: string; prompt: string | null }>("SELECT session_id, prompt FROM room_turns WHERE room_id = ? AND turn_id = ?", room.room_id, coords.turn_id);
		const text = kept?.prompt ?? prompt;
		if (text === undefined || text === null) throw new Error("the gateway restarted before this turn began");
		const session = await this.remoteSession(room, coords.thread_id, member, bot, peer);
		if (!kept) this.d.db.run("INSERT OR REPLACE INTO room_turns (room_id, turn_id, session_id, submission_id, prompt) VALUES (?, ?, ?, 0, ?)", room.room_id, coords.turn_id, session.id, text);
		this.d.db.run("UPDATE sessions SET last_active = ? WHERE id = ?", Date.now() / 1000, session.id);
		const key = `${room.room_id}\0${coords.turn_id}`;
		const controller = new AbortController();
		this.remoteTurns.set(key, controller);
		const off = this.watchApprovals(room, member, session, coords);
		try {
			const r = await runOnPeer(peer, text, {
				key: `room:${room.room_id}:${coords.turn_id}`,
				sessionId: session.id,
				failFast: `${remote.node} is offline (its bots cannot be reached right now)`,
				onApproval: (p) =>
					this.d.approvals.ask(
						{
							sessionId: session.id,
							bot: bot.name,
							toolName: p.toolName,
							command: p.command,
							description: fromMachine(remote.node, p.description),
							patternKey: `member:${remote.nodeId}:${p.patternKey}`,
						},
						controller.signal,
					),
				signal: controller.signal,
				timeoutMs: 24 * 3600_000,
				maxAttempts: 1000,
			});
			this.d.sessions.recordRemote(session.id, { prompt: text, answer: r.text });
			return redact(r.text).trim();
		} catch (error) {
			if (this.stopped) return undefined;
			if (controller.signal.aborted) throw new Error("stopped");
			throw error;
		} finally {
			off();
			this.remoteTurns.delete(key);
		}
	}

	/**
	 * While a turn waits for the owner's approval: a line in the room saying who waits and where, and the
	 * member's session listed at the top of the chat list (src/api/ops/sessions.ts) so its card can be reached
	 * without the notification. Returns the unsubscribe.
	 */
	private watchApprovals(room: RoomInfo, member: RoomMember, session: SessionRow, coords: Coords): () => void {
		return this.d.hub.subscribe(session.id, (_sid, e) => {
			if (e.type === "approval.resolved") return this.d.hub.publishGlobal({ type: "sessions.changed", bot: session.bot, sessionId: session.id });
			if (e.type !== "approval.requested" || this.row(room.room_id)?.disbanded_at !== null) return;
			this.d.db.run("UPDATE sessions SET last_active = ? WHERE id = ?", Date.now() / 1000, session.id);
			this.d.hub.publishGlobal({ type: "sessions.changed", bot: session.bot, sessionId: session.id });
			const who = member.display_name || member.handle;
			const status = `${who} is waiting for your approval: open "${session.title}" in Chats`;
			this.append(room.room_id, [{ kind: "room.activity", actor: GATEWAY, payload: { status, member_id: member.member_id, thread_id: coords.thread_id, discussion_event_id: coords.discussion_event_id } }]);
		});
	}

	private closeTurn(roomId: string, turnId: string, outcome: Append[]): void {
		this.commit(roomId, () => {
			// A disbanded room files nothing more about its turns.
			if (this.row(roomId)) this.appendIn(roomId, outcome);
			this.d.db.run("DELETE FROM room_turns WHERE room_id = ? AND turn_id = ?", roomId, turnId);
		});
	}

	private sessionTitle(room: RoomInfo, threadId: string): string {
		return `Group: ${room.name}${threadId === "main" ? "" : ` · ${threadId}`}`;
	}

	/** The member's own session for a room thread, made on its first turn (configured as that bot). */
	private async memberSession(room: RoomInfo, threadId: string, member: RoomMember): Promise<SessionRow> {
		const kept = this.d.db.get<{ session_id: string }>("SELECT session_id FROM room_sessions WHERE room_id = ? AND thread_id = ? AND member_id = ?", room.room_id, threadId, member.member_id);
		const existing = kept ? this.d.sessions.get(kept.session_id) : undefined;
		if (existing && existing.bot === member.profile) return existing;
		const row = await this.d.sessions.create(member.profile, { kind: "room", source: "room", title: this.sessionTitle(room, threadId) });
		this.d.db.run("INSERT OR REPLACE INTO room_sessions (room_id, thread_id, member_id, session_id) VALUES (?, ?, ?, ?)", room.room_id, threadId, member.member_id, row.id);
		return row;
	}

	/** A member's bot's room session on its machine, catalogued here under the id it has there. */
	private async remoteSession(room: RoomInfo, threadId: string, member: RoomMember, bot: Bot, peer: PeerTarget): Promise<SessionRow> {
		const kept = this.d.db.get<{ session_id: string }>("SELECT session_id FROM room_sessions WHERE room_id = ? AND thread_id = ? AND member_id = ?", room.room_id, threadId, member.member_id);
		const existing = kept ? this.d.sessions.get(kept.session_id) : undefined;
		if (existing && existing.bot === bot.name && existing.remote_node === bot.remote!.nodeId) return existing;
		const title = this.sessionTitle(room, threadId);
		const id = await createPeerSession(peer, { kind: "room", title });
		const row = this.d.sessions.registerRemote(id, bot.name, bot.remote!.nodeId, { kind: "room", source: "room", title });
		this.d.db.run("INSERT OR REPLACE INTO room_sessions (room_id, thread_id, member_id, session_id) VALUES (?, ?, ?, ?)", room.room_id, threadId, member.member_id, row.id);
		return row;
	}

	private async notifySettled(room: RoomInfo, discussionEventId: string): Promise<void> {
		const replies = this.events(room.room_id).filter((e) => e.kind === "message.member" && e.payload.discussion_event_id === discussionEventId);
		const last = replies[replies.length - 1];
		if (!last) return;
		const who = room.members.find((m) => m.member_id === last.payload.member_id);
		const line = `${who?.display_name || who?.handle || "A bot"}: ${String(last.payload.text).replace(/\s+/g, " ")}`;
		const more = replies.length > 1 ? ` (${replies.length} replies)` : "";
		await this.d.notifier.send({ title: `${room.name}${more}`, message: line.slice(0, 1000) }).catch((error) => log.warn("room notification not sent", { room: room.room_id, error: String(error).slice(0, 200) }));
	}

	// ── Storage ─────────────────────────────────────────────────────────────────────────────

	private row(id: string, includeDisbanded = false): RoomRow | undefined {
		return this.d.db.get<RoomRow>(`SELECT * FROM rooms WHERE id = ?${includeDisbanded ? "" : " AND disbanded_at IS NULL"}`, id);
	}

	private require(id: unknown, code: number): RoomRow {
		const room = typeof id === "string" && id ? this.row(id, true) : undefined;
		if (!room) throw new RoomError(code, `room not found: ${typeof id === "string" ? id : ""}`);
		return room;
	}

	private events(roomId: string): RoomEvent[] {
		return this.d.db.all<EventRow>("SELECT * FROM room_events WHERE room_id = ? ORDER BY seq", roomId).map(event);
	}

	private latestSeq(roomId: string): number {
		return this.d.db.get<{ s: number | null }>("SELECT MAX(seq) AS s FROM room_events WHERE room_id = ?", roomId)?.s ?? 0;
	}

	private append(roomId: string, items: Append[]): RoomEvent[] {
		return this.commit(roomId, () => this.appendIn(roomId, items));
	}

	/** One transaction; the events it filed are announced once it committed (the client API pushes them). */
	private commit<T>(roomId: string, fn: () => T): T {
		const r = this.d.db.tx(fn);
		const filed = this.unannounced.get(roomId) ?? [];
		this.unannounced.delete(roomId);
		if (filed.length > 0) this.d.hub.publishGlobal({ type: "rooms.changed", roomId, events: filed });
		return r;
	}

	/** Appends inside the caller's transaction (commit), numbering each event after the last. */
	private appendIn(roomId: string, items: Append[]): RoomEvent[] {
		const now = Date.now() / 1000;
		let seq = this.latestSeq(roomId);
		const out: RoomEvent[] = [];
		for (const it of items) {
			seq++;
			const e: EventRow = { room_id: roomId, seq, event_id: it.eventId ?? newEventId(), kind: it.kind, actor: JSON.stringify(it.actor), payload: JSON.stringify(it.payload), created_at: now };
			this.d.db.run("INSERT INTO room_events (room_id, seq, event_id, kind, actor, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", e.room_id, e.seq, e.event_id, e.kind, e.actor, e.payload, e.created_at);
			out.push(event(e));
		}
		if (items.length) this.d.db.run("UPDATE rooms SET updated_at = ? WHERE id = ?", now, roomId);
		this.unannounced.set(roomId, [...(this.unannounced.get(roomId) ?? []), ...out]);
		return out;
	}

	private json(r: RoomRow): RoomJson {
		return { room_id: r.id, name: r.name, members: JSON.parse(r.members) as RoomMember[], created_at: r.created_at, updated_at: r.updated_at, disbanded_at: r.disbanded_at, latest_seq: this.latestSeq(r.id) };
	}

	/** 2-6 bots of this gateway, each once; ids and handles default to the bot's name. */
	private roster(value: unknown): RoomMember[] {
		if (!Array.isArray(value)) throw new RoomError(4110, "members must be a list");
		if (value.length < MIN_MEMBERS || value.length > MAX_MEMBERS) throw new RoomError(4110, `a group chat has ${MIN_MEMBERS} to ${MAX_MEMBERS} bots`);
		const out: RoomMember[] = [];
		for (const [i, raw] of value.entries()) {
			const m = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
			const profile = typeof m.profile === "string" && m.profile ? m.profile : "";
			const bot = profile ? this.d.bots.get(profile) : undefined;
			if (!bot) throw new RoomError(4110, `member ${i + 1}: there is no bot named "${profile}"`);
			// A member's bot answers on its own machine; a configured peer agent (`peer:`) cannot join.
			if (bot.isPeer && !bot.remote) throw new RoomError(4110, `${bot.displayName} is an agent on another gateway that is not in this network; it cannot join a group chat`);
			const member: RoomMember = {
				member_id: m.member_id === undefined ? bot.name : identifier(m.member_id, `member ${i + 1} member_id`, 4110),
				profile: bot.name,
				handle: m.handle === undefined ? bot.name : identifier(m.handle, `member ${i + 1} handle`, 4110),
				display_name: typeof m.display_name === "string" && m.display_name.trim() ? m.display_name.trim().slice(0, 80) : bot.displayName,
			};
			if (out.some((o) => o.member_id === member.member_id || o.handle.toLowerCase() === member.handle.toLowerCase())) throw new RoomError(4110, `${bot.displayName} is in the list twice`);
			if (["all", "everyone", "user"].includes(member.handle.toLowerCase())) throw new RoomError(4110, `@${member.handle} is reserved`);
			out.push(member);
		}
		return out;
	}
}

/** Turns started with no terminal event yet. */
function openTurns(events: RoomEvent[]): RoomEvent[] {
	const closed = new Set(events.filter((e) => e.kind === "turn.settled" || e.kind === "turn.failed").map((e) => String(e.payload.turn_id)));
	return events.filter((e) => e.kind === "turn.started" && !closed.has(String(e.payload.turn_id)));
}

function event(r: EventRow): RoomEvent {
	return { room_id: r.room_id, seq: r.seq, event_id: r.event_id, kind: r.kind, actor: JSON.parse(r.actor) as RoomEvent["actor"], payload: JSON.parse(r.payload) as Record<string, unknown>, created_at: r.created_at };
}

function identifier(value: unknown, label: string, code: number): string {
	if (typeof value !== "string" || !IDENTIFIER.test(value)) throw new RoomError(code, `${label} must be letters, digits and - . _ : (up to 128)`);
	return value;
}

function clamp(value: unknown, def: number, min: number, max: number): number {
	const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : def;
	return Math.min(max, Math.max(min, n));
}

function newEventId(): string {
	return `evt-${randomBytes(6).toString("hex")}`;
}

/** The first line of an error, redacted and short, for the room log. */
function oneLine(error: unknown): string {
	const text = error instanceof Error ? error.message : String(error);
	return redact(text.split("\n").find((l) => l.trim()) ?? "the turn failed").slice(0, 300) || "the turn failed";
}

function cut(text: string): string {
	if (Buffer.byteLength(text) <= MAX_TEXT_BYTES) return text;
	return `${Buffer.from(text).subarray(0, MAX_TEXT_BYTES - 40).toString("utf8").replace(/�+$/, "")}\n… (cut to fit the room)`;
}
