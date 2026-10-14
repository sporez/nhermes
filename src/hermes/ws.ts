// /api/ws: Hermes JSON-RPC 2.0 over WebSocket (newline-delimited frames). One Connection per socket.
// Translates RPCs onto core services and canonical session events onto Hermes events and
// server→client approval requests. Holds only per-socket bookkeeping.
import { randomBytes } from "node:crypto";
import type { WebSocket } from "ws";
import type { Core } from "../app.ts";
import type { Choice } from "../core/approvals.ts";
import type { SessionEvent } from "../core/events.ts";
import { UnknownSession } from "../core/sessions.ts";
import { logger, redact } from "../log.ts";
import { modelOptions } from "./rest.ts";
import { approvalParams, type Json, sessionInfo, srqId, thinkingOf, usageJson } from "./shapes.ts";

const log = logger("ws");
const replayEpoch = randomBytes(4).toString("hex");

export class RpcError extends Error {
	readonly code: number;
	constructor(code: number, message: string) {
		super(message);
		this.code = code;
	}
}

type Params = Record<string, unknown>;

function str(p: Params, key: string, required = true): string {
	const v = p[key];
	if (typeof v === "string" && v.length > 0) return v;
	if (required) throw new RpcError(-32602, `${key} is required`);
	return "";
}

const RESULT_TEXT_LIMIT = 4000;

export class Connection {
	private readonly ws: WebSocket;
	private readonly core: Core;
	private readonly attached = new Map<string, () => void>();
	/** Approval request ids this socket was sent and has not seen settled. */
	private readonly sentRequests = new Set<string>();
	private answersRequests = false;
	private readonly offGlobal: () => void;
	private closed = false;

	constructor(ws: WebSocket, core: Core) {
		this.ws = ws;
		this.core = core;
		this.offGlobal = core.hub.onGlobal((e) => this.event(e.type, "", {}));
		ws.on("message", (data) => {
			for (const line of data.toString().split("\n")) {
				if (line.trim()) void this.onFrame(line);
			}
		});
		ws.on("close", () => this.dispose());
		ws.on("error", () => this.dispose());
		this.event("gateway.ready", "", { skin: {}, change_events: true, heartbeat: true, replay_epoch: replayEpoch });
	}

	private dispose(): void {
		if (this.closed) return;
		this.closed = true;
		this.offGlobal();
		for (const off of this.attached.values()) off();
		this.attached.clear();
	}

	private send(frame: Record<string, unknown>): void {
		if (this.closed || this.ws.readyState !== this.ws.OPEN) return;
		this.ws.send(JSON.stringify(frame));
	}

	private event(type: string, sessionId: string, payload?: Record<string, Json | undefined>): void {
		const params: Record<string, unknown> = { type, session_id: sessionId };
		if (payload !== undefined) params.payload = payload;
		this.send({ jsonrpc: "2.0", method: "event", params });
	}

	private async onFrame(line: string): Promise<void> {
		let msg: Record<string, unknown>;
		try {
			msg = JSON.parse(line) as Record<string, unknown>;
		} catch {
			return this.send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
		}
		const id = msg.id;
		if (typeof msg.method !== "string") {
			// A response to one of our server→client requests.
			if (typeof id === "string" && ("result" in msg || "error" in msg)) this.onResponse(id, msg.result);
			return;
		}
		const params = (msg.params && typeof msg.params === "object" ? msg.params : {}) as Params;
		try {
			const result = await this.dispatch(msg.method, params);
			if (id !== undefined && id !== null) this.send({ jsonrpc: "2.0", id, result });
		} catch (error) {
			const code = error instanceof RpcError ? error.code : error instanceof UnknownSession ? 4006 : -32000;
			const message = error instanceof Error ? error.message : String(error);
			if (code === -32000) log.warn("rpc failed", { method: msg.method, error: message });
			if (id !== undefined && id !== null) this.send({ jsonrpc: "2.0", id, error: { code, message } });
		}
	}

	private onResponse(id: string, result: unknown): void {
		if (!id.startsWith("srq-") || result === null || typeof result !== "object") return;
		const choice = (result as { choice?: unknown }).choice;
		if (typeof choice !== "string") return;
		const requestId = id.slice(4);
		this.sentRequests.delete(requestId);
		this.core.approvals.answer(requestId, normalizeChoice(choice));
	}

	private botOf(p: Params) {
		const name = typeof p.profile === "string" && p.profile && p.profile !== "default" ? p.profile : undefined;
		if (!name) return this.core.bots.defaultBot();
		const bot = this.core.bots.get(name);
		if (!bot || bot.isPeer) throw new RpcError(4004, `profile not found: ${name}`);
		return bot;
	}

	private async info(sessionId: string) {
		const row = this.core.sessions.require(sessionId);
		const bot = this.core.bots.require(row.bot);
		const agent = await this.core.engine.agentModel(row.conversation_id);
		return sessionInfo({
			bot,
			model: agent.model,
			thinking: agent.thinking,
			title: row.title,
			running: this.core.sessions.isRunning(sessionId),
			storedId: sessionId,
			yolo: this.core.approvals.isYolo(sessionId),
			usage: await this.core.sessions.usage(sessionId),
		});
	}

	/** Builds the resume snapshot so that no session event lands between the read and the reply. */
	private async snapshotReply(sessionId: string): Promise<Record<string, unknown>> {
		const { sessions, hub, approvals } = this.core;
		let reply: Record<string, unknown> = {};
		for (let attempt = 0; attempt < 5; attempt++) {
			const before = hub.seq(sessionId);
			const snap = await sessions.snapshot(sessionId);
			const info = await this.info(sessionId);
			if (hub.seq(sessionId) !== before && attempt < 4) continue;
			const pending = approvals.pendingFor(sessionId);
			reply = {
				session_id: sessionId,
				stored_session_id: sessionId,
				resumed: sessionId,
				message_count: snap.rows.length,
				messages: snap.rows,
				info,
				running: snap.running,
				status: snap.running ? (snap.inflight?.streaming ? "streaming" : "working") : "idle",
				turn_started_at: snap.running ? snap.turnStartedAt : null,
				started_at: snap.session.created_at,
				inflight: snap.inflight ?? null,
				open_requests: pending.map((r) => ({ id: srqId(r.requestId), method: "approval", params: approvalParams(r) })),
				pending_approval: pending[0] ? approvalParams(pending[0]) : null,
			};
			break;
		}
		// Subscribe in the same synchronous step as the reply: later events follow it.
		this.attach(sessionId);
		for (const r of approvals.pendingFor(sessionId)) this.sentRequests.add(r.requestId);
		return reply;
	}

	private attach(sessionId: string): void {
		if (this.attached.has(sessionId)) return;
		this.attached.set(sessionId, this.core.hub.subscribe(sessionId, (sid, e) => this.onSessionEvent(sid, e)));
	}

	private onSessionEvent(sid: string, e: SessionEvent): void {
		switch (e.type) {
			case "run.started":
				// Hermes sends message.start once, when the prompt is accepted (prompt_turn.py).
				return this.event("message.start", sid, {});
			case "text.delta":
				return this.event("message.delta", sid, { text: redact(e.text) });
			case "reasoning.delta":
				return this.event("reasoning.delta", sid, { text: e.text });
			case "tool.started":
				return this.event("tool.start", sid, { tool_id: e.callId, name: e.name, context: redact(e.preview), args: JSON.parse(redact(JSON.stringify(e.args))) as Record<string, Json>, args_text: redact(JSON.stringify(e.args, null, 2)).slice(0, 2000) });
			case "tool.finished": {
				const text = e.resultText.length > RESULT_TEXT_LIMIT ? `${e.resultText.slice(0, RESULT_TEXT_LIMIT)}\n… (${e.resultText.length - RESULT_TEXT_LIMIT} more characters)` : e.resultText;
				const firstLine = e.resultText.split("\n").find((l) => l.trim()) ?? "";
				return this.event("tool.complete", sid, { tool_id: e.callId, name: e.name, duration_s: Math.round(e.durationS * 100) / 100, result_text: text, summary: (e.isError ? "Failed: " : "") + firstLine.slice(0, 120) });
			}
			case "run.finished": {
				const payload: Record<string, Json | undefined> = { text: redact(e.text), status: e.status, usage: usageJson(e.usage) };
				if (e.reasoning) payload.reasoning = e.reasoning;
				if (e.error) payload.error = e.error;
				this.event("session.usage", sid, { usage: usageJson(e.usage) });
				return this.event("message.complete", sid, payload);
			}
			case "usage":
				return this.event("session.usage", sid, { usage: usageJson(e.usage) });
			case "title":
				return this.event("session.title", sid, { session_id: sid, title: e.title });
			case "notice":
				return e.message.startsWith("Compressing") ? this.event("status.update", sid, { kind: "compacting", text: e.message }) : this.event("notice", sid, { message: e.message });
			case "approval.requested":
				if (!this.answersRequests) return;
				this.sentRequests.add(e.request.requestId);
				return this.send({ jsonrpc: "2.0", id: srqId(e.request.requestId), method: "approval", params: approvalParams(e.request) });
			case "approval.resolved":
				// Hermes withdraws a request only when it times out or the turn is interrupted; an answer from
				// another client is learned through approval.pending.
				if (this.sentRequests.delete(e.requestId) && e.reason !== "answered") {
					this.event("request.cancel", sid, { id: srqId(e.requestId), method: "approval", reason: e.reason === "timeout" ? "timeout" : "interrupted" });
				}
				return;
			default:
				return;
		}
	}

	private async dispatch(method: string, p: Params): Promise<unknown> {
		const { sessions, approvals, engine, bots } = this.core;
		switch (method) {
			case "ping":
				return { pong: true };
			case "client.capabilities":
				this.answersRequests = p.server_requests === true;
				return { server_requests: this.answersRequests ? ["approval"] : [] };
			case "gateway.capabilities":
				return { per_session_exclusive_submit: true };
			case "profiles.list":
				return { profiles: bots.list().filter((b) => !b.isPeer).map((b) => ({ name: b.name, is_default: b.isDefault, display_name: b.displayName })) };
			case "config.get": {
				const key = str(p, "key");
				const bot = this.botOf(p);
				if (key === "profile") return { home: bot.workspace, display: bot.name };
				if (key === "project") return { cwd: bot.workspace, branch: null };
				if (key === "provider") return { model: bot.model.modelId, provider: bot.model.provider };
				throw new RpcError(-32602, `unsupported config key: ${key}`);
			}
			case "session.create": {
				const bot = this.botOf(p);
				const row = await sessions.create(bot.name, { kind: "chat", source: typeof p.source === "string" ? p.source : "ios", title: typeof p.title === "string" ? p.title : undefined });
				await sessions.live(row.id);
				this.attach(row.id);
				return { session_id: row.id, stored_session_id: row.id, message_count: 0, messages: [], info: await this.info(row.id) };
			}
			case "session.resume":
			case "session.activate": {
				const id = str(p, "session_id");
				if (!sessions.get(id)) throw new RpcError(4006, `session not found: ${id}`);
				if (!sessions.isRunning(id)) await sessions.followBot(id);
				return this.snapshotReply(id);
			}
			case "session.close": {
				const id = str(p, "session_id");
				this.attached.get(id)?.();
				this.attached.delete(id);
				return { closed: true };
			}
			case "session.delete": {
				const id = str(p, "session_id");
				await sessions.delete(id);
				this.attached.get(id)?.();
				this.attached.delete(id);
				return { deleted: id };
			}
			case "session.title": {
				const id = str(p, "session_id");
				if (typeof p.title === "string" && p.title.trim()) return { title: sessions.update(id, { title: p.title }).title };
				return { title: sessions.require(id).title };
			}
			case "session.usage":
				return usageJson(await sessions.usage(str(p, "session_id")));
			case "session.context_breakdown": {
				const id = str(p, "session_id");
				const row = sessions.require(id);
				const [stats, usage] = await Promise.all([engine.contextStats(row.conversation_id), sessions.usage(id)]);
				const used = Math.max(usage.contextUsed, stats.system + stats.tools + stats.conversation);
				const max = usage.contextMax;
				return {
					categories: [
						{ id: "system", label: "System prompt", tokens: stats.system, color: "blue" },
						{ id: "tools", label: "Tools", tokens: stats.tools, color: "purple" },
						{ id: "conversation", label: "Conversation", tokens: Math.max(0, used - stats.system - stats.tools), color: "orange" },
						{ id: "free", label: "Free", tokens: Math.max(0, max - used), color: "gray" },
					],
					context_max: max,
					context_percent: max > 0 ? Math.min(100, Math.round((used / max) * 100)) : 0,
					context_used: used,
					estimated_total: used,
					context_estimated: true,
					model: usage.model,
				};
			}
			case "prompt.submit": {
				const id = str(p, "session_id");
				const text = typeof p.text === "string" ? p.text : "";
				if (!text.trim()) throw new RpcError(-32602, "text is required");
				this.attach(id);
				const requestId = typeof p.idempotency_key === "string" ? p.idempotency_key : undefined;
				const r = await sessions.submit(id, text, { requestId, whenBusy: "followUp" });
				// submission_status: our extension, so a client retrying with an idempotency key learns that the
				// earlier submission already finished (Vory ignores it).
				return { status: r.status, submission_status: r.submission };
			}
			case "session.steer": {
				const id = str(p, "session_id");
				const r = await sessions.submit(id, str(p, "text"), { whenBusy: "steer" });
				return { status: r.status === "streaming" ? "streaming" : "queued" };
			}
			case "session.interrupt": {
				const interrupted = await sessions.interrupt(str(p, "session_id"));
				return { status: interrupted ? "interrupted" : "idle", interrupted };
			}
			case "approval.pending": {
				const id = str(p, "session_id");
				return { approvals: approvals.pendingFor(id).map(approvalParams) };
			}
			case "approval.received":
				return { acknowledged: true };
			case "approval.respond": {
				const id = str(p, "session_id");
				const choice = normalizeChoice(typeof p.choice === "string" ? p.choice : "deny");
				const pending = approvals.pendingFor(id);
				const targets = p.all === true ? pending : pending.filter((r) => (typeof p.request_id === "string" ? r.requestId === p.request_id : r === pending[0]));
				let resolved = 0;
				for (const r of targets) if (approvals.answer(r.requestId, choice)) resolved++;
				return { resolved };
			}
			case "config.set":
				return this.configSet(p);
			case "commands.catalog": {
				const id = str(p, "session_id", false);
				const bot = id ? this.core.bots.require(sessions.require(id).bot) : this.botOf(p);
				const usage = this.core.skills.usage(bot.name);
				const skills = this.core.skills.active(bot).filter((s) => s.modelInvocable);
				return {
					pairs: [...COMMANDS.map((c) => [c.name, c.description]), ...skills.map((s) => [s.name, s.description])],
					categories: [],
					canon: { "/compress": "/compact" },
					commands: Object.fromEntries(COMMANDS.map((c) => [`/${c.name}`, { argument_mode: c.args ? "text" : null, desktop: null }])),
					skills: Object.fromEntries(skills.map((s) => [`/${s.name}`, { usage: usage.get(s.name) ?? 0, origin: s.source === "bot" ? "local" : "hub" }])),
					warning: "",
				};
			}
			case "slash.exec":
			case "command.dispatch": {
				const id = str(p, "session_id");
				const command = method === "slash.exec" ? str(p, "command") : `${str(p, "name")} ${typeof p.arg === "string" ? p.arg : ""}`;
				const skill = this.skillCommand(id, command);
				if (skill) return skill;
				const output = await this.slash(id, command);
				return method === "slash.exec" ? { output } : { type: "exec", output };
			}
			case "model.options":
				return modelOptions(this.core, this.botOf(p).model);
			default:
				throw new RpcError(-32601, `unknown method: ${method}`);
		}
	}

	private async configSet(p: Params): Promise<unknown> {
		const key = str(p, "key");
		const id = str(p, "session_id", false);
		const value = typeof p.value === "string" ? p.value : String(p.value ?? "");
		const { sessions, engine, approvals, models } = this.core;
		if (key === "yolo") {
			if (!id) throw new RpcError(-32602, "session_id is required");
			approvals.setYolo(id, value === "on" || value === "true");
			return { key, value: approvals.isYolo(id) ? "on" : "off", scope: "session", info: await this.info(id) };
		}
		if (!id) throw new RpcError(-32602, "session_id is required for this gateway's session settings");
		const row = sessions.require(id);
		if (key === "model") {
			const words = value.split(/\s+/).filter(Boolean);
			const model = words.find((w, i) => !w.startsWith("--") && words[i - 1] !== "--provider");
			const pi = words.indexOf("--provider");
			let provider = pi >= 0 ? words[pi + 1] : undefined;
			let modelId = model ?? "";
			if (!provider && modelId.includes("/") && models.getModel(modelId.slice(0, modelId.indexOf("/")), modelId.slice(modelId.indexOf("/") + 1))) {
				provider = modelId.slice(0, modelId.indexOf("/"));
				modelId = modelId.slice(modelId.indexOf("/") + 1);
			}
			if (!provider || !models.getModel(provider, modelId)) throw new RpcError(4010, `unknown model: ${value}`);
			await engine.configure(row.conversation_id, { model: { provider, modelId } });
			sessions.markOverride(id, "model");
			const busy = sessions.isRunning(id);
			return { key, value: modelId, scope: "session", deferred: busy, info: await this.info(id) };
		}
		if (key === "reasoning") {
			const level = thinkingOf(value);
			if (!level) throw new RpcError(-32602, `unknown reasoning effort: ${value}`);
			await engine.configure(row.conversation_id, { thinkingLevel: level as never });
			sessions.markOverride(id, "thinking");
			return { key, value, scope: "session", info: await this.info(id) };
		}
		if (key === "fast") {
			return { key, value: "off", warning: value === "on" ? "Fast mode is not available on this gateway." : null, info: await this.info(id) };
		}
		throw new RpcError(-32602, `unsupported config key: ${key}`);
	}

	/** `/<skill> [what]`: becomes a prompt that has the bot load and follow that skill (Vory sends it). */
	private skillCommand(sessionId: string, command: string): { type: "skill"; message: string } | undefined {
		const [name = "", ...rest] = command.replace(/^\//, "").trim().split(/\s+/);
		const row = this.core.sessions.require(sessionId);
		const skill = this.core.skills.find(this.core.bots.require(row.bot), name);
		if (!skill) return undefined;
		const what = rest.join(" ").trim();
		return { type: "skill", message: `Use the "${skill.name}" skill (load it with the skill tool first)${what ? ` for: ${what}` : "."}` };
	}

	private async slash(sessionId: string, command: string): Promise<string> {
		const [name = "", ...rest] = command.replace(/^\//, "").trim().split(/\s+/);
		const { sessions, engine } = this.core;
		const row = sessions.require(sessionId);
		switch (name.toLowerCase()) {
			case "compact":
			case "compress":
				await engine.compact(row.conversation_id, rest.join(" ") || undefined);
				return "Compaction started.";
			case "usage": {
				const u = await sessions.usage(sessionId);
				return [`Model ${u.model}`, `input ${u.input}`, `output ${u.output}`, `cache read ${u.cacheRead}`, `context ${u.contextUsed} / ${u.contextMax}`, `cost $${u.costUsd.toFixed(4)}`].join("\n");
			}
			case "status": {
				const info = await this.info(sessionId);
				return `Bot ${row.bot} · model ${info.provider}/${info.model} · reasoning ${info.reasoning_effort} · ${info.running ? "running" : "idle"}`;
			}
			default:
				throw new RpcError(4018, `unknown command: /${name}`);
		}
	}
}

const COMMANDS: { name: string; description: string; args?: boolean }[] = [
	{ name: "new", description: "Start a new chat" },
	{ name: "compact", description: "Compress this chat's context", args: true },
	{ name: "usage", description: "Show token usage for this chat" },
	{ name: "status", description: "Show this chat's bot, model and state" },
];

function normalizeChoice(c: string): Choice {
	return c === "once" || c === "session" || c === "always" || c === "deny" ? c : "deny";
}
