// The weather card a bot builds (src/core/card-kinds.ts): its checks, and times made RFC 3339 with the place's offset.
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCard, MAX_DAYS } from "../../src/core/card-kinds.ts";

const base = { kind: "weather", place: "Lisbon", units: { temperature: "°C" } };

test("a weather card keeps what the app draws, rounds and clamps percentages, orders high and low, and drops what is empty", () => {
	const card = buildCard({
		...base,
		place: "  Lisbon  ",
		units: { temperature: "celsius", windSpeed: "km/h" },
		current: { condition: "Partly Cloudy", temperature: 19.2, humidityPercent: 140, uvIndex: 2.6, wind: { speed: 14, direction: "NW" }, extra: 1 },
		hourly: [],
		daily: [{ date: "2026-10-28", condition: "Rain", high: 13, low: 18, precipitationChancePercent: 69.6 }],
		alerts: [{ summary: "Wind", severity: "Moderate", detailsURL: "" }],
		source: { name: "Open-Meteo", url: "https://example.com/w" },
	});
	assert.deepEqual(card, {
		kind: "weather",
		data: {
			place: "Lisbon",
			units: { temperature: "°C", windSpeed: "km/h" },
			current: { condition: "Partly Cloudy", temperature: 19.2, humidityPercent: 100, uvIndex: 3, wind: { speed: 14, direction: "NW" } },
			daily: [{ date: "2026-10-28", condition: "Rain", high: 18, low: 13, precipitationChancePercent: 70 }],
			alerts: [{ summary: "Wind", severity: "moderate" }],
			source: { name: "Open-Meteo", url: "https://example.com/w" },
		},
	});
	assert.deepEqual(buildCard({ ...base, units: { temperature: "F" }, daily: [{ date: "2026-10-28", condition: "Clear", high: 60, low: 50 }] }).data.units, { temperature: "°F" });
});

test("times are kept as RFC 3339; a local time takes the place's offset on that day, summer or winter", () => {
	const data = buildCard({
		...base,
		timeZone: "Europe/Lisbon",
		current: { condition: "Clear", temperature: 20, time: "2026-07-01T12:00" },
		hourly: [
			{ time: "2026-12-01T09:30", condition: "Fog", temperature: 9 },
			{ time: "2026-12-01T10:00:00-05:00", condition: "Fog", temperature: 9 },
		],
		daily: [{ date: "2026-07-01", condition: "Clear", high: 28, low: 18, sunrise: "2026-07-01T06:15", sunset: "2026-07-01T21:05:30" }],
	}).data as { current: { time: string }; hourly: { time: string }[]; daily: { sunrise: string; sunset: string }[] };
	assert.equal(data.current.time, "2026-07-01T12:00:00+01:00");
	assert.deepEqual(data.hourly.map((h) => h.time), ["2026-12-01T09:30:00+00:00", "2026-12-01T10:00:00-05:00"]);
	assert.deepEqual([data.daily[0]!.sunrise, data.daily[0]!.sunset], ["2026-07-01T06:15:00+01:00", "2026-07-01T21:05:30+01:00"]);
	const ny = buildCard({ ...base, timeZone: "America/New_York", hourly: [{ time: "2026-03-08T12:00", condition: "Clear", temperature: 5 }] }).data as { hourly: { time: string }[] };
	assert.equal(ny.hourly[0]!.time, "2026-03-08T12:00:00-04:00", "the day daylight saving starts");
});

test("a weather card is refused, with what to do, without a place, units, any weather, a real zone, good times or dates, or with too many days", () => {
	const day = { date: "2026-10-28", condition: "Clear", high: 20, low: 10 };
	assert.throws(() => buildCard({ ...base, place: " ", daily: [day] }), /place needs some text/);
	assert.throws(() => buildCard({ ...base, units: { temperature: "K" }, daily: [day] }), /units: \{temperature: "°C" or "°F"\}/);
	assert.throws(() => buildCard({ ...base, units: undefined, daily: [day] }), /units/);
	assert.throws(() => buildCard(base), /needs current, hourly or daily/);
	assert.throws(() => buildCard({ ...base, timeZone: "Mars/Base", daily: [day] }), /not a time zone/);
	assert.throws(() => buildCard({ ...base, hourly: [{ time: "2026-10-28T14:00", condition: "Clear", temperature: 1 }] }), /give timeZone/);
	assert.throws(() => buildCard({ ...base, hourly: [{ time: "at two", condition: "Clear", temperature: 1 }] }), /Hour 1's time must be an RFC 3339 time/);
	assert.throws(() => buildCard({ ...base, daily: [{ ...day, date: "28/10/2026" }] }), /Day 1's date must be YYYY-MM-DD/);
	assert.throws(() => buildCard({ ...base, daily: [{ ...day, high: "warm" }] }), /Day 1's high must be a number/);
	assert.throws(() => buildCard({ ...base, daily: [{ ...day, condition: "" }] }), /Day 1's condition needs some text/);
	assert.throws(() => buildCard({ ...base, current: { condition: "Clear" } }), /current.temperature must be a number/);
	assert.throws(() => buildCard({ ...base, daily: Array.from({ length: MAX_DAYS + 1 }, () => day) }), new RegExp(`at most ${MAX_DAYS} days`));
	assert.throws(() => buildCard({ ...base, daily: [day], alerts: [{ summary: "x", detailsURL: "javascript:alert(1)" }] }), /http or https/);
});
