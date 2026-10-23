// Signing this machine in to model providers from another member's panel or CLI. Only when this gateway's
// owner allowed it (Network: "Let other machines sign this machine in to model providers"). The login runs
// here, through core/logins.ts: only the flow's codes, links and prompts travel; the credential is saved by
// this machine's own Pi store and never sent back. Also the forwarding the panel and the admin API use to
// reach a member's routes.
import type { Core } from "../app.ts";
import { LoginError } from "../core/logins.ts";
import { HttpError, obj, type Req, Router } from "../http.ts";
import { logger } from "../log.ts";
import { FederationError, type MemberRow } from "./members.ts";

const log = logger("logins");

/** Turns login errors into HTTP answers (an async result is mapped on rejection). */
export function loginCall<T>(fn: () => T): T {
	const map = (error: unknown): never => {
		if (error instanceof LoginError) throw new HttpError(error.status, error.message);
		throw error;
	};
	try {
		const r = fn();
		return r instanceof Promise ? (r.catch(map) as T) : r;
	} catch (error) {
		return map(error);
	}
}

export function loginRoutes(core: Core): Router {
	const r = new Router();
	const allowed = (q: Req): MemberRow => {
		if (!q.member) throw new HttpError(401, "Unauthorized");
		if (!core.members.acceptsLogins()) throw new HttpError(403, `${core.members.self().name} doesn't let other machines sign it in; turn on "Let other machines sign this machine in to model providers" in its Network tab`);
		return q.member;
	};
	r.on("GET", "/federation/logins", async (q) => (allowed(q), { providers: await core.logins.list() }));
	r.on("POST", "/federation/logins", (q) => {
		const from = allowed(q);
		const provider = obj(q.body).provider;
		if (typeof provider !== "string" || !provider) throw new HttpError(400, "provider required");
		return loginCall(() => core.logins.start(provider, `member:${from.name}`));
	});
	r.on("DELETE", "/federation/logins/providers/:provider", (q) => {
		const from = allowed(q);
		return loginCall(() => core.logins.logout(q.params.provider!, `member:${from.name}`));
	});
	r.on("GET", "/federation/logins/:id", (q) => (allowed(q), loginCall(() => core.logins.get(q.params.id!))));
	r.on("POST", "/federation/logins/:id/answer", (q) => {
		allowed(q);
		const value = obj(q.body).value;
		if (typeof value !== "string") throw new HttpError(400, "value required");
		return loginCall(() => core.logins.answer(q.params.id!, value));
	});
	r.on("DELETE", "/federation/logins/:id", (q) => {
		const from = allowed(q);
		log.info("login cancelled by a member", { id: q.params.id, by: from.name });
		return loginCall(() => core.logins.cancel(q.params.id!, `member:${from.name}`));
	});
	return r;
}

/** Calls a member's /federation/logins… route. Its answers (including a 403 with its message) pass through; an unreachable member is a 502. */
export async function memberLogins(core: Core, node: string, method: string, sub: string, body?: unknown): Promise<Record<string, unknown>> {
	const m = core.members.byName(node);
	if (!m) throw new HttpError(404, `no member named "${node}"`);
	try {
		return await core.members.call<Record<string, unknown>>(m, `/federation/logins${sub}`, body, method, 10_000);
	} catch (error) {
		if (error instanceof FederationError) {
			if (error.status === 401) throw new HttpError(502, `${node} no longer accepts this machine; join it to the network again`);
			throw new HttpError(error.status, error.message);
		}
		throw error;
	}
}

/** The remote routes under a prefix: /panel/api/remote/:node/logins… and /admin/remote/:node/logins… */
export function remoteLoginRoutes(core: Core, r: Router, prefix: string): void {
	const to = (q: Req, method: string, sub: string, body?: unknown) => memberLogins(core, q.params.node!, method, sub, body);
	const id = (q: Req) => encodeURIComponent(q.params.id!);
	r.on("GET", `${prefix}/:node/logins`, (q) => to(q, "GET", ""));
	r.on("POST", `${prefix}/:node/logins`, (q) => to(q, "POST", "", { provider: obj(q.body).provider }));
	r.on("DELETE", `${prefix}/:node/logins/providers/:provider`, (q) => to(q, "DELETE", `/providers/${encodeURIComponent(q.params.provider!)}`));
	r.on("GET", `${prefix}/:node/logins/:id`, (q) => to(q, "GET", `/${id(q)}`));
	r.on("POST", `${prefix}/:node/logins/:id/answer`, (q) => to(q, "POST", `/${id(q)}/answer`, { value: obj(q.body).value }));
	r.on("DELETE", `${prefix}/:node/logins/:id`, (q) => to(q, "DELETE", `/${id(q)}`));
}
