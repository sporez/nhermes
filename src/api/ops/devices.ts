// The owner's devices for push notifications (docs/API.md "Push notifications"): the app registers its APNs
// device token on every connection, and lists, removes and tests devices. Owner only. Notifications go out
// only when the gateway has an APNs key (feature `push.apns` in the hello).
import type { DeviceRow } from "../../notify/devices.ts";
import { ApiError } from "../errors.ts";
import type { Op } from "../ops.ts";

const ms = (s: number | null) => (s ? Math.round(s * 1000) : null);

function deviceJson(d: DeviceRow) {
	return {
		id: d.id,
		platform: d.platform,
		environment: d.environment,
		bundleId: d.bundle_id,
		name: d.name,
		tokenEnd: d.token.slice(-6),
		createdAt: ms(d.created_at),
		lastSeenAt: ms(d.last_seen),
		lastError: d.last_error,
	};
}

export const deviceOps: Op[] = [
	{
		name: "devices.register",
		http: "POST /devices",
		handle: (p, cx) => {
			const platform = p.optEnum("platform", ["ios", "macos"] as const);
			const environment = p.optEnum("environment", ["development", "production"] as const);
			if (!platform || !environment) throw new ApiError("invalid_params", "platform (ios, macos) and environment (development, production) are required.");
			const device = cx.core.devices.register({ token: p.str("token"), platform, environment, bundleId: p.str("bundleId"), name: p.optStr("name") });
			return { device: deviceJson(device), pushEnabled: cx.core.apns.configured() };
		},
	},
	{ name: "devices.list", http: "GET /devices", handle: (_p, cx) => ({ items: cx.core.devices.list().map(deviceJson), nextCursor: null, pushEnabled: cx.core.apns.configured() }) },
	{
		name: "devices.delete",
		http: "DELETE /devices/:id",
		handle: (p, cx) => {
			if (!cx.core.devices.remove(p.str("id"))) throw new ApiError("not_found", "No device with that id.");
			return { deleted: true };
		},
	},
	{
		name: "devices.test",
		http: "POST /devices/:id/test",
		handle: async (p, cx) => {
			const d = cx.core.devices.get(p.str("id"));
			if (!d) throw new ApiError("not_found", "No device with that id.");
			if (!cx.core.apns.configured()) throw new ApiError("not_available", "This gateway has no APNs key yet: see push.apns in docs/OPERATIONS.md.");
			return cx.core.apns.deliver(d, { kind: "test", title: "nHermes", body: "Test notification from your gateway." });
		},
	},
];
