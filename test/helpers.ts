// Shared test setup: a Config built in code, a faux model provider, and a temp data dir.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, type FauxProviderHandle, fauxProvider, type Models } from "@earendil-works/pi-ai";
import { type CoreOptions, createCore } from "../src/app.ts";
import type { BotConfig, Config } from "../src/config.ts";
import type { SessionEvent } from "../src/core/events.ts";
import { setLogLevel } from "../src/log.ts";

setLogLevel((process.env.NHERMES_LOG_LEVEL as "debug" | undefined) ?? "error");

export const TOKEN = "test-token-0123456789abcdef";

export async function tempDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
	const dir = await mkdtemp(join(tmpdir(), "nh-test-"));
	// Retries: Pi's model store can drop a lock file into the directory while it is being removed.
	return { dir, cleanup: () => rm(dir, { recursive: true, force: true, maxRetries: 5 }) };
}

export function testConfig(dir: string, bots?: BotConfig[], extra: Partial<Config> = {}): Config {
	return {
		configPath: join(dir, "config.yaml"),
		configDir: dir,
		dataDir: join(dir, "data"),
		server: { host: "127.0.0.1", port: 0, publicName: "Test" },
		token: TOKEN,
		tokenEnv: "NHERMES_TOKEN",
		secretsPath: join(dir, "secrets.env"),
		modelLists: { hide: ["openrouter"] },
		review: { enabled: true, keyEnv: "TEST_JEV_KEY", allowThreshold: 0.8, timeoutMs: 3000 },
		pi: { authPath: join(dir, "auth.json"), modelsPath: join(dir, "models.json") },
		defaults: { model: "faux/faux-1", thinking: "medium", approvals: "smart", approvalTimeoutS: 30 },
		skillsDir: join(dir, "skills"),
		timezone: "America/New_York",
		node: {},
		panel: { enabled: true },
		bots: bots ?? [
			{ name: "main", displayName: "Main", default: true, instructions: "You are the main test bot." },
			{ name: "ops", displayName: "Ops", instructions: "You are the ops test bot.", trusted: true },
		],
		...extra,
	};
}

export function fauxModels(): { models: Models; faux: FauxProviderHandle } {
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1", reasoning: true }, { id: "faux-2" }] });
	const models = createModels();
	models.setProvider(faux.provider);
	return { models, faux };
}

export async function testCore(dir: string, opts: CoreOptions & { config?: Config } = {}) {
	const config = opts.config ?? testConfig(dir);
	return createCore(config, opts);
}

/** Collects hub events for one session; `until` resolves when a predicate matches. */
export function collect(hub: { subscribe(id: string, l: (sid: string, e: SessionEvent) => void): () => void }, sessionId: string) {
	const events: SessionEvent[] = [];
	const waiters: { pred: (e: SessionEvent) => boolean; resolve: (e: SessionEvent) => void }[] = [];
	const off = hub.subscribe(sessionId, (_sid, e) => {
		events.push(e);
		for (const w of [...waiters]) {
			if (w.pred(e)) {
				waiters.splice(waiters.indexOf(w), 1);
				w.resolve(e);
			}
		}
	});
	return {
		events,
		off,
		until(pred: (e: SessionEvent) => boolean, timeoutMs = 5000): Promise<SessionEvent> {
			const hit = events.find(pred);
			if (hit) return Promise.resolve(hit);
			return new Promise((resolve, reject) => {
				const t = setTimeout(() => reject(new Error(`timed out waiting; saw ${events.map((x) => x.type).join(",")}`)), timeoutMs);
				waiters.push({ pred, resolve: (e) => (clearTimeout(t), resolve(e)) });
			});
		},
	};
}
