// Agent-to-agent delegation. `delegate` asks another bot to do a task in a child conversation that is
// configured as that bot (its model, tools, instructions) and listed as one of its sessions.
//  - wait: true  → the child is owned by this tool call (Pi Durable foreground subagent pattern); the
//                  answer is the tool result. Replay-safe: a rerun after a crash finds the same child and
//                  the same submission (request id), so the task is not sent twice.
//  - wait: false → the child is owned by a background anchor task; a durable reporter task waits for the
//                  answer and posts it back into the caller's conversation as a follow-up message.
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
import type { Approvals } from "../core/approvals.ts";
import type { Bot, Bots } from "../core/bots.ts";
import type { Sessions } from "../core/sessions.ts";
import { runOnPeer } from "../remote/peer.ts";

export type DelegateDeps = {
	sessions: () => Sessions;
	bots: () => Bots;
	agentFor: (bot: Bot) => AgentChange;
	maxDepth: number;
	approvals: () => Approvals;
	/** The root chat a session's approvals are asked in. */
	attentionSession: (sessionId: string) => string;
};

function textOf(message: AssistantMessage | undefined): string {
	return (message?.content ?? []).flatMap((c) => (c.type === "text" ? [c.text] : [])).join("");
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

type ReporterInput = { bot: string; childId: number; task: string };
type ReporterState = { phase: "deliver" } | { phase: "report"; report?: string };

const Reporter = defineTask<ReporterInput, ReporterState, null>({
	name: "nh.delegate-reporter",
	version: 1,
	initial: () => ({ phase: "deliver" }),
	phases: {
		deliver: async (task, runtime, ctx) => {
			const child = (await runtime.conversation(task.input.childId as ConversationId, ctx))!;
			const sub = await child.submit({ type: "input", content: task.input.task, requestId: `delegate:${task.id}` }, ctx);
			const settled = await sub.wait(ctx);
			await runtime.commit(async (tx) => {
				const next = (report?: string) => ({ status: "running", checkpoint: { phase: "report", report } }) as const;
				if (settled.status === "unanswered") return next(settled.reason === "aborted" ? undefined : `[${task.input.bot} could not finish the delegated task: ${settled.reason}]`);
				if (settled.type !== "input") return next();
				const answer = (await tx.entry(AssistantEntry, settled.answer))?.model?.[0] as AssistantMessage | undefined;
				return next(`[Result from bot "${task.input.bot}" for the task you delegated: "${task.input.task.slice(0, 200)}"]\n\n${textOf(answer)}`);
			}, ctx);
		},
		report: async (task, runtime, ctx) => {
			const report = task.state.checkpoint.report;
			if (report !== undefined) {
				const caller = (await runtime.conversation(runtime.conversationId, ctx))!;
				await caller.submit({ type: "input", content: report, whenBusy: "followUp", requestId: `delegate-report:${task.id}` }, ctx);
			}
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), ctx);
		},
	},
	abort: (_t, runtime, ctx) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
});

export function delegateExtension(deps: DelegateDeps): { extension: Extension; tools: ToolRegistration[] } {
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
			if (target.isPeer) {
				const peer = target.config.peer!;
				const token = process.env[peer.tokenEnv];
				if (!token) throw new Error(`the token for ${target.name} (${peer.tokenEnv}) is not set on this gateway`);
				if (args.wait === false) throw new Error(`${target.name} is on another machine; delegate to it with wait: true`);
				// The remote session survives a rerun of this call (memo), and the submission key deduplicates it there.
				const remembered = await api.memo<string>("peer-session", ctx);
				const attention = deps.attentionSession(caller.id);
				const r = await runOnPeer({ url: peer.url, token, profile: peer.profile }, args.task, {
					key: `delegate:${api.taskId}`,
					sessionId: remembered,
					onSession: async (id) => void (await api.memo("peer-session", id, ctx)),
					onApproval: (p) =>
						deps.approvals().ask(
							{
								sessionId: attention,
								bot: target.name,
								toolName: String(p.tool_name ?? "tool"),
								command: String(p.command ?? ""),
								description: `${String(p.description ?? "needs approval")} (asked by ${target.displayName} on another machine)`,
								patternKey: `peer:${target.name}:${String(p.pattern_key ?? "")}`,
							},
							ctx.abortSignal ?? new AbortController().signal,
						),
					signal: ctx.abortSignal,
				});
				await api.details({ peer: target.name, remoteSession: r.sessionId }, ctx);
				return { output: [{ type: "text", text: `${target.name} answered (on ${new URL(peer.url).host}, session ${r.sessionId}):\n\n${r.text}` }] };
			}
			const change = deps.agentFor(target);
			const title = `From ${caller.bot}: ${args.task.replace(/\s+/g, " ").slice(0, 60)}`;

			if (args.wait === false) {
				const childId = await api.commit(async (tx) => {
					const background = { ownership: { kind: "conversation" }, background: true } as const;
					const anchor = await tx.createTask(Anchor, null, background);
					const child = await tx.createConversation({ ownership: { kind: "task", taskId: anchor } });
					await configure(tx, child.id, change);
					await tx.createTask(Reporter, { bot: target.name, childId: child.id as number, task: args.task }, background);
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
		extension: defineExtension({ name: "delegation", tasks: [Anchor, Reporter] }),
		tools: [tool as ToolRegistration],
	};
}
