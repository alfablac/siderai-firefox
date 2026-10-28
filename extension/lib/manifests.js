'use strict';
/**
 * Graphite Manifests — find the *separate audio rendition* of a streamed
 * video from its HLS (.m3u8) or DASH (.mpd) manifest, so the background can
 * fetch the site's own compressed audio track (AAC/Opus segments) and send
 * THAT to the transcription provider instead of re-encoded WAV.
 *
 * Pure text parsing (regex / line based): no DOMParser, no fetch, so it
 * runs identically in the background page, content scripts, the sidebar
 * and test sandboxes. All URL resolution is done against the manifest URL.
 */
(function (global) {

  /* RFC-3986-ish relative resolution without a DOM. Handles absolute,
   * protocol-relative, root-relative and ../ / ./ references. */
  function resolveUrl(base, ref) {
    var r = String(ref || '').trim();
    if (!r) return '';
    if (/^[a-z][a-z0-9+.-]*:/i.test(r)) return r;
    var b;
    try { b = new URL(String(base || '')); } catch (e) { return r; }
    if (r.indexOf('//') === 0) return b.protocol + r;
    if (r.charAt(0) === '/') return b.origin + r;
    var dir = b.pathname.replace(/[^/]*$/, '');
    var path = dir + r;
    var out = [];
    path.split('/').forEach(function (seg) {
      if (seg === '.') return;
      if (seg === '..') { out.pop(); return; }
      out.push(seg);
    });
    return b.origin + out.join('/') + (b.search && r.indexOf('?') === -1 && r.indexOf('#') === -1 ? '' : '');
  }

  function parseAttrs(text) {
    var attrs = {};
    var re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/gi;
    var m;
    while ((m = re.exec(String(text || '')))) {
      var v = m[2];
      if (v.length >= 2 && v.charAt(0) === '"' && v.charAt(v.length - 1) === '"') v = v.slice(1, -1);
      attrs[m[1].toUpperCase()] = v;
    }
    return attrs;
  }

  /* ------------------------------ HLS ------------------------------ */

  /** From a master playlist, pick the audio rendition a player would
   * use: DEFAULT=YES first, then the first AUTOSELECT, then the first
   * audio group. Returns { url, lang, name, groupId, default } or null. */
  function parseHlsMaster(text, baseUrl) {
    var lines = String(text || '').split(/\r?\n/);
    var audios = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (line.indexOf('#EXT-X-MEDIA:') !== 0) continue;
      var attrs = parseAttrs(line.slice('#EXT-X-MEDIA:'.length));
      if (String(attrs.TYPE || '').toUpperCase() !== 'AUDIO') continue;
      if (!attrs.URI) continue;
      audios.push({
        url: resolveUrl(baseUrl, attrs.URI),
        lang: attrs.LANGUAGE || '',
        name: attrs.NAME || '',
        groupId: attrs['GROUP-ID'] || '',
        isDefault: /^(YES|TRUE|1)$/i.test(attrs.DEFAULT || ''),
        autoselect: /^(YES|TRUE|1)$/i.test(attrs.AUTOSELECT || '')
      });
    }
    if (!audios.length) return null;
    var pick = audios.filter(function (a) { return a.isDefault; })[0] ||
      audios.filter(function (a) { return a.autoselect; })[0] || audios[0];
    return pick;
  }

  /** If the playlist is a media playlist (has segments), it IS the audio
   * rendition when its segments look like audio. Returns the ordered
   * segment list (with EXT-X-MAP init segment first when present). Each
   * segment also carries its #EXTINF duration (seconds, 0 when unknown)
   * and the running start time, so callers can group segments into
   * time-bounded transcription chunks without re-reading the playlist. */
  function parseHlsMedia(text, baseUrl) {
    var lines = String(text || '').split(/\r?\n/);
    var init = null;
    var segments = [];
    var segmentDurations = [];
    var segmentStarts = [];
    var sawTarget = false;
    var pendingDur = 0;
    var cursor = 0;
    var targetDur = 0;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line) continue;
      if (line.indexOf('#EXT-X-TARGETDURATION') === 0) {
        sawTarget = true;
        var td = Number(line.slice(line.indexOf(':') + 1));
        if (isFinite(td) && td > 0) targetDur = td;
      }
      if (line.indexOf('#EXTINF:') === 0) {
        var inf = Number(line.slice('#EXTINF:'.length).split(',')[0]);
        if (isFinite(inf) && inf > 0) pendingDur = inf;
      }
      if (line.indexOf('#EXT-X-MAP:') === 0) {
        var attrs = parseAttrs(line.slice('#EXT-X-MAP:'.length));
        if (attrs.URI) init = resolveUrl(baseUrl, attrs.URI);
        continue;
      }
      if (line.charAt(0) === '#') continue;
      var dur = pendingDur > 0 ? pendingDur : targetDur;
      segments.push(resolveUrl(baseUrl, line));
      segmentDurations.push(dur);
      segmentStarts.push(cursor);
      cursor += dur;
      pendingDur = 0;
    }
    if (!segments.length) return null;
    return {
      init: init, segments: segments,
      segmentDurations: segmentDurations, segmentStarts: segmentStarts,
      totalDuration: cursor,
      isMedia: sawTarget || segments.length > 0
    };
  }

  /** Does this text look like an HLS playlist at all? */
  function isHls(text) {
    return String(text || '').indexOf('#EXTM3U') !== -1;
  }

  /** Is a URL (or Content-Type) an HLS manifest? */
  function looksLikeHlsUrl(url, contentType) {
    if (contentType && /mpegurl/i.test(contentType)) return true;
    return /\.m3u8($|[?#])/i.test(String(url || ''));
  }

  function looksLikeDashUrl(url, contentType) {
    if (contentType && /dash\+xml/i.test(contentType)) return true;
    return /\.mpd($|[?#])/i.test(String(url || ''));
  }

  /* ------------------------------ DASH ------------------------------ */

  function attrOf(tag, name) {
    var m = new RegExp('\\b' + name + '\\s*=\\s*"([^"]*)"', 'i').exec(tag) ||
      new RegExp("\\b" + name + "\\s*=\\s*'([^']*)'", 'i').exec(tag);
    return m ? m[1] : '';
  }

  /* Expand a SegmentTemplate into concrete segment URLs. Supports
   * $RepresentationID$, $Number$, $Number%0Nd$, $Bandwidth$, $Time$ lists
   * via SegmentTimeline, and plain duration-based numbering. Returns
   * { urls, durations, starts } so callers can chunk by time. */
  function expandDashSegments(tpl, baseUrl, repId, bandwidth, durationSec) {
    var media = tpl.media || '';
    if (!media) return { urls: [], durations: [], starts: [] };
    var out = [];
    var durs = [];
    var starts = [];
    function fill(tplStr, num, time) {
      var s = String(tplStr);
      s = s.replace(/\$RepresentationID\$/g, repId || '');
      s = s.replace(/\$Bandwidth\$/g, String(bandwidth || 0));
      s = s.replace(/\$Number%0(\d+)d\$/g, function (_, w) {
        var n = String(num);
        while (n.length < Number(w)) n = '0' + n;
        return n;
      });
      s = s.replace(/\$Number\$/g, String(num));
      s = s.replace(/\$Time\$/g, String(time != null ? time : num));
      s = s.replace(/\$\$/g, '$');
      return resolveUrl(baseUrl, s);
    }
    var timescale = Number(tpl.timescale) > 0 ? Number(tpl.timescale) : 1;
    var start = Number(tpl.startNumber) || 1;
    if (tpl.timeline && tpl.timeline.length) {
      var t = 0;
      var num = start;
      tpl.timeline.forEach(function (entry) {
        if (entry.t != null && Number(entry.t) >= 0) t = Number(entry.t);
        var count = 1 + (Number(entry.r) > 0 ? Number(entry.r) : 0);
        for (var k = 0; k < count; k++) {
          out.push(fill(media, num, t));
          durs.push((Number(entry.d) || 0) / timescale);
          starts.push(t / timescale);
          num++;
          t += Number(entry.d) || 0;
        }
      });
      return { urls: out, durations: durs, starts: starts };
    }
    var segDur = Number(tpl.duration) && Number(tpl.timescale)
      ? Number(tpl.duration) / Number(tpl.timescale) : 0;
    if (segDur > 0 && durationSec > 0) {
      var count2 = Math.min(2000, Math.ceil(durationSec / segDur));
      for (var n = 0; n < count2; n++) {
        out.push(fill(media, start + n, Math.round(n * Number(tpl.duration))));
        durs.push(segDur);
        starts.push(n * segDur);
      }
      return { urls: out, durations: durs, starts: starts };
    }
    // Unknown length: emit the first segment only; caller transcribes
    // what it can get rather than failing outright.
    out.push(fill(media, start, 0));
    durs.push(segDur || 0);
    starts.push(0);
    return { urls: out, durations: durs, starts: starts };
  }

  function parseSegmentTemplate(block, inherited) {
    var tpl = {
      media: '', initialization: '', timescale: 1, duration: 0,
      startNumber: 1, timeline: null
    };
    if (inherited) {
      Object.keys(inherited).forEach(function (k) { tpl[k] = inherited[k]; });
    }
    var m = /<SegmentTemplate\b([^>]*)>/i.exec(block);
    if (m) {
      var tag = m[1];
      tpl.media = attrOf(tag, 'media') || tpl.media;
      tpl.initialization = attrOf(tag, 'initialization') || tpl.initialization;
      tpl.timescale = Number(attrOf(tag, 'timescale')) || tpl.timescale || 1;
      tpl.duration = Number(attrOf(tag, 'duration')) || tpl.duration || 0;
      tpl.startNumber = Number(attrOf(tag, 'startNumber')) || tpl.startNumber || 1;
    }
    var tl = /<SegmentTimeline>([\s\S]*?)<\/SegmentTimeline>/i.exec(block);
    if (tl) {
      var entries = [];
      var re = /<S\b([^>]*?)\/?>/gi;
      var sm;
      while ((sm = re.exec(tl[1]))) {
        entries.push({
          t: attrOf(sm[1], 't') !== '' ? Number(attrOf(sm[1], 't')) : null,
          d: Number(attrOf(sm[1], 'd')) || 0,
          r: Number(attrOf(sm[1], 'r')) || 0
        });
      }
      if (entries.length) tpl.timeline = entries;
    }
    return tpl;
  }

  /** Pick the audio AdaptationSet's first Representation and expand its
   * segments. Returns { init, segments, lang, mimeType, bandwidth } or
   * null when the manifest has no separate audio adaptation. */
  function parseDashAudio(text, baseUrl) {
    var xml = String(text || '');
    if (xml.indexOf('<MPD') === -1) return null;
    var durM = /mediaPresentationDuration\s*=\s*"PT(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?"/i.exec(xml);
    var durationSec = durM ? ((Number(durM[1]) || 0) * 3600 + (Number(durM[2]) || 0) * 60 + (Number(durM[3]) || 0)) : 0;
    // MPD-level BaseURL applies to everything below it.
    var mpdBase = baseUrl;
    var baseM = /<BaseURL>([^<]+)<\/BaseURL>/i.exec(xml);
    if (baseM) mpdBase = resolveUrl(baseUrl, baseM[1].trim());

    var sets = [];
    var setRe = /<AdaptationSet\b([^>]*)>([\s\S]*?)<\/AdaptationSet>/gi;
    var sm2;
    while ((sm2 = setRe.exec(xml))) sets.push({ tag: sm2[1], body: sm2[2] });
    if (!sets.length) {
      // Self-closing / single-representation manifests.
      var single = /<AdaptationSet\b([^>]*)\/>/i.exec(xml);
      if (single) sets.push({ tag: single[1], body: '' });
    }
    var mpdTpl = parseSegmentTemplate(xml.split(/<Period/i)[0] || '', null);

    for (var i = 0; i < sets.length; i++) {
      var set = sets[i];
      var mime = attrOf(set.tag, 'mimeType');
      var contentType = attrOf(set.tag, 'contentType');
      var isAudio = /^audio\//i.test(mime) || /^audio$/i.test(contentType) ||
        /<Representation[^>]*\bmimeType\s*=\s*"audio\//i.test(set.body) ||
        /<Representation[^>]*\bcodecs\s*=\s*"(mp4a|opus|vorbis|ec-3|ac-3)/i.test(set.body);
      if (!isAudio) continue;
      var setBase = mpdBase;
      var setBaseM = /<BaseURL>([^<]+)<\/BaseURL>/i.exec(set.body);
      if (setBaseM) setBase = resolveUrl(mpdBase, setBaseM[1].trim());
      var setTpl = parseSegmentTemplate(set.body, mpdTpl);
      var repM = /<Representation\b([^>]*)>/i.exec(set.body);
      if (!repM) continue;
      var repTag = repM[1];
      var repId = attrOf(repTag, 'id');
      var bandwidth = Number(attrOf(repTag, 'bandwidth')) || 0;
      var repMime = attrOf(repTag, 'mimeType') || mime || 'audio/mp4';
      var rep = { tag: repTag, body: set.body };
      void rep;
      var repTpl = parseSegmentTemplate(set.body.slice(set.body.indexOf(repM[0])), setTpl);
      // SegmentBase (single-file) audio: the whole media is one URL.
      var segBaseInit = /<SegmentBase[^>]*>[\s\S]*?<Initialization[^>]*\bsourceURL\s*=\s*"([^"]+)"/i.exec(set.body);
      var repBaseM = /<BaseURL>([^<]+)<\/BaseURL>/i.exec(set.body.slice(set.body.indexOf(repM[0])));
      var repBase = repBaseM ? resolveUrl(setBase, repBaseM[1].trim()) : setBase;
      if (segBaseInit) {
        return {
          init: null, segments: [resolveUrl(repBase, segBaseInit[1])],
          segmentDurations: [durationSec || 0], segmentStarts: [0],
          durationSec: durationSec || 0,
          lang: attrOf(set.tag, 'lang') || '', mimeType: repMime, bandwidth: bandwidth, singleFile: true
        };
      }
      var init = null;
      if (repTpl.initialization) {
        init = resolveUrl(repBase, String(repTpl.initialization)
          .replace(/\$RepresentationID\$/g, repId || '')
          .replace(/\$Bandwidth\$/g, String(bandwidth || 0)));
      }
      var expanded = expandDashSegments(repTpl, repBase, repId, bandwidth, durationSec);
      if (!expanded.urls.length) continue;
      return {
        init: init, segments: expanded.urls,
        segmentDurations: expanded.durations, segmentStarts: expanded.starts,
        durationSec: durationSec || 0,
        lang: attrOf(set.tag, 'lang') || '', mimeType: repMime, bandwidth: bandwidth
      };
    }
    return null;
  }

  global.GraphiteManifests = {
    resolveUrl: resolveUrl,
    isHls: isHls,
    looksLikeHlsUrl: looksLikeHlsUrl,
    looksLikeDashUrl: looksLikeDashUrl,
    parseHlsMaster: parseHlsMaster,
    parseHlsMedia: parseHlsMedia,
    parseDashAudio: parseDashAudio
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
