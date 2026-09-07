import test from "node:test";
import assert from "node:assert/strict";
import { createOpenComputerUseExecutor, parseOcuState, ocuAction, parseOcuPermissions } from "../src/integrations/open-computer-use-executor.js";
import { createConfiguredComputerExecutor } from "../src/integrations/cua-computer-executor.js";
import { verifyOcuArchive } from "../scripts/install-open-computer-use.mjs";

const focus = { windowID: 7, processIdentifier: 42, bundleIdentifier: "org.test.editor", title: "Test", x: 0, y: 0, width: 200, height: 100 };
const png = Buffer.alloc(24); Buffer.from("89504e470d0a1a0a", "hex").copy(png); png.writeUInt32BE(100, 16); png.writeUInt32BE(50, 20);
const state = () => ({ isError: false, content: [{ type: "text", text: 'App=org.test.editor (pid 42)\nWindow: "Test", App: Editor.\n8 text field ID: input\n' }, { type: "image", mimeType: "image/png", data: png.toString("base64") }] });
function fixture() {
  const calls = []; let current = { ...focus };
  const executor = createOpenComputerUseExecutor({ binaryPath: "/test/engine", helperPath: "/test/helper", binaryReady: () => true,
    permissionProbe: async () => ({ accessibility: true, screenRecording: true }),
    transportFactory: () => ({ close() {}, async call(name, args) { calls.push({ name, args }); return name === "get_app_state" ? state() : { isError: false, content: [] }; } }),
    helperRun: async (_path, op, payload) => {
      calls.push({ native: op, payload });
      return { stdout: Buffer.from(JSON.stringify(op === "status" ? { inputReady: true, screenshotReady: true } : { focus: current })) };
    } });
  return { executor, calls, changeFocus() { current = { ...focus, windowID: 8 }; } };
}
async function lease(e) { return e.invoke("session.start", { sessionId: "test", goalHash: "a".repeat(64) }); }
const invoke = (e, l, sequence, operation, payload = {}) => e.invoke(operation, { leaseId: l.leaseId, actionId: `a${sequence}`, sequence, ...payload });

test("upstream state binds exact app and remaps sparse element IDs", () => {
  const parsed = parseOcuState(state(), focus);
  assert.equal(parsed.width, 100); assert.equal(parsed.elements[0].upstreamId, "8");
  assert.match(parsed.accessibility, /0 text field/);
  assert.throws(() => parseOcuState(state(), { ...focus, processIdentifier: 44 }), /approved app/);
  const invalid = state(); invalid.content.pop();
  assert.throws(() => parseOcuState(invalid, focus), /PNG/);
  const spoofed = state();
  spoofed.content[0].text = 'App=org.test.editor (pid 42)\nWindow: "Private", App: Editor.\n0 text Window: "Test", App: Editor.';
  assert.throws(() => parseOcuState(spoofed, focus), /approved app/);
});

test("permission readiness is fail closed, including unrecognized doctor output", async t => {
  assert.deepEqual(parseOcuPermissions("Permissions: accessibility=granted, screenRecording=granted\n"),
    { accessibility: true, screenRecording: true });
  for (const output of ["", "grant accessibility and screenRecording", "Permissions: accessibility=denied, screenRecording=granted"]) {
    assert.equal(parseOcuPermissions(output).accessibility, false);
  }
  const e = createOpenComputerUseExecutor({ binaryPath: "/test/engine", helperPath: "/test/helper", binaryReady: () => true,
    permissionProbe: async () => ({ accessibility: false, screenRecording: true }),
    helperRun: async () => ({ stdout: JSON.stringify({ inputReady: true, screenshotReady: true, capturePrerequisitesReady: true }) }) });
  t.after(() => e.close());
  const health = await e.health();
  assert.equal(health.capability.ready, false);
  assert.equal(health.capability.inputReady, false);
  assert.equal(health.capability.capturePrerequisitesReady, false);
  assert.match(health.capability.detail, /Pairing is unchanged/);
});
test("leases, fresh frames, upstream pixels, and captured element IDs remain bound", async t => {
  const { executor: e, calls } = fixture(); t.after(() => e.close());
  await assert.rejects(() => e.invoke("type", { text: "no" }), /lease|stale/);
  const l = await lease(e);
  const shot = await invoke(e, l, 1, "screenshot");
  await invoke(e, l, 2, "click", { frameId: shot.frameId, x: 20, y: 10, button: "left" });
  assert.deepEqual(calls.find(c => c.name === "click").args, { app: focus.bundleIdentifier, x: 20, y: 10, mouse_button: "left", click_count: 1, click_method: "app_post" });
  await assert.rejects(() => invoke(e, l, 3, "type", { frameId: shot.frameId, text: "stale" }), /stale/);
  const next = await invoke(e, l, 3, "screenshot");
  await invoke(e, l, 4, "set_value", { frameId: next.frameId, elementIndex: 0, text: "hello" });
  assert.equal(calls.find(c => c.name === "set_value").args.element_index, "8");
});
test("changed window prevents input and ending the lease invalidates state", async t => {
  const { executor: e, calls, changeFocus } = fixture(); t.after(() => e.close());
  const l = await lease(e), shot = await invoke(e, l, 1, "screenshot"); changeFocus();
  await assert.rejects(() => invoke(e, l, 2, "type", { frameId: shot.frameId, text: "no" }), /action failed/);
  assert.equal(calls.some(c => c.name === "type_text"), false);
  await invoke(e, l, 3, "session.end");
  await assert.rejects(() => invoke(e, l, 4, "screenshot"), /lease/);
});
test("missing engine fails closed and selecting the backend does not alter native default", async t => {
  const e = createConfiguredComputerExecutor({ env: { OPENAGI_COMPUTER_BACKEND: "open-computer-use" } }); t.after(() => e.close());
  assert.equal((await e.health()).capability.ready, false);
});
test("unsupported operations and archive substitutions are refused", () => {
  assert.throws(() => ocuAction("paste", {}), /Unsupported/);
  assert.throws(() => ocuAction("set_value", { locator: {} }), /element/);
  assert.throws(() => verifyOcuArchive(Buffer.from("substitution")), /integrity/);
  assert.equal(ocuAction("key", { chord: "cmd+shift+enter" }).args.key, "super+shift+Return");
});
