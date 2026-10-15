// Secrets: managed in secrets.env without ever returning a value; changes keep the file's comments and
// mode, apply at once (environment, log redaction, bot shells) and say when a restart is needed.
import assert from "node:assert/strict";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { adminRoutes } from "../../src/admin.ts";
import { createCore } from "../../src/app.ts";
import { loadConfig, scrubbedShellEnv } from "../../src/config.ts";
import { startHermesServer } from "../../src/hermes/server.ts";
import { redact } from "../../src/log.ts";
import { fauxModels, TOKEN, tempDir } from "../helpers.ts";

test("set, replace and remove keys; nothing ever hands a value back", async () => {
	const { dir, cleanup } = await tempDir();
	delete process.env.NHERMES_TOKEN;
	const secretsPath = join(dir, "secrets.env");
	writeFileSync(secretsPath, `# Gateway token, paste into Vory\nNHERMES_TOKEN=${TOKEN}\n# PUSHOVER_USER_KEY=\n`, { mode: 0o600 });
	writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: { neuralwatt: { baseUrl: "https://x", apiKey: "$NEURALWATT_API_KEY" } } }));
	writeFileSync(join(dir, "config.yaml"), `server: { host: 127.0.0.1, port: 0 }\npi: { modelsPath: ./models.json }\ndefaults: { model: faux/faux-1 }\nbots:\n  - name: main\n    secrets: [WEATHER_KEY]\n`);
	process.env.FROM_SERVICE_KEY = "set-by-systemd-0123456789";
	const core = await createCore(loadConfig(join(dir, "config.yaml")), { models: fauxModels().models });
	const server = await startHermesServer(core, { host: "127.0.0.1", port: 0, extraRouters: [adminRoutes(core)] });
	const call = (method: string, path: string, body?: unknown) =>
		fetch(`http://127.0.0.1:${server.port}${path}`, { method, headers: { "X-Hermes-Session-Token": TOKEN, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
	try {
		const byName = () => new Map(core.secrets.list().map((s) => [s.name, s]));
		const before = byName();
		assert.equal(before.get("NHERMES_TOKEN")?.source, "file");
		assert.equal(before.get("OPENROUTER_API_KEY")?.set, false);
		assert.deepEqual(before.get("NEURALWATT_API_KEY")?.usedBy, ["models: neuralwatt"]);
		assert.deepEqual(before.get("WEATHER_KEY")?.usedBy, ["bot main"]);

		// Set through the admin API: in the file (comments kept, 0600), in effect now, redacted, out of shells.
		const key = "sk-or-v1-abcdefghijklmnop0123456789";
		const r = await call("PUT", "/admin/secrets/OPENROUTER_API_KEY", { value: key });
		assert.equal(r.status, 200);
		assert.deepEqual(await r.json(), { restartNeeded: false });
		const text = readFileSync(secretsPath, "utf8");
		assert.match(text, /# Gateway token, paste into Vory\n/);
		assert.match(text, /^OPENROUTER_API_KEY=sk-or-v1-abcdefghijklmnop0123456789$/m);
		assert.equal(statSync(secretsPath).mode & 0o777, 0o600);
		assert.equal(process.env.OPENROUTER_API_KEY, key);
		assert.equal(redact(`key ${key}`), "key [redacted]");
		assert.ok("OPENROUTER_API_KEY" in scrubbedShellEnv());
		assert.equal(byName().get("OPENROUTER_API_KEY")?.source, "file");
		assert.ok(byName().get("OPENROUTER_API_KEY")!.updatedAt! > 0);

		// No response carries a value.
		const listed = await (await call("GET", "/admin/secrets")).text();
		assert.equal(listed.includes(key) || listed.includes(TOKEN), false);
		assert.equal(core.secrets.hint("OPENROUTER_API_KEY"), "…6789");

		// Replace, a value with spaces round-trips, restart-only names say so, bad input is refused.
		core.secrets.set("OPENROUTER_API_KEY", "sk-or-v1-replacement-0000000000");
		assert.equal((readFileSync(secretsPath, "utf8").match(/OPENROUTER_API_KEY=/g) ?? []).length, 1);
		core.secrets.set("WEATHER_KEY", "two words # and a hash");
		assert.equal(loadConfig(join(dir, "config.yaml")) && process.env.WEATHER_KEY, "two words # and a hash");
		assert.deepEqual(core.secrets.set("PUSHOVER_USER_KEY", "u123456789abcdef"), { restartNeeded: true });
		assert.equal((await call("PUT", "/admin/secrets/bad-name", { value: "x" })).status, 400);
		assert.equal((await call("PUT", "/admin/secrets/X_KEY", { value: "line1\nline2" })).status, 400);
		assert.equal((await call("PUT", "/admin/secrets/FROM_SERVICE_KEY", { value: "other-value-0123456789" })).status, 409, "set by the environment");

		// Remove; the token cannot be removed, only replaced (shown once).
		assert.equal((await call("DELETE", "/admin/secrets/OPENROUTER_API_KEY")).status, 200);
		assert.equal(process.env.OPENROUTER_API_KEY, undefined);
		assert.doesNotMatch(readFileSync(secretsPath, "utf8"), /OPENROUTER_API_KEY/);
		assert.equal((await call("DELETE", "/admin/secrets/NHERMES_TOKEN")).status, 400);
		const fresh = (await (await call("POST", "/admin/secrets/token/new")).json()) as { name: string; value: string };
		assert.equal(fresh.name, "NHERMES_TOKEN");
		assert.ok(fresh.value.length >= 24 && fresh.value !== TOKEN);
		assert.match(readFileSync(secretsPath, "utf8"), new RegExp(`^NHERMES_TOKEN=${fresh.value}$`, "m"));

		// Vory's env screen lists the same names, redacted.
		const env = (await (await call("GET", "/api/env")).json()) as Record<string, { is_set: boolean; redacted_value: string | null; provider: string | null }>;
		assert.equal(env.NEURALWATT_API_KEY?.provider, "neuralwatt");
		assert.equal(env.WEATHER_KEY?.is_set, true);
		assert.match(env.WEATHER_KEY!.redacted_value!, /^«redacted:…hash»$/);
	} finally {
		await server.close();
		await core.close();
		delete process.env.FROM_SERVICE_KEY;
		await cleanup();
	}
});
