import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDurableRuntime, createHostedInterface } from "../src/index.js";
import { registerComputerUseTools } from "../src/integrations/computer-use.js";
import { ToolRegistry } from "../src/tool-registry.js";
import { PendingActionStore } from "../src/pending-actions.js";
import { ComputerUseLog } from "../src/computer-use-log.js";

async function until(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for approval continuation");
}

async function appWithComputerUse() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-computer-approval-"));
  const runtime = createDurableRuntime({ dataDir });
  registerComputerUseTools(runtime.tools, runtime);
  const generatedRequests = [];
  runtime.agentHost.modelProvider = {
    name: "approval-test-provider",
    model: "test-model",
    isConfigured: () => true,
    async generate(request) {
      generatedRequests.push(request);
      return {
        id: "approval_followup",
        text: "Approval received; continuing the approved computer-use session.",
        provider: "test",
        model: "test-model",
        toolCalls: []
      };
    }
  };
  const app = createHostedInterface(runtime, {
    host: "127.0.0.1",
    port: 0,
    authToken: "",
    dataDir,
    tickerMs: 60_000,
    nodeControlEnabled: true,
    computerExecutor: {
      async health() {
        return { capability: {
          id: "computer-use", ready: true,
          operations: ["session.start", "session.end", "screenshot", "click", "move", "type", "key", "scroll"]
        } };
      },
      async invoke(operation) {
        if (operation === "session.start") return { leaseId: "test-lease", nextSequence: 1 };
        return { ok: true };
      }
    }
  });
  const address = await app.listen();
  return { runtime, app, base: address.url, dataDir, generatedRequests };
}

test("computer-use approval deduplicates requests, starts once, and resumes the original chat", async () => {
  const previousComputerHops = process.env.OPENAGI_COMPUTER_MAX_TOOL_HOPS;
  delete process.env.OPENAGI_COMPUTER_MAX_TOOL_HOPS;
  const { runtime, app, base, dataDir, generatedRequests } = await appWithComputerUse();
  const context = {
    sessionId: "local:approval-test:main",
    channel: "local",
    from: "approval-test",
    agentId: "main",
    origin: "autopilot"
  };

  try {
    const first = await runtime.tools.invoke("start_computer_use_session", {
      goal: "Configure the RSVP sheet"
    }, context);
    const repeated = await runtime.tools.invoke("start_computer_use_session", {
      goal: "Configure that RSVP Google Sheet"
    }, context);

    assert.equal(first.result.status, "awaiting_confirmation");
    assert.equal(repeated.result.actionId, first.result.actionId, "same chat gets one durable approval request");
    assert.equal(runtime.pendingActions.list({ status: "pending" }).filter((a) => a.toolName === "start_computer_use_session").length, 1);
    const waitingStatus = await runtime.tools.invoke("computer_use_status", {}, context);
    assert.equal(waitingStatus.result.active, false);
    assert.equal(waitingStatus.result.awaitingApproval, true);
    assert.equal(waitingStatus.result.pendingActionId, first.result.actionId);

    const response = await fetch(`${base}/pending-actions/${encodeURIComponent(first.result.actionId)}/approve`, {
      method: "POST"
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.deepEqual(body.continuation, { status: "queued", sessionId: context.sessionId });

    const active = runtime.computerUseLog.listSessions({ status: "active" });
    assert.equal(active.length, 1, "approval starts exactly one session");
    assert.equal(active[0].approvalActionId, first.result.actionId);
    assert.equal(active[0].sourceSessionId, context.sessionId);
    const approvedOutcome = runtime.outcomes.recent(20).find((outcome) =>
      outcome.metadata?.approvalActionId === first.result.actionId
    );
    assert.ok(approvedOutcome, "the action is measured only after confirmed execution");
    assert.equal(approvedOutcome.kind, "autopilot-fire");
    assert.equal(approvedOutcome.sessionId, context.sessionId);
    assert.deepEqual(approvedOutcome.toolCalls, [{ name: "start_computer_use_session", ok: true }]);
    const activeStatus = await runtime.tools.invoke("computer_use_status", {}, context);
    assert.equal(activeStatus.result.active, true);
    assert.equal(activeStatus.result.session.id, active[0].id);

    const session = await until(() => {
      const current = runtime.agentHost.store.getSession(context.sessionId);
      return current?.messages?.length >= 2 ? current : null;
    });
    assert.equal(session.messages[0].metadata.runtimeEvent, "approval");
    assert.equal(session.messages[0].metadata.approvalActionId, first.result.actionId);
    assert.match(session.messages[1].content, /Approval received/);
    assert.equal(generatedRequests.at(-1)?.maxToolHops, 24,
      "an approved computer session gets enough bounded screenshot/action rounds to finish useful work");

    const afterApproval = await runtime.tools.invoke("start_computer_use_session", {
      goal: "Configure the RSVP sheet"
    }, context);
    assert.equal(afterApproval.ok, true);
    assert.equal(afterApproval.result.alreadyActive, true);
    assert.equal(afterApproval.result.sessionId, active[0].id);
    assert.equal(runtime.computerUseLog.listSessions({ status: "active" }).length, 1);
    assert.equal(runtime.pendingActions.list({ status: "pending" }).filter((a) => a.toolName === "start_computer_use_session").length, 0);
  } finally {
    if (previousComputerHops === undefined) delete process.env.OPENAGI_COMPUTER_MAX_TOOL_HOPS;
    else process.env.OPENAGI_COMPUTER_MAX_TOOL_HOPS = previousComputerHops;
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("dashboard exposes a durable Approvals tab and computer-use approval surface", () => {
  const source = fs.readFileSync(new URL("../src/hosted-interface.js", import.meta.url), "utf8");
  assert.match(source, /data-tab="approvals"[^>]*>Approvals/);
  assert.match(source, /async function renderApprovals\(/);
  assert.match(source, /Computer-use requests awaiting approval/);
  assert.match(source, /pending-action-resolved/);
});

test("computer-use approval stores an immutable target and refuses cross-goal reuse", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-computer-binding-"));
  const tools = new ToolRegistry();
  const pendingActions = new PendingActionStore({ dir: path.join(dataDir, "pending") });
  tools.bindPendingActions(pendingActions);
  const runtime = {
    tools,
    pendingActions,
    computerUseLog: new ComputerUseLog({ dir: path.join(dataDir, "computer-use") }),
    observations: { search: async () => [] }
  };
  const record = {
    nodeId: "node-approved", name: "Work Mac", local: true,
    capabilities: [{ id: "computer-use", ready: true, operations: ["session.start", "screenshot"] }]
  };
  runtime.nodeCapabilities = {
    refresh: async () => [record],
    list: () => [record],
    resolve: (_id, selector = {}) => !selector.nodeId || selector.nodeId === record.nodeId ? record : null,
    dispatch: async (_node, _capability, operation) => operation === "session.start"
      ? { leaseId: "lease-approved", nextSequence: 1 }
      : { ok: true }
  };
  registerComputerUseTools(runtime.tools, runtime);
  const context = { sessionId: "chat:binding", channel: "local", from: "user" };
  try {
    const queued = await runtime.tools.invoke("start_computer_use_session", { goal: "Prepare the report" }, context);
    assert.equal(queued.result.status, "awaiting_confirmation");
    const pending = runtime.pendingActions.get(queued.result.actionId);
    assert.equal(pending.args.nodeId, "node-approved");
    assert.equal(pending.args.nodeName, "Work Mac");
    assert.match(pending.summary, /Work Mac/);
    const approved = await runtime.tools.invoke(pending.toolName, pending.args, { ...context, __confirmed: true });
    assert.equal(approved.ok, true);
    const changed = await runtime.tools.invoke("start_computer_use_session", { goal: "Delete unrelated files" }, context);
    assert.equal(changed.ok, false);
    assert.match(changed.error, /different goal or node|End that session/);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("concurrent approval surfaces claim a side effect exactly once", async () => {
  const { runtime, app, base, dataDir } = await appWithComputerUse();
  let runs = 0;
  runtime.tools.register({
    name: "approval_race_test",
    sideEffects: true,
    needsConfirmation: true,
    parameters: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => {
      runs += 1;
      await new Promise((resolve) => setTimeout(resolve, 40));
      return { executed: true };
    }
  });

  try {
    const queued = await runtime.tools.invoke("approval_race_test", {}, {
      sessionId: "autopilot:approval-race",
      channel: "autopilot",
      from: "autopilot",
      agentId: "main",
      origin: "autopilot"
    });
    const id = queued.result.actionId;
    const approve = () => fetch(`${base}/pending-actions/${encodeURIComponent(id)}/approve`, { method: "POST" });
    const responses = await Promise.all([approve(), approve()]);

    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
    assert.equal(runs, 1, "the approved handler executes once even when two surfaces race");
    assert.equal(runtime.outcomes.recent(20).filter((outcome) =>
      outcome.metadata?.approvalActionId === id
    ).length, 1, "the confirmed action creates one outcome");
    assert.equal(runtime.pendingActions.get(id).status, "approved");
  } finally {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
