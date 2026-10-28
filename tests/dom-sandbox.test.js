"use strict";
/* DOM sandbox test for the YouTube summarize panel placement.
 *
 * youtube.js is a content-script IIFE, so — following the extraction
 * precedent in smoke.test.js (resolveMaxTokens / formatMs / clampRect) —
 * this test slices the ensurePanel..panelBody region out of the source and
 * evals it in a vm against a minimal tree DOM. The stub DOM supports just
 * enough: children/parentNode, appendChild/append/prepend,
 * insertAdjacentElement('afterend'|'beforebegin'|'beforeend'|'afterbegin'),
 * next/previousElementSibling, contains(), closest(), isConnected, dataset,
 * and querySelector(All) for tag / #id / .class / [attr="v"] / comma lists
 * returning the FIRST MATCH IN DOCUMENT ORDER (real DOM semantics — this
 * matters: the pre-1.0.22 mobile fallback asked
 * querySelector('#player-container-id, #player, ytm-app, #movie_player')
 * and got ytm-app, the ancestor, so the panel landed inside/behind the
 * player subtree instead of after the description).
 *
 * Contract: ok lines + "N failure(s)", exit 1 on failure. No dependencies.
 * Run: node tests/dom-sandbox.test.js
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const EXT = path.join(ROOT, "extension");

let failures = 0;
function ok(name) { console.log("ok - " + name); }
function fail(name, err) { failures++; console.error("FAIL - " + name + ": " + err.message); }
function check(name, fn) { try { fn(); ok(name); } catch (e) { fail(name, e); } }

/* ---------------------------------------------------------- stub DOM --- */

class StubClassList {
  constructor(el) { this._el = el; this._s = new Set(); }
  add(...cs) { cs.forEach((c) => this._s.add(c)); this._sync(); }
  remove(...cs) { cs.forEach((c) => this._s.delete(c)); this._sync(); }
  contains(c) { return this._s.has(c); }
  toggle(c, f) { const on = f === undefined ? !this._s.has(c) : !!f; if (on) this._s.add(c); else this._s.delete(c); this._sync(); return on; }
  _sync() {
    if (this._s.size) this._el._attrs.set("class", [...this._s].join(" "));
    else this._el._attrs.delete("class");
  }
}

let elSeq = 0;
class StubEl {
  constructor(tag) {
    this.tagName = String(tag || "div").toUpperCase();
    this.nodeType = 1;
    this._attrs = new Map();
    this.classList = new StubClassList(this);
    // dataset synced to data-* attributes (dataset.gsYt <-> data-gs-yt).
    const toAttr = (p) => "data-" + String(p).replace(/([A-Z])/g, "-$1").toLowerCase();
    const toProp = (a) => a.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const attrs = this._attrs;
    this.dataset = new Proxy({}, {
      get: (_, p) => {
        if (typeof p !== "string") return undefined;
        const v = attrs.get(toAttr(p));
        return v === undefined ? undefined : v;
      },
      set: (_, p, v) => { attrs.set(toAttr(String(p)), String(v)); return true; },
      deleteProperty: (_, p) => { attrs.delete(toAttr(String(p))); return true; },
      has: (_, p) => typeof p === "string" && attrs.has(toAttr(p)),
      ownKeys: () => [...attrs.keys()].filter((k) => k.startsWith("data-")).map(toProp),
      getOwnPropertyDescriptor: (_, p) => {
        if (typeof p !== "string") return undefined;
        const v = attrs.get(toAttr(p));
        return v === undefined ? undefined : { value: v, writable: true, enumerable: true, configurable: true };
      }
    });
    this.style = {};
    this.children = [];
    this.parentNode = null;
    this._listeners = {};
    this._text = "";
    this._seq = ++elSeq;
  }
  get className() { return this._attrs.get("class") || ""; }
  set className(v) {
    this.classList._s = new Set(String(v || "").split(/\s+/).filter(Boolean));
    this.classList._sync();
  }
  get id() { return this._attrs.get("id") || ""; }
  set id(v) { this._attrs.set("id", String(v)); }
  get isConnected() {
    let n = this;
    while (n) { if (n.nodeType === 9) return true; n = n.parentNode; }
    return false;
  }
  get nextElementSibling() {
    if (!this.parentNode) return null;
    const sibs = this.parentNode.children;
    const i = sibs.indexOf(this);
    return i >= 0 && i + 1 < sibs.length ? sibs[i + 1] : null;
  }
  get previousElementSibling() {
    if (!this.parentNode) return null;
    const sibs = this.parentNode.children;
    const i = sibs.indexOf(this);
    return i > 0 ? sibs[i - 1] : null;
  }
  get textContent() {
    return this._text + this.children.map((c) => c.textContent).join("");
  }
  set textContent(v) {
    this.children.forEach((c) => { c.parentNode = null; });
    this.children = [];
    this._text = String(v == null ? "" : v);
  }
  setAttribute(name, value) {
    if (name === "class") { this.className = value; return; }
    this._attrs.set(name, String(value));
  }
  getAttribute(name) { return this._attrs.has(name) ? this._attrs.get(name) : null; }
  removeAttribute(name) { this._attrs.delete(name); if (name === "class") this.classList._s.clear(); }
  hasAttribute(name) { return this._attrs.has(name); }
  appendChild(node) {
    if (node.parentNode) node.parentNode._detach(node);
    node.parentNode = this;
    this.children.push(node);
    return node;
  }
  _detach(node) {
    const i = this.children.indexOf(node);
    if (i >= 0) this.children.splice(i, 1);
    if (node.parentNode === this) node.parentNode = null;
  }
  append(...nodes) { nodes.forEach((n) => this.appendChild(n)); }
  prepend(node) {
    if (node.parentNode) node.parentNode._detach(node);
    node.parentNode = this;
    this.children.unshift(node);
    return node;
  }
  insertAdjacentElement(position, node) {
    if (position === "beforebegin") {
      if (!this.parentNode) return null;
      const parent = this.parentNode;
      if (node.parentNode) node.parentNode._detach(node);
      node.parentNode = parent;
      parent.children.splice(parent.children.indexOf(this), 0, node);
      return node;
    }
    if (position === "afterend") {
      if (!this.parentNode) return null;
      const parent = this.parentNode;
      if (node.parentNode) node.parentNode._detach(node);
      node.parentNode = parent;
      parent.children.splice(parent.children.indexOf(this) + 1, 0, node);
      return node;
    }
    if (position === "afterbegin") return this.prepend(node);
    if (position === "beforeend") return this.appendChild(node);
    throw new Error("unsupported insertAdjacentElement position: " + position);
  }
  replaceChildren(...nodes) {
    this.children.slice().forEach((c) => this._detach(c));
    this._text = "";
    nodes.forEach((n) => this.appendChild(n));
  }
  addEventListener(type, handler) {
    (this._listeners[type] = this._listeners[type] || []).push(handler);
  }
  removeEventListener() {}
  contains(node) {
    let n = node;
    while (n) { if (n === this) return true; n = n.parentNode; }
    return false;
  }
  closest(selector) {
    let n = this;
    while (n) {
      if (n.nodeType === 1 && matchCompound(n, selector)) return n;
      n = n.parentNode;
    }
    return null;
  }
  querySelector(selector) {
    return queryAll(this, selector, true)[0] || null;
  }
  querySelectorAll(selector) {
    return queryAll(this, selector, false);
  }
}

function matchSimple(el, simple) {
  const s = String(simple).trim();
  // [attr="v"] or [attr]
  const attrMatch = s.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/);
  if (attrMatch) {
    const v = el.getAttribute(attrMatch[1]);
    return attrMatch[2] === undefined ? v !== null : v === attrMatch[2];
  }
  if (s.startsWith("#")) return el.id === s.slice(1);
  if (s.startsWith(".")) return el.classList.contains(s.slice(1));
  return el.tagName === s.toUpperCase();
}

// One compound (no combinators): e.g. tag.class, .a.b, tag#id, [attr].
function matchCompound(el, selector) {
  if (el.nodeType !== 1) return false;
  return String(selector).split(",").some((part) => {
    const tokens = part.trim().match(/([#.][\w-]+|\[[^\]]+\]|[\w-]+|\*)/g) || [];
    if (!tokens.length) return false;
    return tokens.every((tok) => tok === "*" || matchSimple(el, tok));
  });
}

function* walkDescendants(root) {
  for (const child of root.children || []) {
    yield child;
    yield* walkDescendants(child);
  }
}

// First match in document order over descendants of root (browser semantics
// for comma lists: order in the list does NOT matter).
function queryAll(root, selector, firstOnly) {
  const out = [];
  for (const el of walkDescendants(root)) {
    if (matchCompound(el, selector)) {
      out.push(el);
      if (firstOnly) break;
    }
  }
  return out;
}

function makeDocument(rootEl) {
  const doc = new StubEl("#document");
  doc.nodeType = 9;
  doc.tagName = undefined;
  doc.documentElement = rootEl;
  doc.body = null;
  doc.createElement = (tag) => new StubEl(tag);
  doc.appendChild(rootEl);
  const body = queryAll(doc, "body", true)[0];
  doc.body = body || null;
  return doc;
}

/* -------------------------------------------------------- fixture trees --- */

function h(doc, tag, attrs, ...kids) {
  const el = doc.createElement(tag);
  if (attrs) {
    if (attrs.id) el.setAttribute("id", attrs.id);
    if (attrs.class) el.className = attrs.class;
    if (attrs.text) el.textContent = attrs.text;
  }
  kids.flat().forEach((k) => { if (k) el.appendChild(k); });
  return el;
}

// m.youtube.com watch page (tags/ids mirror the real mobile DOM).
// opts: { description: bool, metadata: bool }
function buildMobileDocument(opts) {
  const { description: withDescription = true, metadata: withMetadata = true } = opts || {};
  const doc = makeDocument(new StubEl("html"));
  const moviePlayer = h(doc, "div", { id: "movie_player" },
    h(doc, "video", { class: "html5-main-video" }));
  const player = h(doc, "div", { id: "player" }, moviePlayer);
  const playerContainer = h(doc, "div", { id: "player-container-id" }, player);
  const metaKids = [
    h(doc, "ytm-slim-video-information-renderer", { text: "Video title" }),
    h(doc, "ytm-slim-owner-renderer", { text: "Channel" })
  ];
  let description = null;
  if (withDescription) {
    description = h(doc, "ytm-expandable-video-description-body-renderer", { text: "Description text" });
    metaKids.push(description);
  }
  const metadataSection = withMetadata
    ? h(doc, "ytm-slim-video-metadata-section-renderer", null, metaKids)
    : null;
  const related = h(doc, "ytm-item-section-renderer", { text: "Up next" });
  const resultsKids = metadataSection ? [metadataSection, related] : [related];
  const results = h(doc, "ytm-single-column-watch-next-results-renderer", null, resultsKids);
  const watch = h(doc, "ytm-watch", null, [playerContainer, results]);
  const app = h(doc, "ytm-app", null, [watch]);
  const body = h(doc, "body", null, [app]);
  doc.documentElement.appendChild(body);
  doc.body = body;
  return { doc, app, watch, playerContainer, player, moviePlayer, results, metadataSection, description, related };
}

// Desktop watch page.
function buildDesktopDocument() {
  const doc = makeDocument(new StubEl("html"));
  const meta = h(doc, "ytd-watch-metadata", { text: "Title + description" });
  const below = h(doc, "div", { id: "below" }, meta);
  const primaryInner = h(doc, "div", { id: "primary-inner" }, below);
  const primary = h(doc, "div", { id: "primary" }, primaryInner);
  const columns = h(doc, "div", { id: "columns" }, primary);
  const body = h(doc, "body", null, [columns]);
  doc.documentElement.appendChild(body);
  doc.body = body;
  return { doc, columns, primary, primaryInner, below, meta };
}

/* ------------------------------------------- extract the region under test */

function loadPanelModule() {
  // Slice from the placement ladder through buildPanel: everything the
  // mount/relocate path touches, stopping before panelBody().
  const src = fs.readFileSync(path.join(EXT, "content/youtube.js"), "utf8");
  const start = src.indexOf("const PANEL_PLACEMENTS");
  const end = src.indexOf("function panelBody()");
  assert.ok(start >= 0 && end > start, "panel region markers present in youtube.js");
  const region = src.slice(start, end);
  return { src, region };
}

function makePanelEnv(doc) {
  const { region } = loadPanelModule();
  const sandbox = {
    console, Math, Date, JSON,
    document: doc,
    // panelMutating is declared just above the extracted region in
    // youtube.js; the region reads/writes it during guarded moves.
    panelMutating: false,
    runtime: { sendMessage: () => Promise.resolve({}) },
    location: { href: "https://m.youtube.com/watch?v=sandbox1" },
    summarizeVideo() {}, showChapters() {}, toggleBilingual() {}, sendToSidebar() {}
  };
  vm.createContext(sandbox);
  vm.runInContext(region, sandbox, { filename: "youtube.js(panel-region)" });
  return sandbox;
}

/* ------------------------------------------------------------------ utils */

function docIndex(rootEl, target) {
  let i = 0;
  for (const el of walkDescendants(rootEl)) {
    if (el === target) return i;
    i++;
  }
  return -1;
}

function hasPlayerAncestor(el) {
  let n = el.parentNode;
  while (n) {
    if (n.id && ["player-container-id", "player", "movie_player"].includes(n.id)) return true;
    n = n.parentNode;
  }
  return false;
}

/* ------------------------------------------------------------------ tests */

check("m.youtube.com: panel lands after the description, outside the player", () => {
  const fx = buildMobileDocument({ description: true });
  const env = makePanelEnv(fx.doc);
  const panel = env.ensurePanel();
  assert.ok(panel, "panel created");
  assert.ok(panel.isConnected, "panel is connected to the document");
  assert.ok(!fx.playerContainer.contains(panel), "panel is not inside #player-container-id");
  assert.ok(!hasPlayerAncestor(panel), "panel has no player ancestor");
  const docRoot = fx.doc.documentElement;
  assert.ok(docIndex(docRoot, fx.description) < docIndex(docRoot, panel),
    "panel comes after the description block in document order");
  assert.ok(docIndex(docRoot, fx.metadataSection) < docIndex(docRoot, panel),
    "panel comes after the metadata section");
  assert.ok(docIndex(docRoot, panel) < docIndex(docRoot, fx.related),
    "panel comes before the up-next section");
  assert.ok(["ytm-slim-video-metadata-section-renderer",
    "ytm-expandable-video-description-body-renderer",
    "ytm-single-column-watch-next-results-renderer"].includes(
      (panel.previousElementSibling && panel.previousElementSibling.tagName.toLowerCase()) ||
      (panel.parentNode && panel.parentNode.tagName.toLowerCase())),
    "panel is anchored at the metadata/description level");
});

check("m.youtube.com without description: panel still mounts outside the player", () => {
  const fx = buildMobileDocument({ description: false });
  const env = makePanelEnv(fx.doc);
  const panel = env.ensurePanel();
  assert.ok(panel && panel.isConnected, "panel is connected");
  assert.ok(!fx.playerContainer.contains(panel), "panel is not inside the player");
  assert.ok(!hasPlayerAncestor(panel), "panel has no player ancestor");
  const docRoot = fx.doc.documentElement;
  assert.ok(docIndex(docRoot, fx.metadataSection) < docIndex(docRoot, panel),
    "panel still lands after the metadata section when no description renderer exists");
  assert.ok(docIndex(docRoot, panel) < docIndex(docRoot, fx.related),
    "panel still lands before the up-next section");
});

check("panel upgrades to the metadata anchor when it appears late", () => {
  // No metadata section at first: the panel mounts at a fallback spot.
  const fx = buildMobileDocument({ description: false, metadata: false });
  const env = makePanelEnv(fx.doc);
  const early = env.ensurePanel();
  assert.ok(early.isConnected, "early panel connected");
  assert.ok(early.dataset.gsPlacement !== "0",
    "early panel is at a fallback rank, not the metadata rank");
  // YouTube renders the description lazily: metadata section content
  // arrives after the panel already mounted at a fallback position.
  const lateMeta = h(fx.doc, "ytm-slim-video-metadata-section-renderer", null, [
    h(fx.doc, "ytm-slim-video-information-renderer", { text: "Title" }),
    h(fx.doc, "ytm-expandable-video-description-body-renderer", { text: "Late description" })
  ]);
  fx.results.prepend(lateMeta);
  if (typeof env.relocatePanelIfNeeded === "function") env.relocatePanelIfNeeded();
  const panel = fx.doc.querySelector(".gs-yt-panel");
  assert.strictEqual(panel, early, "same panel node is moved, not rebuilt");
  const docRoot = fx.doc.documentElement;
  assert.ok(docIndex(docRoot, lateMeta) < docIndex(docRoot, panel),
    "panel moved after the late metadata section");
  assert.ok(!fx.playerContainer.contains(panel), "panel still outside the player");
});

check("desktop: panel still lands right after ytd-watch-metadata", () => {
  const fx = buildDesktopDocument();
  const env = makePanelEnv(fx.doc);
  const panel = env.ensurePanel();
  assert.ok(panel && panel.isConnected, "panel connected on desktop tree");
  assert.strictEqual(fx.meta.nextElementSibling, panel,
    "panel is the immediate next sibling of ytd-watch-metadata");
});

/* ------------------------------ search.js markdownLite (Graphite AI Answer)
   search.js is also a content-script IIFE: slice the pure text helpers
   (escapeHtml .. setGeneratedHtml, exclusive) and run markdownLite in a
   vm. Regression target: answers showed raw **, #, -, backticks because
   the old renderer required single-line heading blocks and blocks where
   EVERY line was a list item. */

function loadSearchMarkdown() {
  const src = fs.readFileSync(path.join(EXT, "content/search.js"), "utf8");
  const start = src.indexOf("function escapeHtml");
  const end = src.indexOf("function setGeneratedHtml");
  assert.ok(start >= 0 && end > start, "markdown region markers present in search.js");
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(src.slice(start, end), sandbox, { filename: "search.js(markdown-region)" });
  assert.strictEqual(typeof sandbox.markdownLite, "function", "markdownLite extracted");
  assert.strictEqual(typeof sandbox.inlineMd, "function", "inlineMd extracted");
  return sandbox.markdownLite;
}

check("search markdown: heading renders as a heading element", () => {
  const md = loadSearchMarkdown();
  assert.strictEqual(md("## Summary"), "<h4>Summary</h4>");
  // Heading inside a multi-line block (the old single-line-only failure).
  assert.ok(md("Intro line\n## Summary\nBody text").includes("<h4>Summary</h4>"),
    "heading must render mid-block: " + md("Intro line\n## Summary\nBody text"));
  assert.ok(!md("## Summary").includes("#"), "no raw # markers remain");
});

check("search markdown: paragraph with bold and an inline link", () => {
  const md = loadSearchMarkdown();
  const html = md("This is **bold** and [a link](https://x.example/path) here.");
  assert.ok(html.includes("<strong>bold</strong>"), "bold rendered: " + html);
  assert.ok(html.includes('<a href="https://x.example/path"'), "link rendered: " + html);
  assert.ok(html.includes(">a link</a>"), "link label: " + html);
  assert.ok(!html.includes("**") && !html.includes("]("), "no raw markdown remains: " + html);
});

check("search markdown: mixed intro paragraph + bullet list splits per group", () => {
  const md = loadSearchMarkdown();
  const html = md("Here are the key points:\n- First **point**\n- Second point\n\nConcluding line.");
  assert.ok(html.includes("<p>Here are the key points:</p>"), "intro is its own paragraph: " + html);
  assert.ok(html.includes("<ul><li>First <strong>point</strong></li><li>Second point</li></ul>"),
    "consecutive bullets form one list: " + html);
  assert.ok(html.includes("<p>Concluding line.</p>"), "trailing text is a paragraph: " + html);
  assert.ok(!/(^|>)- /.test(html), "no raw bullet markers remain: " + html);
});

check("search markdown: numbered list renders as <ol>", () => {
  const md = loadSearchMarkdown();
  const html = md("Steps:\n1. Do A\n2. Do B");
  assert.ok(html.includes("<ol><li>Do A</li><li>Do B</li></ol>"), "ordered list: " + html);
  assert.ok(!html.includes("1. Do A"), "no raw numbering remains: " + html);
  // A single list line is still a list (old code required >1 line).
  assert.ok(md("- Only one").includes("<ul><li>Only one</li></ul>"), "single bullet: " + md("- Only one"));
});

check("search markdown: inline code span is escaped and not re-interpreted", () => {
  const md = loadSearchMarkdown();
  const html = md("Run `npm install <pkg>` and keep `**literal**` literal");
  assert.ok(html.includes("<code>npm install &lt;pkg&gt;</code>"), "code span escaped: " + html);
  assert.ok(html.includes("<code>**literal**</code>"), "markers inside code stay literal: " + html);
  assert.ok(!html.includes("<pkg>"), "no tag injected from code span: " + html);
});

check("search markdown: fenced code block renders as <pre><code>, content escaped", () => {
  const md = loadSearchMarkdown();
  const html = md("Before:\n\n```js\nconst a = \"<b>\";\n**not bold**\n```\n\nAfter");
  assert.ok(html.includes("<pre><code>"), "pre/code block: " + html);
  assert.ok(html.includes("&lt;b&gt;"), "fence content escaped: " + html);
  assert.ok(!html.includes("<b>"), "no markup from fence content: " + html);
  assert.ok(!html.includes("<strong>not bold</strong>"), "no emphasis inside fence: " + html);
  assert.ok(!html.includes("```"), "no raw fences remain: " + html);
  assert.ok(html.includes("<p>After</p>"), "text after the fence is a paragraph: " + html);
});

check("search markdown: <script> in the source stays escaped and inert", () => {
  const md = loadSearchMarkdown();
  const html = md("<script>alert(1)</script> and <img src=x onerror=alert(1)> with **safe** text");
  assert.ok(!html.includes("<script"), "no live script tag: " + html);
  assert.ok(!html.includes("<img"), "no live img tag: " + html);
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"), "script shown as inert text: " + html);
  assert.ok(html.includes("<strong>safe</strong>"), "surrounding markdown still renders: " + html);
  // Unsafe link targets never become anchors.
  const bad = md("[click](javascript:alert(1))");
  assert.ok(!bad.includes("<a "), "javascript: URL not linked: " + bad);
});

check("search markdown: blockquote and horizontal rule render", () => {
  const md = loadSearchMarkdown();
  const html = md("> quoted **line**\n> second line\n\n---\n\nAfter the rule");
  assert.ok(html.includes("<blockquote>quoted <strong>line</strong><br>second line</blockquote>"),
    "blockquote: " + html);
  assert.ok(html.includes("<hr>"), "horizontal rule: " + html);
  assert.ok(!html.includes("&gt; quoted") && !html.includes("\n---"), "no raw markers remain: " + html);
});

check("search markdown: GFM pipe table renders as a table", () => {
  const md = loadSearchMarkdown();
  const html = md("Results:\n\n| Name | Value |\n| --- | --- |\n| Alpha | **1** |\n| Beta | 2 |\n\nDone.");
  assert.ok(html.includes("<table><thead><tr><th>Name</th><th>Value</th></tr></thead>"), "table head: " + html);
  assert.ok(html.includes("<td><strong>1</strong></td>"), "cell inline markdown renders: " + html);
  assert.ok(html.includes("<td>Beta</td><td>2</td>"), "body rows: " + html);
  assert.ok(!html.includes("| --- |"), "no raw pipe rows remain: " + html);
  assert.ok(html.includes("<p>Done.</p>"), "text after the table is a paragraph: " + html);
});

/* ------------------------------ lib/captions.js (GraphiteCaptions) --------
   The whole caption lib is a pure IIFE: run it in a vm and exercise the
   parser against VTT/SRT inputs the way the sidebar Videos tab does. */

function loadCaptions() {
  const src = fs.readFileSync(path.join(EXT, "lib/captions.js"), "utf8");
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: "captions.js" });
  assert.ok(sandbox.GraphiteCaptions, "GraphiteCaptions global exported");
  return sandbox.GraphiteCaptions;
}

check("captions: WebVTT with header metadata, NOTE/STYLE blocks, cue ids", () => {
  const C = loadCaptions();
  const vtt = "WEBVTT - demo captions\n" +
    "Kind: captions\nLanguage: en\n\n" +
    "NOTE this is ignored\nanother note line\n\n" +
    "STYLE\n::cue { color: lime }\n\n" +
    "intro-cue\n00:00:01.500 --> 00:00:04.000 align:start\nHello <b>world</b>\n\n" +
    "00:00:05.000 --> 00:00:07.250\nSecond &amp; final &lt;line&gt;\n";
  const segs = C.parseCues(vtt);
  assert.strictEqual(segs.length, 2, "two cues parsed, got " + segs.length);
  assert.strictEqual(segs[0].start, 1.5, "first start in seconds");
  assert.strictEqual(segs[0].dur, 2.5, "first duration");
  assert.strictEqual(segs[0].text, "Hello world", "tags stripped from cue text");
  assert.strictEqual(segs[1].text, "Second & final <line>", "entities decoded");
  assert.ok(!segs.some((s) => /NOTE|STYLE|cue \{/.test(s.text)), "header blocks skipped");
});

check("captions: SRT with cue numbers and comma decimals", () => {
  const C = loadCaptions();
  const srt = "1\n00:00:00,500 --> 00:00:03,000\nFirst line\n\n2\n00:00:04,000 --> 00:00:06,500\nSecond line\n";
  const segs = C.parseCues(srt);
  assert.strictEqual(segs.length, 2);
  assert.strictEqual(segs[0].start, 0.5);
  assert.strictEqual(segs[0].dur, 2.5);
  assert.strictEqual(segs[1].start, 4);
  assert.strictEqual(segs[1].text, "Second line");
});

check("captions: roll-up duplicates collapse, empty/garbage input stays empty", () => {
  const C = loadCaptions();
  const rolling = "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello\n\n" +
    "00:00:02.000 --> 00:00:03.000\nHello world\n\n" +
    "00:00:03.000 --> 00:00:04.000\nHello world\n";
  const segs = C.parseCues(rolling);
  // Note: no deepStrictEqual across the vm boundary (different Array ctor).
  assert.strictEqual(segs.map((s) => s.text).join("|"), "Hello world", "roll-up merges into the fullest text");
  assert.strictEqual(segs[0].start, 1, "merged segment keeps the first start time");
  assert.strictEqual(segs[0].dur, 3, "merged segment spans the whole roll-up");
  assert.strictEqual(C.parseCues("").length, 0, "empty input");
  assert.strictEqual(C.parseCues("not a caption file at all").length, 0, "garbage input");
  assert.strictEqual(C.parseCues(null).length, 0, "null input");
});

check("captions: fromTrackCues normalises TextTrack cue records", () => {
  const C = loadCaptions();
  const segs = C.fromTrackCues([
    { startTime: 61, endTime: 63.5, text: "At one minute" },
    { startTime: 0, endTime: 2, text: "Start" },
    { startTime: 2, endTime: 2, text: "" }
  ]);
  assert.strictEqual(segs.length, 2, "sorted and empties dropped");
  assert.strictEqual(segs[0].text, "Start", "sorted by start");
  assert.strictEqual(segs[1].start, 61);
  assert.strictEqual(segs[1].dur, 2.5);
});

check("captions: segmentsToText formats timestamps, plain mode drops them", () => {
  const C = loadCaptions();
  const segs = [{ start: 65, dur: 2, text: "One oh five" }, { start: 3661, dur: 1, text: "Hour mark" }];
  assert.strictEqual(C.segmentsToText(segs, true), "[01:05] One oh five\n[1:01:01] Hour mark");
  assert.strictEqual(C.segmentsToText(segs, false), "One oh five\nHour mark");
  assert.strictEqual(C.formatTimestamp(0), "00:00");
  assert.strictEqual(C.formatTimestamp(3599), "59:59");
});

check("captions: parseTimestamp accepts hh:mm:ss, mm:ss, comma and ms forms", () => {
  const C = loadCaptions();
  assert.strictEqual(C.parseTimestamp("01:02:03.500"), 3723.5);
  assert.strictEqual(C.parseTimestamp("02:03,250"), 123.25);
  assert.strictEqual(C.parseTimestamp("00:07"), 7);
  assert.ok(Number.isNaN(C.parseTimestamp("nope")), "garbage is NaN");
});

/* ----------------------- lib/audio-extract.js (GraphiteAudioExtract) -----
   Pure WAV codec: run the lib in a vm with a Blob shim and a fake
   AudioBuffer, the way the content script uses it after decodeAudioData. */

function loadAudioExtract() {
  const src = fs.readFileSync(path.join(EXT, "lib/audio-extract.js"), "utf8");
  const sandbox = {
    Float32Array: Float32Array, ArrayBuffer: ArrayBuffer, DataView: DataView,
    Math: Math, Number: Number,
    Blob: class {
      constructor(parts, opts) {
        this.parts = parts || [];
        this.type = (opts && opts.type) || "";
        this.size = this.parts.reduce((n, p) => n + (p.byteLength != null ? p.byteLength : (p.length || 0)), 0);
      }
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: "audio-extract.js" });
  assert.ok(sandbox.GraphiteAudioExtract, "GraphiteAudioExtract global exported");
  return sandbox.GraphiteAudioExtract;
}

function fakeAudioBuffer(channels, sampleRate, seconds) {
  const len = Math.floor(sampleRate * seconds);
  const data = channels.map((gain, ci) => {
    const arr = new Float32Array(len);
    for (let i = 0; i < len; i++) arr[i] = Math.sin(i / 10 + ci) * gain;
    return arr;
  });
  return {
    numberOfChannels: channels.length, sampleRate: sampleRate, length: len,
    duration: seconds,
    getChannelData: (i) => data[i]
  };
}

check("audio-extract: downmix averages channels, resample halves 48k->16k by ratio 3", () => {
  const A = loadAudioExtract();
  const buf = fakeAudioBuffer([1, 0.5], 48000, 0.1);
  const mono = A.downmixDecodeAudioBuffer(buf);
  assert.strictEqual(mono.length, 4800, "downmix keeps frame count");
  const expectedAvg = (buf.getChannelData(0)[0] * 1 + buf.getChannelData(1)[0]) / 2;
  assert.ok(Math.abs(mono[0] - expectedAvg) < 1e-6, "first frame is the channel average");
  assert.ok(Math.abs(mono[0]) > 0.1, "fixture channel 1 starts at sin(1) != 0 (guards the old vacuous check)");
  const res = A.resampleMonoSamples(new Float32Array([0, 0.3, 0.6, 0.9, 0, 0]), 48000, 16000);
  assert.strictEqual(res.length, 2, "48k->16k keeps every third sample");
  assert.ok(Math.abs(res[0] - 0) < 1e-6 && Math.abs(res[1] - 0.9) < 1e-6, "resampled values");
  const same = A.resampleMonoSamples(new Float32Array([1, 2]), 16000, 16000);
  assert.strictEqual(same.length, 2, "same-rate resample is a copy");
});

check("audio-extract: WAV size estimate matches the encoder", () => {
  const A = loadAudioExtract();
  assert.strictEqual(A.estimatePcm16WavSize(1, 16000), 44 + 32000, "1s mono 16k PCM16");
  assert.strictEqual(A.estimatePcm16WavSize(0, 16000), 44, "empty is header only");
  const wav = A.renderToWavBlob(fakeAudioBuffer([1], 16000, 1), {});
  assert.strictEqual(wav.size, A.estimatePcm16WavSize(1, 16000), "encoder byte count matches estimate");
  assert.strictEqual(wav.type, "audio/wav", "wav mime");
});

check("audio-extract: chunks stay under the base64 ceiling and keep timing", () => {
  const A = loadAudioExtract();
  const chunks = A.renderWavBlobInChunks(fakeAudioBuffer([1], 16000, 30), {});
  assert.ok(chunks.length >= 2, "30s at 16kHz needs multiple chunks, got " + chunks.length);
  chunks.forEach((c, i) => {
    assert.ok(A._b64CharsForBytes(c.size) <= A.DEFAULT_MAX_B64_CHARS,
      "chunk " + i + " base64 fits the ceiling");
    assert.strictEqual(c.size, 44 + Math.round(c.dur * 16000) * 2, "chunk size matches its duration");
    if (i) assert.ok(Math.abs(c.start - (chunks[i - 1].start + chunks[i - 1].dur)) < 0.001, "chunks are contiguous");
  });
  const totalDur = chunks.reduce((n, c) => n + c.dur, 0);
  assert.ok(Math.abs(totalDur - 30) < 0.01, "chunk durations cover the whole buffer");
});

check("audio-extract: MP3 chunks are valid audio/mpeg and ~8x smaller than WAV", () => {
  const A = loadAudioExtract();
  const chunks = A.renderMp3BlobInChunks(fakeAudioBuffer([1, 0.5], 48000, 10), {});
  assert.ok(chunks.length >= 1, "mp3 chunks produced");
  const totalBytes = chunks.reduce((n, c) => n + c.size, 0);
  const wavBytes = A.estimatePcm16WavSize(10, 16000);
  assert.ok(totalBytes < wavBytes / 4, "mp3 (" + totalBytes + "B) is far smaller than wav (" + wavBytes + "B)");
  chunks.forEach((c, i) => {
    assert.strictEqual(c.blob.type, "audio/mpeg", "chunk " + i + " is audio/mpeg");
    assert.ok(A._b64CharsForBytes(c.size) <= A.DEFAULT_MAX_B64_CHARS, "chunk " + i + " fits the ceiling");
    // MP3 frame sync: 0xFFE* header at offset 0.
    const buf = c.blob.parts[0];
    assert.ok(buf[0] === 0xFF && (buf[1] & 0xE0) === 0xE0, "chunk " + i + " starts with an MP3 sync word");
  });
  const totalDur = chunks.reduce((n, c) => n + c.dur, 0);
  assert.ok(Math.abs(totalDur - 10) < 0.01, "mp3 chunk durations cover the buffer");
});

/* ----------------------- lib/manifests.js (GraphiteManifests) ----------
   HLS/DASH separate-audio-track discovery: the manifest's compressed
   audio rendition is what the background fetches for transcription. */

function loadManifests() {
  const src = fs.readFileSync(path.join(EXT, "lib/manifests.js"), "utf8");
  const sandbox = { URL: URL, Math: Math, Number: Number, RegExp: RegExp, String: String };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: "manifests.js" });
  assert.ok(sandbox.GraphiteManifests, "GraphiteManifests global exported");
  return sandbox.GraphiteManifests;
}

check("manifests: HLS master picks the DEFAULT audio rendition, media lists segments", () => {
  const M = loadManifests();
  const base = "https://cdn.example.com/v/123/master.m3u8";
  const master = [
    "#EXTM3U",
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,URI="audio/en.m3u8"',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Spanish",LANGUAGE="es",DEFAULT=NO,URI="audio/es.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=800000,AUDIO="aud"',
    "video/360.mp4.m3u8",
    ""
  ].join("\n");
  const pick = M.parseHlsMaster(master, base);
  assert.strictEqual(pick.url, "https://cdn.example.com/v/123/audio/en.m3u8");
  assert.strictEqual(pick.lang, "en");
  const media = [
    "#EXTM3U", "#EXT-X-TARGETDURATION:6", '#EXT-X-MAP:URI="init.mp4"',
    "#EXTINF:6.0,", "seg1.m4s", "#EXTINF:6.0,", "../seg2.m4s", "#EXT-X-ENDLIST", ""
  ].join("\n");
  const parsed = M.parseHlsMedia(media, "https://cdn.example.com/v/123/audio/en.m3u8");
  assert.strictEqual(parsed.init, "https://cdn.example.com/v/123/audio/init.mp4");
  assert.strictEqual(parsed.segments.length, 2);
  assert.strictEqual(parsed.segments[1], "https://cdn.example.com/v/123/seg2.m4s");
  assert.ok(M.isHls(master) && M.looksLikeHlsUrl(base) && !M.looksLikeDashUrl(base));
  assert.strictEqual(M.parseHlsMaster("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv.m3u8\n", base), null, "no audio group -> null");
});

check("manifests: DASH picks the audio AdaptationSet and expands its segments", () => {
  const M = loadManifests();
  const mpd = [
    '<?xml version="1.0"?>',
    '<MPD mediaPresentationDuration="PT0H1M0S"><Period>',
    '<AdaptationSet mimeType="video/mp4"><Representation id="v1" bandwidth="800000">',
    '<SegmentTemplate timescale="1000" duration="4000" media="v/$Number$.m4s" initialization="v/init.mp4"/></Representation></AdaptationSet>',
    '<AdaptationSet mimeType="audio/mp4" lang="en"><Representation id="a1" bandwidth="64000">',
    '<SegmentTemplate timescale="1000" duration="4000" media="a/$Number%03d$.m4s" initialization="a/init-$RepresentationID$.mp4"/></Representation></AdaptationSet>',
    "</Period></MPD>"
  ].join("\n");
  const audio = M.parseDashAudio(mpd, "https://cdn.example.com/dash/manifest.mpd");
  assert.ok(audio, "audio adaptation found");
  assert.strictEqual(audio.init, "https://cdn.example.com/dash/a/init-a1.mp4");
  assert.strictEqual(audio.segments.length, 15, "60s / 4s segments");
  assert.strictEqual(audio.segments[0], "https://cdn.example.com/dash/a/001.m4s");
  assert.strictEqual(audio.mimeType, "audio/mp4");
  const noAudio = mpd.replace('mimeType="audio/mp4" lang="en"', 'mimeType="text/vtt"');
  // text/vtt set has no audio codecs either, so it must not be picked.
  assert.strictEqual(M.parseDashAudio(noAudio, "https://cdn.example.com/dash/manifest.mpd"), null);
});

check("manifests: resolveUrl handles relative, root and protocol-relative refs", () => {
  const M = loadManifests();
  assert.strictEqual(M.resolveUrl("https://a.b/c/d.m3u8", "e/f.m3u8"), "https://a.b/c/e/f.m3u8");
  assert.strictEqual(M.resolveUrl("https://a.b/c/d.m3u8", "/x.m3u8"), "https://a.b/x.m3u8");
  assert.strictEqual(M.resolveUrl("https://a.b/c/d.m3u8", "//cdn.b/x.m3u8"), "https://cdn.b/x.m3u8");
  assert.strictEqual(M.resolveUrl("https://a.b/c/d.m3u8", "https://z.b/x.m3u8"), "https://z.b/x.m3u8");
  assert.strictEqual(M.resolveUrl("https://a.b/c/d/e.m3u8", "../x.m3u8"), "https://a.b/c/x.m3u8");
});

check("audio-extract: explicit secondsPerChunk and source-rate resampling", () => {
  const A = loadAudioExtract();
  const chunks = A.renderWavBlobInChunks(fakeAudioBuffer([1, 1], 48000, 3), { secondsPerChunk: 1 });
  assert.strictEqual(chunks.length, 3, "one chunk per second");
  assert.ok(chunks.every((c) => Math.abs(c.dur - 1) < 0.001), "each chunk is one second at the target rate");
  assert.strictEqual(chunks[1].start, 1, "second chunk starts at 1s");
});

/* ---------------------------------------------------------------- summary */

console.log(failures === 0 ? "\nall dom-sandbox tests passed" : "\n" + failures + " failure(s)");
process.exit(failures ? 1 : 0);
