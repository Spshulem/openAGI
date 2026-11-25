// Per-chat reasoning effort: the owner asks the agent in a chat ("set your
// reasoning effort to extra high") and only that chat session thinks harder
// from its next turn on. Nothing global changes — env defaults, other chats,
// background tasks and Paseo coding sessions keep their own settings.
//
// The choice lives on the session record (metadata.reasoningEffort) so it
// survives restarts with the conversation it belongs to, and is applied only
// to foreground `chat` turns on a provider that really sends an effort.

import { REASONING_EFFORTS } from "./model-router.js";

export const SESSION_EFFORT_KEY = "reasoningEffort";

// Spoken/typed names the owner uses, mapped to the canonical API values.
const ALIASES = new Map([
  ["extra high", "xhigh"], ["extra-high", "xhigh"], ["extrahigh", "xhigh"], ["x-high", "xhigh"],
  ["x high", "xhigh"], ["xhigh", "xhigh"], ["very high", "xhigh"],
  ["med", "medium"], ["normal", "medium"],
  ["min", "minimal"], ["minimum", "minimal"],
  ["off", "none"]
]);

export function normalizeReasoningEffort(value) {
  const raw = String(value ?? "").trim().toLowerCase().replace(/[_]+/g, " ").replace(/\s+/g, " ");
  if (!raw) return null;
  const mapped = ALIASES.get(raw) ?? raw;
  return REASONING_EFFORTS.includes(mapped) ? mapped : null;
}

// What the active provider can do: { supported, provider, model, options,
// configuredDefault, reason }. A provider opts in by implementing
// reasoningEffortSupport(); anything else is reported unsupported rather than
// pretending a setting took effect.
export function providerReasoningEffortSupport(provider, { task = "chat" } = {}) {
  const name = provider?.name ?? provider?.constructor?.name ?? "unknown";
  let model = null;
  try { model = provider?.resolveModel?.({ task }) ?? provider?.model ?? null; } catch { model = provider?.model ?? null; }
  if (typeof provider?.reasoningEffortSupport !== "function") {
    return { supported: false, provider: name, model, options: [], configuredDefault: null,
      reason: `The active model provider (${name}) does not expose a per-request reasoning-effort setting.` };
  }
  let support;
  try { support = provider.reasoningEffortSupport({ task }) ?? {}; } catch (error) {
    return { supported: false, provider: name, model, options: [], configuredDefault: null,
      reason: `Could not read reasoning-effort support: ${String(error?.message ?? error).slice(0, 160)}` };
  }
  const options = Array.isArray(support.options) ? support.options.filter((o) => REASONING_EFFORTS.includes(o)) : [];
  return {
    supported: support.supported === true && options.length > 0,
    provider: support.provider ?? name,
    model: support.model ?? model,
    options,
    configuredDefault: support.configuredDefault ?? null,
    reason: support.supported === true && options.length > 0 ? null : (support.reason ?? `The active model provider (${name}) does not support reasoning effort.`)
  };
}

export function sessionReasoningEffort(session) {
  const entry = session?.metadata?.[SESSION_EFFORT_KEY];
  const effort = normalizeReasoningEffort(entry?.effort);
  return effort ? { effort, setAt: entry.setAt ?? null, setBy: entry.setBy ?? null } : null;
}

// The effort a foreground chat turn should send, or null for the provider's
// own default. An override the current provider cannot honor is dropped (a
// later provider switch must not 400 every turn).
export function effectiveSessionReasoningEffort(session, provider, { task = "chat" } = {}) {
  if (task !== "chat") return null;
  const override = sessionReasoningEffort(session);
  if (!override) return null;
  const support = providerReasoningEffortSupport(provider, { task });
  return support.supported && support.options.includes(override.effort) ? override.effort : null;
}

// Read the current setting for one chat session, in the shape the tool returns.
export function describeSessionReasoningEffort({ store, provider, sessionId }) {
  const session = store.getSession(sessionId);
  const override = sessionReasoningEffort(session);
  const support = providerReasoningEffortSupport(provider, { task: "chat" });
  const applied = override && support.supported && support.options.includes(override.effort) ? override.effort : null;
  return {
    sessionId,
    scope: "this chat session only",
    provider: support.provider,
    model: support.model,
    supported: support.supported,
    options: support.options,
    sessionOverride: override?.effort ?? null,
    effective: applied ?? support.configuredDefault ?? "provider default",
    ...(override && !applied ? { note: `Saved override "${override.effort}" is not supported by ${support.provider} and is not being sent.` } : {}),
    ...(support.reason ? { unavailableReason: support.reason } : {})
  };
}

// Set (effort) or clear (effort null) the override on one chat session, then
// read it back from the store so the reply reports what actually persisted.
export function applySessionReasoningEffort({ store, provider, sessionId, effort, setBy = "owner" }) {
  if (!sessionId) throw new Error("No current chat session to change.");
  const support = providerReasoningEffortSupport(provider, { task: "chat" });
  let next = null;
  if (effort !== null) {
    next = normalizeReasoningEffort(effort);
    if (!next) throw new Error(`"${String(effort).slice(0, 40)}" is not a reasoning effort (${REASONING_EFFORTS.join(", ")}).`);
    if (!support.supported) throw new Error(support.reason);
    if (!support.options.includes(next)) {
      throw new Error(`${support.provider} supports ${support.options.join(", ")} — not "${next}".`);
    }
  }
  const session = store.getSession(sessionId);
  const metadata = { ...(session.metadata ?? {}) };
  const before = sessionReasoningEffort(session)?.effort ?? null;
  if (next) metadata[SESSION_EFFORT_KEY] = { effort: next, setAt: new Date().toISOString(), setBy };
  else delete metadata[SESSION_EFFORT_KEY];
  store.saveSession({ ...session, metadata });
  const readback = describeSessionReasoningEffort({ store, provider, sessionId });
  if (readback.sessionOverride !== next) {
    throw new Error(`Reasoning effort did not persist (read back ${readback.sessionOverride ?? "none"}).`);
  }
  return {
    ...readback,
    previous: before,
    changed: before !== next,
    takesEffect: "from the next message in this chat; the reply already in progress keeps its current effort"
  };
}
