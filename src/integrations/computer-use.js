// Computer-use beta integration. Wires a provider-neutral `computer_*` tool
// vocabulary into OpenAGI's ToolRegistry. A connected computer-use node can
// capture the live screen and synthesize input; without one, the safe local
// fallback is read-only OCR from the observation store.
//
// IMPORTANT (production honesty): without a reachable node, input-synthesis
// tools record the agent's intent and then THROW. They never report fake
// success. Session management and the real-data screenshot/OCR readback still
// function in observation-only mode.
//
// The tools are registered behind a feature flag (OPENAGI_COMPUTER_USE=1)
// so the default install is unaffected. Tool list:
//   start_computer_use_session — user-gated approval that opens a session
//                               with a stated goal. Subsequent actions
//                               within that session don't re-prompt.
//   computer_screenshot       — current screen state (returns OCR snippet,
//                               since real screenshot transport needs the
//                               Mac app).
//   computer_click            — click at (x, y).
//   computer_type             — type a string.
//   computer_key              — press a key chord.
//   computer_scroll           — scroll at (x, y).
//   computer_move             — move mouse (no click).
//   end_computer_use_session  — close the active session.
//
// Every action call records {kind, args, reasoning} to the ComputerUseLog
// BEFORE attempting execution. The "reasoning" is whatever the model
// produced in its assistant text turn alongside the tool call — captured
// via a separate `reasoning` param that the agent is instructed to fill.
import crypto from "node:crypto";
import { pinnedRemoteOrigin } from "../node-control.js";

const SAFETY_NOTE = "Computer use is experimental. Every action is logged with the reasoning you provide; the log is visible to the user. Input synthesis requires a reachable computer-use node; without one, those calls are logged and refused, so do not assume they succeed.";

const EXECUTION_UNAVAILABLE = "no reachable computer-use node is configured. The intent was recorded to the audit log but NOT performed. Do not assume the action succeeded.";
const REQUIRED_INPUT_OPERATIONS = ["click", "move", "type", "key", "scroll"];

// Tool names that this module registers. Kept here in one place so the
// dynamic unregister path (used by the dashboard toggle) can remove
// exactly what was added without guessing.
export const COMPUTER_USE_TOOL_NAMES = [
  "computer_use_status",
  "start_computer_use_session",
  "end_computer_use_session",
  "computer_screenshot",
  "computer_click",
  "computer_type",
  "computer_key",
  "computer_scroll",
  "computer_move"
];

/// Reads the current enabled state from process.env. NOT cached — so when
/// the dashboard toggle writes IMESSAGE-style to .env and updates
/// process.env, the next check reflects the new value immediately.
export function isComputerUseEnabled() {
  const v = process.env.OPENAGI_COMPUTER_USE;
  return v === "1" || v === "true" || v === "yes";
}

/// Public, secret-free capability status for the dashboard. This never returns
/// the configured node URL or token. A health failure is a readiness state, not
/// an exception that breaks the rest of the Computer Use page.
export async function computerUseReadiness({
  env = process.env,
  fetchImpl = globalThis.fetch,
  runtime = null,
  toolsRegistered = null,
  timeoutMs = 1_200
} = {}) {
  const value = String(env.OPENAGI_COMPUTER_USE ?? "").toLowerCase();
  const enabled = value === "1" || value === "true" || value === "yes";
  await runtime?.nodeCapabilities?.refresh?.().catch?.(() => {});
  const explicit = explicitComputerNode(env);
  const discovered = runtime?.nodeCapabilities?.resolve?.("computer-use") ?? null;
  const node = explicit ?? (discovered ? relayComputerNode(runtime, discovered) : null);
  const nodeConfigured = Boolean(node);
  let nodeReachable = false;
  let liveScreenshot = false;
  let inputAvailable = false;
  let operations = [];
  let detail = null;
  if (node?.kind === "relay") {
    const capability = discovered.capabilities?.find?.((entry) => entry.id === "computer-use") ?? null;
    nodeReachable = Boolean(capability);
    liveScreenshot = capability?.ready === true && capability.operations?.includes?.("screenshot");
    operations = capability?.operations ?? [];
    inputAvailable = capability?.ready === true
      && ["click", "move", "type", "key", "scroll"].every((operation) => operations.includes(operation));
    detail = capability?.detail ?? null;
  } else if (node?.kind === "invalid") {
    detail = node.detail;
  } else if (nodeConfigured && typeof fetchImpl === "function") {
    const status = await probeExplicitComputerNode(node, fetchImpl, timeoutMs);
    nodeReachable = status.reachable;
    operations = status.operations;
    liveScreenshot = status.liveScreenshot;
    inputAvailable = status.inputAvailable;
    detail = status.detail;
  }
  const mode = !enabled
    ? "disabled"
    : nodeReachable
      ? (liveScreenshot && inputAvailable ? "control-ready" : "permissions-required")
      : nodeConfigured
        ? "node-unreachable"
        : "observe-only";
  return {
    enabled,
    toolsRegistered: toolsRegistered == null ? enabled : Boolean(toolsRegistered),
    mode,
    nodeConfigured,
    nodeReachable,
    screenshot: enabled ? (liveScreenshot ? "live-image" : "recent-ocr") : "disabled",
    inputAvailable: enabled && nodeReachable && inputAvailable,
    operations,
    detail
  };
}

/// A configured computer-use node (a Mac running `openagi computer-server`)
/// turns the stub into real execution: screenshots + input synthesis run on
/// that node. Without it, input is logged and refused (no fake success).
function explicitComputerNode(env = process.env) {
  const url = String(env.OPENAGI_COMPUTER_NODE ?? "").replace(/\/$/, "");
  if (!url) return null;
  try {
    const safeUrl = pinnedRemoteOrigin(url, {
      allowInsecureRemote: env.OPENAGI_ALLOW_INSECURE_NODE_RELAY === "1"
        || String(env.OPENAGI_ALLOW_INSECURE_NODE_RELAY ?? "").toLowerCase() === "true"
    });
    const token = typeof env.OPENAGI_COMPUTER_NODE_TOKEN === "string" && env.OPENAGI_COMPUTER_NODE_TOKEN
      ? env.OPENAGI_COMPUTER_NODE_TOKEN
      : null;
    if (!token) {
      return { kind: "invalid", id: "explicit", detail: "the explicit computer node requires a scoped authentication token" };
    }
    return { kind: "http", id: "explicit", url: safeUrl, token };
  } catch (error) {
    return { kind: "invalid", id: "explicit", detail: error.message };
  }
}

async function probeExplicitComputerNode(node, fetchImpl, timeoutMs = 1_200) {
  if (node?.kind !== "http" || typeof fetchImpl !== "function") {
    return { reachable: false, liveScreenshot: false, inputAvailable: false, operations: [], detail: null };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetchImpl(`${node.url}/health`, {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${node.token}`
      },
      redirect: "manual",
      signal: controller.signal
    });
    if (!response?.ok) {
      try { await response?.body?.cancel?.(); } catch { /* best effort */ }
      return { reachable: false, liveScreenshot: false, inputAvailable: false, operations: [], detail: null };
    }
    const body = await readNodeJsonLimited(response, 256 * 1024).catch(() => null);
    const capability = body?.capability?.id === "computer-use" ? body.capability : null;
    const operations = Array.isArray(capability?.operations) ? capability.operations : [];
    return {
      reachable: Boolean(capability),
      liveScreenshot: capability?.screenshotReady === true && operations.includes("screenshot"),
      inputAvailable: capability?.inputReady === true
        && REQUIRED_INPUT_OPERATIONS.every((operation) => operations.includes(operation)),
      operations,
      detail: typeof capability?.detail === "string" ? capability.detail.slice(0, 300) : null
    };
  } catch {
    return { reachable: false, liveScreenshot: false, inputAvailable: false, operations: [], detail: null };
  } finally {
    clearTimeout(timer);
  }
}

function relayComputerNode(runtime, record) {
  return {
    kind: "relay",
    id: record.nodeId,
    record,
    dispatch: (operation, payload, opts) => runtime.nodeCapabilities.dispatch(record.nodeId, "computer-use", operation, payload, opts)
  };
}

function computerNode(runtime, session = null) {
  if (session && session.capability !== "computer-use") return null;
  const explicit = explicitComputerNode();
  if (explicit?.kind === "invalid") return null;
  if (explicit) return session?.targetNodeId && session.targetNodeId !== explicit.id ? null : explicit;
  if (!runtime?.nodeCapabilities?.resolve) return null;
  const record = runtime.nodeCapabilities.resolve("computer-use", {
    nodeId: session?.targetNodeId ?? null
  });
  return record ? relayComputerNode(runtime, record) : null;
}

function computerNodeForRevocation(runtime, session, lease) {
  const explicit = explicitComputerNode();
  if (explicit?.kind === "http" && lease?.nodeId === explicit.id) return explicit;
  const nodeId = lease?.nodeId ?? session?.targetNodeId;
  if (nodeId && runtime?.nodeCapabilities?.dispatch) {
    return relayComputerNode(runtime, { nodeId });
  }
  return null;
}

const NODE_PATHS = {
  "session.start": "/session/start",
  "session.end": "/session/end",
  screenshot: "/screenshot",
  click: "/click",
  move: "/move",
  type: "/type",
  key: "/key",
  scroll: "/scroll"
};

async function callNode(node, operation, body, fetchImpl, timeoutMs = 30_000, opts = {}) {
  if (node.kind === "relay") return await node.dispatch(operation, body, opts);
  const path = NODE_PATHS[operation];
  if (!path) throw new Error("unsupported computer node operation");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  let res;
  try {
    res = await fetchImpl(`${node.url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(node.token ? { authorization: `Bearer ${node.token}` } : {}) },
      body: JSON.stringify(body ?? {}),
      redirect: "manual",
      signal: controller.signal
    });
  } finally { clearTimeout(timer); }
  const json = await readNodeJsonLimited(
    res,
    operation === "screenshot" ? 12 * 1024 * 1024 : 256 * 1024
  ).catch(() => ({}));
  if (!res.ok) {
    const publicError = typeof json?.error === "string" ? json.error.slice(0, 300) : `computer node HTTP ${res.status}`;
    const error = new Error(publicError);
    error.nodeAcknowledged = true;
    // Current nodes state this explicitly. Older compatible node services used
    // 5xx for executor failures after entering a lease, so retain that legacy
    // default only for 5xx. Redirects/auth/route failures never prove that the
    // action reached the lease and must not advance its sequence.
    error.nodeSequenceConsumed = json?.sequenceConsumed === true
      || (json?.sequenceConsumed !== false && res.status >= 500);
    throw error;
  }
  return json;
}

/// Remove all computer-use tools from the registry. Caller is expected
/// to also close any active session so the agent doesn't leave a dangling
/// reference. Returns the number of tools actually unregistered.
export function unregisterComputerUseTools(registry) {
  let count = 0;
  for (const name of COMPUTER_USE_TOOL_NAMES) {
    if (registry.has?.(name)) {
      registry.unregister(name);
      count += 1;
    }
  }
  return count;
}

export function registerComputerUseTools(registry, runtime, { fetchImpl = globalThis.fetch } = {}) {
  if (!runtime.computerUseLog) return { registered: false, reason: "no computer-use log bound" };

  const requireActiveSession = (context = {}) => {
    const sourceSessionId = context.sessionId;
    if (typeof sourceSessionId !== "string" || !sourceSessionId) {
      throw new Error("Computer-use action is missing its source chat session.");
    }
    const active = runtime.computerUseLog.activeSessionFor(sourceSessionId);
    if (!active) throw new Error("No active computer-use session. Call start_computer_use_session first and have the user approve.");
    return active;
  };

  runtime.__computerNodeLeases ??= new Map();
  runtime.__computerNodeLeaseOpenings ??= new Map();

  const ensureNodeLease = async (node, session) => {
    const existing = runtime.__computerNodeLeases.get(session.id);
    if (existing) {
      if (existing.nodeId !== node.id) throw new Error("approved computer-use session is bound to a different node");
      return existing;
    }
    const opening = runtime.__computerNodeLeaseOpenings.get(session.id);
    if (opening) return await opening;
    const promise = (async () => {
      const goalHash = crypto.createHash("sha256")
        .update(`${session.sourceSessionId}\0${session.targetNodeId}\0${session.goal}`, "utf8")
        .digest("hex");
      const opened = await callNode(node, "session.start", {
        sessionId: session.id,
        goalHash,
        expiresAt: session.expiresAt,
        maxActions: 200,
        allowedOperations: ["session.end", "screenshot", "click", "move", "type", "key", "scroll"]
      }, fetchImpl);
      const lease = {
        nodeId: node.id,
        leaseId: opened.leaseId,
        nextSequence: Number.isSafeInteger(opened.nextSequence) ? opened.nextSequence : 1,
        inFlightSequence: null
      };
      const current = runtime.computerUseLog.getSession(session.id);
      if (!current || current.status !== "active") {
        // Stop may race the first node handshake. The newly-created lease was
        // never exposed to another action, so sequence 1 can revoke it safely.
        await callNode(node, "session.end", {
          leaseId: lease.leaseId,
          actionId: `abort_${crypto.randomUUID().replaceAll("-", "")}`,
          sequence: lease.nextSequence
        }, fetchImpl, 5_000, { sessionId: session.id }).catch(() => {});
        throw new Error("computer-use session ended while the node lease was opening");
      }
      runtime.__computerNodeLeases.set(session.id, lease);
      return lease;
    })();
    runtime.__computerNodeLeaseOpenings.set(session.id, promise);
    try {
      return await promise;
    } finally {
      if (runtime.__computerNodeLeaseOpenings.get(session.id) === promise) {
        runtime.__computerNodeLeaseOpenings.delete(session.id);
      }
    }
  };

  const invokeNodeAction = async (node, session, action, operation, payload = {}) => {
    const lease = await ensureNodeLease(node, session);
    if (lease.inFlightSequence != null) {
      throw new Error("another computer-use action is already in progress");
    }
    const sequence = lease.nextSequence;
    lease.inFlightSequence = sequence;
    try {
      const result = await callNode(node, operation, {
        ...payload,
        leaseId: lease.leaseId,
        actionId: action.id,
        sequence
      }, fetchImpl, 30_000, { sessionId: session.id });
      if (lease.nextSequence === sequence) lease.nextSequence += 1;
      return result;
    } catch (error) {
      if (error?.nodeSequenceConsumed === true && lease.nextSequence === sequence) {
        lease.nextSequence += 1;
      }
      throw error;
    } finally {
      if (lease.inFlightSequence === sequence) lease.inFlightSequence = null;
    }
  };

  const abortSession = async (session, reason = "computer-use session was stopped", status = "aborted") => {
    if (!session) return false;
    // Revoke the main-side authority synchronously before any network wait so
    // a concurrent tool cannot reopen a lease while Stop is in progress.
    runtime.computerUseLog.endSession(session.id, { reason, status });
    runtime.nodeCapabilities?.cancelSession?.(session.id, reason);
    const lease = runtime.__computerNodeLeases.get(session.id);
    const node = computerNodeForRevocation(runtime, session, lease);
    runtime.__computerNodeLeases.delete(session.id);
    if (lease && node) {
      // session.end is an authenticated, idempotent lease revocation at the
      // node. It deliberately ignores the physical-action sequence so Stop
      // always wins a race with an action that is entering or settling.
      await callNode(node, "session.end", {
        leaseId: lease.leaseId,
        actionId: `abort_${crypto.randomUUID().replaceAll("-", "")}`
      }, fetchImpl, 5_000, { sessionId: session.id }).catch(() => {});
    }
    return true;
  };
  runtime.abortComputerUseSession = async (sessionOrId, reason) => {
    const session = typeof sessionOrId === "string"
      ? runtime.computerUseLog.getSession(sessionOrId)
      : sessionOrId;
    return await abortSession(session, reason, "aborted");
  };

  registry.register({
    name: "computer_use_status",
    sideEffects: false,
    description: "Check whether a computer-use session is already active or awaiting approval. Call this before start_computer_use_session and after the user approves; never create a second start request when a session is active.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false
    },
    handler: async (_args, context = {}) => {
      await runtime.nodeCapabilities?.refresh?.();
      const active = runtime.computerUseLog.activeSessionFor(context.sessionId) ?? null;
      const pending = runtime.pendingActions?.list?.({ status: "pending" })
        .filter((action) => action.toolName === "start_computer_use_session" && action.context?.sessionId === context.sessionId) ?? [];
      const discoveredNodes = runtime.nodeCapabilities?.list?.("computer-use")?.map?.((entry) => ({
        nodeId: entry.nodeId,
        name: entry.name ?? null,
        ready: entry.capabilities?.some?.((capability) => capability.id === "computer-use" && capability.ready) ?? false
      })) ?? [];
      const explicitStatus = explicitComputerNode();
      const availableNodes = explicitStatus
        ? [{ nodeId: "explicit", name: null, ready: explicitStatus.kind !== "invalid" }, ...discoveredNodes]
        : discoveredNodes;
      return {
        active: Boolean(active),
        session: active ? {
          id: active.id,
          goal: active.goal,
          startedAt: active.startedAt
        } : null,
        awaitingApproval: pending.length > 0,
        pendingActionId: pending[0]?.id ?? null,
        availableNodes,
        note: active
          ? "A user-approved computer-use session is active. Continue with computer_screenshot and the computer action tools; do not call start again."
          : pending.length > 0
            ? "A start request is already waiting in Approvals. Do not create another."
            : "No computer-use session is active or awaiting approval."
      };
    }
  });

  registry.register({
    name: "start_computer_use_session",
    description: "Open a computer-use session for a user-stated goal. First call computer_use_status. If a session is active, continue it and do not call this tool again. Otherwise this creates ONE request in the dashboard's Approvals tab and Computer Use page. Approval automatically resumes the chat; subsequent computer_* actions in the approved session won't re-prompt. " + SAFETY_NOTE,
    parameters: {
      type: "object",
      properties: {
        goal: { type: "string", description: "What the user is trying to accomplish, in one sentence. Will be shown verbatim in the approval card." },
        node: { type: "string", description: "Optional node name or id. Use a value returned by computer_use_status when the user names a specific Mac." },
        nodeId: { type: "string", description: "Immutable node id resolved before approval. Do not invent this value." },
        nodeName: { type: "string", description: "Display name resolved before approval. Do not invent this value." }
      },
      required: ["goal"],
      additionalProperties: false
    },
    needsConfirmation: true,
    approvalTtlMs: 5 * 60 * 1000,
    prepareApprovalArgs: async (args, context) => {
      const goal = String(args.goal ?? "").trim().slice(0, 500);
      if (!goal) throw new Error("Computer-use session goal is required.");
      await runtime.nodeCapabilities?.refresh?.();
      const explicit = explicitComputerNode();
      if (explicit?.kind === "invalid") throw new Error(explicit.detail);
      const record = explicit
        ? { nodeId: explicit.id, name: "Configured computer node" }
        : runtime.nodeCapabilities?.resolve?.("computer-use", {
            nodeId: args.nodeId ?? args.node ?? null,
            nodeName: args.node ?? null
          });
      if (!record) {
        const ready = runtime.nodeCapabilities?.list?.("computer-use")
          ?.filter?.((entry) => entry.capabilities?.some?.((capability) => capability.ready)) ?? [];
        if (!args.node && ready.length > 1) {
          throw new Error("More than one computer-use node is ready. Choose a specific node before requesting approval.");
        }
        throw new Error(args.node
          ? "The requested computer-use node is not online and control-ready."
          : "No computer-use node is online and control-ready.");
      }
      const nodeId = record.nodeId ?? record.id;
      const nodeName = record.name ?? nodeId;
      const existing = runtime.computerUseLog.activeSessionFor(context?.sessionId);
      if (existing && (existing.goal !== goal || existing.targetNodeId !== nodeId)) {
        throw new Error("This chat already controls a different goal or node. End that session before requesting another approval.");
      }
      return { goal, ...(args.node ? { node: String(args.node).slice(0, 200) } : {}), nodeId, nodeName };
    },
    confirmationRequired: (args, context) => {
      const active = runtime.computerUseLog.activeSessionFor(context?.sessionId);
      if (!active) return true;
      return active.goal !== String(args.goal ?? "").trim() || active.targetNodeId !== args.nodeId;
    },
    approvalDedupeKey: (_args, context) =>
      "computer-use-session:" + (context.sessionId || [context.channel, context.from, context.agentId].filter(Boolean).join(":") || "global"),
    summarize: (args) => `Open computer-use session on ${String(args.nodeName ?? args.nodeId ?? "selected node").slice(0, 80)}: "${String(args.goal ?? "").slice(0, 120)}"`,
    handler: async (args, context = {}) => {
      if (typeof context.sessionId !== "string" || !context.sessionId) {
        throw new Error("Computer-use approval cannot start without a source chat session.");
      }
      const existing = runtime.computerUseLog.activeSessionFor(context.sessionId);
      if (existing) {
        if (existing.goal !== String(args.goal ?? "").trim() || existing.targetNodeId !== args.nodeId) {
          throw new Error("The active computer-use approval belongs to a different goal or node.");
        }
        return {
          sessionId: existing.id,
          goal: existing.goal,
          alreadyActive: true,
          note: "The approved computer-use session is already active. Continue with computer_screenshot / computer_click / etc; do not request approval again."
        };
      }
      const explicit = explicitComputerNode();
      const selected = explicit?.kind === "http" && explicit.id === args.nodeId
        ? explicit
        : runtime.nodeCapabilities?.resolve?.("computer-use", { nodeId: args.nodeId }) ?? null;
      if (!selected || (selected.id ?? selected.nodeId) !== args.nodeId) {
        throw new Error("The computer-use node approved by the user is no longer online and control-ready.");
      }
      if (selected.kind === "http") {
        // Approval can sit for minutes after it was prepared. Re-authenticate
        // the immutable explicit target and re-check its current screenshot +
        // input permissions before creating any main-side authority.
        const status = await probeExplicitComputerNode(selected, fetchImpl);
        if (!status.reachable || !status.liveScreenshot || !status.inputAvailable
            || !status.operations.includes("session.start")) {
          throw new Error("The computer-use node approved by the user is no longer online and control-ready.");
        }
      }
      const session = runtime.computerUseLog.startSession({
        goal: args.goal,
        approvedBy: "user",
        approvalActionId: context.__confirmationActionId ?? null,
        sourceSessionId: context.sessionId,
        targetNodeId: args.nodeId,
        capability: "computer-use"
      });
      return {
        sessionId: session.id,
        goal: session.goal,
        note: "Session active. Use computer_screenshot / computer_click / etc to act. Call end_computer_use_session when done."
      };
    }
  });

  registry.register({
    name: "end_computer_use_session",
    description: "Close the active computer-use session. Call this when the goal is achieved, when you decide to stop, or when the user asks you to.",
    parameters: {
      type: "object",
      properties: {
        reason: { type: "string", description: "Brief reason — 'goal achieved', 'user asked', 'cannot proceed without X', etc." }
      },
      additionalProperties: false
    },
    // Ending an already-approved capability is a safety action and must never
    // be held behind a second scrutiny approval.
    scrutinyConfirmationRequired: () => false,
    handler: async (args, context = {}) => {
      const active = runtime.computerUseLog.activeSessionFor(context.sessionId);
      if (!active) return { ended: false, reason: "no active session" };
      await abortSession(active, args.reason ?? "computer-use session ended", "ended");
      return { ended: true, sessionId: active.id };
    }
  });

  registry.register({
    name: "computer_screenshot",
    sideEffects: false,
    description: "Read the current screen state. A connected computer-use node returns a live image; observation-only mode returns the most recent OCR text + active app from the local observation store.",
    parameters: {
      type: "object",
      properties: {
        reasoning: { type: "string", description: "Why you're taking this screenshot right now (one short sentence)." }
      },
      additionalProperties: false
    },
    handler: async (args, context = {}) => {
      const session = requireActiveSession(context);
      const action = runtime.computerUseLog.recordAction({
        sessionId: session.id,
        kind: "screenshot",
        args: {},
        reasoning: args.reasoning ?? null
      });
      const node = computerNode(runtime, session);
      if (node) {
        try {
          const shot = await invokeNodeAction(node, session, action, "screenshot", {});
          runtime.computerUseLog.markActionResult(action.id, {
            status: "executed",
            result: { width: shot.width, height: shot.height, bytes: shot.bytes }
          });
          return {
            actionId: action.id,
            image: shot.base64,
            format: shot.format ?? "png",
            width: shot.width,
            height: shot.height,
            frameId: shot.frameId,
            note: "Live screenshot from the computer-use node."
          };
        } catch (error) {
          runtime.computerUseLog.markActionResult(action.id, { status: "error", error: error.message });
          await abortSession(session, "computer-use node action failed; approval must be renewed", "aborted");
          throw new Error(`computer-use node screenshot failed: ${error.message}`);
        }
      }
      // No node: fall back to OCR readback from the observation store.
      const snippets = await (runtime.observations?.search?.({ limit: 3 }) ?? Promise.resolve([]));
      const text = snippets.map((s) => s.text ?? "").filter(Boolean).join("\n").slice(0, 1200);
      const app = snippets[0]?.app ?? "(unknown)";
      runtime.computerUseLog.markActionResult(action.id, {
        status: "executed",
        result: { app, textSample: text.slice(0, 240) }
      });
      return {
        actionId: action.id,
        app,
        ocrSample: text || "(no recent OCR — capture may not be running)",
        note: "OCR readback only — no computer-use node configured, so no raw screenshot. Set OPENAGI_COMPUTER_NODE for live capture."
      };
    }
  });

  // Helper to register an input-synthesis action tool. When a computer-use
  // node is configured the action executes ON that node (real input); without
  // one, the intent + reasoning are logged and the handler THROWS so the agent
  // gets an explicit failure instead of a fabricated success. No silent stub.
  function registerAction(name, nodePath, description, paramShape, payloadOf, required = [], metadata = {}, includeReasoning = true) {
    registry.register({
      name,
      description: description + " Executes on the selected connected computer-use node; without one the call is logged and refused.",
      parameters: {
        type: "object",
        properties: {
          ...paramShape,
          ...(includeReasoning ? {
            reasoning: { type: "string", description: "Why you're doing this (one short sentence). Captured to the action log for the user to review." }
          } : {})
        },
        required,
        additionalProperties: false
      },
      metadata,
      // The human approves the bounded goal, chat, and immutable target when
      // the session starts. Each action then revalidates that active session
      // and its node lease below. Re-queuing actions here would both duplicate
      // the approval and, for computer_type, persist the text being typed.
      scrutinyConfirmationRequired: () => false,
      handler: async (args, context = {}) => {
        const session = requireActiveSession(context);
        const reasoning = includeReasoning ? args.reasoning : null;
        const actionArgs = includeReasoning
          ? Object.fromEntries(Object.entries(args).filter(([key]) => key !== "reasoning"))
          : args;
        const action = runtime.computerUseLog.recordAction({
          sessionId: session.id,
          kind: name.replace(/^computer_/, ""),
          args: actionArgs,
          reasoning: reasoning ?? null
        });
        const node = computerNode(runtime, session);
        if (!node) {
          runtime.computerUseLog.markActionResult(action.id, {
            status: "unavailable",
            result: { reason: "no computer-use node configured" }
          });
          throw new Error(EXECUTION_UNAVAILABLE);
        }
        try {
          await invokeNodeAction(node, session, action, nodePath, payloadOf(actionArgs));
          if (runtime.computerUseLog.getSession(session.id)?.status !== "active") {
            runtime.computerUseLog.markActionResult(action.id, { status: "aborted", error: "session-stopped" });
            throw Object.assign(new Error("computer-use session was stopped before the action result was accepted"), {
              nodeAcknowledged: true
            });
          }
          runtime.computerUseLog.markActionResult(action.id, { status: "executed", result: { via: "node" } });
          return { actionId: action.id, ok: true };
        } catch (error) {
          runtime.computerUseLog.markActionResult(action.id, { status: "error", error: error.message });
          await abortSession(session, "computer-use node action failed; approval must be renewed", "aborted");
          throw new Error(`computer-use node ${name} failed: ${error.message}`);
        }
      }
    });
  }

  registerAction("computer_click", "click", "Click at (x, y) coordinates on the screen. Coordinates are screen-space pixels with (0,0) at top-left.", {
    frameId: { type: "string", description: "frameId from the screenshot these coordinates refer to." },
    x: { type: "integer", description: "Screen x (pixels)." },
    y: { type: "integer", description: "Screen y (pixels)." },
    button: { type: "string", enum: ["left", "right", "middle"] }
  }, (a) => ({ frameId: a.frameId, x: a.x, y: a.y, button: a.button }), ["frameId", "x", "y", "button"]);
  registerAction("computer_type", "type", "Type a string into the focused app.", {
    frameId: { type: "string", description: "Fresh frameId from the screenshot that established the current focus." },
    text: { type: "string", description: "Text to type. Use computer_key for non-printable keys." }
  }, (a) => ({ frameId: a.frameId, text: a.text }), ["frameId", "text"], { sensitiveArguments: ["text"] }, false);
  registerAction("computer_key", "key", "Press a key chord. Examples: 'cmd+a', 'enter', 'esc', 'cmd+shift+t'.", {
    frameId: { type: "string", description: "Fresh frameId from the screenshot that established the current focus." },
    chord: { type: "string", description: "Key chord, plus-separated. Modifiers: cmd, shift, alt, ctrl. Then the key name." }
  }, (a) => ({ frameId: a.frameId, chord: a.chord }), ["frameId", "chord"]);
  registerAction("computer_scroll", "scroll", "Scroll at (x, y).", {
    frameId: { type: "string", description: "frameId from the screenshot these coordinates refer to." },
    x: { type: "integer" },
    y: { type: "integer" },
    deltaX: { type: "integer", description: "Horizontal scroll delta in lines." },
    deltaY: { type: "integer", description: "Vertical scroll delta in lines. Negative = down." }
  }, (a) => ({ frameId: a.frameId, x: a.x, y: a.y, deltaX: a.deltaX, deltaY: a.deltaY }), ["frameId", "x", "y", "deltaX", "deltaY"]);
  registerAction("computer_move", "move", "Move the mouse to (x, y) without clicking.", {
    frameId: { type: "string", description: "frameId from the screenshot these coordinates refer to." },
    x: { type: "integer" },
    y: { type: "integer" }
  }, (a) => ({ frameId: a.frameId, x: a.x, y: a.y }), ["frameId", "x", "y"]);

  return { registered: true, node: Boolean(explicitComputerNode() ?? runtime.nodeCapabilities?.resolve?.("computer-use")) };
}

async function readNodeJsonLimited(response, maxBytes) {
  const declared = Number(response?.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error("computer node response exceeded the transport limit");
  }
  if (response?.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) throw new Error("computer node response exceeded the transport limit");
        chunks.push(value);
      }
    } catch (error) {
      try { await reader.cancel(); } catch { /* best effort */ }
      throw error;
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(bytes));
  }
  if (typeof response?.text === "function") {
    const raw = await response.text();
    if (Buffer.byteLength(raw, "utf8") > maxBytes) {
      throw new Error("computer node response exceeded the transport limit");
    }
    return raw ? JSON.parse(raw) : {};
  }
  const value = await response.json();
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > maxBytes) {
    throw new Error("computer node response exceeded the transport limit");
  }
  return value;
}
