// A bot knowing nHermes: the `about` prompt section (what this is, the bot's live settings, where the
// docs are, how things change) for bots that have the `self` tool group.
import { resolve } from "node:path";
import type { Feature, LateServices } from "../app.ts";
import type { Bot } from "../core/bots.ts";
import type { Skills } from "../skills/skills.ts";

/** The install directory, resolved from the running code (README.md, ARCHITECTURE.md, docs/). */
export const INSTALL_DIR = resolve(import.meta.dirname, "..", "..");

export type SelfServices = { skills: Skills };

/** Where this bot's commands run: here, or over SSH. */
function whereCommandsRun(bot: Bot): string {
	const ssh = bot.config.host?.ssh;
	return ssh ? `on ${ssh.user ? `${ssh.user}@` : ""}${ssh.host} over SSH` : "on the gateway's machine";
}

export function aboutText(late: LateServices, services: SelfServices, bot: Bot): string {
	const c = late.config;
	const skills = services.skills.active(bot).map((s) => s.name);
	const jobs = late.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE bot = ?", bot.name)?.n ?? 0;
	const where = c.node.url ? c.node.url.replace(/\/$/, "") : `port ${c.server.port}`;
	const d = (file: string) => `${INSTALL_DIR}/${file}`;
	return [
		"About you and nHermes:",
		`You are a bot in nHermes, a self-hosted agent gateway on the machine "${c.server.publicName}". The owner reaches you through Vory or the web panel (${where}/panel). One process runs the bots, sessions, memory, skills, scheduler and the approval guard.`,
		"Your settings right now:",
		`- model ${bot.model.provider}/${bot.model.modelId}, thinking ${bot.thinking}; approvals ${bot.approvals.mode}${bot.trusted ? "; trusted (an infrastructure bot)" : ""}`,
		`- tool groups: ${bot.toolGroups.join(", ") || "none"}; commands run ${whereCommandsRun(bot)}; workspace ${bot.workspace}`,
		`- active skills: ${skills.join(", ") || "none"}; shared memory: ${bot.sharedMemory.join(", ") || "none"}; scheduled jobs: ${jobs}`,
		`Documentation (read it only when asked about nHermes or yourself; read the whole file): ${INSTALL_DIR}. You can list and read it with nhermes_docs.`,
		`- operations, CLI, config.yaml: ${d("docs/OPERATIONS.md")}; concepts and tools: ${d("ARCHITECTURE.md")}; the network of machines: ${d("docs/FEDERATION.md")}`,
		`- approvals, secrets and the Jev reviewer: ${d("docs/SECRETS-AND-REVIEW.md")}; Vory support: ${d("docs/COMPATIBILITY.md")}; browser and desktop: ${d("docs/COMPUTER_USE.md")}`,
		"How things change:",
		"- You can change your own description, instructions, model, thinking and skills, and your own memory and scheduled jobs. Every settings change asks the owner first, and you never edit config.yaml or the gateway's files yourself.",
		`- Only the owner${bot.trusted ? " or a trusted bot (you are one)" : " or a trusted bot"} can change tools, trust, approvals, hosts, other bots and gateway settings.`,
		"- Only the owner can handle secrets, tokens, the panel password, network invitations and backups. Software updates need a trusted bot and the owner's approval.",
		"- The owner can do all of it in the panel, in Vory, or by editing config.yaml and running `nhermes reload`.",
	].join("\n");
}

export function selfFeature(late: LateServices, services: SelfServices): Feature {
	return {
		groups: new Map([["self", []]]),
		promptParts: [(bot) => (bot.toolGroups.includes("self") ? aboutText(late, services, bot) : undefined)],
	};
}
