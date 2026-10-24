// The cards a bot builds itself with `show {card}` (docs/API.md "Cards"): their model-facing schema and the
// checks behind it. The schema tells the model the shapes; this file's `buildCard` is what enforces them and the
// caps, because over-long text is cut, not refused, and a schema check can only refuse. Every failure is a
// plain sentence the model can act on. The data kept in the card is the checked, trimmed copy, never the raw
// argument.
import { Type } from "@earendil-works/pi-ai";

export const MAX_TITLE = 200;
export const MAX_TEXT = 500;
export const MAX_URL = 2000;
export const MAX_LIST_ITEMS = 50;
export const MAX_FACT_ROWS = 30;
export const MAX_LINKS = 12;

/** The kinds a bot can build. */
export const BUILT_KINDS = ["list", "facts", "links"] as const;
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
		default:
			throw new Error(`Unknown card kind${typeof raw.kind === "string" ? ` "${raw.kind}"` : ""}. Use one of: ${BUILT_KINDS.join(", ")}.`);
	}
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
