// Vory's MCP Servers screen (`/api/mcp/servers`, per profile) onto the gateway's MCP servers (src/mcp/).
// Vory shows one toggle per server for the selected profile; here a profile is a bot, so the toggle grants
// or removes that bot's tool group `mcp:<server>` rather than switching the server for everyone. Test is a
// live check; Remove deletes the server from the gateway (Vory asks first). Vory cannot add a server: the
// panel and `nhermes mcp` do. For a member's bot, src/federation/vory.ts forwards these to its machine.
import type { Core } from "../app.ts";
import { mcpAction, mcpServerView, setBotMcp, UnknownMcpServer } from "../mcp/manage.ts";
import { call } from "./manage.ts";
import { HttpError, obj, type Router } from "../http.ts";
import { botFor, localOnly } from "./lookup.ts";

export function mcpVoryRoutes(core: Core, r: Router): void {
	const bot = (profile: string | null | undefined) => {
		const b = botFor(core, profile);
		localOnly(b);
		return b;
	};
	const known = (name: string) => {
		const c = core.config.mcp.servers.find((s) => s.name === name);
		if (!c) throw new HttpError(404, `Server '${name}' not found`);
		return c;
	};
	const profileOf = (q: { query: URLSearchParams; body: unknown }) => q.query.get("profile") ?? (obj(q.body).profile as string | undefined);

	r.on("GET", "/api/mcp/servers", (q) => {
		const b = bot(q.query.get("profile"));
		return {
			servers: core.config.mcp.servers.map((c) => {
				const v = mcpServerView(core, c);
				return {
					name: c.name,
					transport: "http",
					url: c.url,
					command: null,
					args: [],
					// Vory's toggle: whether this profile (bot) has the server.
					enabled: b.toolGroups.includes(`mcp:${c.name}`),
					auth: Object.keys(c.headers).length > 0 ? "header" : null,
					tools: null,
					source: "config",
					// Not read by Vory today; the panel shows the same.
					description: v.description,
					state: c.enabled ? v.status.state : "disabled",
					tool_count: v.exposedCount,
				};
			}),
		};
	});

	r.on("PUT", "/api/mcp/servers/:name/enabled", (q) => {
		const c = known(q.params.name!);
		const enabled = obj(q.body).enabled;
		if (typeof enabled !== "boolean") throw new HttpError(400, "enabled must be true or false");
		const b = bot(profileOf(q));
		call(() => setBotMcp(core, b.name, b.toolGroups, c.name, enabled));
		return { ok: true, name: c.name, enabled };
	});

	r.on("POST", "/api/mcp/servers/:name/test", async (q) => {
		known(q.params.name!);
		try {
			const t = await mcpAction(core, q.params.name!, "test");
			if (!("ok" in t)) throw new Error("unexpected answer");
			return { ok: t.ok, status: t.ok ? "connected" : t.state, tool_count: t.toolCount, tools: t.tools, ...(t.error ? { error: t.error } : {}) };
		} catch (error) {
			if (error instanceof UnknownMcpServer) throw new HttpError(404, error.message);
			throw error;
		}
	});

	r.on("DELETE", "/api/mcp/servers/:name", (q) => {
		known(q.params.name!);
		call(() => core.settings.removeMcpServer(q.params.name!));
		return { ok: true };
	});
}
