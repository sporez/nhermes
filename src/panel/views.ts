// What the bot editor shows about this gateway's own bots, for its own panel and for a member's panel
// (through /federation/manage): the editor data, the models it may pick from, a bot's skills and its
// system prompt in parts.
import { configView } from "../admin.ts";
import { groundRules, personaParts, personaText } from "../agent/extensions.ts";
import type { Core } from "../app.ts";
import type { Bot } from "../core/bots.ts";

/** Bots this gateway owns and edits: not members' bots, not `peer:` entries. */
export function ownBots(c: Core): Bot[] {
	return c.bots.list().filter((b) => !b.remote && !b.isPeer);
}

/** The models a bot picker offers: hidden providers stay out unless a bot or the default uses one. */
export async function modelChoices(c: Core): Promise<{ models: string[]; providers: { name: string; models: number; shown: boolean }[] }> {
	const all = await c.models.getAvailable();
	const hidden = new Set(c.config.modelLists.hide);
	const inUse = new Set([c.config.defaults.model, ...c.bots.list().filter((b) => !b.remote).map((b) => `${b.model.provider}/${b.model.modelId}`)]);
	const models = all.map((m) => `${m.provider}/${m.id}`).filter((m) => !hidden.has(m.slice(0, m.indexOf("/"))) || inUse.has(m));
	const providers = [...new Set(all.map((m) => m.provider))].sort().map((name) => ({ name, models: all.filter((m) => m.provider === name).length, shown: !hidden.has(name) }));
	return { models, providers };
}

/** Everything the bot editor needs for this gateway's bots. */
export async function editorView(c: Core) {
	const view = configView(c);
	const own = new Set(ownBots(c).map((b) => b.name));
	return {
		toolGroups: view.toolGroups,
		models: (await modelChoices(c)).models,
		bots: view.bots.filter((b) => own.has(b.name)),
		spaces: [...new Set(c.config.bots.flatMap((b) => b.sharedMemory ?? []))].sort(),
	};
}

/** Skills a bot could use (its own and the global ones), each switched on or off for it. */
export function skillsView(c: Core, bot: Bot) {
	const usage = c.skills.usage(bot.name);
	return {
		toolGroupOn: bot.toolGroups.includes("skills"),
		allGlobal: bot.globalSkills.includes("*"),
		skills: c.skills.catalog(bot).map((s) => ({ name: s.name, description: s.description, source: s.source, active: s.active, usage: usage.get(s.name) ?? 0 })),
	};
}

/**
 * The bot's system prompt as a new chat gets it: the editable parts (its instructions; the ground rules,
 * shared by all bots) and the generated ones. Tool descriptions are added by the engine.
 */
export async function promptView(c: Core, bot: Bot) {
	const p = await personaParts(c.deps, bot, "");
	return {
		...p,
		groundRulesCustom: c.config.groundRules !== undefined,
		builtInGroundRules: groundRules([...new Set([c.config.configDir, c.config.dataDir])]),
		tools: bot.toolGroups,
		full: await personaText(c.deps, bot, ""),
	};
}
