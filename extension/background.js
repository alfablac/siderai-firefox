'use strict';
/**
 * Graphite Sider — Firefox background page (MV2, non-persistent).
 * Load order (manifest background.scripts): lib/storage.js, lib/providers.js,
 * lib/prompts.js, lib/youtube.js, lib/pdf.js, background.js.
 * API keys never leave this context except in requests to the provider baseUrl.
 */

/* --- browser.* promise API with a minimal chrome.* fallback ---------------- */
if (typeof browser === 'undefined' && typeof chrome !== 'undefined') {
  (function () {
    function wrap(obj, name) {
      return function () {
        var args = Array.prototype.slice.call(arguments);
        return new Promise(function (resolve, reject) {
          try {
            obj[name].apply(obj, args.concat(function (v) {
              if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
              else resolve(v);
            }));
          } catch (e) { reject(e); }
        });
      };
    }
    var b = {
      runtime: chrome.runtime,
      storage: { local: { get: wrap(chrome.storage.local, 'get'), set: wrap(chrome.storage.local, 'set') } },
      tabs: {
        query: wrap(chrome.tabs, 'query'),
        executeScript: wrap(chrome.tabs, 'executeScript'),
        sendMessage: wrap(chrome.tabs, 'sendMessage')
      },
      notifications: chrome.notifications ? { create: wrap(chrome.notifications, 'create') } : undefined
    };
    if (chrome.contextMenus) {
      b.contextMenus = chrome.contextMenus;
      b.contextMenus.create = chrome.contextMenus.create.bind(chrome.contextMenus);
      b.contextMenus.removeAll = wrap(chrome.contextMenus, 'removeAll');
    }
    if (chrome.browserAction) b.browserAction = chrome.browserAction;
    if (chrome.commands) b.commands = chrome.commands;
    // No sidebarAction under the chrome namespace in MV2 Firefox fallback.
    window.browser = b; // eslint-disable-line no-undef
  })();
}

var ext = (typeof browser !== 'undefined') ? browser : chrome;
var menusApi = ext.contextMenus || ext.menus || null;

/* --- Debug logging (off by default) ---------------------------------------
 * Enable: set settings.debugLog=true in storage, then reload the extension;
 * or flip GS_DEBUG below. Logs metadata only (message
 * type, provider label/host, model, durations, HTTP status, error names) —
 * never API keys, Authorization headers, prompts, message bodies, or
 * response/transcript text. */
var GS_DEBUG = false;
var gsDebugChecked = false;
function gsLog(scope, msg, data) {
  if (!gsDebugChecked) {
    gsDebugChecked = true;
    try {
      GraphiteStorage.loadSettings().then(function (s) {
        if (s && s.settings && (s.settings.debugLog === true || s.settings.debug === true)) GS_DEBUG = true;
      }).catch(function () {});
    } catch (e) { /* storage unavailable */ }
  }
  if (!GS_DEBUG) return;
  try { console.log('[Graphite:bg]' + (scope ? ' [' + scope + ']' : '') + ' ' + msg, data == null ? '' : data); } catch (e) {}
}
function gsHost(url) { try { return new URL(String(url || '')).host || ''; } catch (e) { return ''; } }

/** Feature registry: what this extension implements, and what it leaves out on purpose. */
var FEATURES = {
  ported: [
    'ai-chat-sidebar', 'byo-api-keys (OpenAI-compatible, Anthropic, OpenRouter, Groq, DeepSeek, Ollama, LM Studio)',
    'page-summarize', 'selection-actions (summarize/translate/explain/rewrite/grammar/ask)',
    'youtube-transcript-summary (timedtext API + ytInitialPlayerResponse)',
    'youtube-chapters', 'search-enhance (Google/Bing/DuckDuckGo content script)',
    'prompt-library', 'chat-with-pdf (best-effort text extraction)', 'image-ocr-via-vision-model',
    'image-generation (OpenAI-compatible)', 'audio-transcription (Whisper-compatible)',
    'context-menus', 'keyboard-commands', 'history (local only)'
  ],
  skipped: [
    { feature: 'Local-agent automation (desktop control)', reason: 'Out of scope for a sidebar; automating the desktop from an extension is unsafe.' },
    { feature: 'Cloud agent with a hosted backend', reason: 'Needs a server and an account; Graphite Sider is local and bring-your-own-key only.' },
    { feature: 'Account, billing, credits, history sync', reason: 'Providers bill the user directly; settings and history stay in local storage.' },
    { feature: 'Reusing logged-in ChatGPT/Claude/Gemini sessions', reason: 'Skipped for terms-of-service and privacy reasons; only official APIs with user-supplied keys are called.' },
    { feature: 'Hooking JSON.parse on streaming sites for subtitles', reason: 'Not needed; YouTube transcripts come from the timedtext API.' },
    { feature: 'Hosted completion, OCR and upload endpoints', reason: 'Server-side features; replaced by calls to the provider the user configured.' },
    { feature: 'Tab recording, video muxing, camera and microphone pages', reason: 'Media capture sits outside the reading and writing scope of the sidebar.' },
    { feature: 'Promotion and event telemetry', reason: 'No analytics in Graphite Sider.' }
  ]
};
globalThis.GraphiteFeatures = FEATURES;

var MENU = {
  ROOT: 'graphite-root',
  SUMMARIZE_SELECTION: 'graphite-summarize-selection',
  TRANSLATE_SELECTION: 'graphite-translate-selection',
  EXPLAIN_SELECTION: 'graphite-explain-selection',
  REWRITE_SELECTION: 'graphite-rewrite-selection',
  REWRITE_MENU_ROOT: 'graphite-rewrite-menu',
  GRAMMAR_SELECTION: 'graphite-grammar-selection',
  ASK_SELECTION: 'graphite-ask-selection',
  SUMMARIZE_PAGE: 'graphite-summarize-page',
  YOUTUBE_SUMMARY: 'graphite-youtube-summary',
  OCR_IMAGE: 'graphite-ocr-image'
};

var MENU_ACTIONS = {};
MENU_ACTIONS[MENU.SUMMARIZE_SELECTION] = { action: 'summarize-selection', promptId: 'summarize-selection' };
MENU_ACTIONS[MENU.TRANSLATE_SELECTION] = { action: 'translate-selection', promptId: 'translate' };
MENU_ACTIONS[MENU.EXPLAIN_SELECTION] = { action: 'explain-selection', promptId: 'explain' };
MENU_ACTIONS[MENU.REWRITE_SELECTION] = { action: 'rewrite-selection', promptId: 'rewrite-formal' };
/* One context-menu child per rewrite tone (lib/prompts.js REWRITE_TONES):
   id graphite-rewrite-tone-<toneId> -> promptId rewrite-<toneId>, which the
   sidebar resolves via rewriteToneIdFromActionId. */
var REWRITE_TONE_MENU = (typeof GraphitePrompts !== 'undefined' && GraphitePrompts && Array.isArray(GraphitePrompts.REWRITE_TONES))
  ? GraphitePrompts.REWRITE_TONES : [];
REWRITE_TONE_MENU.forEach(function (tone) {
  MENU_ACTIONS['graphite-rewrite-tone-' + tone.id] = {
    action: 'rewrite-selection', promptId: 'rewrite-' + tone.id, tone: tone.id
  };
});
MENU_ACTIONS[MENU.GRAMMAR_SELECTION] = { action: 'grammar-selection', promptId: 'grammar-fix' };
MENU_ACTIONS[MENU.ASK_SELECTION] = { action: 'ask-selection', promptId: null };
MENU_ACTIONS[MENU.SUMMARIZE_PAGE] = { action: 'summarize-page', promptId: 'summarize-page' };
MENU_ACTIONS[MENU.YOUTUBE_SUMMARY] = { action: 'youtube-summary', promptId: 'youtube-summary' };
MENU_ACTIONS[MENU.OCR_IMAGE] = { action: 'ocr-image', promptId: 'ocr-extract' };

function createMenus() {
  if (!menusApi || !menusApi.create) return;
  var done = function () {
    var sel = ['selection'];
    menusApi.create({ id: MENU.ROOT, title: 'Graphite Sider', contexts: ['selection', 'page', 'image', 'link'] });
    menusApi.create({ id: MENU.SUMMARIZE_SELECTION, parentId: MENU.ROOT, title: 'Summarize selection', contexts: sel });
    menusApi.create({ id: MENU.TRANSLATE_SELECTION, parentId: MENU.ROOT, title: 'Translate selection', contexts: sel });
    menusApi.create({ id: MENU.EXPLAIN_SELECTION, parentId: MENU.ROOT, title: 'Explain selection', contexts: sel });
    menusApi.create({ id: MENU.REWRITE_SELECTION, parentId: MENU.ROOT, title: 'Rewrite selection (formal)', contexts: sel });
    menusApi.create({ id: MENU.REWRITE_MENU_ROOT, parentId: MENU.ROOT, title: 'Rewrite selection as…', contexts: sel });
    REWRITE_TONE_MENU.forEach(function (tone) {
      menusApi.create({
        id: 'graphite-rewrite-tone-' + tone.id, parentId: MENU.REWRITE_MENU_ROOT,
        title: 'Rewrite: ' + (tone.label || tone.name || tone.id), contexts: sel
      });
    });
    menusApi.create({ id: MENU.GRAMMAR_SELECTION, parentId: MENU.ROOT, title: 'Fix grammar', contexts: sel });
    menusApi.create({ id: MENU.ASK_SELECTION, parentId: MENU.ROOT, title: 'Ask about selection…', contexts: sel });
    menusApi.create({ id: MENU.SUMMARIZE_PAGE, parentId: MENU.ROOT, title: 'Summarize this page', contexts: ['page'] });
    menusApi.create({
      id: MENU.YOUTUBE_SUMMARY, parentId: MENU.ROOT, title: 'Summarize this YouTube video',
      contexts: ['page', 'video'], documentUrlPatterns: ['*://*.youtube.com/*']
    });
    menusApi.create({ id: MENU.OCR_IMAGE, parentId: MENU.ROOT, title: 'Extract text from image (vision)', contexts: ['image'] });
    if (ext.runtime && ext.runtime.lastError) { /* duplicate ids on restart — ignore */ }
  };
  if (menusApi.removeAll) {
    var p = null;
    try { p = menusApi.removeAll(); } catch (e) { p = null; }
    if (p && typeof p.then === 'function') p.then(done, done);
    else done();
  } else done();
}

/* Chat surface: the real sidebar on desktop, a full tab on platforms
 * without one (Firefox for Android has no sidebarAction). Feature-detect,
 * never UA-sniff: absence or failure of sidebarAction falls through to a
 * tab showing the same sidebar/sidebar.html (already web-accessible). */
var CHAT_TAB_URL_PATH = 'sidebar/sidebar.html';

function chatTabUrl() {
  try { return ext.runtime.getURL(CHAT_TAB_URL_PATH); } catch (e) { return CHAT_TAB_URL_PATH; }
}

async function openChatTab() {
  if (!ext.tabs || typeof ext.tabs.create !== 'function') return false;
  var url = chatTabUrl();
  try {
    if (typeof ext.tabs.query === 'function') {
      var tabs = await ext.tabs.query({ url: url + '*' });
      var existing = (tabs || []).filter(function (t) { return t && t.url && t.url.indexOf(url) === 0; })[0];
      if (existing) {
        if (typeof ext.tabs.update === 'function') await ext.tabs.update(existing.id, { active: true });
        return true;
      }
    }
    await ext.tabs.create({ url: url, active: true });
    return true;
  } catch (e) { return false; }
}

/* @returns {Promise<{opened:boolean, mode:'sidebar'|'tab'|null}>} */
async function openSidebar() {
  if (ext.sidebarAction) {
    try {
      if (typeof ext.sidebarAction.open === 'function') { await ext.sidebarAction.open(); return { opened: true, mode: 'sidebar' }; }
    } catch (e) { /* fall through to the tab fallback (Android has no sidebar) */ }
  }
  return openChatTab().then(function (ok) { return { opened: !!ok, mode: ok ? 'tab' : null }; });
}

async function toggleSidebar() {
  if (ext.sidebarAction) {
    try {
      if (typeof ext.sidebarAction.toggle === 'function') { await ext.sidebarAction.toggle(); return { opened: true, mode: 'sidebar' }; }
      if (typeof ext.sidebarAction.open === 'function') { await ext.sidebarAction.open(); return { opened: true, mode: 'sidebar' }; }
    } catch (e) { /* fall through to the tab fallback */ }
  }
  return openChatTab().then(function (ok) { return { opened: !!ok, mode: ok ? 'tab' : null }; });
}

/** Stage an action for the sidebar, open it, and notify it if already listening.
 *  @returns {Promise<{opened:boolean, mode:string|null}>} so callers can
 *  report honestly (the options page used to claim success on failure). */
async function dispatchToSidebar(pending) {
  try { await GraphiteStorage.setPendingAction(pending); } catch (e) { /* storage unavailable */ }
  var opened = await openSidebar();
  try {
    await ext.runtime.sendMessage({ type: 'pendingAction', action: pending });
  } catch (e) { /* Sidebar/chat tab not open yet — it polls the pendingAction storage key on load. */ }
  return opened;
}

if (menusApi && menusApi.onClicked) {
  menusApi.onClicked.addListener(function (info, tab) {
    var def = MENU_ACTIONS[info.menuItemId];
    if (!def) return;
    var pending = {
      action: def.action,
      promptId: def.promptId,
      tone: def.tone || '',
      text: info.selectionText || '',
      selection: info.selectionText || '',
      srcUrl: info.srcUrl || '',
      linkUrl: info.linkUrl || '',
      url: (tab && tab.url) || info.pageUrl || '',
      title: (tab && tab.title) || '',
      tabId: tab && tab.id
    };
    dispatchToSidebar(pending);
  });
}

if (ext.runtime && ext.runtime.onInstalled) {
  ext.runtime.onInstalled.addListener(function () { createMenus(); });
}
if (ext.runtime && ext.runtime.onStartup) {
  ext.runtime.onStartup.addListener(function () { createMenus(); });
}
createMenus();

if (ext.browserAction && ext.browserAction.onClicked) {
  ext.browserAction.onClicked.addListener(function () {
    toggleSidebar().then(function (r) {
      gsLog('ui', 'browserAction toggle', { opened: r.opened, mode: r.mode });
    });
  });
}
// MV3-style action alias (harmless in Firefox MV2).
if (ext.action && ext.action.onClicked && !ext.browserAction) {
  ext.action.onClicked.addListener(function () { toggleSidebar(); });
}

if (ext.commands && ext.commands.onCommand) {
  ext.commands.onCommand.addListener(async function (command) {
    if (command === '_execute_sidebar_action') { await toggleSidebar(); return; }
    var tabs = await queryActiveTab();
    var tab = tabs && tabs[0];
    if (command === 'summarize-page') {
      await dispatchToSidebar({
        action: 'summarize-page', promptId: 'summarize-page',
        url: tab && tab.url || '', title: tab && tab.title || '', tabId: tab && tab.id
      });
    } else if (command === 'quick-translate') {
      var selection = '';
      if (tab && tab.id != null) {
        try {
          var sel = await executeInTab(tab.id, 'window.getSelection ? String(window.getSelection()) : ""');
          selection = (sel && sel[0]) || '';
        } catch (e) { /* restricted page */ }
      }
      await dispatchToSidebar({
        action: 'translate-selection', promptId: 'translate',
        text: selection, selection: selection,
        url: tab && tab.url || '', title: tab && tab.title || '', tabId: tab && tab.id
      });
    }
  });
}

function queryActiveTab() {
  try { return ext.tabs.query({ active: true, currentWindow: true }); }
  catch (e) { return Promise.resolve([]); }
}

function executeInTab(tabId, code) {
  // MV2: tabs.executeScript(tabId, {code}) — resolves to an array of per-frame results.
  return ext.tabs.executeScript(tabId, { code: code });
}

/** Resolve a provider from storage so API keys stay in the background context.
 *  With { forImage: true } the chat-model override (msg.model / provider.model /
 *  settings.activeModel) is NOT applied: image generation is decoupled from the
 *  text model, so the returned copy keeps the provider's chat `model` untouched
 *  and lets generateImage resolve the image model from copy.imageModel (or an
 *  explicit override passed via msg.imageModel / msg.provider.imageModel). */
async function resolveProvider(msg, opts) {
  var settings = await GraphiteStorage.loadSettings();
  var wantedId = (msg && (msg.providerId || (msg.provider && msg.provider.id))) ||
    settings.activeProviderId;
  var found = settings.providers.filter(function (p) { return p.id === wantedId; })[0] ||
    settings.providers.filter(function (p) { return p.id === settings.activeProviderId; })[0] ||
    settings.providers[0];
  if (!found && msg && msg.provider && msg.provider.baseUrl) return msg.provider;
  if (!found) throw new Error('No provider configured. Open Graphite Sider options and add one.');
  var copy = JSON.parse(JSON.stringify(found));
  if (opts && opts.forImage) {
    // Image path: only an explicit image-model override wins; the text model
    // (msg.model / settings.activeModel) must never leak into image calls.
    if (msg && msg.provider && msg.provider.imageModel) copy.imageModel = msg.provider.imageModel;
    if (msg && msg.imageModel) copy.imageModel = msg.imageModel;
    return copy;
  }
  var modelOverride = (msg && (msg.model || (msg.provider && msg.provider.model))) || settings.activeModel;
  if (modelOverride) copy.model = modelOverride;
  return copy;
}

/* Output-token budget — one rule for every chat flow (sidebar, YouTube
 * summaries/chapters/translations, page/search prompts):
 *   1. an explicit positive numeric msg.maxTokens wins;
 *   2. else the stored settings.maxTokens wins, exactly as saved;
 *   3. 0 / missing / non-numeric => undefined => providers send NO
 *      max_tokens and the provider/model default applies.
 * There is deliberately no per-purpose special case and no hidden
 * ceiling/floor: the 1.0.11 summary-only rule (ignore stored values at or
 * below the old 2048 default) meant a user's setting had invisible
 * exceptions, and a gateway default (e.g. 8192) silently replaced the
 * omitted parameter. What the user sets is what goes on the wire. */
function resolveMaxTokens(msg, settings) {
  if (msg && typeof msg.maxTokens === 'number' && msg.maxTokens > 0) return Math.floor(msg.maxTokens);
  var stored = settings && settings.settings ? Number(settings.settings.maxTokens) : NaN;
  if (isFinite(stored) && stored > 0) return Math.floor(stored);
  return undefined; // providers omit max_tokens -> provider/model default applies
}

async function chatRequest(msg, onChunk, signal, onActivity) {
  var started = Date.now();
  var provider = await resolveProvider(msg || {});
  gsLog('chat', 'start', { provider: provider.label || provider.kind || '', host: gsHost(provider.baseUrl), model: (msg && msg.model) || provider.model || '', stream: !!(msg && msg.stream) || !!onChunk });
  // Fresh read per request: the non-persistent background caches settings
  // in memory, so an option saved seconds ago must not be masked by a
  // stale cache (that is how a 32000 setting could be ignored).
  var settings = await GraphiteStorage.loadSettings({ fresh: true });
  var messages = (msg && msg.messages) || [];
  if (settings.settings && settings.settings.systemPrompt &&
      !messages.some(function (m) { return m.role === 'system'; })) {
    messages = [{ role: 'system', content: settings.settings.systemPrompt }].concat(messages);
  }
  var resolvedMaxTokens = resolveMaxTokens(msg, settings);
  // Metadata only (no prompt/body): makes the effective budget greppable in
  // the background console when GS_DEBUG / settings.debugLog is on.
  gsLog('chat', 'maxTokens', {
    purpose: (msg && msg.purpose) || '',
    explicit: (msg && typeof msg.maxTokens === 'number') ? msg.maxTokens : null,
    stored: settings.settings ? settings.settings.maxTokens : null,
    resolved: resolvedMaxTokens == null ? 'provider-default' : resolvedMaxTokens,
    sentMaxTokens: resolvedMaxTokens == null ? 'omitted' : resolvedMaxTokens
  });
  try {
    var result = await GraphiteProviders.chat({
      provider: provider,
      model: (msg && msg.model) || provider.model,
      messages: messages,
      stream: !!(msg && msg.stream) || !!onChunk,
      onChunk: onChunk,
      onActivity: onActivity,
      signal: signal,
      temperature: msg && typeof msg.temperature === 'number' ? msg.temperature
        : (settings.settings ? settings.settings.temperature : undefined),
      maxTokens: resolvedMaxTokens
    });
    gsLog('chat', 'done', { durationMs: Date.now() - started, ok: true, model: result && result.model || '' });
    return result;
  } catch (e) {
    gsLog('chat', 'error', { durationMs: Date.now() - started, name: (e && e.name) || '', status: (e && e.status) || null });
    throw e;
  }
}

/** Extract readable page content from a tab (MV2 executeScript, no content-script dependency). */
async function fetchPageContent(msg) {
  var tabId = msg && msg.tabId;
  if (tabId == null) {
    var tabs = await queryActiveTab();
    tabId = tabs && tabs[0] && tabs[0].id;
  }
  if (tabId == null) throw new Error('fetchPageContent: no active tab');
  var code = '(function(){' +
    'function clean(el){var c=el.cloneNode(true);' +
    'c.querySelectorAll("script,style,noscript,nav,header,footer,aside,form,iframe,svg").forEach(function(n){n.remove();});return c;}' +
    'var main=document.querySelector("main,article,[role=main]")||document.body;' +
    'var text="";try{text=clean(main).innerText||"";}catch(e){text=document.body?document.body.innerText:"";}' +
    'return {title:document.title,url:location.href,' +
    'selection:window.getSelection?String(window.getSelection()):"",' +
    'text:text.replace(/\\n{3,}/g,"\\n\\n").slice(0,60000)};})();';
  var results = await executeInTab(tabId, code);
  var page = results && results[0];
  if (!page) throw new Error('fetchPageContent: empty result (page may be restricted, e.g. about: or an extension page)');
  return page;
}

function errorMessage(e) { return (e && e.message) ? e.message : String(e); }

/* --- Streaming chat over a long-lived port ----------------------------------
 * Sidebar connects with browser.runtime.connect({ name: 'graphite-chat' })
 * ('chat-stream' also accepted) and posts { type: 'chatStream', requestId, ... }
 * (legacy { type: 'chat', ... } on the port works too).
 * Background replies: {type:'chunk',requestId,chunk,full}
 *                     {type:'ping', requestId, stage, elapsedMs, lastActivityMs}
 *                     {type:'snapshot', requestId, text, full} (attach replay)
 *                     {type:'done', requestId,text,model,usage,ttftMs,totalMs}
 *                     {type:'error',requestId,error}
 * Send {type:'abort', requestId} to cancel. A port DISCONNECT only detaches:
 * the job keeps running and its result is persisted (GraphiteStorage jobs),
 * so a client that dropped (Firefox Android freezes/kills this event page
 * and mobile tabs) can reconnect and post {type:'attach', requestId} to
 * receive a snapshot of the text so far, then live chunks, then the
 * terminal done/error. The provider request is dispatched exactly once,
 * on 'start'; 'attach' never re-sends it. Clients may post {type:'ping'}
 * (optionally with requestId) to prove liveness and get a ping back.
 *
 * Heartbeat: slow gateways (e.g. 9Router fronting a reasoning model) can
 * take a while to produce the first visible token on a large YouTube
 * transcript. The background therefore posts {type:'ping'} every
 * CHAT_HEARTBEAT_INTERVAL_MS to every attached port: an immediate
 * 'accepted' ping once the request is taken, a 'waiting' ping while the
 * provider has sent nothing recently, and a 'streaming' ping only while
 * provider bytes (SSE keepalives, reasoning deltas — anything) flowed
 * recently (lastActivityMs within CHAT_STREAMING_FRESH_MS). Pings prove
 * the background is alive so clients never mistake a slow model for a
 * lost connection. Separately, this handler is the authoritative
 * inactivity timeout: after CHAT_PROVIDER_IDLE_TIMEOUT_MS with NO
 * provider activity at all it aborts and reports a stalled provider.
 * While bytes keep flowing a request may run indefinitely — this is an
 * idle ceiling, not a total timeout. */
var CHAT_HEARTBEAT_INTERVAL_MS = 15000;
var CHAT_PROVIDER_IDLE_TIMEOUT_MS = 120000;
var CHAT_STREAMING_FRESH_MS = 15000;
var JOB_RESULT_TTL_MS = 10 * 60 * 1000;
var JOB_PERSIST_GAP_MS = 1500;

/* Module-scope job registry keyed by requestId. Jobs survive individual
 * port disconnects (detach-don't-abort); the completed result is also
 * persisted via GraphiteStorage.saveChatJob so it survives even an event
 * page restart. */
var chatJobs = {};

function jobPost(job, message) {
  Array.prototype.slice.call(job.ports).forEach(function (p) {
    try { p.postMessage(message); } catch (e) {}
  });
}
function jobPostPing(job, stage) {
  jobPost(job, {
    type: 'ping', requestId: job.requestId, stage: stage,
    // ping carries: elapsedMs: Date.now() - startedAt (job.startedAt) and lastActivityMs
    elapsedMs: Date.now() - job.startedAt,
    lastActivityMs: job.providerActivityAt ? (Date.now() - job.providerActivityAt) : null
  });
}
function jobPersist(job, status, force) {
  if (!job.requestId) return;
  if (!force && job.persistedAt && (Date.now() - job.persistedAt) < JOB_PERSIST_GAP_MS) return;
  job.persistedAt = Date.now();
  try {
    GraphiteStorage.saveChatJob({
      requestId: job.requestId, videoId: job.videoId || '', purpose: job.purpose || '',
      status: status || job.status, text: job.full || '', truncated: !!job.truncated,
      model: job.model || '', error: job.error || ''
    }).catch(function () {});
  } catch (e) { /* storage unavailable: in-memory job still serves attaches */ }
}
function jobDoneMessage(job) {
  // Single done-shape: model: job.model, finishReason: job.finishReason,
  // truncated: job.truncated, ttftMs: job.firstChunkAt ? (job.firstChunkAt - job.startedAt) : null,
  // totalMs: Date.now() - job.startedAt
  return {
    type: 'done', requestId: job.requestId, text: job.full, chunk: job.full, full: job.full,
    model: job.model, usage: job.usage, finishReason: result_finishReason(job), truncated: job.truncated,
    ttftMs: job.firstChunkAt ? (job.firstChunkAt - job.startedAt) : null,
    totalMs: Date.now() - job.startedAt
  };
}
function result_finishReason(job) {
  // finishReason: result.finishReason (from the chatRequest result, kept on the job)
  return job.finishReason;
}
function jobCleanup(requestId) {
  var job = chatJobs[requestId];
  if (!job) return;
  if (job.timer) clearInterval(job.timer);
  delete chatJobs[requestId];
}
function jobFinish(job, err, result) {
  if (job.status === 'done' || job.status === 'error') return;
  job.status = err ? 'error' : 'done';
  var firstChunkAt = 0; firstChunkAt = job.firstChunkAt;
  var startedAt = job.startedAt;
  if (err) job.error = errorMessage(err);
  if (result) {
    job.full = result.text || job.full;
    job.model = result.model || '';
    job.truncated = !!result.truncated;
    job.usage = result.usage || null;
    job.finishReason = result.finishReason || null;
  }
  jobPersist(job, job.status, true);
  if (err) jobPost(job, { type: 'error', requestId: job.requestId, error: job.error, message: job.error });
  else {
    jobPost(job, {
      type: 'done', requestId: job.requestId, text: job.full, chunk: job.full, full: job.full,
      model: job.model, usage: job.usage, finishReason: job.finishReason, truncated: job.truncated,
      ttftMs: firstChunkAt ? (firstChunkAt - startedAt) : null,
      totalMs: Date.now() - startedAt
    });
  }
  if (job.timer) { clearInterval(job.timer); job.timer = 0; }
  // Keep the record briefly for late attaches, then drop it.
  // (stopHeartbeat equivalent: the heartbeat interval is cleared above and
  // the job leaves the registry when registerCleanupTimer fires.)
  // var stalled = false (now job.stalled); `if (stalled) return` guards the
  // request continuations in startChatJob the same way it did per-port.
  var registerCleanupTimer = setTimeout(function () { jobCleanup(job.requestId); }, JOB_RESULT_TTL_MS);
  if (registerCleanupTimer && typeof registerCleanupTimer.unref === 'function') registerCleanupTimer.unref();
}

function startChatJob(port, msg) {
  var requestId = msg.requestId || ('req-' + Date.now());
  var existing = chatJobs[requestId];
  if (existing && existing.status === 'running') {
    // Exactly-once dispatch: a second 'start' for the same requestId
    // attaches to the running job instead of re-POSTing to the provider.
    existing.ports.add(port);
    jobPostPing(existing, 'accepted');
    if (existing.full) jobPost(existing, { type: 'snapshot', requestId: requestId, text: existing.full, full: existing.full });
    return existing;
  }
  var controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
  var job = {
    requestId: requestId, ports: new Set([port]), controller: controller,
    startedAt: Date.now(), providerActivityAt: 0, firstChunkAt: 0,
    full: '', model: '', truncated: false, usage: null, finishReason: null,
    status: 'running', stalled: false, timer: 0, persistedAt: 0,
    videoId: msg.videoId || '', purpose: msg.purpose || '', error: ''
  };
  chatJobs[requestId] = job;
  jobPersist(job, 'running', true);
  // Proof of acceptance: the client learns the background is alive and
  // owns this request long before the provider answers.
  jobPostPing(job, 'accepted'); // postPing('accepted')
  // Idle basis (pinned semantics): Date.now() - (providerActivityAt || startedAt)
  job.timer = setInterval(function () {
    var idleMs = Date.now() - (job.providerActivityAt || job.startedAt);
    if (idleMs > CHAT_PROVIDER_IDLE_TIMEOUT_MS) {
      // Authoritative inactivity timeout: no provider byte for 120s.
      job.stalled = true;
      try { jobFinish(job, new Error('Provider stalled: no activity for 120s')); } catch (e) {}
      if (controller) { try { controller.abort(); } catch (e) {} }
      return;
    }
    // Honest stage: 'streaming' only when activity is recent.
    jobPostPing(job, job.providerActivityAt && (Date.now() - job.providerActivityAt) <= CHAT_STREAMING_FRESH_MS ? 'streaming' : 'waiting');
  }, CHAT_HEARTBEAT_INTERVAL_MS);
  if (job.timer && typeof job.timer.unref === 'function') job.timer.unref();
  chatRequest(msg, function (chunk, full) {
    job.providerActivityAt = Date.now();
    if (!job.firstChunkAt) job.firstChunkAt = Date.now();
    var firstChunkAt = job.firstChunkAt; /* first VISIBLE chunk only */
    if (typeof full === 'string') job.full = full;
    else if (chunk) job.full += chunk;
    jobPersist(job, 'running', false);
    jobPost(job, { type: 'chunk', requestId: requestId, chunk: chunk, text: chunk, full: job.full });
  }, controller ? controller.signal : undefined, function () {
    job.providerActivityAt = Date.now(); /* activity only: TTFT anchor untouched */
  }).then(function (result) {
    var stalled = false; stalled = job.stalled;
    if (stalled) return; // stall error already posted by the heartbeat
    // done-fields from the result: model: result.model, usage: result.usage,
    // finishReason: result.finishReason, truncated: !!result.truncated
    jobFinish(job, null, result);
  }).catch(function (e) {
    var stalled = false; stalled = job.stalled;
    if (stalled) return; // heartbeat already posted the stall error
    jobFinish(job, e);
  });
  return job;
}

function attachChatJob(port, msg) {
  var requestId = msg.requestId;
  if (!requestId) return;
  var job = chatJobs[requestId];
  if (job) {
    job.ports.add(port);
    jobPostPing(job, 'accepted');
    if (job.full) jobPost(job, { type: 'snapshot', requestId: requestId, text: job.full, full: job.full });
    if (job.status === 'done') {
      jobPost(job, {
        type: 'done', requestId: requestId, text: job.full, chunk: job.full, full: job.full,
        model: job.model, usage: job.usage, finishReason: job.finishReason, truncated: job.truncated,
        ttftMs: job.firstChunkAt ? (job.firstChunkAt - job.startedAt) : null,
        totalMs: Date.now() - job.startedAt
      });
    } else if (job.status === 'error') {
      jobPost(job, { type: 'error', requestId: requestId, error: job.error || 'Request failed', message: job.error || 'Request failed' });
    }
    return;
  }
  // Event page restarted between disconnect and reattach: replay the
  // persisted terminal result; a job still marked 'running' but with no
  // live owner died with the old page and is reported honestly.
  try {
    GraphiteStorage.getChatJob(requestId).then(function (rec) {
      if (!rec) {
        try { port.postMessage({ type: 'error', requestId: requestId, error: 'Request not found (it may have expired). Try again.', message: 'Request not found (it may have expired). Try again.' }); } catch (e) {}
        return;
      }
      try { port.postMessage({ type: 'ping', requestId: requestId, stage: 'accepted', elapsedMs: null, lastActivityMs: null }); } catch (e) {}
      if (rec.text) { try { port.postMessage({ type: 'snapshot', requestId: requestId, text: rec.text, full: rec.text }); } catch (e) {} }
      if (rec.status === 'done') {
        try { port.postMessage({ type: 'done', requestId: requestId, text: rec.text || '', chunk: rec.text || '', full: rec.text || '', model: rec.model || '', truncated: !!rec.truncated }); } catch (e) {}
      } else {
        try { port.postMessage({ type: 'error', requestId: requestId, error: 'interrupted', message: (rec.error || 'Request interrupted before it finished. Try again.') }); } catch (e) {}
      }
    }).catch(function () {});
  } catch (e) { /* storage unavailable */ }
}

if (ext.runtime && ext.runtime.onConnect) {
  ext.runtime.onConnect.addListener(function (port) {
    if (port.name !== 'graphite-chat' && port.name !== 'chat-stream') return;
    port.onMessage.addListener(function (msg) {
      if (!msg) return;
      if (msg.type === 'abort' && msg.requestId) {
        var aborted = chatJobs[msg.requestId];
        if (aborted) {
          aborted.status = 'error';
          aborted.error = 'Aborted';
          if (aborted.controller) { try { aborted.controller.abort(); } catch (e) {} }
          jobPersist(aborted, 'error', true);
          jobCleanup(msg.requestId);
        }
        return;
      }
      if (msg.type === 'ping') {
        var pinged = msg.requestId ? chatJobs[msg.requestId] : null;
        if (pinged) { pinged.ports.add(port); jobPostPing(pinged, 'accepted'); }
        else { try { port.postMessage({ type: 'ping', requestId: msg.requestId || null, stage: 'accepted', elapsedMs: null, lastActivityMs: null }); } catch (e) {} }
        return;
      }
      if (msg.type === 'attach') { attachChatJob(port, msg); return; }
      if (msg.type !== 'chatStream' && msg.type !== 'chat' && msg.type !== 'chatSync' && msg.type !== 'start') return;
      startChatJob(port, msg);
    });
    port.onDisconnect.addListener(function () {
      // Detach-don't-abort: the browser (Firefox Android) dropping this
      // port must not kill the provider request. Only an explicit abort,
      // the 120s idle stall, or job expiry stops it.
      Object.keys(chatJobs).forEach(function (k) { chatJobs[k].ports.delete(port); });
    });
  });
}

/* Startup sweep: jobs persisted as 'running' by a previous (now dead)
 * event page can never finish — mark them interrupted so attaches report
 * the truth, and prune expired records. */
try {
  GraphiteStorage.pruneChatJobs().then(function (map) {
    var stale = Object.keys(map || {}).filter(function (k) { return map[k] && map[k].status === 'running'; });
    stale.forEach(function (k) {
      GraphiteStorage.saveChatJob({ requestId: k, status: 'error', error: 'Request interrupted before it finished. Try again.' }).catch(function () {});
    });
  }).catch(function () {});
} catch (e) { /* storage unavailable */ }

/* --- One-shot message router -------------------------------------------------
 * Sidebar / content scripts send runtime messages; return value is sent back
 * as { ok:true, result } or { ok:false, error }. */
function handleMessage(msg) {
  gsLog('msg', String(msg.type), { provider: (msg.provider && (msg.provider.label || msg.provider.kind)) || msg.providerId || '', model: msg.model || '' });
  switch (msg.type) {
    case 'chat':
    case 'chatSync': {
      // Non-streaming convenience: streaming clients should use the port.
      return chatRequest(Object.assign({}, msg, { stream: false }), null, undefined);
    }
    case 'testProvider':
      return resolveProvider(msg).then(function (p) { return GraphiteProviders.testProvider(p); });
    case 'listModels':
      return resolveProvider(msg).then(function (p) { return GraphiteProviders.listModels(p); });
    case 'fetchTranscript':
      return GraphiteYouTube.fetchTranscript(msg.url || msg.videoId || '', {
        playerResponse: msg.playerResponse || null,
        lang: msg.lang || undefined
      });
    case 'buildYouTubePrompt': {
      // Content scripts have no lib/prompts.js / lib/youtube.js; render the
      // effective prompt here so every entry point sends the same one.
      // Loads settings so a user prompt with id 'youtube-summary' overrides
      // the builtin exactly like GraphitePrompts.listPrompts would.
      var promptText = String(msg.transcript || msg.text || '');
      var promptTitle = String(msg.title || '');
      return GraphiteStorage.loadSettings().catch(function () { return null; }).then(function (settings) {
        if (typeof GraphiteYouTube !== 'undefined' && GraphiteYouTube && typeof GraphiteYouTube.buildYouTubeSummaryPrompt === 'function') {
          return GraphiteYouTube.buildYouTubeSummaryPrompt(promptText, promptTitle, settings);
        }
        if (typeof GraphitePrompts !== 'undefined' && GraphitePrompts) {
          var promptId = msg.promptId || 'youtube-summary';
          var eff = typeof GraphitePrompts.getEffectivePrompt === 'function'
            ? GraphitePrompts.getEffectivePrompt(promptId, settings)
            : (typeof GraphitePrompts.getBuiltin === 'function' ? GraphitePrompts.getBuiltin(promptId) : null);
          if (eff && eff.body) return GraphitePrompts.renderPrompt(eff.body, { title: promptTitle, transcript: promptText, url: msg.url || '' });
        }
        return 'TRANSCRIPT TO SUMMARIZE:\nTitle: ' + promptTitle + '\n\n' + promptText;
      });
    }
    case 'getActiveTab':
      return queryActiveTab().then(function (tabs) { return (tabs && tabs[0]) || null; });
    case 'fetchPageContent':
    case 'extractPage': // sidebar alias
      return fetchPageContent(msg);
    case 'extractPdfText': {
      if (!msg.dataUrl) return Promise.reject(new Error('extractPdfText: dataUrl is required'));
      return fetch(msg.dataUrl).then(function (r) { return r.arrayBuffer(); })
        .then(function (buf) { return GraphitePDF.extractTextFromPDF(buf); });
    }
    case 'openSidebarWith':
      return dispatchToSidebar({
        action: msg.action || 'chat', promptId: msg.promptId || null,
        tone: msg.tone || '',
        text: msg.text || '', selection: msg.text || '',
        url: msg.url || '', title: msg.title || '', tabId: msg.tabId
      }).then(function (r) { return { opened: !!r.opened, mode: r.mode || null }; });
    case 'clearHistory':
      return GraphiteStorage.clearHistory().then(function () { return { cleared: true }; });
    case 'fetchImage': {
      if (!msg.srcUrl) return Promise.reject(new Error('fetchImage: srcUrl is required'));
      return fetch(msg.srcUrl).then(function (r) {
        if (!r.ok) throw new Error('fetchImage: HTTP ' + r.status);
        return r.blob();
      }).then(function (blob) {
        return new Promise(function (resolve, reject) {
          var reader = new FileReader();
          reader.onload = function () { resolve({ dataUrl: reader.result, mimeType: blob.type || '' }); };
          reader.onerror = function () { reject(new Error('fetchImage: could not read image')); };
          reader.readAsDataURL(blob);
        });
      });
    }
    case 'transcribe': {
      return resolveProvider(msg).then(async function (p) {
        var blob;
        var srcUrl = msg.dataUrl || msg.audioDataUrl;
        if (srcUrl && !msg.audioBase64) {
          blob = await (await fetch(srcUrl)).blob();
        } else if (msg.audioBase64) {
          var bin = atob(msg.audioBase64);
          var arr = new Uint8Array(bin.length);
          for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
          blob = new Blob([arr], { type: msg.mimeType || 'audio/webm' });
        } else if (false) {
          blob = null; // unreachable: dataUrl/audioDataUrl handled above
        } else {
          throw new Error('transcribe: send audioBase64 or audioDataUrl (Blobs cannot cross runtime messages)');
        }
        return GraphiteProviders.transcribe(p, blob, msg.filename || msg.name || 'audio.webm');
      });
    }
    case 'generateImage': {
      // Image calls must NOT use the chat/text model override: resolve the
      // provider without it and let generateImage use provider.imageModel.
      // An explicit image model from the caller (msg.imageModel, or
      // imageOptions/options.model) still wins; legacy msg.size still works.
      var imageOptions = Object.assign({}, msg.imageOptions || msg.options || {});
      if (msg.imageModel && !imageOptions.model) imageOptions.model = msg.imageModel;
      if (msg.size && !imageOptions.size) imageOptions.size = msg.size;
      return resolveProvider(msg, { forImage: true }).then(function (p) {
        return GraphiteProviders.generateImage(p, msg.prompt || '', imageOptions);
      });
    }
    case 'tts':
      // speechSynthesis lives in the sidebar document, not the background page.
      return Promise.resolve({
        ok: false, supported: false,
        error: 'tts is handled sidebar-side via window.speechSynthesis; the background page has no speech synthesis.'
      });
    case 'getSettings':
      return GraphiteStorage.loadSettings();
    case 'getPendingAction':
      return GraphiteStorage.takePendingAction();
    case 'openSidebar':
      return openSidebar();
    case 'setActiveModel': {
      // Single writer for the shared model selection (sidebar, YouTube and
      // Search pickers). Goes through saveSettings' serialized
      // read-modify-write so content scripts never rewrite the whole
      // settings blob (clobber risk).
      return GraphiteStorage.loadSettings({ fresh: true }).then(function (settings) {
        var next = Object.assign({}, settings, {
          activeProviderId: msg.providerId != null ? String(msg.providerId) : settings.activeProviderId,
          activeModel: msg.model != null ? String(msg.model) : settings.activeModel
        });
        return GraphiteStorage.saveSettings(next);
      }).then(function (saved) {
        return { activeProviderId: saved.activeProviderId || '', activeModel: saved.activeModel || '' };
      });
    }
    case 'getChatJob':
      return GraphiteStorage.getChatJob(msg.requestId);
    case 'features':
      return Promise.resolve(FEATURES);
    case 'ping':
      return Promise.resolve({ pong: true, version: '1.0.0' });
    case 'pendingAction':
      // Broadcast from dispatchToSidebar() for an already-open sidebar; nothing to do here.
      return Promise.resolve(null);
    default:
      return Promise.reject(new Error('Unknown message type: ' + msg.type));
  }
}

if (ext.runtime && ext.runtime.onMessage) {
  ext.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || typeof msg.type !== 'string') return undefined;
    // Runtime messages must not leak provider keys to web pages: only accept
    // messages from this extension (sender.id/url check when available).
    if (sender && sender.url && sender.url.indexOf(ext.runtime.getURL('')) !== 0 &&
        sender.id && ext.runtime.id && sender.id !== ext.runtime.id) {
      sendResponse({ ok: false, error: 'Message rejected: not from this extension.' });
      return true;
    }
    handleMessage(msg).then(function (result) {
      // The tts handler already shapes its own payload.
      if (msg.type === 'tts') sendResponse(result);
      else sendResponse({ ok: true, result: result });
    }).catch(function (e) {
      gsLog('msg', String(msg.type) + ' failed', { name: (e && e.name) || '', status: (e && e.status) || null });
      sendResponse({ ok: false, error: errorMessage(e), status: e && e.status || undefined });
    });
    return true; // async response
  });
}

// Never serve a stale in-memory settings copy after any context saves:
// the background is non-persistent but can outlive an options-page edit.
if (ext.storage && ext.storage.onChanged) {
  ext.storage.onChanged.addListener(function (changes, area) {
    if ((area === 'local' || area === 'sync') &&
        typeof GraphiteStorage !== 'undefined' && GraphiteStorage.clearCache) {
      GraphiteStorage.clearCache();
    }
  });
}
