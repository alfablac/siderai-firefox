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

/* ---------------------------------------------------------------- summary */

console.log(failures === 0 ? "\nall dom-sandbox tests passed" : "\n" + failures + " failure(s)");
process.exit(failures ? 1 : 0);
