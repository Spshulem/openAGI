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
  // The context it was asked in must still hold: the same chat, still there,
  // and nothing the owner said since that makes it stale.
  const verdict = typeof runtime.tools?.approvalVerdict === "function"
    ? await runtime.tools.approvalVerdict(action)
    : staleVerdict(await runtime.tools?.approvalStillValid?.(action));
  const stale = verdict?.reason ?? null;
  if (stale) {
    // Re-raised only if this call retired it: a card denied or run on
    // another surface meanwhile stays as it is.
    // The owner's own words behind a chat card go with it to the fresh one,
    // so approving it still carries the rest of a multi-step request.
    const ownerIntent = runtime.pendingActions.ownerIntentFor?.(id) ?? null;
    const expired = runtime.pendingActions.expire?.(id, stale) ?? null;
    const reraised = verdict.reraise && expired ? reraiseStaleApproval(runtime, action, stale, ownerIntent) : null;
    // Nothing ran: say so in words a model cannot read as "on its way".
    const error = reraised
      ? `${stale} Nothing was sent or started. A fresh approval is waiting${reraised.confirmCode ? ` (code ${reraised.confirmCode})` : ""}; approve it to send.`
      : stale;
    return {
      status: 410,
      body: { error, notRun: true, ...(reraised ? { reraised: { actionId: reraised.id, ...(reraised.confirmCode ? { code: reraised.confirmCode } : {}) } } : {}) },
      action: runtime.pendingActions.get(id) ?? action
    };
  }
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

function staleVerdict(reason) {
  return typeof reason === "string" && reason ? { reason, reraise: false } : null;
}

// A card retired because the owner said more in its target since (the tool's
// check asked for a re-raise), raised again with the very same arguments, in
// the same chat and mode, so the request waits for a fresh "yes" instead of
// vanishing. Null when the store cannot raise one.
function reraiseStaleApproval(runtime, action, reason, ownerIntent = null) {
  if (typeof runtime.pendingActions?.enqueue !== "function") return null;
  const tool = runtime.tools?.get?.(action?.toolName);
  try {
    return runtime.pendingActions.enqueue({
      toolName: action.toolName,
      args: action.args,
      context: action.context,
      summary: action.summary,
      reason: `Asked again: ${String(reason ?? "").slice(0, 200)}`,
      dedupeKey: action.dedupeKey,
      ttlMs: tool?.approvalTtlMs ?? null,
      mode: action.mode ?? "queue",
      announce: action.mode !== "chat",
      ...(ownerIntent ? { ownerIntent } : {})
    });
  } catch {
    return null;
  }
}
