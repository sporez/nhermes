// Standard SKILL.md skills (Agent Skills spec), discovered with Pi's loader. Two sources: the global
// skills directory (a bot opts in by name or "*") and each bot's own bots/<name>/skills (always on
// unless switched off). A job can attach extra skills to its session. Only names and descriptions go
// into the prompt; the `skill` tool loads a body when the model decides it is relevant.
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { loadSkillsFromDir, type Skill } from "@earendil-works/pi-coding-agent";
import type { Bot, Bots } from "../core/bots.ts";
import { logger } from "../log.ts";
import type { AppDb } from "../store/db.ts";

const log = logger("skills");

export type SkillEntry = { name: string; description: string; filePath: string; baseDir: string; source: "global" | "bot"; modelInvocable: boolean };

export const SKILL_FILE_MAX = 64 * 1024;
const SKILL_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** A supporting file's path inside a skill folder: relative, no `..`, no hidden parts, never SKILL.md itself. */
function skillRelPath(path: string): string {
	const parts = path.split("/");
	if (!path || isAbsolute(path) || path.includes("\\") || parts.some((p) => p === "" || p === "." || p === ".." || p.startsWith("."))) throw new Error(`bad file path "${path}": use a plain relative path inside the skill folder`);
	if (path.toLowerCase() === "skill.md") throw new Error("SKILL.md is given as skillMd, not in files");
	return path;
}

export class Skills {
	private readonly globalDir: string;
	private readonly db: AppDb;
	private cache = new Map<string, { at: number; skills: SkillEntry[] }>();

	constructor(globalDir: string, db: AppDb) {
		this.globalDir = globalDir;
		this.db = db;
	}

	private load(dir: string, source: SkillEntry["source"]): SkillEntry[] {
		const key = `${source}:${dir}`;
		const hit = this.cache.get(key);
		if (hit && Date.now() - hit.at < 5000) return hit.skills;
		let skills: Skill[] = [];
		if (existsSync(dir)) {
			const r = loadSkillsFromDir({ dir, source: "path" });
			for (const d of r.diagnostics) log.warn("skill diagnostic", { dir, diagnostic: JSON.stringify(d).slice(0, 300) });
			skills = r.skills;
		}
		const out = skills.map((s) => ({ name: s.name, description: s.description, filePath: s.filePath, baseDir: s.baseDir, source, modelInvocable: !s.disableModelInvocation }));
		this.cache.set(key, { at: Date.now(), skills: out });
		return out;
	}

	/** Forgets what was read, so a write shows at once. */
	invalidate(): void {
		this.cache.clear();
	}

	/**
	 * Writes a skill into `root/<name>/` (SKILL.md and supporting files; other files there stay). The name and
	 * SKILL.md frontmatter are checked with Pi's loader first, and nothing can land outside the skill folder.
	 */
	write(root: string, name: string, skillMd: string, files: Record<string, string> = {}): string[] {
		if (name.length > 64 || !SKILL_NAME.test(name)) throw new Error("skill names are lowercase letters, digits and single hyphens (at most 64 characters)");
		const all: [string, string][] = [["SKILL.md", skillMd], ...Object.entries(files).map(([p, c]): [string, string] => [skillRelPath(p), c])];
		if (all.length > 30) throw new Error("at most 30 files per skill");
		for (const [p, c] of all) if (Buffer.byteLength(c) > SKILL_FILE_MAX) throw new Error(`${p} is larger than ${SKILL_FILE_MAX / 1024} KB`);
		const tmp = mkdtempSync(join(tmpdir(), "nh-skill-"));
		try {
			mkdirSync(join(tmp, name));
			writeFileSync(join(tmp, name, "SKILL.md"), skillMd);
			const r = loadSkillsFromDir({ dir: tmp, source: "path" });
			if (r.skills.length !== 1 || r.skills[0]!.name !== name || r.diagnostics.length > 0) {
				throw new Error(`SKILL.md is not a valid skill (needs frontmatter with name: ${name} and a description): ${JSON.stringify(r.diagnostics[0] ?? "no skill found").slice(0, 300)}`);
			}
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
		mkdirSync(root, { recursive: true });
		const dir = join(realpathSync(root), name);
		if (existsSync(dir) && (lstatSync(dir).isSymbolicLink() || !lstatSync(dir).isDirectory())) throw new Error("that skill path is not a normal folder");
		mkdirSync(dir, { recursive: true });
		const written: string[] = [];
		for (const [p, c] of all) {
			const target = resolve(dir, p);
			if (!target.startsWith(dir + sep)) throw new Error("path is outside the skill directory");
			mkdirSync(dirname(target), { recursive: true });
			if (!realpathSync(dirname(target)).startsWith(dir) || (existsSync(target) && lstatSync(target).isSymbolicLink())) throw new Error("path is outside the skill directory");
			writeFileSync(target, c);
			written.push(p);
		}
		this.invalidate();
		return written;
	}

	/** Removes one skill folder under `root` (it must hold a SKILL.md). */
	remove(root: string, name: string): void {
		if (!SKILL_NAME.test(name)) throw new Error("bad skill name");
		const dir = join(root, name);
		if (!existsSync(dir) || lstatSync(dir).isSymbolicLink() || !existsSync(join(dir, "SKILL.md"))) throw new Error(`no skill "${name}" there`);
		rmSync(dir, { recursive: true });
		this.invalidate();
	}

	global(): SkillEntry[] {
		return this.load(this.globalDir, "global");
	}

	ofBot(bot: Bot): SkillEntry[] {
		return this.load(bot.skillsDir, "bot");
	}

	/** Every skill a bot could use, with whether it is active for it. Per-bot skills shadow global ones. */
	catalog(bot: Bot): (SkillEntry & { active: boolean })[] {
		const own = this.ofBot(bot);
		const ownNames = new Set(own.map((s) => s.name));
		const all = [...own, ...this.global().filter((s) => !ownNames.has(s.name))];
		const wantsAll = bot.globalSkills.includes("*");
		return all.map((s) => ({
			...s,
			active: !bot.disabledSkills.includes(s.name) && (s.source === "bot" || wantsAll || bot.globalSkills.includes(s.name)),
		}));
	}

	/** Skills active in one session: the bot's, plus any the session (a job) attached explicitly. */
	active(bot: Bot, attached: readonly string[] = []): SkillEntry[] {
		const cat = this.catalog(bot);
		return cat.filter((s) => s.active || attached.includes(s.name));
	}

	/**
	 * Switches one skill on or off for a bot (Vory's Skills screen and the panel), as bot overrides: off
	 * always wins; on clears that and opts into a global skill beyond config.
	 */
	setEnabled(bots: Bots, bot: Bot, name: string, enabled: boolean): SkillEntry {
		const skill = this.catalog(bot).find((s) => s.name === name);
		if (!skill) throw new UnknownSkill(name);
		const o = bots.overrides(bot.name);
		const disabled = new Set(o.disabledSkills ?? []);
		const on = new Set(o.enabledSkills ?? []);
		if (enabled) {
			disabled.delete(name);
			if (skill.source === "global") on.add(name);
		} else {
			disabled.add(name);
			on.delete(name);
		}
		bots.setOverrides(bot.name, { disabledSkills: [...disabled], enabledSkills: [...on] });
		return skill;
	}

	find(bot: Bot, name: string, attached: readonly string[] = []): SkillEntry | undefined {
		return this.active(bot, attached).find((s) => s.name === name);
	}

	body(skill: SkillEntry): string {
		return readFileSync(skill.filePath, "utf8");
	}

	/** Files next to SKILL.md (scripts, references), relative to the skill directory. */
	files(skill: SkillEntry, limit = 50): string[] {
		const root = dirname(skill.filePath);
		const out: string[] = [];
		const walk = (d: string, depth: number) => {
			if (depth > 3 || out.length >= limit) return;
			for (const name of readdirSync(d)) {
				if (name.startsWith(".")) continue;
				const p = join(d, name);
				if (statSync(p).isDirectory()) walk(p, depth + 1);
				else if (p !== skill.filePath) out.push(relative(root, p));
				if (out.length >= limit) return;
			}
		};
		walk(root, 0);
		return out;
	}

	/** Reads a supporting file inside the skill's directory (no escaping it). */
	readFile(skill: SkillEntry, path: string): string {
		const root = dirname(skill.filePath);
		const target = resolve(root, path);
		if (target !== root && !target.startsWith(root + sep)) throw new Error("path is outside the skill directory");
		return readFileSync(target, "utf8");
	}

	noteUse(bot: string, skill: string): void {
		this.db.run(
			"INSERT INTO skill_usage (bot, skill, count, last_used) VALUES (?, ?, 1, ?) ON CONFLICT(bot, skill) DO UPDATE SET count = count + 1, last_used = excluded.last_used",
			bot,
			skill,
			Date.now() / 1000,
		);
	}

	usage(bot: string): Map<string, number> {
		return new Map(this.db.all<{ skill: string; count: number }>("SELECT skill, count FROM skill_usage WHERE bot = ?", bot).map((r) => [r.skill, r.count]));
	}
}

export class UnknownSkill extends Error {
	override name = "UnknownSkill";
	constructor(skill: string) {
		super(`Skill '${skill}' not found`);
	}
}
