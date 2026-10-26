// What `nhermes doctor` says about spaces: cua runs, containers use gVisor, and the host firewall that keeps a
// space off the LAN is active (docs/SPACES.md). Every command has a short timeout, and the commands are
// injected so tests never run the real cua or systemctl. Output is read loosely: a format we do not recognise
// is a warning that says so, never a failure.
import { execFile } from "node:child_process";
import { CuaMissing, type CuaRun } from "./cua.ts";

export type SpacesFinding = { level: "ok" | "warn"; text: string };
export type SpacesProbe = { cua: CuaRun; systemctl: CuaRun; platform: NodeJS.Platform };

const FIREWALL_UNIT = "nhermes-spaces-firewall";
const SHORT_MS = 5000;
const DOCTOR_MS = 20_000;

/** Runs a command with a timeout; rejects with `CuaMissing` when it cannot be started. */
export function execProbe(command: string): CuaRun {
	return (args, options) =>
		new Promise((resolve, reject) => {
			execFile(command, args, { timeout: options?.timeoutMs ?? SHORT_MS, maxBuffer: 1024 * 1024, env: { ...process.env, DO_NOT_TRACK: "1" } }, (error, stdout, stderr) => {
				const code = (error as NodeJS.ErrnoException | null)?.code;
				if (code === "ENOENT" || code === "EACCES") return reject(new CuaMissing());
				resolve({ code: error ? (typeof code === "number" ? code : 1) : 0, stdout: String(stdout), stderr: String(stderr) });
			});
		});
}

export function defaultProbe(cua: string): SpacesProbe {
	return { cua: execProbe(cua), systemctl: execProbe("systemctl"), platform: process.platform };
}

/** Whether the cua command exists on this host; its version when it answers. */
export async function cuaVersion(probe: SpacesProbe): Promise<{ installed: boolean; version?: string; problem?: string }> {
	try {
		const r = await probe.cua(["--version"], { timeoutMs: SHORT_MS });
		if (r.code !== 0) return { installed: true, problem: "did not answer `--version` (it may be stuck)" };
		return { installed: true, version: /(\d+\.\d+[\w.+-]*)/.exec(r.stdout)?.[1] };
	} catch (e) {
		if (e instanceof CuaMissing) return { installed: false };
		return { installed: true, problem: String(e instanceof Error ? e.message : e) };
	}
}

/** The container runtime line of `cua runtime doctor`. */
export function containerRuntime(output: string): "gvisor" | "runc" | "failing" | "unknown" {
	const line = output.split("\n").find((l) => /^\s*container\b/i.test(l));
	if (!line) return "unknown";
	if (/without\s+runsc|runc\b.*unless/i.test(line)) return "runc";
	if (/gvisor|runsc/i.test(line)) return /\b(fail|missing|error|not\s+found)\b/i.test(line) ? "failing" : "gvisor";
	return /\bok\b/i.test(line) ? "runc" : "failing";
}

/** The findings for the Spaces section; `bots` is true when some bot has the spaces tool group. */
export async function spacesFindings(probe: SpacesProbe, bots: boolean): Promise<SpacesFinding[]> {
	const cua = await cuaVersion(probe);
	if (!cua.installed && !bots) return [];
	const out: SpacesFinding[] = [];
	if (!cua.installed) {
		out.push({ level: "warn", text: "Spaces: a bot has the spaces tools but the cua command is not installed on this host, so it cannot open one. See docs/SPACES.md, \"Host setup\"." });
	} else if (cua.problem) {
		out.push({ level: "warn", text: `Spaces: the cua command ${cua.problem}. Run \`cua --version\` on the gateway host.` });
	} else {
		out.push({ level: "ok", text: `Spaces: cua${cua.version ? ` ${cua.version}` : ""} runs` });
	}

	if (cua.installed && !cua.problem) {
		try {
			const r = await probe.cua(["runtime", "doctor"], { timeoutMs: DOCTOR_MS });
			const kind = containerRuntime(r.stdout);
			if (kind === "gvisor") out.push({ level: "ok", text: "Spaces: containers run under gVisor" });
			else if (kind === "runc") out.push({ level: "warn", text: "Spaces: containers would run with plain runc, which shares the host's kernel. Install gVisor (runsc) as docs/SPACES.md \"Host setup\" describes." });
			else if (kind === "failing") out.push({ level: "warn", text: "Spaces: the container runtime is not working (see `cua runtime doctor`). Install Docker and gVisor as docs/SPACES.md \"Host setup\" describes." });
			else out.push({ level: "warn", text: "Spaces: could not tell whether containers use gVisor (`cua runtime doctor` printed nothing nHermes knows how to read, or did not finish). Run it by hand." });
		} catch (e) {
			out.push({ level: "warn", text: `Spaces: could not run \`cua runtime doctor\`: ${String(e instanceof Error ? e.message : e)}` });
		}
	}

	if (probe.platform !== "linux") {
		out.push({ level: "warn", text: `Spaces: the firewall that keeps a space off your network cannot be checked on this host (${probe.platform}); spaces are meant for a Linux host, see docs/SPACES.md "Network isolation".` });
	} else {
		try {
			const r = await probe.systemctl(["is-active", FIREWALL_UNIT], { timeoutMs: SHORT_MS });
			if (r.code === 0 && r.stdout.trim() === "active") out.push({ level: "ok", text: `Spaces: the firewall (${FIREWALL_UNIT}) is active` });
			else out.push({ level: "warn", text: `Spaces: the firewall (${FIREWALL_UNIT}) is ${r.stdout.trim() || "not active"}, so a space can reach your network. Install and start it as the header of deploy/${FIREWALL_UNIT}.service says (docs/SPACES.md "Network isolation").` });
		} catch (e) {
			const why = e instanceof CuaMissing ? "this host has no systemctl" : String(e instanceof Error ? e.message : e);
			out.push({ level: "warn", text: `Spaces: the firewall (${FIREWALL_UNIT}) cannot be checked: ${why}. See docs/SPACES.md "Network isolation".` });
		}
	}
	return out;
}
