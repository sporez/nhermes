// Software updates from the git checkout: list what is new, fast-forward, reinstall packages only when
// the lockfile changed, restart through the service manager, go back to the previous version, and
// refuse a checkout with local changes or a version that needs a newer Node.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Updates } from "../../src/core/updates.ts";
import { AppDb } from "../../src/store/db.ts";
import { tempDir } from "../helpers.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, encoding: "utf8" }).trim();

function commit(repo: string, file: string, content: string, message: string): void {
	writeFileSync(join(repo, file), content);
	git(repo, "add", file);
	git(repo, "commit", "-q", "-m", message);
}

test("check, update, restart, go back; refuse local changes and a newer Node", async () => {
	const { dir, cleanup } = await tempDir();
	const origin = join(dir, "origin.git");
	const dev = join(dir, "dev");
	const code = join(dir, "code");
	mkdirSync(dev);
	git(dir, "init", "-q", "--bare", "-b", "main", origin);
	git(dev, "init", "-q", "-b", "main");
	commit(dev, "package.json", JSON.stringify({ engines: { node: ">=24" } }), "first");
	commit(dev, "package-lock.json", "{}", "lockfile");
	git(dev, "remote", "add", "origin", origin);
	git(dev, "push", "-q", "origin", "main");
	git(dir, "clone", "-q", origin, code);

	const installs: string[] = [];
	let restarts = 0;
	const db = new AppDb(":memory:");
	const updates = new Updates(db, { codeDir: code, installPackages: (d) => void installs.push(d), restart: () => void restarts++, managed: true });
	try {
		let s = updates.check();
		assert.equal(s.updatable, true);
		assert.equal(s.current?.subject, "lockfile");
		assert.deepEqual(s.available, []);
		assert.throws(() => updates.update(), /already up to date/);

		// Two new commits upstream, one of them touching the lockfile.
		commit(dev, "README.md", "hello", "docs");
		commit(dev, "package-lock.json", '{"v":2}', "bump a package");
		git(dev, "push", "-q", "origin", "main");
		s = updates.check();
		assert.deepEqual(s.available.map((c) => c.subject), ["bump a package", "docs"]);

		const r = updates.update();
		assert.equal(r.from.hash, s.current!.hash);
		assert.equal(r.to.subject, "bump a package");
		assert.equal(r.packagesReinstalled, true);
		assert.deepEqual(installs, [code]);
		assert.equal(r.restarting, true);
		await new Promise((res) => setTimeout(res, 700));
		assert.equal(restarts, 1);
		assert.deepEqual(updates.status().available, []);
		assert.equal(updates.status().previous?.subject, "lockfile");

		// Back to the previous version (the lockfile changes back, so packages are reinstalled again).
		const back = updates.rollback();
		assert.equal(back.to.subject, "lockfile");
		assert.equal(installs.length, 2);
		assert.deepEqual(updates.status().available.map((c) => c.subject), ["bump a package", "docs"]);

		// Local changes block an update.
		writeFileSync(join(code, "README.md"), "edited here");
		git(code, "add", "README.md");
		assert.throws(() => updates.update(), /local changes/);
		git(code, "reset", "-q", "--hard");

		// A version that needs a newer Node is refused, and nothing moves.
		commit(dev, "package.json", JSON.stringify({ engines: { node: ">=99" } }), "needs node 99");
		git(dev, "push", "-q", "origin", "main");
		const before = updates.status().current!.hash;
		assert.throws(() => updates.update(), /needs Node 99 or newer.*install script/);
		assert.equal(updates.status().current!.hash, before);
	} finally {
		db.close();
		await cleanup();
	}
});

test("a copy that is not a git checkout says how to get updates", async () => {
	const { dir, cleanup } = await tempDir();
	const db = new AppDb(":memory:");
	try {
		const updates = new Updates(db, { codeDir: dir, managed: false });
		const s = updates.status();
		assert.equal(s.updatable, false);
		assert.match(s.reason!, /not a git checkout.*install script/);
		assert.throws(() => updates.check(), /not a git checkout/);
	} finally {
		db.close();
		await cleanup();
	}
});

test("a remote on http:// or git:// is refused, and credentials in the remote address are not shown", async () => {
	const { dir, cleanup } = await tempDir();
	const origin = join(dir, "origin.git");
	const code = join(dir, "code");
	const dev = join(dir, "dev");
	mkdirSync(dev);
	git(dir, "init", "-q", "--bare", "-b", "main", origin);
	git(dev, "init", "-q", "-b", "main");
	commit(dev, "package.json", "{}", "first");
	git(dev, "remote", "add", "origin", origin);
	git(dev, "push", "-q", "origin", "main");
	git(dir, "clone", "-q", origin, code);
	const updates = new Updates(new AppDb(":memory:"), { codeDir: code, installPackages: () => {}, managed: false });
	try {
		assert.equal(updates.status().updatable, true, "a local path is fine");
		git(code, "remote", "set-url", "origin", "https://user:pass@example.com/repo.git");
		assert.equal(updates.status().remote, "https://example.com/repo.git");
		git(code, "remote", "set-url", "origin", "http://example.com/repo.git");
		const s = updates.status();
		assert.equal(s.updatable, false);
		assert.match(s.reason ?? "", /unencrypted/);
		assert.throws(() => updates.check(), /unencrypted/);
		assert.throws(() => updates.update(), /unencrypted/);
		git(code, "remote", "set-url", "origin", "git://example.com/repo.git");
		assert.throws(() => updates.check(), /unencrypted/);
		git(code, "remote", "set-url", "origin", "git@example.com:me/repo.git");
		assert.equal(updates.status().updatable, true, "ssh is fine");
	} finally {
		await cleanup();
	}
});
