// Browser tools. The model reads pages through Playwright's AI accessibility snapshot, whose element
// refs ([ref=e12]) it passes back to act on; every action returns the page's new snapshot. Screenshots
// come back as images and are kept only under data/browser/<bot>/shots.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import type { Locator, Page } from "playwright-core";
import type { Feature, LateServices } from "../app.ts";
import type { BrowserSession, Browsers } from "../computer/browser.ts";
import { pictureLine } from "../core/cards.ts";
import { gatewayFilesPattern } from "../core/policy.ts";
import { FILE_REFUSED, isGatewayFileUrl, isOwnPanel, maybePanelUrl, PANEL_REFUSED } from "./own-gateway.ts";

const SNAPSHOT_LIMIT = 15_000;

type Output = { output: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[]; isError?: boolean };

export async function describePage(page: Page, limit = SNAPSHOT_LIMIT): Promise<string> {
	const title = await page.title().catch(() => "");
	let snap = await page.ariaSnapshot({ mode: "ai", timeout: 10_000 }).catch((e: Error) => `(no snapshot: ${e.message})`);
	if (snap.length > limit) snap = `${snap.slice(0, limit)}\n… [snapshot cut at ${limit} characters; scroll or use browser_snapshot with a larger max_chars]`;
	return `URL: ${page.url()}\nTitle: ${title}\n\n${snap}`;
}

function target(page: Page, args: { ref?: string; selector?: string; text?: string }): Locator {
	if (args.ref) return page.locator(`aria-ref=${args.ref.replace(/^\[?ref=|\]$/g, "")}`);
	if (args.selector) return page.locator(args.selector).first();
	if (args.text) return page.getByText(args.text, { exact: false }).first();
	throw new Error("give ref (from a snapshot), selector, or text");
}

const Target = {
	ref: Type.Optional(Type.String({ description: "Element ref from the latest snapshot, e.g. e12" })),
	selector: Type.Optional(Type.String({ description: "CSS selector, when there is no ref" })),
	text: Type.Optional(Type.String({ description: "Visible text to find, when there is no ref" })),
};

export function browserFeature(late: LateServices, browsers: () => Browsers): Feature {
	const gatewayFiles = gatewayFilesPattern(late.config.configDir, late.config.dataDir);
	/** Why a bot may not open this URL, if it may not: the gateway's own panel, or the gateway's own files. */
	const refusal = async (url: string): Promise<string | undefined> => {
		if (isGatewayFileUrl(url, gatewayFiles)) return FILE_REFUSED;
		if (await isOwnPanel(url, late.ownPorts())) return PANEL_REFUSED;
		return undefined;
	};
	const guarded = new WeakSet<BrowserSession>();
	/** Aborts every request (redirects, sub-requests, clicks) to the panel or the gateway's files. */
	const guard = async (session: BrowserSession) => {
		if (guarded.has(session)) return;
		guarded.add(session);
		await session.context.route(
			(u) => u.protocol === "file:" || maybePanelUrl(u.toString()),
			async (route) => ((await refusal(route.request().url())) ? route.abort("blockedbyclient") : route.fallback()),
		);
	};
	const check = async (url: string | undefined) => {
		const why = url ? await refusal(url) : undefined;
		if (why) throw new Error(why);
	};
	const withPage = async (conversationId: number, ctx: Context, fn: (s: BrowserSession, page: Page) => Promise<Output | string>): Promise<Output> => {
		const bot = late.sessions().botOf(conversationId);
		if (!bot) throw new Error("this conversation has no bot");
		const session = await browsers().session(bot);
		await guard(session);
		return session.lock.run(async () => {
			if (ctx.abortSignal?.aborted) throw new Error("cancelled");
			const page = await session.page();
			const r = await fn(session, page);
			return typeof r === "string" ? { output: [{ type: "text", text: r }] } : r;
		});
	};
	const after = async (page: Page, note: string) => {
		await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => undefined);
		// A redirect (or a click) can still land on the panel; Playwright does not route redirect hops.
		const why = await refusal(page.url());
		if (why) {
			await page.goto("about:blank").catch(() => undefined);
			throw new Error(why);
		}
		return `${note}\n\n${await describePage(page)}`;
	};

	const tools = [
		defineTool({
			name: "browser_open",
			description: "Open a URL in your browser (new_tab to keep the current page). Returns the page's accessibility snapshot with element refs.",
			parameters: Type.Object({ url: Type.String(), new_tab: Type.Optional(Type.Boolean()) }),
			execute: async (args, api, ctx) => {
				await check(args.url);
				return withPage(api.conversationId as number, ctx, async (s, current) => {
					let page = current;
					if (args.new_tab) {
						page = await s.context.newPage();
						s.current = s.pages().indexOf(page);
					}
					const res = await page.goto(args.url, { waitUntil: "domcontentloaded" });
					return after(page, `Opened (HTTP ${res?.status() ?? "?"}).`);
				});
			},
		}),
		defineTool({
			name: "browser_snapshot",
			description: "Read the current page: URL, title and accessibility tree with element refs.",
			parameters: Type.Object({ max_chars: Type.Optional(Type.Number()) }),
			replay: "safe",
			execute: async (args, api, ctx) => withPage(api.conversationId as number, ctx, async (_s, page) => describePage(page, Math.min(args.max_chars ?? SNAPSHOT_LIMIT, 60_000))),
		}),
		defineTool({
			name: "browser_click",
			description: "Click an element (by ref from the snapshot, or selector/text).",
			parameters: Type.Object({ ...Target, double: Type.Optional(Type.Boolean()) }),
			execute: async (args, api, ctx) =>
				withPage(api.conversationId as number, ctx, async (s, page) => {
					const before = s.pages().length;
					const loc = target(page, args);
					if (args.double) await loc.dblclick();
					else await loc.click();
					await page.waitForTimeout(300);
					const pages = s.pages();
					if (pages.length > before) {
						s.current = pages.length - 1;
						const opened = pages[s.current]!;
						return after(opened, "Clicked; it opened a new tab, now current.");
					}
					return after(page, "Clicked.");
				}),
		}),
		defineTool({
			name: "browser_type",
			description: "Type into a field (replacing what is there unless append). submit presses Enter afterwards.",
			parameters: Type.Object({ ...Target, value: Type.String(), submit: Type.Optional(Type.Boolean()), append: Type.Optional(Type.Boolean()) }),
			execute: async (args, api, ctx) =>
				withPage(api.conversationId as number, ctx, async (_s, page) => {
					const loc = target(page, args);
					if (args.append) await loc.pressSequentially(args.value);
					else await loc.fill(args.value);
					if (args.submit) {
						await loc.press("Enter");
						await page.waitForTimeout(500);
					}
					return after(page, args.submit ? "Typed and submitted." : "Typed.");
				}),
		}),
		defineTool({
			name: "browser_select",
			description: "Choose an option in a select element.",
			parameters: Type.Object({ ...Target, option: Type.String() }),
			execute: async (args, api, ctx) =>
				withPage(api.conversationId as number, ctx, async (_s, page) => {
					await target(page, args).selectOption({ label: args.option }).catch(() => target(page, args).selectOption(args.option));
					return after(page, "Selected.");
				}),
		}),
		defineTool({
			name: "browser_press",
			description: "Press a key or chord on the page (Enter, Escape, Tab, ArrowDown, Control+a, …).",
			parameters: Type.Object({ key: Type.String() }),
			execute: async (args, api, ctx) =>
				withPage(api.conversationId as number, ctx, async (_s, page) => {
					await page.keyboard.press(args.key);
					await page.waitForTimeout(300);
					return after(page, `Pressed ${args.key}.`);
				}),
		}),
		defineTool({
			name: "browser_scroll",
			description: "Scroll the page up or down (by pixels, default one screen).",
			parameters: Type.Object({ direction: Type.Union([Type.Literal("up"), Type.Literal("down")]), pixels: Type.Optional(Type.Number()) }),
			replay: "safe",
			execute: async (args, api, ctx) =>
				withPage(api.conversationId as number, ctx, async (_s, page) => {
					const dy = (args.pixels ?? 700) * (args.direction === "up" ? -1 : 1);
					await page.mouse.wheel(0, dy);
					await page.waitForTimeout(250);
					return after(page, `Scrolled ${args.direction}.`);
				}),
		}),
		defineTool({
			name: "browser_back",
			description: "Go back in the current tab's history.",
			parameters: Type.Object({}),
			execute: async (_args, api, ctx) =>
				withPage(api.conversationId as number, ctx, async (_s, page) => {
					await page.goBack({ waitUntil: "domcontentloaded" });
					return after(page, "Went back.");
				}),
		}),
		defineTool({
			name: "browser_wait",
			description: "Wait for some text to appear on the page, or for a number of seconds (max 30).",
			parameters: Type.Object({ text: Type.Optional(Type.String()), seconds: Type.Optional(Type.Number()) }),
			replay: "safe",
			execute: async (args, api, ctx) =>
				withPage(api.conversationId as number, ctx, async (_s, page) => {
					if (args.text) await page.getByText(args.text).first().waitFor({ timeout: Math.min((args.seconds ?? 15) * 1000, 30_000) });
					else await page.waitForTimeout(Math.min((args.seconds ?? 2) * 1000, 30_000));
					return after(page, args.text ? `"${args.text}" is on the page.` : "Waited.");
				}),
		}),
		defineTool({
			name: "browser_screenshot",
			description: "Take a screenshot of the current page (full_page for the whole length). Returns the image.",
			parameters: Type.Object({ full_page: Type.Optional(Type.Boolean()) }),
			replay: "safe",
			execute: async (args, api, ctx) =>
				withPage(api.conversationId as number, ctx, async (s, page) => {
					const png = await page.screenshot({ fullPage: args.full_page === true, type: "png" });
					const file = join(s.dir, "shots", `${Date.now()}.png`);
					writeFileSync(file, png, { mode: 0o600 });
					return {
						output: [
							{ type: "text", text: `Screenshot of ${page.url()} saved on the gateway as ${file}.\n\n${pictureLine(api.callId)}` },
							{ type: "image", data: png.toString("base64"), mimeType: "image/png" },
						],
					};
				}),
		}),
		defineTool({
			name: "browser_tabs",
			description: "List, switch to, open or close tabs.",
			parameters: Type.Object({ action: Type.Union([Type.Literal("list"), Type.Literal("switch"), Type.Literal("new"), Type.Literal("close")]), index: Type.Optional(Type.Number()), url: Type.Optional(Type.String()) }),
			execute: async (args, api, ctx) => {
				if (args.action === "new") await check(args.url);
				return withPage(api.conversationId as number, ctx, async (s, page) => {
					if (args.action === "new") {
						const p = await s.context.newPage();
						s.current = s.pages().indexOf(p);
						if (args.url) await p.goto(args.url, { waitUntil: "domcontentloaded" });
						return after(p, `Opened tab ${s.current}.`);
					}
					if (args.action === "switch" || args.action === "close") {
						const pages = s.pages();
						const i = args.index ?? s.current;
						const p = pages[i];
						if (!p) throw new Error(`no tab ${i}; there are ${pages.length}`);
						if (args.action === "close") {
							await p.close();
							s.current = Math.max(0, Math.min(s.current, s.pages().length - 1));
							return `Closed tab ${i}.`;
						}
						s.current = i;
						await p.bringToFront();
						return after(p, `Switched to tab ${i}.`);
					}
					void page;
					const lines = await Promise.all(s.pages().map(async (p, i) => `${i === s.current ? "*" : " "} ${i}: ${await p.title().catch(() => "")} — ${p.url()}`));
					return lines.join("\n") || "No tabs.";
				});
			},
		}),
	];
	return { groups: new Map([["browser", tools as ToolRegistration[]]]) };
}
