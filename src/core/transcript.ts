// Projects Durable transcript entries into the row shape Hermes clients render
// (`session_history._project_history`: role, text, timestamp, row_id, name, context, reasoning).
import { basename } from "node:path";
import type { EntryRecord } from "../engine/engine.ts";
import { redact } from "../log.ts";

export type TranscriptRow = {
	role: "user" | "assistant" | "tool" | "system";
	text: string;
	timestamp: number;
	row_id: number;
	name?: string;
	context?: string;
	reasoning?: string;
	finish_reason?: string;
	has_tool_calls?: boolean;
};

type Block = { type: string; text?: string; thinking?: string; id?: string; name?: string; arguments?: Record<string, unknown> };
type Msg = { role: string; content: string | Block[]; timestamp?: number; stopReason?: string; errorMessage?: string; toolCallId?: string; toolName?: string; isError?: boolean };

export const TOOL_RESULT_PREVIEW = 2000;

/** The call's main argument on one line, at most 80 characters (agent/display.py preview). */
export function toolPreview(args: Record<string, unknown> | undefined): string {
	if (!args) return "";
	for (const k of ["command", "path", "url", "query", "selector", "text", "task", "name"]) {
		const v = args[k];
		if (typeof v === "string" && v.trim()) return v.split(/\s+/).join(" ").slice(0, 80);
	}
	return "";
}

export function textOf(content: string | Block[] | undefined): string {
	if (content === undefined) return "";
	if (typeof content === "string") return content;
	return content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
}

function thinkingOf(content: string | Block[]): string {
	if (typeof content === "string") return "";
	return content.filter((b) => b.type === "thinking").map((b) => b.thinking ?? "").join("\n");
}

/**
 * A user message as clients show it. A prompt with attachments (src/core/attachments.ts) is the words with
 * a line per picture or PDF, then the attached files' text for the model only: shown are the first block,
 * with each picture as Vory's `[User attached image: <name>]` and each PDF as `📎 <name>`.
 */
export function userDisplay(content: string | Block[] | undefined): string {
	if (content === undefined || typeof content === "string") return content ?? "";
	const first = content.find((b) => b.type === "text")?.text ?? "";
	if (!content.some((b) => b.type === "image") && content.filter((b) => b.type === "text").length < 2) return first;
	return first
		.replace(/^\[Image attached at: (.+)\]$/gm, (_, path: string) => `[User attached image: ${basename(path)}]`)
		.replace(/^\[PDF attached at: (.+?) \(.*\)\]$/gm, (_, path: string) => `📎 ${basename(path)}`);
}

/** The words of a shown user message without its picture marks, for titles and previews ("Picture" when that is all). */
export function userPlain(display: string): string {
	const words = display.replace(/\s*\[User attached image: [^\]]+\]/g, "").trim();
	if (words || !display.includes("[User attached image:")) return words;
	return (display.match(/\[User attached image:/g)?.length ?? 0) > 1 ? "Pictures" : "Picture";
}


export function projectTranscript(entries: readonly EntryRecord[]): TranscriptRow[] {
	return projectRaw(entries).map((r) => ({
		...r,
		text: redact(r.text),
		...(r.context !== undefined ? { context: redact(r.context) } : {}),
		...(r.reasoning !== undefined ? { reasoning: redact(r.reasoning) } : {}),
	}));
}

function projectRaw(entries: readonly EntryRecord[]): TranscriptRow[] {
	const rows: TranscriptRow[] = [];
	const calls = new Map<string, { name: string; args: Record<string, unknown> }>();
	let ordinal = 0;
	for (const entry of entries) {
		ordinal++;
		const msg = entry.model?.[0] as Msg | undefined;
		if (entry.kind === "pi.compaction") {
			rows.push({ role: "system", text: "Earlier messages were summarized to save context.", timestamp: Date.now() / 1000, row_id: ordinal });
			continue;
		}
		if (entry.kind === "nh.notice") {
			const d = (entry.data ?? {}) as { text?: string; at?: string };
			if (d.text) rows.push({ role: "system", text: d.text, timestamp: d.at ? Number(d.at) : Date.now() / 1000, row_id: ordinal });
			continue;
		}
		if (!msg) continue;
		const ts = (msg.timestamp ?? Date.now()) / 1000;
		if (msg.role === "user") {
			const text = userDisplay(msg.content);
			if (text) rows.push({ role: "user", text, timestamp: ts, row_id: ordinal });
		} else if (msg.role === "assistant") {
			const blocks = typeof msg.content === "string" ? [] : msg.content;
			const toolCalls = blocks.filter((b) => b.type === "toolCall");
			for (const tc of toolCalls) calls.set(tc.id ?? "", { name: tc.name ?? "tool", args: tc.arguments ?? {} });
			const text = textOf(msg.content);
			const reasoning = thinkingOf(msg.content);
			if (msg.stopReason === "error" && !text) {
				rows.push({ role: "system", text: `Error: ${msg.errorMessage ?? "model request failed"}`, timestamp: ts, row_id: ordinal });
				continue;
			}
			if (!text && !reasoning) continue;
			const row: TranscriptRow = { role: "assistant", text, timestamp: ts, row_id: ordinal };
			if (reasoning) row.reasoning = reasoning;
			if (toolCalls.length > 0) row.has_tool_calls = true;
			row.finish_reason = msg.stopReason === "toolUse" ? "tool_calls" : msg.stopReason === "length" ? "length" : "stop";
			rows.push(row);
		} else if (msg.role === "toolResult") {
			const call = calls.get(msg.toolCallId ?? "");
			const name = call?.name ?? msg.toolName ?? "tool";
			const text = textOf(msg.content).slice(0, TOOL_RESULT_PREVIEW);
			rows.push({ role: "tool", name, context: toolPreview(call?.args), text, timestamp: ts, row_id: ordinal });
		}
	}
	return rows;
}
