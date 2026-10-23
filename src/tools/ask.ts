// The `ask` tool: the bot asks the owner something it needs before going on, as a question card in the app
// (docs/API.md "Questions"). The question waits on the approvals broker (src/core/approvals.ts), so it is in
// Waiting for You, notifies, reaches the owner through other machines, and is withdrawn by a stop. The answer is
// the call's result and the bot carries on in the same turn. Replay-safe: after a restart the question is asked
// again. Its own timeout is the gateway's question timeout, and in a scheduled run at most until the task's
// next occurrence (the scheduler skips an occurrence while a run is still going).
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import type { Feature, LateServices } from "../app.ts";
import type { Approvals } from "../core/approvals.ts";
import type { QuestionCard } from "../core/cards.ts";
import { answeredText, ASK_TOOL, checkQuestions, MAX_OPTIONS, MAX_QUESTIONS } from "../core/questions.ts";
import { redactJson } from "../core/turns.ts";

export type AskDeps = {
	approvals: () => Approvals;
	/** The chat the owner answers in (a delegated task asks in its caller's chat). */
	attentionSession: (sessionId: string) => string;
	/** When a scheduled task's next occurrence is due (ms), for a question asked in its run. */
	deadline: (sessionId: string) => number | undefined;
};

export function askFeature(late: LateServices, deps: AskDeps): Feature {
	const option = Type.Object({
		id: Type.String({ description: "Short id of the option, unique within the question" }),
		label: Type.String({ description: "What the owner reads, a few words" }),
		detail: Type.Optional(Type.String({ description: "One line more, when the label needs it" })),
	});
	const question = Type.Object({
		id: Type.String({ description: "Short id, unique among the questions (the answer is keyed by it)" }),
		prompt: Type.String({ description: "The question, one sentence" }),
		kind: Type.Union([Type.Literal("single"), Type.Literal("multiple"), Type.Literal("text")], { description: "single: pick one option; multiple: pick any; text: a short answer in the owner's words" }),
		options: Type.Optional(Type.Array(option, { description: `For single and multiple: 2 to ${MAX_OPTIONS} options` })),
		other: Type.Optional(Type.Boolean({ description: "true adds a field for an answer in the owner's own words" })),
	});
	const ask = defineTool({
		name: ASK_TOOL,
		description:
			"Ask the owner a question and wait for the answer, which comes back as this tool's result; then carry on. " +
			"Ask when the answer changes what you'll do and you can't reasonably choose yourself. Ask instead of listing options in your reply. " +
			"Don't ask to confirm something before doing it: actions that need the owner's approval are asked for on their own. " +
			`Up to ${MAX_QUESTIONS} questions at once, each with choices (single or multiple) or a short text answer. ` +
			"Never ask for passwords, keys, codes or other secrets: those are set up as secrets, never typed into a chat. " +
			"If the owner dismisses the question or doesn't answer, don't ask again; go on without it or wrap up. " +
			"caption is one short line saying what you're asking about (for example \"Dinner plans\").",
		parameters: Type.Object({
			caption: Type.String({ description: "One short line, at most 120 characters" }),
			questions: Type.Array(question, { description: `1 to ${MAX_QUESTIONS} questions` }),
		}),
		replay: "safe",
		execute: async (args, api, ctx) => {
			const sessions = late.sessions();
			const row = sessions.byConversation(api.conversationId as number);
			const bot = sessions.botOf(api.conversationId as number);
			if (!row || !bot) throw new Error("this conversation is not a known session");
			const { caption, questions } = checkQuestions(args.caption, args.questions);
			const attention = deps.attentionSession(row.id);
			const limit = late.config.defaults.questionTimeoutS * 1000;
			const next = deps.deadline(attention);
			const timeoutMs = next === undefined ? limit : Math.max(1000, Math.min(limit, next - Date.now()));
			const outcome = await deps.approvals().question(
				{
					sessionId: attention,
					toolCallId: api.callId,
					callSessionId: row.id,
					bot: bot.name,
					caption,
					questions,
					description: attention === row.id ? caption : `${caption} (asked by ${bot.displayName} in a delegated task)`,
					timeoutMs,
				},
				ctx.abortSignal ?? new AbortController().signal,
			);
			const answers = outcome.answered ? outcome.values : null;
			const card = redactJson<QuestionCard>({ kind: "question", caption, data: { questions, answers } });
			return { output: [{ type: "text" as const, text: answeredText(questions, outcome) }], details: { card, structured: { answers: card.data.answers } } as never };
		},
	});
	// Every bot has it, like `show`: asking the owner needs no permission.
	return { always: [ask] as ToolRegistration[] };
}
