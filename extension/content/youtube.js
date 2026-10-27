/* Graphite Sider - YouTube enhancer.
   Injects a Graphite panel under the player: video summary, timestamped
   chapters and a bilingual subtitles overlay. Transcript is captured via
   a page-context bridge (installed once by content/inject-yt.js at
   document_start) that passively records the timedtext URL and a slim
   projection of ytInitialPlayerResponse, bridged back with window
   messages.

   FREEZE FIX (do not regress): the previous version observed
   document.documentElement with {childList,subtree} and called maybeInit()
   on every mutation batch; maybeInit()->ensurePanel() itself mutates the
   DOM, and YouTube mutates constantly, so the observer self-triggered in
   an unbounded storm (harness: 200k callbacks/900ms cap-hit; real file
   needed a circuit breaker after 300 callbacks for 40 test mutations).
   This version never observes the whole document: work is scheduled
   through a single rAF+timeout-debounced entry point, guarded by
   href/videoId, and the only MutationObserver watches a narrow anchor
   subtree and ignores mutations inside our own panel. */
(function () {
  'use strict';

  if (window.__graphiteYouTubeLoaded) return;
  window.__graphiteYouTubeLoaded = true;

  const runtime = (typeof browser !== 'undefined' && browser.runtime)
    ? browser.runtime
    : (typeof chrome !== 'undefined' ? chrome.runtime : null);
  if (!runtime) return;

  const DEFAULT_SETTINGS = {
    targetLanguage: 'English',
    translateLanguage: '',
    language: '',
    youtubeSummary: true
  };
  let settings = Object.assign({}, DEFAULT_SETTINGS);

  let playerResponse = null;
  let captionUrl = '';
  let transcript = null; // [{start, dur, text}]
  let transcriptPromise = null;
  let summaryCache = { videoId: '', text: '' };
  let bilingualOn = false;
  let subtitleTimer = null;
  let translationCache = new Map();
  let pendingLines = [];
  let pendingTimer = null;
  let lastCaptionIndex = -1;

  // ------------------------------------------------------------- settings

  async function loadSettings() {
    try {
      const api = typeof browser !== 'undefined' ? browser : chrome;
      const keys = ['graphiteSider.settings.v1', 'graphite_settings'];
      const data = await api.storage.local.get(keys);
      const stored = (data && (data['graphiteSider.settings.v1'] || data.graphite_settings)) || {};
      const inner = (stored && stored.settings) || {};
      const flat = Object.assign({}, stored);
      if (inner.targetLang && !flat.targetLanguage) flat.targetLanguage = inner.targetLang;
      if (inner.targetLang && !flat.translateLanguage) flat.translateLanguage = inner.targetLang;
      if (typeof inner.youtubeAutoSummary !== 'undefined') flat.youtubeSummary = inner.youtubeAutoSummary;
      flat.targetLanguage = flat.targetLanguage || flat.translateLanguage || '';
      settings = Object.assign({}, DEFAULT_SETTINGS, flat);
      ytDebug = settings.debugLog === true || settings.debug === true; // gated, off by default
    } catch (e) {
      settings = Object.assign({}, DEFAULT_SETTINGS);
    }
  }

  /* Debug logging (off by default; enable via settings.debugLog).
   * Metadata only: video id, durations, error names. Never transcript
   * text, prompt bodies, or provider responses. */
  let ytDebug = false;
  function ytLog(msg, data) {
    if (!ytDebug) return;
    try { console.log('[Graphite:yt] ' + msg, data == null ? '' : data); } catch (e) {}
  }

  function targetLang() {
    return settings.translateLanguage || settings.targetLanguage || settings.language || 'English';
  }

  // ---------------------------------------------------------------- utils

  function escapeHtml(text) {
    return String(text == null ? '' : text)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* Shared timestamp helpers. This content script cannot load lib/prompts.js
   * (not in manifest), so the helpers below mirror GraphitePrompts
   * parseTimestampSeconds / linkifyTimestamps / extractTimestamps. */

  function parseTimestampSeconds(raw) {
    if (raw == null) return null;
    if (typeof raw === 'number') return (isFinite(raw) && raw >= 0) ? Math.floor(raw) : null;
    const s = String(raw).trim();
    if (!s) return null;
    if (/^\d+$/.test(s)) return parseInt(s, 10); // bare integer seconds (data-seek-seconds round-trip)
    if (/^\[part\s+\d+\]$/i.test(s)) return null; // [Part N] is never a time
    const m = s.match(/^(?:\((\d{1,2}):([0-5]\d)(?::([0-5]\d))?\)|\[(\d{1,2}):([0-5]\d)(?::([0-5]\d))?\]|(\d{1,2}):([0-5]\d)(?::([0-5]\d))?)$/);
    if (!m) return null;
    const a = m[1] != null ? [m[1], m[2], m[3]] : (m[4] != null ? [m[4], m[5], m[6]] : [m[7], m[8], m[9]]);
    return a[2] != null
      ? parseInt(a[0], 10) * 3600 + parseInt(a[1], 10) * 60 + parseInt(a[2], 10)
      : parseInt(a[0], 10) * 60 + parseInt(a[1], 10);
  }

  const TS_RANGE_SRC = '(\\d{1,2}:[0-5]\\d(?::[0-5]\\d)?)(\\s*(?:-|–|—|to)\\s*)(\\d{1,2}:[0-5]\\d(?::[0-5]\\d)?)';
  const TS_SINGLE_SRC = '(\\d{1,2}:[0-5]\\d(?::[0-5]\\d)?)';

  function tsButton(label, seconds) {
    return '<button type="button" class="gs-yt-ts" data-seek-seconds="' + seconds + '" title="Jump to ' + escapeHtml(label) + '">' + escapeHtml(label) + '</button>';
  }

  /* Linkify timestamps in an ESCAPED html string. Ranges target their start. */
  function linkifyTimestamps(html) {
    const protectedRe = /(<(?:pre|code|a|button|script|style)\b[\s\S]*?<\/(?:pre|code|a|button|script|style)>)|(<[^>]+>)/gi;
    const parts = String(html == null ? '' : html).split(protectedRe);
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (part == null || part === '' || part.charAt(0) === '<') continue;
      const rangeRe = new RegExp(TS_RANGE_SRC, 'g');
      const singleRe = new RegExp(TS_SINGLE_SRC, 'g');
      const matches = [];
      let m;
      while ((m = rangeRe.exec(part)) !== null) {
        const a = parseTimestampSeconds(m[1]);
        const b = parseTimestampSeconds(m[3]);
        if (a != null && b != null && b >= a) matches.push({ index: m.index, len: m[0].length, label: m[1] + m[2] + m[3], seconds: a });
      }
      while ((m = singleRe.exec(part)) !== null) {
        const sec = parseTimestampSeconds(m[1]);
        if (sec == null) continue;
        const inside = matches.some((x) => m.index >= x.index && m.index < x.index + x.len);
        if (!inside) matches.push({ index: m.index, len: m[0].length, label: m[1], seconds: sec });
      }
      matches.sort((x, y) => x.index - y.index);
      let out = '';
      let last = 0;
      matches.forEach((x) => {
        if (x.index < last) return;
        out += part.slice(last, x.index) + tsButton(x.label, x.seconds);
        last = x.index + x.len;
      });
      parts[i] = out + part.slice(last);
    }
    return parts.join('');
  }

  function extractTimestamps(text) {
    const s = String(text == null ? '' : text);
    const rangeRe = new RegExp(TS_RANGE_SRC, 'g');
    const singleRe = new RegExp(TS_SINGLE_SRC, 'g');
    const covered = [];
    const found = [];
    const seen = {};
    let m;
    while ((m = rangeRe.exec(s)) !== null) {
      const a = parseTimestampSeconds(m[1]);
      const b = parseTimestampSeconds(m[3]);
      if (a == null || b == null || b < a) continue;
      covered.push([m.index, m.index + m[0].length]);
      const label = m[0].replace(/\s+/g, ' ').trim();
      if (!seen[label + '@' + a]) { seen[label + '@' + a] = true; found.push({ label, seconds: a, endSeconds: b }); }
    }
    while ((m = singleRe.exec(s)) !== null) {
      if (covered.some((c) => m.index >= c[0] && m.index < c[1])) continue;
      const sec = parseTimestampSeconds(m[1]);
      if (sec != null && !seen[m[1] + '@' + sec]) { seen[m[1] + '@' + sec] = true; found.push({ label: m[1], seconds: sec }); }
    }
    return found.sort((x, y) => x.seconds - y.seconds);
  }

  // Delegated seek clicks (survives re-render). Direct player seek first,
  // then YouTube's seekTo API, then a ?t= reload as last resort.
  document.addEventListener('click', (event) => {
    const target = event.target && event.target.closest ? event.target.closest('[data-seek-seconds]') : null;
    if (!target) return;
    if (!target.closest || !target.closest('.gs-yt-panel')) return;
    const seconds = parseTimestampSeconds(target.getAttribute('data-seek-seconds'));
    if (seconds == null) return;
    event.preventDefault();
    seekTo(seconds);
  });

  function inlineMd(text) {
    return String(text)
      .replace(/`([^`]+)`/g, (m, c) => {
        const label = c.trim();
        // The summary headings emit `[Start - End]` inside the code span; unwrap it.
        const inner = label.replace(/^\[([\s\S]*)\]$/, '$1');
        const range = inner.match(new RegExp('^' + TS_RANGE_SRC + '$'));
        if (range) {
          const a = parseTimestampSeconds(range[1]);
          const b = parseTimestampSeconds(range[3]);
          if (a != null && b != null && b >= a) return tsButton(label, a);
        }
        const single = parseTimestampSeconds(label);
        if (single != null) return tsButton(label, single);
        return '<code>' + c + '</code>';
      })
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  }

  function isTableSeparator(line) {
    return /^\s*\|?[\s:|-]+\|?\s*$/.test(line) && line.indexOf('-') !== -1;
  }

  function splitRow(line) {
    let t = String(line || '').trim();
    if (t.charAt(0) === '|') t = t.slice(1);
    if (t.charAt(t.length - 1) === '|') t = t.slice(0, -1);
    return t.split('|').map((c) => c.trim());
  }

  // Line-based renderer: headings, lists, blockquotes, hr, tables, paragraphs.
  // The old paragraph-split renderer could not render the summary's tables.
  function markdownLite(text) {
    const lines = String(text == null ? '' : text).split('\n');
    const html = [];
    let i = 0;
    const cell = (raw) => linkifyTimestamps(inlineMd(escapeHtml(raw)));
    const textHtml = (raw) => linkifyTimestamps(inlineMd(escapeHtml(raw)));

    function listBlock(start) {
      const first = lines[start];
      const ordered = /^\s*\d+[.)]\s/.test(first);
      const tag = ordered ? 'ol' : 'ul';
      const items = [];
      let j = start;
      while (j < lines.length) {
        const item = lines[j].match(/^\s*(?:[-*+]|\d+[.)])\s+(.*)$/);
        if (!item) break;
        items.push('<li>' + textHtml(item[1]) + '</li>');
        j++;
      }
      return { html: '<' + tag + '>' + items.join('') + '</' + tag + '>', next: j };
    }

    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }

      const heading = line.match(/^(#{1,6})\s+(.*)$/);
      if (heading) { html.push('<h4>' + textHtml(heading[2]) + '</h4>'); i++; continue; }

      if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { html.push('<hr>'); i++; continue; }

      if (line.indexOf('|') !== -1 && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
        const head = splitRow(line);
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].indexOf('|') !== -1 && lines[i].trim()) { rows.push(splitRow(lines[i])); i++; }
        let t = '<div class="gs-yt-table-wrap"><table><thead><tr>';
        head.forEach((c) => { t += '<th>' + cell(c) + '</th>'; });
        t += '</tr></thead><tbody>';
        rows.forEach((r) => {
          t += '<tr>';
          head.forEach((unused, ci) => { t += '<td>' + cell(r[ci] || '') + '</td>'; });
          t += '</tr>';
        });
        html.push(t + '</tbody></table></div>');
        continue;
      }

      if (/^\s*>\s?/.test(line)) {
        const quote = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) { quote.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
        html.push('<blockquote>' + quote.map(textHtml).join('<br>') + '</blockquote>');
        continue;
      }

      if (/^\s*(?:[-*+]|\d+[.)])\s+/.test(line)) {
        const block = listBlock(i);
        html.push(block.html); i = block.next; continue;
      }

      const para = [line]; i++;
      while (i < lines.length && lines[i].trim() &&
             !/^(#{1,6})\s/.test(lines[i]) && !/^\s*>\s?/.test(lines[i]) &&
             !/^\s*(?:[-*+]|\d+[.)])\s/.test(lines[i]) &&
             !/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i]) &&
             !(lines[i].indexOf('|') !== -1 && i + 1 < lines.length && isTableSeparator(lines[i + 1]))) {
        para.push(lines[i]); i++;
      }
      html.push('<p>' + para.map(textHtml).join('<br>') + '</p>');
    }
    return html.join('\n');
  }

  // Cancel any trailing partial flush scheduled by a superseded stream.
  function cancelPendingPartial() {
    if (partialTimer) { clearTimeout(partialTimer); partialTimer = 0; }
  }

  // Render a summary and also expose the parsed seek index for tests.
  function renderSummary(text) {
    cancelPendingPartial();
    const body = panelBody();
    body.innerHTML = markdownLite(text);
    body.dataset.seekTargets = JSON.stringify(extractTimestamps(text));
    return body;
  }

  // Progressive render during streaming (rendered at most every 150ms by
  // the stream callback): plain escaped text, never half-minted seek buttons.
  // The first chunk renders immediately; later chunks at most once per
  // 150ms, and a trailing timer guarantees the newest text is flushed after
  // the window even when the stream then stalls or the port dies, so a
  // dropped update can never leave the panel showing a stale partial.
  // The final renderSummary() pass runs markdownLite + linkify, so clicks
  // work once the response completes.
  let lastPartialAt = 0;
  let partialTimer = 0;
  let latestPartialText = '';
  function flushPartial() {
    partialTimer = 0;
    lastPartialAt = Date.now();
    const body = panelBody();
    body.innerHTML = '<span class="gs-yt-status"><span class="gs-spinner"></span>Summarizing\u2026</span>' +
      '<div class="gs-yt-partial">' + escapeHtml(String(latestPartialText || '')) + '</div>';
    body.dataset.seekTargets = '[]';
  }
  function renderSummaryPartial(text) {
    latestPartialText = String(text || '');
    if (partialTimer) return;
    const wait = 150 - (Date.now() - lastPartialAt);
    if (wait <= 0) flushPartial();
    else partialTimer = setTimeout(flushPartial, wait);
  }

  function formatTime(seconds) {
    const total = Math.max(0, Math.floor(seconds || 0));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
    return (h > 0 ? h + ':' : '') + mm + ':' + String(s).padStart(2, '0');
  }

  function parseTime(text) {
    const parts = String(text || '').split(':').map((p) => Number(p));
    if (parts.some(isNaN)) return 0;
    return parts.reduce((acc, value) => acc * 60 + value, 0);
  }

  // Firefox's MV2 background is a non-persistent event page: it can be
  // unloaded while a provider request is in flight (the request still
  // reaches the provider), and a message sent while no background listener
  // exists rejects with the raw "Could not establish connection. Receiving
  // end does not exist." That string must never be the panel's final error.
  //
  // All panel chat (summaries, chapters, subtitle translation) therefore
  // goes over the long-lived 'graphite-chat' port with stream:true — the
  // same path the sidebar uses: port traffic keeps the receiving context
  // reachable for the whole request, streamed chunks keep it arriving, and
  // a port that closes early yields whatever text already arrived instead
  // of losing the whole reply. The provider request starts only when the
  // port message is posted, and there is no automatic resend — a failed
  // request is dispatched exactly once, so the provider dashboard never
  // shows a duplicate POST for one click.
  //
  // Slow-model heartbeat (do not collapse these timers back into one):
  // gateways such as 9Router fronting a reasoning model routinely need
  // minutes before the first visible token on a 160k-char transcript, and
  // can pause between tokens while thinking. The background proves it is
  // alive with {type:'ping'} every ~15s (accepted / waiting / streaming).
  // Pings — and any provider byte, including SSE keepalives and reasoning
  // deltas forwarded as ping activity — reset only the background-liveness
  // watchdog below. They do NOT reset the provider no-activity ceiling:
  // that bounds a genuinely hung request. Expiring liveness (no ping at
  // all) means the background really is gone; expiring the activity
  // ceiling means the provider stopped producing anything, which is
  // reported honestly — never as a lost extension connection.
  const CONNECTION_LOST_MESSAGE = 'Connection to the extension background was lost. Reload the page and try again.';
  const PROVIDER_STALLED_MESSAGE = 'The model has not responded for several minutes. It may still be busy — check your provider, or try again.';
  const SUMMARY_BACKGROUND_TIMEOUT_MS = 45000;   // no ping/chunk from the background at all
  const SUMMARY_FIRST_ACTIVITY_TIMEOUT_MS = 600000; // no provider byte before the first token
  const SUMMARY_STALL_TIMEOUT_MS = 600000;       // no provider byte between tokens

  function isConnectionLostError(error) {
    const text = String((error && error.message) || error || '');
    return text.indexOf('Receiving end does not exist') !== -1 ||
      text.indexOf('Could not establish connection') !== -1;
  }

  function friendlyPanelError(message, fallback) {
    const text = String(message == null ? '' : message);
    if (!text) return fallback || 'Request failed';
    return isConnectionLostError(text) ? CONNECTION_LOST_MESSAGE : text;
  }

  // Port/runtime errors that mean the background went away, as opposed to a
  // provider failure the background relays verbatim (e.g. an HTTP 503).
  function isBackgroundGoneError(error) {
    const text = String((error && error.message) || error || '');
    return isConnectionLostError(text) ||
      /message port closed before a response was received/i.test(text) ||
      /disconnected port object/i.test(text) ||
      /attempt to postMessage on disconnected port/i.test(text) ||
      /extension context invalidated/i.test(text);
  }

  // Unexpected runtime strings must not leak into the panel; real provider
  // errors arrive as {type:'error'} messages and pass through unchanged.
  function panelErrorText(error) {
    const text = String((error && error.message) || error || '');
    return (text && !isBackgroundGoneError(text)) ? text : CONNECTION_LOST_MESSAGE;
  }

  // Stream one chat over a fresh 'graphite-chat' port (background contract:
  // post {type:'start', requestId, messages} -> {type:'ping'}* ->
  // {type:'chunk', text}* -> {type:'done', text} | {type:'error', error}).
  // Resolves with the full text; rejects with the provider error, with
  // PROVIDER_STALLED_MESSAGE when the provider goes silent past the
  // no-activity ceiling, or with CONNECTION_LOST_MESSAGE only when the
  // background itself stops pinging / the port closes before any chunk.
  // Sent exactly once. `onWaiting(elapsedMs)` (optional) fires on 'waiting'
  // heartbeats so callers can show a still-working state pre-first-token.
  // `opts.markTruncated` appends a visible notice when the provider reports
  // a length cut-off (finish_reason 'length'); leave it off for chapters /
  // subtitle translation, whose parsers expect pure model text.
  function runSummaryStream(messages, onUpdate, onWaiting, opts) {
    const startedAt = Date.now();
    const requestId = 'yt-' + startedAt + '-' + Math.floor(Math.random() * 1e6);
    ytLog('chatStream open', { requestId: requestId });
    return new Promise((resolve, reject) => {
      let sawChunk = false;
      let sawActivity = false;
      let done = false;
      let full = '';
      let port = null;
      let backgroundTimer = 0;
      let activityTimer = 0;
      // Background liveness: reset by ANY port traffic (ping or chunk).
      // Only this timer may produce CONNECTION_LOST_MESSAGE.
      function armBackgroundTimer() {
        clearTimeout(backgroundTimer);
        backgroundTimer = setTimeout(() => finish(new Error(CONNECTION_LOST_MESSAGE)), SUMMARY_BACKGROUND_TIMEOUT_MS);
      }
      // Provider activity: reset by chunks and by 'streaming' pings (raw
      // provider bytes / reasoning). 'waiting' pings leave it running, so a
      // provider that never answers still fails — with the honest message.
      function armActivityTimer() {
        clearTimeout(activityTimer);
        activityTimer = setTimeout(() => finish(new Error(PROVIDER_STALLED_MESSAGE)),
          sawChunk ? SUMMARY_STALL_TIMEOUT_MS : SUMMARY_FIRST_ACTIVITY_TIMEOUT_MS);
      }
      armBackgroundTimer();
      armActivityTimer();
      function cleanup() {
        clearTimeout(backgroundTimer);
        clearTimeout(activityTimer);
        if (!port) return;
        try { port.onMessage.removeListener(onMsg); } catch (e) {}
        try { port.onDisconnect.removeListener(onDisc); } catch (e) {}
        try { port.disconnect(); } catch (e) {}
        ytLog('chatStream closed', { durationMs: Date.now() - startedAt, chars: full.length });
      }
      function finish(err, text) {
        if (done) return;
        done = true;
        cleanup();
        if (err) { ytLog('chatStream failed', { durationMs: Date.now() - startedAt, name: (err && err.name) || '' }); reject(err); }
        else resolve(text || '');
      }
      function onMsg(msg) {
        if (!msg) return;
        if (msg.requestId != null && msg.requestId !== requestId) return; // shared ports: ignore other flows
        if (msg.type === 'ping') {
          // Heartbeat: the background owns this request. Any ping resets
          // background liveness; only provider activity ('streaming', or a
          // recent lastActivityMs) resets the provider ceiling. A ping is
          // never rendered and never counts as a chunk.
          armBackgroundTimer();
          if (msg.stage === 'streaming' ||
              (typeof msg.lastActivityMs === 'number' && msg.lastActivityMs < SUMMARY_STALL_TIMEOUT_MS)) {
            if (!sawActivity) { sawActivity = true; ytLog('chatStream first activity', { durationMs: Date.now() - startedAt }); }
            armActivityTimer();
          } else if (msg.stage === 'waiting' && !sawChunk && onWaiting) {
            try { onWaiting(typeof msg.elapsedMs === 'number' ? msg.elapsedMs : (Date.now() - startedAt)); } catch (e) {}
          }
          return;
        }
        if (msg.type === 'chunk') {
          const chunkText = (typeof msg.text === 'string') ? msg.text
            : (typeof msg.chunk === 'string' ? msg.chunk : '');
          if (!chunkText && typeof msg.full !== 'string') return;
          armBackgroundTimer();
          sawActivity = true;
          if (!sawChunk) { sawChunk = true; ytLog('chatStream first chunk', { durationMs: Date.now() - startedAt }); }
          if (typeof msg.full === 'string' && msg.full) full = msg.full;
          else full += chunkText;
          if (onUpdate) { try { onUpdate(full); } catch (e) {} }
          armActivityTimer();
        } else if (msg.type === 'done') {
          let text = (typeof msg.text === 'string' && msg.text)
            || (typeof msg.full === 'string' && msg.full) || full;
          if (msg.truncated && opts && opts.markTruncated && text) {
            text += '\n\n> \u26A0\uFE0F Resposta cortada pelo limite de tokens do modelo/provedor (finish_reason: length). Aumente o Max tokens nas op\u00E7\u00F5es ou use um modelo com sa\u00EDda maior. / Response cut off by the model/provider token limit.';
          }
          finish(null, text);
        } else if (msg.type === 'error') {
          // Provider failure relayed by the background: surface it as-is.
          finish(new Error(String(msg.error || msg.message || 'Request failed')));
        }
      }
      function onDisc() {
        if (sawChunk && full) { finish(null, full); return; } // keep partial work
        let detail = '';
        try { detail = (runtime.lastError && runtime.lastError.message) || ''; } catch (e) {}
        finish(new Error(detail || CONNECTION_LOST_MESSAGE));
      }
      try { port = runtime.connect({ name: 'graphite-chat' }); }
      catch (e) { finish(new Error(CONNECTION_LOST_MESSAGE)); return; }
      try {
        port.onMessage.addListener(onMsg);
        port.onDisconnect.addListener(onDisc);
      } catch (e) { finish(new Error(CONNECTION_LOST_MESSAGE)); return; }
      try { port.postMessage({ type: 'start', requestId: requestId, purpose: 'youtube-summary', messages: messages, stream: true }); }
      catch (e) { finish(new Error(panelErrorText(e))); }
    });
  }

  // Every panel chat path resolves through runSummaryStream above; grep
  // guard in tests/smoke.test.js ("youtube chat is port-streamed") fails if
  // a caller goes back to one-shot runtime.sendMessage({type:'chatSync'}).


  function getVideoId() {
    try { return new URL(location.href).searchParams.get('v') || ''; } catch (e) { return ''; }
  }

  function getVideoEl() {
    return document.querySelector('video.html5-main-video, #movie_player video, video');
  }

  // ------------------------------------------------ page-context bridge
  // The bridge page-script is installed ONCE by content/inject-yt.js at
  // document_start (manifest). This content script must not inject a second
  // copy: the old code re-injected an identical bridge here, racing the
  // early one and re-serializing the full ytInitialPlayerResponse 3x per
  // navigation. We only listen, and (as a degraded fallback when the early
  // script somehow did not run) request one re-send via a ping message.

  let bridgePinged = false;
  function injectPageScript() {
    // Legacy name kept for call sites; now a bounded, one-shot ping.
    if (bridgePinged) return;
    bridgePinged = true;
    try { window.postMessage({ type: 'gs-yt-ping' }, '*'); } catch (e) { /* noop */ }
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data) return;
    if (event.data.type === 'gs-yt-caption-url' && event.data.url) {
      if (event.data.url !== captionUrl) captionUrl = event.data.url;
    }
    if (event.data.type === 'gs-yt-player-response' && event.data.playerResponse) {
      try {
        const parsed = JSON.parse(event.data.playerResponse);
        // Only accept a payload for the video we are actually on (or when
        // we have nothing yet); stale SPA payloads must not clobber state.
        const incomingId = (parsed && parsed.videoDetails && parsed.videoDetails.videoId) || '';
        const currentId = getVideoId();
        if (incomingId && currentId && incomingId !== currentId) return;
        playerResponse = parsed;
        if (transcript && currentVideoIdFromResponse() !== getVideoId()) {
          transcript = null; transcriptPromise = null;
        }
      } catch (e) { /* ignore malformed payloads */ }
    }
  });

  function currentVideoIdFromResponse() {
    try { return (playerResponse && playerResponse.videoDetails && playerResponse.videoDetails.videoId) || ''; }
    catch (e) { return ''; }
  }

  // ------------------------------------------------------------- transcript

  function captionTracks() {
    try {
      const tracks = playerResponse.captions.playerCaptionsTracklistRenderer.captionTracks;
      return Array.isArray(tracks) ? tracks : [];
    } catch (e) {
      return [];
    }
  }

  async function fetchCaptionJson(url) {
    const withFmt = /[?&]fmt=/.test(url) ? url : url + (url.includes('?') ? '&' : '?') + 'fmt=json3';
    try {
      const res = await fetch(withFmt, { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        if (data && Array.isArray(data.events)) return data.events;
      }
    } catch (e) { /* fall through to XML */ }
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) throw new Error('Caption request failed (' + res.status + ')');
    const xmlText = await res.text();
    const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
    return Array.from(doc.querySelectorAll('text')).map((node) => ({
      tStartMs: Math.round(parseFloat(node.getAttribute('start') || '0') * 1000),
      dDurationMs: Math.round(parseFloat(node.getAttribute('dur') || '0') * 1000),
      segs: [{ utf8: node.textContent || '' }]
    }));
  }

  function eventsToTranscript(events) {
    return (events || []).map((event) => {
      const text = (event.segs || []).map((seg) => seg.utf8 || '').join('').replace(/\s+/g, ' ').trim();
      return {
        start: (event.tStartMs || 0) / 1000,
        dur: (event.dDurationMs || 0) / 1000,
        text
      };
    }).filter((line) => line.text);
  }

  async function fetchTimedTextList(videoId) {
    // Fallback: timedtext list API (may require a PO token on some clients;
    // failures are non-fatal and simply yield no tracks).
    const url = 'https://www.youtube.com/api/timedtext?v=' + encodeURIComponent(videoId) + '&type=list';
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) return [];
    const xmlText = await res.text();
    const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
    return Array.from(doc.querySelectorAll('track')).map((node) => ({
      baseUrl: 'https://www.youtube.com/api/timedtext?v=' + encodeURIComponent(videoId) +
        '&lang=' + encodeURIComponent(node.getAttribute('lang_code') || 'en') +
        '&name=' + encodeURIComponent(node.getAttribute('name') || ''),
      languageCode: node.getAttribute('lang_code') || '',
      kind: node.getAttribute('kind') || ''
    }));
  }

  async function getTranscript() {
    if (transcript) return transcript;
    if (transcriptPromise) return transcriptPromise;
    transcriptPromise = (async () => {
      const videoId = getVideoId();
      // 1. URL captured from the page's own timedtext request.
      if (captionUrl) {
        try {
          transcript = eventsToTranscript(await fetchCaptionJson(captionUrl));
          if (transcript.length) return transcript;
        } catch (e) { /* try next source */ }
      }
      // 2. Caption tracks from ytInitialPlayerResponse. Bounded wait:
      // the bridge retries its own send a few times; we poll at most
      // ~3s total and then fall through to the timedtext list fallback.
      injectPageScript();
      for (let attempt = 0; attempt < 6 && !playerResponse; attempt++) {
        await new Promise((r) => setTimeout(r, 500));
        if (attempt === 2) injectPageScript();
      }
      let tracks = captionTracks();
      if (!tracks.length && videoId) {
        try { tracks = await fetchTimedTextList(videoId); } catch (e) { tracks = []; }
      }
      if (!tracks.length) throw new Error('No captions found for this video. Enable subtitles or try another video.');
      const track = tracks.find((t) => (t.languageCode || '').startsWith('en') && t.kind !== 'asr')
        || tracks.find((t) => (t.languageCode || '').startsWith('en'))
        || tracks[0];
      const events = await fetchCaptionJson(track.baseUrl);
      transcript = eventsToTranscript(events);
      if (!transcript.length) throw new Error('Caption track was empty.');
      return transcript;
    })();
    try {
      return await transcriptPromise;
    } finally {
      transcriptPromise = null;
    }
  }

  // Ceiling for the timestamped transcript text sent to the model. The old
  // 24000-char default cut a 44:59 video at [22:52]: captions serialize to
  // ~17.5 chars/s (one [MM:SS] line per ~3s caption event, ~52 chars/line),
  // so 24000 chars ends at ~22:52 and a full 45-min transcript is ~47k
  // chars. 160000 chars covers ~2.5h at that density (~9000 caption lines)
  // in a single provider request; it is a ceiling, not a chunk size.
  const TRANSCRIPT_TEXT_MAX_CHARS = 160000;

  function transcriptText(withTimestamps, maxChars) {
    const limit = (typeof maxChars === 'number' && maxChars > 0) ? maxChars : TRANSCRIPT_TEXT_MAX_CHARS;
    const lines = (transcript || []).map((line) =>
      (withTimestamps ? '[' + formatTime(line.start) + '] ' : '') + line.text
    );
    const joined = lines.join('\n');
    if (joined.length <= limit) return joined;
    // Cut on a line boundary so the last line is never a partial timestamp.
    const cut = joined.lastIndexOf('\n', limit);
    return joined.slice(0, cut > 0 ? cut : limit);
  }

  // -------------------------------------------------------------- panel UI

  // Increments on every new video / fresh run so a superseded request can
  // no longer write into the current panel.
  let runSeq = 0;

  // True while ensurePanel is mutating the DOM itself, so the narrow
  // observer (and any re-entrant schedule) can ignore our own writes.
  let panelMutating = false;

  function ensurePanel() {
    let panel = document.querySelector('.gs-yt-panel');
    if (panel) return panel;
    panelMutating = true;
    try { return buildPanel(); } finally { panelMutating = false; }
  }

  function buildPanel() {
    let panel = document.querySelector('.gs-yt-panel');
    if (panel) return panel;
    const anchor = document.querySelector('#below, ytd-watch-metadata, #meta-contents, #primary-inner');
    panel = document.createElement('div');
    panel.className = 'gs-yt-panel';
    panel.innerHTML =
      '<div class="gs-yt-head">' +
        '<span class="gs-yt-title">\u25C6 Graphite</span>' +
        '<button class="gs-yt-btn" data-gs-yt="summarize">Summarize with Graphite</button>' +
        '<button class="gs-yt-btn" data-gs-yt="chapters">Chapters</button>' +
        '<button class="gs-yt-btn" data-gs-yt="bilingual">Bilingual subtitles</button>' +
        '<button class="gs-yt-btn" data-gs-yt="sidebar">Send summary to sidebar</button>' +
      '</div>' +
      '<div class="gs-yt-body" data-gs-yt="body">' +
        '<span class="gs-yt-status">Summarize this video, jump through chapters, or overlay translated subtitles.</span>' +
      '</div>';
    if (anchor && anchor.parentNode) {
      // Prefer directly below the title/meta block.
      const meta = document.querySelector('ytd-watch-metadata') || anchor;
      meta.insertAdjacentElement('afterend', panel);
    } else {
      const primary = document.querySelector('#primary, #columns');
      if (primary) primary.prepend(panel);
    }
    panel.querySelector('[data-gs-yt="summarize"]').addEventListener('click', () => summarizeVideo());
    panel.querySelector('[data-gs-yt="chapters"]').addEventListener('click', () => showChapters());
    panel.querySelector('[data-gs-yt="bilingual"]').addEventListener('click', (event) => toggleBilingual(event.currentTarget));
    panel.querySelector('[data-gs-yt="sidebar"]').addEventListener('click', sendToSidebar);
    return panel;
  }

  function panelBody() {
    return ensurePanel().querySelector('[data-gs-yt="body"]');
  }

  function setPanelLoading(label) {
    cancelPendingPartial();
    panelBody().innerHTML = '<span class="gs-yt-status"><span class="gs-spinner"></span>' + escapeHtml(label) + '</span>';
  }

  // Shown once a background heartbeat reports the provider has not sent
  // anything yet (slow 9Router/reasoning TTFT), so a multi-minute wait reads
  // as "still working" instead of a frozen panel. Streaming progress keeps
  // the existing partial renderer; this only covers the pre-first-token gap.
  function setPanelWaiting(elapsedMs) {
    cancelPendingPartial();
    const secs = Math.max(1, Math.round((elapsedMs || 0) / 1000));
    panelBody().innerHTML = '<span class="gs-yt-status"><span class="gs-spinner"></span>' +
      'Waiting for the model\u2026 (' + secs + 's \u2014 large transcripts can take a few minutes)</span>';
  }

  function setPanelError(message) {
    cancelPendingPartial();
    ytLog('panel error shown', { name: (message && message.name) || '' });
    panelBody().innerHTML = '<span class="gs-yt-status" style="color:#e88a8a">' + escapeHtml(friendlyPanelError(message, 'Request failed')) + '</span>';
  }

  // The canonical prompt lives in lib/prompts.js ('youtube-summary'), which is
  // NOT loaded in this content script. Ask the background (where the libs are
  // loaded) to render it; fall back to an inline mirror of lib/youtube.js's
  // compact template if the background has no prompts lib either.
  async function buildSummaryPrompt(title, url) {
    const transcript = transcriptText(true);
    try {
      const res = await runtime.sendMessage({
        type: 'buildYouTubePrompt', title: title || '', url: url || '',
        transcript, promptId: 'youtube-summary'
      });
      const unwrapped = (res && typeof res === 'object' && 'ok' in res && ('result' in res || 'error' in res))
        ? (res.ok ? res.result : null) : res;
      const prompt = typeof unwrapped === 'string' ? unwrapped : (unwrapped && (unwrapped.prompt || unwrapped.text));
      if (prompt) return prompt;
    } catch (e) { /* fall through to inline */ }
    return 'You are an expert transcript analyst and summarizer.\n\nCreate a complete, organized summary in the same language as the transcript. STRICT RULES: do NOT invent information, names, timestamps, or quotes; preserve provided timestamps exactly (if none, use [Part 1], [Part 2]); group by THEME in chronological order; use Markdown tables. OUTPUT: 1) OVERVIEW table (Title/Topic, Type, Speakers, Total Duration, Main Subject); 2) EXECUTIVE SUMMARY (TL;DR) 150-200 words + 5-7 takeaway bullets; 3) SUMMARY TABLE OF THEMES (# | Timestamp | Theme / Topic | Core Summary | Key Speaker(s)); 4) DETAILED THEMATIC BREAKDOWN (5-10 sections: ### [N]. [Title] `[Start - End]`, Summary, Key Points, Important Quote, Decisions / Outcomes); 5) FINAL CONSOLIDATED TABLES (Key Decisions; Action Items / Next Steps — or "Not mentioned in the transcript."; Open Questions); 6) FINAL TAKEAWAYS (3-5 bullets).\n\nTRANSCRIPT TO SUMMARIZE:\nTitle: ' + (title || '') + '\nURL: ' + (url || '') + '\n\n' + transcript;
  }

  async function summarizeVideo() {
    const videoId = getVideoId();
    const runId = ++runSeq;
    ytLog('summarize start', { videoId }); // id only — never the transcript
    if (summaryCache.videoId === videoId && summaryCache.text) {
      renderSummary(summaryCache.text);
      return summaryCache.text;
    }
    setPanelLoading('Loading transcript...');
    try {
      await getTranscript();
      if (runId !== runSeq) return '';
      setPanelLoading('Summarizing with Graphite...');
      const title = document.title.replace(/ - YouTube$/, '');
      const prompt = await buildSummaryPrompt(title, location.href);
      if (runId !== runSeq) return '';
      const result = await runSummaryStream([{ role: 'user', content: prompt }], (partial) => {
        if (runId !== runSeq) return;
        renderSummaryPartial(partial);
      }, (elapsedMs) => {
        if (runId !== runSeq) return;
        setPanelWaiting(elapsedMs);
      }, { markTruncated: true });
      if (runId !== runSeq) return '';
      summaryCache = { videoId, text: result };
      renderSummary(result);
      return result;
    } catch (error) {
      if (runId !== runSeq) return '';
      setPanelError(error && error.message ? error.message : 'Summary failed');
      return '';
    }
  }

  async function showChapters() {
    setPanelLoading('Building chapters...');
    try {
      await getTranscript();
      const prompt =
        'From this timestamped YouTube transcript, produce chapter markers. Reply with ONLY lines in the format "[mm:ss] Chapter title" (use [hh:mm:ss] for videos over an hour), one per line, 4 to 14 chapters, no extra commentary.\n\nTitle: ' +
        document.title.replace(/ - YouTube$/, '') + '\n\nTranscript:\n' + transcriptText(true, TRANSCRIPT_TEXT_MAX_CHARS);
      const result = await runSummaryStream([{ role: 'user', content: prompt }], null);
      const chapters = [];
      result.split('\n').forEach((line) => {
        const match = line.match(/\[(\d{1,2}:\d{2}(?::\d{2})?)\]\s*(.+)/);
        if (match) chapters.push({ time: match[1], seconds: parseTime(match[1]), title: match[2].trim() });
      });
      if (!chapters.length) {
        panelBody().innerHTML = markdownLite(result);
        return;
      }
      const body = panelBody();
      body.innerHTML = '';
      chapters.forEach((chapter) => {
        const button = document.createElement('button');
        button.className = 'gs-yt-chapter';
        button.innerHTML = '<span class="gs-yt-chapter-time">' + escapeHtml(chapter.time) + '</span>' + escapeHtml(chapter.title);
        button.addEventListener('click', () => seekTo(chapter.seconds));
        body.appendChild(button);
      });
    } catch (error) {
      setPanelError(error && error.message ? error.message : 'Chapters failed');
    }
  }

  function seekTo(seconds) {
    const target = parseTimestampSeconds(seconds);
    if (target == null) return false;
    const video = getVideoEl();
    if (video) {
      try { video.currentTime = target; if (video.paused) video.play().catch(() => {}); return true; } catch (e) { /* try player API */ }
    }
    const player = document.getElementById('movie_player');
    if (player && typeof player.seekTo === 'function') {
      try { player.seekTo(target, true); if (typeof player.playVideo === 'function') player.playVideo(); return true; } catch (e) { /* fall through */ }
    }
    try {
      const url = new URL(location.href);
      url.searchParams.set('t', String(target) + 's');
      location.href = url.toString();
      return true;
    } catch (e) { return false; }
  }

  async function sendToSidebar() {
    let text = summaryCache.videoId === getVideoId() ? summaryCache.text : '';
    if (!text) text = await summarizeVideo();
    try {
      await runtime.sendMessage({
        type: 'openSidebarWith',
        action: 'youtube-summary',
        text: text || location.href,
        url: location.href,
        title: document.title
      });
    } catch (e) { /* sidebar open is best-effort */ }
  }

  // ---------------------------------------------------- bilingual subtitles

  function ensureSubtitleOverlay() {
    const container = document.querySelector('#movie_player, .html5-video-player');
    if (!container) return null;
    let overlay = container.querySelector('.gs-yt-subs');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.className = 'gs-yt-subs';
      overlay.style.display = 'none';
      container.appendChild(overlay);
    }
    return overlay;
  }

  async function toggleBilingual(button) {
    bilingualOn = !bilingualOn;
    if (button) button.classList.toggle('gs-yt-btn-active', bilingualOn);
    const overlay = ensureSubtitleOverlay();
    if (!bilingualOn) {
      if (overlay) overlay.style.display = 'none';
      if (subtitleTimer) { clearInterval(subtitleTimer); subtitleTimer = null; }
      lastCaptionIndex = -1;
      return;
    }
    try {
      await getTranscript();
    } catch (error) {
      bilingualOn = false;
      if (button) button.classList.remove('gs-yt-btn-active');
      setPanelError(error && error.message ? error.message : 'No captions available');
      return;
    }
    if (overlay) overlay.style.display = '';
    if (subtitleTimer) clearInterval(subtitleTimer);
    subtitleTimer = setInterval(updateSubtitles, 400);
    updateSubtitles();
  }

  // Binary search: transcript is sorted by start. The old reverse linear
  // scan ran on every 400ms tick over the whole transcript (O(n) per tick,
  // worst at end-of-video). Keep lastCaptionIndex as a fast-path hint.
  function currentCaptionIndex(now) {
    const lines = transcript || [];
    if (!lines.length) return -1;
    const hint = lastCaptionIndex;
    if (hint >= 0 && hint < lines.length) {
      const hl = lines[hint];
      if (now >= hl.start && now <= hl.start + Math.max(hl.dur, 1.5) + 0.4) return hint;
      const nl = lines[hint + 1];
      if (nl && now >= nl.start && now <= nl.start + Math.max(nl.dur, 1.5) + 0.4) return hint + 1;
    }
    let lo = 0, hi = lines.length - 1, cand = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (lines[mid].start <= now) { cand = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    if (cand < 0) return -1;
    const line = lines[cand];
    return (now <= line.start + Math.max(line.dur, 1.5) + 0.4) ? cand : -1;
  }

  function updateSubtitles() {
    if (!bilingualOn || !transcript) return;
    const video = getVideoEl();
    const overlay = ensureSubtitleOverlay();
    if (!video || !overlay) return;
    const index = currentCaptionIndex(video.currentTime);
    if (index === -1) {
      overlay.style.display = 'none';
      return;
    }
    overlay.style.display = '';
    const line = transcript[index];
    if (index === lastCaptionIndex && overlay.dataset.gsIndex === String(index)) return;
    lastCaptionIndex = index;
    overlay.dataset.gsIndex = String(index);
    const cached = translationCache.get(index);
    overlay.innerHTML =
      '<div>' + escapeHtml(line.text) + '</div>' +
      '<div class="gs-yt-subs-trans">' + escapeHtml(cached || '...') + '</div>';
    if (!cached) queueTranslation(index);
  }

  function queueTranslation(index) {
    pendingLines.push(index);
    if (pendingTimer) return;
    // Batch up to 5 lines, flushed shortly after they appear / 5s max.
    pendingTimer = setTimeout(flushTranslations, 350);
  }

  async function flushTranslations() {
    pendingTimer = null;
    const batch = [...new Set(pendingLines)].filter((i) => !translationCache.has(i)).slice(0, 5);
    pendingLines = [];
    if (!batch.length) return;
    const numbered = batch.map((i, n) => '[' + (n + 1) + '] ' + transcript[i].text).join('\n');
    try {
      const result = await runSummaryStream([{
        role: 'user',
        content: 'Translate each numbered caption line into ' + targetLang() +
          '. Reply with the same numbered lines only, no commentary.\n\n' + numbered
      }], null);
      const byNumber = new Map();
      result.split('\n').forEach((line) => {
        const match = line.match(/^\s*\[(\d+)\]\s*(.*)$/);
        if (match) byNumber.set(Number(match[1]) - 1, match[2].trim());
      });
      batch.forEach((captionIndex, n) => {
        const translated = byNumber.get(n) || (batch.length === 1 ? result.trim() : '');
        if (translated) translationCache.set(captionIndex, translated);
      });
      // Refresh the visible line if it was part of this batch.
      lastCaptionIndex = -1;
      const overlay = ensureSubtitleOverlay();
      if (overlay) overlay.dataset.gsIndex = '';
      updateSubtitles();
    } catch (e) {
      batch.forEach((captionIndex) => translationCache.set(captionIndex, ''));
    }
  }

  // ---------------------------------------------------------------- wiring
  // Lifecycle: single debounced scheduler + narrow observer + SPA events.
  // No document-wide MutationObserver, no continuous polling.

  let anchorObserver = null;
  let observedAnchor = null;
  let scheduleRaf = 0;
  let scheduleTimer = 0;
  let navFallbackTimer = 0;
  let lastHref = location.href;
  let lastVideoId = getVideoId();
  let destroyed = false;

  function isOwnNode(node) {
    if (!node || node.nodeType !== 1) return false;
    const el = node;
    return el.classList.contains('gs-yt-panel') || el.classList.contains('gs-yt-subs') ||
      !!(el.closest && el.closest('.gs-yt-panel, .gs-yt-subs'));
  }

  function findAnchorRoot() {
    return document.querySelector('#primary-inner, #primary, #columns, ytd-watch-flexy') || null;
  }

  // Observe only the watch-column subtree (where the panel anchor lives),
  // never documentElement. Rebinds if YouTube replaces the anchor node.
  function ensureAnchorObserver() {
    if (destroyed) return;
    const root = findAnchorRoot();
    if (!root) return;
    if (anchorObserver && observedAnchor === root) return;
    if (anchorObserver) anchorObserver.disconnect();
    observedAnchor = root;
    anchorObserver = new MutationObserver((mutations) => {
      if (panelMutating || destroyed) return;
      // Skip batches that are PURELY our own writes (panel body updates).
      // A batch that also removes the panel itself must still re-mount,
      // so "touches own" alone is not a skip condition.
      const onlyOwn = mutations.every((m) =>
        isOwnNode(m.target) &&
        [...m.addedNodes].every(isOwnNode) &&
        [...m.removedNodes].every((n) => !n.classList || !n.classList.contains('gs-yt-panel')));
      if (onlyOwn) return;
      // Only react when the panel is actually missing (YouTube re-render
      // dropped it) or the anchor was replaced; otherwise do nothing.
      if (!document.querySelector('.gs-yt-panel')) scheduleInit();
    });
    anchorObserver.observe(root, { childList: true, subtree: true });
  }

  // Coalesce all triggers into at most one run per frame (+50ms tail).
  // NOTE: the pending flag must stay set until `run` executes -- clearing
  // it in the rAF callback let a second schedule through and dropped the
  // pending run's coalescing (observed as flaky re-mount).
  function scheduleInit() {
    if (destroyed || panelMutating) return;
    if (scheduleRaf || scheduleTimer) return;
    const run = () => { scheduleRaf = 0; scheduleTimer = 0; maybeInit(); };
    scheduleTimer = setTimeout(run, 60);
    if (typeof requestAnimationFrame === 'function') {
      scheduleRaf = requestAnimationFrame(() => { scheduleRaf = 0; });
    }
  }

  function maybeInit() {
    if (destroyed || panelMutating) return;
    if (!/\/watch/.test(location.pathname)) return;
    const videoId = getVideoId();
    if (videoId && videoId !== lastVideoId) {
      lastVideoId = videoId;
      resetForVideo();
    }
    lastHref = location.href;
    injectPageScript(); // one-shot bridge ping; no DOM mutation
    if (!document.querySelector('.gs-yt-panel')) ensurePanel();
    ensureAnchorObserver();
  }

  function onNavigate() {
    if (destroyed) return;
    const href = location.href;
    const videoId = getVideoId();
    if (href === lastHref && videoId === lastVideoId) { scheduleInit(); return; }
    lastHref = href;
    if (videoId !== lastVideoId) lastVideoId = videoId;
    resetForVideo();
    scheduleInit();
  }

  function startNavFallback() {
    stopNavFallback();
    // SPA fallback only: cheap href check, cleared once real nav occurs
    // or after a bounded lifetime so nothing polls forever.
    let ticks = 0;
    navFallbackTimer = setInterval(() => {
      ticks++;
      if (destroyed || ticks > 120) { stopNavFallback(); return; }
      if (location.href !== lastHref) { onNavigate(); stopNavFallback(); startNavFallback(); }
    }, 2000);
  }
  function stopNavFallback() {
    if (navFallbackTimer) { clearInterval(navFallbackTimer); navFallbackTimer = 0; }
  }

  function cleanup() {
    destroyed = true;
    if (anchorObserver) { anchorObserver.disconnect(); anchorObserver = null; }
    observedAnchor = null;
    if (scheduleRaf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(scheduleRaf);
    if (scheduleTimer) clearTimeout(scheduleTimer);
    scheduleRaf = 0; scheduleTimer = 0;
    stopNavFallback();
    if (subtitleTimer) { clearInterval(subtitleTimer); subtitleTimer = null; }
    if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
    document.removeEventListener('yt-navigate-finish', onNavigate);
    window.removeEventListener('popstate', onNavigate);
  }

  function resetForVideo() {
    runSeq++; // supersede in-flight summary / chapter / translation runs
    transcript = null;
    transcriptPromise = null;
    playerResponse = null;
    captionUrl = '';
    summaryCache = { videoId: '', text: '' };
    translationCache = new Map();
    pendingLines = [];
    lastCaptionIndex = -1;
    if (bilingualOn) {
      bilingualOn = false;
      if (subtitleTimer) { clearInterval(subtitleTimer); subtitleTimer = null; }
      const overlay = document.querySelector('.gs-yt-subs');
      if (overlay) overlay.style.display = 'none';
      const btn = document.querySelector('[data-gs-yt="bilingual"]');
      if (btn) btn.classList.remove('gs-yt-btn-active');
    }
  }

  runtime.onMessage.addListener((message) => {
    if (!message || message.type !== 'graphite-command') return undefined;
    if (message.command === 'youtube-summary') {
      ensurePanel();
      summarizeVideo();
      const panel = document.querySelector('.gs-yt-panel');
      if (panel) panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return Promise.resolve({ ok: true });
    }
    if (message.command === 'getTranscript') {
      return getTranscript()
        .then((lines) => ({ ok: true, transcript: lines, text: transcriptText(true) }))
        .catch((error) => ({ ok: false, error: String(error && error.message || error) }));
    }
    if (message.command === 'seek') {
      const seconds = parseTimestampSeconds(message.seconds != null ? message.seconds : message.timestamp);
      if (seconds == null) return Promise.resolve({ ok: false, error: 'Invalid timestamp' });
      if (message.videoId && getVideoId() && message.videoId !== getVideoId()) {
        return Promise.resolve({ ok: false, error: 'Video mismatch' });
      }
      return Promise.resolve({ ok: !!seekTo(seconds), seconds });
    }
    return undefined;
  });

  window.GraphiteYouTube = { getTranscript, summarizeVideo, seekTo, toggleBilingual };

  (async function init() {
    await loadSettings();
    if (destroyed) return;
    lastHref = location.href;
    lastVideoId = getVideoId();
    maybeInit();
    // SPA navigation: primary signal + bounded href-check fallback.
    document.addEventListener('yt-navigate-finish', onNavigate);
    window.addEventListener('popstate', onNavigate);
    window.addEventListener('pagehide', cleanup, { once: true });
    startNavFallback();
  })();
})();
