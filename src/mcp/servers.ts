// The gateway's MCP servers (docs/MCP.md): one McpConnection per configured server, following config
// changes live, and the last tool list each server gave (`mcp_snapshots`), kept while it is offline and
// across restarts, with a short log of what changed between lists (`mcp_changes`). A server's tools are
// "known" when it has a snapshot; "available" only while its connection is online. Starting never waits
// for a server.
import { createHash } from "node:crypto";
import type { Tool as McpTool } from "@earendil-works/pi-mcp";
import { type McpServerConfig, secretRefs } from "../config.ts";
import { logger, registerSecret } from "../log.ts";
import type { AppDb } from "../store/db.ts";
import { type CallOptions, type CallResult, type ConnectionStatus, type DiscoveredTools, McpConnection, MissingKey, type Tuning } from "./connection.ts";

const log = logger("mcp");
const MAX_CHANGES = 50;

export type Snapshot = DiscoveredTools & { url: string; discoveredAt: number; connectedAt?: number };

export type ToolChange = { at: number; added: string[]; removed: string[]; changed: string[] };

export type McpServerStatus = ConnectionStatus & {
	url: string;
	enabled: boolean;
	/** Tools known from the last list (0 when never connected). */
	toolCount: number;
	/** The tools came from the current connection, not an earlier one. */
	fresh: boolean;
	discoveredAt?: number;
	serverInfo?: Snapshot["serverInfo"];
	protocolVersion?: string;
	instructions?: string;
};

export type McpServersDeps = {
	db: AppDb;
	servers: () => McpServerConfig[];
	version: string;
	refuse?: (url: string) => Promise<string | undefined>;
	fetch?: typeof fetch;
	tuning?: Partial<Tuning>;
	random?: () => number;
};

/** Header values with `{{secret:NAME}}` filled in from the environment (secrets.env). */
export function resolveHeaders(config: McpServerConfig): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(config.headers)) {
		out[k] = v.replace(/\{\{secret:([A-Za-z_][A-Za-z0-9_]*)\}\}/g, (_m, name: string) => {
			const value = process.env[name];
			if (!value) throw new MissingKey(`the key ${name} is not set on this gateway (Keys)`);
			registerSecret(value);
			return value;
		});
	}
	return out;
}

/** JSON with object keys sorted, so the same tool always hashes the same. */
function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.keys(value)
			.sort()
			.map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

export function toolHash(t: McpTool): string {
	const { name, title, description, inputSchema, outputSchema, annotations } = t;
	return createHash("sha256").update(canonical({ name, title, description, inputSchema, outputSchema, annotations })).digest("hex").slice(0, 16);
}

/** Settings whose change needs a new connection. */
function connectionKey(c: McpServerConfig): string {
	return JSON.stringify([c.url, c.headers, c.enabled]);
}

type SnapshotRow = { server: string; url: string; discovered_at: number; connected_at: number | null; server_info: string; protocol_version: string; instructions: string; tools: string };

export class McpServers {
	private readonly d: McpServersDeps;
	private readonly conns = new Map<string, { conn: McpConnection; key: string }>();
	private readonly snaps = new Map<string, Snapshot>();
	private readonly toolListeners = new Set<(server: string) => void>();
	private readonly stateListeners = new Set<(server: string) => void>();
	private started = false;

	constructor(deps: McpServersDeps) {
		this.d = deps;
		for (const r of deps.db.all<SnapshotRow>("SELECT * FROM mcp_snapshots")) {
			try {
				this.snaps.set(r.server, {
					url: r.url,
					discoveredAt: r.discovered_at * 1000,
					...(r.connected_at ? { connectedAt: r.connected_at * 1000 } : {}),
					serverInfo: JSON.parse(r.server_info) as Snapshot["serverInfo"],
					protocolVersion: r.protocol_version,
					instructions: r.instructions,
					tools: JSON.parse(r.tools) as McpTool[],
				});
			} catch (error) {
				log.warn("ignoring an unreadable MCP tool snapshot", { server: r.server, error: String(error) });
			}
		}
		this.dropStale();
	}

	/** Connects to every enabled server in the background. */
	start(): void {
		this.started = true;
		this.apply();
	}

	/** Follows the configuration: new servers connect, changed ones reconnect, removed ones close. */
	apply(): void {
		this.dropStale();
		if (!this.started) return;
		const configs = this.d.servers();
		const names = new Set(configs.map((c) => c.name));
		for (const [name, { conn }] of this.conns) {
			if (!names.has(name)) {
				this.conns.delete(name);
				void conn.close();
				this.emitState(name);
			}
		}
		for (const c of configs) {
			const key = connectionKey(c);
			const current = this.conns.get(c.name);
			if (current && current.key === key) {
				current.conn.setConfig(c);
				continue;
			}
			if (current) void current.conn.close();
			const conn = new McpConnection({
				config: c,
				headers: resolveHeaders,
				refuse: this.d.refuse,
				fetch: this.d.fetch,
				version: this.d.version,
				tuning: this.d.tuning,
				random: this.d.random,
				onState: (x) => {
					if (this.conns.get(x.name)?.conn === x) this.emitState(x.name);
				},
				onTools: (x, tools) => {
					if (this.conns.get(x.name)?.conn === x) this.store(x.config, tools);
				},
			});
			this.conns.set(c.name, { conn, key });
			conn.start();
			this.emitState(c.name);
		}
	}

	/** Snapshots of servers no longer configured, or now at another URL (a different server), are dropped. */
	private dropStale(): void {
		const configs = new Map(this.d.servers().map((c) => [c.name, c]));
		for (const [name, snap] of this.snaps) {
			const c = configs.get(name);
			if (c && c.url === snap.url) continue;
			this.snaps.delete(name);
			this.d.db.run("DELETE FROM mcp_snapshots WHERE server = ?", name);
			if (!c) this.d.db.run("DELETE FROM mcp_changes WHERE server = ?", name);
			this.emitTools(name);
		}
	}

	/** A key in secrets.env was set or removed: servers whose headers use it connect again. */
	keyChanged(name: string): void {
		for (const { conn } of this.conns.values()) {
			if (Object.values(conn.config.headers).some((v) => secretRefs(v).includes(name))) void conn.reconnect();
		}
	}

	/** Secret names each server's headers use. */
	secretNames(): { server: string; names: string[] }[] {
		return this.d.servers().map((c) => ({ server: c.name, names: [...new Set(Object.values(c.headers).flatMap(secretRefs))] }));
	}

	snapshot(server: string): Snapshot | undefined {
		return this.snaps.get(server);
	}

	connection(server: string): McpConnection | undefined {
		return this.conns.get(server)?.conn;
	}

	status(): McpServerStatus[] {
		return this.d.servers().map((c) => this.statusOf(c));
	}

	statusOf(c: McpServerConfig): McpServerStatus {
		const conn = this.conns.get(c.name)?.conn;
		const snap = this.snaps.get(c.name);
		const base: ConnectionStatus = conn?.status() ?? { name: c.name, state: c.enabled ? "connecting" : "disabled", since: Date.now() };
		return {
			...base,
			url: c.url,
			enabled: c.enabled,
			toolCount: snap?.tools.length ?? 0,
			fresh: conn?.fresh ?? false,
			...(snap
				? { discoveredAt: snap.discoveredAt, serverInfo: snap.serverInfo, protocolVersion: snap.protocolVersion, instructions: snap.instructions, ...(base.lastConnectedAt || !snap.connectedAt ? {} : { lastConnectedAt: snap.connectedAt }) }
				: {}),
		};
	}

	changes(server: string, limit = 20): ToolChange[] {
		return this.d.db
			.all<{ at: number; added: string; removed: string; changed: string }>("SELECT at, added, removed, changed FROM mcp_changes WHERE server = ? ORDER BY id DESC LIMIT ?", server, limit)
			.map((r) => ({ at: r.at * 1000, added: JSON.parse(r.added) as string[], removed: JSON.parse(r.removed) as string[], changed: JSON.parse(r.changed) as string[] }));
	}

	async call(server: string, tool: string, args: Record<string, unknown>, opts: CallOptions): Promise<CallResult> {
		const conn = this.conns.get(server)?.conn;
		if (!conn) return { ok: false, outcome: { kind: "offline", sent: "no", message: "the server is not configured or turned off" }, ms: 0 };
		return conn.call(tool, args, opts);
	}

	async test(server: string): Promise<{ ok: boolean; error?: string }> {
		const conn = this.conns.get(server)?.conn;
		if (!conn) return { ok: false, error: "the server is turned off or not configured" };
		return conn.test();
	}

	async reconnect(server: string): Promise<void> {
		await this.conns.get(server)?.conn.reconnect();
	}

	async refresh(server: string): Promise<void> {
		await this.conns.get(server)?.conn.refresh();
	}

	onToolsChanged(listener: (server: string) => void): () => void {
		this.toolListeners.add(listener);
		return () => this.toolListeners.delete(listener);
	}

	onStateChanged(listener: (server: string) => void): () => void {
		this.stateListeners.add(listener);
		return () => this.stateListeners.delete(listener);
	}

	/** Closes every connection, bounded so a hung server cannot hold up shutdown. */
	async close(): Promise<void> {
		this.started = false;
		const all = [...this.conns.values()].map(({ conn }) => conn.close());
		this.conns.clear();
		await Promise.race([Promise.all(all), new Promise((r) => setTimeout(r, 2000).unref())]);
	}

	private store(config: McpServerConfig, found: DiscoveredTools): void {
		const prev = this.snaps.get(config.name);
		const now = Date.now();
		const snap: Snapshot = { ...found, url: config.url, discoveredAt: now, connectedAt: now };
		const before = new Map((prev?.tools ?? []).map((t) => [t.name, toolHash(t)]));
		const after = new Map(found.tools.map((t) => [t.name, toolHash(t)]));
		const added = [...after.keys()].filter((n) => !before.has(n));
		const removed = [...before.keys()].filter((n) => !after.has(n));
		const changed = [...after.keys()].filter((n) => before.has(n) && before.get(n) !== after.get(n));
		this.snaps.set(config.name, snap);
		this.d.db.run(
			"INSERT INTO mcp_snapshots (server, url, discovered_at, connected_at, server_info, protocol_version, instructions, tools) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(server) DO UPDATE SET url = excluded.url, discovered_at = excluded.discovered_at, connected_at = excluded.connected_at, server_info = excluded.server_info, protocol_version = excluded.protocol_version, instructions = excluded.instructions, tools = excluded.tools",
			config.name,
			config.url,
			now / 1000,
			now / 1000,
			JSON.stringify(found.serverInfo),
			found.protocolVersion,
			found.instructions,
			JSON.stringify(found.tools),
		);
		if (!prev || added.length > 0 || removed.length > 0 || changed.length > 0) {
			this.d.db.run("INSERT INTO mcp_changes (server, at, added, removed, changed) VALUES (?, ?, ?, ?, ?)", config.name, now / 1000, JSON.stringify(added), JSON.stringify(removed), JSON.stringify(changed));
			this.d.db.run("DELETE FROM mcp_changes WHERE server = ? AND id NOT IN (SELECT id FROM mcp_changes WHERE server = ? ORDER BY id DESC LIMIT ?)", config.name, config.name, MAX_CHANGES);
			if (prev) log.info("mcp server's tools changed", { server: config.name, added, removed, changed });
			this.emitTools(config.name);
		}
	}

	private emitTools(server: string): void {
		for (const l of this.toolListeners) {
			try {
				l(server);
			} catch (error) {
				log.warn("mcp tool listener failed", { server, error: String(error) });
			}
		}
	}

	private emitState(server: string): void {
		for (const l of this.stateListeners) {
			try {
				l(server);
			} catch (error) {
				log.warn("mcp state listener failed", { server, error: String(error) });
			}
		}
	}
}
