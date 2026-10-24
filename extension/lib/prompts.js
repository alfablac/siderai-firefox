'use strict';
/**
 * Graphite Sider — prompt library.
 * Placeholders: {{text}} {{selection}} {{url}} {{title}} {{lang}} {{transcript}}
 */
(function (global) {

  function P(id, name, icon, category, body) {
    return { id: id, name: name, icon: icon, category: category, body: body, builtin: true };
  }

  /* ---------------- Rewrite tones: single source of truth ----------------
   * Every rewrite surface (sidebar Write tool, selection toolbar, writing
   * assistant, background context menus) must derive its tones from here.
   * Prompt ids are always 'rewrite-' + tone.id, e.g. 'rewrite-formal'.
   * 'rewrite-formal' / 'rewrite-casual' are preserved for backward compat. */
  function T(id, label, instruction, length) {
    return {
      id: id, label: label, name: label, promptId: 'rewrite-' + id,
      instruction: instruction, length: length || 'same'
    };
  }

  var REWRITE_TONES = [
    T('neutral', 'Neutral (default)',
      'clearer and more natural, with a balanced, unmarked voice. Fix awkward phrasing and improve flow without pushing the text formal or casual.', 'same'),
    T('professional', 'Professional',
      'a polished workplace voice: precise, courteous and competent, like a well-written business email or report. Remove slang and filler and keep sentences direct.', 'same'),
    T('formal', 'Formal',
      'an elevated formal register: complete sentences, no contractions or colloquialisms, measured and respectful phrasing suitable for official correspondence.', 'same'),
    T('casual', 'Casual',
      'a relaxed everyday voice: contractions, simple words and a conversational rhythm, as if explaining something to a friend. Natural, not sloppy.', 'same'),
    T('friendly', 'Friendly',
      'a warm, approachable voice: welcoming word choice, inclusive phrasing and a helpful, upbeat cadence without being saccharine.', 'same'),
    T('confident', 'Confident',
      'an assertive, assured voice: strong verbs and declarative sentences, with hedging such as "just", "maybe" and "I think" removed. Certain, never arrogant.', 'same'),
    T('polite', 'Polite',
      'a maximally courteous, considerate voice: soften requests and corrections, acknowledge the reader, and avoid anything blunt or demanding while staying clear.', 'same'),
    T('empathetic', 'Empathetic',
      'an understanding, supportive voice: acknowledge feelings and difficulty first, use gentle, validating language, and present the content in a reassuring way.', 'same'),
    T('witty', 'Witty',
      'a light, clever, playful voice: dry humour and a smart turn of phrase where it lands naturally. Never force jokes and never mock the subject or the reader.', 'same'),
    T('academic', 'Academic',
      'a scholarly register: precise terminology, objective phrasing, qualified claims and structured, analytical sentences. Do not fabricate citations, data or references.', 'same'),
    T('creative', 'Creative',
      'an expressive, vivid voice: fresh imagery, varied sentence rhythm and distinctive word choice, while keeping the original message unmistakable beneath the flair.', 'same'),
    T('persuasive', 'Persuasive',
      'a compelling, convincing voice: lead with benefits, speak to the reader\'s motivations, use concrete benefit-led phrasing, and keep any call to action already implied by the text.', 'same'),
    T('concise', 'Concise',
      'a tight, economical voice: cut redundancy, filler and throat-clearing so every sentence earns its place.', 'shorter'),
    T('expanded', 'Expanded / Elaborate',
      'a more developed, thorough voice: unpack compressed points, add connective explanation and transitions, and add helpful generic examples (mark [example needed] where a specific fact would have to be invented).', 'longer'),
    T('simplify', 'Simplify (plain English)',
      'plain English: short sentences, common everyday words, and no jargon (explain any unavoidable jargon in-line). Aim for the reading level of a smart 12-year-old.', 'same')
  ];

  var DEFAULT_REWRITE_TONE_ID = 'neutral';

  var REWRITE_TONE_ALIASES = {
    'default': 'neutral', 'normal': 'neutral', 'plain': 'simplify',
    'plain-english': 'simplify', 'elaborate': 'expanded', 'expand': 'expanded',
    'longer': 'expanded', 'shorter': 'concise', 'shorten': 'concise',
    'brief': 'concise', 'business': 'professional'
  };

  function normalizeToneId(raw) {
    var id = String(raw == null ? '' : raw).trim().toLowerCase();
    if (id.indexOf('rewrite-') === 0) id = id.slice('rewrite-'.length);
    if (REWRITE_TONE_ALIASES[id]) id = REWRITE_TONE_ALIASES[id];
    return id;
  }

  function getRewriteTone(toneId) {
    var id = normalizeToneId(toneId);
    for (var i = 0; i < REWRITE_TONES.length; i++) {
      if (REWRITE_TONES[i].id === id) return REWRITE_TONES[i];
    }
    return null;
  }

  function rewriteLengthRule(tone) {
    if (tone && tone.length === 'shorter') {
      return 'Shorten it to roughly 50-70% of the original length while keeping every key fact and number.';
    }
    if (tone && tone.length === 'longer') {
      return 'Lengthen it to roughly 130-180% of the original length by developing the existing points only.';
    }
    return 'Keep roughly the same length (within about 20%).';
  }

  function rewriteBody(tone) {
    return 'Rewrite the following text.\n\nTone: ' + tone.label + ' - write in ' + tone.instruction +
      '\n\nRules: preserve the meaning, all facts, names, numbers and intent; do not add new claims; ' +
      rewriteLengthRule(tone) +
      ' Keep the text in its original language unless it asks otherwise. Output only the rewritten text.\n\nText:\n{{text}}';
  }

  function rewritePromptIdForTone(toneId) {
    var tone = getRewriteTone(toneId);
    return 'rewrite-' + (tone ? tone.id : normalizeToneId(toneId) || DEFAULT_REWRITE_TONE_ID);
  }

  /**
   * Render the rewrite prompt for a tone.
   * @param {string|object} toneId  e.g. 'formal', 'rewrite-formal', or a tone object.
   *        'custom' (or an unknown id) uses vars.customTone as the instruction.
   * @param {object} [vars] { text|selection|input, customTone }
   * @returns {string} prompt with the text substituted (no {{text}} left).
   */
  function rewriteTonePrompt(toneId, vars) {
    vars = vars || {};
    var text = vars.text != null ? vars.text : (vars.selection != null ? vars.selection : (vars.input != null ? vars.input : ''));
    var tone = (toneId && typeof toneId === 'object') ? toneId : getRewriteTone(toneId);
    var custom = String(vars.customTone || vars.custom || '').trim();
    if (!tone && custom) {
      return 'Rewrite the following text.\n\nTone: custom - write in a tone described as: ' + custom +
        '\n\nRules: preserve the meaning, all facts, names, numbers and intent; do not add new claims; ' +
        'keep roughly the same length (within about 20%). Output only the rewritten text.\n\nText:\n' + String(text);
    }
    if (!tone) tone = getRewriteTone(DEFAULT_REWRITE_TONE_ID);
    return renderPrompt(rewriteBody(tone), { text: text, selection: text });
  }

  var BUILTIN_PROMPTS = [
    P('summarize-page', 'Summarize page', '▤', 'read',
      'Summarize the following web page in Markdown.\nTitle: {{title}}\nURL: {{url}}\n\nRequirements: start with a one-sentence TL;DR, then 5-8 bullet key points, then any important caveats. Keep it factual and do not invent details.\n\nPage content:\n{{text}}'),
    P('summarize-selection', 'Summarize selection', '¶', 'read',
      'Summarize the selected text below. Give a one-sentence gist, then concise bullet points.\n\nSelection:\n{{selection}}'),
    P('youtube-summary', 'YouTube summary', '▶', 'video',
      'You are an expert transcript analyst and summarizer.\n\nYour task is to create a complete, organized, and easy-to-read summary of the transcript provided below.\n\nCUSTOMIZATION:\n- Audience: General / Professional\n- Length: Detailed but concise\n- Language: Use the same language as the transcript\n- Focus: Main ideas, key arguments, decisions, and important quotes\n\nSTRICT RULES:\n1. Do NOT invent information, names, timestamps, or quotes that are not in the transcript.\n2. If timestamps are provided, preserve them exactly. If not, do not invent them - use [Part 1], [Part 2], etc.\n3. Group the content by THEME / TOPIC, not just chronologically. Merge repeated ideas into one section.\n4. Keep the sections in chronological order as they appear in the transcript.\n5. Write in clear, neutral, and professional language.\n6. Use Markdown tables wherever requested.\n\n---\n\nOUTPUT FORMAT:\n\n**1. OVERVIEW**\n| Item | Details |\n| :--- | :--- |\n| Title / Topic | [Infer a clear title from the transcript] |\n| Type | [e.g., Podcast, Meeting, Lecture, Interview, Webinar] |\n| Speakers | [List all speakers identified] |\n| Total Duration | [First to last timestamp, if available] |\n| Main Subject | [1 sentence] |\n\n**2. EXECUTIVE SUMMARY (TL;DR)**\nWrite a 150-200 word paragraph summarizing the entire transcript.\nThen list the 5-7 most important takeaways in bullet points.\n\n**3. SUMMARY TABLE OF THEMES**\nCreate a quick-reference table first, before the detailed summary:\n\n| # | Timestamp | Theme / Topic | Core Summary (1-2 sentences) | Key Speaker(s) |\n| :--- | :--- | :--- | :--- | :--- |\n| 1 | 00:00 - 05:30 | [Theme Name] | [Summary] | [Name] |\n| 2 | 05:31 - 12:15 | [Theme Name] | [Summary] | [Name] |\n\n**4. DETAILED THEMATIC BREAKDOWN**\nDivide the transcript into 5-10 logical thematic sections. For EACH section, use this exact format:\n\n### [Number]. [Theme Title] `[Start Time - End Time]`\n**Summary:** [3-5 sentence detailed summary of this section]\n\n**Key Points:**\n* [Key point 1]\n* [Key point 2]\n* [Key point 3]\n\n**Important Quote (if any):**\n> "[Exact quote]" — [Speaker], [Timestamp]\n\n**Decisions / Outcomes:** [Mention any conclusion, agreement, or decision made in this section. If none, write "None"]\n\nThe reader UI turns every preserved timestamp into a seek control, so keep section ranges as `[Start Time - End Time]` and single times as `MM:SS` or `H:MM:SS`.\n\n---\n\n**5. FINAL CONSOLIDATED TABLES**\n\n**a) Key Decisions Made**\n| Decision | Context | Timestamp |\n| :--- | :--- | :--- |\n\n**b) Action Items / Next Steps**\n| Task / Action | Assigned To | Deadline Mentioned | Timestamp |\n| :--- | :--- | :--- | :--- |\n\n*If there are no decisions or action items, write "Not mentioned in the transcript."*\n\n**c) Open Questions & Unresolved Topics**\n* [List anything left unanswered]\n\n**6. FINAL TAKEAWAYS**\nList 3-5 concluding insights in bullet points. What should the reader remember most?\n\n---\n\nTRANSCRIPT TO SUMMARIZE:\nTitle: {{title}}\n\n{{transcript}}'),
    P('youtube-chapters', 'YouTube chapters', '☰', 'video',
      'From this timestamped YouTube transcript, produce a chapter list only.\nOutput one line per chapter: `MM:SS — Chapter title` covering the whole video, 4-12 chapters. Use timestamps present in the transcript.\nTitle: {{title}}\n\nTranscript:\n{{transcript}}'),
    P('translate', 'Translate', '訳', 'write',
      'Translate the following text into {{lang}}. Preserve formatting, names and numbers. Output only the translation.\n\nText:\n{{text}}'),
    P('explain', 'Explain', '？', 'read',
      'Explain the following in plain language for a smart non-expert. Define any jargon, use one concrete example, and keep it under 250 words.\n\n{{text}}'),
    P('grammar-fix', 'Fix grammar', '✓', 'write',
      'Correct grammar, spelling and punctuation in the following text. Do not change meaning or tone. Output the corrected text, then a short list of the main corrections.\n\n{{text}}'),
    // One distinct 'write' prompt per rewrite tone ('rewrite-<tone>').
    // Bodies come from the REWRITE_TONES table above; bodies are rendered
    // per-tone below so the prompt library and every UI stay in sync.
    P('shorten', 'Shorten', '–', 'write',
      'Shorten the following text to about half its length. Keep every key fact and number. Output only the shortened text.\n\n{{text}}'),
    P('expand', 'Expand', '~', 'write',
      'Expand the following text with relevant detail, examples and structure. Do not invent specific facts, statistics or citations; mark placeholders like [example needed] where detail is missing.\n\n{{text}}'),
    P('outline', 'Outline', '≣', 'write',
      'Turn the following material into a structured outline (headings and nested bullets) suitable as the skeleton of an article or document.\n\n{{text}}'),
    P('essay-writer', 'Essay writer', '✒', 'write',
      'Write a well-structured essay on the topic below: introduction with a clear thesis, 3 body sections with evidence-style reasoning, and a conclusion. Do not fabricate citations or statistics.\n\nTopic / material:\n{{text}}'),
    P('code-explain', 'Explain code', '</>', 'code',
      'Explain the following code: what it does, how it works step by step, its inputs/outputs, time/space complexity if relevant, and any bugs or edge cases you notice.\n\n```\n{{text}}\n```'),
    P('code-review', 'Review code', '⌕', 'code',
      'Review the following code like a senior engineer. List: correctness issues, security issues, performance issues, and readability suggestions — each with severity (high/medium/low) and a concrete fix. End with a short verdict.\n\n```\n{{text}}\n```'),
    P('ocr-extract', 'OCR / extract text from image', '▣', 'read',
      'Extract all readable text from the attached image exactly as written, preserving line breaks and layout as much as possible. If there is a table, reproduce it as a Markdown table. Do not summarize.'),
    P('pdf-summary', 'Summarize PDF', '▦', 'read',
      'Summarize this document (from a PDF). Give: TL;DR, section-by-section summary, key figures/dates/names, and open questions or limitations mentioned in the document.\nTitle: {{title}}\n\nDocument text:\n{{text}}'),
    P('article-keypoints', 'Key points', '•', 'read',
      'Extract the key points from the following article as a numbered list. Each point: one bold headline sentence followed by one supporting sentence. Include important numbers.\nTitle: {{title}}\nURL: {{url}}\n\n{{text}}'),
    P('email-reply', 'Draft email reply', '✉', 'write',
      'Draft a polite, ready-to-send reply to the email below. Keep it concise, match the sender\'s formality, and leave [brackets] where I must fill in specifics.\n\nEmail:\n{{text}}'),
    P('search-answer', 'Answer with sources', '⌕', 'read',
      'Answer the question using the search results below. Cite sources inline like [1], [2]. If the results disagree, say so. If they do not answer the question, say what is missing.\n\nQuestion: {{text}}\n\nResults:\n{{selection}}'),
    P('mindmap-mermaid', 'Mind map (Mermaid)', '◇', 'write',
      'Create a Mermaid mindmap of the following material. Output only a ```mermaid code block using `mindmap` syntax, with the central topic as root and 3-6 main branches.\n\n{{text}}'),
    P('data-table-extract', 'Extract data table', '▦', 'read',
      'Extract any structured data (figures, dates, comparisons, lists of items with attributes) from the following text into a clean Markdown table. If there is no tabular data, say so briefly.\n\n{{text}}')
  ];

  // Append one builtin 'write' prompt per tone: 'Rewrite: <Label>'.
  REWRITE_TONES.forEach(function (tone) {
    BUILTIN_PROMPTS.push(P(tone.promptId, 'Rewrite: ' + tone.label, '✎', 'write', rewriteBody(tone)));
  });

  /**
   * Replace {{key}} placeholders. Unknown placeholders are left untouched.
   * @param {string} body @param {object} vars
   */
  function renderPrompt(body, vars) {
    vars = vars || {};
    return String(body || '').replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, function (m, key) {
      return Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key] == null ? '' : vars[key]) : m;
    });
  }

  function getBuiltin(id) {
    return BUILTIN_PROMPTS.filter(function (p) { return p.id === id; })[0] || null;
  }

  /** All prompts: builtins merged with user prompts (user wins on id clash). */
  function listPrompts(settings) {
    var user = (settings && settings.prompts) || [];
    var userIds = {};
    user.forEach(function (p) { userIds[p.id] = true; });
    return BUILTIN_PROMPTS.filter(function (p) { return !userIds[p.id]; }).concat(user);
  }

  /**
   * Resolve the EFFECTIVE prompt for an id: the user's prompt when
   * settings.prompts carries a matching id, otherwise the builtin,
   * otherwise null. The user prompt object itself is returned so callers
   * can read its body/name without the builtin decoration.
   */
  function getEffectivePrompt(id, settings) {
    var user = (settings && settings.prompts) || [];
    var match = user.filter(function (p) { return p && p.id === id && p.body; })[0];
    if (match) return match;
    return getBuiltin(id);
  }

  function uid(prefix) {
    return (prefix || 'prompt') + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  /** CRUD helpers: each takes the full settings object, mutates prompts, returns it. */
  function addPrompt(settings, prompt) {
    settings.prompts = settings.prompts || [];
    var p = {
      id: prompt.id || uid('prompt'),
      name: String(prompt.name || 'Untitled prompt'),
      icon: prompt.icon || '✦',
      category: prompt.category || 'custom',
      body: String(prompt.body || ''),
      shortcut: prompt.shortcut || '',
      builtin: false
    };
    settings.prompts.push(p);
    return p;
  }

  function updatePrompt(settings, id, patch) {
    settings.prompts = settings.prompts || [];
    for (var i = 0; i < settings.prompts.length; i++) {
      if (settings.prompts[i].id === id) {
        settings.prompts[i] = Object.assign({}, settings.prompts[i], patch || {}, { id: id });
        return settings.prompts[i];
      }
    }
    return null;
  }

  function removePrompt(settings, id) {
    settings.prompts = settings.prompts || [];
    var before = settings.prompts.length;
    settings.prompts = settings.prompts.filter(function (p) { return p.id !== id; });
    return settings.prompts.length !== before;
  }

  /* Shared timestamp helpers (sidebar renderer, in-page panel, tests). */
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

  var TIMESTAMP_RANGE_SRC = '(\\d{1,2}:[0-5]\\d(?::[0-5]\\d)?)(\\s*(?:-|–|—|to)\\s*)(\\d{1,2}:[0-5]\\d(?::[0-5]\\d)?)';
  var TIMESTAMP_SINGLE_SRC = '(\\d{1,2}:[0-5]\\d(?::[0-5]\\d)?)';

  /**
   * Linkify an ESCAPED HTML string: real timestamps become seek buttons
   * (ranges target their start). Existing <a>/<code> content is untouched.
   */
  function linkifyTimestamps(html, opts) {
    opts = opts || {};
    var cls = opts.className || 'gs-yt-ts';
    var hrefFmt = typeof opts.hrefFor === 'function' ? opts.hrefFor : null;
    function btn(label, seconds) {
      var href = hrefFmt ? hrefFmt(seconds) : null;
      var extra = href ? ' href="' + href + '" target="_blank" rel="noopener noreferrer"' : '';
      var tag = href ? 'a' : 'button';
      var type = href ? '' : ' type="button"';
      return '<' + tag + type + ' class="' + cls + '" data-seek-seconds="' + seconds + '"' + extra + ' title="Jump to ' + label + '">' + label + '</' + tag + '>';
    }
    function transformSegment(seg) {
      var rangeRe = new RegExp(TIMESTAMP_RANGE_SRC, 'g');
      var singleRe = new RegExp(TIMESTAMP_SINGLE_SRC, 'g');
      // Collect every match first (ranges own their span; a single inside a
      // valid range is dropped, an invalid range falls back to singles).
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
        if (x.index < last) return; // overlap guard
        out += seg.slice(last, x.index) + btn(x.label, x.seconds);
        last = x.index + x.len;
      });
      out += seg.slice(last);
      return out;
    }
    var s = String(html == null ? '' : html);
    // Never rewrite inside code/pre/a/button/script/style or tag attributes.
    // Splitting on those elements keeps their content byte-identical.
    var protectedRe = /(<(?:pre|code|a|button|script|style)\b[\s\S]*?<\/(?:pre|code|a|button|script|style)>)|(<[^>]+>)/gi;
    var parts = s.split(protectedRe);
    for (var i = 0; i < parts.length; i++) {
      var part = parts[i];
      if (part == null || part === '') continue;
      if (part.charAt(0) === '<') continue; // protected element or any tag
      parts[i] = transformSegment(part);
    }
    return parts.join('');
  }

  /* Extract [{label, seconds}] from a raw Markdown/text summary, in order. */
  function extractTimestamps(text) {
    var s = String(text == null ? '' : text);
    var found = [];
    var seen = {};
    var rangeRe = new RegExp(TIMESTAMP_RANGE_SRC, 'g');
    var singleRe = new RegExp(TIMESTAMP_SINGLE_SRC, 'g');
    var covered = [];
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
      if (sec == null) continue;
      if (!seen[m[1] + '@' + sec]) { seen[m[1] + '@' + sec] = true; found.push({ label: m[1], seconds: sec }); }
    }
    return found.sort(function (x, y) { return x.seconds - y.seconds; });
  }

  global.GraphitePrompts = {
    BUILTIN_PROMPTS: BUILTIN_PROMPTS,
    renderPrompt: renderPrompt,
    getBuiltin: getBuiltin,
    getEffectivePrompt: getEffectivePrompt,
    parseTimestampSeconds: parseTimestampSeconds,
    formatTimestampLabel: formatTimestampLabel,
    linkifyTimestamps: linkifyTimestamps,
    extractTimestamps: extractTimestamps,
    listPrompts: listPrompts,
    addPrompt: addPrompt,
    updatePrompt: updatePrompt,
    removePrompt: removePrompt,
    // Rewrite tones (single source of truth for all rewrite UIs).
    REWRITE_TONES: REWRITE_TONES,
    DEFAULT_REWRITE_TONE_ID: DEFAULT_REWRITE_TONE_ID,
    getRewriteTone: getRewriteTone,
    rewritePromptIdForTone: rewritePromptIdForTone,
    rewriteTonePrompt: rewriteTonePrompt,
    getRewritePrompt: rewriteTonePrompt,
    // Render the builtin 'rewrite-<tone>' prompt with {{text}} substituted.
    renderRewritePrompt: function (toneId, vars) {
      var tone = getRewriteTone(toneId);
      var prompt = tone ? getBuiltin('rewrite-' + tone.id) : null;
      if (prompt) {
        var v = vars || {};
        var text = v.text != null ? v.text : (v.selection != null ? v.selection : (v.input != null ? v.input : ''));
        return renderPrompt(prompt.body, { text: text, selection: text });
      }
      return rewriteTonePrompt(toneId, vars);
    }
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
