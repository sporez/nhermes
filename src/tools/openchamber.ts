// Tools for the user's OpenChamber threads (a desktop UI over OpenCode): look at what each thread is doing
// and what is waiting on the user. Talks to OpenChamber's local server through src/openchamber/client.ts;
// the token never passes through the model.
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import type { Feature, LateServices } from "../app.ts";
import { clip, condenseMessages, type Message, OpenChamber, OpenChamberError, type Page, type SessionInfo, when } from "../openchamber/client.ts";

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
		description: "Files an OpenChamber thread has changed: status and added/removed line counts per file. Pass file to get that file's patch (capped).",
		parameters: Type.Object({
			session: Type.String({ description: "Session id (ses_…)" }),
			file: Type.Optional(Type.String({ description: "A path from the summary, to see its patch" })),
		}),
		replay: "safe",
		execute: async (args, api, ctx) => {
			const oc = client(api.conversationId);
			const id = sessionId(args.session);
			const r = await oc.get<{ data: { file: string; patch: string; additions: number; deletions: number; status: string }[] }>(`/api/session/${id}/diff`, undefined, ctx.abortSignal);
			if (args.file) {
				const f = r.data.find((d) => d.file === args.file);
				if (!f) throw new OpenChamberError(`${args.file} is not among the changed files`);
				return text(`${f.status} ${f.file} +${f.additions} −${f.deletions}\n${clip(f.patch, 8000)}`);
			}
			if (r.data.length === 0) return text("No file changes.");
			return text(r.data.map((d) => `${d.status} ${d.file} +${d.additions} −${d.deletions}`).join("\n"));
		},
	});

	return { groups: new Map([["openchamber", [sessions, read, waiting, diff] as ToolRegistration[]]]) };
}
