// Cards: a tool's structured result that the owner is shown in the app instead of a wall of text (docs/API.md
// "Cards"). A tool that keeps structured data gives the model a handle for the call; the bot decides what the
// owner sees with the `show` tool (src/tools/cards.ts), which looks the handle up in the chat's transcript, so
// it works after a restart. This file owns the handle, the "cardable" line, narrowing a result to chosen ids,
// and the text stand-in for places that cannot draw a card.
import { createHash } from "node:crypto";
import type { EntryRecord } from "../engine/engine.ts";

/** The tool that turns a handle into a card; the one name the text fallbacks look for. */
export const SHOW_TOOL = "show";

export type CardSource = { item: string; name: string; args: Record<string, unknown> };

/** What a successful `show` call keeps in its result's details; the turn item is projected from it. */
export type CardDetails = { kind: "result"; caption: string; source: CardSource; data: unknown };

/** A short name for a tool call that the model can quote: "c" and the first 5 hex characters of the call id's hash. */
export function cardHandle(callId: string): string {
	return `c${createHash("sha256").update(callId).digest("hex").slice(0, 5)}`;
}

/** The line appended to the model's text of a result that can be shown as a card. */
export function cardableLine(callId: string): string {
	return `(The owner can be shown this as a card: ${SHOW_TOOL} {from: "${cardHandle(callId)}"})`;
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
