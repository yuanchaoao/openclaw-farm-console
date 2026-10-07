import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// Exercise the real rendering functions with element stand-ins. No browser,
// network, stored credentials or remote instance is involved.
const source = readFileSync(new URL("../console/public/app.js", import.meta.url), "utf8");
const renderers = source.slice(source.indexOf("function renderContext()"), source.indexOf("function appendMessageElement("));
test("fresh installation renders registration rather than dereferencing an absent instance", () => {
  const elements = Object.fromEntries(["renameButton", "resetButton", "currentInstance", "currentInstanceId", "currentStatus", "openConsole", "bridgeStatus", "bridgeDetail", "threadTurns", "input", "sendButton", "chatFeed"].map(k => [k, {}]));
  const context = vm.createContext({ elements, activeInstance: () => undefined, state: { instances: [], histories: {} } });
  vm.runInContext(renderers + "\nrenderContext(); renderMessages();", context);
  assert.equal(elements.currentInstance.textContent, "尚未登记实例");
  assert.equal(elements.input.disabled, true);
  assert.equal(elements.sendButton.disabled, true);
  assert.match(elements.chatFeed.innerHTML, /connections.html/);
});
