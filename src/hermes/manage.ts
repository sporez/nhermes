// Vory's settings and maintenance screens, onto the same services the panel and the CLI use: update,
// restart and doctor (with the action status Vory polls), recent logs, per-bot config, tool groups,
// the default model, keys, creating and removing bots, usage analytics and a read-only Files browser
// over the bots' workspaces. Hermes-only settings answer 400 with the reason rather than pretending.
import { lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import type { Core } from "../app.ts";
import { type BotConfig, ConfigError, THINKING_LEVELS, type ThinkingLevel } from "../config.ts";
import type { Bot } from "../core/bots.ts";
import { BOT_NAME, BOT_NAME_RULE, cloneEntry } from "../core/bot-entry.ts";
import { isRunning, loadAction, runRestart, runUpdate, startDoctor } from "../core/actions.ts";
import { SecretError } from "../core/secrets.ts";
import { usageReport } from "../core/usage.ts";
import { UpdateError } from "../core/updates.ts";
import { recentLogs } from "../log.ts";
import { HttpError, obj, RawBody, type Router } from "../http.ts";
import { FILE_MAX, insideWorkspace, mimeOf, workspaceRoots } from "../core/workspaces.ts";
import { botFor, localOnly } from "./lookup.ts";
import { VERSION } from "../version.ts";

const ACTIONS = new Set(["hermes-update", "gateway-restart", "doctor"]);
/** Pictures GET /api/media serves (Hermes' list, without SVG and icons). */
const MEDIA: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp" };
const MEDIA_MAX = 25 * 1024 * 1024;

/** Turns the services' own errors into HTTP answers. */
export function call<T>(fn: () => T): T {
	try {
		return fn();
	} catch (error) {
		if (error instanceof ConfigError) throw new HttpError(400, error.message);
		if (error instanceof SecretError || error instanceof UpdateError) throw new HttpError(error.status, error.message);
		throw error;
	}
}

function flatten(v: unknown, prefix = "", out: Record<string, unknown> = {}): Record<string, unknown> {
	if (v && typeof v === "object" && !Array.isArray(v)) {
		for (const [k, x] of Object.entries(v)) flatten(x, prefix ? `${prefix}.${k}` : k, out);
	} else if (prefix) out[prefix] = v;
	return out;
}

export function manageRoutes(core: Core, r: Router): void {
	const { bots, settings } = core;
	const local = (profile: string | null | undefined): Bot => {
		const bot = botFor(core, profile);
		localOnly(bot);
		return bot;
	};
	const profileOf = (q: { query: URLSearchParams; body: unknown }) => q.query.get("profile") ?? (obj(q.body).profile as string | undefined);

	// ---- Maintenance: update, restart and doctor, with the status Vory polls while one runs ----
	r.on("GET", "/api/hermes/update/check", (q) => {
		const s = q.query.get("force") === "true" ? call(() => core.updates.check()) : core.updates.status();
		const message = !s.updatable
			? s.reason
			: !core.updates.canRestart
				? "This gateway is not run by systemd or launchd, so an update cannot restart it; update on its machine."
				: s.lastCheck
					? `Last checked ${new Date(s.lastCheck * 1000).toLocaleString("en-US", { timeZone: core.config.timezone })}.`
					: undefined;
		return {
			install_method: "git",
			current_version: `${VERSION}${s.current ? ` (${s.current.hash})` : ""}`,
			behind: s.available.length,
			update_available: s.available.length > 0,
			can_apply: s.updatable && core.updates.canRestart,
			update_command: "nhermes update",
			message,
			commits: s.available.map((c) => ({ sha: c.hash, summary: c.subject, at: c.date })),
		};
	});
	r.on("POST", "/api/hermes/update", () => {
		const a = call(() => runUpdate(core, "hermes-update"));
		return { ok: true, name: "hermes-update", message: a.lines.join(" ") };
	});
	r.on("POST", "/api/gateway/restart", () => {
		call(() => runRestart(core, "gateway-restart"));
		return { ok: true, name: "gateway-restart" };
	});
	r.on("POST", "/api/ops/doctor", async () => {
		const a = await startDoctor(core, "doctor").done;
		return { ok: true, name: "doctor", exit_code: a.exitCode, output: a.lines.join("\n") };
	});
	r.on("GET", "/api/actions/:name/status", (q) => {
		const name = q.params.name!;
		if (!ACTIONS.has(name)) throw new HttpError(404, `no action "${name}"`);
		const a = loadAction(core, name);
		if (!a) return { name, running: false, exit_code: null, lines: [] };
		if (isRunning(a)) return { name, running: true, exit_code: null, lines: a.lines };
		const lines = a.lines.slice(-Number(q.query.get("lines") ?? 60));
		return { name, running: false, exit_code: a.exitCode ?? 0, lines, output: lines.join("\n"), receipt: { outcome: (a.exitCode ?? 0) === 0 ? "success" : "failed" } };
	});
	r.on("GET", "/api/logs", (q) => {
		const n = Math.min(Math.max(Number(q.query.get("lines") ?? 200) || 200, 1), 500);
		return { file: "agent", lines: recentLogs(n) };
	});

	// ---- Config: the selected bot's settings, plus the gateway-wide ones ----
	r.on("GET", "/api/config", (q) => {
		const bot = botFor(core, profileOf(q));
		return {
			config: {
				model: `${bot.model.provider}/${bot.model.modelId}`,
				approvals: { mode: bot.approvals.mode, timeout: core.config.defaults.approvalTimeoutS },
				agent: { reasoning_effort: bot.thinking },
				timezone: core.config.timezone,
				command_allowlist: bot.remote ? [] : core.approvals.rules(`bot:${bot.name}`),
				// nHermes never stops a turn because no app is connected: Vory's "keep work running" is always "never stop it".
				dashboard: { ws_orphan_reap_grace_s: 0 },
			},
		};
	});
	r.on("GET", "/api/config/schema", () => ({
		fields: {
			model: { type: "string", description: "This bot's default model (provider/model)", category: "general" },
			"approvals.mode": { type: "select", description: "How this bot's risky actions are approved", category: "security", options: ["manual", "smart", "off"] },
			"approvals.timeout": { type: "number", description: "Seconds before an unanswered approval is denied (every bot; applies after a restart)", category: "security" },
			"agent.reasoning_effort": { type: "select", description: "This bot's reasoning effort", category: "agent", options: [...THINKING_LEVELS] },
			timezone: { type: "string", description: "Time zone for schedules (every bot; applies after a restart)", category: "general" },
		},
		category_order: ["general", "agent", "security"],
	}));
	r.on("PUT", "/api/config", (q) => {
		const bot = local(profileOf(q));
		const body = obj(q.body);
		const changes = flatten(body.config ?? body);
		const restartNeeded: string[] = [];
		for (const [key, value] of Object.entries(changes)) {
			if (key === "model") {
				const ref = String(value ?? "");
				const i = ref.indexOf("/");
				if (i <= 0 || !core.models.getModel(ref.slice(0, i), ref.slice(i + 1))) throw new HttpError(400, `Unknown model ${ref} (use provider/model)`);
				call(() => settings.editBot(bot.name, { model: ref }));
			} else if (key === "agent.reasoning_effort") {
				if (!THINKING_LEVELS.includes(value as ThinkingLevel)) throw new HttpError(400, `reasoning_effort must be one of ${THINKING_LEVELS.join(", ")}`);
				call(() => settings.editBot(bot.name, { thinking: value as ThinkingLevel }));
			} else if (key === "approvals.mode") {
				if (!["manual", "smart", "off"].includes(String(value))) throw new HttpError(400, "approvals.mode must be manual, smart or off");
				call(() => settings.editBot(bot.name, { approvals: { ...bot.config.approvals, mode: value as "manual" | "smart" | "off" } }));
			} else if (key === "approvals.timeout") {
				if (!Number.isFinite(Number(value)) || Number(value) <= 0) throw new HttpError(400, "approvals.timeout must be a number of seconds");
				restartNeeded.push(...call(() => settings.setGateway({ defaults: { approvalTimeoutS: Number(value) } })).restartNeeded);
			} else if (key === "timezone") {
				restartNeeded.push(...call(() => settings.setGateway({ timezone: String(value) })).restartNeeded);
			} else if (key === "command_allowlist") {
				if (!Array.isArray(value) || value.some((x) => typeof x !== "string")) throw new HttpError(400, "command_allowlist must be a list of rules");
				const scope = `bot:${bot.name}`;
				const next = new Set(value as string[]);
				for (const rule of core.approvals.rules(scope)) if (!next.has(rule)) core.approvals.removeRule(scope, rule);
				for (const rule of next) core.approvals.addRule(scope, rule);
			} else if (key === "dashboard.ws_orphan_reap_grace_s") {
				if (Number(value) !== 0) throw new HttpError(400, "nHermes never stops a turn because the app left, so there is no wait to set");
			} else {
				throw new HttpError(400, `${key} is not a setting on this gateway`);
			}
		}
		return { ok: true, restart_needed: [...new Set(restartNeeded)] };
	});

	// ---- Tool groups, the default model, keys ----
	r.on("PUT", "/api/tools/toolsets/:name", (q) => {
		const bot = local(profileOf(q));
		const name = q.params.name!;
		if (!core.toolGroups.has(name)) throw new HttpError(404, `no tool group "${name}"`);
		const enabled = obj(q.body).enabled === true;
		const tools = enabled ? [...new Set([...bot.toolGroups, name])] : bot.toolGroups.filter((g) => g !== name);
		call(() => settings.editBot(bot.name, { tools }));
		return { ok: true, name, enabled };
	});
	r.on("POST", "/api/model/set", (q) => {
		const b = obj(q.body);
		if ((b.scope ?? "main") !== "main") throw new HttpError(400, "this gateway has no auxiliary models");
		const bot = local(profileOf(q));
		const provider = typeof b.provider === "string" ? b.provider : "";
		const model = typeof b.model === "string" ? b.model : "";
		if (!core.models.getModel(provider, model)) throw new HttpError(400, `Unknown model ${provider}/${model}`);
		call(() => settings.editBot(bot.name, { model: `${provider}/${model}` }));
		return { ok: true, provider, model };
	});
	const keyName = (v: unknown) => {
		if (typeof v !== "string" || !v) throw new HttpError(400, "key is required");
		if (v === core.config.tokenEnv) throw new HttpError(403, "the gateway token is changed in the panel's Keys tab or with nhermes, not from Vory (this app would lose its connection)");
		return v;
	};
	r.on("PUT", "/api/env", (q) => {
		const b = obj(q.body);
		const key = keyName(b.key);
		const result = call(() => core.secrets.set(key, typeof b.value === "string" ? b.value : ""));
		return { ok: true, key, restart_needed: result.restartNeeded };
	});
	r.on("DELETE", "/api/env", (q) => {
		const key = keyName(obj(q.body).key ?? q.query.get("key"));
		const result = call(() => core.secrets.remove(key));
		return { ok: true, key, restart_needed: result.restartNeeded };
	});

	// ---- Bots: create (optionally from another's settings) and remove ----
	r.on("POST", "/api/profiles", (q) => {
		const b = obj(q.body);
		const name = typeof b.name === "string" ? b.name.trim() : "";
		if (!BOT_NAME.test(name)) throw new HttpError(400, BOT_NAME_RULE);
		let entry: BotConfig = { name };
		if (typeof b.clone_from === "string" && b.clone_from) entry = cloneEntry(local(b.clone_from), name);
		call(() => settings.addBot(entry));
		return { ok: true, name };
	});
	r.on("DELETE", "/api/profiles/:name", (q) => {
		const bot = local(q.params.name);
		if (!core.config.bots.some((b) => b.name === bot.name)) throw new HttpError(404, `Profile '${bot.name}' not found`);
		call(() => settings.removeBot(bot.name));
		return { ok: true, name: bot.name };
	});

	// ---- Usage analytics from the chats' model calls (Dashboard, widgets, watch) ----
	r.on("GET", "/api/analytics/usage", async (q) => {
		// A member's bot keeps its chats on its own machine: nothing to count here.
		const bot = botFor(core, profileOf(q));
		const days = Math.min(Math.max(Number(q.query.get("days") ?? 30) || 30, 1), 366);
		const u = await usageReport(core, bot.remote ? [] : [bot.name], days);
		const daily = u.daily.map((s) => ({ day: s.day, input_tokens: s.input, output_tokens: s.output, cache_read_tokens: s.cacheRead, reasoning_tokens: s.reasoning, estimated_cost: s.cost, actual_cost: s.cost, sessions: s.sessions, api_calls: s.calls }));
		return {
			period_days: days,
			daily,
			by_model: u.byModel.map((s) => ({ model: s.model, input_tokens: s.input, output_tokens: s.output, estimated_cost: s.cost, sessions: s.sessions, api_calls: s.calls })),
			totals: {
				total_input: u.totals.input,
				total_output: u.totals.output,
				total_cache_read: u.totals.cacheRead,
				total_reasoning: u.totals.reasoning,
				total_estimated_cost: u.totals.cost,
				total_actual_cost: u.totals.cost,
				total_sessions: u.totals.sessions,
				total_api_calls: u.totals.calls,
			},
		};
	});

	// ---- Files: read-only browsing of each bot's workspace ----
	const roots = () => workspaceRoots(core);
	const inside = (path: string) => insideWorkspace(core, path);
	r.on("GET", "/api/files", (q) => {
		const path = q.query.get("path");
		if (!path || path === "/") {
			return {
				path: "/",
				entries: roots().map(({ bot }) => ({ name: `${bot.displayName} (${bot.name})`, path: bot.workspace, is_directory: true, modified_at: statSync(bot.workspace).mtimeMs / 1000 })),
				root: "/",
			};
		}
		const { real, root } = inside(path);
		if (!statSync(real).isDirectory()) throw new HttpError(400, `${path} is not a folder`);
		const entries = readdirSync(real, { withFileTypes: true })
			.slice(0, 5000)
			.map((d) => {
				const p = join(path, d.name);
				try {
					const st = d.isSymbolicLink() ? statSync(join(real, d.name)) : lstatSync(join(real, d.name));
					return { name: d.name, path: p, is_directory: st.isDirectory(), size: st.isDirectory() ? undefined : st.size, modified_at: st.mtimeMs / 1000, mime_type: mimeOf(d.name) };
				} catch {
					return { name: d.name, path: p, is_directory: false };
				}
			})
			.sort((a, b) => Number(b.is_directory) - Number(a.is_directory) || a.name.localeCompare(b.name));
		return { path, parent: real === root.real ? "/" : dirname(path), entries, root: "/" };
	});
	r.on("GET", "/api/files/download", (q) => {
		const path = q.query.get("path");
		if (!path) throw new HttpError(400, "path is required");
		const { real } = inside(path);
		const st = statSync(real);
		if (!st.isFile()) throw new HttpError(400, `${path} is not a file`);
		if (st.size > FILE_MAX) throw new HttpError(413, `${basename(path)} is larger than ${FILE_MAX / 1024 / 1024} MB`);
		return new RawBody(readFileSync(real), mimeOf(real) ?? "application/octet-stream", basename(path));
	});
	r.on("POST", "/api/files/upload-stream", () => {
		throw new HttpError(403, "the Files tab is read-only on this gateway");
	});

	// ---- Pictures in a chat (hermes_cli/web_routers/files.py GET /api/media) ----
	// Vory finds a sent picture by the "[User attached image: <name>]" mark and asks for it under Hermes'
	// images folder (`~/.hermes/images/<name>`, `~/.hermes/profiles/<bot>/images/<name>`): here it is that
	// bot's uploads/. Any other path is served when it is a picture in a bot's workspace.
	r.on("GET", "/api/media", (q) => {
		const path = q.query.get("path");
		if (!path) throw new HttpError(400, "path is required");
		let file = path;
		const guessed = /^~\/\.hermes\/(?:profiles\/([^/]+)\/)?images\/([^/]+)$/.exec(path);
		if (guessed) {
			// The profile asked for first: on a member answering for its bot it is that bot's own name, where the
			// path still carries the name the bot has on the asking machine.
			const bot = botFor(core, q.query.get("profile") ?? guessed[1]);
			if (!bot.workspace) throw new HttpError(404, `${path} does not exist`);
			file = join(bot.workspace, "uploads", guessed[2]!);
		}
		const mime = MEDIA[extname(file).toLowerCase()];
		if (!mime) throw new HttpError(415, "only pictures are served here");
		const { real } = inside(file);
		const st = statSync(real);
		if (!st.isFile()) throw new HttpError(404, `${path} does not exist`);
		if (st.size > MEDIA_MAX) throw new HttpError(413, `${basename(path)} is larger than ${MEDIA_MAX / 1024 / 1024} MB`);
		return { path, size: st.size, mime_type: mime, data_url: `data:${mime};base64,${readFileSync(real).toString("base64")}` };
	});
}
