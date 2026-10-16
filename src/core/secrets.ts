// The gateway's secrets (API keys, tokens): the variables in secrets.env, managed without ever handing
// a value back. A change is written to the file (comments and order kept, mode 0600, replaced
// atomically) and applied at once: the process environment, log redaction, and the list of names kept
// out of bot shells. The few read only at startup say so.
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { Config } from "../config.ts";
import { secretEnvNames } from "../config.ts";
import { logger, registerSecret } from "../log.ts";
import type { AppDb } from "../store/db.ts";

const log = logger("secrets");

export const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/** Names set through this module in this process (so they are not mistaken for the service's own environment). */
const setHere = new Set<string>();

export class SecretError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

export type SecretInfo = {
	name: string;
	description: string;
	/** Where it is used (bots, providers, features). */
	usedBy: string[];
	set: boolean;
	/** "file": in secrets.env (editable); "environment": set by the process environment (read-only here). */
	source: "file" | "environment" | "unset";
	/** A change applies only after a restart. */
	restartOnly: boolean;
	updatedAt: number | null;
};

type Line = { raw: string; name?: string };

function parseFile(text: string): Line[] {
	return text.split(/\r?\n/).map((raw) => {
		const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(raw);
		return m && !raw.trimStart().startsWith("#") ? { raw, name: m[1] } : { raw };
	});
}

function fileValue(raw: string): string {
	let value = raw.slice(raw.indexOf("=") + 1).trim();
	if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.endsWith(value[0]!)) value = value.slice(1, -1);
	return value;
}

/** A value as the loader reads it back: quoted when it has spaces, quotes or a #. */
function encode(value: string): string {
	return /[\s"'#]/.test(value) ? `"${value}"` : value;
}

/** A key a provider catalog reads (src/models/catalogs.ts). */
export type ProviderKey = { name: string; provider: string; providerName: string };

export class Secrets {
	private readonly config: Config;
	private readonly db: AppDb;
	private readonly providerKeys: ProviderKey[];
	private readonly listeners: ((name: string) => void)[] = [];

	constructor(config: Config, db: AppDb, providerKeys: ProviderKey[] = []) {
		this.config = config;
		this.db = db;
		this.providerKeys = providerKeys;
	}

	/** Called with the name after a key is set or removed. */
	onChange(listener: (name: string) => void): void {
		this.listeners.push(listener);
	}

	private changed(name: string): void {
		for (const l of this.listeners) {
			try {
				l(name);
			} catch (error) {
				log.warn("secret change listener failed", { name, error: error instanceof Error ? error.message : String(error) });
			}
		}
	}

	private read(): Line[] {
		return existsSync(this.config.secretsPath) ? parseFile(readFileSync(this.config.secretsPath, "utf8")) : [];
	}

	private inFile(): Map<string, string> {
		const out = new Map<string, string>();
		for (const l of this.read()) if (l.name) out.set(l.name, fileValue(l.raw));
		return out;
	}

	/** Names the gateway knows about, with what each is for. */
	private catalogue(): Map<string, { description: string; usedBy: Set<string>; restartOnly: boolean }> {
		const c = this.config;
		const out = new Map<string, { description: string; usedBy: Set<string>; restartOnly: boolean }>();
		const add = (name: string, description: string, usedBy: string, restartOnly = false) => {
			const e = out.get(name) ?? { description, usedBy: new Set<string>(), restartOnly };
			e.usedBy.add(usedBy);
			out.set(name, e);
		};
		add(c.tokenEnv, "Gateway session token: Vory and the nhermes command use it", "gateway", true);
		add("PUSHOVER_USER_KEY", "Pushover user key (notifications)", "notifications", true);
		add("PUSHOVER_APP_TOKEN", "Pushover application token (notifications)", "notifications", true);
		add(c.review.keyEnv, "OpenRouter API key: Jev permission review", "permission review");
		// Setting one of these is all a catalog provider needs: its models are fetched and offered.
		for (const k of this.providerKeys) add(k.name, `API key for the ${k.providerName} models (its model list is fetched automatically)`, `models: ${k.provider}`);
		try {
			const models = readFileSync(c.pi.modelsPath, "utf8");
			const doc = JSON.parse(models) as { providers?: Record<string, unknown> };
			for (const [provider, def] of Object.entries(doc.providers ?? {})) {
				for (const m of JSON.stringify(def).matchAll(/"\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?"/g)) add(m[1]!, `API key for the ${provider} models`, `models: ${provider}`);
			}
		} catch {
			// No models.json, or not JSON: no provider keys to list.
		}
		for (const b of c.bots) {
			for (const n of b.secrets ?? []) add(n, "A key the bot may use in web requests ({{secret:NAME}})", `bot ${b.name}`);
			if (b.peer?.tokenEnv) add(b.peer.tokenEnv, "Token of a gateway listed by hand as a peer", `bot ${b.name}`);
		}
		return out;
	}

	list(): SecretInfo[] {
		const file = this.inFile();
		const cat = this.catalogue();
		const names = [...new Set([...cat.keys(), ...file.keys()])].sort();
		return names.map((name) => {
			const known = cat.get(name);
			const env = process.env[name];
			const source: SecretInfo["source"] = file.has(name) && (env === undefined || env === file.get(name)) ? "file" : env !== undefined && env !== "" ? "environment" : "unset";
			return {
				name,
				description: known?.description ?? "Not used by anything this gateway knows of",
				usedBy: [...(known?.usedBy ?? [])],
				set: source !== "unset",
				source,
				restartOnly: known?.restartOnly ?? false,
				updatedAt: this.updatedAt(name),
			};
		});
	}

	/** The last four characters, to tell keys apart. */
	hint(name: string): string {
		const v = process.env[name];
		if (!v) throw new SecretError(404, `${name} is not set`);
		return v.length > 8 ? `…${v.slice(-4)}` : "(short value)";
	}

	set(name: string, value: string): { restartNeeded: boolean } {
		if (!SECRET_NAME.test(name)) throw new SecretError(400, "use letters, digits and _ (starting with a letter or _)");
		if (!value || /[\r\n]/.test(value)) throw new SecretError(400, "the value must be one non-empty line");
		if (/^\s|\s$/.test(value)) throw new SecretError(400, "the value starts or ends with a space; paste it again");
		const info = this.list().find((s) => s.name === name);
		// A variable the service's own environment sets wins over secrets.env at every start; changing the file would not stick.
		const env = process.env[name];
		if (env !== undefined && env !== this.inFile().get(name) && !setHere.has(name)) throw new SecretError(409, `${name} is set by the service's environment, not secrets.env; change it there`);
		if (name === this.config.tokenEnv && value.length < 16) throw new SecretError(400, "the gateway token needs at least 16 characters");
		const lines = this.read();
		const line = `${name}=${encode(value)}`;
		const i = lines.findIndex((l) => l.name === name);
		if (i >= 0) lines[i] = { raw: line, name };
		else {
			while (lines.length > 0 && lines.at(-1)!.raw === "") lines.pop();
			lines.push({ raw: line, name }, { raw: "" });
		}
		this.write(lines);
		process.env[name] = value;
		setHere.add(name);
		secretEnvNames.add(name);
		registerSecret(value);
		this.touch(name);
		log.info("secret set", { name });
		this.changed(name);
		return { restartNeeded: info?.restartOnly ?? false };
	}

	remove(name: string): { restartNeeded: boolean } {
		if (name === this.config.tokenEnv) throw new SecretError(400, "the gateway token cannot be removed; generate a new one instead");
		const info = this.list().find((s) => s.name === name);
		if (!info || info.source === "unset") throw new SecretError(404, `${name} is not set`);
		if (info.source === "environment") throw new SecretError(409, `${name} is set by the service's environment, not secrets.env`);
		this.write(this.read().filter((l) => l.name !== name));
		delete process.env[name];
		this.touch(name);
		log.info("secret removed", { name });
		this.changed(name);
		return { restartNeeded: info.restartOnly };
	}

	/** A new gateway token, returned once. Vory and the CLI need it; the running gateway keeps the old one until restart. */
	newToken(): { name: string; value: string } {
		const value = randomBytes(24).toString("base64url");
		this.set(this.config.tokenEnv, value);
		return { name: this.config.tokenEnv, value };
	}

	private write(lines: Line[]): void {
		const path = this.config.secretsPath;
		const tmp = `${path}.${process.pid}.tmp`;
		writeFileSync(tmp, lines.map((l) => l.raw).join("\n"), { mode: 0o600 });
		chmodSync(tmp, 0o600);
		renameSync(tmp, path);
	}

	private touch(name: string): void {
		this.db.run("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", `secret.updated.${name}`, String(Date.now() / 1000));
	}

	private updatedAt(name: string): number | null {
		const v = this.db.get<{ value: string }>("SELECT value FROM settings WHERE key = ?", `secret.updated.${name}`)?.value;
		return v ? Number(v) : null;
	}
}
