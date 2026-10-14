// Bots: persistent agent identities from config.yaml, with runtime overrides (model, instructions,
// description, skill toggles, always-allow rules) stored in app.sqlite. Sessions come and go; a bot does not.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { type ApprovalMode, type BotConfig, type Config, splitModel, type ThinkingLevel } from "../config.ts";
import type { AppDb } from "../store/db.ts";

export type BotOverrides = {
	model?: string;
	thinking?: ThinkingLevel;
	description?: string;
	instructions?: string;
	/** Skill names switched off (per bot). */
	disabledSkills?: string[];
	/** Global skill names switched on beyond config. */
	enabledSkills?: string[];
	private?: boolean;
};

export type Bot = {
	name: string;
	displayName: string;
	description: string;
	isDefault: boolean;
	instructions: string;
	model: { provider: string; modelId: string };
	thinking: ThinkingLevel;
	toolGroups: string[];
	globalSkills: string[];
	disabledSkills: string[];
	sharedMemory: string[];
	approvals: { mode: ApprovalMode; ask: string[]; deny: string[]; allow: string[] };
	trusted: boolean;
	/** Hidden from other bots' rosters and refused as a delegation target; never shared with members. */
	private: boolean;
	/** Mode B: an independent agent on another machine, reached by delegation. */
	isPeer: boolean;
	/** Local working directory (also the Hermes "profile home"). */
	workspace: string;
	/** Per-bot skills directory. */
	skillsDir: string;
	config: BotConfig;
};

export const DEFAULT_TOOL_GROUPS = ["files", "shell", "web", "memory", "skills", "schedule", "delegate", "notify"];

const DEFAULT_INSTRUCTIONS =
	"You are a capable personal assistant running on the owner's own server. Be direct and concise. " +
	"Use your tools to check facts instead of guessing, and say plainly when something failed.";

export class Bots {
	private readonly config: Config;
	private readonly db: AppDb;

	constructor(config: Config, db: AppDb) {
		this.config = config;
		this.db = db;
	}

	names(): string[] {
		return this.config.bots.map((b) => b.name);
	}

	list(): Bot[] {
		return this.config.bots.map((b) => this.resolve(b));
	}

	get(name: string): Bot | undefined {
		const b = this.config.bots.find((x) => x.name === name);
		return b ? this.resolve(b) : undefined;
	}

	require(name: string): Bot {
		const bot = this.get(name);
		if (!bot) throw new UnknownBot(name);
		return bot;
	}

	defaultBot(): Bot {
		return this.resolve(this.config.bots.find((b) => b.default) ?? this.config.bots[0]!);
	}

	overrides(name: string): BotOverrides {
		const row = this.db.get<{ json: string }>("SELECT json FROM bot_overrides WHERE bot = ?", name);
		return row ? (JSON.parse(row.json) as BotOverrides) : {};
	}

	setOverrides(name: string, patch: BotOverrides): Bot {
		this.require(name);
		const next = { ...this.overrides(name), ...patch };
		for (const k of Object.keys(next) as (keyof BotOverrides)[]) if (next[k] === undefined) delete next[k];
		this.db.run(
			"INSERT INTO bot_overrides (bot, json) VALUES (?, ?) ON CONFLICT(bot) DO UPDATE SET json = excluded.json",
			name,
			JSON.stringify(next),
		);
		return this.require(name);
	}

	/** Forgets a bot's runtime overrides (when it is removed, so a new bot of that name starts clean). */
	clearOverrides(name: string): void {
		this.db.run("DELETE FROM bot_overrides WHERE bot = ?", name);
	}

	/** Where a bot's instructions file is (whether or not it exists). */
	soulPath(b: BotConfig): string {
		if (!b.soulFile) return join(this.config.configDir, "bots", b.name, "SOUL.md");
		return isAbsolute(b.soulFile) ? b.soulFile : resolve(this.config.configDir, b.soulFile);
	}

	private resolve(b: BotConfig): Bot {
		const o = this.overrides(b.name);
		const botDir = join(this.config.configDir, "bots", b.name);
		const soulPath = this.soulPath(b);
		const fileSoul = existsSync(soulPath) ? readFileSync(soulPath, "utf8").trim() : "";
		const instructions = o.instructions ?? (b.instructions?.trim() || fileSoul || DEFAULT_INSTRUCTIONS);
		const workspace = b.workspace
			? resolve(this.config.configDir, b.workspace)
			: join(this.config.dataDir, "workspaces", b.name);
		if (!existsSync(workspace)) mkdirSync(workspace, { recursive: true });
		const model = splitModel(o.model ?? b.model ?? this.config.defaults.model);
		const globalSkills = [...new Set([...(b.skills ?? []), ...(o.enabledSkills ?? [])])];
		return {
			name: b.name,
			displayName: b.displayName ?? b.name.charAt(0).toUpperCase() + b.name.slice(1),
			description: o.description ?? b.description ?? "",
			isDefault: b.default === true,
			instructions,
			model,
			thinking: o.thinking ?? b.thinking ?? this.config.defaults.thinking,
			toolGroups: b.tools ?? DEFAULT_TOOL_GROUPS,
			globalSkills,
			disabledSkills: o.disabledSkills ?? [],
			sharedMemory: b.sharedMemory ?? [],
			approvals: {
				mode: b.approvals?.mode ?? this.config.defaults.approvals,
				ask: b.approvals?.ask ?? [],
				deny: b.approvals?.deny ?? [],
				allow: b.approvals?.allow ?? [],
			},
			trusted: b.trusted === true,
			private: o.private ?? b.private === true,
			isPeer: b.peer !== undefined,
			workspace,
			skillsDir: join(botDir, "skills"),
			config: b,
		};
	}
}

export class UnknownBot extends Error {
	override name = "UnknownBot";
	readonly bot: string;
	constructor(bot: string) {
		super(`unknown bot "${bot}"`);
		this.bot = bot;
	}
}
