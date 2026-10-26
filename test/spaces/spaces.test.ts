// Spaces: limits, ownership, idle deletion, the sweep, shutdown and config, against an in-memory cua; and one
// run through a fake cua executable with the real pi-env daemon (fake-cua.mjs).
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { localDaemon } from "@earendil-works/pi-env";
import { createCore } from "../../src/app.ts";
import { ConfigError, loadConfig, type SpacesConfig } from "../../src/config.ts";
import { setLogLevel, setLogSink } from "../../src/log.ts";
import type { CuaRun } from "../../src/spaces/cua.ts";
import { botSlug, gatewayTag, Spaces } from "../../src/spaces/spaces.ts";
import { fauxModels, TOKEN, tempDir, testConfig } from "../helpers.ts";

const here = dirname(fileURLToPath(import.meta.url));
const DATA = "gateway-a";
const TAG = gatewayTag(DATA);
const CONFIG: SpacesConfig = { cua: "cua", image: "linux", perBot: 2, total: 3, idleMinutes: 30 };

/** A cua with a list of sandboxes in memory; `gate` holds creates until released. */
function memoryCua(initial: string[] = []) {
	const boxes = new Set(initial);
	const calls: string[][] = [];
	let gate: Promise<void> | undefined;
	let creating = 0;
	const run: CuaRun = async (args) => {
		calls.push(args);
		const [, cmd] = args;
		if (cmd === "create") {
			creating++;
			await gate;
			boxes.add(args[args.indexOf("--name") + 1]!);
			return { code: 0, stdout: "{}", stderr: "" };
		}
		if (cmd === "ls") return { code: 0, stdout: JSON.stringify({ sandboxes: [...boxes].map((name) => ({ name, more: true })) }), stderr: "" };
		if (cmd === "rm") return boxes.delete(args.at(-1)!) ? { code: 0, stdout: "", stderr: "" } : { code: 1, stdout: "", stderr: "not found" };
		return { code: 2, stdout: "", stderr: "unsupported" };
	};
	return {
		run,
		boxes,
		calls,
		hold() {
			let release!: () => void;
			gate = new Promise<void>((r) => (release = r));
			return () => {
				gate = undefined;
				release();
			};
		},
		get creating() {
			return creating;
		},
	};
}

test("a space is named for its bot, and open, list and close follow it", async () => {
	const cua = memoryCua();
	const spaces = new Spaces({ dataDir: DATA, config: CONFIG, run: cua.run });
	const a = await spaces.open("Main Bot_1");
	assert.match(a.id, /^s-[0-9a-f]{4}$/);
	assert.equal(a.name, `nhermes-${TAG}-main-bot-1-${a.id}`);
	assert.ok(cua.boxes.has(a.name));
	assert.deepEqual(cua.calls[0]?.slice(0, 3), ["sb", "create", "linux"]);
	assert.deepEqual(spaces.list("Main Bot_1").map((s) => s.id), [a.id]);
	assert.deepEqual(spaces.list("other"), []);
	await spaces.close("Main Bot_1", a.id);
	assert.equal(cua.boxes.size, 0);
	assert.deepEqual(spaces.list(), []);
	assert.equal(botSlug("###"), "bot");
});

test("limits per bot and in all hold, including opens that are still being created", async () => {
	const cua = memoryCua();
	const spaces = new Spaces({ dataDir: DATA, config: { ...CONFIG, perBot: 2, total: 3 }, run: cua.run });
	const release = cua.hold();
	const first = [spaces.open("a"), spaces.open("a")];
	// The third open is refused at once, while the first two are still being created.
	await assert.rejects(spaces.open("a"), /already have 2 spaces open.*2 per bot.*space_close/s);
	release();
	await Promise.all(first);
	assert.equal(cua.boxes.size, 2);

	const release2 = cua.hold();
	const more = ["b", "c", "d"].map((b) => spaces.open(b).then(() => "ok", (e: Error) => e.message));
	release2();
	const out = await Promise.all(more);
	assert.equal(out.filter((r) => r === "ok").length, 1, "one slot was left of three");
	assert.ok(out.some((r) => /already has 3 spaces open.*3 in all.*space_close/s.test(r)));
	assert.equal(cua.boxes.size, 3);
	// A failed create frees its slot.
	await spaces.close("a", spaces.list("a")[0]!.id);
	assert.equal((await spaces.open("e")).id.length, 6);
});

test("a failed create leaves nothing behind and does not use up a slot", async () => {
	const cua = memoryCua();
	const failing: CuaRun = async (args, o) => (args[1] === "create" ? { code: 1, stdout: "", stderr: "no runtime\nmore detail" } : cua.run(args, o));
	const spaces = new Spaces({ dataDir: DATA, config: { ...CONFIG, perBot: 1 }, run: failing });
	await assert.rejects(spaces.open("a"), /Could not open a space: no runtime$/);
	assert.ok(cua.calls.some((c) => c[1] === "rm"), "a half-made sandbox is removed");
	await assert.rejects(spaces.open("a"), /Could not open a space/, "refused for the failure, not for the limit");
});

test("a bot reaches only its own spaces", async () => {
	const spaces = new Spaces({ dataDir: DATA, config: CONFIG, run: memoryCua().run });
	const mine = await spaces.open("a");
	const other = await spaces.open("b");
	await assert.rejects(spaces.env("a", other.id), new RegExp(`no space ${other.id}.*Your open spaces: ${mine.id}\\.`));
	await assert.rejects(spaces.close("a", other.id), /no space/);
	await assert.rejects(spaces.close("a", "s-0000"), /Your open spaces: /);
	await assert.rejects(spaces.env("c", mine.id), /You have no open spaces\./);
	assert.equal(spaces.list().length, 2, "nothing was closed");
});

test("idle spaces are deleted, and using one resets the clock", async () => {
	const cua = memoryCua();
	let now = 1_000_000;
	const spaces = new Spaces({ dataDir: DATA, config: { ...CONFIG, idleMinutes: 10 }, run: cua.run, now: () => now });
	const used = await spaces.open("a");
	const idle = await spaces.open("a");
	now += 9 * 60_000;
	spaces.touch(used.id);
	now += 2 * 60_000;
	assert.deepEqual(await spaces.deleteIdle(), [idle.id]);
	assert.deepEqual(spaces.list().map((s) => s.id), [used.id]);
	assert.ok(!cua.boxes.has(idle.name));
	assert.equal(spaces.list()[0]?.lastUsed, 1_000_000 + 9 * 60_000);
	now += 11 * 60_000;
	assert.deepEqual(await spaces.deleteIdle(), [used.id]);
	assert.equal(cua.boxes.size, 0);
});

test("the sweep deletes only leftovers with this gateway's own prefix", async () => {
	const cua = memoryCua([`nhermes-${TAG}-old-s-1111`, "my-own-box", `nhermes-${TAG}-x-s-2222`, `nhermes-${gatewayTag("gateway-b")}-b-s-3333`, "nhermes-old-s-4444"]);
	const spaces = new Spaces({ dataDir: DATA, config: CONFIG, run: cua.run });
	const mine = await spaces.open("a");
	const release = cua.hold();
	const opening = spaces.open("b");
	// The create is under way (the call was made synchronously); pretend cua already lists its sandbox.
	const pendingName = [...cua.calls].reverse().find((c) => c[1] === "create")![4]!;
	cua.boxes.add(pendingName);
	const removed = await spaces.sweep();
	release();
	await opening;
	assert.deepEqual(removed.sort(), [`nhermes-${TAG}-old-s-1111`, `nhermes-${TAG}-x-s-2222`]);
	assert.ok(cua.boxes.has("my-own-box"));
	assert.ok(cua.boxes.has(`nhermes-${gatewayTag("gateway-b")}-b-s-3333`), "another gateway's space is not ours to delete");
	assert.ok(cua.boxes.has("nhermes-old-s-4444"), "nor is a name without a gateway tag");
	assert.ok(cua.boxes.has(mine.name));
	assert.ok(cua.boxes.has(pendingName), "a space still being created is not a leftover");
	assert.equal(spaces.list("b").length, 1);
});

test("closing the gateway deletes every open space, and refuses new ones", async () => {
	const cua = memoryCua();
	const spaces = new Spaces({ dataDir: DATA, config: CONFIG, run: cua.run });
	await spaces.open("a");
	await spaces.open("b");
	await spaces.shutdown();
	assert.equal(cua.boxes.size, 0);
	await assert.rejects(spaces.open("a"), /shutting down/);
});

test("closing does not wait for a deletion that never finishes", async () => {
	const stuck: CuaRun = async (args) => (args[1] === "rm" ? new Promise(() => {}) : { code: 0, stdout: "{}", stderr: "" });
	const spaces = new Spaces({ dataDir: DATA, config: CONFIG, run: stuck, shutdownTimeoutMs: 20 });
	await spaces.open("a");
	await spaces.shutdown();
});

test("without the cua command, a space says what to do", async () => {
	const { dir, cleanup } = await tempDir();
	try {
		const spaces = new Spaces({ dataDir: DATA, config: { ...CONFIG, cua: join(dir, "no-such-cua") } });
		await assert.rejects(spaces.open("a"), /Spaces need the cua command on the gateway host; see docs\/SPACES\.md/);
		await assert.rejects(spaces.sweep(), /Spaces need the cua command/);
		spaces.start(); // sweeps in the background and swallows the failure
		await spaces.shutdown();
	} finally {
		await cleanup();
	}
});

test("a space through a fake cua runs commands in the real pi-env daemon, once connected and reused", async () => {
	const { dir, cleanup } = await tempDir();
	const sandboxes = join(dir, "sandboxes");
	mkdirSync(sandboxes);
	process.env.FAKE_CUA_DIR = sandboxes;
	const cua = join(here, "fake-cua.mjs");
	const spaces = new Spaces({ dataDir: DATA, config: { ...CONFIG, cua }, daemonBinary: () => localDaemon() });
	try {
		writeFileSync(join(dir, "marker"), "");
		const { id, name } = await spaces.open("main");
		assert.ok(name.startsWith(`nhermes-${TAG}-main-`));
		const env = await spaces.env("main", id);
		assert.equal(await spaces.env("main", id), env, "one environment per space");
		let out = "";
		const r = await env.exec("echo hi", { onOutput: (t: string) => void (out += t) }, BACKGROUND_CONTEXT);
		assert.ok(r.ok, JSON.stringify(r));
		assert.equal(r.value.exitCode, 0);
		assert.equal(out.trim(), "hi");
		await spaces.close("main", id);
		assert.deepEqual(spaces.list(), []);
	} finally {
		delete process.env.FAKE_CUA_DIR;
		await spaces.shutdown();
		await cleanup();
	}
});

test("config: spaces defaults, and the mistakes it refuses", async () => {
	const { dir, cleanup } = await tempDir();
	process.env.NHERMES_TOKEN = TOKEN;
	const path = join(dir, "config.yaml");
	const base = "server:\n  port: 0\ndefaults:\n  model: faux/faux-1\nbots:\n  - name: main\n    default: true\n";
	try {
		writeFileSync(path, base);
		assert.deepEqual(loadConfig(path).spaces, { cua: "cua", image: "linux", perBot: 2, total: 3, idleMinutes: 30 });
		writeFileSync(path, `${base}spaces:\n  cua: /opt/cua/bin/cua\n  image: desktop\n  perBot: 1\n  total: 5\n  idleMinutes: 5\n`);
		assert.deepEqual(loadConfig(path).spaces, { cua: "/opt/cua/bin/cua", image: "desktop", perBot: 1, total: 5, idleMinutes: 5 });
		for (const [bad, msg] of [
			["perBot: 0", /spaces\.perBot/],
			["perBot: 1.5", /spaces\.perBot must be a whole number/],
			["total: many", /spaces\.total/],
			["idleMinutes: -3", /spaces\.idleMinutes/],
			["cua: 7", /spaces\.cua/],
		] as const) {
			writeFileSync(path, `${base}spaces:\n  ${bad}\n`);
			assert.throws(() => loadConfig(path), (e) => e instanceof ConfigError && msg.test(e.message), bad);
		}
	} finally {
		await cleanup();
	}
});

test("the core opens spaces through its config and deletes the open ones when it closes", async () => {
	const { dir, cleanup } = await tempDir();
	const sandboxes = join(dir, "sandboxes");
	mkdirSync(sandboxes);
	process.env.FAKE_CUA_DIR = sandboxes;
	setLogSink(() => {});
	setLogLevel("error");
	const config = testConfig(dir, undefined, { spaces: { ...CONFIG, cua: join(here, "fake-cua.mjs") } });
	const core = await createCore(config, { models: fauxModels().models });
	try {
		await core.spaces.open("main");
		assert.equal(readdirSync(sandboxes).filter((n) => n.includes("-main-")).length, 1);
		await core.close();
		assert.deepEqual(readdirSync(sandboxes).filter((n) => n.includes("-main-")), []);
	} finally {
		delete process.env.FAKE_CUA_DIR;
		await cleanup();
	}
});
