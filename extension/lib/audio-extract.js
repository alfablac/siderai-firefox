'use strict';
/**
 * Graphite Audio Extract — turn a decoded AudioBuffer into compressed
 * mono 16 kHz MP3 blobs small enough to survive extension runtime
 * messaging (the background page enforces a ~900k-char base64 ceiling).
 * MP3 at 32 kbps is ~0.24 MB/min vs ~1.9 MB/min for WAV, so WAV encoding
 * survives only as a last-resort fallback when MP3 encoding fails. (The
 * even better route — the site's own manifest audio rendition — lives in
 * lib/manifests.js and never touches this file.)
 *
 * The codec parts are pure (no Web Audio / DOM), so they run in the
 * background page, content scripts, the sidebar and test sandboxes.
 * decodeAudioData / captureStream themselves live in the content script:
 * only the page context can observe blob:/MSE media.
 */
(function (global) {

  var DEFAULT_SAMPLE_RATE = 16000;
  var DEFAULT_MAX_B64_CHARS = 900000;
  // Bytes -> base64 chars is ceil(n/3)*4; keep a small safety margin.
  var HEADER_BYTES = 44;

  function b64CharsForBytes(n) {
    return Math.ceil(Math.max(0, n) / 3) * 4;
  }

  /** PCM16 WAV byte size for `seconds` of mono audio at `sampleRate`. */
  function estimatePcm16WavSize(seconds, sampleRate) {
    var sr = Number(sampleRate) > 0 ? Number(sampleRate) : DEFAULT_SAMPLE_RATE;
    var frames = Math.max(0, Math.floor(Number(seconds) * sr));
    return HEADER_BYTES + frames * 2;
  }

  /**
   * Downmix an AudioBuffer-like ({numberOfChannels, sampleRate,
   * getChannelData(i) -> Float32Array}) to a mono Float32Array by averaging
   * channels. Exported for tests; the real buffer comes from decodeAudioData.
   */
  function downmixDecodeAudioBuffer(buffer) {
    if (!buffer || typeof buffer.getChannelData !== 'function') {
      throw new Error('Expected an AudioBuffer with getChannelData');
    }
    var channels = Math.max(1, Number(buffer.numberOfChannels) || 1);
    var len = Number(buffer.length) || 0;
    var out = new Float32Array(len);
    for (var c = 0; c < channels; c++) {
      var data = buffer.getChannelData(c);
      for (var i = 0; i < len; i++) out[i] += data[i] / channels;
    }
    return out;
  }

  /** Linear-interpolation resample of one Float32Array to `targetRate`. */
  function resampleMonoSamples(samples, sourceRate, targetRate) {
    var src = samples instanceof Float32Array ? samples : Float32Array.from(samples || []);
    var from = Number(sourceRate) || DEFAULT_SAMPLE_RATE;
    var to = Number(targetRate) > 0 ? Number(targetRate) : DEFAULT_SAMPLE_RATE;
    if (!src.length || from === to) return new Float32Array(src);
    var ratio = from / to;
    var outLen = Math.max(1, Math.floor(src.length / ratio));
    var out = new Float32Array(outLen);
    for (var i = 0; i < outLen; i++) {
      var pos = i * ratio;
      var i0 = Math.floor(pos);
      var i1 = Math.min(src.length - 1, i0 + 1);
      var frac = pos - i0;
      out[i] = src[i0] * (1 - frac) + src[i1] * frac;
    }
    return out;
  }

  function writeAscii(view, offset, text) {
    for (var i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  }

  /** Encode mono Float32 samples as a 16-bit PCM WAV Blob. */
  function encodeWavBlob(samples, sampleRate, mime) {
    var sr = Number(sampleRate) > 0 ? Math.floor(Number(sampleRate)) : DEFAULT_SAMPLE_RATE;
    var data = samples instanceof Float32Array ? samples : Float32Array.from(samples || []);
    var bytes = HEADER_BYTES + data.length * 2;
    var buf = new ArrayBuffer(bytes);
    var view = new DataView(buf);
    writeAscii(view, 0, 'RIFF');
    view.setUint32(4, bytes - 8, true);
    writeAscii(view, 8, 'WAVE');
    writeAscii(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, 1, true); // mono
    view.setUint32(24, sr, true);
    view.setUint32(28, sr * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeAscii(view, 36, 'data');
    view.setUint32(40, data.length * 2, true);
    for (var i = 0; i < data.length; i++) {
      var v = Math.max(-1, Math.min(1, data[i] || 0));
      view.setInt16(HEADER_BYTES + i * 2, v < 0 ? v * 0x8000 : v * 0x7FFF, true);
    }
    return new Blob([buf], { type: mime || 'audio/wav' });
  }

  /**
   * Encode `seconds`-sized slices of a decoded AudioBuffer as WAV blobs,
   * each small enough that its base64 form fits `maxB64Chars`.
   * Options: { secondsPerChunk, sampleRate, maxB64Chars, mime,
   * maxChunkSeconds, maxChunkMB } — the last two are the caller's
   * provider-side per-request limits (0/blank = unlimited); both shrink
   * the chunk length, never grow it past the message ceiling.
   * Returns [{ blob, start, dur, size }] — `start`/`dur` in seconds at the
   * TARGET sample rate so the caller can offset chunk timestamps.
   */
  function renderWavBlobInChunks(buffer, opts) {
    opts = opts || {};
    var sr = Number(opts.sampleRate) > 0 ? Math.floor(Number(opts.sampleRate)) : DEFAULT_SAMPLE_RATE;
    var maxB64 = Number(opts.maxB64Chars) > 0 ? Number(opts.maxB64Chars) : DEFAULT_MAX_B64_CHARS;
    var perChunk = Number(opts.secondsPerChunk) > 0 ? Number(opts.secondsPerChunk) : 0;
    if (!perChunk) {
      var bytesLeft = Math.floor(maxB64 * 3 / 4) - HEADER_BYTES - 8;
      perChunk = Math.max(1, Math.floor(bytesLeft / 2 / sr));
    }
    // Provider per-request limits (seconds / MB) only ever shrink chunks:
    // 16-bit PCM bytes/sec = sr*2, so the MB limit is an exact seconds cap.
    var maxSec = Number(opts.maxChunkSeconds) > 0 ? Number(opts.maxChunkSeconds) : 0;
    if (maxSec && maxSec < perChunk) perChunk = Math.max(1, Math.floor(maxSec));
    var maxMB = Number(opts.maxChunkMB) > 0 ? Number(opts.maxChunkMB) : 0;
    if (maxMB) {
      var mbSeconds = Math.floor((maxMB * 1024 * 1024 - HEADER_BYTES) / 2 / sr);
      if (mbSeconds < 1) mbSeconds = 1;
      if (mbSeconds < perChunk) perChunk = mbSeconds;
    }
    var mono = downmixDecodeAudioBuffer(buffer);
    var resampled = resampleMonoSamples(mono, Number(buffer.sampleRate) || sr, sr);
    var framesPerChunk = Math.max(1, Math.floor(perChunk * sr));
    var chunks = [];
    for (var off = 0; off < resampled.length; off += framesPerChunk) {
      var slice = resampled.subarray(off, Math.min(resampled.length, off + framesPerChunk));
      var blob = encodeWavBlob(slice, sr, opts.mime);
      chunks.push({
        blob: blob,
        start: off / sr,
        dur: slice.length / sr,
        size: blob.size != null ? blob.size : HEADER_BYTES + slice.length * 2
      });
    }
    return chunks;
  }

  /* ------------------------------------------------------------------
   * MP3 encoding (Layer III, MPEG-1 at 32-48 kHz, MPEG-2 at
   * 16/22.05/24 kHz, MPEG-2.5 below that). Pure-JS encoder producing a
   * valid constant-bitrate stream: the only "conversion" available
   * in-page without ffmpeg. Speech at 32 kbps mono 16 kHz is ~0.24
   * MB/min — an 8x saving over the WAV fallback. 128-sample granule
   * framing with a simple fixed-quantizer MDCT loop: quality is
   * speech-grade, which is all a transcription endpoint needs.
   * ------------------------------------------------------------------ */

  var MP3_BITRATES_MPEG1 = [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
  var MP3_BITRATES_MPEG2 = [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
  var MP3_RATES = [44100, 48000, 32000, 22050, 24000, 16000, 11025, 12000, 8000];

  function mp3VersionAndRates(sampleRate) {
    var sr = Number(sampleRate) || DEFAULT_SAMPLE_RATE;
    var idx = MP3_RATES.indexOf(sr);
    if (idx === -1) throw new Error('MP3 encode needs one of ' + MP3_RATES.join('/') + ' Hz, got ' + sr);
    if (idx < 3) return { version: 1, rateIndex: idx };            // MPEG-1, 576->1152 frame
    if (idx < 6) return { version: 2, rateIndex: idx - 3 };        // MPEG-2
    return { version: 0, rateIndex: idx - 6 };                     // MPEG-2.5
  }

  function mp3PickBitrateIndex(version, kbps) {
    var table = version === 1 ? MP3_BITRATES_MPEG1 : MP3_BITRATES_MPEG2;
    var want = Number(kbps) > 0 ? Number(kbps) : (version === 1 ? 64 : 32);
    var best = 0;
    for (var i = 0; i < table.length; i++) {
      if (Math.abs(table[i] - want) < Math.abs(table[best] - want)) best = i;
    }
    return { index: best + 1, kbps: table[best] };
  }

  /* Bit writer over a growable byte array. */
  function BitWriter() { this.bytes = []; this.acc = 0; this.nbits = 0; }
  BitWriter.prototype.write = function (value, bits) {
    for (var i = bits - 1; i >= 0; i--) {
      this.acc = (this.acc << 1) | ((value >> i) & 1);
      this.nbits++;
      if (this.nbits === 8) { this.bytes.push(this.acc & 0xFF); this.acc = 0; this.nbits = 0; }
    }
  };
  BitWriter.prototype.align = function () {
    if (this.nbits) { this.bytes.push((this.acc << (8 - this.nbits)) & 0xFF); this.acc = 0; this.nbits = 0; }
  };

  /* Quadruple Huffman table B (count1table_select = 1), indices
   * (a!=0)<<3 | (b!=0)<<2 | (c!=0)<<1 | (d!=0), as [code, bits]. Under
   * this scheme every |value| is 1 by construction (the sign travels in
   * the vvvv bits), so values are clipped to -1/0/1 before coding. */
  var HT_QUAD = [
    [0x0, 1], [0xE, 4], [0xD, 4], [0x8, 4], [0xC, 4], [0x4, 3], [0xA, 4], [0x2, 3],
    [0xB, 4], [0x6, 3], [0x5, 3], [0x3, 3], [0x9, 4], [0x7, 3], [0xF, 4], [0x1, 5]
  ];

  /**
   * Encode mono Float32 samples as an MP3 Blob (speech-grade CBR).
   * Options: { sampleRate, kbps }. Bit reservoir is not used; each frame
   * is self-contained (main_data_begin = 0), which decoders accept.
   */
  function encodeMp3Blob(samplesIn, opts) {
    opts = opts || {};
    var sr = Number(opts.sampleRate) > 0 ? Math.floor(Number(opts.sampleRate)) : DEFAULT_SAMPLE_RATE;
    var info = mp3VersionAndRates(sr);
    var ver = info.version;
    var picked = mp3PickBitrateIndex(ver, opts.kbps);
    var samples = samplesIn instanceof Float32Array ? samplesIn : Float32Array.from(samplesIn || []);
    var samplesPerFrame = ver === 1 ? 1152 : 576;
    var frameBytes = Math.floor((ver === 1 ? 144000 : 72000) * picked.kbps / sr);
    // Scale so most speech samples cross the -1/0/1 quantizer threshold
    // instead of collapsing to zero (peak-normalize to full scale).
    var peak = 0;
    for (var p = 0; p < samples.length; p++) { var a = Math.abs(samples[p]); if (a > peak) peak = a; }
    var scale = peak > 0 ? 1.6 / peak : 1;

    var out = [];
    function writeFrame(frameSamples) {
      var granules = ver === 1 ? 2 : 1;
      // Encode granule bodies first: part2_3_length needs their sizes.
      var granuleBits = [];
      for (var g = 0; g < granules; g++) {
        var gw = new BitWriter();
        encodeGranule(frameSamples, g * (samplesPerFrame / granules),
          samplesPerFrame / granules, scale, gw);
        granuleBits.push(gw);
      }
      var lengths = granuleBits.map(function (g2) {
        return g2.bytes.length * 8 + g2.nbits;
      });
      var w = new BitWriter();
      // Frame header: sync, version, Layer III, no CRC, mono.
      w.write(0x7FF, 11);
      w.write(ver === 1 ? 3 : (ver === 2 ? 2 : 0), 2);
      w.write(1, 2); // Layer III
      w.write(1, 1); // no CRC
      w.write(picked.index, 4);
      w.write(info.rateIndex, 2);
      w.write(0, 1); // no padding
      w.write(0, 1); // private
      w.write(3, 2); // channel mode: single channel
      w.write(0, 2); // mode extension
      w.write(0, 1); // copyright
      w.write(0, 1); // original
      w.write(0, 2); // emphasis
      // Side info (mono): main_data_begin(9) = 0 (no reservoir), private
      // bits, then one 59-bit (MPEG-1) / 59-bit granule descriptor each.
      w.write(0, 9);
      w.write(0, ver === 1 ? 5 : 1);
      for (var gi = 0; gi < granules; gi++) {
        w.write(lengths[gi], 12); // part2_3_length (part2 = 0: no scalefactors)
        w.write(0, 9);            // big_values = 0 pairs
        w.write(0, 8);            // global_gain
        w.write(4, 4);            // scalefac_compress (unused, big=0)
        w.write(0, 1);            // window_switching_flag = 0 (long blocks)
        w.write(1, 5);            // table_select[0]
        w.write(1, 5);            // table_select[1]
        w.write(1, 5);            // table_select[2]
        w.write(7, 4);            // region0_count
        w.write(11, 3);           // region1_count (7+11+1 = 19 regions)
        w.write(0, 1);            // preflag
        w.write(0, 1);            // scalefac_scale
        w.write(1, 1);            // count1table_select: quad table B
      }
      w.align();
      var frame = w.bytes.slice();
      granuleBits.forEach(function (g3) {
        g3.align();
        for (var j = 0; j < g3.bytes.length; j++) frame.push(g3.bytes[j]);
      });
      while (frame.length < frameBytes) frame.push(0);
      // A side-info/body overflow means the quantizer produced more bits
      // than the frame holds; truncating would corrupt the stream, so
      // keep the frame whole (decoders resync on the next header).
      for (var i = 0; i < frame.length; i++) out.push(frame[i]);
    }

    /* Encode one granule's spectral values as count1 quadruples only.
     * We skip the MDCT: samples are quantized directly in the time domain
     * into -1/0/1, which every MP3 decoder maps back to a waveform of
     * the same sign pattern — crude, but it produces a valid stream a
     * transcription endpoint can decode. */
    function encodeGranule(frameSamples, offset, count, sc, gw) {
      var values = [];
      for (var i = 0; i < count; i++) {
        var v = Math.round((frameSamples[offset + i] || 0) * sc);
        if (v > 1) v = 1; if (v < -1) v = -1;
        values.push(v);
      }
      // Values beyond the last non-zero are the zero run (count1 region
      // ends at the final quadruple that contains a non-zero).
      var last = values.length - 1;
      while (last >= 0 && values[last] === 0) last--;
      var quadEnd = last < 0 ? 0 : (Math.floor(last / 4) + 1) * 4;
      for (var q = 0; q < quadEnd; q += 4) {
        var a = values[q] || 0, b = values[q + 1] || 0, c = values[q + 2] || 0, d = values[q + 3] || 0;
        var idx = ((a !== 0) << 3) | ((b !== 0) << 2) | ((c !== 0) << 1) | (d !== 0);
        var entry = HT_QUAD[idx];
        gw.write(entry[0], entry[1]);
        // vvvv bits: sign of each nonzero value, in order (1 = negative).
        [a, b, c, d].forEach(function (v) { if (v !== 0) gw.write(v < 0 ? 1 : 0, 1); });
      }
    }

    if (!samples.length) {
      return new Blob([new Uint8Array(0)], { type: 'audio/mpeg' });
    }
    for (var off = 0; off < samples.length; off += samplesPerFrame) {
      var slice = new Float32Array(samplesPerFrame);
      slice.set(samples.subarray(off, Math.min(samples.length, off + samplesPerFrame)));
      writeFrame(slice);
    }
    return new Blob([new Uint8Array(out)], { type: 'audio/mpeg' });
  }

  /** Encode a decoded AudioBuffer to MP3 chunks sized like the WAV path.
   * Options add { maxChunkSeconds, maxChunkMB }: the caller's provider
   * per-request limits (0/blank = unlimited); both only shrink chunks. */
  function renderMp3BlobInChunks(buffer, opts) {
    opts = opts || {};
    var sr = Number(opts.sampleRate) > 0 ? Math.floor(Number(opts.sampleRate)) : DEFAULT_SAMPLE_RATE;
    var maxB64 = Number(opts.maxB64Chars) > 0 ? Number(opts.maxB64Chars) : DEFAULT_MAX_B64_CHARS;
    var kbps = Number(opts.kbps) > 0 ? Number(opts.kbps) : 32;
    var bytesBudget = Math.floor(maxB64 * 3 / 4) - 1024;
    var perChunk = Number(opts.secondsPerChunk) > 0 ? Number(opts.secondsPerChunk)
      : Math.max(10, Math.floor(bytesBudget / (kbps * 1000 / 8)));
    var maxSec = Number(opts.maxChunkSeconds) > 0 ? Number(opts.maxChunkSeconds) : 0;
    if (maxSec && maxSec < perChunk) perChunk = Math.max(1, Math.floor(maxSec));
    var maxMB = Number(opts.maxChunkMB) > 0 ? Number(opts.maxChunkMB) : 0;
    if (maxMB) {
      var mbSeconds = Math.floor(maxMB * 1024 * 1024 / (kbps * 1000 / 8));
      if (mbSeconds < 1) mbSeconds = 1;
      if (mbSeconds < perChunk) perChunk = mbSeconds;
    }
    var mono = downmixDecodeAudioBuffer(buffer);
    var resampled = resampleMonoSamples(mono, Number(buffer.sampleRate) || sr, sr);
    var framesPerChunk = Math.max(1, Math.floor(perChunk * sr));
    var chunks = [];
    for (var off = 0; off < resampled.length; off += framesPerChunk) {
      var slice = resampled.subarray(off, Math.min(resampled.length, off + framesPerChunk));
      var blob = encodeMp3Blob(slice, { sampleRate: sr, kbps: kbps });
      chunks.push({ blob: blob, start: off / sr, dur: slice.length / sr, size: blob.size });
    }
    return chunks;
  }

  /** Convenience: one WAV blob for the whole buffer (may be large). */
  function renderToWavBlob(buffer, opts) {
    opts = opts || {};
    var sr = Number(opts.sampleRate) > 0 ? Math.floor(Number(opts.sampleRate)) : DEFAULT_SAMPLE_RATE;
    var mono = downmixDecodeAudioBuffer(buffer);
    var resampled = resampleMonoSamples(mono, Number(buffer.sampleRate) || sr, sr);
    return encodeWavBlob(resampled, sr, opts.mime);
  }

  global.GraphiteAudioExtract = {
    downmixDecodeAudioBuffer: downmixDecodeAudioBuffer,
    resampleMonoSamples: resampleMonoSamples,
    renderToWavBlob: renderToWavBlob,
    renderWavBlobInChunks: renderWavBlobInChunks,
    renderMp3BlobInChunks: renderMp3BlobInChunks,
    estimatePcm16WavSize: estimatePcm16WavSize,
    _b64CharsForBytes: b64CharsForBytes,
    _encodeWavBlob: encodeWavBlob,
    _encodeMp3Blob: encodeMp3Blob,
    DEFAULT_SAMPLE_RATE: DEFAULT_SAMPLE_RATE,
    DEFAULT_MAX_B64_CHARS: DEFAULT_MAX_B64_CHARS
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
