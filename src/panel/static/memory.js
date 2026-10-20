// The Memory tab. Registers itself with the shell in core.js.
import { ago, api, ask, field, h, registerTab, run, select, show, state, toast, ui } from "./core.js";

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
		if (!await ask("Delete this memory?")) return;
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
		h("p", { class: "muted" }, "Pinned memories are in every chat's prompt; the rest are found with recall. A new chat also sees the bot's latest chats (Recent chats in Bots), and chat_search and chat_read reach older ones."),
		h("div", { class: "grid2" }, field("Whose memory", ownerSel), field("Search (Enter)", search)),
		h("details", { class: "card" }, h("summary", {}, "Add a memory"), h("div", { class: "field" }), field("Title", title), field("Text", text),
			h("div", { class: "row between" }, h("label", {}, pinned, " Pin"), h("button", { class: "primary", on: { click: add } }, "Add"))),
		items.length ? items.map(card) : h("div", { class: "notice" }, ui.memoryQ ? "Nothing matches that search." : "No memories yet."));
}

registerTab("memory", memoryScreen);
