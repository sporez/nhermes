import assert from "node:assert/strict";
import { test } from "node:test";
import {
	isPass,
	mentions,
	planNextTurn,
	turnCoordinates,
	type Decision,
	type RoomEvent,
	type RoomInfo,
	type TurnPlan,
} from "../../src/core/room-plan.ts";

const room: RoomInfo = {
	room_id: "room1",
	name: "Standup",
	members: [
		{ member_id: "a1", profile: "alpha", handle: "alpha", display_name: "Alpha" },
		{ member_id: "b1", profile: "beta", handle: "beta", display_name: "Beta" },
		{ member_id: "o1", profile: "ops", handle: "ops", display_name: "Ops" },
	],
};

class Log {
	events: RoomEvent[] = [];
	private seq = 0;
	add(kind: string, actor: { kind: string; id: string }, payload: Record<string, unknown>): RoomEvent {
		const seq = ++this.seq;
		const event = { room_id: room.room_id, seq, event_id: `e${seq}`, kind, actor, payload, created_at: seq };
		this.events.push(event);
		return event;
	}
	user(text: string, thread_id = "t1"): RoomEvent {
		return this.add("message.user", { kind: "user", id: "u" }, { text, thread_id });
	}
	plan(): Decision {
		return planNextTurn(room, this.events);
	}
	task(): TurnPlan {
		const decision = this.plan();
		assert.equal(decision.status, "task");
		return (decision as Extract<Decision, { status: "task" }>).task;
	}
	reply(task: TurnPlan, text: string): void {
		const coords = turnCoordinates(task);
		this.add("turn.started", { kind: "gateway", id: "gw" }, coords);
		if (isPass(text)) {
			this.add("turn.settled", { kind: "gateway", id: "gw" }, { ...coords, passed: true, seen_through_seq: task.seenThroughSeq });
			return;
		}
		const message = this.add("message.member", { kind: "member", id: task.member.member_id }, { ...coords, text });
		this.add(
			"turn.settled",
			{ kind: "gateway", id: "gw" },
			{ ...coords, passed: false, message_event_id: message.event_id, seen_through_seq: task.seenThroughSeq },
		);
	}
	fail(task: TurnPlan): void {
		this.add("turn.failed", { kind: "gateway", id: "gw" }, { ...turnCoordinates(task), error: "boom", seen_through_seq: task.seenThroughSeq });
	}
}

test("isPass", () => {
	for (const text of ["(pass)", "pass.", "", "Pass", "  ( PASS ).  "]) assert.equal(isPass(text), true, text);
	assert.equal(isPass("passing thoughts"), false);
});

test("mentions", () => {
	const handles = (list: { handle: string }[]) => list.map((m) => m.handle);
	assert.deepEqual(handles(mentions(["hi"], room.members)), ["alpha", "beta", "ops"]);
	assert.deepEqual(handles(mentions(["hi"], room.members, false)), []);
	assert.deepEqual(handles(mentions(["ping @OPS and @alpha,"], room.members)), ["alpha", "ops"]);
	assert.deepEqual(handles(mentions(["over to @ops."], room.members)), ["ops"], "a sentence's full stop is not part of the handle");
	assert.deepEqual(handles(mentions(["@everyone"], room.members, false)), ["alpha", "beta", "ops"]);
	assert.deepEqual(handles(mentions(["@nobody"], room.members)), ["alpha", "beta", "ops"]);
});

test("no pending user event is idle", () => {
	assert.deepEqual(new Log().plan(), { status: "idle", reason: "no_pending_user_event" });
});

test("no mention: members are asked in order", () => {
	const log = new Log();
	log.user("what do you think?");
	const first = log.task();
	assert.equal(first.member.handle, "alpha");
	assert.equal(first.roundIndex, 0);
	assert.equal(first.turnId, "d1.r0.p0.s1.ma1");
	assert.equal(first.taskId, "dtask:room1:d1.r0.p0.s1.ma1");
	log.reply(first, "my view");
	const second = log.task();
	assert.equal(second.member.handle, "beta");
	assert.match(second.prompt, /User \(user\): what do you think\?/);
	assert.match(second.prompt, /@alpha: my view/);
});

test("@ops asks only ops", () => {
	const log = new Log();
	log.user("@ops status?");
	const task = log.task();
	assert.equal(task.member.handle, "ops");
	log.reply(task, "all good");
	assert.equal(log.plan().status, "settled"); // nobody cited, so round 1 is silent
});

test("@all asks every member", () => {
	const log = new Log();
	log.user("@all go");
	const seen: string[] = [];
	for (let i = 0; i < 3; i++) {
		const task = log.task();
		seen.push(task.member.handle);
		log.reply(task, "(pass)");
	}
	assert.deepEqual(seen, ["alpha", "beta", "ops"]);
});

test("pass is terminal and leaves no message; all-pass round settles", () => {
	const log = new Log();
	log.user("anyone?");
	for (let i = 0; i < 3; i++) log.reply(log.task(), "(pass)");
	assert.equal(log.events.filter((e) => e.kind === "message.member").length, 0);
	const decision = log.plan();
	assert.equal(decision.status, "settled");
	assert.equal((decision as { reason: string }).reason, "silent_round");
});

test("citation of an already-answered member triggers round 1; rotation order for two cited", () => {
	const log = new Log();
	log.user("discuss");
	log.reply(log.task(), "(pass)"); // alpha
	log.reply(log.task(), "beta here"); // beta
	log.reply(log.task(), "ops here, over to @alpha and @beta"); // ops cites both
	const next = log.task();
	assert.equal(next.roundIndex, 1);
	// responders [alpha, beta] rotated by 1 -> beta first
	assert.equal(next.member.handle, "beta");
	assert.equal(next.memberIndex, 0);
	log.reply(next, "(pass)");
	const after = log.task();
	assert.equal(after.roundIndex, 1);
	assert.equal(after.member.handle, "alpha");
	assert.equal(after.memberIndex, 1);
});

test("10 member messages is bounded", () => {
	const log = new Log();
	const user = log.user("@alpha go");
	for (let i = 0; i < 10; i++) {
		const m = log.add("message.member", { kind: "member", id: "a1" }, { discussion_event_id: user.event_id, member_id: "a1", round_index: 0, thread_id: "t1", text: `m${i}` });
		log.add("turn.settled", { kind: "gateway", id: "gw" }, { discussion_event_id: user.event_id, member_id: "a1", round_index: 0, thread_id: "t1", passed: false, message_event_id: m.event_id, seen_through_seq: 1 });
	}
	const decision = log.plan();
	assert.equal(decision.status, "bounded");
	assert.equal((decision as { reason: string }).reason, "max_messages");
});

test("round cap is bounded max_rounds", () => {
	const log = new Log();
	log.user("@alpha start");
	let rounds = 0;
	for (let i = 0; i < 20 && log.plan().status === "task"; i++) {
		const task = log.task();
		rounds = Math.max(rounds, task.roundIndex);
		log.reply(task, "ping @alpha @beta @ops");
	}
	assert.equal(rounds, 2);
	const decision = log.plan();
	assert.equal(decision.status, "bounded");
	assert.equal((decision as { reason: string }).reason, "max_rounds");
});

test("failed turn is terminal", () => {
	const log = new Log();
	log.user("@alpha go");
	log.fail(log.task());
	const decision = log.plan();
	assert.equal(decision.status, "settled");
});

test("room.activity settled for the discussion is idle", () => {
	const log = new Log();
	const user = log.user("hi");
	log.add("room.activity", { kind: "gateway", id: "gw" }, { status: "settled", reason_code: "silent_round", thread_id: "t1", discussion_event_id: user.event_id });
	assert.equal(log.plan().status, "idle");
});

test("other room.activity statuses are ignored", () => {
	const log = new Log();
	log.user("hi");
	log.add("room.activity", { kind: "gateway", id: "gw" }, { status: "Ops is waiting for your approval", member_id: "o1", thread_id: "t1" });
	assert.equal(log.plan().status, "task");
});

test("a newer user message in the same thread supersedes the older", () => {
	const log = new Log();
	log.user("first");
	log.user("@ops second");
	const task = log.task();
	assert.equal(task.member.handle, "ops");
	assert.equal(task.sourceSeq, 2);
});

test("stop marker makes earlier user messages not pending", () => {
	for (const kind of ["room.stop_requested", "room.disbanded"]) {
		const log = new Log();
		log.user("hi");
		log.add(kind, { kind: "user", id: "u" }, {});
		assert.equal(log.plan().status, "idle", kind);
		log.user("again");
		assert.equal(log.plan().status, "task", kind);
	}
});

test("events may arrive unsorted", () => {
	const log = new Log();
	log.user("hi");
	log.events.reverse();
	assert.equal(log.task().member.handle, "alpha");
});

test("prompt holds only messages after the watermark, plus the rules", () => {
	const log = new Log();
	log.user("@all one");
	log.reply(log.task(), "alpha says A");
	log.reply(log.task(), "beta says B");
	log.reply(log.task(), "ops says C and cites @alpha");
	const task = log.task();
	assert.equal(task.member.handle, "alpha");
	assert.equal(task.roundIndex, 1);
	assert.ok(!task.prompt.includes("User (user): @all one"));
	assert.ok(!task.prompt.includes("alpha says A"));
	assert.match(task.prompt, /@beta: beta says B/);
	assert.match(task.prompt, /@ops: ops says C/);
	assert.ok(task.prompt.startsWith('[Discussion: "Standup"] You are @alpha, one participant with @beta, @ops and the user.\n\nNew messages in this thread since your last turn (oldest first):\n'));
	assert.match(task.prompt, /Rules for this Discussion:/);
	assert.match(task.prompt, /reply with exactly "\(pass\)"/);
});
