// nhermes: the gateway daemon and its small admin CLI.
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createCore } from "./app.ts";
import { ConfigError, loadConfig } from "./config.ts";
import { startHermesServer } from "./hermes/server.ts";
import { logger } from "./log.ts";

const log = logger("cli");

const USAGE = `nhermes <command> [options]

Commands:
  serve                 Run the gateway (one process owns the data directory)
  init [dir]            Write a starter config.yaml and secrets.env into dir (default: .)

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
	const server = await startHermesServer(core, { host: config.server.host, port: config.server.port });
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

async function main(): Promise<void> {
	const { values, positionals } = parseArgs({
		allowPositionals: true,
		options: { config: { type: "string", short: "c" }, help: { type: "boolean", short: "h" } },
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
