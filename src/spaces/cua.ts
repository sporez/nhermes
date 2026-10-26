// The cua command line, the only way nHermes talks to Cua: one function that runs it, and a parser for
// what `cua sb ls` prints. Nothing here knows about bots or limits (spaces.ts).
import { execFile } from "node:child_process";
import { redact } from "../log.ts";

export type CuaResult = { code: number; stdout: string; stderr: string };
/** Runs `cua <args>`. Rejects with `CuaMissing` when the command cannot be started at all. */
export type CuaRun = (args: string[], options?: { timeoutMs?: number }) => Promise<CuaResult>;

export const SPACES_NEED_CUA = "Spaces need the cua command on the gateway host; see docs/SPACES.md.";

/** Thrown when the cua command is not installed (or not executable) on the gateway host. */
export class CuaMissing extends Error {
	constructor() {
		super(SPACES_NEED_CUA);
	}
}

export function execCua(cua: string): CuaRun {
	return (args, options) =>
		new Promise((resolve, reject) => {
			execFile(cua, args, { timeout: options?.timeoutMs ?? 120_000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, DO_NOT_TRACK: "1" } }, (error, stdout, stderr) => {
				const code = (error as NodeJS.ErrnoException | null)?.code;
				if (code === "ENOENT" || code === "EACCES") return reject(new CuaMissing());
				const exit = error ? (typeof code === "number" ? code : 1) : 0;
				resolve({ code: exit, stdout: String(stdout), stderr: String(stderr) });
			});
		});
}

/** The first useful line of a failed command's output, without secrets, short enough to show a bot. */
export function cuaProblem(result: CuaResult): string {
	const text = (result.stderr.trim() || result.stdout.trim()).split("\n").find((l) => l.trim()) ?? `exit code ${result.code}`;
	return redact(text.trim()).slice(0, 300);
}

/**
 * The sandbox names in `cua sb ls --json`. The shape is read loosely: a list, or an object holding one
 * (`sandboxes`, `items`, ...), whose entries are objects with a `name` (or plain strings). Unknown fields are ignored.
 */
export function parseSandboxNames(stdout: string): string[] {
	let json: unknown;
	try {
		json = JSON.parse(stdout);
	} catch {
		throw new Error("cua printed a sandbox list nHermes could not read");
	}
	const list = Array.isArray(json) ? json : json && typeof json === "object" ? Object.values(json).find(Array.isArray) : undefined;
	if (!Array.isArray(list)) return [];
	const names: string[] = [];
	for (const entry of list) {
		const name = typeof entry === "string" ? entry : entry && typeof entry === "object" ? (entry as { name?: unknown }).name : undefined;
		if (typeof name === "string" && name) names.push(name);
	}
	return names;
}
