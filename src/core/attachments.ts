// Files and pictures a client uploads for a prompt. Every upload is written to the bot's workspace
// `uploads/` folder as a new file, never over another, and gets an id (the `attachments` table), so the
// client API names what goes with a message, can take one back before sending, and can open any of them
// later. A file that goes with a message is named by its `@file:` reference, and the prompt carries its text
// (as Hermes' agent/context_references.py expands them). Only references this session was given are
// expanded, so typed text never pulls another file into the prompt.
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { basename, extname, isAbsolute, join, relative, sep } from "node:path";
import type { Engine, UserInput } from "../engine/engine.ts";
import { prepareImage } from "../engine/images.ts";
import { logger } from "../log.ts";
import { HostEnvs } from "../remote/hosts.ts";
import type { AppDb } from "../store/db.ts";
import type { Bot, Bots } from "./bots.ts";
import type { Sessions } from "./sessions.ts";
import type { AttachmentRef } from "./turns.ts";

const log = logger("attachments");

export const IMAGE_MAX_BYTES = 25 * 1024 * 1024;
/** Its base64 must fit one WebSocket frame (64 MB, src/server.ts), as a member machine sends it. */
export const FILE_MAX_BYTES = 40 * 1024 * 1024;
export const PDF_MAX_PAGES = 25;
/** Pictures (a PDF's pages count) one message can carry. */
const MAX_IMAGES = 32;
const MAX_FILE_REFS = 16;
/** Pictures prepared at upload are kept this long for the message that sends them. */
const PREPARED_TTL_MS = 15 * 60_000;
const FALLBACK_CONTEXT = 128_000;
const CHARS_PER_TOKEN = 4;

export class AttachmentError extends Error {
	readonly code: number;
	constructor(code: number, message: string) {
		super(message);
		this.code = code;
	}
}

/** Renders a PDF's first pages to PNG; undefined when the renderer is not installed. */
export type PdfRenderer = (pdfPath: string, maxPages: number) => Promise<Buffer[] | undefined>;

type Picture = { data: string; mimeType: string };
type Staged =
	| { kind: "image"; path: string; name: string; picture: Picture }
	| { kind: "pdf"; path: string; name: string; pages: Picture[] };
type Uploaded = { path: string; name: string };

export type AttachmentKind = "image" | "pdf" | "file";

/** An upload as clients see it. */
export type AttachmentInfo = { id: string; kind: AttachmentKind; name: string; mime: string; size: number; pages?: number; sent: boolean };

type AttachmentRow = { id: string; session_id: string; bot: string; path: string; name: string; mime: string; size: number; kind: AttachmentKind; pages: number | null; created_at: number; sent_at: number | null; withdrawn: number };

export type AttachmentsDeps = {
	db: AppDb;
	bots: Bots;
	sessions: () => Sessions;
	engine: Engine;
	renderPdf?: PdfRenderer;
};

export class Attachments {
	private readonly d: AttachmentsDeps;
	/** Each session's `@file:` references, the files they name. */
	private readonly refs = new Map<string, Map<string, Uploaded>>();
	/** Pictures and PDF pages prepared at upload, by id, so sending them soon after does not prepare them again. */
	private readonly prepared = new Map<string, { at: number; staged: Staged }>();

	constructor(deps: AttachmentsDeps) {
		this.d = deps;
	}

	/**
	 * An upload by id (the client API): a picture, a PDF or any other file, by what its bytes are unless `kind`
	 * says. It goes with the message that names its id.
	 */
	async upload(sessionId: string, bytes: Buffer, name?: string, kind?: AttachmentKind): Promise<AttachmentInfo> {
		if (bytes.length === 0) throw new AttachmentError(4015, "The upload is empty.");
		const detected: AttachmentKind = kind ?? (imageType(bytes) ? "image" : isPdf(bytes) ? "pdf" : "file");
		const max = detected === "image" ? IMAGE_MAX_BYTES : FILE_MAX_BYTES;
		if (bytes.length > max) throw new AttachmentError(4017, `This ${detected === "image" ? "picture" : detected === "pdf" ? "PDF" : "file"} is larger than ${max / 1024 / 1024} MB.`);
		let path: string;
		if (detected === "image") {
			const r = await this.storeImage(sessionId, bytes, name);
			path = r.path;
			this.prepared.set(this.rowByPath(sessionId, path)!.id, { at: Date.now(), staged: { kind: "image", path, name: basename(path), picture: r.picture } });
		} else if (detected === "pdf") {
			const r = await this.storePdf(sessionId, bytes, name, MAX_IMAGES);
			path = r.path;
			this.prepared.set(this.rowByPath(sessionId, path)!.id, { at: Date.now(), staged: { kind: "pdf", path, name: basename(path), pages: r.pages } });
		} else {
			path = this.storeFile(sessionId, bytes, name);
		}
		return info(this.rowByPath(sessionId, path)!);
	}

	/** Takes back an upload that has not gone with a message yet: its file is removed. */
	withdraw(sessionId: string, id: string): boolean {
		const row = this.d.db.get<AttachmentRow>("SELECT * FROM attachments WHERE id = ? AND session_id = ? AND withdrawn = 0", id, sessionId);
		if (!row || row.sent_at !== null) return false;
		this.d.db.run("UPDATE attachments SET withdrawn = 1 WHERE id = ?", id);
		this.prepared.delete(id);
		rmSync(row.path, { force: true });
		return true;
	}

	/** An upload of this session by id, if it is still there. */
	get(sessionId: string, id: string): AttachmentInfo | undefined {
		const row = this.d.db.get<AttachmentRow>("SELECT * FROM attachments WHERE id = ? AND session_id = ? AND withdrawn = 0", id, sessionId);
		return row ? info(row) : undefined;
	}

	/** An upload's file, for downloading it. */
	content(id: string): { sessionId: string; path: string; name: string; mime: string } | undefined {
		const row = this.d.db.get<AttachmentRow>("SELECT * FROM attachments WHERE id = ? AND withdrawn = 0", id);
		return row ? { sessionId: row.session_id, path: row.path, name: row.name, mime: row.mime } : undefined;
	}

	/**
	 * Fills in the ids (and what is known) of attachments a chat's history names by path. An upload from before
	 * uploads had ids gets one now, when its file is still in the bot's uploads folder.
	 */
	identify(sessionId: string, refs: AttachmentRef[]): void {
		let root: string | undefined;
		for (const ref of refs) {
			if (!ref.path || ref.id) continue;
			let path = ref.path;
			if (!isAbsolute(path)) {
				try {
					root ??= this.workspace(sessionId);
				} catch {
					return;
				}
				path = join(root, path);
			}
			let row = this.rowByPath(sessionId, path);
			if (!row) {
				try {
					root ??= this.workspace(sessionId);
				} catch {
					return;
				}
				if (!path.startsWith(join(root, "uploads") + sep)) continue;
				let size: number;
				try {
					size = statSync(path).size;
				} catch {
					continue;
				}
				this.record(sessionId, path, ref.kind, ref.kind === "image" ? (MIME[extname(path).toLowerCase()] ?? "application/octet-stream") : mimeOf(path), size, ref.pages ?? null, true);
				row = this.rowByPath(sessionId, path);
			}
			if (row) {
				ref.id = row.id;
				ref.mime = row.mime;
				ref.size = row.size;
				if (row.pages !== null) ref.pages = row.pages;
			}
		}
	}

	/**
	 * Sends a prompt with the uploads it names by id (the client API): the words, a reference line for each
	 * file, then as `submit` does. Pictures are prepared again if the gateway restarted since the upload.
	 */
	async submitWith<R>(sessionId: string, text: string, ids: readonly string[], send: (content: UserInput) => Promise<R>): Promise<R> {
		const staged: Staged[] = [];
		const refs: string[] = [];
		const known = this.refsOf(sessionId);
		for (const id of ids) {
			const row = this.d.db.get<AttachmentRow>("SELECT * FROM attachments WHERE id = ? AND session_id = ? AND withdrawn = 0", id, sessionId);
			if (!row) throw new AttachmentError(4006, `No upload ${id} in this chat (it was taken back, or belongs to another chat).`);
			if (row.kind === "file") {
				const rel = relative(this.workspace(sessionId), row.path).split("\\").join("/");
				const ref = `@file:${refValue(rel)}`;
				known.set(ref, { path: row.path, name: row.name });
				if (!text.includes(ref)) refs.push(ref);
				continue;
			}
			staged.push(await this.preparedOf(row));
		}
		if (staged.reduce((n, a) => n + (a.kind === "image" ? 1 : a.pages.length), 0) > MAX_IMAGES) throw new AttachmentError(4017, `At most ${MAX_IMAGES} pictures can go with one message.`);
		const words = [text.trim(), ...refs].filter(Boolean).join("\n");
		const content = staged.length === 0 && !this.namesUpload(sessionId, words) ? words : await this.compose(sessionId, words, staged);
		const r = await send(content);
		const now = Date.now() / 1000;
		for (const id of ids) {
			this.d.db.run("UPDATE attachments SET sent_at = COALESCE(sent_at, ?) WHERE id = ?", now, id);
			this.prepared.delete(id);
		}
		return r;
	}

	private async preparedOf(row: AttachmentRow): Promise<Staged> {
		const hit = this.prepared.get(row.id);
		if (hit && Date.now() - hit.at < PREPARED_TTL_MS) return hit.staged;
		const bytes = readFileSync(row.path);
		if (row.kind === "image") {
			const type = imageType(bytes);
			const picture = type ? await prepareImage(bytes, type.mime) : undefined;
			if (!picture) throw new AttachmentError(4016, `${row.name} could not be read as a picture.`);
			return { kind: "image", path: row.path, name: row.name, picture: { data: picture.data, mimeType: picture.mimeType } };
		}
		return { kind: "pdf", path: row.path, name: row.name, pages: await this.renderPages(row.path, MAX_IMAGES) };
	}

	private async storeImage(sessionId: string, bytes: Buffer, filename: string | undefined): Promise<{ path: string; picture: Picture }> {
		const type = imageType(bytes);
		if (!type) {
			if (isHeic(bytes)) throw new AttachmentError(4016, "HEIC pictures are not supported here. Send it as a JPEG or PNG.");
			throw new AttachmentError(4016, "That file is not a picture this gateway can read (PNG, JPEG, GIF, WebP or BMP).");
		}
		const picture = await prepareImage(bytes, type.mime);
		if (!picture) throw new AttachmentError(4016, "That picture could not be read or made small enough to send.");
		const path = this.save(sessionId, bytes, withExt(filename, type.ext, "image"));
		this.record(sessionId, path, "image", type.mime, bytes.length, null);
		return { path, picture: { data: picture.data, mimeType: picture.mimeType } };
	}

	private async storePdf(sessionId: string, bytes: Buffer, filename: string | undefined, room: number): Promise<{ path: string; pages: Picture[] }> {
		if (!isPdf(bytes)) throw new AttachmentError(4016, "That file is not a PDF.");
		const path = this.save(sessionId, bytes, withExt(filename, ".pdf", "document"));
		const pages = await this.renderPages(path, room);
		this.record(sessionId, path, "pdf", "application/pdf", bytes.length, pages.length);
		return { path, pages };
	}

	private storeFile(sessionId: string, bytes: Buffer, name: string | undefined): string {
		const path = this.save(sessionId, bytes, cleanName(name) || "attachment");
		this.record(sessionId, path, "file", mimeOf(path), bytes.length, null);
		return path;
	}

	/** A PDF's first pages as pictures for the model, at most `room` of them; none when they cannot be rendered. */
	private async renderPages(path: string, room: number): Promise<Picture[]> {
		const pages: Picture[] = [];
		let rendered: Buffer[] | undefined;
		try {
			rendered = await (this.d.renderPdf ?? renderWithPdftoppm)(path, PDF_MAX_PAGES);
		} catch (error) {
			log.warn("pdf pages could not be rendered", { error: error instanceof Error ? error.message : String(error) });
		}
		for (const png of rendered ?? []) {
			if (pages.length >= room) break;
			const page = await prepareImage(png, "image/png");
			if (page) pages.push({ data: page.data, mimeType: page.mimeType });
		}
		return pages;
	}

	private record(sessionId: string, path: string, kind: AttachmentKind, mime: string, size: number, pages: number | null, sent = false): void {
		const row = this.d.sessions().require(sessionId);
		const now = Date.now() / 1000;
		this.d.db.run(
			"INSERT INTO attachments (id, session_id, bot, path, name, mime, size, kind, pages, created_at, sent_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			`a${randomBytes(8).toString("hex")}`,
			sessionId,
			row.bot,
			path,
			basename(path),
			mime,
			size,
			kind,
			pages,
			now,
			sent ? now : null,
		);
	}

	private rowByPath(sessionId: string, path: string): AttachmentRow | undefined {
		return this.d.db.get<AttachmentRow>("SELECT * FROM attachments WHERE session_id = ? AND path = ? AND withdrawn = 0 ORDER BY created_at DESC LIMIT 1", sessionId, path);
	}

	/** Whether a PDF's pages can be shown to the model as pictures (the doctor's check). */
	pdfPages(): Promise<boolean> {
		return this.d.renderPdf ? Promise.resolve(true) : pdftoppmInstalled();
	}

	private async compose(sessionId: string, text: string, staged: Staged[]): Promise<UserInput> {
		const hints = staged.map((a) =>
			a.kind === "image"
				? `[Image attached at: ${a.path}]`
				: `[PDF attached at: ${a.path} (${a.pages.length > 0 ? `${a.pages.length === PDF_MAX_PAGES ? `the first ${a.pages.length}` : a.pages.length} page${a.pages.length === 1 ? "" : "s"} shown as images` : "its pages could not be shown as images here; use your tools to read it"})]`,
		);
		const words = [text.trim(), hints.join("\n")].filter(Boolean).join("\n\n");
		const content: Exclude<UserInput, string> = [{ type: "text", text: words }];
		const context = await this.attachedContext(sessionId, text);
		if (context) content.push({ type: "text", text: context });
		for (const a of staged) {
			for (const p of a.kind === "image" ? [a.picture] : a.pages) content.push({ type: "image", data: p.data, mimeType: p.mimeType });
		}
		return content;
	}

	/** Hermes' "--- Attached Context ---" block for the uploads the text names, or undefined. */
	private async attachedContext(sessionId: string, text: string): Promise<string | undefined> {
		const files = [...(this.refs.get(sessionId) ?? [])].filter(([ref]) => text.includes(ref)).slice(0, MAX_FILE_REFS);
		if (files.length === 0) return undefined;
		const row = this.d.sessions().require(sessionId);
		const bot = this.d.bots.require(row.bot);
		const window = (await this.d.engine.agentModel(row.conversation_id)).contextWindow || FALLBACK_CONTEXT;
		const hard = Math.floor(window * 0.5);
		const soft = Math.floor(window * 0.25);
		let used = 0;
		const blocks: string[] = [];
		for (const [ref, file] of files) {
			const r = readText(file.path, (hard - used) * CHARS_PER_TOKEN);
			if (r.text === undefined) {
				blocks.push(
					r.binary
						? onDisk(ref, file, bot, r.size, mimeOf(file.name), "binary file, not inlined as text.", "Use your tools to work with it (read or convert it, extract its text, or view/render it as needed); do not tell the user the file type is unsupported.")
						: onDisk(ref, file, bot, r.size, "text file", "too large to inline safely.", "Use your read tool with a narrow line range, or shell tools, to inspect only the relevant parts; do not load the entire file into context."),
				);
				continue;
			}
			const tokens = Math.ceil(r.text.length / CHARS_PER_TOKEN);
			used += tokens;
			const fence = "`".repeat(Math.max(3, longestRun(r.text, "`") + 1));
			blocks.push(`📄 ${ref} (${tokens} tokens)\n${fence}${fenceLanguage(file.name)}\n${r.text}\n${fence}`);
		}
		const warning = used > soft ? `--- Context Warnings ---\n- @ context injection warning: ${used} tokens exceeds the 25% soft limit (${soft}).\n\n` : "";
		return `${warning}--- Attached Context ---\n\n${blocks.join("\n\n")}`;
	}

	private namesUpload(sessionId: string, text: string): boolean {
		for (const ref of this.refs.get(sessionId)?.keys() ?? []) if (text.includes(ref)) return true;
		return false;
	}

	private refsOf(sessionId: string): Map<string, Uploaded> {
		let known = this.refs.get(sessionId);
		if (!known) this.refs.set(sessionId, (known = new Map()));
		while (known.size > 50) known.delete(known.keys().next().value!);
		return known;
	}

	private workspace(sessionId: string): string {
		const bot = this.d.bots.require(this.d.sessions().require(sessionId).bot);
		if (!bot.workspace) throw new AttachmentError(4019, `${bot.displayName} has no folder on this gateway to keep files in.`);
		return realpathSync(bot.workspace);
	}

	/** Writes a new file in the workspace's uploads/ folder: the name as given, or name-2, name-3… */
	private save(sessionId: string, bytes: Buffer, name: string): string {
		const dir = join(this.workspace(sessionId), "uploads");
		mkdirSync(dir, { recursive: true });
		const ext = extname(name);
		const stem = name.slice(0, name.length - ext.length) || "attachment";
		for (let n = 1; ; n++) {
			const path = join(dir, n === 1 ? `${stem}${ext}` : `${stem}-${n}${ext}`);
			let fd: number;
			try {
				fd = openSync(path, "wx", 0o600);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "EEXIST" && n < 10_000) continue;
				throw error;
			}
			try {
				writeSync(fd, bytes);
			} finally {
				closeSync(fd);
			}
			return path;
		}
	}
}

/** Base64, or a base64 data URL, within `max` bytes once decoded. */
export function decode(value: string, max: number, what: string): Buffer {
	const b64 = value.replace(/^data:[^,]*;base64,/i, "").replace(/\s+/g, "");
	if (!b64) throw new AttachmentError(4015, `The ${what} is empty.`);
	if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(b64)) throw new AttachmentError(4018, `The ${what} did not arrive as base64 data.`);
	if (Math.floor((b64.length * 3) / 4) > max + 3) throw new AttachmentError(4017, `This ${what} is larger than ${max / 1024 / 1024} MB.`);
	const bytes = Buffer.from(b64, "base64");
	if (bytes.length === 0) throw new AttachmentError(4015, `The ${what} is empty.`);
	if (bytes.length > max) throw new AttachmentError(4017, `This ${what} is larger than ${max / 1024 / 1024} MB.`);
	return bytes;
}

function imageType(b: Buffer): { mime: string; ext: string } | undefined {
	if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: "image/png", ext: ".png" };
	if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: "image/jpeg", ext: ".jpg" };
	const head = b.subarray(0, 12).toString("latin1");
	if (head.startsWith("GIF87a") || head.startsWith("GIF89a")) return { mime: "image/gif", ext: ".gif" };
	if (head.startsWith("RIFF") && head.slice(8, 12) === "WEBP") return { mime: "image/webp", ext: ".webp" };
	if (head.startsWith("BM")) return { mime: "image/bmp", ext: ".bmp" };
	return undefined;
}

function isPdf(b: Buffer): boolean {
	return b.subarray(0, 5).toString("latin1") === "%PDF-";
}

function info(row: AttachmentRow): AttachmentInfo {
	return { id: row.id, kind: row.kind, name: row.name, mime: row.mime, size: row.size, ...(row.pages !== null ? { pages: row.pages } : {}), sent: row.sent_at !== null };
}

function isHeic(b: Buffer): boolean {
	const box = b.subarray(4, 12).toString("latin1");
	return box.startsWith("ftyp") && /^(heic|heix|hevc|mif1|msf1)/.test(box.slice(4));
}

/**
 * A file name safe to keep: the last path part, no control characters, no square brackets (clients read
 * `[User attached image: <name>]`), no leading dots.
 */
export function cleanName(name: string | undefined): string {
	const last = (name ?? "").split(/[\\/]/).pop() ?? "";
	return last.replace(/[\x00-\x1f\x7f[\]]+/g, "_").trim().replace(/^\.+|\.+$/g, "").slice(0, 120);
}

/** The cleaned name with the extension its contents have (a ".heic" sent as JPEG is saved as ".jpg"). */
function withExt(name: string | undefined, ext: string, fallback: string): string {
	const clean = cleanName(name);
	const stem = clean.slice(0, clean.length - extname(clean).length) || fallback;
	const same = extname(clean).toLowerCase() === ext || (ext === ".jpg" && extname(clean).toLowerCase() === ".jpeg");
	return same ? clean : `${stem}${ext}`;
}

/** Hermes' format_reference_value: quoted when it holds spaces, brackets or quotes. */
function refValue(value: string): string {
	if (!/[\s()[\]{}<>"'`]/.test(value)) return value;
	for (const q of ["`", '"', "'"]) if (!value.includes(q)) return `${q}${value}${q}`;
	return value;
}

/** The file's text, or why it has none: binary, or longer than `maxChars`. */
function readText(path: string, maxChars: number): { text?: string; binary: boolean; size: number } {
	const size = statSync(path).size;
	if (size > maxChars * 4 + 4) return { binary: false, size };
	const bytes = readFileSync(path);
	if (bytes.subarray(0, 4096).includes(0)) return { binary: true, size };
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return { binary: true, size };
	}
	if (text.length > maxChars) return { binary: false, size };
	return { text, binary: false, size };
}

/** Hermes' note for a file not inlined (`_on_disk_reference_block`): where it is and what to do with it. */
function onDisk(ref: string, file: Uploaded, bot: Bot, size: number, descriptor: string, reason: string, guidance: string): string {
	const where = HostEnvs.isRemote(bot)
		? `It is on the gateway machine at \`${file.path}\`, which your tools on the remote host cannot reach; if you need it, ask the user to put it on that host.`
		: `It is available on disk at \`${file.path}\`. ${guidance}`;
	return `📎 ${ref} (${descriptor}, ${formatBytes(size)}) — ${reason} ${where}`;
}

function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const MIME: Record<string, string> = {
	".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp",
	".zip": "application/zip", ".gz": "application/gzip", ".tar": "application/x-tar", ".pdf": "application/pdf",
	".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".xls": "application/vnd.ms-excel",
	".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".doc": "application/msword",
	".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation", ".mp3": "audio/mpeg", ".m4a": "audio/mp4",
	".wav": "audio/wav", ".mp4": "video/mp4", ".mov": "video/quicktime", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
};

function mimeOf(name: string): string {
	return MIME[extname(name).toLowerCase()] ?? "application/octet-stream";
}

const FENCES: Record<string, string> = {
	".py": "python", ".js": "javascript", ".ts": "typescript", ".tsx": "tsx", ".jsx": "jsx", ".json": "json", ".md": "markdown",
	".sh": "bash", ".yml": "yaml", ".yaml": "yaml", ".toml": "toml", ".csv": "csv", ".html": "html", ".css": "css", ".sql": "sql",
	".swift": "swift", ".go": "go", ".rs": "rust", ".xml": "xml",
};

function fenceLanguage(name: string): string {
	return FENCES[extname(name).toLowerCase()] ?? "";
}

function longestRun(text: string, ch: string): number {
	let best = 0;
	let run = 0;
	for (const c of text) {
		run = c === ch ? run + 1 : 0;
		if (run > best) best = run;
	}
	return best;
}

/** Whether `command` (pdftoppm) runs on this gateway's PATH, as the renderer would find it. */
export function pdftoppmInstalled(command = "pdftoppm"): Promise<boolean> {
	return new Promise((resolve) => execFile(command, ["-v"], { timeout: 10_000 }, (error) => resolve(!error)));
}

/** pdftoppm (poppler-utils), as Hermes renders PDF pages: PNG at 150 dpi. */
export const renderWithPdftoppm: PdfRenderer = (pdfPath, maxPages) =>
	new Promise((resolve, reject) => {
		const dir = mkdtempSync(join(tmpdir(), "nh-pdf-"));
		const done = (fn: () => void) => {
			try {
				fn();
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		};
		execFile("pdftoppm", ["-png", "-r", "150", "-f", "1", "-l", String(maxPages), pdfPath, join(dir, "page")], { timeout: 120_000 }, (error) => {
			if (error && (error as NodeJS.ErrnoException).code === "ENOENT") return done(() => resolve(undefined));
			if (error) return done(() => reject(new Error(`pdftoppm failed: ${error.message.split("\n")[0]}`)));
			done(() => resolve(readdirSync(dir).filter((f) => f.endsWith(".png")).sort().map((f) => readFileSync(join(dir, f)))));
		});
	});
