// The Logins tab: sign a machine in to model providers (this one, or any member) from this panel. The sign-in
// itself runs on the machine that will use it; this page only shows its code or link and sends back answers.
// An open sign-in is followed by polling its session about once a second, until it ends or the tab is left.
import { api, ask, badge, fill, h, registerTab, run, selectable, copyText, show, toast, ui, when } from "./core.js";

ui.loginMachine ??= "";
ui.loginShowKeys ??= false;
let sel = null; // { machine, id, name } while a sign-in is shown

const base = (machine) => (machine ? `/remote/${encodeURIComponent(machine)}/logins` : "/logins");
const rank = (p) => (p.status.kind !== "none" && p.oauth ? 0 : p.status.kind !== "none" ? 1 : p.oauth ? 2 : 3);

function statusOf(p, machine) {
	const s = p.status;
	if (s.kind === "oauth") return [badge("Signed in", "ok"), s.expires ? h("span", { class: "muted small" }, ` renews itself; token checked ${when(s.expires / 1000)}`) : null];
	if (s.kind === "key") return [badge(`Key set (${s.source})`, "ok")];
	return [badge("Not signed in", "warn")];
}

function howOf(p, machine) {
	if (p.oauth) return p.oauth.label || "Sign in with your account";
	return machine ? "Uses a key; set it in that machine's Keys tab" : h("span", {}, "Uses a key; set it in the ", h("a", { href: "#keys" }, "Keys tab"));
}

let gen = 0;
async function loginsScreen() {
	const mine = ++gen;
	const net = await api("GET", "/network");
	if (mine !== gen) return;
	const machines = [{ id: "", label: `This machine (${net.self?.name ?? "this"})`, reachable: true }, ...(net.members ?? []).map((m) => ({ id: m.name, label: m.name, reachable: m.reachable }))];
	if (!machines.some((m) => m.id === ui.loginMachine)) ui.loginMachine = "";
	const machine = ui.loginMachine;
	const mname = machines.find((m) => m.id === machine).label.replace(/^This machine \((.*)\)$/, "$1");

	const picker = h("select", { on: { change: (e) => { ui.loginMachine = e.target.value; sel = null; run(loginsScreen); } } },
		machines.map((m) => h("option", { value: m.id, selected: m.id === machine }, m.reachable ? m.label : `${m.label} (offline)`)));
	const root = h("div", { id: "logins-root" });
	show(h("h1", {}, "Logins"),
		h("p", { class: "muted" }, "Sign a machine in to a model provider. The sign-in happens on that machine and its credentials stay there."),
		h("div", { class: "row" }, h("span", { class: "muted small" }, "Machine"), picker), root);

	let data;
	try {
		data = await api("GET", base(machine));
	} catch (e) {
		if (mine !== gen) return;
		const forbidden = /\b(allow|let|switch|refus)/i.test(e.message) && !/Network/.test(e.message);
		fill(root, h("div", { class: "notice warn" }, e.message,
			machine && forbidden ? h("div", { class: "small" }, "The switch \"Let other machines sign this machine in to model providers\" is in that machine's Network tab.") : null));
		return;
	}
	if (mine !== gen) return;
	const providers = data.providers;

	// Resume a sign-in that is still open (after a reload, or coming back to the tab).
	if (!sel || sel.machine !== machine) {
		const open = providers.find((p) => p.open);
		sel = open ? { machine, id: open.open, name: open.name } : null;
	}
	if (sel) return stepView(root, sel, mname);
	listView(root, providers, machine, mname);
}

function listView(root, providers, machine, mname) {
	const sorted = [...providers].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
	const keyOnly = sorted.filter((p) => !p.oauth);
	const hideKeys = keyOnly.length > 4 && !ui.loginShowKeys;
	const shown = sorted.filter((p) => p.oauth || !hideKeys || p.status.kind !== "none");

	const begin = (p) => run(async () => {
		const s = await api("POST", base(machine), { provider: p.id });
		sel = { machine, id: s.id, name: p.name };
		await loginsScreen();
	});
	const signOut = (p) => run(async () => {
		if (!await ask(`Sign ${mname} out of ${p.name}? Bots that use it stop working until it is signed in again.`, "Sign out")) return;
		await api("DELETE", `${base(machine)}/providers/${encodeURIComponent(p.id)}`);
		toast(`Signed out of ${p.name}`);
		await loginsScreen();
	});

	const card = (p) => {
		const signedIn = p.status.kind === "oauth";
		return h("div", { class: "card" }, h("div", { class: "row between" },
			h("div", { class: "grow" },
				h("div", { class: "row" }, h("strong", {}, p.name), statusOf(p, machine)),
				h("div", { class: "muted small" }, howOf(p, machine)),
				p.lastError && h("div", { class: "err small" }, `Last sign-in failed: ${p.lastError}`)),
			p.oauth && h("div", { class: "row" },
				h("button", { class: signedIn ? "" : "primary", on: { click: () => begin(p) } }, signedIn ? "Sign in again" : "Sign in"),
				signedIn && h("button", { class: "link danger", on: { click: () => signOut(p) } }, "Sign out"))));
	};

	fill(root, 
		shown.length ? shown.map(card) : h("div", { class: "notice" }, "This machine has no providers to sign in to."),
		keyOnly.length > 4 && h("button", { class: "link", on: { click: () => { ui.loginShowKeys = !ui.loginShowKeys; run(loginsScreen); } } },
			ui.loginShowKeys ? "Hide providers that use a key" : `Show providers that use a key (${keyOnly.filter((p) => !shown.includes(p)).length})`));
}

function stepView(root, s, mname) {
	const { machine, id, name } = s;
	const body = h("div");
	let sig = "";
	let ticker = null;
	let expiresAt = 0;
	const left = h("span", { class: "mono" });
	const alive = () => root.isConnected && sel === s;
	const stop = () => clearInterval(ticker);
	const back = () => { sel = null; stop(); run(loginsScreen); };

	const cancel = () => run(async () => {
		await api("DELETE", `${base(machine)}/${encodeURIComponent(id)}`);
		poll();
	});
	const answer = (value) => run(async () => {
		draw(await api("POST", `${base(machine)}/${encodeURIComponent(id)}/answer`, { value }));
	});

	function promptView(p) {
		if (p.type === "select") {
			return h("div", { class: "card" }, h("p", {}, p.message),
				h("div", { class: "row" }, (p.options ?? []).map((o) => h("button", { title: o.description ?? "", on: { click: () => answer(o.id) } }, o.label))));
		}
		const secret = p.type === "secret";
		const input = h("input", { type: secret ? "password" : "text", autocomplete: "off", autocapitalize: "off", placeholder: p.placeholder ?? "", spellcheck: false });
		const send = () => { const v = input.value; if (secret) input.value = ""; if (!v) return toast("Enter a value first", true); answer(v); };
		input.addEventListener("keydown", (e) => { if (e.key === "Enter") send(); });
		return h("div", { class: "card" }, h("p", {}, p.message),
			p.type === "manual_code" && h("p", { class: "muted small" }, "When the sign-in page sends you to an address that doesn't load, copy that address from the browser's address bar and paste it here."),
			h("div", { class: "row" }, h("div", { class: "grow" }, input), h("button", { class: "primary", on: { click: send } }, "Send")));
	}

	function eventView(e) {
		if (e.type === "device_code") {
			expiresAt = e.expiresInSeconds ? e.at + e.expiresInSeconds * 1000 : 0;
			return h("div", { class: "card" },
				h("p", {}, `Open the link on any device and enter this code to sign ${mname} in to ${name}.`),
				selectable(e.userCode, "code mono"),
				h("div", { class: "row" },
					h("button", { on: { click: () => copyText(e.userCode, "code") } }, "Copy code"),
					h("a", { class: "btn primary", href: e.verificationUri, target: "_blank", rel: "noopener noreferrer" }, "Open the sign-in page")),
				h("div", { class: "muted small" }, e.verificationUri),
				expiresAt ? h("div", { class: "muted small" }, "Code expires in ", left) : null);
		}
		if (e.type === "auth_url") {
			return h("div", { class: "card" }, h("p", {}, e.instructions || `Open the sign-in page to sign ${mname} in to ${name}.`),
				h("a", { class: "btn primary", href: e.url, target: "_blank", rel: "noopener noreferrer" }, "Open sign-in page"));
		}
		if (e.type === "info") {
			return h("div", { class: "notice" }, e.message, (e.links ?? []).map((l) => h("div", {}, h("a", { href: l.url, target: "_blank", rel: "noopener noreferrer" }, l.label || l.url))));
		}
		return h("div", { class: "muted small" }, e.message);
	}

	function tick() {
		if (!alive()) return stop();
		if (expiresAt) {
			const sec = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
			left.textContent = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
		}
	}

	function draw(r) {
		const key = JSON.stringify([r.state, r.events.length, r.prompt?.message, r.message]);
		if (key === sig) return;
		sig = key;
		expiresAt = 0;
		const open = r.state === "waiting" || r.state === "prompt";
		const final = !open && h("div", { class: r.state === "done" ? "notice" : "notice warn" },
			r.state === "done" ? `Signed in to ${name} on ${mname}.` : r.state === "cancelled" ? `Sign-in to ${name} was cancelled.` : `Sign-in to ${name} failed: ${r.message ?? "unknown error"}`);
		fill(body, 
			final,
			// Only the latest device code or link matters; the rest are shown in order.
			(open ? r.events : r.events.filter((e) => e.type === "progress" || e.type === "info")).map(eventView),
			r.prompt ? promptView(r.prompt) : null,
			open && r.state === "waiting" && !r.events.length ? h("div", { class: "muted" }, "Starting…") : null,
			h("div", { class: "row" }, open ? h("button", { on: { click: cancel } }, "Cancel sign-in") : h("button", { class: "primary", on: { click: back } }, "Back to providers")));
		tick();
		if (!open) stop();
	}

	async function poll() {
		if (!alive()) return stop();
		try {
			draw(await api("GET", `${base(machine)}/${encodeURIComponent(id)}`));
		} catch (e) {
			stop();
			fill(body, h("div", { class: "notice warn" }, `Lost track of the sign-in: ${e.message}`), h("button", { class: "primary", on: { click: back } }, "Back to providers"));
		}
	}

	fill(root, h("h2", {}, `Sign in to ${name} on ${mname}`), body);
	ticker = setInterval(() => { tick(); }, 1000);
	const pollTimer = setInterval(() => { if (!alive()) clearInterval(pollTimer); else if (!document.hidden && sig && !/"(done|failed|cancelled)"/.test(sig.slice(0, 14))) poll(); }, 1000);
	poll();
}

registerTab("logins", loginsScreen);
