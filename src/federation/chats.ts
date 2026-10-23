// The owner's chats with a network member's bot, on the client API (docs/API.md "Chats with a member's bot").
// The chat is catalogued here (title, preview, pins) under the id its conversation has on the member;
// everything else is the member's: this gateway passes the app's calls on over the member's /api/v1 socket
// (TLS-PSK) and its events back, with the member's bot ids turned into the `<bot>-<node>` ids used here. The
// member's approval requests for these chats are asked here through this gateway's own approvals, so they
// reach the owner the same way a local bot's do, and the answer goes back. (Vory's path for the same chats is
// src/federation/proxy.ts, until the Hermes API goes.)
import { type Approvals, fromMachine } from "../core/approvals.ts";
import type { Bot, Bots } from "../core/bots.ts";
import type { Hub } from "../core/events.ts";
import type { SessionRow, Sessions } from "../core/sessions.ts";
import { logger } from "../log.ts";
import type { ApiEvent } from "../api/socket.ts";
import { ApiClient, RemoteError } from "../remote/api-client.ts";
import type { Members } from "./members.ts";

const log = logger("member-chats");

export type MemberChatsDeps = {
	sessions: () => Sessions;
	bots: Bots;
	members: Members;
	approvals: Approvals;
	hub: Hub;
	/** A member's turn finished in a chat run here (its reply and status): notifications. */
	finished?: (sessionId: string, turn: { text: string; status: string }) => void;
};

type Listener = (e: ApiEvent) => void;

/** One member's socket, reopened while anything here follows or waits on its chats. */
class Link {
	private client: ApiClient | undefined;
	private opening: Promise<ApiClient> | undefined;
	private retry: NodeJS.Timeout | undefined;
	private failures = 0;
	private closed = false;
	/** Chats subscribed on the member through this socket. */
	readonly subscribed = new Set<string>();
	private readonly o: { nodeId: string; chats: MemberChats; deps: MemberChatsDeps };

	constructor(o: { nodeId: string; chats: MemberChats; deps: MemberChatsDeps }) {
		this.o = o;
	}

	private get name(): string {
		return this.o.deps.members.get(this.o.nodeId)?.name ?? "the member";
	}

	async call<T = Record<string, unknown>>(op: string, params: Record<string, unknown>, timeoutMs?: number): Promise<T> {
		const c = await this.connect();
		return c.call<T>(op, params, timeoutMs);
	}

	connect(): Promise<ApiClient> {
		if (this.closed) return Promise.reject(new RemoteError("offline", "link closed"));
		if (this.client && !this.client.closed) return Promise.resolve(this.client);
		this.opening ??= this.open().finally(() => (this.opening = undefined));
		return this.opening;
	}

	private async open(): Promise<ApiClient> {
		const target = this.o.deps.members.target(this.o.nodeId);
		if (!target) throw new RemoteError("not_found", `${this.name} is no longer a member of the network`);
		const c = await ApiClient.open(target, this.name);
		this.client = c;
		this.failures = 0;
		this.subscribed.clear();
		c.onEvent((e) => this.o.chats.onEvent(this.o.nodeId, e));
		c.onClose(() => this.onClose(c));
		return c;
	}

	private onClose(c: ApiClient): void {
		if (this.client !== c) return;
		this.client = undefined;
		const lost = [...this.subscribed];
		this.subscribed.clear();
		// Whoever followed these chats may have missed events: they subscribe again.
		for (const id of lost) this.o.chats.stale(id);
		if (this.closed || !this.o.chats.needsLink(this.o.nodeId)) return;
		const delay = Math.min(30_000, 500 * 2 ** Math.min(this.failures++, 6));
		this.retry = setTimeout(() => {
			this.connect().then(
				() => this.o.chats.relink(this.o.nodeId),
				() => this.onClose(c),
			);
		}, delay);
		this.retry.unref();
	}

	close(): void {
		this.closed = true;
		if (this.retry) clearTimeout(this.retry);
		this.client?.close();
	}
}

export class MemberChats {
	private readonly d: MemberChatsDeps;
	private readonly links = new Map<string, Link>();
	private readonly listeners = new Map<string, Set<Listener>>();
	private readonly running = new Set<string>();
	/** The reply parts of each running turn here, for the catalogue's preview and the notification. */
	private readonly replies = new Map<string, string[]>();
	/** The member's approval request ids → the ask waiting here. */
	private readonly asks = new Map<string, AbortController>();

	constructor(deps: MemberChatsDeps) {
		this.d = deps;
	}

	isRunning(id: string): boolean {
		return this.running.has(id);
	}

	/** Closes the links to machines that are no longer members. */
	dropGone(): void {
		for (const [nodeId, link] of this.links) {
			if (this.d.members.get(nodeId)) continue;
			link.close();
			this.links.delete(nodeId);
		}
	}

	close(): void {
		for (const l of this.links.values()) l.close();
		this.links.clear();
	}

	/** Starts a chat with a member's bot; it is the owner's own chat there (`relay`), not delegated work. */
	async create(bot: Bot, opts: { title?: string; source?: string }): Promise<SessionRow> {
		const remote = this.remoteOf(bot);
		const r = await this.link(remote.nodeId).call<{ session: { id: string } }>("sessions.create", { botId: remote.bot, relay: true, ...(opts.title ? { title: opts.title } : {}) });
		const id = r.session.id;
		if (!id) throw new RemoteError("internal", `${remote.node} did not start a chat`);
		return this.d.sessions().registerRemote(id, bot.name, remote.nodeId, { source: opts.source ?? "app", title: opts.title });
	}

	/** Passes one call about a chat with a member's bot to the member; its answer comes back with local ids. */
	async forward(row: SessionRow, op: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
		const bot = this.botOf(row);
		const r = await this.link(row.remote_node!).call<Record<string, unknown>>(op, { ...params, id: row.id });
		if (op === "sessions.submit" || op === "sessions.steer") {
			const text = typeof params.text === "string" ? params.text : "";
			if (text) this.d.sessions().recordRemote(row.id, { prompt: text });
		}
		if (op === "sessions.subscribe") this.link(row.remote_node!).subscribed.add(row.id);
		return localize(r, bot);
	}

	/** A call about one of a member's bots that is not about a chat (its models). */
	async forBot(bot: Bot, op: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
		const remote = this.remoteOf(bot);
		return localize(await this.link(remote.nodeId).call<Record<string, unknown>>(op, { ...params, botId: remote.bot }), bot);
	}

	/** The chat was deleted here: delete it on the member too (best effort). */
	async deleted(row: SessionRow): Promise<void> {
		this.running.delete(row.id);
		await this.link(row.remote_node!)
			.call("sessions.delete", { id: row.id })
			.catch((e: unknown) => log.warn("could not delete the chat on the member", { session: row.id, error: String(e) }));
	}

	/** Follows a chat's events (a client has it open). The member side is subscribed by the snapshot call. */
	follow(id: string, fn: Listener): () => void {
		const nodeId = this.d.sessions().get(id)?.remote_node ?? "";
		let set = this.listeners.get(id);
		if (!set) this.listeners.set(id, (set = new Set()));
		set.add(fn);
		return () => {
			set.delete(fn);
			if (set.size > 0) return;
			this.listeners.delete(id);
			const link = this.links.get(nodeId);
			if (link?.subscribed.delete(id)) void link.call("sessions.unsubscribe", { id }).catch(() => undefined);
		};
	}

	/** Whether this gateway still needs the member's socket: a chat there is followed here, or running. */
	needsLink(nodeId: string): boolean {
		const sessions = this.d.sessions();
		return [...this.listeners.keys(), ...this.running].some((id) => sessions.get(id)?.remote_node === nodeId);
	}

	/** The socket came back: chats that were running are followed again, so their end and approvals arrive. */
	relink(nodeId: string): void {
		const link = this.links.get(nodeId);
		if (!link) return;
		for (const id of this.running) {
			if (this.d.sessions().get(id)?.remote_node !== nodeId) continue;
			void link
				.call<{ session: { running?: boolean } }>("sessions.subscribe", { id, limit: 1 })
				.then((snap) => {
					link.subscribed.add(id);
					if (snap.session.running === false) this.setRunning(id, false);
				})
				.catch((e: unknown) => log.debug("resubscribe after reconnect failed", { session: id, error: String(e) }));
		}
	}

	/** Tells those following a chat that they may have missed events and should subscribe again. */
	stale(id: string): void {
		this.emit(id, { event: "session.stale", sessionId: id, at: Date.now(), data: {} });
	}

	onEvent(nodeId: string, e: ApiEvent): void {
		if (e.event === "approval.requested") return void this.ask(nodeId, e.data.approval as RemoteApproval);
		if (e.event === "approval.resolved") return void this.asks.get(String(e.data.id))?.abort();
		const id = e.sessionId ?? (e.event === "session.updated" ? String((e.data.session as { id?: unknown } | undefined)?.id ?? "") : "");
		const row = id ? this.d.sessions().get(id) : undefined;
		if (!row || row.remote_node !== nodeId) return;
		const sessions = this.d.sessions();
		switch (e.event) {
			case "turn.started":
				this.replies.set(id, []);
				this.setRunning(id, true);
				break;
			case "item.finished": {
				const item = e.data.item as { type?: string; text?: string };
				if (item.type === "text" && item.text) this.replies.get(id)?.push(item.text);
				break;
			}
			case "turn.finished": {
				const text = (this.replies.get(id) ?? []).join("\n\n");
				this.replies.delete(id);
				this.setRunning(id, false);
				sessions.recordRemote(id, { answer: text });
				this.d.finished?.(id, { text, status: String(e.data.status ?? "complete") });
				break;
			}
			case "session.updated": {
				const title = (e.data.session as { title?: unknown }).title;
				if (typeof title === "string" && title && title !== row.title) sessions.recordRemote(id, { title });
				return;
			}
			case "session.deleted":
				return;
		}
		if (e.sessionId) this.emit(id, localize(e as unknown as Record<string, unknown>, this.botOf(row)) as unknown as ApiEvent);
	}

	private emit(id: string, e: ApiEvent): void {
		for (const fn of this.listeners.get(id) ?? []) fn(e);
	}

	private setRunning(id: string, running: boolean): void {
		if (running === this.running.has(id)) return;
		if (running) this.running.add(id);
		else this.running.delete(id);
		const row = this.d.sessions().get(id);
		if (row) this.d.hub.publishGlobal({ type: "sessions.changed", bot: row.bot, sessionId: id });
	}

	/** A member's approval request for a chat catalogued here is asked here, and the answer goes back. */
	private async ask(nodeId: string, a: RemoteApproval): Promise<void> {
		const row = this.d.sessions().get(a.sessionId);
		// A group chat turn's own connection asks for it (src/core/rooms.ts); asking here too would show two cards.
		if (!row || row.remote_node !== nodeId || row.kind === "room" || this.asks.has(a.id)) return;
		const node = this.d.members.get(nodeId)?.name ?? "another machine";
		const controller = new AbortController();
		this.asks.set(a.id, controller);
		try {
			const choice = await this.d.approvals.ask(
				{
					sessionId: row.id,
					bot: row.bot,
					toolName: a.toolName ?? "tool",
					command: a.command ?? "",
					description: fromMachine(node, a.description ?? "needs approval"),
					patternKey: `member:${nodeId}:${a.patternKey ?? ""}`,
				},
				controller.signal,
			);
			if (!controller.signal.aborted) await this.link(nodeId).call("approvals.answer", { id: a.id, choice });
		} catch (error) {
			log.warn("approval for a member's chat not answered there", { session: row.id, error: String(error) });
		} finally {
			this.asks.delete(a.id);
		}
	}

	private link(nodeId: string): Link {
		if (!this.d.members.get(nodeId)) {
			this.links.get(nodeId)?.close();
			this.links.delete(nodeId);
			throw new RemoteError("not_found", "that machine is no longer a member of the network");
		}
		let link = this.links.get(nodeId);
		if (!link) this.links.set(nodeId, (link = new Link({ nodeId, chats: this, deps: this.d })));
		return link;
	}

	private remoteOf(bot: Bot): NonNullable<Bot["remote"]> {
		if (!bot.remote) throw new RemoteError("bot_not_found", `No bot with id ${bot.name}.`);
		return bot.remote;
	}

	private botOf(row: SessionRow): Bot {
		const bot = this.d.bots.get(row.bot);
		if (!bot?.remote) throw new RemoteError("bot_not_found", `${row.bot} is no longer in the network`);
		return bot;
	}
}

type RemoteApproval = { id: string; sessionId: string; toolName?: string; command?: string; description?: string; patternKey?: string };

/** The member names its bot by its own name; here it is `<bot>-<node>`. */
function localize<T>(value: T, bot: Bot): T {
	const fix = (v: unknown): void => {
		if (!v || typeof v !== "object") return;
		if (Array.isArray(v)) return v.forEach(fix);
		const o = v as Record<string, unknown>;
		if (o.botId === bot.remote?.bot) o.botId = bot.name;
		for (const x of Object.values(o)) if (x && typeof x === "object") fix(x);
	};
	fix(value);
	return value;
}
