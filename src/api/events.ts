// Canonical events → client API events (docs/API.md "Events"). A followed chat's events carry its `seq`
// (the hub's count for that chat, so a client can tell it missed some); gateway-wide events go to every owner
// socket, and to a member only for the chats it started. Stateless apart from the subscriptions.
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

export function sessionFeed(core: Core) {
	return (sessionId: string, send: (e: ApiEvent) => void): (() => void) => {
		// A chat with a member's bot: its events come from the member, already in this shape.
		if (core.sessions.get(sessionId)?.remote_node) return core.memberChats.follow(sessionId, send);
		return core.hub.subscribe(sessionId, (sid, e) => {
			if (e.type === "turn.started") identifyAttachments(core, sid, [e.turn]);
			const out = chatEvent(e);
			if (out) send({ event: out.event, sessionId: sid, seq: core.hub.seq(sid), at: Date.now(), data: out.data });
		});
	};
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
