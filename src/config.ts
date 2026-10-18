// Configuration: one YAML file plus a secrets env file. Secrets never live in the YAML.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { registerSecret } from "./log.ts";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
export const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

export type ApprovalMode = "smart" | "manual" | "off";

export type SshHostConfig = {
	host: string;
	user?: string;
	port?: number;
	identityFile?: string;
	/** Working directory on the host. */
	cwd?: string;
};

export type BotConfig = {
	name: string;
	displayName?: string;
	description?: string;
	default?: boolean;
	instructions?: string;
	soulFile?: string;
	/** "provider/modelId"; the model id may itself contain "/". */
	model?: string;
	thinking?: ThinkingLevel;
	/** Tool groups (see src/tools/index.ts). */
	tools?: string[];
	/** Global skill names this bot may use; "*" for all. Per-bot skills in bots/<name>/skills are always on. */
	skills?: string[];
	/** Shared memory spaces this bot may read and write. */
	sharedMemory?: string[];
	/** How many of its latest chats a new chat is told about (default 5; 0 turns it off). Needs the memory tools. */
	recentChats?: number;
	approvals?: { mode?: ApprovalMode; ask?: string[]; deny?: string[]; allow?: string[] };
	/** Owner-trusted infrastructure bot: broad shell, only high-impact patterns ask. */
	trusted?: boolean;
	/** Kept to itself: other bots do not see it or delegate to it, and it is not shared with members. */
	private?: boolean;
	workspace?: string;
	host?: { ssh: SshHostConfig };
	/** Mode B: this bot is an independent nHermes gateway elsewhere (its `profile` there). */
	peer?: { url: string; tokenEnv: string; profile?: string };
	/** Environment variables this bot's http_request may reference as {{secret:NAME}}. */
	secrets?: string[];
	/** Browser: headless (default true), or attach to a browser elsewhere over CDP. */
	browser?: { headless?: boolean; cdpUrl?: string };
	/** Desktop automation target: an X11 desktop reached through the bot's host (see docs/COMPUTER_USE.md). */
	desktop?: { display?: string };
	/** OpenChamber on this Mac (tool group `openchamber`). Without url/tokenEnv its own settings file is read. */
	openchamber?: {
		url?: string;
		tokenEnv?: string;
		/** Defaults for threads the bot starts; unset ones follow the defaults picked in OpenChamber. */
		model?: string;
		variant?: string;
		agent?: string;
	};
};

export type Config = {
	configPath: string;
	configDir: string;
	dataDir: string;
	/** federationPort: the encrypted port other members use (default port + 1000, the next free one if taken). */
	server: { host: string; port: number; publicName: string; federationPort?: number };
	/** Gateway session token Vory sends as X-Hermes-Session-Token. */
	token: string;
	/** The variable that holds it (auth.tokenEnv, default NHERMES_TOKEN). */
	tokenEnv: string;
	/** The secrets file (secretsFile, default secrets.env next to config.yaml). */
	secretsPath: string;
	/** Jev permission review in the approval guard (active when its key is set). */
	review: ReviewConfig;
	/** Model providers left out of model pickers (Vory, the panel); `models.hide` in config.yaml. */
	modelLists: { hide: string[] };
	pi: { authPath: string; modelsPath: string };
	defaults: { model: string; thinking: ThinkingLevel; approvals: ApprovalMode; approvalTimeoutS: number };
	skillsDir: string;
	timezone: string;
	bots: BotConfig[];
	pushover?: { user: string; token: string };
	/** Chrome/Chromium binary for Playwright (e.g. /usr/bin/google-chrome); default: Playwright's own. */
	browserExecutable?: string;
	/** This gateway as a network member: its name (default: the host name) and the URL members use. */
	node: { name?: string; url?: string };
	/** Replaces the built-in ground rules every bot's prompt carries (src/agent/extensions.ts). */
	groundRules?: string;
	/** The web control panel at /panel (on by default; its password, if any, is set with `nhermes panel password`). */
	panel: { enabled: boolean };
};

export const NODE_NAME = /^[a-z0-9][a-z0-9-]{0,30}$/;

export type ReviewConfig = { enabled: boolean; keyEnv: string; allowThreshold: number; timeoutMs: number };

function parseReview(raw: unknown): ReviewConfig {
	const jev = asRecord(asRecord(raw, "review").jev, "review.jev");
	const threshold = typeof jev.allowThreshold === "number" ? jev.allowThreshold : 0.8;
	if (threshold < 0.5 || threshold > 1) throw new ConfigError("review.jev.allowThreshold must be between 0.5 and 1");
	const timeout = typeof jev.timeoutMs === "number" ? jev.timeoutMs : 3000;
	if (timeout < 500 || timeout > 30_000) throw new ConfigError("review.jev.timeoutMs must be between 500 and 30000");
	return { enabled: jev.enabled !== false, keyEnv: str(jev.keyEnv, "review.jev.keyEnv") ?? "OPENROUTER_API_KEY", allowThreshold: threshold, timeoutMs: timeout };
}

const BOT_NAME = /^[a-z0-9][a-z0-9-]{0,40}$/;

export class ConfigError extends Error {
	override name = "ConfigError";
}

function expandPath(p: string, base: string): string {
	const home = p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
	return isAbsolute(home) ? home : resolve(base, home);
}

/** Names of variables loaded from secrets files: never passed to the shells bots run. */
export const secretEnvNames = new Set<string>();

/** Variables a bot's shell must not inherit: those from secrets files and anything named like a credential. */
export function scrubbedShellEnv(): Record<string, undefined> {
	const out: Record<string, undefined> = {};
	for (const name of Object.keys(process.env)) {
		if (secretEnvNames.has(name) || /(^|_)(API_?KEY|KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?)($|_)/i.test(name)) out[name] = undefined;
	}
	return out;
}

/** Loads KEY=VALUE lines into process.env without overriding values already set. */
export function loadEnvFile(path: string): void {
	if (!existsSync(path)) return;
	for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		const eq = line.indexOf("=");
		if (eq < 1) continue;
		const key = line.slice(0, eq).replace(/^export\s+/, "").trim();
		let value = line.slice(eq + 1).trim();
		if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.endsWith(value[0]!)) value = value.slice(1, -1);
		secretEnvNames.add(key);
		registerSecret(value);
		if (process.env[key] === undefined) process.env[key] = value;
	}
}

export function splitModel(ref: string): { provider: string; modelId: string } {
	const i = ref.indexOf("/");
	if (i < 1 || i === ref.length - 1) throw new ConfigError(`model must be "provider/modelId", got "${ref}"`);
	return { provider: ref.slice(0, i), modelId: ref.slice(i + 1) };
}

function asRecord(v: unknown, where: string): Record<string, unknown> {
	if (v === undefined || v === null) return {};
	if (typeof v !== "object" || Array.isArray(v)) throw new ConfigError(`${where} must be a mapping`);
	return v as Record<string, unknown>;
}

function str(v: unknown, where: string): string | undefined {
	if (v === undefined || v === null) return undefined;
	if (typeof v !== "string") throw new ConfigError(`${where} must be a string`);
	return v;
}

function strList(v: unknown, where: string): string[] | undefined {
	if (v === undefined || v === null) return undefined;
	if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new ConfigError(`${where} must be a list of strings`);
	return v as string[];
}

function parseBot(raw: unknown, i: number): BotConfig {
	const r = asRecord(raw, `bots[${i}]`);
	const name = str(r.name, `bots[${i}].name`);
	if (!name || !BOT_NAME.test(name)) throw new ConfigError(`bots[${i}].name must match ${BOT_NAME}`);
	const where = `bot "${name}"`;
	const thinking = str(r.thinking, `${where}.thinking`);
	if (thinking && !THINKING_LEVELS.includes(thinking as ThinkingLevel)) throw new ConfigError(`${where}.thinking is invalid`);
	const model = str(r.model, `${where}.model`);
	if (model) splitModel(model);
	const ap = asRecord(r.approvals, `${where}.approvals`);
	const mode = str(ap.mode, `${where}.approvals.mode`);
	if (mode && !["smart", "manual", "off"].includes(mode)) throw new ConfigError(`${where}.approvals.mode is invalid`);
	const recent = r.recentChats;
	if (recent !== undefined && (typeof recent !== "number" || !Number.isInteger(recent) || recent < 0 || recent > 20)) throw new ConfigError(`${where}.recentChats must be a whole number from 0 to 20`);
	const hostRaw = asRecord(r.host, `${where}.host`);
	let host: BotConfig["host"];
	if (hostRaw.ssh !== undefined) {
		const s = asRecord(hostRaw.ssh, `${where}.host.ssh`);
		const h = str(s.host, `${where}.host.ssh.host`);
		if (!h) throw new ConfigError(`${where}.host.ssh.host is required`);
		host = {
			ssh: {
				host: h,
				user: str(s.user, `${where}.host.ssh.user`),
				port: typeof s.port === "number" ? s.port : undefined,
				identityFile: str(s.identityFile, `${where}.host.ssh.identityFile`),
				cwd: str(s.cwd, `${where}.host.ssh.cwd`),
			},
		};
	}
	const ocRaw = asRecord(r.openchamber, `${where}.openchamber`);
	const ocModel = str(ocRaw.model, `${where}.openchamber.model`);
	if (ocModel) splitModel(ocModel);
	const peerRaw = asRecord(r.peer, `${where}.peer`);
	const peerUrl = str(peerRaw.url, `${where}.peer.url`);
	return {
		name,
		displayName: str(r.displayName, `${where}.displayName`),
		description: str(r.description, `${where}.description`),
		default: r.default === true,
		instructions: str(r.instructions, `${where}.instructions`),
		soulFile: str(r.soulFile, `${where}.soulFile`),
		model,
		thinking: thinking as ThinkingLevel | undefined,
		tools: strList(r.tools, `${where}.tools`),
		skills: strList(r.skills, `${where}.skills`),
		sharedMemory: strList(r.sharedMemory, `${where}.sharedMemory`),
		recentChats: recent as number | undefined,
		approvals: {
			mode: mode as ApprovalMode | undefined,
			ask: strList(ap.ask, `${where}.approvals.ask`),
			deny: strList(ap.deny, `${where}.approvals.deny`),
			allow: strList(ap.allow, `${where}.approvals.allow`),
		},
		trusted: r.trusted === true,
		private: r.private === true,
		workspace: str(r.workspace, `${where}.workspace`),
		host,
		peer: peerUrl ? { url: peerUrl, tokenEnv: str(peerRaw.tokenEnv, `${where}.peer.tokenEnv`) ?? "", profile: str(peerRaw.profile, `${where}.peer.profile`) } : undefined,
		secrets: strList(r.secrets, `${where}.secrets`),
		browser: r.browser === undefined ? undefined : { headless: asRecord(r.browser, `${where}.browser`).headless !== false, cdpUrl: str(asRecord(r.browser, `${where}.browser`).cdpUrl, `${where}.browser.cdpUrl`) },
		desktop: r.desktop === undefined ? undefined : { display: str(asRecord(r.desktop, `${where}.desktop`).display, `${where}.desktop.display`) },
		openchamber:
			r.openchamber === undefined
				? undefined
				: { url: str(ocRaw.url, `${where}.openchamber.url`), tokenEnv: str(ocRaw.tokenEnv, `${where}.openchamber.tokenEnv`), model: ocModel, variant: str(ocRaw.variant, `${where}.openchamber.variant`), agent: str(ocRaw.agent, `${where}.openchamber.agent`) },
	};
}

export function loadConfig(configPath: string): Config {
	const path = resolve(configPath);
	if (!existsSync(path)) throw new ConfigError(`config file not found: ${path}`);
	const configDir = dirname(path);
	const doc = asRecord(parseYaml(readFileSync(path, "utf8")), "config");
	const secretsFile = expandPath(str(doc.secretsFile, "secretsFile") ?? "secrets.env", configDir);
	loadEnvFile(secretsFile);

	const server = asRecord(doc.server, "server");
	const pi = asRecord(doc.pi, "pi");
	const defaults = asRecord(doc.defaults, "defaults");
	const tokenEnv = str(asRecord(doc.auth, "auth").tokenEnv, "auth.tokenEnv") ?? "NHERMES_TOKEN";
	const token = process.env[tokenEnv] ?? "";
	if (token.length < 16) throw new ConfigError(`${tokenEnv} must be set (in ${secretsFile} or the environment) to at least 16 characters`);
	registerSecret(token);

	const bots = (Array.isArray(doc.bots) ? doc.bots : []).map(parseBot);
	for (const b of bots) for (const name of b.secrets ?? []) registerSecret(process.env[name]);
	for (const b of bots) if (b.peer) registerSecret(process.env[b.peer.tokenEnv]);
	if (bots.length === 0) throw new ConfigError("config needs at least one bot under `bots:`");
	const names = new Set<string>();
	for (const b of bots) {
		if (names.has(b.name)) throw new ConfigError(`duplicate bot name "${b.name}"`);
		names.add(b.name);
	}
	if (bots.some((b) => b.default && b.peer)) throw new ConfigError("the default bot cannot be a peer");
	if (!bots.some((b) => b.default)) {
		const first = bots.find((b) => !b.peer);
		if (!first) throw new ConfigError("config needs at least one local (non-peer) bot");
		first.default = true;
	}
	if (bots.filter((b) => b.default).length > 1) throw new ConfigError("only one bot may be `default: true`");

	const defaultModel = str(defaults.model, "defaults.model");
	if (!defaultModel) throw new ConfigError("defaults.model is required (provider/modelId)");
	splitModel(defaultModel);
	const thinking = (str(defaults.thinking, "defaults.thinking") ?? "medium") as ThinkingLevel;
	if (!THINKING_LEVELS.includes(thinking)) throw new ConfigError("defaults.thinking is invalid");

	const node = asRecord(doc.node, "node");
	const nodeName = str(node.name, "node.name");
	if (nodeName !== undefined && !NODE_NAME.test(nodeName)) throw new ConfigError(`node.name must match ${NODE_NAME}`);

	const pushUser = process.env.PUSHOVER_USER_KEY;
	const pushToken = process.env.PUSHOVER_APP_TOKEN;
	registerSecret(pushToken);
	registerSecret(pushUser);

	return {
		configPath: path,
		configDir,
		dataDir: expandPath(str(doc.dataDir, "dataDir") ?? "data", configDir),
		server: {
			// All interfaces by default, so a headless machine is reachable on the LAN; 127.0.0.1 keeps it local.
			host: str(server.host, "server.host") ?? "0.0.0.0",
			port: typeof server.port === "number" ? server.port : 9119,
			publicName: str(server.name, "server.name") ?? "nHermes",
			federationPort: typeof server.federationPort === "number" ? server.federationPort : undefined,
		},
		token,
		tokenEnv,
		secretsPath: secretsFile,
		review: parseReview(doc.review),
		// OpenRouter's key is there for Jev review; its hundreds of models stay out of the pickers unless asked for.
		modelLists: { hide: strList(asRecord(doc.models, "models").hide, "models.hide") ?? ["openrouter"] },
		pi: {
			authPath: expandPath(str(pi.authPath, "pi.authPath") ?? "~/.pi/agent/auth.json", configDir),
			modelsPath: expandPath(str(pi.modelsPath, "pi.modelsPath") ?? "~/.pi/agent/models.json", configDir),
		},
		defaults: {
			model: defaultModel,
			thinking,
			approvals: (str(defaults.approvals, "defaults.approvals") ?? "smart") as ApprovalMode,
			approvalTimeoutS: typeof defaults.approvalTimeoutS === "number" ? defaults.approvalTimeoutS : 600,
		},
		skillsDir: expandPath(str(doc.skillsDir, "skillsDir") ?? "skills", configDir),
		timezone: str(doc.timezone, "timezone") ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
		bots,
		pushover: pushUser && pushToken ? { user: pushUser, token: pushToken } : undefined,
		browserExecutable: str(doc.browserExecutable, "browserExecutable"),
		node: { name: nodeName, url: str(node.url, "node.url") },
		panel: { enabled: asRecord(doc.panel, "panel").enabled !== false },
		groundRules: str(doc.groundRules, "groundRules")?.trim() || undefined,
	};
}
