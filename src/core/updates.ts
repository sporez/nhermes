// Software updates from the git checkout the gateway runs from (the install script clones the GitHub
// repo). "Check" fetches and lists the new commits; "update" fast-forwards, reinstalls packages when the
// lockfile changed, and restarts the gateway through its service manager (systemd or launchd start it
// again). The commit it came from is kept, so an update can be undone. A checkout with local changes,
// or an update that needs a newer Node, is refused with the reason.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { logger } from "../log.ts";
import type { AppDb } from "../store/db.ts";

const log = logger("updates");

export class UpdateError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

export type Commit = { hash: string; subject: string; date: number };

export type SoftwareStatus = {
	/** Whether the code is a git checkout this can update. */
	updatable: boolean;
	/** Why it cannot update, when it cannot. */
	reason?: string;
	codeDir: string;
	branch?: string;
	remote?: string;
	current?: Commit;
	/** Commits on the remote branch that this checkout does not have (from the last check). */
	available: Commit[];
	lastCheck: number | null;
	previous?: Commit;
	/** A service manager will start the gateway again after it exits. */
	managed: boolean;
};

export type UpdatesOptions = {
	/** The checkout to update (default: the code this process runs). */
	codeDir?: string;
	/** Runs `npm ci` in the checkout (tests replace it). */
	installPackages?: (codeDir: string) => void;
	/** Restarts the gateway after an update (the CLI exits so the service manager starts it again). */
	restart?: () => void;
	managed?: boolean;
};

const DEFAULT_CODE_DIR = resolve(import.meta.dirname, "..", "..");

export class Updates {
	private readonly db: AppDb;
	private readonly codeDir: string;
	private readonly installPackages: (codeDir: string) => void;
	private readonly restartFn: (() => void) | undefined;
	private readonly managed: boolean;
	private timer: ReturnType<typeof setInterval> | undefined;

	constructor(db: AppDb, opts: UpdatesOptions = {}) {
		this.db = db;
		this.codeDir = opts.codeDir ?? DEFAULT_CODE_DIR;
		this.installPackages = opts.installPackages ?? defaultInstall;
		this.restartFn = opts.restart;
		// systemd sets INVOCATION_ID for a service; launchd sets XPC_SERVICE_NAME to the job's label.
		this.managed = opts.managed ?? (Boolean(process.env.INVOCATION_ID) || (process.env.XPC_SERVICE_NAME ?? "").includes("nhermes"));
	}

	private git(args: string[], timeoutMs = 15_000): string {
		return execFileSync("git", args, { cwd: this.codeDir, encoding: "utf8", timeout: timeoutMs, stdio: ["ignore", "pipe", "pipe"] }).trim();
	}

	private commit(ref: string): Commit | undefined {
		try {
			const [hash = "", date = "0", ...subject] = this.git(["log", "-1", "--format=%h%x00%ct%x00%s", ref]).split("\0");
			return { hash, date: Number(date), subject: subject.join("\0") };
		} catch {
			return undefined;
		}
	}

	private setting(key: string): string | undefined {
		return this.db.get<{ value: string }>("SELECT value FROM settings WHERE key = ?", key)?.value;
	}

	private setSetting(key: string, value: string): void {
		this.db.run("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
	}

	/** Why this checkout cannot be updated in place, or undefined when it can. */
	private blocker(): string | undefined {
		if (!existsSync(join(this.codeDir, ".git"))) return "the code is not a git checkout; reinstall with the install script to get updates";
		try {
			this.git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
		} catch {
			return "the checkout has no upstream branch to update from";
		}
		if (this.git(["status", "--porcelain", "--untracked-files=no"])) return `${this.codeDir} has local changes; update it by hand or discard them`;
		return undefined;
	}

	status(): SoftwareStatus {
		const reason = this.blocker();
		const base: SoftwareStatus = { updatable: reason === undefined, codeDir: this.codeDir, available: [], lastCheck: Number(this.setting("updates.lastCheck") ?? 0) || null, managed: this.managed };
		if (reason) base.reason = reason;
		if (!existsSync(join(this.codeDir, ".git"))) return base;
		try {
			base.branch = this.git(["rev-parse", "--abbrev-ref", "HEAD"]);
			const upstream = this.git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
			base.remote = this.git(["remote", "get-url", upstream.split("/")[0]!]);
			base.available = this.git(["log", "--format=%h%x00%ct%x00%s", `HEAD..${upstream}`])
				.split("\n")
				.filter(Boolean)
				.map((l) => {
					const [hash = "", date = "0", ...subject] = l.split("\0");
					return { hash, date: Number(date), subject: subject.join("\0") };
				});
		} catch {
			// No upstream: nothing to list.
		}
		base.current = this.commit("HEAD");
		const prev = this.setting("updates.previous");
		if (prev) base.previous = this.commit(prev);
		return base;
	}

	/** Fetches from the remote and returns the status with the commits now available. */
	check(): SoftwareStatus {
		if (!existsSync(join(this.codeDir, ".git"))) throw new UpdateError(409, "the code is not a git checkout; reinstall with the install script to get updates");
		try {
			this.git(["fetch", "--quiet"], 60_000);
		} catch (error) {
			throw new UpdateError(502, `could not reach the repository (${error instanceof Error ? error.message.split("\n")[0] : String(error)})`);
		}
		this.setSetting("updates.lastCheck", String(Date.now() / 1000));
		const s = this.status();
		log.info("checked for updates", { available: s.available.length });
		return s;
	}

	/** Moves to the latest upstream commit, reinstalls packages if needed, then restarts. */
	update(): { from: Commit; to: Commit; packagesReinstalled: boolean; restarting: boolean } {
		const reason = this.blocker();
		if (reason) throw new UpdateError(409, reason);
		const s = this.check();
		if (s.available.length === 0) throw new UpdateError(409, "already up to date");
		this.ensureNodeFits("@{u}");
		const from = this.commit("HEAD")!;
		const fromFull = this.git(["rev-parse", "HEAD"]);
		this.git(["merge", "--ff-only", "--quiet", "@{u}"], 60_000);
		return this.finish(fromFull, from);
	}

	/** Goes back to the version before the last update. */
	rollback(): { from: Commit; to: Commit; packagesReinstalled: boolean; restarting: boolean } {
		const prev = this.setting("updates.previous");
		if (!prev) throw new UpdateError(409, "there is no earlier version recorded");
		const reason = this.blocker();
		if (reason && !reason.includes("upstream")) throw new UpdateError(409, reason);
		this.ensureNodeFits(prev);
		const from = this.commit("HEAD")!;
		const fromFull = this.git(["rev-parse", "HEAD"]);
		this.git(["reset", "--keep", prev]);
		return this.finish(fromFull, from);
	}

	private finish(fromFull: string, from: Commit): { from: Commit; to: Commit; packagesReinstalled: boolean; restarting: boolean } {
		const changed = this.git(["diff", "--name-only", fromFull, "HEAD"]).split("\n");
		const packagesReinstalled = changed.includes("package-lock.json") || changed.includes("package.json");
		if (packagesReinstalled) this.installPackages(this.codeDir);
		this.setSetting("updates.previous", fromFull);
		const to = this.commit("HEAD")!;
		log.info("software changed", { from: from.hash, to: to.hash, packagesReinstalled });
		const restarting = this.canRestart;
		if (restarting) setTimeout(() => this.restartFn!(), 500).unref();
		return { from, to, packagesReinstalled, restarting };
	}

	/** Whether the gateway can restart itself: a service manager starts it again after it exits. */
	get canRestart(): boolean {
		return this.managed && this.restartFn !== undefined;
	}

	/** Restarts the gateway (Vory's "Restart gateway"); refused when nothing would start it again. */
	restart(): void {
		if (!this.canRestart) throw new UpdateError(409, "this gateway is not run by systemd or launchd, so it cannot restart itself; restart it on its machine");
		log.info("restart requested");
		setTimeout(() => this.restartFn!(), 500).unref();
	}

	/** Refuses a version whose package.json needs a newer Node than the one running. */
	private ensureNodeFits(ref: string): void {
		let pkg: { engines?: { node?: string } };
		try {
			pkg = JSON.parse(this.git(["show", `${ref}:package.json`])) as typeof pkg;
		} catch {
			return;
		}
		const need = /(\d+)/.exec(pkg.engines?.node ?? "")?.[1];
		const have = Number(process.versions.node.split(".")[0]);
		if (need && have < Number(need)) throw new UpdateError(409, `this version needs Node ${need} or newer (running ${process.versions.node}); run the install script instead`);
	}

	/** Checks once a day so the panel can show that an update is waiting. */
	start(): void {
		const tick = () => {
			try {
				if (existsSync(join(this.codeDir, ".git"))) this.check();
			} catch (error) {
				log.debug("update check failed", { error: error instanceof Error ? error.message : String(error) });
			}
		};
		this.timer = setInterval(tick, 24 * 3600_000);
		this.timer.unref();
		setTimeout(tick, 60_000).unref();
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
	}
}

function defaultInstall(codeDir: string): void {
	// npm sits next to the node binary in the official builds the install script uses.
	const npm = existsSync(join(dirname(process.execPath), "npm")) ? join(dirname(process.execPath), "npm") : "npm";
	execFileSync(npm, ["ci", "--omit=dev", "--no-audit", "--no-fund", "--loglevel=error"], { cwd: codeDir, stdio: "ignore", timeout: 300_000, env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}` } });
	if (!existsSync(join(codeDir, "node_modules"))) throw new UpdateError(500, "npm ci did not install the packages");
}
