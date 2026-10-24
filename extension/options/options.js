"use strict";
/* Graphite Sider — options page.
   Settings contract (browser.storage.local key "graphite_settings"):
   { providers:[{id,label,kind,baseUrl,apiKey,model,enabled}],
     activeProviderId, activeModel,
     settings:{targetLang,temperature,maxTokens,systemPrompt,
               youtubeAutoSummary,searchEnhance,selectionToolbar,bilingualSubtitles},
     prompts:[custom...] }
   Uses GraphiteStorage.loadSettings/saveSettings (lib/storage.js) when present,
   otherwise falls back to the raw browser.storage.local API. */

/* The task contract names this key 'graphite_settings'; lib/storage.js (when
   loaded before this script) is the source of truth and exports its own key.
   Prefer the library's exported key so options and sidebar share storage,
   falling back to the documented contract name only when the lib is absent. */
var STORAGE_KEY = (typeof GraphiteStorage !== "undefined" && GraphiteStorage && GraphiteStorage.STORAGE_KEY) ||
  "graphite_settings";

var PRESETS = [
  { id: "openai",      label: "OpenAI",                        kind: "openai-compatible", baseUrl: "https://api.openai.com/v1",               model: "gpt-4o-mini" },
  { id: "anthropic",   label: "Anthropic",                     kind: "anthropic",         baseUrl: "https://api.anthropic.com",               model: "claude-sonnet-4-5" },
  { id: "openrouter",  label: "OpenRouter",                    kind: "openai-compatible", baseUrl: "https://openrouter.ai/api/v1",            model: "" },
  { id: "groq",        label: "Groq",                          kind: "openai-compatible", baseUrl: "https://api.groq.com/openai/v1",          model: "" },
  { id: "deepseek",    label: "DeepSeek",                      kind: "openai-compatible", baseUrl: "https://api.deepseek.com/v1",             model: "deepseek-chat" },
  { id: "together",    label: "Together",                      kind: "openai-compatible", baseUrl: "https://api.together.xyz/v1",             model: "" },
  { id: "fireworks",   label: "Fireworks",                     kind: "openai-compatible", baseUrl: "https://api.fireworks.ai/inference/v1",   model: "" },
  { id: "mistral",     label: "Mistral",                       kind: "openai-compatible", baseUrl: "https://api.mistral.ai/v1",             model: "" },
  { id: "xai",         label: "xAI",                           kind: "openai-compatible", baseUrl: "https://api.x.ai/v1",                     model: "" },
  { id: "ollama",      label: "Ollama local",                  kind: "ollama",            baseUrl: "http://localhost:11434/v1",               model: "llama3.1" },
  { id: "lmstudio",    label: "LM Studio local",               kind: "openai-compatible", baseUrl: "http://localhost:1234/v1",                model: "" },
  { id: "custom-oai",  label: "Custom OpenAI-compatible",      kind: "openai-compatible", baseUrl: "",                                        model: "" },
  { id: "custom-anth", label: "Custom Anthropic-compatible",   kind: "anthropic",         baseUrl: "",                                        model: "" }
];

/* Values are display names: lib prompts substitute {{lang}} with targetLang
   (lib/storage.js defaults it to "English"), so names read naturally. 76 langs. */
var LANGUAGES = [
  "", "English", "Spanish", "French", "German", "Italian", "Portuguese",
  "Portuguese (Brazil)", "Dutch", "Swedish", "Norwegian", "Norwegian Bokmål",
  "Danish", "Finnish", "Icelandic", "Polish", "Czech", "Slovak", "Hungarian",
  "Romanian", "Bulgarian", "Croatian", "Serbian", "Slovenian", "Ukrainian",
  "Russian", "Greek", "Turkish", "Arabic", "Persian", "Hebrew", "Urdu",
  "Hindi", "Bengali", "Tamil", "Telugu", "Marathi", "Gujarati", "Kannada",
  "Malayalam", "Thai", "Vietnamese", "Indonesian", "Malay", "Filipino",
  "Chinese (Simplified)", "Chinese (Traditional)", "Japanese", "Korean",
  "Swahili", "Amharic", "Yoruba", "Igbo", "Hausa", "Estonian", "Latvian",
  "Lithuanian", "Catalan", "Basque", "Galician", "Afrikaans", "Punjabi",
  "Nepali", "Sinhala", "Khmer", "Lao", "Burmese", "Mongolian", "Welsh",
  "Irish", "Albanian", "Macedonian", "Bosnian", "Malayalam", "Kannada"
].filter(function (v, i, a) { return a.indexOf(v) === i; });

function cleanLanguageList(list) {
  var seen = {};
  var out = [];
  (Array.isArray(list) ? list : []).forEach(function (v) {
    var name = String(v == null ? "" : v).trim();
    if (!name || seen[name]) return;
    seen[name] = true;
    out.push(name);
  });
  return out;
}

function parseLanguageLines(text) {
  return cleanLanguageList(String(text || "").split(/\r?\n/));
}

function defaultTranslationLanguages() {
  return cleanLanguageList(LANGUAGES);
}

function effectiveTranslationLanguages() {
  if (typeof state !== "undefined" && state && state.settings &&
      Array.isArray(state.settings.translationLanguages)) {
    var configured = cleanLanguageList(state.settings.translationLanguages);
    if (configured.length) return configured;
  }
  return defaultTranslationLanguages();
}

/* Defensive fallbacks mirroring the documented contract. When lib/storage.js
   is present its DEFAULT_SETTINGS() factory (incl. DEFAULT_UI_SETTINGS, where
   targetLang is the language *display name* fed into {{lang}} placeholders)
   wins, so options stays shape-compatible with the sidebar/background. */
function libDefaults() {
  try {
    if (typeof GraphiteStorage !== "undefined" && GraphiteStorage) {
      if (typeof GraphiteStorage.DEFAULT_SETTINGS === "function") return GraphiteStorage.DEFAULT_SETTINGS();
      if (GraphiteStorage.DEFAULT_UI_SETTINGS) {
        return {
          providers: [], activeProviderId: "", activeModel: "",
          settings: Object.assign({}, GraphiteStorage.DEFAULT_UI_SETTINGS), prompts: []
        };
      }
    }
  } catch (e) { /* fall through to contract defaults */ }
  return null;
}

var DEFAULT_SETTINGS = {
  targetLang: "English", temperature: 0.7, maxTokens: 2048,
  systemPrompt: "", youtubeAutoSummary: false, searchEnhance: true,
  selectionToolbar: true, bilingualSubtitles: false
};

function defaultState() {
  var lib = libDefaults();
  if (lib && lib.settings) {
    return {
      providers: Array.isArray(lib.providers) ? lib.providers.slice() : [],
      activeProviderId: String(lib.activeProviderId || ""), activeModel: String(lib.activeModel || ""),
      settings: Object.assign({}, DEFAULT_SETTINGS, lib.settings),
      prompts: Array.isArray(lib.prompts) ? lib.prompts.slice() : [],
      history: Array.isArray(lib.history) ? lib.history.slice() : []
    };
  }
  return {
    providers: [], activeProviderId: "", activeModel: "",
    settings: Object.assign({}, DEFAULT_SETTINGS), prompts: [], history: []
  };
}

/* Sidebar side (Issue 4): Firefox's built-in sidebar position is controlled
   by Firefox (sidebar.position_start / View > Sidebar position), NOT by any
   MV2 sidebar_action option — manifest.json has no side parameter and
   browser.sidebarAction has no positioning API. The extension therefore
   cannot force the right side. It records the user's preference here and
   shows the one-time Firefox steps; Firefox then remembers the choice for
   the profile. */
var SIDEBAR_GUIDE_STEPS = [
  "Open the Graphite Sider sidebar (toolbar button or Ctrl+Shift+Y).",
  "At the top of the Firefox sidebar, use the sidebar menu / View options and choose “Move sidebar to the right” (Firefox: View → Sidebar position, or right-click the sidebar header).",
  "Alternatively, in about:config set sidebar.position_start to false, then restart Firefox.",
  "Firefox remembers the side for this profile — you only need to do this once. No extension setting can change it for you."
];
function renderSidebarGuide() {
  var box = el("sidebarGuideSteps");
  if (box) box.innerHTML = SIDEBAR_GUIDE_STEPS.map(function (s) { return "<li>" + esc(s) + "</li>"; }).join("");
  var pref = el("sidebarSidePref");
  if (pref && state.settings) pref.value = state.settings.sidebarSide === "left" ? "left" : "right";
}
function openSidebar() {
  var a = api();
  var done = function (ok, msg) { setStatus(msg, ok ? "ok" : "err"); };
  try {
    if (a && a.sidebarAction && typeof a.sidebarAction.open === "function") {
      var r = a.sidebarAction.open();
      if (r && typeof r.then === "function") {
        r.then(function () { done(true, "Sidebar opened — now move it to the right using Firefox's sidebar menu (see steps below)."); })
         .catch(function (e) { done(false, "Could not open sidebar: " + (e && e.message ? e.message : e)); });
        return;
      }
      done(true, "Sidebar opened — now move it to the right using Firefox's sidebar menu (see steps below).");
      return;
    }
  } catch (e) { /* fall through to message */ }
  // Options pages cannot always call sidebarAction; ask the background.
  sendMessage({ type: "openSidebar" }).then(function () {
    done(true, "Sidebar opened — now move it to the right using Firefox's sidebar menu (see steps below).");
  }).catch(function () {
    done(false, "Use the Graphite Sider toolbar button (or Ctrl+Shift+Y) to open the sidebar, then follow the steps below.");
  });
}

/* A usable global `browser` (Firefox) or `chrome` namespace. */
function api() {
  if (typeof browser !== "undefined" && browser && browser.storage) return browser;
  if (typeof chrome !== "undefined" && chrome && chrome.storage) return chrome;
  return null;
}

function storageGet(key) {
  var a = api();
  if (!a) return Promise.reject(new Error("browser.storage API unavailable"));
  try {
    var r = a.storage.local.get(key);
    if (r && typeof r.then === "function") return r;
  } catch (e) { /* fall through to callback form */ }
  return new Promise(function (resolve, reject) {
    a.storage.local.get(key, function (items) {
      var err = (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.lastError);
      if (err) reject(new Error(err.message || String(err))); else resolve(items || {});
    });
  });
}

function storageSet(obj) {
  var a = api();
  if (!a) return Promise.reject(new Error("browser.storage API unavailable"));
  try {
    var r = a.storage.local.set(obj);
    if (r && typeof r.then === "function") return r;
  } catch (e) { /* fall through */ }
  return new Promise(function (resolve, reject) {
    a.storage.local.set(obj, function () {
      var err = (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.lastError);
      if (err) reject(new Error(err.message || String(err))); else resolve();
    });
  });
}

function storageRemove(keys) {
  var a = api();
  if (!a) return Promise.reject(new Error("browser.storage API unavailable"));
  try {
    var r = a.storage.local.remove(keys);
    if (r && typeof r.then === "function") return r;
  } catch (e) { /* fall through */ }
  return new Promise(function (resolve, reject) {
    a.storage.local.remove(keys, function () {
      var err = (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.lastError);
      if (err) reject(new Error(err.message || String(err))); else resolve();
    });
  });
}

function storageGetAll() {
  var a = api();
  if (!a) return Promise.reject(new Error("browser.storage API unavailable"));
  try {
    var r = a.storage.local.get(null);
    if (r && typeof r.then === "function") return r;
  } catch (e) { /* fall through */ }
  return new Promise(function (resolve, reject) {
    a.storage.local.get(null, function (items) {
      var err = (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.lastError);
      if (err) reject(new Error(err.message || String(err))); else resolve(items || {});
    });
  });
}

var PROVIDER_KINDS = ["openai-compatible", "anthropic", "ollama", "custom-openai"];

function normalizeState(raw) {
  var s = defaultState();
  if (!raw || typeof raw !== "object") return s;
  if (Array.isArray(raw.providers)) {
    s.providers = raw.providers.filter(function (p) { return p && typeof p === "object"; }).map(function (p) {
      var out = {
        id: String(p.id || uid("provider")),
        label: String(p.label || "Provider"),
        kind: PROVIDER_KINDS.indexOf(p.kind) >= 0 ? p.kind : "openai-compatible",
        baseUrl: String(p.baseUrl || ""),
        apiKey: String(p.apiKey || ""),
        model: String(p.model || ""),
        enabled: p.enabled !== false
      };
      if (p.visionModel) out.visionModel = String(p.visionModel); // preserve lib field
      if (p.imageModel) out.imageModel = String(p.imageModel); // preserve lib field
      return out;
    });
  }
  if (typeof raw.activeProviderId === "string") s.activeProviderId = raw.activeProviderId;
  if (typeof raw.activeModel === "string") s.activeModel = raw.activeModel;
  if (raw.settings && typeof raw.settings === "object") {
    s.settings = Object.assign({}, DEFAULT_SETTINGS, raw.settings);
    if (s.settings.sidebarSide !== "left" && s.settings.sidebarSide !== "right") s.settings.sidebarSide = "right";
  }
  if (Array.isArray(raw.prompts)) {
    s.prompts = raw.prompts.filter(function (p) { return p && typeof p === "object"; }).map(function (p) {
      var out = {
        id: String(p.id || uid("prompt")),
        name: String(p.name || p.title || "Untitled prompt"),
        body: String(p.body || p.prompt || p.template || "")
      };
      // Preserve any extra prompt fields the library/sidebar may keep.
      Object.keys(p).forEach(function (k) {
        if (!(k in out)) { try { out[k] = JSON.parse(JSON.stringify(p[k])); } catch (e) { out[k] = p[k]; } }
      });
      return out;
    });
  }
  if (Array.isArray(raw.history)) s.history = raw.history.slice(0, 100);
  if (raw._meta && typeof raw._meta === "object") s._meta = raw._meta;
  else if (raw._meta) delete s._meta;
  if (!s.providers.some(function (p) { return p.id === s.activeProviderId; })) {
    s.activeProviderId = s.providers.length ? s.providers[0].id : "";
  }
  return s;
}

function loadSettings() {
  if (typeof GraphiteStorage !== "undefined" && GraphiteStorage &&
      typeof GraphiteStorage.loadSettings === "function") {
    return Promise.resolve()
      .then(function () { return GraphiteStorage.loadSettings(); })
      .then(normalizeState)
      .catch(function () { return rawLoad(); });
  }
  return rawLoad();
}

function rawLoad() {
  return storageGet(STORAGE_KEY).then(function (items) {
    return normalizeState(items ? items[STORAGE_KEY] : undefined);
  });
}

function saveSettings(state) {
  var snapshot = normalizeState(state);
  if (typeof GraphiteStorage !== "undefined" && GraphiteStorage &&
      typeof GraphiteStorage.saveSettings === "function") {
    // lib/storage.js is authoritative: it reads persisted copies first,
    // writes browser.storage.local, verifies by read-back and refreshes
    // mirrors. A failure there must be surfaced, NOT masked by a naive
    // fallback write that could persist a stale snapshot unverified.
    return Promise.resolve()
      .then(function () { return GraphiteStorage.saveSettings(snapshot); });
  }
  // Raw fallback (lib unavailable): still verify by read-back.
  var obj = {};
  obj[STORAGE_KEY] = snapshot;
  return storageSet(obj).then(function () {
    return storageGet(STORAGE_KEY).then(function (items) {
      if (!items || !items[STORAGE_KEY]) throw new Error("read-back verification failed");
    });
  });
}

function makeSetObject(snapshot) {
  var obj = {};
  obj[STORAGE_KEY] = snapshot;
  return obj;
}

function sendMessage(msg) {
  var a = api();
  if (!a || !a.runtime || typeof a.runtime.sendMessage !== "function") {
    return Promise.reject(new Error("background messaging unavailable"));
  }
  try {
    var r = a.runtime.sendMessage(msg);
    if (r && typeof r.then === "function") {
      return r.then(unwrapEnvelope);
    }
  } catch (e) { /* callback form */ }
  return new Promise(function (resolve, reject) {
    a.runtime.sendMessage(msg, function (resp) {
      var err = (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.lastError);
      if (err) reject(new Error(err.message || String(err)));
      else {
        try { resolve(unwrapEnvelope(resp)); } catch (e2) { reject(e2); }
      }
    });
  });
}

/* Background wraps one-shot results as { ok, result } / { ok:false, error };
   handlers (testProvider/listModels) return { ok, models, detail } themselves,
   which the envelope result preserves. */
function unwrapEnvelope(resp) {
  if (resp && typeof resp === "object" && "ok" in resp && ("result" in resp || "error" in resp)) {
    if (resp.ok) return resp.result;
    throw new Error(resp.error || "Background request failed");
  }
  return resp;
}

function uid(prefix) {
  return prefix + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

function el(id) { return document.getElementById(id); }

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

var state = defaultState();
var editingPromptId = null;
var editingDirty = false;
var saveTimer = null;

function setStatus(text, cls) {
  var n = el("saveStatus");
  if (!n) return;
  n.textContent = text;
  n.className = "save-status" + (cls ? " " + cls : "");
}

function persist(showSaved) {
  return saveSettings(state).then(function () {
    if (showSaved !== false) {
      var st = storageStatus();
      setStatus(st && st.localVerified === false
        ? "Saved to backup mirror — browser.storage.local verification failed (see Data)"
        : "Saved ✓ (verified in browser.storage.local)", "ok");
    }
    refreshStorageUsage();
  }).catch(function (err) {
    setStatus("Save failed: " + (err && err.message ? err.message : err), "err");
    refreshStorageUsage();
  });
}

function storageStatus() {
  try {
    if (typeof GraphiteStorage !== "undefined" && GraphiteStorage &&
        typeof GraphiteStorage.getStorageStatus === "function") {
      return GraphiteStorage.getStorageStatus();
    }
  } catch (e) { /* lib unavailable */ }
  return null;
}

/* Human-readable persistence status for the Data section (Issue 3). */
function renderStorageStatus() {
  var node = el("persistenceStatus");
  if (!node) return;
  var idNote = "Add-on ID: graphite-sider@local (stable, from manifest browser_specific_settings.gecko.id). " +
    "Durable storage requires a permanent install with this ID; a temporary about:debugging install is " +
    "removed by Firefox at restart together with its storage, so no setting can survive a full restart that way.";
  var st = storageStatus();
  if (!st) {
    node.textContent = "Storage status: library unavailable; using raw browser.storage.local. " + idNote;
    return;
  }
  var parts = [];
  parts.push("Primary storage: " + (st.primary || "browser.storage.local") +
    (st.localVerified ? " (last save read-back verified)" : st.localVerified === false ? " (READ-BACK FAILED)" : ""));
  parts.push("Settings loaded from: " + (st.source || "unknown") +
    (st.recoveredFrom ? " — recovered from the " + st.recoveredFrom + " backup and primary copy healed" : ""));
  parts.push("Backup mirror (localStorage): " + (st.mirrorOk ? "ok" : st.mirrorOk === false ? "failed" + (st.mirrorError ? " (" + st.mirrorError + ")" : "") : "n/a"));
  parts.push("Sync mirror (browser.storage.sync, settings core only, no history): " +
    (st.syncOk ? "ok" + (st.syncBytes ? " (" + st.syncBytes + " B)" : "") : st.syncOk === false ? "unavailable/failed" + (st.syncError ? " (" + st.syncError + ")" : "") : "n/a"));
  if (st.savedAt) parts.push("Last saved: " + new Date(st.savedAt).toLocaleString() + " (revision " + (st.rev || 0) + ").");
  node.textContent = parts.join(" ") + " " + idNote + " " + (st.note || "");
}

function schedulePersist() {
  setStatus("Unsaved changes…", "");
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(function () { persist(true); }, 450);
}

/* ---------------- Providers UI ---------------- */

function renderPresetOptions() {
  el("presetSelect").innerHTML = PRESETS.map(function (p) {
    return '<option value="' + esc(p.id) + '">' + esc(p.label) + "</option>";
  }).join("");
}

function renderActiveProviderOptions() {
  var sel = el("activeProviderSelect");
  if (!state.providers.length) {
    sel.innerHTML = '<option value="">(no providers)</option>';
    sel.value = "";
    return;
  }
  sel.innerHTML = state.providers.map(function (p) {
    return '<option value="' + esc(p.id) + '">' + esc(p.label) + "</option>";
  }).join("");
  sel.value = state.activeProviderId || state.providers[0].id;
}

function renderProviders() {
  var list = el("providerList");
  el("noProviders").classList.toggle("hidden", state.providers.length > 0);
  list.innerHTML = state.providers.map(function (p) {
    var active = p.id === state.activeProviderId;
    return '' +
    '<article class="provider-card' + (active ? " is-active" : "") + '" data-id="' + esc(p.id) + '">' +
      '<div class="provider-head">' +
        '<span class="provider-title">' + esc(p.label) + "</span>" +
        '<span class="badge">' + esc(p.kind) + "</span>" +
        (active ? '<span class="badge active">Active</span>' : "") +
        '<span class="spacer"></span>' +
        '<label class="check"><input type="checkbox" data-field="enabled"' + (p.enabled ? " checked" : "") + "> Enabled</label>" +
      "</div>" +
      '<div class="grid-2">' +
        '<label class="field"><span>Label</span><input type="text" data-field="label" value="' + esc(p.label) + '"></label>' +
        '<label class="field"><span>Kind</span><select data-field="kind">' +
          PROVIDER_KINDS.map(function (k) {
            return '<option value="' + k + '"' + (p.kind === k ? " selected" : "") + ">" + k + "</option>";
          }).join("") +
        "</select></label>" +
        '<label class="field"><span>Base URL</span><input type="text" data-field="baseUrl" value="' + esc(p.baseUrl) + '" placeholder="https://api.example.com/v1" spellcheck="false"></label>' +
        '<label class="field"><span>API key <em class="hint">(blank for local models)</em></span><input type="password" data-field="apiKey" value="' + esc(p.apiKey) + '" autocomplete="off" spellcheck="false" placeholder="sk-…"></label>' +
      "</div>" +
      '<label class="field"><span>Model</span>' +
        '<input type="text" data-field="model" list="models-' + esc(p.id) + '" value="' + esc(p.model) + '" placeholder="model id" spellcheck="false">' +
        '<datalist id="models-' + esc(p.id) + '"></datalist>' +
      "</label>" +
      '<label class="field"><span>Image model <em class="hint">(used by /images/generations, e.g. gpt-image-1 — not the chat model; Anthropic providers may leave blank)</em></span>' +
        '<input type="text" data-field="imageModel" value="' + esc(p.imageModel || "") + '" placeholder="e.g. gpt-image-1" spellcheck="false">' +
      "</label>" +
      '<div class="row-actions wrap">' +
        '<button type="button" class="btn btn-small" data-action="test">Test Connection</button>' +
        '<button type="button" class="btn btn-small" data-action="fetch-models">Fetch models</button>' +
        '<button type="button" class="btn btn-small" data-action="set-active"' + (active ? " disabled" : "") + ">Set Active</button>" +
        '<button type="button" class="btn btn-small btn-danger" data-action="delete">Delete</button>' +
      "</div>" +
      '<div class="test-result" data-role="test-result" role="status" aria-live="polite"></div>' +
    "</article>";
  }).join("");
  renderActiveProviderOptions();
}

function providerFromCard(card) {
  var id = card.getAttribute("data-id");
  var found = null;
  state.providers.forEach(function (p) { if (p.id === id) found = p; });
  return found;
}

function readProviderCard(card, provider) {
  card.querySelectorAll("[data-field]").forEach(function (input) {
    var f = input.getAttribute("data-field");
    if (f === "enabled") provider.enabled = !!input.checked;
    else provider[f] = input.value;
  });
}

function fillModelDatalist(card, models) {
  var provider = providerFromCard(card);
  if (!provider) return;
  var dl = card.querySelector('datalist[id="models-' + provider.id + '"]') || card.querySelector("datalist");
  if (!dl) return;
  var list = [];
  (models || []).forEach(function (m) {
    var id = typeof m === "string" ? m : (m && (m.id || m.name || m.model));
    if (id) list.push(String(id));
  });
  dl.innerHTML = list.map(function (m) { return '<option value="' + esc(m) + '"></option>'; }).join("");
  return list;
}

function showTestResult(card, ok, text) {
  var box = card.querySelector('[data-role="test-result"]');
  if (!box) return;
  box.className = "test-result show " + (ok ? "ok" : "err");
  box.textContent = text;
}

function addProviderFromPreset() {
  var preset = null;
  PRESETS.forEach(function (p) { if (p.id === el("presetSelect").value) preset = p; });
  if (!preset) preset = PRESETS[0];
  var provider = {
    id: uid("provider"), label: preset.label, kind: preset.kind,
    baseUrl: preset.baseUrl, apiKey: "", model: preset.model, enabled: true
  };
  state.providers.push(provider);
  if (!state.activeProviderId) state.activeProviderId = provider.id;
  renderProviders();
  renderDefaults();
  schedulePersist();
}

/* ---------------- Defaults / features UI ---------------- */

function renderDefaults() {
  el("activeModel").value = state.activeModel || "";
  if (el("translationLanguages")) {
    var langArea = el("translationLanguages");
    if (document.activeElement !== langArea) langArea.value = effectiveTranslationLanguages().join("\n");
  }
  renderLanguageOptions();
  el("targetLang").value = state.settings.targetLang || "";
  el("temperature").value = String(state.settings.temperature != null ? state.settings.temperature : 0.7);
  el("temperatureValue").textContent = Number(el("temperature").value).toFixed(1);
  el("maxTokens").value = String(state.settings.maxTokens || 4096);
  el("maxTokensValue").textContent = "(current: " + (state.settings.maxTokens || 4096) + ")";
  el("systemPrompt").value = state.settings.systemPrompt || "";
  el("featSelectionToolbar").checked = !!state.settings.selectionToolbar;
  el("featSearchEnhance").checked = !!state.settings.searchEnhance;
  el("featYoutubeAutoSummary").checked = !!state.settings.youtubeAutoSummary;
  el("featBilingualSubtitles").checked = !!state.settings.bilingualSubtitles;
  renderActiveProviderOptions();
}

function readDefaultsFromUI() {
  state.activeProviderId = el("activeProviderSelect").value || state.activeProviderId;
  state.activeModel = el("activeModel").value.trim();
  state.settings.targetLang = el("targetLang").value;
  state.settings.temperature = Math.min(2, Math.max(0, Number(el("temperature").value) || 0));
  state.settings.maxTokens = Math.max(64, parseInt(el("maxTokens").value, 10) || 4096);
  state.settings.systemPrompt = el("systemPrompt").value;
  if (el("translationLanguages")) {
    state.settings.translationLanguages = parseLanguageLines(el("translationLanguages").value);
  }
  state.settings.selectionToolbar = el("featSelectionToolbar").checked;
  state.settings.searchEnhance = el("featSearchEnhance").checked;
  state.settings.youtubeAutoSummary = el("featYoutubeAutoSummary").checked;
  state.settings.bilingualSubtitles = el("featBilingualSubtitles").checked;
}

/* ---------------- Prompts UI ---------------- */

function builtinPrompts() {
  try {
    if (typeof GraphitePrompts !== "undefined" && GraphitePrompts) {
      var raw = GraphitePrompts.BUILTIN_PROMPTS || GraphitePrompts.builtinPrompts ||
                GraphitePrompts.prompts || GraphitePrompts.BUILTINS || [];
      if (Array.isArray(raw)) return raw;
      if (raw && typeof raw === "object") {
        return Object.keys(raw).map(function (k) {
          var v = raw[k];
          return typeof v === "string" ? { id: k, name: k, body: v } : v;
        });
      }
      if (typeof GraphitePrompts.listBuiltin === "function") return GraphitePrompts.listBuiltin() || [];
      if (typeof GraphitePrompts.getBuiltinPrompts === "function") return GraphitePrompts.getBuiltinPrompts() || [];
    }
  } catch (e) { /* library shape mismatch — treat as unavailable */ }
  return [];
}

function promptName(p) { return String((p && (p.name || p.title || p.id)) || "Untitled prompt"); }
function promptBody(p) { return String((p && (p.body || p.prompt || p.template || p.content)) || ""); }

var selectedBuiltinPromptId = null;

function builtinById(id) {
  if (!id) return null;
  var found = null;
  builtinPrompts().forEach(function (p) { if (p && p.id === id) found = p; });
  return found;
}

function promptOverride(id) {
  if (!id) return null;
  var found = null;
  (state.prompts || []).forEach(function (p) { if (p && p.id === id) found = p; });
  return found;
}

function isBuiltinId(id) { return !!builtinById(id); }

function renderBuiltinPromptEditor(preferredId) {
  var builtins = builtinPrompts();
  el("noBuiltinPrompts").classList.toggle("hidden", builtins.length > 0);
  var sel = el("builtinPromptSelect");
  var body = el("builtinPromptBody");
  var status = el("builtinPromptStatus");
  var wrapper = el("builtinPromptEditor");
  if (wrapper) wrapper.classList.toggle("hidden", builtins.length === 0);
  if (sel) sel.classList.toggle("hidden", builtins.length === 0);
  if (!builtins.length) { selectedBuiltinPromptId = null; return; }
  var want = preferredId || (sel && sel.value) || selectedBuiltinPromptId;
  if (!want || !builtins.some(function (p) { return p.id === want; })) want = builtins[0].id;
  selectedBuiltinPromptId = want;
  if (sel) {
    sel.innerHTML = builtins.map(function (p) {
      var overridden = !!promptOverride(p.id);
      return '<option value="' + esc(p.id) + '">' + esc(promptName(p)) +
        (overridden ? " (customized)" : "") + "</option>";
    }).join("");
    sel.value = want;
  }
  var builtin = builtinById(want);
  var override = promptOverride(want);
  if (body) body.value = override ? promptBody(override) : (builtin ? promptBody(builtin) : "");
  if (status) {
    status.textContent = override
      ? "Customized — your version is used everywhere"
      : "Built-in default";
    status.className = "hint builtin-prompt-status" + (override ? " is-customized" : "");
  }
}

/* Selected entry of the custom/override dropdown. Kept in sync with
   `editingPromptId` (the id currently loaded in the editor) so saves,
   cancels and deletes always refer to the same prompt. */
var selectedCustomPromptId = null;

function customPromptById(id) {
  if (!id) return null;
  var found = null;
  (state.prompts || []).forEach(function (p) { if (p && p.id === id) found = p; });
  return found;
}

/* Dropdown confinement: custom/override prompts live in ONE closed
   <select>; a body is only visible inside the editor below, and only for
   the entry currently selected in that dropdown (or a new, unsaved entry
   being added). No prompt name/body is rendered outside the dropdown. */
function renderCustomPromptSelect(preferredId) {
  var sel = el("customPromptSelect");
  var status = el("customPromptStatus");
  var editor = el("customPromptEditor");
  var del = el("deleteCustomPromptBtn");
  var has = state.prompts.length > 0;
  el("noCustomPrompts").classList.toggle("hidden", has);
  if (editor) editor.classList.toggle("hidden", !has && !editingPromptId);
  if (del) del.disabled = !has;

  var want = preferredId || editingPromptId || selectedCustomPromptId || null;
  if (want && !customPromptById(want)) want = null;
  if (want) editingPromptId = want;
  selectedCustomPromptId = want;

  if (sel) {
    sel.innerHTML = '<option value="">(+ New prompt)</option>' + state.prompts.map(function (p) {
      return '<option value="' + esc(p.id) + '">' + esc(promptName(p)) +
        (isBuiltinId(p.id) ? " (built-in override)" : " (custom)") + "</option>";
    }).join("");
    sel.value = want || "";
  }

  var found = want ? customPromptById(want) : null;
  if (found) {
    /* Do not clobber a name/body being typed for this same entry. */
    if (!editingDirty) {
      el("promptName").value = promptName(found);
      el("promptBody").value = promptBody(found);
    }
    el("savePromptBtn").textContent = "Save prompt";
    el("cancelPromptEditBtn").classList.remove("hidden");
  } else {
    editingPromptId = null;
    if (!editingDirty) {
      if (document.activeElement !== el("promptName")) el("promptName").value = "";
      if (document.activeElement !== el("promptBody")) el("promptBody").value = "";
    }
  }
  if (status) status.textContent = found
    ? ("Editing: " + promptName(found) + (isBuiltinId(found.id) ? " (built-in override)" : " (custom)"))
    : (has ? "No custom prompt selected" : "No custom prompts yet");
}

function renderPrompts() {
  renderBuiltinPromptEditor(selectedBuiltinPromptId);
  renderCustomPromptSelect();
}

function saveBuiltinPromptEditor() {
  var sel = el("builtinPromptSelect");
  var body = el("builtinPromptBody");
  var id = sel ? sel.value : selectedBuiltinPromptId;
  var builtin = builtinById(id);
  if (!builtin || !body) { setStatus("No built-in prompt selected", "err"); return; }
  var override = promptOverride(id);
  var next = {
    id: builtin.id, name: promptName(builtin),
    icon: builtin.icon || "", category: builtin.category || "",
    body: body.value, builtin: false
  };
  if (override) {
    var keys = Object.keys(override);
    keys.forEach(function (k) { if (!(k in next)) next[k] = override[k]; });
    next.body = body.value;
    state.prompts = state.prompts.map(function (p) { return p.id === id ? next : p; });
  } else {
    state.prompts.push(next);
  }
  selectedBuiltinPromptId = id;
  renderPrompts();
  schedulePersist();
  setStatus("Built-in prompt customized ✓", "ok");
}

function resetBuiltinPromptEditor() {
  var sel = el("builtinPromptSelect");
  var id = sel ? sel.value : selectedBuiltinPromptId;
  var builtin = builtinById(id);
  if (!builtin) { setStatus("No built-in prompt selected", "err"); return; }
  state.prompts = state.prompts.filter(function (p) { return p.id !== id; });
  selectedBuiltinPromptId = id;
  renderPrompts();
  schedulePersist();
  setStatus("Prompt reset to built-in default ✓", "ok");
}

function savePromptFromEditor() {
  var name = el("promptName").value.trim();
  var body = el("promptBody").value;
  if (!name) { setStatus("Prompt name is required", "err"); el("promptName").focus(); return; }
  if (!body.trim()) { setStatus("Prompt body is required", "err"); el("promptBody").focus(); return; }
  var wasBuiltinOverrideEdit = !!(editingPromptId && isBuiltinId(editingPromptId));
  if (editingPromptId) {
    state.prompts.forEach(function (p) {
      if (p.id === editingPromptId) { p.name = name; p.body = body; }
    });
  } else {
    state.prompts.push({ id: uid("prompt"), name: name, body: body });
  }
  if (wasBuiltinOverrideEdit) selectedBuiltinPromptId = editingPromptId;
  selectedCustomPromptId = editingPromptId;
  editingPromptId = null;
  editingDirty = false;
  el("savePromptBtn").textContent = "Add prompt";
  el("cancelPromptEditBtn").classList.add("hidden");
  renderPrompts();
  schedulePersist();
}

function downloadJson(filename, data) {
  var blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  var url = URL.createObjectURL(blob);
  var a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
}

function readJsonFile(input) {
  return new Promise(function (resolve, reject) {
    var file = input.files && input.files[0];
    if (!file) { reject(new Error("no file chosen")); return; }
    var reader = new FileReader();
    reader.onload = function () {
      try { resolve(JSON.parse(String(reader.result || ""))); }
      catch (e) { reject(new Error("invalid JSON file: " + e.message)); }
    };
    reader.onerror = function () { reject(new Error("could not read file")); };
    reader.readAsText(file);
  });
}

/* ---------------- Data / storage usage ---------------- */

function refreshStorageUsage() {
  renderStorageStatus();
  var node = el("storageUsage");
  var a = api();
  function done(text) { node.textContent = text; }
  if (a && a.storage && a.storage.local && typeof a.storage.local.getBytesInUse === "function") {
    try {
      var r = a.storage.local.getBytesInUse(null);
      if (r && typeof r.then === "function") {
        r.then(function (bytes) { done("Storage usage: " + formatBytes(bytes) + " in browser.storage.local."); })
         .catch(function () { estimateUsage(done); });
        return;
      }
    } catch (e) { /* fall through */ }
  }
  estimateUsage(done);
}

function estimateUsage(done) {
  storageGetAll().then(function (all) {
    var bytes = 0;
    try { bytes = new Blob([JSON.stringify(all || {})]).size; } catch (e) { bytes = JSON.stringify(all || {}).length; }
    done("Storage usage: about " + formatBytes(bytes) + " stored in browser.storage.local (estimated).");
  }).catch(function () { done("Storage usage: unavailable in this context."); });
}

function formatBytes(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / (1024 * 1024)).toFixed(2) + " MB";
}

function clearHistory() {
  if (!window.confirm("Clear all Graphite Sider chat history? Settings and providers are kept.")) return;
  var jobs = [];
  // Preferred path: lib/storage.js owns history (embedded in settings + its key).
  if (typeof GraphiteStorage !== "undefined" && GraphiteStorage &&
      typeof GraphiteStorage.clearHistory === "function") {
    jobs.push(Promise.resolve().then(function () { return GraphiteStorage.clearHistory(); }));
    if (GraphiteStorage.HISTORY_KEY) jobs.push(storageRemove(GraphiteStorage.HISTORY_KEY).catch(function () {}));
  }
  // Fallbacks for older/other shapes: legacy keys + discovery pass.
  jobs.push(Promise.all(
    ["graphite_history", "graphite_conversations", "graphite_chats", "chat_history"]
      .map(function (k) { return storageRemove(k).catch(function () {}); })
  ));
  jobs.push(storageGetAll().then(function (all) {
    var extra = Object.keys(all || {}).filter(function (k) {
      return k !== STORAGE_KEY && /hist|conversation|chat/i.test(k);
    });
    return Promise.all(extra.map(function (k) { return storageRemove(k).catch(function () {}); }));
  }).catch(function () {}));
  jobs.push(sendMessage({ type: "clearHistory" }).catch(function () {}));
  // History may also live inside the settings blob (state.history) — clear it.
  state.history = [];
  if (typeof GraphiteStorage === "undefined" || !GraphiteStorage) jobs.push(persist(false));
  Promise.all(jobs).then(function () {
    setStatus("Chat history cleared ✓", "ok");
    refreshStorageUsage();
  });
}

/* ---------------- Events ---------------- */

function bindEvents() {
  el("addProviderBtn").addEventListener("click", addProviderFromPreset);
  el("saveAllBtn").addEventListener("click", function () {
    document.querySelectorAll(".provider-card").forEach(function (card) {
      var p = providerFromCard(card); if (p) readProviderCard(card, p);
    });
    readDefaultsFromUI();
    renderProviders();
    persist(true);
  });

  el("providerList").addEventListener("input", function (ev) {
    var card = ev.target.closest(".provider-card");
    if (!card) return;
    var p = providerFromCard(card);
    if (!p) return;
    readProviderCard(card, p);
    if (ev.target.getAttribute("data-field") === "label") renderActiveProviderOptions();
    schedulePersist();
  });
  el("providerList").addEventListener("change", function (ev) {
    var card = ev.target.closest(".provider-card");
    if (!card) return;
    var p = providerFromCard(card);
    if (!p) return;
    readProviderCard(card, p);
    renderProviders();
    schedulePersist();
  });
  el("providerList").addEventListener("click", function (ev) {
    var btn = ev.target.closest("[data-action]");
    if (!btn) return;
    var card = ev.target.closest(".provider-card");
    var p = card && providerFromCard(card);
    if (!p) return;
    readProviderCard(card, p);
    var action = btn.getAttribute("data-action");
    if (action === "delete") {
      state.providers = state.providers.filter(function (x) { return x.id !== p.id; });
      if (state.activeProviderId === p.id) {
        state.activeProviderId = state.providers.length ? state.providers[0].id : "";
      }
      renderProviders(); renderDefaults(); schedulePersist();
    } else if (action === "set-active") {
      state.activeProviderId = p.id;
      renderProviders(); renderDefaults(); schedulePersist();
    } else if (action === "test") {
      btn.disabled = true;
      showTestResult(card, true, "Testing…");
      sendMessage({ type: "testProvider", provider: p }).then(function (resp) {
        if (resp && resp.ok) {
          var models = resp.models && resp.models.length ? "\nModels: " + resp.models.join(", ") : "";
          showTestResult(card, true, "✓ " + (resp.message || "Connection OK") + models);
        } else {
          showTestResult(card, false, "✗ " + ((resp && resp.message) || "Test failed (no response from background)"));
        }
      }).catch(function (err) {
        showTestResult(card, false, "✗ " + (err && err.message ? err.message : err));
      }).then(function () { btn.disabled = false; });
    } else if (action === "fetch-models") {
      btn.disabled = true;
      sendMessage({ type: "listModels", provider: p }).then(function (resp) {
        var models = (resp && (resp.models || (resp.ok ? resp.models : null))) || null;
        if (models && models.length) {
          fillModelDatalist(card, models);
          showTestResult(card, true, "✓ " + models.length + " model(s) available — pick one in the Model field.");
        } else {
          showTestResult(card, false, "✗ " + ((resp && resp.message) || "No models returned"));
        }
      }).catch(function (err) {
        showTestResult(card, false, "✗ " + (err && err.message ? err.message : err));
      }).then(function () { btn.disabled = false; });
    }
  });

  ["activeProviderSelect", "activeModel", "targetLang", "maxTokens", "systemPrompt"].forEach(function (id) {
    el(id).addEventListener("input", function () { readDefaultsFromUI(); schedulePersist(); });
    el(id).addEventListener("change", function () { readDefaultsFromUI(); schedulePersist(); });
  });
  el("temperature").addEventListener("input", function () {
    el("temperatureValue").textContent = Number(el("temperature").value).toFixed(1);
    readDefaultsFromUI(); schedulePersist();
  });
  ["featSelectionToolbar", "featSearchEnhance", "featYoutubeAutoSummary", "featBilingualSubtitles"].forEach(function (id) {
    el(id).addEventListener("change", function () { readDefaultsFromUI(); schedulePersist(); });
  });

  if (el("translationLanguages")) {
    el("translationLanguages").addEventListener("input", function () {
      var current = el("targetLang").value;
      state.settings.translationLanguages = parseLanguageLines(el("translationLanguages").value);
      renderLanguageOptions(current);
      schedulePersist();
    });
    el("translationLanguages").addEventListener("change", function () {
      var current = el("targetLang").value;
      state.settings.translationLanguages = parseLanguageLines(el("translationLanguages").value);
      renderLanguageOptions(current);
      schedulePersist();
    });
  }

  el("savePromptBtn").addEventListener("click", savePromptFromEditor);
  if (el("builtinPromptSelect")) {
    el("builtinPromptSelect").addEventListener("change", function () {
      renderBuiltinPromptEditor(el("builtinPromptSelect").value);
    });
  }
  if (el("saveBuiltinPromptBtn")) el("saveBuiltinPromptBtn").addEventListener("click", saveBuiltinPromptEditor);
  if (el("resetBuiltinPromptBtn")) el("resetBuiltinPromptBtn").addEventListener("click", resetBuiltinPromptEditor);
  ["promptName", "promptBody"].forEach(function (id) {
    var node = el(id);
    if (node) node.addEventListener("input", function () { editingDirty = true; });
  });
  el("cancelPromptEditBtn").addEventListener("click", function () {
    editingPromptId = null;
    selectedCustomPromptId = null;
    editingDirty = false;
    el("promptName").value = ""; el("promptBody").value = "";
    el("savePromptBtn").textContent = "Add prompt";
    el("cancelPromptEditBtn").classList.add("hidden");
  });
  if (el("customPromptSelect")) {
    el("customPromptSelect").addEventListener("change", function () {
      var found = customPromptById(el("customPromptSelect").value);
      editingDirty = false;
      selectedCustomPromptId = found ? found.id : null;
      editingPromptId = found ? found.id : null;
      renderCustomPromptSelect(selectedCustomPromptId);
      if (found) {
        if (isBuiltinId(found.id)) {
          selectedBuiltinPromptId = found.id;
          renderBuiltinPromptEditor(found.id);
          var bBody = el("builtinPromptBody");
          if (bBody) bBody.focus();
        } else {
          el("promptName").focus();
        }
      }
    });
  }
  if (el("deleteCustomPromptBtn")) {
    el("deleteCustomPromptBtn").addEventListener("click", function () {
      var id = selectedCustomPromptId ||
        (el("customPromptSelect") && el("customPromptSelect").value) || editingPromptId;
      if (!id || !customPromptById(id)) { setStatus("Select a saved prompt to delete", "err"); return; }
      state.prompts = state.prompts.filter(function (p) { return p.id !== id; });
      if (editingPromptId === id) editingPromptId = null;
      selectedCustomPromptId = null;
      editingDirty = false;
      if (isBuiltinId(id)) selectedBuiltinPromptId = id;
      renderPrompts(); schedulePersist();
    });
  }

  el("exportPromptsBtn").addEventListener("click", function () {
    downloadJson("graphite-prompts.json", { prompts: state.prompts, builtins: builtinPrompts().map(function (p) {
      return { name: promptName(p), body: promptBody(p), builtin: true };
    }) });
  });
  el("importPromptsFile").addEventListener("change", function (ev) {
    readJsonFile(ev.target).then(function (data) {
      var incoming = Array.isArray(data) ? data : (data && data.prompts);
      if (!Array.isArray(incoming)) throw new Error("expected {prompts:[…]} or an array");
      incoming.forEach(function (p) {
        if (p && !p.builtin) {
          state.prompts.push({ id: uid("prompt"), name: promptName(p), body: promptBody(p) });
        }
      });
      renderPrompts(); schedulePersist();
      setStatus("Prompts imported ✓", "ok");
    }).catch(function (err) { setStatus("Import failed: " + err.message, "err"); });
    ev.target.value = "";
  });

  el("exportAllBtn").addEventListener("click", function () {
    if (!window.confirm("The exported file contains API keys in plain text. Continue?")) return;
    var job = (typeof GraphiteStorage !== "undefined" && GraphiteStorage &&
               typeof GraphiteStorage.exportSettings === "function")
      ? GraphiteStorage.exportSettings(JSON.parse(JSON.stringify(state)))
      : Promise.resolve(makeExport());
    job.then(function (data) { downloadJson("graphite-settings.json", data); })
       .catch(function (err) { setStatus("Export failed: " + err.message, "err"); });
  });
  if (el("openSidebarBtn")) el("openSidebarBtn").addEventListener("click", openSidebar);
  if (el("sidebarSidePref")) el("sidebarSidePref").addEventListener("change", function () {
    state.settings.sidebarSide = el("sidebarSidePref").value === "left" ? "left" : "right";
    schedulePersist();
  });
  el("importAllFile").addEventListener("change", function (ev) {
    var input = ev.target;
    readJsonFile(input).then(function (data) {
      if (typeof GraphiteStorage !== "undefined" && GraphiteStorage &&
          typeof GraphiteStorage.importSettings === "function") {
        // Library import validates, replaces and verifies the write.
        return GraphiteStorage.importSettings(data).then(function (saved) {
          state = normalizeState(saved);
          renderAll();
          setStatus("Settings imported ✓ (verified in browser.storage.local)", "ok");
          refreshStorageUsage();
        });
      }
      var incoming = (data && data[STORAGE_KEY]) || data;
      state = normalizeState(incoming);
      renderAll();
      return persist(true);
    }).then(function () { /* status already set on the lib path */ })
      .catch(function (err) { setStatus("Import failed: " + err.message, "err"); });
    input.value = "";
  });
  el("refreshUsageBtn").addEventListener("click", refreshStorageUsage);
  el("clearHistoryBtn").addEventListener("click", clearHistory);
}

function makeExport() {
  var obj = {};
  obj[STORAGE_KEY] = state;
  obj.exportedAt = new Date().toISOString();
  obj.app = "graphite-sider";
  return obj;
}

function renderAll() {
  renderProviders();
  renderDefaults();
  renderPrompts();
  renderSidebarGuide();
}

function renderLanguageOptions(preserveValue) {
  var selLang = el("targetLang");
  if (!selLang) return;
  var previous = preserveValue != null ? String(preserveValue) :
    (selLang.value || (state.settings && state.settings.targetLang) || "");
  var names = effectiveTranslationLanguages().slice();
  if (previous && names.indexOf(previous) < 0) names.unshift(previous);
  selLang.innerHTML = names.map(function (name) {
    return '<option value="' + esc(name) + '">' + esc(name || "Auto / same as source") + "</option>";
  }).join("");
  selLang.value = previous;
}

function init() {
  renderPresetOptions();
  renderLanguageOptions("");
  bindEvents();
  loadSettings().then(function (loaded) {
    state = loaded;
    renderAll();
    refreshStorageUsage();
    setStatus("Loaded", "ok");
  }).catch(function (err) {
    state = defaultState();
    renderAll();
    setStatus("Could not load settings: " + (err && err.message ? err.message : err), "err");
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
