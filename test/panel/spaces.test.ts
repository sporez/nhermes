// The panel's running spaces: listed on the Status payload with bot, age and idle time, and deleted by the owner
// without the bot's name. A fake cua keeps the sandboxes in memory.
import assert from "node:assert/strict";
import { test } from "node:test";
import { adminRoutes } from "../../src/admin.ts";
import { startServer } from "../../src/server.ts";
import type { CuaRun } from "../../src/spaces/cua.ts";
import { fauxModels, tempDir, testConfig, testCore } from "../helpers.ts";

test("the owner sees running spaces and deletes one; a space already gone is a 404", async () => {
	const { dir, cleanup } = await tempDir();
	const boxes = new Set<string>();
	const run: CuaRun = async (args) => {
		if (args[1] === "create") boxes.add(args[args.indexOf("--name") + 1]!);
		if (args[1] === "rm") boxes.delete(args.at(-1)!);
		return { code: 0, stdout: "{}", stderr: "" };
	};
	let now = 1_000_000;
	const core = await testCore(dir, { config: testConfig(dir), models: fauxModels().models, spaces: { run, now: () => now } });
	const server = await startServer(core, { host: "127.0.0.1", port: 0, extraRouters: [adminRoutes(core)] });
	const call = (method: string, path: string) =>
		fetch(`http://127.0.0.1:${server.port}/panel/api${path}`, { method, headers: method === "GET" ? {} : { "content-type": "application/json", "x-nhermes-panel": "1" }, body: method === "GET" ? undefined : "{}" });
	try {
		const a = await core.spaces.open("main");
		now += 120_000;
		core.spaces.touch(a.id);
		now += 60_000;
		const status = (await (await call("GET", "/status")).json()) as { spaces: { id: string; bot: string; createdAt: number; lastUsed: number; idleMinutes: number }[] };
		assert.deepEqual(status.spaces, [{ id: a.id, bot: "main", createdAt: 1000, lastUsed: 1120, idleMinutes: 30 }]);
		assert.equal((await call("DELETE", `/spaces/${a.id}`)).status, 200);
		assert.equal(boxes.size, 0);
		assert.deepEqual(core.spaces.list(), []);
		assert.equal((await call("DELETE", `/spaces/${a.id}`)).status, 404);
		assert.equal((await call("DELETE", "/spaces/s-0000")).status, 404);
	} finally {
		await server.close();
		await core.close();
		await cleanup();
	}
});
