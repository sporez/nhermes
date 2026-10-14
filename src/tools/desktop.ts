// Desktop automation on an X11 desktop, through the bot's execution environment (the gateway host or
// an SSH host). Established tools only: ImageMagick `import` for screenshots, `xdotool` for mouse and
// keyboard, `wmctrl` for windows, AT-SPI (python3-pyatspi) for the accessibility tree. Prerequisites
// and limits: docs/COMPUTER_USE.md.
import type { Context } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolExecutionApi, type ToolRegistration } from "@earendil-works/pi-durable";
import type { Feature, LateServices } from "../app.ts";

type Output = { output: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[]; isError?: boolean };

/** Single-quotes a string for POSIX sh. */
export function sq(s: string): string {
	return `'${s.replace(/'/g, `'"'"'`)}'`;
}

const ACCESSIBILITY_PY = String.raw`
import sys, pyatspi
limit = int(sys.argv[1]); want = sys.argv[2].lower() if len(sys.argv) > 2 else ""
out = []
def walk(node, depth):
    if len(out) >= limit or depth > 25: return
    try:
        role = node.getRoleName(); name = node.name or ""
        states = node.getState()
        if not states.contains(pyatspi.STATE_SHOWING) and depth > 1: return
        try:
            ext = node.queryComponent().getExtents(pyatspi.DESKTOP_COORDS); box = f" @{ext.x},{ext.y} {ext.width}x{ext.height}"
        except Exception: box = ""
        text = ""
        if role in ("text", "entry", "password text", "paragraph", "terminal", "document text", "label") and role != "password text":
            try:
                t = node.queryText(); text = t.getText(0, min(t.characterCount, 400)).replace("\n", "\\n")
            except Exception: text = ""
        if name or text or role not in ("filler", "panel", "unknown"):
            out.append("  " * min(depth, 12) + f"- {role} {name!r}{box}" + (f" text={text!r}" if text else ""))
        for i in range(node.childCount): walk(node.getChildAtIndex(i), depth + 1)
    except Exception: pass
desk = pyatspi.Registry.getDesktop(0)
for i in range(desk.childCount):
    app = desk.getChildAtIndex(i)
    if app is None or (want and want not in (app.name or "").lower()): continue
    walk(app, 0)
print("\n".join(out) if out else "(no accessible applications found; is the app running with accessibility enabled?)")
`;

export function desktopFeature(late: LateServices): Feature {
	const display = (conversationId: number) => late.sessions().botOf(conversationId)?.config.desktop?.display ?? ":0";

	const sh = async (api: ToolExecutionApi, ctx: Context, script: string, timeoutMs = 20_000): Promise<{ code: number; out: string }> => {
		const env = api.env;
		if (!env) throw new Error("this bot has no execution environment for desktop control");
		const prefix = `export DISPLAY=${sq(display(api.conversationId as number))}; export XAUTHORITY="\${XAUTHORITY:-$HOME/.Xauthority}"; `;
		let out = "";
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		ctx.abortSignal?.addEventListener("abort", () => controller.abort(), { once: true });
		const { withAbortSignal } = await import("@earendil-works/chord/context");
		try {
			const r = await env.exec(prefix + script, { onOutput: (t: string) => void (out += t) }, withAbortSignal(controller.signal, ctx));
			if (!r.ok) throw new Error(`desktop command failed: ${JSON.stringify(r.error).slice(0, 300)}`);
			return { code: r.value.exitCode ?? 0, out };
		} finally {
			clearTimeout(timer);
		}
	};
	const run = async (api: ToolExecutionApi, ctx: Context, script: string, done: string): Promise<Output> => {
		const r = await sh(api, ctx, script);
		if (r.code !== 0) return { output: [{ type: "text", text: `Failed (exit ${r.code}): ${r.out.trim().slice(0, 2000)}` }], isError: true };
		return { output: [{ type: "text", text: r.out.trim() ? `${done}\n${r.out.trim().slice(0, 4000)}` : done }] };
	};
	const id = (api: ToolExecutionApi) => api;

	const tools = [
		defineTool({
			name: "desktop_screenshot",
			description: "Take a screenshot of the whole desktop. Coordinates in the image are the screen's own pixels (use them for desktop_click).",
			parameters: Type.Object({}),
			replay: "safe",
			execute: async (_a, api, ctx) => {
				const r = await sh(id(api), ctx, `xdotool getdisplaygeometry; import -window root png:- | base64 -w0`, 30_000);
				if (r.code !== 0) return { output: [{ type: "text", text: `Screenshot failed (exit ${r.code}): ${r.out.slice(0, 1000)}` }], isError: true };
				const [geometry = "", ...rest] = r.out.split("\n");
				const data = rest.join("").trim();
				return {
					output: [
						{ type: "text", text: `Desktop ${geometry.trim().replace(" ", "x")} on display ${display(api.conversationId as number)}.` },
						{ type: "image", data, mimeType: "image/png" },
					],
				};
			},
		}),
		defineTool({
			name: "desktop_click",
			description: "Move the mouse to x,y (screen pixels) and click. button: left (default), middle, right; double for a double-click.",
			parameters: Type.Object({ x: Type.Number(), y: Type.Number(), button: Type.Optional(Type.Union([Type.Literal("left"), Type.Literal("middle"), Type.Literal("right")])), double: Type.Optional(Type.Boolean()) }),
			execute: async (a, api, ctx) => {
				const b = a.button === "right" ? 3 : a.button === "middle" ? 2 : 1;
				return run(api, ctx, `xdotool mousemove --sync ${Math.round(a.x)} ${Math.round(a.y)} click ${a.double ? "--repeat 2 " : ""}${b}`, `Clicked ${a.button ?? "left"} at ${Math.round(a.x)},${Math.round(a.y)}.`);
			},
		}),
		defineTool({
			name: "desktop_type",
			description: "Type text into the focused window as keystrokes.",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (a, api, ctx) =>
				run(api, ctx, `printf %s ${sq(Buffer.from(a.text).toString("base64"))} | base64 -d | xdotool type --delay 15 --file -`, `Typed ${a.text.length} characters.`),
		}),
		defineTool({
			name: "desktop_key",
			description: "Press a key or chord in the focused window, xdotool names: Return, Escape, Tab, ctrl+l, alt+F4, super, ctrl+shift+t, …",
			parameters: Type.Object({ keys: Type.String() }),
			execute: async (a, api, ctx) => run(api, ctx, `xdotool key --clearmodifiers -- ${a.keys.split(/\s+/).map(sq).join(" ")}`, `Pressed ${a.keys}.`),
		}),
		defineTool({
			name: "desktop_scroll",
			description: "Scroll at the mouse position (optionally move to x,y first).",
			parameters: Type.Object({ direction: Type.Union([Type.Literal("up"), Type.Literal("down")]), clicks: Type.Optional(Type.Number()), x: Type.Optional(Type.Number()), y: Type.Optional(Type.Number()) }),
			execute: async (a, api, ctx) => {
				const move = a.x !== undefined && a.y !== undefined ? `xdotool mousemove --sync ${Math.round(a.x)} ${Math.round(a.y)}; ` : "";
				return run(api, ctx, `${move}xdotool click --repeat ${Math.min(Math.max(a.clicks ?? 5, 1), 50)} ${a.direction === "up" ? 4 : 5}`, `Scrolled ${a.direction}.`);
			},
		}),
		defineTool({
			name: "desktop_windows",
			description: "List open windows: id, desktop, pid, title, and the focused one.",
			parameters: Type.Object({}),
			replay: "safe",
			execute: async (_a, api, ctx) => run(api, ctx, `wmctrl -lpG; printf 'focused: '; xdotool getactivewindow getwindowname`, "Windows (id desktop pid x y w h host title):"),
		}),
		defineTool({
			name: "desktop_focus",
			description: "Bring a window to the front by id (from desktop_windows) or by part of its title.",
			parameters: Type.Object({ id: Type.Optional(Type.String()), title: Type.Optional(Type.String()) }),
			execute: async (a, api, ctx) => {
				if (a.id) return run(api, ctx, `wmctrl -ia ${sq(a.id)}`, `Focused window ${a.id}.`);
				if (a.title) return run(api, ctx, `wmctrl -a ${sq(a.title)}`, `Focused the window titled like "${a.title}".`);
				throw new Error("give id or title");
			},
		}),
		defineTool({
			name: "desktop_launch",
			description: "Start a desktop application (e.g. 'mousepad', 'xfce4-terminal', 'google-chrome https://…'). Returns at once.",
			parameters: Type.Object({ command: Type.String() }),
			execute: async (a, api, ctx) => {
				const program = a.command.trim().split(/\s+/)[0] ?? "";
				return run(api, ctx, `command -v ${sq(program)} >/dev/null || { echo "${program.replace(/"/g, "")}: not installed"; exit 127; }; setsid -f sh -c ${sq(`${a.command} >/dev/null 2>&1`)}; sleep 2; wmctrl -l | tail -5`, `Started: ${a.command}. Newest windows:`);
			},
		}),
		defineTool({
			name: "desktop_accessibility",
			description: "Read the accessibility tree (roles, names, positions) of running apps, or one app by name. Positions are screen pixels.",
			parameters: Type.Object({ app: Type.Optional(Type.String()), limit: Type.Optional(Type.Number()) }),
			replay: "safe",
			execute: async (a, api, ctx) =>
				run(
					api,
					ctx,
					`export NO_AT_BRIDGE=0; printf %s ${sq(Buffer.from(ACCESSIBILITY_PY).toString("base64"))} | base64 -d > /tmp/nh-a11y.py; python3 /tmp/nh-a11y.py ${Math.min(a.limit ?? 300, 2000)} ${a.app ? sq(a.app) : ""}`,
					"Accessibility tree:",
				),
		}),
	];
	return { groups: new Map([["desktop", tools as ToolRegistration[]]]) };
}
