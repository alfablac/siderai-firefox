'use strict';
/**
 * Graphite Sider — provider clients (bring-your-own-key).
 * Works in Firefox background page / sidebar: fetch only, no Node APIs.
 * NOTE (CORS): extension pages with <all_urls> host permission can call
 * provider APIs directly; Anthropic requires the dangerous-direct-browser
 * header below. Local Ollama/LM Studio must allow the extension origin
 * (e.g. OLLAMA_ORIGINS=* ) or requests will fail with a network error.
 */
(function (global) {

  function trimSlash(u) { return String(u || '').replace(/\/+$/, ''); }

  function providerError(status, bodyText, provider) {
    var snippet = String(bodyText || '').replace(/\s+/g, ' ').slice(0, 400);
    var err = new Error('Provider "' + (provider && provider.label || 'unknown') +
      '" HTTP ' + status + (snippet ? ': ' + snippet : ''));
    err.status = status;
    err.body = snippet;
    return err;
  }

  function networkError(e, provider) {
    var err = new Error('Network error contacting "' + (provider && provider.label || 'provider') +
      '": ' + (e && e.message || e) +
      '. Check the base URL and, for local servers, CORS settings.');
    err.cause = e;
    return err;
  }

  async function readBody(res) {
    try { return await res.text(); } catch (e) { return ''; }
  }

  /** Consume an SSE byte stream; calls onDataLine for each `data:` payload string.
   *  `onActivity` (optional) fires for every raw byte chunk the provider sends —
   *  including SSE comment/keepalive lines and reasoning-only or role-only
   *  deltas that never become visible content. Callers use it as proof the
   *  provider connection is alive even while no text is being produced. */
  async function consumeSSE(res, onDataLine, signal, onActivity) {
    if (!res.body || typeof res.body.getReader !== 'function') {
      var text = await readBody(res);
      if (text && onActivity) onActivity();
      text.split(/\r?\n/).forEach(function (line) {
        if (line.indexOf('data:') === 0) onDataLine(line.slice(5).trim());
      });
      return;
    }
    var reader = res.body.getReader();
    var decoder = new TextDecoder('utf-8');
    var buf = '';
    for (;;) {
      if (signal && signal.aborted) { try { await reader.cancel(); } catch (e) {} throw abortErr(); }
      var chunk = await reader.read();
      if (chunk.done) break;
      if (onActivity) onActivity();
      buf += decoder.decode(chunk.value, { stream: true });
      var idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        var line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line.indexOf('data:') === 0) onDataLine(line.slice(5).trim());
        // Anthropic sends `event:` lines; payload still arrives as data: JSON.
      }
    }
    buf += decoder.decode();
    if (buf.trim().indexOf('data:') === 0) onDataLine(buf.trim().slice(5).trim());
  }

  function abortErr() {
    var e = new Error('Request aborted');
    e.name = 'AbortError';
    return e;
  }

  function isAnthropic(provider) { return provider && provider.kind === 'anthropic'; }

  /** Split system messages out (Anthropic requires top-level `system`). */
  function splitSystem(messages) {
    var system = [];
    var rest = [];
    (messages || []).forEach(function (m) {
      if (m.role === 'system') system.push(typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
      else rest.push(m);
    });
    return { system: system.join('\n\n'), messages: rest };
  }

  /** Convert OpenAI-style content parts to Anthropic blocks (text + image data URLs). */
  function toAnthropicMessages(messages) {
    return messages.map(function (m) {
      if (typeof m.content === 'string') return { role: m.role, content: m.content };
      if (Array.isArray(m.content)) {
        var blocks = m.content.map(function (part) {
          if (part.type === 'text') return { type: 'text', text: part.text || '' };
          if (part.type === 'image_url' && part.image_url && /^data:/.test(part.image_url.url || '')) {
            var match = /^data:([^;]+);base64,(.*)$/.exec(part.image_url.url);
            if (match) return { type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } };
          }
          return { type: 'text', text: '' };
        });
        return { role: m.role, content: blocks };
      }
      return { role: m.role, content: String(m.content == null ? '' : m.content) };
    });
  }

  async function chatOpenAI(provider, opts) {
    var base = trimSlash(provider.baseUrl);
    if (!base) throw new Error('Provider baseUrl is empty');
    var url = base + '/chat/completions';
    var headers = { 'Content-Type': 'application/json' };
    if (provider.apiKey) headers.Authorization = 'Bearer ' + provider.apiKey;
    // OpenRouter attribution (harmless elsewhere only if sent there—scope it).
    if (/openrouter\.ai/.test(base)) {
      headers['HTTP-Referer'] = 'https://graphite-sider.local';
      headers['X-Title'] = 'Graphite Sider';
    }
    var body = {
      model: opts.model || provider.model,
      messages: opts.messages,
      temperature: typeof opts.temperature === 'number' ? opts.temperature : 0.7,
      stream: !!opts.stream
    };
    if (typeof opts.maxTokens === 'number' && opts.maxTokens > 0) body.max_tokens = opts.maxTokens;

    var res;
    try {
      res = await fetch(url, { method: 'POST', headers: headers, body: JSON.stringify(body), signal: opts.signal });
    } catch (e) {
      if (e && e.name === 'AbortError') throw e;
      throw networkError(e, provider);
    }
    if (!res.ok) throw providerError(res.status, await readBody(res), provider);

    if (!opts.stream) {
      var json = await res.json();
      var c = json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
      var fr = json.choices && json.choices[0] && json.choices[0].finish_reason;
      return { text: c || '', model: json.model || body.model, usage: json.usage || null, raw: json, finishReason: fr || null, truncated: fr === 'length' };
    }
    var full = '';
    var finishReason = null;
    await consumeSSE(res, function (data) {
      if (data === '[DONE]') return;
      try {
        var j = JSON.parse(data);
        if (j.choices && j.choices[0] && j.choices[0].finish_reason) finishReason = j.choices[0].finish_reason;
        var delta = j.choices && j.choices[0] && (j.choices[0].delta || j.choices[0].message);
        // Some gateways (e.g. 9Router/Muse) stream reasoning before — or
        // instead of interleaved — visible content. It is not summary text,
        // but it is proof of life: surface it via onActivity so callers do
        // not mistake a thinking model for a dead connection.
        var reasoning = (delta && (delta.reasoning_content || delta.reasoning)) ||
          (j.choices && j.choices[0] && j.choices[0].message &&
            (j.choices[0].message.reasoning_content || j.choices[0].message.reasoning)) || '';
        if (!reasoning && j.delta && (j.delta.reasoning_content || j.delta.reasoning)) {
          reasoning = j.delta.reasoning_content || j.delta.reasoning;
        }
        if (reasoning && opts.onActivity) opts.onActivity();
        var piece = (delta && delta.content) || '';
        if (piece) { full += piece; if (opts.onChunk) opts.onChunk(piece, full); }
      } catch (e) { /* keepalive / non-JSON line */ }
    }, opts.signal, opts.onActivity);
    return { text: full, model: body.model, usage: null, raw: null, finishReason: finishReason, truncated: finishReason === 'length' };
  }

  async function chatAnthropic(provider, opts) {
    var base = trimSlash(provider.baseUrl) || 'https://api.anthropic.com';
    if (!provider.apiKey) throw new Error('Anthropic provider requires an API key');
    var split = splitSystem(opts.messages);
    var headers = {
      'Content-Type': 'application/json',
      'x-api-key': provider.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    };
    var body = {
      model: opts.model || provider.model,
      messages: toAnthropicMessages(split.messages),
      // Anthropic requires max_tokens; when unset use a high ceiling so the
      // model stops naturally instead of truncating long summaries at 2048.
      max_tokens: typeof opts.maxTokens === 'number' && opts.maxTokens > 0 ? opts.maxTokens : 16384,
      temperature: typeof opts.temperature === 'number' ? opts.temperature : 0.7,
      stream: !!opts.stream
    };
    if (split.system) body.system = split.system;

    var res;
    try {
      res = await fetch(base + '/v1/messages', { method: 'POST', headers: headers, body: JSON.stringify(body), signal: opts.signal });
    } catch (e) {
      if (e && e.name === 'AbortError') throw e;
      throw networkError(e, provider);
    }
    if (!res.ok) throw providerError(res.status, await readBody(res), provider);

    if (!opts.stream) {
      var json = await res.json();
      var text = (json.content || []).filter(function (b) { return b.type === 'text'; })
        .map(function (b) { return b.text; }).join('');
      return { text: text, model: json.model || body.model, usage: json.usage || null, raw: json, finishReason: json.stop_reason || null, truncated: json.stop_reason === 'max_tokens' };
    }
    var full = '';
    var stopReason = null;
    await consumeSSE(res, function (data) {
      try {
        var j = JSON.parse(data);
        if (j.type === 'message_delta' && j.delta && j.delta.stop_reason) stopReason = j.delta.stop_reason;
        if (j.type === 'content_block_delta' && j.delta && j.delta.type === 'text_delta') {
          full += j.delta.text;
          if (opts.onChunk) opts.onChunk(j.delta.text, full);
        } else if (j.type === 'content_block_delta' && j.delta && j.delta.type === 'thinking_delta') {
          // Thinking is not answer text, but it is proof of life.
          if (opts.onActivity) opts.onActivity();
        } else if (j.type === 'error') {
          throw new Error('Anthropic stream error: ' + JSON.stringify(j.error || j).slice(0, 300));
        }
      } catch (e) { if (e.message && e.message.indexOf('Anthropic stream') === 0) throw e; }
    }, opts.signal, opts.onActivity);
    return { text: full, model: body.model, usage: null, raw: null, finishReason: stopReason, truncated: stopReason === 'max_tokens' };
  }

  /**
   * Chat completion.
   * @param {{provider:object, model?:string, messages:Array, stream?:boolean,
   *          onChunk?:function(string,string), onActivity?:function(),
   *          signal?:AbortSignal,
   *          temperature?:number, maxTokens?:number}} opts
   * @returns {Promise<{text:string, model:string, usage:object|null}>}
   * Ollama (kind 'ollama', baseUrl …:11434/v1) uses the OpenAI-compatible
   * /v1 endpoint, which Ollama serves natively — no separate native path.
   */
  async function chat(opts) {
    if (!opts || !opts.provider) throw new Error('chat: provider is required');
    if (!Array.isArray(opts.messages) || !opts.messages.length) throw new Error('chat: messages required');
    if (isAnthropic(opts.provider)) return chatAnthropic(opts.provider, opts);
    return chatOpenAI(opts.provider, opts);
  }

  function modelIdFromItem(item) {
    if (typeof item === 'string') return item.trim();
    if (item && typeof item === 'object') {
      var keys = ['id', 'name', 'model'];
      for (var i = 0; i < keys.length; i++) {
        var v = item[keys[i]];
        if (typeof v === 'string' && v.trim()) return v.trim();
      }
    }
    return '';
  }

  function collectModelIds(value, out, seen) {
    if (typeof value === 'string') {
      var sv = value.trim();
      if (sv && !seen[sv]) { seen[sv] = true; out.push(sv); }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(function (item) {
        var id = modelIdFromItem(item);
        if (id && !seen[id]) { seen[id] = true; out.push(id); }
      });
      return;
    }
    if (value && typeof value === 'object') {
      var keys = ['data', 'models', 'result', 'items'];
      var found = false;
      keys.forEach(function (k) {
        if (Array.isArray(value[k])) {
          found = true;
          value[k].forEach(function (item) {
            var id = modelIdFromItem(item);
            if (id && !seen[id]) { seen[id] = true; out.push(id); }
          });
        } else if (typeof value[k] === 'string' && value[k].trim()) {
          found = true;
          var sid = value[k].trim();
          if (!seen[sid]) { seen[sid] = true; out.push(sid); }
        } else if (value[k] && typeof value[k] === 'object') {
          found = true;
          var oid = modelIdFromItem(value[k]);
          if (oid && !seen[oid]) { seen[oid] = true; out.push(oid); }
        }
      });
      if (found) return;
      var single = modelIdFromItem(value);
      if (single && !seen[single]) { seen[single] = true; out.push(single); }
    }
  }

  function extractBalancedJson(text, start) {
    var open = text.charAt(start);
    var stack = [open === '{' ? '}' : ']'];
    var inString = false;
    var escaped = false;
    for (var i = start + 1; i < text.length; i++) {
      var ch = text.charAt(i);
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') { inString = true; continue; }
      if (ch === '{') stack.push('}');
      else if (ch === '[') stack.push(']');
      else if (ch === '}' || ch === ']') {
        if (!stack.length || stack[stack.length - 1] !== ch) return null;
        stack.pop();
        if (!stack.length) return text.slice(start, i + 1);
      }
    }
    return null;
  }

  function collectBalancedPayloads(text) {
    var payloads = [];
    var i = 0;
    while (i < text.length) {
      var ch = text.charAt(i);
      if (ch === '{' || ch === '[') {
        var candidate = extractBalancedJson(text, i);
        if (candidate) {
          try {
            payloads.push(JSON.parse(candidate));
            i += candidate.length;
            continue;
          } catch (e) { i++; continue; }
        }
      }
      i++;
    }
    return payloads;
  }

  function parseModelList(text) {
    var raw = String(text == null ? '' : text);
    if (!raw.trim()) throw new Error('Provider returned an empty model list response');
    var trimmed = raw.trim();
    var payloads = [];
    var parsed = false;

    var dataPayloads = [];
    trimmed.split(/\r?\n/).forEach(function (line) {
      var t = line.trim();
      if (t.indexOf('data:') === 0) {
        var payload = t.slice(5).trim();
        if (payload && payload !== '[DONE]') dataPayloads.push(payload);
      }
    });
    if (dataPayloads.length) {
      try {
        payloads.push(JSON.parse(dataPayloads.join('')));
        parsed = true;
      } catch (e) {
        dataPayloads.forEach(function (payload) {
          try { payloads.push(JSON.parse(payload)); parsed = true; }
          catch (e2) {
            var bal = collectBalancedPayloads(payload);
            if (bal.length) {
              bal.forEach(function (p) { payloads.push(p); });
              parsed = true;
            }
          }
        });
      }
    }

    if (!parsed) {
      try { payloads = [JSON.parse(trimmed)]; parsed = true; } catch (e) { /* fall through */ }
    }
    if (!parsed) {
      var balanced = collectBalancedPayloads(trimmed);
      if (balanced.length) { payloads = balanced; parsed = true; }
    }
    if (!parsed) {
      var snippet = raw.replace(/\s+/g, ' ').trim().slice(0, 200);
      throw new Error('Could not parse model list response: ' + snippet);
    }
    // Double-encoded JSON: the body parsed to a string that is itself JSON.
    for (var pi = 0; pi < payloads.length; pi++) {
      if (typeof payloads[pi] === 'string') {
        try { payloads[pi] = JSON.parse(payloads[pi]); } catch (e) { /* plain model id string */ }
      }
    }
    var out = [];
    var seen = {};
    payloads.forEach(function (p) { collectModelIds(p, out, seen); });
    return out;
  }

  /** GET {base}/models for OpenAI-compatible; Anthropic has no public list → ping fallback. */
  async function listModels(provider) {
    if (!provider || !provider.baseUrl) throw new Error('Provider baseUrl is empty');
    var base = trimSlash(provider.baseUrl);
    if (isAnthropic(provider)) {
      // No /models endpoint for browser keys historically; return configured model.
      return [provider.model].filter(Boolean);
    }
    var headers = {};
    if (provider.apiKey) headers.Authorization = 'Bearer ' + provider.apiKey;
    var res;
    try { res = await fetch(base + '/models', { method: 'GET', headers: headers }); }
    catch (e) { throw networkError(e, provider); }
    if (!res.ok) throw providerError(res.status, await readBody(res), provider);
    var text = await readBody(res);
    var ids = parseModelList(text);
    // 9Router-style gateways may answer 200 with no usable IDs: keep the
    // configured model selectable instead of reporting "No models returned".
    if (!ids.length) ids = [provider.model].filter(Boolean);
    return ids;
  }

  /** Connectivity check: list models, else a 1-token chat ping. */
  async function testProvider(provider) {
    var started = Date.now();
    try {
      var models = await listModels(provider);
      if (models.length || !isAnthropic(provider)) {
        return { ok: true, latencyMs: Date.now() - started, models: models.slice(0, 50), detail: models.length + ' model(s) listed' };
      }
      throw new Error('empty model list');
    } catch (listErr) {
      if (isAnthropic(provider)) {
        var r = await chat({
          provider: provider, messages: [{ role: 'user', content: 'ping' }],
          maxTokens: 1, stream: false
        });
        return { ok: true, latencyMs: Date.now() - started, models: [provider.model], detail: 'chat ping ok: ' + (r.model || '') };
      }
      throw listErr;
    }
  }

  /**
   * Whisper-style transcription (OpenAI-compatible only).
   * @param {object} provider @param {Blob} blob @param {string} [filename]
   * @returns {Promise<{text:string, raw:object}>}
   */
  async function transcribe(provider, blob, filename) {
    if (isAnthropic(provider)) throw new Error('Transcription is not supported by the Anthropic provider');
    if (!provider || !provider.baseUrl) throw new Error('Provider baseUrl is empty');
    var form = new FormData();
    form.append('file', blob, filename || 'audio.webm');
    form.append('model', 'whisper-1');
    var headers = {};
    if (provider.apiKey) headers.Authorization = 'Bearer ' + provider.apiKey;
    var res;
    try {
      res = await fetch(trimSlash(provider.baseUrl) + '/audio/transcriptions', { method: 'POST', headers: headers, body: form });
    } catch (e) { throw networkError(e, provider); }
    if (!res.ok) throw providerError(res.status, await readBody(res), provider);
    var json = await res.json();
    return { text: json.text || '', raw: json };
  }

  /**
   * Parse an /images/generations response body. Normal shape is
   * { data: [{ url, b64_json }] }; some gateways answer with SSE framing
   * (`data: {...}` lines, possibly terminated by `data: [DONE]`), so strip
   * the framing and return the last JSON payload that carries image data.
   */
  function parseImageResponse(text) {
    var raw = String(text || '').trim();
    if (!raw) throw new Error('Image generation returned an empty response');
    try { return JSON.parse(raw); } catch (e) { /* fall through to SSE framing */ }
    if (raw.indexOf('data:') !== -1) {
      var payloads = [];
      raw.split(/\r?\n/).forEach(function (line) {
        var t = line.trim();
        if (t.indexOf('data:') !== 0) return;
        var payload = t.slice(5).trim();
        if (!payload || payload === '[DONE]') return;
        try { payloads.push(JSON.parse(payload)); } catch (e) { /* keepalive/comment line */ }
      });
      for (var i = payloads.length - 1; i >= 0; i--) {
        if (payloads[i] && Array.isArray(payloads[i].data) && payloads[i].data.length) return payloads[i];
      }
      if (payloads.length) return payloads[payloads.length - 1];
    }
    throw new Error('Could not parse image generation response: ' + raw.replace(/\s+/g, ' ').slice(0, 200));
  }

  /**
   * Image generation (OpenAI-compatible POST {baseUrl}/images/generations).
   * The image model is decoupled from the provider's chat model: it resolves
   * as options.model, then provider.imageModel. The chat `model` is never
   * silently reused for images; the caller's override must be explicit.
   * @param {object} provider normalized provider (imageModel, not model)
   * @param {string} prompt
   * @param {object|string} [options] options object; a plain string is treated
   *        as the legacy `size` argument. Fields (all overridable):
   *        model, n (1), size ("auto"), quality ("auto"), background ("auto"),
   *        image_detail ("high"), output_format ("png"), watermark (true),
   *        prompt_extend (true).
   * @returns {Promise<{url:string|null, dataUrl:string|null,
   *          b64_json:string|null, b64:string|null, raw:object}>}
   *          `url` is the remote URL when the API returns one, otherwise it
   *          falls back to the data URL built from b64_json, so legacy
   *          callers that only read `.url` keep working. `dataUrl` is always
   *          the data URL (null when no b64 data came back); `b64` is the
   *          legacy alias of `b64_json`.
   */
  async function generateImage(provider, prompt, options) {
    if (!provider || !provider.baseUrl) throw new Error('Provider baseUrl is empty');
    if (isAnthropic(provider)) {
      throw new Error('Provider "' + (provider.label || 'Anthropic') +
        '" does not support image generation: Anthropic has no /images/generations endpoint. ' +
        'Choose an OpenAI-compatible provider with an image model configured.');
    }
    if (!prompt) throw new Error('generateImage: prompt required');
    // Legacy third argument was a size string; keep accepting it.
    if (typeof options === 'string') options = { size: options };
    var opts = options && typeof options === 'object' ? options : {};
    var model = opts.model || provider.imageModel || '';
    if (!model) {
      throw new Error('No image model configured for provider "' + (provider.label || 'unknown') +
        '". Set an image model (e.g. gpt-image-1) for this provider in Options.');
    }
    var outputFormat = opts.output_format || 'png';
    var body = {
      model: model,
      prompt: prompt,
      n: typeof opts.n === 'number' ? opts.n : 1,
      size: opts.size || 'auto',
      quality: opts.quality || 'auto',
      background: opts.background || 'auto',
      image_detail: opts.image_detail || 'high',
      output_format: outputFormat,
      watermark: typeof opts.watermark === 'boolean' ? opts.watermark : true,
      prompt_extend: typeof opts.prompt_extend === 'boolean' ? opts.prompt_extend : true
    };
    var headers = {
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream'
    };
    if (provider.apiKey) headers.Authorization = 'Bearer ' + provider.apiKey;
    var res;
    try {
      res = await fetch(trimSlash(provider.baseUrl) + '/images/generations', { method: 'POST', headers: headers, body: JSON.stringify(body) });
    } catch (e) { throw networkError(e, provider); }
    if (!res.ok) throw providerError(res.status, await readBody(res), provider);
    var json = parseImageResponse(await readBody(res));
    var first = (json && Array.isArray(json.data) ? json.data : [])[0] || {};
    var b64 = first.b64_json || first.b64 || null;
    var mime = String(outputFormat).toLowerCase();
    if (mime === 'jpg') mime = 'jpeg';
    var dataUrl = b64 ? 'data:image/' + mime + ';base64,' + b64 : null;
    return {
      url: first.url || dataUrl,
      dataUrl: dataUrl,
      b64_json: b64,
      b64: b64, // legacy alias (previous builds returned `b64`)
      raw: json
    };
  }

  global.GraphiteProviders = {
    chat: chat,
    listModels: listModels,
    testProvider: testProvider,
    transcribe: transcribe,
    /** Alias matching the task vocabulary. */
    transcribeAudio: transcribe,
    generateImage: generateImage,
    providerError: providerError,
    _consumeSSE: consumeSSE,
    _splitSystem: splitSystem,
    _parseModelList: parseModelList
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
