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

async function openSidebar() {
  if (ext.sidebarAction) {
    try {
      if (typeof ext.sidebarAction.open === 'function') { await ext.sidebarAction.open(); return true; }
    } catch (e) { /* sidebar may already be open */ return true; }
  }
  return false;
}

async function toggleSidebar() {
  if (ext.sidebarAction) {
    try {
      if (typeof ext.sidebarAction.toggle === 'function') { await ext.sidebarAction.toggle(); return true; }
      if (typeof ext.sidebarAction.open === 'function') { await ext.sidebarAction.open(); return true; }
    } catch (e) { return false; }
  }
  return false;
}

/** Stage an action for the sidebar, open it, and notify it if already listening. */
async function dispatchToSidebar(pending) {
  try { await GraphiteStorage.setPendingAction(pending); } catch (e) { /* storage unavailable */ }
  await openSidebar();
  try {
    await ext.runtime.sendMessage({ type: 'pendingAction', action: pending });
  } catch (e) { /* Sidebar not open yet — it polls the pendingAction storage key on load. */ }
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
  ext.browserAction.onClicked.addListener(function () { toggleSidebar(); });
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

/* Ceiling for YouTube panel summary requests. The detailed 6-section
 * summary format needs a few thousand output tokens; an outsized stored
 * settings.maxTokens (the options page allows up to 131072) is forwarded
 * verbatim otherwise, and some gateways reserve / schedule against the
 * requested ceiling, inflating time-to-first-token for no benefit. 16384
 * leaves roughly 2x headroom over a full-length detailed summary, so a
 * legitimate long-video output is never cut off mid-format.
 * Applied only to YouTube summary streams: an explicit msg.maxTokens
 * always wins, and sidebar chat (no purpose marker) keeps the user's
 * setting untouched. */
var YOUTUBE_SUMMARY_MAX_TOKENS = 16384;
function youtubeSummaryMaxTokens(msg, settings) {
  if (msg && typeof msg.maxTokens === 'number') return msg.maxTokens;
  var stored = settings && settings.settings ? settings.settings.maxTokens : undefined;
  return (typeof stored === 'number' && stored > 0) ? Math.min(stored, YOUTUBE_SUMMARY_MAX_TOKENS) : stored;
}

async function chatRequest(msg, onChunk, signal) {
  var started = Date.now();
  var provider = await resolveProvider(msg || {});
  gsLog('chat', 'start', { provider: provider.label || provider.kind || '', host: gsHost(provider.baseUrl), model: (msg && msg.model) || provider.model || '', stream: !!(msg && msg.stream) || !!onChunk });
  var settings = await GraphiteStorage.loadSettings();
  var messages = (msg && msg.messages) || [];
  if (settings.settings && settings.settings.systemPrompt &&
      !messages.some(function (m) { return m.role === 'system'; })) {
    messages = [{ role: 'system', content: settings.settings.systemPrompt }].concat(messages);
  }
  try {
    var result = await GraphiteProviders.chat({
      provider: provider,
      model: (msg && msg.model) || provider.model,
      messages: messages,
      stream: !!(msg && msg.stream) || !!onChunk,
      onChunk: onChunk,
      signal: signal,
      temperature: msg && typeof msg.temperature === 'number' ? msg.temperature
        : (settings.settings ? settings.settings.temperature : undefined),
      maxTokens: (msg && msg.purpose === 'youtube-summary') ? youtubeSummaryMaxTokens(msg, settings)
        : (msg && typeof msg.maxTokens === 'number' ? msg.maxTokens
          : (settings.settings ? settings.settings.maxTokens : undefined))
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
 *                     {type:'done', requestId,text,model,usage}
 *                     {type:'error',requestId,error}
 * Send {type:'abort', requestId} or disconnect to cancel. */
if (ext.runtime && ext.runtime.onConnect) {
  ext.runtime.onConnect.addListener(function (port) {
    if (port.name !== 'graphite-chat' && port.name !== 'chat-stream') return;
    var controllers = {};
    port.onMessage.addListener(function (msg) {
      if (!msg) return;
      if (msg.type === 'abort' && msg.requestId && controllers[msg.requestId]) {
        controllers[msg.requestId].abort();
        return;
      }
      if (msg.type !== 'chatStream' && msg.type !== 'chat' && msg.type !== 'chatSync' && msg.type !== 'start') return;
      var requestId = msg.requestId || ('req-' + Date.now());
      var controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
      if (controller) controllers[requestId] = controller;
      chatRequest(msg, function (chunk, full) {
        try { port.postMessage({ type: 'chunk', requestId: requestId, chunk: chunk, text: chunk, full: full }); } catch (e) {}
      }, controller ? controller.signal : undefined).then(function (result) {
        try { port.postMessage({ type: 'done', requestId: requestId, text: result.text, chunk: result.text, full: result.text, model: result.model, usage: result.usage || null }); } catch (e) {}
      }).catch(function (e) {
        try { port.postMessage({ type: 'error', requestId: requestId, error: errorMessage(e), message: errorMessage(e) }); } catch (ignored) {}
      }).then(function () { delete controllers[requestId]; });
    });
    port.onDisconnect.addListener(function () {
      Object.keys(controllers).forEach(function (k) { try { controllers[k].abort(); } catch (e) {} });
    });
  });
}

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
      }).then(function () { return { opened: true }; });
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
      return openSidebar().then(function (opened) { return { opened: opened }; });
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
