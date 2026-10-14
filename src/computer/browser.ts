// Browser automation with Playwright. Each bot gets its own persistent, isolated browser profile under
// data/browser/<bot> (cookies and logins survive between operations and restarts), launched lazily and
// closed after it has been idle. A bot may instead attach to a browser running elsewhere over CDP
// (`browser.cdpUrl`, e.g. Chrome on a desktop VM). Operations of one bot are serialized.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type BrowserContext, chromium, type Page } from "playwright-core";
import type { Bot } from "../core/bots.ts";
import { logger } from "../log.ts";

const log = logger("browser");

export type BrowserOptions = { headless: boolean; idleMs: number; executablePath?: string };

class Mutex {
	private tail: Promise<void> = Promise.resolve();
	run<T>(fn: () => Promise<T>): Promise<T> {
		const next = this.tail.then(fn, fn);
		this.tail = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	}
}

export class BrowserSession {
	readonly bot: string;
	readonly context: BrowserContext;
	readonly dir: string;
	current = 0;
	lastUsed = Date.now();
	readonly lock = new Mutex();
	private readonly owned: boolean;

	constructor(bot: string, context: BrowserContext, dir: string, owned: boolean) {
		this.bot = bot;
		this.context = context;
		this.dir = dir;
		this.owned = owned;
	}

	pages(): Page[] {
		return this.context.pages().filter((p) => !p.isClosed());
	}

	async page(): Promise<Page> {
		const pages = this.pages();
		if (pages.length === 0) {
			const p = await this.context.newPage();
			this.current = 0;
			return p;
		}
		if (this.current >= pages.length) this.current = pages.length - 1;
		return pages[this.current]!;
	}

	async close(): Promise<void> {
		if (this.owned) await this.context.close().catch(() => undefined);
		else await this.context.browser()?.close().catch(() => undefined);
	}
}

export class Browsers {
	private readonly sessions = new Map<string, Promise<BrowserSession>>();
	private readonly dataDir: string;
	private readonly opts: BrowserOptions;
	private readonly sweep: NodeJS.Timeout;

	constructor(dataDir: string, opts: Partial<BrowserOptions> = {}) {
		this.dataDir = join(dataDir, "browser");
		this.opts = { headless: opts.headless ?? true, idleMs: opts.idleMs ?? 10 * 60_000, executablePath: opts.executablePath };
		this.sweep = setInterval(() => void this.closeIdle(), 60_000);
		this.sweep.unref();
	}

	/** The bot's browser session, started on first use. */
	session(bot: Bot): Promise<BrowserSession> {
		let s = this.sessions.get(bot.name);
		if (!s) {
			s = this.launch(bot);
			this.sessions.set(bot.name, s);
			s.catch(() => this.sessions.delete(bot.name));
		}
		return s.then((x) => {
			x.lastUsed = Date.now();
			return x;
		});
	}

	private async launch(bot: Bot): Promise<BrowserSession> {
		const dir = join(this.dataDir, bot.name);
		mkdirSync(join(dir, "shots"), { recursive: true, mode: 0o700 });
		const cdp = bot.config.browser?.cdpUrl;
		if (cdp) {
			const browser = await chromium.connectOverCDP(cdp, { timeout: 15_000 });
			const context = browser.contexts()[0] ?? (await browser.newContext());
			log.info("attached to remote browser", { bot: bot.name });
			return new BrowserSession(bot.name, context, dir, false);
		}
		const context = await chromium.launchPersistentContext(join(dir, "profile"), {
			headless: bot.config.browser?.headless ?? this.opts.headless,
			executablePath: this.opts.executablePath,
			viewport: { width: 1280, height: 800 },
			acceptDownloads: false,
		});
		context.setDefaultTimeout(30_000);
		context.setDefaultNavigationTimeout(45_000);
		log.info("browser started", { bot: bot.name });
		return new BrowserSession(bot.name, context, dir, true);
	}

	async closeIdle(now = Date.now()): Promise<void> {
		for (const [name, p] of this.sessions) {
			const s = await p.catch(() => undefined);
			if (s && now - s.lastUsed > this.opts.idleMs) {
				this.sessions.delete(name);
				await s.close();
				log.info("browser closed (idle)", { bot: name });
			}
		}
	}

	async close(): Promise<void> {
		clearInterval(this.sweep);
		const all = [...this.sessions.values()];
		this.sessions.clear();
		for (const p of all) await (await p.catch(() => undefined))?.close();
	}
}
