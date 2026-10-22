// What a bot's tools may not reach: this gateway's own control panel (it has no password by design, so
// a request from the gateway machine itself would act as the owner) and the gateway's own files via
// file:// URLs. Shared by the web and browser tools, and by MCP servers (which may not be the gateway).
import { lookup } from "node:dns/promises";
import { realpathSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { fileURLToPath } from "node:url";

export const PANEL_REFUSED = "this gateway's control panel can't be used from a bot's tools";
export const FILE_REFUSED = "that file belongs to the gateway itself; it can't be opened in the browser";

const isPanelPath = (pathname: string) => /^\/panel(\/|$)/i.test(pathname);

/** Cheap, synchronous test: could this URL be the panel at all (any host)? */
export function maybePanelUrl(url: string): boolean {
	try {
		return isPanelPath(new URL(url).pathname);
	} catch {
		return false;
	}
}

function isThisMachine(addr: string, own: Set<string>): boolean {
	const a = addr.toLowerCase().replace(/^::ffff:/, "");
	return /^127\./.test(a) || a === "::1" || a === "::" || a === "0.0.0.0" || own.has(a);
}

/** True when `url` addresses /panel on one of this gateway's own ports, on this machine. */
export async function isOwnPanel(url: string, ports: readonly number[]): Promise<boolean> {
	let u: URL;
	try {
		u = new URL(url);
	} catch {
		return false;
	}
	if (!isPanelPath(u.pathname)) return false;
	return isOwnGateway(url, ports);
}

/** True when `url` addresses any path on one of this gateway's own ports, on this machine (an MCP server must not be the gateway itself). */
export async function isOwnGateway(url: string, ports: readonly number[]): Promise<boolean> {
	let u: URL;
	try {
		u = new URL(url);
	} catch {
		return false;
	}
	if (!/^https?:$/.test(u.protocol)) return false;
	const port = Number(u.port || (u.protocol === "https:" ? 443 : 80));
	if (!ports.includes(port)) return false;
	const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
	if (host === "localhost" || host.endsWith(".localhost")) return true;
	const own = new Set(Object.values(networkInterfaces()).flatMap((l) => l ?? []).map((i) => i.address.toLowerCase().replace(/%.*$/, "")));
	try {
		const found = await lookup(host, { all: true });
		return found.some((f) => isThisMachine(f.address, own));
	} catch {
		return false;
	}
}

/** True when `url` is a file:// URL inside the gateway's own folders (`gatewayFiles` is policy's pattern). */
export function isGatewayFileUrl(url: string, gatewayFiles: RegExp): boolean {
	let u: URL;
	try {
		u = new URL(url);
	} catch {
		return false;
	}
	if (u.protocol !== "file:") return false;
	let path: string;
	try {
		path = fileURLToPath(u);
	} catch {
		return true;
	}
	const re = new RegExp(gatewayFiles.source, "i");
	if (re.test(path)) return true;
	try {
		return re.test(realpathSync(path));
	} catch {
		return false;
	}
}
