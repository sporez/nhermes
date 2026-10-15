// A bot knowing nHermes: the `about` prompt section (what this is, the bot's live settings, where the
// docs are, how things change) for bots that have the `self` tool group.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { configView } from "../admin.ts";
import type { Core, Feature, LateServices } from "../app.ts";
import type { Bot } from "../core/bots.ts";
import type { Skills } from "../skills/skills.ts";

/** The install directory, resolved from the running code (README.md, ARCHITECTURE.md, docs/). */
export const INSTALL_DIR = resolve(import.meta.dirname, "..", "..");

export type SelfServices = { skills: Skills; view: Pick<Core, "config" | "toolGroups" | "bots"> };

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

function text(t: string) {
	return { output: [{ type: "text" as const, text: t }] };
}

/** The documents a bot may read: README.md, ARCHITECTURE.md and docs/*.md under the install directory. */
export function docFiles(): string[] {
	const docs = existsSync(resolve(INSTALL_DIR, "docs")) ? readdirSync(resolve(INSTALL_DIR, "docs")).filter((f) => f.endsWith(".md")).sort() : [];
	return [...["README.md", "ARCHITECTURE.md"].filter((f) => existsSync(resolve(INSTALL_DIR, f))), ...docs.map((f) => `docs/${f}`)];
}

/** Reads one listed document; anything else (traversal, other folders, other types) is refused. */
export function readDoc(file: string): string {
	const rel = relative(INSTALL_DIR, resolve(INSTALL_DIR, file));
	if (!docFiles().includes(rel)) throw new Error(`not a documentation file; available: ${docFiles().join(", ")}`);
	return readFileSync(resolve(INSTALL_DIR, rel), "utf8");
}

export function selfFeature(late: LateServices, services: SelfServices): Feature {
	const botOf = (conversationId: number) => {
		const bot = late.sessions().botOf(conversationId);
		if (!bot) throw new Error("this conversation has no bot");
		return bot;
	};

	const info = defineTool({
		name: "self_info",
		description:
			"Your own configuration in nHermes: the config.yaml entry, what is in effect and runtime overrides (never secrets). " +
			"A trusted bot can pass bot to see another bot, or gateway: true for the gateway's settings and every bot.",
		parameters: Type.Object({ bot: Type.Optional(Type.String()), gateway: Type.Optional(Type.Boolean()) }),
		replay: "safe",
		execute: async (args, api) => {
			const me = botOf(api.conversationId as number);
			if ((args.gateway || (args.bot && args.bot !== me.name)) && !me.trusted) throw new Error("only a trusted bot can look at other bots or the gateway");
			const view = configView(services.view);
			if (args.gateway) return text(JSON.stringify(view, null, 2));
			const entry = view.bots.find((b) => b.name === (args.bot ?? me.name));
			if (!entry) throw new Error(`unknown bot "${args.bot}"`);
			return text(JSON.stringify({ gateway: view.gateway.timezone, toolGroups: view.toolGroups, bot: entry }, null, 2));
		},
	});
	const docs = defineTool({
		name: "nhermes_docs",
		description: "nHermes's own documentation. Without file, lists the documents; with file (as listed), returns the whole document. Read it only when asked about nHermes or yourself.",
		parameters: Type.Object({ file: Type.Optional(Type.String()) }),
		replay: "safe",
		execute: async (args) => text(args.file ? readDoc(args.file) : `${INSTALL_DIR}\n${docFiles().join("\n")}`),
	});

	return {
		groups: new Map([["self", [info, docs] as ToolRegistration[]]]),
		promptParts: [(bot) => (bot.toolGroups.includes("self") ? aboutText(late, services, bot) : undefined)],
	};
}
