const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const css = fs.readFileSync(path.join(__dirname, '../extension/content/overlay.css'), 'utf8');
assert.match(css, /\.gs-write-btn\s*\{[^}]*opacity:\s*var\(--gs-write-icon-opacity, 0\.68\)\s*;/);
assert.match(css, /\.gs-write-menu\s*\{[^}]*opacity:\s*var\(--gs-write-menu-opacity, 1\)\s*;/);
assert.match(css, /\.gs-write-btn:hover\s*,\s*\.gs-write-btn:focus\s*,\s*\.gs-write-btn:focus-visible\s*\{[^}]*opacity:\s*1\s*;/);
