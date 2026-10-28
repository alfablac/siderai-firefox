/* Graphite Sider - search engine enhancer (Google / Bing / DuckDuckGo).
   Inserts a "Graphite AI Answer" card in the right rail alongside the
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

  function inlineMd(text) {
    return String(text)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  }

  function markdownLite(text) {
    return escapeHtml(text).split(/\n{2,}/).map((block) => {
      const lines = block.split('\n');
      const trimmed = block.trim();
      if (!trimmed) return '';
      const heading = trimmed.match(/^(#{1,4})\s+(.*)$/);
      if (heading && lines.length === 1) {
        const level = Math.min(heading[1].length + 2, 6);
        return '<h' + level + '>' + inlineMd(heading[2]) + '</h' + level + '>';
      }
      const isList = lines.length > 1 && lines.every((l) => /^\s*([-*]|\d+\.)\s+/.test(l));
      if (isList) {
        const ordered = /^\s*\d+\./.test(lines[0]);
        const items = lines.map((l) => '<li>' + inlineMd(l.replace(/^\s*([-*]|\d+\.)\s+/, '')) + '</li>').join('');
        return (ordered ? '<ol>' : '<ul>') + items + (ordered ? '</ol>' : '</ul>');
      }
      return '<p>' + lines.map(inlineMd).join('<br>') + '</p>';
    }).join('');
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

  // The answer belongs in the right rail (Google #rhs, Bing #b_context,
  // DuckDuckGo sidebar) and must fill that container; without a native rail it
  // stretches across the results area instead of sitting shrunk in a narrow
  // floated column. Insertion never lands at the top of the results column.
  function insertionPoint() {
    // 1. The engine's own right rail, when present (Google renders #rhs
    //    only with knowledge-panel-type content; on plain queries it is
    //    usually absent, so the check below must not stop here).
    const railSelectors = ['#rhs', '#b_context', '.results--sidebar', '#sidebar', '.sidebar', '#b_dynRail'];
    for (const selector of railSelectors) {
      const el = document.querySelector(selector);
      if (el && el.getClientRects().length && getComputedStyle(el).display !== 'none') {
        return { el, rail: true };
      }
    }
    // 2. No rail: park the card in its own full-width block above the results
    //    list (inside #rcnt/#search it spans the container instead of being
    //    squeezed into a 336px float); tryInsert marks it with the stretch
    //    class so the CSS below can lay it out wide.
    const mainSelectors = ['#rcnt', '#search', '#b_results', '#links', '#web_content_wrapper', 'main'];
    for (const selector of mainSelectors) {
      const el = document.querySelector(selector);
      if (el) return { el, rail: false };
    }
    return null;
  }

  function buildCard(query, initialResults) {
    const card = document.createElement('section');
    card.className = 'gs-search-card';
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
        errP.style.color = '#e88a8a';
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
    let ticks = 0;
    const observer = new MutationObserver(() => {
      ticks += 1;
      if (typeof card.__gsRefreshResults === 'function') card.__gsRefreshResults();
      const done = typeof card.__gsHasResults === 'function' && card.__gsHasResults();
      if (done || ticks > 40) observer.disconnect();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => observer.disconnect(), 15000);
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
        // Keep the mounted card fed with late-rendered results.
        watchCard(existing);
        return true;
      }
      const query = getQuery();
      if (!query) return false;
      const target = insertionPoint();
      if (!target) return false;
      const results = collectResults(5);
      const card = buildCard(query, results);
      if (target.rail) {
        target.el.prepend(card);
      } else {
        // No native rail: the card becomes a full-width block of its own
        // above the results list (the stretch class in overlay.css), never
        // a shrunk floated column.
        card.classList.add('gs-search-card--stretch');
        target.el.prepend(card);
      }
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
