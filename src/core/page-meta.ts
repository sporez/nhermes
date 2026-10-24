// What a fetched HTML page says about itself (`web_fetch`'s structured result, shown as a Page card): its title,
// description, site name and picture, read from <title>, Open Graph tags and <meta name="description">. Regex-light
// and bounded: only the first 256 KB are looked at, only <meta> tags are scanned, and nothing here throws, so a
// strange page never fails the fetch.

const SCAN_CHARS = 256 * 1024;
const MAX = { title: 200, description: 500, siteName: 100, image: 2000 };

export type PageMeta = { title?: string; description?: string; siteName?: string; image?: string };

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function decode(s: string): string {
	return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
		if (e[0] === "#") {
			const n = e[1]?.toLowerCase() === "x" ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
			return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
		}
		return ENTITIES[e.toLowerCase()] ?? m;
	});
}
const clean = (s: string | undefined, max: number): string | undefined => {
	const t = s === undefined ? "" : decode(s).replace(/\s+/g, " ").trim();
	if (!t) return undefined;
	return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** The attributes of one tag's text, names lower-cased. */
function attributes(tag: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const m of tag.matchAll(/([a-z_:][-a-z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi)) out[m[1]!.toLowerCase()] ??= m[2] ?? m[3] ?? m[4] ?? "";
	return out;
}

/** The page's own details; empty when it gives none. `base` is the page's final address, for a relative picture. */
export function pageMeta(html: string, base: string): PageMeta {
	try {
		const head = html.slice(0, SCAN_CHARS);
		const meta = new Map<string, string>();
		for (const m of head.matchAll(/<meta\s[^>]*>/gi)) {
			const a = attributes(m[0]);
			const key = (a.property ?? a.name ?? "").toLowerCase();
			if (key && a.content !== undefined && !meta.has(key)) meta.set(key, a.content);
		}
		const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1];
		const out: PageMeta = {};
		const title = clean(meta.get("og:title") ?? titleTag, MAX.title) ?? clean(titleTag, MAX.title);
		const description = clean(meta.get("og:description") ?? meta.get("description"), MAX.description);
		const siteName = clean(meta.get("og:site_name"), MAX.siteName);
		let image: string | undefined;
		const rawImage = clean(meta.get("og:image"), MAX.image);
		if (rawImage) {
			const u = new URL(rawImage, base);
			if (u.protocol === "http:" || u.protocol === "https:") image = u.toString();
		}
		if (title) out.title = title;
		if (description) out.description = description;
		if (siteName) out.siteName = siteName;
		if (image && image.length <= MAX.image) out.image = image;
		return out;
	} catch {
		return {};
	}
}
