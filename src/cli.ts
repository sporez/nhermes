// nhermes: the gateway daemon and its small admin CLI.
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { adminRoutes, restoreBackup } from "./admin.ts";
import { createCore } from "./app.ts";
import { ConfigError, loadConfig, NODE_NAME } from "./config.ts";
import { federationAdminRoutes } from "./federation/routes.ts";
import { startHermesServer } from "./hermes/server.ts";
import { logger } from "./log.ts";

const log = logger("cli");

const USAGE = `nhermes <command> [options]

Commands:
  serve                       Run the gateway (one process owns the data directory)
  init [dir] [--name n] [--port p] [--data-dir d]
                              Write a starter config.yaml and secrets.env into dir (default: .)
  status                      Bots, running sessions and scheduled jobs of the running gateway
  reload                      Re-read config.yaml (bots and defaults apply at once; also on SIGHUP)
  backup [--out f] [--secrets]  Consistent backup (.tar.gz) made by the running gateway
  restore <file> [--with-config]  Restore a backup; the gateway must be stopped
  invite [--url u]            A one-time code (10 minutes) for another machine to join this network
  join <code> [--yes]         Join the network a code comes from (asks you to confirm first)
  members                     This machine and the other members, with reachability
  members remove <name>       Remove a member from the whole network
  leave                       Leave the network
  secret list                 The gateway's keys and tokens (names only) and what uses them
  secret set <NAME>           Set a key in secrets.env (asks for the value without showing it)
  secret rm <NAME>            Remove a key
  panel password [--clear]    Set (or remove) the web panel's password; without one it is open on the LAN
  host trust <bot>            Show a bot's SSH host key fingerprints and trust them after you confirm
  memory <bot> [search text]  List or search a bot's memories
  memory <bot> add <text>     Save a memory for a bot (source: owner)
  memory <bot> rm <id>        Forget a memory

Options:
  -c, --config <path>   Config file (default: $NHERMES_CONFIG or ./config.yaml)
  -h, --help            Show this help
`;

type InitOptions = { name?: string; port?: number; dataDir?: string };

const sampleConfig = (o: InitOptions) => `# Neil Hermes configuration. Secrets go in secrets.env, not here.
server:
  host: 0.0.0.0          # all interfaces (Vory, other machines, the panel); 127.0.0.1 keeps it on this machine
  port: ${o.port ?? 9119}
  name: Neil Hermes
${o.name ? `node:\n  name: ${o.name}            # this machine in the network (nhermes invite / join)\n` : ""}dataDir: ${o.dataDir ?? "data"}
timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}

pi:                      # Pi's provider config; shared safely with the Pi CLI
  authPath: ~/.pi/agent/auth.json
  modelsPath: ~/.pi/agent/models.json

defaults:
  model: cerebras/gpt-oss-120b
  thinking: medium
  approvals: smart       # smart | manual | off
  approvalTimeoutS: 600

bots:
  - name: main
    displayName: Main
    default: true
    description: Personal assistant
    instructions: |
      You are the owner's personal assistant, running on their own machine.
      Be direct and concise. Use tools to check facts instead of guessing.
`;

async function serve(configPath: string): Promise<void> {
	const config = loadConfig(configPath);
	mkdirSync(config.dataDir, { recursive: true });
	const core = await createCore(config);
	const server = await startHermesServer(core, { host: config.server.host, port: config.server.port, extraRouters: [adminRoutes(core), federationAdminRoutes(core)] });
	await core.scheduler.start();
	core.members.start(() => core.roster.sync());
	log.info("gateway ready", { bots: core.bots.names(), port: server.port, dataDir: config.dataDir });
	let stopping = false;
	const stop = async (signal: string) => {
		if (stopping) return;
		stopping = true;
		log.info("shutting down", { signal });
		await server.close();
		await core.close();
		process.exit(0);
	};
	process.on("SIGHUP", () => {
		try {
			const r = core.settings.reload();
			if (r.restartNeeded.length > 0) log.warn("reloaded; some changes need a restart", { settings: r.restartNeeded });
		} catch (error) {
			log.error("reload failed; keeping the running configuration", { error: error instanceof Error ? error.message : String(error) });
		}
	});
	process.on("SIGTERM", () => void stop("SIGTERM"));
	process.on("SIGINT", () => void stop("SIGINT"));
}

function init(dir: string, o: InitOptions = {}): void {
	if (o.name !== undefined && !NODE_NAME.test(o.name)) throw new ConfigError(`--name must match ${NODE_NAME}`);
	const target = resolve(dir);
	mkdirSync(target, { recursive: true });
	const cfg = join(target, "config.yaml");
	const secrets = join(target, "secrets.env");
	if (existsSync(cfg)) throw new ConfigError(`${cfg} already exists; not overwriting`);
	writeFileSync(cfg, sampleConfig(o));
	if (!existsSync(secrets)) {
		writeFileSync(secrets, `# Gateway session token: paste into Vory (Session token mode)\nNHERMES_TOKEN=${randomBytes(24).toString("base64url")}\n# PUSHOVER_USER_KEY=\n# PUSHOVER_APP_TOKEN=\n`);
		chmodSync(secrets, 0o600);
	}
	process.stdout.write(`Wrote ${cfg} and ${secrets}\n`);
}

async function admin(configPath: string, method: string, path: string, body?: unknown): Promise<unknown> {
	const config = loadConfig(configPath);
	const host = config.server.host === "0.0.0.0" ? "127.0.0.1" : config.server.host;
	let res: Response;
	try {
		res = await fetch(`http://${host}:${config.server.port}${path}`, {
			method,
			headers: { "X-Hermes-Session-Token": config.token, "content-type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
	} catch {
		throw new ConfigError(`the gateway is not running on ${host}:${config.server.port}`);
	}
	const json = (await res.json()) as { detail?: string };
	if (!res.ok) throw new ConfigError(json.detail ?? `HTTP ${res.status}`);
	return json;
}

async function gatewayRunning(configPath: string): Promise<boolean> {
	const config = loadConfig(configPath);
	const host = config.server.host === "0.0.0.0" ? "127.0.0.1" : config.server.host;
	return fetch(`http://${host}:${config.server.port}/api/health`).then(
		() => true,
		() => false,
	);
}

/** Reads one line from the terminal without echoing it (falls back to a plain read when stdin is not a terminal). */
async function readHidden(prompt: string): Promise<string> {
	process.stdout.write(prompt);
	if (!process.stdin.isTTY) {
		const rl = createInterface({ input: process.stdin });
		const line = await new Promise<string>((resolve) => rl.once("line", resolve));
		rl.close();
		return line.trim();
	}
	return new Promise((resolve) => {
		let value = "";
		process.stdin.setRawMode(true);
		process.stdin.resume();
		const onData = (buf: Buffer) => {
			for (const ch of buf.toString("utf8")) {
				if (ch === "\r" || ch === "\n" || ch === "\u0004") {
					process.stdin.setRawMode(false);
					process.stdin.pause();
					process.stdin.off("data", onData);
					process.stdout.write("\n");
					return resolve(value.trim());
				}
				if (ch === "\u0003") process.exit(130);
				if (ch === "\u007f") value = value.slice(0, -1);
				else value += ch;
			}
		};
		process.stdin.on("data", onData);
	});
}

const print = (v: unknown): void => void process.stdout.write(`${JSON.stringify(v, null, 2)}\n`);

async function main(): Promise<void> {
	const { values, positionals } = parseArgs({
		allowPositionals: true,
		options: {
			config: { type: "string", short: "c" },
			help: { type: "boolean", short: "h" },
			out: { type: "string" },
			secrets: { type: "boolean" },
			"with-config": { type: "boolean" },
			url: { type: "string" },
			clear: { type: "boolean" },
			yes: { type: "boolean", short: "y" },
			name: { type: "string" },
			port: { type: "string" },
			"data-dir": { type: "string" },
		},
	});
	const [command, ...rest] = positionals;
	if (values.help || !command) {
		process.stdout.write(USAGE);
		return;
	}
	const configPath = values.config ?? process.env.NHERMES_CONFIG ?? "config.yaml";
	switch (command) {
		case "serve":
			return serve(configPath);
		case "init":
			return init(rest[0] ?? ".", { name: values.name, port: values.port ? Number(values.port) : undefined, dataDir: values["data-dir"] });
		case "status":
			return print(await admin(configPath, "GET", "/admin/status"));
		case "reload": {
			const r = (await admin(configPath, "POST", "/admin/reload")) as { added: string[]; removed: string[]; changed: string[]; restartNeeded: string[] };
			const groups: [string, string[]][] = [["added", r.added], ["removed", r.removed], ["changed", r.changed]];
			const parts = groups.filter(([, v]) => v.length > 0).map(([k, v]) => `${k}: ${v.join(", ")}`);
			process.stdout.write(`Reloaded${parts.length ? ` (${parts.join("; ")})` : ", no bot changes"}.\n`);
			if (r.restartNeeded.length > 0) process.stdout.write(`Needs a restart to take effect: ${r.restartNeeded.join(", ")}\n`);
			return;
		}
		case "backup":
			return print(await admin(configPath, "POST", "/admin/backup", { out: values.out ? resolve(values.out) : undefined, includeSecrets: values.secrets === true }));
		case "restore": {
			const file = rest[0];
			if (!file) throw new ConfigError("restore needs a backup file");
			if (await gatewayRunning(configPath)) throw new ConfigError("stop the gateway first (systemctl --user stop nhermes)");
			const config = loadConfig(configPath);
			const r = restoreBackup(resolve(file), config.dataDir, config.configDir, values["with-config"] === true);
			process.stdout.write(`Restored into ${config.dataDir}${r.previous ? `; the previous data is in ${r.previous}` : ""}. Start the gateway again.\n`);
			return;
		}
		case "invite": {
			const r = (await admin(configPath, "POST", "/admin/federation/invite", { url: values.url })) as { code: string; expiresAt: number };
			process.stdout.write(`On the machine that should join, run:\n\n  nhermes join ${r.code}\n\nThe code works once, until ${new Date(r.expiresAt * 1000).toLocaleTimeString()}.\n`);
			return;
		}
		case "join": {
			const code = rest[0];
			if (!code) throw new ConfigError("usage: nhermes join <code>");
			const p = (await admin(configPath, "POST", "/admin/federation/preview", { code })) as { name: string; url: string; members: number };
			let answer = "y";
			if (!values.yes) {
				const rl = createInterface({ input: process.stdin, output: process.stdout });
				answer = (await rl.question(`Join the network of "${p.name}" (${p.url}, ${p.members} member${p.members === 1 ? "" : "s"})? Its members will be able to use this machine's bots, and this machine theirs. [y/N] `)).trim().toLowerCase();
				rl.close();
			} else process.stdout.write(`Joining the network of "${p.name}" (${p.url}).\n`);
			if (answer !== "y" && answer !== "yes") return void process.stdout.write("Not joined.\n");
			const r = (await admin(configPath, "POST", "/admin/federation/join", { code })) as { members: string[] };
			return void process.stdout.write(`Joined. Members: ${r.members.join(", ")}\n`);
		}
		case "members": {
			if (rest[0] === "remove") {
				if (!rest[1]) throw new ConfigError("usage: nhermes members remove <name>");
				await admin(configPath, "DELETE", `/admin/members/${encodeURIComponent(rest[1])}`);
				return void process.stdout.write(`Removed ${rest[1]} from the network.\n`);
			}
			const r = (await admin(configPath, "GET", "/admin/members")) as { self: { name: string; url: string }; members: { name: string; url: string; reachable: boolean; last_error: string | null }[] };
			process.stdout.write(`${r.self.name} (this machine) ${r.self.url}\n`);
			for (const m of r.members) process.stdout.write(`${m.name} ${m.url} ${m.reachable ? "reachable" : `unreachable${m.last_error ? `: ${m.last_error}` : ""}`}\n`);
			if (r.members.length === 0) process.stdout.write("No other members. Add one with nhermes invite.\n");
			return;
		}
		case "secret": {
			const [sub, name] = rest;
			if (sub === "list" || !sub) {
				const r = (await admin(configPath, "GET", "/admin/secrets")) as { secrets: { name: string; set: boolean; source: string; usedBy: string[] }[] };
				for (const s of r.secrets) process.stdout.write(`${s.set ? "set  " : "unset"} ${s.name}${s.source === "environment" ? " (from the environment)" : ""}${s.usedBy.length ? `  · ${s.usedBy.join(", ")}` : ""}\n`);
				return;
			}
			if (!name) throw new ConfigError("usage: nhermes secret list | set <NAME> | rm <NAME>");
			if (sub === "rm") {
				const r = (await admin(configPath, "DELETE", `/admin/secrets/${encodeURIComponent(name)}`)) as { restartNeeded: boolean };
				return void process.stdout.write(`Removed ${name}.${r.restartNeeded ? " Restart the gateway for it to take effect." : ""}\n`);
			}
			if (sub !== "set") throw new ConfigError("usage: nhermes secret list | set <NAME> | rm <NAME>");
			const value = await readHidden(`Value for ${name} (not shown): `);
			const r = (await admin(configPath, "PUT", `/admin/secrets/${encodeURIComponent(name)}`, { value })) as { restartNeeded: boolean };
			return void process.stdout.write(`Set ${name}.${r.restartNeeded ? " Restart the gateway for it to take effect." : " In effect now."}\n`);
		}
		case "panel": {
			if (rest[0] !== "password") throw new ConfigError("usage: nhermes panel password [--clear]");
			if (values.clear) {
				await admin(configPath, "POST", "/admin/panel/password", { password: null });
				return void process.stdout.write("The panel no longer asks for a password.\n");
			}
			const rl = createInterface({ input: process.stdin, output: process.stdout });
			const password = await rl.question("New panel password (shown as you type): ");
			rl.close();
			await admin(configPath, "POST", "/admin/panel/password", { password });
			return void process.stdout.write("Panel password set; browsers sign in again.\n");
		}
		case "leave": {
			await admin(configPath, "POST", "/admin/federation/leave");
			return void process.stdout.write("Left the network.\n");
		}
		case "host": {
			const [sub, bot] = rest;
			if (sub !== "trust" || !bot) throw new ConfigError("usage: nhermes host trust <bot>");
			const scan = (await admin(configPath, "POST", `/admin/hosts/${bot}/scan`)) as { lines: string[]; fingerprints: string[] };
			process.stdout.write(`Host key fingerprints for ${bot}'s host:\n${scan.fingerprints.map((f) => `  ${f}`).join("\n")}\nCompare them with the host's own (ssh-keygen -lf /etc/ssh/ssh_host_*_key.pub on it).\n`);
			const rl = createInterface({ input: process.stdin, output: process.stdout });
			const answer = (await rl.question("Trust these keys? [y/N] ")).trim().toLowerCase();
			rl.close();
			if (answer !== "y" && answer !== "yes") return void process.stdout.write("Not trusted.\n");
			await admin(configPath, "POST", `/admin/hosts/${bot}/trust`, { lines: scan.lines });
			return void process.stdout.write("Trusted.\n");
		}
		case "memory": {
			const [bot, sub, ...words] = rest;
			if (!bot) throw new ConfigError("usage: nhermes memory <bot> [search text | add <text> | rm <id>]");
			if (sub === "add") return print(await admin(configPath, "POST", `/admin/memory/${bot}`, { text: words.join(" ") }));
			if (sub === "rm") return print(await admin(configPath, "DELETE", `/admin/memory/${bot}/${words[0]}`));
			const q = [sub, ...words].filter(Boolean).join(" ");
			const r = (await admin(configPath, "GET", `/admin/memory/${bot}${q ? `?q=${encodeURIComponent(q)}` : ""}`)) as { items: { id: number; owner: string; pinned: number; body: string }[] };
			for (const m of r.items) process.stdout.write(`#${m.id} ${m.owner}${m.pinned ? " pinned" : ""}: ${m.body}\n`);
			return;
		}
		default:
			process.stderr.write(`unknown command: ${command}\n\n${USAGE}`);
			process.exit(2);
	}
}

main().catch((error) => {
	if (error instanceof ConfigError) {
		process.stderr.write(`config error: ${error.message}\n`);
		process.exit(2);
	}
	process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
	process.exit(1);
});
