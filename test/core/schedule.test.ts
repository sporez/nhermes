import assert from "node:assert/strict";
import { test } from "node:test";
import { describeSpec, nextRun, parseLocal, parseSchedule } from "../../src/core/schedule.ts";

const NY = "America/New_York";
const at = (iso: string) => Date.parse(iso) / 1000;
const isoOf = (s: number | undefined) => (s === undefined ? undefined : new Date(s * 1000).toISOString());

test("cron schedules run in the job's time zone", () => {
	const spec = parseSchedule("0 7 * * 1-5", NY);
	// Friday 2026-10-16 08:00 New York → next weekday 07:00 is Monday 2026-10-19 (EDT, UTC-4).
	assert.equal(isoOf(nextRun(spec, NY, at("2026-10-16T12:00:00Z"), 0)), "2026-10-19T11:00:00.000Z");
});

test("DST: a time missing on spring-forward runs once an hour later; a repeated time on fall-back runs once", () => {
	const spec = parseSchedule("30 2 * * *", NY);
	assert.equal(isoOf(nextRun(spec, NY, at("2027-03-13T12:00:00Z"), 0)), "2027-03-14T07:30:00.000Z"); // 03:30 EDT
	assert.equal(isoOf(nextRun(spec, NY, at("2027-03-14T07:30:00Z"), 0)), "2027-03-15T06:30:00.000Z"); // 02:30 EDT
	const fall = parseSchedule("30 1 * * *", NY);
	const first = nextRun(fall, NY, at("2027-11-06T12:00:00Z"), 0)!;
	assert.equal(isoOf(first), "2027-11-07T05:30:00.000Z"); // 01:30 EDT
	assert.equal(isoOf(nextRun(fall, NY, first, 0)), "2027-11-08T06:30:00.000Z", "not again at 01:30 EST the same night");
});

test("intervals are anchored to creation; one-shots run once", () => {
	const every = parseSchedule("every 30m", NY);
	assert.deepEqual(every, { kind: "every", seconds: 1800 });
	assert.equal(nextRun(every, NY, 1000 + 1800 * 5 + 10, 1000), 1000 + 1800 * 6);
	assert.equal(describeSpec(parseSchedule("every 2h", NY)), "every 2h");
	assert.throws(() => parseSchedule("every 10s", NY), /1 minute/);
	const once = parseSchedule("at 2026-10-15T09:00", NY);
	assert.equal(once.kind, "at");
	assert.equal(isoOf(once.kind === "at" ? once.at : 0), "2026-10-15T13:00:00.000Z");
	assert.equal(nextRun(once, NY, at("2026-10-15T14:00:00Z"), 0), undefined);
	assert.throws(() => parseSchedule("whenever", NY), /not a schedule/);
	assert.equal(new Date(parseLocal("2026-12-01T09:00", NY)).toISOString(), "2026-12-01T14:00:00.000Z");
});
