// The spaces tool group (src/tools/spaces.ts) and the desktop tools' `space` argument (src/tools/desktop.ts), run
// through the faux model, a fake cua (test/spaces/fake-cua.mjs) and the real local pi-env daemon. The fake space's
// commands run on this machine, so stub xdotool, import and base64 programs stand in for the desktop and log the
// DISPLAY each call used; that is how a call on a space is told from one on the bot's own desktop.
import assert from "node:assert/strict";
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, writeFileSync, ftruncateSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { localDaemon } from "@earendil-works/pi-env";
import { pictureLine } from "../../src/core/cards.ts";
import type { SessionEvent } from "../../src/core/events.ts";
import { decide } from "../../src/core/policy.ts";
import { COPY_MAX_BYTES } from "../../src/tools/spaces.ts";
import { collect, fauxModels, pngBytes, tempDir, testConfig, testCore } from "../helpers.ts";

const here = dirname(fileURLToPath(import.meta.url));
const PNG = pngBytes(12, 9);

async function setup(opts: { spaces?: Partial<{ perBot: number; total: number }>; tools?: Record<string, string[]> } = {}) {
	const t = await tempDir();
	const sandboxes = join(t.dir, "sandboxes");
	const bin = join(t.dir, "bin");
	mkdirSync(sandboxes);
	mkdirSync(bin);
	const log = join(t.dir, "xdotool.log");
	writeFileSync(join(t.dir, "shot.png"), PNG);
	const stub = (name: string, body: string) => {
		writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
		chmodSync(join(bin, name), 0o755);
	};
	stub("xdotool", `echo "$DISPLAY $*" >> '${log}'\n[ "$1" = getdisplaygeometry ] && echo "1280 800"\nexit 0`);
	stub("import", `cat '${join(t.dir, "shot.png")}'`);
	stub("base64", `exec '${process.execPath}' -e 'process.stdout.write(require("fs").readFileSync(0).toString("base64"))'`);
	const saved = { dir: process.env.FAKE_CUA_DIR, path: process.env.PATH };
	process.env.FAKE_CUA_DIR = sandboxes;
	process.env.PATH = `${bin}:${process.env.PATH}`;
	const skew = { ms: 0 };
	const { models, faux } = fauxModels();
	const tools = opts.tools ?? { main: ["spaces", "shell", "files"] };
	const config = testConfig(
		t.dir,
		Object.entries(tools).map(([name, groups], i) => ({ name, default: i === 0, instructions: "test", tools: groups })),
		{ spaces: { cua: join(here, "../spaces/fake-cua.mjs"), image: "linux", perBot: opts.spaces?.perBot ?? 2, total: opts.spaces?.total ?? 3, idleMinutes: 30 } },
	);
	const core = await testCore(t.dir, { models, config, spaces: { daemonBinary: () => localDaemon(), now: () => Date.now() + skew.ms } });
	return {
		core,
		faux,
		skew,
		dir: t.dir,
		sandboxes,
		log: () => {
			try {
				return readFileSync(log, "utf8");
			} catch {
				return "";
			}
		},
		workspace: (bot = "main") => {
			const w = core.bots.require(bot).workspace!;
			mkdirSync(w, { recursive: true });
			return w;
		},
		cleanup: async () => {
			await core.close();
			if (saved.dir === undefined) delete process.env.FAKE_CUA_DIR;
			else process.env.FAKE_CUA_DIR = saved.dir;
			process.env.PATH = saved.path;
			await t.cleanup();
		},
	};
}
type S = Awaited<ReturnType<typeof setup>>;

const ask = (...calls: ReturnType<typeof fauxToolCall>[]) => fauxAssistantMessage(calls, { stopReason: "toolUse" });
const call = (name: string, args: Parameters<typeof fauxToolCall>[1], id: string) => fauxToolCall(name, args, { id });
const finished = (events: SessionEvent[], id: string) => events.find((e) => e.type === "tool.finished" && e.callId === id) as Extract<SessionEvent, { type: "tool.finished" }>;

async function run(s: S, steps: ReturnType<typeof fauxAssistantMessage>[], opts: { bot?: string; source?: string } = {}) {
	const session = await s.core.sessions.create(opts.bot ?? "main", opts.source ? { source: opts.source } : {});
	const c = collect(s.core.hub, session.id);
	s.faux.setResponses([...steps, fauxAssistantMessage([fauxText("done")])]);
	await s.core.sessions.submit(session.id, "go");
	await c.until((e) => e.type === "run.finished", 20000);
	return { session, events: c.events };
}
const opened = (events: SessionEvent[], id: string) => /Opened space (s-[0-9a-f]{4})/.exec(finished(events, id).resultText)![1]!;

test("space_open returns an id, space_shell runs in that space, space_list shows it and space_close deletes it", async () => {
	const s = await setup();
	try {
		let r = await run(s, [ask(call("space_open", {}, "o"))]);
		const id = opened(r.events, "o");
		assert.match(finished(r.events, "o").resultText, /desktop_\* tools with space: "s-[0-9a-f]{4}".*space_close.*display :1.*30 minutes/s);
		assert.equal(s.core.spaces.list("main").length, 1);
		// The command's parent is the space's own daemon, which the fake cua started from the space's directory.
		r = await run(s, [ask(call("space_shell", { space: id, command: "ps -o command= -p $PPID; echo out; echo err >&2; exit 3" }, "sh"), call("space_list", {}, "ls"))]);
		const out = finished(r.events, "sh");
		assert.match(out.resultText, new RegExp(`nhermes-[0-9a-f]{4}-main-${id}/tmp/pi-env`));
		assert.match(out.resultText, /out\nerr\n\nExit code 3\.$/);
		assert.equal(out.isError, true);
		assert.match(finished(r.events, "ls").resultText, new RegExp(`^${id}: open \\d+ min, unused \\d+ min$`));
		r = await run(s, [ask(call("space_close", { space: id }, "c"), call("space_list", {}, "ls2"))]);
		assert.equal(finished(r.events, "c").resultText, `Closed space ${id}.`);
		assert.equal(s.core.spaces.list().length, 0);
	} finally {
		await s.cleanup();
	}
});

test("the per-bot limit and a foreign or unknown id come back as plain tool errors", async () => {
	const s = await setup({ spaces: { perBot: 1 }, tools: { main: ["spaces"], other: ["spaces"] } });
	try {
		const r = await run(s, [ask(call("space_open", {}, "a")), ask(call("space_open", {}, "b"), call("space_shell", { space: "s-0000", command: "true" }, "x"))]);
		assert.match(finished(r.events, "b").resultText, /already have 1 space open \(the limit is 1 per bot\).*space_close/s);
		assert.equal(finished(r.events, "b").isError, true);
		assert.match(finished(r.events, "x").resultText, /You have no space s-0000\. Your open spaces: s-/);
		const id = opened(r.events, "a");
		const other = await run(s, [ask(call("space_shell", { space: id, command: "true" }, "y"), call("space_close", { space: id }, "z"))], { bot: "other" });
		assert.match(finished(other.events, "y").resultText, /You have no space .*You have no open spaces\./s);
		assert.match(finished(other.events, "z").resultText, /You have no space/);
		assert.equal(s.core.spaces.list().length, 1, "the other bot closed nothing");
	} finally {
		await s.cleanup();
	}
});

test("desktop tools with space act on display :1 in the space; a screenshot there can be shown to the owner", async () => {
	const s = await setup({ tools: { main: ["spaces", "desktop"] } });
	try {
		let r = await run(s, [ask(call("space_open", {}, "o"))]);
		const id = opened(r.events, "o");
		r = await run(s, [
			ask(call("desktop_click", { space: id, x: 10, y: 20 }, "k"), call("desktop_screenshot", { space: id }, "shot")),
			ask(call("desktop_click", { x: 1, y: 2 }, "own")),
		]);
		assert.match(finished(r.events, "k").resultText, /Clicked left at 10,20\./);
		assert.match(s.log(), /^:1 mousemove --sync 10 20 click 1$/m);
		const shot = finished(r.events, "shot").resultText;
		assert.match(shot, /^Desktop 1280x800 on display :1\./);
		assert.ok(shot.endsWith(pictureLine("shot")), "the screenshot offers itself as a picture card");
		assert.match(s.log(), /^:0 mousemove --sync 1 2 click 1$/m, "without space, the bot's own desktop (display :0)");
	} finally {
		await s.cleanup();
	}
});

test("a bot without the desktop group is refused the host's desktop but can drive its spaces", async () => {
	const s = await setup();
	try {
		let r = await run(s, [ask(call("space_open", {}, "o"))]);
		const id = opened(r.events, "o");
		r = await run(s, [ask(call("desktop_click", { x: 1, y: 2 }, "host"), call("desktop_windows", {}, "hostw"), call("desktop_click", { space: id, x: 3, y: 4 }, "ok"))]);
		for (const c of ["host", "hostw"]) {
			assert.match(finished(r.events, c).resultText, /This bot can only use desktops in its spaces: give space: "<id>"/);
			assert.equal(finished(r.events, c).isError, true);
		}
		assert.doesNotMatch(s.log(), /mousemove --sync 1 2/);
		assert.match(finished(r.events, "ok").resultText, /Clicked left at 3,4\./);
	} finally {
		await s.cleanup();
	}
});

test("work a network member started cannot open a space", async () => {
	const s = await setup();
	try {
		const r = await run(s, [ask(call("space_open", {}, "o"))], { source: "member:node-a" });
		assert.match(finished(r.events, "o").resultText, /space_open is not available to work another machine started/);
		assert.equal(s.core.spaces.list().length, 0);
	} finally {
		await s.cleanup();
	}
});

test("space_copy moves a file both ways, makes folders, and refuses a folder or a file over the size limit", async () => {
	const s = await setup();
	try {
		const ws = s.workspace();
		writeFileSync(join(ws, "in.txt"), "hello space");
		let r = await run(s, [ask(call("space_open", {}, "o"))]);
		const id = opened(r.events, "o");
		const inSpace = join(s.dir, "inside", "deep", "copied.txt");
		const back = join(ws, "back.txt");
		const big = join(s.dir, "big.bin");
		const fd = openSync(big, "w");
		ftruncateSync(fd, COPY_MAX_BYTES + 1);
		closeSync(fd);
		r = await run(s, [
			ask(call("space_copy", { space: id, from: "in.txt", to: inSpace, direction: "to_space" }, "up")),
			ask(call("space_copy", { space: id, from: inSpace, to: "back.txt", direction: "from_space" }, "down"), call("space_copy", { space: id, from: s.dir, to: "x", direction: "from_space" }, "dir"), call("space_copy", { space: id, from: big, to: "big.bin", direction: "from_space" }, "big"), call("space_copy", { space: id, from: join(s.dir, "nope"), to: "x", direction: "from_space" }, "none")),
		]);
		assert.match(finished(r.events, "up").resultText, /^Copied to space .*: 11 bytes/);
		assert.equal(readFileSync(inSpace, "utf8"), "hello space");
		assert.match(finished(r.events, "down").resultText, /^Copied from space/);
		assert.equal(readFileSync(back, "utf8"), "hello space");
		assert.match(finished(r.events, "dir").resultText, /is not a file/);
		assert.match(finished(r.events, "big").resultText, /the limit is 100 MB/);
		assert.match(finished(r.events, "none").resultText, /Could not read/);
		assert.equal(finished(r.events, "big").isError, true);
	} finally {
		await s.cleanup();
	}
});

test("a space a call is using is not deleted as idle, however long the call; its clock restarts afterwards", async () => {
	const s = await setup();
	try {
		const { id } = await s.core.spaces.open("main");
		const spaces = s.core.spaces;
		let before = 0;
		await spaces.use("main", id, async () => {
			// Idle for far longer than the limit, but in use.
			s.skew.ms += 3 * 60 * 60_000;
			before = spaces.list("main")[0]!.lastUsed;
			assert.deepEqual(await spaces.deleteIdle(), []);
		});
		assert.equal(spaces.list("main").length, 1);
		assert.ok(spaces.list("main")[0]!.lastUsed > before, "touched when the call ended");
		s.skew.ms += 3 * 60 * 60_000;
		assert.deepEqual(await spaces.deleteIdle(), [id], "unused again, it goes");
	} finally {
		await s.cleanup();
	}
});

test("approvals: the space tools run in smart mode and ask in manual mode; desktop tools follow the desktop policy; copies to sensitive files ask", () => {
	const pc = (mode: "smart" | "manual", extra = {}) => ({ bot: { name: "b", trusted: false, approvals: { mode, ask: [], deny: [], allow: [] } } as never, sessionRules: [], botRules: [], yolo: false, ...extra });
	const call = (name: string, args: Record<string, unknown>) => ({ name, arguments: args });
	for (const name of ["space_open", "space_list", "space_close", "space_shell", "space_copy", "desktop_click"]) {
		const args = name === "space_copy" ? { space: "s-1", from: "a", to: "b", direction: "to_space" } : { space: "s-1", command: "sudo apt-get install -y mousepad" };
		assert.equal(decide(call(name, args), pc("smart")).action, "allow", `${name} in smart mode`);
		assert.equal(decide(call(name, args), pc("manual")).action, "ask", `${name} in manual mode`);
	}
	assert.equal(decide(call("desktop_screenshot", { space: "s-1" }), pc("manual")).action, "allow", "looking is free, as on the own desktop");
	const gatewayFiles = /secrets\.env/;
	assert.equal(decide(call("space_copy", { space: "s-1", from: "x", to: "/home/n/.ssh/authorized_keys", direction: "from_space" }), pc("smart")).action, "ask");
	assert.equal(decide(call("space_copy", { space: "s-1", from: "x", to: "/etc/passwd", direction: "from_space" }), pc("smart")).action, "ask");
	assert.equal(decide(call("space_copy", { space: "s-1", from: "/data/secrets.env", to: "k", direction: "to_space" }), pc("smart", { gatewayFiles })).action, "ask");
	assert.equal(decide(call("space_copy", { space: "s-1", from: "k", to: "/data/secrets.env", direction: "from_space" }), pc("smart", { gatewayFiles })).action, "ask", "writing over it");
	assert.equal(decide(call("space_copy", { space: "s-1", from: "/home/n/.ssh/id_ed25519", to: "k", direction: "to_space" }), pc("smart", { gatewayFiles })).action, "ask", "a key sent into a space, which reaches the internet");
	assert.equal(decide(call("space_copy", { space: "s-1", from: "/etc/passwd", to: "k", direction: "to_space" }), pc("smart", { gatewayFiles })).action, "ask");
	assert.equal(decide(call("space_copy", { space: "s-1", from: "notes/report.pdf", to: "k", direction: "to_space" }), pc("smart", { gatewayFiles })).action, "allow", "an ordinary file");
	assert.equal(decide(call("space_copy", { space: "s-1", from: "/tmp/x", to: "/data/secrets.env", direction: "to_space" }), pc("smart", { gatewayFiles })).action, "allow", "the destination is in the space");
});
