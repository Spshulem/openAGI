import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ToolRegistry } from "../src/tool-registry.js";
import { ComputerUseLog } from "../src/computer-use-log.js";
import { registerComputerUseTools } from "../src/integrations/computer-use.js";

for (const cancelDuring of ["session.start", "type", "screenshot"]) {
  test(`G2 request cancellation during ${cancelDuring} revokes only its approved desktop session`, async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-g2-control-stop-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const tools = new ToolRegistry();
    const log = new ComputerUseLog({ dir });
    const session = log.startSession({ goal: "Test scratch document", approvedBy: "user",
      sourceSessionId: "node:test-g2:conversation:main", targetNodeId: "mac-target", capability: "computer-use" });
    const other = log.startSession({ goal: "Other task", approvedBy: "user",
      sourceSessionId: "chat:other", targetNodeId: "mac-other", capability: "computer-use" });
    const calls = [], cancelled = [];
    let reached, finish;
    const started = new Promise(resolve => { reached = resolve; });
    const pending = new Promise(resolve => { finish = resolve; });
    const record = { nodeId: "mac-target", name: "Target Mac", local: true,
      capabilities: [{ id: "computer-use", ready: true,
        operations: ["session.start", "session.end", "screenshot", "click", "move", "type", "key", "scroll"] }] };
    const runtime = { tools, computerUseLog: log, observations: { search: async () => [] },
      nodeCapabilities: {
        resolve: (_cap, selector = {}) => !selector.nodeId || selector.nodeId === record.nodeId ? record : null,
        list: () => [record], refresh: async () => [record],
        cancelSession: id => { cancelled.push(id); finish(); },
        dispatch: async (node, _cap, operation) => {
          calls.push({ node, operation });
          if (operation === cancelDuring) { reached(); await pending; }
          if (operation === "session.start") return { leaseId: "test-lease", nextSequence: 1 };
          return { ok: true, frameId: "test-frame", width: 100, height: 100, bytes: 20 };
        }
      } };
    registerComputerUseTools(tools, runtime);
    const controller = new AbortController();
    const context = { sessionId: session.sourceSessionId, channel: "g2", signal: controller.signal };
    const work = tools.invoke(cancelDuring === "screenshot" ? "computer_screenshot" : "computer_type",
      cancelDuring === "screenshot" ? {} : { text: "scratch", frameId: "test-frame" }, context);
    await Promise.race([started, work.then(() => { throw new Error("tool ended before dispatch"); })]);
    controller.abort();
    const result = await work;
    assert.equal(result.ok, false, "late node success is not accepted after cancellation");
    assert.equal(log.getSession(session.id).status, "aborted");
    assert.equal(log.getSession(other.id).status, "active");
    assert.ok(cancelled.includes(session.id));
    assert.ok(cancelled.every(id => id === session.id));
    assert.ok(calls.every(call => call.node === "mac-target"));
    assert.ok(calls.some(call => call.operation === "session.end"));
    if (cancelDuring === "session.start") assert.equal(calls.some(call => call.operation === "type"), false);
  });
}
