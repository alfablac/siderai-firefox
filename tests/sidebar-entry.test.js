"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const root = path.join(__dirname, "..", "extension");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const source = fs.readFileSync(path.join(root, "background.js"), "utf8");
assert.strictEqual(manifest.commands["open-sidebar"].suggested_key.default, "Ctrl+Q");
let opened = 0;
const context = vm.createContext({
  ext: { sidebarAction: { open() { opened++; return Promise.resolve(); } } },
  MENU: { OPEN_SIDEBAR: "open" }, menusApi: { onClicked: { addListener(fn) { this.listener = fn; } } },
  openSidebarNative() { opened++; return Promise.resolve(); }
});
const menuStart = source.indexOf("if (menusApi && menusApi.onClicked)");
vm.runInContext(source.slice(menuStart, source.indexOf("if (ext.runtime && ext.runtime.onInstalled)", menuStart)), context);
context.menusApi.onClicked.listener({ menuItemId: "open" }, {});
assert.strictEqual(opened, 1, "context menu opens synchronously without async settings work");
context.ext.sidebarAction.toggle = function () { opened++; return Promise.resolve(); };
context.ext.commands = { onCommand: { addListener(fn) { this.listener = fn; } } };
const commandStart = source.indexOf("if (ext.commands && ext.commands.onCommand)");
vm.runInContext(source.slice(commandStart, source.indexOf("function queryActiveTab()", commandStart)), context);
context.ext.commands.onCommand.listener("open-sidebar");
assert.strictEqual(opened, 2, "shortcut opens synchronously without async settings work");
context.ext.commands.onCommand.listener("open-sidebar");
assert.strictEqual(opened, 3, "repeated shortcut uses the native toggle");
context.openSidebarNative = function () { throw new Error("shortcut must toggle, not open"); };
context.ext.commands.onCommand.listener("open-sidebar");
assert.strictEqual(opened, 4);
const start = source.indexOf("    case 'openSidebarWith':");
const end = source.indexOf("    case 'clearHistory':", start);
let pending;
context.msg = { action: "search-answer", text: "Saved text", response: true, prompt: "Question" };
context.sender = { tab: { id: 42 } };
context.tryFloatPanel = async (command, force, tabId) => {
  assert.strictEqual(command, 'showFloatPanel');
  assert.strictEqual(force, true, 'button must bypass the floating-panel setting');
  assert.strictEqual(tabId, 42, 'open in the originating tab');
  return false;
};
context.GraphiteStorage = { async setPendingAction(action) { pending = action; } };
context.ext.runtime = { async sendMessage() {} };
context.openChatTab = () => { throw new Error("queued action must not open a tab"); };
vm.runInContext("async function queue() { switch ('openSidebarWith') {" + source.slice(start, end) + "} }", context);
context.queue().then(result => {
  assert.strictEqual(result.queued, true);
  assert.strictEqual(result.opened, false);
  assert.strictEqual(pending.text, "Saved text");
  assert.strictEqual(pending.surface, "native");
  context.tryFloatPanel = async () => true;
  return context.queue();
}).then(result => {
  assert.strictEqual(result.opened, true);
  assert.strictEqual(pending.surface, "float");
  assert.strictEqual(pending.response, true);
  const sidebar = fs.readFileSync(path.join(root, 'sidebar/sidebar.js'), 'utf8');
  let conversation;
  const responseContext = vm.createContext({
    stopGeneration() {}, uid: () => 'test-chat',
    loadConversation(chat) { conversation = chat; }, persistConversation() {}
  });
  const handler = sidebar.slice(sidebar.indexOf('  function handlePendingAction(action)'), sidebar.indexOf('  function checkPendingAction()'));
  vm.runInContext(handler, responseContext);
  responseContext.handlePendingAction(pending);
  assert.strictEqual(conversation.messages[0].content, 'Question');
  assert.strictEqual(conversation.messages[1].role, 'assistant');
  assert.strictEqual(conversation.messages[1].content, 'Saved text');
  console.log("ok - content action queues without a tab fallback");
}).catch(error => { console.error(error); process.exitCode = 1; });
console.log("ok - native sidebar context menu and configurable shortcut");
const content = fs.readFileSync(path.join(root, 'content/content.js'), 'utf8');
const directStart = content.indexOf('  globalThis.GraphiteOpenFloatingChat =');
const directEnd = content.indexOf('  function openSidebarWith', directStart);
const events = [];
const direct = vm.createContext({
  async showFloatPanel() { events.push('float'); },
  runtime: { async sendMessage(message) {
    assert.strictEqual(message.floatingOpened, true);
    events.push('send');
    return { ok: true };
  } }
});
vm.runInContext(content.slice(directStart, directEnd), direct);
direct.GraphiteOpenFloatingChat({ text: 'Existing response' }).then(() => {
  assert.deepStrictEqual(events, ['float', 'send']);
  console.log('ok - response click opens the panel locally before background messaging');
}).catch(error => { console.error(error); process.exitCode = 1; });
