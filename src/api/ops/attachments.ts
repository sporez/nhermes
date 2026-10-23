// Uploads (docs/API.md "Attachments"): sending a picture, PDF or any file to a chat as bytes, taking one back
// before the message goes, and opening any of them later. The message names what goes with it by id
// (sessions.submit content blocks); core/attachments.ts keeps the files and their ids.
import { readFileSync } from "node:fs";
import type { Core } from "../../app.ts";
import { type AttachmentKind, FILE_MAX_BYTES, decode } from "../../core/attachments.ts";
import type { Turn } from "../../core/turns.ts";
import { RawBody, readRaw } from "../../http.ts";
import { ApiError } from "../errors.ts";
import { localSession } from "../lookup.ts";
import type { Op, OpContext } from "../ops.ts";
import type { Params } from "../params.ts";

const KINDS: AttachmentKind[] = ["image", "pdf", "file"];

/** Gives the attachments a chat's turns name their ids (the history marks them by path). */
export function identifyAttachments(core: Core, sessionId: string, turns: readonly Turn[]): void {
	const refs = turns.flatMap((t) => (t.user?.content ?? []).flatMap((b) => (b.type === "attachment" ? [b.attachment] : [])));
	if (refs.length > 0) core.attachments.identify(sessionId, refs);
}

/** An upload's bytes and name: the HTTP body (name in X-Filename) or, over the socket, base64 `data`. */
async function uploadOf(p: Params, cx: OpContext): Promise<{ bytes: Buffer; name: string | undefined }> {
	let name = p.optStr("name");
	if (!cx.request) return { bytes: decode(p.str("data"), FILE_MAX_BYTES, "upload"), name };
	const header = cx.request.headers["x-filename"];
	if (typeof header === "string" && !name) name = decodeURIComponent(header);
	return { bytes: await readRaw(cx.request, FILE_MAX_BYTES), name };
}

export const attachmentOps: Op[] = [
	{
		name: "sessions.attach",
		http: "POST /sessions/:id/attachments",
		members: true,
		rawBody: true,
		forward: true,
		// A member's chat: the bytes go on to that machine, which keeps the upload.
		remote: async (p, cx, row) => {
			const { bytes, name } = await uploadOf(p, cx);
			return cx.core.memberChats.forward(row, "sessions.attach", { ...(name ? { name } : {}), ...(p.optStr("kind") ? { kind: p.optStr("kind") } : {}), data: bytes.toString("base64") });
		},
		handle: async (p, cx) => {
			const row = localSession(cx, p.str("id"));
			const { bytes, name } = await uploadOf(p, cx);
			return { attachment: await cx.core.attachments.upload(row.id, bytes, name, p.optEnum("kind", KINDS)) };
		},
	},
	{
		name: "sessions.detach",
		http: "DELETE /sessions/:id/attachments/:attachmentId",
		members: true,
		forward: true,
		handle: (p, cx) => {
			const row = localSession(cx, p.str("id"));
			if (!cx.core.attachments.withdraw(row.id, p.str("attachmentId"))) throw new ApiError("conflict", "That upload already went with a message, or is not in this chat.");
			return { withdrawn: true };
		},
	},
	{
		name: "attachments.content",
		http: "GET /sessions/:id/attachments/:attachmentId/content",
		members: true,
		forward: true,
		remote: async (p, cx, row) => {
			const r = (await cx.core.memberChats.forward(row, "attachments.content", { attachmentId: p.str("attachmentId") })) as { name: string; mime: string; data: string };
			return cx.request ? new RawBody(Buffer.from(r.data, "base64"), r.mime, r.name) : r;
		},
		handle: (p, cx) => {
			const row = localSession(cx, p.str("id"));
			const a = cx.core.attachments.content(p.str("attachmentId"));
			if (!a || a.sessionId !== row.id) throw new ApiError("not_found", "No upload with that id in this chat.");
			let data: Buffer;
			try {
				data = readFileSync(a.path);
			} catch {
				throw new ApiError("not_found", `${a.name} is no longer in the bot's uploads folder.`);
			}
			// Over the socket the bytes travel as base64; over HTTP as themselves.
			return cx.request ? new RawBody(data, a.mime, a.name) : { name: a.name, mime: a.mime, data: data.toString("base64") };
		},
	},
];
