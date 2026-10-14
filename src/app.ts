// Composition root: builds the core services around one Engine. `nhermes serve` and the tests use it.
import { join } from "node:path";
import type { Models } from "@earendil-works/pi-ai";
import { defineExtension, type Extension, type ToolRegistration } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { type AgentDeps, guardExtension, personaExtension, type PromptPart } from "./agent/extensions.ts";
import type { Config } from "./config.ts";
import { Approvals } from "./core/approvals.ts";
import { type Bot, Bots } from "./core/bots.ts";
import { Hub } from "./core/events.ts";
import { Scheduler } from "./core/scheduler.ts";
import { Sessions } from "./core/sessions.ts";
import { type AgentChange, Engine } from "./engine/engine.ts";
import { logger } from "./log.ts";
import { HostEnvs, hostsExtension } from "./remote/hosts.ts";
import { AppDb } from "./store/db.ts";
import { MemoryStore } from "./memory/memory.ts";
import { type Notifier, NullNotifier, PushoverNotifier } from "./notify/notifier.ts";
import { Skills } from "./skills/skills.ts";
import { delegateExtension } from "./tools/delegate.ts";
import { memoryFeature } from "./tools/memory.ts";
import { scheduleFeature } from "./tools/schedule.ts";
import { skillsFeature } from "./tools/skills.ts";
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
	hosts: HostEnvs;
	memory: MemoryStore;
	skills: Skills;
	scheduler: Scheduler;
	notifier: Notifier;
	agentFor(bot: Bot): AgentChange;
	close(): Promise<void>;
};

/** A feature module: tool groups, Durable extensions and prompt parts it contributes. */
export type Feature = {
	groups?: ToolGroups;
	extensions?: Extension[];
	promptParts?: PromptPart[];
};

export type CoreOptions = {
	/** Model access; defaults to Pi's ModelRuntime over config.pi.authPath/modelsPath. */
	models?: Models;
	/** Durable DB path override (":memory:" for tests). */
	durablePath?: string;
	appDbPath?: string;
	/** Replaces SSH for remote hosts (tests connect to a local pi-env daemon). */
	connectHost?: ConstructorParameters<typeof HostEnvs>[1];
	/** Feature modules built once the late-bound services exist. */
	features?: (late: LateServices) => Feature[];
	/** Notification transport override (tests). */
	notifier?: Notifier;
};

/** Services features may reach at call time (they are created after the engine opens). */
export type LateServices = { sessions: () => Sessions; bots: () => Bots; agentFor: (bot: Bot) => AgentChange; config: Config; db: AppDb; hub: Hub };

export async function loadModels(config: Config): Promise<Models> {
	const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
	return (await ModelRuntime.create({ authPath: config.pi.authPath, modelsPath: config.pi.modelsPath })) as unknown as Models;
}

/** The root session a run belongs to: where its owner is attending (delegations route approvals there). */
function rootSession(sessions: Sessions, id: string): string {
	let row = sessions.get(id);
	for (let i = 0; row?.parent_id && i < 20; i++) {
		const parent = sessions.get(row.parent_id);
		if (!parent) break;
		row = parent;
	}
	return row?.id ?? id;
}

export async function createCore(config: Config, options: CoreOptions = {}): Promise<Core> {
	const db = new AppDb(options.appDbPath ?? join(config.dataDir, "app.sqlite"));
	const hub = new Hub();
	const bots = new Bots(config, db);
	const approvals = new Approvals(hub, db, config.defaults.approvalTimeoutS * 1000);
	const models = options.models ?? (await loadModels(config));
	const hosts = new HostEnvs(config.dataDir, options.connectHost);

	let sessions: Sessions | undefined;
	const toolGroups = coreToolGroups();
	const agentFor = (bot: Bot): AgentChange => ({
		model: bot.model,
		thinkingLevel: bot.thinking as AgentChange["thinkingLevel"],
		cwd: HostEnvs.isRemote(bot) ? undefined : bot.workspace,
		tools: toolsFor(toolGroups, bot.toolGroups),
	});
	const late: LateServices = { sessions: () => sessions!, bots: () => bots, agentFor, config, db, hub };

	const delegation = delegateExtension({ sessions: late.sessions, bots: late.bots, agentFor, maxDepth: 2 });
	toolGroups.set("delegate", delegation.tools);
	const memory = new MemoryStore(db);
	const skills = new Skills(config.skillsDir, db);
	const notifier: Notifier = options.notifier ?? (config.pushover ? new PushoverNotifier(config.pushover) : new NullNotifier());
	let scheduler: Scheduler | undefined;
	const features = [
		memoryFeature(late, memory),
		skillsFeature(late, skills),
		scheduleFeature(late, () => scheduler!, () => notifier),
		...(options.features?.(late) ?? []),
	];
	for (const f of features) for (const [k, v] of f.groups ?? []) toolGroups.set(k, v);

	const promptParts: PromptPart[] = [
		(bot) => {
			if (!bot.toolGroups.includes("delegate")) return undefined;
			const others = bots.list().filter((b) => b.name !== bot.name);
			if (others.length === 0) return undefined;
			return `Other bots you can ask with the delegate tool:\n${others.map((b) => `- ${b.name}: ${b.description || b.displayName}`).join("\n")}`;
		},
		...features.flatMap((f) => f.promptParts ?? []),
	];
	const deps: AgentDeps = {
		sessions: late.sessions,
		approvals: () => approvals,
		timezone: config.timezone,
		promptParts,
		attentionSession: (id) => rootSession(sessions!, id),
		unattendedPolicy: (sessionId) => scheduler?.approvalsFor(sessionId) ?? "ask",
	};
	const allTools: ToolRegistration[] = [...new Map([...toolGroups.values()].flat().map((t) => [t.name, t])).values()];
	const extensions: Extension[] = [
		personaExtension(deps),
		defineExtension({ name: "tools", tools: allTools }),
		delegation.extension,
		hostsExtension((convId) => sessions?.botOf(convId)),
		...features.flatMap((f) => f.extensions ?? []),
		guardExtension(deps),
	];
	const engine = await Engine.open(
		{
			dbPath: options.durablePath ?? join(config.dataDir, "durable.sqlite"),
			models,
			env: async (convId, cwd) => {
				const bot = sessions?.botOf(convId);
				if (bot && HostEnvs.isRemote(bot)) return hosts.env(bot);
				return new NodeExecutionEnv({ cwd: cwd ?? bot?.workspace ?? config.dataDir });
			},
		},
		extensions,
	);
	sessions = new Sessions(engine, db, bots, hub, approvals, agentFor);
	scheduler = new Scheduler({
		db,
		engine,
		sessions,
		bots,
		hub,
		notifier,
		defaultTimezone: config.timezone,
		modelExists: (ref) => {
			const i = ref.indexOf("/");
			return i > 0 && models.getModel(ref.slice(0, i), ref.slice(i + 1)) !== undefined;
		},
	});

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
		hosts,
		memory,
		skills,
		scheduler,
		notifier,
		agentFor,
		close: async () => {
			await scheduler!.stop();
			await engine.close();
			hosts.close();
			db.close();
		},
	};
}
