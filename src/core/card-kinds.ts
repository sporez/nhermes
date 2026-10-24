// The cards a bot builds itself with `show {card}` (docs/API.md "Cards"): their model-facing schema and the
// checks behind it. The schema tells the model the shapes; this file's `buildCard` is what enforces them and the
// caps, because over-long text is cut, not refused, and a schema check can only refuse. Every failure is a
// plain sentence the model can act on. The data kept in the card is the checked, trimmed copy, never the raw
// argument.
import { Type } from "@earendil-works/pi-ai";
import { drawsAnything, MAX_HTML_BYTES, sanitizeHtml } from "./html-card.ts";

export const MAX_TITLE = 200;
export const MAX_TEXT = 500;
export const MAX_URL = 2000;
export const MAX_LIST_ITEMS = 50;
export const MAX_FACT_ROWS = 30;
export const MAX_LINKS = 12;
export const MAX_SERIES = 6;
export const MAX_POINTS = 300;
export const CHART_TYPES = ["bar", "line", "area", "point", "pie"] as const;
export const X_KINDS = ["category", "date", "number"] as const;

/** The kinds a bot can build. */
export const BUILT_KINDS = ["list", "facts", "links", "chart", "html"] as const;
export type BuiltKind = (typeof BUILT_KINDS)[number];

const str = (description: string) => Type.String({ description });
const opt = (description: string) => Type.Optional(Type.String({ description }));

export const CARD_SCHEMA = Type.Union([
	Type.Object(
		{
			kind: Type.Literal("list"),
			title: str("What the list is"),
			subtitle: opt("A line under the title"),
			items: Type.Array(Type.Object({ title: str("The item"), detail: opt("A line more"), url: opt("An http(s) link"), done: Type.Optional(Type.Boolean({ description: "Shows a check mark when true, an empty box when false; leave out for a plain list" })) }), { description: `Up to ${MAX_LIST_ITEMS} items` }),
		},
		{ description: "A short list from anywhere: steps, packages to update, things to buy" },
	),
	Type.Object(
		{
			kind: Type.Literal("facts"),
			title: str("What these facts are about"),
			subtitle: opt("A line under the title"),
			rows: Type.Array(Type.Object({ label: str("The name"), value: str("The value") }), { description: `Up to ${MAX_FACT_ROWS} rows` }),
		},
		{ description: "A status or summary: a server's health, an order's state" },
	),
	Type.Object(
		{
			kind: Type.Literal("links"),
			title: str("What the links are"),
			items: Type.Array(Type.Object({ url: str("An http(s) address"), title: str("The page's name"), note: opt("A line about it") }), { description: `Up to ${MAX_LINKS} links` }),
		},
		{ description: "Search results, sources, pages to read" },
	),
	Type.Object(
		{
			kind: Type.Literal("chart"),
			title: str("What the chart shows"),
			subtitle: opt("A line under the title"),
			type: Type.Union(CHART_TYPES.map((t) => Type.Literal(t)), { description: "bar, line, area, point or pie (a pie takes one series)" }),
			x: Type.Object({ label: opt("The x axis' name"), kind: Type.Union(X_KINDS.map((t) => Type.Literal(t)), { description: "category: names; date: YYYY-MM-DD or RFC 3339; number" }) }),
			y: Type.Optional(Type.Object({ label: opt("The y axis' name"), unit: opt("For example USD, kg, %") })),
			series: Type.Array(Type.Object({ name: str("The series' name"), points: Type.Array(Type.Object({ x: Type.Union([Type.String(), Type.Number()], { description: "Matches x.kind: a name, a date, or a number" }), y: Type.Number() })) }), {
				description: `Up to ${MAX_SERIES} series and ${MAX_POINTS} points in all`,
			}),
			notes: opt("A line of caveats or the source"),
		},
		{ description: "Numbers that compare or change over time. Prefer it to html for anything that is numbers" },
	),
	Type.Object(
		{
			kind: Type.Literal("html"),
			title: opt("A heading for the card"),
			html: str("An HTML fragment (no html or head) with inline <style> and inline <svg>; no scripts, forms or network. Style it with the CSS variables --nh-canvas --nh-surface --nh-text --nh-secondary --nh-accent --nh-stroke so it matches the app in light and dark"),
			aspect: Type.Optional(Type.Number({ description: "Width divided by height, as a starting shape while it lays out" })),
		},
		{ description: "Last resort, for a diagram, timeline or layout no other kind fits (not for numbers: use chart)" },
	),
]);

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** Trimmed text of at most `max` characters (cut with an ellipsis), or undefined when empty or not text. */
function text(v: unknown, max: number): string | undefined {
	if (typeof v !== "string") return undefined;
	const t = v.replace(/\s+/g, " ").trim();
	if (!t) return undefined;
	return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function required(v: unknown, max: number, where: string): string {
	const t = text(v, max);
	if (t === undefined) throw new Error(`${where} needs some text.`);
	return t;
}

/** An http(s) address as written, or a plain error. */
function url(v: unknown, where: string): string {
	const s = typeof v === "string" ? v.trim() : "";
	let ok = false;
	try {
		const u = new URL(s);
		ok = (u.protocol === "http:" || u.protocol === "https:") && s.length <= MAX_URL;
	} catch {
		// Not an address.
	}
	if (!ok) throw new Error(`${where} must be an http or https address (at most ${MAX_URL} characters).`);
	return s;
}

function items(v: unknown, kind: string, max: number): Obj[] {
	if (!Array.isArray(v) || v.length === 0 || !v.every(isObj)) throw new Error(`A ${kind} card needs "${kind === "facts" ? "rows" : "items"}": a list of objects, at least one.`);
	if (v.length > max) throw new Error(`A ${kind} card holds at most ${max} ${kind === "facts" ? "rows" : "items"}; you gave ${v.length}. Keep the most useful ones.`);
	return v as Obj[];
}

/**
 * The checked data of a card the bot built, and the kind it is. Cuts over-long text; refuses (plain error) a wrong
 * shape, a missing title, too many items and an address that is not http(s). The data does not repeat the kind.
 */
export function buildCard(raw: unknown): { kind: BuiltKind; data: Obj } {
	if (!isObj(raw)) throw new Error(`card must be an object with a kind: ${BUILT_KINDS.join(", ")}.`);
	if (raw.kind === "html") return buildHtml(raw);
	const title = required(raw.title, MAX_TITLE, "The card's title");
	const subtitle = text(raw.subtitle, MAX_TEXT);
	const head = { title, ...(subtitle ? { subtitle } : {}) };
	switch (raw.kind) {
		case "list":
			return {
				kind: "list",
				data: {
					...head,
					items: items(raw.items, "list", MAX_LIST_ITEMS).map((it, i) => {
						const detail = text(it.detail, MAX_TEXT);
						return {
							title: required(it.title, MAX_TITLE, `List item ${i + 1}`),
							...(detail ? { detail } : {}),
							...(it.url === undefined || it.url === "" ? {} : { url: url(it.url, `The link of list item ${i + 1}`) }),
							...(typeof it.done === "boolean" ? { done: it.done } : {}),
						};
					}),
				},
			};
		case "facts":
			return {
				kind: "facts",
				data: { ...head, rows: items(raw.rows, "facts", MAX_FACT_ROWS).map((r, i) => ({ label: required(r.label, MAX_TITLE, `Row ${i + 1}'s label`), value: required(r.value, MAX_TEXT, `Row ${i + 1}'s value`) })) },
			};
		case "links":
			return {
				kind: "links",
				data: {
					title,
					items: items(raw.items, "links", MAX_LINKS).map((it, i) => {
						const note = text(it.note, MAX_TEXT);
						return { url: url(it.url, `Link ${i + 1}'s address`), title: required(it.title, MAX_TITLE, `Link ${i + 1}'s title`), ...(note ? { note } : {}) };
					}),
				},
			};
		case "chart":
			return { kind: "chart", data: buildChart(raw, head) };
		default:
			throw new Error(`Unknown card kind${typeof raw.kind === "string" ? ` "${raw.kind}"` : ""}. Use one of: ${BUILT_KINDS.join(", ")}.`);
	}
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const RFC3339 = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

function oneOf<T extends string>(v: unknown, allowed: readonly T[], where: string): T {
	if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) throw new Error(`${where} must be one of: ${allowed.join(", ")}.`);
	return v as T;
}

function buildChart(raw: Obj, head: Obj): Obj {
	const type = oneOf(raw.type, CHART_TYPES, "The chart's type");
	if (!isObj(raw.x)) throw new Error(`A chart needs x: {kind: ${X_KINDS.join(" | ")}, label?}.`);
	const xKind = oneOf(raw.x.kind, X_KINDS, "x.kind");
	const xLabel = text(raw.x.label, MAX_TITLE);
	const yIn = isObj(raw.y) ? raw.y : {};
	const yLabel = text(yIn.label, MAX_TITLE);
	const unit = text(yIn.unit, MAX_TITLE);
	const seriesIn = raw.series;
	if (!Array.isArray(seriesIn) || seriesIn.length === 0 || !seriesIn.every(isObj)) throw new Error("A chart needs series: a list of {name, points: [{x, y}]}, at least one.");
	if (seriesIn.length > MAX_SERIES) throw new Error(`A chart holds at most ${MAX_SERIES} series; you gave ${seriesIn.length}.`);
	if (type === "pie" && seriesIn.length !== 1) throw new Error("A pie chart takes exactly one series: one slice per point.");
	let total = 0;
	const series = seriesIn.map((s, si) => {
		const where = `Series ${si + 1}`;
		if (!Array.isArray(s.points) || s.points.length === 0 || !s.points.every(isObj)) throw new Error(`${where} needs points: a list of {x, y}, at least one.`);
		total += s.points.length;
		if (total > MAX_POINTS) throw new Error(`A chart holds at most ${MAX_POINTS} points in all. Show fewer, for example by grouping.`);
		return {
			name: required(s.name, MAX_TITLE, `${where}'s name`),
			points: (s.points as Obj[]).map((p, pi) => {
				const at = `${where}, point ${pi + 1}`;
				if (!finite(p.y)) throw new Error(`${at}: y must be a finite number.`);
				let x: string | number;
				if (xKind === "number") {
					if (!finite(p.x)) throw new Error(`${at}: x must be a finite number (x.kind is number).`);
					x = p.x;
				} else if (xKind === "date") {
					if (typeof p.x !== "string" || !(DATE.test(p.x) || RFC3339.test(p.x)) || !Number.isFinite(Date.parse(p.x))) throw new Error(`${at}: x must be a date as YYYY-MM-DD or RFC 3339 (x.kind is date).`);
					x = p.x;
				} else {
					x = required(p.x, MAX_TITLE, `${at}: x`);
				}
				return { x, y: p.y };
			}),
		};
	});
	const notes = text(raw.notes, MAX_TEXT);
	return { ...head, type, x: { ...(xLabel ? { label: xLabel } : {}), kind: xKind }, y: { ...(yLabel ? { label: yLabel } : {}), ...(unit ? { unit } : {}) }, series, ...(notes ? { notes } : {}) };
}

function buildHtml(raw: Obj): { kind: "html"; data: Obj } {
	if (typeof raw.html !== "string" || !raw.html.trim()) throw new Error("An html card needs html: a fragment to draw.");
	if (Buffer.byteLength(raw.html) > MAX_HTML_BYTES) throw new Error(`The html is over ${MAX_HTML_BYTES / 1024} KB. Make the layout smaller.`);
	const html = sanitizeHtml(raw.html).trim();
	if (!drawsAnything(html)) throw new Error("Nothing is left of the html after removing what an html card can't hold (scripts, frames, forms, remote content). Write a layout with text or inline SVG.");
	const title = text(raw.title, MAX_TITLE);
	const aspect = finite(raw.aspect) && raw.aspect > 0 ? Math.min(5, Math.max(0.2, raw.aspect)) : undefined;
	return { kind: "html", data: { ...(title ? { title } : {}), html, ...(aspect ? { aspect } : {}) } };
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/** The item titles of a built list or links card, normalized for comparing with a result's. */
export function builtTitles(data: Obj): string[] {
	return Array.isArray(data.items) ? (data.items as Obj[]).flatMap((i) => (typeof i.title === "string" ? [norm(i.title)] : [])) : [];
}

/** How many of a card's titles appear among a result's item names (both normalized). */
export function titlesRepeated(cardTitles: readonly string[], resultNames: readonly string[]): number {
	const have = new Set(resultNames.map(norm));
	return cardTitles.filter((t) => have.has(t)).length;
}
