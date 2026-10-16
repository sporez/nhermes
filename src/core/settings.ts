// Runtime configuration: re-reading config.yaml while the gateway runs, and the edits the admin API
// and the panel make to it. Edits go through the YAML document, so comments and order survive; the
// result is loaded and checked before it replaces the file, then applied like a reload. Bots and
// `defaults` apply at once (each prompt reads them); the rest is reported as needing a restart.
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type Document, isMap, isSeq, parseDocument, type YAMLMap } from "yaml";
import { type ApprovalMode, type BotConfig, type Config, ConfigError, loadConfig, type ThinkingLevel } from "../config.ts";
import { logger } from "../log.ts";
import type { Bots, BotOverrides } from "./bots.ts";

const log = logger("settings");

export type ReloadResult = { added: string[]; removed: string[]; changed: string[]; restartNeeded: string[] };

/** A change to one bot's config entry: a value sets the key, `null` removes it, `undefined` leaves it. */
export type BotPatch = { [K in Exclude<keyof BotConfig, "name">]?: BotConfig[K] | null };

export type GatewayPatch = {
	server?: { host?: string; port?: number; name?: string };
	defaults?: { model?: string; thinking?: ThinkingLevel; approvals?: ApprovalMode; approvalTimeoutS?: number };
	timezone?: string;
	/** The ground rules for every bot; null goes back to the built-in rules. */
	groundRules?: string | null;
	/** Model providers to leave out of model pickers. */
	modelLists?: { hide?: string[] };
	/** Jev permission review settings. */
	review?: { enabled?: boolean; allowThreshold?: number; timeoutMs?: number; keyEnv?: string };
};

/** Runtime overrides that shadow a config key; editing the key clears them so the edit shows. */
const SHADOWED: Partial<Record<keyof BotConfig, keyof BotOverrides>> = {
	model: "model",
	thinking: "thinking",
	description: "description",
	instructions: "instructions",
	private: "private",
};

/** Settings that are read once at startup. */
const RESTART_ONLY: [string, (c: Config) => unknown][] = [
	["server", (c) => c.server],
	["dataDir", (c) => c.dataDir],
	["auth token", (c) => c.token],
	["pi", (c) => c.pi],
	["skillsDir", (c) => c.skillsDir],
	["timezone", (c) => c.timezone],
	["defaults.approvalTimeoutS", (c) => c.defaults.approvalTimeoutS],
	["browserExecutable", (c) => c.browserExecutable],
	["pushover", (c) => c.pushover],
	["node", (c) => c.node],
	["panel", (c) => c.panel],
	["secretsFile", (c) => c.secretsPath],
];

export type SettingsDeps = {
	config: Config;
	bots: Bots;
	/** Tool group names a bot may list. */
	toolGroups: () => string[];
	/** Called for each bot whose entry changed or went away (drop cached connections). */
	botChanged: (name: string) => void;
};

export class Settings {
	private readonly d: SettingsDeps;
	private keepPrev = false;

	constructor(deps: SettingsDeps) {
		this.d = deps;
	}

	/** Runs an edit that first keeps the current file as config.yaml.prev (one step of undo by hand). */
	withBackup<T>(edit: () => T): T {
		this.keepPrev = true;
		try {
			return edit();
		} finally {
			this.keepPrev = false;
		}
	}

	/** Re-reads config.yaml. A file that does not load leaves the running configuration as it was. */
	reload(): ReloadResult {
		const next = loadConfig(this.d.config.configPath);
		this.check(next);
		return this.apply(next);
	}

	editBot(name: string, patch: BotPatch): ReloadResult {
		const current = this.d.config.bots.find((b) => b.name === name);
		if (!current) throw new ConfigError(`unknown bot "${name}"`);
		if (current.default && patch.default === false) throw new ConfigError("make another bot the default instead");
		const { instructions, ...rest } = patch;
		// Instructions kept in a SOUL file stay there.
		const soul = this.d.bots.soulPath(current);
		const toSoulFile = typeof instructions === "string" && !current.instructions && existsSync(soul);
		const result = this.write((doc) => {
			const item = botItem(doc, name);
			const fields: BotPatch = toSoulFile ? rest : patch;
			for (const [k, v] of Object.entries(fields)) {
				if (v === undefined) continue;
				if (v === null) item.delete(k);
				else item.set(k, doc.createNode(v));
			}
			if (patch.default === true) for (const other of seqItems(doc)) if (other !== item) other.delete("default");
		}, () => {
			if (toSoulFile) writeFileSync(soul, `${(instructions as string).trim()}\n`);
		});
		const cleared: BotOverrides = {};
		for (const k of Object.keys(patch) as (keyof BotPatch)[]) {
			const o = SHADOWED[k];
			if (o && patch[k] !== undefined) (cleared as Record<string, undefined>)[o] = undefined;
		}
		if (Object.keys(cleared).length > 0) this.d.bots.setOverrides(name, cleared);
		return result;
	}

	/**
	 * Moves settings older versions kept as overrides in app.sqlite (Vory's model, thinking, description,
	 * instructions) into config.yaml, so each bot's settings live in one place. Returns the bots moved.
	 */
	foldOverrides(): string[] {
		const moved: string[] = [];
		for (const b of this.d.config.bots) {
			const o = this.d.bots.overrides(b.name);
			const patch: BotPatch = {};
			for (const [k, ok] of Object.entries(SHADOWED) as [keyof BotPatch, keyof BotOverrides][]) {
				if (o[ok] !== undefined) (patch as Record<string, unknown>)[k] = o[ok];
			}
			if (Object.keys(patch).length === 0) continue;
			try {
				this.editBot(b.name, patch);
				moved.push(b.name);
			} catch (error) {
				log.warn("could not move a bot's overrides into config.yaml", { bot: b.name, error: String(error) });
			}
		}
		return moved;
	}

	addBot(bot: BotConfig): ReloadResult {
		if (this.d.config.bots.some((b) => b.name === bot.name)) throw new ConfigError(`a bot named "${bot.name}" already exists`);
		const entry = Object.fromEntries(Object.entries(bot).filter(([, v]) => v !== undefined && v !== false));
		const result = this.write((doc) => {
			if (!isSeq(doc.get("bots"))) doc.set("bots", doc.createNode([]));
			if (bot.default) for (const other of seqItems(doc)) other.delete("default");
			(doc.get("bots") as { add(v: unknown): void }).add(doc.createNode(entry));
		});
		this.d.bots.clearOverrides(bot.name);
		return result;
	}

	/** Removes a bot from config. Its sessions, memory and workspace stay on disk. */
	removeBot(name: string): ReloadResult {
		const current = this.d.config.bots.find((b) => b.name === name);
		if (!current) throw new ConfigError(`unknown bot "${name}"`);
		if (current.default) throw new ConfigError("the default bot cannot be removed; make another bot the default first");
		const result = this.write((doc) => {
			const seq = doc.get("bots");
			if (!isSeq(seq)) throw new ConfigError("config has no bots list");
			seq.items.splice(seq.items.indexOf(botItem(doc, name)), 1);
		});
		this.d.bots.clearOverrides(name);
		return result;
	}

	setGateway(patch: GatewayPatch): ReloadResult {
		return this.write((doc) => {
			for (const [k, v] of Object.entries(patch.server ?? {})) if (v !== undefined) doc.setIn(["server", k], v);
			for (const [k, v] of Object.entries(patch.defaults ?? {})) if (v !== undefined) doc.setIn(["defaults", k], v);
			if (patch.timezone !== undefined) doc.set("timezone", patch.timezone);
			if (patch.modelLists?.hide !== undefined) doc.setIn(["models", "hide"], doc.createNode(patch.modelLists.hide, { flow: true }));
			for (const [k, v] of Object.entries(patch.review ?? {})) if (v !== undefined) doc.setIn(["review", "jev", k], v);
			if (patch.groundRules === null || patch.groundRules?.trim() === "") doc.delete("groundRules");
			else if (patch.groundRules !== undefined) doc.set("groundRules", doc.createNode(`${patch.groundRules.trim()}\n`));
		});
	}

	/** Edits the YAML document, checks the result by loading it, then replaces the file and applies it. */
	private write(edit: (doc: Document) => void, after?: () => void): ReloadResult {
		const path = this.d.config.configPath;
		const doc = parseDocument(existsSync(path) ? readFileSync(path, "utf8") : "");
		if (doc.errors.length > 0) throw new ConfigError(`config.yaml does not parse: ${doc.errors[0]!.message}`);
		edit(doc);
		const tmp = `${path}.${process.pid}.tmp`;
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(tmp, doc.toString());
		let next: Config;
		try {
			next = loadConfig(tmp);
			this.check(next);
		} catch (error) {
			rmSync(tmp, { force: true });
			throw error;
		}
		if (this.keepPrev && existsSync(path)) copyFileSync(path, `${path}.prev`);
		renameSync(tmp, path);
		next.configPath = path;
		after?.();
		return this.apply(next);
	}

	private check(next: Config): void {
		const known = new Set(this.d.toolGroups());
		for (const b of next.bots) {
			const unknown = (b.tools ?? []).filter((t) => !known.has(t));
			if (unknown.length > 0) throw new ConfigError(`bot "${b.name}": unknown tool group ${unknown.join(", ")} (known: ${[...known].join(", ")})`);
		}
	}

	private apply(next: Config): ReloadResult {
		const config = this.d.config;
		const before = new Map(config.bots.map((b) => [b.name, JSON.stringify(b)]));
		const after = new Map(next.bots.map((b) => [b.name, JSON.stringify(b)]));
		const added = [...after.keys()].filter((n) => !before.has(n));
		const removed = [...before.keys()].filter((n) => !after.has(n));
		const changed = [...after.keys()].filter((n) => before.has(n) && before.get(n) !== after.get(n));
		const restartNeeded = RESTART_ONLY.filter(([, get]) => JSON.stringify(get(config)) !== JSON.stringify(get(next))).map(([k]) => k);
		config.bots = next.bots;
		config.groundRules = next.groundRules;
		config.review = next.review;
		config.modelLists = next.modelLists;
		config.defaults = { ...next.defaults, approvalTimeoutS: config.defaults.approvalTimeoutS };
		for (const n of [...changed, ...removed]) this.d.botChanged(n);
		log.info("configuration applied", { added, removed, changed, restartNeeded });
		return { added, removed, changed, restartNeeded };
	}
}

function seqItems(doc: Document): YAMLMap[] {
	const seq = doc.get("bots");
	return isSeq(seq) ? seq.items.filter((i): i is YAMLMap => isMap(i)) : [];
}

function botItem(doc: Document, name: string): YAMLMap {
	const item = seqItems(doc).find((i) => i.get("name") === name);
	if (!item) throw new ConfigError(`bot "${name}" is not in config.yaml`);
	return item;
}
