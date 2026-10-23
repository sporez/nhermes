// Approval broker: holds what needs the owner's answer until a client answers, the turn is interrupted, or the
// timeout passes. A request is a tool call waiting for approval (asked from the Durable `beforeTool` hook,
// before the call's intent is recorded) or a bot's question (asked from its `ask` tool, src/tools/ask.ts, which
// is replay-safe). Either way, if the process dies while it waits, Durable runs the step again after restart and
// it is asked again. An approval nobody answers is denied (fails closed); a question nobody answers ends unanswered.
import { randomUUID } from "node:crypto";
import type { AppDb } from "../store/db.ts";
import { redact } from "../log.ts";
import type { ApprovalRequest, CommandApproval, Hub, QuestionRequest } from "./events.ts";
import { type Answers, checkAnswers, checkQuestions, type Question, type QuestionOutcome, replyAnswers } from "./questions.ts";

export type Choice = "once" | "session" | "always" | "deny";

/** A request another machine raised (docs/API.md "Approvals"), as this gateway asks it again. */
export type ForwardedRequest = { toolName: string; command: string; description: string; patternKey: string; question?: { caption: string; questions: Question[] } };
/** What goes back to `approvals.answer` there. */
export type ForwardedAnswer = { choice: string; values?: Answers };

/** A request from another machine's `approval.requested` event. */
export function forwardedRequest(a: Record<string, unknown>): ForwardedRequest {
	const str = (v: unknown, d: string) => (typeof v === "string" ? v : d);
	const question = a.kind === "question" && Array.isArray(a.questions) ? { caption: str(a.caption, str(a.description, "A question")), questions: a.questions as Question[] } : undefined;
	return { toolName: str(a.toolName, "tool"), command: str(a.command, ""), description: str(a.description, "needs approval"), patternKey: str(a.patternKey, ""), ...(question ? { question } : {}) };
}
const CHOICES: readonly string[] = ["once", "session", "always", "deny"];

type Reason = "answered" | "timeout" | "cancelled";
type Resolution = { choice: string; reason: Reason; values?: Answers };
type Pending = { request: ApprovalRequest; finish: (r: Resolution) => void; timer: NodeJS.Timeout };

type ApprovalInput = Omit<CommandApproval, "kind" | "requestId" | "createdAt" | "choices"> & { noAlways?: boolean; onceOnly?: boolean };
type QuestionInput = Omit<QuestionRequest, "kind" | "requestId" | "createdAt" | "choices" | "toolName" | "description"> & {
	toolName?: string;
	description?: string;
	/** How long it waits; the gateway's question timeout when absent. */
	timeoutMs?: number;
};

export class Approvals {
	private readonly pending = new Map<string, Pending>();
	private readonly hub: Hub;
	private readonly db: AppDb;
	private readonly timeoutMs: number;
	private readonly questionTimeoutMs: () => number;
	/** Sessions with per-session YOLO on (memory only: it resets when the gateway restarts). */
	private readonly yolo = new Set<string>();

	constructor(hub: Hub, db: AppDb, timeoutMs: number, questionTimeoutMs: () => number = () => 86_400_000) {
		this.hub = hub;
		this.db = db;
		this.timeoutMs = timeoutMs;
		this.questionTimeoutMs = questionTimeoutMs;
	}

	setYolo(sessionId: string, on: boolean): void {
		if (on) this.yolo.add(sessionId);
		else this.yolo.delete(sessionId);
	}

	isYolo(sessionId: string): boolean {
		return this.yolo.has(sessionId);
	}

	rules(scope: string): string[] {
		return this.db.all<{ rule: string }>("SELECT rule FROM approval_rules WHERE scope = ?", scope).map((r) => r.rule);
	}

	addRule(scope: string, rule: string): void {
		this.db.run("INSERT OR IGNORE INTO approval_rules (scope, rule, created_at) VALUES (?, ?, ?)", scope, rule, Date.now() / 1000);
	}

	removeRule(scope: string, rule: string): void {
		this.db.run("DELETE FROM approval_rules WHERE scope = ? AND rule = ?", scope, rule);
	}

	/** Waits for an approval. Rejects never; aborting resolves "deny". */
	ask(input: ApprovalInput, signal: AbortSignal): Promise<Choice> {
		const { noAlways, onceOnly, ...rest } = input;
		const choices: Choice[] = onceOnly ? ["once", "deny"] : noAlways ? ["once", "session", "deny"] : ["once", "session", "always", "deny"];
		const request: CommandApproval = { ...rest, kind: "approval", requestId: newId(), createdAt: Date.now() / 1000, choices };
		return this.hold(request, this.timeoutMs, signal, "deny", (r) => {
			const choice = r.choice as Choice;
			if (choice === "session") this.addRule(`session:${request.sessionId}`, request.patternKey);
			if (choice === "always") this.addRule(`bot:${request.bot}`, request.patternKey);
			return choice;
		});
	}

	/** Waits for the owner's answer to a bot's questions. Rejects never; aborting ends it unanswered. */
	question(input: QuestionInput, signal: AbortSignal): Promise<QuestionOutcome> {
		const { timeoutMs, ...rest } = input;
		const request: QuestionRequest = { toolName: "ask", description: rest.caption, ...rest, kind: "question", requestId: newId(), createdAt: Date.now() / 1000, choices: ["answer", "dismiss"] };
		return this.hold(request, timeoutMs ?? this.questionTimeoutMs(), signal, "dismiss", (r): QuestionOutcome => {
			if (r.choice === "answer" && r.values) return { answered: true, values: r.values };
			return { answered: false, reason: r.reason === "answered" ? "dismissed" : r.reason };
		});
	}

	private hold<T>(request: ApprovalRequest, timeoutMs: number, signal: AbortSignal, fallback: string, settle: (r: Resolution) => T): Promise<T> {
		this.audit(request, "asked");
		return new Promise<T>((resolve) => {
			const finish = (r: Resolution) => {
				const p = this.pending.get(request.requestId);
				if (!p) return;
				clearTimeout(p.timer);
				this.pending.delete(request.requestId);
				signal.removeEventListener("abort", onAbort);
				const out = settle(r);
				this.audit(request, `${r.reason}:${r.choice}`);
				this.hub.publish(request.sessionId, { type: "approval.resolved", requestId: request.requestId, choice: r.choice, reason: r.reason });
				resolve(out);
			};
			const onAbort = () => finish({ choice: fallback, reason: "cancelled" });
			const timer = setTimeout(() => finish({ choice: fallback, reason: "timeout" }), timeoutMs);
			this.pending.set(request.requestId, { request, finish, timer });
			if (signal.aborted) return onAbort();
			signal.addEventListener("abort", onAbort, { once: true });
			this.hub.publish(request.sessionId, { type: "approval.requested", request });
		});
	}

	/**
	 * Answer one request; returns false when it is no longer waiting. A question takes `answer` with its values
	 * (checked against its questions; a wrong shape throws a plain error) or `dismiss`; an approval takes a choice.
	 */
	answer(requestId: string, choice: string, values?: unknown): boolean {
		const p = this.pending.get(requestId);
		if (!p) return false;
		const r = p.request;
		if (r.kind === "question") {
			if (choice === "dismiss" || choice === "deny") p.finish({ choice: "dismiss", reason: "answered" });
			else if (choice === "answer") p.finish({ choice: "answer", reason: "answered", values: checkAnswers(r.questions, values) });
			else throw new Error(`A question is answered with "answer" and its values, or "dismiss".`);
			return true;
		}
		if (!CHOICES.includes(choice)) throw new Error(`An approval is answered with one of: ${r.choices.join(", ")}.`);
		// An answer the card did not offer ("always" for a config change) counts as the nearest one offered.
		const nearest = r.choices.includes("session") ? "session" : "once";
		p.finish({ choice: r.choices.includes(choice as Choice) ? choice : nearest, reason: "answered" });
		return true;
	}

	/** A message typed in a chat while a question waits there answers the oldest one; returns its id, if any. */
	answerWithReply(sessionId: string, text: string): string | undefined {
		const q = this.pendingFor(sessionId).find((r): r is QuestionRequest => r.kind === "question");
		if (!q || !text.trim()) return undefined;
		this.pending.get(q.requestId)?.finish({ choice: "answer", reason: "answered", values: replyAnswers(q.questions, text) });
		return q.requestId;
	}

	/**
	 * Asks here what another machine asked its owner (an approval, or a bot's question, checked again here) and
	 * answers what to send back there. `here`: the chat it is asked in and how it reads.
	 */
	async relay(r: ForwardedRequest, here: { sessionId: string; bot: string; description: string; patternKey: string }, signal: AbortSignal): Promise<ForwardedAnswer> {
		if (r.question) {
			const { caption, questions } = checkQuestions(r.question.caption, r.question.questions);
			const o = await this.question({ sessionId: here.sessionId, bot: here.bot, toolName: r.toolName, caption, questions, description: here.description }, signal);
			return o.answered ? { choice: "answer", values: o.values } : { choice: "dismiss" };
		}
		return { choice: await this.ask({ sessionId: here.sessionId, bot: here.bot, toolName: r.toolName, command: r.command, description: here.description, patternKey: here.patternKey }, signal) };
	}

	/** Every request still waiting, oldest first. */
	allPending(): ApprovalRequest[] {
		return [...this.pending.values()].map((p) => p.request).sort((a, b) => a.createdAt - b.createdAt);
	}

	/** A chat's requests still waiting, oldest first. */
	pendingFor(sessionId: string): ApprovalRequest[] {
		return this.allPending().filter((r) => r.sessionId === sessionId);
	}

	/** Withdraw everything waiting in a session (interrupt): approvals are denied, questions end unanswered. */
	cancelSession(sessionId: string): void {
		for (const p of [...this.pending.values()]) if (p.request.sessionId === sessionId) p.finish({ choice: p.request.kind === "question" ? "dismiss" : "deny", reason: "cancelled" });
	}

	/** A question's audit entry keeps its caption, never the answers. */
	private audit(r: ApprovalRequest, what: string): void {
		const detail = r.kind === "question" ? { tool: r.toolName, caption: redact(r.caption).slice(0, 200), questions: r.questions.length } : { tool: r.toolName, command: redact(r.command).slice(0, 500), pattern: r.patternKey };
		this.db.run("INSERT INTO audit (at, bot, session_id, kind, detail) VALUES (?, ?, ?, ?, ?)", Date.now() / 1000, r.bot, r.sessionId, `${r.kind === "question" ? "question" : "approval"}.${what}`, JSON.stringify(detail));
	}
}

const newId = () => randomUUID().slice(0, 12);

/** An approval description that says which machine the request came from (once; a prefix already there is kept). */
export function fromMachine(machine: string, description: string): string {
	const prefix = `from ${machine}: `;
	return description.startsWith(prefix) ? description : prefix + description;
}
