// Canonical events. Produced from Pi Durable's agent events (core/live.ts) and the approval broker;
// consumed by the Hermes adapter, the scheduler and delegation. Adapters translate; they never
// produce agent state of their own.

export type UsageSummary = {
	model: string;
	input: number;
	output: number;
	reasoning: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
	calls: number;
	contextUsed: number;
	contextMax: number;
	costUsd: number;
};

export type ApprovalRequest = {
	requestId: string;
	sessionId: string;
	bot: string;
	toolName: string;
	command: string;
	description: string;
	patternKey: string;
	choices: ("once" | "session" | "always" | "deny")[];
	createdAt: number;
};

export type RunStatus = "complete" | "error" | "interrupted";

export type SessionEvent =
	| { type: "run.started"; at: number; prompt: string }
	| { type: "message.started" }
	| { type: "text.delta"; text: string }
	| { type: "reasoning.delta"; text: string }
	| { type: "tool.started"; callId: string; name: string; args: Record<string, unknown>; preview: string }
	| { type: "tool.output"; callId: string; name: string; text: string }
	| { type: "tool.finished"; callId: string; name: string; resultText: string; isError: boolean; durationS: number }
	| { type: "run.finished"; text: string; reasoning: string; status: RunStatus; error?: string; usage: UsageSummary }
	| { type: "usage"; usage: UsageSummary }
	| { type: "title"; title: string }
	| { type: "approval.requested"; request: ApprovalRequest }
	| { type: "approval.resolved"; requestId: string; choice: string; reason: "answered" | "timeout" | "cancelled" }
	| { type: "notice"; message: string };

export type GlobalEvent = { type: "sessions.changed"; bot: string } | { type: "cron.changed" };

type SessionListener = (sessionId: string, event: SessionEvent) => void;
type GlobalListener = (event: GlobalEvent) => void;

/** In-process fan-out. Listeners must not throw; failures are isolated per listener. */
export class Hub {
	private readonly bySession = new Map<string, Set<SessionListener>>();
	private readonly all = new Set<SessionListener>();
	private readonly globals = new Set<GlobalListener>();
	private readonly seqs = new Map<string, number>();

	/** Count of events published for a session so far (detects events racing a snapshot read). */
	seq(sessionId: string): number {
		return this.seqs.get(sessionId) ?? 0;
	}

	subscribe(sessionId: string, listener: SessionListener): () => void {
		let set = this.bySession.get(sessionId);
		if (!set) this.bySession.set(sessionId, (set = new Set()));
		set.add(listener);
		return () => {
			set.delete(listener);
			if (set.size === 0) this.bySession.delete(sessionId);
		};
	}

	subscribeAll(listener: SessionListener): () => void {
		this.all.add(listener);
		return () => this.all.delete(listener);
	}

	onGlobal(listener: GlobalListener): () => void {
		this.globals.add(listener);
		return () => this.globals.delete(listener);
	}

	subscriberCount(sessionId: string): number {
		return this.bySession.get(sessionId)?.size ?? 0;
	}

	publish(sessionId: string, event: SessionEvent): void {
		this.seqs.set(sessionId, this.seq(sessionId) + 1);
		for (const l of [...(this.bySession.get(sessionId) ?? []), ...this.all]) {
			try {
				l(sessionId, event);
			} catch {
				// a broken subscriber must not stop the others
			}
		}
	}

	publishGlobal(event: GlobalEvent): void {
		for (const l of this.globals) {
			try {
				l(event);
			} catch {
				// isolated
			}
		}
	}
}
