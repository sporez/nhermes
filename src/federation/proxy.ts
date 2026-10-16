// Chats with a member's bot, for the owner's own client (Vory). The chat is catalogued here (title,
// preview, pins, unread) under the id its conversation has on the member; everything else goes to the
// member over its link: prompts, steering, interrupts and settings, and back come the member's events,
// passed on unchanged apart from the bot's name. The member's approval requests are asked here through
// this gateway's own approvals, so they reach the owner the same way a local bot's do.
import type { Approvals } from "../core/approvals.ts";
import type { Bot, Bots } from "../core/bots.ts";
import type { Hub } from "../core/events.ts";
import type { SessionRow, Sessions } from "../core/sessions.ts";
import { logger } from "../log.ts";
import { LinkError, type LinkEvent, MemberLink } from "./link.ts";
import type { Members } from "./members.ts";

const log = logger("proxy");

export type ProxyDeps = {
	sessions: () => Sessions;
	bots: Bots;
	members: Members;
	approvals: Approvals;
	hub: Hub;
	/** A member's turn finished in a chat run here (its `message.complete` payload): notifications. */
	finished?: (sessionId: string, payload: Record<string, unknown>) => void;
};

type Reply = Record<string, unknown>;

export class ProxySessions {
	private readonly d: ProxyDeps;
	private readonly links = new Map<string, MemberLink>();
	private readonly listeners = new Map<string, Set<(e: LinkEvent) => void>>();
	private readonly running = new Set<string>();
	/** The member's approval request ids (as `srq-…`) → the ask waiting here. */
	private readonly asks = new Map<string, AbortController>();

	constructor(deps: ProxyDeps) {
		this.d = deps;
	}

	/** Whether a session is a chat with a member's bot. */
	isProxy(id: string): boolean {
		return Boolean(this.d.sessions().get(id)?.remote_node);
	}

	isRunning(id: string): boolean {
		return this.running.has(id);
	}

	/** Starts a chat with a member's bot; `relay` tells the member it is the owner's own chat, not delegated work. */
	async create(bot: Bot, opts: { source?: string; title?: string }): Promise<Reply> {
		const remote = this.remoteOf(bot);
		const r = await this.link(remote.nodeId).call<Reply>("session.create", { profile: remote.bot, relay: true, ...(opts.title ? { title: opts.title } : {}) });
		const id = String(r.session_id ?? "");
		if (!id) throw new LinkError(-32000, `${remote.node} did not start a chat`);
		this.d.sessions().registerRemote(id, bot.name, remote.nodeId, opts);
		return this.localize(bot, r);
	}

	/** Passes one call for a member chat to the member. */
	async forward(id: string, method: string, params: Reply): Promise<Reply> {
		const row = this.d.sessions().require(id);
		const bot = this.botOf(row);
		const r = await this.link(row.remote_node!).call<Reply>(method, params);
		const sessions = this.d.sessions();
		if ((method === "prompt.submit" || method === "session.steer") && typeof params.text === "string") sessions.recordRemote(id, { prompt: params.text });
		if (method === "session.title" && typeof r.title === "string") sessions.recordRemote(id, { title: r.title });
		if ((method === "session.resume" || method === "session.activate") && typeof r.running === "boolean") this.setRunning(id, r.running);
		return this.localize(bot, r);
	}

	/** A call about one of a member's bots that is not about a chat (model options, commands, config). */
	async forBot(bot: Bot, method: string, params: Reply): Promise<Reply> {
		const remote = this.remoteOf(bot);
		return this.localize(bot, await this.link(remote.nodeId).call<Reply>(method, { ...params, profile: remote.bot }));
	}

	/** The chat's messages, read from the member. */
	async messages(row: SessionRow): Promise<unknown[]> {
		const r = await this.forward(row.id, "session.resume", { session_id: row.id });
		return Array.isArray(r.messages) ? r.messages : [];
	}

	/** Watches a chat's events (a client has it open). */
	subscribe(id: string, fn: (e: LinkEvent) => void): () => void {
		let set = this.listeners.get(id);
		if (!set) this.listeners.set(id, (set = new Set()));
		set.add(fn);
		return () => {
			set.delete(fn);
			if (set.size === 0) this.listeners.delete(id);
		};
	}

	/** The chat was deleted here: delete it on the member too (best effort). */
	async deleted(row: SessionRow): Promise<void> {
		await this.link(row.remote_node!)
			.call("session.delete", { session_id: row.id })
			.catch((e: unknown) => log.warn("could not delete the chat on the member", { session: row.id, error: String(e) }));
	}

	close(): void {
		for (const l of this.links.values()) l.close();
		this.links.clear();
	}

	private link(nodeId: string): MemberLink {
		const m = this.d.members.get(nodeId);
		if (!m) {
			this.links.get(nodeId)?.close();
			this.links.delete(nodeId);
			throw new LinkError(4004, "that machine is no longer a member of the network");
		}
		let link = this.links.get(nodeId);
		if (!link) {
			link = new MemberLink({
				name: m.name,
				target: () => this.d.members.target(nodeId),
				onEvent: (e) => this.onEvent(nodeId, e),
				onRequest: (method, params) => this.onRequest(nodeId, method, params),
				watched: () => [...this.listeners.keys()].filter((id) => this.d.sessions().get(id)?.remote_node === nodeId),
			});
			this.links.set(nodeId, link);
		}
		return link;
	}

	private remoteOf(bot: Bot): NonNullable<Bot["remote"]> {
		if (!bot.remote) throw new LinkError(4004, `profile not found: ${bot.name}`);
		return bot.remote;
	}

	private botOf(row: SessionRow): Bot {
		const bot = this.d.bots.get(row.bot);
		if (!bot?.remote) throw new LinkError(4004, `${row.bot} is no longer in the network`);
		return bot;
	}

	private setRunning(id: string, running: boolean): void {
		if (running === this.running.has(id)) return;
		if (running) this.running.add(id);
		else this.running.delete(id);
		const row = this.d.sessions().get(id);
		if (row) this.d.hub.publishGlobal({ type: "sessions.changed", bot: row.bot });
	}

	private onEvent(nodeId: string, e: LinkEvent): void {
		const id = e.session_id;
		const row = id ? this.d.sessions().get(id) : undefined;
		if (!row || row.remote_node !== nodeId) return;
		const payload = e.payload ?? {};
		switch (e.type) {
			case "request.cancel":
				// The member withdrew an approval request: withdraw the one asked here (its own request.cancel follows).
				this.asks.get(String(payload.id ?? ""))?.abort();
				return;
			case "message.start":
				this.setRunning(id, true);
				break;
			case "message.complete":
				this.setRunning(id, false);
				this.d.sessions().recordRemote(id, { answer: typeof payload.text === "string" ? payload.text : "" });
				this.d.finished?.(id, payload);
				break;
			case "session.title":
				if (typeof payload.title === "string") this.d.sessions().recordRemote(id, { title: payload.title });
				break;
		}
		const bot = this.d.bots.get(row.bot);
		const out = bot ? (this.localize(bot, { type: e.type, session_id: id, payload }) as LinkEvent) : e;
		for (const fn of this.listeners.get(id) ?? []) fn(out);
	}

	private async onRequest(nodeId: string, method: string, params: Reply): Promise<unknown> {
		if (method !== "approval") return undefined;
		const id = String(params.session_id ?? "");
		const row = this.d.sessions().get(id);
		if (!row || row.remote_node !== nodeId) return { choice: "deny" };
		const node = this.d.members.get(nodeId)?.name ?? "another machine";
		const key = `srq-${String(params.request_id ?? "")}`;
		const controller = new AbortController();
		this.asks.set(key, controller);
		try {
			const choice = await this.d.approvals.ask(
				{
					sessionId: id,
					bot: row.bot,
					toolName: String(params.tool_name ?? "tool"),
					command: String(params.command ?? ""),
					description: `${String(params.description ?? "needs approval")} (on ${node})`,
					patternKey: `member:${nodeId}:${String(params.pattern_key ?? "")}`,
				},
				controller.signal,
			);
			return { choice };
		} finally {
			this.asks.delete(key);
		}
	}

	/** The member calls its bot by its own name; here it is `<bot>-<node>`. */
	private localize(bot: Bot, r: Reply): Reply {
		const fix = (v: unknown): void => {
			if (!v || typeof v !== "object") return;
			const o = v as Reply;
			if (o.profile_name === bot.remote?.bot) o.profile_name = bot.name;
			if (o.profile === bot.remote?.bot) o.profile = bot.name;
			if ("cwd" in o && typeof o.cwd === "string") o.cwd = "";
			for (const k of ["info", "payload"]) fix(o[k]);
		};
		fix(r);
		return r;
	}
}
