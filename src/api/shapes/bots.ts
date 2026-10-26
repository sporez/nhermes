// Wire shapes of the bot settings resources (docs/API.md "Bot settings"): a bot's editor data, tool groups and
// MCP servers, from this gateway or from a member's /federation/manage answers (the same data, in the same
// shape). Times leave as Unix milliseconds. No key value is in any of them: MCP headers show their
// `{{secret:NAME}}` references, never the keys.
import type { Core } from "../../app.ts";
import { GROUP_LABELS } from "../../tools/index.ts";
import type { mcpDetail, mcpServerView } from "../../mcp/manage.ts";
import type { editorView } from "../../panel/views.ts";

type Editor = Awaited<ReturnType<typeof editorView>>;
export type EditorEntry = Editor["bots"][number];

const ms = (seconds: number | null | undefined): number | null => (seconds ? Math.round(seconds * 1000) : null);

/** What an editor needs for one bot: its settings, what they come to, and the choices it picks from. */
export function settingsJson(botId: string, entry: EditorEntry, choices: Pick<Editor, "models" | "toolGroups" | "spaces">, editableKeys: string[]) {
	const { instructionsFrom, ...effective } = entry.effective;
	const { peer: _peer, ...rest } = effective;
	return {
		botId,
		config: entry.config,
		effective: { ...rest, instructionsFrom },
		editableKeys,
		choices: { models: choices.models, toolGroups: choices.toolGroups, spaces: choices.spaces },
	};
}

/** What a new bot's editor picks from on one machine, and what the bot gets for what it leaves out. */
export function choicesJson(node: string, machines: { name: string; self: boolean; online: boolean }[], view: Pick<Editor, "models" | "toolGroups" | "spaces" | "defaults">, editableKeys: string[]) {
	return { node, machines, models: view.models, toolGroups: view.toolGroups, spaces: view.spaces, defaults: view.defaults, editableKeys };
}

export function toolGroupsJson(core: Core) {
	return [...core.toolGroups.entries()].map(([name, tools]) => ({
		name,
		label: GROUP_LABELS[name]?.label ?? (name.startsWith("mcp:") ? `MCP: ${name.slice(4)}` : name),
		description: GROUP_LABELS[name]?.description ?? (name.startsWith("mcp:") ? (core.config.mcp.servers.find((s) => `mcp:${s.name}` === name)?.description ?? "Tools of an MCP server") : ""),
		tools: tools.map((t) => t.name),
	}));
}

type ServerView = ReturnType<typeof mcpServerView>;
type ServerDetail = ReturnType<typeof mcpDetail>;

/** An MCP server as the client API shows it. `bots` is the names of the machine's bots that have it. */
export function mcpJson(v: ServerView | ServerDetail, botName?: string) {
	const { bots, status, ...rest } = v;
	const base = {
		...rest,
		botIds: bots,
		status: { ...status, since: ms(status.since), lastConnectedAt: ms(status.lastConnectedAt), offlineSince: ms(status.offlineSince), nextAttemptAt: ms(status.nextAttemptAt), discoveredAt: ms(status.discoveredAt) },
		...(botName === undefined ? {} : { enabledForBot: bots.includes(botName) }),
	};
	if (!("changes" in base)) return base;
	return { ...base, changes: (base.changes as { at: number }[]).map((c) => ({ ...c, at: Math.round(c.at * 1000) })) };
}
