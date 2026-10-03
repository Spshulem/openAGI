// Runs one approved pending action: claim it (one-shot across racing
// surfaces), invoke the tool with the approval bypass, journal the result.
// Shared by the dashboard approve route, an outreach "do" and the owner's
// spoken "yes NN" in chat, so every surface executes it the same way.

// continuation: (action, invokeResult, options) => receipt | null, for the
// computer-use resume a dashboard approval schedules.
// Returns { status, body, action, invokeResult }: status is the HTTP status
// the approve route sends; body is its JSON.
export async function executeApprovedAction(runtime, id, { decidedBy = "user", claimedBy = decidedBy, continuation = null } = {}) {
  let action = runtime.pendingActions?.get?.(id) ?? null;
  if (!action) return { status: 404, body: { error: "unknown pending action" } };
  if (action.status === "expired") return { status: 410, body: { error: "approval expired; request it again" } };
  if (action.status === "approved" && action.error == null
      && action.toolName === "start_computer_use_session") {
    const resumed = continuation?.(action, { ok: true }, { resetFailed: true }) ?? null;
    return { status: 200, body: { ok: true, alreadyApproved: true, ...(resumed ? { continuation: resumed } : {}) }, action };
  }
  if (action.status !== "pending") return { status: 409, body: { error: `action already ${action.status}` }, action };
  const claim = runtime.pendingActions.claimForExecution?.(id, { claimedBy });
  if (!claim) {
    action = runtime.pendingActions.get(id);
    return { status: 409, body: { error: `action already ${action?.status ?? "claimed"}` }, action };
  }
  action = claim.action;
  // Re-invoke the original tool with the bypass flag so the gate doesn't
  // re-queue the same call. Persist the result on the action.
  const invokeResult = await runtime.tools.invoke(action.toolName, action.args, {
    ...action.context,
    __confirmed: true,
    __confirmationActionId: action.id,
    ...(decidedBy !== "user" ? { __approvedBy: decidedBy } : {})
  });
  const executionError = invokeResult?.ok ? null : invokeResult?.error ?? "approved tool execution failed";
  recordApprovedActionOutcome(runtime, action, invokeResult);
  runtime.pendingActions.decide(id, {
    decision: "approve",
    decidedBy,
    result: invokeResult?.ok ? invokeResult.result : null,
    error: executionError,
    executionId: claim.executionId
  });
  const resumed = continuation?.(action, invokeResult) ?? null;
  return {
    status: invokeResult?.ok ? 200 : 400,
    body: { ...invokeResult, ...(resumed ? { continuation: resumed } : {}) },
    action,
    invokeResult
  };
}

// Approval is only intent. Record an outcome at the point the confirmed tool
// actually returns, preserving the original autonomous/user provenance. This
// keeps queued approvals out of the scorecard while making the eventual work
// (including a real failure) measurable once—and only once—it executes.
export function recordApprovedActionOutcome(runtime, action, invokeResult) {
  if (!runtime.outcomes?.record || !approvedInvocationWasAttempted(invokeResult)) return null;
  const origin = String(action?.context?.origin ?? action?.context?.channel ?? "local").toLowerCase();
  const kind = origin === "autopilot"
    ? "autopilot-fire"
    : origin === "cron"
      ? "cron-fire"
      : "tool-call";
  try {
    return runtime.outcomes.record({
      kind,
      refId: action.id,
      sessionId: action.context?.sessionId ?? null,
      agentId: action.context?.agentId ?? "main",
      channel: action.context?.channel ?? null,
      toolCalls: [{ name: action.toolName, ok: invokeResult?.ok === true }],
      metadata: {
        approvalActionId: action.id,
        approvedExecution: true,
        origin
      }
    });
  } catch {
    // Outcome accounting is an audit side effect. It must never undo a tool
    // action the user explicitly approved.
    return null;
  }
}

function approvedInvocationWasAttempted(invokeResult) {
  if (!invokeResult || typeof invokeResult !== "object") return false;
  if (invokeResult.ok !== true) return true;
  const result = invokeResult.result;
  const status = typeof result?.status === "string" ? result.status.toLowerCase() : null;
  if (["awaiting_confirmation", "awaiting_owner_confirmation", "skipped", "no-op", "noop"].includes(status)) return false;
  return !(result?.skipped === true || result?.noop === true || result?.noOp === true || result?.alreadyActive === true);
}
