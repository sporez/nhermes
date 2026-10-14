// nhermes: the gateway daemon and its small admin CLI.
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { adminRoutes, restoreBackup } from "./admin.ts";
import { createCore } from "./app.ts";
import { ConfigError, loadConfig } from "./config.ts";
import { startHermesServer } from "./hermes/server.ts";
import { logger } from "./log.ts";

const log = logger("cli");

const USAGE = `nhermes <command> [options]

Commands:
  serve                       Run the gateway (one process owns the data directory)
  init [dir]                  Write a starter config.yaml and secrets.env into dir (default: .)
  status                      Bots, running sessions and scheduled jobs of the running gateway
  backup [--out f] [--secrets]  Consistent backup (.tar.gz) made by the running gateway
  restore <file> [--with-config]  Restore a backup; the gateway must be stopped
  host trust <bot>            Show a bot's SSH host key fingerprints and trust them after you confirm
  memory <bot> [search text]  List or search a bot's memories
  memory <bot> add <text>     Save a memory for a bot (source: owner)
  memory <bot> rm <id>        Forget a memory

Options:
  -c, --config <path>   Config file (default: $NHERMES_CONFIG or ./config.yaml)
  -h, --help            Show this help
`;

const SAMPLE_CONFIG = `# Neil Hermes configuration. Secrets go in secrets.env, not here.
server:
  host: 127.0.0.1        # use 0.0.0.0 (or the Tailscale address) to reach it from Vory
  port: 9119
  name: Neil Hermes
dataDir: data
timezone: America/New_York

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
      You are Neil's personal assistant, running on his own server.
      Be direct and concise. Use tools to check facts instead of guessing.
`;

async function serve(configPath: string): Promise<void> {
	const config = loadConfig(configPath);
	mkdirSync(config.dataDir, { recursive: true });
	const core = await createCore(config);
	const server = await startHermesServer(core, { host: config.server.host, port: config.server.port, extraRouters: [adminRoutes(core)] });
	await core.scheduler.start();
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
	process.on("SIGTERM", () => void stop("SIGTERM"));
	process.on("SIGINT", () => void stop("SIGINT"));
}

function init(dir: string): void {
	const target = resolve(dir);
	mkdirSync(target, { recursive: true });
	const cfg = join(target, "config.yaml");
	const secrets = join(target, "secrets.env");
	if (existsSync(cfg)) throw new ConfigError(`${cfg} already exists; not overwriting`);
	writeFileSync(cfg, SAMPLE_CONFIG);
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
			return init(rest[0] ?? ".");
		case "status":
			return print(await admin(configPath, "GET", "/admin/status"));
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
