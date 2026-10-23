// The owner's devices that get push notifications (APNs, src/notify/apns.ts): registered by the app with its
// device token, one row per token. A device registers again on every connection (a token can change); Apple
// telling us a token is gone removes it. Tokens are never listed back whole.
import { randomBytes } from "node:crypto";
import type { AppDb } from "../store/db.ts";

export type DevicePlatform = "ios" | "macos";
/** Which APNs servers the token belongs to: a development build's tokens work only with the sandbox. */
export type ApnsEnvironment = "development" | "production";

export type DeviceRow = {
	id: string;
	token: string;
	platform: DevicePlatform;
	environment: ApnsEnvironment;
	bundle_id: string;
	name: string;
	created_at: number;
	last_seen: number;
	last_error: string | null;
};

export type DeviceInput = { token: string; platform: DevicePlatform; environment: ApnsEnvironment; bundleId: string; name?: string };

export class DeviceError extends Error {
	override name = "DeviceError";
}

const TOKEN = /^[0-9a-f]{32,200}$/;
const BUNDLE = /^[A-Za-z0-9.-]{1,155}$/;

export class Devices {
	private readonly db: AppDb;

	constructor(db: AppDb) {
		this.db = db;
	}

	list(): DeviceRow[] {
		return this.db.all<DeviceRow>("SELECT * FROM devices ORDER BY last_seen DESC");
	}

	get(id: string): DeviceRow | undefined {
		return this.db.get<DeviceRow>("SELECT * FROM devices WHERE id = ?", id);
	}

	/** Registers a device, or refreshes the one with this token (its id stays). */
	register(d: DeviceInput): DeviceRow {
		const token = d.token.toLowerCase();
		if (!TOKEN.test(token)) throw new DeviceError("The device token must be the hex string the system gave the app.");
		if (!BUNDLE.test(d.bundleId)) throw new DeviceError("bundleId is not a bundle identifier.");
		const name = (d.name ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 80);
		const now = Date.now() / 1000;
		const existing = this.db.get<DeviceRow>("SELECT * FROM devices WHERE token = ?", token);
		if (existing) {
			this.db.run("UPDATE devices SET platform = ?, environment = ?, bundle_id = ?, name = ?, last_seen = ?, last_error = NULL WHERE id = ?", d.platform, d.environment, d.bundleId, name || existing.name, now, existing.id);
			return this.get(existing.id)!;
		}
		const id = `d${randomBytes(8).toString("hex")}`;
		this.db.run("INSERT INTO devices (id, token, platform, environment, bundle_id, name, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", id, token, d.platform, d.environment, d.bundleId, name, now, now);
		return this.get(id)!;
	}

	remove(id: string): boolean {
		return this.db.run("DELETE FROM devices WHERE id = ?", id).changes > 0;
	}

	failed(id: string, error: string): void {
		this.db.run("UPDATE devices SET last_error = ? WHERE id = ?", error.slice(0, 300), id);
	}

	delivered(id: string): void {
		this.db.run("UPDATE devices SET last_error = NULL WHERE id = ? AND last_error IS NOT NULL", id);
	}
}
