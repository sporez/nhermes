// The panel's optional password. Off by default (the owner's LAN is trusted); when set, a login page
// guards the panel and a signed, HttpOnly cookie keeps the browser signed in for 30 days. The password
// is stored as a scrypt hash in app.sqlite, never in config.yaml.
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { AppDb } from "../store/db.ts";

export const COOKIE = "nh_panel";
const SESSION_S = 30 * 24 * 3600;

export class PanelAuth {
	private readonly db: AppDb;

	constructor(db: AppDb) {
		this.db = db;
	}

	private get(key: string): string | undefined {
		return this.db.get<{ value: string }>("SELECT value FROM settings WHERE key = ?", key)?.value;
	}

	private set(key: string, value: string | undefined): void {
		if (value === undefined) this.db.run("DELETE FROM settings WHERE key = ?", key);
		else this.db.run("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
	}

	get passwordSet(): boolean {
		return this.get("panel.password") !== undefined;
	}

	/** Sets the password, or clears it with null. Changing it signs every browser out. */
	setPassword(password: string | null): void {
		if (password === null) this.set("panel.password", undefined);
		else {
			if (password.length < 6) throw new Error("the panel password needs at least 6 characters");
			const salt = randomBytes(16);
			this.set("panel.password", `${salt.toString("hex")}:${scryptSync(password, salt, 32).toString("hex")}`);
		}
		this.set("panel.cookieKey", randomBytes(32).toString("hex"));
	}

	checkPassword(password: string): boolean {
		const stored = this.get("panel.password");
		if (!stored) return true;
		const [salt, hash] = stored.split(":");
		const given = scryptSync(password, Buffer.from(salt!, "hex"), 32);
		return timingSafeEqual(given, Buffer.from(hash!, "hex"));
	}

	private key(): string {
		let k = this.get("panel.cookieKey");
		if (!k) {
			k = randomBytes(32).toString("hex");
			this.set("panel.cookieKey", k);
		}
		return k;
	}

	/** A cookie value good for 30 days. */
	issue(now = Date.now()): string {
		const exp = Math.floor(now / 1000) + SESSION_S;
		return `${exp}.${createHmac("sha256", this.key()).update(String(exp)).digest("hex")}`;
	}

	/** Whether a request may use the panel: always when there is no password, else with a valid cookie. */
	allowed(cookieHeader: string | undefined, now = Date.now()): boolean {
		if (!this.passwordSet) return true;
		const value = (cookieHeader ?? "")
			.split(";")
			.map((c) => c.trim())
			.find((c) => c.startsWith(`${COOKIE}=`))
			?.slice(COOKIE.length + 1);
		if (!value) return false;
		const [exp, mac] = value.split(".");
		if (!exp || !mac || Number(exp) < now / 1000) return false;
		const want = createHmac("sha256", this.key()).update(exp).digest("hex");
		return mac.length === want.length && timingSafeEqual(Buffer.from(mac), Buffer.from(want));
	}

	static cookie(value: string): string {
		return `${COOKIE}=${value}; Path=/panel; HttpOnly; SameSite=Strict; Max-Age=${SESSION_S}`;
	}

	static clearCookie(): string {
		return `${COOKIE}=; Path=/panel; HttpOnly; SameSite=Strict; Max-Age=0`;
	}
}
