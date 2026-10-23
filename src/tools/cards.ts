// The `show` tool: the bot decides which tool results the owner is shown as cards in the app (docs/API.md
// "Cards"). It resolves a handle against the chat's transcript, so it works after a restart, keeps the
// resolved data in its own result details (the card is projected from there, with no second lookup), and ends
// the run when it was called together with the reply (Pi's `terminate`: no extra model call to say "done").
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import type { Feature, LateServices } from "../app.ts";
import { type CardDetails, findCardSource, narrowCardData, shownText, SHOW_TOOL } from "../core/cards.ts";
import { redactJson } from "../core/turns.ts";

const MAX_CAPTION = 120;

export function cardsFeature(late: LateServices): Feature {
	const show = defineTool({
		name: SHOW_TOOL,
		description:
			"Show the owner a tool result as a card in the app. A result you can show ends with a line giving its handle. " +
			"Show what the owner asked for, not the lookups you made along the way. Call it together with your final reply, in the same message: " +
			"the card appears with your reply and nothing more is needed after it. The owner sees the card in the app, so never restate what it shows; " +
			"write only what it doesn't say. caption is one short line of yours (for example \"Groceries: 5 reminders\"); it is what the owner reads " +
			"where cards can't be drawn. only: ids of the items to keep, when the owner asked about some of them.",
		parameters: Type.Object({
			from: Type.String({ description: "The handle from the result's \"can be shown as a card\" line" }),
			only: Type.Optional(Type.Array(Type.String(), { description: "Ids of the items to keep; the others are left out of the card" })),
			caption: Type.String({ description: `One short line, at most ${MAX_CAPTION} characters` }),
		}),
		replay: "safe",
		execute: async (args, api) => {
			const caption = args.caption.replace(/\s+/g, " ").trim();
			if (!caption) throw new Error("Give the card a caption: one short line saying what it shows.");
			const entries = await late.sessions().entriesOf(api.conversationId as number);
			const found = findCardSource(entries, args.from.trim());
			const data = args.only?.length ? narrowCardData(found.data, args.only) : found.data;
			const card = redactJson<CardDetails>({ kind: "result", caption: caption.length > MAX_CAPTION ? `${caption.slice(0, MAX_CAPTION - 1)}…` : caption, source: found.source, data, ...(args.only?.length ? { filtered: true as const } : {}) });
			return { output: [{ type: "text" as const, text: shownText(card.caption, card.data) }], details: { card } as never, control: { terminate: true as const } };
		},
	});
	// Every bot has it: showing a result it already has needs no permission, and without it the app shows no cards.
	return { always: [show] as ToolRegistration[] };
}
