// Composition root: builds the core services around one Engine. `nhermes serve` and the tests use it.
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Models } from "@earendil-works/pi-ai";
import { defineExtension, type Extension, type ToolRegistration } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { type AgentDeps, groundRules, guardExtension, personaExtension, type PromptPart } from "./agent/extensions.ts";
import { type Config, scrubbedShellEnv } from "./config.ts";
import { Approvals } from "./core/approvals.ts";
import { Attachments, type PdfRenderer } from "./core/attachments.ts";
import { type Bot, Bots } from "./core/bots.ts";
import { Hub } from "./core/events.ts";
import { Logins } from "./core/logins.ts";
import { Rooms } from "./core/rooms.ts";
import { Scheduler } from "./core/scheduler.ts";
import { Sessions } from "./core/sessions.ts";
import { GATEWAY_TOOLS, gatewayFilesPattern } from "./core/policy.ts";
import { JevReviewer, ReviewLog } from "./core/review.ts";
import { Secrets } from "./core/secrets.ts";
import { Updates, type UpdatesOptions } from "./core/updates.ts";
import { Settings } from "./core/settings.ts";
import { Members, type MembersOptions } from "./federation/members.ts";
import { MemberChats } from "./federation/chats.ts";
import { Roster } from "./federation/roster.ts";
import { type AgentChange, Engine } from "./engine/engine.ts";
import { logger } from "./log.ts";
import { type ProviderCatalog, ProviderCatalogs } from "./models/catalogs.ts";
import { HostEnvs, hostsExtension } from "./remote/hosts.ts";
import { Spaces, type SpacesOptions } from "./spaces/spaces.ts";
import { SpaceViewer } from "./spaces/viewer.ts";
import { AppDb } from "./store/db.ts";
import { MemoryStore } from "./memory/memory.ts";
import type { Tuning } from "./mcp/connection.ts";
import { McpServers } from "./mcp/servers.ts";
import { pickableModels } from "./models/pickable.ts";
import { VERSION } from "./version.ts";
import { McpTools } from "./tools/mcp.ts";
import { isOwnGateway } from "./tools/own-gateway.ts";
import { NetworkNotifier } from "./federation/notify.ts";
import { FanoutNotifier, type Notification, type Notifier, type OptionalNotifier, PushoverNotifier } from "./notify/notifier.ts";
import { ApnsTransport } from "./notify/apns.ts";
import { Devices } from "./notify/devices.ts";
import { Push } from "./notify/push.ts";
import { Skills } from "./skills/skills.ts";
import { delegateExtension } from "./tools/delegate.ts";
import { memoryFeature } from "./tools/memory.ts";
import { askFeature } from "./tools/ask.ts";
import { cardsFeature } from "./tools/cards.ts";
import { scheduleFeature } from "./tools/schedule.ts";
import { webFeature } from "./tools/web.ts";
import { Browsers } from "./computer/browser.ts";
import { browserFeature } from "./tools/browser.ts";
import { desktopFeature } from "./tools/desktop.ts";
import { spacesFeature } from "./tools/spaces.ts";
import { describeConfigCall, type SelfServices, selfFeature } from "./tools/self.ts";
import { OpenChamberWatcher } from "./openchamber/watcher.ts";
import { openchamberFeature } from "./tools/openchamber.ts";
import { skillsFeature } from "./tools/skills.ts";
import { coreToolGroups, type ToolGroups, toolsFor } from "./tools/index.ts";

const log = logger("app");

export type Core = {
	config: Config;
	db: AppDb;
	engine: Engine;
	bots: Bots;
	sessions: Sessions;
	/** Pictures and files uploaded for a session's next prompt. */
	attachments: Attachments;
	hub: Hub;
	approvals: Approvals;
	models: Models;
	/** Provider sign-in sessions (nhermes auth, the panel). */
	logins: Logins;
	toolGroups: ToolGroups;
	deps: AgentDeps;
	hosts: HostEnvs;
	/** Disposable desktops bots open on this host (src/spaces/). */
	spaces: Spaces;
	/** The owner's live views of spaces, here and on members (src/spaces/viewer.ts). */
	viewer: SpaceViewer;
	memory: MemoryStore;
	skills: Skills;
	scheduler: Scheduler;
	/** Group chats between this gateway's bots. */
	rooms: Rooms;
	notifier: Notifier;
	/** Only this gateway's own transports (no forwarding to a member). */
	localNotifier: Notifier;
	/** Push notifications to the owner's devices (src/notify/push.ts), straight from Apple. */
	push: Push;
	/** The devices that get them from Apple, and the sender (src/notify/devices.ts, apns.ts). */
	devices: Devices;
	apns: ApnsTransport;
	browsers: Browsers;
	settings: Settings;
	members: Members;
	roster: Roster;
	/** The owner's chats with members' bots on the client API. */
	memberChats: MemberChats;
	secrets: Secrets;
	/** Providers whose model list is fetched once their key is set. */
	catalogs: ProviderCatalogs;
	reviewer: JevReviewer;
	reviewLog: ReviewLog;
	updates: Updates;
	/** MCP servers: connections, availability, tool snapshots. */
	mcp: McpServers;
	/** Their tools as Durable tools, by tool group `mcp:<server>`. */
	mcpTools: McpTools;
	agentFor(bot: Bot): AgentChange;
	close(): Promise<void>;
};

/** A feature module: tool groups, Durable extensions and prompt parts it contributes. */
export type Feature = {
	groups?: ToolGroups;
	/** Tools every bot has, whatever its tool groups (cards' `show`). */
	always?: ToolRegistration[];
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
	/** Replaces the cua command and the daemon connection of spaces (tests). */
	spaces?: Partial<Omit<SpacesOptions, "config">>;
	/** Feature modules built once the late-bound services exist. */
	features?: (late: LateServices) => Feature[];
	/** OpenChamber's settings file (tests point this away from the real one). */
	openchamberSettingsPath?: string;
	/** Notification transport override (tests). */
	notifier?: Notifier;
	/** Apple's push servers (tests point them at a local server). */
	apnsHosts?: Record<"production" | "development", string>;
	/** How long after an approval is settled its push banners are replaced (tests shorten it). */
	pushSettleMs?: number;
	browserHeadless?: boolean;
	browserExecutable?: string;
	/** Software updates: the checkout, package install and restart (the CLI passes restart; tests replace the rest). */
	updates?: UpdatesOptions;
	/** Replaces the HTTP call to Jev (tests). */
	reviewFetch?: typeof fetch;
	/** Membership clock/transport overrides (tests). */
	members?: MembersOptions;
	/** Provider catalogs and their HTTP call (tests). */
	catalogs?: ProviderCatalog[];
	catalogFetch?: typeof fetch;
	/** Replaces pdftoppm for PDF pages (tests). */
	renderPdf?: PdfRenderer;
	/** MCP connection timings and HTTP call (tests). */
	mcpTuning?: Partial<Tuning>;
	mcpFetch?: typeof fetch;
};

/** Services features may reach at call time (they are created after the engine opens). */
export type LateServices = { sessions: () => Sessions; bots: () => Bots; attachments: () => Attachments; agentFor: (bot: Bot) => AgentChange; config: Config; db: AppDb; hub: Hub; spaces: () => Spaces; /** Ports this gateway's web server answers on (its panel is on them). */ ownPorts: () => number[] };

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
	const reviewer = new JevReviewer(config, { fetch: options.reviewFetch });
	const reviewLog = new ReviewLog(db);
	const updates = new Updates(db, options.updates);
	bots.setRemote(() => roster.list());
	members.onChange(() => void roster.sync().then(() => hub.publishGlobal({ type: "bots.changed" })));
	const approvals = new Approvals(hub, db, config.defaults.approvalTimeoutS * 1000, () => config.defaults.questionTimeoutS * 1000);
	const models = options.models ?? (await loadModels(config));
	// Before any chat resumes, so one on a catalog model finds it.
	const catalogs = new ProviderCatalogs({ models, db, modelsPath: config.pi.modelsPath, catalogs: options.catalogs, fetch: options.catalogFetch });
	await catalogs.start();
	// The notifier is built further down; the callback runs only when a model call fails, long after.
	let tellOwner: ((n: Notification) => Promise<void>) | undefined;
	const logins = new Logins({
		models,
		db,
		authPath: config.pi.authPath,
		onNeedsSignIn: (p) =>
			void tellOwner?.({ title: `${p.name} needs signing in`, message: `${p.name} on ${members.self().name} needs signing in again. Open the panel's Logins tab.` }).catch(() => {}),
	});
	const secrets = new Secrets(config, db, catalogs.keys());
	secrets.registerEnvironment();
	secrets.onChange((name) => catalogs.keyChanged(name));
	const hosts = new HostEnvs(config.dataDir, options.connectHost);
	const spaces = new Spaces({ ...options.spaces, config: config.spaces, dataDir: config.dataDir });
	const viewer = new SpaceViewer({ spaces, memberTarget: (nodeId) => members.target(nodeId) });
	// A member's views close with its key, like its sockets (src/server.ts).
	members.onRevoke(() => viewer.dropMember((nodeId) => members.get(nodeId) !== undefined));

	let sessions: Sessions | undefined;
	const toolGroups = coreToolGroups();
	let mcpTools: McpTools | undefined;
	const agentFor = (bot: Bot): AgentChange => {
		// Gateway-wide tools are not offered to bots that are not trusted.
		const tools = [...toolsFor(toolGroups, bot.toolGroups), ...alwaysTools].filter((t) => bot.trusted || !GATEWAY_TOOLS.has(t.name));
		// Deferred MCP tools are found with tool_search.
		if (mcpTools && tools.some((t) => t.deferred)) tools.push(mcpTools.searchTool);
		return { model: bot.model, thinkingLevel: bot.thinking as AgentChange["thinkingLevel"], cwd: HostEnvs.isRemote(bot) ? undefined : bot.workspace, tools };
	};
	const ownPorts = (): number[] => {
		const ports = new Set<number>([config.server.port]);
		try {
			const p = Number(new URL(members.self().url).port);
			if (p) ports.add(p);
		} catch {
			// an unparsable node url adds no port
		}
		return [...ports];
	};
	const mcp = new McpServers({
		db,
		servers: () => config.mcp.servers,
		version: VERSION,
		refuse: async (url) => ((await isOwnGateway(url, ownPorts())) ? "the URL points at this gateway itself" : undefined),
		fetch: options.mcpFetch,
		tuning: options.mcpTuning,
	});
	secrets.onChange((name) => mcp.keyChanged(name));
	mcpTools = new McpTools({ servers: mcp, toolGroups, configs: () => config.mcp.servers });
	mcp.onToolsChanged(() => mcpTools?.republish());
	const late: LateServices = { sessions: () => sessions!, bots: () => bots, attachments: () => attachments, agentFor, config, db, hub, spaces: () => spaces, ownPorts };

	const delegation = delegateExtension({
		sessions: late.sessions,
		bots: late.bots,
		agentFor,
		maxDepth: 2,
		approvals: () => approvals,
		attentionSession: (id) => rootSession(sessions!, id),
		members: () => members,
		stopped: async (conversationId, text, call) => {
			const row = sessions!.byConversation(conversationId);
			await engine.writeNotice(conversationId, text, { at: String(Date.now() / 1000), call });
			if (row) hub.publish(row.id, { type: "notice", message: text, call });
		},
	});
	toolGroups.set("delegate", delegation.tools);
	const memory = new MemoryStore(db);
	const skills = new Skills(config.skillsDir, db);
	const browsers = new Browsers(config.dataDir, { headless: options.browserHeadless ?? true, executablePath: options.browserExecutable ?? config.browserExecutable });
	const devices = new Devices(db);
	const apns = new ApnsTransport({ config: config.apns, devices, gatewayId: () => members.self().id, hosts: options.apnsHosts });
	const push = new Push({ hub, bots, sessions: () => sessions, transports: [apns], settleDelayMs: options.pushSettleMs });
	removeVoryRegistrations(config.dataDir);
	// What this gateway can deliver itself; /federation/notify uses only this. The gateway's own notifier adds
	// forwarding to a member as the fallback for when nothing local can deliver.
	const localNotifier: Notifier = options.notifier ?? new FanoutNotifier([...(config.pushover ? [new PushoverNotifier(config.pushover)] : []), push]);
	const notifier: Notifier = options.notifier ?? new FanoutNotifier([{ get name() { return localNotifier.name; }, send: (n) => localNotifier.send(n), ready: () => localNotifier.name !== "none" } satisfies OptionalNotifier, new NetworkNotifier(() => members, () => localNotifier)]);
	tellOwner = (n) => notifier.send(n);
	let scheduler: Scheduler | undefined;
	let rooms: Rooms | undefined;
	const selfServices: SelfServices = {
		skills,
		view: { config, toolGroups, bots },
		settings: () => settings,
		updates: () => updates,
		modelExists: (ref) => {
			const i = ref.indexOf("/");
			return i > 0 && models.getModel(ref.slice(0, i), ref.slice(i + 1)) !== undefined;
		},
		pickableModels: (current) => pickableModels(models, config.modelLists.hide, current),
	};
	const desktop = desktopFeature(late);
	const features = [
		memoryFeature(late, memory),
		skillsFeature(late, skills),
		selfFeature(late, selfServices),
		cardsFeature(late),
		askFeature(late, { approvals: () => approvals, attentionSession: (id) => rootSession(sessions!, id), deadline: (id) => scheduler?.questionDeadline(id) }),
		scheduleFeature(late, () => scheduler!, () => notifier),
		webFeature(late),
		browserFeature(late, () => browsers),
		desktop,
		spacesFeature(late, desktop.groups!.get("desktop")!),
		openchamberFeature(late, { settingsPath: options.openchamberSettingsPath }),
		...(options.features?.(late) ?? []),
	];
	for (const f of features) for (const [k, v] of f.groups ?? []) toolGroups.set(k, v);
	const alwaysTools = features.flatMap((f) => f.always ?? []);

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
		mcpTools.promptPart(),
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
		reviewer,
		reviewLog,
		describeConfig: (bot, name, args) => describeConfigCall(selfServices, bot, name, args),
		gatewayFiles: gatewayFilesPattern(config.configDir, config.dataDir),
		acceptsBotEdits: () => members.acceptsBotEdits(),
		machine: () => members.self().name,
		roomOwnerMessages: (id) => rooms?.ownerMessages(id),
		mcpTool: (name) => mcpTools?.lookup(name),
	};
	// MCP tools live in their own extension, which is re-installed when a server's tool list changes.
	const allTools: ToolRegistration[] = [...new Map([...[...toolGroups.entries()].filter(([g]) => !g.startsWith("mcp:")).flatMap(([, tools]) => tools), ...alwaysTools].map((t) => [t.name, t])).values()];
	const extensions: Extension[] = [
		personaExtension(deps),
		defineExtension({ name: "tools", tools: allTools }),
		delegation.extension,
		hostsExtension((convId) => sessions?.botOf(convId)),
		...features.flatMap((f) => f.extensions ?? []),
		mcpTools.extension(),
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
	mcpTools.attach(engine.registry);
	sessions = new Sessions(engine, db, bots, hub, approvals, agentFor, (m) => logins.modelOutcome(m));
	// The chats of a bot that are followed hear about its spaces; one space belongs to all of the bot's chats.
	spaces.onChanged((bot) => {
		const list = spaces.list(bot);
		for (const id of hub.followed()) if (sessions?.get(id)?.bot === bot) hub.publish(id, { type: "spaces", spaces: list });
	});
	const attachments = new Attachments({ db, bots, sessions: late.sessions, engine, renderPdf: options.renderPdf });
	const memberChats = new MemberChats({ sessions: late.sessions, bots, members, approvals, hub, finished: (id, t) => push.remoteFinished(id, t) });
	members.onRevoke(() => memberChats.dropGone());
	sessions.setRemoteHooks({ running: (id) => memberChats.isRunning(id), deleted: (row) => memberChats.deleted(row) });
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

	const chamberWatcher = new OpenChamberWatcher({
		configs: () => bots.list().filter((b) => b.toolGroups.includes("openchamber_alerts")).map((b) => b.config?.openchamber ?? {}),
		notifier: () => notifier,
		settingsPath: options.openchamberSettingsPath,
	});
	const settings = new Settings({
		config,
		bots,
		toolGroups: () => [...toolGroups.keys()],
		botChanged: (name) => hosts.reset(name),
		// The openchamber_alerts group turned on or off (the client API, the panel) takes effect without a restart.
		applied: () => {
			void chamberWatcher.sync();
			hub.publishGlobal({ type: "bots.changed" });
		},
		mcpChanged: () => {
			mcp.apply();
			mcpTools?.republish();
		},
	});
	const folded = settings.withBackup(() => settings.foldOverrides());
	if (folded.length > 0) log.info("moved bot overrides into config.yaml", { bots: folded });

	push.start();
	chamberWatcher.start();
	engine.resume();
	const reattached = await sessions.attachBusy();
	if (reattached > 0) log.info("re-attached interrupted runs", { count: reattached });
	rooms = new Rooms({ db, engine, sessions, bots, hub, notifier, approvals, members, memberChats });
	rooms.start();
	// In the background: a server that is down or slow never holds up the gateway.
	mcp.start();
	// Also in the background: sweeps leftovers from an earlier run.
	spaces.start();

	return {
		config,
		db,
		engine,
		bots,
		sessions,
		attachments,
		hub,
		approvals,
		models,
		logins,
		toolGroups,
		deps,
		hosts,
		spaces,
		viewer,
		memory,
		skills,
		scheduler,
		rooms,
		notifier,
		localNotifier,
		push,
		devices,
		apns,
		browsers,
		settings,
		members,
		roster,
		memberChats,
		secrets,
		catalogs,
		reviewer,
		reviewLog,
		updates,
		mcp,
		mcpTools,
		agentFor,
		close: async () => {
			members.stop();
			logins.close();
			updates.stop();
			catalogs.stop();
			push.stop();
			apns.close();
			await chamberWatcher.stop();
			memberChats.close();
			await scheduler!.stop();
			await rooms!.stop();
			await browsers.close();
			await engine.close();
			// After the engine: a call still waiting must not be answered as "connection lost" while Durable shuts
			// down; it stays unfinished, so a restart applies Durable's replay rule to it.
			await mcp.close();
			hosts.close();
			viewer.close();
			await spaces.shutdown();
			db.close();
		},
	};
}

/**
 * The Vory app's notification registrations, kept by versions that spoke its protocol, are of no use now that the
 * nHermes app gets notifications from Apple: removed once, with a line in the log (docs/CLIENT-API.md decision 5).
 */
function removeVoryRegistrations(dataDir: string): void {
	const dir = join(dataDir, "vory");
	if (!existsSync(dir)) return;
	rmSync(dir, { recursive: true, force: true });
	log.info("removed Vory's notification registrations (the nHermes app gets its notifications from Apple)", { dir });
}
