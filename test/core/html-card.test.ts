// The html card's sanitizer (src/core/html-card.ts) and the chart and html cards a bot builds (src/core/card-kinds.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCard, MAX_POINTS } from "../../src/core/card-kinds.ts";
import { sanitizeHtml } from "../../src/core/html-card.ts";

const clean = (html: string) => sanitizeHtml(html);

test("script, iframe, object and form go with their content; embed, link, meta, base and page wrappers go as tags", () => {
	assert.equal(clean("<p>a</p><script>alert(1)</script><p>b</p>"), "<p>a</p><p>b</p>");
	assert.equal(clean("<SCRIPT src=x.js></SCRIPT >hi"), "hi");
	assert.equal(clean("a<script/>stolen</script>b"), "ab", "a slash does not end a script");
	assert.equal(clean("a<script>never closed"), "a");
	assert.equal(clean('a<iframe src="https://example.com">fallback</iframe>b'), "ab");
	assert.equal(clean("a<object data=x><param name=y>inner</object>b"), "ab");
	assert.equal(clean("a<form action=x><input name=q><form>nested</form>tail</form>b"), "ab", "nested forms are skipped whole");
	assert.equal(clean('a<embed src="x">b<link rel=stylesheet href="https://example.com/x.css">c<meta http-equiv=refresh content="0;url=https://example.com">d<base href="https://example.com/">e'), "abcde");
	assert.equal(clean("<!doctype html><html><head><title>T</title></head><body><p>x</p></body></html>"), "<title>T</title><p>x</p>");
	assert.equal(clean("a<!-- <script>x</script> -->b<!--[if IE]><script>y</script><![endif]-->c"), "abc", "comments are dropped");
});

test("on* attributes and javascript: addresses are dropped however they are written", () => {
	assert.equal(clean('<p onclick="x()" ONMOUSEOVER=y() class="k">t</p>'), '<p class="k">t</p>');
	assert.equal(clean('<svg onload="x()"><circle r=1 onfocus=\'z\' /></svg>'), "<svg><circle r=\"1\" /></svg>");
	assert.equal(clean('<a href="javascript:alert(1)">x</a>'), "<a>x</a>");
	assert.equal(clean('<a href=" JaVa\tScRiPt:alert(1)">x</a>'), "<a>x</a>");
	assert.equal(clean('<a href="&#106;avascript:alert(1)">x</a>'), "<a>x</a>");
	assert.equal(clean('<a href="java&Tab;script&colon;alert(1)">x</a>'), "<a>x</a>");
	assert.equal(clean('<a href="vbscript:x" title="javascript:y">x</a>'), "<a>x</a>");
	assert.equal(clean('<svg><animate attributeName="href" to="javascript:alert(1)"/></svg>'), '<svg><animate attributeName="href" /></svg>');
	assert.equal(clean('<div style="background:url(javascript:alert(1))">x</div>'), '<div style="background:none">x</div>');
});

test("images come only as data: addresses; a link keeps only http(s)", () => {
	assert.equal(clean('<img src="https://example.com/a.png" alt="a">'), '<img alt="a">');
	assert.equal(clean('<img src="//example.com/a.png">'), "<img>");
	assert.equal(clean('<img src="data:image/png;base64,AAAA">'), '<img src="data:image/png;base64,AAAA">');
	assert.equal(clean('<image href="https://example.com/a.png"/>'), "<image />");
	assert.equal(clean('<img srcset="https://example.com/a.png 2x" src="data:image/gif;base64,R0lG">'), '<img src="data:image/gif;base64,R0lG">');
	assert.equal(clean('<a href="https://example.com/p?a=1&b=2">x</a>'), '<a href="https://example.com/p?a=1&b=2">x</a>');
	assert.equal(clean('<a href="HTTP://example.com">x</a>'), '<a href="HTTP://example.com">x</a>');
	assert.equal(clean('<a href="/relative">x</a><a href="mailto:a@example.com">y</a><a href="data:text/html,<b>">z</a>'), "<a>x</a><a>y</a><a>z</a>");
	assert.equal(clean('<svg><use href="#shape"/><use href="https://example.com/s.svg#a"/></svg>'), '<svg><use href="#shape" /><use /></svg>');
	assert.equal(clean('<div style="background:url(https://example.com/x.png)">x</div>'), '<div style="background:none">x</div>');
});

test("legit inline <style> and inline <svg> survive, and stray markup is made harmless", () => {
	const ok = '<style>.box{background:var(--nh-surface);color:var(--nh-text);border:1px solid var(--nh-stroke)}</style><div class="box">Hi &amp; bye</div>';
	assert.equal(clean(ok), ok);
	const svg = '<svg viewBox="0 0 100 40" width="100%"><defs><marker id="a"><path d="M0 0L5 2.5L0 5z" fill="var(--nh-accent)"/></marker></defs><rect x="2" y="2" width="40" height="20" rx="4" fill="var(--nh-surface)" stroke="var(--nh-stroke)"/><text x="10" y="15" fill="var(--nh-text)">A</text><path d="M42 12H80" marker-end="url(#a)"/></svg>';
	assert.equal(clean(svg).replace(/ \/>/g, "/>"), svg.replace(/ \/>/g, "/>"));
	assert.equal(clean("<style>@import url(https://example.com/x.css);.a{background:url(data:image/png;base64,AA)}</style>x"), "<style>.a{background:url(data:image/png;base64,AA)}</style>x");
	assert.equal(clean("1 < 2 and <3"), "1 &lt; 2 and &lt;3");
	assert.equal(clean('<p title=\'say "hi"\'>x</p>'), '<p title="say &quot;hi&quot;">x</p>');
});

test("a built html card is cleaned, capped at 64 KB, and refused when nothing is left", () => {
	const card = buildCard({ kind: "html", title: "Flow", html: '<style>p{color:red}</style><script>x()</script><p onclick="y()">Hi</p>', aspect: 99 });
	assert.deepEqual(card, { kind: "html", data: { title: "Flow", html: "<style>p{color:red}</style><p>Hi</p>", aspect: 5 } });
	assert.throws(() => buildCard({ kind: "html", html: "<script>x()</script>" }), /Nothing is left/);
	assert.throws(() => buildCard({ kind: "html", html: "<style>p{}</style>  <!-- c -->" }), /Nothing is left/);
	assert.throws(() => buildCard({ kind: "html", html: "   " }), /needs html/);
	assert.throws(() => buildCard({ kind: "html" }), /needs html/);
	assert.throws(() => buildCard({ kind: "html", html: `<p>${"x".repeat(64 * 1024)}</p>` }), /over 64 KB/);
	assert.ok(buildCard({ kind: "html", html: `<p>${"x".repeat(64 * 1024 - 7)}</p>` }));
	assert.deepEqual(buildCard({ kind: "html", html: "<svg><rect width=1 height=1/></svg>" }).data.html, '<svg><rect width="1" height="1"/></svg>'.replace("\"/>", "\" />"));
});

const chart = (over: Record<string, unknown> = {}) => ({
	kind: "chart",
	title: "Sales",
	type: "bar",
	x: { kind: "category", label: "Month" },
	y: { label: "Revenue", unit: "USD" },
	series: [{ name: "2026", points: [{ x: "Jan", y: 10 }, { x: "Feb", y: 12.5 }] }],
	...over,
});

test("a built chart keeps its checked shape and refuses what the app could not draw", () => {
	assert.deepEqual(buildCard(chart({ subtitle: "q1", notes: "n" })), {
		kind: "chart",
		data: { title: "Sales", subtitle: "q1", type: "bar", x: { label: "Month", kind: "category" }, y: { label: "Revenue", unit: "USD" }, series: [{ name: "2026", points: [{ x: "Jan", y: 10 }, { x: "Feb", y: 12.5 }] }], notes: "n" },
	});
	for (const type of ["bar", "line", "area", "point"]) assert.equal(buildCard(chart({ type })).data.type, type);
	assert.equal(buildCard(chart({ type: "pie" })).kind, "chart");
	assert.throws(() => buildCard(chart({ type: "radar" })), /type must be one of/);
	assert.throws(() => buildCard(chart({ x: { kind: "time" } })), /x\.kind must be one of/);
	assert.throws(() => buildCard(chart({ x: undefined })), /needs x/);
	assert.deepEqual(buildCard(chart({ y: undefined })).data.y, {}, "y is optional");
	// x by kind.
	const dated = (...xs: unknown[]) => chart({ x: { kind: "date" }, series: [{ name: "s", points: xs.map((x) => ({ x, y: 1 })) }] });
	assert.ok(buildCard(dated("2026-10-24", "2026-10-24T09:30:00Z", "2026-10-24T09:30:00.5+02:00")));
	for (const bad of ["24/10/2026", "2026-13-40", "2026-10-24 09:30", "2026-10-24T09:30:00", 5, "Jan"]) assert.throws(() => buildCard(dated(bad)), /YYYY-MM-DD or RFC 3339/, String(bad));
	const numeric = (x: unknown) => chart({ x: { kind: "number" }, series: [{ name: "s", points: [{ x, y: 1 }] }] });
	assert.ok(buildCard(numeric(3.5)));
	assert.throws(() => buildCard(numeric("3")), /x must be a finite number/);
	assert.throws(() => buildCard(numeric(Number.NaN)), /finite/);
	// y and counts.
	const withY = (y: unknown) => chart({ series: [{ name: "s", points: [{ x: "a", y }] }] });
	assert.throws(() => buildCard(withY("5")), /y must be a finite number/);
	assert.throws(() => buildCard(withY(Number.POSITIVE_INFINITY)), /finite/);
	assert.throws(() => buildCard(withY(null)), /finite/);
	const many = (n: number, m: number) => chart({ series: Array.from({ length: n }, (_, i) => ({ name: `s${i}`, points: Array.from({ length: m }, (_, j) => ({ x: `p${j}`, y: j })) })) });
	assert.ok(buildCard(many(6, 50)), "6 series of 50 is exactly 300 points");
	assert.throws(() => buildCard(many(7, 1)), /at most 6 series/);
	assert.throws(() => buildCard(many(6, 51)), new RegExp(`at most ${MAX_POINTS} points`));
	assert.throws(() => buildCard(chart({ series: [] })), /needs series/);
	assert.throws(() => buildCard(chart({ series: [{ name: "s", points: [] }] })), /needs points/);
	assert.throws(() => buildCard(chart({ type: "pie", series: many(2, 1).series })), /exactly one series/);
	// Labels are cut.
	const long = buildCard(chart({ title: "t".repeat(300), x: { kind: "category", label: "l".repeat(300) }, notes: "n".repeat(900), series: [{ name: "s".repeat(300), points: [{ x: "c".repeat(300), y: 1 }] }] })).data as { title: string; notes: string; x: { label: string }; series: { name: string; points: { x: string }[] }[] };
	assert.deepEqual([long.title.length, long.x.label.length, long.notes.length, long.series[0]!.name.length, long.series[0]!.points[0]!.x.length], [200, 200, 500, 200, 200]);
});
