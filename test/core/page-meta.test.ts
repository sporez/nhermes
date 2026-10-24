// A fetched page's title, description, site name and picture (src/core/page-meta.ts), from HTML fixtures. No network.
import assert from "node:assert/strict";
import { test } from "node:test";
import { pageMeta } from "../../src/core/page-meta.ts";

const BASE = "https://example.com/blog/post";

test("Open Graph tags win; the picture is made absolute; entities are decoded", () => {
	const html = `<html><head><title>Plain title</title>
		<meta property="og:title" content="Fish &amp; Chips: a review">
		<meta property="og:description" content='Crisp, "golden" &#39;n&#x27; good'>
		<meta property="og:site_name" content="Example Eats">
		<meta property="og:image" content="/img/a.png">
		<meta name="description" content="Meta description"></head><body></body></html>`;
	assert.deepEqual(pageMeta(html, BASE), { title: "Fish & Chips: a review", description: `Crisp, "golden" 'n' good`, siteName: "Example Eats", image: "https://example.com/img/a.png" });
});

test("without og tags it falls back to <title> and meta description, and says nothing it was not told", () => {
	assert.deepEqual(pageMeta(`<title>\n  Hello   world </title><meta name="description" content="About it">`, BASE), { title: "Hello world", description: "About it" });
	assert.deepEqual(pageMeta("<html><body>No head at all</body></html>", BASE), {});
	assert.deepEqual(pageMeta("", BASE), {});
});

test("long values are cut, a picture that is not http(s) is dropped, and nothing throws on junk", () => {
	const long = pageMeta(`<title>${"t".repeat(500)}</title><meta name="description" content="${"d".repeat(900)}">`, BASE);
	assert.equal(long.title?.length, 200);
	assert.equal(long.description?.length, 500);
	assert.equal(pageMeta(`<meta property="og:image" content="javascript:alert(1)">`, BASE).image, undefined);
	assert.equal(pageMeta(`<meta property="og:image" content="data:image/png;base64,AAAA">`, BASE).image, undefined);
	assert.deepEqual(pageMeta(`<meta property="og:image" content="http://[bad">`, BASE), {}, "an unparsable address is skipped, not thrown");
	assert.deepEqual(pageMeta("<meta <title <<<>>> content=", BASE), {});
});

test("only the first 256 KB are scanned", () => {
	assert.deepEqual(pageMeta(`${" ".repeat(300 * 1024)}<title>Late</title>`, BASE), {});
});
