// Vory's attachments over the wire: image.attach_bytes, pdf.attach and file.attach, then prompt.submit.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createModels, fauxAssistantMessage, fauxProvider, type FauxResponseFactory } from "@earendil-works/pi-ai";
import type { Core } from "../../src/app.ts";
import { userDisplay } from "../../src/core/transcript.ts";
import { type HermesServer, startHermesServer } from "../../src/hermes/server.ts";
import { pngBytes, TOKEN, tempDir, testCore } from "../helpers.ts";
import { HermesClient } from "./client.ts";

const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1", reasoning: true }, { id: "faux-2" }], tokensPerSecond: 400 });
const models = createModels();
models.setProvider(faux.provider);
let core: Core;
let server: HermesServer;
let cleanup: () => Promise<void>;

before(async () => {
	const t = await tempDir();
	cleanup = t.cleanup;
	core = await testCore(t.dir, { models, renderPdf: async () => [pngBytes(10, 14)] });
	server = await startHermesServer(core, { host: "127.0.0.1", port: 0 });
});

after(async () => {
	await server.close();
	await core.close();
	await cleanup();
});

async function chat(): Promise<{ c: HermesClient; sid: string }> {
	const c = await HermesClient.connect(server.port, TOKEN);
	await c.waitEvent("gateway.ready");
	const r = await c.call<{ session_id: string }>("session.create", {});
	return { c, sid: r.session_id };
}

type Part = { type: string; text?: string; data?: string };
/** A faux reply that records the user message the model was given. */
function recording(into: Part[][], reply = "Seen."): FauxResponseFactory {
	return (context) => {
		const last = context.messages.at(-1);
		into.push(last && last.role === "user" ? (typeof last.content === "string" ? [{ type: "text", text: last.content }] : (last.content as Part[])) : []);
		return fauxAssistantMessage(reply);
	};
}

const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64");

test("a picture sent alone reaches the model with a line naming where it was saved", async () => {
	const { c, sid } = await chat();
	try {
		const png = pngBytes(12, 12);
		const seen: Part[][] = [];
		faux.setResponses([recording(seen)]);
		const r = await c.call<Record<string, unknown>>("image.attach_bytes", { session_id: sid, content_base64: b64(png), filename: "IMG_0042.jpg" });
		assert.equal(r.attached, true);
		assert.equal(r.name, "IMG_0042.png");
		assert.equal(r.count, 1);
		assert.equal(r.text, "[User attached image: IMG_0042.png]");
		assert.match(String(r.path), /uploads\/IMG_0042\.png$/);
		const sent = await c.call<{ status: string }>("prompt.submit", { session_id: sid, text: "" });
		assert.equal(sent.status, "streaming");
		await c.waitEvent("message.complete", sid);
		assert.deepEqual(seen[0], [
			{ type: "text", text: `[Image attached at: ${r.path}]` },
			{ type: "image", data: b64(png), mimeType: "image/png" },
		]);
		const empty = await c.call("prompt.submit", { session_id: sid, text: "  " }).catch((e: { code: number }) => e);
		assert.equal((empty as { code: number }).code, -32602, "nothing left waiting: text is required again");
	} finally {
		c.ws.close();
	}
});

test("pictures uploaded while a turn runs go with the queued message", async () => {
	const { c, sid } = await chat();
	try {
		let release!: () => void;
		const held = new Promise<void>((r) => (release = r));
		const seen: Part[][] = [];
		faux.setResponses([async () => (await held, fauxAssistantMessage("First.")), recording(seen, "Second.")]);
		await c.call("prompt.submit", { session_id: sid, text: "first" });
		await c.waitEvent("message.start", sid);
		await c.call("image.attach_bytes", { session_id: sid, data: `data:image/png;base64,${b64(pngBytes(4, 4))}` });
		const queued = await c.call<{ status: string }>("prompt.submit", { session_id: sid, text: "and this one?" });
		assert.equal(queued.status, "queued");
		release();
		await c.waitFor((f) => f.method === "event" && (f.params as { type: string }).type === "message.complete" && JSON.stringify(f.params).includes("Second."));
		assert.deepEqual(seen[0]!.map((p) => p.type), ["text", "image"]);
		assert.match(seen[0]![0]!.text!, /^and this one\?\n\n\[Image attached at: .*uploads\/image\.png\]$/);
	} finally {
		c.ws.close();
	}
});

test("a file comes back as an @file: reference whose text the model gets when the message names it", async () => {
	const { c, sid } = await chat();
	try {
		const seen: Part[][] = [];
		faux.setResponses([recording(seen)]);
		const r = await c.call<Record<string, unknown>>("file.attach", { session_id: sid, data_url: `data:text/csv;base64,${b64("a,b\n1,2\n")}`, name: "data.csv" });
		assert.deepEqual({ ...r, path: undefined }, { attached: true, name: "data.csv", path: undefined, ref_path: "uploads/data.csv", ref_text: "@file:uploads/data.csv", uploaded: true });
		await c.call("prompt.submit", { session_id: sid, text: `Sum column b\n${r.ref_text}` });
		await c.waitEvent("message.complete", sid);
		assert.equal(seen[0]!.length, 2);
		assert.equal(seen[0]![0]!.text, "Sum column b\n@file:uploads/data.csv");
		assert.match(seen[0]![1]!.text!, /^--- Attached Context ---\n\n📄 @file:uploads\/data\.csv \(2 tokens\)\n```csv\na,b\n1,2\n\n```$/);
	} finally {
		c.ws.close();
	}
});

test("a PDF's pages go with the next message", async () => {
	const { c, sid } = await chat();
	try {
		const seen: Part[][] = [];
		faux.setResponses([recording(seen)]);
		const r = await c.call<Record<string, unknown>>("pdf.attach", { session_id: sid, content_base64: b64("%PDF-1.4\n%%EOF\n"), filename: "invoice.pdf" });
		assert.equal(r.attached, true);
		assert.equal(r.filename, "invoice.pdf");
		assert.equal(r.pages_attached, 1);
		await c.call("prompt.submit", { session_id: sid, text: "What is the total?" });
		await c.waitEvent("message.complete", sid);
		assert.deepEqual(seen[0]!.map((p) => p.type), ["text", "image"]);
		assert.match(seen[0]![0]!.text!, /\[PDF attached at: .*uploads\/invoice\.pdf \(1 page shown as images\)\]$/);
	} finally {
		c.ws.close();
	}
});

test("a reopened chat shows pictures as Vory's marks and files as typed, never the files' text", async () => {
	const { c, sid } = await chat();
	try {
		faux.setResponses([fauxAssistantMessage("Two things."), fauxAssistantMessage("And a PDF.")]);
		const img = await c.call<{ name: string }>("image.attach_bytes", { session_id: sid, content_base64: b64(pngBytes(3, 3)), filename: "cat.png" });
		const file = await c.call<{ ref_text: string }>("file.attach", { session_id: sid, data_url: `data:text/plain;base64,${b64("secret recipe")}`, name: "notes.txt" });
		await c.call("prompt.submit", { session_id: sid, text: `Look ${file.ref_text}` });
		await c.waitEvent("message.complete", sid);
		await c.call("pdf.attach", { session_id: sid, content_base64: b64("%PDF-1.4\n"), filename: "plan.pdf" });
		await c.call("prompt.submit", { session_id: sid, text: "" });
		await c.waitFor((f) => f.method === "event" && JSON.stringify(f.params).includes("And a PDF."));
		const snap = await c.call<{ messages: { role: string; text: string }[] }>("session.resume", { session_id: sid });
		const users = snap.messages.filter((m) => m.role === "user").map((m) => m.text);
		assert.deepEqual(users, [`Look @file:uploads/notes.txt\n\n[User attached image: ${img.name}]`, "📎 plan.pdf"]);
		// A PDF whose pages could not be rendered is sent as text alone, and shows the same way.
		const row = { role: "user", content: [{ type: "text", text: "read it\n\n[PDF attached at: /w/uploads/scan.pdf (its pages could not be shown as images here; use your tools to read it)]" }] };
		assert.equal(userDisplay(row.content), "read it\n\n📎 scan.pdf");
		assert.equal(core.sessions.require(sid).title, "Look @file:uploads/notes.txt");
	} finally {
		c.ws.close();
	}
});

test("a chat that starts with only a picture is titled Picture", async () => {
	const { c, sid } = await chat();
	try {
		faux.setResponses([fauxAssistantMessage("A dot.")]);
		await c.call("image.attach_bytes", { session_id: sid, content_base64: b64(pngBytes(3, 3)) });
		await c.call("prompt.submit", { session_id: sid, text: "" });
		const title = await c.waitEvent("session.title", sid);
		assert.equal(title.payload.title, "Picture");
		assert.equal(core.sessions.require(sid).preview, "Picture");
	} finally {
		c.ws.close();
	}
});

test("bad uploads are refused in plain words, and a path on the gateway is never read", async () => {
	const { c, sid } = await chat();
	const fail = (method: string, params: Record<string, unknown>) => c.call(method, { session_id: sid, ...params }).catch((e: { code: number; message: string }) => e) as Promise<{ code: number; message: string }>;
	try {
		assert.equal((await fail("image.attach_bytes", {})).code, 4015);
		assert.equal((await fail("image.attach_bytes", { content_base64: b64("hello") })).code, 4016);
		assert.equal((await fail("image.attach_bytes", { content_base64: "%%%" })).code, 4018);
		assert.equal((await fail("pdf.attach", { content_base64: b64("hello") })).code, 4016);
		assert.equal((await fail("file.attach", { path: "/etc/hosts" })).code, 4016);
		assert.equal((await fail("pdf.attach", { path: "/etc/hosts" })).code, 4016);
		assert.equal((await c.call("image.attach_bytes", { session_id: "nope", content_base64: b64(pngBytes(2, 2)) }).catch((e: { code: number }) => e) as { code: number }).code, 4006);
		assert.equal(core.attachments.pending(sid), 0);
	} finally {
		c.ws.close();
	}
});
