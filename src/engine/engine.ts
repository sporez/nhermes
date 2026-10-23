// The engine boundary: the only module that talks to Pi Durable. Everything above it uses these
// methods and the AgentEvent stream, so a Pi Durable API change is contained here and in
// test/upstream/. Conversation ids are Durable's numeric ids; the session layer maps them to the
// string ids clients see.
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import {
	type AgentChange,
	type AgentEvent,
	type ConversationId,
	type ConversationOwnership,
	createRegistry,
	type EntryRecord,
	type EnvTarget,
	type Extension,
	Harness,
	type HarnessSettings,
	LiveDoc,
	MemoryStorage,
	type Registry,
	type SubmissionId,
	type SubmissionRecord,
	UsageDoc,
	type UsageState,
	type UserInput,
	watchEvents,
} from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { logger } from "../log.ts";
import { imageTokens } from "./image-tokens.ts";

const log = logger("engine");
const ctx = BACKGROUND_CONTEXT;

export type ConvId = number;
export type ModelRef = { provider: string; modelId: string };
export type { AgentChange, AgentEvent, EntryRecord, UsageState, UserInput };

export type EngineOptions = {
	/** Path of the Durable SQLite file; ":memory:" uses MemoryStorage (tests). */
	dbPath: string;
	models: Models;
	env?: (conversationId: ConvId, cwd: string | undefined) => ExecutionEnv | undefined | Promise<ExecutionEnv | undefined>;
	settings?: HarnessSettings;
};

export type SubmitOptions = {
	requestId?: string;
	whenBusy?: "steer" | "followUp" | "reject";
};

export type SubmitResult = { submissionId: number; status: SubmissionRecord["status"] };

export type EngineWatch = { stop(): Promise<void> };

const cid = (id: ConvId) => id as ConversationId;

export class Engine {
	readonly registry: Registry;
	readonly models: Models;
	private readonly harness: Harness;

	private constructor(harness: Harness, registry: Registry, models: Models) {
		this.harness = harness;
		this.registry = registry;
		this.models = models;
	}

	static async open(options: EngineOptions, extensions: readonly Extension[]): Promise<Engine> {
		const registry = createRegistry();
		for (const ext of extensions) registry.install(ext);
		const storage = options.dbPath === ":memory:" ? new MemoryStorage() : await openNodeSqliteStorage(options.dbPath);
		const envFn = options.env;
		const harness = await Harness.open(
			storage,
			{
				models: options.models,
				registry,
				settings: options.settings,
				env: envFn ? (target: EnvTarget) => envFn(target.conversationId as number, target.cwd) : undefined,
				onReport: (error) => log.warn("durable report", { error: error instanceof Error ? error.message : String(error) }),
			},
			ctx,
		);
		harness.closed.then((end) => {
			if (end.reason === "failed") log.error("durable session failed", { error: String(end.error) });
		});
		return new Engine(harness, registry, options.models);
	}

	/** Continue runs the previous process left unfinished. */
	resume(): void {
		this.harness.resume();
	}

	async close(): Promise<void> {
		await this.harness.close(ctx);
	}

	async create(agent: AgentChange, ownership: ConversationOwnership = { kind: "ownerless" }): Promise<ConvId> {
		const conv = await this.harness.createConversation({ ownership, agent }, ctx);
		return conv.id as number;
	}

	async exists(id: ConvId): Promise<boolean> {
		return (await this.harness.conversation(cid(id), ctx)) !== undefined;
	}

	private async conv(id: ConvId) {
		const c = await this.harness.conversation(cid(id), ctx);
		if (!c) throw new UnknownConversation(id);
		return c;
	}

	async configure(id: ConvId, change: AgentChange): Promise<void> {
		await (await this.conv(id)).configure(change, ctx);
	}

	/**
	 * The conversation's resolved model, thinking level and the tools the model may call (offered now, or deferred
	 * until tool_search loads them), with the model's context window.
	 */
	async agentModel(id: ConvId): Promise<{ model?: ModelRef; thinking: string; contextWindow: number; tools: string[] }> {
		const agent = await (await this.conv(id)).agent(ctx);
		const ref = agent.model;
		const model = ref ? this.models.getModel(ref.provider, ref.modelId) : undefined;
		return {
			model: ref ? { provider: ref.provider, modelId: ref.modelId } : undefined,
			thinking: agent.thinkingLevel,
			contextWindow: model?.contextWindow ?? 0,
			tools: [...agent.tools, ...agent.deferred].map((t) => t.name),
		};
	}

	/** Text, or text and image blocks (a prompt with attached pictures). */
	async submit(id: ConvId, content: UserInput, options: SubmitOptions = {}): Promise<SubmitResult> {
		const conv = await this.conv(id);
		const sub = await conv.submit({ type: "input", content, requestId: options.requestId, whenBusy: options.whenBusy ?? "followUp" }, ctx);
		const record = await sub.status(ctx);
		return { submissionId: sub.id as number, status: record.status };
	}

	/** Resolves when the submission is answered or can no longer be. */
	async waitSubmission(submissionId: number, context: Context = ctx): Promise<SubmissionRecord> {
		const sub = await this.harness.submission(submissionId as SubmissionId, context);
		if (!sub) throw new Error(`unknown submission ${submissionId}`);
		return sub.wait(context);
	}

	async submissionStatus(submissionId: number): Promise<SubmissionRecord | undefined> {
		const sub = await this.harness.submission(submissionId as SubmissionId, ctx);
		return sub ? sub.status(ctx) : undefined;
	}

	/** Starts a fresh model context (older entries stay in the transcript). Queued like a write while busy. */
	async reset(id: ConvId, handoff?: string): Promise<void> {
		await (await this.conv(id)).reset(handoff, ctx);
	}

	/** Appends an entry the model does not see (a notice shown to clients). */
	async writeNotice(id: ConvId, text: string, data: Record<string, string> = {}): Promise<void> {
		await (await this.conv(id)).submit({ type: "write", entry: { kind: "nh.notice", data: { text, ...data } } }, ctx);
	}

	/** Records how a turn ended (core/turns.ts reads it back for history); the model does not see it. */
	async writeRunRecord(id: ConvId, record: { turn: string; status: string; endedAt: number; error?: string }): Promise<void> {
		await (await this.conv(id)).submit({ type: "write", entry: { kind: "nh.run", data: record } }, ctx);
	}

	/** The text of an answer entry (the `answer` of a settled input). */
	async answerText(id: ConvId, entryId: number): Promise<string> {
		const conv = await this.conv(id);
		const page = await conv.entries({ minEntryId: entryId as EntryRecord["id"], maxEntryId: entryId as EntryRecord["id"] }, 1, undefined, ctx);
		const msg = page.items[0]?.model?.[0] as { content?: { type: string; text?: string }[] } | undefined;
		return (msg?.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
	}

	async abort(id: ConvId): Promise<void> {
		await (await this.conv(id)).abort(ctx);
	}

	async compact(id: ConvId, instructions?: string): Promise<void> {
		await (await this.conv(id)).compact(instructions, ctx);
	}

	async waitForIdle(id: ConvId, context: Context = ctx): Promise<void> {
		await (await this.conv(id)).waitForIdle(context);
	}

	/** Every entry of the conversation, oldest first. */
	async entries(id: ConvId): Promise<EntryRecord[]> {
		const conv = await this.conv(id);
		const out: EntryRecord[] = [];
		let cursor: Parameters<typeof conv.entries>[2];
		for (;;) {
			const page = await conv.entries({ order: "ascending" }, 500, cursor, ctx);
			out.push(...page.items);
			if (page.next === undefined) break;
			cursor = page.next;
		}
		return out;
	}

	/** The newest `limit` entries, newest first. */
	async latestEntries(id: ConvId, limit: number): Promise<EntryRecord[]> {
		const conv = await this.conv(id);
		const page = await conv.entries({ order: "descending" }, limit, undefined, ctx);
		return [...page.items];
	}

	async isBusy(id: ConvId): Promise<boolean> {
		const live = await this.harness.snapshot(LiveDoc, cid(id), ctx);
		return live?.run !== undefined;
	}

	/** Text of the in-flight partial assistant message, if a generation is streaming. */
	async livePartialText(id: ConvId): Promise<string> {
		const live = await this.harness.snapshot(LiveDoc, cid(id), ctx);
		const msg = live?.generation?.message as { content?: { type: string; text?: string }[] } | undefined;
		return (msg?.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
	}

	/**
	 * Rough token estimate of what the next request would carry, by part: text at chars / 4, images by
	 * their pixel size on this model's provider (nothing if the model takes no images).
	 */
	async contextStats(id: ConvId): Promise<{ system: number; tools: number; conversation: number }> {
		const conv = await this.conv(id);
		const [view, agent] = await Promise.all([conv.context(ctx), conv.agent(ctx)]);
		const model = agent.model ? this.models.getModel(agent.model.provider, agent.model.modelId) : undefined;
		const seesImages = model?.input.includes("image") ?? true;
		const size = (content: unknown): number => {
			if (!Array.isArray(content)) return JSON.stringify(content ?? "").length / 4;
			let n = 0;
			for (const block of content as { type?: string; data?: string }[]) {
				if (block.type === "image") n += seesImages && typeof block.data === "string" ? imageTokens(block.data, model?.api ?? "") : 0;
				else n += JSON.stringify(block).length / 4;
			}
			return n;
		};
		let system = 0;
		let conversation = 0;
		// Later system messages replace prompt sections by name, so only each name's latest text counts.
		const sections = new Map<string, string>();
		for (const m of view.messages) {
			if (m.role === "system") {
				system += size(m.content);
				for (const [name, text] of Object.entries(m.sections ?? {})) {
					if (text === null) sections.delete(name);
					else sections.set(name, text);
				}
			} else conversation += size((m as { content?: unknown }).content);
		}
		for (const text of sections.values()) system += text.length / 4;
		const tools = agent.tools.reduce((n, t) => n + JSON.stringify({ n: t.name, d: t.description, p: t.parameters }).length, 0);
		return { system: Math.round(system), tools: Math.round(tools / 4), conversation: Math.round(conversation) };
	}

	async usage(id: ConvId): Promise<UsageState> {
		return ((await this.harness.snapshot(UsageDoc, cid(id), ctx)) ?? { models: {}, tools: {} }) as UsageState;
	}

	/** Conversations with unfinished submissions, to re-attach event watches after a restart. */
	async busyConversations(): Promise<ConvId[]> {
		const inspection = await this.harness.inspect(ctx);
		return [...new Set(inspection.submissions.map((s) => s.conversationId as number))];
	}

	async watch(id: ConvId, listener: (events: readonly AgentEvent[]) => void | Promise<void>): Promise<EngineWatch> {
		const stream = await watchEvents(this.harness, cid(id), ctx);
		// The state at attachment first, then every commit's batch on top of it.
		await listener([stream.snapshot]);
		stream.start(async (events) => {
			try {
				await listener(events);
			} catch (error) {
				log.warn("event listener failed", { conversation: id, error: String(error) });
			}
		});
		return { stop: async () => void (await stream.stop()) };
	}
}

export class UnknownConversation extends Error {
	override name = "UnknownConversation";
	readonly id: ConvId;
	constructor(id: ConvId) {
		super(`unknown conversation ${id}`);
		this.id = id;
	}
}
