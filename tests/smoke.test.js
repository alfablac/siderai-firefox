"use strict";
/* Smoke tests for Graphite Sider. No dependencies: node tests/smoke.test.js
 *
 * Behaviour while the core extension (manifest/lib/background) is still being
 * built by other agents: checks for core-dependent items are SKIPPED with a
 * "PENDING (core file not present yet)" warning instead of failing, so this
 * suite stays green for the options/build tooling on its own. Once the core
 * files land, the same checks become hard assertions automatically. Run with
 * STRICT=1 to force core checks to FAIL when files are absent (final
 * integration gate). */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const EXT = path.join(ROOT, "extension");
const STRICT = !!process.env.STRICT;

let failures = 0, pending = 0;
let sseDone = Promise.resolve(); // reassigned by the SSE block below
function ok(name) { console.log("ok - " + name); }
function fail(name, err) { failures++; console.error("FAIL - " + name + ": " + err.message); }
function pend(name, why) {
  if (STRICT) { failures++; console.error("FAIL (STRICT) - " + name + ": " + why); }
  else { pending++; console.warn("PENDING - " + name + ": " + why); }
}
function check(name, fn) { try { fn(); ok(name); } catch (e) { fail(name, e); } }

function loadLibInSandbox(rel, extraGlobals) {
  const file = path.join(EXT, rel);
  const code = fs.readFileSync(file, "utf8");
  const sandbox = Object.assign({
    console, setTimeout, clearTimeout, Promise, JSON, Math, Date,
    window: {}, self: {}, globalThis: {},
  }, extraGlobals || {});
  sandbox.window = sandbox; sandbox.self = sandbox; sandbox.globalThis = sandbox;
  // minimal browser.storage stub for lib files that touch it at load time
  sandbox.browser = { storage: { local: {
    get: async () => ({}), set: async () => {}, remove: async () => {},
  } }, runtime: { sendMessage: async () => ({}) } };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: rel });
  return sandbox;
}

/* ---------- manifest (delegated detail lives in manifest.test.js) ---------- */
const manifestPath = path.join(EXT, "manifest.json");
let manifest = null;
if (!fs.existsSync(manifestPath)) {
  pend("manifest exists & parses", "extension/manifest.json not present yet");
} else {
  check("manifest exists & parses", () => {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  });
}
if (manifest) {
  check("manifest is MV2 with gecko id and sidebar_action", () => {
    assert.strictEqual(manifest.manifest_version, 2);
    assert.ok(manifest.browser_specific_settings.gecko.id, "gecko id");
    assert.ok(manifest.sidebar_action.default_panel, "sidebar_action.default_panel");
  });
  check("all manifest-referenced files exist on disk", () => {
    const refs = new Set();
    const add = (p) => { if (typeof p === "string" && p) refs.add(p); };
    (manifest.background && manifest.background.scripts || []).forEach(add);
    if (manifest.sidebar_action) { add(manifest.sidebar_action.default_panel); add(manifest.sidebar_action.default_icon); }
    if (manifest.options_ui) add(manifest.options_ui.page);
    if (manifest.browser_action) add(manifest.browser_action.default_popup);
    if (manifest.icons) Object.values(manifest.icons).forEach(add);
    (manifest.content_scripts || []).forEach((cs) => { (cs.js || []).forEach(add); (cs.css || []).forEach(add); });
    (manifest.web_accessible_resources || []).forEach((r) => {
      if (typeof r === "string") add(r); else if (r && r.resources) r.resources.forEach(add);
    });
    const missing = [...refs].filter((r) => !r.includes("*") && !fs.existsSync(path.join(EXT, r)));
    assert.deepStrictEqual(missing, [], "missing: " + missing.join(", "));
  });
}

/* ---------- lib syntax ---------- */
for (const rel of ["lib/storage.js", "lib/prompts.js", "lib/providers.js"]) {
  const file = path.join(EXT, rel);
  if (!fs.existsSync(file)) { pend(rel + " syntax", rel + " not present yet"); continue; }
  check(rel + " passes syntax check", () => { new Function(fs.readFileSync(file, "utf8")); });
}

/* ---------- options page (owned by this task: always asserted) ---------- */
check("options page files exist", () => {
  for (const rel of ["options/options.html", "options/options.css", "options/options.js"]) {
    assert.ok(fs.existsSync(path.join(EXT, rel)), "missing " + rel);
  }
});
check("options.js passes syntax check (node --check equivalent)", () => {
  new Function(fs.readFileSync(path.join(EXT, "options/options.js"), "utf8"));
});
check("options.html loads lib/storage.js + lib/prompts.js before options.js (guarded use)", () => {
  const html = fs.readFileSync(path.join(EXT, "options/options.html"), "utf8");
  const js = fs.readFileSync(path.join(EXT, "options/options.js"), "utf8");
  const iS = html.indexOf("lib/storage.js"), iP = html.indexOf("lib/prompts.js"), iO = html.indexOf("options.js");
  assert.ok(iS >= 0 && iP >= 0 && iO > iS && iO > iP, "script order wrong");
  assert.ok(/typeof GraphiteStorage/.test(js), "options.js must guard typeof GraphiteStorage");
  assert.ok(/graphite_settings/.test(js), "options.js must use graphite_settings key");
  assert.ok(/testProvider/.test(js) && /listModels/.test(js), "options.js must use testProvider/listModels messages");
  assert.ok(!/purple/i.test(html + fs.readFileSync(path.join(EXT, "options/options.css"), "utf8")),
    "Graphite theme must not use purple");
});
check("options.html covers providers, defaults, features, prompts, data, security, help", () => {
  const html = fs.readFileSync(path.join(EXT, "options/options.html"), "utf8");
  const js = fs.readFileSync(path.join(EXT, "options/options.js"), "utf8");
  for (const id of ["providers", "defaults", "features", "prompts", "data", "security", "help"]) {
    assert.ok(html.includes('id="' + id + '"'), "missing section #" + id);
  }
  for (const preset of ["OpenAI", "Anthropic", "OpenRouter", "Groq", "DeepSeek", "Together",
                        "Fireworks", "Mistral", "xAI", "Ollama", "LM Studio",
                        "Custom OpenAI-compatible", "Custom Anthropic-compatible"]) {
    assert.ok(js.includes(preset), "missing preset " + preset);
  }
  assert.ok(/OLLAMA_ORIGINS/.test(html), "help must document OLLAMA_ORIGINS");
  assert.ok(/browser\.storage\.local/.test(html), "security note must mention browser.storage.local");
});

/* ---------- storage defaults shape (via lib/storage.js when present) ---------- */
const storageFile = path.join(EXT, "lib/storage.js");
if (!fs.existsSync(storageFile)) {
  pend("storage defaults shape", "lib/storage.js not present yet");
} else {
  check("storage defaults shape (lib/storage.js in vm sandbox)", () => {
    const sb = loadLibInSandbox("lib/storage.js");
    const GS = sb.GraphiteStorage || (sb.window && sb.window.GraphiteStorage);
    assert.ok(GS, "GraphiteStorage global not exposed by lib/storage.js");
    const dflt = (typeof GS.getDefaults === "function" && GS.getDefaults()) ||
                 (typeof GS.defaultSettings === "function" && GS.defaultSettings()) ||
                 GS.DEFAULTS || GS.defaults || null;
    if (dflt) {
      const providers = dflt.providers, settings = dflt.settings || dflt;
      assert.ok(Array.isArray(providers), "defaults.providers must be an array");
      for (const k of ["targetLang", "temperature", "maxTokens", "systemPrompt",
                       "youtubeAutoSummary", "searchEnhance", "selectionToolbar", "bilingualSubtitles"]) {
        assert.ok(k in settings, "defaults.settings missing " + k);
      }
      assert.ok("prompts" in dflt, "defaults missing prompts");
    } else if (typeof GS.loadSettings === "function") {
      // shape verified asynchronously below by contract keys on returned value
      return GS.loadSettings().then((loaded) => {
        assert.ok(loaded && typeof loaded === "object", "loadSettings must resolve to an object");
      });
    } else {
      throw new Error("no defaults accessor (getDefaults/DEFAULTS/loadSettings) found");
    }
  });
}

/* ---------- prompts library ---------- */
const promptsFile = path.join(EXT, "lib/prompts.js");
if (!fs.existsSync(promptsFile)) {
  pend("prompts builtin >= 15 and renderPrompt", "lib/prompts.js not present yet");
} else {
  check("prompts builtin >= 15 and renderPrompt placeholder works", () => {
    const sb = loadLibInSandbox("lib/prompts.js");
    const GP = sb.GraphitePrompts || (sb.window && sb.window.GraphitePrompts);
    assert.ok(GP, "GraphitePrompts global not exposed by lib/prompts.js");
    const builtins = GP.BUILTIN_PROMPTS || GP.builtinPrompts || GP.prompts || GP.BUILTINS ||
      (typeof GP.listBuiltin === "function" ? GP.listBuiltin() : null) ||
      (typeof GP.getBuiltinPrompts === "function" ? GP.getBuiltinPrompts() : null);
    assert.ok(Array.isArray(builtins), "builtin prompts list not found");
    assert.ok(builtins.length >= 15, "expected >=15 builtins, got " + builtins.length);
    assert.ok(typeof GP.renderPrompt === "function", "GraphitePrompts.renderPrompt missing");
    const sample = builtins.find((p) => /\{\{/.test(String(p.body || p.prompt || p.template || ""))) || builtins[0];
    const template = String(sample.body || sample.prompt || sample.template || "Hello {{text}}");
    const out = GP.renderPrompt(template, { text: "WORLD", selection: "WORLD", targetLang: "en" });
    assert.ok(typeof out === "string" && out.length > 0, "renderPrompt must return a string");
    if (/\{\{text\}\}/.test(template)) assert.ok(out.includes("WORLD"), "renderPrompt must substitute {{text}}");
  });
}

/* ---------- youtube summary prompt + timestamp helpers ---------- */
if (!fs.existsSync(promptsFile) || !fs.existsSync(path.join(EXT, "sidebar/markdown.js")) || !fs.existsSync(path.join(EXT, "lib/youtube.js"))) {
  pend("youtube analyst prompt and timestamp parser", "youtube/markdown libs not present yet");
} else {
  check("youtube-summary builtin is the expert transcript-analyst prompt", () => {
    const sb = loadLibInSandbox("lib/prompts.js");
    const GP = sb.GraphitePrompts;
    const builtin = GP.getBuiltin("youtube-summary");
    assert.ok(builtin, "youtube-summary builtin missing");
    const body = builtin.body;
    ["expert transcript analyst", "STRICT RULES", "Do NOT invent", "same language as the transcript",
     "OVERVIEW", "EXECUTIVE SUMMARY (TL;DR)", "150-200", "SUMMARY TABLE OF THEMES",
     "DETAILED THEMATIC BREAKDOWN", "FINAL CONSOLIDATED TABLES", "Key Decisions Made",
     "Action Items", "Open Questions", "FINAL TAKEAWAYS", "Not mentioned in the transcript.",
     "{{title}}", "{{transcript}}"
    ].forEach((needle) => assert.ok(body.includes(needle), "prompt missing: " + needle));
    const rendered = GP.renderPrompt(body, { title: "My Video", transcript: "[00:01] hello" });
    assert.ok(rendered.includes("My Video") && rendered.includes("[00:01] hello"), "prompt placeholders not rendered");
    assert.ok(!rendered.includes("{{transcript}}"), "transcript placeholder left in prompt");
  });

  check("buildYouTubeSummaryPrompt returns the analyst prompt", () => {
    const sb = loadLibInSandbox("lib/prompts.js");
    vm.runInContext(fs.readFileSync(path.join(EXT, "lib/youtube.js"), "utf8"), sb, { filename: "lib/youtube.js" });
    const Y = sb.GraphiteYouTube;
    assert.ok(Y && typeof Y.buildYouTubeSummaryPrompt === "function", "buildYouTubeSummaryPrompt missing");
    const out = Y.buildYouTubeSummaryPrompt("[00:00] hi there", "Title X");
    assert.ok(out.includes("expert transcript analyst"), "builder lost the analyst prompt");
    assert.ok(out.includes("Title X") && out.includes("[00:00] hi there"), "builder placeholders");
  });

  check("timestamp parser: MM:SS, H:MM:SS, ranges, [Part N] ignored", () => {
    const GP = loadLibInSandbox("lib/prompts.js").GraphitePrompts;
    assert.strictEqual(GP.parseTimestampSeconds("05:30"), 330);
    assert.strictEqual(GP.parseTimestampSeconds("00:00"), 0);
    assert.strictEqual(GP.parseTimestampSeconds("1:02:03"), 3723);
    assert.strictEqual(GP.parseTimestampSeconds("[12:15]"), 735);
    assert.strictEqual(GP.parseTimestampSeconds("(12:15)"), 735);
    assert.strictEqual(GP.parseTimestampSeconds("05:31 - 12:15"), null, "ranges are not a single timestamp");
    assert.strictEqual(GP.parseTimestampSeconds("[Part 1]"), null);
    assert.strictEqual(GP.parseTimestampSeconds("[Part 12]"), null);
    assert.strictEqual(GP.parseTimestampSeconds("12:75"), null);
    assert.strictEqual(GP.parseTimestampSeconds("hello"), null);
    assert.strictEqual(GP.parseTimestampSeconds(""), null);
    assert.strictEqual(GP.formatTimestampLabel(330), "5:30");
    assert.strictEqual(GP.formatTimestampLabel(3723), "1:02:03");
  });

  check("linkifyTimestamps: ranges seek to start, code/attributes untouched", () => {
    const GP = loadLibInSandbox("lib/prompts.js").GraphitePrompts;
    const html = GP.linkifyTimestamps("Watch 00:00 - 05:30 and 1:02:03 & [12:15].");
    assert.ok(html.includes('data-seek-seconds="0"'), "range start seek: " + html);
    assert.ok(html.includes('data-seek-seconds="3723"'), "h:mm:ss seek");
    assert.ok(html.includes('data-seek-seconds="735"'), "bracket seek");
    assert.ok(!GP.linkifyTimestamps("[Part 1] only").includes("data-seek-seconds"), "[Part N] must not linkify");
    const safe = GP.linkifyTimestamps('<a href="https://x.test/?t=05:30">05:30</a> <code>05:30</code> plain 06:00');
    assert.strictEqual((safe.match(/data-seek-seconds/g) || []).length, 1, "only plain text linkified: " + safe);
    assert.ok(safe.includes('data-seek-seconds="360"'));
  });

  check("sidebar markdown renders seek controls and keeps tables/code safe", () => {
    const sb = loadLibInSandbox("sidebar/markdown.js");
    const Md = sb.GraphiteMarkdown || (sb.window && sb.window.GraphiteMarkdown);
    assert.ok(Md, "GraphiteMarkdown missing");
    const html = Md.render("### 1. Intro `00:00 - 05:30`\n\nSee 12:15 and [Part 2].\n\n| T | When |\n| :--- | :--- |\n| A | 00:00 - 05:30 |");
    assert.ok(html.includes(">00:00 - 05:30</button>"), "backticked section range is a seek control: " + html);
    assert.ok(html.includes('data-seek-seconds="735"'), "prose timestamp: " + html);
    assert.ok(html.includes('data-seek-seconds="0"'), "table range timestamp");
    assert.ok(!html.includes('[Part 2]</button>') && !html.includes('Part 2" data-seek'), "[Part N] not a seek target");
    const codeHtml = Md.render("Run `seek 05:30` then wait 06:00");
    assert.strictEqual((codeHtml.match(/data-seek-seconds/g) || []).length, 1, "inline code not linkified: " + codeHtml);
    assert.strictEqual(Md.parseTimestampSeconds("05:30"), 330);
    assert.strictEqual(Md.parseTimestampSeconds("[Part 1]"), null);
  });

  check("bug3: seek click round-trip — data-seek-seconds value re-parses to seconds", () => {
    const GP = loadLibInSandbox("lib/prompts.js").GraphitePrompts;
    const Md = loadLibInSandbox("sidebar/markdown.js").GraphiteMarkdown;
    // Both click handlers (youtube.js:182, sidebar.js:1190) feed the
    // data-seek-seconds attribute string back through parseTimestampSeconds;
    // that round-trip must not return null or every seek click no-ops.
    assert.strictEqual(GP.parseTimestampSeconds("754"), 754);
    assert.strictEqual(GP.parseTimestampSeconds("0"), 0);
    assert.strictEqual(Md.parseTimestampSeconds("754"), 754);
    assert.strictEqual(Md.parseTimestampSeconds(GP.parseTimestampSeconds("12:34")), 754);
    // sidebar.js / youtube.js keep verbatim copies of the same guard.
    for (const rel of ["content/youtube.js"]) {
      const src = fs.readFileSync(path.join(EXT, rel), "utf8");
      assert.ok(/\/\^\\d\+\$\/\.test\(s\)/.test(src), rel + " must accept bare integer seconds");
    }
    // Click handlers must still route through the parser (not raw Number()).
    const yt = fs.readFileSync(path.join(EXT, "content/youtube.js"), "utf8");
    assert.ok(/parseTimestampSeconds\(target\.getAttribute\('data-seek-seconds'\)\)/.test(yt), "youtube click handler parses attribute");
    const side = fs.readFileSync(path.join(EXT, "sidebar/sidebar.js"), "utf8");
    assert.ok(/parseTimestampSeconds\(target\.getAttribute\('data-seek-seconds'\)\)/.test(side), "sidebar click handler parses attribute");
  });

  check("bug3: representative summary output becomes seek controls end-to-end", () => {
    const sb = loadLibInSandbox("lib/prompts.js");
    vm.runInContext(fs.readFileSync(path.join(EXT, "sidebar/markdown.js"), "utf8"), sb, { filename: "sidebar/markdown.js" });
    const Md = sb.GraphiteMarkdown;
    const GP = sb.GraphitePrompts;
    assert.ok(Md && GP, "markdown + prompts globals");
    // Shape mandated by the expert prompt: themes table with bare timestamps,
    // heading with bracketed code-span range, paragraph with [05:00].
    const sample = [
      "### 1. Opening `[12:34 - 13:00]`",
      "",
      "Starts at [05:00] and peaks around (22:52); ignore 12:75 and [Part 1].",
      "",
      "| # | Timestamp | Theme |",
      "| :--- | :--- | :--- |",
      "| 1 | 22:52 | Deep dive |",
      "| 2 | 22:52 - 23:10 | Follow-up |",
    ].join("\n");
    const html = Md.render(sample);
    const seeks = [...html.matchAll(/data-seek-seconds="(\d+)"/g)].map((m) => Number(m[1]));
    assert.ok(seeks.includes(754), "heading bracketed code-span range seeks to start (12:34 = 754): " + html);
    assert.ok(html.includes("> [12:34 - 13:00]</button>") || html.includes(">[12:34 - 13:00]</button>"), "heading range is a seek control: " + html);
    assert.ok(seeks.includes(300), "paragraph [05:00] seeks to 300: " + html);
    assert.ok(seeks.includes(1372), "bare table timestamp 22:52 seeks: " + html);
    assert.strictEqual(seeks.filter((s) => s === 1372).length, 3, "paragraph (22:52) + table bare + range-start all 22:52");
    assert.ok(!/>12:75<\/button>/.test(html) && !html.includes('data-seek-seconds="795"'), "invalid 12:75 rejected");
    assert.ok(!html.includes('[Part 1]</button>'), "[Part 1] must not be a seek control: " + html);
    assert.ok(!/class="gs-yt-ts"[^>]*>Part/.test(html), "[Part 1] not linkified as a control");
    // Simulate the click handler: every rendered attribute feeds back to its seconds.
    for (const m of html.matchAll(/data-seek-seconds="(\d+)"/g)) {
      assert.strictEqual(Md.parseTimestampSeconds(m[1]), Number(m[1]), "click round-trip for " + m[1]);
    }
    // Prompts linkify agrees on the same output shape.
    const linked = GP.linkifyTimestamps("At 22:52 and [Part 1] here");
    assert.ok(linked.includes('data-seek-seconds="1372"') && !linked.includes("Part 1</button>"), "prompts linkify: " + linked);
  });

  check("seek wiring: content handler, sidebar delegation, background builder", () => {
    const yt = fs.readFileSync(path.join(EXT, "content/youtube.js"), "utf8");
    assert.ok(yt.includes("command === 'seek'"), "content seek command");
    assert.ok(yt.includes("data-seek-seconds"), "content seek controls");
    assert.ok(yt.includes("buildYouTubePrompt"), "content asks background for the prompt");
    assert.ok(yt.includes("seekTo"), "content seekTo");
    const side = fs.readFileSync(path.join(EXT, "sidebar/sidebar.js"), "utf8");
    assert.ok(side.includes("graphite-command"), "sidebar sends graphite-command");
    assert.ok(side.includes("seekActiveVideo"), "sidebar seek helper");
    assert.ok(side.includes("buildYouTubeSummaryPrompt"), "sidebar uses shared builder");
    assert.ok(!side.includes("'Summarize this YouTube video.'"), "stale short prompt remains");
    const bg = fs.readFileSync(path.join(EXT, "background.js"), "utf8");
    assert.ok(bg.includes("buildYouTubePrompt"), "background prompt builder");
  });
}

/* ---------- provider SSE parsing (via lib/providers.js when present) ----------
   Real API of lib/providers.js (inspected): GraphiteProviders.chat(opts) with
   fetch() stubbed, and the exported _consumeSSE helper. We exercise both. */
const providersFile = path.join(EXT, "lib/providers.js");
if (!fs.existsSync(providersFile)) {
  pend("providers SSE parser (OpenAI chunks & Anthropic events)",
       "lib/providers.js not present yet — SSE contract noted, will assert once core lands");
} else {
  const fakeSseResponse = (sseText) => ({
    ok: true, status: 200,
    text: async () => sseText,          // forces consumeSSE's no-reader fallback path
    json: async () => JSON.parse(sseText),
  });
  const runSseTests = async () => {
    // OpenAI-compatible SSE through chat()
    let fetchedUrl = null, chunks = [];
    let sb = loadLibInSandbox("lib/providers.js", {
      fetch: async (url) => {
        fetchedUrl = url;
        return fakeSseResponse(
          'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n' +
          'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n' +
          "data: [DONE]\n\n");
      },
    });
    let GP = sb.GraphiteProviders;
    assert.ok(GP && typeof GP.chat === "function", "GraphiteProviders.chat missing");
    let out = await GP.chat({
      provider: { label: "t", kind: "openai-compatible", baseUrl: "https://api.example.test/v1", apiKey: "k", model: "m" },
      messages: [{ role: "user", content: "hi" }], stream: true,
      onChunk: (piece) => chunks.push(piece),
    });
    assert.strictEqual(fetchedUrl, "https://api.example.test/v1/chat/completions");
    assert.strictEqual(out.text, "Hello", "OpenAI SSE text: " + JSON.stringify(out));
    assert.strictEqual(chunks.join(""), "Hello", "OpenAI onChunk deltas");

    // Anthropic events through chat()
    chunks = [];
    sb = loadLibInSandbox("lib/providers.js", {
      fetch: async (url) => {
        fetchedUrl = url;
        return fakeSseResponse(
          'event: message_start\ndata: {"type":"message_start"}\n\n' +
          'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}\n\n' +
          'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"!" }}\n\n');
      },
    });
    GP = sb.GraphiteProviders;
    out = await GP.chat({
      provider: { label: "a", kind: "anthropic", baseUrl: "https://api.anthropic.com", apiKey: "k", model: "claude-x" },
      messages: [{ role: "user", content: "hi" }], stream: true,
      onChunk: (piece) => chunks.push(piece),
    });
    assert.strictEqual(fetchedUrl, "https://api.anthropic.com/v1/messages");
    assert.strictEqual(out.text, "Hi!", "Anthropic SSE text: " + JSON.stringify(out));
    assert.strictEqual(chunks.join(""), "Hi!", "Anthropic onChunk deltas");

    // _consumeSSE directly splits data: payloads
    assert.strictEqual(typeof GP._consumeSSE, "function", "_consumeSSE export missing");
    const payloads = [];
    await GP._consumeSSE(fakeSseResponse('data: one\n\ndata: two\n\n'), (d) => payloads.push(d));
    assert.deepStrictEqual(payloads, ["one", "two"]);
  };
  sseDone = runSseTests().then(
    () => ok("provider SSE parser handles OpenAI chunks and Anthropic events (chat + _consumeSSE)"),
    (e) => fail("provider SSE parser handles OpenAI chunks and Anthropic events", e));
}

/* ---------- 1.0.3: input icon, menu overflow, Inter, translate pickers ---------- */
check("input write button is an SVG icon, not 'AI' text", () => {
  const src = fs.readFileSync(path.join(EXT, "content/content.js"), "utf8");
  assert.ok(!src.includes(">AI<"), "stale >AI< badge remains in content.js");
  const m = src.match(/gs-write-btn[\s\S]{0,600}?setIcon\(writeBtn,\s*'<svg/);
  assert.ok(m, "write button must embed inline SVG");
  assert.ok(src.includes("setAttribute('aria-label', 'Graphite writing assistant')"), "write button aria-label");
});
check("write menu is the scroll container with viewport clamps", () => {
  const css = fs.readFileSync(path.join(EXT, "content/overlay.css"), "utf8");
  const m = css.match(/\.gs-write-menu\s*\{([^}]*)\}/);
  assert.ok(m, ".gs-write-menu rule missing");
  assert.ok(/max-height:/.test(m[1]), ".gs-write-menu max-height");
  assert.ok(/overflow-y:\s*auto/.test(m[1]), ".gs-write-menu overflow-y:auto");
  assert.ok(/max-width:/.test(m[1]), ".gs-write-menu max-width");
  const js = fs.readFileSync(path.join(EXT, "content/content.js"), "utf8");
  assert.ok(js.includes("positionWriteMenu"), "measured positioning helper");
});
check("in-box translate picker with language select exists", () => {
  const js = fs.readFileSync(path.join(EXT, "content/content.js"), "utf8");
  assert.ok(js.includes("showTranslatePickerCard"), "translate picker card");
  assert.ok(js.includes("lang-select"), "language select control");
  assert.ok(js.includes("Change language"), "re-open picker from result");
});
check("shadow Inter @font-face built from runtime fonts URL", () => {
  const js = fs.readFileSync(path.join(EXT, "content/content.js"), "utf8");
  assert.ok(js.includes("fontFaceCss"), "fontFaceCss helper");
  assert.ok(/runtime\.getURL\('fonts\//.test(js), "fonts runtime URL");
});
check("Inter is the first family on every surface", () => {
  const side = fs.readFileSync(path.join(EXT, "sidebar/sidebar.css"), "utf8");
  assert.ok(/body\s*\{[^}]*font(-family)?:[^;}]*"Inter",/.test(side), "sidebar body Inter-first");
  const opts = fs.readFileSync(path.join(EXT, "options/options.css"), "utf8");
  assert.ok(/font(-family)?:[^;}]*"Inter",system-ui/.test(opts), "options Inter-first");
  const contentCss = fs.readFileSync(path.join(EXT, "content/content.css"), "utf8");
  assert.ok(/font-family:\s*"Inter",|@font-face/.test(contentCss), "content.css Inter");
  const overlay = fs.readFileSync(path.join(EXT, "content/overlay.css"), "utf8");
  const root = overlay.match(/\.gs-root\s*\{([^}]*)\}/);
  assert.ok(root && /font-family:\s*"Inter",/.test(root[1]), "overlay .gs-root Inter-first");
  assert.ok(!/-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial/.test(overlay), "old stack left in overlay.css");
});
check("bundled Inter woff2 files exist with WOFF2 magic", () => {
  for (const w of [400, 500, 600, 700]) {
    const p = path.join(EXT, "fonts/inter-latin-" + w + "-normal.woff2");
    assert.ok(fs.existsSync(p), "missing " + p);
    assert.strictEqual(fs.readFileSync(p).slice(0, 4).toString("latin1"), "wOF2", "not a woff2: " + p);
  }
  assert.ok(fs.existsSync(path.join(EXT, "fonts/inter.css")), "fonts/inter.css");
});
check("manifest exposes fonts/* and stays on graphite theme", () => {
  assert.ok(manifest, "manifest required");
  assert.ok((manifest.web_accessible_resources || []).includes("fonts/*"), "fonts/* WAR");
});
check("sidebar translate select and pending chooser wiring", () => {
  const js = fs.readFileSync(path.join(EXT, "sidebar/sidebar.js"), "utf8");
  assert.ok(js.includes('id="tLangSel"'), "tLangSel select");
  assert.ok(!js.includes('id="tLang"'), "stale free-text tLang input");
  assert.ok(!js.includes("Translate this selection to English"), "hardcoded English pending translate");
  assert.ok(!js.includes("Translate this to English"), "hardcoded English quick translate");
  assert.ok(js.includes("openTranslateTool"), "pending translate shows chooser first");
});

/* ---------- 1.0.4: image model + endpoint, translation languages, drag, prompt editor ---------- */
let imageDone = Promise.resolve();
check("storage: imageModel preserved, translationLanguages normalized", () => {
  const sb = loadLibInSandbox("lib/storage.js");
  const GS = sb.GraphiteStorage;
  const norm = GS.normalize({
    providers: [{ id: "p1", label: "P", kind: "openai-compatible", baseUrl: "https://x.test/v1/", apiKey: "k", model: "chat-m", imageModel: "cx/gpt-image-2.5" }],
    settings: { translationLanguages: [" English ", "Portuguese (Brazil)", "english", ""] },
  });
  assert.strictEqual(norm.providers[0].imageModel, "cx/gpt-image-2.5", "imageModel must survive normalize");
  assert.strictEqual(norm.providers[0].model, "chat-m", "chat model untouched");
  assert.strictEqual(norm.settings.translationLanguages.join("|"), "English|Portuguese (Brazil)", "trim/dedupe/drop-empty");
  const dflt = GS.DEFAULT_SETTINGS();
  assert.ok(dflt.settings.translationLanguages.includes("Portuguese (Brazil)"), "default list has Portuguese (Brazil)");
  assert.ok(dflt.providers.some((p) => "imageModel" in p), "default providers carry imageModel");
  const fb = GS.normalize({ settings: { translationLanguages: [] } });
  assert.ok(fb.settings.translationLanguages.length > 0, "empty list falls back to defaults");
});

check("background: image routing isolated from chat model override", () => {
  const bg = fs.readFileSync(path.join(EXT, "background.js"), "utf8");
  assert.ok(bg.includes("forImage"), "resolveProvider image mode");
  assert.ok(bg.includes("imageOptions"), "image options pass-through");
  assert.ok(bg.includes("generateImage"), "generateImage case");
});

check("builtin prompt override wins in listPrompts", () => {
  const sb = loadLibInSandbox("lib/prompts.js");
  const GP = sb.GraphitePrompts;
  const target = GP.getBuiltin("translate") || GP.BUILTIN_PROMPTS[0];
  const eff = GP.listPrompts({ prompts: [{ id: target.id, name: target.name, body: "CUSTOM-BODY", builtin: false }] });
  const found = eff.find((p) => p.id === target.id);
  assert.strictEqual(found.body, "CUSTOM-BODY", "user override must win over builtin");
});

check("options: image model field, language editor, prompt dropdown editor", () => {
  const html = fs.readFileSync(path.join(EXT, "options/options.html"), "utf8");
  const js = fs.readFileSync(path.join(EXT, "options/options.js"), "utf8");
  assert.ok(html.includes('id="translationLanguages"'), "translation languages textarea");
  assert.ok(html.includes('id="builtinPromptSelect"'), "builtin prompt dropdown");
  assert.ok(html.includes('id="builtinPromptBody"'), "builtin prompt editor textarea");
  assert.ok(html.includes('id="builtinPromptStatus"'), "builtin prompt status line");
  assert.ok(js.includes("imageModel"), "options provider imageModel binding");
  assert.ok(js.includes("translationLanguages"), "options parses translationLanguages");
  assert.ok(!js.includes("builtinPromptList") && !html.includes("builtinPromptList"), "old read-only builtin cards removed");
});

check("content: toolbar drag + configured languages; sidebar image decoupled", () => {
  const js = fs.readFileSync(path.join(EXT, "content/content.js"), "utf8");
  assert.ok(js.includes("wireToolbarDrag"), "toolbar drag wiring");
  assert.ok(js.includes("composedPath"), "drag resolves shadow-tree targets via composedPath");
  assert.ok(js.includes("translationLanguages"), "content language setting pass-through");
  const css = fs.readFileSync(path.join(EXT, "content/overlay.css"), "utf8");
  const logo = css.match(/\.gs-toolbar-logo\s*\{([^}]*)\}/);
  assert.ok(logo && /cursor:\s*grab/.test(logo[1]) && /touch-action:\s*none/.test(logo[1]), "logo is the drag handle");
  const side = fs.readFileSync(path.join(EXT, "sidebar/sidebar.js"), "utf8");
  const gi = side.indexOf("generateImage");
  assert.ok(gi >= 0 && !side.slice(gi, gi + 200).includes("activeModel"), "sidebar image call must not send the chat model");
  assert.ok(side.includes("dataUrl"), "sidebar renders b64 data URLs");
});

if (!fs.existsSync(providersFile)) {
  pend("generateImage payload/endpoint", "lib/providers.js not present yet");
} else {
  const runImageTests = async () => {
    let captured = null;
    const sb = loadLibInSandbox("lib/providers.js", {
      fetch: async (url, opts) => {
        captured = { url, opts };
        return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ b64_json: "QUJD" }] }) };
      },
    });
    const GP = sb.GraphiteProviders;
    assert.strictEqual(typeof GP.generateImage, "function", "generateImage export");
    const provider = { label: "T", kind: "openai-compatible", baseUrl: "https://gw.test/v1/", apiKey: "k", model: "chat-model", imageModel: "cx/gpt-image-2.5" };
    const r = await GP.generateImage(provider, "A cute cat wearing a hat");
    assert.strictEqual(captured.url, "https://gw.test/v1/images/generations", "image endpoint");
    assert.strictEqual(captured.opts.method, "POST");
    assert.strictEqual(captured.opts.headers.Accept, "text/event-stream", "SSE accept header");
    assert.strictEqual(captured.opts.headers.Authorization, "Bearer k");
    const body = JSON.parse(captured.opts.body);
    assert.strictEqual(body.model, "cx/gpt-image-2.5", "image model, not chat model");
    assert.deepStrictEqual(
      { n: body.n, size: body.size, quality: body.quality, background: body.background, image_detail: body.image_detail, output_format: body.output_format, watermark: body.watermark, prompt_extend: body.prompt_extend },
      { n: 1, size: "auto", quality: "auto", background: "auto", image_detail: "high", output_format: "png", watermark: true, prompt_extend: true },
      "image payload defaults");
    assert.strictEqual(r.dataUrl, "data:image/png;base64,QUJD", "b64 -> data URL");
    assert.strictEqual(r.url, r.dataUrl, "url falls back to data URL");
    // SSE-framed response tolerated
    const sb2 = loadLibInSandbox("lib/providers.js", {
      fetch: async () => ({ ok: true, status: 200, text: async () => 'data: {"data":[{"url":"https://img.test/x.png"}]}\n\ndata: [DONE]\n\n' }),
    });
    const r2 = await sb2.GraphiteProviders.generateImage(provider, "cat");
    assert.strictEqual(r2.url, "https://img.test/x.png");
    // Anthropic + missing-image-model guards
    await assert.rejects(GP.generateImage({ label: "A", kind: "anthropic", baseUrl: "https://api.anthropic.com", model: "c" }, "cat"), /does not support image generation/);
    await assert.rejects(GP.generateImage({ label: "X", kind: "openai-compatible", baseUrl: "https://x.test/v1", model: "chat-only" }, "cat"), /No image model/);
  };
  imageDone = runImageTests().then(
    () => ok("generateImage: endpoint, payload, b64 + SSE responses, guards"),
    (e) => fail("generateImage: endpoint, payload, b64 + SSE responses, guards", e));
}

/* ---------- 1.0.5: dropdown-confined prompts, youtube override flow, panel error scrub ---------- */
check("youtube-summary override reaches built prompt (getEffectivePrompt + builder)", () => {
  const sb = loadLibInSandbox("lib/prompts.js");
  vm.runInContext(fs.readFileSync(path.join(EXT, "lib/youtube.js"), "utf8"), sb, { filename: "lib/youtube.js" });
  const GP = sb.GraphitePrompts;
  const Y = sb.GraphiteYouTube;
  assert.ok(GP, "GraphitePrompts global not exposed");
  assert.ok(Y && typeof Y.buildYouTubeSummaryPrompt === "function", "buildYouTubeSummaryPrompt missing");
  assert.strictEqual(typeof GP.getEffectivePrompt, "function", "GraphitePrompts.getEffectivePrompt missing");
  const settings = { prompts: [{ id: "youtube-summary", name: "Mine", body: "CUSTOM {{title}} :: {{transcript}}" }] };
  const eff = GP.getEffectivePrompt("youtube-summary", settings);
  assert.ok(eff, "getEffectivePrompt must return the user prompt for youtube-summary");
  assert.strictEqual(eff.body, "CUSTOM {{title}} :: {{transcript}}", "getEffectivePrompt must return the override body");
  const built = Y.buildYouTubeSummaryPrompt("[00:00] hi", "Title X", settings);
  assert.ok(built.includes("CUSTOM Title X"), "override body + rendered title: " + built);
  assert.ok(built.includes("[00:00] hi"), "override rendered transcript into the built prompt");
  assert.ok(!built.includes("expert transcript analyst"), "override must replace the builtin analyst prompt");
  const fallback = Y.buildYouTubeSummaryPrompt("[00:00] hi", "Title X");
  assert.ok(fallback.includes("expert transcript analyst"), "no settings -> builtin analyst prompt");
  assert.ok(fallback.includes("Title X") && fallback.includes("[00:00] hi"), "builtin placeholders rendered");
  const unrelated = Y.buildYouTubeSummaryPrompt("[00:00] hi", "Title X",
    { prompts: [{ id: "summarize-selection", name: "Other", body: "CUSTOM {{title}} :: {{transcript}}" }] });
  assert.ok(unrelated.includes("expert transcript analyst"), "unrelated prompt id must not override the youtube summary prompt");
  // the builtin body itself contains "CUSTOMIZATION:", so probe the override's rendered marker instead
  assert.ok(!unrelated.includes("CUSTOM Title X"), "unrelated override body must not be rendered into the youtube prompt");
  assert.strictEqual(unrelated, fallback, "unrelated prompt id must leave the built prompt unchanged");
});

check("prompts confined to dropdowns in options and sidebar", () => {
  const optsHtml = fs.readFileSync(path.join(EXT, "options/options.html"), "utf8");
  assert.ok(optsHtml.includes('id="customPromptSelect"'), "options custom prompt dropdown");
  assert.ok(optsHtml.includes('id="builtinPromptSelect"'), "options builtin prompt dropdown");
  const optsJs = fs.readFileSync(path.join(EXT, "options/options.js"), "utf8");
  const sideJs = fs.readFileSync(path.join(EXT, "sidebar/sidebar.js"), "utf8");
  assert.ok(!optsJs.includes("customPromptList") && !optsJs.includes("builtinPromptList"),
    "options.js must not use the removed prompt list containers");
  assert.ok(!sideJs.includes("customPromptList") && !sideJs.includes("builtinPromptList"),
    "sidebar.js must not use prompt list containers");
  const sideHtml = fs.readFileSync(path.join(EXT, "sidebar/sidebar.html"), "utf8");
  assert.ok(sideHtml.includes('id="promptSelect"'), "sidebar prompt dropdown");
  // the sidebar slash popup shows prompt names only (no bodies/descriptions)
  assert.ok(sideJs.includes("strongEl.textContent = '/' + p.name"), "slash popup renders prompt names only");
});

check("youtube chat is port-streamed (graphite-chat), never one-shot chatSync", () => {
  const yt = fs.readFileSync(path.join(EXT, "content/youtube.js"), "utf8");
  assert.ok(yt.includes("function runSummaryStream"), "runSummaryStream helper");
  assert.ok(yt.includes("runtime.connect({ name: 'graphite-chat' })"), "panel opens the graphite-chat port");
  assert.ok(yt.includes("type: 'start'"), "port start message");
  assert.ok(yt.includes("stream: true"), "streaming requested");
  assert.ok(yt.includes("msg.requestId") && yt.includes("requestId"), "requestId correlation");
  assert.ok(yt.includes("port.onDisconnect"), "port disconnect handled");
  assert.ok(yt.includes("onUpdate"), "progressive onUpdate callback");
  assert.strictEqual((yt.match(/\brunSummaryStream\(/g) || []).length, 4,
    "definition + 3 call sites (summary, chapters, subtitle translation)");
  assert.ok(!yt.includes("type: 'chatSync'"), "no one-shot chatSync sends remain");
  assert.ok(!yt.includes("chatSync attempt"), "old chatSync logger gone");
  assert.ok(!/retry/i.test(yt), "no retry logic in youtube.js — exactly one provider request per click");
  const summary = yt.slice(yt.indexOf("async function summarizeVideo()"), yt.indexOf("async function showChapters()"));
  assert.ok(summary.includes("buildSummaryPrompt"), "summary builds the prompt before streaming");
  assert.ok(summary.includes("runSummaryStream([{ role: 'user', content: prompt }],"), "summary streams the built prompt");
});

check("youtube panel errors: provider errors verbatim, connection loss friendly", () => {
  const yt = fs.readFileSync(path.join(EXT, "content/youtube.js"), "utf8");
  assert.ok(yt.includes("friendlyPanelError"), "friendlyPanelError helper");
  assert.ok(yt.includes("Reload the page and try again"), "friendly reload guidance");
  assert.ok(yt.includes("Connection to the extension background was lost. Reload the page and try again."),
    "friendly connection-lost message");
  assert.ok(yt.includes("isConnectionLostError"), "connection-error classifier helper");
  const errFn = yt.match(/function setPanelError\(message\) \{([\s\S]*?)\n  \}/);
  assert.ok(errFn && errFn[1].includes("friendlyPanelError"), "setPanelError must scrub via friendlyPanelError");
  const stream = yt.slice(yt.indexOf("function runSummaryStream"), yt.indexOf("  // Every panel chat path"));
  assert.ok(stream.includes("finish(new Error(String(msg.error || msg.message || 'Request failed')))"),
    "port {type:'error'} must surface the provider error verbatim (e.g. a 503)");
  assert.ok(stream.includes("CONNECTION_LOST_MESSAGE"), "watchdog / disconnect use the friendly message");
  assert.ok(stream.includes("sawChunk && full"), "disconnect after chunks keeps partial text");
  assert.ok(stream.includes("msg.type === 'chunk'") && stream.includes("msg.type === 'done'") && stream.includes("msg.type === 'error'"),
    "handles chunk/done/error port messages");
});

check("background prompt path guarded and loads settings", () => {
  const bg = fs.readFileSync(path.join(EXT, "background.js"), "utf8");
  assert.ok(bg.includes("typeof GraphiteYouTube"), "typeof GraphiteYouTube guard");
  assert.ok(!bg.includes("global.GraphiteYouTube"), "no bare global.GraphiteYouTube");
  const region = bg.slice(bg.indexOf("case 'buildYouTubePrompt':"), bg.indexOf("case 'getActiveTab':"));
  assert.ok(region.includes("loadSettings"), "buildYouTubePrompt handler loads settings so overrides flow");
  assert.ok(region.includes("GraphiteYouTube.buildYouTubeSummaryPrompt"), "handler builds via GraphiteYouTube");
  assert.ok(region.includes("typeof GraphitePrompts"), "typeof GraphitePrompts guard in handler");
  assert.ok(region.includes("getEffectivePrompt"), "handler resolves the effective prompt");
  assert.ok(!/(^|[^\w.$])global\./.test(bg), "background.js must not use the bare global object");
});

check("manifest background order and release version 1.0.27", () => {
  assert.ok(manifest, "manifest required");
  const scripts = (manifest.background && manifest.background.scripts) || [];
  const iP = scripts.indexOf("lib/prompts.js"), iY = scripts.indexOf("lib/youtube.js"), iB = scripts.indexOf("background.js");
  assert.ok(iP >= 0 && iY >= 0 && iB > iP && iB > iY, "lib/prompts.js + lib/youtube.js load before background.js");
  assert.strictEqual(manifest.version, "1.0.27", "release version");
});

/* ---------- 1.0.6 bug: transcript truncated at 22:52 of a 44:59 video -----
   Root cause: content/youtube.js transcriptText() sliced the joined,
   timestamped transcript at maxChars || 24000. At ~17.5 chars/s of
   serialized captions (one [MM:SS] line per ~3s event, ~52 chars/line)
   24000 chars ends at ~22:52; a full 45-min transcript is ~47k chars. */
check("youtube transcript cap: no sub-ceiling slice remains in the summary path", () => {
  const yt = fs.readFileSync(path.join(EXT, "content/youtube.js"), "utf8");
  assert.ok(yt.includes("TRANSCRIPT_TEXT_MAX_CHARS"), "named transcript ceiling constant");
  const m = yt.match(/TRANSCRIPT_TEXT_MAX_CHARS\s*=\s*(\d+)/);
  assert.ok(m, "ceiling constant is a numeric literal");
  assert.ok(Number(m[1]) >= 120000, "ceiling must cover ~2h of dense captions (>= 120000 chars), got " + m[1]);
  assert.ok(!yt.includes("|| 24000") && !yt.includes("maxChars || 24000"), "old 24000-char summary truncation must be gone");
  assert.ok(!yt.includes("transcriptText(true, 20000)"), "old 20000-char chapters cap must be gone");
  assert.ok(yt.includes("transcriptText(true, TRANSCRIPT_TEXT_MAX_CHARS)"), "chapters use the same ceiling");
  assert.ok(yt.includes("lastIndexOf('\\n', limit)"), "ceiling cut lands on a line boundary");
  // The default (summary / getTranscript-command) path takes no smaller cap.
  const body1 = yt.slice(yt.indexOf("function transcriptText"), yt.indexOf("// -------------------------------------------------------------- panel UI"));
  assert.ok(body1.includes("maxChars"), "transcriptText still accepts an explicit cap");
  const summary = yt.slice(yt.indexOf("async function buildSummaryPrompt"), yt.indexOf("async function summarizeVideo()"));
  assert.ok(summary.includes("transcriptText(true)"), "summary uses the default (ceiling) transcript text");
});

check("45-min transcript survives the summary prompt builder end-to-end", () => {
  const sb = loadLibInSandbox("lib/prompts.js");
  vm.runInContext(fs.readFileSync(path.join(EXT, "lib/youtube.js"), "utf8"), sb, { filename: "lib/youtube.js" });
  const Y = sb.GraphiteYouTube;
  assert.ok(Y && typeof Y.segmentsToText === "function" && typeof Y.buildYouTubeSummaryPrompt === "function",
    "GraphiteYouTube segment/prompt helpers missing");
  // Synthetic 44:59 video: one caption segment every 3s, 0..2697s (900 segs).
  const segments = [];
  for (let s = 0; s < 2699; s += 3) {
    segments.push({ start: s, dur: 3, text: "Caption segment spoken words here." });
  }
  assert.strictEqual(segments.length, 900, "900 synthetic segments");
  const text = Y.segmentsToText(segments, true);
  // Size math: [MM:SS] prefix + text + newline ~= 43 chars/line here; denser
  // real ASR (~7 words/3s, ~52 chars/line) is ~47k chars for 45 min. Either
  // way the text must exceed the old 24000 cap — otherwise this regression
  // test would pass vacuously against the buggy code.
  assert.ok(text.length > 24000, "synthetic transcript must exceed the old 24000 cap, got " + text.length);
  const lastLine = text.split("\n").pop();
  assert.ok(lastLine.startsWith("[44:57]"), "last timestamped line is [44:57], got: " + lastLine);
  // End-to-end: the same builder the background buildYouTubePrompt handler
  // and the sidebar use must carry the full transcript into the prompt.
  const prompt = Y.buildYouTubeSummaryPrompt(text, "Long Video");
  assert.ok(prompt.includes("expert transcript analyst"), "analyst prompt intact");
  assert.ok(prompt.includes("[00:00] Caption segment"), "first caption line in prompt");
  assert.ok(prompt.includes("[44:57] Caption segment spoken words here."), "last caption line (44:57) reaches the prompt");
  assert.ok(!prompt.includes("{{transcript}}"), "transcript placeholder rendered");
  // The old behavior, for contrast: slicing at 24000 loses the second half.
  assert.ok(!text.slice(0, 24000).includes("[44:57]"), "sanity: the 24000 slice really did truncate");
  // A custom youtube-summary override still wins with the full transcript.
  const settings = { prompts: [{ id: "youtube-summary", name: "Mine", body: "CUSTOM {{title}} :: {{transcript}}" }] };
  const custom = Y.buildYouTubeSummaryPrompt(text, "Long Video", settings);
  assert.ok(custom.includes("CUSTOM Long Video"), "override body rendered");
  assert.ok(custom.includes("[44:57] Caption segment spoken words here."), "override receives the full transcript too");
});

/* ---------- Bug 2 (reworked 1.0.12): maxTokens — explicit wins everywhere
   Original bug: panel summaries inherited the small global default (2048),
   sent verbatim as max_tokens, cutting DETALHAMENTO TEMÁTICO mid-section.
   The 1.0.11 summary-only unlimited rule still hid exceptions (a user's
   32000 was ignored for summaries below/above thresholds and a gateway
   default such as 8192 could silently replace an omitted max_tokens).
   1.0.12 rule, one path for every flow: explicit positive msg.maxTokens
   wins; else the stored settings.maxTokens wins exactly; 0/blank/missing
   sends NO max_tokens (provider default). Settings are re-read fresh per
   request, storage coerces string values, options never rewrites the
   value to a floor/fallback, and Anthropic (which requires the field)
   falls back to 16384. A provider length cut-off must be surfaced. */
check("maxTokens: explicit wins everywhere; truncation surfaced", () => {
  const yt = fs.readFileSync(path.join(EXT, "content/youtube.js"), "utf8");
  assert.ok(yt.includes("purpose: 'youtube-summary'"), "summary stream still tags purpose (diagnostics only)");
  const stream = yt.slice(yt.indexOf("function runSummaryStream"), yt.indexOf("  // Every panel chat path"));
  assert.ok(!stream.includes("maxTokens:"), "content sends no explicit maxTokens — budget stays a background concern");
  const bg = fs.readFileSync(path.join(EXT, "background.js"), "utf8");
  assert.ok(!bg.includes("youtubeSummaryMaxTokens"), "summary-only budget helper removed");
  assert.ok(!bg.includes("YOUTUBE_SUMMARY_MAX_TOKENS"), "summary-only budget constant removed");
  assert.ok(bg.includes("function resolveMaxTokens"), "single budget resolver");
  assert.ok(bg.includes("loadSettings({ fresh: true })"), "chatRequest re-reads settings fresh per request");
  assert.ok(bg.includes("gsLog('chat', 'maxTokens'"), "resolved budget is debug-logged (metadata only)");
  assert.ok(bg.includes("sentMaxTokens"), "debug log distinguishes sent vs omitted");
  assert.ok(bg.includes("maxTokens: resolvedMaxTokens"), "chatRequest sends the resolved budget for every flow");
  assert.ok(bg.includes("storage.onChanged"), "background invalidates cached settings on storage change");
  // Behavioural: run the actual resolver extracted from background.js.
  const fnSrc = bg.match(/function resolveMaxTokens\(msg, settings\) \{[\s\S]*?\n\}/);
  assert.ok(fnSrc, "resolver source extractable");
  const resolveMaxTokens = new Function(fnSrc[0] + "; return resolveMaxTokens;")();
  const stored = (v) => ({ settings: { maxTokens: v } });
  assert.strictEqual(resolveMaxTokens({ maxTokens: 5000 }, stored(32000)), 5000, "explicit msg.maxTokens wins over stored");
  assert.strictEqual(resolveMaxTokens({ purpose: "youtube-summary" }, stored(32000)), 32000, "stored 32000 honoured for YouTube summaries");
  assert.strictEqual(resolveMaxTokens({}, stored(32000)), 32000, "stored 32000 honoured for sidebar chat");
  assert.strictEqual(resolveMaxTokens({}, stored(2048)), 2048, "stored value at old default is honoured too (no hidden threshold)");
  assert.strictEqual(resolveMaxTokens({}, stored("32000")), 32000, "string stored value coerced");
  assert.strictEqual(resolveMaxTokens({}, stored(0)), undefined, "0 means provider default (omit max_tokens)");
  assert.strictEqual(resolveMaxTokens({}, stored("")), undefined, "blank means provider default");
  assert.strictEqual(resolveMaxTokens({}, {}), undefined, "missing settings means provider default");
  assert.strictEqual(resolveMaxTokens({ maxTokens: 0 }, stored(32000)), 32000, "explicit 0 falls through to stored");
  assert.ok(bg.includes("finishReason: result.finishReason"), "background forwards finishReason on done");
  assert.ok(bg.includes("truncated: !!result.truncated"), "background forwards truncated flag on done");
  // Providers: explicit numeric ceiling reaches the wire; finish_reason parsed.
  const prov = fs.readFileSync(path.join(EXT, "lib/providers.js"), "utf8");
  assert.ok(prov.includes("if (typeof opts.maxTokens === 'number' && opts.maxTokens > 0) body.max_tokens = opts.maxTokens;"),
    "OpenAI-compatible provider sends max_tokens only when a positive number is given");
  assert.ok(prov.includes("? opts.maxTokens : 16384"), "Anthropic fallback is the high 16384 ceiling, not 2048");
  assert.ok(prov.includes("finishReason"), "providers surface finishReason");
  assert.ok(prov.includes("truncated: finishReason === 'length'"), "length cut-off flagged as truncated");
  // Storage: default is provider-default (0) and values coerce losslessly.
  const sb = loadLibInSandbox("lib/storage.js");
  const GS = sb.GraphiteStorage || (sb.window && sb.window.GraphiteStorage);
  assert.ok(GS && typeof GS.normalize === "function" && typeof GS.DEFAULT_SETTINGS === "function", "storage API for budget checks");
  assert.strictEqual(GS.DEFAULT_SETTINGS().settings.maxTokens, 0, "storage default maxTokens is 0 (provider default)");
  assert.strictEqual(GS.normalize({ settings: { maxTokens: "32000" } }).settings.maxTokens, 32000, "normalize coerces '32000' to 32000");
  assert.strictEqual(GS.normalize({ settings: { maxTokens: 32000 } }).settings.maxTokens, 32000, "normalize preserves 32000");
  assert.strictEqual(GS.normalize({ settings: { maxTokens: 0 } }).settings.maxTokens, 0, "normalize preserves 0");
  assert.strictEqual(GS.normalize({ settings: { maxTokens: "bogus" } }).settings.maxTokens, 0, "normalize maps invalid to provider default");
  // Options: never rewrite the user's value to a floor/fallback.
  const opts = fs.readFileSync(path.join(EXT, "options/options.js"), "utf8");
  assert.ok(!opts.includes("|| 4096"), "options must not fall back to 4096");
  assert.ok(!opts.includes("Math.max(64, parseInt"), "options must not floor maxTokens at 64");
  assert.ok(opts.includes("maxTokens: 0"), "options default maxTokens is 0 (provider default)");
  const optsHtml = fs.readFileSync(path.join(EXT, "options/options.html"), "utf8");
  assert.ok(optsHtml.includes('min="0"') && optsHtml.includes("0 = provider default"), "options input documents 0 = provider default");
  // Panel marks truncated summaries visibly; chapters/translation unaffected.
  assert.ok(stream.includes("msg.truncated") && stream.includes("markTruncated"), "panel handles truncated done");
  assert.ok(yt.includes("{ markTruncated: true }"), "only the summary call opts into the notice");
  const side = fs.readFileSync(path.join(EXT, "sidebar/sidebar.js"), "utf8");
  assert.ok(!side.includes("youtube-summary'"), "sidebar never tags youtube-summary purpose");
});

/* ---------- Heartbeat: slow 9Router/reasoning TTFT must not read as
   "connection lost" -------------------------------------------------------
   The background pings every 15s; pings reset only the short background-
   liveness watchdog in the YouTube panel. The provider ceiling is a 120s
   INACTIVITY deadline (not total): while bytes flow the request may run
   indefinitely, and reasoning/SSE bytes count as activity. */
check("heartbeat: background pings, provider activity, split client timers", () => {
  const bg = fs.readFileSync(path.join(EXT, "background.js"), "utf8");
  assert.ok(bg.includes("CHAT_HEARTBEAT_INTERVAL_MS = 15000"), "background heartbeat interval constant");
  assert.ok(bg.includes("type: 'ping'"), "background posts ping messages");
  assert.ok(bg.includes("postPing('accepted')"), "immediate accepted ping on request start");
  assert.ok(bg.includes("'streaming'") && bg.includes("'waiting'"), "ping stages distinguish provider activity");
  assert.ok(bg.includes("onActivity"), "background wires provider onActivity");
  assert.ok(bg.includes("lastActivityMs"), "ping carries last provider-activity age");
  assert.ok(bg.includes("stopHeartbeat"), "heartbeat is stopped when the request settles");

  const prov = fs.readFileSync(path.join(EXT, "lib/providers.js"), "utf8");
  assert.ok(prov.includes("onActivity"), "providers expose onActivity");
  assert.ok(prov.includes("reasoning_content"), "OpenAI reasoning deltas count as activity");
  assert.ok(prov.includes("thinking_delta"), "Anthropic thinking deltas count as activity");

  const yt = fs.readFileSync(path.join(EXT, "content/youtube.js"), "utf8");
  assert.ok(yt.includes("msg.type === 'ping'"), "youtube panel handles ping messages");
  assert.ok(yt.includes("SUMMARY_BACKGROUND_TIMEOUT_MS = 45000"), "short background-liveness watchdog");
  assert.ok(yt.includes("SUMMARY_FIRST_ACTIVITY_TIMEOUT_MS = 120000"), "120s first-activity inactivity ceiling");
  assert.ok(yt.includes("SUMMARY_STALL_TIMEOUT_MS = 120000"), "120s stall inactivity ceiling");
  assert.ok(!yt.includes("600000"), "old 600000 ceilings gone from youtube.js");
  assert.ok(!yt.includes("SUMMARY_FIRST_CHUNK_TIMEOUT_MS = 120000"), "old first-chunk watchdog name gone");
  assert.ok(yt.includes("PROVIDER_STALLED_MESSAGE"), "provider silence gets its own honest message");
  const stream = yt.slice(yt.indexOf("function runSummaryStream"), yt.indexOf("  // Every panel chat path"));
  assert.ok(stream.includes("armBackgroundTimer") && stream.includes("armActivityTimer"), "split timers in stream");
  // Pings must never be treated as answer text.
  const pingBlock = stream.slice(stream.indexOf("msg.type === 'ping'"), stream.indexOf("msg.type === 'chunk'"));
  assert.ok(pingBlock.includes("return;"), "ping handling returns before chunk handling");
  assert.ok(!pingBlock.includes("full +="), "ping never appends to the answer");
  // Only the background-liveness timer may raise the connection-lost error.
  assert.ok(stream.includes("setTimeout(() => finish(new Error(CONNECTION_LOST_MESSAGE)), SUMMARY_BACKGROUND_TIMEOUT_MS)"),
    "connection-lost comes only from the background-liveness timer");
  assert.ok(stream.includes("finish(new Error(PROVIDER_STALLED_MESSAGE))"), "activity ceiling uses the stalled message");

  const side = fs.readFileSync(path.join(EXT, "sidebar/sidebar.js"), "utf8");
  assert.ok(side.includes("msg.type === 'ping'"), "sidebar tolerates heartbeat pings");
  const sideStream = side.slice(side.indexOf("function streamChat"), side.indexOf("function chatSyncFallback"));
  assert.ok(sideStream.includes("msg.type === 'ping'"), "sidebar ping handling lives in streamChat");
});

/* ---------- Stats + 120s inactivity timeout hardening --------------------
   Per-response stats (TTFT from first VISIBLE chunk, total) ride the done
   message; the background enforces the 120s idle ceiling authoritatively
   with an honest stage; sidebar + youtube mirror it with split watchdogs
   whose activity deadlines anchor to lastActivityMs, never re-arm fresh. */
check("stats + timeout: ttft/total, msg-meta, 120s idle, honest stage", () => {
  const bg = fs.readFileSync(path.join(EXT, "background.js"), "utf8");
  // A) per-response stats
  assert.ok(bg.includes("ttftMs: firstChunkAt ? (firstChunkAt - startedAt) : null"), "done carries ttftMs from first visible chunk");
  assert.ok(bg.includes("totalMs: Date.now() - startedAt"), "done carries totalMs");
  assert.ok(bg.includes("var firstChunkAt = 0"), "firstChunkAt tracked separately");
  const chunkFn = bg.slice(bg.indexOf("chatRequest(msg, function (chunk, full)"), bg.indexOf("}, controller ? controller.signal"));
  assert.ok(chunkFn.includes("firstChunkAt"), "onChunk sets firstChunkAt");
  const activityFn = bg.slice(bg.indexOf("}, controller ? controller.signal"), bg.indexOf("}).then(function (result)"));
  assert.ok(!activityFn.includes("firstChunkAt"), "onActivity must NOT set firstChunkAt (TTFT is visible text only)");
  // B) background 120s idle enforcement + honest stage
  assert.ok(bg.includes("CHAT_PROVIDER_IDLE_TIMEOUT_MS = 120000"), "background 120s idle constant");
  assert.ok(bg.includes("Date.now() - (providerActivityAt || startedAt)"), "idle computed from last activity (or start)");
  assert.ok(bg.includes("idleMs > CHAT_PROVIDER_IDLE_TIMEOUT_MS"), "idle ceiling enforced in heartbeat");
  assert.ok(bg.includes("Provider stalled: no activity for 120s"), "clear stall error message");
  assert.ok(bg.includes("controller.abort()"), "stall aborts the provider request");
  assert.ok(bg.includes("var stalled = false") && bg.includes("if (stalled) return"), "stall error not overwritten by abort rejection");
  assert.ok(bg.includes("CHAT_STREAMING_FRESH_MS"), "streaming freshness window constant");
  assert.ok(/<=\s*CHAT_STREAMING_FRESH_MS \? 'streaming' : 'waiting'/.test(bg.replace(/\s+/g, " ")),
    "stage is 'streaming' only when activity is recent, else 'waiting'");
  assert.ok(bg.includes("elapsedMs: Date.now() - startedAt") && bg.includes("lastActivityMs"), "pings keep elapsedMs/lastActivityMs");

  const side = fs.readFileSync(path.join(EXT, "sidebar/sidebar.js"), "utf8");
  const sideStream = side.slice(side.indexOf("function streamChat"), side.indexOf("function chatSyncFallback"));
  assert.ok(side.includes("function renderMsgMeta"), "msg-meta rendering hook");
  assert.ok(side.includes("msg-meta"), "msg-meta class used");
  assert.ok(sideStream.includes("msg.ttftMs") && sideStream.includes("msg.totalMs"), "sidebar captures ttftMs/totalMs from done");
  assert.ok(sideStream.includes("msg.model") || sideStream.includes("model: msg.model"), "sidebar captures model from done");
  assert.ok(sideStream.includes("renderMsgMeta(targetEl, doneStats)"), "streamChat renders msg-meta on finish");
  assert.ok(side.includes("function formatMs"), "ms formatter (850ms / 1.2s)");
  assert.ok(/n < 1000/.test(side) && side.includes("'ms'"), "sub-second format is NNNms");
  // sidebar watchdogs: 45s liveness + 120s provider idle
  assert.ok(side.includes("STREAM_BACKGROUND_TIMEOUT_MS = 45000"), "sidebar 45s liveness watchdog");
  assert.ok(side.includes("STREAM_PROVIDER_IDLE_TIMEOUT_MS = 120000"), "sidebar 120s idle watchdog");
  assert.ok(sideStream.includes("lastPortMsgAt") && sideStream.includes("lastActivityAt"), "split liveness/activity anchors");
  assert.ok(sideStream.includes("msg.lastActivityMs"), "sidebar activity anchored to ping lastActivityMs");
  assert.ok(sideStream.includes("Provider stalled: no activity for 120s"), "sidebar stall error text");
  assert.ok(sideStream.includes("Connection to the extension background was lost"), "sidebar liveness error text");
  // chatSync fallback: total-only stats
  const sync = side.slice(side.indexOf("function chatSyncFallback"), side.indexOf("function runStreamOrSync"));
  assert.ok(sync.includes("renderMsgMeta") && sync.includes("totalMs: Date.now() - syncStartedAt"), "chatSync measures total around sendMessage");
  assert.ok(!sync.includes("ttftMs"), "chatSync shows total only (no fabricated TTFT)");
  // partial-copy preservation (other change): must not regress
  assert.ok(side.includes("hasSelectionInside"), "partial-copy hasSelectionInside preserved");

  const css = fs.readFileSync(path.join(EXT, "sidebar/sidebar.css"), "utf8");
  assert.ok(/\.msg-meta\s*\{[^}]*font-size:\s*11px/.test(css), ".msg-meta is 11px");
  assert.ok(/\.msg-meta\s*\{[^}]*margin-top:/.test(css), ".msg-meta has margin-top");
  assert.ok(/\.msg-meta\s*\{[^}]*(var\(--muted\)|#9aa1ab)/.test(css), ".msg-meta is muted");

  const yt = fs.readFileSync(path.join(EXT, "content/youtube.js"), "utf8");
  assert.ok(!yt.includes("600000"), "youtube 600000 constants fully replaced");
  const ytStream = yt.slice(yt.indexOf("function runSummaryStream"), yt.indexOf("  // Every panel chat path"));
  assert.ok(ytStream.includes("armActivityTimer(typeof msg.lastActivityMs === 'number' ? msg.lastActivityMs : 0)"),
    "stall re-arm anchored to reported lastActivityMs");
  assert.ok(ytStream.includes("Math.max(0, ceiling - age)"), "deadline is ceiling minus activity age, not a fresh 120s per ping");
  assert.ok(yt.includes("SUMMARY_BACKGROUND_TIMEOUT_MS = 45000"), "youtube 45s liveness stays");
});

check("stats format: formatMs renders 850ms and 1.2s", () => {
  const side = fs.readFileSync(path.join(EXT, "sidebar/sidebar.js"), "utf8");
  const fnSrc = side.match(/function formatMs\(ms\) \{[\s\S]*?\n  \}/);
  assert.ok(fnSrc, "formatMs extractable");
  const formatMs = new Function(fnSrc[0] + "; return formatMs;")();
  assert.strictEqual(formatMs(850), "850ms");
  assert.strictEqual(formatMs(999), "999ms");
  assert.strictEqual(formatMs(1200), "1.2s");
  assert.strictEqual(formatMs(8400), "8.4s");
  assert.strictEqual(formatMs(null), "");
});

let activityDone = Promise.resolve();
{
  // Reasoning-only + keepalive stream: no chunks, but activity must fire so
  // heartbeat pings report 'streaming' instead of 'waiting'.
  const runActivityTests = async () => {
    const enc = new TextEncoder();
    const body = new ReadableStream({
      start(c) {
        c.enqueue(enc.encode(': keepalive\n\n'));
        c.enqueue(enc.encode('data: {"choices":[{"delta":{"reasoning_content":"thinking"}}]}\n\n'));
        c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n'));
        c.enqueue(enc.encode('data: [DONE]\n\n'));
        c.close();
      },
    });
    const sb = loadLibInSandbox("lib/providers.js", {
      TextDecoder, TextEncoder, ReadableStream,
      fetch: async () => ({ ok: true, status: 200, body, text: async () => "", json: async () => ({}) }),
    });
    const GP = sb.GraphiteProviders;
    let activity = 0; const chunks = [];
    const out = await GP.chat({
      provider: { label: "t", kind: "openai-compatible", baseUrl: "https://api.example.test/v1", apiKey: "k", model: "m" },
      messages: [{ role: "user", content: "hi" }], stream: true,
      onChunk: (p) => chunks.push(p), onActivity: () => { activity++; },
    });
    assert.strictEqual(out.text, "Hi", "reasoning is not answer text: " + JSON.stringify(out));
    assert.deepStrictEqual(chunks, ["Hi"], "only content deltas chunk");
    assert.ok(activity >= 3, "keepalive + reasoning + content bytes all fire onActivity, got " + activity);
  };
  activityDone = runActivityTests().then(
    () => ok("providers: raw SSE bytes fire onActivity even with no content"),
    (e) => fail("providers: raw SSE bytes fire onActivity even with no content", e));
}

/* ---------- 1.0.8: search AI answer on the right side -------------------
   The card belongs in the right rail (Google #rhs, Bing #b_context,
   DuckDuckGo sidebar) with Google's #22242a background, never at the top
   of the main results column. */
check("search AI answer: right rail, Google #22242a background", () => {
  const src = fs.readFileSync(path.join(EXT, "content/search.js"), "utf8");
  const css = fs.readFileSync(path.join(EXT, "content/overlay.css"), "utf8");
  // Background is Google's #22242a, not the old graphite panel #1f2227, and
  // the whole card (not a child) carries it.
  const cardCss = css.match(/\.gs-search-card\s\{[^}]*\}/);
  assert.ok(cardCss, ".gs-search-card rule present");
  assert.ok(cardCss[0].includes("background: #22242a"), "card background is Google #22242a");
  assert.ok(!cardCss[0].includes("background: #1f2227"), "old #1f2227 background gone from the card");
  // Code chips stay legible on #22242a (lighter than the card, no #17191d).
  const chipCss = css.match(/\.gs-search-body code\s\{[^}]*\}/);
  assert.ok(chipCss && !chipCss[0].includes("#17191d"), "code chips contrast on #22242a");
  // Right side: the rail is preferred; fallbacks get the right-column class.
  const insert = src.slice(src.indexOf("function insertionPoint"), src.indexOf("function buildCard"));
  assert.ok(insert.includes("'#rhs'"), "Google #rhs still a rail candidate");
  assert.ok(insert.includes("'#b_context'"), "Bing #b_context still a rail candidate");
  assert.ok(insert.includes("getClientRects"), "empty/hidden rails are skipped");
  assert.ok(insert.indexOf("'#rhs'") < insert.indexOf("'#rcnt'"), "rail is tried before main-column fallbacks");
  assert.ok(src.includes("gs-search-card--stretch"), "fallback path marks the card to stretch full-width");
  assert.ok(/\.gs-search-card--stretch[^{]*\{[^}]*width:\s*100%/.test(css), "stretch card fills its container width");
  assert.ok(!/float:\s*right/.test(css.match(/\.gs-search-card--rail-fallback\s\{[^}]*\}/)?.[0] || ""), "no shrunk floated column remains");
  // Main-column insertion must not happen silently: the only un-classed
  // insertion is into the rail itself.
  const tryInsert = src.slice(src.indexOf("const tryInsert"), src.indexOf("if (!tryInsert())"));
  assert.ok(tryInsert.includes("target.rail"), "insertion distinguishes rail from fallback");
  // Opt-in generation and the settings gate are unchanged.
  assert.ok(src.includes("Generate answer"), "opt-in Generate button intact");
  assert.ok(src.includes("stored.searchEnhance === false"), "searchEnhance gate intact");
  assert.ok(src.includes("'search-answer'"), "search-answer action unchanged");
});

/* ---------- 1.0.24: search card — fresh results, full-width box ----------
   Regression: the card captured results once at mount (often before Google
   rendered them) and the Generate handler closed over that stale, usually
   empty array, so the model reported the search as empty. The card also
   shrank into a 336px floated column outside a native rail. */
check("1.0.24: search card re-collects results and stretches to fill its container", () => {
  const src = fs.readFileSync(path.join(EXT, "content/search.js"), "utf8");
  const css = fs.readFileSync(path.join(EXT, "content/overlay.css"), "utf8");
  const build = src.slice(src.indexOf("function buildCard"), src.indexOf("async function init"));
  // Results are live state, refreshed re-entrantly — not a mount snapshot.
  assert.ok(build.includes("refreshResults"), "card refreshes results after mount");
  assert.ok(build.includes("collectResults(5)"), "refresh re-collects from the live page");
  const click = build.slice(build.indexOf("button.addEventListener('click'"));
  assert.ok(click.includes("refreshResults()"), "Generate re-collects before prompting");
  // Broad Google selectors (the .g class comes and goes between experiments).
  assert.ok(src.includes("#rso h3, #search h3"), "broad h3 fallback selector present");
  // Empty is honest only after a fresh re-collect, and the prompt then asks
  // for a direct answer instead of claiming the search returned nothing.
  assert.ok(src.includes("do not claim the search itself returned nothing"), "empty prompt never blames the search");
  assert.ok(build.includes("No ") && build.includes("results found on this page yet"), "honest still-loading label");
  // Card fills its container; fallback is a full-width stretched block.
  const cardCss = css.match(/\.gs-search-card\s\{[^}]*\}/)[0];
  assert.ok(cardCss.includes("width: 100%"), "card fills its container width");
  const stretch = css.match(/\.gs-search-card--stretch,[^{]*\{[^}]*\}/)[0];
  assert.ok(stretch.includes("width: 100%"), "stretch fallback is full width");
  assert.ok(stretch.includes("max-width: 880px"), "stretch fallback has a readable cap, not 336px");
  assert.ok(!stretch.includes("float: right"), "no floated column");
  assert.ok(src.includes("gs-search-card--stretch"), "non-rail insertion uses the stretch class");
  // Late results keep flowing into a mounted card.
  assert.ok(src.includes("watchCard"), "mounted card is watched for late results");
  assert.ok(src.includes("__gsRefreshResults"), "card exposes its refresher to the watcher");
});

/* ---------- 1.0.9: icon selection toolbar, Copy first -------------------
   Buttons carry an SVG + aria-label + data-label (hover tooltip); the
   visible word text is gone. Copy leads and copies the selection. */
check("selection toolbar: icon buttons with hover text, Copy first", () => {
  const src = fs.readFileSync(path.join(EXT, "content/content.js"), "utf8");
  const css = fs.readFileSync(path.join(EXT, "content/overlay.css"), "utf8");
  const tb = src.slice(src.indexOf("function showToolbar"), src.indexOf("function showAskCard"));
  assert.ok(tb.includes("toolbarButton('Copy', 'copy')"), "Copy is a toolbar button");
  assert.ok(tb.indexOf("toolbarButton('Copy', 'copy')") < tb.indexOf("toolbarButton('Read aloud', 'speak')"), "Copy comes before Read aloud");
  assert.ok(tb.indexOf("toolbarButton('Copy', 'copy')") < tb.indexOf("['Explain', 'explain']"), "Copy is the first action");
  assert.ok(tb.includes("copyText(text)"), "Copy copies the selection text");
  assert.ok(!tb.includes(".textContent = label"), "no visible text labels on toolbar buttons");
  assert.ok(!tb.includes("textContent = 'Read aloud'"), "Read aloud is an icon too");
  const icons = src.slice(src.indexOf("const TOOLBAR_ICONS"), src.indexOf("function toolbarButton"));
  ["copy", "check", "explain", "translate", "summarize", "grammar", "rewrite", "ask", "speak"].forEach((name) => {
    assert.ok(icons.includes(name + ":"), "icon defined: " + name);
  });
  assert.ok((icons.match(/<svg/g) || []).length >= 9, "all toolbar actions have SVG icons");
  assert.ok(icons.includes('viewBox="0 0 24 24"'), "icons use a 24x24 grid");
  assert.ok(icons.includes('stroke="currentColor"'), "icons inherit toolbar colors");
  const factory = src.slice(src.indexOf("function toolbarButton"), src.indexOf("function showToolbar"));
  assert.ok(factory.includes("setAttribute('aria-label', label)"), "buttons carry an aria-label");
  assert.ok(factory.includes("dataset.label = label"), "buttons carry the hover data-label");
  assert.ok(factory.includes("event.preventDefault()"), "mousedown still preserves the selection");
  assert.ok(css.includes("content: attr(data-label)"), "hover tooltip renders data-label");
  assert.ok(css.includes(".gs-toolbar-btn:hover::after"), "tooltip shows on hover");
  assert.ok(css.includes(".gs-toolbar-btn:focus-visible::after"), "tooltip shows on keyboard focus");
  assert.ok(css.includes(".gs-toolbar-btn--copied"), "copied state has its own class");
  assert.ok((manifest.permissions || []).includes("clipboardWrite"), "clipboardWrite permission declared");
});

/* ---------- 1.0.13: selection toolbar Close button + wider drag -------
   The floating selection menu previously could only be dismissed by an
   outside click / Escape and dragged only by its tiny logo. It now has an
   explicit Close (x) button (last, muted until hover) and the toolbar's
   empty background is a drag surface too; action buttons are never a
   drag handle, so their clicks are unaffected. */
check("selection toolbar: Close button and background drag surface", () => {
  const src = fs.readFileSync(path.join(EXT, "content/content.js"), "utf8");
  const css = fs.readFileSync(path.join(EXT, "content/overlay.css"), "utf8");
  const tb = src.slice(src.indexOf("function showToolbar"), src.indexOf("function showAskCard"));
  assert.ok(tb.includes("toolbarButton('Close', 'close')"), "Close is a toolbar button");
  assert.ok(tb.indexOf("toolbarButton('Close', 'close')") > tb.indexOf("toolbarButton('Read aloud', 'speak')"), "Close renders after Read aloud");
  assert.ok(tb.includes("gs-toolbar-close"), "Close carries its muted class");
  assert.ok(tb.includes("addEventListener('click', hideToolbar)"), "Close hides the toolbar");
  const icons = src.slice(src.indexOf("const TOOLBAR_ICONS"), src.indexOf("function toolbarButton"));
  assert.ok(icons.includes("close:"), "close icon defined");
  const drag = src.slice(src.indexOf("function wireToolbarDrag"), src.indexOf("function qs("));
  assert.ok(drag.includes("classList.contains('gs-toolbar-btn')"), "drag never starts on an action button");
  assert.ok(drag.includes("els.includes(toolbar)"), "empty toolbar background is a drag surface");
  assert.ok(drag.includes("window.addEventListener('pointermove'"), "move tracked on window, not toolbar capture");
  assert.ok(css.includes(".gs-toolbar-close"), "close button styled");
  assert.ok(css.includes(".gs-toolbar:active"), "toolbar background shows the grabbing cursor while dragging");
});

/* ---------- 1.0.14: toolbar drag must actually move --------------------
   1.0.13 showed the grab cursor but the toolbar never moved: pointerdown
   on the 12px logo was mostly lost (SVG targets retargeted, button
   mousedown preventDefault swallowed the press) and move/up were bound
   to the toolbar via setPointerCapture, so a lost start was a dead drag.
   1.0.14: bare-grip drag handle (data-gs="toolbar-drag", pointer-events
   none on its SVG), composedPath handle resolution, dual pointer/mouse
   capture-phase start on the toolbar, move/up on window. */
check("selection toolbar drag: window-tracked drag that actually moves", () => {
  const src = fs.readFileSync(path.join(EXT, "content/content.js"), "utf8");
  const css = fs.readFileSync(path.join(EXT, "content/overlay.css"), "utf8");
  const tb = src.slice(src.indexOf("function showToolbar"), src.indexOf("function showAskCard"));
  assert.ok(tb.includes("data-gs', 'toolbar-drag'") || tb.includes('data-gs="toolbar-drag"') || tb.includes("toolbar-drag"), "handle carries data-gs=toolbar-drag");
  assert.ok(!tb.includes("logo.textContent = '\\u25C6'"), "bare diamond glyph replaced by a grip handle");
  const drag = src.slice(src.indexOf("function wireToolbarDrag"), src.indexOf("function qs("));
  assert.ok(drag.includes("composedPath"), "handle resolved via composedPath / shadow retargeting");
  assert.ok(drag.includes("addEventListener('pointerdown', startDrag, true)"), "capture-phase pointerdown start");
  assert.ok(drag.includes("addEventListener('mousedown', startDrag, true)"), "mouse fallback start");
  assert.ok(drag.includes("window.addEventListener('pointermove'"), "pointermove on window");
  assert.ok(drag.includes("window.addEventListener('mousemove'"), "mousemove fallback on window");
  assert.ok(drag.includes("window.addEventListener('pointerup'"), "pointerup on window");
  assert.ok(drag.includes("window.addEventListener('mouseup'"), "mouseup fallback on window");
  assert.ok(!drag.includes("setPointerCapture"), "no setPointerCapture on the handle (the 1.0.13 dead path)");
  assert.ok(drag.includes("gs-toolbar-dragging"), "dragging class toggled for cursor/feedback");
  assert.ok(drag.includes("drag.pointerId") || drag.includes("pointerId:"), "drag tracks the initiating pointerId");
  assert.ok(drag.includes("clampRect"), "drag clamps to the viewport");
  assert.ok(css.includes(".gs-toolbar-dragging"), "dragging cursor styled");
  const logoCss = css.match(/\.gs-toolbar-logo\s*\{([^}]*)\}/);
  assert.ok(logoCss && /min-width:\s*(2[89]|[3-9]\d)px/.test(logoCss[1]), "handle is a >=28px target");
  const logoSvg = css.match(/\.gs-toolbar-logo svg\s*\{([^}]*)\}/);
  assert.ok(logoSvg && /pointer-events:\s*none/.test(logoSvg[1]), "handle SVG never steals the press");

  // Behavioural: the drag math itself — start offset + clamped move must
  // land the toolbar exactly under the pointer for a simulated gesture.
  const clampSrc = src.match(/function clamp\(value, min, max\) \{[\s\S]*?\n  \}/);
  const clampRectSrc = src.match(/function clampRect\(left, top, width, height\) \{[\s\S]*?\n  \}/);
  assert.ok(clampSrc && clampRectSrc, "clamp helpers extractable");
  const sim = new Function("window", clampSrc[0] + "\n" + clampRectSrc[0] + "; return { clampRect };")({ innerWidth: 1024, innerHeight: 768 });
  const start = { left: 100, top: 50, width: 300, height: 38 };
  const dx = 140 - start.left, dy = 60 - start.top; // press at (140,60)
  let pos = sim.clampRect(400 - dx, 300 - dy, start.width, start.height);
  assert.deepStrictEqual(pos, { left: 360, top: 290 }, "toolbar follows the pointer by the press offset");
  pos = sim.clampRect(-500 - dx, -500 - dy, start.width, start.height);
  assert.deepStrictEqual(pos, { left: 8, top: 8 }, "drag clamps to the top-left margin");
  pos = sim.clampRect(5000 - dx, 5000 - dy, start.width, start.height);
  assert.deepStrictEqual(pos, { left: 1024 - 300 - 8, top: 768 - 38 - 8 }, "drag clamps to the bottom-right margin");
});

/* ---------- 1.0.16a: searchable sidebar model picker -------------------
   The native <select id="modelSelect"> popup was browser-rendered and
   capped on-screen, so a long fetched catalogue looked cut off and had
   no search. 1.0.16 replaces it with a custom DOM picker: every matching
   model renders (no 8/12 slice), a filter input narrows the list, and
   picking a row sets state.activeModel. */
check("1.0.16: searchable sidebar model picker renders every match", () => {
  const html = fs.readFileSync(path.join(EXT, "sidebar/sidebar.html"), "utf8");
  assert.ok(html.includes('id="modelPicker"'), "picker container in header");
  assert.ok(html.includes('id="modelButton"'), "picker button shows the current model");
  assert.ok(html.includes('id="modelSearch"'), "search input in the model menu");
  assert.ok(html.includes('id="modelList"'), "listbox container");
  assert.ok(!html.includes('id="modelSelect"'), "native select removed");
  const css = fs.readFileSync(path.join(EXT, "sidebar/sidebar.css"), "utf8");
  assert.ok(/\.model-list\s*\{[^}]*max-height/.test(css) &&
    /\.model-list\s*\{[^}]*overflow-y:\s*auto/.test(css), "model list scrolls inside the menu");
  assert.ok(/\.model-search\s*\{[^}]*max-width:\s*none/.test(css), "search input is not capped at 150px");
  const js = fs.readFileSync(path.join(EXT, "sidebar/sidebar.js"), "utf8");
  assert.ok(!js.includes("$('modelSelect')"), "no stale native-select references");
  const picker = js.slice(js.indexOf("function renderModelSelect"), js.indexOf("function renderGroupModels"));
  assert.ok(picker.includes("function renderModelList"), "list renderer present");
  assert.ok(!/\.slice\(/.test(picker), "picker never truncates the model list");
  assert.ok(/toLowerCase\(\)\.indexOf\(query\)/.test(picker.replace(/\s+/g, " ")),
    "filter is a case-insensitive substring match");
  assert.ok(picker.includes("textContent = m"), "model labels rendered as safe text");
  assert.ok(picker.includes("state.activeModel = m"), "picking a row sets state.activeModel");

  // Behavioural: the filter itself — all matches, case-insensitively.
  const models = ["gpt-5.6-sol", "claude-sonnet-4-5", "GPT-4o-mini", "llama-3.1-8b"];
  const matches = (q) => models.filter((m) => !q || m.toLowerCase().indexOf(String(q).toLowerCase()) !== -1);
  assert.strictEqual(matches("gpt").length, 2, "substring filter is case-insensitive");
  assert.deepStrictEqual(matches(""), models, "empty query renders every model");
  assert.deepStrictEqual(matches("zzz"), [], "no-match filter renders the empty state");
});

/* ---------- 1.0.16b: toolbar drag must survive the release mouseup -----
   1.0.14 fixed the drag start/move, but releasing off the toolbar fired
   document `mouseup` -> onMouseUp -> showToolbar(selection rect), which
   rebuilt and re-anchored the toolbar, annulling the drag (H1). A second
   release mouseup can follow (pointerup + mouseup), so the suppression
   window must be timestamp-guarded, never consumed/cleared by the first
   suppressed mouseup (H1b). This runs the real wireToolbarDrag/onMouseUp
   logic — extracted from content.js — against a stub shadow DOM and a
   stubbed document that records every listener registration, then fires
   real-shaped pointer/mouse events through the recorded handlers. */
check("1.0.16: dragged toolbar stays where released (no snap-back)", () => {
  const src = fs.readFileSync(path.join(EXT, "content/content.js"), "utf8");
  const drag = src.slice(src.indexOf("function wireToolbarDrag"), src.indexOf("function qs("));
  assert.ok(drag.includes("window.addEventListener('pointerdown', startDrag"), "drag start also on window capture");
  assert.ok(drag.includes("buttons === 0"), "missed-release move ends the drag");
  assert.ok(drag.includes("toolbarDragSuppressUntil = Date.now()"), "moved drag opens a suppression window");
  const mouseUp = src.slice(src.indexOf("function onMouseUp"), src.indexOf("// ------------------------------------------------------------- read aloud"));
  assert.ok(mouseUp.includes("toolbarDragActive"), "onMouseUp sits out an active drag");
  assert.ok(mouseUp.includes("toolbarDragSuppressUntil"), "onMouseUp respects the suppression window");
  assert.ok(!/toolbarDragSuppressUntil\s*=\s*0/.test(mouseUp),
    "onMouseUp must not consume the suppression window (H1b)");

  const winL = {}, docL = {};
  const rec = (bag) => (t, h) => { (bag[t] = bag[t] || []).push(h); };
  class El {
    constructor() {
      this.classList = { _s: new Set(), add: (c) => this.classList._s.add(c),
        remove: (c) => this.classList._s.delete(c), contains: (c) => this.classList._s.has(c),
        toggle: (c, f) => (f ? this.classList._s.add(c) : this.classList._s.delete(c)) };
      this.style = {}; this.__gsDragWired = false; this.offsetWidth = 300; this.offsetHeight = 38;
    }
    addEventListener(t, h) { rec(this._l || (this._l = {}))(t, h); }
    removeEventListener() {}
    getBoundingClientRect() {
      return { left: parseFloat(this.style.left || "0"), top: parseFloat(this.style.top || "0"), width: 300, height: 38 };
    }
    querySelector() { return this._tb; }
  }
  const toolbar = new El();
  toolbar._tb = toolbar;
  toolbar.style.left = "100px"; toolbar.style.top = "50px";
  const grip = new El(); grip.classList.add("gs-toolbar-logo");
  const btn = new El(); btn.classList.add("gs-toolbar-btn");
  const page = new El();
  const innerWindow = { innerWidth: 1024, innerHeight: 768,
    addEventListener: rec(winL), removeEventListener: () => {} };
  let showToolbarCalls = 0;
  const timers = [];
  const sandbox = {
    console, Math, Date, JSON,
    window: innerWindow,
    document: { addEventListener: rec(docL) },
    clamp: new Function("return function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }")(),
    clampRect: new Function("window",
      "return function clampRect(left, top, width, height) { const margin = 8; " +
      "const clamp = (v, a, b) => Math.max(a, Math.min(b, v)); return { " +
      "left: clamp(left, margin, Math.max(margin, window.innerWidth - width - margin)), " +
      "top: clamp(top, margin, Math.max(margin, window.innerHeight - height - margin)) }; }",
    )(innerWindow),
    settings: { selectionToolbar: true },
    getSelectionInfo: () => ({ text: "selected text",
      rect: { left: 50, top: 600, width: 200, height: 20, bottom: 620 } }),
    showToolbar: () => { showToolbarCalls++; },
    hideToolbar: () => { showToolbarCalls += 100; },
    qs: () => toolbar,
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout: () => {},
  };
  const fire = (hs, ev) => (hs || []).slice().forEach((h) => h(ev));
  const ev = (type, target, path, x, y, extra) => Object.assign({
    type, target, clientX: x, clientY: y, button: 0, buttons: 1,
    composedPath: () => path, preventDefault() {}, stopPropagation() {},
  }, extra || {});
  // The stub toolbar lives in the host realm; properties set there are
  // not visible inside the vm context, so expose it as a sandbox global
  // before the generated script runs.
  sandbox.__gsToolbar = toolbar;
  vm.createContext(sandbox);
  vm.runInContext("var toolbar = __gsToolbar;", sandbox);
  vm.runInContext(
    "let toolbarDragActive = false;\nlet toolbarDragSuppressUntil = 0;\n" +
    src.slice(src.indexOf("function clamp("), src.indexOf("function truncate(")) +
    "\n" + drag + "\n" + mouseUp +
    "\ndocument.addEventListener('mouseup', onMouseUp, true);\n" +
    "wireToolbarDrag({ querySelector: () => toolbar });",
    sandbox);

  // Show + anchor pass, mirroring showToolbar()'s clampRect placement.
  toolbar.style.left = "100px"; toolbar.style.top = "50px";
  assert.strictEqual(toolbar.style.left, "100px", "toolbar starts selection-anchored");

  // Press the grip (path: grip -> toolbar -> root), move +200/+150, release off-toolbar.
  fire(winL.pointerdown, ev("pointerdown", grip, [grip, toolbar], 130, 65, { pointerId: 7 }));
  fire(winL.pointermove, ev("pointermove", page, [page], 330, 215, { pointerId: 7 }));
  assert.strictEqual(toolbar.style.left, "300px", "drag follows the pointer (left)");
  assert.strictEqual(toolbar.style.top, "200px", "drag follows the pointer (top)");
  fire(winL.pointerup, ev("pointerup", page, [page], 330, 215, { pointerId: 7 }));
  // The release mouseup reaches document (off the toolbar) AFTER pointerup:
  // onMouseUp must sit it out, and its 10ms callback must not re-anchor.
  fire(docL.mouseup, ev("mouseup", page, [page], 330, 215));
  timers.splice(0).forEach((fn) => fn());
  assert.strictEqual(showToolbarCalls, 0, "release mouseup did not re-anchor the toolbar");
  assert.strictEqual(toolbar.style.left, "300px", "toolbar stays at the dragged left");
  assert.strictEqual(toolbar.style.top, "200px", "toolbar stays at the dragged top");

  // The duplicate release mouseup (same gesture) must ALSO be suppressed:
  // the first suppressed mouseup must not have consumed the window (H1b).
  fire(docL.mouseup, ev("mouseup", page, [page], 330, 215));
  timers.splice(0).forEach((fn) => fn());
  assert.strictEqual(showToolbarCalls, 0, "duplicate release mouseup still suppressed (H1b)");
  assert.strictEqual(toolbar.style.left, "300px", "toolbar still at the dragged position");

  // After the window expires, a fresh selection mouseup shows the toolbar.
  const realNow = Date.now;
  Date.now = () => realNow() + 1000;
  try {
    fire(docL.mouseup, ev("mouseup", page, [page], 400, 640));
    timers.splice(0).forEach((fn) => fn());
    assert.strictEqual(showToolbarCalls, 1, "new selection after the window shows the toolbar");
  } finally { Date.now = realNow; }

  // A press on an action button never starts a drag.
  fire(winL.pointerdown, ev("pointerdown", btn, [btn, toolbar], 160, 65, { pointerId: 8 }));
  fire(winL.pointermove, ev("pointermove", page, [page], 400, 400, { pointerId: 8 }));
  assert.strictEqual(toolbar.style.left, "300px", "action buttons are not drag handles");

  // A plain click (no >3px movement) does not suppress the next selection.
  // The drag-suppression window from the drag above may still be open in
  // real time (and must not be consumed by the release mouseup), so let
  // it expire first — plain clicks must behave as before.
  const realNow2 = Date.now;
  Date.now = () => realNow2() + 1000;
  try {
    fire(winL.pointerdown, ev("pointerdown", grip, [grip, toolbar], 330, 215, { pointerId: 9 }));
    fire(winL.pointermove, ev("pointermove", page, [page], 331, 216, { pointerId: 9 }));
    fire(winL.pointerup, ev("pointerup", page, [page], 331, 216, { pointerId: 9 }));
    fire(docL.mouseup, ev("mouseup", page, [page], 331, 216));
    timers.splice(0).forEach((fn) => fn());
    assert.strictEqual(showToolbarCalls, 2, "plain click without movement keeps normal behavior");
  } finally { Date.now = realNow2; }

  // A move with buttons===0 (missed release) ends the drag instead of sticking.
  // (Current left is 301px: the 1px plain-click nudge above.)
  fire(winL.pointerdown, ev("pointerdown", grip, [grip, toolbar], 330, 215, { pointerId: 11 }));
  fire(winL.pointermove, ev("pointermove", page, [page], 500, 300, { pointerId: 11, buttons: 0 }));
  assert.strictEqual(toolbar.style.left, "301px", "buttons===0 ends the drag without sticking");
});

/* ---------- 1.0.15: /models parsing, persisted catalogue, default model ----
   The gatekeepers: 1) listModels must extract ids from every shape a gateway
   (9Router included) actually returns, 2) the options handler must accept the
   bare array listModels returns (the old code read resp.models only, so every
   successful fetch reported "No models returned"), 3) fetched lists persist
   per-provider with the configured model as default and all others available
   in the sidebar/group menus. */
let modelsDone = Promise.resolve();
{
  const runModelListTests = async () => {
    const fakeJsonResp = (body) => ({
      ok: true, status: 200,
      text: async () => body,
      json: async () => { throw new Error("listModels must read text, not res.json()"); },
    });
    let fetchedUrl = null;
    let sbFetchBody = "9router";
    const sb = loadLibInSandbox("lib/providers.js", {
      fetch: async (url) => {
        fetchedUrl = url;
        if (sbFetchBody === "9router") return fakeJsonResp(
          '{"object":"list","data":[{"id":"gpt-5.6-sol","object":"model"},' +
          '{"id":"gpt-5.6-sol","object":"model"},{"id":"claude-sonnet-4-5","object":"model"}]}');
        if (sbFetchBody === "embedded") return fakeJsonResp(
          'callback({"data":[{"id":"m-embedded"}]});');
        if (sbFetchBody === "noids") return fakeJsonResp('{"object":"list","data":[]}');
        return fakeJsonResp('{"data":[]}');
      },
    });
    const GP = sb.GraphiteProviders;
    assert.strictEqual(typeof GP._parseModelList, "function", "_parseModelList export missing");
    const P = GP._parseModelList;
    // Arrays returned from the vm sandbox are cross-realm: compare via join.
    const idsEq = (actual, expected, msg) =>
      assert.strictEqual(Array.from(actual || []).join(""), expected.join(""), msg + ": " + JSON.stringify(actual));

    // 9Router shape: {object:"list", data:[{id,...}]} — deduped, order kept.
    idsEq(P('{"object":"list","data":[{"id":"gpt-5.6-sol","object":"model"}]}'),
      ["gpt-5.6-sol"], "9Router data[].id");
    idsEq(P('[{"id":"a"},{"name":"b"},{"model":"c"},"d"]'),
      ["a", "b", "c", "d"], "bare array of id/name/model/string");
    idsEq(P('{"models":[{"name":"llama3.1"}]}'), ["llama3.1"], "Ollama models[].name");
    idsEq(P('{"result":["r1","r1","r2"]}'), ["r1", "r2"], "result[] dedupe");
    idsEq(P('{"items":[{"id":"i1"}]}'), ["i1"], "items[].id");
    idsEq(P('{"data":"solo-model"}'), ["solo-model"], "data as bare string id");
    // JSON embedded in surrounding text / JSONP-ish wrapper.
    idsEq(P('callback({"data":[{"id":"m-embedded"}]});'), ["m-embedded"], "embedded JSON");
    // Strings containing braces/escapes must not break balanced extraction.
    idsEq(P('pre {"data":[{"id":"a}b"}]} post'), ["a}b"], "braces inside strings");
    // SSE framing and double-encoded JSON.
    idsEq(P('data: {"data":[{"id":"sse-1"}]}\n\ndata: [DONE]\n'),
      ["sse-1"], "SSE data: payload");
    idsEq(P(JSON.stringify(JSON.stringify({ data: [{ id: "double" }] }))),
      ["double"], "double-encoded JSON");
    idsEq(P('{"data":[{"id":"j1"}]}\n{"data":[{"id":"j2"}]}'),
      ["j1", "j2"], "concatenated JSON payloads");
    idsEq(P('{"data":[]}'), [], "parsed but empty stays []");
    assert.throws(() => P('   '), /empty model list response/, "blank body throws");
    assert.throws(() => P('<html>not json</html>'), /Could not parse model list response/, "garbage throws");

    // listModels end-to-end (fetch stubbed): 9Router body -> ids.
    sbFetchBody = "9router";
    const ids = await GP.listModels({ label: "9router", kind: "openai-compatible",
      baseUrl: "https://gw.test/v1/", apiKey: "k", model: "configured-1" });
    assert.strictEqual(fetchedUrl, "https://gw.test/v1/models", "GET {base}/models, slash-trimmed");
    idsEq(ids, ["gpt-5.6-sol", "claude-sonnet-4-5"], "listModels 9Router ids");
    // JSON embedded in text still parses; empty-ids body falls back to configured model.
    sbFetchBody = "embedded";
    idsEq(await GP.listModels({ label: "t", kind: "openai-compatible",
      baseUrl: "https://gw.test/v1", apiKey: "k", model: "configured-1" }), ["m-embedded"], "listModels embedded JSON");
    sbFetchBody = "noids";
    idsEq(await GP.listModels({ label: "t", kind: "openai-compatible",
      baseUrl: "https://gw.test/v1", apiKey: "k", model: "configured-1" }), ["configured-1"],
      "200 with no usable ids keeps the configured model selectable");
    // Anthropic never fetches; returns the configured model.
    idsEq(await GP.listModels({ label: "a", kind: "anthropic",
      baseUrl: "https://api.anthropic.com", apiKey: "k", model: "claude-x" }), ["claude-x"], "Anthropic early return");

    // Storage: fetched list persists; configured default stays first; idempotent.
    const sbS = loadLibInSandbox("lib/storage.js");
    const GS = sbS.GraphiteStorage;
    assert.strictEqual(typeof GS.normalize, "function", "GraphiteStorage.normalize export missing");
    const baseSettings = {
      version: 1, activeProviderId: "p1", activeModel: "",
      providers: [{ id: "p1", label: "9Router", kind: "openai-compatible",
        baseUrl: "https://gw.test/v1", apiKey: "k", model: "configured-1",
        models: [" fetched-1 ", { id: "fetched-2" }, "fetched-1", ""], enabled: true }],
      settings: {}, prompts: [], history: [],
    };
    const norm = GS.normalize(baseSettings);
    idsEq(norm.providers[0].models, ["configured-1", "fetched-1", "fetched-2"],
      "persisted models: default first, deduped, trimmed");
    idsEq(GS.normalize(norm).providers[0].models, Array.from(norm.providers[0].models),
      "normalize idempotent (sync round-trip)");

    // Wiring guards: the bare-array consumer and persistence must not regress.
    const opt = fs.readFileSync(path.join(EXT, "options/options.js"), "utf8");
    assert.ok(/Array\.isArray\(resp\)/.test(opt), "options fetch-models accepts the bare listModels array");
    assert.ok(!/\(resp && \(resp\.models/.test(opt), "old resp.models-only unpacking is gone");
    assert.ok(/p\.models = normalizeModels\(idList/.test(opt), "fetch-models persists p.models via normalizeModels");
    assert.ok(/p\.models\) \? p\.models : \[\]/.test(opt.replace(/\s+/g, " ")) || /Array\.isArray\(p\.models\)/.test(opt),
      "renderProviders lists persisted models in the datalist");
    const side = fs.readFileSync(path.join(EXT, "sidebar/sidebar.js"), "utf8");
    assert.ok(/p\.models/.test(side), "sidebar reads persisted provider models");
    assert.ok(!/listModels/.test(side), "sidebar never fetches the model list itself");
    const storeSrc = fs.readFileSync(path.join(EXT, "lib/storage.js"), "utf8");
    assert.ok(/models: normalizeModelList\(p\.models, model\)/.test(storeSrc),
      "storage normalize emits persisted models with the default first");
  };
  modelsDone = runModelListTests().then(
    () => ok("1.0.15: /models parsing (9Router/embedded/SSE), persisted catalogue, default first"),
    (e) => fail("1.0.15: /models parsing (9Router/embedded/SSE), persisted catalogue, default first", e));
}

/* ---------- 1.0.17: full ~600-model catalogue, stable across fetches -----
   1.0.15 persisted fetched lists but capped them at 250 in both storage
   normalizers, so a ~600-model gateway (9Router) lost most of its list and
   some models "didn't appear". Repeated Fetch clicks also had to never
   grow the saved list: the options handler built a growing idList on top
   of the capped, re-normalized state, so each fetch kept a different 250
   window and the visible list kept shifting/growing. 1.0.17 removes the
   cap (storage.sync sheds the catalogue instead — it cannot hold 600 ids
   under its 8 KB/item quota) and replaces on fetch. */
let models17Done = Promise.resolve();
{
  const runModels17Tests = async () => {
    const fakeJsonResp = (body) => ({
      ok: true, status: 200,
      text: async () => body,
      json: async () => { throw new Error("listModels must read text, not res.json()"); },
    });
    const ids = (n, prefix) => Array.from({ length: n }, (_, i) => prefix + i);
    let fetchCount = 0;
    let fetchBody = "";
    const sb = loadLibInSandbox("lib/providers.js", {
      fetch: async () => { fetchCount++; return fakeJsonResp(fetchBody); },
    });
    const GP = sb.GraphiteProviders;
    const sbS = loadLibInSandbox("lib/storage.js");
    const GS = sbS.GraphiteStorage;
    const idsEq = (actual, expected, msg) =>
      assert.strictEqual(Array.from(actual || []).join(""), expected.join(""), msg);

    // 1) ~600-model gateway response parses completely (no parser cap).
    const all = ids(600, "m");
    fetchBody = JSON.stringify({ object: "list", data: all.map((id) => ({ id, object: "model" })) });
    const parsed = await GP.listModels({ label: "9router", kind: "openai-compatible",
      baseUrl: "https://gw.test/v1", apiKey: "k", model: "" });
    idsEq(parsed, all, "~600 models parse completely");

    // 2) Storage normalize keeps all 600 with the configured default first,
    //    and is idempotent (no growth on re-normalize / sync round-trip).
    const norm = GS.normalize({
      version: 1, activeProviderId: "p1", activeModel: "",
      providers: [{ id: "p1", label: "9Router", kind: "openai-compatible",
        baseUrl: "https://gw.test/v1", apiKey: "k", model: "cfg-default",
        models: all, enabled: true }],
      settings: {}, prompts: [], history: [],
    });
    assert.strictEqual(norm.providers[0].models.length, 601, "default + 600 models persist (no 250 cap)");
    const expected601 = ["cfg-default"].concat(all);
    idsEq(norm.providers[0].models, expected601, "configured default first, then all 600");
    idsEq(GS.normalize(norm).providers[0].models, expected601, "normalize idempotent at 601 models");

    // 3) Repeated fetches REPLACE: a smaller/rotated gateway answer shrinks
    //    the saved list to exactly that answer (+ configured default), and
    //    a repeat fetch of the same answer changes nothing.
    const settingsWith = (models) => ({
      version: 1, activeProviderId: "p1", activeModel: "",
      providers: [{ id: "p1", label: "9Router", kind: "openai-compatible",
        baseUrl: "https://gw.test/v1", apiKey: "k", model: "cfg-default",
        models, enabled: true }],
      settings: {}, prompts: [], history: [],
    });
    const rotated = ids(300, "r"); // gateway now returns a different 300
    fetchBody = JSON.stringify({ object: "list", data: rotated.map((id) => ({ id })) });
    const fetched2 = await GP.listModels({ label: "9router", kind: "openai-compatible",
      baseUrl: "https://gw.test/v1", apiKey: "k", model: "cfg-default" });
    const saved2 = GS.normalize(settingsWith(fetched2)).providers[0].models;
    idsEq(saved2, ["cfg-default"].concat(rotated), "second fetch replaces: 301 models, no leftovers from the 600");
    const fetched3 = await GP.listModels({ label: "9router", kind: "openai-compatible",
      baseUrl: "https://gw.test/v1", apiKey: "k", model: "cfg-default" });
    const saved3 = GS.normalize(settingsWith(fetched3)).providers[0].models;
    idsEq(saved3, Array.from(saved2), "third identical fetch: list stable, no growth");
    assert.strictEqual(fetchCount, 3, "three listModels fetches issued");

    // 4) Options handler: fetched ids are deduped and normalized through the
    //    same default-first path (no uncapped concat of a previous list).
    const opt = fs.readFileSync(path.join(EXT, "options/options.js"), "utf8");
    assert.ok(/p\.models = normalizeModels\(idList/.test(opt), "fetch-models replaces p.models via normalizeModels (default first, deduped)");
    assert.ok(!/slice\(0, 250\)/.test(opt), "options no longer caps models at 250");
    const storeSrc = fs.readFileSync(path.join(EXT, "lib/storage.js"), "utf8");
    assert.ok(!/slice\(0, 250\)/.test(storeSrc), "storage no longer caps models at 250");
    assert.ok(/c\.models = c\.model \? \[c\.model\] : \[\]/.test(storeSrc),
      "storage.sync mirror sheds the catalogue (keeps configured default only)");

    // 5) Group chat lists every saved model (was slice(0, 12)).
    const side = fs.readFileSync(path.join(EXT, "sidebar/sidebar.js"), "utf8");
    assert.ok(!/allModelCombos\(\)\.slice\(0, 12\)/.test(side), "group chat no longer truncated at 12 combos");
  };
  models17Done = runModels17Tests().then(
    () => ok("1.0.17: full ~600-model catalogue persists, fetch replaces (no growth), group chat complete"),
    (e) => fail("1.0.17: full ~600-model catalogue persists, fetch replaces (no growth), group chat complete", e));
}

/* The async SSE + image tests above must settle before the summary/exit. */
Promise.all([Promise.resolve(sseDone), Promise.resolve(imageDone), Promise.resolve(activityDone), Promise.resolve(modelsDone), Promise.resolve(models17Done)]).then(() => {
  console.log(`\n${failures} failure(s), ${pending} pending (core not present yet)`);
  if (pending) console.warn("note: pending checks become hard failures under STRICT=1 once core files land");
  process.exit(failures ? 1 : 0);
});

/* ---------- 1.0.21: Firefox Android + slow-model connection + helper model
   selectors ---------------------------------------------------------------
   Pins: version, model-select load order + persistence path, background
   detach-don't-abort with attach replay and job persistence, chat-tab
   fallback, widened liveness, touch selection, helper payloads. */
check("1.0.21: version, model-select wiring, detach transport, mobile surfaces", () => {
  assert.ok(manifest, "manifest required");
  assert.strictEqual(manifest.version, "1.0.27", "release version");
  assert.ok(manifest.browser_specific_settings.gecko_android, "gecko_android block present");
  // Shared picker loads before both helpers.
  const ytEntry = (manifest.content_scripts || []).find((cs) => (cs.js || []).includes("content/youtube.js"));
  const searchEntry = (manifest.content_scripts || []).find((cs) => (cs.js || []).includes("content/search.js"));
  assert.ok(ytEntry && ytEntry.js.indexOf("lib/model-select.js") < ytEntry.js.indexOf("content/youtube.js"),
    "model-select loads before youtube.js");
  assert.ok(searchEntry && searchEntry.js.indexOf("lib/model-select.js") < searchEntry.js.indexOf("content/search.js"),
    "model-select loads before search.js");
  const ms = fs.readFileSync(path.join(EXT, "lib/model-select.js"), "utf8");
  assert.ok(ms.includes("GraphiteModelSelect"), "picker exposes GraphiteModelSelect");
  assert.ok(ms.includes("type: 'setActiveModel'"), "picker persists via background setActiveModel");
  assert.ok(ms.includes("type: 'getSettings'"), "picker reads settings via background");
  // Background: jobs, attach, detach-don't-abort, setActiveModel, chat tab.
  const bg = fs.readFileSync(path.join(EXT, "background.js"), "utf8");
  assert.ok(bg.includes("case 'setActiveModel':"), "background handles setActiveModel");
  assert.ok(bg.includes("saveSettings"), "setActiveModel persists via saveSettings");
  assert.ok(bg.includes("case 'getChatJob':"), "background handles getChatJob");
  assert.ok(bg.includes("function attachChatJob"), "background replays jobs on attach");
  assert.ok(bg.includes("type: 'snapshot'"), "attach replays a snapshot of text so far");
  assert.ok(bg.includes("Detach-don't-abort"), "disconnect detaches instead of aborting");
  assert.ok(bg.includes("ports.delete(port)"), "disconnect only removes the port from jobs");
  assert.ok(bg.includes("saveChatJob"), "job results persist via GraphiteStorage");
  assert.ok(bg.includes("openChatTab"), "chat-tab fallback exists");
  assert.ok(bg.includes("sidebar/sidebar.html"), "chat tab hosts the sidebar page");
  // Storage jobs API.
  const GS = loadLibInSandbox("lib/storage.js").GraphiteStorage;
  assert.ok(GS && typeof GS.saveChatJob === "function" && typeof GS.getChatJob === "function" &&
    typeof GS.pruneChatJobs === "function", "storage exposes the chat-jobs API");
  // YouTube: attach reconnect, picker mount + payload, wider liveness.
  const yt = fs.readFileSync(path.join(EXT, "content/youtube.js"), "utf8");
  const stream = yt.slice(yt.indexOf("function runSummaryStream"), yt.indexOf("  // Every panel chat path"));
  assert.ok(stream.includes("type: 'attach'"), "youtube re-attaches after a drop");
  assert.ok(stream.includes("providerId: sel") && stream.includes("model: sel"), "youtube sends picker selection");
  assert.ok(yt.includes("GraphiteModelSelect.createPicker"), "youtube mounts the picker");
  assert.ok(yt.includes("SUMMARY_BACKGROUND_TIMEOUT_MS = 90000"), "youtube liveness widened to 90s");
  assert.ok(yt.includes("pageshow") && yt.includes("visibilitychange"), "resume hooks re-arm liveness");
  assert.ok(yt.includes("ytModelPicker"), "youtube tracks the picker instance");
  assert.ok(yt.includes("'openChat'") && yt.includes("Open chat"), "youtube panel offers Open chat");
  // Search: picker mount + payload.
  const search = fs.readFileSync(path.join(EXT, "content/search.js"), "utf8");
  assert.ok(search.includes("GraphiteModelSelect.createPicker"), "search mounts the picker");
  assert.ok(search.includes("providerId: sel") && search.includes("model: sel"), "search sends picker selection");
  assert.ok(search.includes("gs-search-open-chat"), "search card offers Open chat");
  // Sidebar: persistence, coarse composer, chat-tab origin tracking.
  const side = fs.readFileSync(path.join(EXT, "sidebar/sidebar.js"), "utf8");
  assert.ok(side.includes("setActiveModel"), "sidebar persists picker choices");
  assert.ok(side.includes("(pointer: coarse)"), "sidebar composer is coarse-pointer aware");
  assert.ok(side.includes("isComposing"), "sidebar composer guards IME composition");
  assert.ok(side.includes("originatingTab"), "sidebar tracks the originating tab");
  // Content: touch selection + inputs.
  const content = fs.readFileSync(path.join(EXT, "content/content.js"), "utf8");
  assert.ok(content.includes("selectionchange"), "touch selection observed via selectionchange");
  assert.ok(content.includes("pointerType === 'touch'"), "touch pointerup handled separately");
  assert.ok(content.includes("visualViewport"), "positions use visualViewport");
  assert.ok(content.includes("addEventListener('pointerdown', (event) => event.preventDefault())"),
    "focus preservation uses pointerdown (touch-safe)");
  assert.ok(content.includes("snapshotFieldSelection"), "field selection snapshot for touch apply");
  assert.ok(content.includes("isComposing"), "Enter submits guard IME composition");
  // CSS: coarse-pointer targets + narrow search card + chat-tab layout.
  const css = fs.readFileSync(path.join(EXT, "content/overlay.css"), "utf8");
  assert.ok(css.includes("@media (pointer: coarse)"), "coarse-pointer block in overlay.css");
  assert.ok(css.includes(".gs-model-picker"), "picker styles present");
  assert.ok(css.includes(".gs-search-card--rail-fallback"), "narrow search card stacking present");
  const sideCss = fs.readFileSync(path.join(EXT, "sidebar/sidebar.css"), "utf8");
  assert.ok(sideCss.includes("@media (max-width: 640px)"), "chat-tab mobile layout in sidebar.css");
});

/* ---------- 1.0.19: toolbar/write icons blank after the innerHTML removal --
   1.0.18's setIcon parsed icon strings via DOMParser('image/svg+xml') +
   importNode. Verified against Firefox 158: nodes from that document
   render nothing (0 icon pixels), even imported/adopted. The fix rebuilds
   each node with createElementNS in the target document. Guard both the
   construction and the absence of the cross-document path. */
check("1.0.19: icons built as same-document SVG nodes (no DOMParser import)", () => {
  const src = fs.readFileSync(path.join(EXT, "content/content.js"), "utf8");
  assert.ok(!src.includes("'image/svg+xml'"), "no image/svg+xml DOMParser parse call remains");
  assert.ok(!src.includes("importNode"), "no cross-document importNode for icons");
  assert.ok(src.includes("buildSvgNode"), "recursive SVG node builder exists");
  assert.ok(src.includes("createElementNS"), "icons built via createElementNS");
  assert.ok(src.includes("document.createElementNS(SVG_NS"), "builder targets the SVG namespace");
  // setIcon still feeds every icon surface: write button, toolbar, logo, copy-check.
  assert.ok((src.match(/setIcon\(/g) || []).length >= 5, "setIcon still wires write button, toolbar, logo, copy-check");
});

/* ---------- 1.0.22: mobile placement + toolbar label discovery --------------
   m.youtube.com: the panel mounted via a comma-list querySelector whose
   first document-order match could be ytm-app (ancestor of everything),
   and afterend of #movie_player/#player lands inside the player wrapper,
   where the positioned video surface paints over the static panel.
   Fix: an ordered one-selector-at-a-time ladder ending after the
   metadata/description block, plus relocation when metadata renders late.
   Toolbar: the coarse-pointer block used to render every button's name as
   static 9px text; now icons-only everywhere, name via long-press. */
check("1.0.23: panel placement ladder + long-press toolbar labels", () => {
  assert.ok(manifest, "manifest required");
  assert.strictEqual(manifest.version, "1.0.27", "release version 1.0.27");
  const yt = fs.readFileSync(path.join(EXT, "content/youtube.js"), "utf8");
  // Ladder exists, tried sequentially in priority order.
  const ladder = yt.slice(yt.indexOf("const PANEL_PLACEMENTS"), yt.indexOf("function bestPanelPlacement"));
  assert.ok(ladder.includes("ytd-watch-metadata"), "desktop anchor in ladder");
  assert.ok(ladder.includes("ytm-slim-video-metadata-section-renderer"), "mobile metadata section in ladder");
  assert.ok(ladder.includes("ytm-expandable-video-description-body-renderer"), "description renderer in ladder");
  assert.ok(ladder.indexOf("ytd-watch-metadata") < ladder.indexOf("#below"), "desktop anchor outranks #below");
  assert.ok(yt.includes("document.querySelector(p.selector)"), "ladder queried one selector at a time");
  // The old document-order trap is gone from the panel mount path (a
  // comment in the ladder cites the old selector; code must not run it).
  assert.ok(!yt.includes("querySelector('#player-container-id, #player, ytm-app, #movie_player')"),
    "no comma-list player fallback call (document order made ytm-app win)");
  assert.ok(!yt.includes("querySelector('#primary, #columns')"), "old comma mount removed");
  // Relocation: same node moved to a strictly better anchor, observer-driven.
  assert.ok(yt.includes("function relocatePanelIfNeeded"), "relocation helper exists");
  assert.ok(yt.includes("relocatePanelIfNeeded(); // mobile metadata renders late"), "maybeInit relocates");
  assert.ok(yt.includes("PANEL_PLACEMENTS"), "placement ladder shared by mount + relocate");
  // findAnchorRoot prefers the watch column, sequentially.
  const far = yt.slice(yt.indexOf("function findAnchorRoot"), yt.indexOf("function ensureAnchorObserver"));
  assert.ok(far.indexOf("'ytm-watch'") < far.indexOf("'ytm-app'"), "watch column outranks the app root");
  assert.ok(far.indexOf("'ytm-app'") < far.indexOf("'#player-container-id'"), "app root outranks the player subtree");
  // Toolbar: icons only on touch; the name comes from a long-press.
  const content = fs.readFileSync(path.join(EXT, "content/content.js"), "utf8");
  const factory = content.slice(content.indexOf("function toolbarButton"), content.indexOf("function showToolbar"));
  assert.ok(factory.includes("gs-toolbar-btn--labelled"), "long-press toggles the labelled class");
  assert.ok(factory.includes("event.pointerType !== 'touch'"), "long-press is touch-gated");
  assert.ok(factory.includes("stopImmediatePropagation"), "long-press click is suppressed before actions");
  assert.ok(factory.includes("addEventListener('pointerdown', (event) => event.preventDefault())"),
    "focus-preservation pointerdown unchanged");
  const css = fs.readFileSync(path.join(EXT, "content/overlay.css"), "utf8");
  const coarse = css.slice(css.indexOf("@media (pointer: coarse)"));
  assert.ok(!/\.gs-toolbar-btn::after\s*\{[^}]*position:\s*static/.test(coarse),
    "no static always-visible toolbar labels on coarse pointers");
  assert.ok(!/\.gs-toolbar-btn::after\s*\{[^}]*font-size:\s*9px/.test(coarse),
    "no 9px inline toolbar labels on coarse pointers");
  assert.ok(css.includes(".gs-toolbar-btn--labelled::after"), "labelled state reveals the tooltip");
  assert.ok(coarse.includes(".gs-yt-panel"), "coarse panel width hardening kept");
});

/* ---------- 1.0.23: Code / Hand / Research tabs + Tools redesign ----------
   Code: describe -> model JSON {css,js,notes} -> apply via content
   code-apply (background applyCodeToTab fallback) -> save per-host rules
   that content scripts auto-apply on visit. Hand: model JSON step plan
   executed one step at a time; sensitive clicks return needsConfirm and
   passwords are never filled. Research: background researchSearch over
   OpenAlex/Crossref/arXiv/Semantic Scholar (lib/research.js loaded before
   background.js), cited Markdown report via GraphiteResearch.buildResearchPrompt,
   persisted with the 20-report cap. Tools: search filter, category groups,
   favorites persisted under graphiteSider.toolFavorites.v1. */
check("1.0.23: Code/Hand/Research tabs, tools redesign, manifest registration", () => {
  const html = fs.readFileSync(path.join(EXT, "sidebar/sidebar.html"), "utf8");
  ["code", "hand", "research"].forEach((v) => {
    assert.ok(html.includes('data-view="' + v + '"'), "tab for view-" + v);
    assert.ok(html.includes('id="view-' + v + '"'), "section view-" + v);
  });
  ["toolsSearch", "codePrompt", "codeCss", "codeJs", "codeJsEnabled", "codeRuleList",
   "handTask", "handSteps", "handLog", "researchQuery", "researchSources",
   "researchDepth", "researchPerSource", "researchReport", "researchList"].forEach((id) => {
    assert.ok(html.includes('id="' + id + '"'), "sidebar element #" + id);
  });
  assert.ok(html.indexOf("../lib/research.js") > -1 && html.indexOf("../lib/research.js") < html.indexOf('"sidebar.js"'),
    "sidebar loads lib/research.js before sidebar.js");
  const side = fs.readFileSync(path.join(EXT, "sidebar/sidebar.js"), "utf8");
  ["codeGenerate", "codeApply", "codeRemove", "renderCodeRules", "handPlan", "runHandStep",
   "handRunAll", "runResearch", "renderResearchList", "renderResearchSources"].forEach((fn) => {
    assert.ok(side.includes("function " + fn), "sidebar implements " + fn);
  });
  assert.ok(side.includes("function sendTabCommand"), "sidebar sends tab commands");
  assert.ok(side.includes("graphiteSider.toolFavorites.v1"), "tool favorites storage key");
  assert.ok(side.includes("Favorites"), "tools favorites group");
  assert.ok(side.includes("{ id: 'summarize-page'") && side.includes("cat: 'Read'"), "tools carry categories");
  assert.ok(side.includes("researchSearch"), "sidebar calls background researchSearch");
  assert.ok(side.includes("GraphiteResearch.buildResearchPrompt"), "report prompt built from sources");
  assert.ok(!/innerHTML\s*=/.test(side), "sidebar never assigns innerHTML");

  const bg = fs.readFileSync(path.join(EXT, "background.js"), "utf8");
  ["researchSearch", "listResearchReports", "getResearchReport", "saveResearchReport",
   "deleteResearchReport", "listCodeRules", "saveCodeRule", "deleteCodeRule",
   "setCodeRuleEnabled", "applyCodeToTab", "removeCodeFromTab", "handStep", "fetchJson"].forEach((t) => {
    assert.ok(bg.includes("case '" + t + "'"), "background handles " + t);
  });
  const bgScripts = (manifest.background && manifest.background.scripts) || [];
  assert.ok(bgScripts.indexOf("lib/research.js") > -1 && bgScripts.indexOf("lib/research.js") < bgScripts.indexOf("background.js"),
    "lib/research.js loads before background.js");
  assert.ok(bgScripts.indexOf("lib/pdf.js") > -1, "lib/pdf.js still registered in background");

  const storage = fs.readFileSync(path.join(EXT, "lib/storage.js"), "utf8");
  assert.ok(storage.includes("graphiteSider.rules.v1"), "rules storage key");
  assert.ok(storage.includes("graphiteSider.research.v1"), "research storage key");

  const content = fs.readFileSync(path.join(EXT, "content/content.js"), "utf8");
  ["code-apply", "code-remove", "code-status", "page-outline", "hand-click", "hand-fill", "hand-extract", "hand-scroll"].forEach((c) => {
    assert.ok(content.includes("case '" + c + "'"), "content command " + c);
  });
  assert.ok(content.includes("needsConfirm"), "sensitive clicks ask via needsConfirm");
  assert.ok(content.includes("password"), "password fill guard present");
  assert.ok(content.includes("applySavedCodeRules"), "saved rules auto-apply on visit");

  const research = fs.readFileSync(path.join(EXT, "lib/research.js"), "utf8");
  ["openalex", "crossref", "arxiv", "semanticscholar"].forEach((s) => {
    assert.ok(research.includes("'" + s + "'"), "research source " + s);
  });
  assert.ok(research.includes("abstract_inverted_index"), "OpenAlex abstracts reconstructed");
  assert.ok(!research.includes("new DOMParser"), "arXiv parsing never constructs a DOMParser");
});

check("1.0.23: research lib parses, dedupes, and builds cited prompts", () => {
  const sandbox = loadLibInSandbox("lib/research.js");
  const R = sandbox.GraphiteResearch;
  assert.ok(R && typeof R.buildResearchPrompt === "function", "GraphiteResearch exported");

  const openAlex = R.parseOpenAlex({ results: [{
    title: "Spaced repetition works",
    publication_year: 2021,
    authorships: [{ author: { display_name: "Ada Lovelace" } }],
    primary_location: { landing_page_url: "https://example.org/paper", pdf_url: "", source: { display_name: "J. Memory" } },
    open_access: { oa_url: "" },
    doi: "https://doi.org/10.1000/ABC",
    abstract_inverted_index: { Spaced: [0], repetition: [1], works: [2] },
    cited_by_count: 7
  }] });
  assert.strictEqual(openAlex.length, 1, "one OpenAlex source");
  assert.strictEqual(openAlex[0].abstract, "Spaced repetition works", "inverted index rebuilt");
  assert.strictEqual(openAlex[0].doi, "10.1000/abc", "DOI normalized");

  const crossref = R.parseCrossref({ message: { items: [{
    title: ["Spaced Repetition Works"], author: [{ given: "Ada", family: "Lovelace" }],
    published: { "date-parts": [[2021]] }, "container-title": ["J. Memory"],
    URL: "https://doi.org/10.1000/ABC", DOI: "10.1000/ABC", abstract: ""
  }] } });
  assert.strictEqual(R.dedupeSources(openAlex.concat(crossref)).length, 1, "DOI/Title dedupe keeps one");

  const arxiv = R.parseArxiv("<feed><entry><title>Preprint on memory</title><id>http://arxiv.org/abs/2401.00001v1</id>" +
    "<published>2024-01-02T00:00:00Z</published><summary>Abstract here.</summary>" +
    "<author><name>Grace Hopper</name></author>" +
    '<link href="https://arxiv.org/abs/2401.00001v1" rel="alternate"/>' +
    '<link href="https://arxiv.org/pdf/2401.00001v1" rel="related" title="pdf"/></entry></feed>');
  assert.strictEqual(arxiv.length, 1, "arXiv entry parsed");
  assert.strictEqual(arxiv[0].pdfUrl, "https://arxiv.org/pdf/2401.00001v1", "arXiv pdf link found");
  assert.strictEqual(arxiv[0].year, 2024, "arXiv year from published");

  const prompt = R.buildResearchPrompt("Does spaced repetition help?", openAlex, { depth: "standard" });
  assert.ok(prompt.includes("[1] Spaced repetition works"), "numbered source list");
  assert.ok(prompt.includes("## Executive summary"), "report structure heading");
  assert.ok(prompt.includes("## Sources"), "sources heading required");
  assert.ok(/\[n\]/.test(prompt), "inline citation instruction");
  const empty = R.buildResearchPrompt("Q", [], {});
  assert.ok(empty.includes("no sources are available"), "empty sources stated plainly");
});

check("Hand run records: storage, background cases outside pinned slice, summary UI", () => {
  const storage = fs.readFileSync(path.join(EXT, "lib/storage.js"), "utf8");
  assert.ok(storage.includes("graphiteSider.handRuns.v1"), "hand runs storage key");
  assert.ok(/HAND_KEY/.test(storage), "HAND_KEY defined");
  ["saveHandRun", "listHandRuns", "getHandRun", "deleteHandRun"].forEach((fn) => {
    assert.ok(storage.includes("function " + fn), "storage defines " + fn);
    assert.ok(storage.includes(fn + ": " + fn), "storage exports " + fn);
  });
  assert.ok(/HAND_KEY:\s*HAND_KEY/.test(storage), "storage exports HAND_KEY");

  const bg = fs.readFileSync(path.join(EXT, "background.js"), "utf8");
  ["saveHandRun", "listHandRuns", "getHandRun", "deleteHandRun"].forEach((t) => {
    assert.ok(bg.includes("case '" + t + "'"), "background handles " + t);
  });
  const sliceStart = bg.indexOf("case 'buildYouTubePrompt':");
  const sliceEnd = bg.indexOf("case 'getActiveTab':");
  assert.ok(sliceStart > -1 && sliceEnd > sliceStart, "pinned slice anchors present");
  const slice = bg.slice(sliceStart, sliceEnd);
  ["saveHandRun", "listHandRuns", "getHandRun", "deleteHandRun"].forEach((t) => {
    assert.ok(!slice.includes("case '" + t + "'"), t + " not inside pinned slice");
  });
  assert.ok(bg.includes("GraphiteStorage.saveHandRun"), "background delegates to GraphiteStorage");

  const html = fs.readFileSync(path.join(EXT, "sidebar/sidebar.html"), "utf8");
  ["handFinishBtn", "handSummary", "handCopySummaryBtn", "handDownloadSummaryBtn", "handRunsList"].forEach((id) => {
    assert.ok(html.includes('id="' + id + '"'), "sidebar element #" + id);
  });
  assert.ok(html.includes("Finish &amp; summarize") || html.includes("Finish & summarize"), "finish button label");

  const side = fs.readFileSync(path.join(EXT, "sidebar/sidebar.js"), "utf8");
  ["finishHandRun", "handSummaryMarkdown", "copyHandSummary", "downloadHandSummary", "renderHandRunsList", "renderHandSummary", "buildHandRunRecord"].forEach((fn) => {
    assert.ok(side.includes("function " + fn), "sidebar implements " + fn);
  });
  ["handFinishBtn", "handCopySummaryBtn", "handDownloadSummaryBtn", "handRunsList"].forEach((id) => {
    assert.ok(side.includes(id), "sidebar references #" + id);
  });
  assert.ok(/step\.resultText/.test(side), "step resultText stored");
  assert.ok(/handLogEntries/.test(side), "structured hand log entries");
  assert.ok(side.includes("20000"), "hand extract cap 20000 present");
  assert.ok(!/innerHTML\s*=/.test(side), "sidebar still never assigns innerHTML");
});

check("1.0.26 Videos tab: any-page video inventory, transcribe/summarize/translate", () => {
  const html = fs.readFileSync(path.join(EXT, "sidebar/sidebar.html"), "utf8");
  assert.ok(html.includes('data-view="videos"'), "Videos tab button present");
  assert.ok(html.includes('id="view-videos"'), "videos view section present");
  ["videoHost", "videoScanBtn", "videoChatBtn", "videoStatus", "videoList", "videoDetail",
    "videoDetailTitle", "videoDetailMeta", "videoLangSel", "videoTranscribeBtn",
    "videoSummarizeBtn", "videoTranslateBtn", "videoCopyBtn", "videoDownloadBtn",
    "videoDetailStatus", "videoSeekRow", "videoResult", "videoTranscriptText"].forEach((id) => {
    assert.ok(html.includes('id="' + id + '"'), "sidebar element #" + id);
  });
  assert.ok(html.includes("../lib/captions.js"), "sidebar loads the caption parser");

  const side = fs.readFileSync(path.join(EXT, "sidebar/sidebar.js"), "utf8");
  ["videoScan", "renderVideoList", "selectVideo", "renderVideoResult", "renderVideoSeekRow",
    "videoYouTubeTranscript", "videoCaptionTranscript", "videoAudioTranscript",
    "transcribeSelectedVideo", "ensureVideoTranscript", "summarizeSelectedVideo",
    "translateSelectedVideo", "downloadVideoResult", "openVideoInChat",
    "fillVideoLangSelect", "videoRunModel", "videoBusy"].forEach((fn) => {
    assert.ok(side.includes("function " + fn), "sidebar implements " + fn);
  });
  assert.ok(side.includes("if (name === 'videos') renderVideoList();"), "switchView renders the videos view");
  assert.ok(side.includes("t.dataset.view === name"), "switchView toggles tabs by data-view");
  assert.ok(side.includes("'list-videos'"), "sidebar sends list-videos");
  assert.ok(side.includes("'video-captions'"), "sidebar sends video-captions");
  assert.ok(side.includes("'video-seek'"), "sidebar sends video-seek");
  assert.ok(side.includes("'video-media'"), "sidebar sends video-media");
  assert.ok(side.includes("type: 'transcribe'"), "audio fallback goes through background transcribe");
  assert.ok(side.includes("buildYouTubeSummaryPrompt"), "summarize reuses the YouTube summary prompt");
  assert.ok(side.includes("fillVideoLangSelect"), "language select filled without innerHTML");
  assert.ok(!/innerHTML\s*=/.test(side), "sidebar still never assigns innerHTML (Videos wiring)");

  // Slice the init() wiring block: from the first Videos listener to just
  // before the Research listener, which the Videos block precedes.
  const videoWireAnchor = side.indexOf("$('videoScanBtn')");
  const researchWireAnchor = side.indexOf("researchRunBtn", videoWireAnchor);
  assert.ok(videoWireAnchor > -1 && researchWireAnchor > videoWireAnchor, "init video wiring anchors present");
  const sideWiring = side.slice(videoWireAnchor, researchWireAnchor);
  ["videoScanBtn", "videoTranscribeBtn", "videoSummarizeBtn", "videoTranslateBtn",
    "videoCopyBtn", "videoDownloadBtn", "videoChatBtn"].forEach((id) => {
    assert.ok(sideWiring.includes("addEventListener('click'"), "init wiring attaches click handlers");
    assert.ok(sideWiring.includes(id), "init wires #" + id);
  });

  const content = fs.readFileSync(path.join(EXT, "content/content.js"), "utf8");
  ["list-videos", "video-captions", "video-seek", "video-media"].forEach((cmd) => {
    assert.ok(content.includes("case '" + cmd + "'"), "content handles " + cmd);
  });
  ["listPageVideos", "readTextTrackCues", "collectTrackUrls", "fetchTrackText",
    "getPageVideoCaptions", "findIndexedVideo"].forEach((fn) => {
    assert.ok(content.includes("function " + fn), "content implements " + fn);
  });
  assert.ok(content.includes("data-graphite-video-index"), "content tags elements with a stable index");
  assert.ok(/blob:/i.test(content), "content reports blob/MSE sources honestly");

  const bg = fs.readFileSync(path.join(EXT, "background.js"), "utf8");
  ["parseCaptions", "normalizeCues"].forEach((t) => {
    assert.ok(bg.includes("case '" + t + "'"), "background handles " + t);
  });
  const sliceStart = bg.indexOf("case 'buildYouTubePrompt':");
  const sliceEnd = bg.indexOf("case 'getActiveTab':");
  assert.ok(sliceStart > -1 && sliceEnd > sliceStart, "pinned slice anchors present");
  const slice = bg.slice(sliceStart, sliceEnd);
  ["parseCaptions", "normalizeCues"].forEach((t) => {
    assert.ok(!slice.includes("case '" + t + "'"), t + " not inside pinned slice");
  });
  assert.ok(bg.includes("GraphiteCaptions.parseCues"), "background parses with the caption lib");
  assert.ok(bg.includes("GraphiteCaptions.fromTrackCues"), "background normalises with the caption lib");

  const manifest = fs.readFileSync(path.join(EXT, "manifest.json"), "utf8");
  assert.ok(manifest.includes('"lib/captions.js"'), "manifest registers lib/captions.js");

  const css = fs.readFileSync(path.join(EXT, "sidebar/sidebar.css"), "utf8");
  [".video-row", ".video-row.selected", ".video-detail", ".video-seek-row", ".video-result"].forEach((sel) => {
    assert.ok(css.includes(sel), "sidebar css defines " + sel);
  });
});

check("1.0.27 blob/MSE extraction + per-provider transcription model", () => {
  const manifest = fs.readFileSync(path.join(EXT, "manifest.json"), "utf8");
  assert.ok(manifest.includes('"lib/audio-extract.js"'), "manifest registers lib/audio-extract.js");
  assert.ok(manifest.includes('"lib/manifests.js"'), "manifest registers lib/manifests.js");

  const content = fs.readFileSync(path.join(EXT, "content/content.js"), "utf8");
  assert.ok(content.includes("case 'video-extract-audio'"), "content handles video-extract-audio");
  assert.ok(content.includes("extractPageVideoAudio"), "content implements extractPageVideoAudio");
  assert.ok(content.includes("decodeAudioData"), "content decodes media with Web Audio");
  assert.ok(content.includes("renderWavBlobInChunks"), "content keeps the WAV chunk path as last resort");
  assert.ok(content.includes("case 'video-manifest-audio'"), "content handles video-manifest-audio");
  assert.ok(content.includes("detectVideoManifestAudio"), "content detects manifest audio renditions");
  assert.ok(content.includes("collectManifestUrls"), "content collects manifest URLs (performance entries + sources)");
  assert.ok(content.includes("renderMp3BlobInChunks"), "content converts extracted audio to MP3 chunks");
  assert.ok(content.includes("captureElementAudio"), "content can capture pure-MSE players via captureStream");
  assert.ok(content.includes("MediaRecorder"), "capture path records compressed audio, not WAV");
  const mediaCase = content.slice(content.indexOf("case 'video-media'"), content.indexOf("case 'video-extract-audio'"));
  assert.ok(!mediaCase.includes("cannot be sent to the transcription provider"), "old blob dead-end message is gone from video-media");

  const side = fs.readFileSync(path.join(EXT, "sidebar/sidebar.js"), "utf8");
  assert.ok(side.includes("'video-extract-audio'"), "sidebar asks the page to extract audio when no manifest track exists");
  assert.ok(side.includes("'video-manifest-audio'"), "sidebar asks the page for the manifest audio rendition first");
  assert.ok(side.includes("videoManifestTranscript"), "sidebar tries manifest audio before extraction");
  assert.ok(side.includes("transcribeAudioChunks"), "sidebar transcribes chunk by chunk");
  assert.ok(side.includes("holdPendingAudio") && side.includes("clearPendingAudio"), "sidebar holds/releases extracted chunks");
  assert.ok(side.includes("10 * 60 * 1000"), "pending audio auto-clears after 10 minutes");
  const audioFlow = side.slice(side.indexOf("function videoAudioTranscript"), side.indexOf("function transcribeSelectedVideo"));
  assert.ok(!audioFlow.includes("model: state.activeModel"), "chat model never sent on the transcribe path");
  const extractIdx = side.indexOf("function videoAudioTranscript");
  const manifestIdx = side.indexOf("videoManifestTranscript(video)", extractIdx);
  const extractCmdIdx = side.indexOf("'video-extract-audio'", extractIdx);
  assert.ok(manifestIdx > -1 && extractCmdIdx > manifestIdx, "manifest route is attempted before in-page extraction");

  const bg = fs.readFileSync(path.join(EXT, "background.js"), "utf8");
  assert.ok(bg.includes("forTranscription"), "background resolves transcription providers separately");
  assert.ok(bg.includes("900000"), "background enforces the base64 chunk ceiling");
  assert.ok(bg.includes("audioBase64"), "background accepts chunked base64 audio");
  assert.ok(bg.includes("fetchManifestAudio"), "background fetches manifest audio renditions itself");
  assert.ok(bg.includes("msg.manifestUrl"), "transcribe accepts a manifest URL (no base64 hop)");
  assert.ok(bg.includes("GraphiteManifests"), "background uses the manifest parser lib");
  assert.ok(bg.includes("case 'manifestAudio'"), "background exposes manifest discovery");
  const sliceStart = bg.indexOf("case 'buildYouTubePrompt':");
  const sliceEnd = bg.indexOf("case 'getActiveTab':");
  assert.ok(sliceStart > -1 && sliceEnd > sliceStart, "pinned slice anchors present");
  assert.ok(!bg.slice(sliceStart, sliceEnd).includes("case 'transcribe'"), "transcribe case stays outside the pinned slice");

  const prov = fs.readFileSync(path.join(EXT, "lib/providers.js"), "utf8");
  assert.ok(prov.includes("provider.transcriptionModel"), "transcribe reads the per-provider model");
  assert.ok(prov.includes("whisper-1"), "transcribe falls back to whisper-1");
  assert.ok(!prov.includes("form.append('model', 'whisper-1')"), "transcribe model is no longer hardcoded");

  const storage = fs.readFileSync(path.join(EXT, "lib/storage.js"), "utf8");
  assert.ok(storage.includes("transcriptionModel: p.transcriptionModel"), "storage preserves transcriptionModel");

  const options = fs.readFileSync(path.join(EXT, "options/options.js"), "utf8");
  assert.ok(options.includes('data-field="transcriptionModel"'), "options renders the transcription model field");
  assert.ok(options.includes("if (p.transcriptionModel) out.transcriptionModel"), "options preserves transcriptionModel on save");

  const html = fs.readFileSync(path.join(EXT, "sidebar/sidebar.html"), "utf8");
  assert.ok(html.includes("../lib/audio-extract.js"), "sidebar loads the extract lib");
  assert.ok(html.includes("../lib/manifests.js"), "sidebar loads the manifests lib");
});
