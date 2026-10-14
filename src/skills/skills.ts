// Standard SKILL.md skills (Agent Skills spec), discovered with Pi's loader. Two sources: the global
// skills directory (a bot opts in by name or "*") and each bot's own bots/<name>/skills (always on
// unless switched off). A job can attach extra skills to its session. Only names and descriptions go
// into the prompt; the `skill` tool loads a body when the model decides it is relevant.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { loadSkillsFromDir, type Skill } from "@earendil-works/pi-coding-agent";
import type { Bot } from "../core/bots.ts";
import { logger } from "../log.ts";
import type { AppDb } from "../store/db.ts";

const log = logger("skills");

export type SkillEntry = { name: string; description: string; filePath: string; baseDir: string; source: "global" | "bot"; modelInvocable: boolean };

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
