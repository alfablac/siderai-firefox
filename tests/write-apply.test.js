const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('extension/content/content.js', 'utf8');
const code = source.slice(source.indexOf('  function applyToField('), source.indexOf('  function onFocusIn('));
const apply = vm.runInNewContext('(' + code.trim() + ')', { Event: class {} });
function field(value, start, end) {
  return { value, selectionStart: start, selectionEnd: end, focus() {}, dispatchEvent() {}, setRangeText(text, a, b) { this.value = this.value.slice(0, a) + text + this.value.slice(b); this.selectionStart = this.selectionEnd = a + text.length; } };
}
const selected = field('before old after', 7, 10);
const snapshot = { start: 7, end: 10 };
apply(selected, 'new text', 'improve', snapshot, true);
apply(selected, 'new text', 'improve', snapshot, true);
assert.equal(selected.value, 'before new text after');
const full = field('old text', 3, 3);
apply(full, 'replacement', 'rewrite', { start: 3, end: 3 }, false);
apply(full, 'replacement', 'rewrite', { start: 3, end: 3 }, false);
assert.equal(full.value, 'replacement');
assert.doesNotMatch(source, /button\.textContent = 'Applied';\s*button\.disabled = true/);
