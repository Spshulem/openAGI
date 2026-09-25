import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const computerUse = fs.readFileSync(new URL("../src/integrations/computer-use.js", import.meta.url), "utf8");
const hosted = fs.readFileSync(new URL("../src/hosted-interface.js", import.meta.url), "utf8");
const kwinScript = fs.readFileSync(new URL("../linux/kwin/contents/code/main.js", import.meta.url), "utf8");

function signal() {
  const handlers = new Set();
  return {
    connect(handler) { handlers.add(handler); },
    disconnect(handler) { handlers.delete(handler); },
    emit(value) { for (const handler of [...handlers]) handler(value); },
    get size() { return handlers.size; }
  };
}

test("computer-use user-facing copy is platform-neutral for Linux companions", () => {
  assert.doesNotMatch(computerUse, /a Mac running `openagi computer-server`/);
  assert.doesNotMatch(computerUse, /specific Mac/);
  assert.doesNotMatch(computerUse, /selected Mac/);
  assert.doesNotMatch(hosted, /name: localIdentity\.name \|\| "This Mac"/);
  assert.match(computerUse, /capture and input permissions/i);
  assert.match(hosted, /name: localIdentity\.name \|\| "This computer"/);
});

test("KWin bridge invalidates null focus and does not accumulate window callbacks", () => {
  const reports = [];
  const activated = signal();
  const captionChanged = signal();
  const frameGeometryChanged = signal();
  const window = {
    internalId: "window-1", pid: 42, caption: "Editor", desktopFileName: "org.example.Editor",
    resourceClass: "editor", resourceName: "editor", frameGeometry: { x: 0, y: 0, width: 800, height: 600 },
    output: { name: "DP-1" }, fullScreen: false, minimized: false, specialWindow: false,
    captionChanged, frameGeometryChanged
  };
  const workspace = { activeWindow: window, windowActivated: activated };
  vm.runInNewContext(kwinScript, {
    workspace,
    callDBus(_service, _path, _interface, member, payload) { reports.push([member, payload]); },
    registerShortcut() {}
  });

  workspace.activeWindow = null;
  activated.emit(null);
  assert.equal(reports.at(-1)[1], "null");
  assert.equal(captionChanged.size, 0);
  assert.equal(frameGeometryChanged.size, 0);

  workspace.activeWindow = window;
  activated.emit(window);
  activated.emit(window);
  assert.equal(captionChanged.size, 1);
  assert.equal(frameGeometryChanged.size, 1);
});
