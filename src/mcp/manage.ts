// What the panel, the admin API (CLI), members' panels and Vory see of the MCP servers, and the input they
// may send. Routes only translate; edits go through Settings, live actions through McpServers. Key values
// never leave: headers show their `{{secret:NAME}}` references (and whether each key is set), and a header
// that carries a credential must reference a key instead of holding the value itself.
import type { Core } from "../app.ts";
import { CREDENTIAL_HEADER, cleartextRemote, ConfigError, type McpServerConfig, secretRefs } from "../config.ts";
import type { McpServerPatch } from "../core/settings.ts";
import { HttpError } from "../http.ts";
import { redact } from "../log.ts";
import { exposed, isReadOnly, MANY_TOOLS, mcpToolName } from "../tools/mcp.ts";

const sec = (ms: number | undefined) => (ms ? ms / 1000 : null);

function headerView(name: string, value: string): { name: string; value: string | null } {
	// A header without a key reference is shown only when its name does not suggest a credential.
	const shown = secretRefs(value).length > 0 || !CREDENTIAL_HEADER.test(name);
	return { name, value: shown ? redact(value) : null };
}

export function mcpServerView(core: Core, c: McpServerConfig) {
	const st = core.mcp.statusOf(c);
	const snap = core.mcp.snapshot(c.name);
	const tools = snap?.tools ?? [];
	const exposedTools = tools.filter((t) => exposed(c, t.name));
	const secrets = [...new Set(Object.values(c.headers).flatMap(secretRefs))].map((n) => ({ name: n, set: Boolean(process.env[n]) }));
	const warnings: string[] = [];
	if (cleartextRemote(c.url)) warnings.push("Plain http:// to another machine: the headers travel unencrypted unless the network encrypts them.");
	if (c.exposure === "direct" && exposedTools.length > MANY_TOOLS) warnings.push(`${exposedTools.length} tools are declared to every request of the bots that have it; consider exposure: deferred or tools.include.`);
	// While the server waits for a key, its status already says which one.
	if (st.state !== "needs_key") for (const s of secrets) if (!s.set) warnings.push(`The key ${s.name} is not set (Keys).`);
	return {
		name: c.name,
		group: `mcp:${c.name}`,
		url: c.url,
		description: c.description ?? "",
		enabled: c.enabled,
		exposure: c.exposure,
		timeoutS: c.timeoutS,
		maxTimeoutS: c.maxTimeoutS,
		healthCheckS: c.healthCheckS,
		tools: c.tools,
		trustReadOnlyHint: c.trustReadOnlyHint,
		headers: Object.entries(c.headers).map(([n, v]) => headerView(n, v)),
		secrets,
		bots: core.bots.list().filter((b) => !b.remote && b.toolGroups.includes(`mcp:${c.name}`)).map((b) => b.name),
		warnings,
		status: {
			state: st.state,
			since: sec(st.since),
			lastError: st.lastError ? redact(st.lastError) : null,
			lastConnectedAt: sec(st.lastConnectedAt),
			offlineSince: sec(st.offlineSince),
			nextAttemptAt: sec(st.nextAttemptAt),
			fresh: st.fresh,
			discoveredAt: sec(st.discoveredAt),
			serverInfo: st.serverInfo ?? null,
			protocolVersion: st.protocolVersion ?? null,
		},
		toolCount: tools.length,
		exposedCount: exposedTools.length,
		readOnlyCount: exposedTools.filter((t) => isReadOnly(c, t)).length,
	};
}

export function mcpList(core: Core) {
	return { servers: core.config.mcp.servers.map((c) => mcpServerView(core, c)) };
}

export class UnknownMcpServer extends Error {
	override name = "UnknownMcpServer";
	readonly status = 404;
}

function server(core: Core, name: string): McpServerConfig {
	const c = core.config.mcp.servers.find((s) => s.name === name);
	if (!c) throw new UnknownMcpServer(`no MCP server named "${name}"`);
	return c;
}

/** For routes: settings errors are bad input (400), an unknown server is 404; sync and async calls alike. */
export function mcpCall<T>(fn: () => T): T {
	const fail = (error: unknown): never => {
		if (error instanceof UnknownMcpServer) throw new HttpError(404, error.message);
		if (error instanceof ConfigError) throw new HttpError(400, error.message);
		throw error;
	};
	try {
		const out = fn();
		return (out instanceof Promise ? out.catch(fail) : out) as T;
	} catch (error) {
		return fail(error);
	}
}

/** Edits through Settings, with an unknown server answered as such (404) rather than as bad input. */
export function mcpEdit<T>(core: Core, name: string, fn: () => T): T {
	server(core, name);
	return fn();
}

/** One server with its tools as the server described them (untrusted text, shown as such) and its change log. */
export function mcpDetail(core: Core, name: string) {
	const c = server(core, name);
	const snap = core.mcp.snapshot(name);
	const names = new Set<string>();
	return {
		...mcpServerView(core, c),
		instructions: snap?.instructions ? redact(snap.instructions) : "",
		toolList: (snap?.tools ?? []).map((t) => {
			const on = exposed(c, t.name);
			const modelName = on ? mcpToolName(c.name, t.name, (n) => names.has(n)) : null;
			if (modelName) names.add(modelName);
			const owner = c.tools.readOnly.length > 0 && isReadOnly({ ...c, trustReadOnlyHint: false }, t);
			return {
				name: t.name,
				modelName,
				title: t.title ?? "",
				description: t.description ?? "",
				exposed: on,
				readOnly: owner ? "owner" : isReadOnly(c, t) ? "hint" : false,
				annotations: t.annotations ?? {},
				inputSchema: t.inputSchema,
			};
		}),
		changes: core.mcp.changes(name).map((x) => ({ ...x, at: x.at / 1000 })),
	};
}

const KEYS = new Set(["url", "description", "enabled", "headers", "exposure", "timeoutS", "maxTimeoutS", "healthCheckS", "tools", "trustReadOnlyHint"]);
const TOOL_KEYS = new Set(["include", "exclude", "readOnly"]);

function list(v: unknown, where: string): string[] | null {
	if (v === null) return null;
	if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new ConfigError(`${where} must be a list of names or patterns`);
	return (v as string[]).map((x) => x.trim()).filter(Boolean);
}

/**
 * The fields of an add or edit, checked for shape (config loading checks the rest). `null` removes a key.
 * Header values that carry a credential must be a `{{secret:NAME}}` reference, so no key value is ever
 * written to config.yaml from here.
 */
export function mcpPatch(body: Record<string, unknown>): McpServerPatch {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(body)) {
		if (k === "name") continue;
		if (!KEYS.has(k)) throw new ConfigError(`"${k}" is not an MCP server setting`);
		if (v === undefined) continue;
		if (k === "headers" && v !== null) {
			if (typeof v !== "object" || Array.isArray(v)) throw new ConfigError("headers must map names to values");
			const headers: Record<string, string> = {};
			for (const [hn, hv] of Object.entries(v as Record<string, unknown>)) {
				if (typeof hv !== "string" || !hv.trim()) throw new ConfigError(`header ${hn} needs a value`);
				if (CREDENTIAL_HEADER.test(hn) && secretRefs(hv).length === 0) throw new ConfigError(`header ${hn} carries a credential: put the value in Keys and write {{secret:NAME}} here (for example "Bearer {{secret:MY_SERVER_TOKEN}}")`);
				headers[hn] = hv.trim();
			}
			out.headers = headers;
		} else if (k === "tools" && v !== null) {
			if (typeof v !== "object" || Array.isArray(v)) throw new ConfigError("tools must have include, exclude and readOnly lists");
			const t: Record<string, string[] | null> = {};
			for (const [tk, tv] of Object.entries(v as Record<string, unknown>)) {
				if (!TOOL_KEYS.has(tk)) throw new ConfigError(`tools.${tk} is not a setting (include, exclude, readOnly)`);
				if (tv !== undefined) t[tk] = list(tv, `tools.${tk}`);
			}
			out.tools = t;
		} else if (k === "description" && typeof v === "string" && !v.trim()) out.description = null;
		else out[k] = v;
	}
	return out as McpServerPatch;
}

/** The live actions: a fresh check, a reconnect, a new tool list. */
export async function mcpAction(core: Core, name: string, action: string) {
	server(core, name);
	if (action === "test") {
		const r = await core.mcp.test(name);
		const snap = core.mcp.snapshot(name);
		return { ok: r.ok, ...(r.error ? { error: redact(r.error) } : {}), state: core.mcp.statusOf(server(core, name)).state, toolCount: snap?.tools.length ?? 0, tools: (snap?.tools ?? []).map((t) => ({ name: t.name, description: t.description ?? "" })) };
	}
	if (action === "reconnect") await core.mcp.reconnect(name);
	else if (action === "refresh") await core.mcp.refresh(name);
	else throw new ConfigError(`unknown action "${action}" (test, reconnect, refresh)`);
	return mcpServerView(core, server(core, name));
}
