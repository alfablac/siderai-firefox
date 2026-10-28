'use strict';
/**
 * Graphite Sider — manifest URL watcher.
 *
 * Players fetch their HLS/DASH manifest early during page load. By the
 * time the user asks the sidebar to transcribe, the one-shot resource-
 * timing read in collectManifestUrls() can miss it: entries expire from
 * the buffer, the player may bind its manifest to a page-level fetch that
 * never reaches the media element, and SPA navigations rotate URLs.
 *
 * This script therefore runs at document_start on every page (registered
 * as its OWN manifest content-scripts entry, so the main content script
 * keeps its document_end timing) and keeps a small rolling store of the
 * manifest URLs the page actually requested, using a buffered
 * PerformanceObserver so requests made before this listener attached are
 * still seen. The latest request wins: entries are most-recent-first,
 * deduplicated, capped at 8 (matching collectManifestUrls).
 *
 * No permissions, no messages, no DOM access: it only reads resource
 * timing names, which already include query strings but never cookies.
 * collectManifestUrls() in content/content.js merges this store ahead of
 * its legacy one-shot read. The observer disconnects on pagehide so no
 * listener outlives the page. DRM and cookie-gated manifests are NOT
 * solved by this: it only recovers the URL, not access to its bytes.
 */
(function () {
  var STORE = '__graphiteManifestUrls';
  var MAX = 8;
  var RE = /\.(m3u8|mpd)($|[?#])/i;

  function record(name) {
    var s = String(name || '').trim();
    if (!s || !RE.test(s)) return;
    var list = Array.isArray(window[STORE]) ? window[STORE] : [];
    var at = list.indexOf(s);
    if (at !== -1) list.splice(at, 1);
    list.unshift(s);
    if (list.length > MAX) list.length = MAX;
    window[STORE] = list;
  }

  try {
    if (!Array.isArray(window[STORE])) window[STORE] = [];
    // Seed from any entries already buffered before observe() attaches.
    if (window.performance && performance.getEntriesByType) {
      var seed = performance.getEntriesByType('resource') || [];
      // Chronological order -> record() leaves the newest first.
      seed.forEach(function (entry) { if (entry) record(entry.name); });
    }
    if (typeof PerformanceObserver !== 'function') return;
    var observer = new PerformanceObserver(function (list) {
      list.getEntries().forEach(function (entry) { if (entry) record(entry.name); });
    });
    // buffered:true replays entries recorded before this observer existed
    // (player manifests are usually among the page's first requests).
    observer.observe({ type: 'resource', buffered: true });
    window.addEventListener('pagehide', function () {
      try { observer.disconnect(); } catch (e) { /* already gone */ }
    }, { once: true });
  } catch (e) { /* resource timing unavailable; legacy read still applies */ }
})();
