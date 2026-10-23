// The Sessions tab. Registers itself with the shell in core.js.
import { ago, api, ask, badge, h, registerTab, run, select, show, state, ui } from "./core.js";

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
				s.preview && h("div", { class: "muted small trunc" }, s.preview),
				s.recap && h("details", { class: "small" }, h("summary", { class: "muted" }, "Recent chats it started with"),
					h("pre", { class: "mono pre-wrap prompt" }, s.recap))),
			h("div", { class: "row" },
				h("button", { class: "link", on: { click: () => {
					const t = prompt("Rename chat", s.title || "");
					if (t !== null && t.trim()) patch(s, { title: t.trim() })();
				} } }, "Rename"),
				h("button", { class: "link", on: { click: patch(s, { archived: !s.archived }) } }, s.archived ? "Unarchive" : "Archive"),
				s.running && h("button", { class: "link", on: { click: () => run(async () => { await api("POST", `/sessions/${s.id}/stop`); await sessionsScreen(); }) } }, "Stop"),
				h("button", { class: "link danger", on: { click: () => run(async () => {
					if (!await ask(`Delete "${s.title || "Untitled"}"? This cannot be undone.`)) return;
					await api("DELETE", `/sessions/${s.id}`);
					await sessionsScreen();
				}) } }, "Delete")))));

	show(h("h1", {}, "Sessions"), h("p", { class: "muted" }, "Read and continue chats in the nHermes app."),
		h("div", { class: "row" }, botSel, archSel),
		h("div", { class: "field" }),
		rows.length ? rows : h("div", { class: "notice" }, "No sessions match."));
}

registerTab("sessions", sessionsScreen);
