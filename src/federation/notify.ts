// Notifications a member raises on its own (scheduled jobs, the notify tool, OpenChamber alerts) have no
// transport when only one gateway in the network has push or Pushover set up. This forwards them
// to a member that has one. It is only "ready" when nothing local can deliver, and the receiving route uses the local
// notifier alone, so a notification never travels more than one hop.
import { FederationError, type Members } from "./members.ts";
import { logger, redact } from "../log.ts";
import { type Notification, NotifyError, type Notifier, type OptionalNotifier } from "../notify/notifier.ts";

const log = logger("notify");

const TIMEOUT_MS = 10_000;

export class NetworkNotifier implements OptionalNotifier {
	readonly name = "network";
	private lastGood?: string;

	/** `local` is the notifier this gateway delivers through itself; forwarding is the fallback. */
	private readonly members: () => Members;
	private readonly local: () => Notifier;

	constructor(members: () => Members, local: () => Notifier) {
		this.members = members;
		this.local = local;
	}

	ready(): boolean {
		return this.local().name === "none" && this.members().list().length > 0;
	}

	async send(n: Notification): Promise<void> {
		const members = this.members();
		const list = members.list();
		// The last member that accepted, then the reachable ones, then the rest.
		const rank = (m: { node_id: string; reachable: boolean }) => (m.node_id === this.lastGood ? 0 : m.reachable ? 1 : 2);
		const order = [...list].sort((a, b) => rank(a) - rank(b));
		// A member's session ids mean nothing on another gateway.
		const body = { title: redact(n.title), message: redact(n.message), priority: n.priority, url: n.url, urlTitle: n.urlTitle, bot: n.bot };
		const tried: string[] = [];
		for (const view of order) {
			const row = members.get(view.node_id);
			if (!row) continue;
			try {
				await members.call(row, "/federation/notify", body, "POST", TIMEOUT_MS);
				this.lastGood = row.node_id;
				log.info("notification forwarded", { to: row.name, title: n.title.slice(0, 80) });
				return;
			} catch (error) {
				const why = error instanceof FederationError && error.status === 409 ? "no transport" : error instanceof Error ? error.message : String(error);
				tried.push(`${row.name}: ${why.slice(0, 120)}`);
			}
		}
		throw new NotifyError(`no member could deliver the notification (${tried.join("; ") || "no members"})`);
	}
}
