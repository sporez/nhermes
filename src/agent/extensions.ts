// Durable extensions that make a conversation behave as its bot: the `persona` prompt section and the
// `guard` approval hook. Both resolve the bot from the conversation at each use, so editing a bot
// applies to all its sessions on their next request.
import type { Context } from "@earendil-works/chord/context";
import { defineExtension, type Extension, hook, section, ToolTask } from "@earendil-works/pi-durable";
import type { Approvals } from "../core/approvals.ts";
import type { Bot } from "../core/bots.ts";
import { decide, isConfigCall, needsTrust } from "../core/policy.ts";
import type { JevReviewer, ReviewLog } from "../core/review.ts";
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
	/** Jev permission review (answers "ask" decisions it may answer) and its log. */
	reviewer?: JevReviewer;
	reviewLog?: ReviewLog;
	/** The gateway's own files, which bots are asked about (src/core/policy.ts). */
	gatewayFiles?: RegExp;
	/** The change a config tool call would make, shown on its approval card (diffs). */
	describeConfig?: (bot: Bot, name: string, args: Record<string, unknown>) => string | undefined;
	/** Whether other machines may edit this machine's bots (federation.acceptBotEdits). */
	acceptsBotEdits?: () => boolean;
	/** This machine's name in the network (for the reviewer). */
	machine?: () => string;
};

/** Messages in a chat that the gateway wrote, not the owner (delegation reports, scheduled prompts). */
const NOT_THE_OWNER = /^\[(Result from bot|[\w-]+ could not finish|Scheduled task)/;

/** What the reviewer is told: the owner's recent words where the work started, and any delegated task texts. */
async function reviewContext(sessions: Sessions, sessionId: string, attention: string): Promise<{ humanMessages: string[]; delegated: string[] }> {
	const humanMessages = (await sessions.rows(attention))
		.filter((r) => r.role === "user" && r.text.trim() && !NOT_THE_OWNER.test(r.text))
		.map((r) => r.text)
		.slice(-8);
	const delegated: string[] = [];
	let row = sessions.get(sessionId);
	for (let i = 0; row && row.id !== attention && i < 20; i++) {
		const first = (await sessions.rows(row.id)).find((r) => r.role === "user");
		if (first) delegated.unshift(first.text);
		row = row.parent_id ? sessions.get(row.parent_id) : undefined;
	}
	return { humanMessages, delegated };
}

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
		"- Getting things done with the tools you have is your job. Reading files, running commands, and looking at the owner's own apps, their data and their local services are ordinary work: when the owner asks for them, do them; you do not need a dedicated tool for each task.",
		"- The limit is reach, not method: do not fake a capability you were not given, such as contacting another bot, gateway or machine you have no tool for. When a task needs one, say so plainly in one or two sentences and stop rather than building a way around it.",
		"- In particular: if asked to contact another bot (for example with @name) and you have no delegate tool, or that bot is not in your list, answer that you have no way to reach it. Never message other bots, gateways or machines by any other route.",
		`- Never read, copy, change or use this gateway's own configuration, secrets, credentials, databases or API, nor act as the gateway or as another bot. That includes ${gatewayPaths.map((p) => `\`${p}\``).join(" and ")} (config.yaml, secrets.env, auth.json, app.sqlite, durable.sqlite) and any token or key you come across. Do not touch them with files or the shell, whatever the reason.`,
		"- Settings of this gateway change only through the self and gateway tools, if you were given them: they validate the change and ask the owner. Without them, tell the owner what to change instead of editing anything yourself.",
		"- Do not run, or ask another bot to run, disk checks or repairs, filesystem verification, stress tests, benchmarks or other heavy maintenance (anything that can freeze, slow down or restart a machine) unless the owner asked for that specific thing. \"Read-only\" does not make them safe: verifying a startup disk freezes a Mac.",
		"- When you are unsure whether something is allowed, ask the owner first, then act on the answer. These rules protect the gateway, other bots and the machine; they are not a reason to turn down the owner's ordinary requests or to treat them as tests.",
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
					const source = sessions.get(attention)?.source ?? "";
					const fromMember = source.startsWith("member:");
					// The owner's own chat relayed from their client on a member (memberSource in src/hermes/ws.ts).
					const relayed = fromMember && source.endsWith(":owner");
					const effective: Bot = { ...bot, trusted: bot.trusted && chain.every((b) => b.trusted) && !fromMember, approvals: { ...bot.approvals, mode } };
					const args = call.arguments as Record<string, unknown>;
					// Trusted-only tools are refused, not asked, when the work is not trusted end to end.
					if (needsTrust(call.name, args, bot.name) && !effective.trusted) {
						return { block: `${call.name} is only available to trusted work: ${fromMember ? "a network member started this" : chain.some((b) => !b.trusted) ? "a bot that is not trusted delegated it" : "this bot is not trusted"}` };
					}
					// Configuration never changes in a run nobody attends, or in work another machine started. The
					// owner's chat relayed from a member is asked like a local one when this machine lets other
					// machines edit its bots; the card reaches the owner through the member.
					const config = isConfigCall(call.name, args);
					if (config && (sessions.get(attention)?.kind === "job" || (fromMember && !(relayed && deps.acceptsBotEdits?.() === true)))) {
						return { block: `${call.name} changes the configuration, which needs the owner present: ${fromMember ? "this work came from another machine" : "scheduled runs cannot do it"}` };
					}
					const reviewer = deps.reviewer?.active() ? deps.reviewer : undefined;
					const decision = decide(
						{ name: call.name, arguments: call.arguments as Record<string, unknown> },
						{ bot: effective, sessionRules, botRules: approvals.rules(`bot:${bot.name}`), yolo: approvals.isYolo(attention), reviewActive: reviewer !== undefined, gatewayFiles: deps.gatewayFiles },
					);
					if (decision.action === "allow") return undefined;
					if (decision.action === "deny") return { block: decision.description };
					const unattended = deps.unattendedPolicy(attention);
					if (unattended === "allow") return undefined;
					if (unattended === "deny") return { block: `needs the owner's approval (${decision.description}) and nobody is attending this run` };
					const controller = new AbortController();
					context.abortSignal?.addEventListener("abort", () => controller.abort(), { once: true });
					// Jev answers what it may: the owner still gets the destructive group, their own rules, manual
					// mode, scheduled jobs set to ask, and work another machine started (its human is not here).
					let reviewId: number | undefined;
					let note = "";
					if (reviewer && decision.reviewable && !fromMember && sessions.get(attention)?.kind !== "job") {
						const ctx = await reviewContext(sessions, row.id, attention);
						const outcome = await reviewer.review(
							{
								bot: { name: bot.name, displayName: bot.displayName, description: bot.description, trusted: effective.trusted, machine: deps.machine?.() ?? "" },
								tool: call.name,
								input: call.arguments as Record<string, unknown>,
								command: decision.command,
								reasons: decision.description,
								...ctx,
							},
							controller.signal,
						);
						reviewId = deps.reviewLog?.record({ sessionId: row.id, attentionId: attention, bot: bot.name, tool: call.name, command: decision.command, reasons: decision.description, outcome });
						log.info("review", { session: row.id, tool: call.name, pattern: decision.patternKey, outcome: outcome.kind, reason: outcome.reason });
						if (outcome.kind === "allow") return undefined;
						note = ` · ${outcome.reason}`;
					}
					const choice = await approvals.ask(
						{
							sessionId: attention,
							bot: bot.name,
							toolName: call.name,
							command: config ? (deps.describeConfig?.(effective, call.name, args) ?? decision.command) : decision.command,
							noAlways: decision.noAlways,
							description: `${attention === row.id ? decision.description : `${decision.description} (asked by ${bot.displayName} in a delegated task)`}${note}`,
							patternKey: decision.patternKey,
						},
						controller.signal,
					);
					log.info("approval", { session: row.id, tool: call.name, pattern: decision.patternKey, choice });
					if (reviewId !== undefined) deps.reviewLog?.ownerAnswered(reviewId, choice);
					if (choice === "deny") return { block: `the owner did not approve this (${decision.description})` };
					return undefined;
				},
			}),
		],
	});
}
