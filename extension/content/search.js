/* Graphite Sider - search engine enhancer (Google / Bing / DuckDuckGo).
   On wide viewports the "Graphite AI Answer" card is a wide floating box
   fixed at the right of the viewport, so the engine's results stay on the
   left in their intended layout and are never pushed or reflowed; the
   card's colors follow the results page's own light/dark theme. On narrow
   viewports it falls back to an in-flow full-width block above the
   results. Generation is opt-in (click) so no tokens are spent passively. */
(function () {
  'use strict';

  if (!/(^|\.)(google\.|bing\.com|duckduckgo\.com)/.test(location.hostname)) return;
  if (window.__graphiteSearchLoaded) return;
  window.__graphiteSearchLoaded = true;

  const runtime = (typeof browser !== 'undefined' && browser.runtime)
    ? browser.runtime
    : (typeof chrome !== 'undefined' ? chrome.runtime : null);
  if (!runtime) return;

  function escapeHtml(text) {
    return String(text == null ? '' : text)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // Providers sometimes ship text that is already HTML-escaped
  // ("Fish &amp; Chips", "&lt;tag&gt;"). Decode ONE pass before
  // escapeHtml re-escapes, so entities display as intended instead of
  // double-escaped ("&amp;amp;") while markup stays inert text.
  function decodeHtmlEntities(text) {
    return String(text == null ? '' : text).replace(
      /&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi,
      (match, entity) => {
        if (entity.charAt(0) === '#') {
          const hex = entity.charAt(1) === 'x' || entity.charAt(1) === 'X';
          const code = parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
          if (!isFinite(code) || code <= 0 || code > 0x10FFFF) return match;
          try { return String.fromCodePoint(code); } catch (e) { return match; }
        }
        switch (entity.toLowerCase()) {
          case 'amp': return '&';
          case 'lt': return '<';
          case 'gt': return '>';
          case 'quot': return '"';
          case 'apos': return "'";
          case 'nbsp': return ' ';
          default: return match;
        }
      });
  }

  // SAFETY: inlineMd operates on ALREADY-escaped text, so link URLs and
  // code contents are pre-escaped (&quot; cannot break out of href, &lt;
  // cannot open a tag). Code spans and links are stashed before emphasis
  // runs so markers/underscores inside them are never reinterpreted.
  function inlineMd(text) {
    const stash = [];
    const keep = (html) => { stash.push(html); return '\u0000' + (stash.length - 1) + '\u0000'; };
    const emphasis = (s) => String(s)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/__([^_]+)__/g, '<strong>$1</strong>')
      .replace(/~~([^~]+)~~/g, '<del>$1</del>')
      .replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/(^|[^_\w])_([^_\n]+)_(?![\w])/g, '$1<em>$2</em>');
    let out = String(text);
    out = out.replace(/`([^`\n]+)`/g, (m, code) => keep('<code>' + code + '</code>'));
    out = out.replace(/\[([^\]\n]+)\]\((https?:[^)\s]+)\)/g,
      (m, label, url) => keep('<a href="' + url + '" target="_blank" rel="noopener">' + emphasis(label) + '</a>'));
    out = emphasis(out);
    let prev = null;
    while (prev !== out && /\u0000\d+\u0000/.test(out)) {
      prev = out;
      out = out.replace(/\u0000(\d+)\u0000/g,
        (m, i) => (stash[Number(i)] !== undefined ? stash[Number(i)] : m));
    }
    return out;
  }

  // Line-based lite Markdown for model answers. Structure is detected on
  // the decoded source line by line (so a heading/list/quote works inside
  // a multi-line block and mixed intro+list text splits into groups), and
  // every text fragment is escaped BEFORE inlineMd — only the tags
  // generated here survive, via setGeneratedHtml below.
  function markdownLite(text) {
    const source = decodeHtmlEntities(text == null ? '' : String(text))
      .replace(/\r\n?/g, '\n');
    const lines = source.split('\n');
    const out = [];
    let para = [];
    let list = null;
    let quote = [];
    let fence = null;
    const renderInline = (raw) => inlineMd(escapeHtml(raw));
    // GFM pipe tables: a header row, a --- separator row, then body rows.
    // Collected raw (unescaped) and escaped per cell at render, like fences.
    let table = null;
    const splitRow = (line) => {
      let s = line.trim();
      if (s.charAt(0) === '|') s = s.slice(1);
      if (s.charAt(s.length - 1) === '|') s = s.slice(0, -1);
      return s.split('|').map((c) => c.trim());
    };
    const isSepRow = (line) => /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line) &&
      splitRow(line).every((c) => /^:?-{1,}:?$/.test(c));
    function flushTable() {
      if (!table) return;
      const head = table.head.map((c) => '<th>' + renderInline(c) + '</th>').join('');
      const rows = table.rows.map((r) =>
        '<tr>' + r.map((c) => '<td>' + renderInline(c) + '</td>').join('') + '</tr>').join('');
      out.push('<table><thead><tr>' + head + '</tr></thead><tbody>' + rows + '</tbody></table>');
      table = null;
    }
    function flushPara() {
      if (!para.length) return;
      out.push('<p>' + para.map((l) => renderInline(l.trim())).join('<br>') + '</p>');
      para = [];
    }
    function flushList() {
      if (!list) return;
      const tag = list.ordered ? 'ol' : 'ul';
      out.push('<' + tag + '>' + list.items.map((item) =>
        '<li>' + renderInline(item) + '</li>').join('') + '</' + tag + '>');
      list = null;
    }
    function flushQuote() {
      if (!quote.length) return;
      out.push('<blockquote>' + quote.map((l) => renderInline(l)).join('<br>') + '</blockquote>');
      quote = [];
    }
    function flushBlocks() { flushPara(); flushList(); flushQuote(); flushTable(); }
    function flushFence() {
      if (fence === null) return;
      out.push('<pre><code>' + escapeHtml(fence.join('\n')) + '</code></pre>');
      fence = null;
    }
    for (const line of lines) {
      if (fence !== null) {
        if (/^\s*```/.test(line)) flushFence();
        else fence.push(line);
        continue;
      }
      if (/^\s*```/.test(line)) { flushBlocks(); fence = []; continue; }
      if (!line.trim()) { flushBlocks(); continue; }
      const heading = line.match(/^\s*(#{1,6})\s+(.+?)\s*#*\s*$/);
      if (heading) {
        flushBlocks();
        const level = Math.min(heading[1].length + 2, 6);
        out.push('<h' + level + '>' + renderInline(heading[2]) + '</h' + level + '>');
        continue;
      }
      if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
        flushBlocks();
        out.push('<hr>');
        continue;
      }
      const quoted = line.match(/^\s*>\s?(.*)$/);
      if (quoted) { flushPara(); flushList(); flushTable(); quote.push(quoted[1]); continue; }
      // GFM pipe table: separator row under a pending header row starts it.
      if (table && /^\s*\|/.test(line)) { table.rows.push(splitRow(line)); continue; }
      if (!table && para.length === 1 && /^\s*\|/.test(para[0]) && isSepRow(line)) {
        table = { head: splitRow(para[0]), rows: [] };
        para = [];
        continue;
      }
      const item = line.match(/^\s*([-*+•]|\d+[.)])\s+(.+)$/);
      if (item) {
        flushPara(); flushQuote(); flushTable();
        const ordered = /^\d/.test(item[1]);
        if (list && list.ordered !== ordered) flushList();
        if (!list) list = { ordered, items: [] };
        list.items.push(item[2]);
        continue;
      }
      if (list && /^\s{2,}\S/.test(line)) {
        list.items[list.items.length - 1] += ' ' + line.trim();
        continue;
      }
      flushList(); flushQuote(); flushTable();
      para.push(line);
    }
    flushFence();
    flushBlocks();
    return out.join('');
  }

  function setGeneratedHtml(el, html) {
    var doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
    var blocked = doc.querySelectorAll('script, style, iframe, object, embed, form, input, img, svg, math, link, meta, title, base');
    for (var i = blocked.length - 1; i >= 0; i--) blocked[i].remove();
    var els = doc.querySelectorAll('*');
    for (var j = 0; j < els.length; j++) {
      var attrs = Array.from(els[j].attributes || []);
      for (var k = 0; k < attrs.length; k++) {
        var name = attrs[k].name.toLowerCase();
        if (name !== 'href' && name !== 'title' && name !== 'class') els[j].removeAttribute(attrs[k].name);
        else if (name === 'href' && !/^(https?:|mailto:|#|\/|\.)/i.test(attrs[k].value)) els[j].removeAttribute(attrs[k].name);
      }
    }
    while (el.firstChild) el.removeChild(el.firstChild);
    while (doc.body.firstChild) el.appendChild(doc.body.firstChild);
  }

  // Shared provider/model picker (lib/model-select.js, loaded before this
  // file): the choice persists via the background (setActiveModel) and is
  // sent per request below so a faster model can serve search answers.
  let searchModelPicker = null;

  async function chatSync(messages, action) {
    const sel = searchModelPicker ? searchModelPicker.getSelection() : null;
    const raw = await runtime.sendMessage({
      type: 'chatSync', messages, action,
      providerId: sel ? sel.providerId : undefined,
      model: sel ? sel.model : undefined
    });
    if (!raw) throw new Error('No response from background');
    const res = (raw && typeof raw === 'object' && 'ok' in raw && ('result' in raw || 'error' in raw))
      ? (raw.ok ? raw.result : (() => { throw new Error(raw.error || 'Request failed'); })())
      : raw;
    if (!res) throw new Error('No response from background');
    if (res.error) throw new Error(res.error);
    if (res.ok === false) throw new Error(res.text || 'Request failed');
    return res.text || '';
  }

  function getQuery() {
    const params = new URLSearchParams(location.search);
    const fromUrl = params.get('q') || params.get('query') || '';
    if (fromUrl.trim()) return fromUrl.trim();
    const input = document.querySelector(
      'input[name="q"], textarea[name="q"], #sb_form_q, input[type="search"]'
    );
    return input ? (input.value || '').trim() : '';
  }

  function engineName() {
    if (location.hostname.includes('bing.')) return 'Bing';
    if (location.hostname.includes('duckduckgo.')) return 'DuckDuckGo';
    return 'Google';
  }

  // Results are collected FRESH at generate time (and re-collected while the
  // page settles): Google renders results progressively, so a snapshot taken
  // when the card first mounts is often empty — the old card then told the
  // model "no results" and it reported the search as empty. Broad selectors:
  // current Google markup nests results as #rso > div with h3 links, and the
  // .g class comes and goes between experiments.
  function collectResults(limit) {
    const selectors = [
      // Google (specific first, then the broad container sweep)
      '#rso .g, #search .g',
      '#rso div[data-hveid] h3, #search div[data-hveid] h3',
      '#rso h3, #search h3',
      // Bing
      '#b_results .b_algo',
      // DuckDuckGo
      '.result, .web-result, article[data-testid="result"]'
    ];
    let nodes = [];
    for (const selector of selectors) {
      nodes = Array.from(document.querySelectorAll(selector));
      if (nodes.length) break;
    }
    const results = [];
    const seen = new Set();
    for (const node of nodes) {
      if (node.closest && node.closest('.gs-search-card')) continue;
      const root = node.closest('.g, .b_algo, .result, .web-result, article') || node;
      const titleEl = root.querySelector('h3, h2, .result__title, a[data-testid="result-title-a"]') || root.querySelector('a');
      const snippetEl = root.querySelector(
        '.VwiC3b, .b_caption p, .result__snippet, [data-sncf], .b_snippet, span'
      );
      const linkEl = root.querySelector('a[href^="http"]');
      const title = titleEl ? (titleEl.innerText || titleEl.textContent || '').trim() : '';
      const snippet = snippetEl ? (snippetEl.innerText || snippetEl.textContent || '').trim() : '';
      const url = linkEl ? linkEl.href : '';
      const key = title + '|' + url;
      if (!title || seen.has(key)) continue;
      seen.add(key);
      results.push({ title, snippet: snippet.slice(0, 300), url });
      if (results.length >= limit) break;
    }
    return results;
  }

  // Results stay on the left in the engine's intended layout. On wide
  // viewports the card is a floating box fixed at the right (mounted on
  // <body>, out of flow), so it can never push the results around; the
  // gs-search-card--float class in panel.css carries that layout and it
  // only applies above the wide breakpoint. On narrow viewports a fixed
  // box would cover results, so there the card falls back in-flow: its own
  // full-width block above the results list, marked with the stretch class.
  function mountCard(card) {
    // Grafted onto <body>: a transformed or filtered ancestor would
    // hijack position:fixed positioning, and body has none on search
    // pages. The same node is moved (never rebuilt) so live result
    // state and the watcher expandos survive.
    card.classList.remove('gs-search-card--stretch');
    card.classList.add('gs-search-card--float');
    wireSearchCardControls(card);
    document.body.appendChild(card);
  }

  // In-flow fallback host (narrow viewports): the results column itself,
  // where the card takes a whole full-width row above the list.
  function fallbackInsertionPoint() {
    const mainSelectors = ['#rcnt', '#search', '#b_results', '#links', '#web_content_wrapper', 'main'];
    for (const selector of mainSelectors) {
      const el = document.querySelector(selector);
      if (el) return el;
    }
    return null;
  }

  // Below this width (mirrors the CSS breakpoint in panel.css) a floating
  // box would overlap the results column, so the in-flow fallback is used;
  // wide viewports keep results untouched on the left.
  const FLOAT_MIN_WIDTH = 1150;
  const SEARCH_CARD_GEOMETRY_KEY = 'graphiteSider.searchCardGeometry.v1';

  function clampSearchGeometry(geometry) {
    const margin = 12;
    const width = Math.min(Math.max(320, Number(geometry.width) || 420), Math.max(320, window.innerWidth - margin * 2));
    const height = Math.min(Math.max(240, Number(geometry.height) || 560), Math.max(240, window.innerHeight - margin * 2));
    return {
      left: Math.max(margin, Math.min(Number(geometry.left) || margin, window.innerWidth - width - margin)),
      top: Math.max(margin, Math.min(Number(geometry.top) || margin, window.innerHeight - height - margin)),
      width,
      height
    };
  }

  function applySearchGeometry(card, geometry) {
    const g = clampSearchGeometry(geometry);
    card.style.left = g.left + 'px';
    card.style.top = g.top + 'px';
    card.style.right = 'auto';
    card.style.width = g.width + 'px';
    card.style.height = g.height + 'px';
    card.style.maxHeight = 'none';
  }

  function saveSearchGeometry(card) {
    const rect = card.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    try {
      const api = typeof browser !== 'undefined' ? browser : chrome;
      api.storage.local.set({ [SEARCH_CARD_GEOMETRY_KEY]: {
        left: rect.left, top: rect.top, width: rect.width, height: rect.height
      } });
    } catch (e) { /* best-effort */ }
  }

  function wireSearchCardControls(card) {
    if (card.__gsControlsWired) return;
    card.__gsControlsWired = true;
    card.classList.add('gs-search-card--resizable');
    const header = card.querySelector('.gs-search-head');
    let gesture = null;
    const end = () => {
      if (!gesture) return;
      gesture = null;
      card.classList.remove('gs-search-card--dragging');
      saveSearchGeometry(card);
    };
    const start = (mode, event) => {
      if (event.button != null && event.button !== 0) return;
      if (event.target.closest('button, select, input, a')) return;
      if (mode === 'drag' && event.target.closest('.gs-model-picker')) return;
      const r = card.getBoundingClientRect();
      gesture = { mode, x: event.clientX, y: event.clientY, left: r.left, top: r.top, width: r.width, height: r.height };
      card.classList.add('gs-search-card--dragging');
      event.preventDefault();
    };
    const move = (event) => {
      if (!gesture) return;
      if (gesture.mode === 'drag') {
        applySearchGeometry(card, Object.assign({}, gesture, {
          left: gesture.left + event.clientX - gesture.x,
          top: gesture.top + event.clientY - gesture.y
        }));
      } else {
        applySearchGeometry(card, Object.assign({}, gesture, {
          width: gesture.width + event.clientX - gesture.x,
          height: gesture.height + event.clientY - gesture.y
        }));
      }
      event.preventDefault();
    };
    if (header) {
      header.title = 'Drag to move';
      header.addEventListener('pointerdown', (e) => start('drag', e));
      header.addEventListener('mousedown', (e) => { if (!gesture) start('drag', e); });
    }
    card.addEventListener('pointerdown', (e) => {
      const rect = card.getBoundingClientRect();
      if (e.clientX >= rect.right - 22 && e.clientY >= rect.bottom - 22) start('resize', e);
    });
    card.addEventListener('mousedown', (e) => {
      const rect = card.getBoundingClientRect();
      if (!gesture && e.clientX >= rect.right - 22 && e.clientY >= rect.bottom - 22) start('resize', e);
    });
    window.addEventListener('pointermove', move, { capture: true, passive: false });
    window.addEventListener('mousemove', move, true);
    window.addEventListener('pointerup', end, true);
    window.addEventListener('mouseup', end, true);
    window.addEventListener('blur', end);
    try {
      const api = typeof browser !== 'undefined' ? browser : chrome;
      api.storage.local.get(SEARCH_CARD_GEOMETRY_KEY).then((value) => {
        const saved = value && value[SEARCH_CARD_GEOMETRY_KEY];
        if (saved && window.innerWidth >= FLOAT_MIN_WIDTH) {
          card.classList.add('gs-search-card--user-geometry');
          applySearchGeometry(card, saved);
        }
      }).catch(() => {});
    } catch (e) { /* use default placement */ }
  }

  // Engines can flip light/dark at runtime (theme toggle, OS scheme
  // change) without any DOM mutation, so keep the sampled page theme
  // fresh on a slow interval while the card lives. Cleared on unload;
  // one timer per page (the content script runs once per frame).
  setInterval(() => {
    const card = document.querySelector('.gs-search-card');
    if (card) applyPageTheme(card);
  }, 3000);

  // Follow the results page's own theme: sample the rendered page
  // background and mark light cards so the CSS variable set flips to the
  // engine's light palette (Google #fff card on #fff/#f8f9fa pages,
  // #202124 text). Dark pages keep the Graphite dark palette (default
  // #22242a). getComputedStyle always resolves rgba(); a transparent body
  // falls back to the document element.
  function applyPageTheme(card) {
    try {
      const bg = getComputedStyle(document.body).backgroundColor;
      const m = /rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+%?))?\)/.exec(bg || '');
      if (!m || (m[4] !== undefined && parseFloat(m[4]) === 0)) return;
      const lum = (0.2126 * Number(m[1]) + 0.7152 * Number(m[2]) + 0.0722 * Number(m[3])) / 255;
      if (lum > 0.6) card.classList.add('gs-search-card--light');
      else card.classList.remove('gs-search-card--light');
    } catch (e) { /* theme stays dark, the historical default */ }
  }

  function buildCard(query, initialResults) {
    const card = document.createElement('section');
    card.className = 'gs-search-card graphite-sider-ui';
    // Live state, not the mount-time snapshot: refreshResults() re-collects
    // so late-rendered results are seen, and the Generate handler always
    // reads this array instead of a stale closure.
    const state = { results: (initialResults || []).slice() };
    const head = document.createElement('div');
    head.className = 'gs-search-head';
    const title = document.createElement('span');
    title.className = 'gs-search-title';
    title.textContent = '◆ Graphite AI Answer';
    head.appendChild(title);
    try {
      if (typeof GraphiteModelSelect !== 'undefined' && GraphiteModelSelect.createPicker) {
        searchModelPicker = GraphiteModelSelect.createPicker(head, {});
      }
    } catch (e) { searchModelPicker = null; }
    // No sidebar on Firefox for Android: open the chat (sidebar on desktop,
    // chat tab there) from the card too.
    const openChatBtn = document.createElement('button');
    openChatBtn.className = 'gs-yt-btn gs-search-open-chat';
    openChatBtn.type = 'button';
    openChatBtn.textContent = 'Open chat';
    openChatBtn.addEventListener('click', () => {
      runtime.sendMessage({ type: 'openSidebarWith', action: 'chat', text: '', url: location.href, title: document.title })
        .catch(() => {});
    });
    head.appendChild(openChatBtn);
    const body = document.createElement('div');
    body.className = 'gs-search-body';
    const sources = document.createElement('p');
    sources.className = 'gs-search-sources';
    body.appendChild(sources);
    // Honest count text, kept current by refreshResults(). The search is
    // only reported as having no results when collection is STILL empty
    // after re-collecting against the settled page.
    function describeResults() {
      if (state.results.length) {
        sources.textContent = 'Answer "' + query + '" using the top ' +
          state.results.length + ' ' + engineName() + ' results as context. Generated only when you ask.';
      } else {
        sources.textContent = 'No ' + engineName() + ' results found on this page yet — they may still be loading. ' +
          'Clicking Generate re-checks the page before answering.';
      }
    }
    function refreshResults() {
      const fresh = collectResults(5);
      if (fresh.length) state.results = fresh;
      describeResults();
      return state.results;
    }
    refreshResults();
    const foot = document.createElement('div');
    foot.className = 'gs-search-foot';
    const button = document.createElement('button');
    button.className = 'gs-yt-btn gs-search-generate';
    button.type = 'button';
    button.textContent = 'Generate answer';
    foot.appendChild(button);
    card.appendChild(head);
    card.appendChild(body);
    card.appendChild(foot);
    button.addEventListener('click', async () => {
      button.disabled = true;
      button.textContent = 'Generating...';
      // Re-collect NOW: results rendered after the card mounted (the common
      // case on Google) must be in the prompt, not the stale empty snapshot.
      refreshResults();
      const results = state.results;
      while (body.firstChild) body.removeChild(body.firstChild);
      const status = document.createElement('span');
      status.className = 'gs-yt-status';
      const spinner = document.createElement('span');
      spinner.className = 'gs-spinner';
      status.appendChild(spinner);
      status.appendChild(document.createTextNode('Thinking...'));
      body.appendChild(status);
      const context = results.map((r, i) =>
        (i + 1) + '. ' + r.title + (r.snippet ? '\n   ' + r.snippet : '') + (r.url ? '\n   ' + r.url : '')
      ).join('\n');
      // Only when collection is genuinely empty after the fresh re-collect
      // does the prompt say so; otherwise the real results are the context
      // and the model must answer from them, not claim the search was empty.
      const prompt = results.length
        ? 'Answer this search query concisely and helpfully, using the search results below as context where relevant. Mention sources by number like [1] when you rely on them. If the results do not answer the query, say so briefly and answer from general knowledge.\n\nQuery: ' +
          query + '\n\nSearch results:\n' + context
        : 'Answer this search query concisely and helpfully from your general knowledge. No search-result snippets could be read from the results page, so do not claim the search itself returned nothing — just answer the question directly.\n\nQuery: ' +
          query;
      try {
        const answer = await chatSync([{ role: 'user', content: prompt }], 'search-answer');
        setGeneratedHtml(body, markdownLite(answer));
        const ansFoot = document.createElement('div');
        ansFoot.className = 'gs-search-foot';
        const sidebarBtnEl = document.createElement('button');
        sidebarBtnEl.className = 'gs-yt-btn';
        sidebarBtnEl.type = 'button';
        sidebarBtnEl.setAttribute('data-gs-open-sidebar', '');
        sidebarBtnEl.textContent = 'Open in sidebar';
        const copyBtnEl = document.createElement('button');
        copyBtnEl.className = 'gs-yt-btn';
        copyBtnEl.type = 'button';
        copyBtnEl.setAttribute('data-gs-copy', '');
        copyBtnEl.textContent = 'Copy';
        ansFoot.appendChild(sidebarBtnEl);
        ansFoot.appendChild(copyBtnEl);
        body.appendChild(ansFoot);
        const sidebarBtn = body.querySelector('[data-gs-open-sidebar]');
        if (sidebarBtn) sidebarBtn.addEventListener('click', () => {
          runtime.sendMessage({
            type: 'openSidebarWith',
            action: 'search-answer',
            text: answer,
            url: location.href,
            title: document.title
          }).catch(() => {});
        });
        const copyBtn = body.querySelector('[data-gs-copy]');
        if (copyBtn) copyBtn.addEventListener('click', async () => {
          try { await navigator.clipboard.writeText(answer); copyBtn.textContent = 'Copied'; } catch (e) { /* ignore */ }
        });
      } catch (error) {
        while (body.firstChild) body.removeChild(body.firstChild);
        const errP = document.createElement('p');
        errP.style.color = 'var(--gs-card-error, #e88a8a)';
        errP.textContent = error && error.message ? error.message : 'Request failed';
        body.appendChild(errP);
        button.disabled = false;
        button.textContent = 'Try again';
      }
    });
    card.__gsRefreshResults = refreshResults;
    card.__gsHasResults = () => state.results.length > 0;
    return card;
  }

  // Keep re-collecting results until they appear (Google renders them after
  // the card mounts) or the watch expires; also re-lays the card out if the
  // page reflows. Disconnects once results are flowing.
  function watchCard(card) {
    if (!card || card.__gsWatching) return;
    card.__gsWatching = true;
    // A viewport resize can cross the float breakpoint in either direction;
    // re-anchor the same node so the layout mode always matches.
    let resizeTimer = 0;
    const onResize = () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => { ensureMount(card); }, 150);
    };
    window.addEventListener('resize', onResize);
    let ticks = 0;
    const observer = new MutationObserver(() => {
      ticks += 1;
      if (typeof card.__gsRefreshResults === 'function') card.__gsRefreshResults();
      // The page can re-render under the card (Google swaps result columns
      // without a resize): keep the mount layout in step, and re-sample
      // the page theme in case the engine flipped light/dark.
      ensureMount(card);
      applyPageTheme(card);
      const done = typeof card.__gsHasResults === 'function' && card.__gsHasResults();
      if (done || ticks > 40) observer.disconnect();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => observer.disconnect(), 15000);
  }

  // Idempotently place the card for the current viewport: floating box at
  // the right on wide viewports, in-flow full-width fallback on narrow
  // ones. Moving the same node keeps state and expandos; when the card is
  // already where it belongs this is a no-op (MutationObserver feedback
  // would otherwise re-trigger itself forever).
  function ensureMount(card) {
    if (!card || !card.isConnected && !document.body) return;
    if (window.innerWidth >= FLOAT_MIN_WIDTH) {
      if (card.parentElement === document.body &&
          card.classList.contains('gs-search-card--float')) return;
      mountCard(card);
      if (card.classList.contains('gs-search-card--user-geometry')) return;
      applyPageTheme(card);
      return;
    }
    if (card.parentElement !== document.body &&
        card.classList.contains('gs-search-card--stretch')) return;
    const host = fallbackInsertionPoint();
    if (!host) return;
    card.classList.remove('gs-search-card--float');
    card.classList.add('gs-search-card--stretch');
    host.prepend(card);
    applyPageTheme(card);
  }

  async function init() {
    let stored = {};
    try {
      const api = typeof browser !== 'undefined' ? browser : chrome;
      const keys = ['graphiteSider.settings.v1', 'graphite_settings'];
      const data = await api.storage.local.get(keys);
      const raw = (data && (data['graphiteSider.settings.v1'] || data.graphite_settings)) || {};
      stored = Object.assign({}, raw, (raw && raw.settings) || {});
    } catch (e) { /* settings default to enabled */ }
    if (stored.searchEnhance === false) return;

    const tryInsert = () => {
      const existing = document.querySelector('.gs-search-card');
      if (existing) {
        // Keep the mounted card fed with late-rendered results, and keep
        // its mount layout matching the viewport.
        ensureMount(existing);
        watchCard(existing);
        return true;
      }
      const query = getQuery();
      if (!query) return false;
      if (!document.body) return false;
      const results = collectResults(5);
      const card = buildCard(query, results);
      mountCard(card);
      ensureMount(card);
      watchCard(card);
      return true;
    };

    if (!tryInsert()) {
      let attempts = 0;
      const observer = new MutationObserver(() => {
        attempts += 1;
        if (tryInsert() || attempts > 60) observer.disconnect();
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
      setTimeout(() => observer.disconnect(), 15000);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
