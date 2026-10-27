"use strict";
/* Manifest contract tests. No dependencies: node tests/manifest.test.js
   FAILS if extension/manifest.json is missing or violates the contract. */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const EXT = path.join(ROOT, "extension");
const manifestPath = path.join(EXT, "manifest.json");

let failures = 0;
function check(name, fn) {
  try { fn(); console.log("ok - " + name); }
  catch (e) { failures++; console.error("FAIL - " + name + ": " + e.message); }
}

check("extension/manifest.json exists", () => {
  assert.ok(fs.existsSync(manifestPath), "extension/manifest.json not found (core pending?)");
});

let manifest = null;
check("manifest parses as JSON", () => {
  manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert.ok(manifest && typeof manifest === "object");
});

if (manifest) {
  check("manifest is Manifest V2", () => {
    assert.strictEqual(manifest.manifest_version, 2,
      "expected manifest_version 2, got " + manifest.manifest_version);
  });

  check("has a name and version", () => {
    assert.ok(typeof manifest.name === "string" && manifest.name.length > 0);
    assert.ok(typeof manifest.version === "string" && manifest.version.length > 0);
  });

  check("gecko id present (browser_specific_settings.gecko.id)", () => {
    const gecko = manifest.browser_specific_settings && manifest.browser_specific_settings.gecko;
    assert.ok(gecko && typeof gecko.id === "string" && gecko.id.length > 0,
      "missing browser_specific_settings.gecko.id");
  });

  check("gecko data_collection_permissions declared (required for new AMO add-ons)", () => {
    const gecko = manifest.browser_specific_settings.gecko;
    const dcp = gecko.data_collection_permissions;
    assert.ok(dcp && typeof dcp === "object", "missing browser_specific_settings.gecko.data_collection_permissions");
    assert.ok(Array.isArray(dcp.required) && dcp.required.length > 0, "data_collection_permissions.required must be a non-empty array");
    const allowed = new Set([
      "none", "personallyIdentifyingInfo", "healthInfo", "financialAndPaymentInfo",
      "authenticationInfo", "personalCommunications", "locationInfo",
      "browsingActivity", "websiteContent", "websiteActivity", "searchTerms",
      "bookmarksInfo", "technicalAndInteraction"
    ]);
    dcp.required.forEach((v) => assert.ok(allowed.has(v), "unknown data_collection_permissions value: " + v));
    assert.ok(!(dcp.required.includes("none") && dcp.required.length > 1),
      "'none' must not be combined with other data types");
    assert.ok(!dcp.required.includes("technicalAndInteraction"),
      "technicalAndInteraction cannot be a required data type");
    // Only the provider the user configures ever receives data, and only on
    // explicit user actions; these five types cover everything sent there.
    const expected = ["authenticationInfo", "browsingActivity", "personalCommunications", "searchTerms", "websiteContent"];
    expected.forEach((v) => assert.ok(dcp.required.includes(v), "expected declared data type missing: " + v));
  });

  check("strict_min_version covers built-in data consent (Firefox >= 142)", () => {
    const gecko = manifest.browser_specific_settings.gecko;
    const min = parseInt(String(gecko.strict_min_version || "0"), 10);
    // gecko.data_collection_permissions is only understood from Firefox 142;
    // a lower floor makes AMO warn the key is unsupported on Android.
    assert.ok(min >= 142,
      "strict_min_version must be >= 142.0 so data_collection_permissions is enforced at install, got " + gecko.strict_min_version);
  });

  check("sidebar_action present (Firefox sidebar)", () => {
    assert.ok(manifest.sidebar_action && typeof manifest.sidebar_action === "object",
      "manifest.sidebar_action missing");
    assert.ok(manifest.sidebar_action.default_panel, "sidebar_action.default_panel missing");
  });

  check("options page declared and exists on disk", () => {
    const page = (manifest.options_ui && manifest.options_ui.page) ||
                 (manifest.options_page || null);
    assert.ok(page, "no options_ui.page / options_page");
    assert.ok(fs.existsSync(path.join(EXT, page)), "options page file missing: " + page);
  });

  check("all manifest-referenced files exist on disk", () => {
    const refs = new Set();
    const add = (p) => { if (typeof p === "string" && p) refs.add(p); };
    if (manifest.background && Array.isArray(manifest.background.scripts)) {
      manifest.background.scripts.forEach(add);
    }
    if (manifest.background && manifest.background.page) add(manifest.background.page);
    if (manifest.sidebar_action) {
      add(manifest.sidebar_action.default_panel);
      add(manifest.sidebar_action.default_icon);
    }
    if (manifest.options_ui) add(manifest.options_ui.page);
    if (manifest.browser_action) {
      add(manifest.browser_action.default_popup);
      if (typeof manifest.browser_action.default_icon === "string") add(manifest.browser_action.default_icon);
      else if (manifest.browser_action.default_icon) Object.values(manifest.browser_action.default_icon).forEach(add);
    }
    if (manifest.page_action) {
      add(manifest.page_action.default_popup);
      if (typeof manifest.page_action.default_icon === "string") add(manifest.page_action.default_icon);
      else if (manifest.page_action.default_icon) Object.values(manifest.page_action.default_icon).forEach(add);
    }
    if (manifest.icons) Object.values(manifest.icons).forEach(add);
    (manifest.content_scripts || []).forEach((cs) => {
      (cs.js || []).forEach(add);
      (cs.css || []).forEach(add);
    });
    (manifest.web_accessible_resources || []).forEach((r) => {
      if (typeof r === "string") add(r);
      else if (r && Array.isArray(r.resources)) r.resources.forEach(add);
    });
    const missing = [...refs].filter((r) => !r.includes("*") && !fs.existsSync(path.join(EXT, r)));
    assert.deepStrictEqual(missing, [], "referenced files missing: " + missing.join(", "));
  });

  check("permissions include storage", () => {
    assert.ok(Array.isArray(manifest.permissions) && manifest.permissions.includes("storage"),
      "permissions should include 'storage'");
  });

  // 1.0.18: AMO warned on every dynamic innerHTML assignment (54 warnings)
  // plus a strict_min_version below the Firefox 142 floor that understands
  // gecko.data_collection_permissions. Rendering now goes through DOM
  // construction or DOMParser + sanitizer walks; this keeps it that way.
  check("no unsafe innerHTML sinks (AMO warnings stay at zero)", () => {
    const files = [
      "content/content.js", "content/youtube.js", "content/search.js",
      "content/inject-yt.js", "sidebar/sidebar.js", "sidebar/markdown.js",
      "options/options.js", "background.js",
    ];
    const sink = /\.innerHTML\s*=|\.outerHTML\s*=|insertAdjacentHTML|document\.write\s*\(/;
    const offenders = [];
    files.forEach((rel) => {
      const p = path.join(EXT, rel);
      if (!fs.existsSync(p)) return;
      fs.readFileSync(p, "utf8").split(/\r?\n/).forEach((line, i) => {
        if (sink.test(line)) offenders.push(rel + ":" + (i + 1) + " " + line.trim().slice(0, 80));
      });
    });
    assert.deepStrictEqual(offenders, [], "unsafe HTML sinks found:\n" + offenders.join("\n"));
  });
} else {
  failures++;
  console.error("FAIL - manifest-dependent checks skipped: manifest unavailable");
}

console.log(failures ? `\n${failures} failure(s)` : "\nall manifest tests passed");
process.exit(failures ? 1 : 0);
