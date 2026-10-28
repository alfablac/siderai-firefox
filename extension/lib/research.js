'use strict';
/**
 * Graphite Research — academic source search helpers.
 * Loaded as a classic script in background page / sidebar.
 * Attaches `GraphiteResearch` to globalThis.
 *
 * Pure functions only: URL builders, response parsers (OpenAlex,
 * Crossref, arXiv Atom XML, Semantic Scholar), dedupe and the report
 * prompt builder. Callers fetch the URLs themselves (fetch injected
 * there), so this file runs unchanged in Node tests — arXiv parsing
 * deliberately uses regex/string ops only, never DOMParser.
 */
(function (global) {

  var SOURCES = [
    { id: 'openalex', label: 'OpenAlex (academic)' },
    { id: 'crossref', label: 'Crossref (academic)' },
    { id: 'arxiv', label: 'arXiv (preprints)' },
    { id: 'semanticscholar', label: 'Semantic Scholar' }
  ];

  function clampLimit(limit) {
    var n = parseInt(limit, 10);
    if (!isFinite(n) || n <= 0) return 10;
    return Math.min(n, 100);
  }

  function buildSourceUrl(sourceId, query, limit) {
    var q = encodeURIComponent(String(query || '').trim());
    var n = clampLimit(limit);
    if (sourceId === 'openalex') {
      return 'https://api.openalex.org/works?search=' + q + '&per-page=' + n +
        '&select=id,title,publication_year,authorships,primary_location,open_access,abstract_inverted_index,doi,cited_by_count';
    }
    if (sourceId === 'crossref') {
      return 'https://api.crossref.org/works?query=' + q + '&rows=' + n +
        '&select=title,author,published,container-title,URL,DOI,abstract';
    }
    if (sourceId === 'arxiv') {
      return 'https://export.arxiv.org/api/query?search_query=all:' + q +
        '&start=0&max_results=' + n;
    }
    if (sourceId === 'semanticscholar') {
      return 'https://api.semanticscholar.org/graph/v1/paper/search?query=' + q +
        '&limit=' + n + '&fields=title,abstract,authors,year,externalIds,url,openAccessPdf,venue';
    }
    return '';
  }

  function decodeEntities(str) {
    return String(str || '')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
      .replace(/&#(\d+);/g, function (_, num) { return String.fromCharCode(parseInt(num, 10)); })
      .replace(/&#x([0-9a-fA-F]+);/g, function (_, num) { return String.fromCharCode(parseInt(num, 16)); })
      .replace(/&amp;/g, '&');
  }

  function cleanText(str) {
    return decodeEntities(String(str || '').replace(/<[^>]+>/g, ' '))
      .replace(/\s+/g, ' ').trim();
  }

  function truncate(str, max) {
    var s = String(str || '');
    return s.length > max ? s.slice(0, max) : s;
  }

  /** Authors string: at most 4 names, then "et al." when there were more. */
  function formatAuthors(names) {
    var clean = [];
    (names || []).forEach(function (name) {
      var n = cleanText(name);
      if (n) clean.push(n);
    });
    if (!clean.length) return '';
    var shown = clean.slice(0, 4).join(', ');
    return clean.length > 4 ? shown + ' et al.' : shown;
  }

  function normalizeDoi(doi) {
    return String(doi || '').trim().toLowerCase()
      .replace(/^https?:\/\/(dx\.)?doi\.org\//, '')
      .replace(/^doi:\s*/, '');
  }

  function normalizeTitle(title) {
    return String(title || '').toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
  }

  /** OpenAlex stores abstracts as { word: [positions] }; rebuild the text. */
  function reconstructAbstract(index) {
    if (!index || typeof index !== 'object') return '';
    var words = [];
    Object.keys(index).forEach(function (word) {
      var positions = index[word];
      if (!Array.isArray(positions)) return;
      positions.forEach(function (pos) {
        if (typeof pos === 'number' && pos >= 0) words[pos] = word;
      });
    });
    return words.filter(function (w) { return !!w; }).join(' ');
  }

  function parseOpenAlex(json) {
    var items = json && Array.isArray(json.results) ? json.results : [];
    var out = [];
    items.forEach(function (item) {
      if (!item) return;
      var title = cleanText(item.title || item.display_name || '');
      if (!title) return;
      var names = (item.authorships || []).map(function (a) {
        return a && a.author ? a.author.display_name : '';
      });
      var loc = item.primary_location || {};
      var venue = loc.source ? cleanText(loc.source.display_name || '') : '';
      var doi = normalizeDoi(item.doi || '');
      out.push({
        title: title,
        authors: formatAuthors(names),
        year: item.publication_year || null,
        venue: venue,
        url: loc.landing_page_url || item.id || (doi ? 'https://doi.org/' + doi : ''),
        pdfUrl: loc.pdf_url || (item.open_access && item.open_access.oa_url) || '',
        doi: doi,
        abstract: truncate(cleanText(reconstructAbstract(item.abstract_inverted_index)), 1200),
        source: 'openalex'
      });
    });
    return out;
  }

  function crossrefYear(item) {
    var fields = ['published', 'issued', 'published-print', 'published-online', 'created'];
    for (var i = 0; i < fields.length; i++) {
      var d = item[fields[i]];
      var parts = d && d['date-parts'] && d['date-parts'][0];
      if (parts && parts[0]) return Number(parts[0]) || null;
    }
    return null;
  }

  function parseCrossref(json) {
    var items = json && json.message && Array.isArray(json.message.items) ? json.message.items : [];
    var out = [];
    items.forEach(function (item) {
      if (!item) return;
      var title = cleanText(Array.isArray(item.title) ? (item.title[0] || '') : (item.title || ''));
      if (!title) return;
      var names = (item.author || []).map(function (a) {
        if (!a) return '';
        return a.name || ((a.given || '') + ' ' + (a.family || ''));
      });
      var pdfUrl = '';
      if (Array.isArray(item.link)) {
        item.link.forEach(function (l) {
          if (!pdfUrl && l && l.URL && /pdf/i.test(l['content-type'] || '')) pdfUrl = l.URL;
        });
      }
      out.push({
        title: title,
        authors: formatAuthors(names),
        year: crossrefYear(item),
        venue: cleanText(Array.isArray(item['container-title']) ? (item['container-title'][0] || '') : ''),
        url: item.URL || '',
        pdfUrl: pdfUrl,
        doi: normalizeDoi(item.DOI || ''),
        abstract: truncate(cleanText(item.abstract || ''), 1200),
        source: 'crossref'
      });
    });
    return out;
  }

  function parseSemanticScholar(json) {
    var items = json && Array.isArray(json.data) ? json.data : [];
    var out = [];
    items.forEach(function (item) {
      if (!item) return;
      var title = cleanText(item.title || '');
      if (!title) return;
      var names = (item.authors || []).map(function (a) { return a ? a.name : ''; });
      out.push({
        title: title,
        authors: formatAuthors(names),
        year: item.year || null,
        venue: cleanText(item.venue || ''),
        url: item.url || '',
        pdfUrl: (item.openAccessPdf && item.openAccessPdf.url) || '',
        doi: normalizeDoi(item.externalIds && item.externalIds.DOI || ''),
        abstract: truncate(cleanText(item.abstract || ''), 1200),
        source: 'semanticscholar'
      });
    });
    return out;
  }

  function extractTag(block, tag) {
    var m = new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + tag + '>').exec(block);
    return m ? m[1] : '';
  }

  /** Parse an arXiv Atom feed with regex/string ops only (no DOMParser). */
  function parseArxiv(xmlText) {
    if (!xmlText || typeof xmlText !== 'string') return [];
    var out = [];
    var entryRe = /<entry>([\s\S]*?)<\/entry>/g;
    var entry;
    while ((entry = entryRe.exec(xmlText)) !== null) {
      var block = entry[1];
      var title = cleanText(extractTag(block, 'title'));
      if (!title) continue;
      var published = cleanText(extractTag(block, 'published'));
      var year = published ? (parseInt(published.slice(0, 4), 10) || null) : null;
      var names = [];
      var authorRe = /<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/g;
      var author;
      while ((author = authorRe.exec(block)) !== null) names.push(cleanText(author[1]));
      var pdfUrl = '';
      var linkRe = /<link\b[^>]*>/g;
      var link;
      while ((link = linkRe.exec(block)) !== null) {
        var tag = link[0];
        if (!/title\s*=\s*["']pdf["']/.test(tag)) continue;
        var href = /href\s*=\s*["']([^"']*)["']/.exec(tag);
        if (href) { pdfUrl = decodeEntities(href[1]); break; }
      }
      var doiMatch = /<[^>]*:?doi[^>]*>([\s\S]*?)<\/[^>]*>/i.exec(block);
      out.push({
        title: title,
        authors: formatAuthors(names),
        year: year,
        venue: 'arXiv',
        url: cleanText(extractTag(block, 'id')),
        pdfUrl: pdfUrl,
        doi: normalizeDoi(doiMatch ? cleanText(doiMatch[1]) : ''),
        abstract: truncate(cleanText(extractTag(block, 'summary')), 1200),
        source: 'arxiv'
      });
    }
    return out;
  }

  /** Dedupe by DOI (when present) and by normalized title. First wins. */
  function dedupeSources(list) {
    var seenDoi = {};
    var seenTitle = {};
    var out = [];
    (list || []).forEach(function (s) {
      if (!s) return;
      var doi = normalizeDoi(s.doi || '');
      var title = normalizeTitle(s.title || '');
      if (doi && seenDoi[doi]) return;
      if (title && seenTitle[title]) return;
      if (doi) seenDoi[doi] = true;
      if (title) seenTitle[title] = true;
      out.push(s);
    });
    return out;
  }

  function buildResearchPrompt(query, sources, opts) {
    var depth = opts && opts.depth ? String(opts.depth) : 'standard';
    var list = Array.isArray(sources) ? sources : [];
    var lines = [];
    lines.push('You are a research analyst. Write a structured Markdown report answering the research question below, based ONLY on the numbered sources provided.');
    lines.push('');
    lines.push('Research question: ' + String(query || '').trim());
    lines.push('Depth: ' + depth + (depth === 'deep'
      ? ' — be thorough: cover each theme in depth, compare sources, and note disagreements.'
      : (depth === 'quick' ? ' — be concise: prioritise the strongest findings.' : ' — balance breadth and detail.')));
    lines.push('');
    lines.push('Rules:');
    lines.push('- Cite sources inline as [n], matching the numbered source list below (e.g. [1], [3]). Every factual claim must carry at least one citation.');
    lines.push('- Never invent citations, sources, numbers, results, or quotations. Only use information present in the sources below.');
    lines.push('- If the evidence is thin, sparse, or contradictory, say so explicitly instead of filling gaps.');
    lines.push('- Do not cite a source for claims its abstract does not support.');
    lines.push('');
    lines.push('Report structure (use exactly these Markdown headings):');
    lines.push('## Executive summary');
    lines.push('## Key findings');
    lines.push('## Detailed analysis by theme');
    lines.push('## Limitations & open questions');
    lines.push('## Sources');
    lines.push('In the Sources section, list every source you cited as: [n] Title — Authors (Year), Venue. URL');
    lines.push('');
    if (!list.length) {
      lines.push('Sources: none were retrieved. State plainly in the report that no sources are available and that the evidence is insufficient to answer the question; do not invent an answer.');
      return lines.join('\n');
    }
    lines.push('Sources:');
    list.forEach(function (s, i) {
      var n = i + 1;
      var head = '[' + n + '] ' + cleanText(s.title || 'Untitled');
      var meta = [];
      if (s.authors) meta.push(s.authors);
      if (s.year) meta.push(String(s.year));
      if (s.venue) meta.push(s.venue);
      if (meta.length) head += ' — ' + meta.join(', ');
      lines.push(head);
      if (s.url) lines.push('URL: ' + s.url);
      if (s.doi) lines.push('DOI: ' + s.doi);
      if (s.abstract) lines.push('Abstract: ' + truncate(cleanText(s.abstract), 600));
      lines.push('');
    });
    return lines.join('\n').trim();
  }

  global.GraphiteResearch = {
    SOURCES: SOURCES,
    buildSourceUrl: buildSourceUrl,
    parseOpenAlex: parseOpenAlex,
    parseCrossref: parseCrossref,
    parseArxiv: parseArxiv,
    parseSemanticScholar: parseSemanticScholar,
    dedupeSources: dedupeSources,
    buildResearchPrompt: buildResearchPrompt
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
