'use strict';
/* GraphiteMarkdown - minimal, safe markdown renderer.
   Escapes all HTML first; only emits tags it generates itself. */
(function (global) {
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function safeUrl(url) {
    var u = String(url || '').trim();
    if (/^(https?:|mailto:)/i.test(u)) return u;
    if (/^#/.test(u) || /^\//.test(u) || /^\./.test(u)) return u;
    return '#';
  }

  var TIMESTAMP_RANGE_SRC = '(\\d{1,2}:[0-5]\\d(?::[0-5]\\d)?)(\\s*(?:-|–|—|to)\\s*)(\\d{1,2}:[0-5]\\d(?::[0-5]\\d)?)';
  var TIMESTAMP_SINGLE_SRC = '(\\d{1,2}:[0-5]\\d(?::[0-5]\\d)?)';

  function parseTimestampSeconds(raw) {
    if (raw == null) return null;
    if (typeof raw === 'number') return (isFinite(raw) && raw >= 0) ? Math.floor(raw) : null;
    var s = String(raw).trim();
    if (!s) return null;
    if (/^\d+$/.test(s)) return parseInt(s, 10); // bare integer seconds (data-seek-seconds round-trip)
    if (/^\[part\s+\d+\]$/i.test(s)) return null; // [Part N] is never a time
    var m = s.match(/^(?:\((\d{1,2}):([0-5]\d)(?::([0-5]\d))?\)|\[(\d{1,2}):([0-5]\d)(?::([0-5]\d))?\]|(\d{1,2}):([0-5]\d)(?::([0-5]\d))?)$/);
    if (!m) return null;
    var a = (m[1] != null) ? [m[1], m[2], m[3]] : (m[4] != null ? [m[4], m[5], m[6]] : [m[7], m[8], m[9]]);
    if (a[2] != null) return parseInt(a[0], 10) * 3600 + parseInt(a[1], 10) * 60 + parseInt(a[2], 10);
    return parseInt(a[0], 10) * 60 + parseInt(a[1], 10);
  }

  function formatTimestampLabel(totalSeconds) {
    var total = Math.max(0, Math.floor(Number(totalSeconds) || 0));
    var h = Math.floor(total / 3600);
    var m = Math.floor((total % 3600) / 60);
    var s = total % 60;
    var mm = h > 0 ? String(m).padStart(2, '0') : String(m);
    return (h > 0 ? h + ':' : '') + mm + ':' + String(s).padStart(2, '0');
  }

  var renderOpts = {};
  var hrefForSeek = null;

  function seekButton(label, seconds, opts) {
    opts = opts || renderOpts;
    var href = hrefForSeek ? hrefForSeek(seconds, opts) : null;
    var extra = href ? ' href="' + href + '" target="_blank" rel="noopener noreferrer"' : '';
    var tag = href ? 'a' : 'button';
    var type = href ? '' : ' type="button"';
    return '<' + tag + type + ' class="gs-yt-ts" data-seek-seconds="' + seconds + '"' + extra + ' title="Jump to ' + label + '">' + label + '</' + tag + '>';
  }

  /* Linkify timestamps in an ESCAPED html string (ranges seek to their start). */
  function linkifyTimestamps(html, opts) {
    opts = opts || renderOpts;
    function transformSegment(seg) {
      var rangeRe = new RegExp(TIMESTAMP_RANGE_SRC, 'g');
      var singleRe = new RegExp(TIMESTAMP_SINGLE_SRC, 'g');
      var matches = [];
      var m;
      while ((m = rangeRe.exec(seg)) !== null) {
        var a = parseTimestampSeconds(m[1]);
        var b = parseTimestampSeconds(m[3]);
        if (a != null && b != null && b >= a) matches.push({ index: m.index, len: m[0].length, label: m[1] + m[2] + m[3], seconds: a });
      }
      while ((m = singleRe.exec(seg)) !== null) {
        var sec = parseTimestampSeconds(m[1]);
        if (sec == null) continue;
        var inside = matches.some(function (x) { return m.index >= x.index && m.index < x.index + x.len; });
        if (!inside) matches.push({ index: m.index, len: m[0].length, label: m[1], seconds: sec });
      }
      matches.sort(function (x, y) { return x.index - y.index; });
      var out = '';
      var last = 0;
      matches.forEach(function (x) {
        if (x.index < last) return;
        out += seg.slice(last, x.index) + seekButton(x.label, x.seconds, opts);
        last = x.index + x.len;
      });
      return out + seg.slice(last);
    }
    var s = String(html == null ? '' : html);
    // Keep code/pre/a/button content and tag attributes byte-identical.
    var protectedRe = /(<(?:pre|code|a|button|script|style)\b[\s\S]*?<\/(?:pre|code|a|button|script|style)>)|(<[^>]+>)/gi;
    var parts = s.split(protectedRe);
    for (var i = 0; i < parts.length; i++) {
      var part = parts[i];
      if (part == null || part === '' || part.charAt(0) === '<') continue;
      parts[i] = transformSegment(part);
    }
    return parts.join('');
  }

  function extractTimestamps(text) {
    var s = String(text == null ? '' : text);
    var rangeRe = new RegExp(TIMESTAMP_RANGE_SRC, 'g');
    var singleRe = new RegExp(TIMESTAMP_SINGLE_SRC, 'g');
    var covered = [];
    var found = [];
    var seen = {};
    var m;
    while ((m = rangeRe.exec(s)) !== null) {
      var a = parseTimestampSeconds(m[1]);
      var b = parseTimestampSeconds(m[3]);
      if (a == null || b == null || b < a) continue;
      covered.push([m.index, m.index + m[0].length]);
      var label = m[0].replace(/\s+/g, ' ').trim();
      if (!seen[label + '@' + a]) { seen[label + '@' + a] = true; found.push({ label: label, seconds: a, endSeconds: b }); }
    }
    while ((m = singleRe.exec(s)) !== null) {
      var inside = covered.some(function (c) { return m.index >= c[0] && m.index < c[1]; });
      if (inside) continue;
      var sec = parseTimestampSeconds(m[1]);
      if (sec != null && !seen[m[1] + '@' + sec]) { seen[m[1] + '@' + sec] = true; found.push({ label: m[1], seconds: sec }); }
    }
    return found.sort(function (x, y) { return x.seconds - y.seconds; });
  }

  function renderInline(escaped) {
    var startedCode = [];
    var out = escaped;
    // inline code (already escaped content); a code span that is ONLY a
    // timestamp/range becomes a seek control (section headings rely on it).
    out = out.replace(/`([^`\n]+)`/g, function (m, c) {
      var label = c.trim();
      // The summary headings emit `[Start - End]` inside the code span; unwrap it.
      var inner = label.replace(/^\[([\s\S]*)\]$/, '$1');
      var range = inner.match(new RegExp('^' + TIMESTAMP_RANGE_SRC + '$'));
      if (range) {
        var a = parseTimestampSeconds(range[1]);
        var b = parseTimestampSeconds(range[3]);
        if (a != null && b != null && b >= a) {
          startedCode.push(seekButton(label, a, renderOpts));
          return '\u0001C' + (startedCode.length - 1) + '\u0002';
        }
      } else if (parseTimestampSeconds(label) != null) {
        startedCode.push(seekButton(label, parseTimestampSeconds(label), renderOpts));
        return '\u0001C' + (startedCode.length - 1) + '\u0002';
      }
      startedCode.push('<code>' + c + '</code>');
      return '\u0001C' + (startedCode.length - 1) + '\u0002';
    });
    // images ![alt](url)
    out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, function (m, alt, url) {
      return '<img alt="' + alt + '" src="' + safeUrl(url.replace(/&amp;/g, '&')) + '">';
    });
    // links [text](url)
    out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (m, text, url) {
      return '<a href="' + safeUrl(url.replace(/&amp;/g, '&')) + '" target="_blank" rel="noopener noreferrer">' + text + '</a>';
    });
    // bold then italic
    out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/__([^_]+)__/g, '<strong>$1</strong>');
    out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    out = out.replace(/(^|[^_])_([^_\n]+)_/g, '$1<em>$2</em>');
    out = out.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    out = linkifyTimestamps(out, renderOpts);
    out = out.replace(/\u0001C(\d+)\u0002/g, function (m, idx) { return startedCode[Number(idx)] || ''; });
    return out;
  }

  function isTableSeparator(line) {
    return /^\s*\|?[\s:|-]+\|?\s*$/.test(line) && line.indexOf('-') !== -1;
  }

  function splitRow(line) {
    var t = line.trim();
    if (t.charAt(0) === '|') t = t.slice(1);
    if (t.charAt(t.length - 1) === '|') t = t.slice(0, -1);
    return t.split('|').map(function (c) { return c.trim(); });
  }

  function render(md, opts) {
    renderOpts = opts || {};
    hrefForSeek = (opts && typeof opts.seekHrefFor === 'function') ? opts.seekHrefFor : null;
    var src = String(md == null ? '' : md);
    // 1. Extract fenced code blocks before escaping/processing.
    var blocks = [];
    src = src.replace(/```([A-Za-z0-9_+-]*)\n?([\s\S]*?)(?:```|$)/g, function (m, lang, code) {
      var idx = blocks.length;
      blocks.push({ lang: (lang || '').toLowerCase(), code: code.replace(/\n$/, '') });
      return '\n\u0001CODE' + idx + '\u0002\n';
    });

    var lines = src.split('\n');
    var html = [];
    var i = 0;
    var listStack = []; // 'ul' | 'ol'

    function closeLists(toDepth) {
      while (listStack.length > (toDepth || 0)) html.push('</' + listStack.pop() + '>');
    }

    while (i < lines.length) {
      var line = lines[i];

      var codeMatch = /^\u0001CODE(\d+)\u0002$/.test(line.trim()) ? line.trim().match(/^\u0001CODE(\d+)\u0002$/) : null;
      if (codeMatch) {
        closeLists(0);
        var b = blocks[Number(codeMatch[1])];
        html.push('<div class="code-wrap"><div class="code-head"><span>' + escapeHtml(b.lang || 'code') + '</span>' +
          '<button type="button" class="mini-btn" data-copy-code="' + Number(codeMatch[1]) + '">Copy</button></div>' +
          '<pre><code data-code-idx="' + Number(codeMatch[1]) + '">' + escapeHtml(b.code) + '</code></pre></div>');
        i++;
        continue;
      }

      if (!line.trim()) { closeLists(0); i++; continue; }

      // Heading
      var h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) {
        closeLists(0);
        var lvl = h[1].length;
        html.push('<h' + lvl + '>' + renderInline(escapeHtml(h[2])) + '</h' + lvl + '>');
        i++;
        continue;
      }

      // Horizontal rule
      if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { closeLists(0); html.push('<hr>'); i++; continue; }

      // Table: header row followed by separator
      if (line.indexOf('|') !== -1 && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
        closeLists(0);
        var head = splitRow(line);
        i += 2;
        var rows = [];
        while (i < lines.length && lines[i].indexOf('|') !== -1 && lines[i].trim()) { rows.push(splitRow(lines[i])); i++; }
        var t = '<div class="table-wrap"><table><thead><tr>';
        head.forEach(function (c) { t += '<th>' + renderInline(escapeHtml(c)) + '</th>'; });
        t += '</tr></thead><tbody>';
        rows.forEach(function (r) {
          t += '<tr>';
          head.forEach(function (_, ci) { t += '<td>' + renderInline(escapeHtml(r[ci] || '')) + '</td>'; });
          t += '</tr>';
        });
        t += '</tbody></table></div>';
        html.push(t);
        continue;
      }

      // Blockquote (collect consecutive)
      if (/^\s*>\s?/.test(line)) {
        closeLists(0);
        var quote = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) { quote.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
        html.push('<blockquote>' + quote.map(function (q) { return renderInline(escapeHtml(q)); }).join('<br>') + '</blockquote>');
        continue;
      }

      // Lists
      var ul = line.match(/^(\s*)[-*+]\s+(.*)$/);
      var ol = line.match(/^(\s*)\d+[.)]\s+(.*)$/);
      if (ul || ol) {
        var indent = Math.floor((ul || ol)[1].replace(/\t/g, '  ').length / 2);
        var type = ul ? 'ul' : 'ol';
        var text = (ul || ol)[2];
        while (listStack.length > indent + 1) html.push('</' + listStack.pop() + '>');
        if (listStack.length < indent + 1) { html.push('<' + type + '>'); listStack.push(type); }
        else if (listStack[listStack.length - 1] !== type) { html.push('</' + listStack.pop() + '>'); html.push('<' + type + '>'); listStack.push(type); }
        var task = text.match(/^\[([ xX])\]\s+(.*)$/);
        if (task) {
          html.push('<li class="task"><input type="checkbox" disabled' + (task[1].toLowerCase() === 'x' ? ' checked' : '') + '> ' + renderInline(escapeHtml(task[2])) + '</li>');
        } else {
          html.push('<li>' + renderInline(escapeHtml(text)) + '</li>');
        }
        i++;
        continue;
      }

      // Paragraph: gather until blank / block starter
      closeLists(0);
      var para = [line];
      i++;
      while (i < lines.length && lines[i].trim() &&
             !/^(#{1,6})\s/.test(lines[i]) && !/^\s*>\s?/.test(lines[i]) &&
             !/^(\s*)[-*+]\s/.test(lines[i]) && !/^(\s*)\d+[.)]\s/.test(lines[i]) &&
             !/^\u0001CODE\d+\u0002$/.test(lines[i].trim()) &&
             !(lines[i].indexOf('|') !== -1 && i + 1 < lines.length && isTableSeparator(lines[i + 1]))) {
        para.push(lines[i]); i++;
      }
      html.push('<p>' + para.map(function (p) { return renderInline(escapeHtml(p)); }).join('<br>') + '</p>');
    }
    closeLists(0);

    render._lastBlocks = blocks;
    return html.join('\n');
  }

  global.GraphiteMarkdown = {
    render: render,
    escapeHtml: escapeHtml,
    parseTimestampSeconds: parseTimestampSeconds,
    formatTimestampLabel: formatTimestampLabel,
    linkifyTimestamps: linkifyTimestamps,
    extractTimestamps: extractTimestamps,
    getLastBlocks: function () { return render._lastBlocks || []; }
  };
})(typeof window !== 'undefined' ? window : this);
