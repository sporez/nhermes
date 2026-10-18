// Group-chat turn planner: a pure replay of the room log that decides the next member turn.
// Port of plan_next_task in Hermes' gateway/hosted_room_discussion.py (we write our own log, so no foreign-event validation).

export type RoomMember = { member_id: string; profile: string; handle: string; display_name: string };
export type RoomActor = { kind: string; id: string };
export type RoomEvent = {
	room_id: string;
	seq: number;
	event_id: string;
	kind: string;
	actor: RoomActor;
	payload: Record<string, unknown>;
	created_at: number;
};
export type RoomInfo = { room_id: string; name: string; members: RoomMember[] };

export const MAX_ROUNDS = 3;
export const MAX_MESSAGES = 10;
export const MAX_DELTA_LINES = 24;
export const MAX_PROMPT_BYTES = 128 * 1024;

export type TurnPlan = {
	discussionEventId: string;
	sourceSeq: number;
	threadId: string;
	member: RoomMember;
	memberIndex: number;
	roundIndex: number;
	seenThroughSeq: number;
	turnId: string;
	taskId: string;
	prompt: string;
};

export type Decision =
	| { status: "idle"; reason: "no_pending_user_event" }
	| { status: "task"; reason: "member_turn"; discussionEventId: string; threadId: string; task: TurnPlan }
	| { status: "settled"; reason: "silent_round"; discussionEventId: string; threadId: string }
	| { status: "bounded"; reason: "max_rounds" | "max_messages"; discussionEventId: string; threadId: string };

const MENTION_RE = /@([A-Za-z0-9][A-Za-z0-9._:-]*)/g;
const PASS_RE = /^\(?\s*pass\s*\)?\.?$/i;
const encoder = new TextEncoder();
const byteLength = (text: string): number => encoder.encode(text).length;

export function isPass(text: string): boolean {
	const trimmed = String(text ?? "").trim();
	return trimmed === "" || PASS_RE.test(trimmed);
}

export function mentions(texts: string[], members: RoomMember[], defaultAll = true): RoomMember[] {
	const handles = new Set(members.map((member) => member.handle.toLowerCase()));
	const found = new Set<string>();
	let everyone = false;
	for (const text of texts) {
		for (const match of String(text ?? "").matchAll(MENTION_RE)) {
			// "@ops." at the end of a sentence still means ops (Hermes keeps the dot and misses it).
			const handle = (match[1] ?? "").replace(/[.:-]+$/, "").toLowerCase();
			if (handle === "all" || handle === "everyone") everyone = true;
			else if (handles.has(handle)) found.add(handle);
		}
	}
	if (everyone || (defaultAll && found.size === 0)) return [...members];
	return members.filter((member) => found.has(member.handle.toLowerCase()));
}

export function turnCoordinates(t: TurnPlan) {
	return {
		discussion_event_id: t.discussionEventId,
		member_id: t.member.member_id,
		member_index: t.memberIndex,
		round_index: t.roundIndex,
		task_id: t.taskId,
		thread_id: t.threadId,
		turn_id: t.turnId,
	};
}

const str = (value: unknown): string => String(value ?? "");
const memberOf = (event: RoomEvent): string => str(event.payload.member_id ?? event.actor.id);

function unaddressedMentions(messages: RoomEvent[], members: RoomMember[]): RoomMember[] {
	const citedAt = new Map<string, number>();
	const lastPostAt = new Map<string, number>();
	for (const event of messages) {
		if (event.kind !== "message.member") continue;
		const speaker = memberOf(event);
		lastPostAt.set(speaker, event.seq);
		for (const member of mentions([str(event.payload.text)], members, false)) {
			if (member.member_id !== speaker) citedAt.set(member.member_id, event.seq);
		}
	}
	return members.filter((member) => {
		const cited = citedAt.get(member.member_id);
		return cited !== undefined && (lastPostAt.get(member.member_id) ?? 0) <= cited;
	});
}

function rotate(members: RoomMember[], roundIndex: number): RoomMember[] {
	const shift = members.length ? roundIndex % members.length : 0;
	return [...members.slice(shift), ...members.slice(0, shift)];
}

function deriveWatermarks(events: RoomEvent[]): Map<string, number> {
	const seqById = new Map<string, number>();
	for (const event of events) if (event.kind === "message.member") seqById.set(event.event_id, event.seq);
	const watermarks = new Map<string, number>();
	for (const event of events) {
		if (event.kind !== "turn.settled" && event.kind !== "turn.failed") continue;
		const key = `${str(event.payload.thread_id)}\0${str(event.payload.member_id)}`;
		let watermark = Number(event.payload.seen_through_seq ?? 0);
		if (event.kind === "turn.settled" && !event.payload.passed) {
			watermark = Math.max(watermark, seqById.get(str(event.payload.message_event_id)) ?? 0);
		}
		watermarks.set(key, Math.max(watermarks.get(key) ?? 0, watermark));
	}
	return watermarks;
}

function formatMessage(event: RoomEvent, room: RoomInfo): string {
	if (event.kind === "message.user") return `User (user): ${str(event.payload.text)}`;
	const member = room.members.find((candidate) => candidate.member_id === memberOf(event));
	return `@${member?.handle ?? memberOf(event)}: ${str(event.payload.text)}`;
}

// Cut to at most maxBytes of UTF-8, dropping a partial trailing character.
function truncateUtf8(text: string, maxBytes: number): string {
	const bytes = encoder.encode(text);
	if (bytes.length <= maxBytes) return text;
	return new TextDecoder("utf-8").decode(bytes.slice(0, Math.max(0, maxBytes))).replace(/�+$/, "");
}

function buildPrompt(room: RoomInfo, member: RoomMember, messages: RoomEvent[], watermark: number, seenThrough: number): string {
	const delta = messages.filter((event) => watermark < event.seq && event.seq <= seenThrough).slice(-MAX_DELTA_LINES);
	const peers = room.members
		.filter((candidate) => candidate.member_id !== member.member_id)
		.map((candidate) => `@${candidate.handle}`)
		.join(", ");
	const opening = [
		`[Discussion: "${room.name}"] You are @${member.handle}, one participant with ${peers || "no other members"} and the user.`,
		"",
		"New messages in this thread since your last turn (oldest first):",
	];
	const rules = [
		"",
		"Rules for this Discussion:",
		"- Reply with one conversational message only when you have something new worth adding.",
		'- If you have nothing new to add, reply with exactly "(pass)".',
		"- Mention a teammate by handle to pull them into the next round; do not repeat points already made.",
		"- Never reveal content from private conversations. Your reply is published verbatim.",
	];
	const fixed = byteLength([...opening, ...rules].join("\n"));
	let available = Math.max(0, MAX_PROMPT_BYTES - fixed - 1);
	const selected: string[] = [];
	for (const event of [...delta].reverse()) {
		const line = `  ${formatMessage(event, room)}`;
		const lineBytes = byteLength(line) + 1;
		if (lineBytes > available) {
			if (selected.length === 0 && available > 32) selected.push(truncateUtf8(line, available));
			selected.push("  [Earlier content omitted to fit this turn.]");
			break;
		}
		selected.push(line);
		available -= lineBytes;
	}
	selected.reverse();
	return [...opening, ...selected, ...rules].join("\n");
}

function pendingDiscussion(events: RoomEvent[]): RoomEvent | undefined {
	const stoppedThrough = Math.max(
		0,
		...events.filter((e) => e.kind === "room.stop_requested" || e.kind === "room.disbanded").map((e) => e.seq),
	);
	const completed = new Set(
		events
			.filter((e) => e.kind === "room.activity" && (e.payload.status === "settled" || e.payload.status === "bounded"))
			.map((e) => str(e.payload.discussion_event_id)),
	);
	const latestByThread = new Map<string, RoomEvent>();
	for (const event of events) if (event.kind === "message.user") latestByThread.set(str(event.payload.thread_id), event);
	return [...latestByThread.values()]
		.sort((a, b) => a.seq - b.seq)
		.find((event) => event.seq > stoppedThrough && !completed.has(event.event_id));
}

export function planNextTurn(room: RoomInfo, input: RoomEvent[]): Decision {
	const events = [...input].sort((a, b) => a.seq - b.seq);
	const discussion = pendingDiscussion(events);
	if (!discussion) return { status: "idle", reason: "no_pending_user_event" };
	const threadId = str(discussion.payload.thread_id);
	const base = { discussionEventId: discussion.event_id, threadId };

	const committed = new Set(
		events
			.filter((e) => e.kind === "turn.settled" && e.payload.message_event_id != null)
			.map((e) => str(e.payload.message_event_id)),
	);
	const threadMessages = events.filter(
		(e) =>
			e.payload.thread_id === threadId &&
			(e.kind === "message.user" || (e.kind === "message.member" && committed.has(e.event_id))),
	);
	const discussionMessages = threadMessages.filter((e) => e.seq >= discussion.seq);
	const memberMessages = threadMessages.filter(
		(e) => e.kind === "message.member" && e.payload.discussion_event_id === discussion.event_id,
	);
	if (memberMessages.length >= MAX_MESSAGES) return { status: "bounded", reason: "max_messages", ...base };

	const terminals = new Set(
		events
			.filter(
				(e) => (e.kind === "turn.settled" || e.kind === "turn.failed") && e.payload.discussion_event_id === discussion.event_id,
			)
			.map((e) => `${Number(e.payload.round_index)}\0${str(e.payload.member_id)}`),
	);
	const watermarks = deriveWatermarks(events);
	const seenThrough = Math.max(...threadMessages.map((e) => e.seq));

	for (let roundIndex = 0; roundIndex < MAX_ROUNDS; roundIndex++) {
		const responders =
			roundIndex === 0
				? mentions([str(discussion.payload.text)], room.members)
				: unaddressedMentions(discussionMessages, room.members);
		const ordered = rotate(responders, roundIndex);
		for (let memberIndex = 0; memberIndex < ordered.length; memberIndex++) {
			const member = ordered[memberIndex];
			if (!member) continue;
			if (terminals.has(`${roundIndex}\0${member.member_id}`)) continue;
			const watermark = watermarks.get(`${threadId}\0${member.member_id}`) ?? 0;
			if (!threadMessages.some((e) => watermark < e.seq && e.seq <= seenThrough)) continue;
			const prompt = buildPrompt(room, member, threadMessages, watermark, seenThrough);
			const turnId = `d${discussion.seq}.r${roundIndex}.p${memberIndex}.s${seenThrough}.m${member.member_id}`;
			const task: TurnPlan = {
				discussionEventId: discussion.event_id,
				sourceSeq: discussion.seq,
				threadId,
				member,
				memberIndex,
				roundIndex,
				seenThroughSeq: seenThrough,
				turnId,
				taskId: `dtask:${room.room_id}:${turnId}`,
				prompt,
			};
			return { status: "task", reason: "member_turn", ...base, task };
		}
		if (!memberMessages.some((e) => Number(e.payload.round_index) === roundIndex)) {
			return { status: "settled", reason: "silent_round", ...base };
		}
		if (roundIndex === MAX_ROUNDS - 1) return { status: "bounded", reason: "max_rounds", ...base };
	}
	throw new Error("bounded discussion loop exhausted unexpectedly");
}
