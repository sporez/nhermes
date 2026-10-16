const TABS = ["bots", "network", "sessions", "memory", "keys", "status", "gateway"];
const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh"];
const view = document.getElementById("view");
let state = null;
let timer = null;
let tab = "bots";
const ui = { bot: null, owner: null, sessionBot: "", archived: "exclude", memoryQ: "", reviewFilter: "" };

// ---- helpers ----
function h(tag, attrs = {}, ...kids) {
	const el = document.createElement(tag);
	for (const [k, v] of Object.entries(attrs)) {
		if (v === undefined || v === null || v === false) continue;
		if (k === "class") el.className = v;
		else if (k === "on") for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
		else if (k in el && k !== "list") el[k] = v;
		else el.setAttribute(k, v === true ? "" : v);
	}
	for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid);
	return el;
}

/** Replaces an element's children; like h(), it accepts lists and skips empty values (replaceChildren would show them as text). */
function fill(el, ...kids) {
	el.replaceChildren(...kids.flat().filter((k) => k !== null && k !== undefined && k !== false));
}

/** Replaces the main view. */
function show(...kids) {
	fill(view, ...kids);
}

/**
 * Copies text. The clipboard API exists only on HTTPS or localhost; the panel is usually plain HTTP on the
 * LAN, so fall back to selecting a hidden field and the older copy command.
 */
async function copyText(text, what = "text") {
	try {
		if (navigator.clipboard && window.isSecureContext) {
			await navigator.clipboard.writeText(text);
			return toast("Copied");
		}
		// Safari (macOS and iOS) copies only a selection it made itself, within the tap or click: a
		// read-only field kept on screen (no keyboard pops up), selected both ways.
		const area = h("textarea", { value: text, readOnly: true, class: "copy-buffer" });
		document.body.append(area);
		area.focus({ preventScroll: true });
		area.select();
		area.setSelectionRange(0, text.length);
		const range = document.createRange();
		range.selectNodeContents(area);
		const sel = window.getSelection();
		let ok = false;
		try {
			ok = document.execCommand("copy");
		} finally {
			area.remove();
			sel?.removeAllRanges();
		}
		ok ? toast("Copied") : toast(`Copy did not work in this browser; tap the ${what} to select it, then copy`, true);
	} catch {
		toast(`Copy did not work in this browser; tap the ${what} to select it, then copy`, true);
	}
}

/** Text that selects whole on a tap, for copying by hand when a browser refuses to copy. */
function selectable(text, cls = "") {
	const el = h("div", { class: `selectable ${cls}` }, text);
	el.addEventListener("click", () => {
		const r = document.createRange();
		r.selectNodeContents(el);
		const s = window.getSelection();
		s?.removeAllRanges();
		s?.addRange(r);
	});
	return el;
}

class AuthError extends Error {}

async function api(method, path, body) {
	const opts = { method, credentials: "same-origin", headers: {} };
	if (method !== "GET") {
		opts.headers = { "content-type": "application/json", "x-nhermes-panel": "1" };
		opts.body = JSON.stringify(body ?? {});
	}
	let res;
	try { res = await fetch(`/panel/api${path}`, opts); } catch { throw new Error("cannot reach the gateway"); }
	const data = await res.json().catch(() => ({}));
	if (res.status === 401 && path !== "/login") { showLogin(); throw new AuthError("sign in"); }
	if (!res.ok) throw new Error(data.detail || `request failed (${res.status})`);
	return data;
}

let toastTimer = null;
function toast(msg, isError = false) {
	const t = document.getElementById("toast");
	t.textContent = msg;
	t.className = isError ? "error" : "";
	t.hidden = false;
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => { t.hidden = true; }, isError ? 7000 : 3500);
}

/** Run an async action, showing errors as a toast. Returns undefined on failure. */
async function run(fn) {
	try { return await fn(); } catch (e) { if (!(e instanceof AuthError)) toast(e.message, true); }
}

function ago(ts) {
	if (!ts) return "never";
	const d = Date.now() / 1000 - ts;
	if (d < 0) return `in ${span(-d)}`;
	if (d < 45) return "just now";
	return `${span(d)} ago`;
}
function span(s) {
	if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min`;
	if (s < 172800) return `${Math.round(s / 3600)} h`;
	return `${Math.round(s / 86400)} d`;
}
const when = (ts) => (ts ? new Date(ts * 1000).toLocaleString() : "");

const field = (label, input, hint) => h("label", { class: "field" }, h("span", {}, label), input, hint && h("div", { class: "hint" }, hint));
const badge = (text, cls = "") => h("span", { class: `badge ${cls}` }, text);
function select(options, value, labels = {}) {
	const s = h("select");
	for (const o of options) s.append(h("option", { value: o, selected: o === value }, labels[o] ?? o));
	return s;
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function loadState() { state = await api("GET", "/state"); }

function restartNote(r) {
	if (!r) return;
	const parts = [];
	if (r.added?.length) parts.push(`added: ${r.added.join(", ")}`);
	if (r.removed?.length) parts.push(`removed: ${r.removed.join(", ")}`);
	if (r.changed?.length) parts.push(`changed: ${r.changed.join(", ")}`);
	if (r.restartNeeded?.length) parts.push(`takes effect after a restart: ${r.restartNeeded.join(", ")}`);
	toast(parts.length ? `Saved. ${parts.join(". ")}` : "Saved. Nothing else changed.");
}

// ---- shell ----
function stopTimer() { clearInterval(timer); timer = null; }

function showLogin() {
	stopTimer();
	document.getElementById("top").hidden = true;
	const pw = h("input", { type: "password", autocomplete: "current-password", autofocus: true });
	const err = h("div", { class: "err" });
	const go = async (e) => {
		e.preventDefault();
		try {
			await api("POST", "/login", { password: pw.value });
			await start();
		} catch (x) { err.textContent = x.message; }
	};
	show(h("form", { class: "card login", on: { submit: go } },
		h("h1", {}, "nHermes panel"), field("Password", pw), err, h("button", { class: "primary", type: "submit" }, "Sign in")));
}

function renderTabs() {
	const nav = document.getElementById("tabs");
	nav.replaceChildren(...TABS.map((t) => h("a", { href: `#${t}`, class: t === tab ? "active" : "" }, t[0].toUpperCase() + t.slice(1))));
}

const SCREENS = { bots: botsScreen, network: networkScreen, sessions: sessionsScreen, memory: memoryScreen, keys: keysScreen, status: statusScreen, gateway: gatewayScreen };

async function route() {
	if (!state) return;
	const name = location.hash.slice(1);
	tab = TABS.includes(name) ? name : "bots";
	stopTimer();
	renderTabs();
	show();
	await run(() => SCREENS[tab]());
}

async function start() {
	const s = await api("GET", "/session");
	if (s.passwordSet && !s.signedIn) return showLogin();
	await loadState();
	document.getElementById("machine").textContent = state.node.name;
	document.title = `${state.node.name} - nHermes`;
	document.getElementById("top").hidden = false;
	void refreshUpdateBadge();
	await route();
}

/** A small "update available" mark next to the machine name (from the gateway's last check). */
async function refreshUpdateBadge(sw) {
	try {
		sw ??= await api("GET", "/software");
		const brand = document.getElementById("machine").parentElement;
		brand.querySelector(".update-badge")?.remove();
		if (sw.available?.length) brand.append(h("a", { href: "#gateway", class: "badge warn update-badge" }, `update available (${sw.available.length})`));
	} catch {
		// Not important enough to report.
	}
}

// ---- Bots ----
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
		if (instr.value.trim() !== (effective.instructions ?? "")) patch.instructions = instr.value.trim() || null;
		if (!Object.keys(patch).length) return toast("Nothing changed");
		restartNote(await api("PATCH", path, patch));
		await ctx.reload();
		botsScreen(false);
	});
	const remove = () => run(async () => {
		const where = ctx.node ? ` on ${ctx.node}` : "";
		if (!confirm(`Remove "${bot.name}"${where} from the config?\n\nIts chats, memory and workspace stay on disk; they just stop being served.`)) return;
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
				if (!confirm("Go back to the built-in ground rules for every bot?")) return;
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
			...p.generated.map((g, i) => block(`${4 + i}. Generated`, g, "From the bot's settings: other bots, memory, skills.")),
			h("div", { class: "hint" }, `Tool groups: ${p.tools.join(", ") || "none"}. Each tool's own description is added by the engine.`),
		);
	});
	const details = h("details", { class: "card", on: { toggle: () => details.open && load() } }, h("summary", {}, "System prompt (what a new chat gets)"), body);
	return details;
}

// ---- Network ----
async function networkScreen() {
	const net = await api("GET", "/network");
	const sec = await api("GET", "/secrets");
	const reload = () => networkScreen();
	const accept = h("input", { type: "checkbox", checked: sec.acceptsFromMembers });
	accept.addEventListener("change", () => run(async () => {
		try { await api("PATCH", "/network/settings", { acceptSecrets: accept.checked }); toast("Saved"); }
		catch (e) { accept.checked = !accept.checked; throw e; }
	}));
	const edits = h("input", { type: "checkbox", checked: net.acceptsBotEdits });
	edits.addEventListener("change", () => run(async () => {
		try { await api("PATCH", "/network/settings", { acceptBotEdits: edits.checked }); toast("Saved"); }
		catch (e) { edits.checked = !edits.checked; throw e; }
	}));
	const plainCount = net.members.filter((m) => !m.encrypted).length;
	const strict = h("input", { type: "checkbox", checked: net.requiresPsk });
	strict.addEventListener("change", () => run(async () => {
		if (strict.checked && plainCount > 0 && !confirm(`${plainCount} member${plainCount === 1 ? " is" : "s are"} not encrypted yet and will be cut off until updated. Refuse plain connections anyway?`)) { strict.checked = false; return; }
		try { await api("PATCH", "/network/settings", { requirePsk: strict.checked }); toast("Saved"); }
		catch (e) { strict.checked = !strict.checked; throw e; }
	}));
	const acceptCard = h("div", { class: "card" },
		h("label", {}, accept, " ", h("strong", {}, "Accept keys from other machines")),
		h("div", { class: "hint" }, "Lets members of this network set keys in this machine's secrets.env. Between machines that are both up to date, keys travel encrypted."),
		h("div", { class: "field" }),
		h("label", {}, edits, " ", h("strong", {}, "Let other machines edit this machine's bots")),
		h("div", { class: "hint" }, "Their panels can then create, edit and remove this machine's bots (private ones included), change their skills and read their system prompts, as this panel can. Hosts, workspaces and keys stay editable only here."),
		h("div", { class: "field" }),
		h("label", {}, strict, " ", h("strong", {}, "Refuse unencrypted connections from all members")),
		h("div", { class: "hint" }, plainCount === 0
			? "Every member talks to this machine encrypted. Turning this on also cuts off any older machine that joins later until it is updated."
			: `${plainCount} member${plainCount === 1 ? " still talks" : "s still talk"} to this machine unencrypted (an older version). Update ${plainCount === 1 ? "it" : "them"} first.`));
	const act = (fn) => () => run(async () => { await fn(); await reload(); });
	const out = h("div");

	const members = net.members.length
		? net.members.map((m) => h("div", { class: "card row between" },
			h("div", { class: "grow" },
				h("div", {}, h("span", { class: `dot ${m.reachable ? "" : "off"}` }), h("strong", {}, m.name), " ", badge(m.reachable ? "reachable" : "unreachable", m.reachable ? "ok" : "bad"), " ",
					m.encrypted ? badge("encrypted", "ok") : badge("not encrypted (update it)", "warn")),
				h("div", { class: "muted small trunc" }, m.url, m.psk_port ? ` · encrypted port ${m.psk_port}` : ""),
				h("div", { class: "muted small" }, `Last seen ${ago(m.last_seen)}`, m.last_error ? ` - ${m.last_error}` : "")),
			h("div", { class: "row" },
				m.encrypted && h("button", { title: "Replace the key this machine and that one share", on: { click: act(async () => {
					await api("POST", `/network/members/${encodeURIComponent(m.name)}/rotate`);
					toast(`New key shared with ${m.name}`);
				}) } }, "Regenerate key"),
				h("button", { class: "danger", on: { click: act(async () => {
					if (!confirm(`Remove ${m.name} from the network?`)) return;
					await api("DELETE", `/network/members/${encodeURIComponent(m.name)}`);
				}) } }, "Remove"))))
		: [h("div", { class: "notice" }, "No other machines yet. Use \"Invite a machine\" to add one.")];

	const url = h("input", { type: "text", placeholder: "Optional: address other machines should use for this one" });
	const invite = () => run(async () => {
		const r = await api("POST", "/network/invite", url.value.trim() ? { url: url.value.trim() } : {});
		showInvite(out, r);
	});
	const inviteBtn = h("button", { class: "primary", on: { click: invite } }, "Invite a machine");
	out.append(joinBox(reload));

	show(
		h("div", { class: "row between" }, h("h1", {}, "Network"), h("button", { on: { click: act(async () => { await api("POST", "/network/refresh"); toast("Refreshed"); }) } }, "Refresh")),
		h("h2", {}, "This machine"),
		h("div", { class: "card" }, h("strong", {}, net.self.name), h("div", { class: "muted small" }, net.self.url),
			h("div", { class: "muted small" }, net.pskPort ? `Encrypted port for other machines: ${net.pskPort}` : "No encrypted port (it could not be opened; see the log)")),
		acceptCard,
		h("h2", {}, "Members"), members,
		h("div", { class: "field" }, url),
		h("div", { class: "row" }, inviteBtn,
			net.members.length > 0 && h("button", { class: "danger", on: { click: act(async () => {
				if (!confirm("Leave this network? Other machines' bots will disappear from this gateway.")) return;
				await api("POST", "/network/leave");
			}) } }, "Leave network")),
		out);
}

function showInvite(out, r) {
	const copy = h("button", { on: { click: () => copyText(r.code, "code") } }, "Copy");
	const card = h("div", { class: "card" }, h("h3", {}, "Invitation code"), selectable(r.code, "code"), copy,
		h("p", {}, "On the other machine run: ", h("span", { class: "mono" }, `nhermes join ${r.code}`), ", or paste the code in its panel."),
		h("div", { class: "muted small" }, `Expires ${when(r.expiresAt)} (${ago(r.expiresAt)}).`));
	out.prepend(card);
}

function joinBox(reload) {
	const code = h("input", { type: "text", placeholder: "Paste an invitation code" });
	const result = h("div");
	const preview = () => run(async () => {
		const p = await api("POST", "/network/preview", { code: code.value.trim() });
		const confirmJoin = () => run(async () => {
			await api("POST", "/network/join", { code: code.value.trim() });
			toast(`Joined ${p.name}`);
			await loadState();
			reload();
		});
		result.replaceChildren(h("div", { class: "notice" },
			h("div", {}, "Join the network of ", h("strong", {}, p.name), h("span", { class: "muted" }, ` (${p.url})`), "?"),
			h("div", { class: "muted small" }, `${p.members} machine${p.members === 1 ? "" : "s"} in that network`),
			h("div", { class: "row" }, h("button", { class: "primary", on: { click: confirmJoin } }, "Join"), h("button", { on: { click: () => result.replaceChildren() } }, "Cancel"))));
	});
	return h("div", { class: "card" }, h("h3", {}, "Join a network"), h("div", { class: "row" }, h("div", { class: "grow" }, code), h("button", { on: { click: preview } }, "Preview")), result);
}

// ---- Sessions ----
const tokens = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : `${n}`);
const dollars = (n) => (n >= 1 ? `$${n.toFixed(2)}` : n >= 0.01 ? `$${n.toFixed(3)}` : `$${n.toFixed(4)}`);

/** One line of a chat's spend: tokens, share of the prompt read from cache, calls, cost and model. */
function spendLine(u) {
	const prompt = u.input + u.cacheRead + u.cacheWrite;
	const parts = [
		`${tokens(u.total)} tokens (${tokens(prompt)} in, ${tokens(u.output)} out${u.reasoning ? `, ${tokens(u.reasoning)} reasoning` : ""})`,
		prompt > 0 && `${Math.round((u.cacheRead / prompt) * 100)}% cached`,
		u.calls > 0 && `${u.calls} ${u.calls === 1 ? "call" : "calls"}`,
		u.costUsd > 0 && dollars(u.costUsd),
		u.models.length && u.models.join(", "),
	].filter(Boolean);
	const title = `Input ${u.input.toLocaleString()} · cache read ${u.cacheRead.toLocaleString()} · cache write ${u.cacheWrite.toLocaleString()} · output ${u.output.toLocaleString()}`;
	return h("div", { class: "muted small trunc", title }, parts.join(" - "));
}

async function sessionsScreen() {
	const q = new URLSearchParams({ archived: ui.archived });
	if (ui.sessionBot) q.set("bot", ui.sessionBot);
	const { sessions } = await api("GET", `/sessions?${q}`);
	const redo = () => run(sessionsScreen);
	const bots = ["", ...state.bots.map((b) => b.name), ...state.remoteBots.map((b) => b.name)];
	const botSel = select(bots, ui.sessionBot, { "": "All bots" });
	const archSel = select(["exclude", "only", "include"], ui.archived, { exclude: "Active", only: "Archived", include: "All" });
	botSel.addEventListener("change", () => { ui.sessionBot = botSel.value; redo(); });
	archSel.addEventListener("change", () => { ui.archived = archSel.value; redo(); });
	const patch = (s, body) => () => run(async () => { await api("PATCH", `/sessions/${s.id}`, body); await sessionsScreen(); });

	const rows = sessions.map((s) => h("div", { class: "card" },
		h("div", { class: "row between" },
			h("div", { class: "grow" },
				h("div", { class: "row" }, h("strong", { class: "trunc" }, s.title || "Untitled"), badge(s.bot), s.kind !== "chat" && badge(s.kind), s.running && badge("running", "ok"), s.archived && badge("archived"), s.remote && badge("remote")),
				h("div", { class: "muted small" }, `${ago(s.lastActive)} - ${s.messages} messages`),
				s.usage && spendLine(s.usage),
				s.preview && h("div", { class: "muted small trunc" }, s.preview)),
			h("div", { class: "row" },
				h("button", { class: "link", on: { click: () => {
					const t = prompt("Rename chat", s.title || "");
					if (t !== null && t.trim()) patch(s, { title: t.trim() })();
				} } }, "Rename"),
				h("button", { class: "link", on: { click: patch(s, { archived: !s.archived }) } }, s.archived ? "Unarchive" : "Archive"),
				s.running && h("button", { class: "link", on: { click: () => run(async () => { await api("POST", `/sessions/${s.id}/stop`); await sessionsScreen(); }) } }, "Stop"),
				h("button", { class: "link danger", on: { click: () => run(async () => {
					if (!confirm(`Delete "${s.title || "Untitled"}"? This cannot be undone.`)) return;
					await api("DELETE", `/sessions/${s.id}`);
					await sessionsScreen();
				}) } }, "Delete")))));

	show(h("h1", {}, "Sessions"), h("p", { class: "muted" }, "Read and continue chats in Vory."),
		h("div", { class: "row" }, botSel, archSel),
		h("div", { class: "field" }),
		rows.length ? rows : h("div", { class: "notice" }, "No sessions match."));
}

// ---- Memory ----
async function memoryScreen() {
	const owners = [...state.bots.map((b) => b.name), ...state.spaces.map((s) => `shared:${s}`)];
	if (!owners.length) return show(h("h1", {}, "Memory"), h("div", { class: "notice" }, "No bots to show memory for."));
	if (!owners.includes(ui.owner)) ui.owner = owners[0];
	const labels = Object.fromEntries(state.spaces.map((s) => [`shared:${s}`, `Shared: ${s}`]));
	const ownerSel = select(owners, ui.owner, labels);
	const search = h("input", { type: "text", placeholder: "Search", value: ui.memoryQ });
	const redo = () => run(memoryScreen);
	ownerSel.addEventListener("change", () => { ui.owner = ownerSel.value; redo(); });
	search.addEventListener("keydown", (e) => { if (e.key === "Enter") { ui.memoryQ = search.value.trim(); redo(); } });
	const { items } = await api("GET", `/memory?owner=${encodeURIComponent(ui.owner)}&q=${encodeURIComponent(ui.memoryQ)}`);
	items.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
	const del = (m) => () => run(async () => {
		if (!confirm("Delete this memory?")) return;
		await api("DELETE", `/memory/${m.id}?owner=${encodeURIComponent(ui.owner)}`);
		await memoryScreen();
	});
	const pin = (m) => () => run(async () => { await api("PATCH", `/memory/${m.id}`, { owner: ui.owner, pinned: !m.pinned }); await memoryScreen(); });

	const card = (m) => {
		const body = h("div", {}, m.title && h("strong", {}, m.title), h("div", { class: "pre-wrap" }, m.body),
			h("div", { class: "muted small" }, [m.pinned && "pinned", m.owner !== ui.owner && `owner: ${m.owner}`, m.source, `updated ${ago(m.updated_at)}`].filter(Boolean).join(" - ")));
		const wrap = h("div", { class: "card" });
		const view_ = () => wrap.replaceChildren(h("div", { class: "row between" }, h("div", { class: "grow" }, body),
			h("div", { class: "row" },
				h("button", { class: "link", on: { click: pin(m) } }, m.pinned ? "Unpin" : "Pin"),
				h("button", { class: "link", on: { click: edit } }, "Edit"),
				h("button", { class: "link danger", on: { click: del(m) } }, "Delete"))));
		const edit = () => {
			const title = h("input", { type: "text", value: m.title ?? "", placeholder: "Title (optional)" });
			const text = h("textarea", { value: m.body });
			const save = () => run(async () => {
				await api("PATCH", `/memory/${m.id}`, { owner: ui.owner, body: text.value, title: title.value });
				await memoryScreen();
			});
			wrap.replaceChildren(field("Title", title), field("Text", text), h("div", { class: "row" }, h("button", { class: "primary", on: { click: save } }, "Save"), h("button", { on: { click: view_ } }, "Cancel")));
		};
		view_();
		return wrap;
	};

	const title = h("input", { type: "text", placeholder: "Title (optional)" });
	const text = h("textarea", { placeholder: "Something to remember" });
	const pinned = h("input", { type: "checkbox" });
	const add = () => run(async () => {
		if (!text.value.trim()) return toast("Write something first", true);
		await api("POST", "/memory", { owner: ui.owner, body: text.value, title: title.value || undefined, pinned: pinned.checked });
		await memoryScreen();
	});

	show(h("h1", {}, "Memory"),
		h("div", { class: "grid2" }, field("Whose memory", ownerSel), field("Search (Enter)", search)),
		h("details", { class: "card" }, h("summary", {}, "Add a memory"), h("div", { class: "field" }), field("Title", title), field("Text", text),
			h("div", { class: "row between" }, h("label", {}, pinned, " Pin"), h("button", { class: "primary", on: { click: add } }, "Add"))),
		items.length ? items.map(card) : h("div", { class: "notice" }, ui.memoryQ ? "Nothing matches that search." : "No memories yet."));
}

// ---- Keys ----
const GATEWAY_TOKEN_KEY = "NHERMES_TOKEN";
const KEY_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

function memberChecks(members, label = "Also set on") {
	const boxes = members.map((m) => h("input", { type: "checkbox", value: m.name, disabled: !m.reachable }));
	const el = members.length
		? h("div", { class: "field" }, h("span", { class: "small muted" }, label),
			h("div", { class: "checks" }, members.map((m, i) => h("label", {}, boxes[i], m.name, m.reachable ? "" : " (unreachable)"))))
		: null;
	return { el, picked: () => boxes.filter((b) => b.checked).map((b) => b.value) };
}

function reportKeySave(r) {
	const bad = (r.members ?? []).filter((m) => !m.ok);
	const good = (r.members ?? []).filter((m) => m.ok);
	const parts = ["Saved."];
	if (good.length) parts.push(`Also set on ${good.map((m) => m.name).join(", ")}.`);
	if (bad.length) parts.push(`Failed: ${bad.map((m) => `${m.name} (${m.error ?? "error"})`).join("; ")}.`);
	if (r.restartNeeded) parts.push("Takes effect after a restart.");
	toast(parts.join(" "), bad.length > 0);
}

async function keysScreen() {
	const data = await api("GET", "/secrets");
	const redo = () => run(keysScreen);
	const newToken = h("div");

	const generate = () => run(async () => {
		if (!confirm("Generate a new gateway token? The old one stops working after the gateway restarts.")) return;
		const t = await api("POST", "/token/new");
		const box = h("div", { class: "card" }, h("h3", {}, "New token for ", h("span", { class: "mono" }, t.name)),
			h("div", { class: "notice warn" }, "Shown only once. Vory and the nhermes command need this new token after the gateway restarts."),
			selectable(t.value, "code mono"),
			h("div", { class: "row" },
				h("button", { on: { click: () => copyText(t.value, "token") } }, "Copy"),
				h("button", { on: { click: () => { newToken.replaceChildren(); redo(); } } }, "Done (hide it)")));
		newToken.replaceChildren(box);
	});

	const card = (k) => {
		const wrap = h("div", { class: "card" });
		const hint = h("span", { class: "mono" });
		const isToken = k.name === GATEWAY_TOKEN_KEY;
		const head = h("div", { class: "grow" },
			h("div", { class: "row" }, h("strong", { class: "mono" }, k.name), badge(k.set ? "set" : "not set", k.set ? "ok" : "warn"),
				k.source === "environment" && badge("from the environment (read-only)"),
				k.restartOnly && badge("restart needed to take effect")),
			k.description && h("div", { class: "muted small" }, k.description),
			k.usedBy?.length > 0 && h("div", { class: "muted small" }, `used by: ${k.usedBy.join(", ")}`),
			k.updatedAt && h("div", { class: "muted small" }, `updated ${ago(k.updatedAt)}`),
			h("div", { class: "small" }, hint));
		const editable = k.source !== "environment";
		const identify = () => run(async () => {
			const r = await api("POST", `/secrets/${encodeURIComponent(k.name)}/hint`);
			hint.textContent = `ends with ${r.hint}`;
		});
		const remove = () => run(async () => {
			if (!confirm(`Remove ${k.name} from secrets.env?`)) return;
			const r = await api("DELETE", `/secrets/${encodeURIComponent(k.name)}`);
			toast(r.restartNeeded ? "Removed. Takes effect after a restart." : "Removed");
			await keysScreen();
		});
		const edit = () => {
			const value = h("input", { type: "password", autocomplete: "off", placeholder: "New value" });
			const checks = isToken ? { el: null, picked: () => [] } : memberChecks(data.members);
			const save = () => run(async () => {
				if (!value.value) return toast("Enter a value first", true);
				const body = { value: value.value };
				const also = checks.picked();
				if (also.length) body.alsoOn = also;
				value.value = "";
				reportKeySave(await api("PUT", `/secrets/${encodeURIComponent(k.name)}`, body));
				await keysScreen();
			});
			const cancel = () => { value.value = ""; draw(); };
			wrap.replaceChildren(head, h("div", { class: "field" }), field(k.set ? "Replace value" : "Value", value), checks.el,
				h("div", { class: "row" }, h("button", { class: "primary", on: { click: save } }, "Save"), h("button", { on: { click: cancel } }, "Cancel")));
		};
		const send = () => {
			const checks = memberChecks(data.members, "Send to");
			const go = () => run(async () => {
				const to = checks.picked();
				if (!to.length) return toast("Pick a machine first", true);
				const r = await api("POST", `/secrets/${encodeURIComponent(k.name)}/send`, { to });
				const bad = r.members.filter((m) => !m.ok);
				const good = r.members.filter((m) => m.ok);
				const parts = [];
				if (good.length) parts.push(`Sent to ${good.map((m) => m.name).join(", ")}.`);
				if (bad.length) parts.push(`Failed: ${bad.map((m) => `${m.name} (${m.error ?? "error"})`).join("; ")}.`);
				toast(parts.join(" "), bad.length > 0);
				if (!bad.length) draw();
			});
			wrap.replaceChildren(head, h("div", { class: "field" }), checks.el,
				h("div", { class: "muted small" }, "The machine must have \"Accept keys from other machines\" on (its panel, Network)."),
				h("div", { class: "row" }, h("button", { class: "primary", on: { click: go } }, "Send"), h("button", { on: { click: draw } }, "Cancel")));
		};
		const draw = () => wrap.replaceChildren(h("div", { class: "row between" }, head,
			h("div", { class: "row" },
				editable && !isToken && h("button", { on: { click: edit } }, k.set ? "Replace" : "Set"),
				k.set && !isToken && data.members.length > 0 && h("button", { on: { click: send } }, "Send to…"),
				isToken && h("button", { on: { click: generate } }, "Generate new token"),
				k.set && h("button", { class: "link", on: { click: identify } }, "Identify"),
				k.set && editable && !isToken && h("button", { class: "link danger", on: { click: remove } }, "Remove"))));
		draw();
		return wrap;
	};

	const name = h("input", { type: "text", placeholder: "EXAMPLE_API_KEY", autocapitalize: "off", autocomplete: "off" });
	const value = h("input", { type: "password", autocomplete: "off" });
	const addChecks = memberChecks(data.members);
	const err = h("div", { class: "err" });
	const add = () => run(async () => {
		err.textContent = "";
		const n = name.value.trim();
		if (!KEY_NAME.test(n)) { err.textContent = "Use letters, digits and underscores, not starting with a digit (max 64 characters)."; return; }
		if (!value.value) { err.textContent = "Enter a value."; return; }
		const body = { value: value.value };
		const also = addChecks.picked();
		if (also.length) body.alsoOn = also;
		value.value = "";
		reportKeySave(await api("PUT", `/secrets/${encodeURIComponent(n)}`, body));
		await keysScreen();
	});

	show(h("h1", {}, "Keys"),
		h("p", { class: "muted" }, "Keys and tokens in this machine's secrets.env. Values can be set but are never shown."),
		newToken,
		data.secrets.length ? data.secrets.map(card) : h("div", { class: "notice" }, "No keys yet."),
		h("details", { class: "card" }, h("summary", {}, "Add a key"), h("div", { class: "field" }),
			field("Name", name), field("Value", value), addChecks.el, err,
			h("button", { class: "primary", on: { click: add } }, "Save")));
}

// ---- Status ----
const OUTCOMES = { auto_allowed: ["auto-approved", "ok"], asked: ["sent to you", "warn"], unavailable: ["unavailable", ""] };

async function reviewSection() {
	const q = new URLSearchParams({ limit: "30" });
	if (ui.reviewFilter) q.set("outcome", ui.reviewFilter);
	const r = await api("GET", `/reviews?${q}`);
	const rv = state.review;
	let line;
	if (r.active) line = badge("active", "ok");
	else if (rv && !rv.enabled) line = h("span", { class: "muted small" }, "Turned off. Enable it on the Gateway tab.");
	else if (rv && !rv.keySet) line = h("span", { class: "muted small" }, "No key set: add ", h("span", { class: "mono" }, rv.keyEnv), " on the ", h("a", { href: "#keys" }, "Keys"), " tab.");
	else line = h("span", { class: "muted small" }, "Not active. Check the Gateway tab.");
	const day = r.lastDay ?? {};
	const filter = select(["", ...Object.keys(OUTCOMES)], ui.reviewFilter, { "": "All", auto_allowed: "Auto-approved", asked: "Sent to you", unavailable: "Unavailable" });
	filter.addEventListener("change", () => { ui.reviewFilter = filter.value; run(statusScreen); });
	const item = (x) => {
		const [label, cls] = OUTCOMES[x.outcome] ?? [x.outcome, ""];
		return h("div", { class: "card" },
			h("div", { class: "row" }, h("span", { class: "muted small" }, ago(x.at)), badge(x.bot), badge(label, cls), h("strong", { class: "small" }, x.tool),
				x.elapsed_ms != null && h("span", { class: "muted small" }, `${x.elapsed_ms} ms`),
				x.owner_choice && h("span", { class: "small" }, `you chose: ${x.owner_choice}`)),
			h("div", { class: "mono trunc review-cmd", title: x.command ?? "", on: { click: (e) => e.currentTarget.classList.toggle("trunc") } }, x.command ?? ""),
			x.reasons?.length > 0 && h("div", { class: "muted small" }, `guard: ${[].concat(x.reasons).join("; ")}`),
			x.detail && h("div", { class: "muted small" }, x.detail));
	};
	return [h("h2", {}, "Permission reviews (Jev)"),
		h("div", { class: "card" }, h("div", { class: "row between" }, line,
			h("span", { class: "small" }, `Last day: ${day.auto_allowed ?? 0} auto-approved, ${day.asked ?? 0} sent to you, ${day.unavailable ?? 0} unavailable`))),
		h("div", { class: "row" }, filter),
		h("div", { class: "field" }),
		r.reviews.length ? r.reviews.map(item) : h("div", { class: "muted" }, "No reviews yet.")].flat();
}

async function statusScreen() {
	const s = await api("GET", "/status");
	await loadState();
	const reviews = await reviewSection();
	const answer = (a, choice) => () => run(async () => { await api("POST", `/approvals/${a.id}`, { choice }); await statusScreen(); });
	const approvals = s.approvals.map((a) => h("div", { class: "card" },
		h("div", { class: "row" }, h("strong", {}, a.tool), badge(a.bot), h("span", { class: "muted small" }, ago(a.createdAt))),
		h("pre", { class: "mono pre-wrap" }, a.command || ""),
		a.description && h("div", { class: "muted small" }, a.description),
		h("div", { class: "field" }),
		h("div", { class: "row" },
			h("button", { class: "primary", on: { click: answer(a, "once") } }, "Allow once"),
			h("button", { on: { click: answer(a, "session") } }, "Allow for this chat"),
			h("button", { on: { click: answer(a, "always") } }, "Always allow"),
			h("button", { class: "danger", on: { click: answer(a, "deny") } }, "Deny"))));

	const jobRow = (j) => h("tr", {},
		h("td", {}, h("div", {}, j.name), h("div", { class: "muted small" }, j.bot)),
		h("td", {}, j.running ? badge("running", "ok") : j.enabled ? badge("scheduled") : badge("paused", "warn")),
		h("td", { class: "hide-s" }, j.enabled ? ago(j.nextRunAt) : ""),
		h("td", {}, j.lastRunAt ? `${j.lastStatus ?? ""} ${ago(j.lastRunAt)}` : "never", j.lastError && h("div", { class: "err small" }, j.lastError)),
		h("td", {}, h("button", { class: "link", on: { click: () => run(async () => { await api("POST", `/jobs/${j.id}/${j.enabled ? "pause" : "resume"}`); await statusScreen(); }) } }, j.enabled ? "Pause" : "Resume")));

	show(h("h1", {}, "Status"),
		h("div", { class: "card" }, h("strong", {}, String(s.running)), ` ${s.running === 1 ? "chat" : "chats"} running right now`),
		h("h2", {}, "Waiting for you"),
		approvals.length ? approvals : h("div", { class: "muted" }, "Nothing is waiting for approval."),
		h("h2", {}, "Scheduled jobs"),
		s.jobs.length
			? h("div", { class: "card" }, h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, "Job"), h("th", {}, "State"), h("th", { class: "hide-s" }, "Next run"), h("th", {}, "Last run"), h("th"))), h("tbody", {}, s.jobs.map(jobRow))))
			: h("div", { class: "muted" }, "No scheduled jobs."),
		reviews);
	if (!timer) timer = setInterval(() => { if (tab === "status" && !document.hidden) run(statusScreen); }, 5000);
}

// ---- Gateway ----
async function gatewayScreen() {
	const g = state.gateway;
	const host = h("input", { type: "text", value: g.server.host });
	const port = h("input", { type: "number", value: g.server.port, min: 1, max: 65535 });
	const pname = h("input", { type: "text", value: g.server.publicName ?? "" });
	const models = [...state.models];
	if (g.defaults.model && !models.includes(g.defaults.model)) models.unshift(g.defaults.model);
	const model = select(models, g.defaults.model);
	const thinking = select(THINKING, g.defaults.thinking);
	const mode = select(["smart", "manual", "off"], g.defaults.approvals);
	const timeout = h("input", { type: "number", value: g.defaults.approvalTimeoutS, min: 1 });
	const tz = h("input", { type: "text", value: g.timezone ?? "", placeholder: "America/New_York" });
	const rv = state.review;
	const rvOn = h("input", { type: "checkbox", checked: rv.enabled });
	const rvThr = h("input", { type: "number", value: rv.allowThreshold, min: 0.5, max: 1, step: 0.05 });
	const rvTime = h("input", { type: "number", value: rv.timeoutMs, min: 500, max: 30000, step: 100 });

	const save = () => run(async () => {
		const patch = {};
		const server = {}, defaults = {};
		if (host.value.trim() !== g.server.host) server.host = host.value.trim();
		if (Number(port.value) !== g.server.port) server.port = Number(port.value);
		if (pname.value.trim() !== (g.server.publicName ?? "")) server.name = pname.value.trim();
		if (model.value !== g.defaults.model) defaults.model = model.value;
		if (thinking.value !== g.defaults.thinking) defaults.thinking = thinking.value;
		if (mode.value !== g.defaults.approvals) defaults.approvals = mode.value;
		if (Number(timeout.value) !== g.defaults.approvalTimeoutS) defaults.approvalTimeoutS = Number(timeout.value);
		if (Object.keys(server).length) patch.server = server;
		if (Object.keys(defaults).length) patch.defaults = defaults;
		if (tz.value.trim() !== (g.timezone ?? "")) patch.timezone = tz.value.trim();
		const review = {};
		if (rvOn.checked !== rv.enabled) review.enabled = rvOn.checked;
		if (Number(rvThr.value) !== rv.allowThreshold) review.allowThreshold = Number(rvThr.value);
		if (Number(rvTime.value) !== rv.timeoutMs) review.timeoutMs = Number(rvTime.value);
		if (Object.keys(review).length) patch.review = review;
		if (!Object.keys(patch).length) return toast("Nothing changed");
		restartNote(await api("PATCH", "/gateway", patch));
		await loadState();
		gatewayScreen();
	});

	const setPassword = (remove) => () => run(async () => {
		if (remove) {
			if (!confirm("Remove the panel password? Anyone on your network will be able to open this panel.")) return;
			await api("POST", "/password", { password: null });
		} else {
			const p = prompt("New panel password (at least 6 characters)");
			if (p === null) return;
			if (p.length < 6) return toast("The password must be at least 6 characters", true);
			await api("POST", "/password", { password: p });
		}
		await loadState();
		toast(remove ? "Password removed" : "Password saved");
		gatewayScreen();
	});
	const set = state.panel.passwordSet;
	const pass = set
		? h("div", {}, h("p", {}, "Password is on."), h("div", { class: "row" }, h("button", { on: { click: setPassword(false) } }, "Change"), h("button", { class: "danger", on: { click: setPassword(true) } }, "Remove"),
			h("button", { on: { click: () => run(async () => { await api("POST", "/logout"); showLogin(); }) } }, "Sign out")))
		: h("div", {}, h("p", { class: "muted" }, "No password: anyone on your network can open this panel."), h("button", { on: { click: setPassword(false) } }, "Set a password"));

	show(h("h1", {}, "Gateway"),
		connectCard(),
		h("div", { class: "card" }, h("strong", {}, state.node.name), h("div", { class: "muted small" }, state.node.url), h("div", { class: "muted small mono" }, state.configPath)),
		h("div", { class: "card" }, h("h3", {}, "Defaults"),
			h("div", { class: "grid2" }, field("Model", model), field("Thinking", thinking), field("Approval mode", mode), field("Approval timeout (seconds)", timeout, "Takes effect after a restart")),
			h("h3", {}, "Server"),
			h("div", { class: "grid2" }, field("Host", host), field("Port", port), field("Public name", pname), field("Time zone", tz)),
			h("div", { class: "hint" }, "Server and time zone changes take effect after a restart."),
			h("h3", {}, "Permission review (Jev)"),
			h("div", { class: "checks" }, h("label", {}, rvOn, "Review commands before asking you")),
			h("div", { class: "grid2" }, field("Auto-approve threshold (0.5 to 1)", rvThr), field("Timeout (ms)", rvTime)),
			h("div", { class: "field" }, h("span", { class: "small muted" }, "Key variable "), h("span", { class: "mono" }, rv.keyEnv), " ",
				badge(rv.keySet ? "set" : "not set", rv.keySet ? "ok" : "warn"), " ", h("a", { href: "#keys" }, "Keys")),
			h("div", { class: "hint" }, "Commands and the owner's recent messages are sent to OpenRouter/TypeSafe for review; known secrets are removed first."),
			h("div", { class: "field" }), h("button", { class: "primary", on: { click: save } }, "Save")),
		modelListsCard(),
		h("div", { class: "card" }, h("h3", {}, "Panel password"), pass),
		softwareCard());
}

/** Which providers' models appear in the model pickers here and in Vory. */
function modelListsCard() {
	const boxes = (state.modelProviders ?? []).map((p) => ({ p, box: h("input", { type: "checkbox", checked: p.shown }) }));
	const save = () => run(async () => {
		const hide = boxes.filter((b) => !b.box.checked).map((b) => b.p.name);
		restartNote(await api("PATCH", "/gateway", { modelLists: { hide } }));
		await loadState();
	});
	return h("div", { class: "card" }, h("h3", {}, "Model lists"),
		h("p", { class: "muted small" }, "Providers whose models appear in model pickers (this panel and Vory). A model already in use stays listed."),
		boxes.length
			? h("div", { class: "checks" }, boxes.map(({ p, box }) => h("label", {}, box, ` ${p.name} (${p.models})`)))
			: h("div", { class: "muted" }, "No model providers are connected."),
		h("div", { class: "field" }), h("button", { class: "primary", on: { click: save } }, "Save"));
}

/** What a client such as Vory needs: an address and the gateway token (shown only when asked). */
function connectCard() {
	const addresses = h("div", {}, h("div", { class: "muted small" }, "Loading…"));
	const tokenBox = h("div");
	const hideToken = () => tokenBox.replaceChildren(h("button", { on: { click: showToken } }, "Show token"));
	const showToken = () => run(async () => {
		const r = await api("POST", "/connect/token");
		fill(tokenBox,
			h("div", { class: "row" }, selectable(r.token, "mono token"),
				h("button", { on: { click: () => copyText(r.token, "token") } }, "Copy"),
				h("button", { class: "link", on: { click: hideToken } }, "Hide")),
			r.newTokenAfterRestart && h("div", { class: "notice warn" }, "A new token was generated in Keys; this one stops working when the gateway restarts."),
		);
	});
	hideToken();
	run(async () => {
		const r = await api("GET", "/connect");
		addresses.replaceChildren(...(r.addresses.length
			? r.addresses.map((a) => h("div", { class: "row between" },
				h("div", {}, selectable(a.url, "mono"), h("div", { class: "muted small" }, a.label)),
				h("button", { on: { click: () => copyText(a.url, "address") } }, "Copy")))
			: [h("div", { class: "muted" }, "No network address found.")]));
	});
	return h("div", { class: "card" }, h("h3", {}, "Connect a client"),
		h("p", { class: "muted small" }, "In Vory: Settings → Gateways → Add. Use one of these addresses, choose Session token, and paste the token."),
		h("div", { class: "field" }, h("span", {}, "Address"), addresses),
		h("div", { class: "field" }, h("span", {}, "Token"), tokenBox,
			h("div", { class: "hint" }, "Every device uses this same token. To cut all devices off, generate a new one in Keys and enter it again on the ones you keep.")));
}

/** Version, what is new on GitHub, update (the gateway restarts) and going back. */
function softwareCard() {
	const body = h("div", {}, h("div", { class: "muted small" }, "Loading…"));
	const commitLine = (c) => h("div", { class: "row" }, h("span", { class: "mono" }, c.hash), h("span", {}, c.subject), h("span", { class: "muted small" }, ago(c.date)));
	const waitForRestart = async () => {
		toast("Updating; the gateway is restarting…");
		await new Promise((r) => setTimeout(r, 3000));
		for (let i = 0; i < 40; i++) {
			try {
				await api("GET", "/session");
				location.reload();
				return;
			} catch {
				await new Promise((r) => setTimeout(r, 1500));
			}
		}
		toast("The gateway has not come back yet; check its logs.", true);
	};
	const change = (path, question) => run(async () => {
		if (!confirm(question)) return;
		const r = await api("POST", path);
		if (r.restarting) return waitForRestart();
		toast(`Now at ${r.to.hash}. Restart the gateway to run it.`);
		render(await api("GET", "/software"));
	});
	const render = (sw) => {
		void refreshUpdateBadge(sw);
		const running = sw.running ? ` ${sw.running} running chat${sw.running === 1 ? "" : "s"} will pause for a few seconds and carry on.` : "";
		const restartNote = sw.managed ? `The gateway restarts by itself.${running}` : "This gateway is not running as a service: restart it yourself afterwards.";
		fill(body,
			sw.current ? h("div", {}, h("span", { class: "muted small" }, "Running "), commitLine(sw.current)) : h("div", { class: "muted" }, "Version unknown."),
			h("div", { class: "muted small" }, `From ${sw.remote ?? "an unknown source"}${sw.branch ? ` (${sw.branch})` : ""} · last checked ${sw.lastCheck ? ago(sw.lastCheck) : "never"}`),
			sw.updatable ? null : h("div", { class: "notice" }, sw.reason),
			sw.available.length
				? h("div", { class: "field" }, h("strong", {}, `${sw.available.length} new commit${sw.available.length === 1 ? "" : "s"}`), ...sw.available.map(commitLine))
				: h("div", { class: "field muted" }, "Up to date."),
			h("div", { class: "row" },
				h("button", { on: { click: () => run(async () => render(await api("POST", "/software/check"))) } }, "Check now"),
				sw.updatable && sw.available.length > 0 && h("button", { class: "primary", on: { click: () => change("/software/update", `Update to ${sw.available[0].hash}?\n\n${restartNote}`) } }, "Update now"),
				sw.previous && h("button", { on: { click: () => change("/software/rollback", `Go back to ${sw.previous.hash} (${sw.previous.subject})?\n\n${restartNote}`) } }, `Go back to ${sw.previous.hash}`)),
			h("div", { class: "hint" }, restartNote),
		);
	};
	run(async () => render(await api("GET", "/software")));
	return h("div", { class: "card" }, h("h3", {}, "Software"), body);
}

window.addEventListener("hashchange", route);
run(start);
