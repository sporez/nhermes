// The `html` card's fragment (docs/API.md "Cards"): a small layout or diagram the bot writes as HTML with inline
// <style> and inline SVG. It is cleaned here, and the app draws it again in a locked-down web view (no page
// scripts, no network), so this is one of two locks. No dependency: the fragment is tokenized, and every tag that
// is kept is written out again from its parsed name and attributes, so what the app sees is what was checked.
//
// Dropped with their content: <script>, <iframe>, <object>, <form>. Dropped as tags: <embed>, <link>, <meta>,
// <base>, and a page's own <html>, <head>, <body>, <!doctype> wrappers (the fragment is only the body's content).
// Dropped attributes: every `on*`; any whose value is a javascript:, vbscript: or data:text/html address; `srcdoc`
// and `srcset`. Addresses: a link's href is kept only when http(s); any other src/href/xlink:href only as `data:`
// or a `#fragment` of the same layout (SVG's <use>). Inline <style> and style="" lose @import and url() unless the
// url is a data: address.

export const MAX_HTML_BYTES = 64 * 1024;

const DROP_WITH_CONTENT = new Set(["script", "iframe", "object", "form"]);
const DROP_TAG = new Set(["embed", "link", "meta", "base", "html", "head", "body"]);
const URL_ATTRS = new Set(["src", "href", "xlink:href", "poster", "background", "data", "action", "formaction", "ping", "cite"]);
const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", colon: ":", tab: "\t", newline: "\n", lpar: "(", rpar: ")" };

/** An attribute value as a parser would see it, for judging its address: entities decoded, controls and spaces gone, lower case. */
function normalized(value: string): string {
	return value
		.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);?/gi, (m, e: string) => {
			if (e[0] === "#") {
				const n = e[1]?.toLowerCase() === "x" ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
				return Number.isFinite(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
			}
			return NAMED[e.toLowerCase()] ?? m;
		})
		// biome-ignore lint/suspicious/noControlCharactersInRegex: browsers ignore these inside an address.
		.replace(/[\u0000-\u0020\u00a0\u1680\u2000-\u200f\u2028\u2029\u202f\u205f\u3000\ufeff]/g, "")
		.toLowerCase();
}

/** Style text without @import or any url() that is not a data: address, and without expression(). */
function cleanCss(css: string): string {
	const text = css.replace(/@import[^;{]*;?/gi, "").replace(/expression\s*\(/gi, "(");
	let out = "";
	let i = 0;
	for (let m = /url\(/gi.exec(text); m; m = /url\(/gi.exec(text.slice(i))) {
		const start = i + m.index;
		out += text.slice(i, start);
		// Read the argument to its matching ")", counting nested parentheses and skipping quoted text.
		let depth = 1;
		let j = start + 4;
		let quote = "";
		for (; j < text.length && depth > 0; j++) {
			const c = text[j]!;
			if (quote) quote = c === quote ? "" : quote;
			else if (c === '"' || c === "'") quote = c;
			else if (c === "(") depth++;
			else if (c === ")") depth--;
		}
		const arg = text.slice(start + 4, depth === 0 ? j - 1 : j).trim().replace(/^(["'])([\s\S]*)\1$/, "$2");
		out += normalized(arg).startsWith("data:") ? text.slice(start, j) : "none";
		i = j;
	}
	return out + text.slice(i);
}

function keepAttribute(tag: string, name: string, value: string): string | undefined {
	if (name.startsWith("on") || name === "srcdoc" || name === "srcset") return undefined;
	const v = normalized(value);
	if (/^(javascript|vbscript):/.test(v) || v.startsWith("data:text/html")) return undefined;
	if (URL_ATTRS.has(name)) {
		if ((name === "href" || name === "xlink:href") && tag === "a") return /^https?:/.test(v) ? value : undefined;
		if (v.startsWith("data:") || (v.startsWith("#") && (name === "href" || name === "xlink:href"))) return value;
		return undefined;
	}
	return name === "style" ? cleanCss(value) : value;
}

/** Attributes of a tag's text after its name: name, then an optional quoted or bare value. */
function attributesOf(rest: string): [string, string][] {
	const out: [string, string][] = [];
	const seen = new Set<string>();
	for (const m of rest.matchAll(/([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
		if (seen.has(m[1]!.toLowerCase())) continue;
		seen.add(m[1]!.toLowerCase());
		out.push([m[1]!, m[2] ?? m[3] ?? m[4] ?? ""]);
	}
	return out;
}

const TAG = /^<(\/?)([a-zA-Z][a-zA-Z0-9:_-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/;

/** Where an element's closing tag ends, counting nested elements of the same name; the end of the text when it never closes. */
function skipElement(html: string, from: number, name: string, nested: boolean): number {
	const re = new RegExp(`<(/?)${name}(?=[\\s/>])[^>]*>`, "gi");
	re.lastIndex = from;
	let depth = 1;
	for (let m = re.exec(html); m; m = re.exec(html)) {
		depth += m[1] ? -1 : nested ? 1 : 0;
		if (depth <= 0) return re.lastIndex;
	}
	return html.length;
}

/** The fragment cleaned as described at the top of this file. */
export function sanitizeHtml(html: string): string {
	let out = "";
	let i = 0;
	while (i < html.length) {
		const lt = html.indexOf("<", i);
		if (lt < 0) {
			out += html.slice(i);
			break;
		}
		out += html.slice(i, lt);
		const rest = html.slice(lt);
		if (rest.startsWith("<!--")) {
			const end = html.indexOf("-->", lt + 4);
			i = end < 0 ? html.length : end + 3;
			continue;
		}
		if (rest.startsWith("<!") || rest.startsWith("<?")) {
			const end = html.indexOf(">", lt);
			i = end < 0 ? html.length : end + 1;
			continue;
		}
		const m = TAG.exec(rest.slice(0, 20_000));
		if (!m) {
			out += "&lt;";
			i = lt + 1;
			continue;
		}
		i = lt + m[0].length;
		const closing = m[1] === "/";
		const written = m[2]!;
		const name = written.toLowerCase();
		if (DROP_WITH_CONTENT.has(name)) {
			if (!closing) i = skipElement(html, i, name, name !== "script" && name !== "iframe");
			continue;
		}
		if (DROP_TAG.has(name)) continue;
		if (closing) {
			out += `</${written}>`;
			continue;
		}
		const selfClosing = /\/\s*$/.test(m[3]!);
		const attrs = attributesOf(selfClosing ? m[3]!.replace(/\/\s*$/, "") : m[3]!).flatMap(([n, v]) => {
			const kept = keepAttribute(name, n.toLowerCase(), v);
			return kept === undefined ? [] : [` ${n}="${kept.replace(/"/g, "&quot;")}"`];
		});
		out += `<${written}${attrs.join("")}${selfClosing ? " /" : ""}>`;
		if (name === "style") {
			const end = skipElement(html, i, "style", false);
			const close = /<\/style[^>]*>$/i.exec(html.slice(i, end));
			out += cleanCss(html.slice(i, close ? end - close[0].length : end)).replace(/<\/?[a-z]/gi, (t) => `&lt;${t.slice(1)}`);
			out += "</style>";
			i = end;
		}
	}
	return out;
}

/** Whether a cleaned fragment draws anything: some text, or an element other than <style>. */
export function drawsAnything(cleaned: string): boolean {
	const rest = cleaned.replace(/<style\b[\s\S]*?<\/style>/gi, "");
	return /<[a-z]/i.test(rest) || rest.replace(/&nbsp;|\s/g, "") !== "";
}
