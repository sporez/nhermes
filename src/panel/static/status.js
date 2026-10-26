// The Status tab. Registers itself with the shell in core.js.
import { ago, api, ask, badge, h, loadState, pollWhile, registerTab, run, select, show, state, ui, when } from "./core.js";

const OUTCOMES = { auto_allowed: ["auto-approved", "ok"], asked: ["sent to you", "warn"], unavailable: ["unavailable", ""] };
const JOB_NOTIFY = { never: "never notifies", always: "notifies every run", on_error: "notifies on failure", on_change: "notifies on change", agent: "bot decides when to notify" };

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
		h("td", {}, h("div", {}, j.name), h("div", { class: "muted small" }, `${j.bot} - ${j.schedule} (${j.timezone})`),
			h("div", { class: "muted small" }, [j.context === "continue" ? "same thread every run" : "fresh thread each run", j.deliver === "chat" ? "posts result to chat" : "result stays in its session", JOB_NOTIFY[j.notify] ?? `notify: ${j.notify}`].join(" - "))),
		h("td", {}, j.running ? badge("running", "ok") : j.enabled ? badge("scheduled") : badge("paused", "warn")),
		h("td", { class: "hide-s" }, j.enabled ? ago(j.nextRunAt) : ""),
		h("td", {}, j.lastRunAt ? `${j.lastStatus ?? ""} ${ago(j.lastRunAt)}` : "never", j.lastError && h("div", { class: "err small" }, j.lastError)),
		h("td", {}, h("div", { class: "row" },
			h("button", { class: "link", on: { click: () => run(async () => { await api("POST", `/jobs/${j.id}/${j.enabled ? "pause" : "resume"}`); await statusScreen(); }) } }, j.enabled ? "Pause" : "Resume"),
			h("button", { class: "link danger", on: { click: () => run(async () => {
				if (!await ask(`Delete the scheduled job "${j.name}"? It stops running; the chat its runs wrote stays in Sessions.`)) return;
				await api("DELETE", `/jobs/${j.id}`);
				await statusScreen();
			}) } }, "Delete"))));

	const spaceRow = (x) => h("tr", {},
		h("td", { class: "mono" }, x.id), h("td", {}, badge(x.bot)),
		h("td", {}, ago(x.createdAt).replace(/ ago$/, "")),
		h("td", {}, h("div", {}, ago(x.lastUsed)), h("div", { class: "muted small" }, `deleted after ${x.idleMinutes} min unused`)),
		h("td", {}, h("button", { class: "link danger", on: { click: () => run(async () => {
			if (!await ask(`Delete space ${x.id} of ${x.bot}? Whatever is open in it is lost.`, "Delete")) return;
			await api("DELETE", `/spaces/${encodeURIComponent(x.id)}`);
			await statusScreen();
		}) } }, "Delete")));

	show(h("h1", {}, "Status"),
		h("div", { class: "card" }, h("strong", {}, String(s.running)), ` ${s.running === 1 ? "chat" : "chats"} running right now`),
		h("h2", {}, "Waiting for you"),
		approvals.length ? approvals : h("div", { class: "muted" }, "Nothing is waiting for approval."),
		s.spaces.length > 0 && h("h2", {}, "Running spaces"),
		s.spaces.length > 0 && h("div", { class: "card" }, h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, "Space"), h("th", {}, "Bot"), h("th", {}, "Open for"), h("th", {}, "Last used"), h("th"))), h("tbody", {}, s.spaces.map(spaceRow)))),
		h("h2", {}, "Scheduled jobs"),
		s.jobs.length
			? h("div", { class: "card" }, h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, "Job"), h("th", {}, "State"), h("th", { class: "hide-s" }, "Next run"), h("th", {}, "Last run"), h("th"))), h("tbody", {}, s.jobs.map(jobRow))))
			: h("div", { class: "muted" }, "No scheduled jobs."),
		reviews);
	pollWhile("status", statusScreen, 5000);
}

registerTab("status", statusScreen);
