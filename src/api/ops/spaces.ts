// Live views of a bot's spaces (docs/API.md "Spaces"): the link behind a `space` card, made when the owner opens
// it. A member's bot's space is viewed through this gateway too: the member makes the view for this gateway and
// it is served here (src/spaces/viewer.ts), so the app only ever talks to the gateway it is connected to.
import { ApiError } from "../errors.ts";
import { localSession } from "../lookup.ts";
import type { Op } from "../ops.ts";

export const spaceOps: Op[] = [
	{
		name: "sessions.viewSpace",
		http: "POST /sessions/:id/spaces/:space/view",
		members: true,
		forward: true,
		remote: async (p, cx, row) => {
			const r = (await cx.core.memberChats.forward(row, "sessions.viewSpace", { space: p.str("space"), control: p.optBool("control") ?? false })) as { view?: { path?: unknown; expiresAt?: unknown } };
			if (typeof r.view?.path !== "string" || typeof r.view.expiresAt !== "number") throw new ApiError("internal", "The other machine gave a view this gateway could not use.");
			return { view: cx.core.viewer.relay(row.remote_node!, r.view.path, r.view.expiresAt) };
		},
		handle: async (p, cx) => {
			const row = localSession(cx, p.str("id"));
			const member = cx.caller.kind === "member" ? cx.caller.member.node_id : undefined;
			return { view: await cx.core.viewer.open(row.bot, p.str("space"), { control: p.optBool("control") ?? false, ...(member ? { member } : {}) }) };
		},
	},
];
