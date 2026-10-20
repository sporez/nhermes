// The Bots tab. Registers itself with the shell in core.js.
import { AuthError, THINKING, api, ask, badge, field, h, loadState, registerTab, restartNote, run, same, select, show, state, toast, ui, when } from "./core.js";

// Members' bots, as their machines report them for editing (refreshed when the Bots screen opens).
let remoteMembers = [];

async function loadRemote() {
	try { remoteMembers = (await api("GET", "/remote")).members; } catch (e) { if (e instanceof AuthError) throw e; remoteMembers = []; }
}

/** Where a bot lives and what its editor may offer: this machine, or a member that allows edits. */
function localCtx() {
	return { node: null, base: "", models: state.models, toolGroups: state.toolGroups, bots: state.bots, reload: loadState };
}
function remoteCtx(m) {
	return { node: m.node, base: `/remote/${encodeURIComponent(m.node)}`, models: m.models, toolGroups: m.toolGroups, bots: m.bots,
		reload: async () => { await Promise.all([loadState(), loadRemote()]); } };
}
const botKey = (ctx, name) => (ctx.node ? `${ctx.node}/${name}` : name);

async function botsScreen(refresh = true) {
	if (refresh) await loadRemote();
	const local = localCtx();
	const remotes = remoteMembers.filter((m) => m.editable).map(remoteCtx);
	const ctxs = [local, ...remotes];
	const find = (key) => {
		for (const ctx of ctxs) {
			if (key === botKey(ctx, "+new")) return { ctx, bot: "+new" };
			const bot = ctx.bots.find((b) => botKey(ctx, b.name) === key);
			if (bot) return { ctx, bot };
		}
		const ro = state.remoteBots.find((b) => `${b.node}/${b.name}` === key);
		return ro ? { ctx: null, bot: ro } : null;
	};
	if (!ui.bot || !find(ui.bot)) ui.bot = local.bots[0]?.name ?? "+new";
	const pick = (key) => { ui.bot = key; botsScreen(false); };
	const item = (key, kids) => h("li", { class: key === ui.bot ? "active" : "", on: { click: () => pick(key) } }, kids);
	const botItem = (ctx, b) => item(botKey(ctx, b.name), [
		h("div", { class: "trunc" }, b.effective.displayName || b.name),
		b.signIn && h("div", { class: "small" }, badge(`Needs sign-in: ${b.signIn.name}`, "bad"), " ", h("a", { href: "#logins", on: { click: (e) => e.stopPropagation() } }, "Logins")),
		h("div", { class: "row small muted" }, b.name, b.effective.default && badge("default"), b.effective.private && badge("private"), b.effective.trusted && badge("trusted"))]);

	const list = h("ul", { class: "list" }, local.bots.map((b) => botItem(local, b)), item("+new", "+ New bot"));

	// Remote bots: one group per member. Editable when that machine allows edits from this one.
	const remoteList = h("ul", { class: "list" });
	for (const m of remoteMembers) {
		remoteList.append(h("li", { class: "static group" }, h("strong", {}, `On ${m.node}`), " ", !m.reachable && badge("offline", "bad")));
		if (m.editable) {
			const ctx = remotes.find((c) => c.node === m.node);
			remoteList.append(...ctx.bots.map((b) => botItem(ctx, b)), item(botKey(ctx, "+new"), `+ New bot on ${m.node}`));
			continue;
		}
		for (const b of state.remoteBots.filter((x) => x.node === m.node)) {
			remoteList.append(item(`${b.node}/${b.name}`, [h("div", { class: "trunc" }, b.displayName || b.name), h("div", { class: "row small muted" }, b.name, badge("view only"))]));
		}
	}

	const selected = find(ui.bot);
	let pane;
	if (!selected.ctx) pane = readOnlyBot(selected.bot, remoteMembers.find((m) => m.node === selected.bot.node));
	else if (selected.bot === "+new") pane = newBotForm(selected.ctx);
	else pane = botEditor(selected.bot, selected.ctx);

	const reload = h("button", { on: { click: () => run(async () => { restartNote(await api("POST", "/reload")); await loadState(); botsScreen(); }) } }, "Reload config.yaml");
	show(
		h("div", { class: "row between" }, h("h1", {}, "Bots"), reload),
		h("div", { class: "layout" },
			h("div", {}, list, remoteMembers.length > 0 && h("h2", {}, "Remote bots"), remoteMembers.length > 0 && remoteList),
			pane));
}

/** A member's bot this machine may not edit: what the roster says, and why it is view only. */
function readOnlyBot(b, member) {
	const why = !member || !member.reachable
		? `${b.node} is offline; its bots can be edited here again when it is back.`
		: `${b.node} does not accept bot edits from other machines. Turn on "Let other machines edit this machine's bots" in ${b.node}'s panel (Network) to manage its bots from here.`;
	return h("div", { class: "card" },
		h("div", { class: "row" }, h("h3", {}, b.displayName || b.name), h("span", { class: "muted small" }, b.name), !b.reachable && badge("offline", "bad"), badge(b.model)),
		b.description && h("p", { class: "muted" }, b.description),
		h("div", { class: "notice warn small" }, why));
}

function newBotForm(ctx) {
	const name = h("input", { type: "text", placeholder: "my-bot", autocapitalize: "off" });
	const err = h("div", { class: "err" });
	const create = () => run(async () => {
		if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(name.value)) { err.textContent = "Use lowercase letters, digits and dashes, starting with a letter or digit (max 41 characters)."; return; }
		await api("POST", `${ctx.base}/bots`, { name: name.value });
		ui.bot = botKey(ctx, name.value);
		await ctx.reload();
		toast(ctx.node ? `Bot created on ${ctx.node}` : "Bot created");
		botsScreen(false);
	});
	return h("div", { class: "card" }, h("h3", {}, ctx.node ? `New bot on ${ctx.node}` : "New bot"), field("Name", name, "Lowercase letters, digits and dashes. Cannot be changed later."), err, h("button", { class: "primary", on: { click: create } }, "Create"));
}

function botEditor(bot, ctx) {
	const { config, effective } = bot;
	const path = `${ctx.base}/bots/${encodeURIComponent(bot.name)}`;
	const name = h("input", { type: "text", value: effective.displayName ?? "" });
	const desc = h("input", { type: "text", value: effective.description ?? "" });
	const initModel = config.model ?? "";
	const models = ["", ...ctx.models];
	if (initModel && !models.includes(initModel)) models.push(initModel);
	const model = select(models, initModel, { "": ctx.node ? `(${ctx.node}'s default)` : "(gateway default)" });
	const thinking = select(THINKING, effective.thinking);
	const tools = ctx.toolGroups.map((g) => h("input", { type: "checkbox", value: g, checked: effective.tools.includes(g) }));
	const mode = select(["smart", "manual", "off"], effective.approvals);
	const priv = h("input", { type: "checkbox", checked: effective.private });
	const trusted = h("input", { type: "checkbox", checked: effective.trusted });
	const dflt = h("input", { type: "checkbox", checked: effective.default });
	const shared = h("input", { type: "text", value: (config.sharedMemory ?? []).join(", "), placeholder: "household, work" });
	// A member on an older version has no recentChats: the field stays hidden for its bots.
	const recent = effective.recentChats !== undefined && h("input", { type: "number", min: 0, max: 20, step: 1, value: effective.recentChats });
	const instr = h("textarea", { value: effective.instructions ?? "" });
	const check = (box, text) => h("label", {}, box, text);
	const sourceNote = { config: "config.yaml", default: "the built-in default", "soul file": "its SOUL.md file", override: "a change made in Vory" }[effective.instructionsFrom] ?? effective.instructionsFrom;

	const save = () => run(async () => {
		const patch = {};
		const text = (v, init, key) => { if (v.trim() !== (init ?? "")) patch[key] = v.trim() || null; };
		text(name.value, effective.displayName, "displayName");
		text(desc.value, effective.description, "description");
		if (model.value !== initModel) patch.model = model.value || null;
		if (thinking.value !== effective.thinking) patch.thinking = thinking.value;
		const picked = tools.filter((t) => t.checked).map((t) => t.value);
		if (!same([...picked].sort(), [...effective.tools].sort())) patch.tools = picked;
		if (mode.value !== effective.approvals) patch.approvals = { ...config.approvals, mode: mode.value };
		if (priv.checked !== effective.private) patch.private = priv.checked;
		if (trusted.checked !== effective.trusted) patch.trusted = trusted.checked;
		if (dflt.checked !== effective.default) patch.default = dflt.checked;
		const spaces = shared.value.split(",").map((s) => s.trim()).filter(Boolean);
		if (!same(spaces, config.sharedMemory ?? [])) patch.sharedMemory = spaces.length ? spaces : null;
		if (recent && Number(recent.value) !== effective.recentChats) {
			const n = Number(recent.value);
			if (recent.value.trim() === "" || !Number.isInteger(n) || n < 0 || n > 20) return toast("Recent chats must be a whole number from 0 to 20", true);
			// The default (5) is left out of config.yaml.
			patch.recentChats = n === 5 ? null : n;
		}
		if (instr.value.trim() !== (effective.instructions ?? "")) patch.instructions = instr.value.trim() || null;
		if (!Object.keys(patch).length) return toast("Nothing changed");
		restartNote(await api("PATCH", path, patch));
		await ctx.reload();
		botsScreen(false);
	});
	const remove = () => run(async () => {
		const where = ctx.node ? ` on ${ctx.node}` : "";
		if (!await ask(`Remove "${bot.name}"${where} from the config?\n\nIts chats, memory and workspace stay on disk; they just stop being served.`)) return;
		restartNote(await api("DELETE", path));
		ui.bot = null;
		await ctx.reload();
		botsScreen(false);
	});

	return h("div", { class: "card" },
		h("div", { class: "row" }, h("h3", {}, bot.name), ctx.node && badge(`on ${ctx.node}`)),
		h("div", { class: "grid2" }, field("Display name", name), field("Description", desc)),
		h("div", { class: "grid2" }, field("Model", model), field("Thinking", thinking)),
		field("Tool groups", h("div", { class: "checks" }, tools.map((t) => check(t, t.value)))),
		h("div", { class: "grid2" }, field("Approval mode", mode), field("Shared memory spaces", shared, "Comma separated")),
		recent && h("div", { class: "grid2" }, field("Recent chats", recent,
			`How many of its latest chats a new chat is told about (0 turns it off; default 5).${effective.tools.includes("memory") ? "" : " Needs the memory tool group, which is off."}`)),
		h("div", { class: "checks" }, check(priv, "Private"), check(trusted, "Trusted"), check(dflt, ctx.node ? `Default bot on ${ctx.node}` : "Default bot")),
		h("div", { class: "field" }),
		field("Instructions", instr, `Currently from ${sourceNote}. Saving writes them to the bot's config entry${ctx.node ? ` on ${ctx.node}` : ""}.`),
		h("div", { class: "row between" }, h("button", { class: "primary", on: { click: save } }, "Save"), h("button", { class: "danger", on: { click: remove } }, "Remove bot")),
		skillsCard(bot, ctx),
		promptCard(bot, ctx));
}

/** Every skill this bot could use, its own and the global ones, each switched on or off on the spot. */
function skillsCard(bot, ctx) {
	const body = h("div");
	const botPath = `${ctx.base}/bots/${encodeURIComponent(bot.name)}`;
	const path = `${botPath}/skills`;
	const load = () => run(async () => {
		const r = await api("GET", path);
		const row = (s) => {
			const box = h("input", { type: "checkbox", checked: s.active });
			box.addEventListener("change", () => run(async () => {
				try {
					await api("PUT", `${path}/${encodeURIComponent(s.name)}`, { enabled: box.checked });
					toast(`${s.name} ${box.checked ? "on" : "off"} for ${bot.name}`);
				} catch (e) {
					box.checked = !box.checked;
					throw e;
				}
			}));
			return h("label", { class: "skill" }, box,
				h("div", { class: "grow" },
					h("div", { class: "row" }, h("strong", {}, s.name), s.usage > 0 && h("span", { class: "muted small" }, `used ${s.usage}×`)),
					s.description && h("div", { class: "muted small" }, s.description)));
		};
		const group = (title, list, empty) => h("div", {}, h("h2", {}, title), list.length ? list.map(row) : h("div", { class: "muted small" }, empty));
		// "Every global skill" is the bot's skills: ["*"] in config.yaml, so new global skills are on too.
		const all = h("input", { type: "checkbox", checked: r.allGlobal });
		all.addEventListener("change", () => run(async () => {
			const named = (ctx.bots.find((b) => b.name === bot.name)?.config.skills ?? []).filter((s) => s !== "*");
			const skills = all.checked ? ["*"] : named.length ? named : null;
			try {
				restartNote(await api("PATCH", botPath, { skills }));
			} catch (e) {
				all.checked = !all.checked;
				throw e;
			}
			await ctx.reload();
			await load();
		}));
		body.replaceChildren(h("div", {},
			!r.toolGroupOn && h("div", { class: "notice warn small" }, "The skills tool group is off for this bot, so it cannot load any of these."),
			group("This bot's own", r.skills.filter((s) => s.source === "bot"), "None. They live in its bots/<name>/skills folder and are on unless switched off."),
			group("Global", r.skills.filter((s) => s.source === "global"), ctx.node ? `No global skills on ${ctx.node}.` : "No global skills on this machine."),
			h("label", { class: "skill" }, all,
				h("div", { class: "grow" }, h("strong", {}, "Every global skill"),
					h("div", { class: "muted small" }, "Includes ones added later. A skill switched off above stays off."))),
			h("div", { class: "hint" }, "Changes apply from the bot's next message."),
		));
	});
	const details = h("details", { class: "card", on: { toggle: () => details.open && load() } }, h("summary", {}, "Skills"), body);
	return details;
}

/** A generated prompt section's name: the words before the colon that opens it ("Memory", "Recent chats"…). */
function sectionTitle(text) {
	const m = /^([^:\n]{1,60}):/.exec(text);
	return m ? m[1] : undefined;
}

const SECTION_HINTS = {
	Memory: "Generated: pinned memories (Memory tab) and how to use the memory tools.",
	"Recent chats": "Generated: the bot's latest chats as they stand now. Each chat keeps the list it started with (shown with the chat in Sessions); set how many under Recent chats above.",
	Skills: "Generated from the skills switched on above.",
	"About you and nHermes": "Generated for bots with the self tool group.",
};

/** The bot's system prompt as a new chat gets it, loaded when opened; this machine's ground rules are edited here too. */
function promptCard(bot, ctx) {
	const body = h("div");
	const load = () => run(async () => {
		const p = await api("GET", `${ctx.base}/bots/${encodeURIComponent(bot.name)}/prompt`);
		const block = (title, text, hint) => h("div", { class: "field" }, h("span", {}, title), h("pre", { class: "mono pre-wrap prompt" }, text), hint && h("div", { class: "hint" }, hint));
		let rulesPart;
		if (ctx.node) {
			// Ground rules are a gateway setting: each machine's own panel edits its own.
			rulesPart = [block("3. Ground rules", p.groundRules, `Shared by every bot on ${ctx.node}${p.groundRulesCustom ? " (its own text)" : " (built-in text)"}; edit them in ${ctx.node}'s panel.`)];
		} else {
			const rules = h("textarea", { class: "mono tall", value: p.groundRules });
			const saveRules = () => run(async () => {
				if (rules.value.trim() === p.groundRules) return toast("Nothing changed");
				restartNote(await api("PATCH", "/gateway", { groundRules: rules.value.trim() }));
				await load();
			});
			const reset = () => run(async () => {
				if (!await ask("Go back to the built-in ground rules for every bot?")) return;
				restartNote(await api("PATCH", "/gateway", { groundRules: null }));
				await load();
			});
			rulesPart = [
				field("3. Ground rules", rules, `Shared by every bot on this machine${p.groundRulesCustom ? " (your own text, saved in config.yaml)" : " (built-in text)"}.`),
				h("div", { class: "row" }, h("button", { class: "primary", on: { click: saveRules } }, "Save ground rules"), p.groundRulesCustom && h("button", { on: { click: reset } }, "Use the built-in rules")),
			];
		}
		body.replaceChildren(
			block("1. Instructions", p.instructions || "(none)", "This bot's own text; edit it in Instructions above."),
			block("2. Identity", p.identity, "Generated."),
			...rulesPart,
			...p.generated.map((g, i) => {
				const title = sectionTitle(g);
				return block(`${4 + i}. ${title ?? "Generated"}`, g, SECTION_HINTS[title] ?? "Generated from the bot's settings.");
			}),
			h("div", { class: "hint" }, `Tool groups: ${p.tools.join(", ") || "none"}. Each tool's own description is added by the engine.`),
		);
	});
	const details = h("details", { class: "card", on: { toggle: () => details.open && load() } }, h("summary", {}, "System prompt (what a new chat gets)"), body);
	return details;
}

registerTab("bots", botsScreen);
