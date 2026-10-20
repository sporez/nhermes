// A multi-step browser workflow through the agent's tools against a local site, with a real headless
// Chromium: search form, results, a link that opens a new tab, a JS-driven button, a screenshot, tabs,
// element refs from the accessibility snapshot, and a profile that keeps its cookies.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { gatewayFilesPattern } from "../../src/core/policy.ts";
import { isGatewayFileUrl, isOwnPanel, maybePanelUrl } from "../../src/tools/own-gateway.ts";
import { collect, fauxModels, tempDir, testConfig, testCore } from "../helpers.ts";

const PAGES: Record<string, string> = {
	"/": `<html><head><title>Shop</title></head><body><h1>Shop</h1><form action="/search"><label>Search <input id="q" name="q"></label><button>Find</button></form></body></html>`,
	"/item/2": `<html><head><title>Widget Pro</title></head><body><h1>Widget Pro</h1><p id="price">Price: $42</p><button id="add" onclick="document.getElementById('cart').textContent='Added to cart'; document.cookie='cart=widget-pro; path=/; max-age=86400'">Add to cart</button><p id="cart">Cart empty</p></body></html>`,
};

function site() {
	const server = createServer((req, res) => {
		const url = new URL(req.url ?? "/", "http://x");
		res.setHeader("content-type", "text/html");
		if (url.pathname === "/search") {
			const q = url.searchParams.get("q") ?? "";
			res.end(`<html><head><title>Results for ${q}</title></head><body><h1>Results for ${q}</h1><ul><li><a href="/item/1">Widget Basic</a></li><li><a href="/item/2" target="_blank">Widget Pro</a></li></ul><p>Cookie: ${req.headers.cookie ?? "none"}</p></body></html>`);
			return;
		}
		res.end(PAGES[url.pathname] ?? "<h1>Not here</h1>");
	});
	return new Promise<{ base: string; close: () => void }>((r) => server.listen(0, "127.0.0.1", () => r({ base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() })));
}

test("browser workflow: search, open result in a new tab, act on it, screenshot, tabs; state persists", async () => {
	const { dir, cleanup } = await tempDir();
	const { base, close } = await site();
	const { models, faux } = fauxModels();
	const config = testConfig(dir, [{ name: "web", default: true, instructions: "You browse.", tools: ["browser"] }]);
	const core = await testCore(dir, { models, config });
	try {
		const s = await core.sessions.create("web");
		let c = collect(core.hub, s.id);
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("browser_open", { url: base })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("Opened the shop.")]),
		]);
		await core.sessions.submit(s.id, "open the shop");
		await c.until((e) => e.type === "run.finished", 30000);
		const opened = (c.events.find((e) => e.type === "tool.finished") as { resultText: string }).resultText;
		assert.match(opened, /heading "Shop"/);
		// Use the refs the snapshot gave, as a model would.
		const box = /textbox "Search" \[ref=(e\d+)\]/.exec(opened)?.[1];
		const button = /button "Find" \[ref=(e\d+)\]/.exec(opened)?.[1];
		assert.ok(box && button, opened);

		c = collect(core.hub, s.id);
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("browser_type", { ref: box, value: "widget" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("browser_click", { ref: button })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("browser_click", { text: "Widget Pro" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("browser_click", { selector: "#add" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("browser_screenshot", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("browser_tabs", { action: "list" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("Widget Pro costs $42 and is in the cart.")]),
		]);
		await core.sessions.submit(s.id, "find the widget pro price and add it to the cart");
		const done = await c.until((e) => e.type === "run.finished", 60000);
		if (done.type !== "run.finished") return;
		assert.equal(done.status, "complete");
		const results = c.events.filter((e) => e.type === "tool.finished") as { name: string; resultText: string; isError: boolean }[];
		assert.ok(results.every((r) => !r.isError), JSON.stringify(results.filter((r) => r.isError)));
		assert.match(results[1]!.resultText, /Results for widget/);
		assert.match(results[2]!.resultText, /opened a new tab[\s\S]*Price: \$42/);
		assert.match(results[3]!.resultText, /Added to cart/);
		assert.match(results[4]!.resultText, /Screenshot of .*\/item\/2 saved/);
		assert.match(results[5]!.resultText, /0: Results for widget[\s\S]*\* 1: Widget Pro/);
		// The screenshot went to the model as an image.
		const entries = await core.engine.entries(s.conversation_id);
		const shot = entries.find((e) => JSON.stringify(e.model ?? []).includes('"type":"image"'));
		assert.ok(shot, "the screenshot result carries an image block");

		// The profile is persistent: after the browser is closed and relaunched, the cookie is still there.
		await core.browsers.close();
		c = collect(core.hub, s.id);
		faux.setResponses([fauxAssistantMessage([fauxToolCall("browser_open", { url: `${base}/search?q=again` })], { stopReason: "toolUse" }), fauxAssistantMessage([fauxText("ok")])]);
		await core.sessions.submit(s.id, "search again");
		await c.until((e) => e.type === "run.finished", 30000);
		assert.match((c.events.find((e) => e.type === "tool.finished") as { resultText: string }).resultText, /Cookie: cart=widget-pro/);
	} finally {
		close();
		await core.close();
		await cleanup();
	}
});

test("the browser's guards: file:// URLs inside the gateway's folders and the own panel are refused", async () => {
	const re = gatewayFilesPattern("/srv/nh/config", "/srv/nh/data");
	for (const bad of ["file:///srv/nh/config/secrets.env", "file:///srv/nh/data/app.sqlite", "file:///srv/nh/config/config.yaml", "file:///srv/nh/data/browser/a/profile/Cookies", "file:///SRV/NH/CONFIG/secrets.env", "file:///srv/nh/config/../config/secrets.env"]) {
		assert.equal(isGatewayFileUrl(bad, re), true, bad);
	}
	for (const ok of ["file:///srv/nh/data/workspaces/bot/page.html", "file:///tmp/page.html", "https://example.com/srv/nh/config/x", "not a url"]) {
		assert.equal(isGatewayFileUrl(ok, re), false, ok);
	}
	assert.equal(maybePanelUrl("http://example.com/Panel/x"), true);
	assert.equal(maybePanelUrl("http://example.com/panelx"), false);
	assert.equal(await isOwnPanel("http://localhost:8642/panel", [8642]), true);
	assert.equal(await isOwnPanel("http://127.0.0.1:8642/PANEL/api/x", [8642]), true);
	assert.equal(await isOwnPanel("http://[::1]:8642/panel", [8642]), true);
	assert.equal(await isOwnPanel("http://127.0.0.1:9999/panel", [8642]), false);
	assert.equal(await isOwnPanel("http://127.0.0.1:8642/api/x", [8642]), false);
});

test("the browser cannot open the own panel or the gateway's files, by address or by redirect", async () => {
	const { dir, cleanup } = await tempDir();
	const own = createServer((_q, res) => res.end("<h1>Panel</h1>"));
	await new Promise<void>((r) => own.listen(0, "127.0.0.1", () => r()));
	const ownPort = (own.address() as AddressInfo).port;
	const other = createServer((req, res) => {
		if (req.url === "/go") {
			res.writeHead(302, { location: `http://127.0.0.1:${ownPort}/panel` });
			res.end();
			return;
		}
		res.setHeader("content-type", "text/html");
		res.end("<h1>Other</h1>");
	});
	await new Promise<void>((r) => other.listen(0, "127.0.0.1", () => r()));
	const otherPort = (other.address() as AddressInfo).port;
	const { models, faux } = fauxModels();
	const config = testConfig(dir, [{ name: "web", default: true, instructions: "You browse.", tools: ["browser"] }]);
	writeFileSync(join(dir, "secrets.env"), "X=1\n");
	const core = await testCore(dir, { models, config });
	core.members.setListenPort(ownPort);
	try {
		const s = await core.sessions.create("web");
		const c = collect(core.hub, s.id);
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("browser_open", { url: `http://localhost:${ownPort}/panel` })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("browser_open", { url: `file://${join(config.configDir, "secrets.env")}` })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("browser_tabs", { action: "new", url: `http://127.0.0.1:${ownPort}/panel/` })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("browser_open", { url: `http://127.0.0.1:${otherPort}/go` })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("browser_open", { url: `http://127.0.0.1:${otherPort}/` })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("done")]),
		]);
		await core.sessions.submit(s.id, "try");
		await c.until((e) => e.type === "run.finished", 60000);
		const r = c.events.filter((e) => e.type === "tool.finished") as { resultText: string; isError: boolean }[];
		assert.match(r[0]!.resultText, /control panel can't be used/);
		assert.match(r[1]!.resultText, /belongs to the gateway itself/);
		assert.match(r[2]!.resultText, /control panel can't be used/);
		assert.equal(r[3]!.isError, true, "a redirect to the panel is refused");
		assert.match(r[3]!.resultText, /control panel can't be used/);
		assert.doesNotMatch(r[3]!.resultText, /heading "Panel"/);
		assert.equal(r[4]!.isError, false);
		assert.match(r[4]!.resultText, /Other/);
	} finally {
		own.close();
		other.close();
		await core.close();
		await cleanup();
	}
});
