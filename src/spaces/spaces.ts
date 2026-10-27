// Spaces: disposable Cua desktops on the gateway host that bots open, use and throw away. This owns their
// lifecycle: open, close, list, the per-bot and per-gateway limits, deletion of idle ones, and a sweep of
// leftovers. Nothing is persisted: `cua sb ls` is the record of what exists, and every sandbox named
// `nhermes-<tag>-*` that this process does not hold is a leftover (a crash, a restart) and gets deleted. The
// tag comes from the gateway's data directory, so two gateways on one host never delete each other's spaces.
// Control goes through pi-env's daemon, copied into the space and run with `cua sb exec -i`. The owner watches a
// space through Cua's own viewer (`viewLink`; src/spaces/viewer.ts serves it), and a watched space is never idle.
// While the owner has a control view open, the bot's desktop input in that space is refused (src/tools/desktop.ts).
import { createHash, randomBytes } from "node:crypto";
import { Connection, packagedDaemon, RemoteExecutionEnv } from "@earendil-works/pi-env";
import type { SpacesConfig } from "../config.ts";
import { logger } from "../log.ts";
import { CuaMissing, type CuaResult, type CuaRun, cuaProblem, execCua, parseSandboxNames, SPACES_NEED_CUA } from "./cua.ts";

const log = logger("spaces");

const GUEST_DAEMON = "/tmp/pi-env";
const SWEEP_EVERY_MS = 24 * 60 * 60 * 1000;
const CREATE_TIMEOUT_MS = 180_000;
/**
 * How long a viewer link opens new connections. Cua keeps a space's media session (and its audio capture) until
 * the ticket expires, so a short ticket bounds what an abandoned viewer costs; a viewer already connected stays.
 */
export const VIEW_TTL_S = 600;

/** `watching`: open views of it; `controlling`: those of them with control (the owner's mouse and keys). */
export type SpaceInfo = { id: string; name: string; bot: string; createdAt: number; lastUsed: number; watching: number; controlling: number };

/** A viewer link from Cua: the space's viewer port on this host's loopback, and the URL fragment holding its ticket. */
export type ViewLink = { port: number; fragment: string; expiresAt: number };

/** A space that is not (or no longer) open; `message` is for the owner. */
export class SpaceGone extends Error {}

/** What the bot is told while the owner has taken control of one of its spaces. */
export function ownerHasControl(id: string): string {
	return `The owner has taken control of space ${id} and is using its mouse and keyboard. Don't click, type, scroll, focus or launch anything there until they hand it back (they close the view or switch to watching); screenshots, reading windows and space_shell still work. Tell them what you were about to do, or wait for their next message.`;
}

export type SpacesOptions = {
	config: SpacesConfig;
	/** This gateway's data directory: names its spaces apart from those of other gateways on the host. */
	dataDir: string;
	/** Replaces the cua command (tests). */
	run?: CuaRun;
	/** The local file to copy into a space as its daemon; default: pi-env's Linux build for this machine's architecture. */
	daemonBinary?: () => string;
	/** The command whose stdio is the daemon's, `cua sb exec -i <name> -- /tmp/pi-env` by default. */
	daemonCommand?: (name: string) => string[];
	/** Milliseconds; replaced by tests that move time. */
	now?: () => number;
	/** How long closing the gateway waits for deletions. */
	shutdownTimeoutMs?: number;
};

type Space = SpaceInfo & { inUse: number; connection?: Connection; env?: RemoteExecutionEnv; envPromise?: Promise<RemoteExecutionEnv> };

export class Spaces {
	private readonly config: SpacesConfig;
	private readonly run: CuaRun;
	private readonly now: () => number;
	/** `nhermes-<tag>-`: what every sandbox of this gateway starts with. */
	private readonly prefix: string;
	private readonly spaces = new Map<string, Space>();
	/** Opens in progress (id → bot): counted against the limits, and not leftovers. */
	private readonly pending = new Map<string, string>();
	private readonly options: SpacesOptions;
	private timers: NodeJS.Timeout[] = [];
	private closed = false;
	private readonly removedListeners = new Set<(id: string) => void>();

	constructor(options: SpacesOptions) {
		this.options = options;
		this.config = options.config;
		this.run = options.run ?? execCua(options.config.cua);
		this.now = options.now ?? Date.now;
		this.prefix = `nhermes-${gatewayTag(options.dataDir)}-`;
	}

	/** Starts the idle timer and the daily sweep, and sweeps once now in the background (never blocks or fails startup). */
	start(): void {
		const idleMs = this.config.idleMinutes * 60_000;
		const check = setInterval(() => void this.deleteIdle().catch((e) => log.warn("deleting idle spaces failed", { error: String(e) })), Math.min(60_000, Math.max(1000, idleMs / 4)));
		const daily = setInterval(() => void this.sweep().catch(sweepFailed), SWEEP_EVERY_MS);
		check.unref();
		daily.unref();
		this.timers.push(check, daily);
		void this.sweep().catch(sweepFailed);
	}

	/** Opens a space for a bot: `id` is what the bot uses, `name` is the Cua sandbox. */
	async open(bot: string): Promise<{ id: string; name: string }> {
		if (this.closed) throw new Error("The gateway is shutting down; no space can be opened now.");
		const mine = this.countFor(bot);
		if (mine >= this.config.perBot) throw new Error(`You already have ${mine} space${mine === 1 ? "" : "s"} open (the limit is ${this.config.perBot} per bot). Close one with space_close first.`);
		const all = this.spaces.size + this.pending.size;
		if (all >= this.config.total) throw new Error(`This gateway already has ${all} space${all === 1 ? "" : "s"} open (the limit is ${this.config.total} in all). Close one with space_close, or try again when another bot is done.`);
		let id = newId();
		while (this.spaces.has(id) || this.pending.has(id)) id = newId();
		const name = `${this.prefix}${botSlug(bot)}-${id}`;
		this.pending.set(id, bot);
		try {
			const made = await this.cua(["sb", "create", this.config.image, "--name", name, "--wait", "desktop", "--json"], CREATE_TIMEOUT_MS);
			if (made.code !== 0) {
				// A create that failed half way may have left a sandbox behind.
				await this.run(["sb", "rm", "-f", name]).catch(() => {});
				throw new Error(`Could not open a space: ${cuaProblem(made)}`);
			}
			const t = this.now();
			this.spaces.set(id, { id, name, bot, createdAt: t, lastUsed: t, inUse: 0, watching: 0, controlling: 0 });
			log.info("space opened", { id, name, bot });
			return { id, name };
		} finally {
			this.pending.delete(id);
		}
	}

	/** The bot's open spaces (all of them without a bot name), oldest first. */
	list(bot?: string): SpaceInfo[] {
		return [...this.spaces.values()]
			.filter((s) => bot === undefined || s.bot === bot)
			.map(({ id, name, bot: b, createdAt, lastUsed, watching, controlling }) => ({ id, name, bot: b, createdAt, lastUsed, watching, controlling }))
			.sort((a, b) => a.createdAt - b.createdAt);
	}

	/** Notes a use, which resets the idle clock. */
	touch(id: string): void {
		const s = this.spaces.get(id);
		if (s) s.lastUsed = this.now();
	}

	/**
	 * Runs `fn` with the environment of one of the bot's spaces. While it runs the space counts as in use and is
	 * never deleted as idle, however long the call takes; the idle clock restarts when it ends.
	 */
	async use<T>(bot: string, id: string, fn: (env: RemoteExecutionEnv) => Promise<T>): Promise<T> {
		const space = this.owned(bot, id);
		space.inUse++;
		try {
			return await fn(await this.env(bot, id));
		} finally {
			space.inUse--;
			space.lastUsed = this.now();
		}
	}

	/** The pi-env environment for one of the bot's spaces; the daemon is deployed and started on first use, then reused. */
	async env(bot: string, id: string): Promise<RemoteExecutionEnv> {
		const space = this.owned(bot, id);
		this.touch(id);
		if (space.env) return space.env;
		space.envPromise ??= this.connect(space).finally(() => {
			space.envPromise = undefined;
		});
		return space.envPromise;
	}

	async close(bot: string, id: string): Promise<void> {
		await this.remove(this.owned(bot, id));
	}

	/**
	 * A link to Cua's viewer for one of the bot's spaces: watch only, or with `control` the owner's mouse and keys
	 * reach the space (clipboard on; files and microphone off). Each call mints a new ticket.
	 */
	async viewLink(bot: string, id: string, control: boolean): Promise<ViewLink> {
		const space = this.spaces.get(id);
		if (!space || space.bot !== bot) throw new SpaceGone(`Space ${id} is closed.`);
		const mode = control ? ["--files", "none"] : ["--view-only"];
		const r = await this.cua(["sb", "view", space.name, ...mode, "--no-open", "--ttl", String(VIEW_TTL_S), "--json"]);
		if (r.code !== 0) throw new Error(`Could not open a view of space ${id}: ${cuaProblem(r)}`);
		const link = parseViewLink(r.stdout);
		if (!link) throw new Error(`cua gave a view of space ${id} that nHermes could not use`);
		return link;
	}

	/**
	 * Counts a viewer of a space until the returned function is called: a watched space is never deleted as idle,
	 * and its idle clock restarts when the last viewer leaves. A viewer with `control` also holds the space's desktop
	 * for the owner (`controlled`). Undefined when the space is gone.
	 */
	watch(id: string, opts: { control: boolean }): (() => void) | undefined {
		const space = this.spaces.get(id);
		if (!space) return undefined;
		space.watching++;
		if (opts.control) space.controlling++;
		let done = false;
		return () => {
			if (done) return;
			done = true;
			space.watching--;
			if (opts.control) space.controlling--;
			space.lastUsed = this.now();
		};
	}

	/** Whether the owner has a control view of the space open right now. */
	controlled(id: string): boolean {
		return (this.spaces.get(id)?.controlling ?? 0) > 0;
	}

	/** Called with a space's id once it is deleted (closed, idle, or at shutdown). */
	onRemoved(listener: (id: string) => void): void {
		this.removedListeners.add(listener);
	}

	/** Deletes spaces unused for the idle time (never one a call is using or the owner is watching); returns their ids. */
	async deleteIdle(): Promise<string[]> {
		const cutoff = this.now() - this.config.idleMinutes * 60_000;
		const gone: string[] = [];
		for (const s of [...this.spaces.values()].filter((x) => x.inUse === 0 && x.watching === 0 && x.lastUsed <= cutoff)) {
			try {
				await this.remove(s);
				log.info("idle space deleted", { id: s.id, bot: s.bot });
				gone.push(s.id);
			} catch (e) {
				log.warn("could not delete an idle space", { id: s.id, error: String(e) });
			}
		}
		return gone;
	}

	/** Deletes every sandbox with this gateway's prefix that it does not hold; returns their names. */
	async sweep(): Promise<string[]> {
		const listed = await this.cua(["sb", "ls", "--json"]);
		if (listed.code !== 0) throw new Error(`cua could not list sandboxes: ${cuaProblem(listed)}`);
		const known = new Set([...this.spaces.values()].map((s) => s.name));
		const removed: string[] = [];
		for (const name of parseSandboxNames(listed.stdout)) {
			if (!name.startsWith(this.prefix) || known.has(name)) continue;
			// A space being created is not held yet; its id ends the name.
			if ([...this.pending.keys()].some((id) => name.endsWith(`-${id}`))) continue;
			const r = await this.run(["sb", "rm", "-f", name]).catch((e) => ({ code: 1, stdout: "", stderr: String(e) }));
			if (r.code === 0) removed.push(name);
			else log.warn("could not delete a leftover space", { name, problem: cuaProblem(r) });
		}
		if (removed.length) log.info("deleted leftover spaces", { names: removed });
		return removed;
	}

	/** Stops the timers and deletes every open space, best effort within a short time. */
	async shutdown(): Promise<void> {
		this.closed = true;
		for (const t of this.timers) clearInterval(t);
		this.timers = [];
		const all = [...this.spaces.values()];
		let timer: NodeJS.Timeout | undefined;
		const limit = new Promise<void>((resolve) => {
			timer = setTimeout(resolve, this.options.shutdownTimeoutMs ?? 10_000);
			timer.unref();
		});
		await Promise.race([Promise.allSettled(all.map((s) => this.remove(s))), limit]);
		clearTimeout(timer);
		for (const s of all) s.connection?.close();
	}

	private countFor(bot: string): number {
		return [...this.spaces.values()].filter((s) => s.bot === bot).length + [...this.pending.values()].filter((b) => b === bot).length;
	}

	private owned(bot: string, id: string): Space {
		const space = this.spaces.get(id);
		if (space && space.bot === bot) return space;
		const mine = this.list(bot).map((s) => s.id);
		throw new Error(`You have no space ${id}. ${mine.length ? `Your open spaces: ${mine.join(", ")}.` : "You have no open spaces."}`);
	}

	/** Forgets the space first, so nothing can use it while it goes; one that will not delete is swept later. */
	private async remove(space: Space): Promise<void> {
		this.spaces.delete(space.id);
		space.connection?.close();
		for (const l of this.removedListeners) l(space.id);
		const r = await this.run(["sb", "rm", "-f", space.name]);
		if (r.code !== 0) throw new Error(`Could not delete space ${space.id}: ${cuaProblem(r)}. It will be removed by the next cleanup.`);
		log.info("space closed", { id: space.id, bot: space.bot });
	}

	private async connect(space: Space): Promise<RemoteExecutionEnv> {
		const { name } = space;
		const binary = this.options.daemonBinary?.() ?? packagedDaemon({ platform: "linux", arch: process.arch === "arm64" ? "arm64" : "x64" });
		const copied = await this.cua(["sb", "cp", binary, `${name}:${GUEST_DAEMON}`]);
		if (copied.code !== 0) throw new Error(`Could not set up space ${space.id}: ${cuaProblem(copied)}`);
		const made = await this.cua(["sb", "exec", name, "--", `chmod +x ${GUEST_DAEMON}`]);
		if (made.code !== 0) throw new Error(`Could not set up space ${space.id}: ${cuaProblem(made)}`);
		const connection = new Connection({
			command: this.options.daemonCommand?.(name) ?? [this.config.cua, "sb", "exec", "-i", name, "--", GUEST_DAEMON],
			onLog: (t) => log.debug("pi-env", { id: space.id, text: t.slice(0, 500) }),
		});
		try {
			const env = new RemoteExecutionEnv({ connection, id: `nhermes-space:${space.id}`, cwd: (await connection.info()).home });
			space.connection = connection;
			space.env = env;
			return env;
		} catch (e) {
			connection.close();
			throw new Error(`Could not connect to space ${space.id}: ${String(e instanceof Error ? e.message : e).slice(0, 300)}`);
		}
	}

	private cua(args: string[], timeoutMs?: number): Promise<CuaResult> {
		return this.run(args, { timeoutMs });
	}
}

function sweepFailed(e: unknown): void {
	if (e instanceof CuaMissing) log.debug(SPACES_NEED_CUA);
	else log.warn("sweeping leftover spaces failed", { error: String(e) });
}

/** Four hex characters naming one gateway's data directory. */
export function gatewayTag(dataDir: string): string {
	return createHash("sha256").update(dataDir).digest("hex").slice(0, 4);
}

/**
 * The port and fragment of `cua sb view --json`'s `{url, expires_at_unix}`. Only a viewer on this host's loopback
 * is accepted: the gateway forwards to that port and nowhere else.
 */
export function parseViewLink(stdout: string): ViewLink | undefined {
	let json: { url?: unknown; expires_at_unix?: unknown };
	try {
		json = JSON.parse(stdout) as typeof json;
	} catch {
		return undefined;
	}
	if (typeof json.url !== "string") return undefined;
	let url: URL;
	try {
		url = new URL(json.url);
	} catch {
		return undefined;
	}
	const port = Number(url.port);
	if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !Number.isInteger(port) || port <= 0 || url.pathname.replace(/\/$/, "") !== "/viewer") return undefined;
	const fragment = url.hash.replace(/^#/, "");
	if (!/(^|&)ticket=[^&]+/.test(fragment)) return undefined;
	const expiresAt = typeof json.expires_at_unix === "number" ? json.expires_at_unix * 1000 : Date.now() + VIEW_TTL_S * 1000;
	return { port, fragment, expiresAt };
}

function newId(): string {
	return `s-${randomBytes(2).toString("hex")}`;
}

/** The bot's name as it appears in a sandbox name: lowercase letters, digits and hyphens. */
export function botSlug(bot: string): string {
	return bot.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "bot";
}
