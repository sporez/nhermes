// One MCP server's connection: its availability state, reconnects with backoff, the idle health check,
// tool discovery and calls (docs/MCP.md, "Connection lifecycle"). Each server has its own client and
// timers; nothing here waits on another server, and a call waits only on its own server, within bounds.
//
// Invariants:
// - A tool call is sent at most once. The only second send is after a 404 on an expired session, which
//   the spec defines as not processed. Nothing is queued, and nothing is replayed after a reconnect.
// - pi-mcp keeps a client "connected" after any failed request, so availability is ours: a successful
//   initialize, request or ping makes the server online; failed health checks, or a call that shows the
//   server is unreachable, take it offline.
// - A client that is replaced is closed only once our own requests on it have settled, so one call's
//   failure never fails another call still waiting on the same server.
// - A call on a connection that has been idle is preceded by a ping. A pooled connection to a server that
//   went away then fails on the ping, not on the call, so the call is not sent on a dead connection (where
//   a reset would leave its outcome unknown) and is reported as "offline, not sent" instead.
import { type CallToolResult, McpClient, type Tool as McpTool, StreamableHttpTransport } from "@earendil-works/pi-mcp";
import type { McpServerConfig } from "../config.ts";
import { logger, redact } from "../log.ts";
import { type Classified, classify, errorText, meansUnreachable } from "./outcome.ts";

const log = logger("mcp");

export type McpState = "disabled" | "connecting" | "online" | "offline" | "needs_key" | "failed" | "closed";

export type DiscoveredTools = {
	tools: McpTool[];
	serverInfo: { name: string; version: string; title?: string };
	protocolVersion: string;
	instructions: string;
};

/** Timings, all overridable for tests. */
export type Tuning = {
	/** An initialize + tools/list attempt. */
	connectBudgetMs: number;
	/** How long a call waits for a reconnect when it finds the server offline. */
	probeBudgetMs: number;
	/** Calls make a fresh attempt at most this often. */
	probeGapMs: number;
	pingTimeoutMs: number;
	/** Consecutive failed health checks before the server counts as offline. */
	pingMisses: number;
	backoffBaseMs: number;
	backoffCapMs: number;
	/** Retry interval for a server that refused the key or is set up wrong. */
	slowRetryMs: number;
	/** A call on a connection idle this long is preceded by a ping (see `call`). */
	preflightIdleMs: number;
};

export const DEFAULT_TUNING: Tuning = {
	connectBudgetMs: 10_000,
	probeBudgetMs: 3_000,
	probeGapMs: 5_000,
	pingTimeoutMs: 10_000,
	pingMisses: 2,
	backoffBaseMs: 5_000,
	backoffCapMs: 300_000,
	slowRetryMs: 30 * 60_000,
	preflightIdleMs: 1_000,
};

export type ConnectionStatus = {
	name: string;
	state: McpState;
	/** When the current state began (ms since epoch). */
	since: number;
	lastError?: string;
	lastConnectedAt?: number;
	/** When the server was last seen unreachable after being reachable, or first failed. */
	offlineSince?: number;
	nextAttemptAt?: number;
};

export type CallOptions = {
	signal?: AbortSignal;
	readOnly: boolean;
	onProgress?: (message: string) => void;
};

export type CallResult = { ok: true; result: CallToolResult; ms: number } | { ok: false; outcome: Classified; ms: number; since?: number };

export type ConnectionDeps = {
	config: McpServerConfig;
	/** The request headers with secrets filled in; throws MissingKey when one is not set. */
	headers: (config: McpServerConfig) => Record<string, string>;
	/** A reason the URL may not be used (it is this gateway), or undefined. */
	refuse?: (url: string) => Promise<string | undefined>;
	fetch?: typeof fetch;
	version: string;
	tuning?: Partial<Tuning>;
	random?: () => number;
	onState: (connection: McpConnection) => void;
	onTools: (connection: McpConnection, tools: DiscoveredTools) => void;
};

export class MissingKey extends Error {
	override name = "MissingKey";
}

/** Resolves with the promise's value, or undefined after `ms` (the promise keeps running). */
function within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
	return new Promise((resolve, reject) => {
		const t = setTimeout(() => resolve(undefined), ms);
		t.unref?.();
		promise.then(
			(v) => (clearTimeout(t), resolve(v)),
			(e) => (clearTimeout(t), reject(e)),
		);
	});
}

export class McpConnection {
	private cfg: McpServerConfig;
	private readonly d: ConnectionDeps;
	private readonly t: Tuning;
	private stateValue: McpState;
	private sinceValue = Date.now();
	private lastError: string | undefined;
	private lastConnectedAt: number | undefined;
	private offlineSince: number | undefined;
	private nextAttemptAt: number | undefined;
	private client: McpClient | undefined;
	/** Our requests in flight per client, so a replaced client is closed only once they settle. */
	private readonly inflight = new Map<McpClient, number>();
	private readonly retired = new Set<McpClient>();
	private attempt: Promise<void> | undefined;
	private lastAttemptAt = 0;
	private failures = 0;
	private misses = 0;
	private lastOkAt = 0;
	private retryTimer: ReturnType<typeof setTimeout> | undefined;
	private healthTimer: ReturnType<typeof setTimeout> | undefined;
	private closed = false;
	/** The last trouble state logged, so a server that stays away is logged once, not at every attempt. */
	private reported: McpState | undefined;
	/** Whether the tools came from the current connection (not an earlier one). */
	fresh = false;

	constructor(deps: ConnectionDeps) {
		this.d = deps;
		this.cfg = deps.config;
		this.t = { ...DEFAULT_TUNING, ...deps.tuning };
		this.stateValue = deps.config.enabled ? "connecting" : "disabled";
	}

	get name(): string {
		return this.cfg.name;
	}

	get config(): McpServerConfig {
		return this.cfg;
	}

	get state(): McpState {
		return this.stateValue;
	}

	status(): ConnectionStatus {
		return {
			name: this.cfg.name,
			state: this.stateValue,
			since: this.sinceValue,
			...(this.lastError ? { lastError: this.lastError } : {}),
			...(this.lastConnectedAt ? { lastConnectedAt: this.lastConnectedAt } : {}),
			...(this.offlineSince ? { offlineSince: this.offlineSince } : {}),
			...(this.nextAttemptAt ? { nextAttemptAt: this.nextAttemptAt } : {}),
		};
	}

	/** Settings that do not need a new connection (timeouts, tool lists, description). */
	setConfig(config: McpServerConfig): void {
		this.cfg = config;
		if (this.stateValue === "online") this.scheduleHealth();
	}

	start(): void {
		if (!this.cfg.enabled) return this.setState("disabled");
		void this.connect();
	}

	/** Connects now (Test, Reconnect, a changed key), whatever the backoff says. */
	async reconnect(): Promise<void> {
		if (this.closed || !this.cfg.enabled) return;
		await this.attempt?.catch(() => undefined);
		if (this.client) this.retire(this.client);
		this.client = undefined;
		this.failures = 0;
		await this.connect();
	}

	/** A live check for the panel and Vory: a fresh initialize and tool list (calls in flight finish on the old client). */
	async test(): Promise<{ ok: boolean; error?: string }> {
		if (!this.cfg.enabled) return { ok: false, error: "the server is turned off" };
		await this.reconnect();
		return this.stateValue === "online" ? { ok: true } : { ok: false, error: this.lastError ?? this.stateValue };
	}

	/** Lists the tools again (panel Refresh, tools/list_changed). Keeps the old list on failure. */
	async refresh(): Promise<void> {
		const client = this.client;
		if (!client || this.stateValue !== "online") return;
		try {
			const tools = await this.track(client, () => client.listTools({ timeoutMs: this.t.connectBudgetMs }));
			if (this.client !== client || this.closed) return;
			this.ok();
			this.d.onTools(this, this.discovered(client, tools));
		} catch (error) {
			const c = classify(error);
			this.lastError = redact(`refreshing the tool list failed: ${c.message}`);
			log.debug("mcp tool refresh failed", { server: this.name, error: c.message });
			this.afterFailure(client, c);
			this.d.onState(this);
		}
	}

	async call(tool: string, args: Record<string, unknown>, opts: CallOptions): Promise<CallResult> {
		const started = Date.now();
		const fail = (outcome: Classified): CallResult => ({ ok: false, outcome, ms: Date.now() - started, ...(this.offlineSince ? { since: this.offlineSince } : {}) });
		const refusal = this.refusal();
		if (refusal) return fail(refusal);
		if (this.stateValue !== "online" || !this.client) {
			// One quick attempt, shared by concurrent calls and bounded, so a server that just came back is
			// used at once and a gone one fails fast. Nothing was sent if it fails.
			if (this.attempt || Date.now() - this.lastAttemptAt >= this.t.probeGapMs) await within(this.connect().catch(() => undefined), this.t.probeBudgetMs);
			const again = this.refusal();
			if (again) return fail(again);
			if (this.stateValue !== "online" || !this.client) return fail({ kind: "offline", sent: "no", message: this.lastError ?? "not connected" });
		} else if (Date.now() - this.lastOkAt >= this.t.preflightIdleMs) {
			await this.healthCheck(true, Math.min(this.t.pingTimeoutMs, this.t.probeBudgetMs));
			if (this.stateValue !== "online" || !this.client) {
				await within(this.connect().catch(() => undefined), this.t.probeBudgetMs);
				const again = this.refusal();
				if (again) return fail(again);
				if (this.stateValue !== "online" || !this.client) return fail({ kind: "offline", sent: "no", message: this.lastError ?? "not connected" });
			}
		}
		return this.send(tool, args, opts, started, true);
	}

	async close(): Promise<void> {
		this.closed = true;
		this.clearTimers();
		const clients = [...(this.client ? [this.client] : []), ...this.retired];
		this.client = undefined;
		this.retired.clear();
		this.setState("closed");
		await Promise.all(clients.map((c) => c.close().catch(() => undefined)));
	}

	private refusal(): Classified | undefined {
		if (this.closed || !this.cfg.enabled) return { kind: "offline", sent: "no", message: "the server is turned off" };
		if (this.stateValue === "needs_key") return { kind: "auth", sent: "no", message: this.lastError ?? "the server refused the key" };
		if (this.stateValue === "failed") return { kind: "misconfigured", sent: "no", message: this.lastError ?? "set up wrong" };
		return undefined;
	}

	private async send(tool: string, args: Record<string, unknown>, opts: CallOptions, started: number, mayResend: boolean): Promise<CallResult> {
		const client = this.client!;
		const deadline = new AbortController();
		const timer = setTimeout(() => deadline.abort(), this.cfg.maxTimeoutS * 1000);
		timer.unref?.();
		const signal = opts.signal ? AbortSignal.any([opts.signal, deadline.signal]) : deadline.signal;
		const onProgress = opts.onProgress;
		try {
			const result = await this.track(client, () =>
				client.callTool(tool, args, {
					signal,
					timeoutMs: this.cfg.timeoutS * 1000,
					...(onProgress ? { onProgress: (p) => onProgress(p.message ?? (p.total ? `${p.progress}/${p.total}` : String(p.progress))) } : {}),
				}),
			);
			this.ok();
			return { ok: true, result, ms: Date.now() - started };
		} catch (error) {
			const outcome = classify(error, deadline.signal.aborted ? "deadline" : opts.signal?.aborted ? "owner" : undefined);
			if (outcome.kind === "session_expired" && mayResend && !this.closed) {
				// The spec: a 404 on a session means it is gone and the request was not processed. Start a new
				// session and send this one request once more.
				if (this.client === client) {
					this.retire(client);
					this.client = undefined;
				}
				await within(this.connect().catch(() => undefined), this.t.connectBudgetMs);
				if (this.stateValue === "online" && this.client) return this.send(tool, args, opts, started, false);
				return { ok: false, outcome: this.refusal() ?? { kind: "offline", sent: "no", message: this.lastError ?? "could not start a new session" }, ms: Date.now() - started };
			}
			this.afterFailure(client, outcome);
			return { ok: false, outcome, ms: Date.now() - started, ...(this.offlineSince ? { since: this.offlineSince } : {}) };
		} finally {
			clearTimeout(timer);
		}
	}

	/** What a failed request says about the server. */
	private afterFailure(client: McpClient, c: Classified): void {
		if (this.client !== client || this.closed) return;
		if (c.kind === "auth") return this.fail("needs_key", c.message);
		if (meansUnreachable(c.kind)) return this.lost(c.message);
		if (c.kind === "session_expired") return this.lost("the session expired");
		if (c.kind === "timeout") void this.healthCheck(true);
	}

	/** Counts a request on `client` while it runs, and closes a retired client when its last one settles. */
	private async track<T>(client: McpClient, run: () => Promise<T>): Promise<T> {
		this.inflight.set(client, (this.inflight.get(client) ?? 0) + 1);
		try {
			return await run();
		} finally {
			const n = (this.inflight.get(client) ?? 1) - 1;
			if (n > 0) this.inflight.set(client, n);
			else {
				this.inflight.delete(client);
				if (this.retired.delete(client)) void client.close().catch(() => undefined);
			}
		}
	}

	private retire(client: McpClient): void {
		if ((this.inflight.get(client) ?? 0) === 0) void client.close().catch(() => undefined);
		else this.retired.add(client);
	}

	private ok(): void {
		this.lastOkAt = Date.now();
		this.misses = 0;
	}

	private connect(): Promise<void> {
		if (this.closed || !this.cfg.enabled) return Promise.resolve();
		this.attempt ??= this.connectOnce().finally(() => {
			this.attempt = undefined;
		});
		return this.attempt;
	}

	private async connectOnce(): Promise<void> {
		this.clearRetry();
		this.lastAttemptAt = Date.now();
		if (this.stateValue !== "connecting") this.setState("connecting");
		let headers: Record<string, string>;
		try {
			headers = this.d.headers(this.cfg);
		} catch (error) {
			return this.fail(error instanceof MissingKey ? "needs_key" : "failed", errorText(error));
		}
		const refused = await this.d.refuse?.(this.cfg.url);
		if (refused) return this.fail("failed", refused);
		const fetchImpl = this.d.fetch ?? globalThis.fetch;
		const client = new McpClient({ name: "nhermes", version: this.d.version, requestTimeoutMs: this.t.connectBudgetMs });
		const transport = new StreamableHttpTransport({
			url: this.cfg.url,
			headers,
			// Headers carry the server's key: never follow a redirect with them.
			fetch: (input, init) => fetchImpl(input, { ...init, redirect: "error" }),
		});
		let timedOut = false;
		const budget = setTimeout(() => {
			timedOut = true;
			void client.close().catch(() => undefined);
		}, this.t.connectBudgetMs);
		budget.unref?.();
		try {
			await client.connect(transport);
			const tools = client.serverCapabilities?.tools ? await client.listTools({ timeoutMs: this.t.connectBudgetMs }) : [];
			if (this.closed || timedOut) {
				await client.close().catch(() => undefined);
				if (timedOut && !this.closed) this.fail("offline", `no answer within ${Math.round(this.t.connectBudgetMs / 1000)} s`);
				return;
			}
			client.onNotification("notifications/tools/list_changed", () => void this.refresh());
			client.onClose(() => {
				if (this.client === client && !this.closed) this.lost("the connection closed");
			});
			client.onError((error) => log.debug("mcp transport error", { server: this.name, error: errorText(error) }));
			const old = this.client;
			this.client = client;
			if (old && old !== client) this.retire(old);
			const downFor = this.offlineSince ? Math.round((Date.now() - this.offlineSince) / 1000) : undefined;
			const wasOffline = this.stateValue !== "connecting" || this.failures > 0;
			this.failures = 0;
			this.ok();
			this.lastConnectedAt = Date.now();
			this.offlineSince = undefined;
			this.lastError = undefined;
			this.nextAttemptAt = undefined;
			this.fresh = true;
			this.d.onTools(this, this.discovered(client, tools));
			this.setState("online");
			log.info(wasOffline && downFor !== undefined ? "mcp server is back" : "mcp server connected", { server: this.name, tools: tools.length, protocol: client.protocolVersion, ...(downFor !== undefined ? { downForS: downFor } : {}) });
			this.scheduleHealth();
		} catch (error) {
			await client.close().catch(() => undefined);
			if (this.closed) return;
			if (timedOut) return this.fail("offline", `no answer within ${Math.round(this.t.connectBudgetMs / 1000)} s`);
			const c = classify(error);
			if (c.kind === "auth") return this.fail("needs_key", c.message);
			if (c.kind === "rejected" && c.httpStatus === 400) return this.fail("failed", `${c.message} (the server refused the MCP handshake; it may only speak the newer MCP protocol 2026-07-28, which nHermes does not yet)`);
			if (c.kind === "rejected" && c.rpcCode === undefined) return this.fail("failed", `${c.message} (is the URL the server's MCP endpoint?)`);
			if (c.kind === "rejected" || /unsupported protocol version|Invalid MCP initialize/i.test(c.message)) return this.fail("failed", c.message);
			return this.fail("offline", c.message);
		} finally {
			clearTimeout(budget);
		}
	}

	private discovered(client: McpClient, tools: McpTool[]): DiscoveredTools {
		const info = client.serverInfo;
		return {
			tools,
			serverInfo: { name: info?.name ?? "", version: info?.version ?? "", ...(info?.title ? { title: info.title } : {}) },
			protocolVersion: client.protocolVersion ?? "",
			instructions: client.instructions ?? "",
		};
	}

	/** The server stopped answering: try again at once, then back off. */
	private lost(reason: string): void {
		if (this.closed) return;
		const client = this.client;
		this.client = undefined;
		this.fresh = false;
		if (client) this.retire(client);
		this.lastError = redact(reason);
		this.offlineSince ??= Date.now();
		this.clearHealth();
		log.debug("mcp server stopped answering; reconnecting", { server: this.name, error: this.lastError });
		void this.connect();
	}

	private fail(state: "offline" | "needs_key" | "failed", message: string): void {
		const client = this.client;
		this.client = undefined;
		this.fresh = false;
		if (client) this.retire(client);
		this.clearHealth();
		this.lastError = redact(message);
		let wait: number;
		if (state === "offline") {
			this.offlineSince ??= Date.now();
			this.failures++;
			const step = Math.min(this.t.backoffCapMs, this.t.backoffBaseMs * 2 ** (this.failures - 1));
			wait = Math.round(step * (0.5 + 0.5 * (this.d.random ?? Math.random)()));
		} else wait = this.t.slowRetryMs;
		this.clearRetry();
		this.nextAttemptAt = Date.now() + wait;
		this.retryTimer = setTimeout(() => {
			this.retryTimer = undefined;
			void this.connect();
		}, wait);
		this.retryTimer.unref?.();
		this.setState(state);
	}

	private scheduleHealth(): void {
		this.clearHealth();
		if (this.cfg.healthCheckS <= 0 || this.closed) return;
		this.healthTimer = setTimeout(() => void this.healthCheck(false), this.cfg.healthCheckS * 1000);
		this.healthTimer.unref?.();
	}

	/**
	 * Pings when idle (any successful request counts as a check). `now` pings regardless (before a call, after a
	 * timeout); a ping that fails outright then counts as the server being unreachable.
	 */
	private async healthCheck(now: boolean, timeoutMs = this.t.pingTimeoutMs): Promise<void> {
		const client = this.client;
		if (!client || this.stateValue !== "online" || this.closed) return;
		if (!now && Date.now() - this.lastOkAt < this.cfg.healthCheckS * 1000) return this.scheduleHealth();
		try {
			await this.track(client, () => client.ping({ timeoutMs }));
			if (this.client !== client) return;
			this.ok();
		} catch (error) {
			if (this.client !== client) return;
			const c = classify(error);
			log.debug("mcp health check failed", { server: this.name, error: c.message });
			if (c.kind === "auth") return this.fail("needs_key", c.message);
			if (c.kind === "session_expired") return this.lost("the session expired");
			if (++this.misses >= this.t.pingMisses || meansUnreachable(c.kind)) return this.lost(`health check failed: ${c.message}`);
		}
		this.scheduleHealth();
	}

	private setState(next: McpState): void {
		const prev = this.stateValue;
		if (prev === next) return;
		this.stateValue = next;
		this.sinceValue = Date.now();
		if (next === "online") this.reported = undefined;
		else if ((next === "offline" || next === "needs_key" || next === "failed") && this.reported !== next) {
			this.reported = next;
			const msg = next === "offline" ? "mcp server offline; retrying with backoff" : next === "needs_key" ? "mcp server needs a key (missing or refused)" : "mcp server cannot be used";
			log.warn(msg, { server: this.name, error: this.lastError });
		}
		this.d.onState(this);
	}

	private clearRetry(): void {
		if (this.retryTimer) clearTimeout(this.retryTimer);
		this.retryTimer = undefined;
		this.nextAttemptAt = undefined;
	}

	private clearHealth(): void {
		if (this.healthTimer) clearTimeout(this.healthTimer);
		this.healthTimer = undefined;
	}

	private clearTimers(): void {
		this.clearRetry();
		this.clearHealth();
	}
}
