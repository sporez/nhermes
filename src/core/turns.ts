// A chat as turns: Durable's transcript entries projected into what a client shows (docs/API.md "Turns").
// A turn opens with each owner message and holds the run's items in order: reasoning, reply parts, tool
// calls, errors. The live projection (core/live.ts) names items with the same ids, so a snapshot and the
// live events that follow it describe the same objects:
//   turn       `t<entry id of the user message>`
//   reasoning  `<turn>.<n>r`, reply part `<turn>.<n>t`, failed call `<turn>.<n>e` (n: the turn's nth model reply)
//   tool call  its Durable call id (a successful `show` or `ask` call is a card item with the same id)
//   notice     `n<entry id>` (its own turn, with no user message)
// Text is redacted here, once, for every consumer.
import { basename } from "node:path";
import type { EntryRecord } from "../engine/engine.ts";
import { redact } from "../log.ts";
import { CARD_TOOLS, type CardDetails } from "./cards.ts";
import { textOf, toolPreview } from "./transcript.ts";

export type AttachmentRef = {
	/** Its id in the attachments table; null for uploads from before attachments had ids. */
	id: string | null;
	kind: "image" | "pdf" | "file";
	name: string;
	mime?: string;
	size?: number;
	pages?: number;
	/** Where it is on the gateway (for looking the id up); never sent to clients. */
	path?: string;
};

export type ContentBlock = { type: "text"; text: string } | { type: "attachment"; attachment: AttachmentRef };

export type ToolStatus = "running" | "done" | "failed" | "blocked" | "unknown";

export type TurnItem =
	| { type: "reasoning"; id: string; text: string; at: number }
	| { type: "text"; id: string; text: string; at: number }
	| {
			type: "tool";
			id: string;
			name: string;
			args: Record<string, unknown>;
			preview: string;
			status: ToolStatus;
			startedAt: number | null;
			durationMs: number | null;
			/** The whole result text (callers cap what they send). */
			result: string | null;
			/** Structured data the tool returned beside its text (an MCP server's structuredContent). */
			json?: unknown;
			/** Output streamed while it runs (live only). */
			output?: string;
	  }
	/** What the owner was shown with the `show` tool, or asked with `ask` (core/cards.ts); replaces that call's tool item. */
	| ({ type: "card"; id: string; at: number } & CardDetails)
	| { type: "notice"; id: string; kind: "notice" | "compaction"; text: string; at: number }
	| { type: "error"; id: string; message: string; at: number };

export type TurnStatus = "running" | "complete" | "error" | "interrupted";

export type TurnUsage = { input: number; output: number; cacheRead: number; cacheWrite: number; costUsd: number; calls: number };

export type Turn = {
	id: string;
	status: TurnStatus;
	startedAt: number;
	/** When it ended; null while running, and for turns from before run records were kept. */
	endedAt: number | null;
	user: { content: ContentBlock[]; at: number } | null;
	items: TurnItem[];
	error?: string;
	usage?: TurnUsage;
};

/** How a run ended, recorded as an `nh.run` entry after it (engine.writeRunRecord). */
export type RunRecord = { turn: string; status: Exclude<TurnStatus, "running">; error?: string; endedAt: number };

/** What the live projection holds that the transcript does not have yet: the reply streaming now. */
export type LivePartial = { turnId: string; ordinal: number; text: string; reasoning: string; tools: Map<string, { startedAt: number; output: string }> };

export const turnId = (entryId: number): string => `t${entryId}`;
export const replyItemId = (turn: string, n: number, kind: "r" | "t" | "e"): string => `${turn}.${n}${kind}`;

/** A tool result's status: Durable writes a refused call as `<harness>[error] Tool call blocked: …</harness>`. */
export function toolStatus(text: string, isError: boolean | undefined): ToolStatus {
	if (isError && /^<harness>\s*\[error\] Tool call blocked: /.test(text)) return "blocked";
	return isError ? "failed" : "done";
}

type Block = { type: string; text?: string; thinking?: string; id?: string; name?: string; arguments?: Record<string, unknown> };
type Msg = {
	role: string;
	content: string | Block[];
	timestamp?: number;
	stopReason?: string;
	errorMessage?: string;
	toolCallId?: string;
	isError?: boolean;
	durationMs?: number;
	details?: { structured?: unknown; card?: CardDetails };
	usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; cost?: { total: number } };
};

/**
 * A user message as content blocks: the owner's words, and the attachments the gateway's lines name
 * (src/core/attachments.ts writes `[Image attached at: <path>]`, `[PDF attached at: <path> (…)]` and
 * `@file:uploads/…` references). The rest of the message (attached files' text, pictures) is the model's.
 */
export function userContent(content: string | Block[] | undefined): ContentBlock[] {
	const first = typeof content === "string" ? content : (content?.find((b) => b.type === "text")?.text ?? "");
	const attachments: AttachmentRef[] = [];
	const words = first
		.replace(/^\[Image attached at: (.+)\]$/gm, (_, path: string) => (attachments.push({ id: null, kind: "image", name: basename(path), path }), ""))
		.replace(/^\[PDF attached at: (.+?) \((?:the first )?(\d+)? ?(?:page|its pages).*\)\]$/gm, (_, path: string, pages?: string) => (attachments.push({ id: null, kind: "pdf", name: basename(path), path, ...(pages ? { pages: Number(pages) } : {}) }), ""))
		.replace(/@file:(`uploads\/[^`]+`|"uploads\/[^"]+"|'uploads\/[^']+'|uploads\/\S+)/g, (_, ref: string) => {
			const rel = ref.replace(/^[`"']|[`"']$/g, "");
			attachments.push({ id: null, kind: "file", name: basename(rel), path: rel });
			return "";
		})
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	const blocks: ContentBlock[] = words ? [{ type: "text", text: redact(words) }] : [];
	for (const a of attachments) blocks.push({ type: "attachment", attachment: a });
	return blocks;
}

function usageOf(m: Msg, into: TurnUsage | undefined): TurnUsage | undefined {
	if (!m.usage) return into;
	const u = into ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, calls: 0 };
	u.input += m.usage.input;
	u.output += m.usage.output;
	u.cacheRead += m.usage.cacheRead;
	u.cacheWrite += m.usage.cacheWrite;
	u.costUsd += m.usage.cost?.total ?? 0;
	u.calls++;
	return u;
}

export function redactJson<T>(v: T): T {
	return v === undefined ? v : (JSON.parse(redact(JSON.stringify(v))) as T);
}

/**
 * The turns of a conversation, oldest first. `live`: the conversation is running now; its last turn is
 * running, and the reply streaming now is added from `partial`.
 */
/** The card item of a successful `show` or `ask` call: its id, the result's time, and the card kept in its details. */
export function cardItem(callId: string, at: number, card: CardDetails): Extract<TurnItem, { type: "card" }> {
	if (card.kind === "question") return { type: "card", id: callId, at, kind: card.kind, caption: card.caption, data: card.data };
	return { type: "card", id: callId, at, kind: card.kind, caption: card.caption, source: card.source, data: card.data, ...(card.filtered ? { filtered: true as const } : {}) };
}

export function projectTurns(entries: readonly EntryRecord[], live?: { running: boolean; partial?: LivePartial }): Turn[] {
	const turns: Turn[] = [];
	const records = new Map<string, RunRecord>();
	for (const e of entries) if (e.kind === "nh.run") records.set((e.data as RunRecord).turn, e.data as RunRecord);
	let turn: Turn | undefined;
	let ordinal = 0;
	const tools = new Map<string, Extract<TurnItem, { type: "tool" }>>();
	// A turn's end is known only from its run record: a reply's timestamp is when its generation started.
	const close = () => {
		if (!turn) return;
		const rec = records.get(turn.id);
		if (rec) {
			turn.status = rec.status;
			turn.endedAt = rec.endedAt;
			if (rec.error) turn.error = redact(rec.error);
		}
		for (const item of turn.items) if (item.type === "tool" && item.status === "running") item.status = "unknown";
		turn = undefined;
	};
	for (const entry of entries) {
		if (entry.kind === "pi.compaction" || entry.kind === "nh.notice") {
			const d = (entry.data ?? {}) as { text?: string; at?: string };
			const at = entry.kind === "nh.notice" && d.at ? Number(d.at) * 1000 : (turn?.endedAt ?? turn?.startedAt ?? 0);
			const text = entry.kind === "pi.compaction" ? "Earlier messages were summarized to save context." : (d.text ?? "");
			if (!text) continue;
			close();
			turns.push({ id: `n${entry.id}`, status: "complete", startedAt: at, endedAt: at, user: null, items: [{ type: "notice", id: `n${entry.id}`, kind: entry.kind === "pi.compaction" ? "compaction" : "notice", text: redact(text), at }] });
			continue;
		}
		const m = entry.model?.[0] as Msg | undefined;
		if (!m) continue;
		const at = m.timestamp ?? 0;
		if (m.role === "user") {
			close();
			turn = { id: turnId(entry.id as number), status: "complete", startedAt: at, endedAt: null, user: { content: userContent(m.content), at }, items: [] };
			turns.push(turn);
			ordinal = 0;
			continue;
		}
		if (!turn) continue;
		if (m.role === "assistant") {
			ordinal++;
			turn.usage = usageOf(m, turn.usage);
			const blocks = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content;
			const thought = blocks.filter((b) => b.type === "thinking").map((b) => b.thinking ?? "").filter(Boolean).join("\n");
			if (thought) turn.items.push({ type: "reasoning", id: replyItemId(turn.id, ordinal, "r"), text: redact(thought), at });
			const text = textOf(m.content);
			if (text) turn.items.push({ type: "text", id: replyItemId(turn.id, ordinal, "t"), text: redact(text), at });
			if (m.stopReason === "error") {
				const message = redact(m.errorMessage ?? "The model request failed.");
				turn.items.push({ type: "error", id: replyItemId(turn.id, ordinal, "e"), message, at });
				turn.status = "error";
				turn.error = message;
			} else if (m.stopReason === "aborted") turn.status = "interrupted";
			for (const b of blocks) {
				if (b.type !== "toolCall" || !b.id) continue;
				const item: Extract<TurnItem, { type: "tool" }> = { type: "tool", id: b.id, name: b.name ?? "tool", args: redactJson(b.arguments ?? {}), preview: redact(toolPreview(b.arguments)), status: "running", startedAt: null, durationMs: null, result: null };
				tools.set(b.id, item);
				turn.items.push(item);
			}
		} else if (m.role === "toolResult") {
			const item = tools.get(m.toolCallId ?? "");
			if (!item) continue;
			const text = textOf(m.content);
			if (CARD_TOOLS.has(item.name) && !m.isError && m.details?.card) {
				const at = m.timestamp ?? 0;
				const i = turn.items.indexOf(item);
				if (i >= 0) turn.items[i] = cardItem(item.id, at, redactJson(m.details.card));
				tools.delete(item.id);
				continue;
			}
			item.result = redact(text);
			item.durationMs = m.durationMs ?? null;
			item.startedAt = m.durationMs !== undefined && m.timestamp !== undefined ? m.timestamp - m.durationMs : (m.timestamp ?? null);
			item.status = toolStatus(text, m.isError);
			if (m.details?.structured !== undefined) item.json = redactJson(m.details.structured);
		}
	}
	if (live?.running && turn) {
		const open = turn;
		open.status = "running";
		open.endedAt = null;
		const p = live.partial;
		if (p && p.turnId === open.id) {
			if (p.reasoning) open.items.push({ type: "reasoning", id: replyItemId(open.id, p.ordinal, "r"), text: redact(p.reasoning), at: Date.now() });
			if (p.text) open.items.push({ type: "text", id: replyItemId(open.id, p.ordinal, "t"), text: redact(p.text), at: Date.now() });
			for (const [id, t] of p.tools) {
				const item = tools.get(id);
				if (item && item.status === "running") {
					item.startedAt = t.startedAt;
					if (t.output) item.output = redact(t.output);
				}
			}
		}
	} else close();
	// A `show` or `ask` call still running is not announced: it appears as its card, or as a failed call, when it
	// ends. A question waiting for its answer is the pending request (docs/API.md "Questions").
	for (const t of turns) t.items = t.items.filter((i) => !(i.type === "tool" && CARD_TOOLS.has(i.name) && i.status === "running"));
	return turns;
}
