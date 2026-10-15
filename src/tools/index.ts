// Tool groups a bot can be given (config `tools:`). Each group is a list of Durable tool
// registrations; the agent's enabled tools are the union of its bot's groups.
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { createBashTool, createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-durable/tools";

export type ToolGroups = Map<string, ToolRegistration[]>;

export function coreToolGroups(): ToolGroups {
	const groups: ToolGroups = new Map();
	groups.set("files", [createReadTool() as ToolRegistration, createWriteTool() as ToolRegistration, createEditTool() as ToolRegistration]);
	groups.set("shell", [createBashTool() as ToolRegistration]);
	return groups;
}

export function toolsFor(groups: ToolGroups, names: readonly string[]): ToolRegistration[] {
	const out: ToolRegistration[] = [];
	const seen = new Set<string>();
	for (const g of names) {
		for (const t of groups.get(g) ?? []) {
			if (!seen.has(t.name)) {
				seen.add(t.name);
				out.push(t);
			}
		}
	}
	return out;
}

export const GROUP_LABELS: Record<string, { label: string; description: string }> = {
	files: { label: "File Operations", description: "read, write, edit" },
	shell: { label: "Shell", description: "bash (local or on the bot's host)" },
	web: { label: "Web & HTTP", description: "web_fetch, http_request" },
	memory: { label: "Memory", description: "remember, recall, forget" },
	skills: { label: "Skills", description: "skill (load a SKILL.md by name)" },
	self: { label: "Self-management", description: "self_info, nhermes_docs, change own setup" },
	schedule: { label: "Scheduled Tasks", description: "schedule_create, schedule_list, …" },
	delegate: { label: "Delegation", description: "delegate to another bot" },
	notify: { label: "Notifications", description: "notify (Vory and/or Pushover)" },
	browser: { label: "Browser Automation", description: "Playwright: open, snapshot, click, type, screenshot" },
	desktop: { label: "Desktop Automation", description: "X11 desktop: screenshot, click, type, windows" },
};
