// /api/ws: Hermes JSON-RPC 2.0 over WebSocket (newline-delimited frames). One Connection per socket.
// Translates RPCs onto core services and canonical session events onto Hermes events and
// server→client approval requests. Holds only per-socket bookkeeping.
import { randomBytes } from "node:crypto";
import type { WebSocket } from "ws";
import type { Core } from "../app.ts";
import type { Choice } from "../core/approvals.ts";
import { AttachmentError } from "../core/attachments.ts";
import type { SessionEvent } from "../core/events.ts";
import { RoomError } from "../core/rooms.ts";
import { UnknownSession } from "../core/sessions.ts";
import { LinkError } from "../federation/link.ts";
import type { MemberRow } from "../federation/members.ts";
import { shareable } from "../federation/roster.ts";
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

/** An upload's data: the first of `keys` given, as base64 or a data URL. */
function bytesParam(p: Params, ...keys: string[]): string {
	for (const k of keys) if (typeof p[k] === "string" && p[k]) return p[k];
	throw new RpcError(4015, `${keys[0]} is required`);
}

function num(v: unknown): number | undefined {
	return typeof v === "number" ? v : undefined;
}

const RESULT_TEXT_LIMIT = 4000;

/** The group chat methods this gateway answers (Vory's Bot Mode); not offered to network members. */
const GROUP_METHODS = ["groups.capabilities", "groups.list", "groups.create", "groups.send", "groups.log", "groups.disband"];

/** What a network member may call: chats it started with this gateway's shareable bots. */
const MEMBER_METHODS = new Set([
	"ping",
	"client.capabilities",
	"gateway.capabilities",
	"profiles.list",
	"session.create",
	"session.resume",
	"session.activate",
	"session.close",
	"session.delete",
	"session.title",
	"session.usage",
	"session.context_breakdown",
	"prompt.submit",
	"session.steer",
	"session.interrupt",
	"approval.pending",
	"approval.received",
	"approval.respond",
	"config.set",
	"commands.catalog",
	"slash.exec",
	"command.dispatch",
	"model.options",
]);

/** Calls about a chat with a member's bot that the member answers (approvals and the catalogue stay here). */
const PROXIED = new Set([
	"session.resume",
	"session.activate",
	"prompt.submit",
	"session.steer",
	"session.interrupt",
	"session.title",
	"session.usage",
	"session.context_breakdown",
	"config.set",
	"commands.catalog",
	"slash.exec",
	"command.dispatch",
]);

/**
 * The session source that marks a chat a member started (it is never trusted, see guardExtension).
 * `relayed` marks the owner's own chat passed on from their client on that member (`session.create`
 * with `relay: true`, sent only by ProxySessions); delegated work and anything unmarked stay plain.
 */
export function memberSource(nodeId: string, relayed = false): string {
	return relayed ? `member:${nodeId}:owner` : `member:${nodeId}`;
}

export class Connection {
	private readonly ws: WebSocket;
	private readonly core: Core;
	private readonly attached = new Map<string, () => void>();
	/** Approval request ids this socket was sent and has not seen settled. */
	private readonly sentRequests = new Set<string>();
	private answersRequests = false;
	private readonly offGlobal: () => void;
	private closed = false;
	/** Set when the other end is a network member rather than the owner's client. */
	private readonly member: MemberRow | undefined;

	constructor(ws: WebSocket, core: Core, member?: MemberRow) {
		this.ws = ws;
		this.core = core;
		this.member = member;
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
			const code = error instanceof RpcError || error instanceof LinkError || error instanceof RoomError || error instanceof AttachmentError ? error.code : error instanceof UnknownSession ? 4006 : -32000;
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
		// The owner's client also reaches members' bots (through the proxy); a member reaches only local ones.
		const reachable = bot && (!bot.isPeer || (bot.remote && !this.member)) && !(this.member && bot.private);
		if (!reachable) throw new RpcError(4004, `profile not found: ${name}`);
		return bot;
	}

	/** A call for a chat with a member's bot, answered by the member. */
	private async proxied(sessionId: string, method: string, p: Params): Promise<unknown> {
		this.attach(sessionId);
		const r = await this.core.proxy.forward(sessionId, method, p);
		if (method === "session.resume" || method === "session.activate") {
			// Approvals for this chat are asked here, under this gateway's request ids.
			const pending = this.core.approvals.pendingFor(sessionId);
			r.open_requests = pending.map((a) => ({ id: srqId(a.requestId), method: "approval", params: approvalParams(a) }));
			r.pending_approval = pending[0] ? approvalParams(pending[0]) : null;
			for (const a of pending) this.sentRequests.add(a.requestId);
		}
		return r;
	}

	/** A member reaches only the methods above, and only sessions it created; it cannot switch approvals off. */
	private checkMember(member: MemberRow, method: string, p: Params): void {
		if (!MEMBER_METHODS.has(method)) throw new RpcError(-32601, `unknown method: ${method}`);
		if (typeof p.session_id === "string" && p.session_id) {
			const row = this.core.sessions.get(p.session_id);
			if (row && row.source !== memberSource(member.node_id) && row.source !== memberSource(member.node_id, true)) throw new RpcError(4006, `session not found: ${p.session_id}`);
		}
		if (method === "config.set" && p.key === "yolo") throw new RpcError(4003, "a network member cannot switch approvals off");
		if (method === "session.create" && (typeof p.profile !== "string" || !p.profile || p.profile === "default")) {
			if (this.core.bots.defaultBot().private) throw new RpcError(4004, "profile not found: default");
		}
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
				inflight: snap.inflight ? { ...snap.inflight, user: redact(snap.inflight.user), assistant: redact(snap.inflight.assistant) } : null,
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
		const offHub = this.core.hub.subscribe(sessionId, (sid, e) => this.onSessionEvent(sid, e));
		if (!this.core.proxy.isProxy(sessionId)) return void this.attached.set(sessionId, offHub);
		// A member chat: its events come from the member; only approvals come from the hub.
		const offProxy = this.core.proxy.subscribe(sessionId, (e) => this.event(e.type, e.session_id, e.payload as Record<string, Json>));
		this.attached.set(sessionId, () => (offHub(), offProxy()));
	}

	private onSessionEvent(sid: string, e: SessionEvent): void {
		switch (e.type) {
			case "run.started":
				// Hermes sends message.start once, when the prompt is accepted (prompt_turn.py).
				return this.event("message.start", sid, {});
			case "text.delta":
				return this.event("message.delta", sid, { text: redact(e.text) });
			case "reasoning.delta":
				return this.event("reasoning.delta", sid, { text: redact(e.text) });
			case "tool.started":
				return this.event("tool.start", sid, { tool_id: e.callId, name: e.name, context: redact(e.preview), args: JSON.parse(redact(JSON.stringify(e.args))) as Record<string, Json>, args_text: redact(JSON.stringify(e.args, null, 2)).slice(0, 2000) });
			case "tool.finished": {
				const text = e.resultText.length > RESULT_TEXT_LIMIT ? `${e.resultText.slice(0, RESULT_TEXT_LIMIT)}\n… (${e.resultText.length - RESULT_TEXT_LIMIT} more characters)` : e.resultText;
				const firstLine = e.resultText.split("\n").find((l) => l.trim()) ?? "";
				return this.event("tool.complete", sid, { tool_id: e.callId, name: e.name, duration_s: Math.round(e.durationS * 100) / 100, result_text: redact(text), summary: redact((e.isError ? "Failed: " : "") + firstLine.slice(0, 120)) });
			}
			case "run.finished": {
				const payload: Record<string, Json | undefined> = { text: redact(e.text), status: e.status, usage: usageJson(e.usage) };
				if (e.reasoning) payload.reasoning = redact(e.reasoning);
				if (e.error) payload.error = redact(e.error);
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
		if (this.member) this.checkMember(this.member, method, p);
		const sid = typeof p.session_id === "string" ? p.session_id : "";
		if (sid && PROXIED.has(method) && this.core.proxy.isProxy(sid)) return this.proxied(sid, method, p);
		switch (method) {
			case "ping":
				return { pong: true };
			case "client.capabilities":
				this.answersRequests = p.server_requests === true;
				return { server_requests: this.answersRequests ? ["approval"] : [] };
			case "gateway.capabilities":
				return { per_session_exclusive_submit: true };
			// Group chats (src/core/rooms.ts). Rooms belong to the gateway, so `profile` is ignored.
			case "groups.capabilities":
				return { protocol_version: 1, driver: true, persistent_process: true, features: ["room_identity", "monotonic_log", "idempotent_send", "typed_events", "actor_identity"], methods: GROUP_METHODS, max_log_limit: 500 };
			case "groups.list":
				return this.core.rooms.list({ limit: num(p.limit), offset: num(p.offset), includeDisbanded: p.include_disbanded === true });
			case "groups.create":
				return { room: this.core.rooms.create(p) };
			case "groups.send": {
				const event = this.core.rooms.send(p);
				return { event, client_event_id: p.event_id, accepted: true, driver_started: true };
			}
			case "groups.log":
				return this.core.rooms.log(p);
			case "groups.disband":
				return this.core.rooms.disband(p.room_id);
			case "profiles.list":
				return { profiles: (this.member ? shareable(bots.list()) : bots.list().filter((b) => !b.isPeer || b.remote)).map((b) => ({ name: b.name, is_default: b.isDefault, display_name: b.displayName })) };
			case "config.get": {
				const key = str(p, "key");
				const bot = this.botOf(p);
				if (bot.remote) return this.core.proxy.forBot(bot, method, { key });
				if (key === "profile") return { home: bot.workspace, display: bot.name };
				if (key === "project") return { cwd: bot.workspace, branch: null };
				if (key === "provider") return { model: bot.model.modelId, provider: bot.model.provider };
				throw new RpcError(-32602, `unsupported config key: ${key}`);
			}
			case "session.create": {
				const bot = this.botOf(p);
				if (bot.remote) {
					const r = await this.core.proxy.create(bot, { source: typeof p.source === "string" ? p.source : "ios", title: typeof p.title === "string" ? p.title : undefined });
					this.attach(String(r.session_id));
					return r;
				}
				const source = this.member ? memberSource(this.member.node_id, p.relay === true) : typeof p.source === "string" ? p.source : "ios";
				// kind "room": a bot's session for a group chat another gateway runs (src/core/rooms.ts), kept out of chat lists.
				const kind = p.kind === "room" ? "room" : "chat";
				const row = await sessions.create(bot.name, { kind, source, title: typeof p.title === "string" ? p.title : undefined });
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
				// The total is the provider's own count from the last call; the estimate only splits it up.
				const estimated = stats.system + stats.tools + stats.conversation;
				const used = usage.contextUsed > 0 ? usage.contextUsed : estimated;
				const fixed = stats.system + stats.tools;
				const scale = fixed > used ? used / fixed : 1;
				const system = Math.round(stats.system * scale);
				const tools = Math.round(stats.tools * scale);
				const max = usage.contextMax;
				return {
					categories: [
						{ id: "system", label: "System prompt", tokens: system, color: "blue" },
						{ id: "tools", label: "Tools", tokens: tools, color: "purple" },
						{ id: "conversation", label: "Conversation", tokens: Math.max(0, used - system - tools), color: "orange" },
						{ id: "free", label: "Free", tokens: Math.max(0, max - used), color: "gray" },
					],
					context_max: max,
					context_percent: max > 0 ? Math.min(100, Math.round((used / max) * 100)) : 0,
					context_used: used,
					estimated_total: used,
					context_estimated: usage.contextUsed <= 0,
					model: usage.model,
				};
			}
			case "prompt.submit": {
				const id = str(p, "session_id");
				const text = typeof p.text === "string" ? p.text : "";
				// A message of only pictures comes with no text.
				if (!text.trim() && this.core.attachments.pending(id) === 0) throw new RpcError(-32602, "text is required");
				this.attach(id);
				const requestId = typeof p.idempotency_key === "string" ? p.idempotency_key : undefined;
				const r = await this.core.attachments.submit(id, text, (content) => sessions.submit(id, content, { requestId, whenBusy: "followUp" }));
				// submission_status: our extension, so a client retrying with an idempotency key learns that the
				// earlier submission already finished (Vory ignores it).
				return { status: r.status, submission_status: r.submission };
			}
			// Uploads for the next prompt (Hermes' methods_prompt.py replies; src/core/attachments.ts).
			case "image.attach_bytes": {
				const id = str(p, "session_id");
				sessions.require(id);
				const r = await this.core.attachments.image(id, bytesParam(p, "content_base64", "data"), typeof p.filename === "string" ? p.filename : undefined);
				return { attached: true, path: r.path, name: r.name, count: r.count, remainder: "", text: `[User attached image: ${r.name}]`, bytes: r.bytes };
			}
			case "pdf.attach": {
				const id = str(p, "session_id");
				sessions.require(id);
				if (typeof p.path === "string" && p.path) throw new RpcError(4016, "Send the PDF's contents; this gateway does not read files by path.");
				const r = await this.core.attachments.pdf(id, bytesParam(p, "content_base64", "data"), typeof p.filename === "string" ? p.filename : undefined);
				return { attached: true, filename: r.name, path: r.path, pages_attached: r.pages, pages: [], count: r.count, text: `[User attached PDF: ${r.name} (${r.pages} page(s))]` };
			}
			case "file.attach": {
				const id = str(p, "session_id");
				sessions.require(id);
				if (typeof p.path === "string" && p.path) throw new RpcError(4016, "Send the file's contents; this gateway does not read files by path.");
				const r = this.core.attachments.file(id, bytesParam(p, "data_url"), typeof p.name === "string" ? p.name : undefined);
				return { attached: true, name: r.name, path: r.path, ref_path: r.refPath, ref_text: r.ref, uploaded: true };
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
				if (bot.remote) return this.core.proxy.forBot(bot, method, {});
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
			case "model.options": {
				const bot = this.botOf(p);
				return bot.remote ? this.core.proxy.forBot(bot, method, {}) : modelOptions(this.core, bot.model);
			}
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
