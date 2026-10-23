// Wire shapes of group chats (docs/API.md "Group chats"). The room log keeps the typed events core/rooms.ts
// files; on the wire their payload keys are camelCase like everything else, and times are milliseconds.
import type { RoomJson } from "../../core/rooms.ts";
import type { RoomEvent } from "../../core/room-plan.ts";

const camel = (k: string) => k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

/** Payload keys camelCased, nested ones too; values as they are. */
function camelKeys(v: unknown): unknown {
	if (Array.isArray(v)) return v.map(camelKeys);
	if (!v || typeof v !== "object") return v;
	return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [camel(k), camelKeys(x)]));
}

export function roomJson(r: RoomJson) {
	return {
		id: r.room_id,
		name: r.name,
		members: r.members.map((m) => ({ id: m.member_id, botId: m.profile, handle: m.handle, displayName: m.display_name })),
		createdAt: Math.round(r.created_at * 1000),
		updatedAt: Math.round(r.updated_at * 1000),
		disbandedAt: r.disbanded_at === null ? null : Math.round(r.disbanded_at * 1000),
		latestSeq: r.latest_seq,
	};
}

export function roomEventJson(e: RoomEvent) {
	return { roomId: e.room_id, seq: e.seq, id: e.event_id, kind: e.kind, actor: e.actor, data: camelKeys(e.payload), at: Math.round(e.created_at * 1000) };
}
