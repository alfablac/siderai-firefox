/* Graphite Sider - YouTube timedtext hook (document_start).
   Installs the SINGLE page-context bridge as early as possible so the
   caption URL from the page's own timedtext XHR is captured before
   playback starts. content/youtube.js only listens (plus a one-shot
   'gs-yt-ping' re-send request); it no longer injects a duplicate bridge.

   Bridge contract (window.postMessage):
     { type: 'gs-yt-caption-url', url }
     { type: 'gs-yt-player-response', playerResponse: <JSON string> }
       -- SLIM projection only: videoDetails.videoId/title/lengthSeconds
          and captionTracks[]. The full ytInitialPlayerResponse is never
          serialized (the old bridge JSON.stringify'd the entire object
          3x per page; tens of KB-MS each on real watch pages).
     { type: 'gs-yt-ping' }  (content -> page: re-send once, deduped)

   FREEZE FIX: XHR hook is passive and narrow -- it only records the URL
   string for timedtext requests and always delegates to the original
   open(). No response interception, no body reads, no retriggering.
   Sends are bounded: immediate + 2 retries, then once per SPA videoId
   change (checked on ping / timedtext capture), deduped by videoId. */
(function () {
  'use strict';
  if (window.__graphiteInjectYtLoaded) return;
  window.__graphiteInjectYtLoaded = true;

  function inject() {
    if (document.getElementById('gs-yt-bridge')) return true;
    var root = document.documentElement || document.head;
    if (!root) return false;
    var script = document.createElement('script');
    script.id = 'gs-yt-bridge';
    script.textContent = [
      '(function(){',
      '  if (window.__gsYtBridge) return; window.__gsYtBridge = true;',
      '  var sentForVideoId = "__none__";',
      '  var lastCaptionUrl = "";',
      '  function slimPlayerResponse(pr){',
      '    try {',
      '      if (!pr) return null;',
      '      var vd = pr.videoDetails || {};',
      '      var tracks = [];',
      '      try {',
      '        var list = pr.captions.playerCaptionsTracklistRenderer.captionTracks;',
      '        if (Array.isArray(list)) tracks = list.map(function(t){',
      '          return { baseUrl: t.baseUrl || "", languageCode: t.languageCode || "", kind: t.kind || "", name: (t.name && t.name.simpleText) || "" };',
      '        });',
      '      } catch(e) {}',
      '      return { videoDetails: { videoId: vd.videoId || "", title: vd.title || "", lengthSeconds: vd.lengthSeconds || "" }, captions: { playerCaptionsTracklistRenderer: { captionTracks: tracks } } };',
      '    } catch(e) { return null; }',
      '  }',
      '  function currentVideoId(){',
      '    try { return new URLSearchParams(location.search).get("v") || ""; } catch(e) { return ""; }',
      '  }',
      '  function sendPlayerResponse(force){',
      '    try {',
      '      var pr = window.ytInitialPlayerResponse;',
      '      var slim = slimPlayerResponse(pr);',
      '      if (!slim) return;',
      '      var vid = slim.videoDetails.videoId || currentVideoId();',
      '      if (!force && vid && vid === sentForVideoId) return;',
      '      sentForVideoId = vid;',
      '      window.postMessage({type:"gs-yt-player-response", playerResponse: JSON.stringify(slim)}, "*");',
      '    } catch(e) {}',
      '  }',
      '  var origOpen = XMLHttpRequest.prototype.open;',
      '  XMLHttpRequest.prototype.open = function(method, url){',
      '    try {',
      '      if (url && String(url).indexOf("timedtext") !== -1) {',
      '        var u = String(url);',
      '        if (u !== lastCaptionUrl) {',
      '          lastCaptionUrl = u;',
      '          window.postMessage({type:"gs-yt-caption-url", url:u}, "*");',
      '          sendPlayerResponse(false);',
      '        }',
      '      }',
      '    } catch(e) {}',
      '    return origOpen.apply(this, arguments);',
      '  };',
      '  window.addEventListener("message", function(ev){',
      '    if (ev.source === window && ev.data && ev.data.type === "gs-yt-ping") sendPlayerResponse(true);',
      '  });',
      '  sendPlayerResponse(false);',
      '  setTimeout(function(){ sendPlayerResponse(false); }, 1200);',
      '  setTimeout(function(){ sendPlayerResponse(false); }, 3000);',
      '})();'
    ].join('\n');
    root.appendChild(script);
    script.remove();
    return true;
  }

  if (!inject()) {
    document.addEventListener('DOMContentLoaded', inject, { once: true });
  }
})();
