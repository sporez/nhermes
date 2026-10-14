// Live state of one session, derived from Pi Durable's agent events: whether a run is going, the
// prompt in flight, the partial answer, and the run's text so far. It republishes everything as
// canonical events on the hub. Durable remains the source of truth; this is a projection that can be
// rebuilt at any time from a watch's snapshot.
import type { AgentEvent, ConvId, Engine, EngineWatch, EntryRecord } from "../engine/engine.ts";
import { logger } from "../log.ts";
import type { Hub, RunStatus, UsageSummary } from "./events.ts";
import { textOf, toolPreview } from "./transcript.ts";

const log = logger("live");

type Block = { type: string; text?: string; thinking?: string; id?: string; name?: string; arguments?: Record<string, unknown> };
type Msg = { role: string; content: string | Block[]; stopReason?: string; errorMessage?: string; usage?: TokenUsage; toolCallId?: string; toolName?: string; isError?: boolean; durationMs?: number; model?: string; provider?: string };
type TokenUsage = { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning?: number; totalTokens: number; cost?: { total: number } };

export type LiveHooks = {
	/** A user prompt was placed (counts and titles). */
	onUserPlaced(sessionId: string, text: string): void;
	/** A model response was recorded. */
	onAssistant(sessionId: string): void;
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

	get partialText(): string {
		return this.blocks.join("");
	}

	get isStreaming(): boolean {
		return this.streaming;
	}

	get attached(): boolean {
		return this.watch !== undefined;
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
						this.prompt = textOf(m.content);
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
				case "tool_execution_start":
					if (e.parentToolCallId !== undefined) break;
					this.toolStarts.set(e.toolCallId, Date.now());
					this.emit({ type: "tool.started", callId: e.toolCallId, name: e.toolName, args: e.args as Record<string, unknown>, preview: toolPreview(e.args as Record<string, unknown>) });
					break;
				case "tool_execution_update":
					if (e.parentToolCallId === undefined && e.output && "append" in e.output && e.output.append) {
						this.emit({ type: "tool.output", callId: e.toolCallId, name: e.toolName, text: e.output.append });
					}
					break;
				case "tool_execution_end": {
					if (e.parentToolCallId !== undefined) break;
					const started = this.toolStarts.get(e.toolCallId);
					this.toolStarts.delete(e.toolCallId);
					const m = e.entry?.model?.[0] as Msg | undefined;
					const resultText = m ? textOf(m.content) : "The tool did not finish (interrupted).";
					const durationS = m?.durationMs !== undefined ? m.durationMs / 1000 : started ? (Date.now() - started) / 1000 : 0;
					this.emit({ type: "tool.finished", callId: e.toolCallId, name: e.toolName, resultText, isError: m?.isError ?? true, durationS });
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
				this.prompt = textOf(m.content);
				break;
			}
		}
		this.runParts = [];
		if (running) {
			for (const entry of entries.slice(lastUser + 1)) {
				const m = entry.model?.[0] as Msg | undefined;
				if (m?.role === "assistant") {
					const t = textOf(m.content);
					if (t) this.runParts.push(t);
				}
			}
			if (!this.running) this.turnStartedAt = Date.now() / 1000;
		}
		this.running = running;
		this.blocks = [];
		this.thinking = [];
		this.streaming = false;
		if (partial) {
			this.streaming = true;
			this.applyWholeMessage(partial, false);
		}
	}

	private beginMessage(): void {
		this.blocks = [];
		this.thinking = [];
		this.streaming = true;
		this.emit({ type: "message.started" });
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
		if (emit && next.startsWith(prev) && next.length > prev.length) this.emit({ type: "text.delta", text: next.slice(prev.length) });
	}

	private setThinking(i: number, next: string, emit = true): void {
		const prev = this.thinking[i] ?? "";
		this.thinking[i] = next;
		if (emit && next.startsWith(prev) && next.length > prev.length) this.emit({ type: "reasoning.delta", text: next.slice(prev.length) });
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
			this.prompt = textOf(m.content);
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
		this.lastAssistant = { stopReason: m.stopReason, errorMessage: m.errorMessage };
		this.blocks = [];
		this.thinking = [];
		this.streaming = false;
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
		const usage = await this.hooks.usage(this.sessionId);
		log.debug("run finished", { session: this.sessionId, status });
		this.emit({ type: "run.finished", text, reasoning: this.runReasoning.join("\n"), status, error, usage });
		this.hooks.onRunFinished(this.sessionId, text, status);
	}
}
