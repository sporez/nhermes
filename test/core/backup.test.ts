import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { makeBackup, restoreBackup } from "../../src/admin.ts";
import { collect, fauxModels, tempDir, testConfig, testCore } from "../helpers.ts";

test("backup taken from a live gateway restores sessions, transcripts, memory, jobs and approval rules", async () => {
	const { dir, cleanup } = await tempDir();
	const config = testConfig(dir);
	writeFileSync(config.configPath, "# test config\n");
	writeFileSync(join(dir, "secrets.env"), "NHERMES_TOKEN=xyz\n");
	const a = fauxModels();
	const core = await testCore(dir, { models: a.models, config });
	const out = join(dir, "backups", "b.tar.gz");
	let sessionId = "";
	try {
		const s = await core.sessions.create("main");
		sessionId = s.id;
		const c = collect(core.hub, s.id);
		a.faux.setResponses([fauxAssistantMessage([fauxText("Backed-up answer.")])]);
		await core.sessions.submit(s.id, "something worth keeping");
		await c.until((e) => e.type === "run.finished");
		core.memory.add(core.bots.require("main"), { body: "The backup drive is the blue one.", pinned: true });
		core.scheduler.create({ name: "Nightly", bot: "ops", prompt: "check", schedule: "0 2 * * *" });
		core.approvals.addRule("bot:ops", "rm -rf");
		// Taken while the gateway is running.
		const r = makeBackup(core, out, false);
		assert.ok(r.bytes > 1000);
	} finally {
		await core.close();
	}

	const restored = join(dir, "restored");
	const r = restoreBackup(out, join(restored, "data"), join(restored, "config"), true);
	assert.equal(r.previous, undefined);
	assert.ok(existsSync(join(restored, "config", "config.yaml")));
	assert.equal(existsSync(join(restored, "config", "secrets.env")), false, "secrets are excluded unless asked for");

	const b = fauxModels();
	const core2 = await testCore(dir, { models: b.models, config: { ...config, dataDir: join(restored, "data") } });
	try {
		const rows = await core2.sessions.rows(sessionId);
		assert.deepEqual(rows.map((x) => x.text), ["something worth keeping", "Backed-up answer."]);
		assert.equal(core2.sessions.require(sessionId).title, "something worth keeping");
		assert.match(core2.memory.search(core2.bots.require("main"), "backup drive")[0]!.body, /blue one/);
		assert.equal(core2.scheduler.list()[0]?.name, "Nightly");
		assert.deepEqual(core2.approvals.rules("bot:ops"), ["rm -rf"]);
		// And it keeps working.
		const c = collect(core2.hub, sessionId);
		b.faux.setResponses([fauxAssistantMessage([fauxText("Still here.")])]);
		await core2.sessions.submit(sessionId, "are you there?");
		const done = await c.until((e) => e.type === "run.finished");
		assert.equal(done.type === "run.finished" && done.text, "Still here.");
	} finally {
		await core2.close();
	}
	try {
		// Restoring over existing data keeps the old data aside.
		const again = restoreBackup(out, join(restored, "data"), join(restored, "config"), false);
		assert.ok(again.previous && existsSync(again.previous));
	} finally {
		await cleanup();
	}
});

test("a backup is owner-only and, without --secrets, carries no member keys or panel cookie key", async () => {
	const { dir, cleanup } = await tempDir();
	const config = testConfig(dir);
	writeFileSync(config.configPath, "# test config\n");
	const core = await testCore(dir, { models: fauxModels().models, config });
	try {
		core.db.run("INSERT INTO members (node_id, name, url, secret, joined_at, prev_secret, prev_until) VALUES ('n1', 'other', 'http://example.com', 'pair-secret', 1, 'old-pair-secret', 99)");
		core.db.run("INSERT INTO member_outbox (node_id, path, body, created_at) VALUES ('n1', '/federation/introduce', 'pair-secret-in-body', 1)");
		core.db.run("INSERT INTO invites (secret_hash, expires_at) VALUES ('h', 99)");
		core.db.run("INSERT INTO settings (key, value) VALUES ('panel.password', 'salt:hash'), ('panel.cookieKey', 'cookie-key')");
		const extract = (file: string): DatabaseSync => {
			const to = join(dir, `x-${Math.random().toString(36).slice(2)}`);
			mkdirSync(to);
			execFileSync("tar", ["-xzf", file, "-C", to]);
			return new DatabaseSync(join(to, "data", "app.sqlite"), { readOnly: true });
		};
		const plain = join(dir, "out", "plain.tar.gz");
		makeBackup(core, plain, false);
		if (process.platform !== "win32") assert.equal(statSync(plain).mode & 0o777, 0o600);
		const db = extract(plain);
		assert.deepEqual(db.prepare("SELECT secret, prev_secret, prev_until FROM members").all().map((r) => ({ ...r })), [{ secret: "", prev_secret: null, prev_until: null }]);
		assert.equal(db.prepare("SELECT count(*) AS n FROM member_outbox").get()!.n, 0);
		assert.equal(db.prepare("SELECT count(*) AS n FROM invites").get()!.n, 0);
		assert.equal(db.prepare("SELECT value FROM settings WHERE key = 'panel.cookieKey'").get(), undefined);
		assert.equal(db.prepare("SELECT value FROM settings WHERE key = 'panel.password'").get()!.value, "salt:hash");
		db.close();

		const full = join(dir, "out", "full.tar.gz");
		makeBackup(core, full, true);
		const kept = extract(full);
		assert.equal(kept.prepare("SELECT secret FROM members").get()!.secret, "pair-secret");
		kept.close();
	} finally {
		await core.close();
		await cleanup();
	}
});
