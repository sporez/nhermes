// Calling another member's bot management API (/federation/manage/*, src/federation/manage.ts) from this
// gateway: the panel and the client API both use it. A member's 401 means it no longer knows this machine,
// which must not read as "sign in" to the caller, so it becomes a 502.
import type { Core } from "../app.ts";
import { HttpError } from "../http.ts";
import { FederationError } from "./members.ts";

export async function manageCall<T = Record<string, unknown>>(core: Core, node: string, method: string, path: string, body?: unknown, timeoutMs?: number): Promise<T> {
	const m = core.members.byName(node);
	if (!m) throw new HttpError(404, `no member named "${node}"`);
	try {
		return await core.members.call<T>(m, path, body, method, timeoutMs);
	} catch (error) {
		if (error instanceof FederationError && error.status === 401) throw new HttpError(502, `${node} no longer accepts this machine; join it to the network again`);
		throw error;
	}
}

/** A change on a member: its roster here is refreshed so names and descriptions follow. */
export async function manageWrite<T = Record<string, unknown>>(core: Core, node: string, method: string, path: string, body: unknown): Promise<T> {
	const r = await manageCall<T>(core, node, method, path, body);
	await core.roster.sync().catch(() => {});
	return r;
}
