// Synthesizes the Claude-Duet-style SupervisorCard deck, compact active
// session summary, coalesced catch-up brief, and Scrutinizer autonomy banner
// from the fleet supervisor's state. Existing FleetState fields remain intact
// so Android, push extensions, and older clients stay 100% compatible.

import { clampTailLines, clampText, clampTextLines, parsePaseoThreadKey, parsePrRef, redactSecrets } from "./contracts.js";
import { asksToMergePr } from "./policy.js";
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

const DRAFT_STATUS_ACTION = /\b(?:mark|convert|turn|move|change|switch|promote|set)\b[^.?!\n]{0,28}\b(?:draft|ready\s+for\s+review)\b|\b(?:keep|leave)\b[^.?!\n]{0,24}\bdraft\b|\bdraft\s+(?:ready|to\s+ready)\b/i;
const CONVERT_TO_DRAFT_ACTION = /\b(?:mark|convert|turn|move|change|switch|set)\b[^.?!\n]{0,28}\b(?:as\s+|to\s+|into\s+|back\s+to\s+)?draft\b|\b(?:keep|leave)\b[^.?!\n]{0,24}\bdraft\b/i;
const DRAFT_STATUS_OPTION = /^(?:mark\s+(?:as\s+)?(?:ready|draft)|ready\s+for\s+review|convert\s+to\s+draft|keep\s+(?:as\s+)?draft)$/i;
const UNKNOWN_DRAFT_PR_STATE = /\b(?:still|currently)\s+(?:in\s+|a\s+)?draft\b|\bdraft\s+(?:pr|pull\s+request)\b|\b(?:pr|pull\s+request)(?:\s+#?\d+)?\s+is\s+(?:still\s+)?(?:in\s+|a\s+)?draft\b/i;

function isMergeReadyQuestion(question, row, prRef, prMeta = null) {
  if (!prRef || !parsePrRef(prRef)) return false;
  const rowMatchesPr = Boolean(row?.pr && (!row.pr.ref || row.pr.ref === prRef));
  const knownIsDraft = typeof prMeta?.isDraft === "boolean"
    ? prMeta.isDraft
    : (rowMatchesPr && typeof row?.pr?.isDraft === "boolean" ? row.pr.isDraft : null);
  const firstOpt = Array.isArray(question.options) ? String(question.options[0] ?? "").trim() : "";
  const askText = `${question.title ?? ""} ${question.body ?? ""}`;
  const statusActionMatch = knownIsDraft === false
    ? CONVERT_TO_DRAFT_ACTION.test(askText)
    : DRAFT_STATUS_ACTION.test(askText);
  const isDraftAsk = knownIsDraft === true
    || (rowMatchesPr && Array.isArray(row?.blockers) && row.blockers.includes("draft"))
    || statusActionMatch
    || DRAFT_STATUS_OPTION.test(firstOpt)
    || (knownIsDraft === null && UNKNOWN_DRAFT_PR_STATE.test(askText));
  if (isDraftAsk) return false;
  if (question.kind === "ready" || question.mergeAsk) return true;
  if (question.kind !== "agent-ask") return false;
  if (!/^(?:approve(?: and)? merge|merge(?: now| pr)?|ship(?: pr| it)?)$/i.test(firstOpt)) return false;
  return asksToMergePr(askText);
}

function classifyCardKind(question, row = null, prRef = null, prMeta = null) {
  const ciState = prMeta?.ciState ?? row?.pr?.ci?.state ?? null;
  const mergeState = prMeta?.mergeState ?? row?.pr?.mergeState ?? null;
  if (isMergeReadyQuestion(question, row, prRef, prMeta)) {
    if (ciState === "FAILURE" || ciState === "ERROR") {
      return { kind: "ci_failed", kindLabel: "CI Failed", rank: 1 };
    }
    if (mergeState === "DIRTY") {
      return { kind: "ci_failed", kindLabel: "Needs Rebase", rank: 1 };
    }
    if (ciState === "PENDING" || ciState === "IN_PROGRESS") {
      return { kind: "merge_ready", kindLabel: "Checks Running", rank: 0 };
    }
    return { kind: "merge_ready", kindLabel: "PR Ready", rank: 0 };
  }
  if (question.kind === "stuck" && (ciState === "FAILURE" || ciState === "ERROR")) {
    return { kind: "ci_failed", kindLabel: "CI Failed", rank: 1 };
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
  const prRef = question.prRef ?? row?.prRef ?? null;
  if (row?.pr?.state && SETTLED_PR.has(row.pr.state) && (question.kind === "ready" || question.mergeAsk || isMergeReadyQuestion(question, row, prRef))) {
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

const OPAQUE_SESSION_ID_RE = /^(?:paseo chat|wks_[0-9a-f]+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{6,})$/i;
const LEADING_OPAQUE_PREFIX_RE = /^(?:wks_[0-9a-f]+|Paseo chat|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{6,}):/i;

function cleanWorkspaceName(workspace) {
  const raw = typeof workspace === "string" ? workspace.trim() : "";
  if (!raw || OPAQUE_SESSION_ID_RE.test(raw)) return null;
  return raw;
}

function cleanSessionTitle(raw, max = 120) {
  let text = String(raw ?? "").trim();
  if (!text) return null;
  text = text
    .replace(/<(?:system_instruction|system-reminder|EXTREMELY_IMPORTANT|TASK_INSTRUCTION)\b[\s\S]*?(?:<\/(?:system_instruction|system-reminder|EXTREMELY_IMPORTANT|TASK_INSTRUCTION)>|$)/gi, " ")
    .replace(/<[^>]{1,120}>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text || OPAQUE_SESSION_ID_RE.test(text)) return null;
  if (/^you are working inside conductor\b/i.test(text)) return null;
  return clampText(redactSecrets(text), max) || null;
}

function stripAttachmentMarkdown(text) {
  return String(text ?? "")
    .replace(/!\[[^\]]*\]\(file:\/\/[^)\s]+\)/gi, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function cleanBriefProse(text) {
  return stripAttachmentMarkdown(text)
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/(?:^|\n)##+\s+Words in this PR[\s\S]*?(?=\n##+\s|\s*$)/gi, "\n")
    .replace(/(?:^|\n)\s*\|[^\n]*\|(?=\s*(?:\n|$))/g, " ")
    .replace(/(?:^|\n)\s*---+\s*(?=\n|$)/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function buildActionsForQuestion(question, row, prRef, prMeta = null) {
  const options = Array.isArray(question.options) ? question.options.filter(Boolean) : [];
  const ciState = prMeta?.ciState ?? row?.pr?.ci?.state ?? null;
  const mergeState = prMeta?.mergeState ?? row?.pr?.mergeState ?? null;
  const appOnlyCard = question.answerIn === "agent app" || (question.kind === "agent-card" && question.answerIn !== "here");

  if (appOnlyCard) {
    const chatLabel = question.openChat?.app
      ? `Open in ${question.openChat.app.charAt(0).toUpperCase() + question.openChat.app.slice(1)}`
      : "Open in app";
    return {
      primaryAction: { op: "open_chat", label: chatLabel, value: options.includes("open thread") ? "open thread" : "opened", destructive: false },
      secondaryAction: { op: "defer", label: "Later", value: "dismiss", destructive: false },
      extraActions: []
    };
  }

  if (isMergeReadyQuestion(question, row, prRef, prMeta)) {
    if (ciState === "FAILURE" || ciState === "ERROR" || mergeState === "DIRTY") {
      return {
        primaryAction: { op: "fix_ci", label: mergeState === "DIRTY" ? "Have agent rebase" : "Have agent fix CI", value: "fix_ci", destructive: false },
        secondaryAction: { op: "defer", label: "Later", value: options.includes("later") ? "later" : "dismiss", destructive: false },
        extraActions: []
      };
    }
    if (ciState === "PENDING" || ciState === "IN_PROGRESS") {
      return {
        primaryAction: { op: "merge", label: "Watch CI", value: prRef, destructive: false },
        secondaryAction: { op: "defer", label: "Later", value: options.includes("later") ? "later" : "dismiss", destructive: false },
        extraActions: []
      };
    }
    const extraActions = [];
    if (question.threadKey || row?.key) {
      extraActions.push({ op: "merge_and_deploy", label: "Merge & Deploy", value: prRef, destructive: false });
    }
    return {
      primaryAction: { op: "merge", label: "Merge PR", value: prRef, destructive: false },
      secondaryAction: { op: "defer", label: "Later", value: options.includes("later") ? "later" : "dismiss", destructive: false },
      extraActions
    };
  }

  const realOptions = options.filter((opt) => !["dismiss", "open thread"].includes(String(opt).toLowerCase()));
  const first = realOptions[0] ?? null;
  const second = realOptions[1] ?? null;
  const hasOpenThread = options.some((opt) => String(opt).toLowerCase() === "open thread");
  const primaryAction = first
    ? {
        op: "answer",
        label: humanOptionLabel(first),
        value: first,
        destructive: /^(?:delete|destroy|wipe|close pr|stop)$/i.test(first)
      }
    : hasOpenThread
      ? { op: "open_chat", label: "Open chat", value: "open thread", destructive: false }
      : { op: "defer", label: "Dismiss", value: "dismiss", destructive: false };

  const secondaryAction = second && !["later", "dismiss"].includes(second.toLowerCase())
    ? { op: "answer", label: humanOptionLabel(second), value: second, destructive: /^(?:delete|destroy|wipe)$/i.test(second) }
    : { op: "defer", label: "Later", value: options.includes("later") ? "later" : "dismiss", destructive: false };

  const extraActions = realOptions
    .slice(2, 4)
    .filter((opt) => !["later", "dismiss"].includes(opt.toLowerCase()))
    .map((opt) => ({
      op: "answer",
      label: humanOptionLabel(opt),
      value: opt,
      destructive: /^(?:delete|destroy|wipe)$/i.test(opt)
    }));
  if (second && !["later", "dismiss"].includes(second.toLowerCase())) {
    extraActions.push({
      op: "defer",
      label: "Later",
      value: options.includes("later") ? "later" : "dismiss",
      destructive: false
    });
  }

  return { primaryAction, secondaryAction, extraActions };
}

function activeReviewBrief(question) {
  return question?.reviewedAt && question?.reviewBrief && typeof question.reviewBrief === "object"
    ? question.reviewBrief
    : null;
}

function buildRecommendation(question, row, prRef, prefs, prMeta = null) {
  const rb = activeReviewBrief(question);
  if (rb?.recommendation) {
    return clampText(redactSecrets(rb.recommendation), 220);
  }
  const ci = prMeta?.ciState ?? row?.pr?.ci?.state ?? null;
  if (isMergeReadyQuestion(question, row, prRef, prMeta)) {
    if (ci === "FAILURE" || ci === "ERROR") {
      const failing = (prMeta?.failingChecks ?? row?.pr?.ci?.failing ?? []).slice(0, 2).join(", ");
      return `CI failed${failing ? ` (${failing})` : ""}. Send back to the coding session before merging.`;
    }
    if (prMeta?.mergeState === "DIRTY" || row?.pr?.mergeState === "DIRTY") {
      return "Pull request has merge conflicts with the base branch. Have the coding session rebase before merging.";
    }
    if (ci === "PENDING" || ci === "IN_PROGRESS") {
      return "Checks are still running. Auto-merge is off by default—tap Watch CI to get pinged when green.";
    }
    const threads = Number(prMeta?.unresolvedThreads ?? row?.pr?.unresolvedThreads ?? 0);
    const gatePass = Array.isArray(prMeta?.gates) && prMeta.gates.length > 0 && prMeta.gates.every((g) => g.state === "SUCCESS")
      ? ` · ${prMeta.gates.map((g) => g.label).join(", ")} green`
      : "";
    return `CI green${gatePass}${threads === 0 ? " · 0 open threads" : ` · ${threads} review thread(s)`}. Ready for your merge confirmation.`;
  }
  if (parsePaseoThreadKey(question.threadKey ?? row?.key)) {
    return "Reply right below to answer or steer this session directly without opening the chat.";
  }
  if (row?.reason && !/^agent asks:/i.test(row.reason)) {
    return clampText(redactSecrets(row.reason), 200);
  }
  return null;
}

function buildDecisionBrief(question, row, { kind, headline = "", sessionTitle = null, prMeta = null, agentSummary = null, recentMessages = [] } = {}) {
  const rb = activeReviewBrief(question);
  const lastUserMsg = [...recentMessages].reverse().find((m) => m.role === "user" && m.text)?.text ?? null;
  const fallbackContext = lastUserMsg
    ? `You asked: "${clampText(cleanBriefProse(lastUserMsg), 170)}"`
    : (sessionTitle && !String(headline).toLowerCase().includes(sessionTitle.toLowerCase())
        ? `Session: ${sessionTitle}`
        : null);

  let fallbackWhatChanged = null;
  if (prMeta?.bodySummary) {
    const cleanPr = clampTextLines(cleanBriefProse(prMeta.bodySummary), 420);
    const cleanAgent = agentSummary ? clampTailLines(cleanBriefProse(agentSummary), 220) : "";
    fallbackWhatChanged = cleanAgent && !cleanPr.includes(cleanAgent.slice(0, 32))
      ? clampTextLines(`${cleanPr}\n\nLatest status: ${cleanAgent}`, 520)
      : cleanPr;
  } else if (agentSummary) {
    fallbackWhatChanged = clampTailLines(cleanBriefProse(agentSummary), 440);
  }

  let fallbackDecision = null;
  if (kind === "merge_ready") {
    fallbackDecision = (prMeta?.ciState === "PENDING" || prMeta?.ciState === "IN_PROGRESS")
      ? `Checks are still running on ${prMeta?.ref ?? "this PR"}. Tap Watch CI or wait before merging.`
      : `Confirm whether to merge ${prMeta?.ref ?? "this PR"} now, merge & deploy, or reply with changes.`;
  } else if (kind === "ci_failed") {
    fallbackDecision = prMeta?.mergeState === "DIRTY"
      ? `Have the session rebase ${prMeta?.ref ?? "this PR"} onto base and re-verify, or reply with guidance.`
      : `Have the session fix failing checks on ${prMeta?.ref ?? "this PR"}, or reply with specific instructions.`;
  } else if (question.card) {
    fallbackDecision = clampTextLines(cleanBriefProse(question.card), 260);
  } else if (question.body && !isMechanicalReadyBody(question.body)) {
    fallbackDecision = clampTextLines(cleanBriefProse(question.body), 260);
  } else {
    fallbackDecision = headline;
  }

  return {
    context: rb?.context ? clampText(redactSecrets(rb.context), 240) : (fallbackContext ? redactSecrets(fallbackContext) : null),
    whatChanged: rb?.whatChanged ? clampTextLines(redactSecrets(rb.whatChanged), 520) : (fallbackWhatChanged ? redactSecrets(fallbackWhatChanged) : null),
    decision: rb?.decision ? clampText(redactSecrets(rb.decision), 260) : redactSecrets(fallbackDecision || "Needs your decision.")
  };
}

function buildSuggestedReplies(question, { kind, canReply = false } = {}) {
  if (!canReply || kind === "preference") return [];
  const rb = activeReviewBrief(question);
  if (Array.isArray(rb?.suggestedReplies) && rb.suggestedReplies.length > 0) {
    return rb.suggestedReplies.slice(0, 4).map((s) => clampText(redactSecrets(s), 110)).filter(Boolean);
  }
  if (kind === "merge_ready") {
    return [
      "Rebase on latest main and re-verify",
      "Run a quick staging smoke check first",
      "Hold merge for now — I'll review shortly"
    ];
  }
  if (kind === "ci_failed") {
    return [
      "Fix the failing checks and push an updated commit",
      "Rebase onto latest main and re-run verification"
    ];
  }
  if (question.kind === "prompt") {
    return [
      "Allow",
      "Skip that step and take a non-destructive approach"
    ];
  }
  return [
    "Go ahead with your recommendation",
    "Approved — proceed with all items in scope",
    "Hold off for now — let's adjust the plan"
  ];
}

function isMechanicalReadyBody(text) {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#\d+\s+at\s+[0-9a-f]{7,40}:\s*CI\s+/i.test(String(text ?? "").trim());
}

function formatDiffSummary(prMeta) {
  if (!prMeta) return null;
  const hasCounts = Number.isFinite(prMeta.additions) && Number.isFinite(prMeta.deletions);
  const counts = hasCounts ? `+${prMeta.additions} / -${prMeta.deletions}` : null;
  const files = Number.isFinite(prMeta.changedFiles) && prMeta.changedFiles > 0
    ? `${prMeta.changedFiles} file${prMeta.changedFiles === 1 ? "" : "s"}`
    : null;
  return [counts, files].filter(Boolean).join(" · ") || null;
}

function expandFragmentFromAgent(rawBody, cleanAgent, maxLen = 440) {
  const bodyAnchor = rawBody.slice(0, Math.min(28, rawBody.length));
  if (!bodyAnchor) return null;
  const anchorIdx = cleanAgent.lastIndexOf(bodyAnchor);
  if (anchorIdx === -1) return null;
  const availBefore = anchorIdx;
  const availAfter = Math.max(0, cleanAgent.length - (anchorIdx + rawBody.length));
  const half = Math.max(0, Math.floor((maxLen - rawBody.length) / 2));
  let takeBefore = Math.min(availBefore, half);
  let takeAfter = Math.min(availAfter, half);
  if (takeBefore < half) {
    takeAfter = Math.min(availAfter, Math.max(0, maxLen - rawBody.length - takeBefore));
  } else if (takeAfter < half) {
    takeBefore = Math.min(availBefore, Math.max(0, maxLen - rawBody.length - takeAfter));
  }
  const start = Math.max(0, anchorIdx - takeBefore);
  const end = Math.min(cleanAgent.length, anchorIdx + rawBody.length + takeAfter);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < cleanAgent.length ? "…" : "";
  return `${prefix}${cleanAgent.slice(start, end).trim()}${suffix}`;
}

function buildSummary(question, row, { headline = "", prMeta = null, agentSummary = null } = {}) {
  const parts = [];
  if (prMeta?.title && !String(headline).includes(prMeta.title) && !String(question.title ?? "").includes(prMeta.title)) {
    parts.push(prMeta.title);
  }
  const diffStat = formatDiffSummary(prMeta);
  if (diffStat) parts.push(diffStat);

  const mechanicalBody = isMechanicalReadyBody(question.body);
  const rawBody = stripAttachmentMarkdown(question.body);
  const cleanAgent = agentSummary ? stripAttachmentMarkdown(agentSummary) : "";
  const expandedFragment = (
    rawBody
    && cleanAgent
    && cleanAgent.length > rawBody.length + 40
    && (rawBody.length < 140 || /^(?:\d+[.)]|[a-c][.)]|[-*•])\s/i.test(rawBody))
  )
    ? expandFragmentFromAgent(rawBody, cleanAgent, 430)
    : null;

  const rb = activeReviewBrief(question);
  if (rb?.whatChanged) {
    parts.push(clampText(rb.whatChanged, 380));
  } else if (question.card) {
    parts.push(cleanBriefProse(question.card));
  } else if (prMeta?.bodySummary) {
    parts.push(clampText(cleanBriefProse(prMeta.bodySummary), 360));
  } else if (expandedFragment) {
    parts.push(expandedFragment);
  } else if (rawBody && !mechanicalBody) {
    parts.push(rawBody);
  } else if (cleanAgent) {
    parts.push(clampText(cleanBriefProse(cleanAgent), 340));
  } else if (rawBody) {
    parts.push(rawBody);
  } else if (question.askContext) {
    parts.push(cleanBriefProse(question.askContext));
  } else if (row?.lastAgentText) {
    parts.push(cleanBriefProse(row.lastAgentText));
  }
  const joined = parts.filter(Boolean).join(" — ");
  if (expandedFragment && parts.length === 1) {
    return clampTextLines(redactSecrets(joined), 460);
  }
  return clampText(redactSecrets(joined || row?.reason || "Waiting for your decision."), 460);
}

function buildTimeline(question, row, actions = [], prMeta = null) {
  const raw = [];
  const threadKey = question.threadKey ?? null;
  const relevant = threadKey
    ? actions.filter((a) => a && a.threadKey === threadKey && ["sent", "done", "proposed", "blocked"].includes(a.status)).slice(0, 4).reverse()
    : [];
  for (const act of relevant) {
    raw.push({
      at: act.at ?? null,
      label: act.playbook ? `Playbook: ${act.playbook}` : (act.kind ?? "Update"),
      detail: clampText(redactSecrets(act.reason || act.detail || act.message || act.status), 160)
    });
  }
  const ciState = prMeta?.ciState ?? row?.pr?.ci?.state ?? null;
  if (ciState) {
    const ref = prMeta?.ref ?? row?.pr?.ref ?? question.prRef ?? null;
    const head = prMeta?.head ?? row?.pr?.head ?? null;
    raw.push({
      at: question.updatedAt ?? question.createdAt ?? null,
      label: `GitHub CI: ${ciState}`,
      detail: ref ? `${ref}${head ? ` @ ${head}` : ""}` : "Pull request checks"
    });
  }
  raw.push({
    at: question.askedAt ?? question.createdAt ?? null,
    label: question.kind === "ready" ? "Ready for review" : "Needs your call",
    detail: clampText(redactSecrets(question.title), 160)
  });
  if (question.reviewedAt && question.reviewReason) {
    raw.push({
      at: question.reviewedAt,
      label: "Scrutinizer verified",
      detail: clampText(redactSecrets(question.reviewReason), 160)
    });
  }
  const timeline = [];
  const seenEntries = new Set();
  for (const item of raw) {
    const sig = `${item.label}\0${item.detail ?? ""}`;
    if (seenEntries.has(sig)) continue;
    seenEntries.add(sig);
    timeline.push(item);
  }
  return timeline;
}

function resolveOpenChat(question, row, primaryKey, sessionTitle) {
  const existing = question.openChat ?? row?.openChat ?? null;
  const parsedPaseo = parsePaseoThreadKey(primaryKey);
  if (existing) {
    const cleanLabel = typeof existing.label === "string" && /<(?:system_instruction|system-reminder)/i.test(existing.label)
      ? `${sessionTitle || "Paseo chat"}${parsedPaseo ? " (Paseo)" : ""}`
      : existing.label;
    if (parsedPaseo && (!existing.serverId || !existing.agentId)) {
      return { ...existing, label: cleanLabel, app: existing.app ?? "paseo", serverId: existing.serverId ?? parsedPaseo.serverId, agentId: existing.agentId ?? parsedPaseo.agentId };
    }
    return cleanLabel !== existing.label ? { ...existing, label: cleanLabel } : existing;
  }
  if (parsedPaseo) {
    return {
      app: "paseo",
      url: null,
      label: `${sessionTitle || "Paseo chat"} (Paseo)`,
      serverId: parsedPaseo.serverId,
      agentId: parsedPaseo.agentId,
      note: "Open this existing chat on its Paseo host."
    };
  }
  return null;
}

function buildResources(question, row, prRef, { openChat = null, sessionTitle = null, prUrlOverride = null } = {}) {
  const resources = [];
  const threadKey = question.threadKey ?? question.threadKeys?.[0] ?? null;
  const parsedPaseo = parsePaseoThreadKey(threadKey);
  const serverId = openChat?.serverId ?? parsedPaseo?.serverId ?? null;
  const agentId = openChat?.agentId ?? parsedPaseo?.agentId ?? null;
  const cleanChatLabel = question.chatLabel ? cleanSessionTitle(question.chatLabel) : null;
  if (threadKey) {
    resources.push({
      kind: "conversation",
      label: cleanChatLabel || sessionTitle || cleanWorkspaceName(row?.workspace) || "Agent conversation",
      url: null,
      threadKey,
      ...(serverId && agentId ? { serverId, agentId } : {})
    });
  }
  const parsedPr = parsePrRef(prRef);
  const prUrl = prUrlOverride ?? row?.pr?.url ?? (parsedPr ? `https://github.com/${parsedPr.repo}/pull/${parsedPr.number}` : null);
  if (prUrl || prRef) {
    resources.push({
      kind: "pr",
      label: parsedPr ? `Pull Request #${parsedPr.number} (${parsedPr.repo})` : String(prRef),
      url: prUrl,
      threadKey: null
    });
  }
  if (openChat?.url) {
    resources.push({
      kind: "app",
      label: openChat.label ? `Open ${openChat.label}` : `Open in ${openChat.app ?? "app"}`,
      url: openChat.url,
      threadKey,
      ...(serverId && agentId ? { serverId, agentId } : {})
    });
  }
  return resources;
}

export function buildSupervisorCard(
  question,
  { rowsByKey = new Map(), threadsByKey = new Map(), prsByKey = new Map(), actions = [], prefs = normalizePreferences(null) } = {}
) {
  const primaryKey = question.threadKey ?? question.threadKeys?.[0] ?? null;
  const row = primaryKey ? rowsByKey.get(primaryKey) ?? null : null;
  const thread = primaryKey ? threadsByKey.get(primaryKey) ?? null : null;
  const snap = question.contextSnapshot && typeof question.contextSnapshot === "object" ? question.contextSnapshot : null;
  const candidatePrRef = question.prRef ?? row?.pr?.ref ?? snap?.pr?.ref ?? thread?.prRefs?.[0] ?? null;
  const matchesPrRef = (candidate) => Boolean(candidate && (!candidatePrRef || !candidate.ref || candidate.ref === candidatePrRef));
  const threadKeyedPr = primaryKey ? prsByKey.get(primaryKey) : null;
  const livePr = (candidatePrRef ? prsByKey.get(candidatePrRef) : null) ?? (matchesPrRef(threadKeyedPr) ? threadKeyedPr : null) ?? null;
  const rowPr = matchesPrRef(row?.pr) ? row.pr : null;
  const snapPr = matchesPrRef(snap?.pr) ? snap.pr : null;
  const prState = livePr?.state ?? rowPr?.state ?? snapPr?.state ?? null;
  const hideSettledPr = Boolean(prState && SETTLED_PR.has(prState) && question.kind !== "ready" && !question.mergeAsk);
  const prRef = hideSettledPr ? null : candidatePrRef;
  const parsedPr = parsePrRef(prRef);

  const pickNum = (...vals) => vals.find((v) => Number.isFinite(v)) ?? null;
  const prTitle = hideSettledPr
    ? null
    : (clampText(redactSecrets(livePr?.title || rowPr?.title || snapPr?.title || ""), 180) || null);
  const rawPrBody = hideSettledPr ? null : (livePr?.bodySummary ?? rowPr?.bodySummary ?? snapPr?.bodySummary ?? null);
  const prBodySummary = rawPrBody ? clampTextLines(redactSecrets(cleanBriefProse(rawPrBody)), 2200) : null;
  const additions = hideSettledPr ? null : pickNum(livePr?.additions, rowPr?.additions, snapPr?.additions);
  const deletions = hideSettledPr ? null : pickNum(livePr?.deletions, rowPr?.deletions, snapPr?.deletions);
  const changedFiles = hideSettledPr ? null : pickNum(livePr?.changedFiles, rowPr?.changedFiles, snapPr?.changedFiles);
  const files = hideSettledPr ? [] : (livePr?.files?.length ? livePr.files : (rowPr?.files?.length ? rowPr.files : (snapPr?.files ?? []))).slice(0, 12);
  const rawGates = hideSettledPr ? [] : (livePr?.gates?.length ? livePr.gates : (rowPr?.gates?.length ? rowPr.gates : (snapPr?.gates ?? [])));
  const gates = Array.isArray(rawGates)
    ? rawGates.slice(0, 4).map((g) => ({ label: String(g?.label || g?.name || ""), state: g?.state ?? null })).filter((g) => g.label)
    : [];
  const rawQa = hideSettledPr ? null : (livePr?.qa ?? rowPr?.qa ?? snapPr?.qa ?? null);
  const qa = rawQa ? { required: rawQa.required ?? null, freshOnHead: rawQa.freshOnHead ?? null } : null;
  const ciState = hideSettledPr ? null : (livePr?.ci?.state ?? rowPr?.ci?.state ?? snapPr?.ciState ?? null);
  const mergeState = hideSettledPr ? null : (livePr?.mergeState ?? rowPr?.mergeState ?? snapPr?.mergeState ?? null);
  const headSha = hideSettledPr ? null : ((livePr?.headOid ? String(livePr.headOid).slice(0, 10) : null)
    ?? rowPr?.head
    ?? snapPr?.head
    ?? question.askedHead
    ?? null);
  const prUrl = hideSettledPr ? null : (livePr?.url ?? rowPr?.url ?? snapPr?.url ?? (parsedPr ? `https://github.com/${parsedPr.repo}/pull/${parsedPr.number}` : null));
  const isDraft = hideSettledPr ? null : (typeof livePr?.isDraft === "boolean"
    ? livePr.isDraft
    : (typeof rowPr?.isDraft === "boolean"
        ? rowPr.isDraft
        : (typeof snapPr?.isDraft === "boolean" ? snapPr.isDraft : null)));
  const prMeta = prRef ? {
    ref: prRef,
    title: prTitle,
    bodySummary: prBodySummary,
    isDraft,
    additions,
    deletions,
    changedFiles,
    files,
    gates,
    qa,
    ciState,
    mergeState,
    head: headSha,
    unresolvedThreads: livePr?.unresolvedThreads ?? rowPr?.unresolvedThreads ?? snapPr?.unresolvedThreads ?? 0,
    failingChecks: livePr?.ci?.failing ?? rowPr?.ci?.failing ?? snapPr?.failingChecks ?? []
  } : null;

  const { kind, kindLabel, rank } = classifyCardKind(question, row, prRef, prMeta);
  const { primaryAction, secondaryAction, extraActions } = buildActionsForQuestion(question, row, prRef, prMeta);
  const distinctTitle = cleanSessionTitle(row?.title)
    || cleanSessionTitle(thread?.title)
    || cleanSessionTitle(snap?.threadTitle);
  const sessionTitle = distinctTitle
    || cleanWorkspaceName(row?.workspace ?? thread?.workspace ?? snap?.workspace)
    || (prTitle ? clampText(prTitle, 90) : null)
    || null;
  const labelForOpaquePrefix = distinctTitle || sessionTitle;

  const rawTitle = String(question.title ?? "");
  let cleanTitle = rawTitle;
  if (/<(?:system_instruction|system-reminder)/i.test(rawTitle)) {
    cleanTitle = rawTitle.replace(/^(?:<[^>]+>\s*[^:]{0,120}):/i, `${labelForOpaquePrefix || "Coding session"}:`);
  } else if (LEADING_OPAQUE_PREFIX_RE.test(rawTitle)) {
    const rest = rawTitle.replace(LEADING_OPAQUE_PREFIX_RE, "").trim();
    cleanTitle = labelForOpaquePrefix
      ? (rest ? `${labelForOpaquePrefix}: ${rest}` : labelForOpaquePrefix)
      : (rest || "Coding session");
  }
  if ((kind === "merge_ready" || kind === "ci_failed") && parsedPr && prTitle && /#\d+\s+ready(?:\.\s*(?:needs\s+approve\.?|merge\??)|\s+to\s+merge\??)?$/i.test(cleanTitle.trim())) {
    cleanTitle = `#${parsedPr.number} · ${prTitle}`;
  }
  const headline = clampText(redactSecrets(cleanTitle), 140);

  const rawAgentSummary = stripAttachmentMarkdown(thread?.lastAgentFull || row?.lastAgentText || question.askContext || snap?.agentSummary || "");
  const agentSummary = clampTailLines(redactSecrets(rawAgentSummary), 1600) || null;

  const candidateMessages = Array.isArray(thread?.meta?.conversation) && thread.meta.conversation.length
    ? thread.meta.conversation
    : (Array.isArray(snap?.recentMessages) && snap.recentMessages.length
        ? snap.recentMessages
        : [
            ...((thread?.lastUserText || snap?.lastUserText) ? [{ role: "user", text: thread?.lastUserText || snap?.lastUserText, at: thread?.lastUserAt ?? snap?.lastUserAt ?? null }] : []),
            ...((thread?.lastAgentFull || row?.lastAgentText || snap?.agentSummary) ? [{ role: "assistant", text: thread?.lastAgentFull || row?.lastAgentText || snap?.agentSummary, at: thread?.lastAgentAt ?? row?.lastAgentAt ?? snap?.lastAgentAt ?? null }] : [])
          ]);
  const recentMessages = candidateMessages
    .map((m) => {
      if (!m || typeof m.text !== "string") return null;
      const cleaned = stripAttachmentMarkdown(m.text);
      if (!cleaned) return null;
      return {
        role: m.role === "user" ? "user" : "assistant",
        text: clampTailLines(redactSecrets(cleaned), 700),
        at: m.at ?? null
      };
    })
    .filter(Boolean)
    .slice(-4);

  const prContext = prMeta ? {
    ref: prRef,
    url: prUrl,
    title: prTitle,
    bodySummary: prBodySummary,
    additions,
    deletions,
    changedFiles,
    files,
    gates,
    qa,
    ciState
  } : null;

  const openChat = resolveOpenChat(question, row, primaryKey, sessionTitle);
  const answerIn = question.answerIn ?? "here";
  const canReply = Boolean(primaryKey)
    && question.canReply !== false
    && !["suggestion", "self-fix", "preference"].includes(String(question.kind ?? ""))
    && !((question.threadKeys ?? []).length > 1)
    && answerIn === "here";
  const brief = buildDecisionBrief(question, row, { kind, headline, sessionTitle, prMeta, agentSummary, recentMessages });
  const suggestedReplies = buildSuggestedReplies(question, { kind, canReply });

  return {
    id: question.id,
    questionId: question.id,
    kind,
    kindLabel,
    rank,
    headline,
    sessionTitle,
    summary: buildSummary(question, row, { headline, prMeta, agentSummary }),
    recommendation: buildRecommendation(question, row, prRef, prefs, prMeta),
    brief,
    suggestedReplies,
    canReply,
    agentSummary,
    prContext,
    recentMessages,
    threadKey: primaryKey,
    threadKeys: question.threadKeys ?? (primaryKey ? [primaryKey] : []),
    repo: row?.repo ?? thread?.repo ?? snap?.repo ?? parsedPr?.repo ?? null,
    branch: row?.branch ?? thread?.branch ?? snap?.branch ?? livePr?.headRef ?? null,
    workspace: cleanWorkspaceName(row?.workspace ?? thread?.workspace ?? snap?.workspace),
    prRef: prRef ?? null,
    prUrl,
    prNumber: parsedPr?.number ?? null,
    headSha,
    ciState,
    mergeState,
    noticedAt: question.askedAt ?? question.createdAt ?? null,
    answerIn: question.answerIn ?? "here",
    risky: Boolean(question.risky),
    options: Array.isArray(question.options) ? [...question.options] : [],
    primaryAction,
    secondaryAction,
    extraActions,
    timeline: buildTimeline(question, row, actions, prMeta),
    resources: buildResources(question, row, prRef, { openChat, sessionTitle, prUrlOverride: prUrl }),
    openChat
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
    const isAttention = row.requiresAttention === true;
    const isBlocked = row.health === "red" || group === "you" || group === "blocked";
    if (isRunning) running += 1;
    else if (isCi) waitingCi += 1;
    else if (isBlocked) blocked += 1;
    else quiet += 1;

    if (isRunning || isCi || isBlocked || isAttention || group === "push") {
      activeThreads.push({
        key: row.key,
        kind: row.kind ?? null,
        title: cleanSessionTitle(row.title) || cleanWorkspaceName(row.workspace) || (row.pr?.title ? clampText(redactSecrets(row.pr.title), 120) : null) || row.key,
        repo: row.repo ?? null,
        branch: row.branch ?? null,
        state: row.state ?? "unknown",
        health: row.health ?? "gray",
        watchGroup: group,
        requiresAttention: isAttention,
        attentionReason: row.attentionReason ?? null,
        pushAvailable: Boolean(row.pushPreview),
        muted: Boolean(row.muted),
        reason: row.reason ?? null,
        lastAgentText: row.lastAgentText ? clampText(redactSecrets(row.lastAgentText), 220) : null,
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
    activeThreads: activeThreads.slice(0, 60)
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

export function buildSupervisorDeck(
  state,
  { preferences = null, now = Date.now(), threadsByKey = new Map(), prsByKey = new Map(), knownRows = new Map() } = {}
) {
  const prefs = normalizePreferences(preferences ?? state?.preferences);
  const snapshot = state?.snapshot ?? null;
  const rowsByKey = new Map();
  for (const [k, r] of knownRows ?? []) if (k && r) rowsByKey.set(k, r);
  for (const r of snapshot?.threads ?? []) if (r?.key) rowsByKey.set(r.key, r);
  const actions = Array.isArray(state?.actions) ? state.actions : [];
  const questions = Array.isArray(state?.questions) ? state.questions : [];

  const questionCards = questions
    .filter((q) => isQuestionLiveForDeck(q, q.threadKey ? rowsByKey.get(q.threadKey) : null, prefs))
    .map((q) => buildSupervisorCard(q, { rowsByKey, threadsByKey, prsByKey, actions, prefs }))
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
