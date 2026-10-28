'use strict';
/* Graphite Sider sidebar. All provider calls go through the background
   page via runtime.sendMessage / runtime.connect('graphite-chat'). */
(function () {
  var api = (typeof browser !== 'undefined') ? browser : (typeof chrome !== 'undefined' ? chrome : null);
  var $ = function (id) { return document.getElementById(id); };
  var state = {
    settings: null, providers: [], activeProviderId: '', activeModel: '',
    messages: [], // {role, content} content may be string or parts array
    display: [],   // parallel render records
    ports: [], generating: false,
    contextText: '', contextLabel: '', attachment: null,
    conversationId: null, groupMode: false, groupResults: [],
    editingPromptId: null, lastArtifact: '', slashIndex: 0,
    currentTab: null, stopRequested: false, ytTranscript: '',
    toolFavorites: [], selectedToolId: '',
    handSteps: [], handStop: false,
    handLogEntries: [], handRun: null, handRunSaved: false, handSummaryRecord: null,
    researchRaw: '', researchSources: [], researchId: null,
    videos: [], videoSelected: -1, videoBusy: false, videoResultRaw: ''
  };
  var TOOL_FAVORITES_KEY = 'graphiteSider.toolFavorites.v1';

  function esc(s) { return window.GraphiteMarkdown ? GraphiteMarkdown.escapeHtml(s) : String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function setGeneratedHtml(el, html) {
    var doc = new DOMParser().parseFromString(String(html == null ? '' : html), 'text/html');
    var drop = { script: 1, style: 1, iframe: 1, object: 1, embed: 1, form: 1, link: 1, meta: 1, title: 1, base: 1, svg: 1, math: 1 };
    Array.prototype.forEach.call(doc.querySelectorAll('*'), function (n) {
      if (drop[n.tagName.toLowerCase()]) { n.remove(); return; }
      Array.prototype.slice.call(n.attributes).forEach(function (a) {
        var name = a.name.toLowerCase();
        if (name.indexOf('on') === 0) { n.removeAttribute(a.name); return; }
        if (!/^(href|src|alt|title|class|id|type|disabled|checked|selected|value|placeholder|rows|cols|accept|for|target|rel|data-[a-z0-9-]+)$/.test(name)) n.removeAttribute(a.name);
      });
      var href = n.getAttribute && n.getAttribute('href');
      if (href && !/^(https?:|mailto:|#|\/|\.)/i.test(href)) n.removeAttribute('href');
      var src = n.getAttribute && n.getAttribute('src');
      if (src && !/^(https?:|data:image\/|#|\/|\.)/i.test(src)) n.removeAttribute('src');
    });
    while (el.firstChild) el.removeChild(el.firstChild);
    while (doc.body.firstChild) el.appendChild(doc.body.firstChild);
  }
  function emptyNoteEl(text) { var d = document.createElement('div'); d.className = 'empty-note'; d.textContent = text; return d; }
  function status(t) { $('statusLine').textContent = t; }
  function truncate(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n) + '\n...[truncated]' : s; }
  function uid() { return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

  function sendMessage(msg) {
    var raw;
    try {
      raw = api.runtime.sendMessage(msg);
      if (!(raw && raw.then)) raw = Promise.resolve(raw);
    } catch (e) { raw = Promise.reject(e); }
    return raw.then(function (resp) {
      // Background wraps one-shot results as { ok:true, result } / { ok:false, error }.
      if (resp && typeof resp === 'object' && ('ok' in resp) && ('result' in resp || 'error' in resp)) {
        if (resp.ok) return resp.result;
        throw new Error(resp.error || 'Background request failed');
      }
      return resp;
    });
  }
  var SETTINGS_KEY = (window.GraphiteStorage && GraphiteStorage.STORAGE_KEY) || 'graphiteSider.settings.v1';
  var PENDING_KEY = (window.GraphiteStorage && GraphiteStorage.PENDING_KEY) || 'graphiteSider.pendingAction';
  function storageGet(keys) {
    try {
      if (window.GraphiteStorage && GraphiteStorage._rawGet && typeof keys === 'string') {
        return GraphiteStorage._rawGet(keys);
      }
    } catch (e) { /* fall through */ }
    return api.storage.local.get(keys);
  }
  function storageSet(obj) { return api.storage.local.set(obj); }

  /* ---------------- settings / providers ---------------- */
  function normalizeProviders(settings) {
    var out = [];
    if (!settings) return out;
    var list = settings.providers || settings.providerConfigs || [];
    if (!Array.isArray(list) && typeof list === 'object') list = Object.keys(list).map(function (k) { var v = list[k]; v.id = v.id || k; return v; });
    (list || []).forEach(function (p) {
      if (!p) return;
      var rawModels = p.models || [];
      if (typeof rawModels === 'string') rawModels = [rawModels];
      if (!Array.isArray(rawModels)) rawModels = [];
      var models = [];
      rawModels.forEach(function (m) {
        var id = '';
        if (typeof m === 'string') id = m.trim();
        else if (m && typeof m === 'object') {
          var keys = ['id', 'name', 'model'];
          for (var i = 0; i < keys.length; i++) {
            var v = m[keys[i]];
            if (typeof v === 'string' && v.trim()) { id = v.trim(); break; }
          }
        }
        if (id && models.indexOf(id) === -1) models.push(id);
      });
      var configured = String(p.model || p.defaultModel || '').trim();
      if (configured) {
        models = [configured].concat(models.filter(function (m) { return m !== configured; }));
      }
      out.push({
        id: p.id || p.name || 'provider',
        label: p.label || p.name || p.id || 'Provider',
        model: configured || (models[0] || ''),
        models: models,
        enabled: p.enabled !== false,
        hasKey: !!(p.apiKey || p.key || p.noKey)
      });
    });
    if (!out.length && (settings.providerId || settings.provider || settings.model || settings.apiKey)) {
      out.push({ id: settings.providerId || settings.provider || 'default', label: settings.providerLabel || settings.providerId || settings.provider || 'Default', model: settings.model || '', models: settings.model ? [settings.model] : [], enabled: true, hasKey: !!settings.apiKey });
    }
    return out.filter(function (p) { return p.enabled; });
  }

  function loadSettings() {
    var viaHelper = null;
    try {
      if (window.GraphiteStorage) {
        if (GraphiteStorage.loadSettings) viaHelper = GraphiteStorage.loadSettings();
        else if (GraphiteStorage.getSettings) viaHelper = GraphiteStorage.getSettings();
        else if (GraphiteStorage.get) viaHelper = GraphiteStorage.get('graphite_settings').then(function (o) { return o.graphite_settings; });
      }
    } catch (e) { viaHelper = null; }
    var fallback = function () { return api.storage.local.get(SETTINGS_KEY).then(function (o) { return o[SETTINGS_KEY] || null; }); };
    return Promise.resolve(viaHelper).catch(function () { return null; }).then(function (s) {
      if (!s) return fallback().catch(function () { return null; });
      return s;
    }).then(function (settings) {
      state.settings = settings || {};
      state.providers = normalizeProviders(state.settings);
      state.activeProviderId = state.settings.activeProviderId || state.settings.providerId || state.settings.provider || (state.providers[0] && state.providers[0].id) || '';
      state.activeModel = state.settings.activeModel || state.settings.model || '';
      renderProviderSelects();
      renderGroupModels();
      var configured = state.providers.some(function (p) { return p.hasKey; }) || !!state.settings.apiKey;
      $('noProviderBanner').classList.toggle('hidden', configured || !state.providers.length && configured);
      if (!state.providers.length) $('noProviderBanner').classList.remove('hidden');
      else if (!configured) $('noProviderBanner').classList.remove('hidden');
      else $('noProviderBanner').classList.add('hidden');
      status(state.providers.length ? 'Ready - ' + providerLabel(state.activeProviderId) : 'No provider configured');
    }).catch(function (e) { status('Settings load failed: ' + e.message); });
  }

  function providerLabel(id) {
    var p = state.providers.find(function (x) { return x.id === id; });
    return p ? (p.label + (p.model ? ' / ' + modelOf(p) : '')) : (id || 'No provider');
  }
  function modelOf(p) { return (state.activeProviderId === p.id && state.activeModel) ? state.activeModel : (p.model || (p.models && p.models[0]) || ''); }
  function allModelCombos() {
    var combos = [];
    state.providers.forEach(function (p) {
      var ms = (p.models && p.models.length) ? p.models : [p.model || 'default'];
      ms.forEach(function (m) { if (m) combos.push({ providerId: p.id, model: m, label: p.label + ' / ' + m, providerLabel: p.label }); });
    });
    return combos;
  }

  var modelPickerState = { open: false, highlight: -1, filtered: [] };

  function activeProvider() { return state.providers.find(function (x) { return x.id === state.activeProviderId; }); }
  function currentModels() {
    var p = activeProvider();
    return p ? ((p.models && p.models.length) ? p.models : (p.model ? [p.model] : [])) : [];
  }

  function renderProviderSelects() {
    var ps = $('providerSelect');
    ps.textContent = '';
    if (!state.providers.length) { var o = document.createElement('option'); o.textContent = 'No provider'; ps.appendChild(o); }
    state.providers.forEach(function (p) {
      var o = document.createElement('option'); o.value = p.id; o.textContent = p.label; ps.appendChild(o);
    });
    if (state.activeProviderId) ps.value = state.activeProviderId;
    renderModelSelect();
  }
  function renderModelSelect() {
    // Preserved API: now renders the custom model picker button + list.
    var btnLabel = $('modelButtonLabel');
    if (!btnLabel) return;
    var p = activeProvider();
    var models = currentModels();
    if (!models.length) {
      state.activeModel = '';
      btnLabel.textContent = 'Default model';
      var bb = $('modelButton'); if (bb) bb.title = 'Default model';
      if (modelPickerState.open) renderModelList();
      return;
    }
    if (!state.activeModel || models.indexOf(state.activeModel) === -1) state.activeModel = modelOf(p) || models[0];
    btnLabel.textContent = state.activeModel || 'Default model';
    var btn = $('modelButton'); if (btn) btn.title = state.activeModel || 'Default model';
    if (modelPickerState.open) renderModelList();
  }
  function renderModelList() {
    var list = $('modelList');
    if (!list) return;
    var models = currentModels();
    var query = ($('modelSearch') ? $('modelSearch').value : '').toLowerCase();
    var filtered = models.filter(function (m) { return !query || m.toLowerCase().indexOf(query) !== -1; });
    modelPickerState.filtered = filtered;
    list.textContent = '';
    if (!models.length) { var e = document.createElement('div'); e.className = 'model-empty'; e.textContent = 'No models available'; list.appendChild(e); modelPickerState.highlight = -1; return; }
    if (!filtered.length) { var n = document.createElement('div'); n.className = 'model-empty'; n.textContent = 'No matching models'; list.appendChild(n); modelPickerState.highlight = -1; return; }
    // Highlight current model if present, else first match.
    var hl = filtered.indexOf(state.activeModel);
    modelPickerState.highlight = hl !== -1 ? hl : 0;
    filtered.forEach(function (m, i) {
      var el = document.createElement('div');
      el.className = 'model-item' + (m === state.activeModel ? ' selected' : '') + (i === modelPickerState.highlight ? ' highlighted' : '');
      el.setAttribute('role', 'option');
      el.id = 'model-opt-' + i;
      el.setAttribute('aria-selected', m === state.activeModel ? 'true' : 'false');
      el.textContent = m;
      el.title = m;
      el.addEventListener('pointerdown', function (e) { e.preventDefault(); });
      el.addEventListener('click', function () { selectModel(m); });
      list.appendChild(el);
    });
    var search = $('modelSearch'); if (search) search.setAttribute('aria-activedescendant', filtered[modelPickerState.highlight] ? ('model-opt-' + modelPickerState.highlight) : '');
  }
  function setHighlight(idx) {
    var filtered = modelPickerState.filtered;
    if (!filtered.length) return;
    modelPickerState.highlight = Math.max(0, Math.min(idx, filtered.length - 1));
    Array.prototype.forEach.call($('modelList').querySelectorAll('.model-item'), function (el, i) { el.classList.toggle('highlighted', i === modelPickerState.highlight); });
    var search = $('modelSearch'); if (search) search.setAttribute('aria-activedescendant', 'model-opt-' + modelPickerState.highlight);
    var el = $('modelList').children[modelPickerState.highlight]; if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
  }
  function openModelPicker() {
    var menu = $('modelMenu'), btn = $('modelButton');
    if (!menu || !btn) return;
    modelPickerState.open = true;
    var s = $('modelSearch'); if (s) s.value = '';
    renderModelList();
    menu.classList.remove('hidden');
    btn.setAttribute('aria-expanded', 'true');
    var hEl = $('modelList') && $('modelList').children[modelPickerState.highlight];
    if (hEl && hEl.scrollIntoView) hEl.scrollIntoView({ block: 'nearest' });
    if (s) { s.focus(); s.select(); }
  }
  function closeModelPicker() {
    var menu = $('modelMenu'), btn = $('modelButton');
    if (!menu) return;
    modelPickerState.open = false;
    modelPickerState.highlight = -1;
    var s = $('modelSearch'); if (s) s.value = '';
    menu.classList.add('hidden');
    if (btn) btn.setAttribute('aria-expanded', 'false');
  }
  function toggleModelPicker() { if (modelPickerState.open) closeModelPicker(); else openModelPicker(); }
  function selectModel(m) {
    state.activeModel = m;
    renderModelSelect();
    closeModelPicker();
    var btn = $('modelButton'); if (btn) btn.focus();
    // Persist like the Options page does, so the YouTube/Search helpers
    // (and the next session) see the same active model.
    sendMessage({ type: 'setActiveModel', providerId: state.activeProviderId, model: m }).catch(function () {});
  }
  function renderGroupModels() {
    var box = $('groupModels'); box.textContent = '';
    allModelCombos().forEach(function (c, i) {
      var lab = document.createElement('label');
      var cb = document.createElement('input'); cb.type = 'checkbox'; cb.value = c.providerId + '|' + c.model; cb.checked = i < 2;
      lab.appendChild(cb); lab.appendChild(document.createTextNode(' ' + c.label));
      box.appendChild(lab);
    });
    if (!box.children.length) { var note = document.createElement('span'); note.className = 'muted small'; note.textContent = 'Configure providers in Settings to use group chat.'; box.appendChild(note); }
  }
  function selectedGroupCombos(promptText) {
    var boxes = Array.prototype.slice.call($('groupModels').querySelectorAll('input:checked'));
    var combos = boxes.map(function (cb) { var p = cb.value.split('|'); return { providerId: p[0], model: p.slice(1).join('|'), label: providerLabel(p[0]) + ' / ' + p.slice(1).join('|'), providerLabel: (state.providers.find(function (x) { return x.id === p[0]; }) || {}).label || p[0] }; });
    // @mention filter: @ModelName keeps only matching combos
    if (promptText) {
      var mentions = [];
      var re = /@([A-Za-z0-9 ._/-]+?)(?=\s@|\s{2}|$|,)/g, m;
      // simpler: match @tokens then expand against labels
      var tokenRe = /@([^\s,]+)/g;
      while ((m = tokenRe.exec(promptText)) !== null) mentions.push(m[1].toLowerCase());
      if (mentions.length) {
        var filtered = combos.filter(function (c) { return mentions.some(function (t) { return c.label.toLowerCase().indexOf(t) !== -1 || c.providerLabel.toLowerCase().indexOf(t) !== -1 || c.model.toLowerCase().indexOf(t) !== -1; }); });
        if (filtered.length) combos = filtered;
      }
    }
    return combos.slice(0, 4);
  }

  /* ---------------- tabs / views ---------------- */
  function switchView(name) {
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) { t.classList.toggle('active', t.dataset.view === name); });
    Array.prototype.forEach.call(document.querySelectorAll('.view'), function (v) { v.classList.toggle('active', v.id === 'view-' + name); });
    if (name === 'history') renderHistory();
    if (name === 'prompts') renderPrompts();
    if (name === 'code') { refreshCodeHost(); renderCodeRules(); }
    if (name === 'research') renderResearchList();
    if (name === 'hand') renderHandRunsList();
    if (name === 'videos') renderVideoList();
  }

  /* Send a graphite-command to the content script in the active (or
   * originating) tab. Resolves with the command result object even when
   * it reports { ok:false } so callers can inspect needsConfirm etc.;
   * rejects only on transport failure. */
  function sendTabCommand(command, payload) {
    return getActiveTab().then(function (tab) {
      if (!tab || tab.id == null) throw new Error('No active tab');
      state.currentTab = tab;
      var msg = { type: 'graphite-command', command: command };
      if (payload) Object.keys(payload).forEach(function (k) { msg[k] = payload[k]; });
      return api.tabs.sendMessage(tab.id, msg).then(function (resp) {
        if (resp && typeof resp === 'object' && 'ok' in resp && ('result' in resp || 'error' in resp)) {
          if (resp.ok) return resp.result;
          throw new Error(resp.error || 'Command failed');
        }
        return resp;
      });
    });
  }
  function activeTabId() {
    return getActiveTab().then(function (tab) {
      if (!tab || tab.id == null) throw new Error('No active tab');
      state.currentTab = tab;
      return tab.id;
    });
  }
  function hostOf(url) {
    try { return new URL(url || '').hostname || ''; } catch (e) { return ''; }
  }
  /* Models often wrap JSON in fences or prose; extract the outermost
   * object/array and parse it. Returns null when nothing parses. */
  function extractJsonValue(text) {
    var s = String(text || '').trim();
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    var objAt = s.indexOf('{'), arrAt = s.indexOf('[');
    var start = objAt === -1 ? arrAt : (arrAt === -1 ? objAt : Math.min(objAt, arrAt));
    if (start === -1) return null;
    var end = Math.max(s.lastIndexOf('}'), s.lastIndexOf(']'));
    if (end <= start) return null;
    try { return JSON.parse(s.slice(start, end + 1)); } catch (e) { return null; }
  }
  function outlineSummary(outline) {
    if (!outline) return 'Page outline unavailable (content script not reachable).';
    return (outline.title || 'Untitled') + ' — ' +
      ((outline.headings || []).length) + ' headings, ' +
      ((outline.landmarks || []).length) + ' landmarks, ' +
      ((outline.links || []).length) + ' links, ' +
      ((outline.buttons || []).length) + ' buttons, ' +
      ((outline.fields || []).length) + ' fields';
  }

  /* ---------------- current tab / context ---------------- */
  // When this page runs as a chat TAB (Firefox for Android fallback), the
  // "active tab" is this chat page itself; track the tab the user came
  // from instead (stored by the background's openChatTab flow / pending
  // action tabId, or the most recent non-extension active tab).
  function isChatSurfaceTab(tab) {
    return !!(tab && tab.url && tab.url.indexOf(api.runtime.getURL('sidebar/sidebar.html')) === 0);
  }
  function originatingTab() {
    try {
      var saved = sessionStorage.getItem('graphiteSider.originTabId');
      if (saved) return api.tabs.get(Number(saved)).catch(function () { return null; });
    } catch (e) { /* fall through */ }
    return Promise.resolve(null);
  }
  function rememberOriginTab(tab) {
    if (!tab || tab.id == null || isChatSurfaceTab(tab)) return;
    try { sessionStorage.setItem('graphiteSider.originTabId', String(tab.id)); } catch (e) { /* ignore */ }
    state.currentTab = tab;
  }
  function getActiveTab() {
    return sendMessage({ type: 'getActiveTab' }).then(function (r) {
      if (r && (r.url || r.title)) return r;
      throw new Error('empty');
    }).catch(function () {
      return api.tabs.query({ active: true, currentWindow: true }).then(function (tabs) { return tabs[0] || null; });
    }).then(function (tab) {
      if (isChatSurfaceTab(tab)) {
        return originatingTab().then(function (origin) { return origin || tab; });
      }
      rememberOriginTab(tab);
      return tab;
    });
  }
  function isYouTube(url) { return /(?:youtube\.com\/(?:watch|shorts|live)|youtu\.be\/)/.test(url || ''); }
  function youtubeId(url) {
    var m = String(url || '').match(/(?:v=|youtu\.be\/|shorts\/|live\/)([A-Za-z0-9_-]{11})/);
    return m ? m[1] : '';
  }
  function youtubeWatchUrl(videoId, seconds) {
    if (!videoId) return '';
    var base = 'https://www.youtube.com/watch?v=' + encodeURIComponent(videoId);
    return seconds != null ? base + '&t=' + Math.max(0, Math.floor(seconds)) + 's' : base;
  }
  function parseTimestampSeconds(raw) {
    var Md = window.GraphiteMarkdown;
    if (Md && typeof Md.parseTimestampSeconds === 'function') return Md.parseTimestampSeconds(raw);
    if (window.GraphitePrompts && typeof GraphitePrompts.parseTimestampSeconds === 'function') return GraphitePrompts.parseTimestampSeconds(raw);
    return null;
  }
  /* Sidebar timestamps: real seek controls when the active tab is a YouTube
   * video; otherwise the click falls back to a ?t= tab. */
  function markdownOpts() {
    var tab = state.currentTab;
    var id = tab ? youtubeId(tab.url) : '';
    if (!id) return {};
    return { videoId: id, seekHrefFor: function () { return null; } };
  }
  function seekActiveVideo(seconds) {
    var target = parseTimestampSeconds(seconds);
    if (target == null) return Promise.resolve(false);
    var tab = state.currentTab;
    var id = tab ? youtubeId(tab.url) : '';
    if (!tab || !id) {
      status('No active YouTube video to seek');
      return Promise.resolve(false);
    }
    var msg = { type: 'graphite-command', command: 'seek', seconds: target, videoId: id };
    var send = function (tabId) {
      return api.tabs.sendMessage(tabId, msg).then(function (resp) {
        if (resp && typeof resp === 'object' && 'ok' in resp && ('result' in resp || 'error' in resp)) {
          if (resp.ok) return resp.result;
          throw new Error(resp.error || 'Seek failed');
        }
        return resp;
      }).then(function (r) {
        if (r && r.ok === false) throw new Error(r.error || 'Seek failed');
        status('Jumped to ' + ((window.GraphiteMarkdown && GraphiteMarkdown.formatTimestampLabel) ? GraphiteMarkdown.formatTimestampLabel(target) : target + 's'));
        return true;
      });
    };
    if (tab.id != null) return send(tab.id).catch(function () { return openYouTubeAt(id, target); });
    return api.tabs.query({ active: true, currentWindow: true }).then(function (tabs) {
      var t = tabs && tabs[0];
      if (!t || t.id == null) throw new Error('No active tab');
      state.currentTab = t;
      return send(t.id);
    }).catch(function () { return openYouTubeAt(id, target); });
  }
  function openYouTubeAt(videoId, seconds) {
    var url = youtubeWatchUrl(videoId, seconds);
    if (!url) return Promise.resolve(false);
    try {
      var p = api.tabs.create({ url: url });
      if (p && p.catch) p.catch(function () {}).then(function () {});
      status('Opened YouTube at ' + seconds + 's');
      return Promise.resolve(true);
    } catch (e) {
      status('Seek failed: ' + (e && e.message || e));
      return Promise.resolve(false);
    }
  }
  function refreshPageChip() {
    getActiveTab().then(function (tab) {
      state.currentTab = tab;
      if (!tab) { $('pageChip').textContent = 'No active tab'; return; }
      $('pageChip').textContent = truncate(tab.title || tab.url || 'Untitled', 42);
      $('pageChip').title = (tab.title || '') + '\n' + (tab.url || '');
      $('youtubeChip').classList.toggle('hidden', !isYouTube(tab.url));
    }).catch(function () { $('pageChip').textContent = 'No active tab'; });
  }
  function setContext(text, label) {
    state.contextText = truncate(text, 12000);
    state.contextLabel = label;
    $('contextLabel').textContent = label + ' (' + state.contextText.length + ' chars)';
    $('contextChip').classList.remove('hidden');
    status('Context attached: ' + label);
  }
  function clearContext() { state.contextText = ''; state.contextLabel = ''; $('contextChip').classList.add('hidden'); }

  function attachPage() {
    status('Extracting page...');
    return sendMessage({ type: 'extractPage' }).then(function (r) {
      if (!r || !r.text) throw new Error((r && r.error) || 'No page text returned');
      setContext(r.text, 'Page: ' + (r.title || r.url || 'current page'));
      return r;
    }).catch(function (e) { status('Page extract failed: ' + e.message); throw e; });
  }
  function attachYouTube(urlOverride) {
    return getActiveTab().then(function (tab) {
      var url = urlOverride || (tab && tab.url) || '';
      var id = youtubeId(url);
      if (!id && urlOverride) id = youtubeId('https://www.youtube.com/watch?v=' + urlOverride);
      if (!id) { status('No YouTube video detected'); throw new Error('No YouTube video'); }
      status('Fetching transcript...');
      return sendMessage({ type: 'fetchTranscript', videoId: id, url: url }).then(function (r) {
        var text = typeof r === 'string' ? r : (r && (r.text || r.transcript)) || '';
        if (!text && window.GraphiteYouTube) {
          var Y = window.GraphiteYouTube;
          var fn = Y.fetchTranscript || Y.getTranscript || Y.fetchCaptions;
          if (fn) return Promise.resolve(fn(url || id)).then(function (t) { return typeof t === 'string' ? t : (t.text || t.transcript || ''); });
        }
        return text;
      }).then(function (text) {
        if (!text) throw new Error('Transcript unavailable');
        /* Keep the full transcript: the summary prompt carries timestamps the
         * model must preserve; setContext truncates at 12k for chat context. */
        state.ytTranscript = text;
        setContext(text, 'YouTube: ' + id);
      });
    }).catch(function (e) { status('YouTube failed: ' + e.message); throw e; });
  }

  /* ---------------- files ---------------- */
  function readAsDataURL(file) { return new Promise(function (res, rej) { var r = new FileReader(); r.onload = function () { res(r.result); }; r.onerror = rej; r.readAsDataURL(file); }); }
  function readAsText(file) { return new Promise(function (res, rej) { var r = new FileReader(); r.onload = function () { res(r.result); }; r.onerror = rej; r.readAsText(file); }); }
  function readAsArrayBuffer(file) { return new Promise(function (res, rej) { var r = new FileReader(); r.onload = function () { res(r.result); }; r.onerror = rej; r.readAsArrayBuffer(file); }); }

  function showAttachment(html) { var el = $('attachmentPreview'); setGeneratedHtml(el, html); el.classList.remove('hidden'); }
  function handleImageFile(file, promptText) {
    return readAsDataURL(file).then(function (dataUrl) {
      state.attachment = { kind: 'image', name: file.name, dataUrl: dataUrl, mime: file.type };
      showAttachment('<strong>Image:</strong> ' + esc(file.name) + '<img alt="" src="' + dataUrl + '">');
      if (promptText) { $('composer').value = promptText; sendCurrent(); }
      status('Image attached - send a message to ask about it');
    });
  }
  function handlePdfFile(file) {
    status('Reading PDF...');
    return readAsDataURL(file).then(function (dataUrl) {
      return sendMessage({ type: 'extractPdfText', dataUrl: dataUrl, name: file.name }).then(function (r) {
        var text = typeof r === 'string' ? r : (r && r.text) || '';
        if (text) { setContext(text, 'PDF: ' + file.name); return; }
        throw new Error('background-no-pdf');
      }).catch(function () {
        if (window.GraphitePDF) {
          var P = window.GraphitePDF;
          var fn = P.extractTextFromPDF || P.extractText || P.getText || P.parse || P.extractPdfText;
          if (fn) {
            return readAsArrayBuffer(file).then(fn).then(function (t) {
              var text = typeof t === 'string' ? t : (t && t.text) || '';
              if (!text) throw new Error('No PDF text extracted');
              setContext(text, 'PDF: ' + file.name);
            });
          }
        }
        status('PDF extraction not available in background or lib/pdf.js');
      });
    });
  }
  function handleAudioFile(file, doTranscribe) {
    return readAsDataURL(file).then(function (dataUrl) {
      if (!doTranscribe) { state.attachment = { kind: 'audio', name: file.name, dataUrl: dataUrl, mime: file.type }; showAttachment('<strong>Audio:</strong> ' + esc(file.name)); status('Audio attached'); return null; }
      status('Transcribing audio...');
      return sendMessage({ type: 'transcribe', dataUrl: dataUrl, name: file.name, mime: file.type }).then(function (r) {
        var text = typeof r === 'string' ? r : (r && (r.text || r.transcript)) || '';
        if (!text) throw new Error((r && r.error) || 'Transcription unavailable - background returned no text');
        setContext(text, 'Audio transcript: ' + file.name);
        return text;
      }).catch(function (e) { status('Transcribe failed: ' + e.message); throw e; });
    });
  }
  function handleTextFile(file) {
    return readAsText(file).then(function (text) { setContext(text, 'File: ' + file.name); });
  }

  /* ---------------- messages rendering ---------------- */
  function buildApiMessages(extraUserText) {
    var msgs = [];
    var systemParts = [];
    if (state.contextText) systemParts.push('Context (' + state.contextLabel + '):\n' + state.contextText);
    state.messages.forEach(function (m) { msgs.push({ role: m.role, content: m.content }); });
    if (systemParts.length) msgs.unshift({ role: 'system', content: systemParts.join('\n\n') });
    if (extraUserText) msgs.push({ role: 'user', content: extraUserText });
    return msgs;
  }
  function userContentFor(text) {
    if (state.attachment && state.attachment.kind === 'image') {
      return [
        { type: 'text', text: text },
        { type: 'image_url', image_url: { url: state.attachment.dataUrl } },
        { type: 'image', dataUrl: state.attachment.dataUrl, mime: state.attachment.mime, name: state.attachment.name }
      ];
    }
    if (state.attachment && state.attachment.kind === 'audio') {
      return [{ type: 'text', text: text }, { type: 'audio', dataUrl: state.attachment.dataUrl, mime: state.attachment.mime, name: state.attachment.name }];
    }
    return text;
  }
  function plainText(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map(function (p) { return p.text || ('[' + (p.type || 'attachment') + ']'); }).join(' ');
    return String(content || '');
  }

  function hasSelectionInside(el) {
    if (!el) return false;
    try {
      var sel = window.getSelection ? window.getSelection() : null;
      if (!sel || sel.isCollapsed || !sel.toString()) return false;
      var anchor = sel.anchorNode;
      if (!anchor) return false;
      return anchor === el || el.contains(anchor);
    } catch (e) { return false; }
  }
  function addMessageEl(role, label, rawText) {
    var wrap = $('messages');
    var el = document.createElement('div');
    el.className = 'msg ' + role;
    var headEl = document.createElement('div'); headEl.className = 'msg-head';
    var labelEl = document.createElement('span'); labelEl.textContent = label;
    var actionsEl = document.createElement('span'); actionsEl.className = 'msg-actions';
    if (role === 'assistant') { var speakBtnEl = document.createElement('button'); speakBtnEl.type = 'button'; speakBtnEl.className = 'mini-btn'; speakBtnEl.setAttribute('data-act', 'speak'); speakBtnEl.textContent = 'Read'; actionsEl.appendChild(speakBtnEl); }
    var copyBtnEl = document.createElement('button'); copyBtnEl.type = 'button'; copyBtnEl.className = 'mini-btn'; copyBtnEl.setAttribute('data-act', 'copy'); copyBtnEl.textContent = 'Copy'; actionsEl.appendChild(copyBtnEl);
    headEl.appendChild(labelEl); headEl.appendChild(actionsEl); el.appendChild(headEl);
    var bodyDivEl = document.createElement('div'); bodyDivEl.className = 'body'; el.appendChild(bodyDivEl);
    el.querySelector('[data-act="copy"]').addEventListener('click', function () {
      var sel = null;
      try { sel = window.getSelection ? window.getSelection() : null; } catch (e) { sel = null; }
      var selected = hasSelectionInside(el) && sel ? String(sel.toString()) : '';
      var t = selected || el.dataset.raw || '';
      if (navigator.clipboard) navigator.clipboard.writeText(t);
      status(selected ? 'Selection copied' : 'Copied');
    });
    var speakBtn = el.querySelector('[data-act="speak"]');
    if (speakBtn) speakBtn.addEventListener('click', function () { speak(el.dataset.raw || ''); });
    wrap.appendChild(el);
    setMessageBody(el, rawText || '');
    return el;
  }
  function setMessageBody(el, rawText) {
    el.dataset.raw = rawText;
    var body = el.querySelector('.body');
    if (window.GraphiteMarkdown) setGeneratedHtml(body, GraphiteMarkdown.render(rawText, markdownOpts())); else body.textContent = rawText;
    wireCodeButtons(el, rawText);
    scrollBottom();
  }
  function formatMs(ms) {
    if (ms == null || !isFinite(Number(ms))) return '';
    var n = Number(ms);
    if (n < 1000) return Math.round(n) + 'ms';
    return (Math.round(n / 100) / 10).toFixed(1) + 's';
  }
  // Standalone .msg-meta line under the body. Works for single chat
  // (.msg > .body) and group columns (bare .msg without .msg-head).
  function renderMsgMeta(el, stats) {
    if (!el || !stats) return;
    var parts = [];
    if (stats.model) parts.push(String(stats.model));
    if (stats.ttftMs != null) parts.push('TTFT ' + formatMs(stats.ttftMs));
    if (stats.totalMs != null) parts.push('total ' + formatMs(stats.totalMs));
    var existing = el.querySelector('.msg-meta');
    if (!parts.length) { if (existing) existing.remove(); return; }
    var meta = existing || document.createElement('div');
    meta.className = 'msg-meta';
    meta.textContent = parts.join(' \u00B7 ');
    if (!existing) el.appendChild(meta);
  }
  function wireCodeButtons(el, rawText) {
    var blocks = [];
    var re = /```([A-Za-z0-9_+-]*)\n?([\s\S]*?)(?:```|$)/g, m;
    while ((m = re.exec(rawText)) !== null) blocks.push({ lang: (m[1] || '').toLowerCase(), code: m[2] });
    el.querySelectorAll('[data-copy-code]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var b = blocks[Number(btn.getAttribute('data-copy-code'))];
        if (b && navigator.clipboard) navigator.clipboard.writeText(b.code);
        status('Code copied');
      });
    });
    blocks.forEach(function (b, idx) {
      if (b.lang === 'html') {
        var btn = document.createElement('button');
        btn.type = 'button'; btn.className = 'mini-btn'; btn.textContent = 'Preview artifact';
        btn.addEventListener('click', function () { showArtifact(b.code); });
        var wraps = el.querySelectorAll('.code-wrap');
        if (wraps[idx]) wraps[idx].querySelector('.code-head').appendChild(btn);
      }
    });
  }
  function scrollBottom() { var w = $('messages'); w.scrollTop = w.scrollHeight; }
  function speak(text) {
    try {
      if (!('speechSynthesis' in window)) { status('TTS not available'); return; }
      speechSynthesis.cancel();
      var u = new SpeechSynthesisUtterance(String(text).replace(/```[\s\S]*?```/g, ' code block ').slice(0, 4000));
      speechSynthesis.speak(u);
      status('Reading aloud...');
    } catch (e) { status('TTS failed: ' + e.message); }
  }
  function showArtifact(html) {
    state.lastArtifact = html;
    $('artifactFrame').srcdoc = html;
    $('artifactBar').classList.remove('hidden');
    status('Artifact preview loaded');
  }

  /* ---------------- streaming ---------------- */
  function setGenerating(on) {
    state.generating = on;
    $('sendBtn').classList.toggle('hidden', on);
    $('stopBtn').classList.toggle('hidden', !on);
  }
  function newRequestId() {
    return 'chat-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);
  }
  var STREAM_BACKGROUND_TIMEOUT_MS = 90000; // no port message at all (STREAM_BACKGROUND_TIMEOUT_MS = 45000 was the pre-mobile value; widened for Android freezes)
  var STREAM_PROVIDER_IDLE_TIMEOUT_MS = 120000; // no provider activity
  function streamChat(apiMessages, providerId, model, targetEl, onDone) {
    return new Promise(function (resolve) {
      var text = '';
      var port = null;
      try { port = api.runtime.connect({ name: 'graphite-chat' }); }
      catch (e) { if (targetEl) setMessageBody(targetEl, 'Error: ' + e.message); onDone(''); resolve(''); return; }
      state.ports.push(port);
      var bodyEl = targetEl ? targetEl.querySelector('.body') : null;
      if (bodyEl) bodyEl.classList.add('streaming-cursor');
      var finished = false;
      var doneStats = null;
      var lastPortMsgAt = Date.now();
      var lastActivityAt = Date.now();
      var livenessTimer = 0;
      var idleTimer = 0;
      function clearWatchdogs() { clearTimeout(livenessTimer); clearTimeout(idleTimer); }
      function armWatchdogs() {
        clearWatchdogs();
        var now = Date.now();
        livenessTimer = setTimeout(function () {
          finish('Connection to the extension background was lost. Reload the sidebar and try again.');
        }, Math.max(0, STREAM_BACKGROUND_TIMEOUT_MS - (now - lastPortMsgAt)));
        idleTimer = setTimeout(function () {
          finish('Provider stalled: no activity for 120s');
        }, Math.max(0, STREAM_PROVIDER_IDLE_TIMEOUT_MS - (now - lastActivityAt)));
      }
      armWatchdogs();
      function finish(err) {
        if (finished) return; finished = true;
        clearWatchdogs();
        if (bodyEl) bodyEl.classList.remove('streaming-cursor');
        state.ports = state.ports.filter(function (p) { return p !== port; });
        try { port.disconnect(); } catch (e) {}
        if (err && !text) { text = 'Error: ' + err; if (targetEl) setMessageBody(targetEl, text); }
        else if (targetEl && text) setMessageBody(targetEl, text);
        if (targetEl && doneStats) renderMsgMeta(targetEl, doneStats);
        onDone(text); resolve(text);
      }
      port.onMessage.addListener(function (msg) {
        if (!msg) return;
        lastPortMsgAt = Date.now();
        // Background heartbeat: proof the request is alive while a slow
        // provider (e.g. 9Router + reasoning model) produces nothing yet.
        // Never rendered, never appended to the answer text.
        if (msg.type === 'ping') {
          // Any port message proves background liveness; only fresh
          // provider activity (chunk, or streaming with recent
          // lastActivityMs) resets the 120s inactivity watchdog.
          if (msg.stage === 'streaming' &&
              (typeof msg.lastActivityMs !== 'number' || msg.lastActivityMs <= 30000)) {
            lastActivityAt = Date.now() - (typeof msg.lastActivityMs === 'number' ? msg.lastActivityMs : 0);
          }
          armWatchdogs();
          if (!text && msg.stage === 'waiting') status('Waiting for the model...');
          else if (!text && msg.stage === 'streaming') status('Generating...');
          return;
        }
        if (msg.type === 'chunk') {
          lastActivityAt = Date.now(); armWatchdogs();
          text += msg.text || ''; if (targetEl && !hasSelectionInside(targetEl)) setMessageBody(targetEl, text);
        }
        else if (msg.type === 'done') {
          doneStats = {
            model: msg.model || model || '',
            ttftMs: (typeof msg.ttftMs === 'number' ? msg.ttftMs : null),
            totalMs: (typeof msg.totalMs === 'number' ? msg.totalMs : null)
          };
          finish(null);
        }
        else if (msg.type === 'error') finish(msg.message || msg.error || 'Stream error');
        else armWatchdogs();
      });
      port.onDisconnect.addListener(function () {
        var err = (api.runtime.lastError && api.runtime.lastError.message) || null;
        if (text) finish(null); else finish(state.stopRequested ? null : err);
        if (!text && state.stopRequested) { text = text || ''; onDone(text); resolve(text); }
      });
      try { port.postMessage({ type: 'start', requestId: newRequestId(), messages: apiMessages, providerId: providerId, model: model }); }
      catch (e) { finish(e.message); }
    });
  }
  function chatSyncFallback(apiMessages, providerId, model, targetEl) {
    var syncStartedAt = Date.now();
    return sendMessage({ type: 'chatSync', messages: apiMessages, providerId: providerId, model: model }).then(function (r) {
      var text = typeof r === 'string' ? r : (r && (r.text || r.content || (r.message && r.message.content))) || '';
      if (!text && r && r.error) text = 'Error: ' + r.error;
      if (targetEl) setMessageBody(targetEl, text);
      // No streaming here, so TTFT == total: show total only.
      if (targetEl && text && text.indexOf('Error:') !== 0) {
        renderMsgMeta(targetEl, { model: (r && r.model) || model || '', totalMs: Date.now() - syncStartedAt });
      }
      return text;
    }).catch(function (e) { var t = 'Error: ' + e.message; if (targetEl) setMessageBody(targetEl, t); return t; });
  }
  function runStreamOrSync(apiMessages, providerId, model, targetEl) {
    // Try streaming port; if it yields nothing and not stopped, caller may fallback.
    return streamChat(apiMessages, providerId, model, targetEl, function () {});
  }

  function persistConversation() {
    if (!state.messages.length) return Promise.resolve();
    if (!state.conversationId) state.conversationId = uid();
    var title = plainText(state.messages.find(function (m) { return m.role === 'user'; }) ? state.messages.find(function (m) { return m.role === 'user'; }).content : 'Chat').slice(0, 60) || 'Chat';
    return storageGet('graphite_history').then(function (o) {
      var hist = Array.isArray(o.graphite_history) ? o.graphite_history : [];
      var entry = { id: state.conversationId, title: title, updatedAt: Date.now(), messages: state.messages.map(function (m) { return { role: m.role, content: typeof m.content === 'string' ? m.content : plainText(m.content) }; }) };
      hist = hist.filter(function (h) { return h.id !== entry.id; });
      hist.unshift(entry);
      return storageSet({ graphite_history: hist.slice(0, 100) });
    }).catch(function () {});
  }

  function sendCurrent(overrideText, opts) {
    opts = opts || {};
    var text = (overrideText != null ? overrideText : $('composer').value).trim();
    if (!text && !state.attachment) { status('Type a message first'); return Promise.resolve(); }
    if (!opts.keepComposer && overrideText == null) $('composer').value = '';
    hideSlash();
    switchView('chat');

    if (state.groupMode && !opts.single) return sendGroup(text);
    if (!state.providers.length) { status('No provider configured - open Settings'); $('noProviderBanner').classList.remove('hidden'); return Promise.resolve(); }

    var content = userContentFor(text || 'Describe this.');
    state.messages.push({ role: 'user', content: content });
    addMessageEl('user', 'You', plainText(content));
    state.attachment = null; $('attachmentPreview').classList.add('hidden');

    var el = addMessageEl('assistant', providerLabel(state.activeProviderId), '');
    setGenerating(true); state.stopRequested = false; status('Generating...');
    var apiMessages = buildApiMessages();
    return runStreamOrSync(apiMessages, state.activeProviderId, state.activeModel, el).then(function (full) {
      if (!full && !state.stopRequested) {
        return chatSyncFallback(apiMessages, state.activeProviderId, state.activeModel, el);
      }
      return full;
    }).then(function (full) {
      state.messages.push({ role: 'assistant', content: full || '' });
      setGenerating(false); status('Ready');
      persistConversation();
    });
  }

  function sendGroup(text) {
    var combos = selectedGroupCombos(text);
    if (combos.length < 2) { status('Group chat needs 2-4 checked models (or @mention matching models)'); if (combos.length === 1) { /* fall through single */ } else return Promise.resolve(); }
    var content = userContentFor(text);
    state.messages.push({ role: 'user', content: content });
    addMessageEl('user', 'You (group)', plainText(content));
    state.attachment = null; $('attachmentPreview').classList.add('hidden');

    var wrap = document.createElement('div');
    wrap.className = 'group-compare';
    $('messages').appendChild(wrap);
    setGenerating(true); state.stopRequested = false; status('Group generating (' + combos.length + ' models)...');

    var apiMessages = buildApiMessages();
    var results = combos.map(function () { return ''; });
    var promises = combos.map(function (combo, i) {
      var col = document.createElement('div'); col.className = 'group-col';
      var colHead = document.createElement('h4'); colHead.textContent = combo.label; col.appendChild(colHead);
      wrap.appendChild(col);
      var el = document.createElement('div'); el.className = 'msg assistant'; var elBody = document.createElement('div'); elBody.className = 'body'; el.appendChild(elBody);
      col.appendChild(el);
      return streamChat(apiMessages, combo.providerId, combo.model, el, function () {}).then(function (full) {
        if (!full && !state.stopRequested) return chatSyncFallback(apiMessages, combo.providerId, combo.model, el);
        return full;
      }).then(function (full) { results[i] = full || ''; el.dataset.raw = full || ''; return full; });
    });

    return Promise.all(promises).then(function () {
      state.groupResults = combos.map(function (c, i) { return { label: c.label, providerId: c.providerId, model: c.model, text: results[i] }; });
      state.messages.push({ role: 'assistant', content: state.groupResults.map(function (r) { return '### ' + r.label + '\n' + r.text; }).join('\n\n') });
      // Synthesize button
      var bar = document.createElement('div'); bar.className = 'row';
      var btn = document.createElement('button'); btn.type = 'button'; btn.className = 'btn primary small'; btn.textContent = 'Synthesize answers';
      btn.addEventListener('click', synthesizeGroup);
      bar.appendChild(btn); wrap.appendChild(bar);
      setGenerating(false); status('Group done - ' + combos.length + ' answers');
      persistConversation();
    });
  }
  function synthesizeGroup() {
    if (!state.groupResults.length) return;
    var joined = state.groupResults.map(function (r) { return '## ' + r.label + '\n' + r.text; }).join('\n\n');
    var prompt = 'Synthesize the following model answers into one best answer. Resolve contradictions, keep key details, be concise.\n\n' + joined;
    state.messages.push({ role: 'user', content: 'Synthesize group answers' });
    addMessageEl('user', 'You', 'Synthesize group answers');
    var el = addMessageEl('assistant', 'Synthesis - ' + providerLabel(state.activeProviderId), '');
    setGenerating(true); state.stopRequested = false;
    var msgs = buildApiMessages(); msgs.push({ role: 'user', content: prompt });
    // avoid double-counting last user msg is fine; prompt is explicit
    streamChat(msgs, state.activeProviderId, state.activeModel, el, function () {}).then(function (full) {
      if (!full && !state.stopRequested) return chatSyncFallback(msgs, state.activeProviderId, state.activeModel, el);
      return full;
    }).then(function (full) {
      state.messages.push({ role: 'assistant', content: full || '' });
      setGenerating(false); status('Synthesis ready'); persistConversation();
    });
  }

  function stopGeneration() {
    state.stopRequested = true;
    state.ports.slice().forEach(function (p) { try { p.disconnect(); } catch (e) {} });
    state.ports = [];
    setGenerating(false);
    status('Stopped');
  }

  /* ---------------- prompts ---------------- */
  /* ---- Rewrite tones: shared source of truth lives in lib/prompts.js
   * (GraphitePrompts.REWRITE_TONES + rewriteTonePrompt). Only the inline
   * fallback below duplicates tone data, and only for the (currently
   * impossible) case where lib/prompts.js failed to load. ---- */
  function rewriteTones() {
    try {
      if (window.GraphitePrompts && Array.isArray(GraphitePrompts.REWRITE_TONES) && GraphitePrompts.REWRITE_TONES.length) {
        return GraphitePrompts.REWRITE_TONES.map(function (t) {
          return { id: t.id, label: t.label || t.name || t.id };
        });
      }
    } catch (e) {}
    return [
      { id: 'neutral', label: 'Neutral (default)' }, { id: 'professional', label: 'Professional' },
      { id: 'formal', label: 'Formal' }, { id: 'casual', label: 'Casual' }, { id: 'friendly', label: 'Friendly' },
      { id: 'confident', label: 'Confident' }, { id: 'polite', label: 'Polite' }, { id: 'empathetic', label: 'Empathetic' },
      { id: 'witty', label: 'Witty' }, { id: 'academic', label: 'Academic' }, { id: 'creative', label: 'Creative' },
      { id: 'persuasive', label: 'Persuasive' }, { id: 'concise', label: 'Concise' },
      { id: 'expanded', label: 'Expanded / Elaborate' }, { id: 'simplify', label: 'Simplify (plain English)' }
    ];
  }
  // Resolve 'rewrite-<tone>' ids produced by background context menus.
  function rewriteToneIdFromActionId(raw) {
    var s = String(raw == null ? '' : raw);
    var m = s.match(/^rewrite-([a-z-]+)$/i);
    if (!m) return '';
    var tones = rewriteTones();
    for (var i = 0; i < tones.length; i++) if (tones[i].id === m[1].toLowerCase()) return tones[i].id;
    return '';
  }
  // Prompt for a rewrite; uses the shared renderer when available.
  function rewritePromptFor(toneId, text, customTone) {
    var tones = rewriteTones();
    var id = String(toneId || 'neutral').toLowerCase();
    var known = tones.some(function (t) { return t.id === id; });
    try {
      if (window.GraphitePrompts && typeof GraphitePrompts.rewriteTonePrompt === 'function') {
        return GraphitePrompts.rewriteTonePrompt(known ? id : (customTone ? 'custom' : 'neutral'),
          { text: text, customTone: customTone || '' });
      }
    } catch (e) {}
    // Fallback only (lib/prompts.js missing): same shape, generic rules.
    var label = known ? tones.filter(function (t) { return t.id === id; })[0].label : 'Neutral (default)';
    var instr = customTone ? ('a tone described as: ' + customTone)
      : ('a ' + label.replace(/ \(.*\)$/, '').toLowerCase() + ' tone');
    return 'Rewrite the following text in ' + instr + '. Preserve the meaning, all facts, names and numbers. Keep roughly the same length. Output only the rewritten text.\n\nText:\n' + text;
  }

  // Default target language: the options page stores it as a display name
  // (e.g. "Spanish") under settings.targetLang; also accept the flattened
  // synonyms other contexts use so a pending action fired before settings
  // finish loading still defaults correctly.
  function defaultTargetLang() {
    var s = state.settings || {};
    var ui = (s.settings && typeof s.settings === 'object') ? s.settings : s;
    return String(ui.targetLang || s.targetLang || ui.translateLanguage || s.translateLanguage || ui.targetLanguage || s.targetLanguage || 'English').trim() || 'English';
  }
  // User-configured display names from settings.translationLanguages win;
  // same access pattern as defaultTargetLang() (settings may be nested
  // under settings.settings or flattened on state.settings). Falls back
  // to the hardcoded list (same display names as options LANGUAGES,
  // de-duplicated and without the leading "" (Auto) entry) when the
  // configured list is missing/empty. The default target language is
  // always included (prepended if missing).
  function translateLanguages() {
    var fallback = ["English", "Spanish", "French", "German", "Italian", "Portuguese", "Portuguese (Brazil)", "Dutch", "Swedish", "Norwegian", "Norwegian Bokmål", "Danish", "Finnish", "Icelandic", "Polish", "Czech", "Slovak", "Hungarian", "Romanian", "Bulgarian", "Croatian", "Serbian", "Slovenian", "Ukrainian", "Russian", "Greek", "Turkish", "Arabic", "Persian", "Hebrew", "Urdu", "Hindi", "Bengali", "Tamil", "Telugu", "Marathi", "Gujarati", "Kannada", "Malayalam", "Thai", "Vietnamese", "Indonesian", "Malay", "Filipino", "Chinese (Simplified)", "Chinese (Traditional)", "Japanese", "Korean", "Swahili", "Amharic", "Yoruba", "Igbo", "Hausa", "Estonian", "Latvian", "Lithuanian", "Catalan", "Basque", "Galician", "Afrikaans", "Punjabi", "Nepali", "Sinhala", "Khmer", "Lao", "Burmese", "Mongolian", "Welsh", "Irish", "Albanian", "Macedonian", "Bosnian"];
    var s = state.settings || {};
    var ui = (s.settings && typeof s.settings === 'object') ? s.settings : s;
    var configured = Array.isArray(ui.translationLanguages) ? ui.translationLanguages
      : (Array.isArray(s.translationLanguages) ? s.translationLanguages : null);
    var source = (configured && configured.length) ? configured : fallback;
    var list = [];
    source.forEach(function (name) {
      var v = String(name == null ? '' : name).trim();
      if (v && list.indexOf(v) === -1) list.push(v);
    });
    if (!list.length) {
      fallback.forEach(function (name) { if (list.indexOf(name) === -1) list.push(name); });
    }
    var def = defaultTargetLang();
    if (def && list.indexOf(def) === -1) list.unshift(def);
    return list;
  }
  var TRANSLATE_CUSTOM_LANG = '__custom__';
  function translateSelOptions(selected) {
    var langs = translateLanguages();
    var sel = String(selected || defaultTargetLang() || 'English').trim();
    var html = langs.map(function (name) {
      return '<option value="' + esc(name) + '"' + (name === sel ? ' selected' : '') + '>' + esc(name) + '</option>';
    }).join('');
    if (sel && langs.indexOf(sel) === -1) {
      html += '<option value="' + esc(sel) + '" selected>' + esc(sel) + '</option>';
    }
    html += '<option value="' + TRANSLATE_CUSTOM_LANG + '">Other (type below)…</option>';
    return html;
  }
  function toolTranslateLang() {
    var selEl = $('tLangSel');
    if (!selEl) return defaultTargetLang();
    if (selEl.value === TRANSLATE_CUSTOM_LANG) {
      var customEl = $('tLangCustom');
      var custom = customEl ? customEl.value.trim() : '';
      return custom || 'English';
    }
    return (selEl.value || 'English').trim() || 'English';
  }

  function builtinPrompts() {
    try {
      if (window.GraphitePrompts) {
        var P = window.GraphitePrompts;
        var list = P.BUILTIN_PROMPTS || P.BUILTIN || P.builtin || P.prompts || P.defaultPrompts || (typeof P.listPrompts === 'function' ? P.listPrompts(state.settings || {}) : null) || (typeof P.list === 'function' ? P.list() : null);
        if (Array.isArray(list)) return list.map(normalizePrompt);
      }
    } catch (e) {}
    var defaultLang = defaultTargetLang();
    return [
      { id: 'b-summarize', name: 'Summarize', body: 'Summarize the following in concise bullet points:\n\n{{input}}', builtin: true },
      { id: 'b-explain', name: 'Explain simply', body: 'Explain this like I am 12, with one example:\n\n{{input}}', builtin: true },
      { id: 'b-translate', name: 'Translate to ' + defaultLang, body: 'Translate to ' + defaultLang + ', preserve tone:\n\n{{input}}', builtin: true },
      { id: 'b-grammar', name: 'Fix grammar', body: 'Fix grammar and punctuation. Return corrected text, then brief notes:\n\n{{input}}', builtin: true },
      { id: 'b-code', name: 'Explain code', body: 'Explain this code step by step and note bugs:\n\n{{input}}', builtin: true }
    ];
  }
  function normalizePrompt(p) {
    return { id: p.id || uid(), name: p.name || p.title || 'Prompt', body: p.body || p.prompt || p.text || '', builtin: !!p.builtin };
  }
  function customPrompts() {
    return storageGet('graphite_custom_prompts').then(function (o) { return Array.isArray(o.graphite_custom_prompts) ? o.graphite_custom_prompts.map(normalizePrompt) : []; }).catch(function () { return []; });
  }
  function allPrompts() {
    return customPrompts().then(function (c) { return builtinPrompts().concat(c); });
  }
  function applyPrompt(p, input) {
    var body = p.body || '';
    if (body.indexOf('{{input}}') !== -1) body = body.replace(/\{\{input\}\}/g, input || '');
    else if (input) body = body + '\n\n' + input;
    return body;
  }
  /* Dropdown confinement: prompts (builtin + custom) are rendered ONLY as
     <option>s inside the closed #promptSelect; a body appears only in the
     editor textarea when that entry is selected for editing. The legacy
     #promptList container is kept only as an (always-hidden) empty note. */
  var selectedPromptId = null;
  var cachedPrompts = [];
  function promptById(id) { return cachedPrompts.find(function (x) { return x.id === id; }) || null; }
  function renderPrompts() {
    allPrompts().then(function (list) {
      cachedPrompts = list;
      var sel = $('promptSelect');
      var box = $('promptList');
      if (box) { box.textContent = ''; box.classList.add('hidden'); }
      if (!sel) return;
      var want = (selectedPromptId && promptById(selectedPromptId)) ? selectedPromptId
        : (sel.value && promptById(sel.value)) ? sel.value
        : (list.length ? list[0].id : '');
      selectedPromptId = want || null;
      sel.textContent = '';
      list.forEach(function (p) {
        var o = document.createElement('option');
        o.value = p.id; o.textContent = p.name + (p.builtin ? ' (builtin)' : ' (custom)');
        sel.appendChild(o);
      });
      sel.value = selectedPromptId || '';
      updatePromptActions();
    });
  }
  function updatePromptActions() {
    var p = promptById(selectedPromptId) || promptById($('promptSelect') ? $('promptSelect').value : '');
    if (p) selectedPromptId = p.id;
    var insert = $('promptInsertBtn'), edit = $('promptEditBtn'), del = $('promptDeleteBtn'), st = $('promptStatus');
    if (insert) insert.disabled = !p;
    if (edit) edit.disabled = !p || !!p.builtin;
    if (del) del.disabled = !p || !!p.builtin;
    if (st) st.textContent = p ? ('Selected: ' + p.name + (p.builtin ? ' (builtin)' : ' (custom)')) : 'No prompts';
  }
  function editSelectedPrompt() {
    var p = promptById(selectedPromptId) || promptById($('promptSelect') ? $('promptSelect').value : '');
    if (!p || p.builtin) return;
    state.editingPromptId = p.id; $('promptName').value = p.name; $('promptBody').value = p.body; $('promptForm').classList.remove('hidden');
  }
  function deleteSelectedPrompt() {
    var p = promptById(selectedPromptId) || promptById($('promptSelect') ? $('promptSelect').value : '');
    if (!p || p.builtin) return;
    customPrompts().then(function (c) { return storageSet({ graphite_custom_prompts: c.filter(function (x) { return x.id !== p.id; }) }); }).then(function () { selectedPromptId = null; renderPrompts(); });
  }
  function insertSelectedPrompt() {
    var p = promptById(selectedPromptId) || promptById($('promptSelect') ? $('promptSelect').value : '');
    if (p) insertPromptIntoComposer(p);
  }
  function insertPromptIntoComposer(p) {
    switchView('chat');
    var cur = $('composer').value;
    // Lib translate prompt carries {{lang}}: resolve it to the settings
    // default so inserting it never leaves a placeholder or forces English.
    var body = String(p.body || '').replace(/\{\{\s*lang\s*\}\}/g, defaultTargetLang());
    var curText = cur.trim();
    // If composer has text and prompt has placeholder, fill it; else insert prompt body
    if (curText && body.indexOf('{{input}}') !== -1) $('composer').value = applyPrompt({ id: p.id, name: p.name, body: body, builtin: p.builtin }, curText);
    else if (curText && /\{\{(?:text|selection)\}\}/.test(body)) $('composer').value = body.replace(/\{\{(?:text|selection)\}\}/g, curText);
    else $('composer').value = (cur ? cur + '\n' : '') + body;
    $('composer').focus();
    status('Prompt inserted: ' + p.name);
  }
  function saveCustomPrompt() {
    var name = $('promptName').value.trim(), body = $('promptBody').value.trim();
    if (!name || !body) { status('Prompt needs name and body'); return; }
    customPrompts().then(function (c) {
      if (state.editingPromptId) {
        c = c.map(function (x) { return x.id === state.editingPromptId ? { id: x.id, name: name, body: body } : x; });
      } else c.push({ id: uid(), name: name, body: body });
      return storageSet({ graphite_custom_prompts: c });
    }).then(function () {
      state.editingPromptId = null; $('promptName').value = ''; $('promptBody').value = ''; $('promptForm').classList.add('hidden'); renderPrompts(); status('Prompt saved');
    });
  }

  /* slash autocomplete */
  function hideSlash() { $('slashPopup').classList.add('hidden'); }
  function checkSlash() {
    var v = $('composer').value;
    var caret = $('composer').selectionStart || v.length;
    var before = v.slice(0, caret);
    var m = before.match(/(?:^|\n)\/([^\n/]*)$/);
    if (!m) { hideSlash(); return; }
    var query = m[1].toLowerCase();
    allPrompts().then(function (list) {
      var hits = list.filter(function (p) { return p.name.toLowerCase().indexOf(query) !== -1; }).slice(0, 8);
      var pop = $('slashPopup');
      if (!hits.length) { hideSlash(); return; }
      pop.textContent = ''; state.slashIndex = 0;
      hits.forEach(function (p, i) {
        var el = document.createElement('div'); el.className = 'slash-item' + (i === 0 ? ' selected' : '');
        var strongEl = document.createElement('strong'); strongEl.textContent = '/' + p.name; el.appendChild(strongEl);
        el.addEventListener('click', function () { pickSlash(p); });
        pop.appendChild(el);
      });
      pop.classList.remove('hidden');
      pop._hits = hits;
    });
  }
  function pickSlash(p) {
    var v = $('composer').value;
    var caret = $('composer').selectionStart || v.length;
    var before = v.slice(0, caret).replace(/(?:^|\n)\/[^\n/]*$/, function (mm) { return mm.charAt(0) === '\n' ? '\n' : ''; });
    $('composer').value = before + p.body + v.slice(caret);
    hideSlash(); $('composer').focus();
  }

  /* ---------------- history ---------------- */
  function renderHistory() {
    storageGet('graphite_history').then(function (o) {
      var hist = Array.isArray(o.graphite_history) ? o.graphite_history : [];
      var box = $('historyList'); box.textContent = '';
      if (!hist.length) { box.appendChild(emptyNoteEl('No conversations yet')); return; }
      hist.forEach(function (h) {
        var el = document.createElement('div'); el.className = 'list-item';
        var rowEl = document.createElement('div'); rowEl.className = 'row-between';
        var titleEl = document.createElement('strong'); titleEl.textContent = h.title || 'Chat';
        var btnSpan = document.createElement('span');
        var loadBtn = document.createElement('button'); loadBtn.type = 'button'; loadBtn.className = 'mini-btn'; loadBtn.setAttribute('data-a', 'load'); loadBtn.textContent = 'Load';
        var delBtn = document.createElement('button'); delBtn.type = 'button'; delBtn.className = 'mini-btn'; delBtn.setAttribute('data-a', 'del'); delBtn.textContent = 'Delete';
        btnSpan.appendChild(loadBtn); btnSpan.appendChild(document.createTextNode(' ')); btnSpan.appendChild(delBtn);
        rowEl.appendChild(titleEl); rowEl.appendChild(btnSpan); el.appendChild(rowEl);
        var descEl = document.createElement('div'); descEl.className = 'desc'; descEl.textContent = new Date(h.updatedAt || 0).toLocaleString() + ' - ' + ((h.messages || []).length) + ' messages'; el.appendChild(descEl);
        el.querySelector('[data-a="load"]').addEventListener('click', function () { loadConversation(h); });
        el.querySelector('[data-a="del"]').addEventListener('click', function () {
          storageGet('graphite_history').then(function (oo) {
            var list = (oo.graphite_history || []).filter(function (x) { return x.id !== h.id; });
            return storageSet({ graphite_history: list });
          }).then(renderHistory);
        });
        box.appendChild(el);
      });
    });
  }
  function loadConversation(h) {
    state.conversationId = h.id;
    state.messages = (h.messages || []).map(function (m) { return { role: m.role, content: m.content }; });
    var box = $('messages'); box.textContent = '';
    state.messages.forEach(function (m) { addMessageEl(m.role === 'user' ? 'user' : 'assistant', m.role === 'user' ? 'You' : 'Assistant', plainText(m.content)); });
    switchView('chat'); status('Loaded: ' + (h.title || 'Chat'));
  }
  function newChat() {
    stopGeneration();
    state.messages = []; state.conversationId = null; state.groupResults = [];
    var msgBox = $('messages'); msgBox.textContent = ''; msgBox.appendChild(emptyNoteEl('New chat. Attach a page, file, or ask anything.'));
    switchView('chat'); status('New chat');
  }

  /* ---------------- tools ---------------- */
  var TOOLS = [
    { id: 'summarize-page', name: 'Summarize Page', desc: 'Summarize current tab', form: 'page', cat: 'Read' },
    { id: 'youtube', name: 'YouTube Summary', desc: 'Transcript summary + chapters', form: 'youtube', cat: 'Read' },
    { id: 'translate', name: 'Translate', desc: 'Text translation', form: 'translate', cat: 'Read' },
    { id: 'ocr', name: 'OCR Image', desc: 'Extract text from image', form: 'ocr', cat: 'Read' },
    { id: 'chatpdf', name: 'ChatPDF', desc: 'Ask a PDF', form: 'pdf', cat: 'Read' },
    { id: 'vision', name: 'Chat with Image', desc: 'Vision Q&A', form: 'vision', cat: 'Read' },
    { id: 'audio', name: 'Audio Transcribe', desc: 'Transcribe + summarize', form: 'audio', cat: 'Read' },
    { id: 'grammar', name: 'Grammar Checker', desc: 'Fix grammar', form: 'text', cat: 'Write', prompt: 'Fix grammar and punctuation. Return corrected text first, then brief notes on changes:\n\n{{input}}' },
    { id: 'rewrite', name: 'Rewrite / Tone', desc: 'Rewrite in a tone', form: 'rewrite', cat: 'Write' },
    { id: 'outline', name: 'Outline Composer', desc: 'Structured outline', form: 'text', cat: 'Write', prompt: 'Create a detailed hierarchical outline on this topic. Use headings and bullet points:\n\n{{input}}' },
    { id: 'essay', name: 'Essay Writer', desc: 'Draft an essay', form: 'essay', cat: 'Write' },
    { id: 'imagegen', name: 'Image Generator', desc: 'Generate an image', form: 'imagegen', cat: 'Create' },
    { id: 'tts', name: 'TTS Read Aloud', desc: 'Read text aloud', form: 'tts', cat: 'Create' },
    { id: 'websearch', name: 'Web Search Answer', desc: 'Answer from a search tab', form: 'websearch', cat: 'Data' },
    { id: 'data', name: 'Data Analysis', desc: 'Paste CSV and ask', form: 'data', cat: 'Data' },
    { id: 'mindmap', name: 'Mind Map', desc: 'Mermaid mind map', form: 'text', cat: 'Create', prompt: 'Create a Mermaid mindmap diagram for this topic. Output only a ```mermaid code block using mindmap syntax:\n\n{{input}}' },
    { id: 'artifacts', name: 'Artifacts', desc: 'HTML artifact preview', form: 'artifact', cat: 'Create' }
  ];
  var TOOL_CATS = ['Read', 'Write', 'Create', 'Data'];
  var TOOL_FAV_GROUP = 'Favorites';
  function isToolFav(id) { return state.toolFavorites.indexOf(id) !== -1; }
  function loadToolFavorites() {
    return storageGet(TOOL_FAVORITES_KEY).then(function (o) {
      var list = o && o[TOOL_FAVORITES_KEY];
      state.toolFavorites = Array.isArray(list) ? list.filter(function (id) { return typeof id === 'string'; }) : [];
    }).catch(function () { state.toolFavorites = []; });
  }
  function saveToolFavorites() {
    var payload = {};
    payload[TOOL_FAVORITES_KEY] = state.toolFavorites.slice();
    return storageSet(payload).catch(function () {});
  }
  function toggleToolFavorite(id) {
    var at = state.toolFavorites.indexOf(id);
    if (at === -1) state.toolFavorites.push(id); else state.toolFavorites.splice(at, 1);
    saveToolFavorites();
    renderTools();
  }
  function toolCard(tool) {
    var fav = isToolFav(tool.id);
    var b = document.createElement('button'); b.type = 'button'; b.className = 'tool-card' + (state.selectedToolId === tool.id ? ' selected' : '');
    var cardName = document.createElement('strong'); cardName.textContent = tool.name;
    var cardDesc = document.createElement('span'); cardDesc.textContent = tool.desc;
    var star = document.createElement('span'); star.className = 'tool-fav' + (fav ? ' on' : '');
    star.textContent = fav ? '\u2605' : '\u2606';
    star.setAttribute('role', 'button');
    star.setAttribute('aria-label', fav ? ('Remove ' + tool.name + ' from favorites') : ('Add ' + tool.name + ' to favorites'));
    star.title = fav ? 'Remove from favorites' : 'Add to favorites';
    star.addEventListener('click', function (e) { e.stopPropagation(); toggleToolFavorite(tool.id); });
    b.appendChild(star); b.appendChild(cardName); b.appendChild(cardDesc);
    b.addEventListener('click', function () { state.selectedToolId = tool.id; renderTools(); openTool(tool); });
    return b;
  }
  function toolCategoryHeading(text) {
    var h = document.createElement('div'); h.className = 'tool-cat'; h.textContent = text; return h;
  }
  function renderTools() {
    var grid = $('toolGrid'); if (!grid) return;
    grid.textContent = '';
    var query = ($('toolsSearch') ? $('toolsSearch').value : '').trim().toLowerCase();
    var matches = TOOLS.filter(function (t) {
      return !query || (t.name + ' ' + t.desc + ' ' + t.cat).toLowerCase().indexOf(query) !== -1;
    });
    if (!matches.length) { grid.appendChild(emptyNoteEl('No tools match "' + query + '".')); return; }
    var shown = {};
    if (!query) {
      var favTools = matches.filter(function (t) { return isToolFav(t.id); });
      if (favTools.length) {
        grid.appendChild(toolCategoryHeading(TOOL_FAV_GROUP));
        favTools.forEach(function (t) { grid.appendChild(toolCard(t)); shown[t.id] = true; });
      }
    }
    TOOL_CATS.forEach(function (cat) {
      var group = matches.filter(function (t) { return t.cat === cat && !shown[t.id]; });
      if (!group.length) return;
      grid.appendChild(toolCategoryHeading(cat));
      group.forEach(function (t) { grid.appendChild(toolCard(t)); shown[t.id] = true; });
    });
    matches.forEach(function (t) {
      if (!shown[t.id]) grid.appendChild(toolCard(t));
    });
  }
  function runToolPrompt(prompt) { switchView('chat'); return sendCurrent(prompt, { single: true }); }
  function openTool(tool) {
    var panel = $('toolPanel'); panel.classList.remove('hidden');
    var h = '<h3>' + esc(tool.name) + '</h3>';
    function ta(id, ph, rows) { return '<textarea id="' + id + '" rows="' + (rows || 4) + '" placeholder="' + esc(ph) + '"></textarea>'; }
    function btn(id, label, cls) { return '<button type="button" class="btn ' + (cls || 'primary') + ' small" id="' + id + '">' + esc(label) + '</button>'; }
    if (tool.form === 'page') {
      setGeneratedHtml(panel, h + '<div class="muted small">Uses extractPage on the current tab.</div><div class="row">' + btn('tGo', 'Summarize current page') + '</div>');
      $('tGo').addEventListener('click', function () { attachPage().then(function () { runToolPrompt('Summarize this page: key points, main argument, and action items.'); }); });
    } else if (tool.form === 'youtube') {
      setGeneratedHtml(panel, h + '<input type="text" id="tUrl" placeholder="YouTube URL or video ID (blank = current tab)">' +
        '<label class="toggle"><input type="checkbox" id="tBilingual"> Bilingual subtitles note (include original + translation guidance)</label>' +
        '<div class="row">' + btn('tSum', 'Summarize') + btn('tChap', 'Chapters', '') + '</div><div class="muted small">Bilingual mode asks the model to keep key original-language quotes with translations.</div>');
      var go = function (mode) {
        attachYouTube($('tUrl').value.trim() || undefined).then(function () {
          var extra = $('tBilingual').checked ? '\n\nInclude bilingual notes: quote key original-language lines and give translations.' : '';
          var transcript = state.ytTranscript || state.contextText || '';
          if (!transcript) throw new Error('Transcript unavailable');
          if (mode === 'chapters') {
            var title = (state.currentTab && state.currentTab.title) || '';
            var chTpl = (window.GraphitePrompts && GraphitePrompts.getBuiltin('youtube-chapters')) ? GraphitePrompts.getBuiltin('youtube-chapters').body : 'From this timestamped YouTube transcript, produce a chapter list only.\nOutput one line per chapter: `MM:SS — Chapter title` covering the whole video, 4-12 chapters. Use timestamps present in the transcript.\nTitle: {{title}}\n\nTranscript:\n{{transcript}}';
            var chPrompt = window.GraphitePrompts ? GraphitePrompts.renderPrompt(chTpl, { title: title, transcript: transcript }) : chTpl.replace('{{title}}', title).replace('{{transcript}}', transcript);
            runToolPrompt(chPrompt + extra);
          } else {
            var built = window.GraphiteYouTube && typeof GraphiteYouTube.buildYouTubeSummaryPrompt === 'function'
              ? GraphiteYouTube.buildYouTubeSummaryPrompt(transcript, (state.currentTab && state.currentTab.title) || '')
              : transcript;
            runToolPrompt(built + extra);
          }
        }).catch(function (e) { status('YouTube failed: ' + (e && e.message || e)); });
      };
      $('tSum').addEventListener('click', function () { go('summary'); });
      $('tChap').addEventListener('click', function () { go('chapters'); });
    } else if (tool.form === 'translate') {
      var defaultLang = defaultTargetLang();
      setGeneratedHtml(panel, h + ta('tText', 'Text to translate') +
        '<label class="muted small" for="tLangSel">Target language</label>' +
        '<select id="tLangSel">' + translateSelOptions(defaultLang) + '</select>' +
        '<input type="text" id="tLangCustom" class="hidden" placeholder="Target language, e.g. Spanish">' +
        '<div class="row">' + btn('tGo', 'Translate') + '</div>');
      $('tLangSel').addEventListener('change', function () { $('tLangCustom').classList.toggle('hidden', this.value !== TRANSLATE_CUSTOM_LANG); if (this.value === TRANSLATE_CUSTOM_LANG) $('tLangCustom').focus(); });
      $('tGo').addEventListener('click', function () { runToolPrompt('Translate the following to ' + toolTranslateLang() + '. Preserve formatting and tone:\n\n' + $('tText').value); });
    } else if (tool.form === 'ocr' || tool.form === 'vision') {
      var isOcr = tool.form === 'ocr';
      setGeneratedHtml(panel, h + '<input type="file" id="tFile" accept="image/*">' + (isOcr ? '' : ta('tQ', 'Question about the image', 2)) + '<div class="row">' + btn('tGo', isOcr ? 'Extract text' : 'Ask') + '</div>');
      $('tGo').addEventListener('click', function () {
        var f = $('tFile').files[0]; if (!f) { status('Pick an image first'); return; }
        handleImageFile(f).then(function () { runToolPrompt(isOcr ? 'OCR: extract all visible text exactly, preserving layout as much as possible.' : ($('tQ').value.trim() || 'Describe this image in detail.')); });
      });
    } else if (tool.form === 'pdf') {
      setGeneratedHtml(panel, h + '<input type="file" id="tFile" accept="application/pdf,.pdf">' + ta('tQ', 'Question about the PDF', 2) + '<div class="row">' + btn('tGo', 'Ask PDF') + '</div>');
      $('tGo').addEventListener('click', function () {
        var f = $('tFile').files[0]; if (!f) { status('Pick a PDF first'); return; }
        handlePdfFile(f).then(function () { runToolPrompt($('tQ').value.trim() || 'Summarize this PDF document.'); });
      });
    } else if (tool.form === 'audio') {
      setGeneratedHtml(panel, h + '<input type="file" id="tFile" accept="audio/*"><div class="row">' + btn('tGo', 'Transcribe + Summarize') + '</div>');
      $('tGo').addEventListener('click', function () {
        var f = $('tFile').files[0]; if (!f) { status('Pick an audio file first'); return; }
        handleAudioFile(f, true).then(function () { runToolPrompt('Summarize this audio transcript: key points, decisions, and action items.'); });
      });
    } else if (tool.form === 'rewrite') {
      var tones = rewriteTones();
      var opts = tones.map(function (t) {
        return '<option value="' + esc(t.id) + '"' + (t.id === 'professional' ? ' selected' : '') + '>' + esc(t.label) + '</option>';
      }).join('') + '<option value="custom">Custom tone…</option>';
      setGeneratedHtml(panel, h + ta('tText', 'Text to rewrite') +
        '<label class="muted small" for="tToneSel">Tone</label>' +
        '<select id="tToneSel">' + opts + '</select>' +
        '<input type="text" id="tTone" class="hidden" placeholder="Custom tone, e.g. like a friendly pirate captain">' +
        '<div class="row">' + btn('tGo', 'Rewrite') + '</div>' +
        '<div class="muted small">Tone source: lib/prompts.js — REWRITE_TONES (rewrite-&lt;tone&gt; prompts).</div>');
      $('tToneSel').addEventListener('change', function () { $('tTone').classList.toggle('hidden', this.value !== 'custom'); if (this.value === 'custom') $('tTone').focus(); });
      $('tGo').addEventListener('click', function () {
        var textToRewrite = $('tText').value;
        if (!textToRewrite.trim()) { status('Paste text to rewrite first'); return; }
        var toneId = $('tToneSel').value;
        runToolPrompt(rewritePromptFor(toneId, textToRewrite, toneId === 'custom' ? $('tTone').value.trim() : ''));
      });
    } else if (tool.form === 'essay') {
      setGeneratedHtml(panel, h + '<input type="text" id="tTopic" placeholder="Essay topic">' + '<input type="text" id="tLen" placeholder="Length, e.g. 600 words" value="600 words"><div class="row">' + btn('tGo', 'Write essay') + '</div>');
      $('tGo').addEventListener('click', function () { runToolPrompt('Write a well-structured essay (' + ($('tLen').value.trim() || '600 words') + ') on: ' + $('tTopic').value + '. Include introduction, body paragraphs with evidence-style reasoning, and conclusion.'); });
    } else if (tool.form === 'imagegen') {
      setGeneratedHtml(panel, h + ta('tText', 'Image prompt', 3) + '<div class="row">' + btn('tGo', 'Generate image') + '</div><div id="tImg"></div>');
      $('tGo').addEventListener('click', function () {
        var prompt = $('tText').value.trim(); if (!prompt) return;
        status('Generating image...');
        // No `model`: the background resolves the active provider's
        // imageModel; the sidebar text model must not leak into image gen.
        sendMessage({ type: 'generateImage', prompt: prompt, providerId: state.activeProviderId }).then(function (r) {
          var url = '';
          if (typeof r === 'string') url = r;
          else if (r && typeof r === 'object') {
            url = r.dataUrl || r.url || r.image || (r.b64_json ? ('data:image/png;base64,' + r.b64_json) : '') || '';
          }
          if (!url) throw new Error((r && r.error) || 'Background generateImage returned no image');
          var imgWrap = $('tImg'); imgWrap.textContent = ''; var genImg = document.createElement('img'); genImg.alt = ''; genImg.style.cssText = 'max-width:100%;border-radius:8px;margin-top:8px'; genImg.src = url; imgWrap.appendChild(genImg);
          status('Image generated');
        }).catch(function (e) { status('Image generation failed: ' + e.message); });
      });
    } else if (tool.form === 'tts') {
      setGeneratedHtml(panel, h + ta('tText', 'Text to read aloud') + '<div class="row">' + btn('tGo', 'Read aloud') + btn('tStop', 'Stop', '') + '</div>');
      $('tGo').addEventListener('click', function () { speak($('tText').value); });
      $('tStop').addEventListener('click', function () { if ('speechSynthesis' in window) speechSynthesis.cancel(); });
    } else if (tool.form === 'websearch') {
      setGeneratedHtml(panel, h + '<div class="muted small">Open a search results tab, then run this - it extracts that tab via extractPage and answers.</div>' + ta('tQ', 'Question', 2) + '<div class="row">' + btn('tGo', 'Answer from current tab') + '</div>');
      $('tGo').addEventListener('click', function () { attachPage().then(function () { runToolPrompt('Answer using the search/page context above. Cite sources with URLs where present:\n\n' + ($('tQ').value.trim() || 'What are the key findings?')); }); });
    } else if (tool.form === 'data') {
      setGeneratedHtml(panel, h + ta('tCsv', 'Paste CSV data', 6) + ta('tQ', 'Question about the data', 2) + '<div class="row">' + btn('tPreview', 'Preview table', '') + btn('tGo', 'Analyze') + '</div><div id="tTable"></div>');
      $('tPreview').addEventListener('click', function () {
        var rows = $('tCsv').value.trim().split('\n').slice(0, 12).map(function (l) { return l.split(','); });
        var html = '<div class="table-wrap"><table>' + rows.map(function (r, i) { return '<tr>' + r.map(function (c) { return i === 0 ? '<th>' + esc(c) + '</th>' : '<td>' + esc(c) + '</td>'; }).join('') + '</tr>'; }).join('') + '</table></div>';
        setGeneratedHtml($('tTable'), html);
      });
      $('tGo').addEventListener('click', function () { setContext($('tCsv').value, 'CSV data'); runToolPrompt('Analyze this CSV data. ' + ($('tQ').value.trim() || 'Summarize trends, totals, and outliers. Show calculations.')); });
    } else if (tool.form === 'artifact') {
      setGeneratedHtml(panel, h + '<div class="muted small">Paste HTML or ask in chat for a ```html block, then use Preview artifact on the message.</div>' + ta('tHtml', 'HTML artifact', 6) + '<div class="row">' + btn('tGo', 'Preview') + '</div>');
      $('tGo').addEventListener('click', function () { showArtifact($('tHtml').value); });
    } else { // generic text tool
      setGeneratedHtml(panel, h + ta('tText', 'Input') + '<div class="row">' + btn('tGo', 'Run') + '</div>');
      $('tGo').addEventListener('click', function () { runToolPrompt(applyPrompt(tool, $('tText').value)); });
    }
    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  // Open the Tools view with the Translate tool prefilled. Used by pending
  // translate actions so the user picks the language before any model call.
  function openTranslateTool(prefillText) {
    var tool = null;
    TOOLS.forEach(function (t) { if (t.form === 'translate') tool = t; });
    if (!tool) tool = { id: 'translate', name: 'Translate', desc: 'Text translation', form: 'translate' };
    switchView('tools');
    state.selectedToolId = tool.id;
    renderTools();
    openTool(tool);
    if (prefillText != null && $('tText')) $('tText').value = prefillText;
    if ($('tLangSel')) { $('tLangSel').focus(); try { $('tLangSel').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } catch (e) {} }
    status('Choose a target language, then Translate');
  }

  /* ---------------- code (per-site CSS/JS) ---------------- */
  function codeStatus(text) { var el = $('codeStatus'); if (el) el.textContent = text; }
  function refreshCodeHost() {
    var chip = $('codeHost'); if (!chip) return Promise.resolve(null);
    return getActiveTab().then(function (tab) {
      state.currentTab = tab;
      var host = hostOf(tab && tab.url);
      chip.textContent = host || ((tab && tab.title) ? truncate(tab.title, 40) : 'No active tab');
      chip.title = (tab && (tab.title + '\n' + (tab.url || ''))) || '';
      return tab;
    }).catch(function () { chip.textContent = 'No active tab'; return null; });
  }
  function codeGenerate() {
    var btn = $('codeGenerateBtn');
    var request = $('codePrompt').value.trim();
    if (!request) { codeStatus('Describe the change you want first.'); $('codePrompt').focus(); return; }
    if (btn) btn.disabled = true;
    codeStatus('Inspecting page and generating...');
    sendTabCommand('page-outline', {}).catch(function () { return null; }).then(function (outline) {
      return refreshCodeHost().then(function (tab) {
        var prompt = [
          'You restyle web pages with custom CSS and JavaScript (like a userscript).',
          'Page title: ' + ((tab && tab.title) || (outline && outline.title) || ''),
          'Page URL: ' + ((tab && tab.url) || (outline && outline.url) || ''),
          'User request: ' + request,
          '',
          'Page outline (headings, landmarks, interactive elements):',
          truncate(JSON.stringify(outline || {}), 6000),
          '',
          'Return ONLY a JSON object (no prose, no markdown fences): {"css":"...","js":"...","notes":"..."}',
          '- css: a stylesheet applied to the page. Prefer stable selectors from the outline; keep it focused on the request.',
          '- js: plain JavaScript with no imports; only include it when CSS cannot do the job, otherwise use "".',
          '- notes: one short sentence describing what the code does.'
        ].join('\n');
        return chatSyncFallback([{ role: 'user', content: prompt }], state.activeProviderId, state.activeModel, null).then(function (text) {
          if (!text || text.indexOf('Error:') === 0) throw new Error((text || 'Generation failed').replace(/^Error:\s*/, ''));
          var parsed = extractJsonValue(text);
          if (!parsed) throw new Error('The model did not return JSON. Try again or simplify the request.');
          $('codeCss').value = String(parsed.css || '');
          $('codeJs').value = String(parsed.js || '');
          if (parsed.js) $('codeJsEnabled').checked = false;
          codeStatus((parsed.notes ? String(parsed.notes) + ' ' : '') + 'Review the code, then Apply preview or Save rule.');
        });
      });
    }).catch(function (e) { codeStatus('Generate failed: ' + e.message); }).then(function () { if (btn) btn.disabled = false; });
  }
  function codeApply() {
    var css = $('codeCss').value;
    var js = $('codeJs').value;
    var jsEnabled = $('codeJsEnabled').checked;
    if (!css.trim() && !jsEnabled) { codeStatus('Nothing to apply: add CSS or enable JavaScript.'); return; }
    codeStatus('Applying...');
    sendTabCommand('code-apply', { css: css, js: js, jsEnabled: jsEnabled }).then(function (r) {
      if (r && r.ok === false && !('jsError' in r)) throw new Error(r.error || 'Apply failed');
      codeStatus('Applied to this tab.' + (r && r.jsError ? ' JS error: ' + r.jsError : ''));
    }).catch(function () {
      activeTabId().then(function (tabId) {
        return sendMessage({ type: 'applyCodeToTab', css: css, js: js, jsEnabled: jsEnabled, tabId: tabId });
      }).then(function (r) {
        codeStatus('Applied to this tab.' + (r && r.jsError ? ' JS error: ' + r.jsError : ''));
      }).catch(function (e) { codeStatus('Apply failed: ' + e.message); });
    });
  }
  function codeRemove() {
    sendTabCommand('code-remove', {}).then(function () { codeStatus('Removed from this tab.'); }).catch(function () {
      activeTabId().then(function (tabId) {
        return sendMessage({ type: 'removeCodeFromTab', tabId: tabId });
      }).then(function () { codeStatus('Removed from this tab.'); }).catch(function (e) { codeStatus('Remove failed: ' + e.message); });
    });
  }
  function codeOutline() {
    codeStatus('Inspecting page...');
    sendTabCommand('page-outline', {}).then(function (outline) {
      codeStatus(outlineSummary(outline));
    }).catch(function (e) { codeStatus('Inspect failed: ' + e.message); });
  }
  function codeSave() {
    refreshCodeHost().then(function (tab) {
      var host = hostOf(tab && tab.url);
      if (!host) { codeStatus('Save failed: the active tab has no site host.'); return; }
      var rule = {
        host: host,
        prompt: $('codePrompt').value.trim(),
        css: $('codeCss').value,
        js: $('codeJs').value,
        jsEnabled: $('codeJsEnabled').checked,
        enabled: true
      };
      if (!rule.css.trim() && !(rule.jsEnabled && rule.js.trim())) { codeStatus('Nothing to save: generate or write CSS/JS first.'); return; }
      sendMessage({ type: 'saveCodeRule', rule: rule }).then(function (saved) {
        codeStatus('Rule saved for ' + ((saved && saved.host) || host) + '. It auto-applies on every visit.');
        renderCodeRules();
      }).catch(function (e) { codeStatus('Save failed: ' + e.message); });
    });
  }
  function codeApplyRule(rule) {
    $('codePrompt').value = rule.prompt || '';
    $('codeCss').value = rule.css || '';
    $('codeJs').value = rule.js || '';
    $('codeJsEnabled').checked = !!rule.jsEnabled;
    codeApply();
  }
  function renderCodeRules() {
    var list = $('codeRuleList'); if (!list) return Promise.resolve();
    return sendMessage({ type: 'listCodeRules' }).then(function (rules) {
      list.textContent = '';
      rules = Array.isArray(rules) ? rules : [];
      if (!rules.length) { list.appendChild(emptyNoteEl('No saved rules yet. Generate a restyle and save it for this site.')); return; }
      rules.forEach(function (rule) {
        var row = document.createElement('div'); row.className = 'rule-row' + (rule.enabled === false ? ' off' : '');
        var head = document.createElement('div'); head.className = 'row-between';
        var hostEl = document.createElement('strong'); hostEl.textContent = rule.host || '(no host)';
        var toggleLabel = document.createElement('label'); toggleLabel.className = 'toggle';
        var toggle = document.createElement('input'); toggle.type = 'checkbox'; toggle.checked = rule.enabled !== false;
        toggle.title = 'Auto-apply on visit';
        toggle.addEventListener('change', function () {
          var on = toggle.checked;
          sendMessage({ type: 'setCodeRuleEnabled', id: rule.id, enabled: on }).then(function () {
            row.classList.toggle('off', !on);
            codeStatus('Rule for ' + (rule.host || '') + (on ? ' enabled.' : ' disabled.'));
          }).catch(function (e) { toggle.checked = !on; codeStatus('Update failed: ' + e.message); });
        });
        toggleLabel.appendChild(toggle);
        head.appendChild(hostEl); head.appendChild(toggleLabel);
        row.appendChild(head);
        var desc = document.createElement('div'); desc.className = 'desc';
        desc.textContent = (rule.prompt || rule.notes || (rule.css ? 'Custom CSS' : 'Custom JS')) + (rule.jsEnabled && rule.js ? ' · JS on' : '');
        row.appendChild(desc);
        var actions = document.createElement('div'); actions.className = 'row';
        var applyBtn = document.createElement('button'); applyBtn.type = 'button'; applyBtn.className = 'btn small'; applyBtn.textContent = 'Apply';
        applyBtn.addEventListener('click', function () { codeApplyRule(rule); });
        var deleteBtn = document.createElement('button'); deleteBtn.type = 'button'; deleteBtn.className = 'btn small danger-outline'; deleteBtn.textContent = 'Delete';
        deleteBtn.addEventListener('click', function () {
          sendMessage({ type: 'deleteCodeRule', id: rule.id }).then(function () {
            codeStatus('Rule deleted.');
            renderCodeRules();
          }).catch(function (e) { codeStatus('Delete failed: ' + e.message); });
        });
        actions.appendChild(applyBtn); actions.appendChild(deleteBtn);
        row.appendChild(actions);
        list.appendChild(row);
      });
    }).catch(function (e) {
      list.textContent = '';
      list.appendChild(emptyNoteEl('Could not load rules: ' + e.message));
    });
  }

  /* ---------------- hand (supervised browser operation) ---------------- */
  var HAND_EXTRACT_MAX = 20000;
  var HAND_RESULT_MAX = 4000;
  function handLog(line, level) {
    var text = String(line == null ? '' : line);
    var lvl = (level === 'ok' || level === 'error' || level === 'extract') ? level : 'info';
    if (!Array.isArray(state.handLogEntries)) state.handLogEntries = [];
    state.handLogEntries.push({ ts: Date.now(), level: lvl, text: text });
    if (state.handLogEntries.length > 500) state.handLogEntries = state.handLogEntries.slice(-500);
    var box = $('handLog'); if (!box) return;
    box.textContent = box.textContent ? box.textContent + '\n' + text : text;
    box.scrollTop = box.scrollHeight;
  }
  function handRunIsActive() {
    return !!(state.handRun && !state.handRunSaved);
  }
  function ensureHandRun() {
    if (handRunIsActive()) return state.handRun;
    var taskEl = $('handTask');
    state.handRun = {
      id: uid(),
      task: taskEl ? taskEl.value.trim() : '',
      startedAt: Date.now(),
      finishedAt: 0,
      pageUrl: (state.currentTab && state.currentTab.url) || '',
      pageTitle: (state.currentTab && state.currentTab.title) || '',
      outcome: '',
      steps: []
    };
    state.handRunSaved = false;
    return state.handRun;
  }
  function resetHandRun() {
    state.handRun = null;
    state.handRunSaved = false;
  }
  function handExcerpt(text, n) {
    var s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    var cap = n || 240;
    return s.length > cap ? s.slice(0, cap) + '…' : s;
  }
  function handStepResultText(step, r, action) {
    if (!step) return '';
    if (action === 'extract') {
      if (step.resultText) return String(step.resultText);
      return r && r.text ? String(r.text) : '';
    }
    if (action === 'fill') return 'Filled with "' + String(step.value != null ? step.value : '') + '"';
    if (action === 'click') {
      var target = (r && (r.text || r.tag)) || step.text || step.selector || 'element';
      return 'Clicked ' + String(target);
    }
    if (action === 'navigate') return 'Navigated to ' + String((r && r.url) || step.url || '');
    if (action === 'wait') return 'Waited ' + (step.ms || step.amount || 800) + 'ms';
    if (action === 'scroll') return 'Scrolled by ' + (step.amount || 600) + 'px' + (r && r.y != null ? ' (y=' + r.y + ')' : '');
    if (r && r.text) return String(r.text);
    return step.resultText ? String(step.resultText) : '';
  }
  function buildHandRunRecord(outcome) {
    var run = ensureHandRun();
    var taskEl = $('handTask');
    var task = taskEl ? taskEl.value.trim() : (run.task || '');
    var steps = (state.handSteps || []).map(function (step, i) {
      return {
        n: i + 1,
        action: String(step.action || ''),
        label: handStepLabel(step),
        state: String(step.state || ''),
        statusText: String(step.statusText || ''),
        resultText: String(step.resultText || '').slice(0, HAND_RESULT_MAX),
        error: String(step.error || '')
      };
    });
    // Include any steps already captured on the run (e.g. restored runs).
    if (!steps.length && Array.isArray(run.steps) && run.steps.length) steps = run.steps;
    var tab = state.currentTab || {};
    return {
      id: run.id || uid(),
      task: task || run.task || '',
      startedAt: run.startedAt || Date.now(),
      finishedAt: Date.now(),
      pageUrl: tab.url || run.pageUrl || '',
      pageTitle: tab.title || run.pageTitle || '',
      outcome: outcome || run.outcome || 'done',
      steps: steps
    };
  }
  function handOutcomeFor(chainOutcome) {
    var steps = state.handSteps || [];
    var anyFailed = steps.some(function (s) { return s.state === 'failed' || !!s.error; });
    var anyDone = steps.some(function (s) { return s.state === 'done'; });
    var allDone = steps.length > 0 && steps.every(function (s) { return s.state === 'done'; });
    if (chainOutcome === 'stopped') return 'stopped';
    if (chainOutcome === 'confirm') return 'paused';
    if (chainOutcome === 'failed') return anyDone ? 'partial' : 'failed';
    if (allDone) return 'done';
    if (anyFailed) return anyDone ? 'partial' : 'failed';
    if (anyDone) return 'partial';
    return 'done';
  }
  function handSummaryMarkdown(record) {
    if (!record) return '';
    var lines = [];
    lines.push('# Hand run summary');
    lines.push('');
    if (record.task) lines.push('**Task:** ' + record.task);
    lines.push('**Outcome:** ' + (record.outcome || ''));
    if (record.pageTitle || record.pageUrl) lines.push('**Page:** ' + [record.pageTitle, record.pageUrl].filter(Boolean).join(' — '));
    if (record.pageUrl) lines.push('**URL:** ' + record.pageUrl);
    if (record.startedAt) lines.push('**Started:** ' + new Date(record.startedAt).toLocaleString());
    if (record.finishedAt) lines.push('**Finished:** ' + new Date(record.finishedAt).toLocaleString());
    if (record.startedAt && record.finishedAt) lines.push('**Duration:** ' + formatMs(Math.max(0, record.finishedAt - record.startedAt)));
    lines.push('');
    lines.push('## Steps');
    lines.push('');
    var steps = Array.isArray(record.steps) ? record.steps : [];
    if (!steps.length) lines.push('_No steps recorded._');
    steps.forEach(function (s, i) {
      var n = s.n || (i + 1);
      var head = n + '. **' + (s.action || 'step') + '** — ' + (s.label || '') + (s.state ? ' [' + s.state + ']' : '');
      lines.push(head);
      if (s.resultText) lines.push('   - Result: ' + String(s.resultText).slice(0, HAND_RESULT_MAX));
      if (s.error) lines.push('   - Error: ' + s.error);
      else if (s.statusText && s.statusText !== s.state) lines.push('   - Status: ' + s.statusText);
    });
    return lines.join('\n');
  }
  function renderHandSummary(record) {
    state.handSummaryRecord = record || null;
    var panel = $('handSummary'); if (!panel) return;
    if (!record) { panel.classList.add('hidden'); return; }
    panel.classList.remove('hidden');
    var outcomeEl = $('handSummaryOutcome');
    if (outcomeEl) outcomeEl.textContent = record.outcome || '';
    var metaEl = $('handSummaryMeta');
    if (metaEl) {
      var steps = Array.isArray(record.steps) ? record.steps : [];
      var okCount = steps.filter(function (s) { return s.state === 'done'; }).length;
      var failCount = steps.filter(function (s) { return s.state === 'failed' || !!s.error; }).length;
      var dur = (record.startedAt && record.finishedAt) ? formatMs(Math.max(0, record.finishedAt - record.startedAt)) : '';
      var parts = [];
      if (record.task) parts.push(record.task);
      parts.push(steps.length + ' steps · ' + okCount + ' ok · ' + failCount + ' failed');
      if (dur) parts.push(dur);
      if (record.pageUrl) parts.push(record.pageUrl);
      if (record.finishedAt) parts.push(new Date(record.finishedAt).toLocaleString());
      metaEl.textContent = parts.join(' · ');
    }
    var box = $('handSummarySteps'); if (!box) return;
    box.textContent = '';
    var steps = Array.isArray(record.steps) ? record.steps : [];
    if (!steps.length) { box.appendChild(emptyNoteEl('No steps recorded.')); return; }
    steps.forEach(function (s, i) {
      var row = document.createElement('div'); row.className = 'hand-summary-step';
      var head = document.createElement('div'); head.className = 'hand-summary-step-head';
      head.textContent = (s.n || (i + 1)) + '. ' + (s.action || 'step') + ' — ' + (s.label || '') + (s.state ? ' [' + s.state + ']' : '');
      row.appendChild(head);
      if (s.resultText) {
        var res = document.createElement('div'); res.className = 'hand-summary-step-result';
        res.textContent = handExcerpt(s.resultText, 500);
        row.appendChild(res);
      }
      if (s.error) {
        var err = document.createElement('div'); err.className = 'hand-summary-step-error';
        err.textContent = 'Error: ' + s.error;
        row.appendChild(err);
      }
      box.appendChild(row);
    });
  }
  function finishHandRun(outcome) {
    if (state.handRunSaved && state.handSummaryRecord) {
      renderHandSummary(state.handSummaryRecord);
      return Promise.resolve(state.handSummaryRecord);
    }
    if (!state.handSteps.length && !(state.handRun && state.handRun.steps && state.handRun.steps.length)) {
      handLog('Nothing to summarize yet — plan and run at least one step.', 'info');
      return Promise.resolve(null);
    }
    var record = buildHandRunRecord(outcome || handOutcomeFor());
    // Capture page info asynchronously if we don't have it yet, but don't block saving on it.
    var save = function (rec) {
      return sendMessage({ type: 'saveHandRun', run: rec }).then(function (saved) {
        var finalRec = saved || rec;
        state.handRunSaved = true;
        if (state.handRun) state.handRun.id = finalRec.id;
        renderHandSummary(finalRec);
        handLog('Run summary saved (' + (finalRec.outcome || '') + ', ' + ((finalRec.steps || []).length) + ' steps).', 'ok');
        renderHandRunsList();
        return finalRec;
      }).catch(function (e) {
        // Still show the deterministic summary even if persistence fails.
        renderHandSummary(rec);
        handLog('Summary ready, but saving failed: ' + e.message, 'error');
        return rec;
      });
    };
    if (!record.pageUrl) {
      return getActiveTab().then(function (tab) {
        if (tab) { record.pageUrl = tab.url || record.pageUrl; record.pageTitle = tab.title || record.pageTitle; state.currentTab = tab; }
        return save(record);
      }).catch(function () { return save(record); });
    }
    return save(record);
  }
  function openHandRun(id) {
    return sendMessage({ type: 'getHandRun', id: id }).then(function (rec) {
      if (!rec) { handLog('That run no longer exists.', 'error'); renderHandRunsList(); return null; }
      state.handSummaryRecord = rec;
      if (rec.task && $('handTask')) $('handTask').value = rec.task;
      // Restore steps so the step list reflects the saved run.
      state.handSteps = (Array.isArray(rec.steps) ? rec.steps : []).map(function (s) {
        return {
          action: s.action || 'wait', url: '', selector: '', text: '', label: '', value: '',
          amount: undefined, ms: undefined, reason: '',
          state: s.state || '', statusText: s.statusText || '',
          resultText: s.resultText || '', error: s.error || '', confirmed: false,
          _savedLabel: s.label || ''
        };
      });
      state.handRun = { id: rec.id, task: rec.task || '', startedAt: rec.startedAt || Date.now(), finishedAt: rec.finishedAt || 0, pageUrl: rec.pageUrl || '', pageTitle: rec.pageTitle || '', outcome: rec.outcome || '', steps: rec.steps || [] };
      state.handRunSaved = true;
      renderHandSteps();
      renderHandSummary(rec);
      handLog('Opened saved run from ' + new Date(rec.finishedAt || rec.startedAt || Date.now()).toLocaleString() + '.', 'info');
      return rec;
    }).catch(function (e) { handLog('Open failed: ' + e.message, 'error'); return null; });
  }
  function renderHandRunsList() {
    var list = $('handRunsList'); if (!list) return Promise.resolve();
    return sendMessage({ type: 'listHandRuns' }).then(function (items) {
      list.textContent = '';
      items = Array.isArray(items) ? items : [];
      if (!items.length) { list.appendChild(emptyNoteEl('No saved runs yet. Finish a run to save its summary.')); return; }
      items.forEach(function (item) {
        var row = document.createElement('div'); row.className = 'hand-run-row list-item';
        var titleEl = document.createElement('strong'); titleEl.textContent = item.task || item.pageTitle || 'Hand run';
        row.appendChild(titleEl);
        var desc = document.createElement('div'); desc.className = 'desc';
        var when = new Date(item.finishedAt || item.startedAt || Date.now()).toLocaleString();
        desc.textContent = (item.outcome || '') + ' · ' + (item.stepCount || 0) + ' steps · ' + (item.okCount || 0) + ' ok · ' + (item.failedCount || 0) + ' failed · ' + when;
        row.appendChild(desc);
        if (item.pageUrl) { var urlEl = document.createElement('div'); urlEl.className = 'desc'; urlEl.textContent = item.pageUrl; row.appendChild(urlEl); }
        var actions = document.createElement('div'); actions.className = 'row';
        var openBtn = document.createElement('button'); openBtn.type = 'button'; openBtn.className = 'btn small'; openBtn.textContent = 'Open';
        openBtn.addEventListener('click', function () { openHandRun(item.id); });
        var deleteBtn = document.createElement('button'); deleteBtn.type = 'button'; deleteBtn.className = 'btn small danger-outline'; deleteBtn.textContent = 'Delete';
        deleteBtn.addEventListener('click', function () {
          sendMessage({ type: 'deleteHandRun', id: item.id }).then(function () {
            if (state.handSummaryRecord && state.handSummaryRecord.id === item.id) renderHandSummary(null);
            if (state.handRun && state.handRun.id === item.id) resetHandRun();
            handLog('Saved run deleted.', 'info');
            renderHandRunsList();
          }).catch(function (e) { handLog('Delete failed: ' + e.message, 'error'); });
        });
        actions.appendChild(openBtn); actions.appendChild(deleteBtn);
        row.appendChild(actions);
        list.appendChild(row);
      });
    }).catch(function (e) {
      list.textContent = '';
      list.appendChild(emptyNoteEl('Could not load saved runs: ' + e.message));
    });
  }
  function copyHandSummary() {
    var record = state.handSummaryRecord;
    if (!record) { handLog('No summary to copy yet.', 'info'); return; }
    var md = handSummaryMarkdown(record);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(md).then(function () { status('Summary copied'); handLog('Summary copied to clipboard.', 'ok'); }).catch(function () { status('Copy failed'); });
    }
  }
  function downloadHandSummary() {
    var record = state.handSummaryRecord;
    if (!record) { handLog('No summary to download yet.', 'info'); return; }
    var md = handSummaryMarkdown(record);
    var base = ((record.task || 'hand-run').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'hand-run');
    var blob = new Blob([md], { type: 'text/markdown' });
    var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = base + '.md'; a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
    status('Summary downloaded');
  }
  function handStepLabel(step) {
    if (step && step._savedLabel) return String(step._savedLabel);
    var action = String((step && step.action) || 'step');
    if (action === 'navigate') return 'Navigate to ' + (step.url || '');
    if (action === 'wait') return 'Wait ' + (step.ms || step.amount || 800) + 'ms';
    if (action === 'scroll') return 'Scroll by ' + (step.amount || 600) + 'px';
    if (action === 'extract') return 'Extract page text';
    if (action === 'click') return 'Click ' + (step.text || step.selector || 'element');
    if (action === 'fill') return 'Fill ' + (step.label || step.selector || 'field') + ' with "' + truncate(step.value || '', 40) + '"';
    return action;
  }
  function renderHandSteps() {
    var box = $('handSteps'); if (!box) return;
    box.textContent = '';
    state.handSteps.forEach(function (step, i) {
      var row = document.createElement('div'); row.className = 'hand-step ' + (step.state || '');
      var idx = document.createElement('span'); idx.className = 'idx'; idx.textContent = String(i + 1);
      var main = document.createElement('span'); main.className = 'detail hand-step-main'; main.style.flex = '1';
      var labelLine = document.createElement('span');
      var label = document.createElement('span'); label.textContent = handStepLabel(step);
      labelLine.appendChild(label);
      if (step.reason) { var why = document.createElement('span'); why.textContent = ' — ' + step.reason; labelLine.appendChild(why); }
      if (step.statusText) { var st = document.createElement('span'); st.textContent = ' [' + step.statusText + ']'; labelLine.appendChild(st); }
      main.appendChild(labelLine);
      var resultSource = step.error ? '' : (step.resultText || '');
      if (resultSource) {
        var res = document.createElement('span'); res.className = 'hand-step-result';
        res.textContent = handExcerpt(resultSource, 240);
        main.appendChild(res);
      }
      if (step.error) {
        var errEl = document.createElement('span'); errEl.className = 'hand-step-error';
        errEl.textContent = String(step.error);
        main.appendChild(errEl);
      }
      var runBtn = document.createElement('button'); runBtn.type = 'button'; runBtn.className = 'btn small'; runBtn.textContent = 'Run';
      runBtn.addEventListener('click', function () { runHandStep(i); });
      row.appendChild(idx); row.appendChild(main); row.appendChild(runBtn);
      box.appendChild(row);
    });
  }
  function handPlan() {
    var btn = $('handPlanBtn');
    var task = $('handTask').value.trim();
    if (!task) { handLog('Describe the task first.'); $('handTask').focus(); return; }
    if (btn) btn.disabled = true;
    resetHandRun();
    renderHandSummary(null);
    handLog('Planning...');
    sendTabCommand('page-outline', {}).catch(function () { return null; }).then(function (outline) {
      var prompt = [
        'You plan supervised browser tasks. Break the task into at most 12 concrete steps for the current page.',
        'Current page outline:',
        truncate(JSON.stringify(outline || {}), 6000),
        '',
        'Task: ' + task,
        '',
        'Return ONLY a JSON array (no prose, no markdown fences). Step shapes:',
        '{"action":"navigate","url":"https://...","reason":"..."}',
        '{"action":"click","selector":"css selector (optional)","text":"visible text (optional)","reason":"..."}',
        '{"action":"fill","selector":"css selector (optional)","label":"field label or placeholder (optional)","value":"...","reason":"..."}',
        '{"action":"extract","reason":"..."} — read the page text',
        '{"action":"scroll","amount":600,"reason":"..."}',
        '{"action":"wait","ms":800,"reason":"..."}',
        'Prefer selectors from the outline. Never plan steps that fill password fields, enter payment details, or confirm purchases/deletions; stop before those and let the user act.'
      ].join('\n');
      return chatSyncFallback([{ role: 'user', content: prompt }], state.activeProviderId, state.activeModel, null).then(function (text) {
        if (!text || text.indexOf('Error:') === 0) throw new Error((text || 'Planning failed').replace(/^Error:\s*/, ''));
        var parsed = extractJsonValue(text);
        if (!parsed || !Array.isArray(parsed) || !parsed.length) throw new Error('The model did not return a step list. Try again.');
        state.handSteps = parsed.slice(0, 12).map(function (s) {
          return {
            action: String((s && s.action) || 'wait'), url: s && s.url || '',
            selector: s && s.selector || '', text: s && s.text || '',
            label: s && s.label || '', value: s && s.value != null ? String(s.value) : '',
            amount: s && s.amount, ms: s && s.ms, reason: s && s.reason || '',
            state: '', statusText: '', resultText: '', error: '', confirmed: false
          };
        });
        state.handStop = false;
        ensureHandRun();
        if (state.handRun) state.handRun.task = task;
        getActiveTab().then(function (tab) {
          if (tab && state.handRun) { state.handRun.pageUrl = tab.url || ''; state.handRun.pageTitle = tab.title || ''; }
        }).catch(function () {});
        renderHandSteps();
        handLog('Plan ready: ' + state.handSteps.length + ' steps. Run them one at a time or Run all.', 'info');
      });
    }).catch(function (e) { handLog('Plan failed: ' + e.message); }).then(function () { if (btn) btn.disabled = false; });
  }
  function runHandStep(index) {
    var step = state.handSteps[index];
    if (!step) return Promise.resolve('done');
    // A run starts at plan success or at the first step run after a finish.
    if (state.handRunSaved) { resetHandRun(); renderHandSummary(null); }
    ensureHandRun();
    var action = String(step.action || '').toLowerCase();
    function mark(stateName, statusText, resultText, errorText) {
      step.state = stateName; step.statusText = statusText || '';
      if (typeof resultText === 'string') step.resultText = resultText;
      if (typeof errorText === 'string') step.error = errorText;
      else if (stateName === 'done') step.error = '';
      renderHandSteps();
    }
    step.error = '';
    mark('', 'running');
    if (action === 'navigate' || action === 'wait') {
      var bgPayload = { type: 'handStep', action: action, url: step.url || '', ms: step.ms || step.amount || 800, amount: step.amount };
      return activeTabId().then(function (tabId) {
        bgPayload.tabId = tabId;
        return sendMessage(bgPayload);
      }).then(function (r) {
        if (action === 'navigate' && r && r.url) { refreshCodeHost(); }
        var resultText = handStepResultText(step, r, action).slice(0, HAND_RESULT_MAX);
        step.resultText = resultText;
        mark('done', 'done', resultText, '');
        handLog('Step ' + (index + 1) + ' ' + action + ': OK' + (resultText ? ' — ' + handExcerpt(resultText, 120) : ''), 'ok');
        return 'done';
      }).catch(function (e) {
        step.error = e.message || String(e);
        mark('failed', 'failed', step.resultText || '', step.error);
        handLog('Step ' + (index + 1) + ' ' + action + ' failed: ' + e.message, 'error');
        return 'failed';
      });
    }
    var command = { click: 'hand-click', fill: 'hand-fill', extract: 'hand-extract', scroll: 'hand-scroll' }[action];
    if (!command) {
      step.error = 'unknown action "' + action + '"';
      mark('failed', 'unknown action', '', step.error);
      handLog('Step ' + (index + 1) + ': unknown action "' + action + '"', 'error');
      return Promise.resolve('failed');
    }
    var payload = { selector: step.selector, text: step.text, label: step.label, value: step.value, amount: step.amount || 600, maxLength: 20000 };
    return sendTabCommand(command, payload).then(function (r) {
      if (r && r.needsConfirm) {
        if (!step.confirmed) {
          step.error = '';
          mark('failed', 'needs confirmation');
          var ok = false;
          try { ok = window.confirm('This click looks sensitive: "' + (r.text || step.text || 'element') + '".\n\nRun it anyway?'); } catch (e) { ok = false; }
          if (!ok) { handLog('Step ' + (index + 1) + ' paused: confirmation declined. Click Run again to retry.', 'info'); return 'confirm'; }
          step.confirmed = true;
          return runHandStep(index);
        }
        step.confirmed = false;
        step.error = 'blocked: the page still requires confirmation';
        mark('failed', 'blocked', step.resultText || '', step.error);
        handLog('Step ' + (index + 1) + ' blocked: the page still requires confirmation.', 'error');
        return 'confirm';
      }
      if (r && r.ok === false) throw new Error(r.error || 'Step failed');
      var resultText = '';
      if (action === 'extract' && r && r.text) {
        resultText = String(r.text).slice(0, HAND_EXTRACT_MAX);
        step.resultText = resultText;
        handLog('Extracted from ' + (r.title || r.url || 'page') + ':\n' + truncate(r.text, 2000), 'extract');
      } else {
        resultText = handStepResultText(step, r, action).slice(0, HAND_RESULT_MAX);
        step.resultText = resultText;
        handLog('Step ' + (index + 1) + ' ' + action + ': OK' + (resultText ? ' (' + handExcerpt(resultText, 80) + ')' : ''), 'ok');
      }
      if (action === 'extract') { /* resultText already stored FULL (cap 20000) above */ }
      mark('done', 'done', step.resultText, '');
      return 'done';
    }).catch(function (e) {
      step.error = e.message || String(e);
      mark('failed', 'failed', step.resultText || '', step.error);
      handLog('Step ' + (index + 1) + ' ' + action + ' failed: ' + e.message, 'error');
      return 'failed';
    });
  }
  function handRunAll() {
    if (!state.handSteps.length) { handLog('Plan steps first.'); return; }
    if (state.handRunSaved) { resetHandRun(); renderHandSummary(null); }
    ensureHandRun();
    state.handStop = false;
    handLog('Running all steps (supervised)...');
    var chain = Promise.resolve('done');
    state.handSteps.forEach(function (step, i) {
      chain = chain.then(function (prev) {
        if (state.handStop) return 'stopped';
        if (prev === 'failed' || prev === 'confirm' || prev === 'stopped') return prev;
        return runHandStep(i);
      });
    });
    chain.then(function (outcome) {
      var finalOutcome;
      if (state.handStop || outcome === 'stopped') { handLog('Stopped by user.', 'info'); finalOutcome = 'stopped'; }
      else if (outcome === 'failed') { handLog('Run stopped: a step failed.', 'error'); finalOutcome = handOutcomeFor('failed'); }
      else if (outcome === 'confirm') { handLog('Run paused: a step needs confirmation.', 'info'); finalOutcome = 'paused'; }
      else { handLog('All steps done.', 'ok'); finalOutcome = handOutcomeFor('done'); }
      return finishHandRun(finalOutcome);
    });
  }
  function handOutline() {
    sendTabCommand('page-outline', {}).then(function (outline) {
      handLog(outlineSummary(outline));
    }).catch(function (e) { handLog('Inspect failed: ' + e.message); });
  }

  /* ---------------- research (Deep Research) ---------------- */
  function researchStatus(text) { var el = $('researchStatus'); if (el) el.textContent = text; }
  function selectedResearchSources() {
    var box = $('researchSources');
    var checked = [];
    if (box) {
      Array.prototype.forEach.call(box.querySelectorAll('input[type="checkbox"]'), function (cb) {
        if (cb.checked) checked.push(cb.value);
      });
    }
    return checked.length ? checked : ['openalex', 'crossref', 'arxiv', 'semanticscholar'];
  }
  function sourceLabel(id) {
    var labels = { openalex: 'OpenAlex', crossref: 'Crossref', arxiv: 'arXiv', semanticscholar: 'Semantic Scholar' };
    return labels[id] || id || 'source';
  }
  function renderResearchSources(sources) {
    state.researchSources = Array.isArray(sources) ? sources : [];
    var box = $('researchSourcesList'); if (!box) return;
    box.textContent = '';
    state.researchSources.forEach(function (s, i) {
      var card = document.createElement('div'); card.className = 'research-source';
      var titleEl = document.createElement('strong');
      if (s.url) {
        var a = document.createElement('a'); a.href = s.url; a.target = '_blank'; a.rel = 'noopener noreferrer';
        a.textContent = (i + 1) + '. ' + (s.title || 'Untitled');
        a.addEventListener('click', function (e) { e.preventDefault(); try { api.tabs.create({ url: s.url }); } catch (err) {} });
        titleEl.appendChild(a);
      } else {
        titleEl.textContent = (i + 1) + '. ' + (s.title || 'Untitled');
      }
      card.appendChild(titleEl);
      var meta = [s.authors, s.year, s.venue, sourceLabel(s.source)].filter(function (x) { return !!x; }).join(' · ');
      if (meta) { var metaEl = document.createElement('div'); metaEl.className = 'src-meta'; metaEl.textContent = meta; card.appendChild(metaEl); }
      if (s.doi) { var doiEl = document.createElement('div'); doiEl.className = 'src-meta'; doiEl.textContent = 'DOI: ' + s.doi; card.appendChild(doiEl); }
      if (s.abstract) {
        var absEl = document.createElement('div'); absEl.className = 'src-meta';
        absEl.textContent = truncate(s.abstract, 280);
        card.appendChild(absEl);
      }
      if (s.pdfUrl) {
        var pdf = document.createElement('a'); pdf.href = s.pdfUrl; pdf.target = '_blank'; pdf.rel = 'noopener noreferrer';
        pdf.textContent = 'PDF';
        pdf.addEventListener('click', function (e) { e.preventDefault(); try { api.tabs.create({ url: s.pdfUrl }); } catch (err) {} });
        card.appendChild(pdf);
      }
      box.appendChild(card);
    });
  }
  function renderResearchReport(markdown) {
    state.researchRaw = String(markdown || '');
    var box = $('researchReport'); if (!box) return;
    box.textContent = '';
    if (!state.researchRaw) return;
    // Same rendering path as chat messages; no timestamp/youtube opts here.
    if (window.GraphiteMarkdown) setGeneratedHtml(box, GraphiteMarkdown.render(state.researchRaw, {}));
    else box.textContent = state.researchRaw;
    var has = !!state.researchRaw.trim();
    $('researchCopyBtn').disabled = !has;
    $('researchDownloadBtn').disabled = !has;
  }
  function runResearch() {
    var btn = $('researchRunBtn');
    var query = $('researchQuery').value.trim();
    if (!query) { researchStatus('Enter a research question first.'); $('researchQuery').focus(); return; }
    if (!window.GraphiteResearch || typeof GraphiteResearch.buildResearchPrompt !== 'function') {
      researchStatus('Research library failed to load; try reloading the sidebar.');
      return;
    }
    if (btn) btn.disabled = true;
    state.researchId = null;
    renderResearchSources([]);
    renderResearchReport('');
    researchStatus('Searching academic sources...');
    sendMessage({
      type: 'researchSearch', query: query,
      sources: selectedResearchSources(),
      perSource: Number($('researchPerSource').value || 6)
    }).then(function (r) {
      var sources = (r && r.sources) || [];
      state.researchId = (r && r.id) || null;
      renderResearchSources(sources);
      var errNote = '';
      if (r && r.errors && r.errors.length) {
        errNote = ' Failed: ' + r.errors.map(function (e) { return sourceLabel(e.source) + ' (' + e.error + ')'; }).join('; ');
      }
      if (!sources.length) {
        researchStatus('No sources found in the selected databases.' + errNote);
        return null;
      }
      researchStatus('Found ' + sources.length + ' sources. Writing the report...' + errNote);
      var prompt = GraphiteResearch.buildResearchPrompt(query, sources, { depth: $('researchDepth').value });
      return chatSyncFallback([{ role: 'user', content: prompt }], state.activeProviderId, state.activeModel, null).then(function (text) {
        if (!text || text.indexOf('Error:') === 0) throw new Error((text || 'Report generation failed').replace(/^Error:\s*/, ''));
        renderResearchReport(text);
        return sendMessage({
          type: 'saveResearchReport',
          report: { id: state.researchId || undefined, query: query, title: truncate(query, 80), report: text, sources: sources }
        }).then(function (saved) {
          state.researchId = (saved && saved.id) || state.researchId;
          researchStatus('Report ready — ' + sources.length + ' sources cited. Saved to your reports.');
          renderResearchList();
        });
      });
    }).catch(function (e) {
      if (e) researchStatus('Research failed: ' + e.message);
    }).then(function () { if (btn) btn.disabled = false; });
  }
  function openResearchReport(id) {
    sendMessage({ type: 'getResearchReport', id: id }).then(function (rec) {
      if (!rec) { researchStatus('That report no longer exists.'); renderResearchList(); return; }
      state.researchId = rec.id;
      $('researchQuery').value = rec.query || '';
      renderResearchSources(rec.sources || []);
      renderResearchReport(rec.report || '');
      researchStatus('Opened saved report from ' + new Date(rec.updatedAt || rec.createdAt || Date.now()).toLocaleString() + '.');
      $('researchReport').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }).catch(function (e) { researchStatus('Open failed: ' + e.message); });
  }
  function renderResearchList() {
    var list = $('researchList'); if (!list) return Promise.resolve();
    return sendMessage({ type: 'listResearchReports' }).then(function (items) {
      list.textContent = '';
      items = Array.isArray(items) ? items : [];
      if (!items.length) { list.appendChild(emptyNoteEl('No saved reports yet. Run a research question above.')); return; }
      items.forEach(function (item) {
        var row = document.createElement('div'); row.className = 'list-item';
        var titleEl = document.createElement('strong'); titleEl.textContent = item.title || item.query || 'Research report';
        row.appendChild(titleEl);
        var desc = document.createElement('div'); desc.className = 'desc';
        desc.textContent = (item.sourceCount || 0) + ' sources · ' + new Date(item.updatedAt || item.createdAt || Date.now()).toLocaleString();
        row.appendChild(desc);
        var actions = document.createElement('div'); actions.className = 'row';
        var openBtn = document.createElement('button'); openBtn.type = 'button'; openBtn.className = 'btn small'; openBtn.textContent = 'Open';
        openBtn.addEventListener('click', function () { openResearchReport(item.id); });
        var deleteBtn = document.createElement('button'); deleteBtn.type = 'button'; deleteBtn.className = 'btn small danger-outline'; deleteBtn.textContent = 'Delete';
        deleteBtn.addEventListener('click', function () {
          sendMessage({ type: 'deleteResearchReport', id: item.id }).then(function () {
            if (state.researchId === item.id) { state.researchId = null; renderResearchReport(''); renderResearchSources([]); }
            researchStatus('Report deleted.');
            renderResearchList();
          }).catch(function (e) { researchStatus('Delete failed: ' + e.message); });
        });
        actions.appendChild(openBtn); actions.appendChild(deleteBtn);
        row.appendChild(actions);
        list.appendChild(row);
      });
    }).catch(function (e) {
      list.textContent = '';
      list.appendChild(emptyNoteEl('Could not load reports: ' + e.message));
    });
  }
  function downloadResearchReport() {
    if (!state.researchRaw) return;
    var name = (($('researchQuery').value.trim() || 'research-report').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'research-report') + '.md';
    var blob = new Blob([state.researchRaw], { type: 'text/markdown' });
    var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
    status('Report downloaded');
  }

  /* ---------------- videos (any page) ---------------- */
  function videoStatus(text) { var el = $('videoStatus'); if (el) el.textContent = text || ''; }
  function videoDetailStatus(text) { var el = $('videoDetailStatus'); if (el) el.textContent = text || ''; }
  function videoIsYouTubeUrl(url) {
    var s = String(url || '');
    return /youtube\.com|youtu\.be/i.test(s);
  }
  function videoFormatDuration(sec) {
    var total = Math.max(0, Math.floor(Number(sec) || 0));
    if (!total) return '';
    var h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
    function pad(n) { return (n < 10 ? '0' : '') + n; }
    return h > 0 ? h + ':' + pad(m) + ':' + pad(s) : pad(m) + ':' + pad(s);
  }
  // Build language <option>s with DOM APIs (no innerHTML anywhere in the
  // sidebar — see the 1.0.19 smoke pin), mirroring translateSelOptions().
  function fillVideoLangSelect(selEl, selected) {
    if (!selEl) return;
    var wanted = String(selected || defaultTargetLang() || 'English').trim();
    selEl.textContent = '';
    var chosen = null;
    translateLanguages().forEach(function (name) {
      var opt = document.createElement('option');
      opt.value = name; opt.textContent = name;
      if (name === wanted) chosen = opt;
      selEl.appendChild(opt);
    });
    if (!chosen && wanted) {
      chosen = document.createElement('option');
      chosen.value = wanted; chosen.textContent = wanted;
      selEl.insertBefore(chosen, selEl.firstChild);
    }
    if (chosen) selEl.value = chosen.value;
  }
  function videoScan() {
    var btn = $('videoScanBtn');
    if (btn) btn.disabled = true;
    videoStatus('Scanning the open page for video and audio elements...');
    return sendTabCommand('list-videos', {}).then(function (result) {
      var hostEl = $('videoHost');
      if (!result || !Array.isArray(result.items)) throw new Error('No page inventory returned.');
      state.videos = result.items;
      state.videoSelected = -1;
      var hideDetail = $('videoDetail'); if (hideDetail) hideDetail.classList.add('hidden');
      if (hostEl) hostEl.textContent = hostOf(result.url) || (state.currentTab && state.currentTab.title) || 'Page';
      renderVideoList();
      videoStatus(state.videos.length
        ? 'Found ' + state.videos.length + ' media element' + (state.videos.length === 1 ? '' : 's') + ' on ' + (result.title ? '"' + truncate(result.title, 60) + '"' : 'this page') + '. Select one to transcribe.'
        : 'No video or audio elements found on this page. Embedded players (iframes) and DRM streams cannot be inventoried here.');
      return result;
    }).catch(function (e) {
      videoStatus('Scan failed: ' + e.message + ' Open a normal web page (not about: or an internal page) and try again.');
    }).then(function () { if (btn) btn.disabled = false; });
  }
  function videoTracksSummary(video) {
    var parts = [];
    if (video && video.tracks && video.tracks.length) {
      parts.push(video.tracks.map(function (t) { return t.label || t.lang || t.kind || 'subtitles'; }).join(', '));
    }
    if (video && video.trackUrls && video.trackUrls.length) {
      parts.push(video.trackUrls.length + ' caption file' + (video.trackUrls.length === 1 ? '' : 's'));
    }
    return parts.filter(Boolean).join(' · ');
  }
  function renderVideoList() {
    var box = $('videoList'); if (!box) return;
    box.textContent = '';
    if (!state.videos.length) {
      box.appendChild(emptyNoteEl('No media found yet. Open a page with a video or audio player, then Scan page.'));
      return;
    }
    state.videos.forEach(function (video, i) {
      var row = document.createElement('div');
      row.className = 'video-row' + (i === state.videoSelected ? ' selected' : '');
      var titleEl = document.createElement('strong');
      titleEl.textContent = (i + 1) + '. ' + (video.label || video.src || 'Video');
      row.appendChild(titleEl);
      var desc = document.createElement('div'); desc.className = 'desc';
      var bits = [video.kind === 'audio' ? 'Audio' : 'Video'];
      if (video.youTube) bits.push('YouTube');
      var dur = videoFormatDuration(video.duration);
      if (dur) bits.push(dur);
      if (video.paused === false) bits.push('playing');
      var tracksText = videoTracksSummary(video);
      if (tracksText) bits.push('Captions: ' + tracksText);
      if (video.manifestUrls && video.manifestUrls.length) bits.push('stream manifest (separate audio track likely)');
      if (video.src && !/^blob:/i.test(String(video.src))) bits.push('direct file');
      else if (video.src) bits.push('streamed (no direct file)');
      desc.textContent = bits.join(' · ');
      row.appendChild(desc);
      var srcEl = document.createElement('div'); srcEl.className = 'desc src';
      srcEl.textContent = video.src || 'No direct source URL';
      row.appendChild(srcEl);
      var actions = document.createElement('div'); actions.className = 'row';
      var selectBtn = document.createElement('button'); selectBtn.type = 'button'; selectBtn.className = 'btn small primary';
      selectBtn.textContent = i === state.videoSelected ? 'Selected' : 'Select';
      selectBtn.addEventListener('click', function () { selectVideo(i); });
      actions.appendChild(selectBtn);
      row.appendChild(actions);
      box.appendChild(row);
    });
  }
  function selectedVideo() {
    return state.videoSelected >= 0 ? (state.videos[state.videoSelected] || null) : null;
  }
  function selectVideo(index) {
    state.videoSelected = index;
    var video = state.videos[index];
    var detail = $('videoDetail');
    if (!video || !detail) return;
    renderVideoList();
    detail.classList.remove('hidden');
    var titleEl = $('videoDetailTitle'); if (titleEl) titleEl.textContent = video.label || video.src || 'Video';
    var metaEl = $('videoDetailMeta'); if (metaEl) {
      var dur = videoFormatDuration(video.duration);
      metaEl.textContent = [video.kind === 'audio' ? 'Audio' : 'Video', dur, video.youTube ? 'YouTube' : ''].filter(Boolean).join(' · ');
    }
    fillVideoLangSelect($('videoLangSel'), defaultTargetLang());
    $('videoTranscriptText').value = '';
    state.videoResultRaw = '';
    renderVideoResult('');
    videoDetailStatus(video.youTube
      ? 'YouTube is transcribed via the YouTube transcript when available. Summarize / Translate run on that transcript.'
      : 'Captions on this player are used first. If none, the separate audio track from the stream manifest is sent to your provider; otherwise audio is extracted from the player in the page as MP3 (Options: Transcription model, e.g. cx/transcribe on 9Router).');
    detail.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
  function renderVideoResult(markdown) {
    state.videoResultRaw = String(markdown || '');
    var box = $('videoResult'); if (!box) return;
    box.textContent = '';
    if (state.videoResultRaw) {
      if (window.GraphiteMarkdown) setGeneratedHtml(box, GraphiteMarkdown.render(state.videoResultRaw, {}));
      else box.textContent = state.videoResultRaw;
    }
    var has = !!state.videoResultRaw.trim();
    var copyBtn = $('videoCopyBtn'); if (copyBtn) copyBtn.disabled = !has;
    var dlBtn = $('videoDownloadBtn'); if (dlBtn) dlBtn.disabled = !has;
    renderVideoSeekRow();
  }
  function renderVideoSeekRow() {
    var row = $('videoSeekRow'); if (!row) return;
    row.textContent = '';
    if (!state.videoResultRaw || !window.GraphiteMarkdown || typeof GraphiteMarkdown.extractTimestamps !== 'function') {
      row.classList.add('hidden'); return;
    }
    var stamps = GraphiteMarkdown.extractTimestamps(state.videoResultRaw).slice(0, 24);
    if (!stamps.length) { row.classList.add('hidden'); return; }
    row.classList.remove('hidden');
    var label = document.createElement('span'); label.className = 'muted small'; label.textContent = 'Jump to:';
    row.appendChild(label);
    stamps.forEach(function (stamp) {
      var btn = document.createElement('button'); btn.type = 'button'; btn.className = 'mini-btn';
      btn.textContent = stamp.label;
      btn.title = 'Seek the page player to ' + stamp.label;
      btn.addEventListener('click', function () {
        var video = selectedVideo();
        sendTabCommand('video-seek', { index: video ? video.index : state.videoSelected, seconds: stamp.seconds })
          .then(function () { videoDetailStatus('Player moved to ' + stamp.label + '.'); })
          .catch(function (e) { videoDetailStatus('Seek failed: ' + e.message); });
      });
      row.appendChild(btn);
    });
  }
  function videoBusy(busy) {
    state.videoBusy = !!busy;
    ['videoScanBtn', 'videoTranscribeBtn', 'videoSummarizeBtn', 'videoTranslateBtn'].forEach(function (id) {
      var el = $(id); if (el) el.disabled = !!busy;
    });
  }
  function videoRunModel(prompt) {
    if (!state.providers.length) throw new Error('No provider configured - open Settings');
    return chatSyncFallback([{ role: 'user', content: prompt }], state.activeProviderId, state.activeModel, null).then(function (text) {
      if (!text || text.indexOf('Error:') === 0) throw new Error((text || 'Model request failed').replace(/^Error:\s*/, ''));
      return text;
    });
  }
  function transcriptFromSegments(segments) {
    if (window.GraphiteCaptions && typeof GraphiteCaptions.segmentsToText === 'function') {
      return GraphiteCaptions.segmentsToText(segments, true);
    }
    return (segments || []).map(function (s) { return s.text; }).join('\n');
  }
  function videoYouTubeTranscript(video) {
    var url = String((video && video.src) || (state.currentTab && state.currentTab.url) || '');
    var id = window.GraphiteYouTube && typeof GraphiteYouTube.parseVideoId === 'function'
      ? GraphiteYouTube.parseVideoId(url) : null;
    if (!id) return Promise.reject(new Error('Could not read a YouTube video id from this page.'));
    videoDetailStatus('Fetching the YouTube transcript...');
    return sendMessage({ type: 'fetchTranscript', url: id }).then(function (r) {
      if (!r || !r.text) throw new Error('No YouTube transcript available for this video.');
      $('videoTranscriptText').value = r.text;
      videoDetailStatus('Transcript ready (' + ((r && r.lang) || 'auto') + '). Summarize or translate below.');
      return r.text;
    });
  }
  function videoCaptionTranscript(video) {
    videoDetailStatus('Looking for captions/subtitles on this player...');
    return sendTabCommand('video-captions', { index: video.index }).then(function (res) {
      if (!res) throw new Error('No caption response from the page.');
      if (res.error) throw new Error(res.error);
      if (res.captionText && window.GraphiteCaptions && typeof GraphiteCaptions.parseCues === 'function') {
        var parsed = GraphiteCaptions.parseCues(String(res.captionText));
        if (parsed && parsed.length) return transcriptFromSegments(parsed);
        // Not VTT/SRT (maybe timedtext XML) — let the background parse it
        // through the same caption lib so parsing logic stays in one place.
        return sendMessage({ type: 'parseCaptions', text: String(res.captionText) }).then(function (r) {
          return (r && r.text) || '';
        });
      }
      if (res.segments && res.segments.length) {
        return sendMessage({ type: 'normalizeCues', cues: res.segments }).then(function (r) {
          return (r && r.text) || transcriptFromSegments(res.segments.map(function (c) {
            return { start: c.startTime || c.start || 0, dur: Math.max(0, (c.endTime || 0) - (c.startTime || 0)), text: c.text || '' };
          }));
        });
      }
      if (res.captionText) return String(res.captionText);
      throw new Error('No captions found on this player.');
    });
  }
  // Extracted-audio hand-off: the content script returns base64 MP3 chunks
  // (WAV only as a last resort); we keep them only long enough to send
  // them one by one to the background transcribe case, then drop the
  // reference (plus a 10-minute safety timer) so large audio never
  // lingers in sidebar memory.
  var pendingAudio = null;
  var pendingAudioTimer = null;
  function clearPendingAudio() {
    pendingAudio = null;
    if (pendingAudioTimer) { clearTimeout(pendingAudioTimer); pendingAudioTimer = null; }
  }
  function holdPendingAudio(chunks) {
    clearPendingAudio();
    pendingAudio = chunks;
    pendingAudioTimer = setTimeout(clearPendingAudio, 10 * 60 * 1000);
    return chunks;
  }
  function transcribeAudioChunks(chunks, video) {
    var texts = [];
    var chain = Promise.resolve();
    (chunks || []).forEach(function (chunk, i) {
      chain = chain.then(function () {
        if (chunks.length > 1) {
          videoDetailStatus('Transcribing extracted audio part ' + (i + 1) + ' of ' + chunks.length + '...');
        }
        // NOTE: no `model` here — the background resolves transcription
        // with { forTranscription: true } so the chat model cannot leak
        // into /audio/transcriptions; Options > Transcription model (or
        // whisper-1 fallback) is what reaches the provider.
        var chunkExt = chunk.format ? String(chunk.format) : String(chunk.mimeType || '').split('/')[1] || 'mp3';
        return sendMessage({
          type: 'transcribe',
          audioBase64: chunk.audioBase64,
          mimeType: chunk.mimeType || 'audio/mpeg',
          filename: 'page-video-' + (Number(video && video.index) || 0) + '-part' + (i + 1) + '.' + chunkExt,
          providerId: state.activeProviderId
        }).then(function (r) {
          var text = (r && (r.text || r.transcript)) || '';
          if (text) texts.push(text);
        });
      });
    });
    return chain.then(function () {
      var joined = texts.join('\n').trim();
      if (!joined) throw new Error('The transcription provider returned no text for the extracted audio.');
      return joined;
    });
  }
  function videoDirectUrlTranscript(video, srcOverride) {
    var attempt = srcOverride
      ? Promise.resolve({ ok: true, url: srcOverride })
      : sendTabCommand('video-media', { index: video.index });
    return attempt.then(function (media) {
      if (!media || !media.ok) throw new Error((media && media.error) || 'No direct media URL for transcription.');
      var src = String(media.url || '');
      if (!src) throw new Error('This player has no direct media URL.');
      if (/^blob:/i.test(src)) throw new Error('This player streams via a blob/MSE source that cannot be sent to the transcription provider.');
      videoDetailStatus('Sending the media file to your provider for transcription. Long files can take a while...');
      return sendMessage({
        type: 'transcribe', dataUrl: src, audioDataUrl: src,
        filename: 'page-video-' + (Number(video.index) || 0),
        providerId: state.activeProviderId
      }).then(function (r) {
        var text = (r && (r.text || r.transcript)) || '';
        if (!text) throw new Error('The transcription provider returned no text.');
        return text;
      });
    });
  }
  function videoManifestTranscript(video) {
    // Best route: the site's OWN separate audio rendition. Most HLS/DASH
    // players keep audio as compressed AAC/Opus segments in the manifest;
    // the background fetches and uploads those bytes directly — no
    // in-page re-encode, no WAV, no base64 hop through the sidebar.
    videoDetailStatus('Looking for a separate audio track in the stream manifest (HLS/DASH)...');
    return sendTabCommand('video-manifest-audio', {
      index: video.index, srcs: video.srcs || [], manifestUrls: video.manifestUrls || []
    }).then(function (res) {
      if (!res || !res.ok) throw new Error((res && res.error) || 'No streaming manifest found for this player.');
      var plan = { manifestUrl: res.manifestUrl || '' };
      if (res.segments && res.segments.length) {
        plan.manifestAudio = { init: res.init || null, segments: res.segments, mimeType: res.mimeType || '' };
      }
      var via = res.kind === 'dash' ? 'DASH' : 'HLS';
      videoDetailStatus('Found the ' + via + ' audio track' + (res.lang ? ' (' + res.lang + ')' : '') + '. Sending it to your provider for transcription...');
      return sendMessage({
        type: 'transcribe',
        manifestUrl: plan.manifestUrl,
        manifestAudio: plan.manifestAudio,
        providerId: state.activeProviderId
      }).then(function (r) {
        var text = (r && (r.text || r.transcript)) || '';
        if (!text) throw new Error('The transcription provider returned no text for the manifest audio.');
        return text;
      });
    });
  }
  function videoAudioTranscript(video) {
    // Order: (1) manifest audio rendition (background fetches the site's
    // compressed segments), (2) in-page extraction — fetch + decode in the
    // page, convert to MP3 chunks (captureStream/WebM for pure MSE), (3)
    // direct media file URL. Only the page can observe blob:/MSE media.
    return videoManifestTranscript(video).catch(function (manifestErr) {
      videoDetailStatus('No manifest audio track (' + manifestErr.message + ') Extracting audio from the player in the page...');
      return sendTabCommand('video-extract-audio', { index: video.index, srcs: video.srcs || [] }).then(function (res) {
        if (res && res.ok && res.chunks && res.chunks.length) {
          var chunks = holdPendingAudio(res.chunks);
          var fmt = String(res.format || 'mp3').toUpperCase();
          videoDetailStatus('Extracted ' + chunks.length + ' ' + fmt + ' audio chunk' + (chunks.length === 1 ? '' : 's') + ' (' + (res.duration || '?') + 's' + (res.source === 'capture' ? ', captured from the player' : '') + '). Transcribing...');
          return transcribeAudioChunks(chunks, video).then(function (text) {
            clearPendingAudio();
            return text;
          }, function (err) {
            clearPendingAudio();
            throw err;
          });
        }
        var extractError = (res && res.error) || 'Audio extraction was not possible on this player.';
        var directUrl = '';
        var candidates = [video.src].concat(video.srcs || []);
        for (var i = 0; i < candidates.length; i++) {
          var candidate = String(candidates[i] || '');
          if (candidate && !/^blob:/i.test(candidate) && /^https?:/i.test(candidate)) { directUrl = candidate; break; }
        }
        if (!directUrl) throw new Error(extractError);
        videoDetailStatus(extractError + ' Falling back to the direct media file...');
        return videoDirectUrlTranscript(video, directUrl);
      });
    });
  }
  // ownBusy: when Summarize/Translate drive the transcription they hold the
  // busy flag themselves, so the transcript step must not release it early.
  function transcribeSelectedVideo(ownBusy) {
    var video = selectedVideo();
    if (!video) { videoStatus('Select a video first.'); return Promise.resolve(); }
    if (state.videoBusy && ownBusy !== false) return Promise.resolve();
    var manageBusy = ownBusy !== false;
    if (manageBusy) videoBusy(true);
    var done = function () { if (manageBusy) videoBusy(false); };
    var steps;
    if (video.youTube || videoIsYouTubeUrl(video.src) || videoIsYouTubeUrl(state.currentTab && state.currentTab.url)) {
      steps = videoYouTubeTranscript(video);
    } else {
      steps = videoCaptionTranscript(video).catch(function (captionErr) {
        videoDetailStatus('No usable captions (' + captionErr.message + ') Trying audio transcription...');
        return videoAudioTranscript(video);
      });
    }
    return steps.then(function (text) {
      $('videoTranscriptText').value = truncate(String(text || ''), 120000);
      renderVideoResult('');
      videoDetailStatus(text ? 'Transcript ready — ' + String(text).length.toLocaleString() + ' characters. Edit it if needed, then Summarize or Translate.' : 'Transcript came back empty.');
    }).catch(function (e) {
      videoDetailStatus('Transcription failed: ' + e.message + ' (audio transcription needs an OpenAI-compatible provider with a Whisper endpoint.)');
    }).then(done);
  }
  function ensureVideoTranscript(video) {
    var existing = $('videoTranscriptText').value.trim();
    if (existing) return Promise.resolve(existing);
    // Caller (Summarize/Translate) already holds the busy flag.
    return transcribeSelectedVideo(false).then(function () {
      return $('videoTranscriptText').value.trim();
    });
  }
  function summarizeSelectedVideo() {
    var video = selectedVideo();
    if (!video) { videoStatus('Select a video first.'); return; }
    if (state.videoBusy) return;
    videoBusy(true);
    ensureVideoTranscript(video).then(function (transcript) {
      if (!transcript) throw new Error('No transcript yet — run Transcribe first.');
      videoDetailStatus('Summarizing in the Videos tab...');
      var prompt = (window.GraphiteYouTube && typeof GraphiteYouTube.buildYouTubeSummaryPrompt === 'function')
        ? GraphiteYouTube.buildYouTubeSummaryPrompt(truncate(transcript, 60000), video.label || document.title || 'Page video')
        : 'Summarize this video transcript. Use timestamps as given.\n\nTitle: ' + (video.label || '') + '\n\n' + truncate(transcript, 60000);
      return videoRunModel(prompt);
    }).then(function (text) {
      renderVideoResult(text);
      videoDetailStatus('Summary ready.');
    }).catch(function (e) { videoDetailStatus('Summary failed: ' + e.message); }).then(function () { videoBusy(false); });
  }
  function translateSelectedVideo() {
    var video = selectedVideo();
    if (!video) { videoStatus('Select a video first.'); return; }
    if (state.videoBusy) return;
    var langSel = $('videoLangSel');
    var lang = langSel && langSel.value ? langSel.value : defaultTargetLang();
    videoBusy(true);
    ensureVideoTranscript(video).then(function (transcript) {
      if (!transcript) throw new Error('No transcript yet — run Transcribe first.');
      videoDetailStatus('Translating the transcript to ' + lang + '...');
      var prompt = 'Translate the following video transcript into ' + lang + '. Preserve the meaning, speaker intent, and all timestamps (e.g. [03:12]) exactly as they appear. Output only the translated transcript in Markdown, grouped naturally.\n\nTitle: ' + (video.label || '') + '\n\nTranscript:\n' + truncate(transcript, 60000);
      return videoRunModel(prompt);
    }).then(function (text) {
      renderVideoResult(text);
      videoDetailStatus('Translation ready (' + lang + ').');
    }).catch(function (e) { videoDetailStatus('Translation failed: ' + e.message); }).then(function () { videoBusy(false); });
  }
  function downloadVideoResult() {
    if (!state.videoResultRaw) return;
    var video = selectedVideo();
    var base = ((video && (video.label || video.src)) || 'page-video').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'page-video';
    var blob = new Blob([state.videoResultRaw], { type: 'text/markdown' });
    var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = base + '.md'; a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
    status('Video result downloaded');
  }
  function openVideoInChat() {
    var video = selectedVideo();
    var transcript = $('videoTranscriptText') ? $('videoTranscriptText').value.trim() : '';
    var result = state.videoResultRaw || '';
    if (!transcript && !result) {
      $('composer').value = '';
      switchView('chat');
      status('Videos: scan the page and transcribe a video, then Open in chat to ask follow-ups.');
      return;
    }
    var label = video ? (video.label || video.src || 'Page video') : 'Page video';
    var text = (result ? result + '\n\n' : '') +
      'Here is the transcript of the video "' + label + '" from the open page. Use it to answer my follow-up questions.\n\n' +
      truncate(transcript || result, 20000);
    setContext(text, 'Video: ' + truncate(label, 60));
    switchView('chat');
    var composer = $('composer');
    if (composer) composer.focus();
  }

  /* ---------------- pending actions ---------------- */
  function handlePendingAction(action) {
    if (!action) return;
    var type = action.type || action.action || '';
    var text = action.text || action.selection || action.content || '';
    // Background context menus (sibling agent) may send tone-qualified ids
    // 'rewrite-<tone>', promptId 'rewrite-<tone>', or tone:'<tone>' /
    // rewriteTone:'<tone>'. All resolve against the shared tone table.
    var rawToneSource = action.tone || action.rewriteTone || action.promptId || action.prompt_id || type || '';
    var pendingToneId = rewriteToneIdFromActionId(rawToneSource);
    var isRewrite = !!pendingToneId || type === 'rewrite' || type === 'rewrite-selection';
    var promptId = action.promptId || action.prompt_id || '';
    var isPendingTranslate = type === 'translate' || type === 'translate-selection' || promptId === 'translate';
    var map = {
      'summarize-selection': 'Summarize this selection:\n\n',
      'summarize': 'Summarize this:\n\n',
      'explain-selection': 'Explain this selection clearly:\n\n',
      'explain': 'Explain this clearly:\n\n',
      'ask-selection': ''
    };
    if (isPendingTranslate && text) {
      openTranslateTool(text);
      return;
    }
    if (action.url && isYouTube(action.url)) {
      attachYouTube(action.url).then(function () {
        var transcript = state.ytTranscript || state.contextText || '';
        var title = action.title || (state.currentTab && state.currentTab.title) || '';
        var built = window.GraphiteYouTube && typeof GraphiteYouTube.buildYouTubeSummaryPrompt === 'function'
          ? GraphiteYouTube.buildYouTubeSummaryPrompt(transcript, title)
          : transcript;
        runToolPrompt(built);
      }).catch(function (e) { status('YouTube failed: ' + (e && e.message || e)); });
      return;
    }
    if (type === 'summarize-page' || type === 'summarize_page') { attachPage().then(function () { runToolPrompt('Summarize this page.'); }); return; }
    if (isRewrite) {
      if (!text) { if (action.prompt) runToolPrompt(action.prompt); return; }
      runToolPrompt(rewritePromptFor(pendingToneId || 'professional', text, action.customTone || ''));
      return;
    }
    if (text || map[type] !== undefined) {
      var prefix = map[type] != null ? map[type] : '';
      runToolPrompt(prefix + text || (action.prompt || ''));
    } else if (action.prompt) runToolPrompt(action.prompt);
  }
  function checkPendingAction() {
    sendMessage({ type: 'getPendingAction' }).then(function (r) {
      var a = r && (r.action || r);
      if (a && (a.type || a.action || a.text || a.prompt)) handlePendingAction(a);
    }).catch(function () {});
    storageGet(PENDING_KEY).then(function (o) {
      var a = o[PENDING_KEY];
      if (a) { var c = {}; c[PENDING_KEY] = null; storageSet(c); handlePendingAction(a); }
    }).catch(function () {});
  }

  /* ---------------- wiring ---------------- */
  function init() {
    if (!api) { status('browser API unavailable'); return; }
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) { t.addEventListener('click', function () { switchView(t.dataset.view); }); });
    $('settingsBtn').addEventListener('click', openSettings);
    $('bannerSettingsBtn').addEventListener('click', openSettings);
    $('newChatBtn').addEventListener('click', newChat);
    $('providerSelect').addEventListener('change', function () { closeModelPicker(); state.activeProviderId = this.value; var np = state.providers.find(function (x) { return x.id === state.activeProviderId; }); state.activeModel = np && np.model ? np.model : ''; renderModelSelect(); renderGroupModels(); sendMessage({ type: 'setActiveModel', providerId: state.activeProviderId, model: state.activeModel }).catch(function () {}); });
    if ($('modelButton')) $('modelButton').addEventListener('click', function () { toggleModelPicker(); });
    if ($('modelSearch')) {
      $('modelSearch').addEventListener('input', function () { renderModelList(); });
      $('modelSearch').addEventListener('keydown', function (e) {
        if (e.key === 'ArrowDown') { e.preventDefault(); setHighlight(modelPickerState.highlight + 1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); setHighlight(modelPickerState.highlight - 1); }
        else if (e.key === 'Enter') { e.preventDefault(); var m = modelPickerState.filtered[modelPickerState.highlight]; if (m) selectModel(m); }
        else if (e.key === 'Escape') { e.preventDefault(); closeModelPicker(); var b = $('modelButton'); if (b) b.focus(); }
      });
    }
    document.addEventListener('pointerdown', function (e) {
      if (!modelPickerState.open) return;
      var picker = $('modelPicker');
      if (picker && e.target !== picker && !picker.contains(e.target)) closeModelPicker();
    });
    $('sendBtn').addEventListener('click', function () { sendCurrent(); });
    $('stopBtn').addEventListener('click', stopGeneration);
    $('composer').addEventListener('keydown', function (e) {
      var pop = $('slashPopup');
      if (!pop.classList.contains('hidden') && (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Tab')) {
        e.preventDefault();
        var hits = pop._hits || []; if (!hits.length) return;
        state.slashIndex = (state.slashIndex + (e.key === 'ArrowUp' ? -1 : 1) + hits.length) % hits.length;
        Array.prototype.forEach.call(pop.querySelectorAll('.slash-item'), function (el, i) { el.classList.toggle('selected', i === state.slashIndex); });
        return;
      }
      if (!pop.classList.contains('hidden') && e.key === 'Enter' && pop._hits && pop._hits[state.slashIndex]) { e.preventDefault(); pickSlash(pop._hits[state.slashIndex]); return; }
      if (e.key === 'Escape') { hideSlash(); return; }
      if (e.key === 'Enter' && !e.shiftKey) {
        // Coarse pointers (soft keyboards): Enter inserts a newline —
        // sending is the Send button's job there. Desktop keeps
        // Enter-to-send. IME composition never sends.
        var coarse = false;
        try { coarse = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches); } catch (err) {}
        if (!e.isComposing && !coarse) { e.preventDefault(); sendCurrent(); }
      }
    });
    $('composer').addEventListener('input', checkSlash);
    $('groupToggle').addEventListener('change', function () { state.groupMode = this.checked; $('groupModels').classList.toggle('hidden', !this.checked); });
    $('clearContextBtn').addEventListener('click', clearContext);
    $('attachPageBtn').addEventListener('click', function () { attachPage(); });
    $('attachYouTubeBtn').addEventListener('click', function () { attachYouTube(); });
    $('attachImageBtn').addEventListener('click', function () { $('fileImage').click(); });
    $('attachPdfBtn').addEventListener('click', function () { $('filePdf').click(); });
    $('attachAudioBtn').addEventListener('click', function () { $('fileAudio').click(); });
    $('attachTextBtn').addEventListener('click', function () { $('fileText').click(); });
    $('fileImage').addEventListener('change', function () { if (this.files[0]) handleImageFile(this.files[0]); this.value = ''; });
    $('filePdf').addEventListener('change', function () { if (this.files[0]) handlePdfFile(this.files[0]); this.value = ''; });
    $('fileAudio').addEventListener('change', function () { if (this.files[0]) handleAudioFile(this.files[0], false); this.value = ''; });
    $('fileText').addEventListener('change', function () { if (this.files[0]) handleTextFile(this.files[0]); this.value = ''; });
    $('addPromptBtn').addEventListener('click', function () { state.editingPromptId = null; $('promptForm').classList.remove('hidden'); });
    $('cancelPromptBtn').addEventListener('click', function () { $('promptForm').classList.add('hidden'); state.editingPromptId = null; });
    $('savePromptBtn').addEventListener('click', saveCustomPrompt);
    if ($('promptSelect')) $('promptSelect').addEventListener('change', function () { selectedPromptId = this.value; updatePromptActions(); });
    if ($('promptInsertBtn')) $('promptInsertBtn').addEventListener('click', insertSelectedPrompt);
    if ($('promptEditBtn')) $('promptEditBtn').addEventListener('click', editSelectedPrompt);
    if ($('promptDeleteBtn')) $('promptDeleteBtn').addEventListener('click', deleteSelectedPrompt);
    $('clearHistoryBtn').addEventListener('click', function () { storageSet({ graphite_history: [] }).then(renderHistory); });
    if ($('toolsSearch')) $('toolsSearch').addEventListener('input', function () { renderTools(); });
    if ($('codeGenerateBtn')) $('codeGenerateBtn').addEventListener('click', codeGenerate);
    if ($('codeOutlineBtn')) $('codeOutlineBtn').addEventListener('click', codeOutline);
    if ($('codeApplyBtn')) $('codeApplyBtn').addEventListener('click', codeApply);
    if ($('codeRemoveBtn')) $('codeRemoveBtn').addEventListener('click', codeRemove);
    if ($('codeSaveBtn')) $('codeSaveBtn').addEventListener('click', codeSave);
    if ($('handPlanBtn')) $('handPlanBtn').addEventListener('click', handPlan);
    if ($('handOutlineBtn')) $('handOutlineBtn').addEventListener('click', handOutline);
    if ($('handRunAllBtn')) $('handRunAllBtn').addEventListener('click', handRunAll);
    if ($('handStopBtn')) $('handStopBtn').addEventListener('click', function () { state.handStop = true; handLog('Stop requested — the current step will finish, then the run halts.'); });
    if ($('handFinishBtn')) $('handFinishBtn').addEventListener('click', function () { finishHandRun(handOutcomeFor()); });
    if ($('handCopySummaryBtn')) $('handCopySummaryBtn').addEventListener('click', copyHandSummary);
    if ($('handDownloadSummaryBtn')) $('handDownloadSummaryBtn').addEventListener('click', downloadHandSummary);
    if ($('videoScanBtn')) $('videoScanBtn').addEventListener('click', videoScan);
    if ($('videoTranscribeBtn')) $('videoTranscribeBtn').addEventListener('click', transcribeSelectedVideo);
    if ($('videoSummarizeBtn')) $('videoSummarizeBtn').addEventListener('click', summarizeSelectedVideo);
    if ($('videoTranslateBtn')) $('videoTranslateBtn').addEventListener('click', translateSelectedVideo);
    if ($('videoCopyBtn')) $('videoCopyBtn').addEventListener('click', function () {
      if (!state.videoResultRaw) return;
      if (navigator.clipboard) navigator.clipboard.writeText(state.videoResultRaw).then(function () { status('Video result copied'); }).catch(function () { status('Copy failed'); });
    });
    if ($('videoDownloadBtn')) $('videoDownloadBtn').addEventListener('click', downloadVideoResult);
    if ($('videoChatBtn')) $('videoChatBtn').addEventListener('click', openVideoInChat);
    if ($('researchRunBtn')) $('researchRunBtn').addEventListener('click', runResearch);
    if ($('researchCopyBtn')) $('researchCopyBtn').addEventListener('click', function () {
      if (!state.researchRaw) return;
      if (navigator.clipboard) navigator.clipboard.writeText(state.researchRaw).then(function () { status('Report copied'); }).catch(function () { status('Copy failed'); });
    });
    if ($('researchDownloadBtn')) $('researchDownloadBtn').addEventListener('click', downloadResearchReport);
    $('closeArtifactBtn').addEventListener('click', function () { $('artifactBar').classList.add('hidden'); });
    $('downloadArtifactBtn').addEventListener('click', function () {
      var blob = new Blob([state.lastArtifact], { type: 'text/html' });
      var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'graphite-artifact.html'; a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
    });
    try {
      if (api.storage && api.storage.onChanged) api.storage.onChanged.addListener(function (changes, area) {
        if (area === 'local' && changes[PENDING_KEY] && changes[PENDING_KEY].newValue) {
          var c = {}; c[PENDING_KEY] = null; storageSet(c);
          handlePendingAction(changes[PENDING_KEY].newValue);
        }
        if (area === 'local' && changes[SETTINGS_KEY]) loadSettings();
      });
      if (api.tabs && api.tabs.onActivated) api.tabs.onActivated.addListener(function (info) {
        // Chat-as-tab: remember the page tab the user switches away from,
        // so context actions keep targeting it.
        if (info && info.tabId != null && api.tabs.get) {
          api.tabs.get(info.tabId).then(function (t) { rememberOriginTab(t); }).catch(function () {});
        }
        refreshPageChip();
      });
      if (api.tabs && api.tabs.onUpdated) api.tabs.onUpdated.addListener(function (id, info) { if (info.title || info.url) refreshPageChip(); });
    } catch (e) {}

    try {
      if (api.runtime && api.runtime.onMessage) api.runtime.onMessage.addListener(function (msg) {
        if (msg && msg.type === 'pendingAction' && msg.action) handlePendingAction(msg.action);
        return undefined;
      });
    } catch (e) {}
    $('messages').addEventListener('click', function (event) {
      try {
        var clickSel = window.getSelection ? window.getSelection() : null;
        if (clickSel && !clickSel.isCollapsed && String(clickSel.toString() || '')) return;
      } catch (e) { /* fall through to seek */ }
      var target = event.target && event.target.closest ? event.target.closest('[data-seek-seconds]') : null;
      if (!target) return;
      var inBody = target.closest && target.closest('.msg .body');
      if (!inBody) return;
      var seconds = parseTimestampSeconds(target.getAttribute('data-seek-seconds'));
      if (seconds == null) return;
      event.preventDefault();
      seekActiveVideo(seconds);
    });
    var initMsgBox = $('messages'); initMsgBox.textContent = ''; initMsgBox.appendChild(emptyNoteEl('Attach a page, YouTube video, or file - or just ask.'));
    loadToolFavorites().then(function () { renderTools(); });
    renderTools();
    loadSettings().then(function () { refreshPageChip(); checkPendingAction(); });
  }
  function openSettings() {
    try {
      if (api.runtime.openOptionsPage) { var p = api.runtime.openOptionsPage(); if (p && p.catch) p.catch(function () {}); }
      else api.tabs.create({ url: api.runtime.getURL('options/options.html') });
    } catch (e) { try { api.tabs.create({ url: api.runtime.getURL('options/options.html') }); } catch (e2) { status('Settings unavailable: ' + e2.message); } }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
