import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ComputerUseLog } from "../src/computer-use-log.js";
import { createComputerExecutor, runComputerHelper } from "../src/integrations/computer-server.js";
import { registerComputerUseTools } from "../src/integrations/computer-use.js";
import { createNodeControlWorker, NodeControlBroker } from "../src/node-control.js";
import { ToolRegistry } from "../src/tool-registry.js";

test("the screenshot relay recovers from a focus race in the same lease, but stops on an unknown failure", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-capture-recovery-"));
  const helper = path.join(dir, "test-helper");
  fs.writeFileSync(helper, "#!/bin/sh\nprintf 'private helper diagnostics' >&2\nexit 75\n", { mode: 0o700 });
  const broker = new NodeControlBroker({ commandTimeoutMs: 2_000 });
  const nodeId = "fixture-node";
  let capture = "focus-lost";
  const focus = { windowID: 1, processIdentifier: 2, bundleIdentifier: "com.example.Editor",
    title: "Fixture", x: 0, y: 0, width: 400, height: 200 };
  const executor = createComputerExecutor({
    helperPath: helper,
    capabilityStatus: async () => ({ screenshotReady: true, inputReady: true,
      operations: ["click", "move", "type", "key", "scroll"], capturePrerequisitesReady: true }),
    async helperRun(file, operation, payload, opts) {
      assert.equal(operation, "screenshot");
      if (capture === "focus-lost") return runComputerHelper(file, operation, payload, opts);
      if (capture === "unknown-failure") throw new Error("private unknown error");
      return { stdout: JSON.stringify({ format: "png", base64: "aW1hZ2U=", width: 400, height: 200,
        focus, elements: [], accessibility: "", bytes: 5 }) };
    }
  });
  const commands = [];
  const errors = [];
  const capabilities = async () => [(await executor.health()).capability];
  const worker = createNodeControlWorker({
    remote: "https://fixture.example.test", token: "fixture", nodeId, capabilities, pollMs: 100, retryMs: 5,
    execute(command) {
      commands.push(command);
      return executor.invoke(command.operation, command.payload);
    },
    async fetchImpl(url, { body }) {
      const data = JSON.parse(body);
      if (url.endsWith("/poll")) {
        return Response.json({ command: await broker.poll(nodeId, data.capabilities, { timeoutMs: 25 }) });
      }
      if (data.error) errors.push(data.error);
      return Response.json({ ok: broker.deliver(nodeId, data.commandId, data) });
    }
  });
  t.after(async () => {
    broker.close();
    await worker.stop();
    await executor.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  broker.advertise(nodeId, await capabilities());
  worker.start();

  const tools = new ToolRegistry();
  const computerUseLog = new ComputerUseLog({ dir });
  registerComputerUseTools(tools, { computerUseLog, nodeCapabilities: broker });
  const context = { sessionId: "fixture-chat" };
  const approved = computerUseLog.startSession({ goal: "Inspect the editor", sourceSessionId: context.sessionId, targetNodeId: nodeId });
  const screenshot = () => tools.get("computer_screenshot").handler({}, context);
  const refused = await screenshot();
  assert.equal(refused.ok, false);
  assert.equal(refused.error, "computer-screenshot-focus-unavailable");
  assert.equal(refused.image, undefined);
  assert.equal(refused.frameId, undefined);
  assert.equal(computerUseLog.activeSessionFor(context.sessionId)?.id, approved.id);
  assert.equal(computerUseLog.listActions()[0].status, "failed");
  assert.deepEqual(errors, ["computer-screenshot-focus-unavailable"]);

  capture = "ready";
  const fresh = await screenshot();
  assert.equal(fresh.image, "aW1hZ2U=");
  assert.deepEqual(commands.map(c => c.operation), ["session.start", "screenshot", "screenshot"]);
  assert.deepEqual(commands.slice(1).map(c => c.payload.sequence), [1, 2]);
  assert.equal(commands[2].payload.leaseId, commands[1].payload.leaseId);
  assert.ok(commands.every(c => c.nodeId === nodeId));

  capture = "unknown-failure";
  await assert.rejects(screenshot, /node-capability-command-failed/);
  assert.equal(computerUseLog.getSession(approved.id).status, "aborted");
  assert.equal(commands.at(-1).operation, "session.end");
  assert.equal(errors.at(-1), "node-capability-command-failed");
});
