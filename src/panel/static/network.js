// The Network tab. Registers itself with the shell in core.js.
import { ago, api, ask, badge, copyText, h, loadState, registerTab, run, selectable, toast, when } from "./core.js";

const show = registerTab("network", networkScreen);

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
	const logins = h("input", { type: "checkbox", checked: net.acceptsLogins });
	logins.addEventListener("change", () => run(async () => {
		try { await api("PATCH", "/network/settings", { acceptLogins: logins.checked }); toast("Saved"); }
		catch (e) { logins.checked = !logins.checked; throw e; }
	}));
	const acceptCard = h("div", { class: "card" },
		h("label", {}, accept, " ", h("strong", {}, "Accept keys from other machines")),
		h("div", { class: "hint" }, "Lets members of this network set keys in this machine's secrets.env. Keys travel encrypted."),
		h("div", { class: "field" }),
		h("label", {}, edits, " ", h("strong", {}, "Let other machines edit this machine's bots")),
		h("div", { class: "hint" }, "Their panels can then create, edit and remove this machine's bots (private ones included), change their skills and read their system prompts, as this panel can. Hosts, workspaces and keys stay editable only here."),
		h("div", { class: "field" }),
		h("label", {}, logins, " ", h("strong", {}, "Let other machines sign this machine in to model providers")),
		h("div", { class: "hint" }, "Their panels can start and answer sign-ins here (Logins tab). The sign-in is saved on this machine; no tokens are sent to them."));
	const act = (fn) => () => run(async () => { await fn(); await reload(); });
	const out = h("div");

	const members = net.members.length
		? net.members.map((m) => h("div", { class: "card row between" },
			h("div", { class: "grow" },
				h("div", {}, h("span", { class: `dot ${m.reachable ? "" : "off"}` }), h("strong", {}, m.name), " ", badge(m.reachable ? "reachable" : "unreachable", m.reachable ? "ok" : "bad"), " ",
					m.encrypted ? badge("encrypted", "ok") : badge("No encrypted link: remove this machine and join it again", "warn")),
				h("div", { class: "muted small trunc" }, m.url, m.psk_port ? ` · encrypted port ${m.psk_port}` : ""),
				h("div", { class: "muted small" }, `Last seen ${ago(m.last_seen)}`, m.last_error ? ` - ${m.last_error}` : "")),
			h("div", { class: "row" },
				m.encrypted && h("button", { title: "Replace the key this machine and that one share", on: { click: act(async () => {
					await api("POST", `/network/members/${encodeURIComponent(m.name)}/rotate`);
					toast(`New key shared with ${m.name}`);
				}) } }, "Regenerate key"),
				h("button", { class: "danger", on: { click: act(async () => {
					if (!await ask(`Remove ${m.name} from the network?`)) return;
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
				if (!await ask("Leave this network? Other machines' bots will disappear from this gateway.")) return;
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
