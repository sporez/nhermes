// Questions a bot asks the owner with its `ask` tool (src/tools/ask.ts, docs/API.md "Questions"): their shape
// and caps, checking an answer against them, a typed reply taken as an answer, and the text the model reads
// back. The request waits on the approvals broker (src/core/approvals.ts); this file holds no state.

export type QuestionKind = "single" | "multiple" | "text";
export type QuestionOption = { id: string; label: string; detail?: string };
export type Question = { id: string; prompt: string; kind: QuestionKind; options?: QuestionOption[]; other?: boolean };
/** By question id: an option id (single), option ids (multiple), or the owner's words (text, or "other"). */
export type Answers = Record<string, string | string[]>;

export const ASK_TOOL = "ask";
export const MAX_QUESTIONS = 4;
export const MAX_OPTIONS = 8;
export const MAX_ANSWER = 2000;
const MAX_CAPTION = 120;
const MAX_PROMPT = 300;
const MAX_LABEL = 100;
const MAX_DETAIL = 200;
const MAX_ID = 40;

const cut = (s: string, max: number) => {
	const t = s.replace(/\s+/g, " ").trim();
	return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** The caption and questions as the model gave them, checked and capped; throws a plain error the model can act on. */
export function checkQuestions(caption: string, questions: readonly Question[]): { caption: string; questions: Question[] } {
	const c = cut(caption, MAX_CAPTION);
	if (!c) throw new Error("Give the question a caption: one short line saying what you're asking about.");
	if (questions.length === 0) throw new Error("Ask at least one question.");
	if (questions.length > MAX_QUESTIONS) throw new Error(`Ask at most ${MAX_QUESTIONS} questions at once.`);
	const ids = new Set<string>();
	const out = questions.map((q, n) => {
		const id = q.id.trim().slice(0, MAX_ID);
		if (!id) throw new Error(`Question ${n + 1} needs an id.`);
		if (ids.has(id)) throw new Error(`Two questions have the id "${id}"; give each its own.`);
		ids.add(id);
		const prompt = cut(q.prompt, MAX_PROMPT);
		if (!prompt) throw new Error(`Question "${id}" needs a prompt.`);
		if (q.kind === "text") {
			if (q.options?.length) throw new Error(`Question "${id}" is a text question; it takes no options (use single or multiple for choices).`);
			return { id, prompt, kind: q.kind };
		}
		const options = q.options ?? [];
		if (options.length < 2) throw new Error(`Question "${id}" needs at least two options to choose from (or make it a text question).`);
		if (options.length > MAX_OPTIONS) throw new Error(`Question "${id}" has ${options.length} options; give at most ${MAX_OPTIONS}.`);
		const optionIds = new Set<string>();
		const opts = options.map((o) => {
			const oid = o.id.trim().slice(0, MAX_ID);
			if (!oid) throw new Error(`An option of question "${id}" needs an id.`);
			if (optionIds.has(oid)) throw new Error(`Question "${id}" has two options with the id "${oid}".`);
			optionIds.add(oid);
			const label = cut(o.label, MAX_LABEL);
			if (!label) throw new Error(`Option "${oid}" of question "${id}" needs a label.`);
			const detail = o.detail ? cut(o.detail, MAX_DETAIL) : "";
			return { id: oid, label, ...(detail ? { detail } : {}) };
		});
		return { id, prompt, kind: q.kind, options: opts, ...(q.other ? { other: true } : {}) };
	});
	return { caption: c, questions: out };
}

const answerText = (s: string) => s.trim().slice(0, MAX_ANSWER);

/**
 * The owner's answer checked against the questions: every key a question's id, each value the shape its kind
 * takes, at least one answered. Text is trimmed and capped. Throws a plain error for a wrong shape.
 */
export function checkAnswers(questions: readonly Question[], values: unknown): Answers {
	if (typeof values !== "object" || values === null || Array.isArray(values)) throw new Error("values must be an object of answers by question id.");
	const out: Answers = {};
	for (const [key, value] of Object.entries(values as Record<string, unknown>)) {
		const q = questions.find((x) => x.id === key);
		if (!q) throw new Error(`There is no question "${key}" (the questions are: ${questions.map((x) => x.id).join(", ")}).`);
		const ids = new Set((q.options ?? []).map((o) => o.id));
		const pick = (v: unknown, own: { used: boolean }): string => {
			if (typeof v !== "string" || !v.trim()) throw new Error(`The answer to "${q.id}" must be ${q.kind === "text" ? "some text" : "an option id"}.`);
			if (ids.has(v)) return v;
			if (!q.other) throw new Error(`"${v}" is not an option of "${q.id}" (its options are: ${[...ids].join(", ")}).`);
			if (own.used) throw new Error(`"${q.id}" takes one answer in the owner's own words.`);
			own.used = true;
			return answerText(v);
		};
		if (q.kind === "text") {
			if (typeof value !== "string" || !value.trim()) throw new Error(`The answer to "${q.id}" must be some text.`);
			out[key] = answerText(value);
		} else if (q.kind === "single") {
			if (typeof value !== "string") throw new Error(`The answer to "${q.id}" must be one option id.`);
			out[key] = pick(value, { used: false });
		} else {
			if (!Array.isArray(value) || value.length === 0) throw new Error(`The answer to "${q.id}" must be a list of option ids.`);
			const own = { used: false };
			out[key] = [...new Set(value.map((v) => pick(v, own)))];
		}
	}
	if (Object.keys(out).length === 0) throw new Error("Answer at least one of the questions.");
	return out;
}

/**
 * A message typed while the questions wait, as their answer: the first text question's, else the first one that
 * takes the owner's own words, else the first question's (the owner answered in their own words anyway).
 */
export function replyAnswers(questions: readonly Question[], reply: string): Answers {
	const q = questions.find((x) => x.kind === "text") ?? questions.find((x) => x.other) ?? questions[0];
	if (!q) return {};
	const text = answerText(reply);
	return { [q.id]: q.kind === "multiple" ? [text] : text };
}

/** An answer as words: option labels, or the owner's own words. */
function said(q: Question, v: string | string[] | undefined): string {
	if (v === undefined) return "(no answer)";
	const label = (x: string) => q.options?.find((o) => o.id === x)?.label ?? `"${x}"`;
	return Array.isArray(v) ? v.map(label).join(", ") : q.kind === "text" ? `"${v}"` : label(v);
}

/** What the model reads back: the answers as plain lines, or why there are none. */
export function answeredText(questions: readonly Question[], outcome: QuestionOutcome): string {
	if (outcome.answered) return ["The owner answered:", ...questions.map((q) => `${q.prompt} ${said(q, outcome.values[q.id])}`)].join("\n");
	if (outcome.reason === "dismissed") return "The owner dismissed the question without answering. Don't ask it again; go on without it if you can, or wrap up and say what you'd need.";
	if (outcome.reason === "timeout") return "The owner didn't answer in time. Don't ask it again; go on without it if you can, or wrap up and say what you'd need.";
	return "The question was withdrawn before the owner answered (the run was stopped).";
}

/** The question's stand-in where cards are not drawn: the caption, then each question (and its answer, once there is one). */
export function questionNote(caption: string, questions: readonly Question[], answers?: Answers | null): string {
	return [`[Question: ${caption}]`, ...questions.map((q) => (answers ? `${q.prompt} ${said(q, answers[q.id])}` : q.prompt))].join("\n");
}

export type QuestionOutcome = { answered: true; values: Answers } | { answered: false; reason: "dismissed" | "timeout" | "cancelled" };
