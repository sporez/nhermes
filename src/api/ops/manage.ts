// The gateway's own settings and upkeep (docs/API.md "Gateway"): settings, keys, scheduled tasks, logs,
// usage, the bots' files, and software updates, restart and doctor. The owner only, except that a chat's
// bot's files (sessions.file) open for the member that started the chat. Keys never come back: a value goes
// in, and only whether it is set and its last characters come out.
import { randomUUID } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { THINKING_LEVELS, type ThinkingLevel } from "../../config.ts";
import { loadAction, pruneActions, runCheck, runRestart, runUpdate, startDoctor } from "../../core/actions.ts";
import type { GatewayPatch } from "../../core/settings.ts";
import { type JobInput, type NotifyPolicy } from "../../core/scheduler.ts";
import { usageReport } from "../../core/usage.ts";
import { FILE_MAX, insideWorkspace, mimeOf, workspaceRoots } from "../../core/workspaces.ts";
import { RawBody } from "../../http.ts";
import { recentLogs } from "../../log.ts";
import { ApiError } from "../errors.ts";
import { botOf, localSession } from "../lookup.ts";
import type { Op, OpContext } from "../ops.ts";
import type { Params } from "../params.ts";
import { actionJson, gatewaySettingsJson, jobJson, keyJson, ms, runJson, softwareJson } from "../shapes/manage.ts";

const APPROVALS = ["manual", "smart", "off"] as const;

function ownerOnly(cx: OpContext): void {
	if (cx.caller.kind === "member") throw new ApiError("not_allowed", "Only the gateway's owner can do that.");
}

/** Wraps a handler so a network member is refused before it runs. */
const owner = (fn: (p: Params, cx: OpContext) => unknown | Promise<unknown>) => (p: Params, cx: OpContext) => {
	ownerOnly(cx);
	return fn(p, cx);
};

// ---- Settings ----

function settingsPatch(p: Params, cx: OpContext): GatewayPatch {
	const patch: GatewayPatch = {};
	const tz = p.optStr("timeZone");
	if (tz !== undefined) patch.timezone = tz;
	const d = p.optObject("defaults");
	if (d) {
		const defaults: NonNullable<GatewayPatch["defaults"]> = {};
		if (d.model !== undefined) {
			const ref = String(d.model);
			const i = ref.indexOf("/");
			if (i <= 0 || !cx.core.models.getModel(ref.slice(0, i), ref.slice(i + 1))) throw new ApiError("invalid_params", `There is no model ${ref} on this gateway (use provider/model).`);
			defaults.model = ref;
		}
		if (d.thinking !== undefined) {
			if (!THINKING_LEVELS.includes(d.thinking as ThinkingLevel)) throw new ApiError("invalid_params", `defaults.thinking must be one of: ${THINKING_LEVELS.join(", ")}.`);
			defaults.thinking = d.thinking as ThinkingLevel;
		}
		if (d.approvals !== undefined) {
			if (!APPROVALS.includes(d.approvals as (typeof APPROVALS)[number])) throw new ApiError("invalid_params", `defaults.approvals must be one of: ${APPROVALS.join(", ")}.`);
			defaults.approvals = d.approvals as (typeof APPROVALS)[number];
		}
		if (d.approvalTimeoutS !== undefined) {
			if (typeof d.approvalTimeoutS !== "number" || !(d.approvalTimeoutS > 0)) throw new ApiError("invalid_params", "defaults.approvalTimeoutS must be a number of seconds.");
			defaults.approvalTimeoutS = d.approvalTimeoutS;
		}
		if (d.questionTimeoutS !== undefined) {
			if (typeof d.questionTimeoutS !== "number" || !(d.questionTimeoutS > 0)) throw new ApiError("invalid_params", "defaults.questionTimeoutS must be a number of seconds.");
			defaults.questionTimeoutS = d.questionTimeoutS;
		}
		patch.defaults = defaults;
	}
	const hide = p.optList("hiddenModelProviders");
	if (hide) patch.modelLists = { hide };
	if (p.raw.groundRules === null) patch.groundRules = null;
	else if (p.has("groundRules")) patch.groundRules = p.optStr("groundRules")!;
	const r = p.optObject("review");
	if (r) {
		const review: NonNullable<GatewayPatch["review"]> = {};
		if (r.enabled !== undefined) {
			if (typeof r.enabled !== "boolean") throw new ApiError("invalid_params", "review.enabled must be true or false.");
			review.enabled = r.enabled;
		}
		for (const k of ["allowThreshold", "timeoutMs"] as const) {
			if (r[k] === undefined) continue;
			if (typeof r[k] !== "number") throw new ApiError("invalid_params", `review.${k} must be a number.`);
			review[k] = r[k];
		}
		if (r.keyEnv !== undefined) {
			if (typeof r.keyEnv !== "string" || !r.keyEnv) throw new ApiError("invalid_params", "review.keyEnv must be a key name.");
			review.keyEnv = r.keyEnv;
		}
		patch.review = review;
	}
	return patch;
}

// ---- Keys ----

function keyName(cx: OpContext, p: Params): string {
	const name = p.str("name");
	if (name === cx.core.config.tokenEnv) throw new ApiError("not_allowed", "The gateway's own token is changed in the panel's Keys tab or with nhermes, not from the app (it would lose its connection).");
	return name;
}

function keyOf(cx: OpContext, name: string) {
	const k = cx.core.secrets.list().find((s) => s.name === name);
	return k ? keyJson(cx.core, k) : { name, set: false, description: "", usedBy: [], hint: null };
}

// ---- Scheduled tasks ----

function jobPatch(p: Params): Partial<JobInput> {
	const j: Partial<JobInput> = {};
	const name = p.optStr("name");
	if (name !== undefined) j.name = name;
	const prompt = p.optStr("prompt");
	if (prompt !== undefined) j.prompt = prompt;
	const schedule = p.optStr("schedule");
	if (schedule !== undefined) j.schedule = schedule;
	const tz = p.optStr("timezone");
	if (tz !== undefined) j.timezone = tz;
	const botId = p.optStr("botId");
	if (botId !== undefined) j.bot = botId;
	const notify = p.optStr("notify");
	if (notify !== undefined) j.notify = notify as NotifyPolicy;
	const deliver = p.optStr("deliver");
	if (deliver !== undefined) j.deliver = deliver as JobInput["deliver"];
	const context = p.optStr("context");
	if (context !== undefined) j.context = context as JobInput["context"];
	const approvals = p.optStr("approvals");
	if (approvals !== undefined) j.approvals = approvals as JobInput["approvals"];
	if (p.raw.model === null) j.model = null;
	else if (p.has("model")) j.model = p.optStr("model") || null;
	const skills = p.optList("skills");
	if (skills) j.skills = skills;
	const enabled = p.optBool("enabled");
	if (enabled !== undefined) j.enabled = enabled;
	return j;
}

const job = (cx: OpContext, id: string) => jobJson(cx.core, cx.core.scheduler.require(id));

// ---- Files ----

type Entry = { name: string; path: string; isDirectory: boolean; size: number | null; modifiedAt: number | null; mime: string | null; botId?: string };

function absolute(path: string): string {
	if (!isAbsolute(path)) throw new ApiError("invalid_params", "path must be an absolute path (start from the list of workspaces).");
	return path;
}

function listFiles(p: Params, cx: OpContext) {
	const path = p.optStr("path");
	if (!path || path === "/") {
		const items: Entry[] = workspaceRoots(cx.core).map(({ bot, real }) => ({ name: `${bot.displayName} (${bot.name})`, path: bot.workspace, isDirectory: true, size: null, modifiedAt: ms(statSync(real).mtimeMs / 1000), mime: null, botId: bot.name }));
		return { path: "/", parent: null, items, nextCursor: null };
	}
	const { real, root } = insideWorkspace(cx.core, absolute(path));
	if (!statSync(real).isDirectory()) throw new ApiError("invalid_params", `${path} is not a folder.`);
	const items: Entry[] = readdirSync(real, { withFileTypes: true })
		.slice(0, 5000)
		.map((d) => {
			const entry = join(path, d.name);
			try {
				const st = d.isSymbolicLink() ? statSync(join(real, d.name)) : lstatSync(join(real, d.name));
				return { name: d.name, path: entry, isDirectory: st.isDirectory(), size: st.isDirectory() ? null : st.size, modifiedAt: ms(st.mtimeMs / 1000), mime: st.isDirectory() ? null : (mimeOf(d.name) ?? null) };
			} catch {
				return { name: d.name, path: entry, isDirectory: false, size: null, modifiedAt: null, mime: null };
			}
		})
		.sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name));
	return { path, parent: real === root.real ? "/" : dirname(path), items, nextCursor: null };
}

/** A file inside a workspace (of `botName` only, when given) as the answer: raw bytes over HTTP, base64 over the socket. */
function fileAnswer(cx: OpContext, path: string, botName?: string) {
	const { real } = insideWorkspace(cx.core, path, botName);
	const st = statSync(real);
	if (!st.isFile()) throw new ApiError("invalid_params", `${path} is not a file.`);
	if (st.size > FILE_MAX) throw new ApiError("too_large", `${basename(path)} is larger than ${FILE_MAX / 1024 / 1024} MB.`);
	const data = readFileSync(real);
	const mime = mimeOf(real) ?? "application/octet-stream";
	return cx.request ? new RawBody(data, mime, basename(real)) : { name: basename(real), mime, data: data.toString("base64") };
}

// ---- Actions ----

const ACTION_KINDS = ["check", "update", "restart", "doctor"] as const;

function startAction(p: Params, cx: OpContext) {
	const kind = p.optEnum("kind", ACTION_KINDS);
	if (!kind) throw new ApiError("invalid_params", `kind is required: ${ACTION_KINDS.join(", ")}.`);
	const id = randomUUID();
	const name = `run.${id}`;
	pruneActions(cx.core);
	if (kind === "doctor") {
		const { record } = startDoctor(cx.core, name, kind);
		return { action: actionJson(id, record) };
	}
	const record = kind === "check" ? runCheck(cx.core, name, kind) : kind === "update" ? runUpdate(cx.core, name, kind) : runRestart(cx.core, name, kind);
	return { action: actionJson(id, record) };
}

export const manageOps: Op[] = [
	{ name: "gateway.settings", http: "GET /gateway/settings", handle: owner((_p, cx) => gatewaySettingsJson(cx.core)) },
	{
		name: "gateway.updateSettings",
		http: "PATCH /gateway/settings",
		handle: owner((p, cx) => {
			const { restartNeeded } = cx.core.settings.setGateway(settingsPatch(p, cx));
			return { settings: gatewaySettingsJson(cx.core), restartNeeded };
		}),
	},
	{
		name: "gateway.logs",
		http: "GET /gateway/logs",
		handle: owner((p) => ({ lines: recentLogs(p.optInt("lines", { min: 1, max: 500 }) ?? 200) })),
	},
	{
		name: "gateway.usage",
		http: "GET /gateway/usage",
		handle: owner(async (p, cx) => {
			const days = p.optInt("days", { min: 1, max: 366 }) ?? 30;
			const botId = p.optStr("botId");
			const bots = botId ? [botOf(cx, botId)] : cx.core.bots.list().filter((b) => !b.isPeer);
			// A member's bot keeps its chats on its own machine: nothing to count here.
			return usageReport(cx.core, bots.filter((b) => !b.remote).map((b) => b.name), days);
		}),
	},
	{ name: "keys.list", http: "GET /keys", handle: owner((_p, cx) => ({ items: cx.core.secrets.list().map((k) => keyJson(cx.core, k)), nextCursor: null })) },
	{
		name: "keys.set",
		http: "PUT /keys/:name",
		handle: owner((p, cx) => {
			const name = keyName(cx, p);
			const { restartNeeded } = cx.core.secrets.set(name, p.optStr("value") ?? "");
			return { key: keyOf(cx, name), restartNeeded };
		}),
	},
	{
		name: "keys.delete",
		http: "DELETE /keys/:name",
		handle: owner((p, cx) => {
			const name = keyName(cx, p);
			const { restartNeeded } = cx.core.secrets.remove(name);
			return { key: keyOf(cx, name), restartNeeded };
		}),
	},
	{
		name: "jobs.list",
		http: "GET /jobs",
		handle: owner((p, cx) => {
			const botId = p.optStr("botId");
			const jobs = cx.core.scheduler.list(botId ? botOf(cx, botId).name : undefined);
			return { items: jobs.map((j) => jobJson(cx.core, j)), nextCursor: null };
		}),
	},
	{ name: "jobs.get", http: "GET /jobs/:id", handle: owner((p, cx) => ({ job: job(cx, p.str("id")) })) },
	{
		name: "jobs.create",
		http: "POST /jobs",
		handle: owner((p, cx) => {
			const patch = jobPatch(p);
			const bot = patch.bot ?? botOf(cx, undefined).name;
			const created = cx.core.scheduler.create({ ...patch, bot, name: p.str("name"), prompt: p.str("prompt"), schedule: p.str("schedule") });
			return { job: job(cx, created.id) };
		}),
	},
	{
		name: "jobs.update",
		http: "PATCH /jobs/:id",
		handle: owner((p, cx) => {
			const updated = cx.core.scheduler.update(p.str("id"), jobPatch(p));
			return { job: job(cx, updated.id) };
		}),
	},
	{
		name: "jobs.delete",
		http: "DELETE /jobs/:id",
		handle: owner((p, cx) => {
			const id = cx.core.scheduler.require(p.str("id")).id;
			cx.core.scheduler.delete(id);
			return { deleted: true, id };
		}),
	},
	{
		name: "jobs.runs",
		http: "GET /jobs/:id/runs",
		handle: owner((p, cx) => {
			const j = cx.core.scheduler.require(p.str("id"));
			return { items: cx.core.scheduler.runs(j.id, p.optInt("limit", { min: 1, max: 200 }) ?? 20).map((r) => runJson(r, j)), nextCursor: null };
		}),
	},
	{
		// Answers once the run has started; the app follows `jobs.changed` events for the rest.
		name: "jobs.run",
		http: "POST /jobs/:id/run",
		handle: owner(async (p, cx) => {
			const j = cx.core.scheduler.require(p.str("id"));
			const run = await cx.core.scheduler.trigger(j.id);
			return { run: runJson(run, cx.core.scheduler.require(j.id)) };
		}),
	},
	{
		name: "jobs.pause",
		http: "POST /jobs/:id/pause",
		handle: owner((p, cx) => ({ job: job(cx, cx.core.scheduler.setEnabled(p.str("id"), false).id) })),
	},
	{
		name: "jobs.resume",
		http: "POST /jobs/:id/resume",
		handle: owner((p, cx) => ({ job: job(cx, cx.core.scheduler.setEnabled(p.str("id"), true).id) })),
	},
	{ name: "files.list", http: "GET /files", handle: owner(listFiles) },
	{ name: "files.content", http: "GET /files/content", handle: owner((p, cx) => fileAnswer(cx, absolute(p.str("path")))) },
	{
		// A file of the chat's bot's workspace (a picture a reply names). The member that started the chat may open it too.
		name: "sessions.file",
		http: "GET /sessions/:id/files/content",
		members: true,
		forward: true,
		remote: async (p, cx, row) => {
			const r = (await cx.core.memberChats.forward(row, "sessions.file", { path: p.str("path") })) as { name: string; mime: string; data: string };
			return cx.request ? new RawBody(Buffer.from(r.data, "base64"), r.mime, r.name) : r;
		},
		handle: (p, cx) => {
			const row = localSession(cx, p.str("id"));
			const bot = cx.core.bots.get(row.bot);
			if (!bot?.workspace || bot.isPeer) throw new ApiError("not_found", "This chat's bot has no workspace here.");
			const path = p.str("path");
			return fileAnswer(cx, isAbsolute(path) ? path : join(bot.workspace, path), row.bot);
		},
	},
	{ name: "software.status", http: "GET /software", handle: owner((_p, cx) => softwareJson(cx.core, cx.core.updates.status())) },
	{ name: "actions.start", http: "POST /actions", handle: owner(startAction) },
	{
		name: "actions.get",
		http: "GET /actions/:id",
		handle: owner((p, cx) => {
			const id = p.str("id");
			const a = loadAction(cx.core, `run.${id}`);
			if (!a) throw new ApiError("not_found", `No action with id ${id}.`);
			return { action: actionJson(id, a) };
		}),
	},
];
