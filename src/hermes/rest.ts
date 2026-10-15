// Hermes-compatible REST endpoints, translated onto the core services. Routes we do not implement are
// absent (404), so Vory's own capability checks hide those features.
import type { Core } from "../app.ts";
import type { Bot } from "../core/bots.ts";
import { THINKING_LEVELS } from "../config.ts";
import { GROUP_LABELS } from "../tools/index.ts";
import { LinkError } from "../federation/link.ts";
import { HttpError, obj, type Req, Router } from "./http.ts";
import { JobError, type JobInput } from "../core/scheduler.ts";
import { VoryPushError } from "../notify/vory.ts";
import { cronJobJson, cronRunJson, profileJson, storedSession, VERSION } from "./shapes.ts";

function botFor(core: Core, profile: string | null | undefined) {
	if (!profile || profile === "current" || (profile === "default" && !core.bots.get("default"))) return core.bots.defaultBot();
	const bot = core.bots.get(profile);
	if (!bot || (bot.isPeer && !bot.remote)) throw new HttpError(404, `Profile '${profile}' not found`);
	return bot;
}

/** A member's bot is changed on its own machine. */
function localOnly(bot: Bot): void {
	if (bot.remote) throw new HttpError(409, `${bot.displayName} belongs to ${bot.remote.node}; change it there`);
}

/** A member that cannot be reached answers 502 with the reason. */
async function proxyCall<T>(fn: () => Promise<T>): Promise<T> {
	try {
		return await fn();
	} catch (error) {
		if (error instanceof LinkError) throw new HttpError(error.code === 4004 ? 404 : 502, error.message);
		throw error;
	}
}

function intParam(q: URLSearchParams, key: string, def: number, max: number): number {
	const raw = q.get(key);
	if (raw === null) return def;
	const n = Number(raw);
	if (!Number.isInteger(n) || n < 0) throw new HttpError(422, `${key} must be a non-negative integer`);
	if (n > max) throw new HttpError(422, `${key} must be less than or equal to ${max}`);
	return n;
}

/** Models offered in pickers: hidden providers left out, except the model already in use. */
export async function pickableModels(core: Core, current?: { provider: string; modelId: string }) {
	const hide = new Set(core.config.modelLists.hide);
	return (await core.models.getAvailable()).filter((m) => !hide.has(m.provider) || (m.provider === current?.provider && m.id === current?.modelId));
}

export async function modelOptions(core: Core, current?: { provider: string; modelId: string }) {
	const available = await pickableModels(core, current);
	const byProvider = new Map<string, typeof available[number][]>();
	for (const m of available) {
		const list = byProvider.get(m.provider) ?? [];
		list.push(m);
		byProvider.set(m.provider, list);
	}
	const providers = [...byProvider.entries()].map(([slug, list]) => {
		const p = core.models.getProvider(slug) as { name?: string } | undefined;
		const capabilities: Record<string, { reasoning: boolean; fast: boolean; can_disable_reasoning: boolean }> = {};
		for (const m of list) capabilities[m.id] = { reasoning: m.reasoning === true, fast: false, can_disable_reasoning: m.reasoning === true };
		return {
			slug,
			name: p?.name ?? slug,
			models: list.map((m) => m.id),
			featured_models: list.slice(0, 6).map((m) => m.id),
			authenticated: true,
			is_current: current?.provider === slug,
			capabilities,
		};
	});
	return { providers, model: current?.modelId ?? null, provider: current?.provider ?? null };
}

export function restRoutes(core: Core): Router {
	const r = new Router();
	const { sessions, bots } = core;

	const listRow = (id: string) => {
		const row = sessions.require(id);
		const bot = bots.get(row.bot);
		return storedSession(row, bot ? bot.model.modelId : "", sessions.isRunning(id));
	};

	r.on("GET", "/api/status", () => ({
		version: VERSION,
		release_date: "",
		gateway_running: true,
		gateway_state: "running",
		active_sessions: sessions.runningCount(),
		active_agents: sessions.runningCount(),
		auth_required: false,
		auth_providers: [],
		auth_flows: [],
		profiles: bots.names(),
		gateway_mode: "single",
	}));
	r.on("GET", "/api/health", () => ({ ok: true, version: VERSION, auth_required: false }));

	// Bots (profiles)
	r.on("GET", "/api/profiles", () => ({
		profiles: bots
			.list()
			.filter((b) => !b.isPeer || b.remote)
			.map((b) => profileJson(b, b.remote ? 0 : core.skills.catalog(b).filter((s) => s.active).length)),
	}));
	r.on("GET", "/api/profiles/active", () => ({ active: bots.defaultBot().name, current: bots.defaultBot().name }));
	r.on("GET", "/api/profiles/:name/soul", (q) => {
		const bot = botFor(core, q.params.name);
		return { content: bot.instructions, exists: !bot.remote };
	});
	r.on("PUT", "/api/profiles/:name/soul", (q) => {
		const content = obj(q.body).content;
		if (typeof content !== "string") throw new HttpError(422, "content is required");
		const bot = botFor(core, q.params.name);
		localOnly(bot);
		bots.setOverrides(bot.name, { instructions: content });
		return { ok: true };
	});
	r.on("PUT", "/api/profiles/:name/description", (q) => {
		const d = obj(q.body).description;
		const bot = botFor(core, q.params.name);
		localOnly(bot);
		bots.setOverrides(bot.name, { description: typeof d === "string" ? d : "" });
		return { ok: true };
	});
	r.on("PUT", "/api/profiles/:name/model", (q) => {
		const b = obj(q.body);
		const provider = typeof b.provider === "string" ? b.provider : "";
		const model = typeof b.model === "string" ? b.model : "";
		const bot = botFor(core, q.params.name);
		localOnly(bot);
		if (!core.models.getModel(provider, model)) throw new HttpError(400, `Unknown model ${provider}/${model}`);
		bots.setOverrides(bot.name, { model: `${provider}/${model}` });
		return { ok: true, provider, model };
	});

	// Sessions
	r.on("GET", "/api/sessions", (q) => {
		const bot = botFor(core, q.query.get("profile"));
		const limit = intParam(q.query, "limit", 20, 100);
		const offset = intParam(q.query, "offset", 0, 1_000_000);
		const archived = (q.query.get("archived") ?? "exclude") as "exclude" | "only" | "include";
		if (!["exclude", "only", "include"].includes(archived)) throw new HttpError(400, "archived must be one of: exclude, only, include");
		const order = (q.query.get("order") ?? "created") as "recent" | "created";
		if (!["recent", "created"].includes(order)) throw new HttpError(400, "order must be one of: created, recent");
		const { rows, total } = sessions.list(bot.name, { limit, offset, archived, order });
		return { sessions: rows.map((row) => listRow(row.id)), total, limit, offset };
	});
	r.on("GET", "/api/sessions/search", (q) => {
		const bot = botFor(core, q.query.get("profile"));
		const term = (q.query.get("q") ?? "").trim();
		const { rows } = sessions.list(bot.name, { limit: 50, offset: 0, archived: "include", order: "recent", search: term || undefined });
		return { sessions: rows.map((row) => listRow(row.id)) };
	});
	r.on("GET", "/api/sessions/stats", (q) => {
		const bot = botFor(core, q.query.get("profile"));
		const all = sessions.list(bot.name, { limit: 1, offset: 0, archived: "include", order: "recent" }).total;
		const archived = sessions.list(bot.name, { limit: 1, offset: 0, archived: "only", order: "recent" }).total;
		return { total: all, active_store: all - archived, archived };
	});
	const owned = (q: Req) => {
		const row = sessions.get(q.params.id!);
		const bot = botFor(core, q.query.get("profile") ?? (obj(q.body).profile as string | undefined));
		if (!row || row.bot !== bot.name) throw new HttpError(404, "Session not found");
		return row;
	};
	r.on("GET", "/api/sessions/:id", (q) => {
		const row = owned(q);
		return { ...listRow(row.id), is_default_profile: bots.get(row.bot)?.isDefault ?? false };
	});
	r.on("GET", "/api/sessions/:id/messages", async (q) => {
		const row = owned(q);
		const all = row.remote_node ? await proxyCall(() => core.proxy.messages(row)) : await sessions.rows(row.id);
		const limit = Math.min(intParam(q.query, "limit", 500, 100_000), 500);
		const offset = intParam(q.query, "offset", 0, 1_000_000);
		const order = q.query.get("order") ?? (q.query.has("limit") ? "oldest" : "latest");
		const page = order === "latest" ? all.slice(Math.max(0, all.length - offset - limit), all.length - offset) : all.slice(offset, offset + limit);
		return { session_id: row.id, profile: row.bot, messages: page, pagination: { limit, offset, order, returned: page.length } };
	});
	r.on("PATCH", "/api/sessions/:id", (q) => {
		const row = owned(q);
		const b = obj(q.body);
		if (b.title === undefined && b.archived === undefined && b.pinned === undefined && b.hidden === undefined && b.unread === undefined) {
			throw new HttpError(400, "Nothing to update; provide 'title', 'archived', 'pinned'.");
		}
		const updated = sessions.update(row.id, {
			title: typeof b.title === "string" ? b.title : undefined,
			archived: typeof b.archived === "boolean" ? b.archived : undefined,
			pinned: typeof b.pinned === "boolean" ? b.pinned : undefined,
		});
		return { ok: true, title: updated.title, archived: updated.archived === 1, pinned: updated.pinned === 1 };
	});
	r.on("DELETE", "/api/sessions/:id", async (q) => {
		const row = sessions.get(q.params.id!);
		if (!row) return { ok: true, already_absent: true };
		await sessions.delete(row.id);
		return { ok: true };
	});

	// Skills: per bot, `enabled` means active for that bot.
	r.on("GET", "/api/skills", (q) => {
		const bot = botFor(core, q.query.get("profile"));
		if (bot.remote) return [];
		const usage = core.skills.usage(bot.name);
		return core.skills.catalog(bot).map((s) => ({
			name: s.name,
			description: s.description,
			category: s.source === "bot" ? bot.name : "global",
			enabled: s.active,
			usage: usage.get(s.name) ?? 0,
			provenance: s.source === "bot" ? "agent" : "local",
		}));
	});
	r.on("PUT", "/api/skills/toggle", (q) => {
		const b = obj(q.body);
		const bot = botFor(core, (typeof b.profile === "string" && b.profile) || q.query.get("profile"));
		localOnly(bot);
		const name = typeof b.name === "string" ? b.name : "";
		if (!core.skills.catalog(bot).some((s) => s.name === name)) throw new HttpError(404, `Skill '${name}' not found`);
		core.skills.setEnabled(core.bots, bot, name, b.enabled === true);
		return { ok: true, name, enabled: b.enabled === true };
	});

	// Scheduled tasks (Vory's cron screens). The job reply after "trigger" is held while the run goes, as
	// Hermes does, up to 25 s (Vory's request timeout is 30 s); a longer run answers with state "running".
	const { scheduler } = core;
	const jobJson = (id: string) => {
		const job = scheduler.require(id);
		return cronJobJson(job, scheduler.lastRun(job.id), scheduler.isRunning(job.id));
	};
	const jobErrors = <T>(fn: () => T): T => {
		try {
			return fn();
		} catch (error) {
			if (error instanceof JobError) throw new HttpError(error.status, error.message);
			throw error;
		}
	};
	const jobPatch = (raw: Record<string, unknown>): Partial<JobInput> => {
		const p: Partial<JobInput> = {};
		const s = (k: string) => (typeof raw[k] === "string" ? (raw[k] as string) : undefined);
		if (s("name") !== undefined) p.name = s("name");
		if (s("prompt") !== undefined) p.prompt = s("prompt");
		if (s("schedule") !== undefined) p.schedule = s("schedule");
		if (s("timezone") !== undefined) p.timezone = s("timezone");
		if (s("profile") !== undefined || s("bot") !== undefined) p.bot = s("bot") ?? s("profile");
		if (s("notify") !== undefined) p.notify = s("notify") as JobInput["notify"];
		if (s("deliver") !== undefined && ["session", "chat"].includes(s("deliver")!)) p.deliver = s("deliver") as JobInput["deliver"];
		if (s("context") !== undefined) p.context = s("context") as JobInput["context"];
		if (s("approvals") !== undefined) p.approvals = s("approvals") as JobInput["approvals"];
		if ("model" in raw && (raw.model === null || typeof raw.model === "string")) p.model = (raw.model as string | null) || null;
		if (Array.isArray(raw.skills)) p.skills = raw.skills.filter((x): x is string => typeof x === "string");
		if (typeof raw.enabled === "boolean") p.enabled = raw.enabled;
		return p;
	};
	r.on("GET", "/api/cron/jobs", (q) => {
		const profile = q.query.get("profile");
		const jobs = scheduler.list(profile && profile !== "all" ? botFor(core, profile).name : undefined);
		return { jobs: jobs.map((j) => jobJson(j.id)), count: jobs.length };
	});
	r.on("POST", "/api/cron/jobs", (q) => {
		const b = obj(q.body);
		const patch = jobPatch(b);
		const bot = patch.bot ?? botFor(core, q.query.get("profile")).name;
		const job = jobErrors(() =>
			scheduler.create({ ...patch, bot, name: patch.name ?? "", prompt: patch.prompt ?? "", schedule: patch.schedule ?? "" } as JobInput),
		);
		return jobJson(job.id);
	});
	r.on("GET", "/api/cron/jobs/:id", (q) => jobErrors(() => jobJson(q.params.id!)));
	r.on("GET", "/api/cron/jobs/:id/runs", (q) => {
		const job = jobErrors(() => scheduler.require(q.params.id!));
		const limit = intParam(q.query, "limit", 20, 200);
		return { runs: scheduler.runs(job.id, limit).map((run) => cronRunJson(run, job)) };
	});
	r.on("PUT", "/api/cron/jobs/:id", (q) => {
		const b = obj(q.body);
		const updates = obj(b.updates ?? b);
		jobErrors(() => scheduler.update(q.params.id!, jobPatch(updates)));
		return jobJson(q.params.id!);
	});
	r.on("POST", "/api/cron/jobs/:id/pause", (q) => (jobErrors(() => scheduler.setEnabled(q.params.id!, false)), jobJson(q.params.id!)));
	r.on("POST", "/api/cron/jobs/:id/resume", (q) => (jobErrors(() => scheduler.setEnabled(q.params.id!, true)), jobJson(q.params.id!)));
	r.on("POST", "/api/cron/jobs/:id/trigger", async (q) => {
		const run = await (async () => {
			try {
				return await scheduler.trigger(q.params.id!);
			} catch (error) {
				if (error instanceof JobError) throw new HttpError(error.status, error.message);
				throw error;
			}
		})();
		await scheduler.waitRun(run.id, 25_000);
		return jobJson(q.params.id!);
	});
	r.on("DELETE", "/api/cron/jobs/:id", (q) => (jobErrors(() => scheduler.delete(q.params.id!)), { ok: true }));

	// Models
	r.on("GET", "/api/model/options", async (q) => {
		const bot = botFor(core, q.query.get("profile"));
		if (bot.remote) return proxyCall(() => core.proxy.forBot(bot, "model.options", {}));
		return modelOptions(core, bot.model);
	});

	// Configuration: the settings that exist here, read-only over REST (edit config.yaml or use the CLI).
	r.on("GET", "/api/config", () => {
		const def = bots.defaultBot();
		return {
			config: {
				model: `${def.model.provider}/${def.model.modelId}`,
				approvals: { mode: def.approvals.mode, timeout: core.config.defaults.approvalTimeoutS },
				agent: { reasoning_effort: def.thinking },
				timezone: core.config.timezone,
			},
		};
	});
	r.on("GET", "/api/config/schema", () => ({
		fields: {
			model: { type: "string", description: "Default model of the default bot (provider/model)", category: "general" },
			"approvals.mode": { type: "select", description: "Dangerous action approval mode", category: "security", options: ["manual", "smart", "off"] },
			"approvals.timeout": { type: "number", description: "Seconds before an unanswered approval is denied", category: "security" },
			"agent.reasoning_effort": { type: "select", description: "Reasoning effort", category: "agent", options: [...THINKING_LEVELS] },
			timezone: { type: "string", description: "Time zone for schedules", category: "general" },
		},
		category_order: ["general", "agent", "security"],
	}));
	// The gateway's keys, read-only and redacted (they are managed in the panel or with `nhermes secret`).
	r.on("GET", "/api/env", () => {
		const out: Record<string, unknown> = {};
		for (const sec of core.secrets.list()) {
			const v = process.env[sec.name];
			const provider = sec.usedBy.find((u) => u.startsWith("models: "))?.slice(8) ?? null;
			out[sec.name] = {
				is_set: sec.set,
				redacted_value: v ? `«redacted:…${v.slice(-4)}»` : null,
				description: sec.description,
				category: provider ? "LLM Providers" : "Gateway",
				is_password: true,
				provider,
			};
		}
		return out;
	});
	r.on("GET", "/api/tools/toolsets", (q) => {
		const bot = botFor(core, q.query.get("profile"));
		if (bot.remote) return [];
		return [...core.toolGroups.entries()].map(([name, tools]) => ({
			name,
			label: GROUP_LABELS[name]?.label ?? name,
			description: GROUP_LABELS[name]?.description ?? "",
			platform: "gateway",
			enabled: bot.toolGroups.includes(name),
			configured: true,
			tools: tools.map((t) => t.name),
		}));
	});

	// Vory's notification Companion: its files only (devices, markers, plugin), kept by core.vory. The
	// Files browser stays absent (GET /api/files is 404), so Vory keeps that tab hidden.
	const voryFiles = <T>(fn: () => T): T => {
		try {
			return fn();
		} catch (error) {
			if (error instanceof VoryPushError) throw new HttpError(error.status, error.message);
			throw error;
		}
	};
	const pathOf = (v: unknown) => {
		if (typeof v !== "string" || !v.startsWith("/")) throw new HttpError(400, "path must be absolute");
		return v;
	};
	r.on("GET", "/api/files", () => {
		throw new HttpError(404, "Not Found");
	});
	r.on("POST", "/api/files/upload", (q) => {
		const b = obj(q.body);
		const path = pathOf(b.path);
		const m = typeof b.data_url === "string" ? /^data:[^,]*;base64,(.*)$/s.exec(b.data_url) : null;
		if (!m) throw new HttpError(400, "data_url must be a base64 data URL");
		voryFiles(() => core.vory.write(path, Buffer.from(m[1]!, "base64")));
		return { ok: true, path };
	});
	r.on("GET", "/api/files/read", (q) => {
		const path = pathOf(q.query.get("path"));
		const data = core.vory.read(path);
		if (!data) throw new HttpError(404, "File not found");
		const mime = path.endsWith(".json") ? "application/json" : "text/plain";
		return { path, size: data.length, data_url: `data:${mime};base64,${data.toString("base64")}` };
	});
	r.on("DELETE", "/api/files", (q) => {
		const b = obj(q.body);
		const path = pathOf(b.path ?? q.query.get("path"));
		voryFiles(() => core.vory.remove(path, b.recursive === true));
		return { ok: true };
	});
	r.on("POST", "/api/dashboard/agent-plugins/:name/:action", (q) => {
		if (q.params.name !== "vory-push" || !["enable", "disable"].includes(q.params.action!)) throw new HttpError(404, "Not Found");
		return q.params.action === "enable" ? core.vory.enable() : core.vory.disable();
	});

	return r;
}
