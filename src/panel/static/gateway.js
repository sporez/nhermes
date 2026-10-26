// The Gateway tab. Registers itself with the shell in core.js.
import { THINKING, ago, api, ask, badge, copyText, field, fill, h, loadState, refreshUpdateBadge, registerTab, run, same, select, selectable, showLogin, state, toast, when } from "./core.js";

const show = registerTab("gateway", gatewayScreen);

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
			if (!await ask("Remove the panel password? Anyone on your network will be able to open this panel.")) return;
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

/** Which providers' models appear in the model pickers here and in the app. */
function modelListsCard() {
	const boxes = (state.modelProviders ?? []).map((p) => ({ p, box: h("input", { type: "checkbox", checked: p.shown }) }));
	const save = () => run(async () => {
		const hide = boxes.filter((b) => !b.box.checked).map((b) => b.p.name);
		restartNote(await api("PATCH", "/gateway", { modelLists: { hide } }));
		await loadState();
	});
	return h("div", { class: "card" }, h("h3", {}, "Model lists"),
		h("p", { class: "muted small" }, "Providers whose models appear in model pickers (this panel and the app). A model already in use stays listed."),
		boxes.length
			? h("div", { class: "checks" }, boxes.map(({ p, box }) => h("label", {}, box, ` ${p.name} (${p.models})`)))
			: h("div", { class: "muted" }, "No model providers are connected."),
		h("div", { class: "field" }), h("button", { class: "primary", on: { click: save } }, "Save"));
}

/** What a client (the nHermes app) needs: an address and the gateway token (shown only when asked). */
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
		h("p", { class: "muted small" }, "In the nHermes app (its first-run screen, or Settings): enter one of these addresses and the token."),
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
		if (!await ask(question)) return;
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
