// Push notifications to the owner's devices: what to send and when, whatever carries it. An approval asked
// in a chat is sent at once, and replaced quietly on the devices it reached once it is answered, times out
// or is withdrawn; a chat's turn that finished or failed is sent too (jobs notify through the scheduler, and
// delegated work answers in its parent chat); scheduled-task results, the `notify` tool and other
// notifications arrive through `send`. A chat another gateway in the network started here is that gateway's
// to notify, so a phone registered on both gets each notification once. Transports (src/notify/apns.ts,
// src/notify/vory.ts) only deliver.
import type { Bots } from "../core/bots.ts";
import type { Hub, SessionEvent } from "../core/events.ts";
import type { SessionRow, Sessions } from "../core/sessions.ts";
import { logger } from "../log.ts";
import type { Notification, OptionalNotifier } from "./notifier.ts";

const log = logger("push");

export type PushKind = "approval" | "settled" | "turn" | "error" | "cron" | "notice" | "test";

/** One notification, before a transport shapes it for its devices. Text is redacted by the transport. */
export type PushMessage = {
	kind: PushKind;
	title: string;
	body: string;
	/** The chat it is about (tapping it opens that chat), its bot, and the approval it asks for. */
	sessionId?: string;
	botId?: string;
	approvalId?: string;
	/** The longer text, for a client that shows more than the banner. */
	text?: string;
	/** Notifications with the same key replace each other on a device. */
	collapse?: string;
};

export type TurnUsage = { output: number; contextUsed: number; contextMax: number };

export interface PushTransport {
	readonly name: string;
	/** Whether it has anywhere to send right now. */
	ready(): boolean;
	/** Sends to its devices (only those in `only`, when given) and answers the ids of the ones it reached. */
	push(m: PushMessage, only?: ReadonlySet<string>): Promise<Set<string>>;
	/** A chat's turn ended (what a transport shows beside notifications, such as a Live Activity). */
	turnEnded?(sessionId: string, phase: "done" | "error", usage: TurnUsage): Promise<void>;
}

export type PushOptions = {
	hub: Hub;
	bots: Bots;
	sessions: () => Sessions | undefined;
	transports: PushTransport[];
	/** How long after an approval is settled its banners are replaced (the answering device acts first). */
	settleDelayMs?: number;
};

type Open = { sessionId: string; bot: string; title: string; reached: Map<PushTransport, Set<string>> };

export class Push implements OptionalNotifier {
	readonly name = "push";
	private readonly o: PushOptions & { settleDelayMs: number };
	private readonly open = new Map<string, Open>();
	private readonly timers = new Set<NodeJS.Timeout>();
	private off?: () => void;

	constructor(o: PushOptions) {
		this.o = { ...o, settleDelayMs: o.settleDelayMs ?? 2500 };
	}

	start(): void {
		this.off ??= this.o.hub.subscribeAll((sid, e) => this.onEvent(sid, e));
	}

	stop(): void {
		this.off?.();
		this.off = undefined;
		for (const t of this.timers) clearTimeout(t);
		this.timers.clear();
	}

	ready(): boolean {
		return this.o.transports.some((t) => t.ready());
	}

	/** Scheduled-task results, the notify tool, forwarded notifications. */
	async send(n: Notification): Promise<void> {
		const row = n.sessionId ? this.o.sessions()?.get(n.sessionId) : undefined;
		const botId = n.bot ?? row?.bot;
		const bot = botId ? (this.o.bots.get(botId)?.displayName ?? botId) : undefined;
		const kind: PushKind = n.priority === 1 ? "error" : row?.kind === "job" ? "cron" : "notice";
		const reached = await this.pushAll({
			kind,
			title: bot ? `${bot} · ${n.title}` : n.title,
			body: n.message.slice(0, 300),
			text: n.message.slice(0, 1200),
			...(n.sessionId ? { sessionId: n.sessionId } : {}),
			...(botId ? { botId } : {}),
		});
		if (count(reached) === 0) throw new Error("no device accepted the notification");
	}

	/** A turn of a member's bot finished, in a chat this gateway runs for its client (src/federation/chats.ts). */
	remoteFinished(sessionId: string, t: { text: string; status: string; error?: string }): void {
		this.turnFinished(sessionId, { ...t, usage: { output: 0, contextUsed: 0, contextMax: 0 } }).catch((error) => log.warn("push failed", { error: String(error).slice(0, 300) }));
	}

	private onEvent(sid: string, e: SessionEvent): void {
		if (e.type !== "approval.requested" && e.type !== "approval.resolved" && e.type !== "run.finished") return;
		if (!this.ready()) return;
		const run = async () => {
			if (e.type === "approval.requested") await this.approvalRequested(e.request);
			else if (e.type === "approval.resolved") this.later(this.o.settleDelayMs, () => this.settle(e.requestId, e.reason));
			else await this.turnFinished(sid, { text: e.text, status: e.status, error: e.error, usage: e.usage });
		};
		run().catch((error) => log.warn("push failed", { error: String(error).slice(0, 300) }));
	}

	private about(sessionId: string, fallbackBot = "") {
		const row = this.o.sessions()?.get(sessionId);
		const botId = row?.bot ?? fallbackBot;
		return { row, botId, bot: this.o.bots.get(botId)?.displayName ?? (botId || "nHermes"), title: row?.title || "New chat" };
	}

	private async approvalRequested(r: Extract<SessionEvent, { type: "approval.requested" }>["request"]): Promise<void> {
		const { row, botId, bot, title } = this.about(r.sessionId, r.bot);
		if (drivenElsewhere(row)) return;
		const what = r.description || r.command || "A command is waiting for your decision";
		const reached = await this.pushAll({
			kind: "approval",
			title: `${bot} · approval needed`,
			body: `${title}: ${what.slice(0, 180)}`,
			sessionId: r.sessionId,
			botId,
			approvalId: r.requestId,
			collapse: `approval-${r.requestId}`,
		});
		this.open.set(r.requestId, { sessionId: r.sessionId, bot, title, reached });
	}

	/** The approval is no longer waiting: its banner is replaced, quietly, on every device it reached. */
	private async settle(requestId: string, reason: "answered" | "timeout" | "cancelled"): Promise<void> {
		const o = this.open.get(requestId);
		if (!o) return;
		this.open.delete(requestId);
		const answered = reason === "answered";
		const m: PushMessage = {
			kind: "settled",
			title: answered ? `${o.bot} · approval answered` : o.bot,
			body: answered ? `${o.title}: answered.` : `${o.title}: no longer waiting for an answer.`,
			sessionId: o.sessionId,
			botId: this.about(o.sessionId).botId,
			approvalId: requestId,
			collapse: `approval-${requestId}`,
		};
		await Promise.all([...o.reached].filter(([, ids]) => ids.size > 0).map(([t, ids]) => t.push(m, ids)));
	}

	private async turnFinished(sid: string, e: { text: string; status: string; error?: string; usage: TurnUsage }): Promise<void> {
		const { row, botId, bot, title } = this.about(sid);
		if (!row || row.kind !== "chat" || drivenElsewhere(row)) return;
		const failed = e.status === "error";
		await Promise.all(this.o.transports.filter((t) => t.ready() && t.turnEnded).map((t) => t.turnEnded!(sid, failed ? "error" : "done", e.usage)));
		if (e.status === "interrupted") return;
		if (failed) {
			const err = e.error || "The turn failed.";
			await this.pushAll({ kind: "error", title: `${bot} · turn failed`, body: `${title}: ${err.slice(0, 300)}`, text: err.slice(0, 1200), sessionId: sid, botId, collapse: `turn-${sid}` });
			return;
		}
		const text = e.text.trim() || "Done";
		await this.pushAll({ kind: "turn", title: bot, body: `${title}: ${text.slice(0, 300)}`, text: text.slice(0, 1200), sessionId: sid, botId, collapse: `turn-${sid}` });
	}

	private async pushAll(m: PushMessage): Promise<Map<PushTransport, Set<string>>> {
		const reached = new Map<PushTransport, Set<string>>();
		await Promise.all(
			this.o.transports
				.filter((t) => t.ready())
				.map(async (t) => {
					try {
						reached.set(t, await t.push(m));
					} catch (error) {
						log.warn("push transport failed", { transport: t.name, error: String(error).slice(0, 300) });
					}
				}),
		);
		if (count(reached) > 0) log.info("push sent", { kind: m.kind, devices: count(reached) });
		return reached;
	}

	private later(ms: number, fn: () => Promise<void>): void {
		const t = setTimeout(() => {
			this.timers.delete(t);
			fn().catch((error) => log.warn("push failed", { error: String(error).slice(0, 300) }));
		}, ms);
		t.unref?.();
		this.timers.add(t);
	}
}

const count = (reached: Map<PushTransport, Set<string>>) => [...reached.values()].reduce((n, s) => n + s.size, 0);

/**
 * A chat another gateway in the network started here (its client chats with our bot through it, or one of its
 * bots delegated to ours). That gateway notifies for it.
 */
function drivenElsewhere(row: SessionRow | undefined): boolean {
	return row?.source.startsWith("member:") ?? false;
}
