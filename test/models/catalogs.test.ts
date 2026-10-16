// Provider catalogs: setting a provider's key is enough for its models to appear, the list is kept for
// offline starts, removing the key withdraws them, and a models.json entry for the provider wins.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createCore } from "../../src/app.ts";
import { ProviderCatalogs } from "../../src/models/catalogs.ts";
import { neuralwatt, neuralwattModels } from "../../src/models/neuralwatt.ts";
import { AppDb } from "../../src/store/db.ts";
import { tempDir, testConfig } from "../helpers.ts";

const KEY = "NEURALWATT_API_KEY";

function nwList(ids: string[]) {
	return {
		data: ids.map((id) => ({
			id,
			metadata: {
				display_name: id.toUpperCase(),
				capabilities: { tools: true, reasoning: true, reasoning_effort: true },
				reasoning: { accepted_efforts: ["low", "high"] },
				limits: { max_context_length: 200_000, max_output_tokens: 100_000 },
				pricing: { input_per_million: 1, output_per_million: 2 },
			},
		})),
	};
}

/** A Neuralwatt stand-in: answers with `ids()`, or fails when it returns undefined. */
function fakeFetch(ids: () => string[] | undefined) {
	const calls: string[] = [];
	const fn = (async (url: string | URL | Request, init?: RequestInit) => {
		calls.push(String(url));
		assert.equal((init?.headers as Record<string, string>).Authorization, `Bearer ${process.env[KEY]}`);
		const list = ids();
		return list ? new Response(JSON.stringify(nwList(list))) : new Response("down", { status: 503 });
	}) as typeof fetch;
	return { fn, calls };
}

async function runtime(dir: string) {
	return ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: join(dir, "models.json"), refreshOnCreate: false });
}

test("the mapping keeps tool-capable models with their limits, prices and reasoning levels", () => {
	const models = neuralwattModels([
		...nwList(["a-fast"]).data,
		{ id: "no-tools", metadata: { capabilities: { tools: false } } },
		{ id: "bare" },
	]);
	assert.deepEqual(models.map((m) => m.id), ["a-fast", "bare"]);
	const a = models[0]!;
	assert.equal(a.name, "A-FAST (fast)");
	assert.equal("maxTokens" in a && a.maxTokens, 65536);
	assert.equal("contextWindow" in a && a.contextWindow, 200_000);
	assert.deepEqual("thinkingLevelMap" in a && a.thinkingLevelMap, { off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: null });
	assert.deepEqual(a.cost, { input: 1, output: 2, cacheRead: 1, cacheWrite: 0 });
	assert.equal(models[1]!.name, "bare");
});

test("a set key brings the models in, a stored list survives a dead network, a removed key withdraws them", async () => {
	const { dir, cleanup } = await tempDir();
	const db = new AppDb(join(dir, "app.sqlite"));
	process.env[KEY] = "nw-key-0123456789";
	let ids: string[] | undefined = ["m1", "m2"];
	const net = fakeFetch(() => ids);
	try {
		const models = await runtime(dir);
		const cat = new ProviderCatalogs({ models, db, modelsPath: join(dir, "models.json"), catalogs: [neuralwatt], fetch: net.fn });
		await cat.start();
		cat.stop();
		assert.deepEqual(net.calls, ["https://api.neuralwatt.com/v1/models"]);
		assert.ok(models.getModel("neuralwatt", "m1"));
		assert.deepEqual((await models.getAvailable("neuralwatt")).map((m) => m.id), ["m1", "m2"]);
		assert.equal((await models.getAuth("neuralwatt"))?.auth.apiKey, "nw-key-0123456789");
		assert.deepEqual(cat.status()[0], { id: "neuralwatt", name: "Neuralwatt", keyEnv: KEY, active: true, models: 2, fetchedAt: cat.status()[0]!.fetchedAt, error: null, managedBy: "catalog" });

		// A later start with the network down: the stored list is registered before anything is fetched.
		ids = undefined;
		const models2 = await runtime(dir);
		const cat2 = new ProviderCatalogs({ models: models2, db, modelsPath: join(dir, "models.json"), catalogs: [neuralwatt], fetch: net.fn });
		await cat2.start();
		assert.ok(models2.getModel("neuralwatt", "m2"));
		await cat2.refresh();
		assert.match(cat2.status()[0]!.error ?? "", /503/);
		assert.ok(models2.getModel("neuralwatt", "m2"), "a failed refresh keeps the list");

		// New models upstream replace the list.
		ids = ["m3"];
		await cat2.refresh();
		assert.deepEqual(models2.getModels("neuralwatt").map((m) => m.id), ["m3"]);
		assert.equal(cat2.status()[0]!.error, null);

		delete process.env[KEY];
		cat2.keyChanged(KEY);
		cat2.stop();
		assert.equal(models2.getModel("neuralwatt", "m3"), undefined);
		assert.equal(cat2.status()[0]!.active, false);
	} finally {
		delete process.env[KEY];
		db.close();
		await cleanup();
	}
});

test("a provider models.json defines is left to models.json", async () => {
	const { dir, cleanup } = await tempDir();
	const db = new AppDb(join(dir, "app.sqlite"));
	process.env[KEY] = "nw-key-0123456789";
	const net = fakeFetch(() => ["m1"]);
	writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: { neuralwatt: { baseUrl: "https://x/v1", api: "openai-completions", apiKey: `$${KEY}`, models: [{ id: "pinned", name: "Pinned", reasoning: false, input: ["text"], contextWindow: 1000, maxTokens: 100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
	try {
		const models = await runtime(dir);
		const cat = new ProviderCatalogs({ models, db, modelsPath: join(dir, "models.json"), catalogs: [neuralwatt], fetch: net.fn });
		await cat.start();
		await cat.refresh();
		cat.stop();
		assert.deepEqual(net.calls, []);
		assert.deepEqual(models.getModels("neuralwatt").map((m) => m.id), ["pinned"]);
		assert.equal(cat.status()[0]!.managedBy, "models.json");
	} finally {
		delete process.env[KEY];
		db.close();
		await cleanup();
	}
});

test("setting the key through the gateway fetches the list at once and lists the key in Keys", async () => {
	const { dir, cleanup } = await tempDir();
	delete process.env[KEY];
	const net = fakeFetch(() => ["m1"]);
	const core = await createCore(testConfig(dir), { catalogFetch: net.fn });
	try {
		const listed = core.secrets.list().find((s) => s.name === KEY);
		assert.equal(listed?.set, false);
		assert.deepEqual(listed?.usedBy, ["models: neuralwatt"]);
		assert.equal(core.models.getModel("neuralwatt", "m1"), undefined);

		core.secrets.set(KEY, "nw-key-0123456789");
		for (let i = 0; i < 50 && !core.models.getModel("neuralwatt", "m1"); i++) await new Promise((r) => setTimeout(r, 20));
		assert.ok(core.models.getModel("neuralwatt", "m1"));

		core.secrets.remove(KEY);
		assert.equal(core.models.getModel("neuralwatt", "m1"), undefined);
	} finally {
		delete process.env[KEY];
		await core.close();
		await cleanup();
	}
});
