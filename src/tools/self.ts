// A bot knowing nHermes: the `about` prompt section (what this is, the bot's live settings, where the
// docs are, how things change) for bots that have the `self` tool group.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join, relative, resolve } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { configView } from "../admin.ts";
import { type BotConfig, ConfigError } from "../config.ts";
import { redact } from "../log.ts";
import type { Core, Feature, LateServices } from "../app.ts";
import type { Bot } from "../core/bots.ts";
import type { BotPatch, GatewayPatch, Settings } from "../core/settings.ts";
import { UpdateError, type Updates } from "../core/updates.ts";
import type { Skills } from "../skills/skills.ts";

/** The install directory, resolved from the running code (README.md, ARCHITECTURE.md, docs/). */
export const INSTALL_DIR = resolve(import.meta.dirname, "..", "..");

export type SelfServices = {
	skills: Skills;
	view: Pick<Core, "config" | "toolGroups" | "bots">;
	settings: () => Settings;
	updates: () => Updates;
	/** Whether "provider/model" names a model the gateway can use. */
	modelExists: (ref: string) => boolean;
	/** The models the pickers offer (hidden providers left out, except the one in use); names and limits only, never keys. */
	pickableModels: (current: { provider: string; modelId: string }) => Promise<PickableModel[]>;
};

export type PickableModel = { provider: string; id: string; name?: string; reasoning?: boolean; input?: string[]; contextWindow?: number; cost?: { input: number; output: number } };

/** One line per model, grouped by provider, the bot's current one marked. */
export function modelListText(models: PickableModel[], current: { provider: string; modelId: string }): string {
	if (models.length === 0) return "No models are available.";
	const size = (n: number) => (n >= 1_000_000 ? `${Math.round(n / 1_000_000)}M` : `${Math.round(n / 1000)}K`);
	const lines = [`Models you can switch to with self_update (model: "provider/model"). Current: ${current.provider}/${current.modelId}.`];
	let provider = "";
	for (const m of [...models].sort((a, b) => a.provider.localeCompare(b.provider))) {
		if (m.provider !== provider) lines.push("", `${(provider = m.provider)}:`);
		const facts = [
			m.name && m.name !== m.id ? m.name : undefined,
			m.contextWindow ? `${size(m.contextWindow)} context` : undefined,
			m.reasoning ? "reasoning" : undefined,
			m.input?.includes("image") ? "images" : undefined,
			m.cost && (m.cost.input || m.cost.output) ? `$${m.cost.input}/$${m.cost.output} per M in/out` : undefined,
		].filter(Boolean);
		const here = m.provider === current.provider && m.id === current.modelId ? " (current)" : "";
		lines.push(`- ${m.provider}/${m.id}${here}${facts.length ? `: ${facts.join(", ")}` : ""}`);
	}
	return lines.join("\n");
}

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

/**
 * What gateway_bot_update / gateway_bot_add may set. Left out even for trusted bots: sharedMemory (reaches other
 * bots' data), secrets and peer (name environment variables that hold secrets, which a bot could then send out).
 */
export const BOT_FIELDS = ["displayName", "description", "default", "instructions", "soulFile", "model", "thinking", "tools", "skills", "recentChats", "approvals", "trusted", "private", "workspace", "host", "browser", "desktop", "openchamber"] as const;

/** What a bot may set in `openchamber`: not url or tokenEnv, which would let it send the token elsewhere. */
const OPENCHAMBER_FIELDS = ["model", "variant", "agent"];

/** Gateway settings a trusted bot may change (no server address or port, no key variable names). */
function gatewayPatchOf(raw: Record<string, unknown>): GatewayPatch {
	const rec = (v: unknown, keys: string[], where: string): Record<string, unknown> => {
		if (v === undefined) return {};
		if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error(`${where} must be an object`);
		const bad = Object.keys(v).filter((k) => !keys.includes(k));
		if (bad.length > 0) throw new Error(`${where}.${bad.join(", ")} cannot be changed here`);
		return v as Record<string, unknown>;
	};
	const bad = Object.keys(raw).filter((k) => !["defaults", "timezone", "groundRules", "modelLists", "review"].includes(k));
	if (bad.length > 0) throw new Error(`gateway setting ${bad.join(", ")} cannot be changed here (allowed: defaults, timezone, groundRules, modelLists, review)`);
	const out: GatewayPatch = {};
	if (raw.defaults !== undefined) out.defaults = rec(raw.defaults, ["model", "thinking", "approvals"], "defaults") as GatewayPatch["defaults"];
	if (raw.review !== undefined) out.review = rec(raw.review, ["enabled", "allowThreshold", "timeoutMs"], "review") as GatewayPatch["review"];
	if (raw.modelLists !== undefined) out.modelLists = rec(raw.modelLists, ["hide"], "modelLists") as GatewayPatch["modelLists"];
	if (raw.timezone !== undefined) out.timezone = raw.timezone as string;
	if (raw.groundRules !== undefined) out.groundRules = raw.groundRules as string | null;
	return out;
}

export function botPatchOf(raw: Record<string, unknown>, what: string): Record<string, unknown> {
	const bad = Object.keys(raw).filter((k) => !(BOT_FIELDS as readonly string[]).includes(k));
	if (bad.length > 0) throw new Error(`${bad.join(", ")} cannot be set by a bot (${what}); allowed: ${BOT_FIELDS.join(", ")}`);
	const oc = raw.openchamber;
	if (oc !== undefined && oc !== null) {
		const badOc = typeof oc === "object" && !Array.isArray(oc) ? Object.keys(oc).filter((k) => !OPENCHAMBER_FIELDS.includes(k)) : ["(not an object)"];
		if (badOc.length > 0) throw new Error(`openchamber.${badOc.join(", ")} cannot be set by a bot (${what}); allowed: ${OPENCHAMBER_FIELDS.join(", ")}`);
	}
	return raw;
}

const withoutCredentials = (url: string | undefined) => url?.replace(/\/\/[^@/]+@/, "//");

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
	const machine = hostname().split(".")[0];
	const where = c.node.url ? c.node.url.replace(/\/$/, "") : `http://${machine}:${c.server.port}`;
	const d = (file: string) => `${INSTALL_DIR}/${file}`;
	return [
		"About you and nHermes:",
		`You are a bot in nHermes, a self-hosted agent gateway named "${c.server.publicName}" on the machine "${machine}". The owner reaches you through the nHermes app (Mac, iPhone, iPad) or the web panel (${where}/panel/). One process runs the bots, sessions, memory, skills, scheduler and the approval guard.`,
		"Your settings right now:",
		`- model ${bot.model.provider}/${bot.model.modelId}, thinking ${bot.thinking}; approvals ${bot.approvals.mode}${bot.trusted ? "; trusted (an infrastructure bot)" : ""}`,
		`- tool groups: ${bot.toolGroups.join(", ") || "none"}; commands run ${whereCommandsRun(bot)}; workspace ${bot.workspace}`,
		`- active skills: ${skills.join(", ") || "none"}; shared memory: ${bot.sharedMemory.join(", ") || "none"}; scheduled jobs: ${jobs}`,
		`Documentation (read it only when asked about nHermes or yourself; read the whole file): ${INSTALL_DIR}. You can list and read it with nhermes_docs.`,
		`- operations, CLI, config.yaml: ${d("docs/OPERATIONS.md")}; concepts and tools: ${d("ARCHITECTURE.md")}; the network of machines: ${d("docs/FEDERATION.md")}`,
		`- approvals, secrets and the Jev reviewer: ${d("docs/SECRETS-AND-REVIEW.md")}; the client API: ${d("docs/API.md")}; browser and desktop: ${d("docs/COMPUTER_USE.md")}`,
		"How things change:",
		"- You can change your own description, instructions, model, thinking and skills, and your own memory and scheduled jobs. self_models lists the models you can switch to. Every settings change asks the owner first, and you never edit config.yaml or the gateway's files yourself.",
		`- Only the owner${bot.trusted ? " or a trusted bot (you are one)" : " or a trusted bot"} can change tools, trust, approvals, hosts, other bots and gateway settings.`,
		"- Only the owner can handle secrets, tokens, the panel password, network invitations and backups. Software updates need a trusted bot and the owner's approval.",
		"- The owner can do all of it in the panel, in the nHermes app, or by editing config.yaml and running `nhermes reload`.",
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
	const cur = (n: unknown) => services.view.bots.get(String(n))?.config;
	if (name === "gateway_bot_update") {
		const c = cur(args.name);
		const patch = (args.patch ?? {}) as Record<string, unknown>;
		return [`Change bot "${args.name}":`, ...Object.entries(patch).map(([k, v]) => fieldChange(k, (c as Record<string, unknown> | undefined)?.[k], v))].join("\n");
	}
	if (name === "gateway_bot_add") return `Add bot:\n${JSON.stringify(args.config, null, 2)}`;
	if (name === "gateway_bot_remove") return `Remove bot "${args.name}" from config.yaml (its sessions, memory and workspace stay on disk)`;
	if (name === "gateway_update") {
		const c = services.view.config as unknown as Record<string, unknown>;
		const lines: string[] = [];
		for (const [k, v] of Object.entries((args.patch ?? {}) as Record<string, unknown>)) {
			if (v !== null && typeof v === "object" && !Array.isArray(v)) for (const [k2, v2] of Object.entries(v)) lines.push(fieldChange(`${k}.${k2}`, (c[k] as Record<string, unknown> | undefined)?.[k2], v2));
			else lines.push(fieldChange(k, k === "groundRules" ? c.groundRules : c[k], v));
		}
		return ["Change the gateway's settings:", ...lines].join("\n");
	}
	if (name === "gateway_reload") return "Re-read config.yaml and apply it";
	if (name === "gateway_skill_write" || name === "gateway_skill_delete") {
		const dir = typeof args.bot === "string" ? services.view.bots.get(args.bot)?.skillsDir : services.view.config.skillsDir;
		const where = typeof args.bot === "string" ? `${args.bot}'s` : "the global";
		if (name === "gateway_skill_delete") return `Delete ${where} skill "${args.name}"`;
		const old = dir ? join(dir, String(args.name), "SKILL.md") : "";
		const extra = Object.keys((args.files as object) ?? {});
		return [`Write ${where} skill "${args.name}"${extra.length ? ` (+ files: ${extra.join(", ")})` : ""}:`, lineDiff(old && existsSync(old) ? readFileSync(old, "utf8") : "", String(args.skillMd ?? ""))].join("\n");
	}
	if (name === "gateway_software") {
		const st = services.updates().status();
		const list = (cs: { hash: string; subject: string }[]) => cs.map((c) => `  ${c.hash} ${c.subject}`).join("\n");
		return args.action === "rollback"
			? `Roll nHermes back to ${st.previous ? `${st.previous.hash} ${st.previous.subject}` : "(nothing recorded)"} and restart the gateway`
			: `Update nHermes from ${st.current?.hash ?? "?"} (${st.available.length} new commits as of the last check) and restart the gateway:\n${list(st.available.slice(0, 15))}`;
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
	const modelsTool = defineTool({
		name: "self_models",
		description: "The models you can switch to (what the owner's model pickers offer), with context size, reasoning, image input and price; your current one is marked. Change it with self_update.",
		parameters: Type.Object({}),
		replay: "safe",
		execute: async (_args, api) => {
			const me = botOf(api.conversationId as number);
			return text(modelListText(await services.pickableModels(me.model), me.model));
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
		late.db.run("INSERT INTO audit (at, bot, session_id, kind, detail) VALUES (?, ?, ?, ?, ?)", Date.now() / 1000, bot.name, row?.id ?? null, `config.${tool}`, redact(JSON.stringify(detail)).slice(0, 4000));
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
			return text(
				`Wrote skill "${args.name}" (${written.join(", ")}). It is active from your next message. ` +
					"Read it back with the skill tool (file for its other files) and change it with self_skill_write; skills are kept with the gateway's configuration, so do not look for them on disk.",
			);
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

	// Gateway-wide tools: trusted bots only (the guard also refuses them through an untrusted delegation chain).
	const trusted = (api: { conversationId: unknown }) => {
		const bot = botOf(api.conversationId as number);
		if (!bot.trusted) throw new Error("only a trusted bot can change the gateway or other bots");
		return bot;
	};
	const settings = () => services.settings();
	const Obj = Type.Record(Type.String(), Type.Unknown());
	const botUpdate = defineTool({
		name: "gateway_bot_update",
		description: `Change any bot's setup in config.yaml (fields: ${BOT_FIELDS.join(", ")}); a null value removes a field. Not sharedMemory, secrets or peer. The owner is asked to approve.`,
		parameters: Type.Object({ name: Type.String(), patch: Obj }),
		replay: "safe",
		execute: async (args, api) => {
			const me = trusted(api);
			const patch = botPatchOf(args.patch, "owner only");
			wrap(() => settings().withBackup(() => settings().editBot(args.name, patch as BotPatch)));
			audit(api, me, "gateway_bot_update", { bot: args.name, patch });
			return text(`Updated ${args.name}: ${Object.keys(patch).join(", ")}.`);
		},
	});
	const botAdd = defineTool({
		name: "gateway_bot_add",
		description: `Add a bot: config with name and any of ${BOT_FIELDS.join(", ")}. The owner is asked to approve.`,
		parameters: Type.Object({ config: Obj }),
		replay: "safe",
		execute: async (args, api) => {
			const me = trusted(api);
			const { name, ...rest } = args.config;
			if (typeof name !== "string") throw new Error("config.name is required");
			const entry = { name, ...botPatchOf(rest, "owner only") } as BotConfig;
			wrap(() => settings().withBackup(() => settings().addBot(entry)));
			audit(api, me, "gateway_bot_add", { config: entry });
			return text(`Added bot ${name}.`);
		},
	});
	const botRemove = defineTool({
		name: "gateway_bot_remove",
		description: "Remove a bot from config.yaml (its sessions, memory and workspace stay on disk). Not yourself, not the default bot. The owner is asked to approve.",
		parameters: Type.Object({ name: Type.String() }),
		replay: "safe",
		execute: async (args, api) => {
			const me = trusted(api);
			if (args.name === me.name) throw new Error("a bot cannot remove itself");
			wrap(() => settings().withBackup(() => settings().removeBot(args.name)));
			audit(api, me, "gateway_bot_remove", { bot: args.name });
			return text(`Removed bot ${args.name}.`);
		},
	});
	const gwUpdate = defineTool({
		name: "gateway_update",
		description: "Change gateway settings: patch with defaults {model, thinking, approvals}, timezone, groundRules (null restores the built-in rules), modelLists {hide}, review {enabled, allowThreshold, timeoutMs}. The owner is asked to approve.",
		parameters: Type.Object({ patch: Obj }),
		replay: "safe",
		execute: async (args, api) => {
			const me = trusted(api);
			const patch = gatewayPatchOf(args.patch);
			const result = wrap(() => settings().withBackup(() => settings().setGateway(patch)));
			audit(api, me, "gateway_update", { patch });
			return text(`Gateway settings updated${result.restartNeeded.length ? `; needs a restart: ${result.restartNeeded.join(", ")}` : ""}.`);
		},
	});
	const reload = defineTool({
		name: "gateway_reload",
		description: "Re-read config.yaml (after the owner changed it by hand) and apply it. The owner is asked to approve.",
		parameters: Type.Object({}),
		replay: "safe",
		execute: async (_args, api) => {
			const me = trusted(api);
			const result = wrap(() => settings().reload());
			audit(api, me, "gateway_reload", result);
			return text(`Reloaded: ${JSON.stringify(result)}`);
		},
	});
	const skillRoot = (bot: string | undefined) => {
		if (!bot) return services.view.config.skillsDir;
		const b = late.bots().get(bot);
		if (!b || b.remote) throw new Error(`unknown bot "${bot}"`);
		return b.skillsDir;
	};
	const gwSkillWrite = defineTool({
		name: "gateway_skill_write",
		description: "Create or replace a skill: a global one (all bots can opt in), or one in a bot's own folder when bot is given. Same arguments as self_skill_write. The owner is asked to approve.",
		parameters: Type.Object({ name: Type.String(), skillMd: Type.String(), files: Type.Optional(Type.Record(Type.String(), Type.String())), bot: Type.Optional(Type.String()) }),
		replay: "safe",
		execute: async (args, api) => {
			const me = trusted(api);
			const written = services.skills.write(skillRoot(args.bot), args.name, args.skillMd, args.files);
			audit(api, me, "gateway_skill_write", { skill: args.name, bot: args.bot ?? "(global)", files: written });
			return text(`Wrote skill "${args.name}" (${written.join(", ")}).`);
		},
	});
	const gwSkillDelete = defineTool({
		name: "gateway_skill_delete",
		description: "Delete a global skill, or one of a bot's own when bot is given. The owner is asked to approve.",
		parameters: Type.Object({ name: Type.String(), bot: Type.Optional(Type.String()) }),
		replay: "safe",
		execute: async (args, api) => {
			const me = trusted(api);
			services.skills.remove(skillRoot(args.bot), args.name);
			audit(api, me, "gateway_skill_delete", { skill: args.name, bot: args.bot ?? "(global)" });
			return text(`Deleted skill "${args.name}".`);
		},
	});
	const software = defineTool({
		name: "gateway_software",
		description:
			"nHermes's own software: action status | check (fetch and list new commits) | update | rollback (the last update). update and rollback ask the owner, are refused while other sessions are running " +
			"unless force is true, and restart the gateway: your run resumes afterwards; call status to see the new version.",
		parameters: Type.Object({ action: Type.Union([Type.Literal("status"), Type.Literal("check"), Type.Literal("update"), Type.Literal("rollback")]), force: Type.Optional(Type.Boolean()) }),
		replay: "safe",
		execute: async (args, api) => {
			const me = trusted(api);
			const show = (v: unknown) => JSON.stringify(v, (k, x) => (k === "remote" ? withoutCredentials(x as string) : x), 2);
			try {
				if (args.action === "status") return text(show(services.updates().status()));
				if (args.action === "check") return text(show(services.updates().check()));
				const others = late.sessions().runningCount() - 1;
				if (others > 0 && !args.force) throw new Error(`${others} other session(s) are running and a restart would interrupt them; try again later or pass force: true`);
				const r = args.action === "update" ? services.updates().update() : services.updates().rollback();
				audit(api, me, `gateway_software.${args.action}`, { from: r.from, to: r.to });
				return text(`${args.action === "update" ? "Updated" : "Rolled back"} from ${r.from.hash} (${r.from.subject}) to ${r.to.hash} (${r.to.subject})${r.restarting ? "; the gateway is restarting now, call gateway_software status afterwards" : "; restart the gateway to run it"}.`);
			} catch (error) {
				if (error instanceof UpdateError) throw new Error(error.message);
				throw error;
			}
		},
	});

	return {
		groups: new Map([["self", [info, modelsTool, docs, update, skillWrite, skillDelete, botUpdate, botAdd, botRemove, gwUpdate, reload, gwSkillWrite, gwSkillDelete, software] as ToolRegistration[]]]),
		promptParts: [(bot) => (bot.toolGroups.includes("self") ? aboutText(late, services, bot) : undefined)],
	};
}
