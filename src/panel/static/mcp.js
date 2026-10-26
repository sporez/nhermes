// The MCP tab: this machine's MCP servers (docs/MCP.md), their state and tools, and their settings, then the
// servers of members that allow edits from other machines (managed on their own machine through
// /panel/api/remote/<node>/mcp). A bot gets a server through its tool group mcp:<name> in the bot editor
// (Bots). Key values are never shown or typed here: headers reference keys from the Keys tab as
// {{secret:NAME}}. Only this machine's servers refresh while the tab is open. Registers itself in core.js.
import { ago, api, ask, badge, field, fill, h, pollWhile, registerTab, restartNote, run, select, toast, ui, when } from "./core.js";

const show = registerTab("mcp", mcpScreen, "MCP");

const STATE = {
	online: ["online", "ok"],
	connecting: ["connecting", ""],
	offline: ["offline", "warn"],
	needs_key: ["needs a key", "bad"],
	failed: ["set up wrong", "bad"],
	disabled: ["turned off", ""],
	closed: ["closed", ""],
};
const NAME = /^[a-z0-9][a-z0-9-]{0,30}$/;

const listText = (v) => (v ?? []).join(", ");
const listOf = (text) => text.split(/[,\n]/).map((x) => x.trim()).filter(Boolean);

function stateLine(s) {
	const st = s.status;
	const [label, cls] = STATE[st.state] ?? [st.state, ""];
	const parts = [];
	if (st.state === "online" && st.lastConnectedAt) parts.push(`connected ${ago(st.lastConnectedAt)}`);
	if (st.state === "offline" && st.offlineSince) parts.push(`unreachable since ${when(st.offlineSince)}`);
	if (st.state === "offline" && st.nextAttemptAt) parts.push(`next try ${ago(st.nextAttemptAt)}`);
	if (st.state !== "online" && st.lastConnectedAt) parts.push(`last connected ${ago(st.lastConnectedAt)}`);
	return h("div", { class: "row" }, badge(label, cls), parts.length > 0 && h("span", { class: "muted small" }, parts.join(" · ")));
}

function toolsLine(s) {
	if (s.toolCount === 0) return h("span", { class: "muted small" }, s.status.state === "online" ? "no tools" : "no tools known yet");
	const ro = s.readOnlyCount ? `, ${s.readOnlyCount} read-only` : "";
	const hidden = s.toolCount > s.exposedCount ? `, ${s.toolCount - s.exposedCount} not exposed` : "";
	const cached = s.status.fresh ? "" : " (known from an earlier connection)";
	return h("span", { class: "small" }, `${s.exposedCount} tool${s.exposedCount === 1 ? "" : "s"}${ro}${hidden}${cached}${s.exposure === "deferred" ? ", found with tool_search" : ""}`);
}

/** The settings form, for a new server (s undefined) or an existing one; `base` is "" or "/remote/<node>". */
function form(s, done, base = "") {
	const name = h("input", { type: "text", value: s?.name ?? "", placeholder: "calendar", autocapitalize: "off", autocomplete: "off", disabled: Boolean(s) });
	const url = h("input", { type: "text", value: s?.url ?? "", placeholder: "https://mac.example.com:8443/mcp", autocapitalize: "off", autocomplete: "off" });
	const description = h("input", { type: "text", value: s?.description ?? "", placeholder: "What it offers, for the bots and for you" });
	const exposure = select(["direct", "deferred"], s?.exposure ?? "direct", { direct: "Declared to the model (default)", deferred: "Found with tool_search (many tools)" });
	const readOnly = h("input", { type: "text", value: listText(s?.tools.readOnly), placeholder: "list_*, get_*, search_*", autocapitalize: "off" });
	const include = h("input", { type: "text", value: listText(s?.tools.include ?? ["*"]), autocapitalize: "off" });
	const exclude = h("input", { type: "text", value: listText(s?.tools.exclude), autocapitalize: "off" });
	const hint = h("input", { type: "checkbox", checked: s?.trustReadOnlyHint ?? false });
	const timeout = h("input", { type: "number", value: s?.timeoutS ?? 60, min: 1 });
	const maxTimeout = h("input", { type: "number", value: s?.maxTimeoutS ?? 300, min: 1 });
	const health = h("input", { type: "number", value: s?.healthCheckS ?? 60, min: 0 });
	const rows = h("div");
	let headersChanged = false;
	const addRow = (hn = "", hv = "", hidden = false) => {
		const n = h("input", { type: "text", value: hn, placeholder: "Authorization", autocapitalize: "off", autocomplete: "off" });
		const v = h("input", { type: "text", value: hv ?? "", placeholder: hidden ? "(kept as it is in config.yaml; re-enter to change)" : "Bearer {{secret:CALENDAR_MCP_TOKEN}}", autocapitalize: "off", autocomplete: "off" });
		const row = h("div", { class: "grid2" }, n, h("div", { class: "row" }, h("div", { class: "grow" }, v), h("button", { class: "link danger", on: { click: () => { row.remove(); headersChanged = true; } } }, "Remove")));
		row.dataset.hidden = hidden ? "1" : "";
		for (const el of [n, v]) el.addEventListener("input", () => { headersChanged = true; });
		rows.append(row);
	};
	for (const x of s?.headers ?? []) addRow(x.name, x.value, x.value === null);
	const err = h("div", { class: "err" });

	const save = () => run(async () => {
		err.textContent = "";
		if (!s && !NAME.test(name.value.trim())) { err.textContent = "The name uses lower-case letters, digits and -, up to 31 characters."; return; }
		const body = {
			url: url.value.trim(),
			description: description.value.trim() || null,
			exposure: exposure.value,
			timeoutS: Number(timeout.value),
			maxTimeoutS: Number(maxTimeout.value),
			healthCheckS: Number(health.value),
			trustReadOnlyHint: hint.checked,
			tools: { include: listOf(include.value), exclude: listOf(exclude.value), readOnly: listOf(readOnly.value) },
		};
		if (!s || headersChanged) {
			const headers = {};
			for (const row of rows.children) {
				const [n, v] = row.querySelectorAll("input");
				if (!n.value.trim()) continue;
				if (!v.value.trim()) {
					if (row.dataset.hidden) { err.textContent = `Enter ${n.value}'s value again, as {{secret:NAME}} for a key from the Keys tab.`; return; }
					continue;
				}
				headers[n.value.trim()] = v.value.trim();
			}
			body.headers = Object.keys(headers).length ? headers : null;
		}
		const r = s ? await api("PATCH", `${base}/mcp/${encodeURIComponent(s.name)}`, body) : await api("POST", `${base}/mcp`, { name: name.value.trim(), ...body });
		restartNote(r);
		ui.mcpEditing = null;
		await done();
	});
	const cancel = () => run(async () => { ui.mcpEditing = null; await done(); });

	return h("div", {},
		!s && field("Name", name, "Its tools are named mcp__<name>__<tool>; bots get them with the tool group mcp:<name>."),
		field("URL", url, "The server's Streamable HTTP endpoint (MCP 2025-11-25 or earlier, or a server that speaks both)."),
		field("Description", description),
		h("div", { class: "field" }, h("div", { class: "small muted" }, "Headers"), rows,
			h("button", { class: "link", on: { click: () => { addRow(); headersChanged = true; } } }, "+ Add a header"),
			h("div", { class: "hint" }, "Put the token in the ", h("a", { href: "#keys" }, "Keys"), " tab", base ? " of that machine (or send it there from this one)" : "", " and write {{secret:NAME}} here. A header that carries a credential is refused otherwise.")),
		field("Read-only tools", readOnly, "Names or patterns (* = anything). These change nothing, so they never ask for approval. Every other tool asks first."),
		h("div", { class: "field checks" }, h("label", {}, hint, "Also trust the server's own read-only hints (the spec treats them as untrusted)")),
		h("div", { class: "grid2" }, field("Expose tools", include, "Patterns; * for all."), field("Leave out", exclude)),
		field("How bots see the tools", exposure),
		h("div", { class: "grid2" }, field("Call timeout (s)", timeout, "Progress from the server extends it…"), field("Longest call (s)", maxTimeout, "…up to this.")),
		field("Health check every (s)", health, "While connected and idle; 0 turns it off."),
		err,
		h("div", { class: "row" }, h("button", { class: "primary", on: { click: save } }, s ? "Save" : "Add server"), h("button", { on: { click: cancel } }, "Cancel")));
}

async function toolsPanel(name, base) {
	const d = await api("GET", `${base}/mcp/${encodeURIComponent(name)}`);
	const tools = d.toolList.map((t) => h("tr", {},
		h("td", {}, h("div", { class: "mono" }, t.name), t.modelName ? h("div", { class: "muted small mono" }, t.modelName) : h("div", { class: "muted small" }, "not exposed")),
		h("td", {}, t.readOnly === "owner" ? badge("read-only", "ok") : t.readOnly === "hint" ? badge("read-only (server's hint)", "ok") : badge("asks first", "warn")),
		h("td", { class: "hide-s" }, h("div", { class: "small pre-wrap" }, t.title ? `${t.title}: ${t.description}` : t.description),
			h("details", {}, h("summary", { class: "muted small" }, "Parameters"), h("pre", { class: "mono pre-wrap prompt" }, JSON.stringify(t.inputSchema, null, 2))))));
	const change = (c) => {
		const parts = [c.added.length && `added ${c.added.join(", ")}`, c.removed.length && `removed ${c.removed.join(", ")}`, c.changed.length && `changed ${c.changed.join(", ")}`].filter(Boolean);
		return h("li", { class: "static small" }, h("span", { class: "muted" }, `${when(c.at)} · `), parts.join("; ") || "no change");
	};
	return h("div", {},
		h("p", { class: "muted small" }, "Descriptions and parameters are the server's own words, shown as it sent them."),
		d.toolList.length ? h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, "Tool"), h("th", {}, "Approval"), h("th", { class: "hide-s" }, "What it does"))), h("tbody", {}, tools)) : h("div", { class: "muted" }, "No tools known yet."),
		d.instructions && h("details", {}, h("summary", { class: "muted small" }, "The server's instructions (not given to bots)"), h("pre", { class: "mono pre-wrap prompt" }, d.instructions)),
		d.changes.length > 0 && [h("h2", {}, "Tool list changes"), h("ul", { class: "list" }, d.changes.map(change))]);
}

function card(s, redo, base = "") {
	const key = `${base}|${s.name}`;
	const open = ui.mcpOpen === key;
	const path = `${base}/mcp/${encodeURIComponent(s.name)}`;
	const body = h("div");
	const act = (action, label) => () => run(async () => {
		const r = await api("POST", `${path}/${action}`);
		if (action === "test") toast(r.ok ? `${s.name} answers: ${r.toolCount} tools` : `${s.name} does not answer: ${r.error ?? r.state}`, !r.ok);
		else toast(`${label}: ${s.name}`);
		await redo();
	});
	const toggle = () => run(async () => { restartNote(await api("PATCH", path, { enabled: !s.enabled })); await redo(); });
	const remove = () => run(async () => {
		const who = s.bots.length ? `\nIt is taken off ${s.bots.join(", ")}.` : "";
		if (!await ask(`Remove the MCP server ${s.name}?${who}`, "Remove")) return;
		restartNote(await api("DELETE", path));
		await redo();
	});
	const edit = () => run(async () => { ui.mcpEditing = key; await redo(); });
	const showTools = () => run(async () => { ui.mcpOpen = open ? null : key; await redo(); });
	const wrap = h("div", { class: "card" },
		h("div", { class: "row between" },
			h("div", { class: "grow" },
				h("div", { class: "row" }, h("strong", {}, s.name), h("span", { class: "muted small mono" }, s.group)),
				s.description && h("div", { class: "small" }, s.description),
				h("div", { class: "muted small mono trunc", title: s.url }, s.url),
				stateLine(s),
				s.status.lastError && s.status.state !== "online" && h("div", { class: "muted small" }, s.status.lastError),
				h("div", {}, toolsLine(s)),
				h("div", { class: "muted small" }, s.bots.length ? `Bots: ${s.bots.join(", ")}` : "No bot has it yet: add ", !s.bots.length && h("span", { class: "mono" }, s.group), !s.bots.length && ` to a bot's tools${base ? " on that machine" : ""} on the `, !s.bots.length && h("a", { href: "#bots" }, "Bots"), !s.bots.length && " tab."),
				s.warnings.map((w) => h("div", { class: "small warn-text" }, w))),
			h("div", { class: "row" },
				s.enabled && h("button", { on: { click: act("test", "Tested") } }, "Test"),
				s.enabled && s.status.state === "online" && h("button", { on: { click: act("refresh", "Tools listed again") } }, "Refresh tools"),
				h("button", { on: { click: showTools } }, open ? "Hide tools" : "Tools"),
				h("button", { on: { click: edit } }, "Edit"),
				h("button", { on: { click: toggle } }, s.enabled ? "Turn off" : "Turn on"),
				h("button", { class: "link danger", on: { click: remove } }, "Remove"))),
		body);
	if (ui.mcpEditing === key) body.append(h("div", { class: "field" }), form(s, redo, base));
	else if (open) run(async () => body.replaceChildren(h("div", { class: "field" }), await toolsPanel(s.name, base)));
	return wrap;
}

/** One machine's servers and its "Add" form, into `box`. */
function serverList(box, servers, redo, base, label) {
	const addKey = `${base}|`;
	const add = h("details", { class: "card", open: ui.mcpEditing === addKey }, h("summary", {}, label), h("div", { class: "field" }), form(undefined, redo, base));
	add.addEventListener("toggle", () => { ui.mcpEditing = add.open ? addKey : ui.mcpEditing === addKey ? null : ui.mcpEditing; });
	fill(box, servers.length ? servers.map((s) => card(s, redo, base)) : h("div", { class: "notice" }, "No MCP servers yet."), add);
}

async function drawLocal(box) {
	const data = await api("GET", "/mcp");
	serverList(box, data.servers, () => run(() => drawLocal(box)), "", "Add an MCP server");
}

/** Members' servers, from each member that allows edits from other machines. Loaded on open and after a change. */
async function drawMembers(box) {
	const net = await api("GET", "/network");
	if (!net.members.length) return fill(box);
	const parts = [h("h2", {}, "Other machines")];
	for (const m of net.members) {
		const base = `/remote/${encodeURIComponent(m.name)}`;
		const section = h("div");
		parts.push(h("h3", {}, m.name), section);
		try {
			const r = await api("GET", `${base}/mcp`);
			serverList(section, r.servers, () => run(() => drawMembers(box)), base, `Add an MCP server on ${m.name}`);
		} catch (e) {
			fill(section, h("div", { class: "muted small" }, e.message));
		}
	}
	fill(box, parts);
}

async function mcpScreen() {
	const local = h("div");
	const members = h("div");
	show(h("h1", {}, "MCP servers"),
		h("p", { class: "muted" }, "Tools from MCP servers this machine connects to. A server may be offline at times (a laptop asleep): its last known tools stay, calls to it fail at once and the bot is told nothing was sent. Calls that change something ask for approval unless the tool is marked read-only."),
		local, members);
	await drawLocal(local);
	await run(() => drawMembers(members));
	// This machine's live state, but not while a form (it would lose what is typed) or a tool list is open.
	pollWhile("mcp", () => (ui.mcpEditing === null && ui.mcpOpen === null ? drawLocal(local) : undefined), 5000);
}
