// The `show` tool: the bot decides what the owner is shown as a card in the app (docs/API.md "Cards"): a tool
// result it names by handle (`from`; a picture in the result is kept as an attachment of the chat), or a card it builds
// itself (`card`: list, facts, links, chart, html, or a picture file on its own machine). A handle is
// resolved against the chat's transcript, so it works after a restart. The checked card is kept in the call's own
// result details (the card item is projected from there, with no second lookup), and the call ends the run when it
// was made together with the reply (Pi's `terminate`: no extra model call to say "done").
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import type { Feature, LateServices } from "../app.ts";
import { buildCard, CARD_SCHEMA } from "../core/card-kinds.ts";
import { basename } from "node:path";
import { IMAGE_MAX_BYTES } from "../core/attachments.ts";
import { type BuiltCard, findCardSource, narrowCardData, repeatedResult, type ResultCard, shownPictureText, shownText, SHOW_TOOL } from "../core/cards.ts";
import { redactJson } from "../core/turns.ts";

const MAX_CAPTION = 120;

export function cardsFeature(late: LateServices): Feature {
	const show = defineTool({
		name: SHOW_TOOL,
		description:
			"Show the owner a card in the app. Call it together with your final reply, in the same message: the card appears with your reply and nothing more is needed after it. " +
			"Show what the owner asked for, not the lookups you made along the way. The owner sees the card, so never restate what it shows; write only what it doesn't say. " +
			"Give exactly one of from or card. Pick the most specific card there is: " +
			"(1) from: a tool result whose last line offers it as a card and names the card, for example \"as a Weather card: show {from: ...}\". Always prefer this, and never rebuild by hand data that such a line offers. " +
			"(2) card: build one from what you found, with the first kind that fits, in this order: chart (numbers that compare or change: bar, line, area, point, pie), " +
			"then list (steps, things to buy), facts (labelled values: a status or summary) or links (search results, sources). " +
			"(1b) a picture: from, when a result's line says \"can be shown this picture\" (a screenshot you took); or card {kind: image, path} for a picture file on your machine. The owner sees the picture itself. " +
			"(3) html last, only for a diagram, timeline or layout none of those fits (never for numbers): a fragment with inline <style> and inline <svg>, no scripts or remote content; " +
			"style it with the CSS variables --nh-canvas, --nh-surface, --nh-text, --nh-secondary, --nh-accent and --nh-stroke so it matches the app in light and dark. " +
			"A result with no such line is not offered as a card: say it in your reply, unless the owner asked to see it as a card. " +
			"caption is one short line of yours (for example \"Groceries: 5 reminders\"); it is what the owner reads where cards can't be drawn. only (with from): ids of the items to keep, when the owner asked about some of them.",
		parameters: Type.Object({
			from: Type.Optional(Type.String({ description: "The handle from a result's \"can be shown as a ... card\" line" })),
			card: Type.Optional(CARD_SCHEMA),
			only: Type.Optional(Type.Array(Type.String(), { description: "With from: ids of the items to keep; the others are left out of the card" })),
			caption: Type.String({ description: `One short line, at most ${MAX_CAPTION} characters` }),
		}),
		replay: "safe",
		execute: async (args, api, ctx) => {
			const caption = args.caption.replace(/\s+/g, " ").trim();
			if (!caption) throw new Error("Give the card a caption: one short line saying what it shows.");
			const clip = caption.length > MAX_CAPTION ? `${caption.slice(0, MAX_CAPTION - 1)}…` : caption;
			const from = args.from?.trim();
			if ((from ? 1 : 0) + (args.card === undefined ? 0 : 1) !== 1) throw new Error("Give exactly one of from (a handle from a result's \"can be shown as a card\" line) or card (a card you build).");
			const entries = await late.sessions().entriesOf(api.conversationId as number);
			let card: ResultCard | BuiltCard;
			const keep = (bytes: Buffer, name: string) => {
				const row = late.sessions().byConversation(api.conversationId as number);
				if (!row) throw new Error("This chat is not open, so the picture can't be kept.");
				const { id, kind, name: kept, mime, size } = late.attachments().keepPicture(row.id, bytes, name);
				return { attachment: { id, kind, name: kept, mime, size } };
			};
			if (from) {
				const found = findCardSource(entries, from);
				if (found.picture) {
					if (args.only?.length) throw new Error("only picks items from a result with a list; a picture is shown whole. Leave it out.");
					const data = keep(Buffer.from(found.picture.data, "base64"), found.source.name);
					card = redactJson<BuiltCard>({ kind: "image", caption: clip, source: found.source, data });
					return { output: [{ type: "text" as const, text: shownPictureText(card.caption) }], details: { card } as never, control: { terminate: true as const } };
				}
				const data = args.only?.length ? narrowCardData(found.data, args.only) : found.data;
				card = redactJson<ResultCard>({ kind: "result", caption: clip, source: found.source, data, ...(args.only?.length ? { filtered: true as const } : {}) });
			} else {
				if (args.only?.length) throw new Error("only goes with from: it picks items from a result. Leave it out of a card you build.");
				const built = buildCard(args.card);
				if (built.kind === "image") {
					const path = built.data.path as string;
					const env = api.env;
					if (!env) throw new Error("This bot has no machine to read a picture file from.");
					const info = await env.fileInfo(path, ctx);
					if (!info.ok) throw new Error(`Can't read ${path}: ${info.error.message}`);
					if (info.value.kind !== "file") throw new Error(`${path} is not a file. Give the path of a picture file.`);
					if (info.value.size > IMAGE_MAX_BYTES) throw new Error(`${path} is larger than ${IMAGE_MAX_BYTES / 1024 / 1024} MB, too big to show. Make a smaller picture.`);
					const read = await env.readBinaryFile(path, ctx);
					if (!read.ok) throw new Error(`Can't read ${path}: ${read.error.message}`);
					card = redactJson<BuiltCard>({ kind: "image", caption: clip, data: keep(Buffer.from(read.value), basename(path)) });
					return { output: [{ type: "text" as const, text: shownPictureText(card.caption) }], details: { card } as never, control: { terminate: true as const } };
				}
				const repeated = built.kind === "list" || built.kind === "links" ? repeatedResult(entries, built.data) : undefined;
				if (repeated) throw new Error(`This card repeats the items of a result you can show as it is. Show it with from: "${repeated}" instead.`);
				card = redactJson<BuiltCard>({ kind: built.kind, caption: clip, data: built.data });
			}
			return { output: [{ type: "text" as const, text: shownText(card.caption, card.data) }], details: { card } as never, control: { terminate: true as const } };
		},
	});
	// Every bot has it: showing a result it already has needs no permission, and without it the app shows no cards.
	return { always: [show] as ToolRegistration[] };
}
