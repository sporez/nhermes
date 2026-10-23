// Gateway upkeep actions (check, update, restart, doctor) and the record of their progress, shared by the
// Hermes screens and the client API. A record lives in app.sqlite under a key; one that restarts the
// gateway stays "running" while the process that started it lives and is done once a new process answers.
import { randomUUID } from "node:crypto";
import type { Core } from "../app.ts";
import { VERSION } from "../version.ts";
import { runDoctor } from "./doctor.ts";

/** This process; an action started by an earlier one finished when that process exited for it. */
const BOOT = randomUUID();

export type ActionRecord = {
	boot: string;
	/** "check" | "update" | "restart" | "doctor"; absent on the records Hermes keeps by name. */
	kind?: string;
	/** Unix seconds. */
	startedAt: number;
	finishedAt?: number;
	exitCode?: number;
	lines: string[];
	restarting?: boolean;
};

const key = (name: string) => `actions.${name}`;

export function saveAction(core: Core, name: string, a: ActionRecord): void {
	core.db.run("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key(name), JSON.stringify(a));
}

/** The record under a name; a restart that a new process has outlived is finished here. */
export function loadAction(core: Core, name: string): ActionRecord | undefined {
	const row = core.db.get<{ value: string }>("SELECT value FROM settings WHERE key = ?", key(name));
	if (!row) return undefined;
	const a = JSON.parse(row.value) as ActionRecord;
	if (a.finishedAt === undefined && a.boot !== BOOT) {
		a.finishedAt = Date.now() / 1000;
		if (a.restarting) {
			const current = core.updates.status().current;
			a.exitCode = 0;
			a.lines = [...a.lines, `Back up at ${new Date().toISOString().slice(11, 19)} on ${VERSION}${current ? ` (${current.hash})` : ""}.`];
		} else {
			a.exitCode = 1;
			a.lines = [...a.lines, "The gateway restarted before this finished."];
		}
		saveAction(core, name, a);
	}
	return a;
}

/** Whether a record is still going (only ever true for this process's own). */
export const isRunning = (a: ActionRecord): boolean => a.finishedAt === undefined;

/** Updates the software; the gateway restarts after it when a service manager can start it again. */
export function runUpdate(core: Core, name: string, kind?: string): ActionRecord {
	const started = Date.now() / 1000;
	const u = core.updates.update();
	const lines = [`Updated ${u.from.hash} → ${u.to.hash} (${u.to.subject}).`, u.packagesReinstalled ? "Packages reinstalled." : "", u.restarting ? "Restarting…" : "Restart the gateway on its machine to run the new version."].filter(Boolean);
	const a: ActionRecord = { boot: BOOT, ...(kind ? { kind } : {}), startedAt: started, lines, restarting: u.restarting, ...(u.restarting ? {} : { finishedAt: Date.now() / 1000, exitCode: 0 }) };
	saveAction(core, name, a);
	return a;
}

export function runRestart(core: Core, name: string, kind?: string): ActionRecord {
	core.updates.restart();
	const a: ActionRecord = { boot: BOOT, ...(kind ? { kind } : {}), startedAt: Date.now() / 1000, lines: ["Restarting the gateway…"], restarting: true };
	saveAction(core, name, a);
	return a;
}

/** Fetches what is new on the remote. Never restarts anything. */
export function runCheck(core: Core, name: string, kind?: string): ActionRecord {
	const started = Date.now() / 1000;
	const s = core.updates.check();
	const lines = s.available.length === 0 ? ["Up to date."] : [`${s.available.length} new ${s.available.length === 1 ? "commit" : "commits"}:`, ...s.available.map((c) => `${c.hash} ${c.subject}`)];
	const a: ActionRecord = { boot: BOOT, ...(kind ? { kind } : {}), startedAt: started, finishedAt: Date.now() / 1000, exitCode: 0, lines };
	saveAction(core, name, a);
	return a;
}

/** Starts the health check. The record says running at once; the promise ends when the report is in. */
export function startDoctor(core: Core, name: string, kind?: string): { record: ActionRecord; done: Promise<ActionRecord> } {
	const record: ActionRecord = { boot: BOOT, ...(kind ? { kind } : {}), startedAt: Date.now() / 1000, lines: [] };
	saveAction(core, name, record);
	const done = runDoctor(core).then(
		(report) => {
			const a: ActionRecord = { boot: BOOT, ...(kind ? { kind } : {}), startedAt: report.at, finishedAt: Date.now() / 1000, exitCode: report.exitCode, lines: report.lines };
			saveAction(core, name, a);
			return a;
		},
		(error) => {
			const a: ActionRecord = { ...record, finishedAt: Date.now() / 1000, exitCode: 1, lines: [`The health check failed: ${error instanceof Error ? error.message : String(error)}`] };
			saveAction(core, name, a);
			return a;
		},
	);
	return { record, done };
}

/** Keeps the records of the client API's last 20 actions; older ones are dropped. */
export function pruneActions(core: Core): void {
	core.db.run(
		"DELETE FROM settings WHERE key LIKE 'actions.run.%' AND key NOT IN (SELECT key FROM settings WHERE key LIKE 'actions.run.%' ORDER BY json_extract(value, '$.startedAt') DESC LIMIT 20)",
	);
}
