// The gateway itself: the hello every client reads first (what this gateway is and offers), and ping.
import { randomUUID } from "node:crypto";
import type { Core } from "../../app.ts";
import { FILE_MAX_BYTES, IMAGE_MAX_BYTES } from "../../core/attachments.ts";
import { VERSION } from "../../version.ts";
import type { Caller, Op } from "../ops.ts";

/** The API's version. Only a breaking change raises it (docs/API.md "Evolution"). */
export const API_VERSION = 1;

/** This process: a client that sees a new one after reconnecting knows the gateway restarted. */
export const BOOT_ID = randomUUID();

/**
 * What this gateway offers beyond the core chat operations. A client shows a feature only when its name is
 * here; a new capability is a new name.
 */
export const FEATURES: string[] = ["events.replay", "cards", "questions", "spaces.view"];

/** Sizes a client should respect, so it can tell the user before sending something that will be refused. */
export const LIMITS = {
	/** Characters of a tool result sent in a turn; a longer one is marked truncated and fetched on its own. */
	toolResultChars: 64 * 1024,
	imageBytes: IMAGE_MAX_BYTES,
	fileBytes: FILE_MAX_BYTES,
};

export function hello(core: Core, caller: Caller) {
	const self = core.members.self();
	return {
		api: API_VERSION,
		gateway: { id: self.id, name: self.name, version: VERSION, commit: core.updates.status().current?.hash ?? null },
		bootId: BOOT_ID,
		features: [...FEATURES, ...(core.apns.configured() ? ["push.apns"] : [])],
		limits: LIMITS,
		caller: caller.kind === "member" ? { kind: "member", node: { id: caller.member.node_id, name: caller.member.name } } : { kind: "owner" },
	};
}

export const gatewayOps: Op[] = [
	{ name: "gateway.hello", http: "GET /", members: true, handle: (_p, cx) => hello(cx.core, cx.caller) },
	{ name: "ping", http: "GET /ping", members: true, handle: () => ({ pong: true, at: Date.now() }) },
];
