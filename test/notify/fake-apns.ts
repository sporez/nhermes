// A stand-in for Apple's push service (HTTP/2, POST /3/device/<token>) for tests: it answers 200, or 410
// Unregistered for a token it was told is gone, and keeps what it was sent, for waiters.
import { EventEmitter } from "node:events";
import { createServer, type Http2Server, type IncomingHttpHeaders } from "node:http2";
import type { AddressInfo } from "node:net";

export type Sent = { headers: IncomingHttpHeaders; body: { aps: Record<string, unknown> & { alert: { title: string; body: string } }; nh: Record<string, string> } };

export class FakeApns {
	readonly sent: Sent[] = [];
	readonly gone = new Set<string>();
	private readonly events = new EventEmitter();
	readonly server: Http2Server;
	private constructor(server: Http2Server) {
		this.server = server;
	}

	static async start(): Promise<FakeApns> {
		const server = createServer();
		const f = new FakeApns(server);
		server.on("stream", (stream, headers) => {
			let data = "";
			stream.setEncoding("utf8");
			stream.on("data", (c: string) => (data += c));
			stream.on("end", () => {
				const token = String(headers[":path"]).split("/").at(-1)!;
				if (f.gone.has(token)) {
					stream.respond({ ":status": 410 });
					stream.end(JSON.stringify({ reason: "Unregistered" }));
				} else {
					stream.respond({ ":status": 200 });
					stream.end();
				}
				const sent = { headers, body: JSON.parse(data) as Sent["body"] };
				f.sent.push(sent);
				f.events.emit("sent", sent);
			});
		});
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
		return f;
	}

	get url(): string {
		return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
	}

	/** The first push (from now on, or already sent) that matches. */
	next(pred: (s: Sent) => boolean): Promise<Sent> {
		const hit = this.sent.find(pred);
		if (hit) return Promise.resolve(hit);
		return new Promise((resolve) => {
			const on = (s: Sent) => {
				if (!pred(s)) return;
				this.events.off("sent", on);
				resolve(s);
			};
			this.events.on("sent", on);
		});
	}

	close(): Promise<void> {
		return new Promise((r) => this.server.close(() => r()));
	}
}
