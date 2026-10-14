// Composition root: builds the core services around one Engine. `nhermes serve` and the tests use it.
import { join } from "node:path";
import type { Models } from "@earendil-works/pi-ai";
import { defineExtension, type Extension, type ToolRegistration } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { type AgentDeps, guardExtension, personaExtension } from "./agent/extensions.ts";
import type { Config } from "./config.ts";
import { Approvals } from "./core/approvals.ts";
import { type Bot, Bots } from "./core/bots.ts";
import { Hub } from "./core/events.ts";
import { Sessions } from "./core/sessions.ts";
import { type AgentChange, Engine } from "./engine/engine.ts";
import { logger } from "./log.ts";
import { AppDb } from "./store/db.ts";
import { coreToolGroups, type ToolGroups, toolsFor } from "./tools/index.ts";

const log = logger("app");

export type Core = {
	config: Config;
	db: AppDb;
	engine: Engine;
	bots: Bots;
	sessions: Sessions;
	hub: Hub;
	approvals: Approvals;
	models: Models;
	toolGroups: ToolGroups;
	deps: AgentDeps;
	close(): Promise<void>;
};

export type CoreOptions = {
	/** Model access; defaults to Pi's ModelRuntime over config.pi.authPath/modelsPath. */
	models?: Models;
	/** Durable DB path override (":memory:" for tests). */
	durablePath?: string;
	appDbPath?: string;
	/** Extra tool groups and extensions contributed by features. */
	extraGroups?: ToolGroups;
	extraExtensions?: Extension[];
};

export async function loadModels(config: Config): Promise<Models> {
	const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
	return (await ModelRuntime.create({ authPath: config.pi.authPath, modelsPath: config.pi.modelsPath })) as unknown as Models;
}

export async function createCore(config: Config, options: CoreOptions = {}): Promise<Core> {
	const db = new AppDb(options.appDbPath ?? join(config.dataDir, "app.sqlite"));
	const hub = new Hub();
	const bots = new Bots(config, db);
	const approvals = new Approvals(hub, db, config.defaults.approvalTimeoutS * 1000);
	const models = options.models ?? (await loadModels(config));

	const toolGroups = coreToolGroups();
	for (const [k, v] of options.extraGroups ?? []) toolGroups.set(k, v);
	const allTools: ToolRegistration[] = [...new Map([...toolGroups.values()].flat().map((t) => [t.name, t])).values()];

	let sessions: Sessions | undefined;
	const deps: AgentDeps = {
		sessions: () => sessions!,
		approvals: () => approvals,
		timezone: config.timezone,
		promptParts: [],
		unattendedPolicy: () => "ask",
	};
	const extensions: Extension[] = [
		personaExtension(deps),
		defineExtension({ name: "tools", tools: allTools }),
		...(options.extraExtensions ?? []),
		guardExtension(deps),
	];
	const engine = await Engine.open(
		{
			dbPath: options.durablePath ?? join(config.dataDir, "durable.sqlite"),
			models,
			env: (convId, cwd) => {
				const bot = sessions?.botOf(convId);
				return new NodeExecutionEnv({ cwd: cwd ?? bot?.workspace ?? config.dataDir });
			},
		},
		extensions,
	);
	const agentFor = (bot: Bot): AgentChange => ({
		model: bot.model,
		thinkingLevel: bot.thinking as AgentChange["thinkingLevel"],
		cwd: bot.workspace,
		tools: toolsFor(toolGroups, bot.toolGroups),
	});
	sessions = new Sessions(engine, db, bots, hub, approvals, agentFor);

	engine.resume();
	const reattached = await sessions.attachBusy();
	if (reattached > 0) log.info("re-attached interrupted runs", { count: reattached });

	return {
		config,
		db,
		engine,
		bots,
		sessions,
		hub,
		approvals,
		models,
		toolGroups,
		deps,
		close: async () => {
			await engine.close();
			db.close();
		},
	};
}
