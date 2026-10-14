// Federation membership. Every gateway is an equal member of one network; each pair of members shares a
// secret the software generates at join time, so the owner never handles keys. Joining any member joins
// the network: the member that accepts the join introduces the newcomer to every other member over the
// links it already has. Messages a member could not deliver (the other side was offline) wait in
// member_outbox and are retried.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { hostname, networkInterfaces } from "node:os";
import { type Config, NODE_NAME } from "../config.ts";
import { logger, registerSecret } from "../log.ts";
import type { AppDb } from "../store/db.ts";

const log = logger("members");

export const NODE_HEADER = "x-nhermes-node";
export const SECRET_HEADER = "x-nhermes-member-secret";
const INVITE_TTL_MS = 10 * 60_000;

export type MemberRow = {
	node_id: string;
	name: string;
	url: string;
	secret: string;
	joined_at: number;
	last_seen: number | null;
	last_error: string | null;
};

/** A member as shown to the owner (no secret). */
export type MemberView = Omit<MemberRow, "secret"> & { reachable: boolean };

export type Self = { id: string; name: string; url: string };

/** What a member is told about another member when it is introduced. */
type Introduction = { node_id: string; name: string; url: string; secret: string };

export class FederationError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

function secretNow(): string {
	return randomBytes(24).toString("base64url");
}

function hash(s: string): string {
	return createHash("sha256").update(s).digest("hex");
}

function same(a: string, b: string): boolean {
	const x = Buffer.from(a);
	const y = Buffer.from(b);
	return x.length === y.length && timingSafeEqual(x, y);
}

/** The host name as a node name: "Neils-MacBook-Pro.local" → "neils-macbook-pro". */
export function defaultNodeName(): string {
	const n = hostname().split(".")[0]!.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 31);
	return NODE_NAME.test(n) ? n : "gateway";
}

/** The address other machines most likely reach this one on: a private LAN address, else Tailscale's. */
export function lanAddress(): string {
	const all = Object.values(networkInterfaces()).flatMap((list) => list ?? []).filter((i) => i.family === "IPv4" && !i.internal).map((i) => i.address);
	const lan = all.find((a) => /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a));
	return lan ?? all.find((a) => a.startsWith("100.")) ?? all[0] ?? "127.0.0.1";
}

export type InviteCode = { url: string; secret: string };

export function encodeInvite(c: InviteCode): string {
	return `nh1.${Buffer.from(JSON.stringify({ u: c.url, s: c.secret })).toString("base64url")}`;
}

export function decodeInvite(code: string): InviteCode {
	const m = /^nh1\.([A-Za-z0-9_-]+)$/.exec(code.trim());
	try {
		const v = JSON.parse(Buffer.from(m![1]!, "base64url").toString("utf8")) as { u?: unknown; s?: unknown };
		if (typeof v.u !== "string" || typeof v.s !== "string") throw new Error();
		new URL(v.u);
		return { url: v.u.replace(/\/$/, ""), secret: v.s };
	} catch {
		throw new FederationError(400, "that is not a join code (it starts with nh1.)");
	}
}

export type MembersOptions = { fetch?: typeof fetch; now?: () => number };

export class Members {
	private readonly db: AppDb;
	private readonly config: Config;
	private readonly fetch: typeof fetch;
	private readonly now: () => number;
	private port = 0;
	private timer: ReturnType<typeof setInterval> | undefined;
	private flushing: Promise<void> | undefined;
	private changed: () => void = () => {};

	constructor(db: AppDb, config: Config, opts: MembersOptions = {}) {
		this.db = db;
		this.config = config;
		this.fetch = opts.fetch ?? fetch;
		this.now = opts.now ?? Date.now;
		for (const m of this.rows()) registerSecret(m.secret);
	}

	/** Called after the member list changes (the roster refreshes). */
	onChange(fn: () => void): void {
		this.changed = fn;
	}

	/** The port the gateway listens on (known once the server is up). */
	setListenPort(port: number): void {
		this.port = port;
	}

	self(): Self {
		let row = this.db.get<{ id: string; name: string }>("SELECT id, name FROM node");
		if (!row) {
			row = { id: randomUUID(), name: defaultNodeName() };
			this.db.run("INSERT INTO node (id, name, created_at) VALUES (?, ?, ?)", row.id, row.name, this.now() / 1000);
		}
		const name = this.config.node.name ?? row.name;
		return { id: row.id, name, url: this.config.node.url?.replace(/\/$/, "") ?? this.guessUrl() };
	}

	private guessUrl(): string {
		const h = this.config.server.host;
		const host = h === "0.0.0.0" || h === "::" ? lanAddress() : h;
		return `http://${host}:${this.port || this.config.server.port}`;
	}

	private rows(): MemberRow[] {
		return this.db.all<MemberRow>("SELECT * FROM members ORDER BY name");
	}

	list(): MemberView[] {
		return this.rows().map(({ secret: _s, ...m }) => ({ ...m, reachable: m.last_error === null && m.last_seen !== null }));
	}

	get(nodeId: string): MemberRow | undefined {
		return this.db.get<MemberRow>("SELECT * FROM members WHERE node_id = ?", nodeId);
	}

	byName(name: string): MemberRow | undefined {
		return this.db.get<MemberRow>("SELECT * FROM members WHERE name = ?", name);
	}

	/** The member a request comes from, when its node id and secret match. */
	verify(nodeId: string | undefined, secret: string | undefined): MemberRow | undefined {
		if (!nodeId || !secret) return undefined;
		const m = this.get(nodeId);
		if (!m || !same(m.secret, secret)) return undefined;
		this.db.run("UPDATE members SET last_seen = ?, last_error = NULL WHERE node_id = ?", this.now() / 1000, nodeId);
		return m;
	}

	/** A single-use join code, valid for ten minutes. */
	invite(opts: { url?: string; ttlMs?: number } = {}): { code: string; expiresAt: number } {
		const secret = secretNow();
		const expiresAt = (this.now() + (opts.ttlMs ?? INVITE_TTL_MS)) / 1000;
		this.db.run("DELETE FROM invites WHERE expires_at < ?", this.now() / 1000);
		this.db.run("INSERT INTO invites (secret_hash, expires_at) VALUES (?, ?)", hash(secret), expiresAt);
		return { code: encodeInvite({ url: opts.url?.replace(/\/$/, "") ?? this.self().url, secret }), expiresAt };
	}

	/** What a join code leads to, for the owner to confirm before joining. */
	async preview(code: string): Promise<{ name: string; url: string; members: number }> {
		const { url } = decodeInvite(code);
		const hello = await this.request<{ name: string; members: number }>(url, "GET", "/federation/hello");
		return { name: hello.name, url, members: hello.members };
	}

	/** Joins the network the code comes from. Returns the members this gateway now knows. */
	async join(code: string): Promise<string[]> {
		if (this.rows().length > 0) throw new FederationError(409, "this gateway is already in a network; leave it first (nhermes leave)");
		const { url, secret } = decodeInvite(code);
		const me = this.self();
		const r = await this.request<{ node: { node_id: string; name: string; url: string }; secret: string; members: Introduction[] }>(url, "POST", "/federation/join", {
			invite: secret,
			node_id: me.id,
			name: me.name,
			url: me.url,
		});
		this.db.tx(() => {
			this.insert({ ...r.node, url: r.node.url || url, secret: r.secret });
			for (const m of r.members) this.insert(m);
		});
		for (const m of this.rows()) this.seen(m.node_id);
		log.info("joined the network", { via: r.node.name, members: this.rows().map((m) => m.name) });
		this.changed();
		return this.rows().map((m) => m.name);
	}

	/** The inviting side of a join: checks the invite, adds the newcomer and introduces it to everyone. */
	acceptJoin(body: Record<string, unknown>): { node: { node_id: string; name: string; url: string }; secret: string; members: Introduction[] } {
		const { invite, node_id, name, url } = body;
		if (typeof invite !== "string" || typeof node_id !== "string" || typeof name !== "string" || typeof url !== "string") throw new FederationError(400, "invite, node_id, name and url are required");
		const me = this.self();
		if (!NODE_NAME.test(name)) throw new FederationError(400, `node name "${name}" is not valid`);
		if (name === me.name || this.byName(name)) throw new FederationError(409, `a member is already named "${name}"; set node.name in that machine's config.yaml`);
		if (node_id === me.id || this.get(node_id)) throw new FederationError(409, "that gateway is already a member");
		const secret = secretNow();
		const others: Introduction[] = [];
		this.db.tx(() => {
			const used = this.db.run("UPDATE invites SET used_by = ? WHERE secret_hash = ? AND used_by IS NULL AND expires_at >= ?", node_id, hash(invite), this.now() / 1000);
			if (used.changes !== 1) throw new FederationError(403, "the join code is wrong, expired or already used; make a new one with nhermes invite");
			for (const m of this.rows()) {
				const pair = secretNow();
				others.push({ node_id: m.node_id, name: m.name, url: m.url, secret: pair });
				this.enqueue(m.node_id, "/federation/introduce", { node_id, name, url, secret: pair });
			}
			this.insert({ node_id, name, url, secret });
		});
		log.info("member joined", { name, url });
		void this.flush();
		this.changed();
		return { node: { node_id: me.id, name: me.name, url: me.url }, secret, members: others };
	}

	/** Another member introduces a newcomer. */
	introduce(from: MemberRow, body: Record<string, unknown>): void {
		const { node_id, name, url, secret } = body;
		if (typeof node_id !== "string" || typeof name !== "string" || typeof url !== "string" || typeof secret !== "string") throw new FederationError(400, "bad introduction");
		if (this.get(node_id)) return;
		if (this.byName(name)) throw new FederationError(409, `a member is already named "${name}"`);
		this.insert({ node_id, name, url, secret });
		log.info("member introduced", { name, by: from.name });
		this.changed();
	}

	/** Removes a member from the whole network (any member can). */
	async remove(name: string): Promise<void> {
		const target = this.byName(name);
		if (!target) throw new FederationError(404, `no member named "${name}"`);
		await this.call(target, "/federation/removed", {}).catch((e: unknown) => log.warn("could not tell the removed member", { name, error: String(e) }));
		this.db.tx(() => {
			this.forgetRow(target.node_id);
			for (const m of this.rows()) this.enqueue(m.node_id, "/federation/forget", { node_id: target.node_id });
		});
		this.changed();
		await this.flush();
	}

	/** Leaves the network: every member is told to forget this gateway. */
	async leave(): Promise<void> {
		const me = this.self();
		await Promise.allSettled(this.rows().map((m) => this.call(m, "/federation/forget", { node_id: me.id })));
		this.db.tx(() => {
			this.db.run("DELETE FROM member_outbox");
			this.db.run("DELETE FROM members");
		});
		log.info("left the network");
		this.changed();
	}

	/** A member says another member (or itself) is gone. */
	forget(from: MemberRow, body: Record<string, unknown>): void {
		if (typeof body.node_id !== "string") throw new FederationError(400, "node_id required");
		const gone = this.get(body.node_id);
		this.forgetRow(body.node_id);
		if (gone) log.info("member removed", { name: gone.name, by: from.name });
		this.changed();
	}

	/** This gateway was removed from the network by `from`: drop every link. */
	removed(from: MemberRow): void {
		this.db.tx(() => {
			this.db.run("DELETE FROM member_outbox");
			this.db.run("DELETE FROM members");
		});
		log.warn("this gateway was removed from the network", { by: from.name });
		this.changed();
	}

	hello(): { node_id: string; name: string; members: number } {
		const me = this.self();
		return { node_id: me.id, name: me.name, members: this.rows().length + 1 };
	}

	/** Headers that identify this gateway to `m` (HTTP and the WebSocket). */
	headersFor(m: MemberRow): Record<string, string> {
		return { [NODE_HEADER]: this.self().id, [SECRET_HEADER]: m.secret };
	}

	/** Calls a member's federation API, signed with the pair's secret. */
	async call<T = unknown>(m: MemberRow, path: string, body?: unknown, method = "POST"): Promise<T> {
		try {
			const r = await this.request<T>(m.url, method, path, body, this.headersFor(m));
			this.seen(m.node_id);
			return r;
		} catch (error) {
			this.db.run("UPDATE members SET last_error = ? WHERE node_id = ?", error instanceof Error ? error.message : String(error), m.node_id);
			throw error;
		}
	}

	/** Delivers waiting messages, one round at a time; ones that still fail stay for the next round. */
	flush(): Promise<void> {
		const round = (this.flushing ?? Promise.resolve()).then(() => this.deliver());
		this.flushing = round;
		return round;
	}

	private async deliver(): Promise<void> {
		for (const o of this.db.all<{ id: number; node_id: string; path: string; body: string }>("SELECT * FROM member_outbox ORDER BY id")) {
			const m = this.get(o.node_id);
			if (!m) {
				this.db.run("DELETE FROM member_outbox WHERE id = ?", o.id);
				continue;
			}
			try {
				await this.call(m, o.path, JSON.parse(o.body));
				this.db.run("DELETE FROM member_outbox WHERE id = ?", o.id);
			} catch {
				this.db.run("UPDATE member_outbox SET attempts = attempts + 1 WHERE id = ?", o.id);
			}
		}
	}

	/** Runs `tick` (and the outbox) every `intervalMs` until stop(). */
	start(tick: () => Promise<void> = async () => {}, intervalMs = 60_000): void {
		this.stop();
		const run = () => void Promise.allSettled([this.flush(), tick()]);
		this.timer = setInterval(run, intervalMs);
		this.timer.unref();
		run();
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}

	private insert(m: Introduction): void {
		registerSecret(m.secret);
		this.db.run("INSERT INTO members (node_id, name, url, secret, joined_at) VALUES (?, ?, ?, ?, ?)", m.node_id, m.name, m.url.replace(/\/$/, ""), m.secret, this.now() / 1000);
	}

	private forgetRow(nodeId: string): void {
		this.db.run("DELETE FROM member_outbox WHERE node_id = ?", nodeId);
		this.db.run("DELETE FROM members WHERE node_id = ?", nodeId);
	}

	private seen(nodeId: string): void {
		this.db.run("UPDATE members SET last_seen = ?, last_error = NULL WHERE node_id = ?", this.now() / 1000, nodeId);
	}

	private enqueue(nodeId: string, path: string, body: unknown): void {
		this.db.run("INSERT INTO member_outbox (node_id, path, body, created_at) VALUES (?, ?, ?, ?)", nodeId, path, JSON.stringify(body), this.now() / 1000);
	}

	private async request<T>(base: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
		let res: Response;
		try {
			res = await this.fetch(`${base}${path}`, {
				method,
				headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) },
				body: body === undefined ? undefined : JSON.stringify(body),
				signal: AbortSignal.timeout(10_000),
			});
		} catch (error) {
			throw new FederationError(502, `${base} is not reachable (${error instanceof Error ? error.message : String(error)})`);
		}
		const json = (await res.json().catch(() => ({}))) as { detail?: string };
		if (!res.ok) throw new FederationError(res.status === 401 ? 401 : res.status >= 500 ? 502 : res.status, json.detail ?? `${base} answered ${res.status}`);
		return json as T;
	}
}
