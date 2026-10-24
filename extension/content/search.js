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

  function collectResults(limit) {
    const selectors = [
      // Google
      '#search .g, #rso .g, div[data-hveid] h3',
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
  // DuckDuckGo sidebar), never at the top of the main results column.
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
    // 2. No rail: build our own column next to the main results. Prepending
    //    inside #rcnt (Google's two-column container) keeps the card
    //    beside, not above, the organic results.
    const mainSelectors = ['#rcnt', '#search', '#b_results', '#links', '#web_content_wrapper', 'main'];
    for (const selector of mainSelectors) {
      const el = document.querySelector(selector);
      if (el) return { el, rail: false };
    }
    return null;
  }

  function buildCard(query, results) {
    const card = document.createElement('section');
    card.className = 'gs-search-card';
    card.innerHTML =
      '<div class="gs-search-head">' +
        '<span class="gs-search-title">\u25C6 Graphite AI Answer</span>' +
      '</div>' +
      '<div class="gs-search-body">' +
        '<p class="gs-search-sources">Answer "' + escapeHtml(query) + '" using the top ' +
        results.length + ' ' + engineName() + ' results as context. Generated only when you ask.</p>' +
      '</div>' +
      '<div class="gs-search-foot">' +
        '<button class="gs-yt-btn gs-search-generate" type="button">Generate answer</button>' +
      '</div>';
    const body = card.querySelector('.gs-search-body');
    const button = card.querySelector('.gs-search-generate');
    button.addEventListener('click', async () => {
      button.disabled = true;
      button.textContent = 'Generating...';
      body.innerHTML = '<span class="gs-yt-status"><span class="gs-spinner"></span>Thinking...</span>';
      const context = results.map((r, i) =>
        (i + 1) + '. ' + r.title + (r.snippet ? '\n   ' + r.snippet : '') + (r.url ? '\n   ' + r.url : '')
      ).join('\n');
      const prompt =
        'Answer this search query concisely and helpfully, using the search results below as context where relevant. Mention sources by number like [1] when you rely on them. If the results do not answer the query, say so briefly and answer from general knowledge.\n\nQuery: ' +
        query + '\n\nSearch results:\n' + context;
      try {
        const answer = await chatSync([{ role: 'user', content: prompt }], 'search-answer');
        body.innerHTML = markdownLite(answer) +
          '<div class="gs-search-foot">' +
            '<button class="gs-yt-btn" type="button" data-gs-open-sidebar>Open in sidebar</button>' +
            '<button class="gs-yt-btn" type="button" data-gs-copy>Copy</button>' +
          '</div>';
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
        body.innerHTML = '<p style="color:#e88a8a">' +
          escapeHtml(error && error.message ? error.message : 'Request failed') + '</p>';
        button.disabled = false;
        button.textContent = 'Try again';
      }
    });
    return card;
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
      if (document.querySelector('.gs-search-card')) return true;
      const query = getQuery();
      if (!query) return false;
      const target = insertionPoint();
      if (!target) return false;
      const results = collectResults(5);
      const card = buildCard(query, results);
      if (target.rail) {
        target.el.prepend(card);
      } else {
        // Park in a right-side column of our own instead of inflating the
        // top of the results column. The host page's layout rows already
        // place the card on the right; the class only tightens it.
        card.classList.add('gs-search-card--rail-fallback');
        target.el.prepend(card);
      }
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
