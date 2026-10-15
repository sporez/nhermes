// Composition root: builds the core services around one Engine. `nhermes serve` and the tests use it.
import { join } from "node:path";
import type { Models } from "@earendil-works/pi-ai";
import { defineExtension, type Extension, type ToolRegistration } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { type AgentDeps, groundRules, guardExtension, personaExtension, type PromptPart } from "./agent/extensions.ts";
import { type Config, scrubbedShellEnv } from "./config.ts";
import { Approvals } from "./core/approvals.ts";
import { type Bot, Bots } from "./core/bots.ts";
import { Hub } from "./core/events.ts";
import { Scheduler } from "./core/scheduler.ts";
import { Sessions } from "./core/sessions.ts";
import { Secrets } from "./core/secrets.ts";
import { Settings } from "./core/settings.ts";
import { Members, type MembersOptions } from "./federation/members.ts";
import { ProxySessions } from "./federation/proxy.ts";
import { Roster } from "./federation/roster.ts";
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
import { webFeature } from "./tools/web.ts";
import { Browsers } from "./computer/browser.ts";
import { browserFeature } from "./tools/browser.ts";
import { desktopFeature } from "./tools/desktop.ts";
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
	browsers: Browsers;
	settings: Settings;
	members: Members;
	roster: Roster;
	proxy: ProxySessions;
	secrets: Secrets;
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
	browserHeadless?: boolean;
	browserExecutable?: string;
	/** Membership clock/transport overrides (tests). */
	members?: MembersOptions;
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
	const members = new Members(db, config, options.members);
	const roster = new Roster(db, members);
	bots.setRemote(() => roster.list());
	members.onChange(() => void roster.sync());
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

	const delegation = delegateExtension({
		sessions: late.sessions,
		bots: late.bots,
		agentFor,
		maxDepth: 2,
		approvals: () => approvals,
		attentionSession: (id) => rootSession(sessions!, id),
		members: () => members,
	});
	toolGroups.set("delegate", delegation.tools);
	const memory = new MemoryStore(db);
	const skills = new Skills(config.skillsDir, db);
	const browsers = new Browsers(config.dataDir, { headless: options.browserHeadless ?? true, executablePath: options.browserExecutable ?? config.browserExecutable });
	const notifier: Notifier = options.notifier ?? (config.pushover ? new PushoverNotifier(config.pushover) : new NullNotifier());
	let scheduler: Scheduler | undefined;
	const features = [
		memoryFeature(late, memory),
		skillsFeature(late, skills),
		scheduleFeature(late, () => scheduler!, () => notifier),
		webFeature(late),
		browserFeature(late, () => browsers),
		desktopFeature(late),
		...(options.features?.(late) ?? []),
	];
	for (const f of features) for (const [k, v] of f.groups ?? []) toolGroups.set(k, v);

	const promptParts: PromptPart[] = [
		(bot) => {
			if (!bot.toolGroups.includes("delegate")) return undefined;
			const others = bots.list().filter((b) => b.name !== bot.name && !b.private);
			if (others.length === 0) return undefined;
			const line = (b: Bot) => {
				// A member's description is text from another machine: shown quoted, as data.
				if (b.remote) return `- ${b.name}: ${JSON.stringify(b.description || b.displayName)} (on the machine "${b.remote.node}"${b.remote.reachable ? "" : ", offline right now"})`;
				return `- ${b.name}: ${b.description || b.displayName}${b.isPeer ? " (an independent agent on another machine)" : ""}`;
			};
			return (
				`Other bots you can ask with the delegate tool:\n${others.map(line).join("\n")}\n` +
				"When the user addresses one of them with @name, they want that bot to do it: delegate the task to it. " +
				"Use wait: false for anything that may take more than a minute or two; its answer comes back as a new message."
			);
		},
		...features.flatMap((f) => f.promptParts ?? []),
	];
	const deps: AgentDeps = {
		sessions: late.sessions,
		approvals: () => approvals,
		timezone: config.timezone,
		promptParts,
		attentionSession: (id) => rootSession(sessions!, id),
		delegationChain: (id) => {
			const out: Bot[] = [];
			let row = sessions!.get(id);
			for (let i = 0; row?.parent_id && i < 20; i++) {
				row = sessions!.get(row.parent_id);
				const b = row ? bots.get(row.bot) : undefined;
				if (b) out.push(b);
			}
			return out;
		},
		unattendedPolicy: (sessionId) => scheduler?.approvalsFor(sessionId) ?? "ask",
		groundRules: () => config.groundRules ?? groundRules([...new Set([config.configDir, config.dataDir])]),
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
				return new NodeExecutionEnv({ cwd: cwd ?? bot?.workspace ?? config.dataDir, shellEnv: scrubbedShellEnv() as NodeJS.ProcessEnv });
			},
		},
		extensions,
	);
	sessions = new Sessions(engine, db, bots, hub, approvals, agentFor);
	const proxy = new ProxySessions({ sessions: late.sessions, bots, members, approvals, hub });
	sessions.setRemoteHooks({ running: (id) => proxy.isRunning(id), deleted: (row) => proxy.deleted(row) });
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

	const settings = new Settings({ config, bots, toolGroups: () => [...toolGroups.keys()], botChanged: (name) => hosts.reset(name) });

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
		browsers,
		settings,
		members,
		roster,
		proxy,
		secrets: new Secrets(config, db),
		agentFor,
		close: async () => {
			members.stop();
			proxy.close();
			await scheduler!.stop();
			await browsers.close();
			await engine.close();
			hosts.close();
			db.close();
		},
	};
}
