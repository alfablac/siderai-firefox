'use strict';
/**
 * Graphite Sider — storage & settings.
 * Loaded as a classic script in background page, sidebar and options pages
 * (script order: storage.js first). Also importScripts()-able.
 * Attaches `GraphiteStorage` to globalThis.
 *
 * Persistence model (Issue 3 — BYOK settings lost across Firefox restarts):
 *
 *   PRIMARY   browser.storage.local[key graphiteSider.settings.v1]
 *             Durable ONLY when the add-on is installed permanently with the
 *             stable gecko id from manifest.json (graphite-sider@local).
 *             A temporary about:debugging install is removed by Firefox at
 *             restart together with its storage — no extension code can
 *             survive that. See the Data section of the options page.
 *   MIRROR A  localStorage[key] (same moz-extension origin). Backup only:
 *             it never overrides a newer primary copy (savedAt wins) and is
 *             consulted only when the primary copy is missing or older.
 *             Its origin is keyed by the extension UUID, so it helps only
 *             while the add-on id/UUID is stable (permanent install).
 *   MIRROR B  browser.storage.sync[graphiteSider.settings.sync.v1]
 *             Best-effort mirror of the settings *core* only (providers,
 *             active selection, UI settings, prompts — history is excluded
 *             and the payload is size-capped below the 8 KB/item sync quota).
 *             Firefox stores storage.sync in the profile when not signed in
 *             to Firefox Sync; when Sync is enabled it may be synced by
 *             Firefox itself. Write failures (quota, no sync area) are
 *             reported in the storage status, never fatal.
 *
 * Every save: reads the persisted copies first (so a non-persistent
 * background page or a second context with a stale in-memory cache cannot
 * clobber newer on-disk data), writes the primary copy, reads it back to
 * verify, then refreshes both mirrors. Settings carry `_meta {savedAt, rev}`
 * so competing copies can be ordered without guessing.
 *
 * Privacy: API keys live in browser.storage.local (primary) on this device,
 * plus the two mirrors above so settings can be recovered if the primary
 * copy is lost. Keys are sent only to the configured provider baseUrl.
 */
(function (global) {

  var STORAGE_KEY = 'graphiteSider.settings.v1';
  var PENDING_KEY = 'graphiteSider.pendingAction';
  var HISTORY_KEY = 'graphiteSider.history.v1';
  var JOBS_KEY = 'graphiteSider.jobs.v1';
  var SYNC_KEY = 'graphiteSider.settings.sync.v1';
  var HISTORY_LIMIT = 100;
  // storage.sync allows 8192 bytes per item (key + value); stay well under.
  var SYNC_BUDGET_BYTES = 7000;

  /** @returns {*} browser.* promise API, chrome callback API, or null. */
  function extApi() {
    if (typeof global.browser !== 'undefined' && global.browser && global.browser.storage) return global.browser;
    if (typeof global.chrome !== 'undefined' && global.chrome && global.chrome.storage) return global.chrome;
    return null;
  }

  function makeDeferred() {
    var d = {};
    d.promise = new Promise(function (resolve, reject) { d.resolve = resolve; d.reject = reject; });
    return d;
  }

  // promise/callback-normalised access to one storage area ("local"/"sync").
  function areaGet(areaName, key) {
    var api = extApi();
    var area = api && api.storage && api.storage[areaName];
    if (!area) return Promise.reject(new Error('browser.storage.' + areaName + ' unavailable'));
    var d = makeDeferred();
    try {
      var out = area.get(key, function (items) {
        var err = api.runtime && api.runtime.lastError;
        if (err) d.reject(new Error(err.message || String(err)));
        else d.resolve(items || {});
      });
      if (out && typeof out.then === 'function') return out;
      return d.promise;
    } catch (e) { return Promise.reject(e); }
  }

  function areaSet(areaName, obj) {
    var api = extApi();
    var area = api && api.storage && api.storage[areaName];
    if (!area) return Promise.reject(new Error('browser.storage.' + areaName + ' unavailable'));
    var d = makeDeferred();
    try {
      var out = area.set(obj, function () {
        var err = api.runtime && api.runtime.lastError;
        if (err) d.reject(new Error(err.message || String(err)));
        else d.resolve();
      });
      if (out && typeof out.then === 'function') return out;
      return d.promise;
    } catch (e) { return Promise.reject(e); }
  }

  // In-memory fallback so the library also works in plain pages / Node tests
  // where neither browser storage nor localStorage exists.
  var memoryFallback = {};

  function lsGet(key) {
    try {
      if (global.localStorage) return global.localStorage.getItem(key);
    } catch (e) { /* unavailable */ }
    return Object.prototype.hasOwnProperty.call(memoryFallback, key) ? memoryFallback[key] : null;
  }
  function lsSet(key, value) {
    try {
      if (global.localStorage) { global.localStorage.setItem(key, value); return true; }
    } catch (e) { /* fall through to memory */ }
    memoryFallback[key] = value;
    return false; // memory only — not durable
  }
  function hasLocalStorage() {
    try { return !!global.localStorage; } catch (e) { return false; }
  }

  /**
   * Generic single-key read/write kept for backwards compatibility
   * (sidebar pending-action polling uses _rawGet/_rawSet).
   * storage.local is primary; localStorage is a same-key backup mirror.
   */
  function rawGet(key) {
    var api = extApi();
    if (api && api.storage && api.storage.local) {
      return areaGet('local', key).then(function (items) {
        if (items && typeof items[key] !== 'undefined') return items;
        var mirrored = parseStored(lsGet(key));
        if (mirrored != null) { var o = {}; o[key] = mirrored; return o; }
        return items || {};
      });
    }
    return Promise.resolve().then(function () {
      var v = parseStored(lsGet(key));
      var o = {};
      if (v != null) o[key] = v;
      return o;
    });
  }

  function rawSet(obj) {
    // Always refresh the localStorage backup mirror first (cheap, synchronous).
    Object.keys(obj).forEach(function (k) {
      try { lsSet(k, JSON.stringify(obj[k])); } catch (e) { /* quota */ }
    });
    var api = extApi();
    if (api && api.storage && api.storage.local) return areaSet('local', obj);
    return Promise.resolve();
  }

  function parseStored(text) {
    if (text == null) return null;
    try { return JSON.parse(text); } catch (e) { return null; }
  }

  function uid(prefix) {
    return (prefix || 'id') + '-' + Date.now().toString(36) + '-' +
      Math.random().toString(36).slice(2, 9);
  }

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function byteLength(s) {
    try { return new Blob([s]).size; } catch (e) { return String(s).length; }
  }

  /**
   * Preset providers. `model` is a conservative default the user can edit.
   * Anthropic note: use any current Muse model id your key can access
   * (e.g. claude-sonnet-4-5); claude-3-5-haiku-latest is a safe low-cost default.
   */
  var DEFAULT_PROVIDERS = [
    { id: 'openai', label: 'OpenAI', kind: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-4o-mini', visionModel: 'gpt-4o-mini', imageModel: 'gpt-image-1', enabled: true },
    { id: 'anthropic', label: 'Anthropic', kind: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey: '', model: 'claude-3-5-haiku-latest', visionModel: 'claude-3-5-haiku-latest', imageModel: '', enabled: true },
    { id: 'openrouter', label: 'OpenRouter', kind: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1', apiKey: '', model: 'openai/gpt-4o-mini', imageModel: 'gpt-image-1', enabled: true },
    { id: 'groq', label: 'Groq', kind: 'openai-compatible', baseUrl: 'https://api.groq.com/openai/v1', apiKey: '', model: 'llama-3.3-70b-versatile', imageModel: '', enabled: true },
    { id: 'deepseek', label: 'DeepSeek', kind: 'openai-compatible', baseUrl: 'https://api.deepseek.com/v1', apiKey: '', model: 'deepseek-chat', imageModel: '', enabled: true },
    { id: 'ollama', label: 'Ollama (local)', kind: 'ollama', baseUrl: 'http://localhost:11434/v1', apiKey: '', model: 'llama3.1', imageModel: '', enabled: true },
    { id: 'lmstudio', label: 'LM Studio (local)', kind: 'openai-compatible', baseUrl: 'http://localhost:1234/v1', apiKey: '', model: 'local-model', imageModel: '', enabled: true },
    { id: 'custom', label: 'Custom (OpenAI-compatible)', kind: 'custom-openai', baseUrl: '', apiKey: '', model: '', imageModel: 'gpt-image-1', enabled: true }
  ];

  var DEFAULT_UI_SETTINGS = {
    targetLang: 'English',
    // Editable list of translation target display names used by the sidebar
    // translate UI. Another agent owns the options UI that edits this list.
    translationLanguages: [
      'English', 'Spanish', 'French', 'German', 'Italian', 'Portuguese',
      'Portuguese (Brazil)', 'Dutch', 'Swedish', 'Norwegian', 'Danish',
      'Finnish', 'Polish', 'Czech', 'Hungarian', 'Romanian', 'Ukrainian',
      'Russian', 'Greek', 'Turkish', 'Arabic', 'Persian', 'Hebrew', 'Hindi',
      'Bengali', 'Tamil', 'Thai', 'Vietnamese', 'Indonesian', 'Malay',
      'Filipino', 'Chinese (Simplified)', 'Chinese (Traditional)',
      'Japanese', 'Korean', 'Swahili', 'Catalan', 'Afrikaans'
    ],
    temperature: 0.7,
    // Output-token budget: 0 = provider/model default (no max_tokens sent).
    // Any positive number is sent exactly, for every chat flow.
    maxTokens: 0,
    systemPrompt: 'You are a helpful assistant in the Graphite Sider sidebar. Be concise and use Markdown.',
    youtubeAutoSummary: false,
    searchEnhance: true,
    selectionToolbar: true,
    bilingualSubtitles: false,
    // Issue 4: preferred sidebar side. Firefox (not the extension) controls
    // the actual built-in sidebar position; this records the user's choice
    // so the UI can show the matching one-time Firefox steps. See options.
    sidebarSide: 'right'
  };

  /**
   * Normalize translationLanguages: trim, drop empties, dedupe
   * (case-insensitive, first-seen spelling wins); fall back to the default
   * list when missing, not an array, or empty after cleaning.
   */
  function normalizeLangList(list) {
    var fallback = clone(DEFAULT_UI_SETTINGS.translationLanguages);
    if (!Array.isArray(list)) return fallback;
    var seen = {};
    var out = [];
    list.forEach(function (item) {
      var name = String(item == null ? '' : item).trim();
      if (!name) return;
      var key = name.toLowerCase();
      if (seen[key]) return;
      seen[key] = true;
      out.push(name);
    });
    return out.length ? out : fallback;
  }

  function normalizeModelList(input, defaultModel) {
    var out = [];
    var seen = {};
    if (Array.isArray(input)) {
      input.forEach(function (entry) {
        var id = '';
        if (typeof entry === 'string') id = entry.trim();
        else if (entry && typeof entry === 'object') {
          var keys = ['id', 'name', 'model'];
          for (var i = 0; i < keys.length; i++) {
            var v = entry[keys[i]];
            if (typeof v === 'string' && v.trim()) { id = v.trim(); break; }
          }
        }
        if (id && !seen[id]) { seen[id] = true; out.push(id); }
      });
    }
    var def = typeof defaultModel === 'string' ? defaultModel.trim() : '';
    if (def) {
      if (out.indexOf(def) !== -1) out = out.filter(function (m) { return m !== def; });
      out.unshift(def);
    }
    // Full provider catalogue: gateways like 9Router list ~600 models, so
    // there is no artificial cap here. storage.sync sheds the catalogue
    // (see coreForSync) to stay under its 8 KB/item quota.
    return out;
  }

  /** Factory-default full settings object. */
  function DEFAULT_SETTINGS() {
    return {
      version: 1,
      providers: clone(DEFAULT_PROVIDERS),
      activeProviderId: 'openai',
      activeModel: '',
      settings: clone(DEFAULT_UI_SETTINGS),
      prompts: [],
      history: []
    };
  }

  /** Merge stored data over defaults so new fields appear after upgrades. */
  function normalize(input) {
    var d = DEFAULT_SETTINGS();
    if (!input || typeof input !== 'object') return d;
    var out = clone(d);
    if (Array.isArray(input.providers) && input.providers.length) {
      out.providers = input.providers.map(function (p) {
        var model = String(p.model || '');
        return {
          id: String(p.id || uid('prov')),
          label: String(p.label || 'Provider'),
          kind: ['openai-compatible', 'anthropic', 'ollama', 'custom-openai'].indexOf(p.kind) >= 0 ? p.kind : 'openai-compatible',
          baseUrl: String(p.baseUrl || '').replace(/\/+$/, ''),
          apiKey: String(p.apiKey || ''),
          model: model,
          models: normalizeModelList(p.models, model),
          visionModel: p.visionModel ? String(p.visionModel) : undefined,
          imageModel: p.imageModel ? String(p.imageModel) : undefined,
          enabled: p.enabled !== false
        };
      });
    }
    if (input.activeProviderId) out.activeProviderId = String(input.activeProviderId);
    if (typeof input.activeModel === 'string') out.activeModel = input.activeModel;
    if (input.settings && typeof input.settings === 'object') {
      // Preserve unknown/future keys, then fill defaults for known ones.
      Object.keys(input.settings).forEach(function (k) {
        try { out.settings[k] = clone(input.settings[k]); } catch (e) { out.settings[k] = input.settings[k]; }
      });
      Object.keys(DEFAULT_UI_SETTINGS).forEach(function (k) {
        if (typeof out.settings[k] === 'undefined') out.settings[k] = clone(DEFAULT_UI_SETTINGS[k]);
      });
      if (out.settings.sidebarSide !== 'left' && out.settings.sidebarSide !== 'right') {
        out.settings.sidebarSide = 'right';
      }
      out.settings.translationLanguages = normalizeLangList(out.settings.translationLanguages);
      // Coerce a string maxTokens (older/options saves) to a number so the
      // background's numeric check never silently drops the user's value.
      // 0 / invalid => provider default (no cap sent).
      var mt = Number(out.settings.maxTokens);
      out.settings.maxTokens = (isFinite(mt) && mt > 0) ? Math.floor(mt) : 0;
    }
    if (Array.isArray(input.prompts)) out.prompts = input.prompts;
    if (Array.isArray(input.history)) out.history = input.history.slice(0, HISTORY_LIMIT);
    if (input._meta && typeof input._meta === 'object') {
      out._meta = {
        savedAt: Number(input._meta.savedAt) || 0,
        rev: Number(input._meta.rev) || 0
      };
    }
    if (!out.providers.some(function (p) { return p.id === out.activeProviderId; })) {
      out.activeProviderId = out.providers.length ? out.providers[0].id : '';
    }
    return out;
  }

  function savedAtOf(settings) {
    return settings && settings._meta ? (Number(settings._meta.savedAt) || 0) : 0;
  }

  /** Settings core for the size-capped storage.sync mirror (no history).
   *  The fetched model catalogue is shed ALWAYS: a ~600-model gateway list
   *  alone bursts the 8 KB/item sync quota, so the mirror keeps only each
   *  provider's identity + configured default model. The full catalogue
   *  lives in browser.storage.local and the localStorage backup. */
  function coreForSync(settings) {
    var core = clone(settings);
    delete core.history;
    core.providers = (core.providers || []).map(function (p) {
      var c = clone(p);
      c.models = c.model ? [c.model] : [];
      return c;
    });
    var text = JSON.stringify(core);
    if (byteLength(text) > SYNC_BUDGET_BYTES) {
      // Shed prompts first (they are also in the local/export copies).
      core.prompts = [];
      core._syncTruncated = true;
      text = JSON.stringify(core);
    }
    if (byteLength(text) > SYNC_BUDGET_BYTES) {
      // Last resort: keep provider identity/selection, drop key material
      // rather than failing the whole mirror silently.
      core.providers = (core.providers || []).map(function (p) {
        var c = clone(p); c.apiKey = ''; return c;
      });
      core._syncTruncated = true;
    }
    return core;
  }

  var cache = null;

  // Last load/save diagnostics, surfaced in the options page.
  var lastStatus = {
    primary: null,          // 'browser.storage.local' | 'localStorage' | 'memory'
    source: null,           // where the effective settings came from
    recoveredFrom: null,    // 'localStorage' | 'storage.sync' | null
    localOk: null, localVerified: null, localError: null,
    mirrorOk: null, mirrorError: null,
    syncOk: null, syncError: null, syncBytes: null,
    savedAt: 0, rev: 0,
    note: 'Temporary about:debugging installs are removed by Firefox at ' +
          'restart (with their storage). For durable settings install the ' +
          'XPI permanently with the stable id graphite-sider@local ' +
          '(Firefox Developer Edition / Nightly / ESR with ' +
          'xpinstall.signatures.required=false, or a signed build).'
  };

  function getStorageStatus() { return clone(lastStatus); }

  /** Collect every persisted copy, newest first. Never writes. */
  function collectPersisted() {
    var candidates = [];
    var jobs = [];

    var api = extApi();
    if (api && api.storage && api.storage.local) {
      jobs.push(areaGet('local', STORAGE_KEY).then(function (items) {
        var v = items && items[STORAGE_KEY];
        if (v && typeof v === 'object') {
          candidates.push({ settings: normalize(v), source: 'local', savedAt: savedAtOf(v) });
        }
        lastStatus.localOk = true;
      }).catch(function (e) {
        lastStatus.localOk = false;
        lastStatus.localError = e && e.message ? e.message : String(e);
      }));
      if (api.storage.sync) {
        jobs.push(areaGet('sync', SYNC_KEY).then(function (items) {
          var env = items && items[SYNC_KEY];
          var v = env && (env.settings || env);
          if (v && typeof v === 'object') {
            candidates.push({
              settings: normalize(v), source: 'sync',
              savedAt: Number(env.savedAt) || savedAtOf(v)
            });
          }
          lastStatus.syncOk = true;
        }).catch(function (e) {
          lastStatus.syncOk = false;
          lastStatus.syncError = e && e.message ? e.message : String(e);
        }));
      }
    }

    // localStorage backup mirror (bare settings or envelope).
    try {
      var parsed = parseStored(lsGet(STORAGE_KEY));
      var lv = parsed && (parsed.settings || parsed);
      if (lv && typeof lv === 'object' && (Array.isArray(lv.providers) || lv.settings)) {
        candidates.push({
          settings: normalize(lv), source: 'localStorage',
          savedAt: Number(parsed.savedAt) || savedAtOf(lv)
        });
      }
    } catch (e) { /* mirror unreadable */ }

    return Promise.all(jobs).then(function () {
      candidates.sort(function (a, b) { return b.savedAt - a.savedAt; });
      // storage.sync is size-shed (coreForSync) and refreshes by re-saving:
      // its envelope savedAt can look newest while carrying an older
      // settings core. Never let it outrank the durable local copy, or a
      // stale maxTokens (etc.) resurrects. The localStorage mirror keeps
      // its savedAt ordering (it is the recovery path when local is lost).
      var local = null;
      candidates.forEach(function (c) { if (c.source === 'local') local = c; });
      if (local && candidates[0] && candidates[0].source === 'sync') {
        candidates = candidates.filter(function (c) { return c.source !== 'sync'; })
          .concat(candidates.filter(function (c) { return c.source === 'sync'; }));
      }
      // A winning sync copy carries only each provider's configured default
      // (coreForSync sheds the fetched catalogue to fit the sync quota).
      // When a fuller catalogue exists in another copy, graft it back by
      // provider id — but only when both copies name the same default
      // model; a changed default means the catalogue is stale and must
      // wait for the next Fetch models.
      if (candidates.length > 1 && candidates[0].source === 'sync') {
        var winner = candidates[0].settings;
        candidates.slice(1).forEach(function (other) {
          (winner.providers || []).forEach(function (wp) {
            var op = (other.settings.providers || []).filter(function (x) { return x.id === wp.id; })[0];
            if (op && op.model === wp.model && (op.models || []).length > (wp.models || []).length) {
              wp.models = (op.models || []).slice();
            }
          });
        });
      }
      return candidates;
    });
  }

  /** Write primary + mirrors and verify the primary copy by reading it back. */
  function persistAll(merged) {
    var api = extApi();
    var hasLocal = !!(api && api.storage && api.storage.local);
    lastStatus.primary = hasLocal ? 'browser.storage.local'
      : (hasLocalStorage() ? 'localStorage' : 'memory');
    lastStatus.savedAt = savedAtOf(merged);
    lastStatus.rev = merged._meta ? merged._meta.rev : 0;

    // Backup mirror (full settings incl. history).
    try {
      var durable = lsSet(STORAGE_KEY, JSON.stringify(
        { savedAt: lastStatus.savedAt, settings: merged }));
      lastStatus.mirrorOk = durable;
      if (!durable && !hasLocal) {
        lastStatus.mirrorError = 'localStorage unavailable; kept in memory only';
      }
    } catch (e) {
      lastStatus.mirrorOk = false;
      lastStatus.mirrorError = e && e.message ? e.message : String(e);
    }

    var syncJob = Promise.resolve();
    if (api && api.storage && api.storage.sync && hasLocal) {
      var core = coreForSync(merged);
      var payload = {};
      payload[SYNC_KEY] = { savedAt: lastStatus.savedAt, settings: core };
      try { lastStatus.syncBytes = byteLength(JSON.stringify(payload)); } catch (e) { /* ignore */ }
      syncJob = areaSet('sync', payload).then(function () {
        lastStatus.syncOk = true; lastStatus.syncError = null;
      }).catch(function (e) {
        // Quota / sync unavailable: non-fatal, primary copy already safe.
        lastStatus.syncOk = false;
        lastStatus.syncError = e && e.message ? e.message : String(e);
      });
    } else {
      lastStatus.syncOk = null;
      lastStatus.syncError = api ? 'storage.sync unavailable in this context' : null;
    }

    if (!hasLocal) {
      return syncJob.then(function () {
        if (!lastStatus.mirrorOk && !hasLocalStorage()) {
          throw new Error('No durable storage available (browser.storage.local and localStorage both unavailable)');
        }
        lastStatus.localOk = null; lastStatus.localVerified = null;
        return merged;
      });
    }

    var payloadLocal = {};
    payloadLocal[STORAGE_KEY] = merged;
    return areaSet('local', payloadLocal).then(function () {
      lastStatus.localOk = true;
      // Read-back verification: repairs/report silent partial writes.
      return areaGet('local', STORAGE_KEY).then(function (items) {
        var back = items && items[STORAGE_KEY];
        var backRev = back && back._meta ? Number(back._meta.rev) : 0;
        if (!back || backRev !== lastStatus.rev ||
            JSON.stringify(normalize(back)) !== JSON.stringify(merged)) {
          throw new Error('read-back verification failed for browser.storage.local');
        }
        lastStatus.localVerified = true;
        return syncJob.then(function () { return merged; });
      });
    }).catch(function (e) {
      lastStatus.localOk = false;
      lastStatus.localVerified = false;
      lastStatus.localError = e && e.message ? e.message : String(e);
      if (!lastStatus.mirrorOk) throw e;
      // Mirror holds the data; surface a degraded-but-saved result and let
      // the next load heal the primary copy from the newer mirror.
      return syncJob.then(function () { return merged; });
    });
  }

  /** @returns {Promise<object>} normalized settings (cached after first load).
   *  Pass { fresh:true } to bypass the in-memory cache (used per chat request
   *  so a just-saved option is honoured by an already-running background). */
  function loadSettings(opts) {
    if (cache && !(opts && opts.fresh)) return Promise.resolve(clone(cache));
    return collectPersisted().then(function (candidates) {
      if (!candidates.length) {
        cache = DEFAULT_SETTINGS();
        lastStatus.source = 'defaults';
        lastStatus.recoveredFrom = null;
        return clone(cache);
      }
      var best = candidates[0];
      cache = best.settings;
      lastStatus.source = best.source;
      lastStatus.savedAt = best.savedAt;
      lastStatus.rev = cache._meta ? cache._meta.rev : 0;
      lastStatus.recoveredFrom = best.source === 'local' ? null : best.source;
      if (best.source !== 'local') {
        // Heal the primary copy from the surviving mirror (fire-and-forget;
        // load itself stays read-only if healing fails).
        persistAll(clone(cache)).catch(function () { /* reported in status */ });
      }
      return clone(cache);
    }).catch(function () {
      // Last resort only: a failed read must not be cached-and-then-saved
      // over good data, so defaults are returned WITHOUT touching mirrors.
      cache = DEFAULT_SETTINGS();
      lastStatus.source = 'defaults-after-error';
      return clone(cache);
    });
  }

  // Serialise saves so concurrent contexts in this page cannot interleave
  // their read-modify-write cycles.
  var saveQueue = Promise.resolve();

  function doSave(s, replace) {
    return collectPersisted().then(function (candidates) {
      var persisted = candidates.length ? candidates[0].settings : null;
      var base = replace ? {} : (persisted || cache || {});
      var mergedInput = replace ? (s || {}) : Object.assign({}, base, s || {});
      var merged = normalize(mergedInput);
      var prevRev = Math.max(
        persisted && persisted._meta ? Number(persisted._meta.rev) || 0 : 0,
        base && base._meta ? Number(base._meta.rev) || 0 : 0);
      merged._meta = { savedAt: Date.now(), rev: prevRev + 1 };
      cache = merged;
      return persistAll(merged);
    }).then(function (merged) { return clone(merged); });
  }

  /**
   * @param {object} s full or partial settings
   * @param {object} [opts] { replace:true } to replace instead of merge
   * @returns {Promise<object>} saved (verified) settings
   */
  function saveSettings(s, opts) {
    var replace = !!(opts && opts.replace);
    var job = saveQueue.then(function () { return doSave(s, replace); });
    // Keep the queue alive after a failed save.
    saveQueue = job.catch(function () { return null; });
    return job;
  }

  /** Export envelope: { app, exportedAt, [STORAGE_KEY]: fullSettings }. */
  function exportSettings(settings) {
    var build = function (s) {
      var env = { app: 'graphite-sider', exportedAt: new Date().toISOString() };
      env[STORAGE_KEY] = clone(s);
      return env;
    };
    if (settings && typeof settings === 'object') {
      return Promise.resolve(build(normalize(settings)));
    }
    return loadSettings().then(build);
  }

  /** Import an export envelope (or bare settings object), replacing current. */
  function importSettings(data) {
    var incoming = data && typeof data === 'object'
      ? (data[STORAGE_KEY] || data.settings || data) : null;
    if (!incoming || typeof incoming !== 'object') {
      return Promise.reject(new Error('invalid settings export: expected an object'));
    }
    return saveSettings(normalize(incoming), { replace: true });
  }

  /** @returns {Promise<object|null>} active provider merged with activeModel override. */
  function getActiveProvider() {
    return loadSettings().then(function (s) {
      var p = s.providers.filter(function (x) { return x.id === s.activeProviderId; })[0] || s.providers[0] || null;
      if (!p) return null;
      var copy = clone(p);
      if (s.activeModel) copy.model = s.activeModel;
      return copy;
    });
  }

  function getProviderById(id) {
    return loadSettings().then(function (s) {
      var p = s.providers.filter(function (x) { return x.id === id; })[0];
      return p ? clone(p) : null;
    });
  }

  /** Queue an action for the sidebar (context-menu flow; sidebar polls this key). */
  function setPendingAction(action) {
    var payload = {};
    payload[PENDING_KEY] = Object.assign({ at: Date.now() }, action || {});
    return rawSet(payload);
  }

  function takePendingAction() {
    return rawGet(PENDING_KEY).then(function (items) {
      var a = items[PENDING_KEY] || null;
      if (a) {
        var clear = {};
        clear[PENDING_KEY] = null;
        return rawSet(clear).then(function () { return a; });
      }
      return null;
    }).catch(function () { return null; });
  }

  function appendHistory(entry) {
    return loadSettings().then(function (s) {
      s.history = [Object.assign({ id: uid('hist'), at: Date.now() }, entry || {})]
        .concat(s.history || []).slice(0, HISTORY_LIMIT);
      return saveSettings(s).then(function () { return s.history; });
    });
  }

  function clearHistory() {
    return loadSettings().then(function (s) { s.history = []; return saveSettings(s); });
  }

  /* --- Chat jobs ----------------------------------------------------------
   * Persisted streaming-job results (background detach fix). When a port
   * drops mid-stream (Firefox Android freezes/kills the non-persistent
   * event page), the background no longer aborts the provider request;
   * the finished text is stored here so a reconnected client can attach
   * by requestId and recover it. Records: { requestId, videoId, purpose,
   * status: 'running'|'done'|'error', text, truncated, model, error,
   * updatedAt, expiresAt }. */
  var JOB_TTL_MS = 10 * 60 * 1000;

  function pruneJobMap(map, now) {
    var out = {};
    var n = now || Date.now();
    Object.keys(map || {}).forEach(function (k) {
      var j = map[k];
      if (j && j.requestId && typeof j.expiresAt === 'number' && j.expiresAt > n) out[k] = j;
    });
    return out;
  }

  function readJobs() {
    return rawGet(JOBS_KEY).then(function (items) {
      var map = items[JOBS_KEY];
      return (map && typeof map === 'object') ? map : {};
    }).catch(function () { return {}; });
  }

  function saveChatJob(job) {
    if (!job || !job.requestId) return Promise.resolve(null);
    return readJobs().then(function (map) {
      var record = Object.assign({}, map[job.requestId] || {}, job, {
        updatedAt: Date.now(),
        expiresAt: (typeof job.expiresAt === 'number' && job.expiresAt > Date.now())
          ? job.expiresAt : (Date.now() + JOB_TTL_MS)
      });
      map[job.requestId] = record;
      var payload = {};
      payload[JOBS_KEY] = pruneJobMap(map);
      return rawSet(payload).then(function () { return record; });
    }).catch(function () { return null; });
  }

  function getChatJob(requestId) {
    if (!requestId) return Promise.resolve(null);
    return readJobs().then(function (map) {
      var j = map[requestId] || null;
      return (j && j.expiresAt && j.expiresAt > Date.now()) ? j : null;
    });
  }

  function pruneChatJobs() {
    return readJobs().then(function (map) {
      var pruned = pruneJobMap(map);
      if (Object.keys(pruned).length === Object.keys(map).length) return pruned;
      var payload = {};
      payload[JOBS_KEY] = pruned;
      return rawSet(payload).then(function () { return pruned; });
    }).catch(function () { return {}; });
  }

  global.GraphiteStorage = {
    STORAGE_KEY: STORAGE_KEY,
    PENDING_KEY: PENDING_KEY,
    HISTORY_KEY: HISTORY_KEY,
    JOBS_KEY: JOBS_KEY,
    SYNC_KEY: SYNC_KEY,
    HISTORY_LIMIT: HISTORY_LIMIT,
    DEFAULT_PROVIDERS: DEFAULT_PROVIDERS,
    DEFAULT_UI_SETTINGS: DEFAULT_UI_SETTINGS,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    normalize: normalize,
    loadSettings: loadSettings,
    saveSettings: saveSettings,
    exportSettings: exportSettings,
    importSettings: importSettings,
    getStorageStatus: getStorageStatus,
    getActiveProvider: getActiveProvider,
    getProviderById: getProviderById,
    setPendingAction: setPendingAction,
    takePendingAction: takePendingAction,
    appendHistory: appendHistory,
    clearHistory: clearHistory,
    saveChatJob: saveChatJob,
    getChatJob: getChatJob,
    pruneChatJobs: pruneChatJobs,
    clearCache: function () { cache = null; },
    _rawGet: rawGet,
    _rawSet: rawSet,
    uid: uid
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
