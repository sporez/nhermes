// Mode A remote execution: a bot with `host.ssh` runs its file and shell tools on that machine through
// pi-env's daemon over SSH. Conversations, credentials and state stay on the gateway. Host keys are
// pinned in the gateway's own known_hosts file and must be accepted once (`nhermes host trust <bot>`).
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { acceptHostKey, type Connection, RemoteExecutionEnv, scanHostKey, type SshConnectOptions, sshConnection } from "@earendil-works/pi-env";
import { defineExtension, type Extension, hook, ToolTask } from "@earendil-works/pi-durable";
import type { Bot } from "../core/bots.ts";
import { logger } from "../log.ts";

const log = logger("hosts");

type Entry = { connection: Connection; env?: RemoteExecutionEnv; envPromise?: Promise<RemoteExecutionEnv> };

export class HostEnvs {
	private readonly entries = new Map<string, Entry>();
	private readonly knownHostsFile: string;
	private readonly connect: (bot: Bot, target: SshConnectOptions) => Connection;

	/** `connect` replaces SSH (tests use a local daemon). */
	constructor(dataDir: string, connect?: (bot: Bot, target: SshConnectOptions) => Connection) {
		const dir = join(dataDir, "ssh");
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		this.knownHostsFile = join(dir, "known_hosts");
		this.connect = connect ?? ((_bot, target) => sshConnection({ ...target, onLog: (t) => log.debug("pi-env", { text: t.slice(0, 500) }) }).connection);
	}

	static isRemote(bot: Bot): boolean {
		return bot.config.host?.ssh !== undefined;
	}

	target(bot: Bot): SshConnectOptions {
		const ssh = bot.config.host?.ssh;
		if (!ssh) throw new Error(`bot ${bot.name} has no host`);
		return {
			host: ssh.host,
			user: ssh.user,
			port: ssh.port,
			identityFile: ssh.identityFile,
			knownHostsFile: this.knownHostsFile,
			hostKeyAlias: `nhermes-${bot.name}`,
		};
	}

	/** The bot's environment on its host; connects lazily (the first tool call detects, deploys and starts). */
	async env(bot: Bot): Promise<RemoteExecutionEnv> {
		let entry = this.entries.get(bot.name);
		if (!entry) {
			entry = { connection: this.connect(bot, this.target(bot)) };
			this.entries.set(bot.name, entry);
		}
		if (entry.env) return entry.env;
		const e = entry;
		e.envPromise ??= (async () => {
			const cwd = bot.config.host?.ssh.cwd ?? (await e.connection.info()).home;
			const env = new RemoteExecutionEnv({ connection: e.connection, id: `nhermes:${bot.name}`, cwd });
			e.env = env;
			return env;
		})().finally(() => {
			e.envPromise = undefined;
		});
		return e.envPromise;
	}

	/** Shows the host's key fingerprints; the owner compares them out of band before `trust`. */
	async scan(bot: Bot): Promise<{ lines: string[]; fingerprints: string[] }> {
		return scanHostKey(this.target(bot));
	}

	async trust(bot: Bot, lines: readonly string[]): Promise<void> {
		await acceptHostKey(this.target(bot), lines);
	}

	/** Drop a bot's connection (config change, or after the host went away). */
	reset(botName: string): void {
		const e = this.entries.get(botName);
		this.entries.delete(botName);
		e?.connection.close();
	}

	close(): void {
		for (const e of this.entries.values()) e.connection.close();
		this.entries.clear();
	}
}

/**
 * Explains a lost host connection to the model. The call is not retried automatically: the command may
 * have started before the connection dropped, so only the model (with the owner) can decide to re-run it.
 * The next call reconnects (pi-env restarts the daemon over SSH).
 */
export function hostsExtension(botOf: (conversationId: number) => Bot | undefined): Extension {
	return defineExtension({
		name: "hosts",
		hooks: [
			hook(ToolTask, {
				afterTool: (call, result, api) => {
					const lost = (result.diagnostics ?? []).some((d) => /connection lost|spawn_error/i.test(d.message));
					if (!result.isError || !lost) return undefined;
					const bot = botOf(api.conversationId as number);
					const host = bot?.config.host?.ssh.host ?? "the host";
					const text =
						`The connection to ${host} was lost while running ${call.name} (the host may have restarted or the network dropped). ` +
						"The command may or may not have run. Check the host's state before running it again; the next tool call reconnects.";
					return { ...result, output: [{ type: "text", text }] };
				},
			}),
		],
	});
}
