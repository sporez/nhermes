// A bot's open spaces and live views of them (docs/API.md "Watching a space"): the list a client pins in every chat
// with the bot (`spaces.changed` keeps it current), and the link behind a `space` card, made when the owner opens
// it; the owner can also close one. A member's bot's space is viewed through this gateway too: the member makes the
// view for this gateway and it is served here (src/spaces/viewer.ts), so the app only ever talks to the gateway it
// is connected to.
import { SpaceGone } from "../../spaces/spaces.ts";
import { ApiError } from "../errors.ts";
import { localSession } from "../lookup.ts";
import type { Op } from "../ops.ts";
import { spaceJson } from "../shapes/spaces.ts";

export const spaceOps: Op[] = [
	{
		name: "sessions.spaces",
		http: "GET /sessions/:id/spaces",
		members: true,
		forward: true,
		handle: (p, cx) => ({ spaces: cx.core.spaces.list(localSession(cx, p.str("id")).bot).map(spaceJson) }),
	},
	{
		name: "sessions.closeSpace",
		http: "DELETE /sessions/:id/spaces/:space",
		members: true,
		forward: true,
		handle: async (p, cx) => {
			const row = localSession(cx, p.str("id"));
			const space = p.str("space");
			if (!cx.core.spaces.list(row.bot).some((s) => s.id === space)) throw new SpaceGone(`Space ${space} is closed.`);
			await cx.core.spaces.close(row.bot, space, { byOwner: true });
			return {};
		},
	},
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
