// The panel's shared pieces: DOM helpers, the API client, toast and in-page questions, formatting, and the
// shell (sign-in, tab bar, routing, the update badge). Screens live in one module each (bots.js, network.js,
// and so on) and this file never imports them.
//
// Adding a tab:
//   1. Create <name>.js. Import what it needs from "./core.js", define an async screen function, and
//      right after the imports write `const show = registerTab("<name>", screenFn[, "Label"]);`. The
//      screen renders with that show(...).
//   2. Add `import "./<name>.js";` to panel.js. Tabs appear in the order of those imports.
//   3. Add "<name>.js" to the FILES allowlist in src/panel/panel.ts.
// A screen that refreshes itself calls pollWhile("<name>", screenFn, ms) from inside the screen.
// Per-screen UI choices that survive a re-render live in `ui`.

const TABS = [];
const SCREENS = {};
const LABELS = {};
export const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh"];
export const view = document.getElementById("view");
export let state = null;
let timer = null;
export let tab = "bots";
export const ui = { bot: null, owner: null, sessionBot: "", archived: "exclude", memoryQ: "", reviewFilter: "", mcpOpen: null, mcpEditing: null };

/**
 * Adds a tab; call it once from the screen's module. `label` replaces the capitalized name in the tab bar.
 * Returns the screen's show(), which replaces the main view only while that tab is open: a screen that
 * finishes loading after you moved to another tab (a member that is slow to answer) must not draw over it.
 */
export function registerTab(name, screen, label) {
	TABS.push(name);
	SCREENS[name] = screen;
	if (label) LABELS[name] = label;
	return (...kids) => { if (tab === name) fill(view, ...kids); };
}

/**
 * Re-runs a screen every `ms` while its tab is open and the page is visible (one timer; route() clears it).
 * A screen that finishes after its tab was left starts no timer.
 */
export function pollWhile(name, fn, ms) {
	if (!timer && tab === name) timer = setInterval(() => { if (tab === name && !document.hidden) run(fn); }, ms);
}

// ---- helpers ----
export function h(tag, attrs = {}, ...kids) {
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
export function fill(el, ...kids) {
	el.replaceChildren(...kids.flat().filter((k) => k !== null && k !== undefined && k !== false));
}

/**
 * Copies text. The clipboard API exists only on HTTPS or localhost; the panel is usually plain HTTP on the
 * LAN, so fall back to selecting a hidden field and the older copy command.
 */
export async function copyText(text, what = "text") {
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
export function selectable(text, cls = "") {
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

export class AuthError extends Error {}

export async function api(method, path, body) {
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

/**
 * Asks yes or no in the page. window.confirm() is blocked without a word in embedded browsers (the
 * in-app browsers of OpenChamber and other apps answer "cancel" and show nothing), which left buttons
 * that asked first doing nothing there.
 */
export function ask(question, yes = "OK") {
	return new Promise((resolve) => {
		const dialog = h("dialog", { class: "ask" });
		const done = (answer) => { dialog.close(); dialog.remove(); resolve(answer); };
		const ok = h("button", { class: "primary", on: { click: () => done(true) } }, yes);
		dialog.append(
			h("p", {}, question),
			h("div", { class: "row end" }, h("button", { on: { click: () => done(false) } }, "Cancel"), ok),
		);
		// Escape cancels.
		dialog.addEventListener("cancel", (e) => { e.preventDefault(); done(false); });
		document.body.append(dialog);
		dialog.showModal();
		ok.focus();
	});
}

let toastTimer = null;
export function toast(msg, isError = false) {
	const t = document.getElementById("toast");
	t.textContent = msg;
	t.className = isError ? "error" : "";
	t.hidden = false;
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => { t.hidden = true; }, isError ? 7000 : 3500);
}

/** Run an async action, showing errors as a toast. Returns undefined on failure. */
export async function run(fn) {
	try { return await fn(); } catch (e) { if (!(e instanceof AuthError)) toast(e.message, true); }
}

export function ago(ts) {
	if (!ts) return "never";
	const d = Date.now() / 1000 - ts;
	if (d < 0) return `in ${span(-d)}`;
	if (d < 45) return "just now";
	return `${span(d)} ago`;
}
export function span(s) {
	if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min`;
	if (s < 172800) return `${Math.round(s / 3600)} h`;
	return `${Math.round(s / 86400)} d`;
}
export const when = (ts) => (ts ? new Date(ts * 1000).toLocaleString() : "");

export const field = (label, input, hint) => h("label", { class: "field" }, h("span", {}, label), input, hint && h("div", { class: "hint" }, hint));
export const badge = (text, cls = "") => h("span", { class: `badge ${cls}` }, text);
export function select(options, value, labels = {}) {
	const s = h("select");
	for (const o of options) s.append(h("option", { value: o, selected: o === value }, labels[o] ?? o));
	return s;
}
export const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export async function loadState() { state = await api("GET", "/state"); }

export function restartNote(r) {
	if (!r) return;
	const parts = [];
	if (r.added?.length) parts.push(`added: ${r.added.join(", ")}`);
	if (r.removed?.length) parts.push(`removed: ${r.removed.join(", ")}`);
	if (r.changed?.length) parts.push(`changed: ${r.changed.join(", ")}`);
	if (r.restartNeeded?.length) parts.push(`takes effect after a restart: ${r.restartNeeded.join(", ")}`);
	toast(parts.length ? `Saved. ${parts.join(". ")}` : "Saved. Nothing else changed.");
}

// ---- shell ----
export function stopTimer() { clearInterval(timer); timer = null; }

export function showLogin() {
	stopTimer();
	tab = "";
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
	fill(view, h("form", { class: "card login", on: { submit: go } },
		h("h1", {}, "nHermes panel"), field("Password", pw), err, h("button", { class: "primary", type: "submit" }, "Sign in")));
}

export function renderTabs() {
	const nav = document.getElementById("tabs");
	nav.replaceChildren(...TABS.map((t) => h("a", { href: `#${t}`, class: t === tab ? "active" : "" }, LABELS[t] ?? t[0].toUpperCase() + t.slice(1))));
}

export async function route() {
	if (!state) return;
	const name = location.hash.slice(1);
	tab = TABS.includes(name) ? name : "bots";
	stopTimer();
	renderTabs();
	fill(view);
	await run(() => SCREENS[tab]());
}

export async function start() {
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
export async function refreshUpdateBadge(sw) {
	try {
		sw ??= await api("GET", "/software");
		const brand = document.getElementById("machine").parentElement;
		brand.querySelector(".update-badge")?.remove();
		if (sw.available?.length) brand.append(h("a", { href: "#gateway", class: "badge warn update-badge" }, `update available (${sw.available.length})`));
	} catch {
		// Not important enough to report.
	}
}
