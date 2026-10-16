// Federation membership. Every gateway is an equal member of one network; each pair of members shares a
// secret the software generates at join time, so the owner never handles keys. Joining any member joins
// the network: the member that accepts the join introduces the newcomer to every other member over the
// links it already has. Messages a member could not deliver (the other side was offline) wait in
// member_outbox and are retried.
//
// Members that both run this version talk TLS-PSK on their encrypted port (src/federation/psk.ts): the pair
// secret keys the handshake and never travels. A member is reached that way as soon as its port is known,
// with no fallback to plain HTTP; the first secret of every pair travelled in clear (on every request, in
// older versions), so it is replaced once over the encrypted link.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { hostname, networkInterfaces } from "node:os";
import type { ConnectionOptions } from "node:tls";
import { type Config, NODE_NAME } from "../config.ts";
import { logger, registerSecret } from "../log.ts";
import type { AppDb } from "../store/db.ts";
import { clientTls, inviteId, inviteKey, keyId, keyRefused, memberIdentity, pairKey, parseIdentity, pskBase, pskRequest } from "./psk.ts";

const log = logger("members");

export const NODE_HEADER = "x-nhermes-node";
export const SECRET_HEADER = "x-nhermes-member-secret";
const INVITE_TTL_MS = 10 * 60_000;
const INVITE_REFUSED = "the join code is wrong, expired or already used; make a new one with nhermes invite";
/** Connection errors that mean the other machine was not reached at all (as opposed to refusing a handshake). */
const UNREACHABLE = new Set(["ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN"]);
/** How long the previous pair secret still opens a connection after it was replaced. */
const PREV_SECRET_GRACE_MS = 10 * 60_000;

export type MemberRow = {
	node_id: string;
	name: string;
	url: string;
	secret: string;
	joined_at: number;
	last_seen: number | null;
	last_error: string | null;
	/** Its encrypted port; null until known (an older version has none). */
	psk_port: number | null;
	/** The secret before the last replacement, accepted until prev_until (seconds). */
	prev_secret: string | null;
	prev_until: number | null;
	/** 1 once it has reached this gateway over the encrypted port: plain requests from it are then refused. */
	psk_inbound: number;
	/** 1 once the pair secret was replaced over the encrypted link. */
	rotated: number;
};

/** A member as shown to the owner (no secrets). */
export type MemberView = Omit<MemberRow, "secret" | "prev_secret" | "prev_until"> & { reachable: boolean; encrypted: boolean };

export type Self = { id: string; name: string; url: string };

/** What a member is told about another member when it is introduced. */
type Introduction = { node_id: string; name: string; url: string; secret: string; psk_port?: number | null };

/** How a WebSocket reaches a member: its URL, and either TLS-PSK options or identifying headers. */
export type MemberTarget = { url: string; headers: Record<string, string>; tls?: ConnectionOptions };

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

/** `pskPort`: the inviter's encrypted port, so the join itself is encrypted (absent from older codes). */
export type InviteCode = { url: string; secret: string; pskPort?: number };

export function encodeInvite(c: InviteCode): string {
	return `nh1.${Buffer.from(JSON.stringify({ u: c.url, s: c.secret, ...(c.pskPort ? { p: c.pskPort } : {}) })).toString("base64url")}`;
}

export function decodeInvite(code: string): InviteCode {
	const m = /^nh1\.([A-Za-z0-9_-]+)$/.exec(code.trim());
	try {
		const v = JSON.parse(Buffer.from(m![1]!, "base64url").toString("utf8")) as { u?: unknown; s?: unknown; p?: unknown };
		if (typeof v.u !== "string" || typeof v.s !== "string") throw new Error();
		new URL(v.u);
		return { url: v.u.replace(/\/$/, ""), secret: v.s, ...(typeof v.p === "number" ? { pskPort: v.p } : {}) };
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
	private pskPortNo = 0;
	private timer: ReturnType<typeof setInterval> | undefined;
	private flushing: Promise<void> | undefined;
	private changed: () => void = () => {};

	constructor(db: AppDb, config: Config, opts: MembersOptions = {}) {
		this.db = db;
		this.config = config;
		this.fetch = opts.fetch ?? fetch;
		this.now = opts.now ?? Date.now;
		for (const m of this.rows()) {
			registerSecret(m.secret);
			if (m.prev_secret) registerSecret(m.prev_secret);
		}
	}

	/** Called after the member list changes (the roster refreshes). */
	onChange(fn: () => void): void {
		this.changed = fn;
	}

	/** The port the gateway listens on (known once the server is up). */
	setListenPort(port: number): void {
		this.port = port;
	}

	/** The encrypted port members use (known once its listener is up; 0 when there is none). */
	setPskPort(port: number): void {
		this.pskPortNo = port;
	}

	pskPort(): number | null {
		return this.pskPortNo || null;
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
		return this.rows().map(({ secret: _s, prev_secret: _p, prev_until: _u, ...m }) => ({ ...m, reachable: m.last_error === null && m.last_seen !== null, encrypted: m.psk_port !== null }));
	}

	get(nodeId: string): MemberRow | undefined {
		return this.db.get<MemberRow>("SELECT * FROM members WHERE node_id = ?", nodeId);
	}

	byName(name: string): MemberRow | undefined {
		return this.db.get<MemberRow>("SELECT * FROM members WHERE name = ?", name);
	}

	/**
	 * The TLS key for a handshake identity (the encrypted listener's pskCallback): a member's current secret,
	 * or its previous one within the grace period, or an open invite. Null refuses the handshake.
	 */
	pskKey(identity: string): Buffer | null {
		const id = parseIdentity(identity);
		if (!id) return null;
		if (id.kind === "invite") {
			const row = this.db.get<{ secret_hash: string }>("SELECT secret_hash FROM invites WHERE substr(secret_hash, 1, 16) = ? AND used_by IS NULL AND expires_at >= ?", id.id, this.now() / 1000);
			return row ? inviteKey(row.secret_hash) : null;
		}
		const m = this.get(id.nodeId);
		if (!m) return null;
		if (keyId(m.secret) === id.keyId) return pairKey(m.secret);
		if (m.prev_secret && m.prev_until !== null && m.prev_until * 1000 >= this.now() && keyId(m.prev_secret) === id.keyId) return pairKey(m.prev_secret);
		return null;
	}

	/** The member an encrypted connection belongs to (its handshake already proved the key). */
	pskMember(identity: string): MemberRow | undefined {
		const id = parseIdentity(identity);
		if (id?.kind !== "member") return undefined;
		const m = this.get(id.nodeId);
		if (!m) return undefined;
		this.db.run("UPDATE members SET last_seen = ?, last_error = NULL, psk_inbound = 1 WHERE node_id = ?", this.now() / 1000, m.node_id);
		return { ...m, psk_inbound: 1 };
	}

	/** Whether plain requests from every member are refused (the owner's switch, once all are encrypted). */
	requiresPsk(): boolean {
		return this.flag("federation.requirePsk");
	}

	setRequiresPsk(on: boolean): void {
		this.setFlag("federation.requirePsk", on);
		log.info("plain requests from members", { refused: on });
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
		return { code: encodeInvite({ url: opts.url?.replace(/\/$/, "") ?? this.self().url, secret, ...(this.pskPortNo ? { pskPort: this.pskPortNo } : {}) }), expiresAt };
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
		const { url, secret, pskPort } = decodeInvite(code);
		const me = this.self();
		const body = { invite: secret, node_id: me.id, name: me.name, url: me.url, psk_port: this.pskPort() };
		type Joined = { node: { node_id: string; name: string; url: string; psk_port?: number | null }; secret: string; members: Introduction[] };
		// With the inviter's encrypted port in the code, the join (and the pair secret it hands out) is
		// encrypted with a key only the code's holder can make.
		let r: Joined;
		if (pskPort) {
			const h = hash(secret);
			r = await this.answer<Joined>(url, () =>
				pskRequest(pskBase(url, pskPort), clientTls(`i:${inviteId(h)}`, inviteKey(h)), "POST", "/federation/join", body, 10_000).catch((error: NodeJS.ErrnoException) => {
					// Reached, but the handshake was refused: the inviter has no open invite for this key.
					if (!UNREACHABLE.has(error.code ?? "") && !/no answer within/.test(error.message)) throw new FederationError(403, INVITE_REFUSED);
					throw error;
				}),
			);
		} else {
			log.warn("joining over plain HTTP: the inviting gateway is an older version");
			r = await this.request<Joined>(url, "POST", "/federation/join", body);
		}
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
	acceptJoin(body: Record<string, unknown>, pskIdentity?: string): { node: { node_id: string; name: string; url: string; psk_port: number | null }; secret: string; members: Introduction[] } {
		const { invite, node_id, name, url } = body;
		if (typeof invite !== "string" || typeof node_id !== "string" || typeof name !== "string" || typeof url !== "string") throw new FederationError(400, "invite, node_id, name and url are required");
		// Over the encrypted port the handshake used one invite's key; the body must name that same invite.
		if (pskIdentity !== undefined && pskIdentity !== `i:${inviteId(hash(invite))}`) throw new FederationError(403, "the join code does not match this connection");
		const psk_port = typeof body.psk_port === "number" ? body.psk_port : null;
		const me = this.self();
		if (!NODE_NAME.test(name)) throw new FederationError(400, `node name "${name}" is not valid`);
		if (name === me.name || this.byName(name)) throw new FederationError(409, `a member is already named "${name}"; set node.name in that machine's config.yaml`);
		if (node_id === me.id || this.get(node_id)) throw new FederationError(409, "that gateway is already a member");
		const secret = secretNow();
		const others: Introduction[] = [];
		this.db.tx(() => {
			const used = this.db.run("UPDATE invites SET used_by = ? WHERE secret_hash = ? AND used_by IS NULL AND expires_at >= ?", node_id, hash(invite), this.now() / 1000);
			if (used.changes !== 1) throw new FederationError(403, INVITE_REFUSED);
			for (const m of this.rows()) {
				const pair = secretNow();
				others.push({ node_id: m.node_id, name: m.name, url: m.url, secret: pair, psk_port: m.psk_port });
				this.enqueue(m.node_id, "/federation/introduce", { node_id, name, url, secret: pair, psk_port });
			}
			this.insert({ node_id, name, url, secret, psk_port });
		});
		log.info("member joined", { name, url, encrypted: pskIdentity !== undefined });
		void this.flush();
		this.changed();
		return { node: { node_id: me.id, name: me.name, url: me.url, psk_port: this.pskPort() }, secret, members: others };
	}

	/** Another member introduces a newcomer. */
	introduce(from: MemberRow, body: Record<string, unknown>): void {
		const { node_id, name, url, secret } = body;
		if (typeof node_id !== "string" || typeof name !== "string" || typeof url !== "string" || typeof secret !== "string") throw new FederationError(400, "bad introduction");
		if (this.get(node_id)) return;
		if (this.byName(name)) throw new FederationError(409, `a member is already named "${name}"`);
		this.insert({ node_id, name, url, secret, psk_port: typeof body.psk_port === "number" ? body.psk_port : null });
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

	/** Whether this gateway lets other members set keys in its secrets.env (off until the owner turns it on). */
	acceptsSecrets(): boolean {
		return this.flag("federation.acceptSecrets");
	}

	setAcceptsSecrets(on: boolean): void {
		this.setFlag("federation.acceptSecrets", on);
		log.info("keys from members", { accepted: on });
	}

	/** Whether other members may edit this gateway's bots from their panels (off until the owner turns it on). */
	acceptsBotEdits(): boolean {
		return this.flag("federation.acceptBotEdits");
	}

	setAcceptsBotEdits(on: boolean): void {
		this.setFlag("federation.acceptBotEdits", on);
		log.info("bot edits from members", { accepted: on });
	}

	private flag(key: string): boolean {
		return this.db.get<{ value: string }>("SELECT value FROM settings WHERE key = ?", key)?.value === "1";
	}

	private setFlag(key: string, on: boolean): void {
		this.db.run("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, on ? "1" : "0");
	}

	hello(): { node_id: string; name: string; members: number; psk_port: number | null } {
		const me = this.self();
		return { node_id: me.id, name: me.name, members: this.rows().length + 1, psk_port: this.pskPort() };
	}

	/** Headers that identify this gateway to `m` over plain HTTP (a member without an encrypted port). */
	headersFor(m: MemberRow): Record<string, string> {
		return { [NODE_HEADER]: this.self().id, [SECRET_HEADER]: m.secret };
	}

	/** TLS-PSK options for `m`, keyed by the pair secret. */
	private tlsFor(m: MemberRow): ConnectionOptions {
		return clientTls(memberIdentity(this.self().id, m.secret), pairKey(m.secret));
	}

	/** How a WebSocket reaches `m`: encrypted when its port is known, else plain with the identifying headers. */
	target(nodeId: string): MemberTarget | undefined {
		const m = this.get(nodeId);
		if (!m) return undefined;
		if (m.psk_port) return { url: pskBase(m.url, m.psk_port), headers: {}, tls: this.tlsFor(m) };
		return { url: m.url, headers: this.headersFor(m) };
	}

	/** Calls a member's federation API: over TLS-PSK when its encrypted port is known, else signed with the pair secret. */
	async call<T = unknown>(m: MemberRow, path: string, body?: unknown, method = "POST", timeoutMs?: number): Promise<T> {
		try {
			const r = m.psk_port
				? await this.answer<T>(m.url, () => pskRequest(pskBase(m.url, m.psk_port!), this.tlsFor(m), method, path, body, timeoutMs ?? 10_000))
				: await this.request<T>(m.url, method, path, body, this.headersFor(m), timeoutMs);
			this.seen(m.node_id);
			return r;
		} catch (error) {
			// A refusal (400, 403, 409…) is an answer; only an unreachable member or a lost pairing is a link problem.
			const answered = error instanceof FederationError && error.status !== 502 && error.status !== 401;
			if (answered) this.seen(m.node_id);
			else this.db.run("UPDATE members SET last_error = ? WHERE node_id = ?", error instanceof Error ? error.message : String(error), m.node_id);
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

	/**
	 * Housekeeping on every tick: learn members' encrypted ports, replace pair secrets that travelled in
	 * clear, and tell the others when this gateway's address changed.
	 */
	async maintain(): Promise<void> {
		this.announce();
		for (const m of this.rows()) {
			if (m.psk_port === null) {
				const hello = await this.request<{ node_id?: string; psk_port?: unknown }>(m.url, "GET", "/federation/hello", undefined, {}, 5_000).catch(() => undefined);
				if (hello?.node_id === m.node_id && typeof hello.psk_port === "number") {
					this.db.run("UPDATE members SET psk_port = ? WHERE node_id = ?", hello.psk_port, m.node_id);
					log.info("member reachable encrypted", { name: m.name, port: hello.psk_port });
					this.changed();
				}
			}
		}
		// One side of each pair replaces the secret (the lower node id), so both never do it at once.
		const me = this.self().id;
		for (const m of this.rows()) {
			if (m.psk_port !== null && !m.rotated && me < m.node_id) await this.rotate(m.name).catch((e: unknown) => log.warn("could not replace a pair secret yet", { name: m.name, error: String(e) }));
		}
		await this.flush();
	}

	/** Replaces the secret shared with one member, over the encrypted link (the panel's "Regenerate key", and maintain()). */
	async rotate(name: string): Promise<void> {
		const m = this.byName(name);
		if (!m) throw new FederationError(404, `no member named "${name}"`);
		if (!m.psk_port) throw new FederationError(409, `${name} has no encrypted port yet (it runs an older version); update it first`);
		const next = secretNow();
		registerSecret(next);
		await this.call(m, "/federation/rotate", { secret: next });
		this.replaceSecret(m, next);
		log.info("pair secret replaced", { name });
	}

	/** The other side of rotate(): only over the encrypted port, so the new secret never travels in clear. */
	acceptRotate(from: MemberRow, body: Record<string, unknown>, encrypted: boolean): void {
		if (!encrypted) throw new FederationError(403, "a pair secret is only replaced over the encrypted port");
		if (typeof body.secret !== "string" || body.secret.length < 24) throw new FederationError(400, "secret required");
		registerSecret(body.secret);
		this.replaceSecret(from, body.secret);
		log.info("pair secret replaced", { name: from.name, by: from.name });
	}

	private replaceSecret(m: MemberRow, next: string): void {
		this.db.run("UPDATE members SET prev_secret = secret, prev_until = ?, secret = ?, rotated = 1 WHERE node_id = ?", (this.now() + PREV_SECRET_GRACE_MS) / 1000, next, m.node_id);
	}

	/** Tells every member this gateway's address when it differs from the one it last told them. */
	private announce(): void {
		if (this.rows().length === 0) return;
		const now = { url: this.self().url, psk_port: this.pskPort() };
		const key = "federation.announced";
		const last = this.db.get<{ value: string }>("SELECT value FROM settings WHERE key = ?", key)?.value;
		if (last === JSON.stringify(now)) return;
		this.db.tx(() => {
			for (const m of this.rows()) this.enqueue(m.node_id, "/federation/moved", now);
			this.db.run("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, JSON.stringify(now));
		});
		if (last !== undefined) log.info("address changed; telling the other members", now);
	}

	/** A member's address changed (another port or IP). */
	moved(from: MemberRow, body: Record<string, unknown>): void {
		const url = typeof body.url === "string" ? body.url.replace(/\/$/, "") : "";
		try {
			new URL(url);
		} catch {
			throw new FederationError(400, "url required");
		}
		const port = typeof body.psk_port === "number" ? body.psk_port : null;
		// An encrypted member never goes back to plain HTTP by a message: that would be a downgrade.
		const psk_port = port ?? from.psk_port;
		if (url === from.url && psk_port === from.psk_port) return;
		this.db.run("UPDATE members SET url = ?, psk_port = ? WHERE node_id = ?", url, psk_port, from.node_id);
		log.info("member moved", { name: from.name, url, psk_port });
		this.changed();
	}

	/** Runs `tick` (and the outbox) every `intervalMs` until stop(). */
	start(tick: () => Promise<void> = async () => {}, intervalMs = 60_000): void {
		this.stop();
		const run = () => void Promise.allSettled([this.maintain(), tick()]);
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
		this.db.run("INSERT INTO members (node_id, name, url, secret, joined_at, psk_port) VALUES (?, ?, ?, ?, ?, ?)", m.node_id, m.name, m.url.replace(/\/$/, ""), m.secret, this.now() / 1000, m.psk_port ?? null);
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

	/** An encrypted request's outcome, with the same errors as request(). */
	private async answer<T>(base: string, send: () => Promise<{ status: number; json: Record<string, unknown> }>): Promise<T> {
		let r: { status: number; json: Record<string, unknown> };
		try {
			r = await send();
		} catch (error) {
			if (error instanceof FederationError) throw error;
			// The member refused our key: like a 401 over plain HTTP, the pairing is gone on its side.
			if (keyRefused(error)) throw new FederationError(401, `${base} no longer accepts this machine's key`);
			throw new FederationError(502, `${base} is not reachable encrypted (${error instanceof Error ? error.message : String(error)})`);
		}
		const detail = typeof r.json.detail === "string" ? r.json.detail : undefined;
		if (r.status < 200 || r.status >= 300) throw new FederationError(r.status === 401 ? 401 : r.status >= 500 ? 502 : r.status, detail ?? `${base} answered ${r.status}`);
		return r.json as T;
	}

	private async request<T>(base: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}, timeoutMs = 10_000): Promise<T> {
		let res: Response;
		try {
			res = await this.fetch(`${base}${path}`, {
				method,
				headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) },
				body: body === undefined ? undefined : JSON.stringify(body),
				signal: AbortSignal.timeout(timeoutMs),
			});
		} catch (error) {
			throw new FederationError(502, `${base} is not reachable (${error instanceof Error ? error.message : String(error)})`);
		}
		const json = (await res.json().catch(() => ({}))) as { detail?: string };
		if (!res.ok) throw new FederationError(res.status === 401 ? 401 : res.status >= 500 ? 502 : res.status, json.detail ?? `${base} answered ${res.status}`);
		return json as T;
	}
}
