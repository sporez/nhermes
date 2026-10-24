// Wire shapes of the gateway upkeep resources (docs/API.md "Gateway"): settings, keys, scheduled tasks,
// workspace files, software and actions. Times leave as Unix milliseconds. No key value is in any of them,
// only whether it is set and the last characters that tell keys apart.
import type { Core } from "../../app.ts";
import type { ActionRecord } from "../../core/actions.ts";
import { ms } from "../../core/job-shapes.ts";
import type { SecretInfo } from "../../core/secrets.ts";
import type { SoftwareStatus } from "../../core/updates.ts";
import { VERSION } from "../../version.ts";

export function gatewaySettingsJson(core: Core) {
	const c = core.config;
	return {
		timeZone: c.timezone,
		defaults: { model: c.defaults.model, thinking: c.defaults.thinking, approvals: c.defaults.approvals, approvalTimeoutS: c.defaults.approvalTimeoutS, questionTimeoutS: c.defaults.questionTimeoutS },
		hiddenModelProviders: c.modelLists.hide,
		groundRules: c.groundRules ?? null,
		review: { enabled: c.review.enabled, allowThreshold: c.review.allowThreshold, timeoutMs: c.review.timeoutMs, keyEnv: c.review.keyEnv },
	};
}

export function keyJson(core: Core, k: SecretInfo) {
	let hint: string | null = null;
	if (k.set) {
		try {
			hint = core.secrets.hint(k.name);
		} catch {
			// Set in the file but not in this process's environment yet.
		}
	}
	return { name: k.name, set: k.set, description: k.description, usedBy: k.usedBy, hint };
}

export function softwareJson(core: Core, s: SoftwareStatus) {
	const restartReason = core.updates.canRestart ? null : "This gateway is not run by systemd or launchd, so it cannot restart itself; do it on its machine.";
	return {
		version: VERSION,
		commit: s.current ? { hash: s.current.hash, subject: s.current.subject, date: ms(s.current.date) } : null,
		branch: s.branch ?? null,
		behind: s.available.length,
		commits: s.available.map((c) => ({ hash: c.hash, subject: c.subject, date: ms(c.date) })),
		lastCheck: ms(s.lastCheck),
		canUpdate: s.updatable,
		canRestart: core.updates.canRestart,
		reason: (!s.updatable ? s.reason : restartReason) ?? null,
		running: core.sessions.runningCount(),
	};
}

export function actionJson(id: string, a: ActionRecord) {
	const done = a.finishedAt !== undefined;
	return {
		id,
		kind: a.kind ?? null,
		status: !done ? "running" : (a.exitCode ?? 0) === 0 ? "done" : "failed",
		startedAt: ms(a.startedAt),
		finishedAt: ms(a.finishedAt),
		exitCode: a.exitCode ?? null,
		lines: a.lines,
	};
}
