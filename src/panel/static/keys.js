// The Keys tab. Registers itself with the shell in core.js.
import { ago, api, ask, badge, copyText, field, h, registerTab, run, selectable, toast } from "./core.js";

const show = registerTab("keys", keysScreen);

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
		if (!await ask("Generate a new gateway token? The old one stops working after the gateway restarts.")) return;
		const t = await api("POST", "/token/new");
		const box = h("div", { class: "card" }, h("h3", {}, "New token for ", h("span", { class: "mono" }, t.name)),
			h("div", { class: "notice warn" }, "Shown only once. The nHermes app and the nhermes command need this new token after the gateway restarts."),
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
			if (!await ask(`Remove ${k.name} from secrets.env?`)) return;
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
