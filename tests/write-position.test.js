"use strict";
// Run with node tests/write-position.test.js.
const assert = require("assert");
const fs = require("fs");
const vm = require("vm");
const source = fs.readFileSync(require("path").join(__dirname, "../extension/content/content.js"), "utf8");
const functions = source.slice(source.indexOf("  function hideWriteButton()"), source.indexOf("  function fieldText(el)"));
const resize = source.slice(source.indexOf("  window.addEventListener('resize', () => {", source.indexOf("document.addEventListener('focusout', onFocusOut")), source.indexOf("  document.addEventListener('scroll',", source.indexOf("document.addEventListener('focusout', onFocusOut")));
let timer, resizeHandler, observer;
const hidden = new Set();
const btn = { style: {}, classList: { add: x => hidden.add(x), remove: x => hidden.delete(x), contains: x => hidden.has(x) } };
const field = { isConnected: true, getBoundingClientRect: () => ({ width: 300, height: 40, right: right, bottom: 100, top: 60 }) };
let right = 300;
const context = { activeField: field, settings: {}, qs: selector => selector.includes('write-btn') ? btn : null,
  clampRect: (left, top) => ({ left, top }), window: { innerHeight: 800, addEventListener: (_, fn) => { resizeHandler = fn; } },
  setTimeout: fn => { timer = fn; return 1; }, clearTimeout: () => { timer = null; },
  ResizeObserver: class { constructor(fn) { this.fn = fn; observer = this; } observe() {} disconnect() {} } };
vm.createContext(context);
vm.runInContext("let writeButtonTimer = null, writeFieldObserver = null, observedWriteField = null;\n" + functions + resize, context);
vm.runInContext("scheduleWriteButton(activeField)", context);
timer();
assert.strictEqual(btn.style.left, "268px");
right = 500;
resizeHandler();
timer();
assert.strictEqual(btn.style.left, "468px", "viewport resize moves the button");
right = 600;
observer.fn();
timer();
assert.strictEqual(btn.style.left, "568px", "field resize moves the button");
vm.runInContext("hideWriteButton()", context);
resizeHandler();
assert.strictEqual(timer, null, "resize does not resurrect a hidden button");
console.log("ok - writing button follows viewport and field resizing");
