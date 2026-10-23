// Group chats (docs/API.md "Group chats"): rooms of 2-6 bots, this gateway's or members', and their typed log
// (core/rooms.ts drives the turns). New log events are pushed to owner sockets as `room.event`; the log can
// also be read from any point, so a client that was away catches up.
import { randomBytes } from "node:crypto";
import { ApiError } from "../errors.ts";
import type { Op, OpContext } from "../ops.ts";
import type { Params } from "../params.ts";
import { roomEventJson, roomJson } from "../shapes/rooms.ts";

function roomOf(cx: OpContext, p: Params) {
	const room = cx.core.rooms.get(p.str("id"));
	if (!room) throw new ApiError("not_found", "No group chat with that id.");
	return room;
}

function open(cx: OpContext, p: Params) {
	const room = roomOf(cx, p);
	if (room.disbanded_at !== null) throw new ApiError("conflict", "This group chat was disbanded.");
	return room;
}

export const roomOps: Op[] = [
	{
		name: "rooms.list",
		http: "GET /rooms",
		handle: (p, cx) => {
			const offset = Number(p.optStr("cursor") ?? "0");
			if (!Number.isInteger(offset) || offset < 0) throw new ApiError("invalid_params", "cursor is not one this gateway gave out.");
			const r = cx.core.rooms.list({ limit: p.optInt("limit", { min: 1, max: 200 }) ?? 50, offset, includeDisbanded: p.optBool("includeDisbanded") === true });
			return { items: r.rooms.map(roomJson), nextCursor: r.next_offset === null ? null : String(r.next_offset) };
		},
	},
	{
		name: "rooms.create",
		http: "POST /rooms",
		handle: (p, cx) => {
			const members = p.raw.members;
			if (!Array.isArray(members)) throw new ApiError("invalid_params", "members must be a list of bots.");
			const room = cx.core.rooms.create({
				room_id: p.optStr("id"),
				name: p.optStr("name"),
				members: members.map((m: Record<string, unknown> | null) => ({
					profile: m?.botId,
					...(m?.id !== undefined ? { member_id: m.id } : {}),
					...(m?.handle !== undefined ? { handle: m.handle } : {}),
					...(m?.displayName !== undefined ? { display_name: m.displayName } : {}),
				})),
			});
			return { room: roomJson(room) };
		},
	},
	{ name: "rooms.get", http: "GET /rooms/:id", handle: (p, cx) => ({ room: roomJson(roomOf(cx, p)) }) },
	{
		name: "rooms.send",
		http: "POST /rooms/:id/messages",
		handle: (p, cx) => {
			const room = open(cx, p);
			const eventId = p.optStr("eventId") ?? `evt-${randomBytes(6).toString("hex")}`;
			const event = cx.core.rooms.send({ room_id: room.room_id, event_id: eventId, payload: { text: p.str("text"), thread_id: p.optStr("threadId") ?? "main" } });
			return { event: roomEventJson(event) };
		},
	},
	{
		name: "rooms.events",
		http: "GET /rooms/:id/events",
		handle: (p, cx) => {
			const room = roomOf(cx, p);
			const r = cx.core.rooms.log({ room_id: room.room_id, since_seq: p.optInt("afterSeq", { min: 0 }) ?? 0, limit: p.optInt("limit", { min: 1, max: 500 }) ?? 100, include_disbanded: true });
			return { items: r.events.map(roomEventJson), latestSeq: r.latest_seq, hasMore: r.has_more };
		},
	},
	{
		name: "rooms.disband",
		http: "DELETE /rooms/:id",
		handle: async (p, cx) => {
			const room = roomOf(cx, p);
			await cx.core.rooms.disband(room.room_id);
			return { room: roomJson(cx.core.rooms.get(room.room_id)!) };
		},
	},
];
