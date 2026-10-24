// Cards: a tool's structured result that the owner is shown in the app instead of a wall of text (docs/API.md
// "Cards"). A tool that keeps structured data gives the model a handle for the call; the bot decides what the
// owner sees with the `show` tool (src/tools/cards.ts), which looks the handle up in the chat's transcript, so
// it works after a restart. This file owns the handle, the "cardable" line, narrowing a result to chosen ids,
// and the text stand-in for places that cannot draw a card. A bot's question (`ask`) is a card too, of kind
// "question" (src/core/questions.ts).
import { createHash } from "node:crypto";
import type { EntryRecord } from "../engine/engine.ts";
import { type Answers, ASK_TOOL, type Question } from "./questions.ts";

/** The tool that turns a handle into a card; the one name the text fallbacks look for. */
export const SHOW_TOOL = "show";

export type CardSource = { item: string; name: string; args: Record<string, unknown> };

/**
 * What a successful `show` call keeps in its result's details; the turn item is projected from it. `filtered`: the
 * bot kept only some items (`only`), so counts in `data` describe the whole result, not the card.
 */
export type ResultCard = { kind: "result"; caption: string; source: CardSource; data: unknown; filtered?: true };

/** What an `ask` call keeps (src/tools/ask.ts): its questions and the owner's answers, null when none came. */
export type QuestionCard = { kind: "question"; caption: string; data: { questions: Question[]; answers: Answers | null } };

/** A card a call keeps in its result's details. */
export type CardDetails = ResultCard | QuestionCard;

/** The tools whose successful call is a card item rather than a tool item. */
export const CARD_TOOLS: ReadonlySet<string> = new Set([SHOW_TOOL, ASK_TOOL]);

/**
 * The MCP tools whose results the nHermes app draws as their own card (MacBridge's), by the tool's own name on any
 * server, and the card each becomes. Grows with the app's cards.
 */
export const MCP_CARDS: ReadonlyMap<string, string> = new Map([
	["mac_bridge_status", "MacBridge status"],
	["mac_calendar_list_calendars", "Calendar"],
	["mac_calendar_list_events", "Calendar"],
	["mac_calendar_get_event", "Calendar"],
	["mac_calendar_create_event", "Calendar"],
	["mac_reminders_list_lists", "Reminders"],
	["mac_reminders_list_reminders", "Reminders"],
	["mac_reminders_get_reminder", "Reminders"],
	["mac_reminders_create_reminder", "Reminders"],
	["mac_reminders_complete_reminder", "Reminders"],
	["mac_contacts_search", "Contacts"],
	["mac_contacts_get", "Contacts"],
	["mac_weather_get", "Weather"],
	["mac_maps_search_places", "Places"],
	["mac_maps_travel_time", "Travel time"],
]);

/** The gateway's own tools whose structured results the app draws as their own card. */
export const OWN_CARDS: ReadonlyMap<string, string> = new Map([
	["schedule_list", "Scheduled tasks"],
	["schedule_create", "Scheduled task"],
	["schedule_update", "Scheduled task"],
	["schedule_run", "Scheduled task"],
	["schedule_history", "Scheduled task"],
	["web_fetch", "Page"],
]);

/** The card names a result can have, besides the dedicated ones: the app's fallback by shape. */
export const GENERIC_CARDS = ["List", "Facts"] as const;

/** Most scalar text a Facts value may hold. */
export const FACT_VALUE_MAX = 200;
/** Most keys a Facts object may hold (null values are not counted). */
export const FACTS_MAX_KEYS = 30;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The generic card a structured result has by its shape alone, or null. The nHermes app's fallback follows this
 * exact rule (test/fixtures in both repos keep them together):
 *
 * - **List:** the data is a JSON object with exactly ONE top-level key whose value is an array; other keys may hold
 *   anything. That array has at least 1 element, and every element is an object with a string `id` and a string
 *   `title` or `name`. If any element fails, it is neither List nor Facts, and there is no card. Two or more
 *   array-valued keys means no List.
 * - **Facts:** a JSON object where, after dropping keys whose value is null, 1 to 30 keys remain. Every value is a
 *   string of at most 200 characters, a finite number or a boolean. Anything nested means no card.
 * - **Anything else** (a bare top-level array, an empty object): no card, so no handle.
 */
export function genericCardFor(data: unknown): "List" | "Facts" | null {
	if (!isRecord(data)) return null;
	const values = Object.values(data);
	const arrays = values.filter(Array.isArray);
	if (arrays.length > 1) return null;
	const only = arrays[0];
	if (only) return only.length > 0 && only.every((e) => isRecord(e) && typeof e.id === "string" && (typeof e.title === "string" || typeof e.name === "string")) ? "List" : null;
	const kept = values.filter((v) => v !== null);
	if (kept.length < 1 || kept.length > FACTS_MAX_KEYS) return null;
	return kept.every((v) => (typeof v === "string" && v.length <= FACT_VALUE_MAX) || (typeof v === "number" && Number.isFinite(v)) || typeof v === "boolean") ? "Facts" : null;
}

/**
 * Which card a tool's structured result becomes: the tool's dedicated card (an MCP tool matches by its own name
 * under `mcp__<server>__`), else the generic card of its shape, else null (no handle: the bot writes it in its reply).
 */
export function cardFor(toolName: string, data: unknown): string | null {
	if (data === undefined || data === null) return null;
	let dedicated = OWN_CARDS.get(toolName);
	if (!dedicated && toolName.startsWith("mcp__")) for (const [tool, card] of MCP_CARDS) if (toolName.endsWith(`__${tool}`)) dedicated = card;
	return dedicated ?? genericCardFor(data);
}

/** A server's or tool's structured result is kept with the call for clients (cards), up to this size; the model never sees it. */
export const MAX_STRUCTURED_CHARS = 256 * 1024;

/**
 * The one rule for making a tool result cardable: what to keep in the call's details and the handle line to add
 * after the model's text. Structured data is kept up to 256 KB, whatever the outcome (clients read it from the
 * tool item); the line only when the call did not fail and the result becomes a card (`cardFor`).
 */
export function cardableResult(callId: string, toolName: string, structured: unknown, isError = false): { structured?: unknown; line?: string } {
	if (structured === undefined || JSON.stringify(structured).length > MAX_STRUCTURED_CHARS) return {};
	const card = isError ? null : cardFor(toolName, structured);
	return { structured, ...(card ? { line: cardableLine(callId, card) } : {}) };
}

/** A short name for a tool call that the model can quote: "c" and the first 5 hex characters of the call id's hash. */
export function cardHandle(callId: string): string {
	return `c${createHash("sha256").update(callId).digest("hex").slice(0, 5)}`;
}

/** The line appended to the model's text of a result that can be shown as a card; names the card when it is known. */
export function cardableLine(callId: string, card?: string): string {
	return `(The owner can be shown this as ${card ? `a ${card}` : "a"} card: ${SHOW_TOOL} {from: "${cardHandle(callId)}"})`;
}

/** A card's stand-in where cards are not drawn (push text, job summaries, reports, transcripts). */
export function cardNote(caption: string): string {
	return `[Card: ${caption}]`;
}

/** The notes for the successful `show` calls among a reply's content blocks (the model asked for them in its answer). */
export function cardNotesOf(content: unknown): string[] {
	if (!Array.isArray(content)) return [];
	return content.flatMap((b: { type?: string; name?: string; arguments?: { caption?: unknown } }) =>
		b?.type === "toolCall" && b.name === SHOW_TOOL && typeof b.arguments?.caption === "string" && b.arguments.caption.trim() ? [cardNote(b.arguments.caption.trim())] : [],
	);
}

/** A reply's text followed by the notes of the cards it showed. */
export function withCardNotes(text: string, content: unknown): string {
	return [text, ...cardNotesOf(content)].filter(Boolean).join("\n\n");
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const hasIds = (v: unknown): v is Obj[] => Array.isArray(v) && v.length > 0 && v.every((e) => isObj(e) && typeof e.id === "string");

/** The ids that `only` can pick from: those of the data itself when it is a list, and of each top-level list. */
function idsOf(data: unknown): string[] {
	if (hasIds(data)) return data.map((e) => e.id as string);
	if (isObj(data)) return Object.values(data).flatMap((v) => (hasIds(v) ? v.map((e) => e.id as string) : []));
	return [];
}

/**
 * The data narrowed to the listed ids: every top-level list of objects with string ids (or the data itself, when
 * it is one) keeps only its listed elements. Throws a plain error when nothing is left.
 */
export function narrowCardData(data: unknown, only: readonly string[]): unknown {
	const keep = new Set(only);
	let kept = 0;
	const pick = (list: Obj[]) => {
		const out = list.filter((e) => keep.has(e.id as string));
		kept += out.length;
		return out;
	};
	let out: unknown = data;
	if (hasIds(data)) out = pick(data);
	else if (isObj(data)) out = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, hasIds(v) ? pick(v) : v]));
	if (kept === 0) {
		const have = idsOf(data);
		throw new Error(have.length ? `None of those ids are in the result. It has: ${have.slice(0, 20).join(", ")}${have.length > 20 ? ", …" : ""}.` : "This result has no items with ids to pick from. Show it whole, without \"only\".");
	}
	return out;
}

/** The names of the items a card holds (`title` or `name` of the objects in its lists), for the model's confirmation. */
export function cardItemNames(data: unknown): string[] {
	const lists = Array.isArray(data) ? [data] : isObj(data) ? Object.values(data).filter(Array.isArray) : [];
	return lists.flatMap((l) => (l as unknown[]).flatMap((e) => (isObj(e) ? [e.title, e.name].filter((n): n is string => typeof n === "string" && n.trim() !== "").slice(0, 1) : [])));
}

/** What the model is told after a successful `show`. */
export function shownText(caption: string, data: unknown): string {
	const names = cardItemNames(data);
	const MAX = 8;
	const list = names.length ? ` (${names.slice(0, MAX).join(", ")}${names.length > MAX ? `, and ${names.length - MAX} more` : ""})` : "";
	return `Shown to the owner as a card: ${caption}${list}. They can see it; don't repeat what it shows, add only what the card doesn't say.`;
}

type Msg = { role?: string; content?: unknown; toolCallId?: string; details?: { structured?: unknown } };

/**
 * The tool result in a chat that a handle names, with the call that made it. Throws a plain error for a handle
 * that names nothing, a result without card data, or two results that share the handle.
 */
export function findCardSource(entries: readonly EntryRecord[], handle: string): { source: CardSource; data: unknown } {
	const calls = new Map<string, { name: string; args: Obj }>();
	const hits: { id: string; data: unknown }[] = [];
	let named = 0;
	for (const entry of entries) {
		const m = entry.model?.[0] as Msg | undefined;
		if (!m) continue;
		if (m.role === "assistant" && Array.isArray(m.content)) {
			for (const b of m.content as { type?: string; id?: string; name?: string; arguments?: Obj }[]) if (b.type === "toolCall" && b.id) calls.set(b.id, { name: b.name ?? "tool", args: b.arguments ?? {} });
		} else if (m.role === "toolResult" && m.toolCallId && cardHandle(m.toolCallId) === handle) {
			named++;
			if (m.details?.structured !== undefined) hits.push({ id: m.toolCallId, data: m.details.structured });
		}
	}
	if (named === 0) throw new Error(`No result in this chat has the handle "${handle}". Use a handle from a tool result's "can be shown as a card" line.`);
	if (named > 1) throw new Error(`The handle "${handle}" names more than one result in this chat, so it can't be shown. Call the tool again to get a fresh handle.`);
	const hit = hits[0];
	if (!hit) throw new Error(`The result with the handle "${handle}" has nothing to draw as a card.`);
	const call = calls.get(hit.id);
	return { source: { item: hit.id, name: call?.name ?? "tool", args: call?.args ?? {} }, data: hit.data };
}
