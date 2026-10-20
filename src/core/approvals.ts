// Approval broker: holds tool calls that need an answer until a client answers, the turn is
// interrupted, or the timeout passes (which fails closed). It is called from the Durable
// `beforeTool` hook, which runs before the call's intent is recorded: if the process dies while a
// call waits, Durable re-runs the hook after restart and the question is asked again.
import { randomUUID } from "node:crypto";
import type { AppDb } from "../store/db.ts";
import { redact } from "../log.ts";
import type { ApprovalRequest, Hub } from "./events.ts";

export type Choice = "once" | "session" | "always" | "deny";

type Pending = { request: ApprovalRequest; finish: (c: Choice, reason: "answered" | "timeout" | "cancelled") => void; timer: NodeJS.Timeout };

export class Approvals {
	private readonly pending = new Map<string, Pending>();
	private readonly hub: Hub;
	private readonly db: AppDb;
	private readonly timeoutMs: number;
	/** Sessions with per-session YOLO on (memory only; Vory re-sends it). */
	private readonly yolo = new Set<string>();

	constructor(hub: Hub, db: AppDb, timeoutMs: number) {
		this.hub = hub;
		this.db = db;
		this.timeoutMs = timeoutMs;
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

	/** Waits for an answer. Rejects never; aborting resolves "deny". */
	ask(input: Omit<ApprovalRequest, "requestId" | "createdAt" | "choices"> & { noAlways?: boolean; onceOnly?: boolean }, signal: AbortSignal): Promise<Choice> {
		const { noAlways, onceOnly, ...rest } = input;
		const choices: Choice[] = onceOnly ? ["once", "deny"] : noAlways ? ["once", "session", "deny"] : ["once", "session", "always", "deny"];
		const request: ApprovalRequest = { ...rest, requestId: randomUUID().slice(0, 12), createdAt: Date.now() / 1000, choices };
		this.audit(request, "asked");
		return new Promise<Choice>((resolve) => {
			const finish = (choice: Choice, reason: "answered" | "timeout" | "cancelled") => {
				const p = this.pending.get(request.requestId);
				if (!p) return;
				clearTimeout(p.timer);
				this.pending.delete(request.requestId);
				signal.removeEventListener("abort", onAbort);
				if (choice === "session") this.addRule(`session:${request.sessionId}`, request.patternKey);
				if (choice === "always") this.addRule(`bot:${request.bot}`, request.patternKey);
				this.audit(request, `${reason}:${choice}`);
				this.hub.publish(request.sessionId, { type: "approval.resolved", requestId: request.requestId, choice, reason });
				resolve(choice);
			};
			const onAbort = () => finish("deny", "cancelled");
			const timer = setTimeout(() => finish("deny", "timeout"), this.timeoutMs);
			this.pending.set(request.requestId, { request, finish, timer });
			if (signal.aborted) return onAbort();
			signal.addEventListener("abort", onAbort, { once: true });
			this.hub.publish(request.sessionId, { type: "approval.requested", request });
		});
	}

	/** Answer one request; returns false when it is no longer waiting. */
	answer(requestId: string, choice: Choice): boolean {
		const p = this.pending.get(requestId);
		if (!p) return false;
		// An answer the card did not offer ("always" for a config change) counts as the nearest one offered.
		const nearest = p.request.choices.includes("session") ? "session" : "once";
		p.finish(p.request.choices.includes(choice) ? choice : nearest, "answered");
		return true;
	}

	/** Every request still waiting, oldest first. */
	allPending(): ApprovalRequest[] {
		return [...this.pending.values()].map((p) => p.request).sort((a, b) => a.createdAt - b.createdAt);
	}

	pendingFor(sessionId: string): ApprovalRequest[] {
		return [...this.pending.values()].filter((p) => p.request.sessionId === sessionId).map((p) => p.request);
	}

	/** Deny everything waiting in a session (interrupt). */
	cancelSession(sessionId: string): void {
		for (const p of [...this.pending.values()]) if (p.request.sessionId === sessionId) p.finish("deny", "cancelled");
	}

	private audit(r: ApprovalRequest, what: string): void {
		this.db.run(
			"INSERT INTO audit (at, bot, session_id, kind, detail) VALUES (?, ?, ?, ?, ?)",
			Date.now() / 1000,
			r.bot,
			r.sessionId,
			`approval.${what}`,
			JSON.stringify({ tool: r.toolName, command: redact(r.command).slice(0, 500), pattern: r.patternKey }),
		);
	}
}

/** An approval description that says which machine the request came from (once; a prefix already there is kept). */
export function fromMachine(machine: string, description: string): string {
	const prefix = `from ${machine}: `;
	return description.startsWith(prefix) ? description : prefix + description;
}
