// MCP servers' tools as Durable tools (docs/MCP.md). Each configured server is tool group `mcp:<server>`;
// its tools are the server's last known list (src/mcp/servers.ts), narrowed by the server's include and
// exclude patterns, named `mcp__<server>__<tool>` (Pi's convention). They are rebuilt, and the `mcp`
// extension re-installed in Durable's registry, whenever a list or the config changes; never when a server
// merely goes offline. A down server keeps its known tools declared, and a call to it fails within a few
// seconds with an outcome that says whether anything was sent (src/mcp/outcome.ts). Tool descriptions and
// results are the server's text: data, never instructions about policy. A result that kept structured data ends
// with a line naming it for the `show` tool (core/cards.ts).
import { createHash } from "node:crypto";
import type { ImageContent, TextContent, TSchema } from "@earendil-works/pi-ai";
import { defineExtension, type Extension, type Registry, type ToolRegistration } from "@earendil-works/pi-durable";
import { createToolSearchTool } from "@earendil-works/pi-durable/tool-search";
import { type CallToolResult, type Tool as McpTool, toLlmContent } from "@earendil-works/pi-mcp";
import type { PromptPart } from "../agent/extensions.ts";
import type { McpServerConfig } from "../config.ts";
import { cardableLine } from "../core/cards.ts";
import { matchesGlob } from "../core/policy.ts";
import type { McpServers } from "../mcp/servers.ts";
import { modelText } from "../mcp/outcome.ts";
import { logger, redact } from "../log.ts";
import type { ToolGroups } from "./index.ts";

const log = logger("mcp");

/** Provider tool names: at most 64 characters of [A-Za-z0-9_-]. */
const MAX_NAME = 64;
const MAX_DESCRIPTION = 2000;
/** Model-facing text of one result beyond this is cut in the middle (Pi's coding agent uses the same). */
const MAX_TEXT_BYTES = 20 * 1024;
/** A server's structured result is kept with the call for clients (cards), up to this size; the model never sees it. */
const MAX_STRUCTURED_CHARS = 256 * 1024;
/** More direct tools than this from one server is worth a warning in the panel. */
export const MANY_TOOLS = 100;

export type McpToolInfo = { server: string; tool: string; readOnly: boolean; deferred: boolean };

/** Whether a tool name matches any of the patterns (`*` matches any characters). */
export function matchesPattern(name: string, patterns: readonly string[]): boolean {
	return patterns.some((p) => matchesGlob(p, name));
}

/** `mcp__<server>__<tool>` sanitized; an 8-hex hash suffix when too long or already taken (Pi's rule). */
export function mcpToolName(server: string, tool: string, taken: (name: string) => boolean = () => false): string {
	const name = `mcp__${server}__${tool}`.replace(/[^A-Za-z0-9_]/g, "_");
	if (name.length <= MAX_NAME && !taken(name)) return name;
	const hash = createHash("sha256").update(`${server}\0${tool}`).digest("hex").slice(0, 8);
	return `${name.slice(0, MAX_NAME - hash.length - 1)}_${hash}`;
}

/** Whether a server's tool is exposed at all (its include and exclude patterns). */
export function exposed(config: McpServerConfig, tool: string): boolean {
	return matchesPattern(tool, config.tools.include) && !matchesPattern(tool, config.tools.exclude);
}

/** Read-only by the owner's word, or by the server's own hint when the owner trusts this server's hints. */
export function isReadOnly(config: McpServerConfig, tool: McpTool): boolean {
	return matchesPattern(tool.name, config.tools.readOnly) || (config.trustReadOnlyHint && tool.annotations?.readOnlyHint === true);
}

function clipMiddle(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text) <= maxBytes) return text;
	const half = Math.floor(maxBytes / 2);
	const head = Buffer.from(text).subarray(0, half).toString("utf8");
	const tail = Buffer.from(text).subarray(-half).toString("utf8");
	return `${head}\n\n[… ${Buffer.byteLength(text) - 2 * half} bytes cut from the middle …]\n\n${tail}`;
}

/** The result for the model: text (one block, capped; `extra` is added after the cap) and images. */
function resultContent(result: CallToolResult, extra?: string): (TextContent | ImageContent)[] {
	const content = toLlmContent(result) as (TextContent | ImageContent)[];
	const text = content.filter((b): b is TextContent => b.type === "text").map((b) => b.text).join("\n");
	const images = content.filter((b): b is ImageContent => b.type === "image");
	const out: (TextContent | ImageContent)[] = [];
	if (text || images.length === 0 || extra) {
		const body = text ? clipMiddle(text, MAX_TEXT_BYTES) : "(the tool returned nothing)";
		out.push({ type: "text", text: extra ? `${body}\n\n${extra}` : body });
	}
	return [...out, ...images];
}

export type McpToolsDeps = {
	servers: McpServers;
	/** The gateway's tool groups: `mcp:<server>` entries are kept here. */
	toolGroups: ToolGroups;
	configs: () => McpServerConfig[];
};

export class McpTools {
	private readonly d: McpToolsDeps;
	private readonly info = new Map<string, McpToolInfo>();
	private tools: ToolRegistration[] = [];
	private registry: Registry | undefined;
	private readonly toolSearch = createToolSearchTool() as unknown as ToolRegistration;

	constructor(deps: McpToolsDeps) {
		this.d = deps;
		this.rebuild();
	}

	/** The Durable extension with the current MCP tools (and tool_search, for deferred servers). */
	extension(): Extension {
		return defineExtension({ name: "mcp", tools: [...this.tools, this.toolSearch] });
	}

	/** From now on, changes re-install the extension in this registry. */
	attach(registry: Registry): void {
		this.registry = registry;
	}

	/** Rebuilds from the snapshots and config, and re-installs the extension. Sessions pick it up at their next prompt. */
	republish(): void {
		this.rebuild();
		this.registry?.install(this.extension());
	}

	lookup(name: string): McpToolInfo | undefined {
		return this.info.get(name);
	}

	/** The tool_search tool, offered to a bot when any of its MCP tools is deferred. */
	get searchTool(): ToolRegistration {
		return this.toolSearch;
	}

	private rebuild(): void {
		const configs = this.d.configs();
		const names = new Set<string>();
		this.info.clear();
		const all: ToolRegistration[] = [];
		for (const key of [...this.d.toolGroups.keys()]) if (key.startsWith("mcp:")) this.d.toolGroups.delete(key);
		for (const c of configs) {
			const group: ToolRegistration[] = [];
			const snap = c.enabled ? this.d.servers.snapshot(c.name) : undefined;
			for (const t of snap?.tools ?? []) {
				if (!exposed(c, t.name)) continue;
				const name = mcpToolName(c.name, t.name, (n) => names.has(n));
				names.add(name);
				const reg = this.registration(c, t, name);
				this.info.set(name, { server: c.name, tool: t.name, readOnly: isReadOnly(c, t), deferred: c.exposure === "deferred" });
				group.push(reg);
			}
			this.d.toolGroups.set(`mcp:${c.name}`, group);
			all.push(...group);
		}
		this.tools = all;
	}

	private registration(c: McpServerConfig, t: McpTool, name: string): ToolRegistration {
		const servers = this.d.servers;
		const configs = this.d.configs;
		const readOnly = isReadOnly(c, t);
		const raw = (t.description ?? "").trim() || t.title || t.name;
		const description = raw.length > MAX_DESCRIPTION ? `${raw.slice(0, MAX_DESCRIPTION)}…` : raw;
		const schema = t.inputSchema ?? {};
		// Providers want an object schema, and some reject one without `properties` (as Pi's coding agent does).
		const parameters = { ...schema, type: "object", properties: (schema.properties as Record<string, unknown> | undefined) ?? {} } as unknown as TSchema;
		return {
			name,
			description: `${description}${description.endsWith(".") ? "" : "."} (MCP server "${c.name}"${readOnly ? ", read-only" : ""})`,
			parameters,
			replay: readOnly ? "safe" : "unsafe",
			...(c.exposure === "deferred" ? { deferred: true as const } : {}),
			execute: async (args, api, ctx) => {
				const current = configs().find((x) => x.name === c.name) ?? c;
				const r = await servers.call(c.name, t.name, (args ?? {}) as Record<string, unknown>, { signal: ctx.abortSignal, readOnly, onProgress: (m) => api.output(`${m}\n`) });
				log.info("mcp call", { server: c.name, tool: t.name, outcome: r.ok ? (r.result.isError ? "tool_error" : "ok") : r.outcome.kind, ms: r.ms });
				if (r.ok) {
					const isError = r.result.isError === true;
					const structured = r.result.structuredContent;
					const keep = structured !== undefined && JSON.stringify(structured).length <= MAX_STRUCTURED_CHARS;
					return { output: resultContent(r.result, keep && !isError ? cardableLine(api.callId) : undefined), isError, details: { server: c.name, tool: t.name, outcome: isError ? "tool_error" : "ok", sent: "yes", ms: r.ms, ...(keep ? { structured } : {}) } };
				}
				const o = r.outcome;
				const text = modelText({ kind: o.kind, message: redact(o.message) }, { server: c.name, tool: t.name, readOnly, timeoutS: current.timeoutS, since: r.since });
				return {
					output: [{ type: "text", text }],
					isError: true,
					details: { server: c.name, tool: t.name, outcome: o.kind, sent: o.sent, ms: r.ms, ...(o.httpStatus ? { httpStatus: o.httpStatus } : {}), ...(o.rpcCode ? { rpcCode: o.rpcCode } : {}) },
				};
			},
		} as ToolRegistration;
	}

	/**
	 * The bot's MCP servers, for its prompt: names and the owner's descriptions only, never live status, so
	 * the prompt changes only when the configuration does (and once, when a server's tools first become known).
	 */
	promptPart(): PromptPart {
		return (bot) => {
			const lines: string[] = [];
			for (const c of this.d.configs()) {
				if (!bot.toolGroups.includes(`mcp:${c.name}`)) continue;
				const about = c.description ? JSON.stringify(c.description) : "no description";
				let note = "";
				if (!c.enabled) note = " It is turned off by the owner, so its tools are not available.";
				else if (!this.d.servers.snapshot(c.name)) note = " No tools known yet: it has not connected since it was added. If a task needs it, say so.";
				else if (c.exposure === "deferred") note = " Its tools are not listed up front: find them with tool_search.";
				lines.push(`- ${c.name}: ${about}.${note}`);
			}
			if (lines.length === 0) return undefined;
			return [
				"MCP servers you can use (their tools are named mcp__<server>__<tool>):",
				...lines,
				"An MCP server can be offline for a while (for example a laptop that is asleep). When a call says the server is offline or that a call may or may not have run, tell the owner plainly; never claim it worked, and do not repeat a call that changes something without checking first.",
			].join("\n");
		};
	}
}
