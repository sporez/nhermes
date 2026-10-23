// Federation membership. Every gateway is an equal member of one network; each pair of members shares a
// secret the software generates at join time, so the owner never handles keys. Joining any member joins
// the network: the member that accepts the join introduces the newcomer to every other member over the
// links it already has. Messages a member could not deliver (the other side was offline) wait in
// member_outbox and are retried.
//
// Members talk only TLS-PSK on their encrypted port (src/federation/psk.ts): the pair secret keys the
// handshake and never travels. There is no plain HTTP path between members and no fallback to one; a member
// row without an encrypted port cannot be reached and has to be removed and joined again.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { hostname, networkInterfaces } from "node:os";
import type { ConnectionOptions } from "node:tls";
import { type Config, NODE_NAME } from "../config.ts";
import { logger, registerSecret } from "../log.ts";
import type { AppDb } from "../store/db.ts";
import { clientTls, inviteId, inviteKey, keyId, keyRefused, memberIdentity, pairKey, parseIdentity, pskBase, pskRequest } from "./psk.ts";

const log = logger("members");

const INVITE_TTL_MS = 10 * 60_000;
const INVITE_REFUSED = "the join code is wrong, expired or already used; make a new one with nhermes invite";
/** Connection errors that mean the other machine was not reached at all (as opposed to refusing a handshake). */
const UNREACHABLE = new Set(["ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN"]);
/** How long the previous pair secret still opens a connection after it was replaced. */
const PREV_SECRET_GRACE_MS = 10 * 60_000;

/**
 * The session source that marks a chat a member started (it is never trusted, see guardExtension).
 * `relayed` marks the owner's own chat passed on from their client on that member (created with `relay`,
 * sent only by ProxySessions); delegated work and anything unmarked stay plain.
 */
export function memberSource(nodeId: string, relayed = false): string {
	return relayed ? `member:${nodeId}:owner` : `member:${nodeId}`;
}

export type MemberRow = {
	node_id: string;
	name: string;
	url: string;
	secret: string;
	joined_at: number;
	last_seen: number | null;
	last_error: string | null;
	/** Its encrypted port. Null only in a row from an older version, which cannot be reached (remove and join again). */
	psk_port: number | null;
	/** The secret before the last replacement, accepted until prev_until (seconds). */
	prev_secret: string | null;
	prev_until: number | null;
	/** 1 once the pair secret was replaced over the encrypted link. */
	rotated: number;
};

/** A member as shown to the owner (no secrets). */
export type MemberView = Omit<MemberRow, "secret" | "prev_secret" | "prev_until"> & { reachable: boolean; encrypted: boolean };

export type Self = { id: string; name: string; url: string };

/** What a member is told about another member when it is introduced. */
type Introduction = { node_id: string; name: string; url: string; secret: string; psk_port?: number | null };

/** How a WebSocket reaches a member: its encrypted URL and the TLS-PSK options. */
export type MemberTarget = { url: string; tls: ConnectionOptions };

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

/** `pskPort`: the inviter's encrypted port, so the join itself is encrypted (a code without it is refused). */
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

/** A code made by a version without the encrypted port cannot be used: refused before any request. */
function encryptedInvite(code: string): { url: string; secret: string; pskPort: number } {
	const { url, secret, pskPort } = decodeInvite(code);
	if (!pskPort) throw new FederationError(400, "this join code comes from an older version of nHermes; update that machine and make a new code");
	return { url, secret, pskPort };
}

/** A pair secret as secretNow() makes it: 32 base64url characters. A blank one (a backup made without --secrets) never opens a link. */
function validSecret(v: unknown): v is string {
	return typeof v === "string" && /^[A-Za-z0-9_-]{32,}$/.test(v);
}

/** A node id as randomUUID() makes it. */
function validNodeId(v: unknown): v is string {
	return typeof v === "string" && /^[A-Za-z0-9-]{1,64}$/.test(v);
}

const noLink = (name: string) => `${name} has no encrypted link; remove it and join it again`;

/** An encrypted port a machine reported about itself or another member. */
function validPort(v: unknown, who: string): number {
	if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 65535) throw new FederationError(400, `${who} has no encrypted port; update that machine and try again`);
	return v;
}

export type MembersOptions = { now?: () => number };

export class Members {
	private readonly db: AppDb;
	private readonly config: Config;
	private readonly now: () => number;
	private port = 0;
	private pskPortNo = 0;
	private timer: ReturnType<typeof setInterval> | undefined;
	private flushing: Promise<void> | undefined;
	private changed: () => void = () => {};
	private readonly revokeListeners: (() => void)[] = [];

	constructor(db: AppDb, config: Config, opts: MembersOptions = {}) {
		this.db = db;
		this.config = config;
		this.now = opts.now ?? Date.now;
		for (const m of this.rows()) {
			registerSecret(m.secret);
			if (m.prev_secret) registerSecret(m.prev_secret);
			if (m.psk_port === null) log.warn(`${m.name} has no encrypted link; remove it and join it again`, { member: m.name });
		}
	}

	/** Called after the member list changes (the roster refreshes). */
	onChange(fn: () => void): void {
		this.changed = fn;
	}

	/** Called when a member was forgotten or a pair secret was replaced or dropped: open links check they are still allowed. */
	onRevoke(fn: () => void): void {
		this.revokeListeners.push(fn);
	}

	private revoke(): void {
		for (const fn of this.revokeListeners) fn();
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
		return this.rows().map(({ secret: _s, prev_secret: _p, prev_until: _u, psk_inbound: _i, ...m }: MemberRow & { psk_inbound?: number }) => ({ ...m, reachable: m.last_error === null && m.last_seen !== null, encrypted: m.psk_port !== null }));
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
		if (validSecret(m.secret) && keyId(m.secret) === id.keyId) return pairKey(m.secret);
		if (validSecret(m.prev_secret) && m.prev_until !== null && m.prev_until * 1000 >= this.now() && keyId(m.prev_secret) === id.keyId) return pairKey(m.prev_secret);
		return null;
	}

	/** Whether the connection's key has since been replaced (it was opened with the previous secret, within the grace). */
	usesReplacedKey(identity: string): boolean {
		const id = parseIdentity(identity);
		if (id?.kind !== "member") return false;
		const m = this.get(id.nodeId);
		return m !== undefined && keyId(m.secret) !== id.keyId;
	}

	/** The member an encrypted connection belongs to (its handshake already proved the key). */
	pskMember(identity: string): MemberRow | undefined {
		const id = parseIdentity(identity);
		if (id?.kind !== "member") return undefined;
		const m = this.get(id.nodeId);
		if (!m) return undefined;
		this.seen(m.node_id);
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
		const { url, secret, pskPort } = encryptedInvite(code);
		const hello = await this.inviteRequest<{ name: string; members: number }>(url, pskPort, secret, "GET", "/federation/hello");
		return { name: hello.name, url, members: hello.members };
	}

	/** A request to the inviter, encrypted with a key only the code's holder can make. */
	private inviteRequest<T>(url: string, pskPort: number, secret: string, method: string, path: string, body?: unknown): Promise<T> {
		const h = hash(secret);
		return this.answer<T>(url, () =>
			pskRequest(pskBase(url, pskPort), clientTls(`i:${inviteId(h)}`, inviteKey(h)), method, path, body, 10_000).catch((error: NodeJS.ErrnoException) => {
				// Reached, but the handshake was refused: the inviter has no open invite for this key.
				if (!UNREACHABLE.has(error.code ?? "") && !/no answer within/.test(error.message)) throw new FederationError(403, INVITE_REFUSED);
				throw error;
			}),
		);
	}

	/** Joins the network the code comes from. Returns the members this gateway now knows. */
	async join(code: string): Promise<string[]> {
		if (this.rows().length > 0) throw new FederationError(409, "this gateway is already in a network; leave it first (nhermes leave)");
		const { url, secret, pskPort } = encryptedInvite(code);
		const me = this.self();
		if (!this.pskPort()) throw new FederationError(409, "this gateway has no encrypted port to join with (see the log)");
		const body = { invite: secret, node_id: me.id, name: me.name, url: me.url, psk_port: this.pskPort() };
		type Joined = { node: { node_id: string; name: string; url: string; psk_port?: number | null }; secret: string; members: Introduction[] };
		const r = await this.inviteRequest<Joined>(url, pskPort, secret, "POST", "/federation/join", body);
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
	acceptJoin(body: Record<string, unknown>, pskIdentity: string): { node: { node_id: string; name: string; url: string; psk_port: number | null }; secret: string; members: Introduction[] } {
		const { invite, node_id, name, url } = body;
		if (typeof invite !== "string" || typeof node_id !== "string" || typeof name !== "string" || typeof url !== "string") throw new FederationError(400, "invite, node_id, name and url are required");
		// The handshake used one invite's key; the body must name that same invite.
		if (pskIdentity !== `i:${inviteId(hash(invite))}`) throw new FederationError(403, "the join code does not match this connection");
		if (!validNodeId(node_id)) throw new FederationError(400, "node_id is not valid");
		const psk_port = validPort(body.psk_port, name);
		const me = this.self();
		for (const m of this.rows()) if (m.psk_port === null) throw new FederationError(409, `${m.name} has no encrypted link; remove it and join it again, then make a new code`);
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
		log.info("member joined", { name, url });
		void this.flush();
		this.changed();
		return { node: { node_id: me.id, name: me.name, url: me.url, psk_port: this.pskPort() }, secret, members: others };
	}

	/** Another member introduces a newcomer. */
	introduce(from: MemberRow, body: Record<string, unknown>): void {
		const { node_id, name, url, secret } = body;
		if (typeof node_id !== "string" || typeof name !== "string" || typeof url !== "string" || typeof secret !== "string") throw new FederationError(400, "bad introduction");
		if (!validNodeId(node_id) || !validSecret(secret)) throw new FederationError(400, "bad introduction");
		const psk_port = validPort(body.psk_port, name);
		if (this.get(node_id)) return;
		if (this.byName(name)) throw new FederationError(409, `a member is already named "${name}"`);
		this.insert({ node_id, name, url, secret, psk_port });
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
		this.revoke();
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
		this.revoke();
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

	/** Whether other members may start and answer provider sign-ins on this gateway (off until the owner turns it on). */
	acceptsLogins(): boolean {
		return this.flag("federation.acceptLogins");
	}

	setAcceptsLogins(on: boolean): void {
		this.setFlag("federation.acceptLogins", on);
		log.info("sign-ins from members", { accepted: on });
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

	/** TLS-PSK options for `m`, keyed by the pair secret. */
	private tlsFor(m: MemberRow): ConnectionOptions {
		return clientTls(memberIdentity(this.self().id, m.secret), pairKey(m.secret));
	}

	/** How a WebSocket reaches `m` (undefined when it is no longer a member). */
	target(nodeId: string): MemberTarget | undefined {
		const m = this.get(nodeId);
		if (!m) return undefined;
		if (!m.psk_port) throw new FederationError(502, noLink(m.name));
		return { url: pskBase(m.url, m.psk_port), tls: this.tlsFor(m) };
	}

	/** Calls a member's federation API over TLS-PSK. */
	async call<T = unknown>(m: MemberRow, path: string, body?: unknown, method = "POST", timeoutMs?: number): Promise<T> {
		try {
			if (!m.psk_port) throw new FederationError(502, noLink(m.name));
			const r = await this.answer<T>(m.url, () => pskRequest(pskBase(m.url, m.psk_port!), this.tlsFor(m), method, path, body, timeoutMs ?? 10_000));
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

	/** Housekeeping on every tick: tell the others when this gateway's address changed, and deliver the outbox. */
	async maintain(): Promise<void> {
		this.announce();
		this.db.run("UPDATE members SET prev_secret = NULL, prev_until = NULL WHERE prev_until IS NOT NULL AND prev_until < ?", this.now() / 1000);
		this.revoke();
		await this.flush();
	}

	/** Replaces the secret shared with one member, over the encrypted link (the panel's "Regenerate key"). */
	async rotate(name: string): Promise<void> {
		const m = this.byName(name);
		if (!m) throw new FederationError(404, `no member named "${name}"`);
		if (!m.psk_port) throw new FederationError(409, noLink(name));
		const next = secretNow();
		registerSecret(next);
		await this.call(m, "/federation/rotate", { secret: next });
		this.replaceSecret(m, next);
		log.info("pair secret replaced", { name });
	}

	/** The other side of rotate(). It only arrives over the encrypted port, so the new secret never travels in clear. */
	acceptRotate(from: MemberRow, body: Record<string, unknown>): void {
		if (!validSecret(body.secret)) throw new FederationError(400, "secret required");
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
		if (!validNodeId(m.node_id) || !validSecret(m.secret)) throw new FederationError(502, `${m.name} sent an invalid identity or key`);
		const psk_port = validPort(m.psk_port, m.name);
		registerSecret(m.secret);
		this.db.run("INSERT INTO members (node_id, name, url, secret, joined_at, psk_port) VALUES (?, ?, ?, ?, ?, ?)", m.node_id, m.name, m.url.replace(/\/$/, ""), m.secret, this.now() / 1000, psk_port);
	}

	private forgetRow(nodeId: string): void {
		this.db.run("DELETE FROM member_outbox WHERE node_id = ?", nodeId);
		this.db.run("DELETE FROM members WHERE node_id = ?", nodeId);
		this.revoke();
	}

	private seen(nodeId: string): void {
		this.db.run("UPDATE members SET last_seen = ?, last_error = NULL WHERE node_id = ?", this.now() / 1000, nodeId);
	}

	private enqueue(nodeId: string, path: string, body: unknown): void {
		this.db.run("INSERT INTO member_outbox (node_id, path, body, created_at) VALUES (?, ?, ?, ?)", nodeId, path, JSON.stringify(body), this.now() / 1000);
	}

	/** An encrypted request's outcome as an answer or a FederationError. */
	private async answer<T>(base: string, send: () => Promise<{ status: number; json: Record<string, unknown> }>): Promise<T> {
		let r: { status: number; json: Record<string, unknown> };
		try {
			r = await send();
		} catch (error) {
			if (error instanceof FederationError) throw error;
			// The member refused our key: the pairing is gone on its side.
			if (keyRefused(error)) throw new FederationError(401, `${base} no longer accepts this machine's key`);
			throw new FederationError(502, `${base} is not reachable encrypted (${error instanceof Error ? error.message : String(error)})`);
		}
		const detail = typeof r.json.detail === "string" ? r.json.detail : undefined;
		if (r.status < 200 || r.status >= 300) throw new FederationError(r.status === 401 ? 401 : r.status >= 500 ? 502 : r.status, detail ?? `${base} answered ${r.status}`);
		return r.json as T;
	}
}
