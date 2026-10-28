'use strict';
/**
 * Graphite Captions — parse WebVTT and SRT caption/subtitle text into
 * timestamped segments, and normalise already-structured segments
 * (e.g. a content script reading a <track>.track via the TextTrack API).
 *
 * The segment shape matches GraphiteYouTube ({start, dur, text}) so
 * sidebar code can feed page videos through the same summary/translate
 * prompts as YouTube. Parsing is regex-based only (no DOMParser, no
 * fetch) so it loads in background, sidebar, content and test sandboxes.
 */
(function (global) {

  function decodeEntities(str) {
    return String(str || '')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
      .replace(/&#(\d+);/g, function (_, n) { return String.fromCharCode(parseInt(n, 10)); })
      .replace(/&#x([0-9a-fA-F]+);/g, function (_, n) { return String.fromCharCode(parseInt(n, 16)); })
      .replace(/\s+/g, ' ').trim();
  }

  // Strip real cue markup (<b>, <i>, <c.class>, <00:00:01.500> timestamps).
  // Runs BEFORE entity decoding so an entity-encoded "&lt;b&gt;" survives
  // as literal text instead of being mistaken for markup.
  function stripCueTags(str) {
    return String(str || '').replace(/<\/?(?:b|i|u|v|c|ruby|rt|lang|\d{2}:)[^>]*>/gi, ' ');
  }

  /** '00:01:23.456' | '01:23.456' | '00:01:23,456' -> seconds, or NaN. */
  function parseTimestamp(value) {
    var s = String(value == null ? '' : value).trim().replace(',', '.');
    var m = /^(?:(\d+):)?([0-5]?\d):([0-5]\d)(?:\.(\d{1,3}))?$/.exec(s);
    if (!m) return NaN;
    return (parseInt(m[1] || '0', 10) * 3600) + (parseInt(m[2], 10) * 60) +
      parseInt(m[3], 10) + (m[4] ? Number('0.' + m[4]) : 0);
  }

  /** Sort, drop empties, dedupe consecutive duplicates (caption roll-up).
   *  Rolling captions repeat the previous cue text as a prefix of the next;
   *  merge them into one growing segment instead of fragmenting the text. */
  function normalizeSegments(segs) {
    var sorted = (segs || []).slice().sort(function (a, b) { return (a.start || 0) - (b.start || 0); });
    var out = [];
    sorted.forEach(function (seg) {
      var text = decodeEntities(stripCueTags(seg.text));
      if (!text) return;
      var prev = out[out.length - 1];
      if (prev) {
        if (prev.text === text) {
          // Exact repeat (roll-up hold): extend the previous segment's span.
          prev.dur = Math.max(prev.dur, (Number(seg.start) || 0) + (Number(seg.dur) || 0) - prev.start);
          return;
        }
        if (text.indexOf(prev.text) === 0 && text.length > prev.text.length) {
          // Roll-up growth ("Hello" -> "Hello world"): replace the previous
          // partial segment with the fuller text, keeping its start time.
          prev.text = text;
          prev.dur = Math.max(prev.dur, (Number(seg.start) || 0) + (Number(seg.dur) || 0) - prev.start);
          return;
        }
      }
      out.push({ start: Number(seg.start) || 0, dur: Number(seg.dur) || 0, text: text });
    });
    return out;
  }

  var TIMING_RE = /(\S+)\s+-->\s+(\S+)/;

  function splitCueBlocks(body) {
    return String(body || '').replace(/\r\n?/g, '\n').split(/\n{2,}/);
  }

  /**
   * Parse WebVTT or SRT text.
   * Returns timestamped segments: [{start, dur, text}] (seconds).
   * Header/ NOTE / STYLE / REGION blocks and SRT cue numbers are skipped.
   */
  function parseCues(text) {
    var src = String(text || '');
    if (src.charCodeAt(0) === 0xFEFF) src = src.slice(1);
    if (/^\s*(WEBVTT|WEBVTT[\s-])/.test(src)) {
      // Drop the WEBVTT header line plus any header metadata that follows.
      src = src.replace(/^\s*WEBVTT[^\n]*\n/, '');
      src = src.replace(/^\s*(NOTE|STYLE|REGION)\b[^\n]*(\n(?!\n)[^\n]*)*\n?/gm, '');
    }
    var out = [];
    splitCueBlocks(src).forEach(function (block) {
      var lines = block.split('\n').filter(function (l) { return l.trim() !== ''; });
      var idx = lines.findIndex(function (l) { return TIMING_RE.test(l); });
      if (idx === -1) return;
      var timing = lines[idx];
      var m = TIMING_RE.exec(timing);
      var start = parseTimestamp(m[1]);
      var end = parseTimestamp(m[2]);
      if (!isFinite(start)) return;
      var cueText = decodeEntities(stripCueTags(lines.slice(idx + 1).join('\n')));
      if (!cueText) return;
      out.push({
        start: start,
        dur: (isFinite(end) && end > start) ? end - start : 0,
        text: cueText
      });
    });
    return normalizeSegments(out);
  }

  /**
   * Normalise structured cues from a TextTrack/textTrack proxy:
   * [{startTime, endTime, text}] -> [{start, dur, text}].
   */
  function fromTrackCues(cues) {
    var list = [];
    (cues || []).forEach(function (c) {
      if (!c) return;
      list.push({
        start: Math.max(0, Number(c.startTime) || 0),
        dur: Math.max(0, (Number(c.endTime) || 0) - (Number(c.startTime) || 0)),
        text: String(c.text || '')
      });
    });
    return normalizeSegments(list);
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

  global.GraphiteCaptions = {
    parseCues: parseCues,
    fromTrackCues: fromTrackCues,
    parseTimestamp: parseTimestamp,
    segmentsToText: segmentsToText,
    formatTimestamp: formatTimestamp,
    _decodeEntities: decodeEntities,
    _normalizeSegments: normalizeSegments
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
