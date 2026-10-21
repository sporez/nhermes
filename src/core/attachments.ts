// Files and pictures a client uploads for the next prompt (Vory's image.attach_bytes, pdf.attach and
// file.attach, as Hermes' tui_gateway/prompt_attachments.py does them). Every upload is written to the
// bot's workspace `uploads/` folder as a new file, never over another. Pictures and rendered PDF pages wait
// here, in memory, until the session's next prompt takes them; uploaded files are remembered by the
// `@file:` reference handed back, and that prompt (or a later one naming it) gets their text, as Hermes'
// agent/context_references.py expands them. Only references this session was given are expanded, so typed
// text never pulls another file into the prompt.
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join, relative } from "node:path";
import type { Engine, UserInput } from "../engine/engine.ts";
import { prepareImage } from "../engine/images.ts";
import { logger } from "../log.ts";
import { HostEnvs } from "../remote/hosts.ts";
import type { Bot, Bots } from "./bots.ts";
import type { Sessions } from "./sessions.ts";

const log = logger("attachments");

export const IMAGE_MAX_BYTES = 25 * 1024 * 1024;
/** Its base64 must fit one WebSocket frame (64 MB, src/hermes/server.ts). */
export const FILE_MAX_BYTES = 40 * 1024 * 1024;
export const PDF_MAX_PAGES = 25;
const MAX_STAGED_IMAGES = 32;
const MAX_FILE_REFS = 16;
/** Staged pictures nobody sent (the prompt never came) are dropped after this long. */
const STAGED_TTL_MS = 15 * 60_000;
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
type SessionUploads = { staged: Staged[]; stagedAt: number; files: Map<string, Uploaded> };

export type AttachmentsDeps = {
	bots: Bots;
	sessions: () => Sessions;
	engine: Engine;
	renderPdf?: PdfRenderer;
};

export class Attachments {
	private readonly d: AttachmentsDeps;
	private readonly bySession = new Map<string, SessionUploads>();

	constructor(deps: AttachmentsDeps) {
		this.d = deps;
	}

	/** A picture for the next prompt: saved to uploads/, shrunk to the model limits. */
	async image(sessionId: string, base64: string, filename?: string): Promise<{ path: string; name: string; count: number; bytes: number }> {
		const bytes = decode(base64, IMAGE_MAX_BYTES, "picture");
		const type = imageType(bytes);
		if (!type) {
			if (isHeic(bytes)) throw new AttachmentError(4016, "HEIC pictures are not supported here. Send it as a JPEG or PNG.");
			throw new AttachmentError(4016, "That file is not a picture this gateway can read (PNG, JPEG, GIF, WebP or BMP).");
		}
		const s = this.uploads(sessionId);
		if (this.imageCount(s) >= MAX_STAGED_IMAGES) throw new AttachmentError(4017, `At most ${MAX_STAGED_IMAGES} pictures can go with one message.`);
		const picture = await prepareImage(bytes, type.mime);
		if (!picture) throw new AttachmentError(4016, "That picture could not be read or made small enough to send.");
		const path = this.save(sessionId, bytes, withExt(filename, type.ext, "image"));
		this.stage(s, { kind: "image", path, name: basename(path), picture: { data: picture.data, mimeType: picture.mimeType } });
		return { path, name: basename(path), count: this.imageCount(s), bytes: bytes.length };
	}

	/** A PDF for the next prompt: saved to uploads/, its first pages shown to the model as pictures when they can be rendered. */
	async pdf(sessionId: string, base64: string, filename?: string): Promise<{ path: string; name: string; pages: number; count: number }> {
		const bytes = decode(base64, FILE_MAX_BYTES, "PDF");
		if (bytes.subarray(0, 5).toString("latin1") !== "%PDF-") throw new AttachmentError(4016, "That file is not a PDF.");
		const s = this.uploads(sessionId);
		const path = this.save(sessionId, bytes, withExt(filename, ".pdf", "document"));
		const pages: Picture[] = [];
		let rendered: Buffer[] | undefined;
		try {
			rendered = await (this.d.renderPdf ?? renderWithPdftoppm)(path, PDF_MAX_PAGES);
		} catch (error) {
			log.warn("pdf pages could not be rendered", { error: error instanceof Error ? error.message : String(error) });
		}
		for (const png of rendered ?? []) {
			if (this.imageCount(s) + pages.length >= MAX_STAGED_IMAGES) break;
			const page = await prepareImage(png, "image/png");
			if (page) pages.push({ data: page.data, mimeType: page.mimeType });
		}
		this.stage(s, { kind: "pdf", path, name: basename(path), pages });
		return { path, name: basename(path), pages: pages.length, count: this.imageCount(s) };
	}

	/** Any other file: saved to uploads/; the reference names it in a prompt, which then carries its text. */
	file(sessionId: string, base64: string, name?: string): { path: string; name: string; ref: string; refPath: string } {
		const bytes = decode(base64, FILE_MAX_BYTES, "file");
		const path = this.save(sessionId, bytes, cleanName(name) || "attachment");
		const refPath = relative(this.workspace(sessionId), path).split("\\").join("/");
		const ref = `@file:${refValue(refPath)}`;
		const s = this.uploads(sessionId);
		s.files.set(ref, { path, name: basename(path) });
		while (s.files.size > 50) s.files.delete(s.files.keys().next().value!);
		return { path, name: basename(path), ref, refPath };
	}

	/** Whether a PDF's pages can be shown to the model as pictures (the doctor's check). */
	pdfPages(): Promise<boolean> {
		return this.d.renderPdf ? Promise.resolve(true) : pdftoppmInstalled();
	}

	/** Pictures and PDFs waiting for this session's next prompt. */
	pending(sessionId: string): number {
		const s = this.bySession.get(sessionId);
		if (s && Date.now() - s.stagedAt > STAGED_TTL_MS) s.staged = [];
		return s?.staged.length ?? 0;
	}

	/**
	 * Sends a prompt with what is waiting: the words and a line per picture or PDF (Hermes' `[Image attached
	 * at: <path>]`), the text of uploaded files it names, and the pictures. What was taken is put back if
	 * `send` fails.
	 */
	async submit<R>(sessionId: string, text: string, send: (content: UserInput) => Promise<R>): Promise<R> {
		if (this.pending(sessionId) === 0 && !this.namesUpload(sessionId, text)) return send(text);
		const s = this.uploads(sessionId);
		const staged = s.staged;
		s.staged = [];
		try {
			return await send(await this.compose(sessionId, text, staged));
		} catch (error) {
			s.staged = [...staged, ...s.staged];
			throw error;
		}
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
		const files = [...(this.bySession.get(sessionId)?.files ?? [])].filter(([ref]) => text.includes(ref)).slice(0, MAX_FILE_REFS);
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
		for (const ref of this.bySession.get(sessionId)?.files.keys() ?? []) if (text.includes(ref)) return true;
		return false;
	}

	private uploads(sessionId: string): SessionUploads {
		let s = this.bySession.get(sessionId);
		if (!s) {
			s = { staged: [], stagedAt: Date.now(), files: new Map() };
			this.bySession.set(sessionId, s);
		}
		return s;
	}

	private stage(s: SessionUploads, a: Staged): void {
		if (Date.now() - s.stagedAt > STAGED_TTL_MS) s.staged = [];
		s.staged.push(a);
		s.stagedAt = Date.now();
	}

	private imageCount(s: SessionUploads): number {
		return s.staged.reduce((n, a) => n + (a.kind === "image" ? 1 : a.pages.length), 0);
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

function isHeic(b: Buffer): boolean {
	const box = b.subarray(4, 12).toString("latin1");
	return box.startsWith("ftyp") && /^(heic|heix|hevc|mif1|msf1)/.test(box.slice(4));
}

/**
 * A file name safe to keep: the last path part, no control characters, no square brackets (Vory reads
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
