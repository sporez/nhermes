// Uploads on the client API: bytes in, an id back; a message names what goes with it; one can be taken back
// before sending; any of them opens later, from history, old chats included.
import assert from "node:assert/strict";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { createModels, fauxAssistantMessage, fauxProvider, type FauxResponseFactory } from "@earendil-works/pi-ai";
import type { Core } from "../../src/app.ts";
import { type GatewayServer, startServer } from "../../src/server.ts";
import { pngBytes, TOKEN, tempDir, testCore } from "../helpers.ts";
import { ApiSocketClient, http } from "./client.ts";

const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1", reasoning: true }], tokensPerSecond: 400 });
const models = createModels();
models.setProvider(faux.provider);
let core: Core;
let server: GatewayServer;
let cleanup: () => Promise<void>;

before(async () => {
	const t = await tempDir();
	cleanup = t.cleanup;
	core = await testCore(t.dir, { models, renderPdf: async () => [pngBytes(10, 14)] });
	server = await startServer(core, { host: "127.0.0.1", port: 0, federationPort: null });
});

after(async () => {
	await server.close();
	await core.close();
	await cleanup();
});

type Part = { type: string; text?: string; data?: string; mimeType?: string };
type Attachment = { id: string; kind: string; name: string; mime: string; size: number; pages?: number; sent: boolean };
type Turn = { id: string; user: { content: { type: string; text?: string; attachment?: Attachment & { path?: string } }[] } };

function recording(into: Part[][], reply = "Seen."): FauxResponseFactory {
	return (context) => {
		const last = context.messages.at(-1);
		into.push(last && last.role === "user" ? (typeof last.content === "string" ? [{ type: "text", text: last.content }] : (last.content as Part[])) : []);
		return fauxAssistantMessage(reply);
	};
}

async function upload(sid: string, bytes: Buffer, name: string, type = "application/octet-stream"): Promise<Response> {
	return fetch(`http://127.0.0.1:${server.port}/api/v1/sessions/${sid}/attachments`, {
		method: "POST",
		headers: { authorization: `Bearer ${TOKEN}`, "content-type": type, "x-filename": encodeURIComponent(name) },
		body: new Uint8Array(bytes),
	});
}

async function chat(): Promise<{ c: ApiSocketClient; sid: string }> {
	const c = await ApiSocketClient.connect(server.port);
	const { session } = await c.call<{ session: { id: string } }>("sessions.create", {});
	await c.call("sessions.subscribe", { id: session.id });
	return { c, sid: session.id };
}

const finished = (sid: string) => (e: { event: string; sessionId?: string }) => e.event === "turn.finished" && e.sessionId === sid;

test("a picture: uploaded as bytes, named by id in the message, seen by the model, and in history with its id", async () => {
	const { c, sid } = await chat();
	const png = pngBytes(12, 12);
	const r = await upload(sid, png, "IMG_0042.jpg", "image/jpeg");
	assert.equal(r.status, 200);
	const { attachment } = (await r.json()) as { attachment: Attachment };
	assert.equal(attachment.kind, "image");
	assert.equal(attachment.name, "IMG_0042.png", "named for what its bytes are");
	assert.equal(attachment.mime, "image/png");
	assert.equal(attachment.size, png.length);
	assert.equal(attachment.sent, false);
	const seen: Part[][] = [];
	faux.setResponses([recording(seen)]);
	await c.call("sessions.submit", { id: sid, content: [{ type: "text", text: "what is this?" }, { type: "attachment", id: attachment.id }] });
	await c.waitEvent(finished(sid));
	assert.equal(seen[0]!.find((p) => p.type === "image")?.data, png.toString("base64"));
	assert.match(seen[0]![0]!.text!, /^what is this\?\n\n\[Image attached at: .+IMG_0042\.png\]$/);
	const started = c.events.find((e) => e.event === "turn.started" && e.sessionId === sid)!;
	const liveBlocks = (started.data.turn as Turn).user.content;
	assert.deepEqual(liveBlocks.map((b) => b.type), ["text", "attachment"]);
	assert.equal(liveBlocks[1]!.attachment!.id, attachment.id, "the live turn names the upload by id");
	assert.equal(liveBlocks[1]!.attachment!.path, undefined, "paths on the gateway stay there");
	const { items } = await http(server.port)<{ items: Turn[] }>(`GET /sessions/${sid}/turns`);
	const block = items.at(-1)!.user.content[1]!;
	assert.equal(block.attachment!.id, attachment.id);
	assert.equal(block.attachment!.kind, "image");
	const down = await fetch(`http://127.0.0.1:${server.port}/api/v1/sessions/${sid}/attachments/${attachment.id}/content`, { headers: { authorization: `Bearer ${TOKEN}` } });
	assert.equal(down.headers.get("content-type"), "image/png");
	assert.deepEqual(Buffer.from(await down.arrayBuffer()), png);
	await c.close();
});

test("a PDF and a text file: pages for the model, the file's text attached, both open from history", async () => {
	const { c, sid } = await chat();
	const pdf = Buffer.from("%PDF-1.4\n% test\n");
	const { attachment: doc } = (await (await upload(sid, pdf, "report.pdf", "application/pdf")).json()) as { attachment: Attachment };
	assert.deepEqual([doc.kind, doc.pages], ["pdf", 1]);
	// Over the socket, as base64 (how a member machine sends one).
	const { attachment: notes } = await c.call<{ attachment: Attachment }>("sessions.attach", { id: sid, name: "notes.md", data: Buffer.from("# Plan\nship it\n").toString("base64") });
	assert.equal(notes.kind, "file");
	const seen: Part[][] = [];
	faux.setResponses([recording(seen)]);
	await c.call("sessions.submit", { id: sid, content: [{ type: "text", text: "read both" }, { type: "attachment", id: doc.id }, { type: "attachment", id: notes.id }] });
	await c.waitEvent(finished(sid));
	const text = seen[0]!.filter((p) => p.type === "text").map((p) => p.text).join("\n");
	assert.match(text, /@file:uploads\/notes\.md/);
	assert.match(text, /--- Attached Context ---[\s\S]*ship it/);
	assert.equal(seen[0]!.filter((p) => p.type === "image").length, 1, "the PDF's page");
	const turn = (await http(server.port)<{ items: Turn[] }>(`GET /sessions/${sid}/turns`)).items.at(-1)!;
	assert.deepEqual(turn.user.content.map((b) => b.type === "text" ? b.text : `${b.attachment!.kind}:${b.attachment!.id}`), ["read both", `pdf:${doc.id}`, `file:${notes.id}`]);
	const file = await c.call<{ name: string; mime: string; data: string }>("attachments.content", { id: sid, attachmentId: notes.id });
	assert.equal(Buffer.from(file.data, "base64").toString(), "# Plan\nship it\n");
	await c.close();
});

test("an upload is taken back before sending; one that went with a message cannot be", async () => {
	const { c, sid } = await chat();
	const { attachment: a } = (await (await upload(sid, pngBytes(8, 8), "a.png", "image/png")).json()) as { attachment: Attachment };
	assert.deepEqual(await http(server.port)(`DELETE /sessions/${sid}/attachments/${a.id}`), { withdrawn: true });
	await assert.rejects(c.call("sessions.submit", { id: sid, content: [{ type: "attachment", id: a.id }] }), (e: { code: string }) => e.code === "invalid_params");
	const gone = await fetch(`http://127.0.0.1:${server.port}/api/v1/sessions/${sid}/attachments/${a.id}/content`, { headers: { authorization: `Bearer ${TOKEN}` } });
	assert.equal(gone.status, 404);
	const { attachment: b } = (await (await upload(sid, pngBytes(8, 8), "b.png", "image/png")).json()) as { attachment: Attachment };
	faux.setResponses([fauxAssistantMessage("ok")]);
	await c.call("sessions.submit", { id: sid, content: [{ type: "attachment", id: b.id }] });
	await c.waitEvent(finished(sid));
	await assert.rejects(http(server.port)(`DELETE /sessions/${sid}/attachments/${b.id}`), (e: { code: string }) => e.code === "conflict");
	// An upload belongs to its chat.
	const other = await chat();
	await assert.rejects(other.c.call("sessions.submit", { id: other.sid, content: [{ type: "attachment", id: b.id }] }), (e: { code: string }) => e.code === "invalid_params");
	await other.c.close();
	await c.close();
});

test("too large is refused before it is kept; a picture the gateway cannot read is kept as a file", async () => {
	const { c, sid } = await chat();
	const big = await upload(sid, Buffer.alloc(41 * 1024 * 1024, 1), "big.bin");
	assert.equal(big.status, 413);
	assert.equal(((await big.json()) as { error: { code: string } }).error.code, "too_large");
	const heic = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypheic"), Buffer.alloc(32)]);
	const { attachment } = (await (await upload(sid, heic, "IMG_1.HEIC", "image/heic")).json()) as { attachment: Attachment };
	assert.equal(attachment.kind, "file");
	const asImage = await fetch(`http://127.0.0.1:${server.port}/api/v1/sessions/${sid}/attachments?kind=image`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` }, body: new Uint8Array(heic) });
	assert.equal(((await asImage.json()) as { error: { code: string } }).error.code, "unsupported_media");
	await c.close();
});

test("a chat from before uploads had ids: its pictures get one when the history is read, and open", async () => {
	const { c, sid } = await chat();
	const png = pngBytes(9, 9);
	const old = join(realpathSync(core.bots.require("main").workspace), "uploads", "old.png");
	mkdirSync(dirname(old), { recursive: true });
	writeFileSync(old, png);
	faux.setResponses([fauxAssistantMessage("ok")]);
	await core.sessions.submit(sid, `[Image attached at: ${old}]`);
	await c.waitEvent(finished(sid));
	const turn = (await http(server.port)<{ items: Turn[] }>(`GET /sessions/${sid}/turns`)).items.at(-1)!;
	const a = turn.user.content.find((b) => b.type === "attachment")!.attachment!;
	assert.match(a.id, /^a[0-9a-f]{16}$/);
	const down = await fetch(`http://127.0.0.1:${server.port}/api/v1/sessions/${sid}/attachments/${a.id}/content`, { headers: { authorization: `Bearer ${TOKEN}` } });
	assert.deepEqual(Buffer.from(await down.arrayBuffer()), png);
	await c.close();
});
