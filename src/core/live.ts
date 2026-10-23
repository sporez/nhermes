// Live state of one session, derived from Pi Durable's agent events: whether a run is going, the
// prompt in flight, the partial answer, and the run's text so far. It republishes everything as
// canonical events on the hub, including the turn events whose ids match core/turns.ts, so a snapshot
// and the events after it name the same turns and items. Durable remains the source of truth; this is a
// projection that can be rebuilt at any time from a watch's snapshot. When a run ends (or a turn ends
// because a new owner message arrived mid-run), it records how in an `nh.run` entry, so history knows a
// turn's end and outcome later.
import type { AgentEvent, ConvId, Engine, EngineWatch, EntryRecord } from "../engine/engine.ts";
import { logger, redact } from "../log.ts";
import type { Hub, RunStatus, UsageSummary } from "./events.ts";
import { type CardDetails, cardNote, SHOW_TOOL } from "./cards.ts";
import { textOf, toolPreview, userDisplay } from "./transcript.ts";
import { cardItem, type LivePartial, projectTurns, replyItemId, type RunRecord, toolStatus, type TurnItem, type TurnUsage, turnId, userContent } from "./turns.ts";

const log = logger("live");

type Block = { type: string; text?: string; thinking?: string; id?: string; name?: string; arguments?: Record<string, unknown> };
type Msg = { role: string; content: string | Block[]; timestamp?: number; stopReason?: string; errorMessage?: string; usage?: TokenUsage; toolCallId?: string; toolName?: string; isError?: boolean; durationMs?: number; model?: string; provider?: string; details?: { structured?: unknown; card?: CardDetails } };
type TokenUsage = { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning?: number; totalTokens: number; cost?: { total: number } };
type ToolItem = Extract<TurnItem, { type: "tool" }>;

export type LiveHooks = {
	/** A user prompt was placed (counts and titles). */
	onUserPlaced(sessionId: string, text: string): void;
	/** A model response was recorded. */
	onAssistant(sessionId: string): void;
	/** How a model call ended, for the provider's sign-in record. */
	onModelOutcome?(m: { provider?: string; stopReason?: string; errorMessage?: string }): void;
	/** A run ended (catalogue update). */
	onRunFinished(sessionId: string, text: string, status: RunStatus): void;
	usage(sessionId: string): Promise<UsageSummary>;
};

export class LiveSession {
	readonly sessionId: string;
	readonly convId: ConvId;
	running = false;
	turnStartedAt = 0;
	prompt = "";
	/** Text blocks of the assistant message streaming now, by content index. */
	private blocks: string[] = [];
	private thinking: string[] = [];
	private streaming = false;
	/** Finished assistant texts of this run, in order. */
	private runParts: string[] = [];
	private runReasoning: string[] = [];
	private lastAssistant: { stopReason?: string; errorMessage?: string } | undefined;
	private toolStarts = new Map<string, number>();
	/** The turn open now (named after its user message), its model replies so far, and its tool calls. */
	private turn: string | undefined;
	private ordinal = 0;
	private opened = { text: false, reasoning: false };
	private tools = new Map<string, ToolItem>();
	/** `show` calls in flight: not announced as tool items; a card (or a failed call) is announced when one ends. */
	private shows = new Map<string, ToolItem>();
	private toolOutput = new Map<string, string>();
	private turnUsage: TurnUsage | undefined;
	private watch: EngineWatch | undefined;
	private attaching: Promise<void> | undefined;
	private readonly engine: Engine;
	private readonly hub: Hub;
	private readonly hooks: LiveHooks;

	constructor(sessionId: string, convId: ConvId, engine: Engine, hub: Hub, hooks: LiveHooks) {
		this.sessionId = sessionId;
		this.convId = convId;
		this.engine = engine;
		this.hub = hub;
		this.hooks = hooks;
	}

	get attached(): boolean {
		return this.watch !== undefined;
	}

	/** What the transcript does not hold yet: the reply streaming now and the tools running (core/turns.ts). */
	partial(): LivePartial | undefined {
		if (!this.turn) return undefined;
		const tools = new Map<string, { startedAt: number; output: string }>();
		for (const [id, at] of this.toolStarts) tools.set(id, { startedAt: at, output: this.toolOutput.get(id) ?? "" });
		return { turnId: this.turn, ordinal: this.ordinal, text: this.streaming ? this.blocks.join("") : "", reasoning: this.streaming ? this.thinking.filter(Boolean).join("\n") : "", tools };
	}

	/** Starts following the conversation (idempotent). Resolves once the initial snapshot is applied. */
	attach(): Promise<void> {
		if (this.watch) return Promise.resolve();
		this.attaching ??= this.engine
			.watch(this.convId, (events) => this.apply(events))
			.then((w) => {
				this.watch = w;
			})
			.finally(() => {
				this.attaching = undefined;
			});
		return this.attaching;
	}

	async detach(): Promise<void> {
		const w = this.watch;
		this.watch = undefined;
		await w?.stop();
	}

	private emit(event: Parameters<Hub["publish"]>[1]): void {
		this.hub.publish(this.sessionId, event);
	}

	private async apply(events: readonly AgentEvent[]): Promise<void> {
		for (const e of events) {
			switch (e.type) {
				case "snapshot":
					this.fromSnapshot(e.entries, e.run !== undefined, e.generation?.message as Msg | undefined);
					break;
				case "message_start": {
					const m = e.message as Msg;
					if (m.role === "user") {
						this.prompt = userDisplay(m.content);
					} else if (m.role === "assistant") {
						this.beginMessage();
						this.applyWholeMessage(m);
					}
					break;
				}
				case "message_update":
					if (!this.streaming) this.beginMessage();
					for (const c of e.changes) this.applyChange(c as never);
					break;
				case "message_end":
					this.endMessage(e.entry);
					break;
				case "run_start":
					this.running = true;
					this.turnStartedAt = Date.now() / 1000;
					this.runParts = [];
					this.runReasoning = [];
					this.lastAssistant = undefined;
					this.emit({ type: "run.started", at: this.turnStartedAt, prompt: this.prompt });
					break;
				case "run_end":
					await this.finishRun(e.inputs as unknown as number[]);
					break;
				case "tool_execution_start": {
					if (e.parentToolCallId !== undefined) break;
					const now = Date.now();
					this.toolStarts.set(e.toolCallId, now);
					const item = this.tools.get(e.toolCallId);
					if (item && this.turn) {
						item.startedAt = now;
						this.emit({ type: "item.updated", turnId: this.turn, item: { ...item } });
					}
					break;
				}
				case "tool_execution_update":
					if (e.parentToolCallId === undefined && e.output && "append" in e.output && e.output.append) {
						this.toolOutput.set(e.toolCallId, (this.toolOutput.get(e.toolCallId) ?? "") + e.output.append);
						this.emit({ type: "tool.output", callId: e.toolCallId, name: e.toolName, text: e.output.append, turnId: this.turn ?? "" });
					}
					break;
				case "tool_execution_end": {
					if (e.parentToolCallId !== undefined) break;
					const started = this.toolStarts.get(e.toolCallId);
					this.toolStarts.delete(e.toolCallId);
					this.toolOutput.delete(e.toolCallId);
					const m = e.entry?.model?.[0] as Msg | undefined;
					const resultText = m ? textOf(m.content) : "The tool did not finish (interrupted).";
					const durationS = m?.durationMs !== undefined ? m.durationMs / 1000 : started ? (Date.now() - started) / 1000 : 0;
					this.emit({ type: "tool.finished", callId: e.toolCallId, name: e.toolName, resultText, isError: m?.isError ?? true, durationS });
					this.finishTool(e.toolCallId, m, started, durationS);
					break;
				}
				case "usage_changed":
					this.emit({ type: "usage", usage: await this.hooks.usage(this.sessionId) });
					break;
				case "compaction_start":
					this.emit({ type: "notice", message: "Compressing context…" });
					break;
				default:
					break;
			}
		}
	}

	private fromSnapshot(entries: readonly EntryRecord[], running: boolean, partial: Msg | undefined): void {
		// Prompt: the newest user message; run text: assistant texts after it.
		let lastUser = -1;
		for (let i = entries.length - 1; i >= 0; i--) {
			const m = entries[i]!.model?.[0] as Msg | undefined;
			if (m?.role === "user") {
				lastUser = i;
				this.prompt = userDisplay(m.content);
				break;
			}
		}
		this.runParts = [];
		this.turn = lastUser >= 0 ? turnId(entries[lastUser]!.id as number) : undefined;
		this.ordinal = 0;
		this.tools.clear();
		this.shows.clear();
		for (const entry of entries.slice(lastUser + 1)) if ((entry.model?.[0] as Msg | undefined)?.role === "assistant") this.ordinal++;
		if (running) {
			for (const entry of entries.slice(lastUser + 1)) {
				const m = entry.model?.[0] as Msg | undefined;
				if (m?.role === "assistant") {
					const t = textOf(m.content);
					if (t) this.runParts.push(t);
				}
			}
			if (!this.running) this.turnStartedAt = Date.now() / 1000;
			// The calls the open turn is still waiting on, so their results finish the same items.
			const open = projectTurns(entries, { running: true }).at(-1);
			if (open && open.id === this.turn) for (const item of open.items) if (item.type === "tool" && item.status === "running") this.tools.set(item.id, item);
			// projectTurns holds back a running `show`; the hub still needs it to finish as a card.
			for (const entry of entries.slice(lastUser + 1)) {
				const m = entry.model?.[0] as Msg | undefined;
				if (m?.role !== "assistant" || typeof m.content === "string") continue;
				for (const b of m.content) {
					if (b.type !== "toolCall" || b.name !== SHOW_TOOL || !b.id) continue;
					const answered = entries.some((x) => (x.model?.[0] as Msg | undefined)?.toolCallId === b.id);
					if (!answered) this.shows.set(b.id, this.toolItem(b));
				}
			}
		}
		this.running = running;
		this.blocks = [];
		this.thinking = [];
		this.streaming = false;
		this.opened = { text: false, reasoning: false };
		if (partial) {
			this.ordinal++;
			this.streaming = true;
			this.applyWholeMessage(partial, false);
			this.opened = { text: this.blocks.some(Boolean), reasoning: this.thinking.some(Boolean) };
		}
	}

	private beginMessage(): void {
		this.blocks = [];
		this.thinking = [];
		this.streaming = true;
		this.ordinal++;
		this.opened = { text: false, reasoning: false };
	}

	/** A whole (partial) message: emit whatever extends what was already shown. */
	private applyWholeMessage(m: Msg, emit = true): void {
		const content = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content;
		content.forEach((b, i) => {
			if (b.type === "text") this.setText(i, b.text ?? "", emit);
			else if (b.type === "thinking") this.setThinking(i, b.thinking ?? "", emit);
		});
	}

	private setText(i: number, next: string, emit = true): void {
		const prev = this.blocks[i] ?? "";
		this.blocks[i] = next;
		if (!emit || !next.startsWith(prev) || next.length <= prev.length) return;
		const turn = this.turn ?? "";
		const itemId = replyItemId(turn, this.ordinal, "t");
		if (!this.opened.text) {
			this.opened.text = true;
			this.emit({ type: "item.started", turnId: turn, item: { type: "text", id: itemId, text: "", at: Date.now() } });
		}
		this.emit({ type: "text.delta", text: next.slice(prev.length), turnId: turn, itemId });
	}

	private setThinking(i: number, next: string, emit = true): void {
		const prev = this.thinking[i] ?? "";
		this.thinking[i] = next;
		if (!emit || !next.startsWith(prev) || next.length <= prev.length) return;
		const turn = this.turn ?? "";
		const itemId = replyItemId(turn, this.ordinal, "r");
		if (!this.opened.reasoning) {
			this.opened.reasoning = true;
			this.emit({ type: "item.started", turnId: turn, item: { type: "reasoning", id: itemId, text: "", at: Date.now() } });
		}
		this.emit({ type: "reasoning.delta", text: next.slice(prev.length), turnId: turn, itemId });
	}

	private applyChange(c: { type: string; contentIndex?: number; delta?: string; block?: Block; message?: Msg }): void {
		const i = c.contentIndex ?? 0;
		switch (c.type) {
			case "text_start":
				this.setText(i, c.block?.text ?? "");
				break;
			case "thinking_start":
				this.setThinking(i, c.block?.thinking ?? "");
				break;
			case "text_delta":
				this.setText(i, (this.blocks[i] ?? "") + (c.delta ?? ""));
				break;
			case "thinking_delta":
				this.setThinking(i, (this.thinking[i] ?? "") + (c.delta ?? ""));
				break;
			case "block":
				if (c.block?.type === "text") this.setText(i, c.block.text ?? "");
				else if (c.block?.type === "thinking") this.setThinking(i, c.block.thinking ?? "");
				break;
			case "message":
				if (c.message) this.applyWholeMessage(c.message);
				break;
			default:
				break;
		}
	}

	private endMessage(entry: EntryRecord): void {
		const m = entry.model?.[0] as Msg | undefined;
		if (!m) return;
		if (m.role === "user") {
			this.prompt = userDisplay(m.content);
			this.startTurn(entry, m);
			this.hooks.onUserPlaced(this.sessionId, this.prompt);
			return;
		}
		if (m.role !== "assistant") return;
		const content = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content;
		// Anything the stream did not show yet (an unstreamed answer) goes out as a delta first.
		if (!this.streaming) this.beginMessage();
		content.forEach((b, i) => {
			if (b.type === "text") this.setText(i, b.text ?? "");
			else if (b.type === "thinking") this.setThinking(i, b.thinking ?? "");
		});
		this.hooks.onAssistant(this.sessionId);
		const text = textOf(m.content);
		if (text) this.runParts.push(text);
		const thought = this.thinking.filter(Boolean).join("\n");
		if (thought) this.runReasoning.push(thought);
		this.finishReply(m, text, thought);
		this.lastAssistant = { stopReason: m.stopReason, errorMessage: m.errorMessage };
		this.hooks.onModelOutcome?.({ provider: m.provider, stopReason: m.stopReason, errorMessage: m.errorMessage });
		this.blocks = [];
		this.thinking = [];
		this.streaming = false;
	}

	/** A new owner message opens a turn; one still open (an owner message mid-run) ends here. */
	private startTurn(entry: EntryRecord, m: Msg): void {
		if (this.turn && this.running) this.endTurn("complete");
		this.turn = turnId(entry.id as number);
		this.ordinal = 0;
		this.tools.clear();
		this.shows.clear();
		this.turnUsage = undefined;
		const at = m.timestamp ?? Date.now();
		this.emit({ type: "turn.started", turn: { id: this.turn, status: "running", startedAt: at, endedAt: null, user: { content: userContent(m.content), at }, items: [] } });
	}

	/** A model reply is complete: its reasoning and text items finish, and the tool calls it asked for start. */
	private finishReply(m: Msg, text: string, thought: string): void {
		const turn = this.turn;
		if (!turn) return;
		const at = m.timestamp ?? Date.now();
		if (m.usage) {
			const u = (this.turnUsage ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, calls: 0 });
			u.input += m.usage.input;
			u.output += m.usage.output;
			u.cacheRead += m.usage.cacheRead;
			u.cacheWrite += m.usage.cacheWrite;
			u.costUsd += m.usage.cost?.total ?? 0;
			u.calls++;
		}
		if (thought) this.emit({ type: "item.finished", turnId: turn, item: { type: "reasoning", id: replyItemId(turn, this.ordinal, "r"), text: redact(thought), at } });
		if (text) this.emit({ type: "item.finished", turnId: turn, item: { type: "text", id: replyItemId(turn, this.ordinal, "t"), text: redact(text), at } });
		if (m.stopReason === "error") this.emit({ type: "item.finished", turnId: turn, item: { type: "error", id: replyItemId(turn, this.ordinal, "e"), message: redact(m.errorMessage ?? "The model request failed."), at } });
		const blocks = typeof m.content === "string" ? [] : m.content;
		for (const b of blocks) {
			if (b.type !== "toolCall" || !b.id) continue;
			const item = this.toolItem(b);
			if (b.name === SHOW_TOOL) {
				this.shows.set(b.id, item);
				continue;
			}
			this.tools.set(b.id, item);
			this.emit({ type: "item.started", turnId: turn, item: { ...item } });
		}
	}

	private toolItem(b: Block): ToolItem {
		const args = JSON.parse(redact(JSON.stringify(b.arguments ?? {}))) as Record<string, unknown>;
		return { type: "tool", id: b.id!, name: b.name ?? "tool", args, preview: redact(toolPreview(b.arguments)), status: "running", startedAt: null, durationMs: null, result: null };
	}

	private finishTool(callId: string, m: Msg | undefined, started: number | undefined, durationS: number): void {
		const turn = this.turn;
		const pending = this.shows.get(callId);
		this.shows.delete(callId);
		const item = this.tools.get(callId) ?? pending;
		if (!turn || !item) return;
		this.tools.delete(callId);
		const text = m ? textOf(m.content) : "";
		if (pending && m && !m.isError && m.details?.card) {
			const card = cardItem(callId, m.timestamp ?? Date.now(), JSON.parse(redact(JSON.stringify(m.details.card))) as CardDetails);
			this.runParts.push(cardNote(card.caption));
			this.emit({ type: "item.started", turnId: turn, item: card });
			this.emit({ type: "item.finished", turnId: turn, item: card });
			return;
		}
		const done: ToolItem = {
			...item,
			status: m ? toolStatus(text, m.isError) : "unknown",
			startedAt: item.startedAt ?? started ?? null,
			// Only a call that ran has a duration (a refused one never started).
			durationMs: m?.durationMs ?? (started !== undefined ? Math.round(durationS * 1000) : null),
			result: m ? redact(text) : null,
			...(m?.details?.structured !== undefined ? { json: JSON.parse(redact(JSON.stringify(m.details.structured))) as unknown } : {}),
		};
		// A failed `show` was never announced: it starts and finishes here, so its error is visible.
		if (pending) this.emit({ type: "item.started", turnId: turn, item: { ...pending } });
		this.emit({ type: "item.finished", turnId: turn, item: done });
	}

	/** The open turn ends: announced, and recorded in the transcript for history. */
	private endTurn(status: RunStatus, error?: string): void {
		const turn = this.turn;
		if (!turn) return;
		const endedAt = Date.now();
		for (const item of this.tools.values()) this.emit({ type: "item.finished", turnId: turn, item: { ...item, status: "unknown" } });
		this.tools.clear();
		this.shows.clear();
		this.emit({ type: "turn.finished", turnId: turn, status, endedAt, ...(error ? { error: redact(error) } : {}), ...(this.turnUsage ? { usage: this.turnUsage } : {}) });
		const record: RunRecord = { turn, status, endedAt, ...(error ? { error } : {}) };
		this.engine.writeRunRecord(this.convId, record).catch((e: unknown) => log.warn("run record not written", { session: this.sessionId, error: String(e) }));
	}

	private async finishRun(inputs: number[]): Promise<void> {
		let status: RunStatus = "complete";
		let error: string | undefined;
		for (const id of inputs) {
			const rec = await this.engine.submissionStatus(id);
			if (rec?.status === "unanswered") {
				if (rec.reason === "aborted") status = "interrupted";
				else {
					status = "error";
					error = typeof rec.detail === "string" ? rec.detail : rec.reason;
				}
			}
		}
		if (this.lastAssistant?.stopReason === "aborted") status = "interrupted";
		if (this.lastAssistant?.stopReason === "error") {
			status = "error";
			error = this.lastAssistant.errorMessage ?? error ?? "The model request failed";
		}
		const text = this.runParts.join("\n\n");
		this.running = false;
		this.streaming = false;
		this.blocks = [];
		this.endTurn(status, error);
		const usage = await this.hooks.usage(this.sessionId);
		log.debug("run finished", { session: this.sessionId, status });
		this.emit({ type: "run.finished", text, reasoning: this.runReasoning.join("\n"), status, error, usage });
		this.hooks.onRunFinished(this.sessionId, text, status);
	}
}
