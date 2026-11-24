// Context-aware, agent-judged gate for proactive Supervisor chat updates.
// Prevents mechanical check-in spam, cross-node duplicate blasts, contradictory
// closed-goal alerts, and tone-deaf follow-ups by running deterministic
// deduplication + cooldown + cadence checks first, then letting the Supervisor
// agent evaluate recent conversation history to decide whether an update is
// genuinely useful right now and how to phrase it.

import { clampText, redactSecrets, shortHash } from "./contracts.js";
import { effectiveCheckinCooldownMs } from "./preferences.js";

const LEGACY_PROACTIVE_PREFIX_RE = /^\s*\*\*(?:Supervisor check-in|Post-send verification)\b/i;
const CLOSED_OR_NO_ACTION_RE = /\b(?:the\s+goal\s+is\s+already\s+closed|goal\s+is\s+(?:already\s+)?closed|did\s+no\s+new\s+work\s+this\s+turn|no\s+new\s+work\s+this\s+turn|no\s+owner\s+action\s+(?:is\s+)?required|nothing\s+left\s+to\s+do|already\s+shipped\s+and\s+verified)\b/i;
const ALREADY_MERGED_RE = /\balready\s+merged\s+into\s+(?:main|master)\b/i;
const MERGE_DECISION_RE = /\b(?:merge|land)\b/i;
const POST_MERGE_ACTION_RE = /\b(?:deploy|release|roll\s*out|publish|ship\s+to\s+prod|production|staging|restart|upgrade|verify\s+live|submit\s+for\s+review)\b/i;
const HUB_DEDUPE_TTL_MS = 4 * 60 * 60_000;
const MAX_TRACKED_KEYS = 400;

export function isProactiveSupervisorText(text) {
  return LEGACY_PROACTIVE_PREFIX_RE.test(String(text ?? ""));
}

export function isProactiveSupervisorMessage(message) {
  if (!message || typeof message !== "object") return false;
  if (message.metadata?.proactive === true || message.proactive === true) return true;
  if (message.role !== "assistant") return false;
  return isProactiveSupervisorText(message.content ?? message.text ?? "");
}

function normalizeIdentityText(raw) {
  return String(raw ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9#]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Filters out contradictory zombie asks where the owning session's latest
// message explicitly states the goal is already closed/done/merged while an
// old question still asks for a decision. Preserves legitimate post-merge
// follow-up decisions (e.g. "PR is already merged into main. May I deploy to prod?").
export function isClosedOrContradictoryDecision(question, thread = null, ctx = null) {
  if (!question || question.kind === "ready" || question.mergeAsk) return false;
  const recentAssistant = Array.isArray(thread?.meta?.conversation)
    ? thread.meta.conversation.findLast((m) => m?.role === "assistant")?.text ?? ""
    : "";
  const probe = [
    thread?.lastAgentText,
    recentAssistant,
    ctx?.status
  ].filter(Boolean).join("\n");
  if (!probe) return false;
  if (CLOSED_OR_NO_ACTION_RE.test(probe)) return true;
  if (ALREADY_MERGED_RE.test(probe)) {
    const decisionText = [question.title, question.body, ctx?.decision].filter(Boolean).join(" ");
    if (MERGE_DECISION_RE.test(decisionText) && !POST_MERGE_ACTION_RE.test(decisionText)) {
      return true;
    }
  }
  return false;
}

// Collapses duplicate open decisions within a single digest (e.g. two failed-over
// or cloned sessions with the exact same project title or PR ref) so the owner
// never receives back-to-back copies of the same item in one message.
export function dedupeDecisionDeltas(deltas = [], contextFor = () => null) {
  if (!Array.isArray(deltas) || deltas.length <= 1) return Array.isArray(deltas) ? [...deltas] : [];
  const seenPr = new Set();
  const seenTitleDecision = new Set();
  const kept = [];
  for (const delta of deltas) {
    const q = delta?.question;
    if (!q) continue;
    const ctx = contextFor(q) ?? null;
    const prRef = String(q.prRef ?? "").trim().toLowerCase();
    const normTitle = normalizeIdentityText(ctx?.itemName || q.title || "");
    const normDecision = normalizeIdentityText(ctx?.decision || q.askedAs?.title || q.title || "");
    const prKey = prRef ? `pr:${prRef}:${q.kind === "prompt" ? "prompt" : "decision"}` : null;
    const titleKey = normTitle ? `title:${normTitle}:${normDecision.slice(0, 80)}` : null;
    const titleOnlyKey = normTitle && prRef ? `titlepr:${normTitle}:${prRef}` : null;
    if ((prKey && seenPr.has(prKey)) || (titleKey && seenTitleDecision.has(titleKey)) || (titleOnlyKey && seenPr.has(titleOnlyKey))) {
      continue;
    }
    if (prKey) seenPr.add(prKey);
    if (titleKey) seenTitleDecision.add(titleKey);
    if (titleOnlyKey) seenPr.add(titleOnlyKey);
    kept.push(delta);
  }
  return kept;
}

function extractJsonObject(rawText) {
  const text = String(rawText ?? "").trim();
  if (!text) return null;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = (fenced ? fenced[1] : text).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isRealConfiguredProvider(provider) {
  if (!provider || typeof provider.generate !== "function") return false;
  if (typeof provider.isConfigured === "function" && !provider.isConfigured()) return false;
  const ctorName = String(provider.constructor?.name ?? "");
  if (ctorName === "DeterministicModelProvider" || ctorName === "NoneProvider") return false;
  if (provider.name === "deterministic" || provider.name === "none") return false;
  return true;
}

function formatRecentConversationForReview(messages = [], maxMessages = 10, maxChars = 4800) {
  const visible = (Array.isArray(messages) ? messages : [])
    .filter((m) => m && ["user", "assistant"].includes(m.role) && typeof (m.content ?? m.text) === "string")
    .slice(-maxMessages);
  if (!visible.length) return "(no prior messages in this chat)";
  const lines = visible.map((m) => {
    const tag = m.role === "user"
      ? "Spencer"
      : (isProactiveSupervisorMessage(m) ? "Peri (prior proactive update)" : "Peri");
    const stamp = typeof (m.createdAt ?? m.at) === "string" ? ` [${String(m.createdAt ?? m.at).slice(11, 16)}Z]` : "";
    return `${tag}${stamp}: ${clampText(redactSecrets(String(m.content ?? m.text)), 520)}`;
  });
  return lines.join("\n").slice(-maxChars);
}

// Runs a lightweight, zero-tool judgment pass through Peri so proactive
// follow-ups are actually thought through against recent conversation context
// instead of blindly blasting mechanical templates.
export async function reviewProactiveUpdateWithAgent({
  candidateText,
  kind = "proactive_supervisor_delta",
  decisionKeys = [],
  recentMessages = [],
  preferences = {},
  modelProvider = null,
  judgeFn = null
} = {}) {
  const cleanCandidate = String(candidateText ?? "").trim();
  if (!cleanCandidate) return { send: false, reason: "empty", agentReviewed: false };

  if (typeof judgeFn === "function") {
    const verdict = await judgeFn({
      candidateText: cleanCandidate,
      kind,
      decisionKeys,
      recentMessages,
      preferences
    });
    if (!verdict || typeof verdict !== "object") {
      return { send: true, text: cleanCandidate, reason: "judge_default", agentReviewed: true };
    }
    if (verdict.send === false) {
      return { send: false, reason: clampText(String(verdict.reason ?? "suppressed_by_agent"), 180), agentReviewed: true };
    }
    const composed = typeof verdict.message === "string" && verdict.message.trim()
      ? clampText(redactSecrets(verdict.message.trim()), 6000)
      : cleanCandidate;
    return {
      send: true,
      text: composed,
      reason: clampText(String(verdict.reason ?? "approved_by_agent"), 180),
      agentReviewed: true
    };
  }

  if (!isRealConfiguredProvider(modelProvider)) {
    return { send: true, text: cleanCandidate, reason: "no_live_model_provider", agentReviewed: false };
  }

  const cadence = preferences?.cadence ?? "balanced";
  const formatPref = typeof preferences?.checkinFormat === "string" && preferences.checkinFormat.trim()
    ? preferences.checkinFormat.trim()
    : null;
  const recentHistory = formatRecentConversationForReview(recentMessages);

  const instructions = [
    "You are Peri, Spencer's OpenAGI Supervisor agent, deciding whether to proactively interrupt Spencer in his Supervisor chat with a candidate update.",
    "You have ZERO tools on this turn. Think carefully about usefulness and context awareness before sending anything.",
    "Suppress the update (`\"send\": false`) if ANY of these are true:",
    "1. You already sent Spencer essentially the same update, decision, or project/PR blocker recently in the conversation history.",
    "2. Spencer recently told you to stop, mute, pause, or ignore updates on this project/topic or in general.",
    "3. The candidate contradicts itself (e.g. says the goal is already closed/done/merged while asking for a decision, or reports a normal finished turn as an owner blocker).",
    "4. It adds no actionable new information that warrants interrupting Spencer right now.",
    "Approve (`\"send\": true`) ONLY if there is a genuinely new, concrete, actionable decision or real failure Spencer needs to know about right now.",
    formatPref
      ? `When sending, strictly follow Spencer's saved update format preference: ${formatPref}`
      : "When sending, write a crisp, context-aware update (remove any duplicate items, keep every real option and recommendation intact, include Goal, Where it stands, and exact Decision needed; never dump raw mechanical boilerplate).",
    "Respond with ONLY valid JSON: {\"send\": true|false, \"reason\": \"short explanation\", \"message\": \"final markdown message when send is true\"}."
  ].join("\n");

  const input = [
    `Current cadence preference: ${cadence}`,
    `Update kind: ${kind}`,
    "",
    "Recent Supervisor conversation (oldest to newest):",
    recentHistory,
    "",
    "Candidate proactive update to evaluate:",
    clampText(cleanCandidate, 5500)
  ].join("\n");

  try {
    const result = await modelProvider.generate({
      input,
      instructions,
      messages: [],
      tools: [],
      task: "plan",
      agent: { id: "supervisor-proactive-gate", name: "Peri" }
    });
    const parsed = extractJsonObject(result?.text ?? "");
    if (!parsed || typeof parsed.send !== "boolean") {
      return { send: true, text: cleanCandidate, reason: "unparseable_agent_verdict", agentReviewed: false };
    }
    if (!parsed.send) {
      return {
        send: false,
        reason: clampText(String(parsed.reason ?? "suppressed_by_agent"), 180),
        agentReviewed: true
      };
    }
    const composed = typeof parsed.message === "string" && parsed.message.trim().length >= 20
      ? clampText(redactSecrets(parsed.message.trim()), 6000)
      : cleanCandidate;
    return {
      send: true,
      text: composed,
      reason: clampText(String(parsed.reason ?? "approved_by_agent"), 180),
      agentReviewed: true
    };
  } catch {
    return { send: true, text: cleanCandidate, reason: "agent_review_error_fallback", agentReviewed: false };
  }
}

function contentFingerprint(text) {
  const norm = String(text ?? "")
    .toLowerCase()
    .replace(/\b\d+\s*(?:min|mins|minutes?|h|hr|hrs|hours?|s|sec|secs|seconds?)\b/g, "#")
    .replace(/\b(?:new|changed):/g, "item:")
    .replace(/[^a-z0-9#]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return shortHash(norm);
}

// Single-hub gate for proactive appends arriving at the main daemon (whether
// from local FleetSupervisor or from paired nodes like buildbot3 / spencer-mac).
// Enforces cadence, cross-node dedupe, global cooldown, and agent judgment in
// one place so multiple paired nodes can never flood the shared chat.
export function createHubProactiveGuard({
  getPreferences = () => ({}),
  getRecentMessages = () => [],
  getModelProvider = () => null,
  judgeProactiveUpdate = null,
  getLastPostedAtMs = null,
  onPosted = null,
  now = () => Date.now()
} = {}) {
  let lastPostedAtMs = 0;
  let evalChain = Promise.resolve();
  const recentFingerprints = new Map();
  const recentDecisionTokens = new Map();

  const prune = (nowMs) => {
    for (const [k, at] of recentFingerprints) {
      if (nowMs - at >= HUB_DEDUPE_TTL_MS) recentFingerprints.delete(k);
    }
    for (const [k, at] of recentDecisionTokens) {
      if (nowMs - at >= HUB_DEDUPE_TTL_MS) recentDecisionTokens.delete(k);
    }
    while (recentFingerprints.size > MAX_TRACKED_KEYS) {
      recentFingerprints.delete(recentFingerprints.keys().next().value);
    }
    while (recentDecisionTokens.size > MAX_TRACKED_KEYS) {
      recentDecisionTokens.delete(recentDecisionTokens.keys().next().value);
    }
  };

  const evaluateSerialized = async ({ text, kind = "proactive_supervisor_delta", decisionKeys = [], decisionTokens = [], alreadyAgentReviewed = false, skipCooldown = false, judgeFn = null, persist = null } = {}) => {
    const cleanText = String(text ?? "").trim();
    if (!cleanText) return { send: false, reason: "empty" };
    const nowMs = now();
    prune(nowMs);
    const prefs = getPreferences?.() ?? {};
    if (prefs?.cadence === "off") {
      return { send: false, reason: "cadence_off" };
    }

    const fp = contentFingerprint(cleanText);
    if (recentFingerprints.has(fp)) {
      return { send: false, reason: "hub_deduped" };
    }
    const cleanKeys = Array.isArray(decisionKeys)
      ? decisionKeys.map((k) => String(k ?? "").trim()).filter(Boolean)
      : [];
    // Deduplicate by decision key + material hash when available so materially
    // changed decisions (e.g., a new PR head SHA or new choices) remain
    // announceable after cooldown instead of being blocked for 4 hours.
    const cleanTokens = Array.isArray(decisionTokens) && decisionTokens.length > 0
      ? decisionTokens.map((t) => String(t ?? "").trim()).filter(Boolean)
      : cleanKeys;
    if (cleanTokens.length > 0 && cleanTokens.every((t) => recentDecisionTokens.has(t))) {
      return { send: false, reason: "hub_decisions_deduped" };
    }

    // Post-send verification failure notices on owner-directed watches are
    // one-shot truth reports (resolved once the watch settles), so exempt them
    // from global check-in cooldown rather than silently dropping them.
    const bypassCooldown = skipCooldown === true || kind === "follow_through_verification";
    const externalLastPosted = Number(getLastPostedAtMs?.()) || 0;
    const effectiveLastPostedAtMs = Math.max(lastPostedAtMs, externalLastPosted);
    const cooldownMs = effectiveCheckinCooldownMs(prefs);
    if (!bypassCooldown && cooldownMs > 0 && effectiveLastPostedAtMs > 0 && nowMs - effectiveLastPostedAtMs < cooldownMs) {
      return { send: false, deferred: true, reason: "hub_cooldown" };
    }

    let finalText = cleanText;
    let agentReviewed = Boolean(alreadyAgentReviewed);
    if (!alreadyAgentReviewed) {
      const verdict = await reviewProactiveUpdateWithAgent({
        candidateText: cleanText,
        kind,
        decisionKeys: cleanKeys,
        recentMessages: getRecentMessages?.() ?? [],
        preferences: prefs,
        modelProvider: getModelProvider?.() ?? null,
        judgeFn: judgeFn ?? judgeProactiveUpdate
      });
      agentReviewed = verdict.agentReviewed;
      if (!verdict.send) {
        recentFingerprints.set(fp, nowMs);
        for (const t of cleanTokens) recentDecisionTokens.set(t, nowMs);
        return { send: false, reason: verdict.reason, agentReviewed };
      }
      finalText = verdict.text || cleanText;
    }

    // Commit dedupe & cooldown state ONLY after persistence succeeds when a
    // persist callback is provided, so a failed conversation-store append never
    // permanently suppresses retries after storage recovers.
    let persistResult = null;
    if (typeof persist === "function") {
      try {
        persistResult = await persist(finalText, { agentReviewed });
        if (persistResult === false || persistResult?.ok === false) {
          return { send: false, deferred: true, reason: "persist_failed", agentReviewed };
        }
      } catch (error) {
        return { send: false, deferred: true, reason: "persist_failed", error, agentReviewed };
      }
    }

    lastPostedAtMs = nowMs;
    try { onPosted?.(nowMs); } catch { /* best-effort */ }
    recentFingerprints.set(fp, nowMs);
    recentFingerprints.set(contentFingerprint(finalText), nowMs);
    for (const t of cleanTokens) recentDecisionTokens.set(t, nowMs);
    return { send: true, text: finalText, agentReviewed, ...(persistResult != null ? { persistResult } : {}) };
  };

  return {
    evaluate(args = {}) {
      const next = evalChain.then(
        () => evaluateSerialized(args),
        () => evaluateSerialized(args)
      );
      evalChain = next.catch(() => {});
      return next;
    },
    reset() {
      lastPostedAtMs = 0;
      recentFingerprints.clear();
      recentDecisionTokens.clear();
    }
  };
}
