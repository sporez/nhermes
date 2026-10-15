// Durable extensions that make a conversation behave as its bot: the `persona` prompt section and the
// `guard` approval hook. Both resolve the bot from the conversation at each use, so editing a bot
// applies to all its sessions on their next request.
import type { Context } from "@earendil-works/chord/context";
import { defineExtension, type Extension, hook, section, ToolTask } from "@earendil-works/pi-durable";
import type { Approvals } from "../core/approvals.ts";
import type { Bot } from "../core/bots.ts";
import { decide } from "../core/policy.ts";
import type { Sessions } from "../core/sessions.ts";
import { logger, redact } from "../log.ts";

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
	/** The ground rules every bot gets: the owner's text from config.yaml, or the built-in rules. */
	groundRules: () => string;
};

function today(tz: string): string {
	return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", weekday: "long" }).format(new Date());
}

/**
 * Rules every bot gets, whatever its instructions say. A bot's shell runs with the gateway's own
 * permissions, so it could reach the gateway's secrets and other machines; these rules are what keeps
 * a resourceful model from building its own way around a missing tool (the approval guard and the
 * operating-system user are the hard limits).
 */
export function groundRules(gatewayPaths: readonly string[]): string {
	return [
		"Ground rules (these always apply):",
		"- Work only through the tools you were given. If a task needs a capability you do not have, say so plainly in one or two sentences and stop. Do not build a way around it: no scripts, no reading another program's files or databases, no calling APIs on your own to stand in for a missing tool.",
		"- In particular: if asked to contact another bot (for example with @name) and you have no delegate tool, or that bot is not in your list, answer that you have no way to reach it. Never message other bots, gateways or machines by any other route.",
		`- Never read, copy, change or use this gateway's own configuration, secrets, credentials or databases, nor act as the gateway or as another bot. That includes ${gatewayPaths.map((p) => `\`${p}\``).join(" and ")} (config.yaml, secrets.env, auth.json, app.sqlite, durable.sqlite) and any token or key you come across.`,
		"- When you are unsure whether something is allowed, ask the owner first.",
	].join("\n");
}

/**
 * The bot's part of the system prompt: its instructions, who and when it is, the ground rules, and the
 * features' sections (other bots, memory, skills…). `sessionId` "" gives what a new chat would get.
 */
export async function personaText(deps: AgentDeps, bot: Bot, sessionId: string): Promise<string> {
	const p = await personaParts(deps, bot, sessionId);
	return [p.instructions, p.identity, p.groundRules, ...p.generated].filter(Boolean).join("\n\n");
}

/** The same prompt in its pieces: the owner-written ones (instructions, ground rules) and the generated ones. */
export async function personaParts(deps: AgentDeps, bot: Bot, sessionId: string): Promise<{ instructions: string; identity: string; groundRules: string; generated: string[] }> {
	const generated: string[] = [];
	for (const part of deps.promptParts) {
		const text = await part(bot, sessionId);
		if (text) generated.push(text.trim());
	}
	return {
		instructions: bot.instructions.trim(),
		identity: `You are the bot "${bot.displayName}" (id ${bot.name}). Today is ${today(deps.timezone)} (${deps.timezone}).`,
		groundRules: deps.groundRules().trim(),
		generated,
	};
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
					return personaText(deps, bot, row.id);
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
				// Defence in depth: a known secret value never reaches the model or the transcript.
				afterTool: (_call, result) => {
					if (!result.output) return undefined;
					let changed = false;
					const output = result.output.map((block) => {
						if (block.type !== "text") return block;
						const clean = redact(block.text);
						if (clean !== block.text) changed = true;
						return clean === block.text ? block : { ...block, text: clean };
					});
					return changed ? { ...result, output } : undefined;
				},
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
					// Trust does not cross machines: work a network member started is never trusted here.
					const fromMember = sessions.get(attention)?.source.startsWith("member:") === true;
					const effective: Bot = { ...bot, trusted: bot.trusted && chain.every((b) => b.trusted) && !fromMember, approvals: { ...bot.approvals, mode } };
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
