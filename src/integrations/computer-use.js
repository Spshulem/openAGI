// Computer-use beta integration. Wires Anthropic's `computer_*` tool
// vocabulary into OpenAGI's ToolRegistry. This build does NOT synthesize
// mouse / keyboard events — real input synthesis lives in the Mac app
// behind macOS Accessibility permission and ships in a later phase.
//
// IMPORTANT (production honesty): the input-synthesis tools (click, type,
// key, scroll, move) record the agent's intent to the audit log and then
// THROW. They never report fake success — an agent calling computer_click
// gets an explicit "execution not available in this build" error so it
// knows the action did not happen. Only session management and the
// (real-data) screenshot/OCR readback actually function.
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

const SAFETY_NOTE = "Computer use is experimental. Every action is logged with the reasoning you provide; the log is visible to the user. Input synthesis (click/type/key/scroll/move) is NOT available in this build — those calls are logged and then refused, so do not assume they succeed.";

const EXECUTION_UNAVAILABLE = "computer-use input synthesis is not available in this build. The intent was recorded to the audit log but NOT performed. Do not assume the action succeeded.";

// Tool names that this module registers. Kept here in one place so the
// dynamic unregister path (used by the dashboard toggle) can remove
// exactly what was added without guessing.
export const COMPUTER_USE_TOOL_NAMES = [
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

/// A configured computer-use node (a Mac running `openagi computer-server`)
/// turns the stub into real execution: screenshots + input synthesis run on
/// that node. Without it, input is logged and refused (no fake success).
function computerNode() {
  const url = (process.env.OPENAGI_COMPUTER_NODE ?? "").replace(/\/$/, "");
  if (!url) return null;
  return { url, token: process.env.OPENAGI_COMPUTER_NODE_TOKEN ?? null };
}

async function callNode(node, path, body, fetchImpl) {
  const res = await fetchImpl(`${node.url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(node.token ? { authorization: `Bearer ${node.token}` } : {}) },
    body: JSON.stringify(body ?? {})
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `computer node HTTP ${res.status}`);
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

  const requireActiveSession = () => {
    const active = runtime.computerUseLog.listSessions({ status: "active" })[0];
    if (!active) throw new Error("No active computer-use session. Call start_computer_use_session first and have the user approve.");
    return active;
  };

  registry.register({
    name: "start_computer_use_session",
    description: "Open a computer-use session for a user-stated goal. THIS REQUIRES USER APPROVAL — once approved, subsequent computer_* actions in this session won't re-prompt. " + SAFETY_NOTE,
    parameters: {
      type: "object",
      properties: {
        goal: { type: "string", description: "What the user is trying to accomplish, in one sentence. Will be shown verbatim in the approval card." }
      },
      required: ["goal"],
      additionalProperties: false
    },
    needsConfirmation: true,
    summarize: (args) => `Open computer-use session: "${String(args.goal ?? "").slice(0, 120)}"`,
    handler: async (args) => {
      const session = runtime.computerUseLog.startSession({ goal: args.goal, approvedBy: "user" });
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
    handler: async (args) => {
      const active = runtime.computerUseLog.listSessions({ status: "active" })[0];
      if (!active) return { ended: false, reason: "no active session" };
      runtime.computerUseLog.endSession(active.id, { reason: args.reason, status: "ended" });
      return { ended: true, sessionId: active.id };
    }
  });

  registry.register({
    name: "computer_screenshot",
    sideEffects: false,
    description: "Read the current screen state. Returns the most recent OCR text + active app from the observation store (real data). This build does not return raw image bytes — image transport ships with the Mac app in a later phase.",
    parameters: {
      type: "object",
      properties: {
        reasoning: { type: "string", description: "Why you're taking this screenshot right now (one short sentence)." }
      },
      additionalProperties: false
    },
    handler: async (args) => {
      const session = requireActiveSession();
      const action = runtime.computerUseLog.recordAction({
        sessionId: session.id,
        kind: "screenshot",
        args: {},
        reasoning: args.reasoning ?? null
      });
      const node = computerNode();
      if (node) {
        try {
          const shot = await callNode(node, "/screenshot", {}, fetchImpl);
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
            note: "Live screenshot from the computer-use node."
          };
        } catch (error) {
          runtime.computerUseLog.markActionResult(action.id, { status: "error", result: { error: error.message } });
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
  function registerAction(name, nodePath, description, paramShape, payloadOf) {
    registry.register({
      name,
      description: description + " Executes on the connected computer-use node; without one (OPENAGI_COMPUTER_NODE unset) the call is logged and refused.",
      parameters: {
        type: "object",
        properties: {
          ...paramShape,
          reasoning: { type: "string", description: "Why you're doing this (one short sentence). Captured to the action log for the user to review." }
        },
        additionalProperties: false
      },
      handler: async (args) => {
        const session = requireActiveSession();
        const { reasoning, ...actionArgs } = args;
        const action = runtime.computerUseLog.recordAction({
          sessionId: session.id,
          kind: name.replace(/^computer_/, ""),
          args: actionArgs,
          reasoning: reasoning ?? null
        });
        const node = computerNode();
        if (!node) {
          runtime.computerUseLog.markActionResult(action.id, {
            status: "unavailable",
            result: { reason: "no computer-use node configured" }
          });
          throw new Error(EXECUTION_UNAVAILABLE);
        }
        try {
          await callNode(node, nodePath, payloadOf(actionArgs), fetchImpl);
          runtime.computerUseLog.markActionResult(action.id, { status: "executed", result: { via: "node" } });
          return { actionId: action.id, ok: true };
        } catch (error) {
          runtime.computerUseLog.markActionResult(action.id, { status: "error", result: { error: error.message } });
          throw new Error(`computer-use node ${name} failed: ${error.message}`);
        }
      }
    });
  }

  registerAction("computer_click", "/click", "Click at (x, y) coordinates on the screen. Coordinates are screen-space pixels with (0,0) at top-left.", {
    x: { type: "integer", description: "Screen x (pixels)." },
    y: { type: "integer", description: "Screen y (pixels)." },
    button: { type: "string", enum: ["left", "right", "middle"], description: "Default left." }
  }, (a) => ({ x: a.x, y: a.y, button: a.button ?? "left" }));
  registerAction("computer_type", "/type", "Type a string into the focused app.", {
    text: { type: "string", description: "Text to type. Use computer_key for non-printable keys." }
  }, (a) => ({ text: a.text ?? "" }));
  registerAction("computer_key", "/key", "Press a key chord. Examples: 'cmd+a', 'enter', 'esc', 'cmd+shift+t'.", {
    chord: { type: "string", description: "Key chord, plus-separated. Modifiers: cmd, shift, alt, ctrl. Then the key name." }
  }, (a) => ({ chord: a.chord }));
  registerAction("computer_scroll", "/scroll", "Scroll at (x, y).", {
    x: { type: "integer" },
    y: { type: "integer" },
    deltaX: { type: "integer", description: "Horizontal scroll delta in lines." },
    deltaY: { type: "integer", description: "Vertical scroll delta in lines. Negative = down." }
  }, (a) => ({ x: a.x, y: a.y, deltaX: a.deltaX, deltaY: a.deltaY }));
  registerAction("computer_move", "/move", "Move the mouse to (x, y) without clicking.", {
    x: { type: "integer" },
    y: { type: "integer" }
  }, (a) => ({ x: a.x, y: a.y }));

  return { registered: true, node: Boolean(computerNode()) };
}
