// Tool-call policy: decides allow / ask / deny for one call. Keyed on what the call does, never on
// what tool output said. "smart" asks only for high-impact actions; "manual" asks for every
// side-effecting tool; "off" allows everything except explicit deny rules.
import type { Bot } from "./bots.ts";

export type Decision = {
	action: "allow" | "ask" | "deny";
	patternKey: string;
	description: string;
	command: string;
	/** An "ask" a reviewer (Jev) may answer instead of the owner: no destructive pattern, owner rule or manual mode involved. */
	reviewable?: boolean;
};

/** `trustedAsks: true` patterns are the destructive group: they ask even trusted bots and are never left to a reviewer. */
type Pattern = { key: string; re: RegExp; description: string; trustedAsks: boolean };

/**
 * Asked only while a reviewer is active (it answers most of them), for trusted bots too: everyday
 * commands that are fine in context but can do damage or reach outside the task.
 */
const REVIEWED_PATTERNS: Pattern[] = [
	{ key: "delete", re: /(^|[;&|(]\s*|\s)rm\s/, description: "delete files", trustedAsks: true },
	{ key: "permissions", re: /\b(chmod|chown|chgrp)\s/, description: "change file permissions", trustedAsks: true },
	{ key: "git write", re: /\bgit\s+(push|commit|reset|rebase|merge|restore|clean|checkout\s+--|branch\s+-[dD]|tag\s+-d|stash\s+(drop|clear))\b/, description: "change a git repository", trustedAsks: true },
	{ key: "remote access", re: /\b(ssh|scp|sftp|rsync|nc|ncat|socat|telnet)\b/, description: "connect to or copy to/from another machine", trustedAsks: true },
	{ key: "shell -c", re: /\b(bash|sh|zsh|dash)\s+-c\b/, description: "run a command string in a new shell", trustedAsks: true },
	{ key: "inline script", re: /\b(python3?|node|perl|ruby|osascript|php)\s+(-[ce]\b|-(\s|$))|<<-?\s*['"]?\w+['"]?/, description: "run an inline script", trustedAsks: true },
	{ key: "containers", re: /\b(docker|podman)\s+(run|rm|rmi|exec|stop|kill|system\s+prune|volume\s+rm|compose\s+(up|down|rm))\b|\bkubectl\s+(apply|delete|exec|scale)\b|\bterraform\s+(apply|destroy)\b/, description: "change containers or infrastructure", trustedAsks: true },
	{ key: "publish", re: /\b(npm|pnpm|yarn)\s+publish\b|\b(docker|podman)\s+push\b|\bgh\s+(release\s+create|pr\s+merge|repo\s+(delete|edit))\b/, description: "publish something", trustedAsks: true },
	{ key: "services", re: /\bsystemctl\s+(start|restart|reload|enable)\b|\blaunchctl\s+(load|unload|bootstrap|bootout|kill|kickstart|remove|enable|disable)\b|\bcrontab\b/, description: "change services or scheduled jobs", trustedAsks: true },
];

/** High-impact shell patterns. `trustedAsks: false` lets a trusted infrastructure bot run them freely. */
const SHELL_PATTERNS: Pattern[] = [
	{ key: "rm -rf", re: /\brm\s+(-[a-zA-Z]*[rR][a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*[rR]|--recursive\s+--force|--force\s+--recursive)\b/, description: "recursive forced delete", trustedAsks: false },
	{ key: "rm -rf /", re: /\brm\s+-[a-zA-Z]*\s+(\/|\/\*|~|\$HOME)(\s|$)/, description: "delete a root or home directory", trustedAsks: true },
	{ key: "mkfs", re: /\bmkfs(\.\w+)?\b/, description: "format a filesystem", trustedAsks: true },
	{ key: "wipefs", re: /\b(wipefs|sgdisk\s+--zap|blkdiscard)\b/, description: "wipe a disk", trustedAsks: true },
	{ key: "partition", re: /\b(fdisk|parted|sfdisk|gdisk)\b/, description: "change partitions", trustedAsks: true },
	// Checking or repairing a mounted disk can freeze the whole machine (macOS freezes the startup volume
	// while it is verified), so even "verify only" asks.
	{
		key: "disk check",
		re: /\bdiskutil\s+(verify|repair|erase|reformat|zero|secureErase|partition|resize|split|merge|unmount|eject|apfs\s+(?!list\b)\w+|cs\s+(?!list\b)\w+|ar\s+(?!list\b)\w+)|\bfsck(_\w+)?\b|\b(badblocks|hdparm|newfs(_\w+)?|e2fsck|xfs_repair|btrfs\s+(check|scrub|rescue))\b|\bsmartctl\s+[^|;&]*(-t|--test)\b/i,
		description: "check, repair or reformat a disk (can freeze the machine)",
		trustedAsks: true,
	},
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
	{ key: "package install", re: /\b(apt(-get)?|dnf|yum|pacman|brew|snap|pip3?|npm)\s+(-\S+\s+)*(install|add|upgrade|dist-upgrade|full-upgrade)\b/, description: "install or upgrade software", trustedAsks: false },
	{ key: "sudo", re: /(^|[;&|(]\s*|\s)sudo\s/, description: "run a command as root", trustedAsks: false },
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
	/** A reviewer (Jev) is active: the wider list applies. */
	reviewActive?: boolean;
	/** The gateway's own files (config, secrets, databases; not the bots' workspaces). */
	gatewayFiles?: RegExp;
};

/** The gateway's own folders and files, as a pattern on commands and paths. Bots' workspaces are excluded. */
export function gatewayFilesPattern(configDir: string, dataDir: string): RegExp {
	const esc = (p: string) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const home = process.env.HOME ?? "";
	const variants = (p: string) => [p, ...(home && p.startsWith(`${home}/`) ? [`~${p.slice(home.length)}`, `$HOME${p.slice(home.length)}`] : [])].map(esc);
	const dirs = [...variants(configDir), ...variants(dataDir).map((d) => `${d}(?!/workspaces/)`)];
	return new RegExp(`(${dirs.join("|")})|\\b(secrets\\.env|app\\.sqlite|durable\\.sqlite)\\b|nhermes/(auth|models)\\.json`);
}

export function decide(call: { name: string; arguments: Record<string, unknown> }, pc: PolicyContext): Decision {
	const { bot } = pc;
	const command = describeCall(call.name, call.arguments);
	const shell = shellCommandOf(call.name, call.arguments);

	for (const rule of bot.approvals.deny) {
		if (ruleMatches(rule, call.name, command)) return { action: "deny", patternKey: rule, description: `blocked by the bot's deny rule "${rule}"`, command };
	}
	if (pc.yolo || bot.approvals.mode === "off") return { action: "allow", patternKey: "", description: "", command };

	// Everything that would make this call need an answer. Each must be allowed on its own: an answer
	// for one pattern never covers another pattern in the same command.
	// `review: false` reasons always reach the owner.
	const reasons: { key: string; description: string; review: boolean }[] = [];
	for (const rule of bot.approvals.ask) {
		if (ruleMatches(rule, call.name, command)) reasons.push({ key: rule, description: `matches the bot's ask rule "${rule}"`, review: false });
	}
	if (shell !== undefined) {
		for (const p of SHELL_PATTERNS) if (p.re.test(shell) && (!bot.trusted || p.trustedAsks)) reasons.push({ key: p.key, description: p.description, review: !p.trustedAsks });
		if (pc.reviewActive) for (const p of REVIEWED_PATTERNS) if (p.re.test(shell)) reasons.push({ key: p.key, description: p.description, review: true });
		if (pc.gatewayFiles?.test(shell)) reasons.push({ key: "gateway files", description: "touch the gateway's own config, secrets or databases", review: true });
	}
	const path = typeof call.arguments.path === "string" ? call.arguments.path : undefined;
	if ((call.name === "write" || call.name === "edit") && path !== undefined) {
		if (SENSITIVE_PATHS.some((re) => re.test(path)) || pc.gatewayFiles?.test(path)) reasons.push({ key: `${call.name}:sensitive`, description: "modify a sensitive file", review: false });
	}
	if (call.name === "read" && path !== undefined && pc.gatewayFiles?.test(path)) reasons.push({ key: "gateway files", description: "read the gateway's own config, secrets or databases", review: true });
	if (bot.approvals.mode === "manual" && SIDE_EFFECT_TOOLS.has(call.name)) reasons.push({ key: `tool:${call.name}`, description: `run ${call.name}`, review: false });
	if (reasons.length === 0) return { action: "allow", patternKey: "", description: "", command };

	// Answers ("session", "always") are stored as the pattern key they were asked for and match only that
	// key; configured allow rules are matched against the call like ask/deny rules.
	if (bot.approvals.allow.some((r) => ruleMatches(r, call.name, command))) return { action: "allow", patternKey: reasons[0]!.key, description: reasons[0]!.description, command };
	const open = reasons.filter((r) => !pc.botRules.includes(r.key) && !pc.sessionRules.includes(r.key));
	if (open.length === 0) return { action: "allow", patternKey: reasons[0]!.key, description: reasons[0]!.description, command };
	return { action: "ask", patternKey: open[0]!.key, description: open.map((r) => r.description).join("; "), command, reviewable: open.every((r) => r.review) };
}
