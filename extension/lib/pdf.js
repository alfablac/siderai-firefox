'use strict';
/**
 * Graphite PDF — best-effort PDF text extraction.
 * Preference order:
 *  1. globalThis.pdfjsLib if the host page bundles PDF.js (we never load a CDN).
 *  2. Minimal built-in extractor: scans for stream…endstream blocks, inflates
 *     FlateDecode streams with DecompressionStream('deflate'), then pulls text
 *     from Tj / TJ operators in content streams.
 * Limitations of (2): no font/ToUnicode CMap decoding, so custom-encoded fonts
 * may yield garbled text; scanned/image PDFs yield nothing (use OCR instead);
 * object streams (PDF 1.5+ cross-reference streams) are not expanded.
 */
(function (global) {

  var latin1Decoder = null;
  function bytesToLatin1(bytes) {
    if (typeof TextDecoder !== 'undefined') {
      try {
        latin1Decoder = latin1Decoder || new TextDecoder('latin1');
        return latin1Decoder.decode(bytes);
      } catch (e) { /* fall through */ }
    }
    var s = '';
    var CHUNK = 8192;
    for (var i = 0; i < bytes.length; i += CHUNK) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return s;
  }

  async function inflate(bytes) {
    if (typeof DecompressionStream !== 'undefined') {
      // PDF FlateDecode is zlib-wrapped: 'deflate' matches; raw fallback covers odd files.
      for (var fmt of ['deflate', 'deflate-raw']) {
        try {
          var ds = new DecompressionStream(fmt);
          var stream = new Blob([bytes]).stream().pipeThrough(ds);
          var buf = await new Response(stream).arrayBuffer();
          return new Uint8Array(buf);
        } catch (e) { /* try next format */ }
      }
    }
    return null;
  }

  /** Extract literal (…) and hex <…> string operands near Tj/TJ — core of extractor (2). */
  function extractShownText(content) {
    var out = [];
    var i = 0;
    var n = content.length;
    function parseLiteral(start) {
      // start points at '('
      var depth = 1;
      var s = '';
      var j = start + 1;
      while (j < n && depth > 0) {
        var c = content[j];
        if (c === '\\') {
          var next = content[j + 1];
          if (next === 'n') s += '\n';
          else if (next === 'r') s += '\r';
          else if (next === 't') s += '\t';
          else if (next === '(' || next === ')' || next === '\\') s += next;
          else if (/[0-7]/.test(next || '')) {
            var oct = next;
            var k = j + 2;
            while (k < n && k < j + 4 && /[0-7]/.test(content[k])) { oct += content[k]; k++; }
            s += String.fromCharCode(parseInt(oct, 8));
            j = k - 1;
          } else if (next === '\n' || next === '\r') { /* line continuation */ }
          else if (next) s += next;
          j += 2;
          continue;
        }
        if (c === '(') { depth++; s += c; j++; continue; }
        if (c === ')') { depth--; if (depth > 0) s += c; j++; continue; }
        s += c;
        j++;
      }
      return { text: s, end: j };
    }
    function parseHex(start) {
      // start points at '<' (not '<<')
      var end = content.indexOf('>', start);
      if (end < 0) return { text: '', end: n };
      var hex = content.slice(start + 1, end).replace(/\s+/g, '');
      if (hex.length % 2) hex += '0';
      var s = '';
      // Heuristic: UTF-16BE (FEFF marker or many NUL high bytes) → decode pairs.
      var isUtf16 = /^FEFF/i.test(hex) || /^00[0-9A-F]{2}00/.test(hex.toUpperCase());
      if (isUtf16) {
        if (/^FEFF/i.test(hex)) hex = hex.slice(4);
        for (var k = 0; k + 4 <= hex.length; k += 4) s += String.fromCharCode(parseInt(hex.substr(k, 4), 16));
      } else {
        for (var q = 0; q + 2 <= hex.length; q += 2) s += String.fromCharCode(parseInt(hex.substr(q, 2), 16));
      }
      return { text: s, end: end + 1 };
    }

    while (i < n) {
      var ch = content[i];
      if (ch === '(') {
        var lit = parseLiteral(i);
        // Only keep strings actually shown: window after string contains Tj/TJ/'/"
        var tail = content.slice(lit.end, lit.end + 400);
        if (/^\s*(\]|Tj|TJ|'|")/.test(tail) || /^\s*[-\d.\s]+\]/.test(tail)) out.push(lit.text);
        i = lit.end;
        continue;
      }
      if (ch === '<' && content[i + 1] !== '<') {
        var hexRes = parseHex(i);
        var tail2 = content.slice(hexRes.end, hexRes.end + 400);
        if (/^\s*(\]|Tj|TJ|'|")/.test(tail2) || /^\s*[-\d.\s]+\]/.test(tail2)) out.push(hexRes.text);
        i = Math.max(hexRes.end, i + 1);
        continue;
      }
      i++;
    }
    return out;
  }

  function cleanText(t) {
    return String(t || '')
      .replace(/\r\n?/g, '\n')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
  }

  /** Extractor (2): scan raw bytes for stream blocks. */
  async function extractBuiltin(arrayBuffer) {
    var bytes = new Uint8Array(arrayBuffer);
    var raw = bytesToLatin1(bytes);
    var pieces = [];
    var re = /stream\r?\n/g;
    var m;
    while ((m = re.exec(raw)) !== null) {
      var start = m.index + m[0].length;
      var end = raw.indexOf('endstream', start);
      if (end < 0) break;
      // Dictionary precedes the stream keyword: check for FlateDecode / Filter.
      var dictStart = Math.max(raw.lastIndexOf('<<', m.index), raw.lastIndexOf('/', m.index) === -1 ? 0 : 0);
      var header = raw.slice(Math.max(0, m.index - 400), m.index);
      void dictStart;
      var isFlate = /FlateDecode/.test(header);
      var isImage = /\/Image|DCTDecode|JPXDecode|CCITTFax/.test(header);
      var streamBytes = bytes.subarray(start, end);
      // Trim trailing EOL that belongs to the delimiter, not the data.
      // (Flate streams tolerate trailing bytes poorly — try exact, then trimmed.)
      var candidates = [streamBytes];
      if (streamBytes.length > 2) candidates.push(streamBytes.subarray(0, streamBytes.length - 1));
      var content = null;
      if (isFlate && !isImage) {
        for (var c of candidates) {
          var inflated = await inflate(c);
          if (inflated) { content = bytesToLatin1(inflated); break; }
        }
      } else if (!isFlate && !isImage && /\/Type\s*\/ObjStm/.test(header) === false) {
        // Uncompressed content stream: use only if it looks like a content stream.
        var asText = bytesToLatin1(streamBytes);
        if (/\bTj\b|\bTJ\b|BT/.test(asText)) content = asText;
      }
      if (content && /\bTj\b|\bTJ\b/.test(content)) {
        var texts = extractShownText(content);
        if (texts.length) pieces.push(texts.join(' '));
      }
      re.lastIndex = end + 9;
    }
    return cleanText(pieces.join('\n'));
  }

  /** Extractor (1): PDF.js, only if already present globally. Never loads a CDN. */
  async function extractViaPdfJs(arrayBuffer) {
    var lib = global.pdfjsLib;
    if (!lib || typeof lib.getDocument !== 'function') return null;
    var pdf = await lib.getDocument({ data: new Uint8Array(arrayBuffer) }).promise;
    var pages = [];
    for (var p = 1; p <= pdf.numPages; p++) {
      var page = await pdf.getPage(p);
      var tc = await page.getTextContent();
      var line = (tc.items || []).map(function (it) { return it.str || ''; }).join(' ');
      pages.push(line);
      if (typeof page.cleanup === 'function') page.cleanup();
    }
    if (typeof pdf.destroy === 'function') await pdf.destroy();
    return cleanText(pages.join('\n\n'));
  }

  /**
   * Extract text from a PDF ArrayBuffer (best effort; see header limitations).
   * @returns {Promise<{text:string, method:'pdfjs'|'builtin', chars:number}>}
   */
  async function extractTextFromPDF(arrayBuffer) {
    if (!arrayBuffer) throw new Error('extractTextFromPDF: arrayBuffer required');
    var viaLib = null;
    try { viaLib = await extractViaPdfJs(arrayBuffer); } catch (e) { viaLib = null; }
    if (viaLib) return { text: viaLib, method: 'pdfjs', chars: viaLib.length };
    var builtin = await extractBuiltin(arrayBuffer);
    return { text: builtin, method: 'builtin', chars: builtin.length };
  }

  /** Split text into overlapping chunks for map-reduce summarization. */
  function chunkText(text, size, overlap) {
    size = size || 6000;
    overlap = typeof overlap === 'number' ? overlap : 300;
    if (overlap >= size) overlap = Math.floor(size / 5);
    var t = String(text || '');
    if (t.length <= size) return t ? [t] : [];
    var chunks = [];
    var i = 0;
    while (i < t.length) {
      var end = Math.min(i + size, t.length);
      if (end < t.length) {
        // Prefer a paragraph / sentence boundary in the last 20% of the window.
        var windowText = t.slice(i, end);
        var cut = Math.max(windowText.lastIndexOf('\n\n'), windowText.lastIndexOf('. '), windowText.lastIndexOf('\n'));
        if (cut > size * 0.6) end = i + cut + 1;
      }
      chunks.push(t.slice(i, end).trim());
      if (end >= t.length) break;
      i = Math.max(end - overlap, i + 1);
    }
    return chunks.filter(Boolean);
  }

  global.GraphitePDF = {
    extractTextFromPDF: extractTextFromPDF,
    extractViaPdfJs: extractViaPdfJs,
    chunkText: chunkText,
    _extractShownText: extractShownText,
    _cleanText: cleanText
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
