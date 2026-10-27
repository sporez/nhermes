// The `spaces` tool group: open, list and close the bot's disposable desktops (src/spaces/), run a command in
// one, copy a file between one and the bot's own machine, and offer the owner a live view of one (a `space` card;
// the link is made when the owner opens it, src/spaces/viewer.ts). The group also holds the desktop tools, which take
// a `space` argument (src/tools/desktop.ts), so a bot with only this group can drive its spaces and never the
// host's own desktop. Every call that uses a space goes through `Spaces.use`, which keeps the space from being
// deleted as idle while the call runs. Spaces belong to one bot; a missing or foreign id is a plain error.
import { posix } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolExecutionApi, type ToolRegistration } from "@earendil-works/pi-durable";
import type { Feature, LateServices } from "../app.ts";
import { type SpaceCard, SPACE_VIEW_TOOL } from "../core/cards.ts";
import { redactJson } from "../core/turns.ts";

/** The largest file space_copy moves. */
export const COPY_MAX_BYTES = 100 * 1024 * 1024;
const OUTPUT_KEEP = 20_000;
const DEFAULT_TIMEOUT_S = 120;
const MAX_TIMEOUT_S = 600;

type Output = { output: { type: "text"; text: string }[]; isError?: boolean };
const text = (t: string, isError = false): Output => ({ output: [{ type: "text", text: t }], ...(isError ? { isError } : {}) });

export function spacesFeature(late: LateServices, desktop: ToolRegistration[]): Feature {
	const botOf = (api: ToolExecutionApi) => {
		const bot = late.sessions().botOf(api.conversationId as number);
		if (!bot) throw new Error("this conversation has no bot");
		return bot;
	};

	const open = defineTool({
		name: "space_open",
		description:
			"Open a new disposable desktop (a space) and return its id. It takes several seconds. Use it with the desktop_* tools by giving space: \"<id>\", run commands in it with space_shell, move files with space_copy. " +
			"Nothing in it is kept. Close it with space_close as soon as you are done; an unused space is deleted after a while. Take a screenshot in it and show the owner the picture with show, " +
			"or let them watch it live with space_view.",
		parameters: Type.Object({}),
		execute: async (_a, api) => {
			const { id } = await late.spaces().open(botOf(api).name);
			const idle = late.config.spaces.idleMinutes;
			return text(`Opened space ${id}. Use desktop_* tools with space: "${id}", run commands with space_shell, and close it with space_close when you are done. Its desktop is display :1 (user cua, home /home/cua). It is deleted after ${idle} minutes unused.`);
		},
	});

	const list = defineTool({
		name: "space_list",
		description: "List your open spaces with how long each has been open and unused.",
		parameters: Type.Object({}),
		replay: "safe",
		execute: async (_a, api) => {
			const mine = late.spaces().list(botOf(api).name);
			if (mine.length === 0) return text("You have no open spaces.");
			const now = Date.now();
			const mins = (ms: number) => `${Math.max(0, Math.round(ms / 60_000))} min`;
			return text(mine.map((s) => `${s.id}: open ${mins(now - s.createdAt)}, unused ${mins(now - s.lastUsed)}`).join("\n"));
		},
	});

	const close = defineTool({
		name: "space_close",
		description: "Delete a space and everything in it. Copy out what you need first.",
		parameters: Type.Object({ space: Type.String({ description: "The space id from space_open" }) }),
		execute: async (a, api) => {
			await late.spaces().close(botOf(api).name, a.space);
			return text(`Closed space ${a.space}.`);
		},
	});

	const shell = defineTool({
		name: "space_shell",
		description:
			"Run a shell command in a space (as the user cua, in its home folder). The space is a separate machine from yours with no access to your files or network; it can reach the internet. " +
			`timeout is in seconds (default ${DEFAULT_TIMEOUT_S}, at most ${MAX_TIMEOUT_S}). The exit code is shown. For GUI programs use the desktop_* tools.`,
		parameters: Type.Object({
			space: Type.String({ description: "The space id from space_open" }),
			command: Type.String(),
			timeout: Type.Optional(Type.Number({ description: "Seconds" })),
		}),
		execute: async (a, api, ctx) => {
			const timeout = Math.min(Math.max(a.timeout ?? DEFAULT_TIMEOUT_S, 1), MAX_TIMEOUT_S);
			let out = "";
			let dropped = 0;
			const r = await late.spaces().use(botOf(api).name, a.space, (env) =>
				env.exec(
					a.command,
					{
						timeout,
						onOutput: (t: string) => {
							out += t;
							if (out.length > OUTPUT_KEEP * 2) {
								dropped += out.length - OUTPUT_KEEP;
								out = out.slice(-OUTPUT_KEEP);
							}
						},
					},
					ctx,
				),
			);
			if (dropped || out.length > OUTPUT_KEEP) {
				dropped += Math.max(0, out.length - OUTPUT_KEEP);
				out = out.slice(-OUTPUT_KEEP);
			}
			const shown = `${dropped ? `[earlier output cut: ${dropped} characters]\n` : ""}${out.trimEnd()}`;
			if (!r.ok) return text(`${shown}\n\nThe command did not finish: ${r.error.code === "timeout" ? `it ran longer than ${timeout} seconds` : r.error.message}`.trim(), true);
			const code = r.value.exitCode ?? 0;
			return text(`${shown}${shown ? "\n\n" : ""}Exit code ${code}.`, code !== 0);
		},
	});

	const copy = defineTool({
		name: "space_copy",
		description:
			`Copy one file between a space and your own machine (up to ${COPY_MAX_BYTES / 1024 / 1024} MB). direction "to_space": from is a path on your machine, to a path in the space. ` +
			'"from_space": from is a path in the space, to a path on your machine. Relative paths start in your working folder, or the space\'s home folder. An existing file is overwritten.',
		parameters: Type.Object({
			space: Type.String({ description: "The space id from space_open" }),
			from: Type.String(),
			to: Type.String(),
			direction: Type.Union([Type.Literal("to_space"), Type.Literal("from_space")]),
		}),
		execute: async (a, api, ctx) => {
			const own = api.env;
			if (!own) throw new Error("this bot has no execution environment for copying files");
			return late.spaces().use(botOf(api).name, a.space, async (theirs) => {
				const [src, dst] = a.direction === "to_space" ? [own, theirs] : [theirs, own];
				const abs = (env: typeof own, p: string) => posix.resolve(env.cwd, p);
				const from = abs(src, a.from);
				const to = abs(dst, a.to);
				const info = await src.fileInfo(from, ctx);
				if (!info.ok) return text(`Could not read ${a.from}: ${info.error.message}`, true);
				if (info.value.kind !== "file") return text(`${a.from} is not a file; copy files one at a time.`, true);
				if (info.value.size > COPY_MAX_BYTES) return text(`${a.from} is ${Math.ceil(info.value.size / 1024 / 1024)} MB; the limit is ${COPY_MAX_BYTES / 1024 / 1024} MB.`, true);
				const data = await src.readBinaryFile(from, ctx);
				if (!data.ok) return text(`Could not read ${a.from}: ${data.error.message}`, true);
				const dir = await dst.createDir(posix.dirname(to), { recursive: true }, ctx);
				if (!dir.ok) return text(`Could not create the folder for ${a.to}: ${dir.error.message}`, true);
				const written = await dst.writeFile(to, data.value, ctx);
				if (!written.ok) return text(`Could not write ${a.to}: ${written.error.message}`, true);
				return text(`Copied ${a.direction === "to_space" ? "to" : "from"} space ${a.space}: ${data.value.length} bytes to ${to}.`);
			});
		},
	});

	const view = defineTool({
		name: SPACE_VIEW_TOOL,
		description:
			"Give the owner a card that opens a live view of one of your spaces, so they can watch what you do there and take control of it when they choose (for a sign-in, a captcha, or to help). " +
			"Use it when the owner asks to watch, or before something they may want to see or do themselves. You can keep working after it. A space being watched is not deleted as unused.",
		parameters: Type.Object({
			space: Type.String({ description: "The space id from space_open" }),
			caption: Type.Optional(Type.String({ description: "One short line saying what is happening in it" })),
		}),
		replay: "safe",
		execute: async (a, api) => {
			const bot = botOf(api).name;
			if (!late.spaces().list(bot).some((s) => s.id === a.space)) throw new Error(`You have no open space ${a.space}. Open one with space_open first.`);
			const caption = (a.caption ?? "").replace(/\s+/g, " ").trim().slice(0, 120) || `Space ${a.space}`;
			const card = redactJson<SpaceCard>({ kind: "space", caption, data: { space: a.space } });
			return { output: [{ type: "text" as const, text: `The owner has a card to watch space ${a.space} live and can take control of it. Carry on; don't describe the screen to them.` }], details: { card } as never };
		},
	});

	const tools = [open, list, close, shell, copy, view] as ToolRegistration[];
	return { groups: new Map([["spaces", [...tools, ...desktop]]]) };
}
