// TLS between members, keyed by the pair secret (TLS-PSK): no certificates anywhere. Both sides prove they
// hold the secret in the handshake, so it never travels, and ECDHE gives forward secrecy. Node's external
// PSK works with TLS 1.2 only, hence the pinned version and cipher.
//
// Identities (sent in clear in the handshake, never secret):
//   m:<node id>:<key id>   a member, keyed by the pair secret whose key id it names
//   i:<invite id>          a joiner, keyed by the invite (see inviteKey)
import { createHash, hkdfSync } from "node:crypto";
import https from "node:https";
import type { ConnectionOptions } from "node:tls";

export const PSK_CIPHERS = "ECDHE-PSK-CHACHA20-POLY1305";
export const PSK_TLS = { ciphers: PSK_CIPHERS, minVersion: "TLSv1.2", maxVersion: "TLSv1.2" } as const;

function derive(material: string, label: string): Buffer {
	return Buffer.from(hkdfSync("sha256", material, "nhermes-psk-v1", label, 32));
}

/** The TLS key for a pair secret. */
export function pairKey(secret: string): Buffer {
	return derive(secret, "pair");
}

/** A short public name for a pair secret, so a member can say which one it is using while a new one settles. */
export function keyId(secret: string): string {
	return createHash("sha256").update(`nhermes-key-id:${secret}`).digest("hex").slice(0, 12);
}

/** The invite's id (in the identity) and key. Both come from the stored hash, which is all the inviter keeps. */
export function inviteId(secretHash: string): string {
	return secretHash.slice(0, 16);
}
export function inviteKey(secretHash: string): Buffer {
	return derive(secretHash, "invite");
}

export function memberIdentity(nodeId: string, secret: string): string {
	return `m:${nodeId}:${keyId(secret)}`;
}

export type PskIdentity = { kind: "member"; nodeId: string; keyId: string } | { kind: "invite"; id: string };

export function parseIdentity(identity: string): PskIdentity | undefined {
	const m = /^m:([^:]+):([0-9a-f]{12})$/.exec(identity);
	if (m) return { kind: "member", nodeId: m[1]!, keyId: m[2]! };
	const i = /^i:([0-9a-f]{16})$/.exec(identity);
	if (i) return { kind: "invite", id: i[1]! };
	return undefined;
}

/** Whether a connection error is the other side refusing our key (it no longer knows this pair), not a network problem. */
export function keyRefused(error: unknown): boolean {
	return error instanceof Error && /unknown psk identity|decrypt error|bad record mac|handshake failure/i.test(error.message);
}

/** Client TLS options for one identity and key (there is no certificate to check; the key is the proof). */
export function clientTls(identity: string, key: Buffer): ConnectionOptions {
	return { ...PSK_TLS, checkServerIdentity: () => undefined, pskCallback: () => ({ identity, psk: key }) };
}

/** The encrypted address of a member: its URL's host with the PSK port. */
export function pskBase(url: string, port: number): string {
	const u = new URL(url);
	return `https://${u.hostname.includes(":") ? `[${u.hostname}]` : u.hostname}:${port}`;
}

/** One JSON request over PSK. Answers the status and the parsed body (an empty object when it is not JSON). */
export function pskRequest(base: string, tls: ConnectionOptions, method: string, path: string, body: unknown, timeoutMs: number): Promise<{ status: number; json: Record<string, unknown> }> {
	const url = new URL(path, base);
	const payload = body === undefined ? undefined : JSON.stringify(body);
	return new Promise((resolve, reject) => {
		const req = https.request(
			{
				...tls,
				host: url.hostname.replace(/^\[|\]$/g, ""),
				port: Number(url.port),
				path: url.pathname + url.search,
				method,
				agent: false,
				headers: payload === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
				timeout: timeoutMs,
			},
			(res) => {
				let text = "";
				res.setEncoding("utf8");
				res.on("data", (c: string) => (text += c));
				res.on("end", () => {
					let json: Record<string, unknown> = {};
					try {
						json = JSON.parse(text) as Record<string, unknown>;
					} catch {
						// Not JSON: an empty body.
					}
					resolve({ status: res.statusCode ?? 0, json });
				});
			},
		);
		req.on("timeout", () => req.destroy(new Error(`no answer within ${timeoutMs} ms`)));
		req.on("error", reject);
		req.end(payload);
	});
}
