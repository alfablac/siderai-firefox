# Vendored dependencies

This directory holds third-party libraries bundled with the Graphite Sider
extension. Nothing is vendored yet — the extension currently ships with no
external runtime dependencies:

- Content scripts (`content/content.js`, `content/youtube.js`,
  `content/search.js`) are plain, dependency-free JavaScript.
- Readability-style page extraction is implemented inline
  ("readability-lite" in `content/content.js`): clone the document, strip
  `script/style/nav/footer/aside`, prefer `article/main`, truncate.
- YouTube transcript capture is implemented inline in
  `content/youtube.js` (page-context XHR hook for `timedtext` URLs plus
  `ytInitialPlayerResponse.captionTracks`), no external library needed.
- Markdown rendering is a small escaped "markdown-lite" renderer in each
  content script (no DOMPurify/marked bundle).

## Adding a vendored library

If a dependency is introduced later:

1. Drop the **unmodified** distribution file(s) in this directory.
2. Record in the table below: name, version, upstream URL, license.
3. Reference it from `manifest.json` (`web_accessible_resources` /
   content-script `js` arrays) before use — content scripts cannot load
   files that are not declared.
4. Keep licenses intact. Prefer permissively licensed (MIT/BSD/Apache-2.0)
   single-file builds that work without a bundler in Firefox.

| Library | Version | Upstream | License |
| ------- | ------- | -------- | ------- |
| _(none)_ | | | |
