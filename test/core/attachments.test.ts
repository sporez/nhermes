import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { UserInput } from "../../src/engine/engine.ts";
import { AttachmentError, cleanName, decode, pdftoppmInstalled } from "../../src/core/attachments.ts";
import { fauxModels, pngBytes, tempDir, testCore } from "../helpers.ts";

type Block = Exclude<UserInput, string>[number];

async function setup(renderPdf?: (path: string, max: number) => Promise<Buffer[] | undefined>) {
	const { dir, cleanup } = await tempDir();
	const { models } = fauxModels();
	const core = await testCore(dir, { models, renderPdf });
	const s = await core.sessions.create("main");
	const uploads = join(core.bots.require("main").workspace, "uploads");
	/** What `submitWith` would hand the engine. */
	const content = (text: string, ...ids: string[]) => core.attachments.submitWith(s.id, text, ids, async (c) => c);
	const pathOf = (id: string) => core.attachments.content(id)!.path;
	return { core, s, uploads, content, pathOf, done: async () => (await core.close(), await cleanup()) };
}

const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64");

test("a picture is saved under uploads/ and goes with the message that names it, after a line naming its path", async () => {
	const t = await setup();
	try {
		const png = pngBytes(8, 8);
		const r = await t.core.attachments.upload(t.s.id, png, "screen shot.png");
		assert.equal(r.name, "screen shot.png");
		assert.equal(r.kind, "image");
		assert.deepEqual(readFileSync(t.pathOf(r.id)), png);
		const again = await t.core.attachments.upload(t.s.id, png, "screen shot.png");
		assert.equal(again.name, "screen shot-2.png", "never overwrites");
		const content = (await t.content("What are these?", r.id, again.id)) as Block[];
		assert.deepEqual(content.map((b) => b.type), ["text", "image", "image"]);
		assert.equal(content[0]!.type === "text" && content[0]!.text, `What are these?\n\n[Image attached at: ${t.pathOf(r.id)}]\n[Image attached at: ${t.pathOf(again.id)}]`);
		assert.equal(t.core.attachments.get(t.s.id, r.id)?.sent, true);
		assert.equal(await t.content("and now?"), "and now?", "only what a message names goes with it");
	} finally {
		await t.done();
	}
});

test("a picture's name gets the extension of what it is, and a file that is not one can be refused as a picture", async () => {
	const t = await setup();
	try {
		const r = await t.core.attachments.upload(t.s.id, pngBytes(4, 4), "../../IMG_1.HEIC");
		assert.equal(r.name, "IMG_1.png");
		assert.equal(readdirSync(t.uploads).length, 1);
		const noName = await t.core.attachments.upload(t.s.id, pngBytes(4, 4));
		assert.equal(noName.name, "image.png");
		await assert.rejects(t.core.attachments.upload(t.s.id, Buffer.from("just text"), "x.txt", "image"), (e) => e instanceof AttachmentError && e.code === 4016);
		const heic = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypheic"), Buffer.alloc(16)]);
		await assert.rejects(t.core.attachments.upload(t.s.id, heic, "a.heic", "image"), /HEIC/);
	} finally {
		await t.done();
	}
});

test("uploads that are not base64, empty or too large are refused", () => {
	assert.throws(() => decode("", 10, "picture"), (e) => e instanceof AttachmentError && e.code === 4015);
	assert.throws(() => decode("not*base64!", 10, "picture"), (e) => e instanceof AttachmentError && e.code === 4018);
	assert.throws(() => decode(b64(Buffer.alloc(20)), 10, "picture"), (e) => e instanceof AttachmentError && e.code === 4017);
	assert.deepEqual(decode(`data:text/csv;base64,${b64("a,b")}`, 10, "file"), Buffer.from("a,b"));
});

test("names are kept safe: last path part, no control characters or brackets, no leading dots", () => {
	assert.equal(cleanName("../../etc/passwd"), "passwd");
	assert.equal(cleanName("C:\\Users\\x\\report.csv"), "report.csv");
	assert.equal(cleanName("..hidden"), "hidden");
	assert.equal(cleanName("a\nb[c].txt"), "a_b_c_.txt");
	assert.equal(cleanName("résumé 📄.pdf"), "résumé 📄.pdf");
	assert.equal(cleanName(""), "");
});

test("an uploaded text file named in a prompt is put in it; a binary or oversized one gets a note with its path", async () => {
	const t = await setup();
	try {
		const csv = await t.core.attachments.upload(t.s.id, Buffer.from("name,qty\napples,3\n"), "stock list.csv");
		assert.equal(csv.kind, "file");
		const zip = await t.core.attachments.upload(t.s.id, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 1, 2]), "archive.zip");
		const csvRef = "@file:`uploads/stock list.csv`";
		const zipRef = "@file:uploads/archive.zip";
		const content = (await t.content("Count the rows", csv.id, zip.id)) as Block[];
		assert.equal(content.length, 2);
		assert.equal(content[0]!.type === "text" && content[0]!.text, `Count the rows\n${csvRef}\n${zipRef}`, "the words stay as typed, then a line per file");
		const ctx = content[1]!.type === "text" ? content[1]!.text : "";
		assert.match(ctx, /^--- Attached Context ---/);
		assert.ok(ctx.includes("📄 @file:`uploads/stock list.csv` (5 tokens)\n```csv\nname,qty\napples,3\n\n```"), ctx);
		assert.ok(ctx.includes(`📎 @file:uploads/archive.zip (application/zip, 8 B) — binary file, not inlined as text. It is available on disk at \`${t.pathOf(zip.id)}\`.`), ctx);
		// Named again later: expanded again.
		const later = (await t.content(`and again ${csvRef}`)) as Block[];
		assert.equal(later.length, 2);
	} finally {
		await t.done();
	}
});

test("only uploads this session was given are expanded, however the text names other files", async () => {
	const t = await setup();
	try {
		writeFileSync(join(t.core.bots.require("main").workspace, "notes.txt"), "private");
		const other = await t.core.sessions.create("main");
		const theirs = await t.core.attachments.upload(other.id, Buffer.from("their file"), "theirs.txt");
		await t.core.attachments.submitWith(other.id, "", [theirs.id], async (c) => c);
		const text = "@file:notes.txt @file:../secrets.env @file:uploads/theirs.txt";
		assert.equal(await t.content(text), text);
		await assert.rejects(t.content("hi", theirs.id), (e) => e instanceof AttachmentError, "nor can another chat's upload be named by id");
	} finally {
		await t.done();
	}
});

test("a text file larger than half the model's context is not inlined", async () => {
	const t = await setup();
	try {
		// faux-1 has a 128k window by default: 64k tokens is about 256k characters.
		const big = await t.core.attachments.upload(t.s.id, Buffer.from("x".repeat(300_000)), "big.log");
		const content = (await t.content("", big.id)) as Block[];
		const ctx = content[1]!.type === "text" ? content[1]!.text : "";
		assert.match(ctx, /📎 @file:uploads\/big\.log \(text file, 293\.0 KB\) — too large to inline safely\./);
	} finally {
		await t.done();
	}
});

test("a PDF's pages go to the model as pictures; without a renderer the model is told where the file is", async () => {
	const pages = [pngBytes(6, 8), pngBytes(6, 8)];
	const t = await setup(async () => pages);
	try {
		const r = await t.core.attachments.upload(t.s.id, Buffer.from("%PDF-1.7\n..."), "report.pdf");
		assert.equal(r.kind, "pdf");
		assert.equal(r.pages, 2);
		assert.ok(existsSync(t.pathOf(r.id)));
		const content = (await t.content("", r.id)) as Block[];
		assert.deepEqual(content.map((b) => b.type), ["text", "image", "image"]);
		assert.equal(content[0]!.type === "text" && content[0]!.text, `[PDF attached at: ${t.pathOf(r.id)} (2 pages shown as images)]`);
		await assert.rejects(t.core.attachments.upload(t.s.id, Buffer.from("not a pdf"), "x.pdf", "pdf"), /not a PDF/);
	} finally {
		await t.done();
	}
	const n = await setup(async () => undefined);
	try {
		const r = await n.core.attachments.upload(n.s.id, Buffer.from("%PDF-1.7\n..."), "scan.pdf");
		assert.equal(r.pages, 0);
		const content = (await n.content("summarise", r.id)) as Block[];
		assert.equal(content.length, 1);
		assert.equal(content[0]!.type === "text" && content[0]!.text, `summarise\n\n[PDF attached at: ${n.pathOf(r.id)} (its pages could not be shown as images here; use your tools to read it)]`);
	} finally {
		await n.done();
	}
});

test("a missing pdftoppm is noticed; an injected renderer counts as present", async () => {
	assert.equal(await pdftoppmInstalled("nh-no-such-pdftoppm"), false);
	const t = await setup(async () => []);
	try {
		assert.equal(await t.core.attachments.pdfPages(), true);
	} finally {
		await t.done();
	}
});

test("an upload whose message failed to send is still unsent and goes with the next message that names it", async () => {
	const t = await setup();
	try {
		const a = await t.core.attachments.upload(t.s.id, pngBytes(4, 4), "a.png");
		await assert.rejects(t.core.attachments.submitWith(t.s.id, "hi", [a.id], async () => Promise.reject(new Error("offline"))), /offline/);
		assert.equal(t.core.attachments.get(t.s.id, a.id)?.sent, false);
		const content = (await t.content("hi", a.id)) as Block[];
		assert.equal(content.length, 2);
		assert.equal(t.core.attachments.get(t.s.id, a.id)?.sent, true);
	} finally {
		await t.done();
	}
});
