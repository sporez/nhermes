// A bot knowing nHermes: the `about` prompt section (what this is, the bot's live settings, where the
// docs are, how things change) for bots that have the `self` tool group.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { configView } from "../admin.ts";
import { ConfigError } from "../config.ts";
import type { Core, Feature, LateServices } from "../app.ts";
import type { Bot } from "../core/bots.ts";
import type { BotPatch, Settings } from "../core/settings.ts";
import type { Skills } from "../skills/skills.ts";

/** The install directory, resolved from the running code (README.md, ARCHITECTURE.md, docs/). */
export const INSTALL_DIR = resolve(import.meta.dirname, "..", "..");

export type SelfServices = {
	skills: Skills;
	view: Pick<Core, "config" | "toolGroups" | "bots">;
	settings: () => Settings;
	/** Whether "provider/model" names a model the gateway can use. */
	modelExists: (ref: string) => boolean;
};

/** What `self_update` may change in the calling bot's own entry; the rest grants privileges or reaches other bots' data. */
export const SELF_FIELDS = ["displayName", "description", "instructions", "model", "thinking", "skills"] as const;

/** A line diff (`-` removed, `+` added, context trimmed) for approval cards. */
export function lineDiff(before: string, after: string): string {
	const a = before.split("\n");
	const b = after.split("\n");
	if (a.length * b.length > 4_000_000) return `(too long to compare)\n${after.slice(0, 2000)}`;
	const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
	for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
	const out: string[] = [];
	let i = 0;
	let j = 0;
	while (i < a.length || j < b.length) {
		if (i < a.length && j < b.length && a[i] === b[j]) (out.push(`  ${a[i]}`), i++, j++);
		else if (j < b.length && (i === a.length || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) out.push(`+ ${b[j++]}`);
		else out.push(`- ${a[i++]}`);
	}
	const keep = out.map((l, k) => !l.startsWith("  ") || out.slice(Math.max(0, k - 2), k + 3).some((x) => !x.startsWith("  ")));
	return out.filter((_, k) => keep[k]).join("\n");
}

function fieldChange(label: string, before: unknown, after: unknown): string {
	const show = (v: unknown) => (v === undefined || v === null ? "(unset)" : typeof v === "string" ? v : JSON.stringify(v));
	const [b, a] = [show(before), show(after)];
	return b.includes("\n") || a.includes("\n") || b.length + a.length > 120 ? `${label}:\n${lineDiff(b === "(unset)" ? "" : b, a)}` : `${label}: ${b} → ${a}`;
}

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

/** The change a config tool call would make, for the owner's approval card. */
export function describeConfigCall(services: SelfServices, bot: Bot, name: string, args: Record<string, unknown>): string | undefined {
	if (name === "self_update") {
		const cur = services.view.bots.get(bot.name)?.config;
		return [`Change ${bot.name}'s own setup:`, ...SELF_FIELDS.filter((k) => args[k] !== undefined).map((k) => fieldChange(k, cur?.[k] ?? (k === "instructions" ? bot.instructions : undefined), args[k]))].join("\n");
	}
	if (name === "self_skill_write" || name === "self_skill_delete") {
		const skillName = String(args.name);
		const old = join(bot.skillsDir, skillName, "SKILL.md");
		if (name === "self_skill_delete") return `Delete ${bot.name}'s skill "${skillName}"`;
		const extra = Object.keys((args.files as object) ?? {});
		return [`Write ${bot.name}'s skill "${skillName}"${extra.length ? ` (+ files: ${extra.join(", ")})` : ""}:`, lineDiff(existsSync(old) ? readFileSync(old, "utf8") : "", String(args.skillMd ?? ""))].join("\n");
	}
	return undefined;
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

	const audit = (api: { conversationId: unknown }, bot: Bot, tool: string, detail: unknown) => {
		const row = late.sessions().byConversation(api.conversationId as number);
		late.db.run("INSERT INTO audit (at, bot, session_id, kind, detail) VALUES (?, ?, ?, ?, ?)", Date.now() / 1000, bot.name, row?.id ?? null, `config.${tool}`, JSON.stringify(detail).slice(0, 4000));
	};
	const wrap = <T>(fn: () => T): T => {
		try {
			return fn();
		} catch (error) {
			if (error instanceof ConfigError) throw new Error(error.message);
			throw error;
		}
	};

	const update = defineTool({
		name: "self_update",
		description:
			"Change your own setup: displayName, description, instructions (replaces them), model (provider/model), thinking, skills (global skills you opt into, by name). " +
			"Tools, trust, approvals and the other settings are not yours to change. The owner is asked to approve every change.",
		parameters: Type.Object({
			displayName: Type.Optional(Type.String()),
			description: Type.Optional(Type.String()),
			instructions: Type.Optional(Type.String()),
			model: Type.Optional(Type.String()),
			thinking: Type.Optional(Type.String()),
			skills: Type.Optional(Type.Array(Type.String())),
		}),
		replay: "safe",
		execute: async (args, api) => {
			const bot = botOf(api.conversationId as number);
			const patch = args as Record<string, unknown>;
			const extra = Object.keys(patch).filter((k) => !(SELF_FIELDS as readonly string[]).includes(k));
			if (extra.length > 0) throw new Error(`you cannot change ${extra.join(", ")} yourself; ask the owner (or a trusted bot) to`);
			const keys = SELF_FIELDS.filter((k) => patch[k] !== undefined);
			if (keys.length === 0) throw new Error("nothing to change");
			if (typeof args.model === "string" && !services.modelExists(args.model)) throw new Error(`unknown model "${args.model}" (use provider/model)`);
			const edit = Object.fromEntries(keys.map((k) => [k, patch[k]])) as BotPatch;
			wrap(() => services.settings().withBackup(() => services.settings().editBot(bot.name, edit)));
			audit(api, bot, "self_update", { fields: keys, patch: edit });
			return text(`Updated ${keys.join(", ")}. It applies from your next message.`);
		},
	});
	const skillWrite = defineTool({
		name: "self_skill_write",
		description:
			"Create or replace one of your own skills: name (lowercase, hyphens) and skillMd, the whole SKILL.md including its frontmatter (name, description). " +
			"files adds supporting files by relative path. The owner is asked to approve.",
		parameters: Type.Object({ name: Type.String(), skillMd: Type.String(), files: Type.Optional(Type.Record(Type.String(), Type.String())) }),
		replay: "safe",
		execute: async (args, api) => {
			const bot = botOf(api.conversationId as number);
			const written = services.skills.write(bot.skillsDir, args.name, args.skillMd, args.files);
			audit(api, bot, "self_skill_write", { skill: args.name, files: written });
			return text(`Wrote skill "${args.name}" (${written.join(", ")}). It is active from your next message.`);
		},
	});
	const skillDelete = defineTool({
		name: "self_skill_delete",
		description: "Delete one of your own skills by name. The owner is asked to approve.",
		parameters: Type.Object({ name: Type.String() }),
		replay: "safe",
		execute: async (args, api) => {
			const bot = botOf(api.conversationId as number);
			services.skills.remove(bot.skillsDir, args.name);
			audit(api, bot, "self_skill_delete", { skill: args.name });
			return text(`Deleted skill "${args.name}".`);
		},
	});

	return {
		groups: new Map([["self", [info, docs, update, skillWrite, skillDelete] as ToolRegistration[]]]),
		promptParts: [(bot) => (bot.toolGroups.includes("self") ? aboutText(late, services, bot) : undefined)],
	};
}
