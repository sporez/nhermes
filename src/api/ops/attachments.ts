// Uploads (docs/API.md "Attachments"): sending a picture, PDF or any file to a chat as bytes, taking one back
// before the message goes, and opening any of them later. The message names what goes with it by id
// (sessions.submit content blocks); core/attachments.ts keeps the files and their ids.
import { readFileSync } from "node:fs";
import type { Core } from "../../app.ts";
import { type AttachmentKind, FILE_MAX_BYTES, decode } from "../../core/attachments.ts";
import type { Turn } from "../../core/turns.ts";
import { RawBody, readRaw } from "../../http.ts";
import { ApiError } from "../errors.ts";
import { localSession, memberOwns } from "../lookup.ts";
import type { Op } from "../ops.ts";

const KINDS: AttachmentKind[] = ["image", "pdf", "file"];

/** Gives the attachments a chat's turns name their ids (the history marks them by path). */
export function identifyAttachments(core: Core, sessionId: string, turns: readonly Turn[]): void {
	const refs = turns.flatMap((t) => (t.user?.content ?? []).flatMap((b) => (b.type === "attachment" ? [b.attachment] : [])));
	if (refs.length > 0) core.attachments.identify(sessionId, refs);
}

export const attachmentOps: Op[] = [
	{
		name: "sessions.attach",
		http: "POST /sessions/:id/attachments",
		members: true,
		rawBody: true,
		handle: async (p, cx) => {
			const row = localSession(cx, p.str("id"));
			const kind = p.optEnum("kind", KINDS);
			let bytes: Buffer;
			let name = p.optStr("name");
			if (cx.request) {
				const header = cx.request.headers["x-filename"];
				if (typeof header === "string" && !name) name = decodeURIComponent(header);
				bytes = await readRaw(cx.request, FILE_MAX_BYTES);
			} else {
				bytes = decode(p.str("data"), FILE_MAX_BYTES, "upload");
			}
			return { attachment: await cx.core.attachments.upload(row.id, bytes, name, kind) };
		},
	},
	{
		name: "sessions.detach",
		http: "DELETE /sessions/:id/attachments/:attachmentId",
		members: true,
		handle: (p, cx) => {
			const row = localSession(cx, p.str("id"));
			if (!cx.core.attachments.withdraw(row.id, p.str("attachmentId"))) throw new ApiError("conflict", "That upload already went with a message, or is not in this chat.");
			return { withdrawn: true };
		},
	},
	{
		name: "attachments.content",
		http: "GET /attachments/:id/content",
		members: true,
		handle: (p, cx) => {
			const a = cx.core.attachments.content(p.str("id"));
			if (!a || !memberOwns(cx.core.sessions.get(a.sessionId), cx.caller)) throw new ApiError("not_found", "No upload with that id.");
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
