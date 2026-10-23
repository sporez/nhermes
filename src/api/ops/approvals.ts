// Approvals (docs/API.md "Approvals"): the requests waiting for the owner (approvals and bots' questions), and
// answering one from any device.
// The rules themselves are the server's (core/approvals.ts, core/policy.ts); a client only answers what the
// gateway asked. Every owner socket hears each request and each answer, whoever gave it.
import type { Choice } from "../../core/approvals.ts";
import { ApiError } from "../errors.ts";
import { memberOwns, sessionOf } from "../lookup.ts";
import type { Op } from "../ops.ts";
import { approvalJson } from "../shapes/chat.ts";

const CHOICES: Choice[] = ["once", "session", "always", "deny"];

export const approvalOps: Op[] = [
	{
		name: "approvals.list",
		http: "GET /approvals",
		members: true,
		handle: (p, cx) => {
			const id = p.optStr("sessionId");
			const all = id ? cx.core.approvals.pendingFor(sessionOf(cx, id).id) : cx.core.approvals.allPending();
			return { items: all.filter((r) => memberOwns(cx.core.sessions.get(r.sessionId), cx.caller)).map(approvalJson) };
		},
	},
	{
		name: "approvals.answer",
		http: "POST /approvals/:id",
		members: true,
		handle: (p, cx) => {
			const id = p.str("id");
			const request = cx.core.approvals.allPending().find((r) => r.requestId === id);
			if (!request || !memberOwns(cx.core.sessions.get(request.sessionId), cx.caller)) throw new ApiError("approval_not_found", GONE);
			const values = p.raw.values;
			// A question is answered with its values (choice "answer", which may be left out) or dismissed.
			const choice = request.kind === "question" ? (p.optEnum("choice", ["answer", "dismiss"] as const) ?? (values === undefined ? undefined : "answer")) : p.optEnum("choice", CHOICES);
			if (!choice) throw new ApiError("invalid_params", request.kind === "question" ? "A question is answered with values, or choice \"dismiss\"." : `choice is required: ${CHOICES.join(", ")}.`);
			let answered: boolean;
			try {
				answered = cx.core.approvals.answer(id, choice, values);
			} catch (error) {
				throw new ApiError("invalid_params", error instanceof Error ? error.message : String(error));
			}
			if (!answered) throw new ApiError("approval_not_found", GONE);
			return { answered: true };
		},
	},
];

const GONE = "That request is not waiting any more (answered, withdrawn or timed out).";
