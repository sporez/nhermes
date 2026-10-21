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
	/** What `submit` would hand the engine. */
	const content = (text: string) => core.attachments.submit(s.id, text, async (c) => c);
	return { core, s, uploads, content, done: async () => (await core.close(), await cleanup()) };
}

const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64");

test("a picture is saved under uploads/ and goes with the next prompt only, after a line naming its path", async () => {
	const t = await setup();
	try {
		const png = pngBytes(8, 8);
		const r = await t.core.attachments.image(t.s.id, b64(png), "screen shot.png");
		assert.equal(r.name, "screen shot.png");
		assert.equal(r.count, 1);
		assert.deepEqual(readFileSync(r.path), png);
		const again = await t.core.attachments.image(t.s.id, `data:image/png;base64,${b64(png)}`, "screen shot.png");
		assert.equal(again.name, "screen shot-2.png", "never overwrites");
		assert.equal(again.count, 2);
		const content = (await t.content("What are these?")) as Block[];
		assert.deepEqual(content.map((b) => b.type), ["text", "image", "image"]);
		assert.equal(content[0]!.type === "text" && content[0]!.text, `What are these?\n\n[Image attached at: ${r.path}]\n[Image attached at: ${again.path}]`);
		assert.equal(t.core.attachments.pending(t.s.id), 0);
		assert.equal(await t.content("and now?"), "and now?", "taken by one prompt");
	} finally {
		await t.done();
	}
});

test("a picture's name gets the extension of what it is, and only pictures are taken", async () => {
	const t = await setup();
	try {
		const r = await t.core.attachments.image(t.s.id, b64(pngBytes(4, 4)), "../../IMG_1.HEIC");
		assert.equal(r.name, "IMG_1.png");
		assert.equal(readdirSync(t.uploads).length, 1);
		const noName = await t.core.attachments.image(t.s.id, b64(pngBytes(4, 4)));
		assert.equal(noName.name, "image.png");
		await assert.rejects(t.core.attachments.image(t.s.id, b64("just text")), (e) => e instanceof AttachmentError && e.code === 4016);
		const heic = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypheic"), Buffer.alloc(16)]);
		await assert.rejects(t.core.attachments.image(t.s.id, b64(heic)), /HEIC/);
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
		const csv = t.core.attachments.file(t.s.id, `data:text/csv;base64,${b64("name,qty\napples,3\n")}`, "stock list.csv");
		assert.equal(csv.ref, "@file:`uploads/stock list.csv`");
		const zip = t.core.attachments.file(t.s.id, b64(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 1, 2])), "archive.zip");
		assert.equal(zip.ref, "@file:uploads/archive.zip");
		const content = (await t.content(`Count the rows\n${csv.ref}\n${zip.ref}`)) as Block[];
		assert.equal(content.length, 2);
		assert.equal(content[0]!.type === "text" && content[0]!.text, `Count the rows\n${csv.ref}\n${zip.ref}`, "the words stay as typed");
		const ctx = content[1]!.type === "text" ? content[1]!.text : "";
		assert.match(ctx, /^--- Attached Context ---/);
		assert.ok(ctx.includes("📄 @file:`uploads/stock list.csv` (5 tokens)\n```csv\nname,qty\napples,3\n\n```"), ctx);
		assert.ok(ctx.includes(`📎 @file:uploads/archive.zip (application/zip, 8 B) — binary file, not inlined as text. It is available on disk at \`${zip.path}\`.`), ctx);
		// Named again later: expanded again.
		const later = (await t.content(`and again ${csv.ref}`)) as Block[];
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
		const theirs = t.core.attachments.file(other.id, b64("their file"), "theirs.txt");
		const text = `@file:notes.txt @file:../secrets.env ${theirs.ref}`;
		assert.equal(await t.content(text), text);
	} finally {
		await t.done();
	}
});

test("a text file larger than half the model's context is not inlined", async () => {
	const t = await setup();
	try {
		// faux-1 has a 128k window by default: 64k tokens is about 256k characters.
		const big = t.core.attachments.file(t.s.id, b64("x".repeat(300_000)), "big.log");
		const content = (await t.content(big.ref)) as Block[];
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
		const r = await t.core.attachments.pdf(t.s.id, b64("%PDF-1.7\n..."), "report.pdf");
		assert.equal(r.pages, 2);
		assert.equal(r.count, 2);
		assert.ok(existsSync(r.path));
		const content = (await t.content("")) as Block[];
		assert.deepEqual(content.map((b) => b.type), ["text", "image", "image"]);
		assert.equal(content[0]!.type === "text" && content[0]!.text, `[PDF attached at: ${r.path} (2 pages shown as images)]`);
		await assert.rejects(t.core.attachments.pdf(t.s.id, b64("not a pdf")), /not a PDF/);
	} finally {
		await t.done();
	}
	const n = await setup(async () => undefined);
	try {
		const r = await n.core.attachments.pdf(n.s.id, b64("%PDF-1.7\n..."), "scan.pdf");
		assert.equal(r.pages, 0);
		const content = (await n.content("summarise")) as Block[];
		assert.equal(content.length, 1);
		assert.equal(content[0]!.type === "text" && content[0]!.text, `summarise\n\n[PDF attached at: ${r.path} (its pages could not be shown as images here; use your tools to read it)]`);
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

test("what was taken for a prompt that failed to send waits for the next one", async () => {
	const t = await setup();
	try {
		await t.core.attachments.image(t.s.id, b64(pngBytes(4, 4)), "a.png");
		await assert.rejects(t.core.attachments.submit(t.s.id, "hi", async () => Promise.reject(new Error("offline"))), /offline/);
		assert.equal(t.core.attachments.pending(t.s.id), 1);
		const content = (await t.content("hi")) as Block[];
		assert.equal(content.length, 2);
	} finally {
		await t.done();
	}
});
