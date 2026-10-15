// Federation HTTP API. `/federation/hello` and `/federation/join` are open (a join proves itself with the
// invite secret); every other `/federation/*` route needs a member's node id and pair secret, checked by
// the server before the handler runs (`req.member`). The owner's side lives under `/admin/` (token).
import type { Core } from "../app.ts";
import { HttpError, obj, type Req, Router } from "../hermes/http.ts";
import { SecretError } from "../core/secrets.ts";
import { logger } from "../log.ts";
import { FederationError, type MemberRow } from "./members.ts";

const log = logger("federation");
import { publish } from "./roster.ts";

export const OPEN_FEDERATION_PATHS = new Set(["/federation/hello", "/federation/join"]);

function member(q: Req): MemberRow {
	if (!q.member) throw new HttpError(401, "Unauthorized");
	return q.member;
}

/** Turns membership errors into HTTP answers. */
export async function federationCall<T>(fn: () => T | Promise<T>): Promise<T> {
	try {
		return await fn();
	} catch (error) {
		if (error instanceof FederationError) throw new HttpError(error.status, error.message);
		throw error;
	}
}

export function federationRoutes(core: Core): Router {
	const r = new Router();
	const m = core.members;
	r.on("GET", "/federation/hello", () => m.hello());
	r.on("POST", "/federation/join", (q) => federationCall(() => m.acceptJoin(obj(q.body))));
	r.on("GET", "/federation/ping", (q) => ({ name: m.self().name, from: member(q).name }));
	r.on("GET", "/federation/roster", (q) => (member(q), publish(core.bots.list())));
	r.on("POST", "/federation/introduce", (q) => federationCall(() => (m.introduce(member(q), obj(q.body)), { ok: true })));
	r.on("POST", "/federation/forget", (q) => federationCall(() => (m.forget(member(q), obj(q.body)), { ok: true })));
	r.on("POST", "/federation/removed", (q) => (m.removed(member(q)), { ok: true }));
	// Another member sets a key here (only when this gateway's owner allowed it).
	r.on("POST", "/federation/secrets", (q) => {
		const from = member(q);
		const b = obj(q.body);
		if (!m.acceptsSecrets()) throw new HttpError(403, `${m.self().name} does not accept keys from other machines; turn that on in its panel (Network)`);
		const name = String(b.name ?? "");
		if (name === core.config.tokenEnv) throw new HttpError(400, "each machine keeps its own gateway token");
		try {
			const r = core.secrets.set(name, String(b.value ?? ""));
			log.info("key set by a member", { name, by: from.name });
			return r;
		} catch (error) {
			if (error instanceof SecretError) throw new HttpError(error.status, error.message);
			throw error;
		}
	});
	return r;
}

export function federationAdminRoutes(core: Core): Router {
	const r = new Router();
	const m = core.members;
	r.on("GET", "/admin/members", () => ({ self: m.self(), members: m.list() }));
	r.on("POST", "/admin/federation/invite", (q) => {
		const url = obj(q.body).url;
		return federationCall(() => m.invite({ url: typeof url === "string" && url ? url : undefined }));
	});
	r.on("POST", "/admin/federation/preview", (q) => federationCall(() => m.preview(String(obj(q.body).code ?? ""))));
	r.on("POST", "/admin/federation/join", (q) => federationCall(async () => ({ members: await m.join(String(obj(q.body).code ?? "")) })));
	r.on("POST", "/admin/federation/leave", () => federationCall(async () => (await m.leave(), { ok: true })));
	r.on("DELETE", "/admin/members/:name", (q) => federationCall(async () => (await m.remove(q.params.name!), { ok: true })));
	return r;
}
