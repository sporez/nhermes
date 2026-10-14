// Tool-call policy: decides allow / ask / deny for one call. Keyed on what the call does, never on
// what tool output said. "smart" asks only for high-impact actions; "manual" asks for every
// side-effecting tool; "off" allows everything except explicit deny rules.
import type { Bot } from "./bots.ts";

export type Decision = { action: "allow" | "ask" | "deny"; patternKey: string; description: string; command: string };

type Pattern = { key: string; re: RegExp; description: string; trustedAsks: boolean };

/** High-impact shell patterns. `trustedAsks: false` lets a trusted infrastructure bot run them freely. */
const SHELL_PATTERNS: Pattern[] = [
	{ key: "rm -rf", re: /\brm\s+(-[a-zA-Z]*[rR][a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*[rR]|--recursive\s+--force|--force\s+--recursive)\b/, description: "recursive forced delete", trustedAsks: false },
	{ key: "rm -rf /", re: /\brm\s+-[a-zA-Z]*\s+(\/|\/\*|~|\$HOME)(\s|$)/, description: "delete a root or home directory", trustedAsks: true },
	{ key: "mkfs", re: /\bmkfs(\.\w+)?\b/, description: "format a filesystem", trustedAsks: true },
	{ key: "wipefs", re: /\b(wipefs|sgdisk\s+--zap|blkdiscard)\b/, description: "wipe a disk", trustedAsks: true },
	{ key: "partition", re: /\b(fdisk|parted|sfdisk|gdisk)\b/, description: "change partitions", trustedAsks: true },
	{ key: "dd of=", re: /\bdd\b[^|;&]*\bof=\/dev\//, description: "write raw to a device", trustedAsks: true },
	{ key: "zfs destroy", re: /\b(zfs|zpool)\s+(destroy|labelclear)\b/, description: "destroy ZFS data", trustedAsks: true },
	{ key: "lvremove", re: /\b(lvremove|vgremove|pvremove)\b/, description: "remove LVM volumes", trustedAsks: true },
	{ key: "power", re: /\b(shutdown|poweroff|halt|reboot)\b|\bsystemctl\s+(poweroff|reboot|halt)\b/, description: "power off or reboot a machine", trustedAsks: true },
	{ key: "proxmox destroy", re: /\b(qm|pct)\s+(destroy|stop|shutdown)\b/, description: "stop or destroy a VM/container", trustedAsks: true },
	{ key: "credentials", re: /\b(passwd|chpasswd|usermod\s+-p|ssh-keygen\s+-R|visudo)\b|authorized_keys|\/etc\/shadow|\/etc\/sudoers/, description: "change credentials or access", trustedAsks: true },
	{ key: "firewall flush", re: /\b(iptables|ip6tables|nft)\s+(-F|--flush|flush)\b|\bufw\s+(disable|reset)\b/, description: "flush the firewall", trustedAsks: true },
	{ key: "git force", re: /\bgit\s+(push\s+[^|;&]*(--force|-f)\b|reset\s+--hard|clean\s+-[a-zA-Z]*f)/, description: "rewrite or discard git history", trustedAsks: false },
	{ key: "pipe to shell", re: /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z)?sh\b/, description: "run a downloaded script", trustedAsks: false },
	{ key: "chmod -R", re: /\b(chmod|chown)\s+-[a-zA-Z]*R/, description: "recursive permission change", trustedAsks: false },
	{ key: "sql drop", re: /\b(DROP\s+(TABLE|DATABASE|SCHEMA)|TRUNCATE\s+TABLE)\b/i, description: "drop database objects", trustedAsks: false },
	{ key: "kill all", re: /\b(killall|pkill)\b|\bkill\s+-9\s+-?1\b/, description: "kill processes broadly", trustedAsks: false },
	{ key: "service stop", re: /\bsystemctl\s+(stop|disable|mask)\b/, description: "stop or disable a service", trustedAsks: false },
	{ key: "package remove", re: /\b(apt(-get)?|dnf|yum|pacman|brew)\s+(remove|purge|autoremove|uninstall|-R)\b/, description: "remove packages", trustedAsks: false },
	{ key: "fork bomb", re: /:\(\)\s*\{\s*:\|:&\s*\};:/, description: "fork bomb", trustedAsks: true },
];

/** Paths whose modification is high impact for write/edit tools. */
const SENSITIVE_PATHS = [/(^|\/)\.ssh\//, /^\/etc\//, /(^|\/)\.pi\/agent\/auth\.json$/, /(^|\/)secrets\.env$/, /(^|\/)\.env$/, /^\/boot\//, /^\/dev\//];

/** Tools with side effects outside the transcript (subject to "manual" mode). */
const SIDE_EFFECT_TOOLS = new Set(["bash", "write", "edit", "http_request", "browser_type", "browser_click", "browser_press", "desktop_click", "desktop_type", "desktop_key", "notify", "schedule_create", "schedule_update", "schedule_delete"]);

export function shellCommandOf(name: string, args: Record<string, unknown>): string | undefined {
	if (name === "bash" && typeof args.command === "string") return args.command;
	return undefined;
}

export function describeCall(name: string, args: Record<string, unknown>): string {
	const cmd = shellCommandOf(name, args);
	if (cmd !== undefined) return cmd;
	if (typeof args.path === "string") return `${name} ${args.path}`;
	if (typeof args.url === "string") return `${name} ${(args.method as string | undefined) ?? ""} ${args.url}`.replace(/\s+/g, " ");
	return `${name} ${JSON.stringify(args).slice(0, 200)}`;
}

function ruleMatches(rule: string, name: string, command: string): boolean {
	// "tool:<name>" matches a tool; anything else is a regex (or literal) on the command text.
	if (rule.startsWith("tool:")) return rule.slice(5) === name;
	try {
		return new RegExp(rule).test(command);
	} catch {
		return command.includes(rule);
	}
}

export type PolicyContext = {
	bot: Bot;
	/** Rules allowed for this session ("session" answers). */
	sessionRules: readonly string[];
	/** Rules allowed for this bot ("always" answers). */
	botRules: readonly string[];
	yolo: boolean;
};

export function decide(call: { name: string; arguments: Record<string, unknown> }, pc: PolicyContext): Decision {
	const { bot } = pc;
	const command = describeCall(call.name, call.arguments);
	const shell = shellCommandOf(call.name, call.arguments);

	for (const rule of bot.approvals.deny) {
		if (ruleMatches(rule, call.name, command)) return { action: "deny", patternKey: rule, description: `blocked by the bot's deny rule "${rule}"`, command };
	}
	if (pc.yolo || bot.approvals.mode === "off") return { action: "allow", patternKey: "", description: "", command };

	// What would make this call need an answer.
	let ask: { key: string; description: string } | undefined;
	for (const rule of bot.approvals.ask) {
		if (ruleMatches(rule, call.name, command)) {
			ask = { key: rule, description: `matches the bot's ask rule "${rule}"` };
			break;
		}
	}
	if (!ask && shell !== undefined) {
		const hit = SHELL_PATTERNS.find((p) => p.re.test(shell) && (!bot.trusted || p.trustedAsks));
		if (hit) ask = { key: hit.key, description: hit.description };
	}
	if (!ask && (call.name === "write" || call.name === "edit") && typeof call.arguments.path === "string") {
		const p = call.arguments.path;
		if (SENSITIVE_PATHS.some((re) => re.test(p))) ask = { key: `${call.name}:sensitive`, description: "modify a sensitive file" };
	}
	if (!ask && bot.approvals.mode === "manual" && SIDE_EFFECT_TOOLS.has(call.name)) {
		ask = { key: `tool:${call.name}`, description: `run ${call.name}` };
	}
	if (!ask) return { action: "allow", patternKey: "", description: "", command };

	// Answers ("session", "always") are stored as the pattern key they were asked for and match only
	// that key; configured allow rules are matched against the call like ask/deny rules.
	const answered = pc.botRules.includes(ask.key) || pc.sessionRules.includes(ask.key);
	if (answered || bot.approvals.allow.some((r) => ruleMatches(r, call.name, command))) {
		return { action: "allow", patternKey: ask.key, description: ask.description, command };
	}
	return { action: "ask", patternKey: ask.key, description: ask.description, command };
}
