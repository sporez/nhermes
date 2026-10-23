// Chat commands: the built-ins a chat runs itself (/compact, /usage, /status) and a bot's skills, which
// become a prompt that has the bot load and follow the skill. Shared by the API layers.
import type { Engine } from "../engine/engine.ts";
import type { Skills } from "../skills/skills.ts";
import type { Bot } from "./bots.ts";
import type { Sessions } from "./sessions.ts";

export type CommandInfo = { name: string; description: string; kind: "builtin" | "skill"; takesText: boolean; usage?: number; origin?: "bot" | "global" };

/** What running a command gave: text to show, or a prompt for the client to send. */
export type CommandResult = { kind: "output"; text: string } | { kind: "prompt"; text: string };

export class CommandError extends Error {
	override name = "CommandError";
}

/** `new` is the client's own (it starts a new chat); the gateway runs the others. */
export const BUILTIN_COMMANDS: readonly { name: string; description: string; takesText: boolean }[] = [
	{ name: "new", description: "Start a new chat", takesText: false },
	{ name: "compact", description: "Compress this chat's context", takesText: true },
	{ name: "usage", description: "Show token usage for this chat", takesText: false },
	{ name: "status", description: "Show this chat's bot, model and state", takesText: false },
];

export type CommandDeps = { sessions: Sessions; engine: Engine; skills: Skills };

export function commandCatalog(d: CommandDeps, bot: Bot): CommandInfo[] {
	const usage = d.skills.usage(bot.name);
	const skills = d.skills.active(bot).filter((s) => s.modelInvocable);
	return [
		...BUILTIN_COMMANDS.map((c) => ({ ...c, kind: "builtin" as const })),
		...skills.map((s) => ({ name: s.name, description: s.description, kind: "skill" as const, takesText: true, usage: usage.get(s.name) ?? 0, origin: s.source === "bot" ? ("bot" as const) : ("global" as const) })),
	];
}

/** Runs `/name args` in a chat. A skill's name wins over nothing; an unknown name throws CommandError. */
export async function runCommand(d: CommandDeps, bot: Bot, sessionId: string, name: string, args: string): Promise<CommandResult> {
	const skill = d.skills.find(bot, name);
	if (skill) return { kind: "prompt", text: `Use the "${skill.name}" skill (load it with the skill tool first)${args ? ` for: ${args}` : "."}` };
	const row = d.sessions.require(sessionId);
	switch (name.toLowerCase()) {
		case "compact":
		case "compress":
			await d.engine.compact(row.conversation_id, args || undefined);
			return { kind: "output", text: "Compaction started." };
		case "usage": {
			const u = await d.sessions.usage(sessionId);
			return { kind: "output", text: [`Model ${u.model}`, `input ${u.input}`, `output ${u.output}`, `cache read ${u.cacheRead}`, `context ${u.contextUsed} / ${u.contextMax}`, `cost $${u.costUsd.toFixed(4)}`].join("\n") };
		}
		case "status": {
			const agent = await d.engine.agentModel(row.conversation_id);
			const model = agent.model ? `${agent.model.provider}/${agent.model.modelId}` : "none";
			return { kind: "output", text: `Bot ${row.bot} · model ${model} · reasoning ${agent.thinking} · ${d.sessions.isRunning(sessionId) ? "running" : "idle"}` };
		}
		default:
			throw new CommandError(`Unknown command /${name}.`);
	}
}
