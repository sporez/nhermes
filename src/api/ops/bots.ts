// Bots' settings (docs/API.md "Bot settings"): creating, editing and removing bots, their skills, approval
// rules and system prompt, the tool groups, and the gateway's MCP servers. All owner-only. A member's bot
// is edited on its own machine through /federation/manage (src/federation/manage.ts), when that machine's
// owner allows it; that machine's answers are shaped here the same as this gateway's own.
import type { BotConfig } from "../../config.ts";
import type { Bot } from "../../core/bots.ts";
import { BOT_NAME, BOT_NAME_RULE, cloneEntry } from "../../core/bot-entry.ts";
import type { BotPatch } from "../../core/settings.ts";
import { manageCall, manageWrite } from "../../federation/manage-client.ts";
import { MEMBER_BOT_KEYS } from "../../federation/manage.ts";
import { mcpAction, mcpDetail, mcpList, mcpPatch, mcpServerView, setBotMcp } from "../../mcp/manage.ts";
import { editorView, promptView, skillsView } from "../../panel/views.ts";
import { ApiError } from "../errors.ts";
import { botOf } from "../lookup.ts";
import type { Op, OpContext } from "../ops.ts";
import type { Params } from "../params.ts";
import { botJson } from "../shapes/chat.ts";
import { choicesJson, type EditorEntry, mcpJson, settingsJson, toolGroupsJson } from "../shapes/bots.ts";

/** Every setting of a bot's config entry the owner may change on this machine. */
const LOCAL_KEYS = [...MEMBER_BOT_KEYS, "soulFile", "workspace", "host", "secrets", "browser", "desktop", "openchamber"];
const MAX_RULE = 1000;

const member = (bot: Bot) => bot.remote!;
const botPath = (bot: Bot, tail = "") => `/federation/manage/bots/${encodeURIComponent(member(bot).bot)}${tail}`;
/** Reads the member answers without its edit switch (src/federation/manage.ts `/federation/read/*`). */
const readPath = (bot: Bot, tail: string) => `/federation/read/bots/${encodeURIComponent(member(bot).bot)}${tail}`;

/** The bot an `id` names, owner only (a network member never reaches these). */
function target(p: Params, cx: OpContext, key = "id"): Bot {
	return botOf(cx, p.str(key));
}

function localOnly(bot: Bot, what: string): void {
	if (bot.remote) throw new ApiError("not_available", `${what} are kept on ${bot.remote.node}.`);
}

/** The settings in a request, by name, for the keys given. */
function fieldsOf(p: Params, keys: readonly string[]): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const k of keys) if (p.raw[k] !== undefined) out[k] = p.raw[k];
	return out;
}

function checkModel(cx: OpContext, fields: Record<string, unknown>): void {
	const m = fields.model;
	if (m === undefined || m === null) return;
	const i = typeof m === "string" ? m.indexOf("/") : -1;
	if (typeof m !== "string" || i <= 0 || !cx.core.models.getModel(m.slice(0, i), m.slice(i + 1))) throw new ApiError("invalid_params", `There is no model ${String(m)} on this gateway (use provider/id).`);
}

/** A member's editor entry for one of its bots, with its choices. */
async function memberEditor(cx: OpContext, bot: Bot) {
	const r = await manageCall<{ toolGroups: string[]; models: string[]; spaces: string[]; bots: EditorEntry[] }>(cx.core, member(bot).node, "GET", "/federation/manage", undefined, 10_000);
	const entry = r.bots.find((b) => b.name === member(bot).bot);
	if (!entry) throw new ApiError("bot_not_found", `${member(bot).node} has no bot named ${member(bot).bot}.`);
	return { entry, choices: r };
}

function refreshed(cx: OpContext, bot: Bot) {
	return botJson(cx.core, cx.core.bots.get(bot.name) ?? bot);
}

/** The network member a call names with `node`; none (or this gateway's own name) is this gateway. */
function memberNode(p: Params, cx: OpContext): string | undefined {
	const node = p.optStr("node")?.trim();
	if (!node || node === cx.core.members.self().name) return undefined;
	if (!cx.core.members.byName(node)) throw new ApiError("not_found", `There is no machine named ${node} in this gateway's network.`);
	return node;
}

/** This gateway and its network members, for choosing where a new bot runs. */
function machinesOf(cx: OpContext) {
	return [{ name: cx.core.members.self().name, self: true, online: true }, ...cx.core.members.list().map((m) => ({ name: m.name, self: false, online: m.reachable }))];
}

async function choices(p: Params, cx: OpContext) {
	const node = memberNode(p, cx);
	if (node) {
		const r = await manageCall<Parameters<typeof choicesJson>[2]>(cx.core, node, "GET", "/federation/manage", undefined, 10_000);
		return choicesJson(node, machinesOf(cx), r, [...MEMBER_BOT_KEYS]);
	}
	return choicesJson(cx.core.members.self().name, machinesOf(cx), await editorView(cx.core), LOCAL_KEYS);
}

/** A new bot on a network member, made there with the settings members may give it. */
async function createOnMember(p: Params, cx: OpContext, node: string, name: string) {
	if (p.optStr("cloneFrom")) throw new ApiError("invalid_params", "cloneFrom works only for a bot on this gateway.");
	const other = LOCAL_KEYS.filter((k) => !MEMBER_BOT_KEYS.has(k) && p.raw[k] !== undefined);
	if (other.length > 0) throw new ApiError("invalid_params", `${other.join(", ")} can be set only on ${node}, in its own settings.`);
	const fields = fieldsOf(p, [...MEMBER_BOT_KEYS]);
	for (const [k, v] of Object.entries(fields)) if (v === null) delete fields[k];
	await manageWrite(cx.core, node, "POST", "/federation/manage/bots", { ...fields, name });
	// A private bot is not shared, so it is not listed here.
	const bot = cx.core.bots.list().find((b) => b.remote?.node === node && b.remote.bot === name);
	return { bot: bot ? botJson(cx.core, bot) : null };
}

async function create(p: Params, cx: OpContext) {
	const name = p.str("name").trim();
	if (!BOT_NAME.test(name)) throw new ApiError("invalid_params", `name: ${BOT_NAME_RULE}.`);
	const node = memberNode(p, cx);
	if (node) return createOnMember(p, cx, node, name);
	let entry: BotConfig = { name };
	const from = p.optStr("cloneFrom");
	if (from) {
		const source = botOf(cx, from);
		localOnly(source, "Settings to copy");
		entry = cloneEntry(source, name);
	}
	const fields = fieldsOf(p, LOCAL_KEYS);
	for (const [k, v] of Object.entries(fields)) if (v === null) delete fields[k];
	checkModel(cx, fields);
	cx.core.settings.addBot({ ...entry, ...fields, name } as BotConfig);
	return { bot: botJson(cx.core, cx.core.bots.get(name)!) };
}

async function update(p: Params, cx: OpContext) {
	const bot = target(p, cx);
	if (bot.remote) {
		const other = LOCAL_KEYS.filter((k) => !MEMBER_BOT_KEYS.has(k) && p.raw[k] !== undefined);
		if (other.length > 0) throw new ApiError("invalid_params", `${other.join(", ")} change only on ${bot.remote.node}, in its own settings.`);
		const body = fieldsOf(p, [...MEMBER_BOT_KEYS]);
		if (Object.keys(body).length === 0) throw new ApiError("invalid_params", "Nothing to change.");
		await manageWrite(cx.core, bot.remote.node, "PATCH", botPath(bot), body);
		return { bot: refreshed(cx, bot) };
	}
	const fields = fieldsOf(p, LOCAL_KEYS);
	if (Object.keys(fields).length === 0) throw new ApiError("invalid_params", "Nothing to change.");
	checkModel(cx, fields);
	cx.core.settings.editBot(bot.name, fields as BotPatch);
	return { bot: refreshed(cx, bot) };
}

async function remove(p: Params, cx: OpContext) {
	const bot = target(p, cx);
	if (bot.remote) {
		try {
			await manageWrite(cx.core, bot.remote.node, "DELETE", botPath(bot), {});
		} catch (error) {
			if (error instanceof ApiError || !(error instanceof Error) || !/default/.test(error.message)) throw error;
			throw new ApiError("conflict", error.message);
		}
		return { deleted: true };
	}
	if (bot.isDefault) throw new ApiError("conflict", "The default bot cannot be removed; make another bot the default first.");
	cx.core.settings.removeBot(bot.name);
	return { deleted: true };
}

async function settings(p: Params, cx: OpContext) {
	const bot = target(p, cx);
	if (bot.remote) {
		const { entry, choices } = await memberEditor(cx, bot);
		return settingsJson(bot.name, entry, choices, [...MEMBER_BOT_KEYS]);
	}
	const view = await editorView(cx.core);
	const entry = view.bots.find((b) => b.name === bot.name);
	if (!entry) throw new ApiError("bot_not_found", `No bot with id ${bot.name}.`);
	return settingsJson(bot.name, entry, view, LOCAL_KEYS);
}

async function skills(p: Params, cx: OpContext) {
	const bot = target(p, cx);
	const v = bot.remote ? await manageCall<ReturnType<typeof skillsView>>(cx.core, bot.remote.node, "GET", readPath(bot, "/skills")) : skillsView(cx.core, bot);
	return { items: v.skills, toolGroupOn: v.toolGroupOn, allGlobal: v.allGlobal };
}

async function setSkill(p: Params, cx: OpContext) {
	const bot = target(p, cx);
	const name = p.str("name");
	const enabled = p.optBool("enabled");
	if (enabled === undefined) throw new ApiError("invalid_params", "enabled is required.");
	let items: ReturnType<typeof skillsView>["skills"];
	if (bot.remote) {
		await manageCall(cx.core, bot.remote.node, "PUT", botPath(bot, `/skills/${encodeURIComponent(name)}`), { enabled });
		items = (await manageCall<ReturnType<typeof skillsView>>(cx.core, bot.remote.node, "GET", readPath(bot, "/skills"))).skills;
	} else {
		cx.core.skills.setEnabled(cx.core.bots, bot, name, enabled);
		items = skillsView(cx.core, bot).skills;
	}
	const skill = items.find((s) => s.name === name);
	if (!skill) throw new ApiError("not_found", `No skill named ${name}.`);
	return { skill };
}

async function prompt(p: Params, cx: OpContext) {
	const bot = target(p, cx);
	const v = bot.remote ? await manageCall<Awaited<ReturnType<typeof promptView>>>(cx.core, bot.remote.node, "GET", readPath(bot, "/prompt")) : await promptView(cx.core, bot);
	return { prompt: v };
}

function ruleOf(p: Params): string {
	const rule = p.str("rule").trim();
	if (!rule) throw new ApiError("invalid_params", "rule is required.");
	if (rule.length > MAX_RULE) throw new ApiError("invalid_params", `rule must be at most ${MAX_RULE} characters.`);
	return rule;
}

const rulesOf = (cx: OpContext, bot: Bot) => cx.core.approvals.rules(`bot:${bot.name}`).map((rule) => ({ rule }));

/** The bot an MCP call is about, when it names a member's: its machine answers. Without `botId`, this gateway. */
function mcpTarget(p: Params, cx: OpContext, key = "botId"): Bot | undefined {
	const id = p.optStr(key);
	if (!id) return undefined;
	const bot = botOf(cx, id);
	return bot.remote ? bot : undefined;
}

/** The name `enabledForBot` is about, on the machine that owns the server: the named bot's own name there. */
function botNameOf(p: Params, cx: OpContext): string | undefined {
	const id = p.optStr("botId");
	if (!id) return undefined;
	const bot = botOf(cx, id);
	return bot.remote ? bot.remote.bot : bot.name;
}

/** The fields of an MCP server in a request: its settings only (not the ids that route the call). */
function mcpFields(p: Params): Record<string, unknown> {
	const { botId: _b, name: _n, id: _i, action: _a, ...rest } = p.raw;
	return rest;
}

/** A member's MCP servers: reads and tests need no edit switch there (`/federation/read/mcp`), changes do. */
async function mcpOn<T>(cx: OpContext, bot: Bot, method: string, path: string, body?: unknown, timeoutMs?: number): Promise<T> {
	const read = method === "GET" || (method === "POST" && path.endsWith("/test"));
	return manageCall<T>(cx.core, member(bot).node, method, `/federation/${read ? "read" : "manage"}/mcp${path}`, body, timeoutMs);
}

/** An MCP server's answer from a member, in this API's shape. */
function mcpShaped(answer: unknown, bot: Bot | undefined) {
	return mcpJson(answer as Parameters<typeof mcpJson>[0], bot ? member(bot).bot : undefined);
}

export const botOps: Op[] = [
	{ name: "bots.create", http: "POST /bots", handle: create },
	{ name: "bots.update", http: "PATCH /bots/:id", handle: update },
	{ name: "bots.delete", http: "DELETE /bots/:id", handle: remove },
	{ name: "bots.settings", http: "GET /bots/:id/settings", handle: settings },
	{ name: "bots.choices", http: "GET /bot-choices", handle: choices },
	{ name: "bots.skills", http: "GET /bots/:id/skills", handle: skills },
	{ name: "bots.setSkill", http: "PUT /bots/:id/skills/:name", handle: setSkill },
	{ name: "bots.prompt", http: "GET /bots/:id/prompt", handle: prompt },
	{
		name: "bots.rules",
		http: "GET /bots/:id/rules",
		handle: (p, cx) => {
			const bot = target(p, cx);
			localOnly(bot, "Its approval rules");
			return { items: rulesOf(cx, bot), nextCursor: null };
		},
	},
	{
		name: "bots.addRule",
		http: "POST /bots/:id/rules",
		handle: (p, cx) => {
			const bot = target(p, cx);
			localOnly(bot, "Its approval rules");
			const rule = ruleOf(p);
			cx.core.approvals.addRule(`bot:${bot.name}`, rule);
			return { rule: { rule } };
		},
	},
	{
		name: "bots.removeRule",
		http: "DELETE /bots/:id/rules",
		handle: (p, cx) => {
			const bot = target(p, cx);
			localOnly(bot, "Its approval rules");
			const rule = ruleOf(p);
			const had = cx.core.approvals.rules(`bot:${bot.name}`).includes(rule);
			cx.core.approvals.removeRule(`bot:${bot.name}`, rule);
			return { deleted: had };
		},
	},
	{ name: "toolGroups.list", http: "GET /tool-groups", handle: (_p, cx) => ({ items: toolGroupsJson(cx.core), nextCursor: null }) },
	{
		name: "mcp.list",
		http: "GET /mcp/servers",
		handle: async (p, cx) => {
			const bot = mcpTarget(p, cx);
			const servers = bot ? (await mcpOn<ReturnType<typeof mcpList>>(cx, bot, "GET", "", undefined, 5000)).servers : mcpList(cx.core).servers;
			return { items: servers.map((s) => mcpJson(s, botNameOf(p, cx))), nextCursor: null };
		},
	},
	{
		name: "mcp.get",
		http: "GET /mcp/servers/:name",
		handle: async (p, cx) => {
			const bot = mcpTarget(p, cx);
			const name = p.str("name");
			return { server: bot ? mcpShaped(await mcpOn(cx, bot, "GET", `/${encodeURIComponent(name)}`), bot) : mcpJson(mcpDetail(cx.core, name), botNameOf(p, cx)) };
		},
	},
	{
		name: "mcp.create",
		http: "POST /mcp/servers",
		handle: async (p, cx) => {
			const bot = mcpTarget(p, cx);
			const name = p.str("name");
			const fields = mcpFields(p);
			if (bot) {
				await mcpOn(cx, bot, "POST", "", { name, ...fields });
				return { server: mcpShaped(await mcpOn(cx, bot, "GET", `/${encodeURIComponent(name)}`), bot) };
			}
			cx.core.settings.addMcpServer(name, mcpPatch(fields));
			return { server: mcpJson(mcpDetail(cx.core, name)) };
		},
	},
	{
		name: "mcp.update",
		http: "PATCH /mcp/servers/:name",
		handle: async (p, cx) => {
			const bot = mcpTarget(p, cx);
			const name = p.str("name");
			const fields = mcpFields(p);
			if (bot) {
				await mcpOn(cx, bot, "PATCH", `/${encodeURIComponent(name)}`, fields);
				return { server: mcpShaped(await mcpOn(cx, bot, "GET", `/${encodeURIComponent(name)}`), bot) };
			}
			mcpDetail(cx.core, name);
			cx.core.settings.editMcpServer(name, mcpPatch(fields));
			return { server: mcpJson(mcpDetail(cx.core, name)) };
		},
	},
	{
		name: "mcp.delete",
		http: "DELETE /mcp/servers/:name",
		handle: async (p, cx) => {
			const bot = mcpTarget(p, cx);
			const name = p.str("name");
			if (bot) await mcpOn(cx, bot, "DELETE", `/${encodeURIComponent(name)}`, {});
			else {
				mcpDetail(cx.core, name);
				cx.core.settings.removeMcpServer(name);
			}
			return { deleted: true };
		},
	},
	{
		name: "mcp.action",
		http: "POST /mcp/servers/:name/:action",
		handle: async (p, cx) => {
			const bot = mcpTarget(p, cx);
			const name = p.str("name");
			const action = p.str("action");
			const answer = bot ? await mcpOn<Record<string, unknown>>(cx, bot, "POST", `/${encodeURIComponent(name)}/${encodeURIComponent(action)}`, {}, 20_000) : await mcpAction(cx.core, name, action);
			// A check answers with its findings; reconnect and refresh with the server as it is now.
			return "group" in answer ? { ok: true, server: mcpShaped(answer, bot) } : answer;
		},
	},
	{
		name: "mcp.setForBot",
		http: "PUT /mcp/servers/:name/bots/:botId",
		handle: async (p, cx) => {
			const bot = target(p, cx, "botId");
			const name = p.str("name");
			const enabled = p.optBool("enabled");
			if (enabled === undefined) throw new ApiError("invalid_params", "enabled is required.");
			if (bot.remote) {
				const { entry } = await memberEditor(cx, bot);
				const group = `mcp:${name}`;
				const tools = entry.effective.tools.filter((g) => g !== group);
				if (enabled) tools.push(group);
				await manageWrite(cx.core, bot.remote.node, "PATCH", botPath(bot), { tools });
				return { server: mcpShaped(await mcpOn(cx, bot, "GET", `/${encodeURIComponent(name)}`), bot) };
			}
			if (!cx.core.config.mcp.servers.some((s) => s.name === name)) throw new ApiError("not_found", `No MCP server named ${name}.`);
			setBotMcp(cx.core, bot.name, bot.toolGroups, name, enabled);
			return { server: mcpJson(mcpServerView(cx.core, cx.core.config.mcp.servers.find((s) => s.name === name)!), bot.name) };
		},
	},
];
