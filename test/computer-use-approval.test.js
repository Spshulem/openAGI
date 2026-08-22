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

async function appWithComputerUse({ dataDir: suppliedDataDir = null, generate = null } = {}) {
  const dataDir = suppliedDataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "openagi-computer-approval-"));
  const runtime = createDurableRuntime({ dataDir });
  registerComputerUseTools(runtime.tools, runtime);
  const generatedRequests = [];
  runtime.agentHost.modelProvider = {
    name: "approval-test-provider",
    model: "test-model",
    isConfigured: () => true,
    async generate(request) {
      generatedRequests.push(request);
      if (generate) return await generate(request, generatedRequests.length);
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

test("a transient approval continuation failure retries without requiring another approval", async () => {
  let calls = 0;
  const { runtime, app, base, dataDir } = await appWithComputerUse({
    generate: async () => {
      calls += 1;
      if (calls === 1) throw new Error("transient provider outage");
      return {
        id: "approval_retry_success",
        text: "The approved session resumed.",
        provider: "test",
        model: "test-model",
        toolCalls: []
      };
    }
  });
  try {
    const queued = await runtime.tools.invoke("start_computer_use_session", {
      goal: "Continue after a transient provider failure"
    }, {
      sessionId: "local:approval-retry:main",
      channel: "local",
      from: "user",
      agentId: "main"
    });
    const response = await fetch(`${base}/pending-actions/${encodeURIComponent(queued.result.actionId)}/approve`, {
      method: "POST"
    });
    assert.equal(response.status, 200);
    await until(() => runtime.pendingActions.get(queued.result.actionId)?.continuation?.status === "delivered", 4_000);
    const action = runtime.pendingActions.get(queued.result.actionId);
    assert.equal(action.continuation.attempts, 2);
    assert.equal(calls, 2);
    assert.equal(action.status, "approved");
  } finally {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("a provider failure after a read-only computer tool retries without renewing approval", async () => {
  let calls = 0;
  const { runtime, app, base, dataDir } = await appWithComputerUse({
    generate: async (request) => {
      calls += 1;
      if (calls === 1) {
        request.onProgress?.({ stage: "tool", tool: "computer_screenshot" });
        throw new Error("provider transport failed after screenshot");
      }
      return {
        id: "approval_readonly_retry_success",
        text: "The live screenshot was verified.",
        provider: "test",
        model: "test-model",
        toolCalls: []
      };
    }
  });
  try {
    const queued = await runtime.tools.invoke("start_computer_use_session", {
      goal: "Verify live pixels without input"
    }, {
      sessionId: "local:approval-readonly-retry:main",
      channel: "local",
      from: "user",
      agentId: "main"
    });
    const response = await fetch(`${base}/pending-actions/${encodeURIComponent(queued.result.actionId)}/approve`, {
      method: "POST"
    });
    assert.equal(response.status, 200);
    await until(() => runtime.pendingActions.get(queued.result.actionId)?.continuation?.status === "delivered", 4_000);
    const action = runtime.pendingActions.get(queued.result.actionId);
    assert.equal(action.continuation.attempts, 2);
    assert.equal(calls, 2);
    assert.equal(runtime.computerUseLog.listSessions({ status: "active" }).length, 1,
      "a read-only provider failure keeps the approved session active for the safe retry");
  } finally {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("a continuation failure after any tool attempt aborts instead of replaying physical work", async () => {
  let calls = 0;
  const { runtime, app, base, dataDir } = await appWithComputerUse({
    generate: async (request) => {
      calls += 1;
      request.onProgress?.({ stage: "tool", tool: "computer_click" });
      throw new Error("provider failed after tool dispatch");
    }
  });
  try {
    const queued = await runtime.tools.invoke("start_computer_use_session", {
      goal: "Do not replay an uncertain physical action"
    }, {
      sessionId: "local:approval-tool-failure:main",
      channel: "local",
      from: "user",
      agentId: "main"
    });
    const response = await fetch(`${base}/pending-actions/${encodeURIComponent(queued.result.actionId)}/approve`, {
      method: "POST"
    });
    assert.equal(response.status, 200);
    await until(() => runtime.pendingActions.get(queued.result.actionId)?.continuation?.status === "blocked");
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    assert.equal(calls, 1, "an uncertain side-effecting turn is never replayed automatically");
    assert.equal(runtime.computerUseLog.activeSessionFor("local:approval-tool-failure:main"), null);
    assert.match(runtime.pendingActions.get(queued.result.actionId).continuation.error, /manual reapproval required/);
  } finally {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("daemon startup recovers a continuation interrupted after durable approval", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-approval-restart-"));
  const seeded = new PendingActionStore({ dir: path.join(dataDir, "pending-actions") });
  const action = seeded.enqueue({
    toolName: "start_computer_use_session",
    args: { goal: "Resume after restart" },
    context: {
      sessionId: "local:approval-restart:main",
      channel: "local",
      from: "user",
      agentId: "main"
    },
    summary: "Start approved computer-use session"
  });
  const execution = seeded.claimForExecution(action.id);
  seeded.decide(action.id, {
    decision: "approve",
    decidedBy: "user",
    result: { sessionId: "computer-session" },
    executionId: execution.executionId
  });
  seeded.prepareContinuation(action.id, {
    requestId: `approval_${action.id}`,
    sessionId: action.context.sessionId
  });
  assert.ok(seeded.claimContinuation(action.id), "simulates a daemon exit while delivery is in flight");

  const { runtime, app } = await appWithComputerUse({ dataDir });
  try {
    await until(() => runtime.pendingActions.get(action.id)?.continuation?.status === "delivered", 3_000);
    const recovered = runtime.pendingActions.get(action.id);
    assert.equal(recovered.status, "approved");
    assert.equal(recovered.continuation.attempts, 2);
    const session = runtime.agentHost.store.getSession(action.context.sessionId);
    assert.ok(session.messages.some((message) => message.metadata?.requestId === `approval_${action.id}`));
  } finally {
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

test("approved explicit node is re-authenticated and permission-checked before session activation", async () => {
  const previous = {
    node: process.env.OPENAGI_COMPUTER_NODE,
    token: process.env.OPENAGI_COMPUTER_NODE_TOKEN,
    insecure: process.env.OPENAGI_ALLOW_INSECURE_NODE_RELAY
  };
  process.env.OPENAGI_COMPUTER_NODE = "https://computer.example";
  process.env.OPENAGI_COMPUTER_NODE_TOKEN = "scoped-test-token";
  delete process.env.OPENAGI_ALLOW_INSECURE_NODE_RELAY;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-computer-explicit-approval-"));
  const tools = new ToolRegistry();
  const pendingActions = new PendingActionStore({ dir: path.join(dataDir, "pending") });
  tools.bindPendingActions(pendingActions);
  const runtime = {
    tools,
    pendingActions,
    computerUseLog: new ComputerUseLog({ dir: path.join(dataDir, "computer-use") }),
    observations: { search: async () => [] }
  };
  let probes = 0;
  registerComputerUseTools(tools, runtime, {
    fetchImpl: async (url, options) => {
      probes += 1;
      assert.equal(url, "https://computer.example/health");
      assert.equal(options.headers.authorization, "Bearer scoped-test-token");
      return new Response(JSON.stringify({
        capability: {
          id: "computer-use",
          screenshotReady: true,
          inputReady: false,
          operations: ["session.start", "session.end", "screenshot", "click", "move", "type", "key", "scroll"]
        }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
  });
  const context = { sessionId: "chat:explicit", channel: "local", from: "user" };
  try {
    const queued = await tools.invoke("start_computer_use_session", { goal: "Prepare the report" }, context);
    assert.equal(queued.result.status, "awaiting_confirmation");
    const pending = pendingActions.get(queued.result.actionId);
    assert.equal(probes, 0, "preparing an approval does not create main-side authority");
    const approved = await tools.invoke(pending.toolName, pending.args, { ...context, __confirmed: true });
    assert.equal(approved.ok, false);
    assert.match(approved.error, /no longer online and control-ready/);
    assert.equal(probes, 1);
    assert.equal(runtime.computerUseLog.listSessions({ status: "active" }).length, 0);
  } finally {
    if (previous.node === undefined) delete process.env.OPENAGI_COMPUTER_NODE;
    else process.env.OPENAGI_COMPUTER_NODE = previous.node;
    if (previous.token === undefined) delete process.env.OPENAGI_COMPUTER_NODE_TOKEN;
    else process.env.OPENAGI_COMPUTER_NODE_TOKEN = previous.token;
    if (previous.insecure === undefined) delete process.env.OPENAGI_ALLOW_INSECURE_NODE_RELAY;
    else process.env.OPENAGI_ALLOW_INSECURE_NODE_RELAY = previous.insecure;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("approved computer actions bypass scrutiny re-confirmation without persisting typed text", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-computer-sensitive-"));
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
    nodeId: "node-sensitive",
    name: "Selected node",
    capabilities: [{
      id: "computer-use",
      ready: true,
      operations: ["session.start", "session.end", "type"]
    }]
  };
  runtime.nodeCapabilities = {
    resolve: () => record,
    dispatch: async (_nodeId, _capability, operation) => operation === "session.start"
      ? { leaseId: "lease-sensitive", nextSequence: 1 }
      : { ok: true }
  };
  registerComputerUseTools(tools, runtime);
  const context = {
    sessionId: "chat:sensitive",
    channel: "local",
    from: "user",
    __scrutinyPolicy: "confirm"
  };
  runtime.computerUseLog.startSession({
    goal: "Enter the approved form values",
    approvedBy: "user",
    sourceSessionId: context.sessionId,
    targetNodeId: record.nodeId
  });
  const typed = "private-value-that-must-not-reach-the-approval-journal";

  try {
    const result = await tools.invoke("computer_type", { frameId: "frame-1", text: typed }, context);
    assert.equal(result.ok, true);
    assert.equal(pendingActions.list().length, 0, "an active approved session does not create a second approval");
    const persisted = fs.readdirSync(dataDir, { recursive: true })
      .filter((entry) => fs.statSync(path.join(dataDir, entry)).isFile())
      .map((entry) => fs.readFileSync(path.join(dataDir, entry), "utf8"))
      .join("\n");
    assert.equal(persisted.includes(typed), false, "typed text is absent from every durable computer/approval record");
    const action = runtime.computerUseLog.listActions({ limit: 1 })[0];
    assert.deepEqual(action.args, {
      textRedacted: true,
      characterCount: typed.length,
      byteCount: Buffer.byteLength(typed, "utf8")
    });
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("node lease sequence advances only when the node consumed the failed action", async () => {
  for (const consumed of [false, true]) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `openagi-computer-sequence-${consumed}-`));
    const tools = new ToolRegistry();
    const runtime = {
      tools,
      pendingActions: new PendingActionStore({ dir: path.join(dataDir, "pending") }),
      computerUseLog: new ComputerUseLog({ dir: path.join(dataDir, "computer-use") }),
      observations: { search: async () => [] }
    };
    const record = {
      nodeId: "node-selected",
      name: "Selected node",
      capabilities: [{
        id: "computer-use",
        ready: true,
        operations: ["session.start", "session.end", "screenshot"]
      }]
    };
    const endSequences = [];
    runtime.nodeCapabilities = {
      refresh: async () => [record],
      list: () => [record],
      resolve: () => record,
      cancelSession: () => ({ cancelled: 0, delivered: 0 }),
      dispatch: async (_nodeId, _capability, operation, payload) => {
        if (operation === "session.start") return { leaseId: "lease-selected", nextSequence: 1 };
        if (operation === "session.end") {
          endSequences.push(payload.sequence);
          return { ok: true };
        }
        const failure = new Error(consumed ? "node rejected the action" : "request failed before delivery");
        if (consumed) {
          failure.nodeAcknowledged = true;
          failure.nodeSequenceConsumed = true;
        }
        throw failure;
      }
    };
    registerComputerUseTools(tools, runtime);
    const context = { sessionId: `chat:sequence:${consumed}` };
    runtime.computerUseLog.startSession({
      goal: "Inspect the selected window",
      approvedBy: "user",
      sourceSessionId: context.sessionId,
      targetNodeId: record.nodeId
    });
    try {
      await assert.rejects(
        () => tools.get("computer_screenshot").handler({ reasoning: "Inspect before acting" }, context),
        /computer-use node screenshot failed/
      );
      assert.deepEqual(endSequences, [undefined], "revocation is unconditional and independent of action sequence");
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
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

test("a delayed denial cannot report success after approval already claimed execution", async () => {
  const { runtime, app, base, dataDir } = await appWithComputerUse();
  runtime.tools.register({
    name: "approval_deny_race_test",
    sideEffects: true,
    needsConfirmation: true,
    parameters: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
      return { executed: true };
    }
  });

  try {
    const queued = await runtime.tools.invoke("approval_deny_race_test", {}, {
      sessionId: "local:deny-race",
      channel: "local",
      from: "user"
    });
    const id = queued.result.actionId;
    const encoder = new TextEncoder();
    let finishDenyBody;
    const denyBody = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('{"reason":"'));
        finishDenyBody = () => {
          controller.enqueue(encoder.encode('stop"}'));
          controller.close();
        };
      }
    });
    const denyPromise = fetch(`${base}/pending-actions/${encodeURIComponent(id)}/deny`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: denyBody,
      duplex: "half"
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    const approvePromise = fetch(`${base}/pending-actions/${encodeURIComponent(id)}/approve`, { method: "POST" });
    await until(() => runtime.pendingActions.get(id)?.status === "executing");
    finishDenyBody();

    const [deny, approve] = await Promise.all([denyPromise, approvePromise]);
    assert.equal(deny.status, 409, "deny must not claim success after execution starts");
    assert.equal(approve.status, 200);
    assert.equal(runtime.pendingActions.get(id).status, "approved");
  } finally {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
