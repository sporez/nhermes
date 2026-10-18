// Tools for the user's OpenChamber threads (a desktop UI over OpenCode): look at what each thread is doing
// and what is waiting on the user (oc_sessions, oc_read, oc_waiting, oc_diff), and act on a thread
// (oc_approve, oc_answer, oc_stop, oc_prompt, oc_start; each asks the owner first, see core/policy.ts). Talks to OpenChamber's local server through src/openchamber/client.ts;
// the token never passes through the model.
import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import type { Feature, LateServices } from "../app.ts";
import { clip, condenseMessages, type Message, modelRef, OpenChamber, OpenChamberError, type Page, type SessionInfo, when } from "../openchamber/client.ts";

export type OpenChamberToolOptions = {
	/** OpenChamber's settings file (tests point this elsewhere). */
	settingsPath?: string;
};

function text(t: string) {
	return { output: [{ type: "text" as const, text: t }] };
}

const SESSION_ID = /^ses_[A-Za-z0-9]+$/;
export function sessionId(v: string): string {
	if (!SESSION_ID.test(v)) throw new OpenChamberError(`"${v}" is not a session id (they look like ses_…; oc_sessions lists them)`);
	return v;
}

type Permission = { id: string; sessionID: string; action: string; resources: string[]; message?: string };
type Form = { id: string; sessionID: string; title: string; fields: { key: string; title?: string; type: string; required?: boolean; options?: { value: string; label: string }[] }[] };

/** Runs `fn` over `items` concurrently; failures drop out (a session that vanished must not hide the rest). */
async function settled<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
	const out = await Promise.allSettled(items.map(fn));
	return out.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
}

export function describePermission(p: Permission): string {
	return `${p.action}${p.resources.length ? ` on ${clip(p.resources.join(", "), 300)}` : ""}${p.message ? ` — ${clip(p.message, 300)}` : ""}`;
}

export function describeForm(f: Form): string {
	const fields = f.fields.map((x) => {
		const opts = x.options?.length ? ` options: ${x.options.map((o) => `${o.value}${o.label !== o.value ? ` (${o.label})` : ""}`).join(" | ")}` : "";
		return `    - ${x.key}${x.title ? ` "${x.title}"` : ""} [${x.type}${x.required ? ", required" : ""}]${opts}`;
	});
	return `${f.title}\n${fields.join("\n")}`;
}

export function openchamberFeature(late: LateServices, options: OpenChamberToolOptions = {}): Feature {
	const client = (conversationId: unknown) => {
		const bot = late.sessions().botOf(conversationId as number);
		return new OpenChamber({ config: bot?.config.openchamber, settingsPath: options.settingsPath });
	};

	const sessions = defineTool({
		name: "oc_sessions",
		description:
			"List the user's recent OpenChamber threads (newest first): title, session id, folder, whether it is running, last update, model and agent. " +
			"Delegated sub-threads are left out unless include_children is true.",
		parameters: Type.Object({
			directory: Type.Optional(Type.String({ description: "Only threads in this absolute folder" })),
			limit: Type.Optional(Type.Number({ description: "Default 15, at most 50" })),
			include_children: Type.Optional(Type.Boolean()),
		}),
		replay: "safe",
		execute: async (args, api, ctx) => {
			const oc = client(api.conversationId);
			const limit = Math.min(Math.max(Math.floor(args.limit ?? 15), 1), 50);
			const [list, active] = await Promise.all([
				oc.get<Page<SessionInfo>>("/api/session", { limit: String(limit), order: "desc", directory: args.directory, parentID: args.include_children ? undefined : "null" }, ctx.abortSignal),
				oc.get<{ data: Record<string, unknown> }>("/api/session/active", undefined, ctx.abortSignal),
			]);
			if (list.data.length === 0) return text("No threads.");
			return text(
				list.data
					.map((s) => `${s.id} "${s.title ?? ""}" ${s.location?.directory ?? "?"} ${active.data[s.id] ? "RUNNING" : "idle"} updated ${when(s.time?.updated)} ${s.model ? `${s.model.providerID}/${s.model.id}` : "?"}${s.agent ? ` agent=${s.agent}` : ""}${s.parentID ? ` (sub-thread of ${s.parentID})` : ""}`)
					.join("\n"),
			);
		},
	});

	const read = defineTool({
		name: "oc_read",
		description: "Read the last turns of an OpenChamber thread, condensed: what the user asked, what the agent said, and one line per tool call. Reasoning is left out.",
		parameters: Type.Object({
			session: Type.String({ description: "Session id (ses_…)" }),
			turns: Type.Optional(Type.Number({ description: "How many user turns back to read. Default 3, at most 20" })),
		}),
		replay: "safe",
		execute: async (args, api, ctx) => {
			const oc = client(api.conversationId);
			const id = sessionId(args.session);
			const turns = Math.min(Math.max(Math.floor(args.turns ?? 3), 1), 20);
			const info = await oc.get<{ data: SessionInfo }>(`/api/session/${id}`, undefined, ctx.abortSignal);
			// Newest first; the cursor from one page continues to the next (it carries the order itself).
			const collected: Message[] = [];
			let users = 0;
			let cursor: string | undefined;
			let more = false;
			for (let page = 0; page < 10; page++) {
				const r = await oc.get<Page<Message>>(`/api/session/${id}/message`, cursor ? { cursor, limit: "40" } : { order: "desc", limit: "40" }, ctx.abortSignal);
				for (const m of r.data) {
					collected.push(m);
					if (m.type === "user") users++;
				}
				cursor = r.cursor?.next;
				more = Boolean(cursor) && r.data.length > 0;
				if (users >= turns || !more) break;
			}
			// Keep from the Nth-last user message on.
			let seen = 0;
			let start = collected.length;
			for (let i = 0; i < collected.length; i++) {
				if (collected[i]!.type === "user" && ++seen === turns) {
					start = i + 1;
					break;
				}
			}
			const keep = seen >= turns ? start : collected.length;
			const wanted = collected.slice(0, keep).reverse();
			const older = more || keep < collected.length;
			const head = `Thread "${info.data.title ?? ""}" (${id}) in ${info.data.location?.directory ?? "?"}`;
			const body = condenseMessages(wanted);
			return text(`${head}\n${older ? "[earlier turns not shown]\n" : ""}${body || "(no messages)"}`);
		},
	});

	const waiting = defineTool({
		name: "oc_waiting",
		description:
			"Everything in OpenChamber that is waiting on the user right now: permission requests (an agent wants to run something) and open forms (an agent asked a question). " +
			"Each entry has the thread title and id and the request or form id to answer with oc_approve or oc_answer.",
		parameters: Type.Object({}),
		replay: "safe",
		execute: async (_args, api, ctx) => {
			const oc = client(api.conversationId);
			const [recent, active] = await Promise.all([
				oc.get<Page<SessionInfo>>("/api/session", { limit: "30", order: "desc" }, ctx.abortSignal),
				oc.get<{ data: Record<string, unknown> }>("/api/session/active", undefined, ctx.abortSignal),
			]);
			const titles = new Map(recent.data.map((s) => [s.id, s]));
			const ids = [...new Set([...Object.keys(active.data), ...recent.data.map((s) => s.id)])];
			// The server-wide list is scoped to a folder, so ask once per folder that has a thread, and each thread too.
			const dirs = [...new Set(recent.data.map((s) => s.location?.directory).filter((d): d is string => Boolean(d)))];
			const perms = new Map<string, Permission>();
			for (const list of await Promise.all([
				...dirs.map((d) => settled([d], (dir) => oc.get<{ data: Permission[] }>("/api/permission/request", { "location[directory]": dir }, ctx.abortSignal)).then((r) => r.flatMap((x) => x.data))),
				settled(ids, (id) => oc.get<{ data: Permission[] }>(`/api/session/${id}/permission`, undefined, ctx.abortSignal)).then((r) => r.flatMap((x) => x.data)),
			])) {
				for (const p of list) perms.set(p.id, p);
			}
			const forms = (await settled(ids, (id) => oc.get<{ data: Form[] }>(`/api/session/${id}/form`, undefined, ctx.abortSignal))).flatMap((x) => x.data);
			if (perms.size === 0 && forms.length === 0) return text("Nothing is waiting on the user.");
			const titleOf = async (id: string) => {
				const known = titles.get(id);
				if (known) return known.title ?? "";
				try {
					const s = await oc.get<{ data: SessionInfo }>(`/api/session/${id}`, undefined, ctx.abortSignal);
					titles.set(id, s.data);
					return s.data.title ?? "";
				} catch {
					return "?";
				}
			};
			const lines: string[] = [];
			for (const p of perms.values()) lines.push(`PERMISSION request=${p.id} session=${p.sessionID} thread="${await titleOf(p.sessionID)}": wants to ${describePermission(p)}`);
			for (const f of forms) lines.push(`QUESTION form=${f.id} session=${f.sessionID} thread="${await titleOf(f.sessionID)}": ${describeForm(f)}`);
			return text(lines.join("\n"));
		},
	});

	const diff = defineTool({
		name: "oc_diff",
		description:
			"Files an OpenChamber thread has changed over the whole thread (or only its latest turn with last_turn): status and added/removed line counts per file. " +
			"Pass file to get that file's patch (capped).",
		parameters: Type.Object({
			session: Type.String({ description: "Session id (ses_…)" }),
			file: Type.Optional(Type.String({ description: "A path from the summary, to see its patch" })),
			last_turn: Type.Optional(Type.Boolean({ description: "Only what the latest turn changed" })),
		}),
		replay: "safe",
		execute: async (args, api, ctx) => {
			const oc = client(api.conversationId);
			const id = sessionId(args.session);
			// The diff spans turns named by their user messages, from and to inclusive; without them it is the first turn only.
			const userIds = async (order: "asc" | "desc"): Promise<string | undefined> => {
				let cursor: string | undefined;
				for (let i = 0; i < 10; i++) {
					const page = await oc.get<Page<Message>>(`/api/session/${id}/message`, cursor ? { cursor, limit: "50" } : { order, limit: "50" }, ctx.abortSignal);
					const user = page.data.find((m) => m.type === "user");
					if (user) return user.id;
					cursor = page.cursor?.next;
					if (!cursor) return undefined;
				}
				return undefined;
			};
			const last = await userIds("desc");
			if (!last) return text("No file changes.");
			const from = args.last_turn ? last : await userIds("asc");
			const r = await oc.get<{ data: { file: string; patch: string; additions: number; deletions: number; status: string }[] }>(`/api/session/${id}/diff`, { from, to: last }, ctx.abortSignal);
			if (args.file) {
				const f = r.data.find((d) => d.file === args.file);
				if (!f) throw new OpenChamberError(`${args.file} is not among the changed files`);
				return text(`${f.status} ${f.file} +${f.additions} −${f.deletions}\n${clip(f.patch, 8000)}`);
			}
			if (r.data.length === 0) return text("No file changes.");
			return text(r.data.map((d) => `${d.status} ${d.file} +${d.additions} −${d.deletions}`).join("\n"));
		},
	});

	const titleOf = async (oc: OpenChamber, id: string, signal?: AbortSignal): Promise<string> => {
		try {
			return (await oc.get<{ data: SessionInfo }>(`/api/session/${id}`, undefined, signal)).data.title ?? "";
		} catch {
			return "?";
		}
	};
	const ASK = " The user approves each call: say which thread (by its title) and exactly what will happen.";

	const approve = defineTool({
		name: "oc_approve",
		description:
			"Answer a permission request in an OpenChamber thread: allow it this once, or reject it (optionally with a reason the agent sees). There is no \"always\". " +
			"Find request ids with oc_waiting." + ASK,
		parameters: Type.Object({
			session: Type.String({ description: "Session id (ses_…)" }),
			request: Type.String({ description: "Permission request id (per_…)" }),
			decision: Type.Union([Type.Literal("once"), Type.Literal("reject")]),
			reason: Type.Optional(Type.String({ description: "Why, when rejecting; the agent sees it" })),
		}),
		execute: async (args, api, ctx) => {
			const oc = client(api.conversationId);
			const id = sessionId(args.session);
			if (!/^per_[A-Za-z0-9]+$/.test(args.request)) throw new OpenChamberError(`"${args.request}" is not a permission request id (they look like per_…)`);
			// Only a request that is really waiting in this thread.
			const pending = await oc.get<{ data: Permission[] }>(`/api/session/${id}/permission`, undefined, ctx.abortSignal);
			const p = pending.data.find((x) => x.id === args.request);
			if (!p) throw new OpenChamberError(`session ${id} has no waiting permission request ${args.request} (oc_waiting lists them)`);
			await oc.post(`/api/session/${id}/permission/${args.request}/reply`, { decision: args.decision, ...(args.reason ? { message: args.reason } : {}) }, ctx.abortSignal);
			return text(`${args.decision === "once" ? "Allowed once" : "Rejected"}: ${describePermission(p)} in "${await titleOf(oc, id, ctx.abortSignal)}".`);
		},
	});

	const answer = defineTool({
		name: "oc_answer",
		description:
			"Answer a question (form) an OpenChamber agent asked. answers maps each field key to its value: a string, number, boolean, or a list of strings for a multiselect. " +
			"Find form ids and their fields with oc_waiting." + ASK,
		parameters: Type.Object({
			session: Type.String({ description: "Session id (ses_…)" }),
			form: Type.String({ description: "Form id (frm_…)" }),
			answers: Type.Record(Type.String(), Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Array(Type.String())])),
		}),
		execute: async (args, api, ctx) => {
			const oc = client(api.conversationId);
			const id = sessionId(args.session);
			if (!/^frm_[A-Za-z0-9]+$/.test(args.form)) throw new OpenChamberError(`"${args.form}" is not a form id (they look like frm_…)`);
			const open = await oc.get<{ data: Form[] }>(`/api/session/${id}/form`, undefined, ctx.abortSignal);
			const f = open.data.find((x) => x.id === args.form);
			if (!f) throw new OpenChamberError(`session ${id} has no open form ${args.form} (oc_waiting lists them)`);
			await oc.post(`/api/session/${id}/form/${args.form}/reply`, { answer: args.answers }, ctx.abortSignal);
			return text(`Answered "${f.title}" in "${await titleOf(oc, id, ctx.abortSignal)}": ${clip(JSON.stringify(args.answers), 300)}`);
		},
	});

	const stop = defineTool({
		name: "oc_stop",
		description: "Interrupt a running OpenChamber thread (stop what its agent is doing now)." + ASK,
		parameters: Type.Object({ session: Type.String({ description: "Session id (ses_…)" }) }),
		execute: async (args, api, ctx) => {
			const oc = client(api.conversationId);
			const id = sessionId(args.session);
			const r = await oc.post<{ interrupted?: boolean }>(`/api/session/${id}/interrupt`, undefined, ctx.abortSignal);
			return text(r?.interrupted ? `Interrupted "${await titleOf(oc, id, ctx.abortSignal)}".` : `"${await titleOf(oc, id, ctx.abortSignal)}" was not running; nothing to interrupt.`);
		},
	});

	const prompt = defineTool({
		name: "oc_prompt",
		description: "Send a message to an existing OpenChamber thread, as if the user typed it. If the agent is busy it is delivered per OpenChamber's rules." + ASK,
		parameters: Type.Object({ session: Type.String({ description: "Session id (ses_…)" }), text: Type.String() }),
		execute: async (args, api, ctx) => {
			const oc = client(api.conversationId);
			const id = sessionId(args.session);
			await oc.post(`/api/session/${id}/prompt`, { text: args.text }, ctx.abortSignal);
			return text(`Sent to "${await titleOf(oc, id, ctx.abortSignal)}": ${clip(args.text, 200)}`);
		},
	});

	const start = defineTool({
		name: "oc_start",
		description:
			"Start a new OpenChamber thread in a folder and give it a first prompt. Leave model, variant and agent out unless the user asks for them: " +
			"they default to this bot's openchamber settings, then to the defaults the user picked in OpenChamber." +
			" The user approves each call: say the thread title, the folder, and what the prompt asks for.",
		parameters: Type.Object({
			directory: Type.String({ description: "Absolute path of an existing folder" }),
			title: Type.String(),
			prompt: Type.String(),
			model: Type.Optional(Type.String({ description: "provider/model" })),
			variant: Type.Optional(Type.String({ description: "Thinking level / model variant, e.g. low, medium, high" })),
			agent: Type.Optional(Type.String()),
		}),
		execute: async (args, api, ctx) => {
			const bot = late.sessions().botOf(api.conversationId as number);
			const cfg = bot?.config.openchamber;
			const oc = client(api.conversationId);
			if (!isAbsolute(args.directory) || !statSync(args.directory, { throwIfNoEntry: false })?.isDirectory()) throw new OpenChamberError(`${args.directory} is not an existing absolute folder`);
			// Read at each start, so a default changed in OpenChamber applies to the next thread.
			const picked = oc.defaults();
			const model = args.model ?? cfg?.model ?? picked.model;
			if (!model) throw new OpenChamberError("no model: pass model (provider/model); neither this bot's openchamber.model nor OpenChamber's default model is set");
			// OpenChamber's default variant belongs to its default model; another model keeps its own default.
			const variant = args.variant ?? cfg?.variant ?? (model === picked.model ? picked.variant : undefined);
			const agent = args.agent ?? cfg?.agent ?? picked.agent ?? null;
			const created = await oc.post<{ data: SessionInfo }>("/api/session", { title: args.title, location: { directory: args.directory }, model: modelRef(model, variant), agent }, ctx.abortSignal);
			await oc.post(`/api/session/${created.data.id}/prompt`, { text: args.prompt }, ctx.abortSignal);
			return text(`Started "${args.title}" (${created.data.id}) in ${args.directory} with ${model}${variant ? ` (${variant})` : ""}${agent ? `, agent ${agent}` : ""}.`);
		},
	});

	return {
		groups: new Map([
			["openchamber", [sessions, read, waiting, diff, approve, answer, stop, prompt, start] as ToolRegistration[]],
			// No tools: a bot with this group has the gateway watch OpenChamber and notify the owner
			// (src/openchamber/watcher.ts). A group, so Vory's Tools page and the panel can switch it.
			["openchamber_alerts", []],
		]),
	};
}
