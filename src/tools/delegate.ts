// Agent-to-agent delegation. `delegate` asks another bot to do a task in a child conversation that is
// configured as that bot (its model, tools, instructions) and listed as one of its sessions.
//  - wait: true  → the child is owned by this tool call (Pi Durable foreground subagent pattern); the
//                  answer is the tool result. Replay-safe: a rerun after a crash finds the same child and
//                  the same submission (request id), so the task is not sent twice.
//  - wait: false → the child is owned by a background anchor task; a durable reporter task waits for the
//                  answer and posts it back into the caller's conversation as a follow-up message.
//                  For a bot on another machine the reporter talks to that machine (remoteReporter).
import { type AssistantMessage, Type } from "@earendil-works/pi-ai";
import {
	type AgentChange,
	AssistantEntry,
	type ConversationId,
	configure,
	defineExtension,
	defineTask,
	defineTool,
	type Extension,
	type ToolRegistration,
} from "@earendil-works/pi-durable";
import { type Approvals, fromMachine } from "../core/approvals.ts";
import type { Bot, Bots } from "../core/bots.ts";
import { withCardNotes } from "../core/cards.ts";
import type { Sessions } from "../core/sessions.ts";
import { type MessageFrom, userEntry } from "../core/turns.ts";
import type { Members } from "../federation/members.ts";
import { ApiClient } from "../remote/api-client.ts";
import { createPeerSession, type PeerTarget, runOnPeer } from "../remote/peer.ts";

export type DelegateDeps = {
	sessions: () => Sessions;
	bots: () => Bots;
	agentFor: (bot: Bot) => AgentChange;
	maxDepth: number;
	approvals: () => Approvals;
	/** The root chat a session's approvals are asked in. */
	attentionSession: (sessionId: string) => string;
	members: () => Members;
	/** Tells the caller's chat that a task handed over in the background was stopped (a notice naming the call). */
	stopped: (conversationId: number, text: string, call: string) => Promise<void>;
};

/** Where a bot on another machine is reached: a network member (pair secret) or a configured peer (token). */
function peerTarget(deps: DelegateDeps, target: Bot): PeerTarget {
	if (target.remote) {
		const t = deps.members().target(target.remote.nodeId);
		if (!t) throw new Error(`${target.remote.node} is no longer a member of the network`);
		return { ...t, profile: target.remote.bot };
	}
	const peer = target.config.peer!;
	const token = process.env[peer.tokenEnv];
	if (!token) throw new Error(`the token for ${target.name} (${peer.tokenEnv}) is not set on this gateway`);
	return { url: peer.url, token, profile: peer.profile };
}

function textOf(message: AssistantMessage | undefined): string {
	return withCardNotes((message?.content ?? []).flatMap((c) => (c.type === "text" ? [c.text] : [])).join(""), message?.content);
}

/** What a delegated task came to: the bot's answer, or why it could not finish. */
type Report = { text: string; failed?: true };

/**
 * The message that posts a report into the caller's chat. The model reads a bracketed line naming the bot and
 * the task before the text (tools/memory.ts and agent/extensions.ts recognise it as not the owner's); the chat shows
 * the text alone, marked as the bot's (`user.from`).
 */
function reportInput(bot: string, task: string, call: string | undefined, report: Report | string, requestId: string) {
	// A report decided before reports carried their outcome is the whole message already.
	const r: Report = typeof report === "string" ? { text: report } : report;
	const header = typeof report === "string" ? "" : r.failed ? `[${bot} could not finish the delegated task: "${task.slice(0, 200)}"]\n\n` : `[Result from bot "${bot}" for the task you delegated: "${task.slice(0, 200)}"]\n\n`;
	const from: MessageFrom = { kind: "delegate", bot, task: task.slice(0, 1000), ...(call ? { call } : {}), ...(r.failed ? { failed: true as const } : {}) };
	return { type: "input", content: header + r.text, whenBusy: "followUp", requestId, entry: userEntry({ from, header }) } as const;
}

const failure = (error: unknown): Report => ({ text: error instanceof Error ? error.message : String(error), failed: true });

/** A background task ended without an answer (Stop, or its bot's chat was stopped): the caller's chat says so. */
async function noteStopped(deps: DelegateDeps, conversationId: number, input: { bot: string; call?: string }): Promise<void> {
	if (!input.call) return;
	const name = deps.bots().get(input.bot)?.displayName ?? input.bot;
	await deps.stopped(conversationId, `Stopped the task handed to ${name}.`, input.call).catch(() => undefined);
}

function depth(sessions: Sessions, sessionId: string): number {
	let d = 0;
	let row = sessions.get(sessionId);
	while (row?.parent_id && d < 20) {
		d++;
		row = sessions.get(row.parent_id);
	}
	return d;
}

const Anchor = defineTask<null, { phase: "done" }, null>({
	name: "nh.delegate-anchor",
	version: 1,
	initial: () => ({ phase: "done" }),
	phases: {
		done: (_t, runtime, ctx) => runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), ctx),
	},
	abort: (_t, runtime, ctx) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
});

/** `call`: the `delegate` call that handed the task over (absent for tasks handed over before reports named it). */
type ReporterInput = { bot: string; childId: number; task: string; call?: string };
type ReporterState = { phase: "deliver" } | { phase: "report"; report?: Report | string };

const reporter = (deps: DelegateDeps) => defineTask<ReporterInput, ReporterState, null>({
	name: "nh.delegate-reporter",
	version: 1,
	initial: () => ({ phase: "deliver" }),
	phases: {
		deliver: async (task, runtime, ctx) => {
			const child = (await runtime.conversation(task.input.childId as ConversationId, ctx))!;
			const sub = await child.submit({ type: "input", content: task.input.task, requestId: `delegate:${task.id}` }, ctx);
			const settled = await sub.wait(ctx);
			await runtime.commit(async (tx) => {
				const next = (report?: Report) => ({ status: "running", checkpoint: { phase: "report", report } }) as const;
				if (settled.status === "unanswered") return next(settled.reason === "aborted" ? undefined : failure(settled.reason));
				if (settled.type !== "input") return next();
				const answer = (await tx.entry(AssistantEntry, settled.answer))?.model?.[0] as AssistantMessage | undefined;
				return next({ text: textOf(answer) });
			}, ctx);
		},
		report: async (task, runtime, ctx) => {
			const report = task.state.checkpoint.report;
			if (report !== undefined) {
				const caller = (await runtime.conversation(runtime.conversationId, ctx))!;
				await caller.submit(reportInput(task.input.bot, task.input.task, task.input.call, report, `delegate-report:${task.id}`), ctx);
			} else {
				await noteStopped(deps, runtime.conversationId as number, task.input);
			}
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), ctx);
		},
	},
	abort: async (task, runtime, ctx) => {
		await noteStopped(deps, runtime.conversationId as number, task.input);
		await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx);
	},
});

type RemoteInput = { bot: string; task: string; key: string; attention: string; call?: string };
type RemoteState = { phase: "start" } | { phase: "wait"; sessionId: string } | { phase: "report"; report: Report | string };

/**
 * wait: false for a bot on another machine. A background task (owned by the caller's conversation)
 * starts a chat there, records its id, then submits the task under a fixed key and waits for the answer,
 * reconnecting as needed; after a restart it resumes that same chat and the key keeps the task from being
 * sent twice. The answer, or why there is none, is posted back into the caller's chat.
 */
function remoteReporter(deps: DelegateDeps) {
	return defineTask<RemoteInput, RemoteState, null>({
		name: "nh.delegate-remote",
		version: 1,
		initial: () => ({ phase: "start" }),
		phases: {
			start: async (task, runtime, ctx) => {
				let next: RemoteState;
				try {
					const target = deps.bots().get(task.input.bot);
					if (!target?.isPeer) throw new Error(`${task.input.bot} is no longer in the network`);
					next = { phase: "wait", sessionId: await createPeerSession(peerTarget(deps, target)) };
				} catch (error) {
					next = { phase: "report", report: failure(error) };
				}
				await runtime.commit(() => ({ status: "running", checkpoint: next }), ctx);
			},
			wait: async (task, runtime, ctx) => {
				const { bot, attention } = task.input;
				const checkpoint = task.state.checkpoint as Extract<RemoteState, { phase: "wait" }>;
				let report: Report;
				try {
					const target = deps.bots().get(bot);
					if (!target?.isPeer) throw new Error(`${bot} is no longer in the network`);
					const machine = target.remote?.node ?? new URL(peerTarget(deps, target).url).host;
					const r = await runOnPeer(peerTarget(deps, target), task.input.task, {
						key: task.input.key,
						sessionId: checkpoint.sessionId,
						onApproval: (p) =>
							deps.approvals().relay(
								p,
								{
									sessionId: attention,
									bot,
									description: `${fromMachine(machine, p.description)} (asked by ${target.displayName} on another machine, for a task running in the background)`,
									patternKey: `peer:${bot}:${p.patternKey}`,
								},
								ctx.abortSignal ?? new AbortController().signal,
							),
						signal: ctx.abortSignal,
						timeoutMs: 24 * 3600_000,
						maxAttempts: 1000,
					});
					report = { text: r.text };
				} catch (error) {
					if (ctx.abortSignal?.aborted) throw error;
					report = failure(error);
				}
				await runtime.commit(() => ({ status: "running", checkpoint: { phase: "report", report } }), ctx);
			},
			report: async (task, runtime, ctx) => {
				const checkpoint = task.state.checkpoint as Extract<RemoteState, { phase: "report" }>;
				const caller = (await runtime.conversation(runtime.conversationId, ctx))!;
				await caller.submit(reportInput(task.input.bot, task.input.task, task.input.call, checkpoint.report, `delegate-report:${task.id}`), ctx);
				await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), ctx);
			},
		},
		abort: async (task, runtime, ctx) => {
			// Stopped while the other machine works on it: stop it there too. Best effort and not awaited, so an
			// offline machine does not hold up the owner's Stop.
			const checkpoint = task.state.checkpoint;
			const target = deps.bots().get(task.input.bot);
			if (checkpoint.phase === "wait" && target?.isPeer) {
				void (async () => {
					const c = await ApiClient.open(peerTarget(deps, target), task.input.bot);
					try {
						await c.call("sessions.interrupt", { id: checkpoint.sessionId }, 10_000);
					} finally {
						c.close();
					}
				})().catch(() => undefined);
			}
			await noteStopped(deps, runtime.conversationId as number, task.input);
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx);
		},
	});
}

export function delegateExtension(deps: DelegateDeps): { extension: Extension; tools: ToolRegistration[] } {
	const RemoteReporter = remoteReporter(deps);
	const Reporter = reporter(deps);
	const tool = defineTool({
		name: "delegate",
		description:
			"Ask another bot to do a task and get its result. The other bot works with its own tools, model and memory. " +
			"wait: true (default) returns its answer as this tool's result; wait: false returns at once and its answer " +
			"arrives later as a new message in this chat.",
		parameters: Type.Object({
			bot: Type.String({ description: "Name of the bot to ask (see the bots list in your instructions)" }),
			task: Type.String({ description: "A self-contained description of the task, with everything the other bot needs" }),
			wait: Type.Optional(Type.Boolean()),
		}),
		replay: "safe",
		execute: async (args, api, ctx) => {
			const sessions = deps.sessions();
			const caller = sessions.byConversation(api.conversationId as number);
			// A private bot answers as if it did not exist, so its name is not revealed.
			const target = deps.bots().get(args.bot);
			if (!caller) throw new Error("this conversation is not a known session");
			if (!target || (target.private && target.name !== caller.bot)) {
				const known = deps.bots().list().filter((b) => !b.private).map((b) => b.name);
				throw new Error(`there is no bot named "${args.bot}"; known bots: ${known.join(", ")}`);
			}
			if (target.name === caller.bot) throw new Error("delegate to a different bot; you can do your own work directly");
			if (depth(sessions, caller.id) >= deps.maxDepth) throw new Error(`delegation depth limit (${deps.maxDepth}) reached`);
			if (target.isPeer && args.wait === false) {
				const attention = deps.attentionSession(caller.id);
				await api.commit(async (tx) => {
					await tx.createTask(RemoteReporter, { bot: target.name, task: args.task, key: `delegate:${api.taskId}`, attention, call: api.callId }, { ownership: { kind: "conversation" }, background: true });
				}, ctx);
				await api.details({ peer: target.name, background: true }, ctx);
				return { output: [{ type: "text", text: `Delegated to ${target.name} on another machine. Its answer will arrive as a new message.` }] };
			}
			if (target.isPeer) {
				const where = peerTarget(deps, target);
				const machine = target.remote?.node ?? new URL(where.url).host;
				// The remote session survives a rerun of this call (memo), and the submission key deduplicates it there.
				const remembered = await api.memo<string>("peer-session", ctx);
				const attention = deps.attentionSession(caller.id);
				const r = await runOnPeer(where, args.task, {
					key: `delegate:${api.taskId}`,
					sessionId: remembered,
					failFast: target.remote ? `${target.remote.node} is offline (its bots cannot be reached right now)` : undefined,
					onSession: async (id) => void (await api.memo("peer-session", id, ctx)),
					onApproval: (p) =>
						deps.approvals().relay(
							p,
							{
								sessionId: attention,
								bot: target.name,
								description: `${fromMachine(machine, p.description)} (asked by ${target.displayName} on another machine)`,
								patternKey: `peer:${target.name}:${p.patternKey}`,
							},
							ctx.abortSignal ?? new AbortController().signal,
						),
					signal: ctx.abortSignal,
				});
				await api.details({ peer: target.name, remoteSession: r.sessionId }, ctx);
				return { output: [{ type: "text", text: `${target.name} answered (on ${machine}, session ${r.sessionId}):\n\n${r.text}` }] };
			}
			const change = deps.agentFor(target);
			const title = `From ${caller.bot}: ${args.task.replace(/\s+/g, " ").slice(0, 60)}`;

			if (args.wait === false) {
				const childId = await api.commit(async (tx) => {
					const background = { ownership: { kind: "conversation" }, background: true } as const;
					const anchor = await tx.createTask(Anchor, null, background);
					const child = await tx.createConversation({ ownership: { kind: "task", taskId: anchor } });
					await configure(tx, child.id, change);
					await tx.createTask(Reporter, { bot: target.name, childId: child.id as number, task: args.task, call: api.callId }, background);
					return child.id as number;
				}, ctx);
				const row = sessions.register(childId, target.name, { kind: "delegate", parentId: caller.id, title, source: "delegate" });
				await sessions.live(row.id);
				await api.details({ sessionId: row.id, bot: target.name }, ctx);
				return { output: [{ type: "text", text: `Delegated to ${target.name} (session ${row.id}). Its answer will arrive as a new message.` }] };
			}

			const childId = await api.commit(async (tx) => {
				const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
				if (existing !== undefined) return existing.id as number;
				const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
				await configure(tx, created.id, change);
				return created.id as number;
			}, ctx);
			const row = sessions.register(childId, target.name, { kind: "delegate", parentId: caller.id, title, source: "delegate" });
			await sessions.live(row.id);
			await api.details({ sessionId: row.id, bot: target.name }, ctx);
			const child = (await api.conversation(childId as ConversationId, ctx))!;
			const sub = await child.submit({ type: "input", content: args.task, requestId: `delegate:${api.taskId}` }, ctx);
			const settled = await sub.wait(ctx);
			if (settled.status === "unanswered") throw new Error(`${target.name} did not finish: ${settled.reason}`);
			if (settled.type !== "input") throw new Error("unexpected settlement");
			const answer = await api.commit(async (tx) => (await tx.entry(AssistantEntry, settled.answer))?.model?.[0] as AssistantMessage | undefined, ctx);
			return { output: [{ type: "text", text: `${target.name} answered (session ${row.id}):\n\n${textOf(answer)}` }] };
		},
	});
	return {
		extension: defineExtension({ name: "delegation", tasks: [Anchor, Reporter, RemoteReporter] }),
		tools: [tool as ToolRegistration],
	};
}
