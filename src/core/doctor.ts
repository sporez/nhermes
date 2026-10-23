// A health check of the gateway (the panel's and client API's doctor): config, models and their keys, keys in use but
// not set, network members, MCP servers, SSH hosts, disk space, PDF page rendering, scheduled jobs, the
// reviewer and the software. An MCP server that is away is only a warning: the gateway works without it.
// Each finding is one line: "ok", "warn" or "fail"; any "fail" makes the exit code 1.
import { statfsSync } from "node:fs";
import { connect } from "node:net";
import type { Core } from "../app.ts";
import { loadConfig } from "../config.ts";

export type Finding = { level: "ok" | "warn" | "fail"; text: string };
export type DoctorReport = { at: number; exitCode: number; findings: Finding[]; lines: string[] };

const MARK = { ok: "✓", warn: "!", fail: "✗" } as const;

function tcpReachable(host: string, port: number, timeoutMs = 3000): Promise<boolean> {
	return new Promise((resolve) => {
		const s = connect({ host, port });
		const done = (ok: boolean) => {
			s.destroy();
			resolve(ok);
		};
		s.setTimeout(timeoutMs, () => done(false));
		s.once("connect", () => done(true));
		s.once("error", () => done(false));
	});
}

export async function runDoctor(c: Core): Promise<DoctorReport> {
	const f: Finding[] = [];
	const add = (level: Finding["level"], text: string) => f.push({ level, text });

	try {
		loadConfig(c.config.configPath);
		add("ok", `config.yaml loads (${c.config.configPath})`);
	} catch (error) {
		add("fail", `config.yaml does not load: ${error instanceof Error ? error.message : String(error)}`);
	}

	const available = new Set((await c.models.getAvailable()).map((m) => `${m.provider}/${m.id}`));
	for (const b of c.bots.list().filter((x) => !x.isPeer)) {
		const ref = `${b.model.provider}/${b.model.modelId}`;
		if (!c.models.getModel(b.model.provider, b.model.modelId)) add("fail", `${b.name}: model ${ref} is unknown`);
		else if (!available.has(ref)) add("fail", `${b.name}: model ${ref} has no key or login`);
		else add("ok", `${b.name}: model ${ref}`);
	}

	const missing = c.secrets.list().filter((s) => !s.set && s.usedBy.length > 0);
	for (const s of missing) add("warn", `${s.name} is not set (used by ${s.usedBy.join(", ")})`);
	if (c.config.apns) {
		const devices = c.devices.list();
		if (!c.apns.configured()) add("warn", `push notifications: the APNs key in ${c.config.apns.keyEnv} is missing or cannot be read`);
		else add(devices.length ? "ok" : "warn", `push notifications: APNs key set, ${devices.length} device${devices.length === 1 ? "" : "s"} registered${devices.some((d) => d.last_error) ? ` (${devices.filter((d) => d.last_error).length} failing)` : ""}`);
	}
	if (missing.length === 0) add("ok", "every key in use is set");

	for (const m of c.members.list()) {
		if (m.reachable) add("ok", `network member ${m.name} reachable`);
		else add("warn", `network member ${m.name} not reachable${m.last_error ? `: ${m.last_error}` : ""}`);
	}

	for (const s of c.mcp.status()) {
		const tools = `${s.toolCount} tool${s.toolCount === 1 ? "" : "s"}${s.fresh ? "" : " known from an earlier connection"}`;
		if (s.state === "online") add("ok", `MCP server ${s.name} connected (${tools})`);
		else if (s.state === "disabled") add("ok", `MCP server ${s.name} is turned off`);
		else if (s.state === "needs_key") add("warn", `MCP server ${s.name} refused the gateway's key: ${s.lastError ?? ""}`);
		else if (s.state === "failed") add("warn", `MCP server ${s.name} cannot be used: ${s.lastError ?? ""}`);
		else add("warn", `MCP server ${s.name} is ${s.state === "connecting" ? "still connecting" : "offline"}${s.lastError ? ` (${s.lastError})` : ""}; ${tools}`);
	}

	const hosts = c.bots.list().filter((b) => !b.isPeer && b.config.host?.ssh);
	await Promise.all(
		hosts.map(async (b) => {
			const ssh = b.config.host!.ssh;
			const port = ssh.port ?? 22;
			if (await tcpReachable(ssh.host, port)) add("ok", `${b.name}: SSH host ${ssh.host}:${port} answers`);
			else add("fail", `${b.name}: SSH host ${ssh.host}:${port} does not answer`);
		}),
	);

	try {
		const s = statfsSync(c.config.dataDir);
		const free = s.bavail * s.bsize;
		const pct = (s.bavail / s.blocks) * 100;
		const gb = (free / 1e9).toFixed(1);
		if (free < 1e9 || pct < 5) add("fail", `disk nearly full: ${gb} GB free (${pct.toFixed(0)}%) at ${c.config.dataDir}`);
		else if (free < 5e9 || pct < 10) add("warn", `disk getting full: ${gb} GB free (${pct.toFixed(0)}%)`);
		else add("ok", `disk: ${gb} GB free (${pct.toFixed(0)}%)`);
	} catch (error) {
		add("warn", `disk space unknown: ${error instanceof Error ? error.message : String(error)}`);
	}

	if (await c.attachments.pdfPages()) add("ok", "PDF pages: pdftoppm found");
	else add("warn", "PDF pages: pdftoppm not found, install poppler-utils (until then a PDF sent from a client reaches the bot only as a file to open)");

	const failedJobs = c.scheduler.list().filter((j) => j.enabled === 1 && c.scheduler.lastRun(j.id)?.status === "error");
	for (const j of failedJobs) add("warn", `scheduled task "${j.name}" (${j.bot}) failed last time: ${c.scheduler.lastRun(j.id)?.error || "no reason recorded"}`);
	if (failedJobs.length === 0) add("ok", `scheduled tasks: ${c.scheduler.list().length}, none failing`);

	if (!c.config.review.enabled) add("ok", "Jev review is off");
	else if (c.reviewer.active()) add("ok", "Jev review is active");
	else add("warn", `Jev review is on but ${c.config.review.keyEnv} is not set, so every approval asks you`);

	const sw = c.updates.status();
	if (!sw.updatable) add("warn", `software updates unavailable: ${sw.reason}`);
	else if (sw.available.length > 0) add("warn", `${sw.available.length} update${sw.available.length === 1 ? "" : "s"} available`);
	else add("ok", `software: ${sw.current?.hash ?? "?"}${sw.lastCheck ? ", up to date at the last check" : ""}`);
	if (!c.updates.canRestart) add("warn", "not run by systemd or launchd: restarts and updates need a hand restart");

	const exitCode = f.some((x) => x.level === "fail") ? 1 : 0;
	return { at: Date.now() / 1000, exitCode, findings: f, lines: f.map((x) => `${MARK[x.level]} ${x.text}`) };
}
