const TABS = ["bots", "network", "sessions", "memory", "status", "gateway"];
const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh"];
const view = document.getElementById("view");
let state = null;
let timer = null;
let tab = "bots";
const ui = { bot: null, owner: null, sessionBot: "", archived: "exclude", memoryQ: "" };

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

/** Replaces the main view; like h(), it accepts lists and skips empty values. */
function show(...kids) {
	view.replaceChildren(...kids.flat().filter((k) => k !== null && k !== undefined && k !== false));
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
		h("h1", {}, "nhermes panel"), field("Password", pw), err, h("button", { class: "primary", type: "submit" }, "Sign in")));
}

function renderTabs() {
	const nav = document.getElementById("tabs");
	nav.replaceChildren(...TABS.map((t) => h("a", { href: `#${t}`, class: t === tab ? "active" : "" }, t[0].toUpperCase() + t.slice(1))));
}

const SCREENS = { bots: botsScreen, network: networkScreen, sessions: sessionsScreen, memory: memoryScreen, status: statusScreen, gateway: gatewayScreen };

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
	document.title = `${state.node.name} - nhermes`;
	document.getElementById("top").hidden = false;
	await route();
}

// ---- Bots ----
async function botsScreen() {
	const local = state.bots;
	if (!ui.bot || (ui.bot !== "+new" && !local.some((b) => b.name === ui.bot))) ui.bot = local[0]?.name ?? "+new";
	const pick = (name) => { ui.bot = name; botsScreen(); };
	const list = h("ul", { class: "list" }, local.map((b) => h("li", { class: b.name === ui.bot ? "active" : "", on: { click: () => pick(b.name) } },
		h("div", { class: "trunc" }, b.effective.displayName || b.name),
		h("div", { class: "row small muted" }, b.name, b.effective.default && badge("default"), b.effective.private && badge("private"), b.effective.trusted && badge("trusted")))));
	list.append(h("li", { class: ui.bot === "+new" ? "active" : "", on: { click: () => pick("+new") } }, "+ New bot"));

	const remote = h("div");
	const nodes = [...new Set(state.remoteBots.map((b) => b.node))];
	for (const node of nodes) {
		remote.append(h("h2", {}, `On ${node}`));
		for (const b of state.remoteBots.filter((x) => x.node === node)) {
			remote.append(h("div", { class: "card" },
				h("div", { class: "row" }, h("strong", {}, b.displayName || b.name), h("span", { class: "muted small" }, b.name), !b.reachable && badge("offline", "bad"), badge(b.model)),
				b.description && h("div", { class: "muted small" }, b.description)));
		}
	}

	const reload = h("button", { on: { click: () => run(async () => { restartNote(await api("POST", "/reload")); await loadState(); botsScreen(); }) } }, "Reload config.yaml");
	show(
		h("div", { class: "row between" }, h("h1", {}, "Bots"), reload),
		h("div", { class: "layout" }, list, ui.bot === "+new" ? newBotForm() : botEditor(local.find((b) => b.name === ui.bot))),
		remote);
}

function newBotForm() {
	const name = h("input", { type: "text", placeholder: "my-bot", autocapitalize: "off" });
	const err = h("div", { class: "err" });
	const create = () => run(async () => {
		if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(name.value)) { err.textContent = "Use lowercase letters, digits and dashes, starting with a letter or digit (max 41 characters)."; return; }
		await api("POST", "/bots", { name: name.value });
		ui.bot = name.value;
		await loadState();
		toast("Bot created");
		botsScreen();
	});
	return h("div", { class: "card" }, h("h3", {}, "New bot"), field("Name", name, "Lowercase letters, digits and dashes. Cannot be changed later."), err, h("button", { class: "primary", on: { click: create } }, "Create"));
}

function botEditor(bot) {
	const { config, effective } = bot;
	const name = h("input", { type: "text", value: effective.displayName ?? "" });
	const desc = h("input", { type: "text", value: effective.description ?? "" });
	const initModel = config.model ?? "";
	const models = ["", ...state.models];
	if (initModel && !models.includes(initModel)) models.push(initModel);
	const model = select(models, initModel, { "": "(gateway default)" });
	const thinking = select(THINKING, effective.thinking);
	const tools = state.toolGroups.map((g) => h("input", { type: "checkbox", value: g, checked: effective.tools.includes(g) }));
	const mode = select(["smart", "manual", "off"], effective.approvals);
	const priv = h("input", { type: "checkbox", checked: effective.private });
	const trusted = h("input", { type: "checkbox", checked: effective.trusted });
	const dflt = h("input", { type: "checkbox", checked: effective.default });
	const shared = h("input", { type: "text", value: (config.sharedMemory ?? []).join(", "), placeholder: "household, work" });
	const instr = h("textarea", { value: effective.instructions ?? "" });
	const check = (box, text) => h("label", {}, box, text);
	const sourceNote = { config: "config.yaml", default: "the gateway default", soul: "its soul file" }[effective.instructionsFrom] ?? effective.instructionsFrom;

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
		restartNote(await api("PATCH", `/bots/${encodeURIComponent(bot.name)}`, patch));
		await loadState();
		botsScreen();
	});
	const remove = () => run(async () => {
		if (!confirm(`Remove "${bot.name}" from the config?\n\nIts chats, memory and workspace stay on disk; they just stop being served.`)) return;
		restartNote(await api("DELETE", `/bots/${encodeURIComponent(bot.name)}`));
		ui.bot = null;
		await loadState();
		botsScreen();
	});

	return h("div", { class: "card" },
		h("h3", {}, bot.name),
		h("div", { class: "grid2" }, field("Display name", name), field("Description", desc)),
		h("div", { class: "grid2" }, field("Model", model), field("Thinking", thinking)),
		field("Tool groups", h("div", { class: "checks" }, tools.map((t) => check(t, t.value)))),
		h("div", { class: "grid2" }, field("Approval mode", mode), field("Shared memory spaces", shared, "Comma separated")),
		h("div", { class: "checks" }, check(priv, "Private"), check(trusted, "Trusted"), check(dflt, "Default bot")),
		h("div", { class: "field" }),
		field("Instructions", instr, `Currently from ${sourceNote}. Saving writes them to the bot's config entry.`),
		h("div", { class: "row between" }, h("button", { class: "primary", on: { click: save } }, "Save"), h("button", { class: "danger", on: { click: remove } }, "Remove bot")));
}

// ---- Network ----
async function networkScreen() {
	const net = await api("GET", "/network");
	const reload = () => networkScreen();
	const act = (fn) => () => run(async () => { await fn(); await reload(); });
	const out = h("div");

	const members = net.members.length
		? net.members.map((m) => h("div", { class: "card row between" },
			h("div", { class: "grow" },
				h("div", {}, h("span", { class: `dot ${m.reachable ? "" : "off"}` }), h("strong", {}, m.name), " ", badge(m.reachable ? "reachable" : "unreachable", m.reachable ? "ok" : "bad")),
				h("div", { class: "muted small trunc" }, m.url),
				h("div", { class: "muted small" }, `Last seen ${ago(m.last_seen)}`, m.last_error ? ` - ${m.last_error}` : "")),
			h("button", { class: "danger", on: { click: act(async () => {
				if (!confirm(`Remove ${m.name} from the network?`)) return;
				await api("DELETE", `/network/members/${encodeURIComponent(m.name)}`);
			}) } }, "Remove")))
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
		h("div", { class: "card" }, h("strong", {}, net.self.name), h("div", { class: "muted small" }, net.self.url)),
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
	const copy = h("button", { on: { click: () => { navigator.clipboard?.writeText(r.code).then(() => toast("Copied"), () => toast("Copy failed; select the code by hand", true)); } } }, "Copy");
	const card = h("div", { class: "card" }, h("h3", {}, "Invitation code"), h("div", { class: "code" }, r.code), copy,
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

// ---- Status ----
async function statusScreen() {
	const s = await api("GET", "/status");
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
			: h("div", { class: "muted" }, "No scheduled jobs."));
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
		h("div", { class: "card" }, h("strong", {}, state.node.name), h("div", { class: "muted small" }, state.node.url), h("div", { class: "muted small mono" }, state.configPath)),
		h("div", { class: "card" }, h("h3", {}, "Defaults"),
			h("div", { class: "grid2" }, field("Model", model), field("Thinking", thinking), field("Approval mode", mode), field("Approval timeout (seconds)", timeout, "Takes effect after a restart")),
			h("h3", {}, "Server"),
			h("div", { class: "grid2" }, field("Host", host), field("Port", port), field("Public name", pname), field("Time zone", tz)),
			h("div", { class: "hint" }, "Server and time zone changes take effect after a restart."),
			h("div", { class: "field" }), h("button", { class: "primary", on: { click: save } }, "Save")),
		h("div", { class: "card" }, h("h3", {}, "Panel password"), pass));
}

window.addEventListener("hashchange", route);
run(start);
