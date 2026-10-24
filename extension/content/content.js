/* Graphite Sider - content script (all pages, document_end).
   Selection toolbar, result popover, writing assistant, full-page
   translate, read-aloud, page-text extraction and image OCR.
   All overlay UI lives in a Shadow DOM root (#graphite-sider-root)
   styled by content/overlay.css to avoid page CSS leakage. */
(function () {
  'use strict';

  if (window.__graphiteContentLoaded) return;
  window.__graphiteContentLoaded = true;

  const runtime = (typeof browser !== 'undefined' && browser.runtime)
    ? browser.runtime
    : (typeof chrome !== 'undefined' ? chrome.runtime : null);
  if (!runtime) return;

  const DEFAULT_SETTINGS = {
    selectionToolbar: true,
    searchEnhance: true,
    writingAssistant: true,
    targetLanguage: 'English',
    translateLanguage: '',
    language: ''
  };

  let settings = Object.assign({}, DEFAULT_SETTINGS);
  let shadowRoot = null;
  let overlayCssText = '';
  let lastSelectionText = '';
  let lastSelectionRect = null;
  let popoverState = { lastText: '', action: '' };
  // Current rewrite tone (id from GraphitePrompts.REWRITE_TONES). In-memory
  // only; the shared table in lib/prompts.js is the source of truth.
  let currentRewriteToneId = 'neutral';
  // Data captured for the open result card so "Try another tone" can re-run.
  let cardContext = { text: '', rect: null, kind: '' };
  let translateState = { active: false, entries: [], running: false };

  function targetLang() {
    return settings.translateLanguage || settings.targetLanguage || settings.language || 'English';
  }

  const SETTINGS_KEYS = ['graphiteSider.settings.v1', 'graphite_settings'];
  function flattenSettings(stored) {
    const flat = Object.assign({}, stored || {});
    const inner = (stored && stored.settings) || {};
    if (inner.targetLang && !flat.targetLanguage) flat.targetLanguage = inner.targetLang;
    if (inner.targetLang && !flat.translateLanguage) flat.translateLanguage = inner.targetLang;
    // translationLanguages may live nested (inner) or flattened (top level);
    // keep the raw array so translateLanguages() can dedupe/trim it. Only
    // overwrite when the nested side actually carries an array.
    if (Array.isArray(inner.translationLanguages)) flat.translationLanguages = inner.translationLanguages;
    else if (!Array.isArray(flat.translationLanguages)) flat.translationLanguages = undefined;
    flat.selectionToolbar = inner.selectionToolbar !== false;
    flat.searchEnhance = inner.searchEnhance !== false;
    flat.writingAssistant = inner.writingAssistant !== false;
    return flat;
  }

  async function loadSettings() {
    try {
      const api = typeof browser !== 'undefined' ? browser : chrome;
      const data = await api.storage.local.get(SETTINGS_KEYS);
      const stored = (data && (data['graphiteSider.settings.v1'] || data.graphite_settings)) || {};
      settings = Object.assign({}, DEFAULT_SETTINGS, flattenSettings(stored));
    } catch (e) {
      settings = Object.assign({}, DEFAULT_SETTINGS);
    }
    return settings;
  }

  try {
    const api = typeof browser !== 'undefined' ? browser : chrome;
    if (api.storage && api.storage.onChanged) {
      api.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        const change = changes['graphiteSider.settings.v1'] || changes.graphite_settings;
        if (change) {
          settings = Object.assign({}, DEFAULT_SETTINGS, flattenSettings(change.newValue || {}));
          if (settings.selectionToolbar === false) hideToolbar();
        }
      });
    }
  } catch (e) { /* storage change listener is best-effort */ }

  // ---------------------------------------------------------------- utils

  function escapeHtml(text) {
    return String(text == null ? '' : text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // Minimal markdown-lite: escape first, then bold/italic/code/lists/headings.
  function markdownLite(text) {
    const escaped = escapeHtml(text);
    const blocks = escaped.split(/\n{2,}/);
    const html = blocks.map((block) => {
      const lines = block.split('\n');
      const trimmed = block.trim();
      if (!trimmed) return '';
      const heading = trimmed.match(/^(#{1,4})\s+(.*)$/);
      if (heading && lines.length === 1) {
        const level = Math.min(heading[1].length + 2, 6);
        return '<h' + level + '>' + inlineMd(heading[2]) + '</h' + level + '>';
      }
      const isList = lines.every((l) => /^\s*([-*]|\d+\.)\s+/.test(l));
      if (isList && lines.length > 1) {
        const ordered = /^\s*\d+\./.test(lines[0]);
        const items = lines.map((l) => '<li>' + inlineMd(l.replace(/^\s*([-*]|\d+\.)\s+/, '')) + '</li>').join('');
        return (ordered ? '<ol>' : '<ul>') + items + (ordered ? '</ol>' : '</ul>');
      }
      if (lines.length === 1 && lines[0].trim().startsWith('```')) return '';
      return '<p>' + lines.map(inlineMd).join('<br>') + '</p>';
    }).join('');
    return html;
  }

  function inlineMd(text) {
    return String(text)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function clampRect(left, top, width, height) {
    const margin = 8;
    return {
      left: clamp(left, margin, Math.max(margin, window.innerWidth - width - margin)),
      top: clamp(top, margin, Math.max(margin, window.innerHeight - height - margin))
    };
  }

  function truncate(text, max) {
    const value = String(text || '');
    return value.length > max ? value.slice(0, max) : value;
  }

  async function chatSync(messages, action) {
    const raw = await runtime.sendMessage({ type: 'chatSync', messages, action });
    if (!raw) throw new Error('No response from background');
    const res = (raw && typeof raw === 'object' && 'ok' in raw && ('result' in raw || 'error' in raw))
      ? (raw.ok ? raw.result : (() => { throw new Error(raw.error || 'Request failed'); })())
      : raw;
    if (!res) throw new Error('No response from background');
    if (res.error) throw new Error(res.error);
    if (res.ok === false) throw new Error(res.text || 'Request failed');
    return res.text || '';
  }

  function openSidebarWith(action, text) {
    try {
      const promise = runtime.sendMessage({
        type: 'openSidebarWith',
        action: action || 'chat',
        text: text || '',
        url: location.href,
        title: document.title
      });
      if (promise && typeof promise.catch === 'function') promise.catch(() => {});
    } catch (e) { /* sidebar open is best-effort */ }
  }

  /* ---- Rewrite tones: single source of truth is lib/prompts.js
   * (GraphitePrompts.REWRITE_TONES + rewriteTonePrompt), but that lib is not
   * a content script on normal pages (see manifest), so the inline table
   * below is the content-script mirror of the same ids/labels; when the lib
   * IS present it takes precedence. If the two ever diverge, lib wins. ---- */
  const FALLBACK_REWRITE_TONES = [
    { id: 'neutral', label: 'Neutral (default)', instruction: 'clearer and more natural, with a balanced, unmarked voice.' },
    { id: 'professional', label: 'Professional', instruction: 'a polished workplace voice: precise, courteous and competent.' },
    { id: 'formal', label: 'Formal', instruction: 'an elevated formal register: no contractions or colloquialisms, measured and respectful phrasing.' },
    { id: 'casual', label: 'Casual', instruction: 'a relaxed everyday voice: contractions, simple words and a conversational rhythm.' },
    { id: 'friendly', label: 'Friendly', instruction: 'a warm, approachable, helpful and upbeat voice.' },
    { id: 'confident', label: 'Confident', instruction: 'an assertive voice: strong verbs and declarative sentences, hedging removed.' },
    { id: 'polite', label: 'Polite', instruction: 'a maximally courteous, considerate voice that softens requests and corrections.' },
    { id: 'empathetic', label: 'Empathetic', instruction: 'an understanding, supportive voice that acknowledges feelings first.' },
    { id: 'witty', label: 'Witty', instruction: 'a light, clever, playful voice; never force jokes.' },
    { id: 'academic', label: 'Academic', instruction: 'a scholarly register: precise terminology, objective phrasing, no fabricated citations.' },
    { id: 'creative', label: 'Creative', instruction: 'an expressive, vivid voice with varied rhythm, message kept unmistakable.' },
    { id: 'persuasive', label: 'Persuasive', instruction: 'a compelling, benefit-led voice speaking to the reader\'s motivations.' },
    { id: 'concise', label: 'Concise', instruction: 'a tight, economical voice with redundancy and filler cut.', length: 'shorter' },
    { id: 'expanded', label: 'Expanded / Elaborate', instruction: 'a more developed, thorough voice that unpacks existing points only.', length: 'longer' },
    { id: 'simplify', label: 'Simplify (plain English)', instruction: 'plain English: short sentences, common words, no unexplained jargon.' }
  ];

  function graphitePromptsLib() {
    try {
      const G = (typeof window !== 'undefined' && window.GraphitePrompts) ||
        (typeof globalThis !== 'undefined' && globalThis.GraphitePrompts);
      return (G && typeof G === 'object') ? G : null;
    } catch (e) { return null; }
  }

  // [{id, label, instruction?, length?}] — lib table wins when present.
  function rewriteTones() {
    const G = graphitePromptsLib();
    if (G && Array.isArray(G.REWRITE_TONES) && G.REWRITE_TONES.length) return G.REWRITE_TONES;
    return FALLBACK_REWRITE_TONES;
  }

  function resolveRewriteTone(raw) {
    const tones = rewriteTones();
    const id = String(raw == null ? '' : raw).trim().toLowerCase().replace(/^rewrite-/, '');
    return tones.find((t) => t.id === id) || null;
  }

  function currentRewriteTone() {
    return resolveRewriteTone(currentRewriteToneId) || rewriteTones()[0] || FALLBACK_REWRITE_TONES[0];
  }

  function rewriteLengthRule(tone) {
    if (tone && tone.length === 'shorter') return 'Shorten it to roughly 50-70% of the original length while keeping every key fact and number.';
    if (tone && tone.length === 'longer') return 'Lengthen it to roughly 130-180% of the original length by developing the existing points only.';
    return 'Keep roughly the same length (within about 20%).';
  }

  /**
   * Render the prompt for a tone. Prefers the shared lib renderer.
   * @param {string} toneId e.g. 'formal' or 'rewrite-formal'
   * @param {object} vars { text|selection|input, customTone } (or a string)
   */
  function rewriteTonePrompt(toneId, vars) {
    const text = (vars && typeof vars === 'object')
      ? (vars.text != null ? vars.text : (vars.selection != null ? vars.selection : (vars.input != null ? vars.input : '')))
      : String(vars == null ? '' : vars);
    const custom = (vars && typeof vars === 'object') ? String(vars.customTone || vars.custom || '').trim() : '';
    const G = graphitePromptsLib();
    if (G && typeof G.rewriteTonePrompt === 'function') {
      try { return G.rewriteTonePrompt(toneId, { text, customTone: custom }); } catch (e) { /* fall through */ }
    }
    if (G && typeof G.getBuiltin === 'function' && typeof G.renderPrompt === 'function') {
      const tone = resolveRewriteTone(toneId);
      const builtin = tone ? G.getBuiltin('rewrite-' + tone.id) : null;
      if (builtin) { try { return G.renderPrompt(builtin.body, { text, selection: text }); } catch (e) { /* fall through */ } }
    }
    const resolved = resolveRewriteTone(toneId);
    if (!resolved && custom) {
      return 'Rewrite the following text in a tone described as: ' + custom +
        '. Preserve the meaning, all facts, names and numbers. Keep roughly the same length. Output only the rewritten text.\n\nText:\n"""' + text + '"""';
    }
    const tone = resolved || rewriteTones()[0] || FALLBACK_REWRITE_TONES[0];
    return 'Rewrite the following text.\n\nTone: ' + tone.label + ' - write in ' + tone.instruction +
      '\n\nRules: preserve the meaning, all facts, names, numbers and intent; do not add new claims; ' +
      rewriteLengthRule(tone) + ' Output only the rewritten text.\n\nText:\n"""' + text + '"""';
  }

  function promptFor(action, text, toneIdOrOptions) {
    // Back-compat: callers pass either a tone id string (rewrite) or an
    // options object { toneId, lang } (translate override).
    let options = {};
    if (toneIdOrOptions && typeof toneIdOrOptions === 'object') options = toneIdOrOptions;
    else if (toneIdOrOptions != null) options = { toneId: toneIdOrOptions };
    const toneId = options.toneId;
    const translateLang = options.lang ? String(options.lang).trim() : '';
    // Cheap lib calls first (lib may be injected on some pages). Skipped when
    // an explicit translate language is requested so the override wins.
    const G = graphitePromptsLib();
    if (G && action !== 'rewrite' && !(action === 'translate' && translateLang)) {
      const fn = G[action] || G.selection;
      if (typeof fn === 'function') {
        try { return fn(text, settings); } catch (e) { /* fall through */ }
      }
    }
    const lang = translateLang || targetLang();
    switch (action) {
      case 'explain':
        return 'Explain the following text clearly and concisely. Use simple language and examples where helpful.\n\nText:\n"""' + text + '"""';
      case 'translate':
        return 'Translate the following text into ' + lang + '. Output only the translation.\n\nText:\n"""' + text + '"""';
      case 'summarize':
        return 'Summarize the following text in a few concise bullet points.\n\nText:\n"""' + text + '"""';
      case 'grammar':
        return 'Fix grammar, spelling and punctuation in the following text. Output only the corrected text, then a brief list of the main fixes.\n\nText:\n"""' + text + '"""';
      case 'rewrite':
        return rewriteTonePrompt(toneId || currentRewriteToneId, { text });
      case 'ask':
        return String(text || '');
      default:
        return String(text || '');
    }
  }

  // ------------------------------------------------------- shadow root UI

  function ensureRoot() {
    if (shadowRoot) return shadowRoot;
    let host = document.getElementById('graphite-sider-root');
    if (!host) {
      host = document.createElement('div');
      host.id = 'graphite-sider-root';
      (document.documentElement || document.body).appendChild(host);
    }
    shadowRoot = host.shadowRoot || host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = overlayCssText;
    shadowRoot.appendChild(style);
    const root = document.createElement('div');
    root.className = 'gs-root';
    root.innerHTML =
      '<div class="gs-toolbar gs-hidden" data-gs="toolbar"></div>' +
      '<div class="gs-card gs-hidden" data-gs="card">' +
        '<div class="gs-card-header" data-gs="card-header">' +
          '<span class="gs-card-title" data-gs="card-title">Graphite</span>' +
          '<button class="gs-card-close" data-gs="card-close" title="Close">&times;</button>' +
        '</div>' +
        '<div class="gs-card-body" data-gs="card-body"></div>' +
        '<div class="gs-card-footer" data-gs="card-footer"></div>' +
      '</div>' +
      '<button type="button" class="gs-write-btn gs-hidden" data-gs="write-btn" title="Graphite writing assistant" aria-label="Graphite writing assistant"><svg viewBox="0 0 32 32" width="16" height="16" aria-hidden="true" focusable="false"><path d="M16 2 L28 12 L16 30 L4 12 Z" fill="#26292f" stroke="currentColor" stroke-width="1.6"/><path d="M4 12 H28 M16 2 L11 12 L16 30 L21 12 L16 2" fill="none" stroke="#8b9bb4" stroke-width="1"/></svg></button>' +
      '<div class="gs-write-menu gs-hidden" data-gs="write-menu"></div>';
    shadowRoot.appendChild(root);
    wireCard(root);
    wireToolbarDrag(root);
    wireWriteMenu(root);
    return shadowRoot;
  }

  // Draggable selection toolbar: the logo (.gs-toolbar-logo) is the handle,
  // mirroring wireCard's header drag (pointerdown -> dx/dy, pointermove ->
  // clampRect, pointerup/cancel -> end). Buttons are siblings of the logo,
  // so their clicks are unaffected; a click on the logo itself after a real
  // drag is suppressed. showToolbar() repositions on each new selection.
  function wireToolbarDrag(root) {
    const toolbar = root.querySelector('[data-gs="toolbar"]');
    if (!toolbar || toolbar.__gsDragWired) return;
    toolbar.__gsDragWired = true;
    let drag = null;
    let moved = false;
    toolbar.addEventListener('pointerdown', (event) => {
      const logo = event.target && event.target.closest ? event.target.closest('.gs-toolbar-logo') : null;
      if (!logo) { drag = null; moved = false; return; }
      const rect = toolbar.getBoundingClientRect();
      drag = { dx: event.clientX - rect.left, dy: event.clientY - rect.top, pointerId: event.pointerId };
      moved = false;
      try { logo.setPointerCapture(event.pointerId); } catch (e) { /* ignore */ }
      event.preventDefault();
    });
    toolbar.addEventListener('pointermove', (event) => {
      if (!drag) return;
      // The pointer was captured on the logo; keep moving the toolbar itself.
      const rect = toolbar.getBoundingClientRect();
      const nextLeft = event.clientX - drag.dx;
      const nextTop = event.clientY - drag.dy;
      if (Math.abs(nextLeft - rect.left) > 3 || Math.abs(nextTop - rect.top) > 3) moved = true;
      const pos = clampRect(nextLeft, nextTop, rect.width, rect.height);
      toolbar.style.left = pos.left + 'px';
      toolbar.style.top = pos.top + 'px';
    });
    const endDrag = () => { drag = null; };
    toolbar.addEventListener('pointerup', endDrag);
    toolbar.addEventListener('pointercancel', endDrag);
    // Suppress the click that follows a real drag on the logo so it cannot
    // trigger anything; plain logo clicks are harmless (no handler) anyway.
    toolbar.addEventListener('click', (event) => {
      if (!moved) return;
      const logo = event.target && event.target.closest ? event.target.closest('.gs-toolbar-logo') : null;
      if (logo) { event.preventDefault(); event.stopPropagation(); }
      moved = false;
    }, true);
  }

  function qs(selector) {
    ensureRoot();
    return shadowRoot.querySelector(selector);
  }

  function fontFaceCss() {
    // Inter @font-face for the shadow UI only. overlay.css is ALSO a
    // declared content stylesheet (manifest content_scripts css), where a
    // __GS_FONT_BASE__ token would not be substituted; page-level Inter is
    // already declared in content.css. So the shadow copy gets a generated
    // block built with runtime.getURL() prepended here.
    try {
      const base = runtime.getURL('fonts/');
      return [400, 500, 600, 700].map((w) =>
        '@font-face{font-family:"Inter";src:url("' + base + 'inter-latin-' + w + '-normal.woff2") format("woff2");font-weight:' + w + ';font-style:normal;font-display:swap}'
      ).join('');
    } catch (e) { return ''; }
  }

  async function loadOverlayCss() {
    try {
      const url = runtime.getURL('content/overlay.css');
      const response = await fetch(url);
      if (response.ok) overlayCssText = await response.text();
    } catch (e) {
      overlayCssText = '';
    }
    if (overlayCssText) {
      overlayCssText = overlayCssText.split('__GS_FONT_BASE__').join(runtime.getURL('fonts/'));
    } else {
      overlayCssText =
        '.gs-toolbar,.gs-card,.gs-write-menu{position:fixed;background:#1f2227;color:#e6e8eb;border:1px solid #33373f;font-family:"Inter",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;z-index:2147483647}' +
        '.gs-hidden{display:none!important}.gs-spinner{width:18px;height:18px;border-radius:50%;border:2px solid #33373f;border-top-color:#5ec8c0;animation:gs-spin .8s linear infinite}@keyframes gs-spin{to{transform:rotate(360deg)}}';
    }
    overlayCssText = fontFaceCss() + overlayCssText;
  }

  // ---------------------------------------------------------------- card

  function wireCard(root) {
    const card = root.querySelector('[data-gs="card"]');
    const header = root.querySelector('[data-gs="card-header"]');
    root.querySelector('[data-gs="card-close"]').addEventListener('click', hideCard);

    let drag = null;
    header.addEventListener('pointerdown', (event) => {
      if (event.target.closest('[data-gs="card-close"]')) return;
      const rect = card.getBoundingClientRect();
      drag = { dx: event.clientX - rect.left, dy: event.clientY - rect.top };
      try { header.setPointerCapture(event.pointerId); } catch (e) { /* ignore */ }
      event.preventDefault();
    });
    header.addEventListener('pointermove', (event) => {
      if (!drag) return;
      const rect = card.getBoundingClientRect();
      const pos = clampRect(event.clientX - drag.dx, event.clientY - drag.dy, rect.width, rect.height);
      card.style.left = pos.left + 'px';
      card.style.top = pos.top + 'px';
    });
    const endDrag = () => { drag = null; };
    header.addEventListener('pointerup', endDrag);
    header.addEventListener('pointercancel', endDrag);
  }

  function showCard(title, anchorRect) {
    const card = qs('[data-gs="card"]');
    qs('[data-gs="card-title"]').textContent = title || 'Graphite';
    card.classList.remove('gs-hidden');
    const width = 368;
    const estimatedHeight = 280;
    let left = window.innerWidth / 2 - width / 2;
    let top = 80;
    if (anchorRect) {
      left = anchorRect.left;
      top = anchorRect.bottom + 10;
      if (top + estimatedHeight > window.innerHeight - 8) {
        top = Math.max(8, anchorRect.top - estimatedHeight - 10);
      }
    }
    const pos = clampRect(left, top, width, estimatedHeight);
    card.style.left = pos.left + 'px';
    card.style.top = pos.top + 'px';
    return card;
  }

  function hideCard() {
    const card = qs('[data-gs="card"]');
    if (card) card.classList.add('gs-hidden');
  }

  function isCardVisible() {
    const card = qs('[data-gs="card"]');
    return !!card && !card.classList.contains('gs-hidden');
  }

  function setCardLoading(label) {
    const body = qs('[data-gs="card-body"]');
    body.innerHTML = '<div class="gs-loading"><span class="gs-spinner"></span><span>' +
      escapeHtml(label || 'Thinking...') + '</span></div>';
    setCardFooter([]);
  }

  function setCardError(message) {
    const body = qs('[data-gs="card-body"]');
    body.innerHTML = '<p class="gs-error">' + escapeHtml(message) + '</p>';
  }

  function setCardFooter(buttons) {
    const footer = qs('[data-gs="card-footer"]');
    footer.innerHTML = '';
    (buttons || []).forEach((button) => {
      const el = document.createElement('button');
      el.className = 'gs-btn' + (button.primary ? ' gs-btn-primary' : '');
      el.textContent = button.label;
      el.addEventListener('click', () => button.onClick(el));
      footer.appendChild(el);
    });
    footer.style.display = (buttons && buttons.length) ? '' : 'none';
  }

  function defaultFooter(extra) {
    const buttons = [
      {
        label: 'Copy',
        onClick: () => {
          if (popoverState.lastText) copyText(popoverState.lastText);
        }
      },
      {
        label: 'Open in sidebar',
        primary: true,
        onClick: () => openSidebarWith(popoverState.action || 'chat', popoverState.lastText || '')
      }
    ];
    return (extra || []).concat(buttons);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch (e) { /* fall back below */ }
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    try { document.execCommand('copy'); } catch (e) { /* ignore */ }
    area.remove();
  }

  async function runCardAction(action, text, anchorRect, options) {
    const opts = options || {};
    const title = opts.title || (action ? action.charAt(0).toUpperCase() + action.slice(1) : 'Graphite');
    showCard(title, anchorRect);
    setCardLoading(opts.loadingLabel || 'Thinking...');
    popoverState = { lastText: '', action: action || 'chat' };
    if (action === 'rewrite' || String(action || '').startsWith('rewrite-')) {
      cardContext = { text: String(text || ''), rect: anchorRect || null, kind: 'rewrite' };
    } else {
      cardContext = { text: '', rect: null, kind: '' };
    }
    try {
      const prompt = opts.prompt || promptFor(action, text);
      const result = await chatSync([{ role: 'user', content: prompt }], action);
      popoverState.lastText = result;
      const body = qs('[data-gs="card-body"]');
      body.innerHTML =
        (opts.sourceText ? '<div class="gs-source">' + escapeHtml(truncate(opts.sourceText, 400)) + '</div>' : '') +
        '<div>' + markdownLite(result) + '</div>';
      setCardFooter(opts.footer ? opts.footer(result) : defaultFooter(opts.extraButtons));
      return result;
    } catch (error) {
      setCardError(error && error.message ? error.message : 'Request failed');
      setCardFooter(defaultFooter());
      throw error;
    }
  }

  /* Card for choosing a rewrite tone. Tones are rendered as graphite chips
   * (no new CSS file: inline styles) plus an optional custom-tone input. */
  function showTonePickerCard(text, anchorRect) {
    const tone = currentRewriteTone();
    showCard('Rewrite: ' + tone.label, anchorRect);
    cardContext = { text: String(text || ''), rect: anchorRect || null, kind: 'rewrite' };
    const body = qs('[data-gs="card-body"]');
    body.innerHTML = '';
    const source = document.createElement('div');
    source.className = 'gs-source';
    source.textContent = truncate(String(text || ''), 400);
    body.appendChild(source);
    const hint = document.createElement('p');
    hint.className = 'gs-muted';
    hint.textContent = 'Tone (source: lib/prompts.js — REWRITE_TONES):';
    body.appendChild(hint);
    const chips = document.createElement('div');
    chips.setAttribute('data-gs', 'tone-chips');
    chips.style.cssText = 'display:flex;flex-wrap:wrap;gap:5px;margin:6px 0 8px;';
    rewriteTones().forEach((t) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'gs-btn' + (t.id === tone.id ? ' gs-btn-primary' : '');
      chip.textContent = t.label;
      chip.setAttribute('data-tone', t.id);
      chip.style.cssText = 'border-radius:999px;padding:4px 9px;font-size:11px;';
      chip.addEventListener('mousedown', (event) => event.preventDefault());
      chip.addEventListener('click', () => {
        currentRewriteToneId = t.id;
        runRewriteWithTone(text, anchorRect, t.id);
      });
      chips.appendChild(chip);
    });
    body.appendChild(chips);
    const customRow = document.createElement('div');
    customRow.style.cssText = 'display:flex;gap:6px;margin-top:4px;';
    const customInput = document.createElement('input');
    customInput.className = 'gs-ask-input';
    customInput.setAttribute('data-gs', 'tone-custom-input');
    customInput.placeholder = 'Custom tone, e.g. like a friendly pirate…';
    const customBtn = document.createElement('button');
    customBtn.type = 'button';
    customBtn.className = 'gs-btn';
    customBtn.textContent = 'Rewrite custom';
    const runCustom = () => {
      const custom = customInput.value.trim();
      if (!custom) return;
      currentRewriteToneId = 'custom';
      runRewriteWithTone(text, anchorRect, 'custom', custom);
    };
    customBtn.addEventListener('click', runCustom);
    customInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') runCustom(); event.stopPropagation(); });
    customRow.appendChild(customInput);
    customRow.appendChild(customBtn);
    body.appendChild(customRow);
    setCardFooter([]);
  }

  const TRANSLATE_LANGUAGES = [
    'English', 'Spanish', 'French', 'German', 'Italian', 'Portuguese',
    'Portuguese (Brazil)', 'Dutch', 'Swedish', 'Norwegian', 'Danish',
    'Finnish', 'Polish', 'Czech', 'Ukrainian', 'Russian', 'Greek',
    'Turkish', 'Arabic', 'Hebrew', 'Persian', 'Hindi', 'Bengali', 'Thai',
    'Vietnamese', 'Indonesian', 'Malay', 'Filipino',
    'Chinese (Simplified)', 'Chinese (Traditional)', 'Japanese', 'Korean',
    'Swahili'
  ];
  const TRANSLATE_QUICK_LANGS = ['English', 'Spanish', 'French', 'German', 'Portuguese', 'Japanese'];

  // User-configured display names from settings.translationLanguages
  // (passed through flattenSettings) win; falls back to TRANSLATE_LANGUAGES
  // when missing/empty after dedupe/trim. Ensures targetLang() is present.
  function translateLanguages() {
    const configured = Array.isArray(settings.translationLanguages) ? settings.translationLanguages : null;
    const source = (configured && configured.length) ? configured : TRANSLATE_LANGUAGES;
    const list = [];
    source.forEach((name) => {
      const v = String(name == null ? '' : name).trim();
      if (v && !list.includes(v)) list.push(v);
    });
    if (!list.length) {
      TRANSLATE_LANGUAGES.forEach((name) => { if (!list.includes(name)) list.push(name); });
    }
    const def = targetLang();
    if (def && !list.includes(def)) list.unshift(def);
    return list;
  }

  function translateQuickLangs() {
    // Quick chips: first few of the effective list; when the user has a
    // configured list, use its head verbatim (preserves its order/names).
    if (Array.isArray(settings.translationLanguages) && settings.translationLanguages.length) {
      return translateLanguages().slice(0, 6);
    }
    return TRANSLATE_QUICK_LANGS.slice();
  }

  function runTranslateWithLang(text, anchorRect, lang) {
    const chosen = String(lang || '').trim() || targetLang();
    runCardAction('translate', text, anchorRect, {
      title: 'Translate: ' + chosen,
      loadingLabel: 'Translating to ' + chosen + '...',
      prompt: promptFor('translate', text, { lang: chosen }),
      sourceText: text,
      footer: () => [
        {
          label: 'Change language',
          onClick: () => showTranslatePickerCard(text, anchorRect)
        }
      ].concat(defaultFooter())
    }).catch(() => {});
  }

  function showTranslatePickerCard(text, anchorRect) {
    const defaultLang = targetLang();
    showCard('Translate', anchorRect);
    cardContext = { text: String(text || ''), rect: anchorRect || null, kind: 'translate' };
    const body = qs('[data-gs="card-body"]');
    body.innerHTML = '';
    const source = document.createElement('div');
    source.className = 'gs-source';
    source.textContent = truncate(String(text || ''), 400);
    body.appendChild(source);
    const hint = document.createElement('p');
    hint.className = 'gs-muted';
    hint.textContent = 'Translate to:';
    body.appendChild(hint);
    const chips = document.createElement('div');
    chips.className = 'gs-lang-chips';
    chips.setAttribute('data-gs', 'lang-chips');
    translateQuickLangs().forEach((lang) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'gs-btn gs-lang-chip' + (lang === defaultLang ? ' gs-btn-primary' : '');
      chip.textContent = lang;
      chip.setAttribute('data-lang', lang);
      chip.addEventListener('mousedown', (event) => event.preventDefault());
      chip.addEventListener('click', () => runTranslateWithLang(text, anchorRect, lang));
      chips.appendChild(chip);
    });
    body.appendChild(chips);
    const row = document.createElement('div');
    row.className = 'gs-lang-row';
    const select = document.createElement('select');
    select.className = 'gs-lang-select';
    select.setAttribute('data-gs', 'lang-select');
    select.setAttribute('aria-label', 'Target language');
    let hasDefault = false;
    translateLanguages().forEach((lang) => {
      const opt = document.createElement('option');
      opt.value = lang;
      opt.textContent = lang;
      if (lang === defaultLang) { opt.selected = true; hasDefault = true; }
      select.appendChild(opt);
    });
    if (!hasDefault) {
      const opt = document.createElement('option');
      opt.value = defaultLang;
      opt.textContent = defaultLang;
      opt.selected = true;
      select.insertBefore(opt, select.firstChild);
    }
    const otherOpt = document.createElement('option');
    otherOpt.value = '__other__';
    otherOpt.textContent = 'Other…';
    select.appendChild(otherOpt);
    const goBtn = document.createElement('button');
    goBtn.type = 'button';
    goBtn.className = 'gs-btn gs-btn-primary';
    goBtn.textContent = 'Translate';
    row.appendChild(select);
    row.appendChild(goBtn);
    body.appendChild(row);
    const customRow = document.createElement('div');
    customRow.className = 'gs-lang-custom-row gs-hidden';
    customRow.setAttribute('data-gs', 'lang-custom-row');
    const customInput = document.createElement('input');
    customInput.className = 'gs-ask-input gs-lang-custom-input';
    customInput.setAttribute('data-gs', 'lang-custom-input');
    customInput.placeholder = 'Custom language, e.g. Catalan…';
    customRow.appendChild(customInput);
    body.appendChild(customRow);
    select.addEventListener('change', () => {
      customRow.classList.toggle('gs-hidden', select.value !== '__other__');
      if (select.value === '__other__') {
        setTimeout(() => { try { customInput.focus(); } catch (e) { /* ignore */ } }, 30);
      }
    });
    const run = () => {
      const lang = select.value === '__other__' ? customInput.value.trim() : select.value;
      if (!lang) return;
      runTranslateWithLang(text, anchorRect, lang);
    };
    goBtn.addEventListener('click', run);
    customInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') run(); event.stopPropagation(); });
    setCardFooter([]);
    setTimeout(() => { try { select.focus(); } catch (e) { /* ignore */ } }, 30);
  }

  function runRewriteWithTone(text, anchorRect, toneId, customTone) {
    const resolved = resolveRewriteTone(toneId);
    const label = resolved ? resolved.label : 'Custom';
    runCardAction('rewrite', text, anchorRect, {
      title: 'Rewrite: ' + label,
      loadingLabel: 'Rewriting (' + label + ')...',
      prompt: rewriteTonePrompt(toneId, { text, customTone: customTone || '' }),
      sourceText: text,
      footer: (result) => toneFooterButtons(text, anchorRect).concat(defaultFooter())
    }).catch(() => {});
  }

  /* Footer buttons shown after a rewrite result: re-run in another tone and
   * regenerate in the current one. The in-memory original text is kept in
   * cardContext so regeneration never needs a new selection. */
  function toneFooterButtons(text, rect) {
    const tone = currentRewriteTone();
    const buttons = rewriteTones().map((t) => ({
      label: (t.id === tone.id ? '✓ ' : '') + t.label,
      primary: t.id === tone.id,
      onClick: () => {
        currentRewriteToneId = t.id;
        runRewriteWithTone(text, rect, t.id);
      }
    }));
    buttons.push({
      label: '↻ Regenerate',
      onClick: () => runRewriteWithTone(text, rect, currentRewriteToneId)
    });
    return buttons;
  }

  // ------------------------------------------------------ selection toolbar

  function hideToolbar() {
    const toolbar = qs('[data-gs="toolbar"]');
    if (toolbar) toolbar.classList.add('gs-hidden');
  }

  // Icon-only toolbar buttons: the word is the tooltip (data-label,
  // rendered on hover/focus by overlay.css) and the aria-label. Stroke
  // icons in a 24x24 grid, currentColor so hover/accent colors apply.
  const TOOLBAR_ICONS = {
    copy: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
    check: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M20 6 9 17l-5-5"/></svg>',
    explain: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1.3.5 2.6 1.5 3.5.8.8 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/></svg>',
    translate: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="m5 8 6 6"/><path d="m4 14 6-6 2-3"/><path d="M2 5h12"/><path d="M7 2h1"/><path d="m22 22-5-10-5 10"/><path d="M14 18h6"/></svg>',
    summarize: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/></svg>',
    grammar: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M18 6 7 17l-5-5"/><path d="m22 10-7.5 7.5L13 16"/></svg>',
    rewrite: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>',
    ask: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>',
    speak: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>'
  };

  function toolbarButton(label, iconName) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'gs-toolbar-btn';
    button.innerHTML = TOOLBAR_ICONS[iconName] || '';
    button.setAttribute('aria-label', label);
    button.dataset.label = label;
    button.addEventListener('mousedown', (event) => event.preventDefault());
    return button;
  }

  function showToolbar(rect, text) {
    if (settings.selectionToolbar === false) return;
    const toolbar = qs('[data-gs="toolbar"]');
    toolbar.innerHTML = '';
    const logo = document.createElement('span');
    logo.className = 'gs-toolbar-logo';
    logo.textContent = '\u25C6';
    logo.title = 'Drag to move';
    toolbar.appendChild(logo);

    // First action: copy the selection. copyText() runs on a snapshot of
    // the text, so hiding the toolbar right after cannot lose it.
    const copyBtn = toolbarButton('Copy', 'copy');
    copyBtn.addEventListener('click', () => {
      copyText(text);
      copyBtn.innerHTML = TOOLBAR_ICONS.check;
      copyBtn.classList.add('gs-toolbar-btn--copied');
      copyBtn.setAttribute('aria-label', 'Copied');
      copyBtn.dataset.label = 'Copied';
      setTimeout(hideToolbar, 450);
    });
    toolbar.appendChild(copyBtn);

    const actions = [
      ['Explain', 'explain'],
      ['Translate', 'translate'],
      ['Summarize', 'summarize'],
      ['Grammar', 'grammar'],
      ['Rewrite', 'rewrite'],
      ['Ask AI', 'ask']
    ];
    actions.forEach(([label, action]) => {
      const button = toolbarButton(label, action);
      button.addEventListener('click', () => {
        hideToolbar();
        if (action === 'ask') {
          showAskCard(text, rect);
        } else if (action === 'rewrite') {
          showTonePickerCard(text, rect);
        } else if (action === 'translate') {
          showTranslatePickerCard(text, rect);
        } else {
          runCardAction(action, text, rect, { sourceText: text }).catch(() => {});
        }
      });
      toolbar.appendChild(button);
    });

    const speak = toolbarButton('Read aloud', 'speak');
    speak.addEventListener('click', () => { hideToolbar(); readAloud(text); });
    toolbar.appendChild(speak);

    // Measure hidden but laid out, position with the real size, then reveal,
    // so the first paint cannot overflow the right/bottom edge.
    toolbar.style.visibility = 'hidden';
    toolbar.classList.remove('gs-hidden');
    const width = toolbar.offsetWidth || 300;
    const height = toolbar.offsetHeight || 38;
    let left = rect.left + rect.width / 2 - width / 2;
    let top = rect.top - height - 10;
    if (top < 8) top = rect.bottom + 10;
    const pos = clampRect(left, top, width, height);
    toolbar.style.left = pos.left + 'px';
    toolbar.style.top = pos.top + 'px';
    toolbar.style.visibility = '';
  }

  function showAskCard(text, rect) {
    showCard('Ask AI', rect);
    const body = qs('[data-gs="card-body"]');
    body.innerHTML =
      '<div class="gs-source">' + escapeHtml(truncate(text, 400)) + '</div>' +
      '<div class="gs-ask-row"><input class="gs-ask-input" data-gs="ask-input" ' +
      'placeholder="Ask about the selected text..."><button class="gs-btn gs-btn-primary" data-gs="ask-send">Ask</button></div>';
    setCardFooter(defaultFooter());
    const input = body.querySelector('[data-gs="ask-input"]');
    const send = body.querySelector('[data-gs="ask-send"]');
    const submit = () => {
      const question = input.value.trim();
      const prompt = question
        ? question + '\n\nContext:\n"""' + text + '"""\n\nPage: ' + document.title + ' (' + location.href + ')'
        : promptFor('explain', text);
      runCardAction('ask', text, null, {
        title: 'Ask AI',
        prompt,
        sourceText: text
      }).catch(() => {});
    };
    send.addEventListener('click', submit);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') submit();
      event.stopPropagation();
    });
    setTimeout(() => { try { input.focus(); } catch (e) { /* ignore */ } }, 30);
  }

  function getSelectionInfo() {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
    const text = selection.toString().trim();
    if (text.length < 2) return null;
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) return null;
    return { text, rect };
  }

  function onMouseUp(event) {
    if (event.target && event.target.closest && event.target.closest('#graphite-sider-root')) return;
    setTimeout(() => {
      if (settings.selectionToolbar === false) return;
      const info = getSelectionInfo();
      if (info) {
        lastSelectionText = info.text;
        lastSelectionRect = info.rect;
        showToolbar(info.rect, info.text);
      } else {
        hideToolbar();
      }
    }, 10);
  }

  // ------------------------------------------------------------- read aloud

  function readAloud(text) {
    try {
      if (!('speechSynthesis' in window)) {
        showCard('Read aloud');
        setCardError('Speech synthesis is not available in this browser.');
        setCardFooter(defaultFooter());
        return;
      }
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(truncate(text, 1200));
      utterance.lang = document.documentElement.lang || undefined;
      window.speechSynthesis.speak(utterance);
    } catch (e) { /* speech is best-effort */ }
  }

  // ---------------------------------------------------- writing assistant

  let activeField = null;
  let writeButtonTimer = null;

  function isEditable(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.isContentEditable) return true;
    const tag = el.tagName;
    if (tag === 'TEXTAREA') return !el.disabled && !el.readOnly;
    if (tag === 'INPUT') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      return ['text', 'search', 'email', 'url', ''].includes(type) && !el.disabled && !el.readOnly;
    }
    return false;
  }

  function hideWriteButton() {
    const btn = qs('[data-gs="write-btn"]');
    if (btn) btn.classList.add('gs-hidden');
    hideWriteMenu();
  }

  function hideWriteMenu() {
    const menu = qs('[data-gs="write-menu"]');
    if (menu) menu.classList.add('gs-hidden');
  }

  function positionWriteButton(el) {
    const btn = qs('[data-gs="write-btn"]');
    const rect = el.getBoundingClientRect();
    if (rect.width < 40 || rect.height < 16 || rect.bottom < 0 || rect.top > window.innerHeight) {
      btn.classList.add('gs-hidden');
      return;
    }
    btn.classList.remove('gs-hidden');
    const pos = clampRect(rect.right - 32, rect.bottom - 32, 26, 26);
    btn.style.left = pos.left + 'px';
    btn.style.top = pos.top + 'px';
  }

  function scheduleWriteButton(el) {
    if (writeButtonTimer) clearTimeout(writeButtonTimer);
    writeButtonTimer = setTimeout(() => positionWriteButton(el), 60);
  }

  function fieldText(el) {
    if (el.isContentEditable) {
      const selection = window.getSelection();
      if (selection && selection.toString().trim()) return selection.toString();
      return el.innerText || el.textContent || '';
    }
    if (typeof el.selectionStart === 'number' && el.selectionStart !== el.selectionEnd) {
      return el.value.slice(el.selectionStart, el.selectionEnd);
    }
    return el.value || '';
  }

  function wireWriteMenu(root) {
    const btn = root.querySelector('[data-gs="write-btn"]');
    btn.addEventListener('mousedown', (event) => event.preventDefault());
    btn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (activeField) showWriteMenu(activeField);
    });
  }

  function positionWriteMenu(el, menu) {
    // Position from the menu's MEASURED size (after it is visible), flipping
    // above the field when there is not enough room below. Re-called when
    // the Rewrite submenu expands/collapses.
    const rect = el.getBoundingClientRect();
    const width = menu.offsetWidth || 224;
    const height = menu.offsetHeight || 0;
    const margin = 8;
    const gap = 6;
    let left = rect.right - width;
    let top = rect.bottom + gap;
    if (top + height > window.innerHeight - margin && rect.top - gap - height >= margin) {
      top = rect.top - gap - height;
    }
    const pos = clampRect(left, top, width, height);
    menu.style.left = pos.left + 'px';
    menu.style.top = pos.top + 'px';
  }

  function showWriteMenu(el) {
    const menu = qs('[data-gs="write-menu"]');
    menu.innerHTML = '';
    const actions = [
      ['Improve writing', 'improve'],
      ['Fix grammar', 'grammar'],
      ['Make shorter', 'shorter'],
      ['Continue writing', 'continue']
    ];
    actions.forEach(([label, action]) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'gs-menu-item';
      item.textContent = label;
      item.addEventListener('mousedown', (event) => event.preventDefault());
      item.addEventListener('click', () => {
        hideWriteMenu();
        runWritingAction(action, label, el).catch(() => {});
      });
      menu.appendChild(item);
    });
    // "Rewrite as ▾" submenu trigger: expands inline inside the scrollable
    // menu; items are indented via the .gs-submenu class in overlay.css.
    const submenu = document.createElement('div');
    submenu.className = 'gs-submenu gs-hidden';
    submenu.setAttribute('data-gs', 'rewrite-submenu');
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'gs-menu-item';
    trigger.textContent = 'Rewrite as ▾';
    trigger.setAttribute('data-gs', 'rewrite-trigger');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.addEventListener('mousedown', (event) => event.preventDefault());
    trigger.addEventListener('click', () => {
      const isHidden = submenu.classList.toggle('gs-hidden');
      trigger.textContent = isHidden ? 'Rewrite as ▾' : 'Rewrite as ▴';
      trigger.setAttribute('aria-expanded', isHidden ? 'false' : 'true');
      // Re-clamp with the new measured height (flip above if needed).
      positionWriteMenu(el, menu);
    });
    menu.appendChild(trigger);
    const tone = currentRewriteTone();
    rewriteTones().forEach((t) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'gs-menu-item' + (t.id === tone.id ? ' gs-menu-item-current' : '');
      item.textContent = (t.id === tone.id ? '✓ ' : '') + t.label;
      item.setAttribute('data-tone', t.id);
      item.addEventListener('mousedown', (event) => event.preventDefault());
      item.addEventListener('click', () => {
        currentRewriteToneId = t.id;
        hideWriteMenu();
        runWritingAction('rewrite', 'Rewrite: ' + t.label, el, { toneId: t.id }).catch(() => {});
      });
      submenu.appendChild(item);
    });
    const customRow = document.createElement('div');
    customRow.className = 'gs-menu-custom-row';
    const customInput = document.createElement('input');
    customInput.className = 'gs-ask-input gs-menu-custom-input';
    customInput.setAttribute('data-gs', 'write-custom-tone');
    customInput.placeholder = 'Custom tone…';
    const customBtn = document.createElement('button');
    customBtn.type = 'button';
    customBtn.className = 'gs-btn gs-menu-custom-btn';
    customBtn.textContent = 'Go';
    customBtn.addEventListener('mousedown', (event) => event.preventDefault());
    customBtn.addEventListener('click', () => {
      const custom = customInput.value.trim();
      if (!custom) return;
      currentRewriteToneId = 'custom';
      hideWriteMenu();
      runWritingAction('rewrite', 'Rewrite: Custom', el, { toneId: 'custom', customTone: custom }).catch(() => {});
    });
    customInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') customBtn.click(); event.stopPropagation(); });
    customRow.appendChild(customInput);
    customRow.appendChild(customBtn);
    submenu.appendChild(customRow);
    menu.appendChild(submenu);
    menu.style.visibility = 'hidden';
    menu.classList.remove('gs-hidden');
    positionWriteMenu(el, menu);
    menu.style.visibility = '';
  }

  async function runWritingAction(action, label, el, options) {
    const opts = options || {};
    const text = fieldText(el).trim();
    if (!text) {
      showCard(label, el.getBoundingClientRect());
      setCardError('Select some text or write something first.');
      setCardFooter([]);
      return;
    }
    const prompts = {
      improve: 'Improve the writing of the following text: clearer, more natural and better flowing, preserving meaning. Output only the improved text.\n\nText:\n"""' + text + '"""',
      grammar: 'Fix grammar, spelling and punctuation in the following text. Output only the corrected text.\n\nText:\n"""' + text + '"""',
      shorter: 'Make the following text shorter and more concise without losing key meaning. Output only the shortened text.\n\nText:\n"""' + text + '"""',
      continue: 'Continue writing the following text naturally in the same style and tone. Output only the continuation.\n\nText:\n"""' + text + '"""'
    };
    if (action === 'rewrite') {
      prompts.rewrite = rewriteTonePrompt(opts.toneId || currentRewriteToneId || 'neutral', {
        text, customTone: opts.customTone || ''
      });
    }
    // 'formal' remains a backward-compatible alias for the Formal tone.
    const effectiveAction = action === 'formal' ? 'rewrite' : action;
    const chatAction = effectiveAction === 'rewrite'
      ? 'rewrite-' + (resolveRewriteTone(opts.toneId) || { id: 'custom' }).id
      : 'writing-' + effectiveAction;
    const prompt = effectiveAction === 'rewrite'
      ? (prompts.rewrite || rewriteTonePrompt('neutral', { text }))
      : (prompts[effectiveAction] || prompts.improve);
    showCard(label, el.getBoundingClientRect());
    setCardLoading(label + '...');
    try {
      const result = await chatSync(
        [{ role: 'user', content: prompt }],
        chatAction
      );
      popoverState = { lastText: result, action: chatAction };
      const body = qs('[data-gs="card-body"]');
      body.innerHTML = '<div>' + markdownLite(result) + '</div>';
      setCardFooter([
        {
          label: effectiveAction === 'continue' ? 'Insert' : 'Apply',
          primary: true,
          onClick: (button) => {
            applyToField(el, result, effectiveAction);
            button.textContent = 'Applied';
            button.disabled = true;
          }
        }
      ].concat(defaultFooter()));
    } catch (error) {
      setCardError(error && error.message ? error.message : 'Request failed');
      setCardFooter(defaultFooter());
    }
  }

  function applyToField(el, result, action) {
    try { el.focus(); } catch (e) { /* ignore */ }
    if (el.isContentEditable) {
      const selection = window.getSelection();
      if (action !== 'continue' && selection && selection.rangeCount && !selection.isCollapsed) {
        const range = selection.getRangeAt(0);
        range.deleteContents();
        range.insertNode(document.createTextNode(result));
        selection.collapseToEnd();
      } else {
        document.execCommand('insertText', false, (action === 'continue' ? ' ' : '') + result);
      }
    } else if (typeof el.setRangeText === 'function') {
      const start = typeof el.selectionStart === 'number' ? el.selectionStart : el.value.length;
      const end = typeof el.selectionEnd === 'number' ? el.selectionEnd : el.value.length;
      if (action === 'continue') {
        el.setRangeText((start > 0 && !/\s$/.test(el.value) ? ' ' : '') + result, end, end, 'end');
      } else if (start !== end) {
        el.setRangeText(result, start, end, 'end');
      } else {
        el.setRangeText(result, 0, el.value.length, 'end');
      }
    } else {
      el.value = action === 'continue' ? (el.value + ' ' + result) : result;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function onFocusIn(event) {
    if (settings.writingAssistant === false) return;
    const el = event.target;
    if (isEditable(el)) {
      activeField = el;
      scheduleWriteButton(el);
    } else if (activeField && !qs('[data-gs="write-menu"]').contains(document.activeElement)) {
      // keep button while focus is inside our shadow UI
    }
  }

  function onFocusOut(event) {
    const el = event.target;
    if (el === activeField) {
      setTimeout(() => {
        if (document.activeElement !== activeField) hideWriteButton();
      }, 150);
    }
  }

  // ----------------------------------------------------- page extraction

  function extractPageText(maxLength) {
    const limit = maxLength || 20000;
    try {
      const clone = document.cloneNode(true);
      const removeSelectors = 'script,style,noscript,nav,footer,aside,header,form,iframe,svg,button,[role="navigation"],[role="banner"],[role="contentinfo"]';
      clone.querySelectorAll(removeSelectors).forEach((node) => node.remove());
      const main = clone.querySelector('article, main, [role="main"]') || clone.body || clone.documentElement;
      let text = (main.innerText || main.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
      if (text.length < 200 && clone.body) {
        text = (clone.body.innerText || '').replace(/\n{3,}/g, '\n\n').trim();
      }
      return text.slice(0, limit);
    } catch (e) {
      return truncate(document.body ? (document.body.innerText || '') : '', 20000);
    }
  }

  // --------------------------------------------------- full-page translate

  function collectParagraphs() {
    const nodes = Array.from(
      document.querySelectorAll('article p, main p, p, li, h1, h2, h3, td, blockquote, figcaption')
    );
    const seen = new Set();
    return nodes.filter((node) => {
      if (seen.has(node)) return false;
      seen.add(node);
      if (node.closest('#graphite-sider-root, .gs-translated-note, script, style, nav, footer, aside')) return false;
      if (node.querySelector('p, li, h1, h2, h3')) return false;
      const text = (node.innerText || node.textContent || '').trim();
      if (text.length < 2 || text.length > 4000) return false;
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      return rect.width > 0 && rect.height > 0;
    });
  }

  function renderTranslated(entry, translation) {
    const note = document.createElement('div');
    note.className = 'gs-translated-note';
    note.setAttribute('data-gs-translation', '1');
    note.textContent = translation;
    entry.el.insertAdjacentElement('afterend', note);
    entry.note = note;
  }

  async function translatePage() {
    if (translateState.active) {
      restorePage();
      return { restored: true };
    }
    if (translateState.running) return { running: true };
    const paragraphs = collectParagraphs();
    if (!paragraphs.length) {
      showCard('Translate page');
      setCardError('No visible paragraphs found to translate.');
      setCardFooter([]);
      return { translated: 0 };
    }
    translateState = { active: false, entries: [], running: true };
    showCard('Translate page');
    const body = qs('[data-gs="card-body"]');
    body.innerHTML =
      '<div class="gs-loading"><span class="gs-spinner"></span><span>Translating page into ' +
      escapeHtml(targetLang()) + '...</span></div>' +
      '<div class="gs-progress"><div class="gs-progress-bar" data-gs="progress-bar"></div></div>' +
      '<p class="gs-muted" data-gs="progress-label">0 / ' + paragraphs.length + '</p>';
    setCardFooter([
      { label: 'Stop & restore', onClick: () => restorePage() }
    ]);
    const bar = body.querySelector('[data-gs="progress-bar"]');
    const label = body.querySelector('[data-gs="progress-label"]');
    const batchSize = 8;
    let done = 0;
    try {
      for (let i = 0; i < paragraphs.length; i += batchSize) {
        if (!translateState.running) break;
        const batch = paragraphs.slice(i, i + batchSize);
        const entries = batch.map((el) => ({
          el,
          original: (el.innerText || el.textContent || '').trim(),
          note: null
        }));
        translateState.entries.push(...entries);
        const numbered = entries.map((entry, index) => '[' + (index + 1) + '] ' + entry.original).join('\n---\n');
        const prompt =
          'Translate each numbered block below into ' + targetLang() +
          '. Reply with the translations in the same numbered format ([1], [2], ...), separated by lines containing only ---. Output only the translations.\n\n' +
          numbered;
        try {
          const result = await chatSync([{ role: 'user', content: prompt }], 'translate-page');
          const parts = parseNumberedTranslations(result, entries.length);
          entries.forEach((entry, index) => {
            const translation = (parts[index] || '').trim();
            if (translation) renderTranslated(entry, translation);
          });
        } catch (batchError) {
          // Per-block fallback so one bad batch does not abort the page.
          for (const entry of entries) {
            if (!translateState.running) break;
            try {
              const single = await chatSync(
                [{ role: 'user', content: promptFor('translate', entry.original) }],
                'translate-page'
              );
              if (single.trim()) renderTranslated(entry, single.trim());
            } catch (e) { /* skip paragraph */ }
          }
        }
        done += batch.length;
        if (bar) bar.style.width = Math.round((done / paragraphs.length) * 100) + '%';
        if (label) label.textContent = done + ' / ' + paragraphs.length;
      }
      translateState.active = true;
      body.innerHTML =
        '<p>Translated ' + translateState.entries.filter((e) => e.note).length +
        ' paragraphs into ' + escapeHtml(targetLang()) +
        '. Translations appear under each original paragraph.</p>';
      setCardFooter([
        { label: 'Restore original', primary: true, onClick: () => restorePage() },
        { label: 'Open in sidebar', onClick: () => openSidebarWith('translate-page', '') }
      ]);
      return { translated: translateState.entries.filter((e) => e.note).length };
    } finally {
      translateState.running = false;
    }
  }

  function restorePage() {
    translateState.running = false;
    translateState.entries.forEach((entry) => {
      if (entry.note && entry.note.parentNode) entry.note.remove();
    });
    translateState.entries = [];
    translateState.active = false;
    document.querySelectorAll('[data-gs-translation]').forEach((node) => node.remove());
    if (isCardVisible()) {
      const body = qs('[data-gs="card-body"]');
      body.innerHTML = '<p>Original page restored.</p>';
      setCardFooter([]);
    }
    return { restored: true };
  }

  // Also exposed for background / sidebar flows and debugging.
  window.GraphiteContent = {
    translatePage,
    restorePage,
    extractPageText,
    getSettings: () => Object.assign({}, settings)
  };

  function parseNumberedTranslations(result, count) {
    const parts = [];
    const text = String(result || '');
    const split = text.split(/\n\s*---\s*\n/);
    if (split.length > 1) {
      split.forEach((part) => parts.push(part.replace(/^\s*\[\d+\]\s*/, '').trim()));
    } else {
      const matches = [...text.matchAll(/\[(\d+)\]\s*([\s\S]*?)(?=\n\[\d+\]|$)/g)];
      matches.forEach((match) => { parts[Number(match[1]) - 1] = match[2].trim(); });
    }
    while (parts.length < count) parts.push('');
    return parts;
  }

  // ------------------------------------------------------------ OCR image

  async function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  async function handleOcrImage(srcUrl) {
    showCard('Image OCR / Describe');
    setCardLoading('Loading image...');
    const body = qs('[data-gs="card-body"]');
    body.innerHTML = '<img class="gs-card-image" alt="Selected image"><div class="gs-loading">' +
      '<span class="gs-spinner"></span><span>Reading image...</span></div>';
    const img = body.querySelector('img');
    img.src = srcUrl;
    setCardFooter([]);
    try {
      let dataUrl = '';
      try {
        const response = await fetch(srcUrl);
        if (response.ok) dataUrl = await blobToDataUrl(await response.blob());
      } catch (e) { /* ask background to fetch instead */ }
      if (!dataUrl) {
        let fetchPromise = null;
        try { fetchPromise = runtime.sendMessage({ type: 'fetchImage', srcUrl }); } catch (e) { /* ignore */ }
        const fetchedRaw = fetchPromise && typeof fetchPromise.catch === 'function'
          ? await fetchPromise.catch(() => null)
          : null;
        const fetched = (fetchedRaw && typeof fetchedRaw === 'object' && 'ok' in fetchedRaw && ('result' in fetchedRaw || 'error' in fetchedRaw))
          ? (fetchedRaw.ok ? fetchedRaw.result : null)
          : fetchedRaw;
        if (fetched && fetched.dataUrl) dataUrl = fetched.dataUrl;
        else if (fetched && fetched.error) throw new Error(fetched.error);
      }
      const content = dataUrl
        ? [
            { type: 'text', text: 'Extract all visible text from this image (OCR), then briefly describe the image. If there is no text, just describe it.' },
            { type: 'image_url', image_url: { url: dataUrl } }
          ]
        : 'Describe and extract all text (OCR) from the image at ' + srcUrl;
      const result = await chatSync(
        [{ role: 'user', content }],
        'ocr-image'
      );
      popoverState = { lastText: result, action: 'ocr-image' };
      body.innerHTML = '<img class="gs-card-image" alt="Selected image"><div>' + markdownLite(result) + '</div>';
      const newImg = body.querySelector('img');
      if (newImg) newImg.src = srcUrl;
      setCardFooter(defaultFooter());
    } catch (error) {
      body.innerHTML = '<img class="gs-card-image" alt="Selected image"><p class="gs-error">' +
        escapeHtml(error && error.message ? error.message : 'OCR failed') + '</p>';
      const newImg = body.querySelector('img');
      if (newImg) newImg.src = srcUrl;
      setCardFooter(defaultFooter());
    }
  }

  // ------------------------------------------------------------ commands

  function currentSelectionOrAsk(anchorRect) {
    const info = getSelectionInfo();
    if (info) return info;
    if (lastSelectionText) return { text: lastSelectionText, rect: lastSelectionRect || anchorRect };
    return null;
  }

  async function handleCommand(command, data) {
    const payload = data || {};
    switch (command) {
      case 'summarize-page': {
        const text = extractPageText(20000);
        await runCardAction('summarize', text, null, {
          title: 'Page summary',
          prompt: 'Summarize this web page in concise bullet points, capturing the main ideas.\n\nTitle: ' +
            document.title + '\nURL: ' + location.href + '\n\n' + text
        });
        return { ok: true };
      }
      case 'translate-page':
        return translateState.active ? restorePage() : translatePage();
      case 'restore-page':
        return restorePage();
      case 'youtube-summary':
        openSidebarWith('youtube-summary', location.href);
        return { ok: true };
      case 'explain-selection': {
        const info = currentSelectionOrAsk();
        if (!info) { showCard('Explain'); setCardError('Select some text first.'); setCardFooter([]); return { ok: false }; }
        await runCardAction('explain', info.text, info.rect, { sourceText: info.text });
        return { ok: true };
      }
      case 'translate-selection': {
        const info = currentSelectionOrAsk();
        if (!info) { showCard('Translate'); setCardError('Select some text first.'); setCardFooter([]); return { ok: false }; }
        await runCardAction('translate', info.text, info.rect, { sourceText: info.text });
        return { ok: true };
      }
      case 'summarize-selection': {
        const info = currentSelectionOrAsk();
        if (!info) { showCard('Summarize'); setCardError('Select some text first.'); setCardFooter([]); return { ok: false }; }
        await runCardAction('summarize', info.text, info.rect, { sourceText: info.text });
        return { ok: true };
      }
      case 'read-aloud': {
        const info = currentSelectionOrAsk();
        readAloud(info ? info.text : extractPageText(1200));
        return { ok: true };
      }
      case 'ask-selection': {
        const info = currentSelectionOrAsk();
        if (!info) { showCard('Ask AI'); setCardError('Select some text first.'); setCardFooter([]); return { ok: false }; }
        showAskCard(info.text, info.rect);
        return { ok: true };
      }
      case 'ocr-image':
        if (payload.srcUrl) await handleOcrImage(payload.srcUrl);
        return { ok: true };
      case 'open-popover': {
        const info = currentSelectionOrAsk();
        if (info) showToolbar(info.rect, info.text);
        return { ok: true };
      }
      default:
        return { ok: false, error: 'Unknown command: ' + command };
    }
  }

  // ------------------------------------------------------------- listeners

  document.addEventListener('mouseup', onMouseUp, true);
  document.addEventListener('keyup', (event) => {
    if (event.key === 'Shift' || event.key.startsWith('Arrow')) onMouseUp(event);
  }, true);
  document.addEventListener('focusin', onFocusIn, true);
  document.addEventListener('focusout', onFocusOut, true);
  document.addEventListener('scroll', () => {
    if (activeField && settings.writingAssistant !== false) scheduleWriteButton(activeField);
  }, true);

  document.addEventListener('pointerdown', (event) => {
    const host = document.getElementById('graphite-sider-root');
    if (host && event.target === host) return; // clicks inside shadow are handled below
    // Shadow content clicks do not reach the page document with a
    // shadow target, so only hide for true outside clicks.
    if (!event.composedPath || !event.composedPath().includes(host)) {
      hideToolbar();
      hideWriteMenu();
    }
  }, true);

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      hideToolbar();
      hideCard();
      hideWriteMenu();
    }
  }, true);

  runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message !== 'object') return undefined;
    if (message.type === 'extractPageText') {
      try {
        return Promise.resolve({
          ok: true,
          text: extractPageText(message.maxLength || 20000),
          title: document.title,
          url: location.href
        });
      } catch (error) {
        return Promise.resolve({ ok: false, error: String(error && error.message || error) });
      }
    }
    if (message.type === 'graphite-command' && message.command) {
      return handleCommand(message.command, message)
        .then((result) => ({ ok: true, result }))
        .catch((error) => ({ ok: false, error: String(error && error.message || error) }));
    }
    if (message.type === 'ocr-image' && message.srcUrl) {
      handleOcrImage(message.srcUrl).catch(() => {});
      return Promise.resolve({ ok: true });
    }
    if (message.type === 'getSelection') {
      const info = getSelectionInfo();
      return Promise.resolve({
        ok: !!info,
        text: info ? info.text : lastSelectionText,
        url: location.href,
        title: document.title
      });
    }
    return undefined;
  });

  // --------------------------------------------------------------- init

  (async function init() {
    await loadSettings();
    await loadOverlayCss();
    ensureRoot();
  })();
})();
