// Wire shapes of the chat resources (docs/API.md "Bots", "Sessions", "Turns", "Approvals"): one serializer
// per resource, used by lists, gets, events and snapshots alike. Times leave here as Unix milliseconds.
import type { Core } from "../../app.ts";
import type { Bot } from "../../core/bots.ts";
import type { ApprovalRequest, UsageSummary } from "../../core/events.ts";
import type { SessionRow } from "../../core/sessions.ts";
import { type ContentBlock, redactJson, type Turn, type TurnItem } from "../../core/turns.ts";
import { redact } from "../../log.ts";
import { LIMITS } from "../ops/gateway.ts";

/** Structured tool results bigger than this are left out (the text still arrives). */
const MAX_JSON_CHARS = 256 * 1024;

const ms = (seconds: number | null | undefined): number | null => (seconds ? Math.round(seconds * 1000) : null);

export function botJson(core: Core, bot: Bot) {
	const local = !bot.remote && !bot.isPeer;
	return {
		id: bot.name,
		name: bot.remote?.bot ?? bot.name,
		displayName: bot.remote ? (bot.config.displayName ?? bot.displayName) : bot.displayName,
		description: bot.description,
		isDefault: bot.isDefault,
		kind: bot.remote ? "member" : bot.isPeer ? "peer" : "local",
		node: bot.remote ? { id: bot.remote.nodeId, name: bot.remote.node, online: bot.remote.reachable } : null,
		model: { provider: bot.model.provider, id: bot.model.modelId },
		thinking: bot.thinking,
		approvals: { mode: bot.approvals.mode },
		toolGroups: local ? bot.toolGroups : [],
		skillCount: local ? core.skills.catalog(bot).filter((s) => s.active).length : 0,
		private: bot.private,
		trusted: bot.trusted,
		avatar: null,
	};
}

export async function sessionJson(core: Core, row: SessionRow) {
	const bot = core.bots.get(row.bot);
	let model = bot ? { provider: bot.model.provider, id: bot.model.modelId } : null;
	let thinking = bot?.thinking ?? null;
	// A chat that chose its own model or reasoning keeps it; the others follow their bot.
	if (!row.remote_node && (row.model_override || row.thinking_override)) {
		const agent = await core.engine.agentModel(row.conversation_id);
		if (row.model_override && agent.model) model = { provider: agent.model.provider, id: agent.model.modelId };
		if (row.thinking_override) thinking = agent.thinking as typeof thinking;
	}
	return {
		id: row.id,
		botId: row.bot,
		kind: row.kind,
		title: redact(row.title),
		preview: redact(row.preview),
		source: row.source,
		createdAt: ms(row.created_at),
		lastActiveAt: ms(row.last_active),
		messageCount: row.message_count,
		running: core.sessions.isRunning(row.id),
		archived: row.archived === 1,
		pinned: row.pinned === 1,
		model,
		thinking,
		yolo: core.approvals.isYolo(row.id),
		approvalMode: bot?.approvals.mode ?? null,
		approvalsWaiting: core.approvals.pendingFor(row.id).length,
		parentId: row.parent_id,
		jobId: row.job_id,
	};
}

function contentJson(blocks: ContentBlock[]) {
	return blocks.map((b) => {
		if (b.type !== "attachment") return b;
		const { path: _path, ...attachment } = b.attachment;
		return { type: "attachment", attachment };
	});
}

export function itemJson(item: TurnItem) {
	if (item.type !== "tool") return item;
	const { result, json, ...rest } = item;
	const max = LIMITS.toolResultChars;
	const out: Record<string, unknown> = {
		...rest,
		isError: item.status === "failed" || item.status === "blocked",
		result: result === null ? null : { text: result.length > max ? result.slice(0, max) : result, truncated: result.length > max, length: result.length },
	};
	if (json !== undefined) {
		const size = JSON.stringify(json).length;
		if (size <= MAX_JSON_CHARS && out.result) (out.result as Record<string, unknown>).json = json;
	}
	return out;
}

export function turnJson(turn: Turn) {
	return { ...turn, user: turn.user ? { ...turn.user, content: contentJson(turn.user.content) } : null, items: turn.items.map(itemJson) };
}

/** A request waiting for the owner: an approval (`kind: "approval"`) or a bot's question (`kind: "question"`). */
export function approvalJson(r: ApprovalRequest) {
	const common = {
		id: r.requestId,
		sessionId: r.sessionId,
		botId: r.bot,
		kind: r.kind,
		toolName: r.toolName,
		description: redact(r.description),
		choices: r.choices,
		createdAt: ms(r.createdAt),
		toolCallId: r.toolCallId ?? null,
		callSessionId: r.callSessionId ?? null,
	};
	if (r.kind === "question") return { ...common, caption: redact(r.caption), questions: redactJson(r.questions) };
	return { ...common, command: redact(r.command), patternKey: r.patternKey };
}

export function usageJson(u: UsageSummary) {
	return {
		model: u.model,
		input: u.input,
		output: u.output,
		reasoning: u.reasoning,
		cacheRead: u.cacheRead,
		cacheWrite: u.cacheWrite,
		total: u.total,
		calls: u.calls,
		contextUsed: u.contextUsed,
		contextMax: u.contextMax,
		contextPercent: u.contextMax > 0 ? Math.min(100, Math.round((u.contextUsed / u.contextMax) * 100)) : 0,
		costUsd: Math.round(u.costUsd * 10000) / 10000,
	};
}
