// Synthesizes the Claude-Duet-style SupervisorCard deck, compact active
// session summary, coalesced catch-up brief, and Scrutinizer autonomy banner
// from the fleet supervisor's state. Existing FleetState fields remain intact
// so Android, push extensions, and older clients stay 100% compatible.

import { clampText, parsePrRef, redactSecrets } from "./contracts.js";
import { buildProgressivePreferenceCards, isSuppressedByQuietCadence, normalizePreferences, SAFE_SLICES } from "./preferences.js";

const SETTLED_PR = new Set(["MERGED", "CLOSED"]);
const DAY_MS = 24 * 60 * 60 * 1000;

const OPTION_LABELS = Object.freeze({
  yes: "Approve",
  no: "Decline",
  approve: "Approve",
  allow: "Allow",
  "allow once": "Allow once",
  merged: "Mark merged",
  later: "Later",
  dismiss: "Later",
  skip: "Skip",
  wait: "Wait",
  added: "Added capacity",
  retry: "Retry",
  restart: "Restart app",
  done: "Done",
  opened: "Opened",
  "open thread": "Open chat",
  "keep going": "Keep going",
  stop: "Stop thread",
  fixed: "Fixed"
});

function humanOptionLabel(option) {
  const raw = String(option ?? "").trim();
  if (!raw) return "Select";
  const mapped = OPTION_LABELS[raw.toLowerCase()];
  if (mapped) return mapped;
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

function classifyCardKind(question) {
  if (question.kind === "ready" || question.mergeAsk) {
    return { kind: "merge_ready", kindLabel: "PR Ready", rank: 0 };
  }
  if (["prompt", "agent-ask", "agent-card", "self-fix"].includes(question.kind)) {
    return { kind: "approval", kindLabel: "Needs Decision", rank: 1 };
  }
  if (["stuck", "limit", "open", "deliver"].includes(question.kind)) {
    return { kind: "blocker", kindLabel: "Blocker", rank: 2 };
  }
  if (question.kind === "suggestion") {
    return { kind: "suggestion", kindLabel: "Improvement", rank: 4 };
  }
  return { kind: "infra", kindLabel: "System", rank: 3 };
}

// Filters questions whose underlying condition resolved since the question
// was opened, or routine updates suppressed by "quiet_until_ready" cadence.
function isQuestionLiveForDeck(question, row, prefs) {
  if (!question || question.status !== "open") return false;
  if (row?.muted) return false;
  if (row?.pr?.state && SETTLED_PR.has(row.pr.state) && (question.kind === "ready" || question.mergeAsk)) {
    return false;
  }
  if (question.kind === "agent-ask" && !question.mergeAsk && row) {
    const askedMs = Date.parse(question.agentAskedAt ?? question.createdAt ?? "");
    const agentMs = Date.parse(row.lastAgentAt ?? "");
    if (row.agentStatus === "running" && Number.isFinite(askedMs) && Number.isFinite(agentMs) && agentMs > askedMs + 2000) {
      return false;
    }
  }
  if (isSuppressedByQuietCadence(question, prefs)) return false;
  return true;
}

function buildActionsForQuestion(question, row, prRef) {
  const options = Array.isArray(question.options) ? question.options.filter(Boolean) : [];
  const ciState = row?.pr?.ci?.state ?? null;
  const mergeState = row?.pr?.mergeState ?? null;

  if (question.answerIn === "agent app" || question.kind === "agent-card") {
    const chatLabel = question.openChat?.app
      ? `Open in ${question.openChat.app.charAt(0).toUpperCase() + question.openChat.app.slice(1)}`
      : "Open in app";
    return {
      primaryAction: { op: "open_chat", label: chatLabel, value: options.includes("open thread") ? "open thread" : "opened", destructive: false },
      secondaryAction: { op: "defer", label: "Later", value: "dismiss", destructive: false }
    };
  }

  if ((question.kind === "ready" || question.mergeAsk) && prRef && parsePrRef(prRef)) {
    if (ciState === "FAILURE" || ciState === "ERROR" || mergeState === "DIRTY") {
      return {
        primaryAction: { op: "fix_ci", label: mergeState === "DIRTY" ? "Have agent rebase" : "Have agent fix CI", value: "fix_ci", destructive: false },
        secondaryAction: { op: "defer", label: "Later", value: options.includes("later") ? "later" : "dismiss", destructive: false }
      };
    }
    if (ciState === "PENDING" || ciState === "IN_PROGRESS") {
      return {
        primaryAction: { op: "merge", label: "Watch CI", value: prRef, destructive: false },
        secondaryAction: { op: "defer", label: "Later", value: options.includes("later") ? "later" : "dismiss", destructive: false }
      };
    }
    return {
      primaryAction: { op: "merge", label: "Merge PR", value: prRef, destructive: false },
      secondaryAction: { op: "defer", label: "Later", value: options.includes("later") ? "later" : "dismiss", destructive: false }
    };
  }

  const realOptions = options.filter((opt) => opt !== "dismiss");
  const first = realOptions[0] ?? null;
  const second = realOptions[1] ?? null;
  const primaryAction = first
    ? {
        op: "answer",
        label: humanOptionLabel(first),
        value: first,
        destructive: /^(?:delete|destroy|wipe|close pr|stop)$/i.test(first)
      }
    : { op: "defer", label: "Dismiss", value: "dismiss", destructive: false };

  const secondaryAction = second && !["later", "dismiss"].includes(second.toLowerCase())
    ? { op: "answer", label: humanOptionLabel(second), value: second, destructive: /^(?:delete|destroy|wipe)$/i.test(second) }
    : { op: "defer", label: "Later", value: options.includes("later") ? "later" : "dismiss", destructive: false };

  return { primaryAction, secondaryAction };
}

function buildRecommendation(question, row, prRef, prefs) {
  if (question.reviewReason) {
    return clampText(redactSecrets(question.reviewReason), 220);
  }
  const ci = row?.pr?.ci?.state ?? null;
  if ((question.kind === "ready" || question.mergeAsk) && prRef) {
    if (ci === "FAILURE" || ci === "ERROR") {
      const failing = (row?.pr?.ci?.failing ?? []).slice(0, 2).join(", ");
      return `CI failed${failing ? ` (${failing})` : ""}. Send back to the coding session before merging.`;
    }
    if (ci === "PENDING") {
      return "Checks are still running. Auto-merge is off by default—tap Watch CI to get pinged when green.";
    }
    const threads = Number(row?.pr?.unresolvedThreads ?? 0);
    return `CI green${threads === 0 ? " · 0 unresolved review threads" : ` · ${threads} review thread(s)`}. Manual confirm required (${prefs.mergePolicy === "manual_confirm" ? "auto-merge off" : "queue after tap"}).`;
  }
  if (row?.reason) {
    return clampText(redactSecrets(row.reason), 200);
  }
  return null;
}

function buildSummary(question, row) {
  const parts = [];
  if (row?.pr?.title && !String(question.title ?? "").includes(row.pr.title)) {
    parts.push(row.pr.title);
  }
  if (question.card) {
    parts.push(question.card);
  } else if (question.body) {
    parts.push(question.body);
  } else if (question.askContext) {
    parts.push(question.askContext);
  } else if (row?.lastAgentText) {
    parts.push(row.lastAgentText);
  }
  const joined = parts.filter(Boolean).join(" — ");
  return clampText(redactSecrets(joined || row?.reason || "Waiting for your decision."), 360);
}

function buildTimeline(question, row, actions = []) {
  const timeline = [];
  const threadKey = question.threadKey ?? null;
  const relevant = threadKey
    ? actions.filter((a) => a && a.threadKey === threadKey && ["sent", "done", "proposed", "blocked"].includes(a.status)).slice(0, 3).reverse()
    : [];
  for (const act of relevant) {
    timeline.push({
      at: act.at ?? null,
      label: act.playbook ? `Playbook: ${act.playbook}` : (act.kind ?? "Update"),
      detail: clampText(redactSecrets(act.reason || act.detail || act.message || act.status), 160)
    });
  }
  if (row?.pr?.ci?.state) {
    timeline.push({
      at: question.updatedAt ?? question.createdAt ?? null,
      label: `GitHub CI: ${row.pr.ci.state}`,
      detail: row.pr.ref ? `${row.pr.ref}${row.pr.head ? ` @ ${row.pr.head}` : ""}` : "Pull request checks"
    });
  }
  timeline.push({
    at: question.askedAt ?? question.createdAt ?? null,
    label: question.kind === "ready" ? "Ready for review" : "Needs your call",
    detail: clampText(redactSecrets(question.title), 160)
  });
  if (question.reviewedAt && question.reviewReason) {
    timeline.push({
      at: question.reviewedAt,
      label: "Scrutinizer verified",
      detail: clampText(redactSecrets(question.reviewReason), 160)
    });
  }
  return timeline;
}

function buildResources(question, row, prRef) {
  const resources = [];
  const threadKey = question.threadKey ?? question.threadKeys?.[0] ?? null;
  if (threadKey) {
    resources.push({
      kind: "conversation",
      label: question.chatLabel || row?.title || row?.workspace || "Agent conversation",
      url: null,
      threadKey
    });
  }
  const parsedPr = parsePrRef(prRef);
  const prUrl = row?.pr?.url ?? (parsedPr ? `https://github.com/${parsedPr.repo}/pull/${parsedPr.number}` : null);
  if (prUrl || prRef) {
    resources.push({
      kind: "pr",
      label: parsedPr ? `Pull Request #${parsedPr.number} (${parsedPr.repo})` : String(prRef),
      url: prUrl,
      threadKey: null
    });
  }
  const openChat = question.openChat ?? row?.openChat ?? null;
  if (openChat?.url || openChat?.app) {
    resources.push({
      kind: "app",
      label: openChat.label ? `Open ${openChat.label}` : `Open in ${openChat.app ?? "app"}`,
      url: openChat.url ?? null,
      threadKey
    });
  }
  return resources;
}

export function buildSupervisorCard(question, { rowsByKey = new Map(), actions = [], prefs = normalizePreferences(null) } = {}) {
  const primaryKey = question.threadKey ?? question.threadKeys?.[0] ?? null;
  const row = primaryKey ? rowsByKey.get(primaryKey) ?? null : null;
  const prRef = question.prRef ?? row?.pr?.ref ?? null;
  const parsedPr = parsePrRef(prRef);
  const { kind, kindLabel, rank } = classifyCardKind(question);
  const { primaryAction, secondaryAction } = buildActionsForQuestion(question, row, prRef);

  return {
    id: question.id,
    questionId: question.id,
    kind,
    kindLabel,
    rank,
    headline: clampText(redactSecrets(question.title), 140),
    summary: buildSummary(question, row),
    recommendation: buildRecommendation(question, row, prRef, prefs),
    threadKey: primaryKey,
    threadKeys: question.threadKeys ?? (primaryKey ? [primaryKey] : []),
    repo: row?.repo ?? parsedPr?.repo ?? null,
    branch: row?.branch ?? null,
    workspace: row?.workspace ?? null,
    prRef: prRef ?? null,
    prUrl: row?.pr?.url ?? (parsedPr ? `https://github.com/${parsedPr.repo}/pull/${parsedPr.number}` : null),
    prNumber: parsedPr?.number ?? null,
    headSha: row?.pr?.head ?? question.askedHead ?? null,
    ciState: row?.pr?.ci?.state ?? null,
    mergeState: row?.pr?.mergeState ?? null,
    noticedAt: question.askedAt ?? question.createdAt ?? null,
    answerIn: question.answerIn ?? "here",
    risky: Boolean(question.risky),
    options: Array.isArray(question.options) ? [...question.options] : [],
    primaryAction,
    secondaryAction,
    timeline: buildTimeline(question, row, actions),
    resources: buildResources(question, row, prRef),
    openChat: question.openChat ?? row?.openChat ?? null
  };
}

export function buildActiveSummary(snapshot, liveCards = []) {
  const threads = Array.isArray(snapshot?.threads) ? snapshot.threads.filter((row) => row?.key) : [];
  let running = 0;
  let waitingCi = 0;
  let blocked = 0;
  let quiet = 0;
  const activeThreads = [];

  for (const row of threads) {
    const group = row.watch?.group ?? null;
    const isRunning = row.agentStatus === "running" || row.state === "running" || group === "working";
    const isCi = row.state === "waiting-ci" || group === "waiting" || row.pr?.ci?.state === "PENDING";
    const isBlocked = row.health === "red" || group === "you" || group === "blocked";
    if (isRunning) running += 1;
    else if (isCi) waitingCi += 1;
    else if (isBlocked) blocked += 1;
    else quiet += 1;

    if (isRunning || isCi || isBlocked || group === "push") {
      activeThreads.push({
        key: row.key,
        kind: row.kind ?? null,
        title: row.title || row.workspace || row.key,
        repo: row.repo ?? null,
        branch: row.branch ?? null,
        state: row.state ?? "unknown",
        health: row.health ?? "gray",
        reason: row.reason ?? null,
        prRef: row.pr?.ref ?? null,
        ciState: row.pr?.ci?.state ?? null,
        lastActivityAt: row.lastActivityAt ?? null,
        openChat: row.openChat ?? null
      });
    }
  }

  return {
    total: threads.length,
    running,
    waitingCi,
    needsYou: liveCards.filter((c) => c.kind !== "preference").length,
    blocked,
    quiet,
    activeThreads: activeThreads.slice(0, 30)
  };
}

export function buildAutonomySummary(actions = [], rawPrefs = null, openQuestionCount = 0, now = Date.now()) {
  const prefs = normalizePreferences(rawPrefs);
  const since = now - DAY_MS;
  const recentSent = actions.filter((a) => {
    const at = Date.parse(a?.at ?? "");
    return Number.isFinite(at) && at >= since && !String(a?.playbook ?? "").startsWith("auto-slice:") && (
      (a.kind === "nudge" && a.status === "sent")
      || (a.kind === "review" && a.status === "done")
    );
  });
  const sliceActionsToday = prefs.autonomousActions.filter((a) => {
    const at = Date.parse(a?.at ?? "");
    return Number.isFinite(at) && at >= since && !a.reverted;
  });
  const handledToday = recentSent.length + sliceActionsToday.length;
  const denominator = handledToday + Math.max(0, openQuestionCount);
  const autonomyPercent = denominator > 0 ? Math.round((handledToday / denominator) * 100) : 0;

  const recentActions = [
    ...prefs.autonomousActions.slice(-5).reverse().map((item) => ({
      id: item.id,
      at: item.at,
      slice: item.slice,
      sliceLabel: item.slice ? (SAFE_SLICES[item.slice]?.label ?? item.slice) : "Routine",
      threadKey: item.threadKey,
      summary: item.summary,
      reverted: item.reverted === true,
      vetoed: item.reverted === true,
      canVeto: !item.reverted && Boolean(item.slice)
    })),
    ...recentSent.slice(0, 5).map((act) => ({
      id: act.id,
      at: act.at,
      slice: null,
      sliceLabel: act.playbook ?? act.kind ?? "Supervisor",
      threadKey: act.threadKey ?? null,
      summary: clampText(redactSecrets(act.reason || act.detail || act.playbook || "Handled routine check"), 140),
      reverted: false,
      vetoed: false,
      canVeto: false
    }))
  ].slice(0, 6);

  const activeAutoSlices = Object.entries(prefs.autoSlices)
    .filter(([, mode]) => mode === "auto")
    .map(([key]) => ({ id: key, label: SAFE_SLICES[key]?.label ?? key }));

  return {
    handledToday,
    handledCount: handledToday,
    totalDecisions: denominator,
    autonomyPercent,
    autonomousPercent: autonomyPercent,
    mergePolicy: prefs.mergePolicy,
    cadence: prefs.cadence,
    activeAutoSlices,
    recentActions
  };
}

export function buildCatchUpSummary(cards = [], activeSummary = null) {
  const actionable = cards.filter((c) => c.kind !== "preference");
  const readyCount = actionable.filter((c) => c.kind === "merge_ready").length;
  const decisionCount = actionable.length - readyCount;
  const parts = [];
  if (readyCount > 0) parts.push(`${readyCount} PR${readyCount === 1 ? "" : "s"} ready to merge`);
  if (decisionCount > 0) parts.push(`${decisionCount} decision${decisionCount === 1 ? "" : "s"} waiting on you`);
  if (parts.length > 0) {
    return `${parts.join(" and ")}.`;
  }
  if (activeSummary) {
    if (activeSummary.running > 0 || activeSummary.waitingCi > 0) {
      const sub = [];
      if (activeSummary.running > 0) sub.push(`${activeSummary.running} running`);
      if (activeSummary.waitingCi > 0) sub.push(`${activeSummary.waitingCi} on CI`);
      return `All clear—${sub.join(" · ")}, nothing needs your input right now.`;
    }
  }
  return "All clear—no coding sessions need you right now.";
}

export function buildSupervisorDeck(state, { preferences = null, now = Date.now() } = {}) {
  const prefs = normalizePreferences(preferences ?? state?.preferences);
  const snapshot = state?.snapshot ?? null;
  const rowsByKey = new Map((snapshot?.threads ?? []).filter((r) => r?.key).map((r) => [r.key, r]));
  const actions = Array.isArray(state?.actions) ? state.actions : [];
  const questions = Array.isArray(state?.questions) ? state.questions : [];

  const questionCards = questions
    .filter((q) => isQuestionLiveForDeck(q, q.threadKey ? rowsByKey.get(q.threadKey) : null, prefs))
    .map((q) => buildSupervisorCard(q, { rowsByKey, actions, prefs }))
    .sort((a, b) => a.rank - b.rank || String(b.noticedAt ?? "").localeCompare(String(a.noticedAt ?? "")));

  const prefCards = buildProgressivePreferenceCards(prefs, { now });
  const cards = [...questionCards, ...prefCards].map(({ rank: _rank, ...card }) => card);

  const activeSummary = buildActiveSummary(snapshot, cards);
  const autonomy = buildAutonomySummary(actions, prefs, questionCards.length, now);
  const catchUpSummary = buildCatchUpSummary(cards, activeSummary);

  return {
    cards,
    preferences: {
      mergePolicy: prefs.mergePolicy,
      cadence: prefs.cadence,
      autoSlices: { ...prefs.autoSlices }
    },
    autonomy,
    activeSummary,
    catchUpSummary
  };
}
