// The `skill` tool (load a skill's instructions) and the prompt part listing active skills by name and
// description only. Skill files live on the gateway, so they are read here, not through the bot's
// execution environment (which may be a remote host).
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import type { Feature, LateServices } from "../app.ts";
import type { Skills } from "../skills/skills.ts";

export function sessionSkills(late: LateServices, sessionId: string): string[] {
	const row = late.db.get<{ skills: string }>("SELECT skills FROM sessions WHERE id = ?", sessionId);
	try {
		return row ? (JSON.parse(row.skills) as string[]) : [];
	} catch {
		return [];
	}
}

export function skillsFeature(late: LateServices, skills: Skills): Feature {
	const context = (conversationId: number) => {
		const row = late.sessions().byConversation(conversationId);
		const bot = late.sessions().botOf(conversationId);
		if (!row || !bot) throw new Error("this conversation has no bot");
		return { bot, attached: sessionSkills(late, row.id) };
	};

	const skill = defineTool({
		name: "skill",
		description:
			"Load a skill's instructions by name (from the skills list in your instructions). Read it before doing a task the " +
			"skill covers, then follow it. With file, read one of the skill's supporting files instead.",
		parameters: Type.Object({ name: Type.String(), file: Type.Optional(Type.String({ description: "A path relative to the skill directory" })) }),
		replay: "safe",
		execute: async (args, api) => {
			const { bot, attached } = context(api.conversationId as number);
			const found = skills.find(bot, args.name, attached);
			if (!found) {
				const names = skills.active(bot, attached).map((s) => s.name);
				throw new Error(`no active skill "${args.name}"${names.length ? `; active: ${names.join(", ")}` : ""}`);
			}
			if (args.file) return { output: [{ type: "text", text: skills.readFile(found, args.file) }] };
			skills.noteUse(bot.name, found.name);
			const files = skills.files(found);
			const extra = files.length ? `\n\n---\nFiles in this skill (read with file): ${files.join(", ")}` : "";
			return { output: [{ type: "text", text: skills.body(found) + extra }] };
		},
	});

	return {
		groups: new Map([["skills", [skill as ToolRegistration]]]),
		promptParts: [
			(bot, sessionId) => {
				if (!bot.toolGroups.includes("skills")) return undefined;
				const active = skills.active(bot, sessionSkills(late, sessionId)).filter((s) => s.modelInvocable);
				if (active.length === 0) return undefined;
				return [
					"Skills: specialised instructions you can load with the skill tool when a task matches one. Load before acting; do not guess their contents. " +
						"The skill tool is the only way to read them (file for a skill's other files): they are kept with the gateway's configuration, not on disk where you can reach them, so a script a skill runs belongs in your workspace.",
					...active.map((s) => `- ${s.name}: ${s.description}`),
				].join("\n");
			},
		],
	};
}
