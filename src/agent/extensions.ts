// Durable extensions that make a conversation behave as its bot: the `persona` prompt section and the
// `guard` approval hook. Both resolve the bot from the conversation at each use, so editing a bot
// applies to all its sessions on their next request.
import type { Context } from "@earendil-works/chord/context";
import { defineExtension, type Extension, hook, section, ToolTask } from "@earendil-works/pi-durable";
import type { Approvals } from "../core/approvals.ts";
import type { Bot } from "../core/bots.ts";
import { decide } from "../core/policy.ts";
import type { Sessions } from "../core/sessions.ts";
import { logger } from "../log.ts";

const log = logger("guard");

/** Extra prompt sections contributed by features (memory, skills); each returns text or nothing. */
export type PromptPart = (bot: Bot, sessionId: string) => string | undefined | Promise<string | undefined>;

export type AgentDeps = {
	sessions: () => Sessions;
	approvals: () => Approvals;
	timezone: string;
	promptParts: PromptPart[];
	/** The session whose clients are asked for a session's approvals (a delegation's root chat). */
	attentionSession: (sessionId: string) => string;
	/** Bots of the sessions that delegated to this one, nearest first (empty for a root session). */
	delegationChain: (sessionId: string) => Bot[];
	/** Session kinds with no client to ask (jobs): how a needed approval is answered. */
	unattendedPolicy: (sessionId: string) => "deny" | "allow" | "ask";
};

function today(tz: string): string {
	return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", weekday: "long" }).format(new Date());
}

export function personaExtension(deps: AgentDeps): Extension {
	return defineExtension({
		name: "persona",
		sections: [
			section(
				"persona",
				async (input) => {
					const sessions = deps.sessions();
					const row = sessions.byConversation(input.conversationId as number);
					const bot = sessions.botOf(input.conversationId as number);
					if (!bot || !row) return undefined;
					const parts = [bot.instructions.trim()];
					parts.push(`You are the bot "${bot.displayName}" (id ${bot.name}). Today is ${today(deps.timezone)} (${deps.timezone}).`);
					for (const part of deps.promptParts) {
						const text = await part(bot, row.id);
						if (text) parts.push(text.trim());
					}
					return parts.join("\n\n");
				},
				{ tag: false },
			),
		],
	});
}

export function guardExtension(deps: AgentDeps): Extension {
	return defineExtension({
		name: "guard",
		hooks: [
			hook(ToolTask, {
				beforeTool: async (call, api, context: Context) => {
					const sessions = deps.sessions();
					const row = sessions.byConversation(api.conversationId as number);
					const bot = sessions.botOf(api.conversationId as number);
					if (!row || !bot) return { block: "this conversation has no bot" };
					const approvals = deps.approvals();
					const attention = deps.attentionSession(row.id);
					const sessionRules = [...new Set([...approvals.rules(`session:${row.id}`), ...approvals.rules(`session:${attention}`)])];
					// Privileges never escalate through delegation: a delegated task is trusted only if every bot
					// in the chain is, and runs under the strictest approval mode in the chain.
					const chain = deps.delegationChain(row.id);
					const order = { manual: 0, smart: 1, off: 2 } as const;
					const mode = [bot, ...chain].map((b) => b.approvals.mode).reduce((a, m) => (order[m] < order[a] ? m : a));
					const effective: Bot = { ...bot, trusted: bot.trusted && chain.every((b) => b.trusted), approvals: { ...bot.approvals, mode } };
					const decision = decide(
						{ name: call.name, arguments: call.arguments as Record<string, unknown> },
						{ bot: effective, sessionRules, botRules: approvals.rules(`bot:${bot.name}`), yolo: approvals.isYolo(attention) },
					);
					if (decision.action === "allow") return undefined;
					if (decision.action === "deny") return { block: decision.description };
					const unattended = deps.unattendedPolicy(attention);
					if (unattended === "allow") return undefined;
					if (unattended === "deny") return { block: `needs the owner's approval (${decision.description}) and nobody is attending this run` };
					const controller = new AbortController();
					context.abortSignal?.addEventListener("abort", () => controller.abort(), { once: true });
					const choice = await approvals.ask(
						{
							sessionId: attention,
							bot: bot.name,
							toolName: call.name,
							command: decision.command,
							description: attention === row.id ? decision.description : `${decision.description} (asked by ${bot.displayName} in a delegated task)`,
							patternKey: decision.patternKey,
						},
						controller.signal,
					);
					log.info("approval", { session: row.id, tool: call.name, pattern: decision.patternKey, choice });
					if (choice === "deny") return { block: `the owner did not approve this (${decision.description})` };
					return undefined;
				},
			}),
		],
	});
}
