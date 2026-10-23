// Canonical events → client API events (docs/API.md "Events"). A followed chat's events carry its `seq`
// (the hub's count for that chat, so a client can tell it missed some) and are kept a while for a client that
// reconnects; gateway-wide events go to every owner socket, and to a member only for the chats it started.
import type { Core } from "../app.ts";
import type { ApprovalRequest, SessionEvent } from "../core/events.ts";
import { logger, redact } from "../log.ts";
import { memberOwns } from "./lookup.ts";
import { identifyAttachments } from "./ops/attachments.ts";
import type { Caller } from "./ops.ts";
import { approvalJson, itemJson, sessionJson, turnJson, usageJson } from "./shapes/chat.ts";
import { roomEventJson, roomJson } from "./shapes/rooms.ts";
import type { ApiEvent } from "./socket.ts";

const log = logger("api-events");

/** A followed chat's event on the wire, or undefined for events that are not sent per chat. */
export function chatEvent(e: SessionEvent): { event: string; data: Record<string, unknown> } | undefined {
	switch (e.type) {
		case "turn.started":
			return { event: "turn.started", data: { turn: turnJson(e.turn) } };
		case "item.started":
		case "item.updated":
		case "item.finished":
			return { event: e.type, data: { turnId: e.turnId, item: itemJson(e.item) } };
		case "text.delta":
		case "reasoning.delta":
			return { event: "item.delta", data: { turnId: e.turnId, itemId: e.itemId, field: "text", text: redact(e.text) } };
		case "tool.output":
			return { event: "item.delta", data: { turnId: e.turnId, itemId: e.callId, field: "output", text: redact(e.text) } };
		case "turn.finished": {
			const { type: _t, ...data } = e;
			return { event: "turn.finished", data };
		}
		case "usage":
			return { event: "usage.updated", data: { usage: usageJson(e.usage) } };
		case "notice":
			return { event: "session.notice", data: { kind: e.message.startsWith("Compressing") ? "compacting" : "notice", text: redact(e.message) } };
		default:
			return undefined;
	}
}

/** Events of a chat kept for a client that reconnects soon (docs/API.md "Following a chat"). */
const REPLAY_EVENTS = 2000;
/** How long a chat's recent events are kept after its last follower left. */
const REPLAY_KEEP_MS = 5 * 60_000;

type Feed = { off: () => void; followers: Set<(e: ApiEvent) => void>; recent: ApiEvent[]; from: number; idle?: NodeJS.Timeout };

/**
 * One hub subscription per followed local chat, turned into wire events once and fanned out to its sockets.
 * The latest events are kept for a while after the last follower leaves, so a client that reconnects gets
 * only what it missed (`events.replay`). A chat with a member's bot is followed through src/federation/chats.ts.
 */
export class ChatFeeds {
	private readonly core: Core;
	private readonly feeds = new Map<string, Feed>();

	constructor(core: Core) {
		this.core = core;
	}

	follow(sessionId: string, send: (e: ApiEvent) => void): () => void {
		if (this.core.sessions.get(sessionId)?.remote_node) return this.core.memberChats.follow(sessionId, send);
		const feed = this.feed(sessionId);
		if (feed.idle) clearTimeout(feed.idle);
		feed.idle = undefined;
		feed.followers.add(send);
		return () => {
			feed.followers.delete(send);
			if (feed.followers.size > 0) return;
			feed.idle = setTimeout(() => {
				feed.off();
				this.feeds.delete(sessionId);
			}, REPLAY_KEEP_MS);
			feed.idle.unref();
		};
	}

	/** The chat's events after `afterSeq`, or undefined when they are not all kept (the client needs a snapshot). */
	since(sessionId: string, afterSeq: number): ApiEvent[] | undefined {
		const feed = this.feeds.get(sessionId);
		if (!feed || afterSeq < feed.from || afterSeq > this.core.hub.seq(sessionId)) return undefined;
		return feed.recent.filter((e) => (e.seq ?? 0) > afterSeq);
	}

	close(): void {
		for (const f of this.feeds.values()) {
			if (f.idle) clearTimeout(f.idle);
			f.off();
		}
		this.feeds.clear();
	}

	private feed(sessionId: string): Feed {
		let feed = this.feeds.get(sessionId);
		if (feed) return feed;
		const f: Feed = { off: () => {}, followers: new Set(), recent: [], from: this.core.hub.seq(sessionId) };
		f.off = this.core.hub.subscribe(sessionId, (sid, e) => {
			if (e.type === "turn.started") identifyAttachments(this.core, sid, [e.turn]);
			const out = chatEvent(e);
			if (!out) return;
			const wire: ApiEvent = { event: out.event, sessionId: sid, seq: this.core.hub.seq(sid), at: Date.now(), data: out.data };
			f.recent.push(wire);
			if (f.recent.length > REPLAY_EVENTS) f.from = f.recent.splice(0, f.recent.length - REPLAY_EVENTS).at(-1)!.seq!;
			for (const send of [...f.followers]) send(wire);
		});
		this.feeds.set(sessionId, (feed = f));
		return feed;
	}
}

export function globalFeed(core: Core) {
	return (send: (e: ApiEvent) => void, caller: Caller): (() => void) => {
		const emit = (event: string, data: Record<string, unknown>) => send({ event, at: Date.now(), data });
		const sessionChanged = (id: string, bot: string) => {
			const row = core.sessions.get(id);
			if (!row) return emit("session.deleted", { id, botId: bot });
			if (!memberOwns(row, caller)) return;
			sessionJson(core, row).then(
				(session) => emit("session.updated", { session }),
				(error: unknown) => log.debug("session for an event not read", { session: id, error: String(error) }),
			);
		};
		const approval = (r: ApprovalRequest) => (caller.kind === "owner" || memberOwns(core.sessions.get(r.sessionId), caller) ? r : undefined);
		const offAll = core.hub.subscribeAll((sid, e) => {
			if (e.type === "approval.requested") {
				if (approval(e.request)) emit("approval.requested", { approval: approvalJson(e.request) });
			} else if (e.type === "approval.resolved") {
				if (caller.kind === "owner" || memberOwns(core.sessions.get(sid), caller)) emit("approval.resolved", { id: e.requestId, sessionId: sid, choice: e.choice, reason: e.reason });
			} else if (e.type === "run.started" || e.type === "run.finished" || e.type === "title") {
				const row = core.sessions.get(sid);
				if (row) sessionChanged(sid, row.bot);
			}
		});
		const offGlobal = core.hub.onGlobal((e) => {
			if (e.type === "sessions.changed") {
				if (e.sessionId) sessionChanged(e.sessionId, e.bot);
				else if (caller.kind === "owner") emit("sessions.changed", { botId: e.bot });
			} else if (e.type === "cron.changed" && caller.kind === "owner") emit("jobs.changed", {});
			else if (e.type === "rooms.changed" && caller.kind === "owner") {
				if (e.events.length === 0 || e.events.some((x) => x.kind === "room.disbanded")) {
					const room = core.rooms.get(e.roomId);
					if (room) emit("room.updated", { room: roomJson(room) });
				}
				for (const x of e.events) emit("room.event", { roomId: e.roomId, event: roomEventJson(x) });
			}
		});
		return () => {
			offAll();
			offGlobal();
		};
	};
}
