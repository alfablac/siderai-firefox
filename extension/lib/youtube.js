'use strict';
/**
 * Graphite YouTube — transcript helpers.
 * Transcripts come from direct timedtext API calls plus ytInitialPlayerResponse
 * parsing: pick a caption track, fetch it as json3, and normalise the events
 * into timestamped lines for the summary prompts.
 */
(function (global) {

  var VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

  /** Extract the 11-char video id from watch/youtu.be/shorts/embed/live/music URLs. */
  function parseVideoId(url) {
    if (!url) return null;
    var s = String(url);
    if (VIDEO_ID_RE.test(s)) return s;
    try {
      var u = new URL(s);
      var host = u.hostname.replace(/^(www\.|m\.|music\.)/, '');
      if (host === 'youtu.be') {
        var id = u.pathname.split('/').filter(Boolean)[0];
        return id && VIDEO_ID_RE.test(id) ? id : null;
      }
      if (host === 'youtube.com' || host === 'youtube-nocookie.com' || host.endsWith('.youtube.com')) {
        var v = u.searchParams.get('v');
        if (v && VIDEO_ID_RE.test(v)) return v;
        var parts = u.pathname.split('/').filter(Boolean);
        if (['shorts', 'embed', 'live', 'v'].indexOf(parts[0]) >= 0 && parts[1] && VIDEO_ID_RE.test(parts[1])) return parts[1];
      }
    } catch (e) { /* not a URL */ }
    var m = s.match(/[?&]v=([A-Za-z0-9_-]{11})/) || s.match(/youtu\.be\/([A-Za-z0-9_-]{11})/);
    return m ? m[1] : null;
  }

  function decodeEntities(str) {
    return String(str || '')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
      .replace(/&#(\d+);/g, function (_, n) { return String.fromCharCode(parseInt(n, 10)); })
      .replace(/&#x([0-9a-fA-F]+);/g, function (_, n) { return String.fromCharCode(parseInt(n, 16)); })
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ').trim();
  }

  /**
   * Parse a timedtext payload: json3 object/string, srv3/XML transcript, or XML list.
   * @returns {Array<{start:number, dur:number, text:string}>}
   */
  function parseTimedText(input) {
    if (!input) return [];
    if (typeof input === 'object') {
      if (Array.isArray(input.events)) return parseJson3(input);
      if (Array.isArray(input)) return normalizeSegments(input);
      return [];
    }
    var s = String(input).trim();
    if (s.charAt(0) === '{') {
      try { var j = JSON.parse(s); if (j && j.events) return parseJson3(j); } catch (e) { /* fall through */ }
    }
    return parseXmlTranscript(s);
  }

  function parseJson3(json) {
    var out = [];
    (json.events || []).forEach(function (ev) {
      if (!ev.segs) return;
      var text = ev.segs.map(function (seg) { return seg.utf8 || ''; }).join('');
      text = decodeEntities(text);
      if (!text) return;
      out.push({ start: (ev.tStartMs || 0) / 1000, dur: (ev.dDurationMs || 0) / 1000, text: text });
    });
    return normalizeSegments(out);
  }

  function parseXmlTranscript(xml) {
    var out = [];
    var re = /<text[^>]*\bstart="([\d.]+)"[^>]*?(?:\bdur="([\d.]+)")?[^>]*>([\s\S]*?)<\/text>/g;
    var m;
    while ((m = re.exec(xml)) !== null) {
      var text = decodeEntities(m[3]);
      if (text) out.push({ start: parseFloat(m[1]) || 0, dur: parseFloat(m[2]) || 0, text: text });
    }
    return normalizeSegments(out);
  }

  /** Sort, drop empties, dedupe consecutive duplicates (auto-caption roll-up). */
  function normalizeSegments(segs) {
    var sorted = segs.slice().sort(function (a, b) { return a.start - b.start; });
    var out = [];
    sorted.forEach(function (seg) {
      var text = decodeEntities(seg.text);
      if (!text) return;
      var prev = out[out.length - 1];
      if (prev && prev.text === text) return;
      // Rolling ASR captions repeat the previous line as a prefix — trim overlap.
      if (prev && text.indexOf(prev.text) === 0 && text.length > prev.text.length) {
        text = text.slice(prev.text.length).trim();
        if (!text) return;
      }
      out.push({ start: seg.start || 0, dur: seg.dur || 0, text: text });
    });
    return out;
  }

  /** Parse an XML caption-track list (type=list response). */
  function parseTrackList(xml) {
    var tracks = [];
    var re = /<track[^>]*>/g;
    var m;
    while ((m = re.exec(String(xml || ''))) !== null) {
      var tag = m[0];
      function attr(name) {
        var am = new RegExp('\\b' + name + '="([^"]*)"').exec(tag);
        return am ? decodeEntities(am[1]) : '';
      }
      tracks.push({
        langCode: attr('lang_code'), langOriginal: attr('lang_original'),
        name: attr('name'), kind: attr('kind'), id: attr('id')
      });
    }
    return tracks.filter(function (t) { return t.langCode; });
  }

  /** Prefer manual English, then any manual, then auto English, then first track. */
  function pickTrack(tracks, preferredLang) {
    if (!tracks.length) return null;
    var pref = (preferredLang || 'en').toLowerCase();
    function isAuto(t) { return t.kind === 'asr'; }
    function langStarts(t, l) { return (t.langCode || '').toLowerCase().indexOf(l) === 0; }
    return tracks.filter(function (t) { return langStarts(t, pref) && !isAuto(t); })[0]
      || tracks.filter(function (t) { return !isAuto(t); })[0]
      || tracks.filter(function (t) { return langStarts(t, pref); })[0]
      || tracks[0];
  }

  function formatTimestamp(sec) {
    sec = Math.max(0, Math.floor(Number(sec) || 0));
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    function pad(n) { return (n < 10 ? '0' : '') + n; }
    return h > 0 ? h + ':' + pad(m) + ':' + pad(s) : pad(m) + ':' + pad(s);
  }

  function segmentsToText(segments, withTimestamps) {
    return (segments || []).map(function (seg) {
      return withTimestamps === false ? seg.text : '[' + formatTimestamp(seg.start) + '] ' + seg.text;
    }).join('\n');
  }

  function extractCaptionTracks(playerResponse) {
    try {
      var captions = playerResponse.captions.playerCaptionsTracklistRenderer.captionTracks || [];
      return captions.map(function (t) {
        return {
          baseUrl: t.baseUrl, langCode: t.languageCode, name: (t.name && (t.name.simpleText || (t.name.runs || []).map(function (r) { return r.text; }).join(''))) || '',
          kind: t.kind || '', isTranslatable: !!t.isTranslatable
        };
      });
    } catch (e) { return []; }
  }

  /**
   * Fetch a transcript.
   * Strategies, in order:
   *  (a) timedtext list API → pick best track → fetch with fmt=json3 (fallback: XML)
   *  (b) captionTracks from a supplied ytInitialPlayerResponse (page context)
   * @param {string} videoIdOrUrl
   * @param {{playerResponse?:object, lang?:string, fetchFn?:function}} [options]
   * @returns {Promise<{videoId:string, lang:string, segments:Array, text:string, source:string}>}
   */
  async function fetchTranscript(videoIdOrUrl, options) {
    options = options || {};
    var fetchFn = options.fetchFn || global.fetch;
    if (typeof fetchFn !== 'function') throw new Error('fetchTranscript: fetch unavailable');
    var videoId = parseVideoId(videoIdOrUrl) || String(videoIdOrUrl || '');
    if (!VIDEO_ID_RE.test(videoId)) throw new Error('fetchTranscript: could not parse a YouTube video id from "' + videoIdOrUrl + '"');
    var errors = [];

    // (a) timedtext list API
    try {
      var listRes = await fetchFn('https://www.youtube.com/api/timedtext?v=' + encodeURIComponent(videoId) + '&type=list');
      if (listRes.ok) {
        var tracks = parseTrackList(await listRes.text());
        var track = pickTrack(tracks, options.lang);
        if (track) {
          var segs = await fetchTrack(fetchFn, videoId, track);
          if (segs.length) {
            return { videoId: videoId, lang: track.langCode, segments: segs, text: segmentsToText(segs, true), source: 'timedtext-list' };
          }
        } else errors.push('timedtext list had no tracks');
      } else errors.push('timedtext list HTTP ' + listRes.status);
    } catch (e) { errors.push('timedtext list: ' + (e && e.message || e)); }

    // (b) playerResponse captionTracks
    if (options.playerResponse) {
      try {
        var prTracks = extractCaptionTracks(options.playerResponse);
        var byLang = {};
        prTracks.forEach(function (t) { byLang[t.langCode] = t; });
        var asTrack = prTracks.map(function (t) {
          return { langCode: t.langCode, kind: t.kind, name: t.name, _baseUrl: t.baseUrl };
        });
        var chosen = pickTrack(asTrack, options.lang);
        if (chosen && chosen._baseUrl) {
          var url = chosen._baseUrl + (chosen._baseUrl.indexOf('?') >= 0 ? '&' : '?') + 'fmt=json3';
          var r = await fetchFn(url);
          if (r.ok) {
            var parsed = parseTimedText(await r.text());
            if (parsed.length) {
              return { videoId: videoId, lang: chosen.langCode, segments: parsed, text: segmentsToText(parsed, true), source: 'player-response' };
            }
          }
          errors.push('playerResponse track fetch failed');
        } else errors.push('playerResponse had no caption tracks');
      } catch (e) { errors.push('playerResponse: ' + (e && e.message || e)); }
    }

    throw new Error('No transcript available for video ' + videoId + ' (' + errors.join('; ') + ')');
  }

  async function fetchTrack(fetchFn, videoId, track) {
    var base = 'https://www.youtube.com/api/timedtext?v=' + encodeURIComponent(videoId) +
      '&lang=' + encodeURIComponent(track.langCode) + (track.kind ? '&kind=' + encodeURIComponent(track.kind) : '') +
      (track.name ? '&name=' + encodeURIComponent(track.name) : '');
    var r = await fetchFn(base + '&fmt=json3');
    if (r.ok) {
      var parsed = parseTimedText(await r.text());
      if (parsed.length) return parsed;
    }
    var r2 = await fetchFn(base);
    if (r2.ok) return parseTimedText(await r2.text());
    return [];
  }

  /** Chunk transcript segments into <= maxChars blocks, preserving [MM:SS] markers. */
  function chunkTranscript(segments, maxChars) {
    maxChars = maxChars || 6000;
    var chunks = [];
    var cur = '';
    (segments || []).forEach(function (seg) {
      var line = '[' + formatTimestamp(seg.start) + '] ' + seg.text;
      if (cur && cur.length + line.length + 1 > maxChars) { chunks.push(cur); cur = ''; }
      cur = cur ? cur + '\n' + line : line;
    });
    if (cur) chunks.push(cur);
    return chunks;
  }

  var YOUTUBE_SUMMARY_PROMPT_ID = 'youtube-summary';
  var YOUTUBE_SUMMARY_INLINE_TEMPLATE = 'You are an expert transcript analyst and summarizer.\n\nCreate a complete, organized summary in the same language as the transcript. STRICT RULES: do NOT invent information, names, timestamps, or quotes; preserve provided timestamps exactly (if none, use [Part 1], [Part 2]); group by THEME in chronological order; use Markdown tables. OUTPUT: 1) OVERVIEW table (Title/Topic, Type, Speakers, Total Duration, Main Subject); 2) EXECUTIVE SUMMARY (TL;DR) 150-200 words + 5-7 takeaway bullets; 3) SUMMARY TABLE OF THEMES (# | Timestamp | Theme / Topic | Core Summary | Key Speaker(s)); 4) DETAILED THEMATIC BREAKDOWN (5-10 sections: ### [N]. [Title] `[Start - End]`, Summary, Key Points, Important Quote, Decisions / Outcomes); 5) FINAL CONSOLIDATED TABLES (Key Decisions; Action Items / Next Steps — or "Not mentioned in the transcript."; Open Questions); 6) FINAL TAKEAWAYS (3-5 bullets).\n\nTRANSCRIPT TO SUMMARIZE:\nTitle: {{title}}\n\n{{transcript}}';

  /**
   * Resolve the effective 'youtube-summary' body: a user prompt with the
   * same id in settings.prompts wins (the listPrompts id-clash rule), the
   * builtin is next, and the inline template is the no-libs fallback.
   * @param {object} [settings] settings object carrying settings.prompts
   * @param {object} [promptsLib] prompts lib; defaults to the loaded
   *        GraphitePrompts. Pass an explicit lib so unit tests can inject
   *        one, and so the builder never depends on an ambient global.
   * @returns {string}
   */
  function getYouTubeSummaryPromptBody(settings, promptsLib) {
    var lib = promptsLib != null ? promptsLib : (typeof global.GraphitePrompts !== 'undefined' ? global.GraphitePrompts : null);
    if (lib) {
      if (typeof lib.getEffectivePrompt === 'function') {
        var eff = lib.getEffectivePrompt(YOUTUBE_SUMMARY_PROMPT_ID, settings);
        if (eff && eff.body) return eff.body;
      }
      if (typeof lib.listPrompts === 'function') {
        var all = lib.listPrompts(settings) || [];
        for (var i = 0; i < all.length; i++) {
          if (all[i] && all[i].id === YOUTUBE_SUMMARY_PROMPT_ID && all[i].body) return all[i].body;
        }
      }
      if (typeof lib.getBuiltin === 'function') {
        var builtin = lib.getBuiltin(YOUTUBE_SUMMARY_PROMPT_ID);
        if (builtin && builtin.body) return builtin.body;
      }
    }
    if (settings && Array.isArray(settings.prompts)) {
      var user = settings.prompts.filter(function (p) {
        return p && p.id === YOUTUBE_SUMMARY_PROMPT_ID && p.body;
      })[0];
      if (user) return user.body;
    }
    return YOUTUBE_SUMMARY_INLINE_TEMPLATE;
  }

  /**
   * Build the standard summary prompt for a fetched transcript.
   * @param {string|object} transcript
   * @param {string} title
   * @param {object} [settings] full settings; a user prompt with id
   *        'youtube-summary' in settings.prompts overrides the builtin.
   * @param {object} [promptsLib] prompts lib override (defaults to the
   *        loaded GraphitePrompts); the override body is resolved
   *        through it, then rendered with its renderPrompt when present.
   */
  function buildYouTubeSummaryPrompt(transcript, title, settings, promptsLib) {
    var text = typeof transcript === 'string' ? transcript
      : (transcript && transcript.text) || segmentsToText((transcript && transcript.segments) || [], true);
    var lib = promptsLib != null ? promptsLib : (typeof global.GraphitePrompts !== 'undefined' ? global.GraphitePrompts : null);
    var tpl = getYouTubeSummaryPromptBody(settings, lib);
    if (lib && typeof lib.renderPrompt === 'function') {
      return lib.renderPrompt(tpl, { title: title || '', transcript: text });
    }
    return tpl.replace('{{title}}', title || '').replace('{{transcript}}', text);
  }

  /** Video metadata via YouTube oEmbed (no API key). */
  async function fetchVideoMeta(videoIdOrUrl, fetchFn) {
    var f = fetchFn || global.fetch;
    var id = parseVideoId(videoIdOrUrl);
    if (!id) throw new Error('fetchVideoMeta: bad video id/url');
    var watch = 'https://www.youtube.com/watch?v=' + id;
    var res = await f('https://www.youtube.com/oembed?url=' + encodeURIComponent(watch) + '&format=json');
    if (!res.ok) throw new Error('oEmbed HTTP ' + res.status);
    var j = await res.json();
    return { videoId: id, title: j.title || '', author: j.author_name || '', authorUrl: j.author_url || '', thumbnail: j.thumbnail_url || '', url: watch };
  }

  global.GraphiteYouTube = {
    parseVideoId: parseVideoId,
    parseTimedText: parseTimedText,
    parseTrackList: parseTrackList,
    pickTrack: pickTrack,
    formatTimestamp: formatTimestamp,
    segmentsToText: segmentsToText,
    extractCaptionTracks: extractCaptionTracks,
    fetchTranscript: fetchTranscript,
    chunkTranscript: chunkTranscript,
    buildYouTubeSummaryPrompt: buildYouTubeSummaryPrompt,
    getYouTubeSummaryPromptBody: getYouTubeSummaryPromptBody,
    fetchVideoMeta: fetchVideoMeta,
    _decodeEntities: decodeEntities,
    _normalizeSegments: normalizeSegments
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
