// Canonical events. Produced from Pi Durable's agent events (core/live.ts) and the approval broker;
// consumed by the API layers, the scheduler and delegation. Adapters translate; they never
// produce agent state of their own.
import type { Question } from "./questions.ts";
import type { SpaceInfo } from "../spaces/spaces.ts";
import type { RoomEvent } from "./room-plan.ts";
import type { Turn, TurnItem, TurnUsage } from "./turns.ts";

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

type RequestBase = {
	requestId: string;
	/** Where the owner answers it: the chat the work started in (a delegated task asks in its caller's chat). */
	sessionId: string;
	/** The tool call waiting, and the session it runs in (differs from sessionId for delegated work). */
	toolCallId?: string;
	callSessionId?: string;
	bot: string;
	toolName: string;
	description: string;
	createdAt: number;
};

/** A tool call waiting for the owner's approval. */
export type CommandApproval = RequestBase & { kind: "approval"; command: string; patternKey: string; choices: ("once" | "session" | "always" | "deny")[] };

/** A bot's `ask` waiting for the owner's answer (src/core/questions.ts). */
export type QuestionRequest = RequestBase & { kind: "question"; caption: string; questions: Question[]; choices: ("answer" | "dismiss")[] };

/** What waits on the approvals broker: an approval or a question. */
export type ApprovalRequest = CommandApproval | QuestionRequest;

export type RunStatus = "complete" | "error" | "interrupted";

export type SessionEvent =
	| { type: "run.started"; at: number; prompt: string }
	// The turn events (ids as core/turns.ts names them): what the client API streams.
	| { type: "turn.started"; turn: Turn }
	| { type: "item.started"; turnId: string; item: TurnItem }
	| { type: "item.updated"; turnId: string; item: TurnItem }
	| { type: "item.finished"; turnId: string; item: TurnItem }
	| { type: "turn.finished"; turnId: string; status: RunStatus; endedAt: number; error?: string; usage?: TurnUsage }
	| { type: "text.delta"; text: string; turnId: string; itemId: string }
	| { type: "reasoning.delta"; text: string; turnId: string; itemId: string }
	| { type: "tool.output"; callId: string; name: string; text: string; turnId: string }
	| { type: "tool.finished"; callId: string; name: string; resultText: string; isError: boolean; durationS: number }
	| { type: "run.finished"; text: string; reasoning: string; status: RunStatus; error?: string; usage: UsageSummary }
	| { type: "usage"; usage: UsageSummary }
	| { type: "title"; title: string }
	| { type: "approval.requested"; request: ApprovalRequest }
	| { type: "approval.resolved"; requestId: string; choice: string; reason: "answered" | "timeout" | "cancelled" }
	/** `call`: the `delegate` call whose background task this notice is about (a task Stop ended). */
	| { type: "notice"; message: string; call?: string }
	/** The chat's bot's open spaces, all of them, after one opened or closed or a view of one did. */
	| { type: "spaces"; spaces: SpaceInfo[] };

/** `sessionId`: the one session that changed, when there is one (a client then fetches just that row). */
export type GlobalEvent =
	| { type: "sessions.changed"; bot: string; sessionId?: string }
	| { type: "cron.changed" }
	/** Bots' settings changed, or a member's list of bots did. */
	| { type: "bots.changed" }
	/** A group chat was created, or filed events in its log (src/core/rooms.ts). */
	| { type: "rooms.changed"; roomId: string; events: RoomEvent[] };

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

	/** The sessions something follows right now. */
	followed(): string[] {
		return [...this.bySession.keys()];
	}

	subscribeAll(listener: SessionListener): () => void {
		this.all.add(listener);
		return () => this.all.delete(listener);
	}

	onGlobal(listener: GlobalListener): () => void {
		this.globals.add(listener);
		return () => this.globals.delete(listener);
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
