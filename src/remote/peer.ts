// Mode B: an independent agent on another machine is another nHermes gateway (its own Durable store, tools
// and memory). This gateway reaches it over that gateway's client API (/api/v1, src/remote/api-client.ts), as
// any client does: a configured `peer:` with the owner's token, a member's bot as a member. Running a task
// there is idempotent (the submission's requestId becomes the other machine's Durable request id) and
// survives a dropped connection: the client reconnects and follows the remote chat again. Approval requests
// from the other machine are handed to a callback (this gateway asks its owner) and answered there.
import { type ForwardedAnswer, type ForwardedRequest, forwardedRequest } from "../core/approvals.ts";
import { cardNote } from "../core/cards.ts";
import { logger } from "../log.ts";
import type { ApiEvent } from "../api/socket.ts";
import { ApiClient, type GatewayTarget, RemoteError } from "./api-client.ts";

const log = logger("peer");

/** A bot on another gateway: where to reach it, and its name there. */
export type PeerTarget = GatewayTarget & { profile?: string };

/** A request from the other machine (an approval or its bot's question), asked of this gateway's owner; the answer goes back. */
export type PeerApproval = (request: ForwardedRequest) => Promise<ForwardedAnswer>;

type RemoteTurn = { id: string; status: string; error?: string; items: { type: string; text?: string; caption?: string }[] };

const machineOf = (t: PeerTarget) => {
	try {
		return new URL(t.url).host;
	} catch {
		return "the other machine";
	}
};

/** The reply text of a turn: its reply parts, as the run's answer, and the captions of the cards it showed. */
function answerOf(turn: RemoteTurn | undefined): string | undefined {
	const parts = turn?.items.flatMap((i) => (i.type === "text" && i.text ? [i.text] : i.type === "card" && i.caption ? [cardNote(i.caption)] : [])) ?? [];
	return parts.length > 0 ? parts.join("\n\n") : undefined;
}

/** Starts an empty chat with the other gateway's bot and returns its id (the first step of a background task). */
export async function createPeerSession(t: PeerTarget, extra: { kind?: "room"; title?: string } = {}): Promise<string> {
	const c = await ApiClient.open(t, machineOf(t));
	try {
		const r = await c.call<{ session: { id: string } }>("sessions.create", { ...(t.profile ? { botId: t.profile } : {}), source: "peer", ...extra });
		return r.session.id;
	} finally {
		c.close();
	}
}

/** Answers the other machine's approval requests for one chat while a task runs there; returns how to stop. */
function relayApprovals(c: ApiClient, sessionId: string, ask: PeerApproval): () => void {
	const asking = new Map<string, AbortController>();
	const off = c.onEvent((e: ApiEvent) => {
		if (e.event === "approval.requested") {
			const a = e.data.approval as { id: string; sessionId: string };
			if (a.sessionId !== sessionId || asking.has(a.id)) return;
			const controller = new AbortController();
			asking.set(a.id, controller);
			// The callback asks this gateway's owner; a withdrawal there (approval.resolved) cancels the question here.
			void withAbort(ask(forwardedRequest(e.data.approval as Record<string, unknown>)), controller.signal)
				.then((answer) => (answer === undefined ? undefined : c.call("approvals.answer", { id: a.id, ...answer })))
				.catch((error: unknown) => log.warn("approval for the other machine not answered", { error: String(error) }))
				.finally(() => asking.delete(a.id));
		} else if (e.event === "approval.resolved") {
			asking.get(String(e.data.id))?.abort();
		}
	});
	return () => {
		off();
		for (const a of asking.values()) a.abort();
	};
}

/** The callback's answer, or undefined once the request was withdrawn on the other machine. */
function withAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
	return new Promise((resolve, reject) => {
		signal.addEventListener("abort", () => resolve(undefined), { once: true });
		p.then(resolve, reject);
	});
}

/**
 * Runs one task on another gateway and returns its answer. `sessionId` (when given) is a remote chat from an
 * earlier attempt of the same task; `key` deduplicates the submission there.
 */
export async function runOnPeer(
	t: PeerTarget,
	task: string,
	opts: {
		key: string;
		sessionId?: string;
		onSession?: (id: string) => Promise<void>;
		onApproval: PeerApproval;
		signal?: AbortSignal;
		timeoutMs?: number;
		/** When the very first connection fails, give up at once with this message instead of retrying. */
		failFast?: string;
		/** Connection attempts before giving up (default 20, about ten minutes of the peer being away). */
		maxAttempts?: number;
	},
): Promise<{ sessionId: string; text: string }> {
	const deadline = Date.now() + (opts.timeoutMs ?? 30 * 60_000);
	let sessionId = opts.sessionId;
	let submitted = false;
	for (let attempt = 0; ; attempt++) {
		if (opts.signal?.aborted) throw new Error("cancelled");
		if (Date.now() > deadline) throw new Error("the peer did not answer in time");
		let c: ApiClient | undefined;
		let stopRelay: (() => void) | undefined;
		try {
			c = await ApiClient.open(t, machineOf(t));
			if (!sessionId) {
				const created = await c.call<{ session: { id: string } }>("sessions.create", { ...(t.profile ? { botId: t.profile } : {}), source: "peer" });
				sessionId = created.session.id;
				await opts.onSession?.(sessionId);
			}
			const id = sessionId;
			stopRelay = relayApprovals(c, id, opts.onApproval);
			// Follow the chat before anything is sent, so its end cannot pass unseen.
			const ended = c.waitEvent((e) => e.event === "turn.finished" && e.sessionId === id, opts.signal);
			ended.catch(() => undefined);
			const snap = await c.call<{ session: { running: boolean }; turns: { items: RemoteTurn[] } }>("sessions.subscribe", { id, limit: 1 });
			const last = snap.turns.items.at(-1);
			if (!submitted || attempt === 0) {
				// Idempotent there: the same key is the same submission.
				const r = await c.call<{ status: string; submission: string }>("sessions.submit", { id, text: task, requestId: opts.key });
				submitted = true;
				log.debug("submitted to peer", { url: t.url, session: id, status: r.status });
				if (r.submission === "done" && answerOf(last)) return { sessionId: id, text: answerOf(last)! };
			}
			if (!snap.session.running && attempt > 0 && answerOf(last)) return { sessionId: id, text: answerOf(last)! };
			const done = await ended;
			if (done.data.status === "error") throw new Error(`the peer's run failed: ${String(done.data.error ?? "")}`);
			const turns = await c.call<{ items: RemoteTurn[] }>("sessions.turns", { id, limit: 1 });
			return { sessionId: id, text: answerOf(turns.items.at(-1)) ?? "" };
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			const code = error instanceof RemoteError ? error.code : "";
			// The other machine no longer has this chat (it restarted before saving it): the task is gone there,
			// and sending it again into a new chat could repeat whatever it was doing, so stop.
			if (sessionId && code === "session_not_found") throw new Error("the other machine no longer has this task (it may have restarted before saving it); nothing was sent again");
			if (attempt === 0 && c === undefined && opts.failFast && code !== "unauthorized") throw new Error(/older nHermes/.test(msg) ? msg : opts.failFast);
			if (code === "unauthorized" || code === "cancelled" || /run failed/.test(msg) || attempt >= (opts.maxAttempts ?? 20)) throw error;
			log.warn("peer connection problem; retrying", { url: t.url, attempt, error: msg });
			await new Promise((r) => setTimeout(r, Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5))));
		} finally {
			stopRelay?.();
			c?.close();
		}
	}
}
