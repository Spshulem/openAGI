// Synthesizes the Claude-Duet-style SupervisorCard deck, compact active
// session summary, coalesced catch-up brief, and Scrutinizer autonomy banner
// from the fleet supervisor's state. Existing FleetState fields remain intact
// so Android, push extensions, and older clients stay 100% compatible.

import { clampTailLines, clampText, clampTextLines, parsePaseoThreadKey, parsePrRef, redactSecrets } from "./contracts.js";
import { asksToMergePr } from "./policy.js";
import { buildDecisionContext, renderDecisionContext, shouldHoldForContext } from "./decision-context.js";
import { buildProgressivePreferenceCards, isSuppressedByQuietCadence, normalizePreferences, SAFE_SLICES } from "./preferences.js";

const SETTLED_PR = new Set(["MERGED", "CLOSED"]);
const DAY_MS = 24 * 60 * 60 * 1000;

const OWNER_BLOCKER_RE = /\b(?:you|your|owner)\b[^.?!\n]{0,80}\b(?:decision|call|approv\w*|authori[sz]\w*|sign[ -]?off|credentials?|sign[ -]?in|log[ -]?in|choice|pick|go[ -]?ahead)\b|\b(?:explicit|owner|your)\s+(?:release\s+)?(?:authorization|approval|sign[ -]?off)\b/i;
const NO_ACTION_COMPLETION_RE = /\b(?:nothing|no action|all done|completed successfully|finished successfully|done)\b[^.?!\n]{0,80}\b(?:needed|required|left|else|more)\b/i;

function cleanOwnerCopy(value, max = 220) {
  return clampText(redactSecrets(cleanBriefProse(String(value ?? ""))), max) || null;
}

function firstUsefulSentence(value) {
  const text = cleanOwnerCopy(value, 360);
  if (!text) return null;
  return (text.split(/(?<=[.!?])\s+/).find((part) => part.trim()) ?? text).trim();
}

function ownerActionHeadline(question, { kind = null } = {}) {
  const title = cleanOwnerCopy(question?.title, 160);
  const body = cleanOwnerCopy(question?.body, 360);
  const activeItem = Array.isArray(question?.meta?.items) && question?.meta?.itemId != null
    ? question.meta.items.find((item) => String(item?.itemId ?? "") === String(question.meta.itemId))
    : null;
  const source = cleanOwnerCopy(activeItem?.question, 360) || `${title ?? ""} ${body ?? ""}`.trim();
  if (!source) return "Review this decision";
  const signIn = /\b(?:browser\s+)?sign[ -]?ins?\b|\blog(?:ged)?[ -]?in\b|\bportals?\b/i.test(source);
  if (signIn) return /\b(?:publisher|listing|submission)s?\b/i.test(source)
    ? "Sign in to the publisher portals"
    : "Sign in to the requested portals";
  const release = /\b(?:release|deploy|cut)\b/i.test(source) && /\b(?:authori[sz]\w*|approv\w*|sign[ -]?off|owner)\b/i.test(source);
  if (release) return "Authorize the production release";
  const stripped = (title || firstUsefulSentence(body) || "Review this decision")
    .replace(/^(?:please|can you|could you|would you)\s+/i, "")
    .replace(/\s*\(\d+\s+open\)\s*$/i, "")
    .replace(/^(?:question\s+\d+|needs? your (?:call|decision))[: -]*/i, "")
    .trim();
  return clampText(stripped || "Review this decision", 120);
}

function ownerDecisionFact(question, { kind = null, hasVerifiedOwnerBlocker = false } = {}) {
  const body = cleanOwnerCopy(question?.body, 500);
  const context = cleanOwnerCopy(question?.askContext, 500);
  const source = body || context;
  if (source) {
    const sentences = source.split(/(?<=[.!?])\s+/).map((part) => part.trim()).filter(Boolean);
    const consequence = sentences.find((part) => /\b(?:can't|cannot|won't|stops?|blocked|paused|waiting|until|requires?|needs?)\b/i.test(part));
    if (consequence) return clampText(consequence, 220);
    if (hasVerifiedOwnerBlocker) return "The session is waiting for your authorization before it can continue.";
  }
  if (kind === "prompt" || kind === "agent-card") return "The agent is paused on this permission card; your choice controls the next action.";
  if (kind === "merge_ready") return "This decision changes the repository; the current checks and head are shown in Context.";
  if (kind === "ci_failed") return "The pull request cannot move forward until the failing checks or rebase are resolved.";
  if (kind === "session-error") return "The session reported an error and needs your direction before work can resume.";
  if (kind === "completed") return "The session finished without a verified owner blocker.";
  return "The agent is waiting for your answer before it can continue.";
}

function questionHasVerifiedOwnerBlocker(question, { kind = null } = {}) {
  if (question?.meta?.ownerBlocker === true || question?.ownerBlocker === true) return true;
  if (kind !== "completed") return false;
  const source = [question?.title, question?.body, question?.askContext, question?.card].filter(Boolean).join(" ");
  return OWNER_BLOCKER_RE.test(source) && !NO_ACTION_COMPLETION_RE.test(source);
}

export function needsOwnerDecision(question, { kind = question?.kind ?? null } = {}) {
  if (!question || question.status && question.status !== "open") return false;
  const verifiedBlocker = questionHasVerifiedOwnerBlocker(question, { kind });
  if (kind === "completed" && !verifiedBlocker) return false;
  if (kind === "suggestion" && question.meta?.plan?.nextAction == null) return false;
  return true;
}

export function buildOwnerDecision(question, { kind = question?.kind ?? null, primaryAction = null } = {}) {
  const verifiedBlocker = questionHasVerifiedOwnerBlocker(question, { kind: question?.kind ?? kind });
  const needsYou = needsOwnerDecision(question, { kind });
  const itemIds = Array.isArray(question?.meta?.itemIds) ? question.meta.itemIds.map(String) : [];
  const activeItemId = question?.meta?.itemId ? String(question.meta.itemId) : null;
  const source = {
    questionId: question?.id ?? null,
    threadKey: question?.threadKey ?? null,
    threadKeys: Array.isArray(question?.threadKeys) ? question.threadKeys : [],
    ...(question?.meta?.app ? { app: String(question.meta.app) } : {}),
    ...(question?.meta?.cardId ? { cardId: String(question.meta.cardId) } : {}),
    ...(activeItemId ? { itemId: activeItemId } : {})
  };
  const action = primaryAction ? {
    op: primaryAction.op ?? null,
    ...(primaryAction.value != null ? { value: primaryAction.value } : {}),
    ...(primaryAction.label ? { label: primaryAction.label } : {})
  } : null;
  const remaining = itemIds.filter((id) => id !== activeItemId);
  const decisionItems = Array.isArray(question?.meta?.items)
    ? question.meta.items.map((item) => ({
        itemId: item?.itemId ? String(item.itemId) : null,
        source: item?.source && typeof item.source === "object" ? item.source : source,
        headline: cleanOwnerCopy(item?.question, 180) || ownerActionHeadline(question, { kind }),
        options: Array.isArray(item?.options) ? item.options.map((option) => String(option)).filter(Boolean) : [],
        multiSelect: item?.multiSelect === true,
        freeText: item?.freeText === true,
        active: item?.itemId != null && String(item.itemId) === activeItemId
      }))
    : [];
  return {
    needsYou,
    ownerBlocker: verifiedBlocker,
    decisionHeadline: ownerActionHeadline(question, { kind }),
    decisionFact: ownerDecisionFact(question, { kind, hasVerifiedOwnerBlocker: verifiedBlocker }),
    decisionSource: source,
    decisionAction: action,
    ...(decisionItems.length ? { decisionItems } : {}),
    ...(remaining.length ? { remainingItemIds: remaining } : {})
  };
}

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
  "got it": "Got it",
  "mark done": "Mark Done",
  archive: "Archive",
  proceed: "Proceed",
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
  if (question.kind === "completed") {
    if (questionHasVerifiedOwnerBlocker(question, { kind: "completed" })) {
      return { kind: "blocker", kindLabel: "Owner blocker", rank: 0 };
    }
    return { kind: "completed", kindLabel: "Finished", rank: 2 };
  }
  if (question.kind === "session-error") {
    return { kind: "blocker", kindLabel: "Session Error", rank: 0 };
  }
  if (question.meta?.hasPlanArtifact || (Array.isArray(question.options) && question.options.some((o) => /^proceed$/i.test(String(o))))) {
    return { kind: "approval", kindLabel: "Plan Ready", rank: 0 };
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
export function isQuestionLiveForDeck(question, row, prefs) {
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

const OPAQUE_SESSION_ID_RE = /^(?:paseo chat|wks_[0-9a-f]+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{6,}|[0-9a-f]{12,64}|(?=[0-9a-f]*\d)[0-9a-f]{4,11})$/i;
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

  if (question.kind === "completed" || question.kind === "session-error") {
    const isPaseo = Boolean(parsePaseoThreadKey(question.threadKey ?? row?.key));
    const extraActions = isPaseo
      ? [{ op: "archive_session", label: "Archive Chat…", value: "archive_session", destructive: true }]
      : [];
    return {
      primaryAction: { op: "open_chat", label: "View Chat", value: "open thread", destructive: false },
      secondaryAction: { op: "dismiss", label: "Dismiss", value: "dismiss", destructive: false },
      extraActions
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

const TRIVIAL_CONTINUATION_USER_MSG_RE = /^(?:\[openagi supervisor\]|continue\b|resume(?:\s+working)?\.?$|yes\.?$|no\.?$|ok(?:ay)?\.?$|go ahead\.?$|proceed\.?$|status\??$|what(?:'s| is) the status\??$|done\.?$|got it\.?$|allow\.?$)/i;

function extractSubstantiveGoalMessage(messages = []) {
  const userMsgs = messages
    .filter((m) => m && m.role === "user" && typeof m.text === "string" && m.text.trim())
    .map((m) => cleanBriefProse(m.text))
    .filter((txt) => txt && !/^The previous turn stopped because of a temporary provider/i.test(txt) && !TRIVIAL_CONTINUATION_USER_MSG_RE.test(txt.trim()));
  if (!userMsgs.length) return null;
  // Prefer the earliest substantive goal prompt in the window over short follow-ups.
  const substantial = userMsgs.find((txt) => txt.length >= 28) ?? userMsgs[0];
  return substantial || null;
}

function extractPermissionDetail(question, thread = null) {
  const perm = thread?.meta?.pendingPermission;
  const cmd = perm?.input?.command ?? perm?.command ?? question?.meta?.command ?? null;
  const toolName = perm?.toolName ?? perm?.name ?? null;
  if (typeof cmd === "string" && cmd.trim()) {
    return {
      toolName: toolName ? String(toolName) : "Bash",
      command: clampText(redactSecrets(cmd.trim().replace(/\s+/g, " ")), 220)
    };
  }
  const rawSource = String(question?.card || question?.body || "");
  const backtickCmd = /`([^`\n]{4,220})`/.exec(rawSource)?.[1] ?? null;
  if (backtickCmd) {
    return {
      toolName: toolName ? String(toolName) : null,
      command: clampText(redactSecrets(backtickCmd.trim()), 220)
    };
  }
  return toolName ? { toolName: String(toolName), command: null } : null;
}

function buildCurrentStateSummary(question, row, { kind, prMeta = null, thread = null } = {}) {
  const ci = prMeta?.ciState ?? row?.pr?.ci?.state ?? null;
  const mergeState = prMeta?.mergeState ?? row?.pr?.mergeState ?? null;
  const prLabel = prMeta?.ref ? (prMeta.ref.includes("#") ? `PR #${prMeta.ref.split("#").pop()}` : prMeta.ref) : null;
  const diffStat = formatDiffSummary(prMeta);

  if (kind === "merge_ready") {
    if (ci === "PENDING" || ci === "IN_PROGRESS") {
      return `${prLabel ?? "Pull request"} is open${diffStat ? ` (${diffStat})` : ""} · CI checks still running — waiting before merge.`;
    }
    const threads = Number(prMeta?.unresolvedThreads ?? row?.pr?.unresolvedThreads ?? 0);
    return `Code complete · ${prLabel ?? "PR"} open${diffStat ? ` (${diffStat})` : ""} · CI green${threads > 0 ? ` · ${threads} open review thread(s)` : ""} — paused at your merge gate.`;
  }
  if (kind === "ci_failed") {
    if (mergeState === "DIRTY") {
      return `${prLabel ?? "Pull request"} has merge conflicts against base — blocked until rebased and re-verified.`;
    }
    const failing = (prMeta?.failingChecks ?? row?.pr?.ci?.failing ?? []).slice(0, 2).join(", ");
    return `${prLabel ?? "Pull request"} stopped with failing CI${failing ? ` (${failing})` : ""} — needs fix before merge.`;
  }
  if (question.kind === "prompt") {
    const perm = extractPermissionDetail(question, thread);
    const toolLabel = perm?.toolName || (/bash/i.test(String(question.title ?? "")) ? "shell command" : "tool");
    return `Paused mid-task waiting for ${toolLabel} approval${prLabel ? ` (${prLabel})` : ""} — has not executed this step yet.`;
  }
  if (question.kind === "session-error") {
    return `Stopped on a runtime/tool error${prLabel ? ` (${prLabel})` : ""} — waiting on recovery or your direction.`;
  }
  if (kind === "blocker" || ["stuck", "limit", "open", "deliver"].includes(String(question.kind ?? ""))) {
    return `Blocked at an external/environment gate${prLabel ? ` (${prLabel})` : ""} — cannot advance without your unblock.`;
  }
  return `Paused at a decision checkpoint${prLabel ? ` (${prLabel})` : ""} — waiting for your call before continuing.`;
}

function buildRecommendation(question, row, prRef, prefs, prMeta = null, thread = null) {
  const ci = prMeta?.ciState ?? row?.pr?.ci?.state ?? null;
  const mergeDirty = prMeta?.mergeState === "DIRTY" || row?.pr?.mergeState === "DIRTY";
  const mergeReadyAsk = isMergeReadyQuestion(question, row, prRef, prMeta);
  const prShort = prRef && String(prRef).includes("#") ? `PR #${String(prRef).split("#").pop()}` : (prRef || "this PR");
  if (mergeReadyAsk) {
    if (ci === "FAILURE" || ci === "ERROR") {
      const failing = (prMeta?.failingChecks ?? row?.pr?.ci?.failing ?? []).slice(0, 2).join(", ");
      return `Recommend: Do not merge yet — CI failed${failing ? ` (${failing})` : ""}; send back to the coding session first.`;
    }
    if (mergeDirty) {
      return `Recommend: Do not merge yet — have the session rebase ${prShort} onto base and re-verify.`;
    }
    if (ci === "PENDING" || ci === "IN_PROGRESS") {
      return `Recommend: Hold merge while CI finishes — tap Watch CI to get notified once checks turn green.`;
    }
  }
  const rb = activeReviewBrief(question);
  if (rb?.recommendation) {
    const cleanRec = clampText(redactSecrets(rb.recommendation), 220);
    if (cleanRec && !/^reply right below\b/i.test(cleanRec) && !/^tap view chat\b/i.test(cleanRec)) {
      return cleanRec;
    }
  }
  if (mergeReadyAsk) {
    const threads = Number(prMeta?.unresolvedThreads ?? row?.pr?.unresolvedThreads ?? 0);
    const gatePass = Array.isArray(prMeta?.gates) && prMeta.gates.length > 0 && prMeta.gates.every((g) => g.state === "SUCCESS")
      ? ` (${prMeta.gates.map((g) => g.label).join(", ")} green)`
      : "";
    if (threads > 0) {
      return `Recommend: Inspect the ${threads} open review thread(s) on ${prShort} before merging; CI is green${gatePass}.`;
    }
    return `Recommend: Merge ${prShort} after a quick diff check — CI is green${gatePass} with 0 open review threads.`;
  }
  if (question.kind === "completed") {
    return "Session finished — inspect the result or Dismiss.";
  }
  if (question.kind === "prompt") {
    const perm = extractPermissionDetail(question, thread);
    const cmd = perm?.command ?? "";
    if (cmd && /\b(?:merge|push\s+--force|reset\s+--hard|rm\s+-rf|deploy|prod)/i.test(cmd)) {
      return `Recommend: Inspect carefully before allowing — command touches merge/deploy/destructive state (\`${clampText(cmd, 90)}\`).`;
    }
    if (cmd) {
      return `Recommend: Allow if \`${clampText(cmd, 90)}\` matches this task's scope, or Deny to steer another way.`;
    }
    return "Recommend: Allow if this local step matches the workspace goal above, or Deny with instructions.";
  }
  const bodyText = String(question?.card || question?.body || "");
  const explicitRecLine = /(?:^|\n)\s*(?:[-*•]|\d+[.)])?\s*\*{0,2}([^*\n]{3,90}?)\s*\(recommended\)\*{0,2}/i.exec(bodyText)?.[1]?.trim();
  if (explicitRecLine) {
    return `Recommend: ${clampText(redactSecrets(explicitRecLine), 180)}.`;
  }
  const realOptions = (Array.isArray(question?.options) ? question.options : [])
    .map((o) => String(o ?? "").trim())
    .filter((o) => o && !["dismiss", "later", "open thread", "opened", "wait", "skip"].includes(o.toLowerCase()));
  if (realOptions.length > 0) {
    return `Recommend: "${humanOptionLabel(realOptions[0])}" if the caveats above look right — otherwise pick another option or reply below.`;
  }
  if (row?.reason && !/^agent asks:/i.test(row.reason)) {
    return `Recommend: Review blocker (${clampText(redactSecrets(row.reason), 140)}) and reply with the unblock step.`;
  }
  return "Recommend: Open details or reply below with your call on the blocker above.";
}

function extractUserStoryFromPrBody(bodySummary) {
  const raw = String(bodySummary ?? "");
  if (!raw.trim()) return null;
  const match = /(?:^|\n)##+\s*(?:User\s+story|Why|Goal|Problem|Context)\s*\n+([\s\S]*?)(?=\n##+\s|\s*$)/i.exec(raw);
  if (match?.[1]) {
    const cleaned = cleanBriefProse(match[1]);
    if (cleaned) return clampText(cleaned, 280);
  }
  return null;
}

function isProcessOnlyWhatChanged(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return true;
  if (raw.length > 260) return false;
  return /\b(?:verification\s+run|certificate\s+passed|open\s+review\s+threads|independent\s+human\s+review|no\s+later\s+merge)\b/i.test(raw)
    && !/\b(?:adds?|fixes?|updates?|routes?|changes?|replaces?|introduces?|supports?)\b/i.test(raw);
}

function buildDecisionBrief(question, row, { kind, headline = "", sessionTitle = null, prMeta = null, agentSummary = null, recentMessages = [], activeGoal = null, thread = null } = {}) {
  const rb = activeReviewBrief(question);
  const substantiveUserGoal = extractSubstantiveGoalMessage(recentMessages);
  const prUserStory = extractUserStoryFromPrBody(prMeta?.rawBody ?? prMeta?.bodySummary);
  const goalStory = activeGoal?.goal
    ? `${clampText(cleanBriefProse(activeGoal.goal), 200)}${activeGoal.doneCriteria ? ` (Done when: ${clampText(cleanBriefProse(activeGoal.doneCriteria), 140)})` : ""}`
    : null;
  const combinedGoalAndStory = [goalStory, prUserStory].filter(Boolean).join(" — ") || null;
  const cleanRbContext = rb?.context && !TRIVIAL_CONTINUATION_USER_MSG_RE.test(String(rb.context).replace(/^You asked:\s*["']?|["']$/gi, "").trim())
    ? cleanBriefProse(rb.context)
    : null;
  const fallbackContext = combinedGoalAndStory
    || cleanRbContext
    || (substantiveUserGoal ? clampText(substantiveUserGoal, 240) : null)
    || (prMeta?.title ? `${clampText(cleanBriefProse(prMeta.title), 200)}` : null)
    || (sessionTitle ? `${sessionTitle}` : null);

  const currentState = buildCurrentStateSummary(question, row, { kind, prMeta, thread });
  const permDetail = question.kind === "prompt" ? extractPermissionDetail(question, thread) : null;
  const permPrefix = permDetail?.command
    ? `Requested ${permDetail.toolName || "command"}: \`${permDetail.command}\``
    : (permDetail?.toolName ? `Requested tool: ${permDetail.toolName}` : null);

  let fallbackWhatChanged = null;
  if (prMeta?.bodySummary) {
    const cleanPr = clampTextLines(cleanBriefProse(prMeta.bodySummary), 520);
    const cleanAgent = agentSummary ? clampTailLines(cleanBriefProse(agentSummary), 260) : "";
    fallbackWhatChanged = cleanAgent && !cleanPr.includes(cleanAgent.slice(0, 32))
      ? clampTextLines(`${cleanPr}\n\nLatest progress & caveats: ${cleanAgent}`, 780)
      : cleanPr;
  } else if (prMeta?.title) {
    const diffStat = formatDiffSummary(prMeta);
    const header = [prMeta.title, diffStat].filter(Boolean).join(" · ");
    const cleanAgent = agentSummary ? clampTailLines(cleanBriefProse(agentSummary), 420) : "";
    fallbackWhatChanged = [header, cleanAgent].filter(Boolean).join("\n\n");
  } else if (agentSummary) {
    fallbackWhatChanged = clampTailLines(cleanBriefProse(agentSummary), 520);
  } else if (question.body && !isMechanicalReadyBody(question.body)) {
    fallbackWhatChanged = clampTextLines(cleanBriefProse(question.body), 480);
  }
  if (permPrefix) {
    fallbackWhatChanged = fallbackWhatChanged && !fallbackWhatChanged.includes(permDetail?.command ?? "___")
      ? clampTextLines(`${permPrefix}\n\n${fallbackWhatChanged}`, 780)
      : (fallbackWhatChanged || permPrefix);
  }

  const activeDecisionItem = Array.isArray(question?.meta?.items) && question.meta.items.length > 0
    ? (question.meta.items.find((it) => String(it?.itemId ?? "") === String(question?.meta?.itemId ?? "")) ?? question.meta.items[0])
    : null;
  const fullChoicesBlock = Array.isArray(activeDecisionItem?.options) && activeDecisionItem.options.length > 0
    ? [
        activeDecisionItem.question,
        ...activeDecisionItem.options.map((opt, idx) => (/^\d+[.)]\s/.test(String(opt)) ? String(opt) : `${idx + 1}. ${opt}`))
      ].filter(Boolean).join("\n")
    : null;

  let fallbackDecision = null;
  if (kind === "merge_ready") {
    const reviewNote = prMeta?.mergeState === "BLOCKED" ? " (GitHub notes required reviewer approval)" : "";
    fallbackDecision = (prMeta?.ciState === "PENDING" || prMeta?.ciState === "IN_PROGRESS")
      ? `Checks are still running on ${prMeta?.ref ?? "this PR"}. Tap Watch CI or wait before merging.`
      : `Approve & merge ${prMeta?.ref ?? "this PR"}${reviewNote} now, merge & deploy, or reply with changes.`;
  } else if (kind === "ci_failed") {
    fallbackDecision = prMeta?.mergeState === "DIRTY"
      ? `Have the session rebase ${prMeta?.ref ?? "this PR"} onto base and re-verify, or reply with guidance.`
      : `Have the session fix failing checks on ${prMeta?.ref ?? "this PR"}, or reply with specific instructions.`;
  } else if (kind === "completed") {
    fallbackDecision = "Session finished. Tap View Chat to read the result or reply, or Dismiss to clear this notification.";
  } else if (question.kind === "suggestion" && question.meta?.plan?.nextAction) {
    fallbackDecision = clampTextLines(cleanBriefProse(question.meta.plan.nextAction), 800);
  } else if (fullChoicesBlock) {
    fallbackDecision = clampTextLines(cleanBriefProse(fullChoicesBlock), 1100);
  } else if (question.card) {
    fallbackDecision = clampTextLines(cleanBriefProse(question.card), 900);
  } else if (question.body && !isMechanicalReadyBody(question.body)) {
    fallbackDecision = clampTextLines(cleanBriefProse(question.body), 1100);
  } else {
    fallbackDecision = headline;
  }

  const liveMergeBlocked = kind === "ci_failed"
    || (kind === "merge_ready" && (prMeta?.ciState === "PENDING" || prMeta?.ciState === "IN_PROGRESS"));
  let resolvedWhatChanged = (rb?.whatChanged && !isProcessOnlyWhatChanged(rb.whatChanged))
    ? (prMeta?.bodySummary && !String(rb.whatChanged).includes(prMeta.title ?? "___")
        ? clampTextLines(`${cleanBriefProse(prMeta.bodySummary).slice(0, 420)}\n\nVerified status & caveats: ${rb.whatChanged}`, 840)
        : clampTextLines(rb.whatChanged, 740))
    : (fallbackWhatChanged
        ? (rb?.whatChanged ? clampTextLines(`${fallbackWhatChanged}\n\nReview check: ${rb.whatChanged}`, 840) : fallbackWhatChanged)
        : (rb?.whatChanged ?? null));
  if (permPrefix && resolvedWhatChanged && !resolvedWhatChanged.includes(permDetail?.command ?? "___")) {
    resolvedWhatChanged = clampTextLines(`${permPrefix}\n\n${resolvedWhatChanged}`, 860);
  }

  const resolvedDecision = (!liveMergeBlocked && rb?.decision && !fullChoicesBlock)
    ? clampTextLines(rb.decision, 900)
    : (fallbackDecision || "Needs your decision.");

  const finalGoal = combinedGoalAndStory || cleanRbContext || fallbackContext;
  return {
    context: finalGoal ? clampText(redactSecrets(finalGoal), 420) : null,
    currentState: currentState ? clampText(redactSecrets(currentState), 240) : null,
    whatChanged: resolvedWhatChanged ? redactSecrets(resolvedWhatChanged) : null,
    decision: redactSecrets(clampTextLines(resolvedDecision, 1100))
  };
}

function buildSuggestedReplies(question, { kind, canReply = false, recommendation = null } = {}) {
  if (!canReply || kind === "preference") return [];
  const hasConcreteRec = Boolean(
    recommendation
    && !/^Session finished/i.test(recommendation)
    && !/^Recommend:\s*Open details/i.test(recommendation)
  );
  const rb = kind === "ci_failed" ? null : activeReviewBrief(question);
  if (Array.isArray(rb?.suggestedReplies) && rb.suggestedReplies.length > 0) {
    return rb.suggestedReplies
      .slice(0, 4)
      .map((s) => clampText(redactSecrets(s), 110))
      .filter((s) => Boolean(s) && (hasConcreteRec || !/recommendation/i.test(s)));
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
      "Skip that command and use a read-only / non-destructive path"
    ];
  }
  return [
    ...(hasConcreteRec ? ["Proceed with the recommended option above"] : []),
    "Approved — finish all remaining in-scope items",
    "Hold off — tell me what's still unverified first"
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

// Folds the decision context into the brief fields every client already
// renders (Goal / state / what changed / decision), without dropping what the
// brief already said, and exposes the structured parts beside them.
function enrichBriefWithDecisionContext(brief, ctx) {
  if (!brief || !ctx) return brief;
  if (!brief.context && ctx.goal) brief.context = clampText(ctx.goal, 420);
  const extra = [];
  const whatChanged = String(brief.whatChanged ?? "");
  if (ctx.assignment && !whatChanged.includes(ctx.assignment.slice(0, 40)) && !String(brief.context ?? "").includes(ctx.assignment.slice(0, 40))) {
    extra.push(`You asked the agent to: ${ctx.assignment}`);
  }
  if (ctx.verified && !whatChanged.includes(ctx.verified.slice(0, 30))) extra.push(`Verified: ${ctx.verified}`);
  if (whatChanged) extra.push(whatChanged);
  if (ctx.blocked && !whatChanged.includes(ctx.blocked.slice(0, 30))) extra.push(`Why it can't proceed alone: ${ctx.blocked}`);
  if (extra.length) brief.whatChanged = clampTextLines(extra.join("\n\n"), 1200);
  const withConsequence = ctx.options.filter((o) => o.consequence);
  if (withConsequence.length && !/\bOptions:/.test(String(brief.decision ?? ""))) {
    brief.decision = clampTextLines(`${brief.decision ?? ctx.decision ?? ""}\n\nOptions:\n${ctx.options.map((o) => `- ${o.label}${o.consequence ? ` — ${o.consequence}` : ""}`).join("\n")}`.trim(), 1400);
  }
  brief.goal = ctx.goal;
  brief.assignment = ctx.assignment;
  brief.verified = ctx.verified;
  brief.blocked = ctx.blocked;
  brief.options = ctx.options;
  brief.sources = ctx.sources;
  brief.missing = ctx.missing;
  return brief;
}

export function buildSupervisorCard(
  question,
  { rowsByKey = new Map(), threadsByKey = new Map(), prsByKey = new Map(), actions = [], prefs = normalizePreferences(null), blockingResolver = null, activeGoalResolver = null, now = Date.now() } = {}
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
  const rawPrBody = hideSettledPr
    ? null
    : (livePr?.bodySummary ?? livePr?.body ?? rowPr?.bodySummary ?? rowPr?.body ?? snapPr?.bodySummary ?? snapPr?.body ?? null);
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
    rawBody: rawPrBody ? redactSecrets(String(rawPrBody)) : null,
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
  const ownerDecision = buildOwnerDecision(question, { kind, primaryAction });
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
  if (/:\s*Question\s+\d+(?:\s*\(\d+\s+open\))?$/i.test(cleanTitle.trim())) {
    const firstLine = (cleanBriefProse(question.card || question.body || "").split(/\n+/)[0] ?? "").trim();
    const firstAsk = (/^([^?]+\?)(?:\s|$)/.exec(firstLine)?.[1] ?? firstLine).trim();
    if (firstAsk) {
      cleanTitle = cleanTitle.replace(/:\s*Question\s+\d+(\s*\(\d+\s+open\))?$/i, (_, suffix = "") => `: ${clampText(firstAsk, 68)}${suffix || ""}`);
    }
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
  const activeGoal = typeof activeGoalResolver === "function"
    ? activeGoalResolver(primaryKey, prRef)
    : null;
  const recommendation = buildRecommendation(question, row, prRef, prefs, prMeta, thread);
  const brief = buildDecisionBrief(question, row, { kind, headline, sessionTitle, prMeta, agentSummary, recentMessages, activeGoal, thread });
  const suggestedReplies = buildSuggestedReplies(question, { kind, canReply, recommendation });
  const rawPlan = question.meta?.plan && typeof question.meta.plan === "object" ? question.meta.plan : null;
  const plan = rawPlan ? {
    remedy: clampText(redactSecrets(String(rawPlan.remedy ?? "")), 40) || null,
    label: clampText(redactSecrets(String(rawPlan.label ?? "")), 80) || null,
    nextAction: clampTextLines(redactSecrets(String(rawPlan.nextAction ?? "")), 1200) || null,
    acceptance: clampTextLines(redactSecrets(String(rawPlan.acceptance ?? "")), 1200) || null,
    issueDraft: rawPlan.issueDraft
      ? clampTextLines(redactSecrets(typeof rawPlan.issueDraft === "string" ? rawPlan.issueDraft : JSON.stringify(rawPlan.issueDraft, null, 2)), 2000) || null
      : null
  } : null;

  const project = deriveCardProject(
    { repo: row?.repo ?? thread?.repo ?? snap?.repo ?? parsedPr?.repo ?? null, workspace: row?.workspace ?? thread?.workspace ?? snap?.workspace ?? null, project: question?.project ?? row?.project ?? null, cwd: row?.cwd ?? null },
    thread ?? row
  );
  const actorLabel = deriveActorLabel(row, thread);
  const subchannel = deriveSubchannel(row, thread, project);
  const blockingImpact = computeBlockingImpact({
    threadKey: primaryKey,
    prRef,
    branch: row?.branch ?? thread?.branch ?? snap?.branch ?? livePr?.headRef ?? null,
    rowsByKey,
    blockingResolver
  });
  const labels = deriveBoardLabels({
    row,
    thread,
    question,
    prRef,
    ciState,
    subchannel,
    blockingCount: blockingImpact.blockingCount
  });

  // The shared decision-ready standard: goal, assignment, verified/changed/
  // blocked, and the decision with options, consequences and recommendation.
  const decisionContext = buildDecisionContext({
    question,
    project: project && project !== "general" ? project : null,
    sessionTitle,
    prMeta: prMeta ? { ...prMeta, url: prUrl } : null,
    recentMessages,
    agentSummary,
    activeGoal,
    openChat,
    currentState: brief.currentState,
    recommendation,
    reviewBrief: activeReviewBrief(question),
    permission: question.kind === "prompt" ? extractPermissionDetail(question, thread) : null,
    contextRequest: question.contextRequest ?? null
  });
  enrichBriefWithDecisionContext(brief, decisionContext);
  const heldForContext = shouldHoldForContext(question, decisionContext, Number(now) || Date.now());

  return {
    id: question.id,
    questionId: question.id,
    kind,
    kindLabel,
    rank,
    headline,
    ...ownerDecision,
    ...(heldForContext ? { needsYou: false } : {}),
    askType: decisionContext.askType,
    contextStatus: decisionContext.complete ? "complete" : (heldForContext ? "requested" : "incomplete"),
    decisionContext: { ...decisionContext, text: renderDecisionContext(decisionContext, { markdown: true }) },
    sessionTitle,
    summary: buildSummary(question, row, { headline, prMeta, agentSummary }),
    recommendation,
    brief,
    ...(plan ? { plan } : {}),
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
    openChat,
    project,
    actorLabel,
    subchannel,
    labels,
    blockingCount: blockingImpact.blockingCount,
    blockingSummary: blockingImpact.blockingSummary
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
        openChat: row.openChat ?? null,
        actorLabel: row.actorLabel ?? null,
        subchannel: row.subchannel ?? null,
        labels: Array.isArray(row.labels) ? row.labels : [],
        nextCheckAt: row.nextCheckAt ?? null
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

const JUNK_PROJECT_NAMES = new Set([
  "general", "workspace", "workspaces", "worktree", "worktrees", "codex-worktrees",
  "imported-history", "imported history", "history", "tmp", "temp", "private", "var",
  "folders", "outputs", "migrated", "mac", "users", "home", "dev", "documents",
  "downloads", "desktop", "repos", "projects", "code", "src", "main", "master", "smoke"
]);

function isJunkProjectToken(token) {
  const clean = String(token ?? "").trim();
  if (!clean) return true;
  const lower = clean.toLowerCase();
  if (JUNK_PROJECT_NAMES.has(lower)) return true;
  if (OPAQUE_SESSION_ID_RE.test(clean)) return true;
  if (/^\d{3,8}$/.test(clean)) return true;
  if (/^[0-9a-f]{4,16}$/i.test(clean)) return true;
  if (/^\d{4}-\d{2}-\d{2}$/.test(clean)) return true;
  return false;
}

function applyProjectAlias(name, aliases = null) {
  const clean = String(name ?? "").trim().replace(/^#/, "");
  if (!clean) return "general";
  if (aliases && typeof aliases === "object") {
    const slug = clean.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
    if (slug && typeof aliases[slug] === "string" && aliases[slug].trim()) {
      return aliases[slug].trim();
    }
  }
  return clean;
}

function extractProjectFromPath(rawPath) {
  const clean = String(rawPath ?? "").trim().replace(/\/+$/, "");
  if (!clean) return null;
  const wtMatch = /\/(?:\.paseo|paseo)\/worktrees\/([^/]+)\/([^/]+)/.exec(clean)
    ?? /\/conductor\/workspaces\/([^/]+)\/([^/]+)/.exec(clean)
    ?? /\/([^/]+)\/\.conductor\/([^/]+)/.exec(clean);
  if (wtMatch?.[1] && !isJunkProjectToken(wtMatch[1])) return wtMatch[1];
  const repoMatch = /\/conductor\/repos\/([^/]+)/.exec(clean)
    ?? /\/codex-worktrees\/[0-9a-f_-]+\/([^/]+)/i.exec(clean)
    ?? /(?:\/Users\/[^/]+|\/home\/[^/]+)\/(?:Dev|Developer|Code|Projects|Repos)\/([^/]+)/i.exec(clean);
  if (repoMatch?.[1] && !isJunkProjectToken(repoMatch[1])) return repoMatch[1];
  if (/\/imported[- ]history(?:\/|$)/i.test(clean)) return null;
  const base = clean.includes("/") ? clean.split("/").filter(Boolean).at(-1) : clean;
  if (!base || isJunkProjectToken(base)) {
    return null;
  }
  return base;
}

export function deriveCardProject(card = null, thread = null, orgOverride = null) {
  const aliases = orgOverride?.projectAliases ?? null;
  const overrideProj = typeof orgOverride?.project === "string" ? orgOverride.project.trim().replace(/^#/, "") : "";
  if (overrideProj && overrideProj.toLowerCase() !== "general") return applyProjectAlias(overrideProj, aliases);
  const explicit = typeof card?.project === "string" ? card.project.trim().replace(/^#/, "") : "";
  if (explicit && !isJunkProjectToken(explicit)) return applyProjectAlias(explicit, aliases);
  const rawLabels = Array.isArray(thread?.meta?.paseoLabels) ? thread.meta.paseoLabels : [];
  for (const label of rawLabels) {
    const slash = String(label ?? "").indexOf("/");
    if (slash > 0) {
      const prefix = String(label).slice(0, slash).trim();
      if (prefix && !isJunkProjectToken(prefix) && prefix.toLowerCase() !== "infrastructure") {
        return applyProjectAlias(prefix, aliases);
      }
    }
  }
  const repo = String(card?.repo ?? thread?.repo ?? "").trim();
  if (repo) {
    const seg = repo.split("/").filter(Boolean).at(-1);
    if (seg && !isJunkProjectToken(seg)) return applyProjectAlias(seg, aliases);
  }
  const paseoProjectName = String(thread?.meta?.paseoProjectName ?? "").trim();
  if (paseoProjectName && !isJunkProjectToken(paseoProjectName)) {
    return applyProjectAlias(paseoProjectName, aliases);
  }
  const origCwd = thread?.meta?.agentLabels?.["migration.originalCwd"] ?? null;
  for (const candidate of [thread?.cwd, thread?.meta?.paseoProjectRoot, thread?.meta?.paseoCwd, origCwd, card?.cwd, card?.workspace, thread?.workspace]) {
    const extracted = extractProjectFromPath(candidate);
    if (extracted) return applyProjectAlias(extracted, aliases);
  }
  const agentTheme = String(thread?.meta?.agentLabels?.theme ?? thread?.meta?.theme ?? "").trim();
  if (agentTheme && !isJunkProjectToken(agentTheme) && agentTheme.toLowerCase() !== "misc") {
    return applyProjectAlias(agentTheme, aliases);
  }
  return "general";
}

function cleanSubAreaSlug(raw) {
  const clean = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/^#/, "")
    .replace(/[^a-z0-9/_-]+/g, "-")
    .replace(/\/{2,}/g, "/")
    .replace(/^[-/]+|[-/]+$/g, "");
  if (!clean || OPAQUE_SESSION_ID_RE.test(clean) || clean === "general" || clean === "workspace") return null;
  return clean.slice(0, 32);
}

export function deriveActorLabel(row = null, thread = null) {
  const rawKind = String(thread?.kind ?? row?.kind ?? parsePaseoThreadKey(row?.key ?? thread?.key)?.kind ?? "").trim().toLowerCase();
  const isPaseo = rawKind === "paseo" || Boolean(parsePaseoThreadKey(row?.key ?? thread?.key));
  const providerRaw = String(thread?.meta?.provider ?? row?.provider ?? rawKind).trim();
  const providerLeaf = providerRaw.includes("/") ? providerRaw.split("/")[0] : providerRaw;
  const engine = (providerLeaf && providerLeaf !== "paseo" ? providerLeaf : null)
    ?? (thread?.openChat?.app && thread.openChat.app !== "paseo" ? thread.openChat.app : null)
    ?? (isPaseo ? "paseo" : rawKind || null);
  const model = clampText(String(thread?.meta?.model ?? row?.model ?? "").trim(), 48) || null;
  const hostVia = isPaseo
    ? "Paseo"
    : (rawKind === "conductor"
        ? "Conductor"
        : (rawKind === "codex"
            ? "Codex"
            : (rawKind === "claude"
                ? "Claude Code"
                : (rawKind === "antigravity" ? "Antigravity" : null))));
  const head = [engine, model && !engine?.includes(model) ? model : null].filter(Boolean).join(" · ");
  if (!head) return hostVia ?? null;
  if (hostVia && hostVia.toLowerCase() !== engine?.toLowerCase()) {
    return `${head} via ${hostVia}`;
  }
  return head;
}

export function deriveSubchannel(row = null, thread = null, explicitProject = null, orgOverride = null) {
  const proj = cleanSubAreaSlug(explicitProject || deriveCardProject(row, thread, orgOverride)) || "general";
  if (typeof orgOverride?.theme === "string" && orgOverride.theme.trim()) {
    const cleaned = cleanSubAreaSlug(orgOverride.theme);
    if (cleaned && cleaned !== proj) {
      return cleaned.includes("/") ? cleaned : `${proj}/${cleaned}`;
    }
  }
  const explicitSub = typeof (row?.subchannel ?? thread?.meta?.subchannel) === "string"
    ? row?.subchannel ?? thread?.meta?.subchannel
    : null;
  if (explicitSub) {
    const cleaned = cleanSubAreaSlug(explicitSub);
    if (cleaned) {
      return cleaned.includes("/") ? cleaned : `${proj}/${cleaned}`;
    }
  }
  const theme = cleanSubAreaSlug(row?.theme ?? thread?.theme ?? thread?.meta?.theme);
  if (theme && theme !== proj) {
    return theme.includes("/") ? theme : `${proj}/${theme}`;
  }
  const rawLabels = Array.isArray(thread?.meta?.paseoLabels) ? thread.meta.paseoLabels : [];
  for (const label of rawLabels) {
    const trimmed = String(label ?? "").trim();
    const slash = trimmed.indexOf("/");
    if (slash > 0) {
      const leaf = cleanSubAreaSlug(trimmed.slice(slash + 1));
      if (leaf && leaf !== proj) return `${proj}/${leaf}`;
    }
  }
  const rawCwd = String(thread?.cwd ?? thread?.meta?.paseoCwd ?? row?.cwd ?? "").trim().replace(/\/+$/, "");
  if (rawCwd) {
    const wtMatch = /\/(?:\.paseo|paseo)\/worktrees\/([^/]+)\/([^/]+)/i.exec(rawCwd)
      ?? /\/conductor\/workspaces\/([^/]+)\/([^/]+)/i.exec(rawCwd);
    if (wtMatch?.[2]) {
      const wt = cleanSubAreaSlug(wtMatch[2]);
      if (wt && wt !== proj) return `${proj}/${wt}`;
    }
    const base = cleanSubAreaSlug(rawCwd.split("/").filter(Boolean).at(-1));
    if (base && base !== proj && rawCwd.toLowerCase().includes(`/${proj}/`)) {
      return `${proj}/${base}`;
    }
  }
  return null;
}

export function deriveBoardLabels({
  row = null,
  thread = null,
  question = null,
  prRef = null,
  ciState = null,
  subchannel = null,
  blockingCount = 0
} = {}) {
  const out = [];
  const seen = new Set();
  const push = (key, value) => {
    const k = String(key ?? "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
    const v = String(value ?? "").trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9_./#-]/g, "");
    if (!k || !v) return;
    const token = `${k}=${v}`.slice(0, 64);
    if (seen.has(token)) return;
    seen.add(token);
    out.push(token);
  };

  const watchGroup = row?.watch?.group ?? null;
  const rawState = String(row?.state ?? thread?.agentStatus ?? "").toLowerCase();
  if (blockingCount > 0 || question?.kind === "blocked" || ciState === "FAILURE" || ciState === "ERROR" || row?.health === "red" || watchGroup === "blocked") {
    push("state", "blocked");
  } else if (watchGroup === "you" || question?.status === "open" || rawState === "waiting" || rawState === "needs-human") {
    push("state", "waiting");
  } else if (question?.kind === "ready" || rawState === "ready-needs-human") {
    push("state", "ready");
  } else if (row?.agentStatus === "running" || rawState === "running" || watchGroup === "working") {
    push("state", "running");
  } else if (rawState && rawState !== "unknown") {
    push("state", rawState);
  }

  const providerRaw = String(thread?.meta?.provider ?? row?.provider ?? thread?.kind ?? row?.kind ?? "").trim();
  const agentLeaf = providerRaw.includes("/") ? providerRaw.split("/")[0] : providerRaw;
  if (agentLeaf) push("agent", agentLeaf);

  const parsedPr = parsePrRef(prRef ?? row?.pr?.ref ?? thread?.prRefs?.[0]);
  if (parsedPr?.number) push("pr", `#${parsedPr.number}`);

  const ci = String(ciState ?? row?.pr?.ci?.state ?? "").toUpperCase();
  if (ci === "SUCCESS") push("ci", "passing");
  else if (ci === "FAILURE" || ci === "ERROR") push("ci", "failing");
  else if (ci === "PENDING" || ci === "IN_PROGRESS") push("ci", "pending");

  if (subchannel && subchannel.includes("/")) {
    push("area", subchannel.split("/").slice(1).join("/"));
  }
  return out;
}

export function computeBlockingImpact({
  threadKey = null,
  prRef = null,
  branch = null,
  rowsByKey = new Map(),
  blockingResolver = null
} = {}) {
  const taskImpact = typeof blockingResolver === "function" && threadKey
    ? (blockingResolver(threadKey) ?? { count: 0, blockingTitles: [] })
    : { count: 0, blockingTitles: [] };
  const taskCount = Number.isFinite(taskImpact?.count) ? Math.max(0, taskImpact.count) : 0;
  const titles = Array.isArray(taskImpact?.blockingTitles) ? taskImpact.blockingTitles.filter(Boolean) : [];

  let peerWaitingCount = 0;
  for (const [k, r] of rowsByKey ?? []) {
    if (!k || !r || k === threadKey || r.muted) continue;
    const samePr = Boolean(prRef && r.pr?.ref && r.pr.ref === prRef);
    const sameBranch = Boolean(branch && r.branch && r.branch === branch);
    if (!samePr && !sameBranch) continue;
    const waitingLike = r.watch?.group === "waiting" || r.watch?.group === "blocked" || r.state === "waiting" || r.health === "red";
    if (waitingLike) peerWaitingCount += 1;
  }

  const blockingCount = taskCount + peerWaitingCount;
  if (blockingCount <= 0) return { blockingCount: 0, blockingSummary: null };
  if (taskCount > 0) {
    const sample = titles[0] ? ` (${clampText(titles[0], 42)})` : "";
    return {
      blockingCount,
      blockingSummary: `Blocking ${blockingCount} downstream item${blockingCount === 1 ? "" : "s"}${sample}`
    };
  }
  const target = prRef || branch || "downstream work";
  return {
    blockingCount,
    blockingSummary: `Blocking ${peerWaitingCount} waiting session${peerWaitingCount === 1 ? "" : "s"} on ${target}`
  };
}

export function buildSupervisorDeck(
  state,
  { preferences = null, now = Date.now(), threadsByKey = new Map(), prsByKey = new Map(), knownRows = new Map(), blockingResolver = null, projectAliases = null, activeGoalResolver = null } = {}
) {
  const prefs = normalizePreferences(preferences ?? state?.preferences);
  const snapshot = state?.snapshot ?? null;
  const rowsByKey = new Map();
  for (const [k, r] of knownRows ?? []) if (k && r) rowsByKey.set(k, r);
  for (const r of snapshot?.threads ?? []) if (r?.key) rowsByKey.set(r.key, r);
  const actions = Array.isArray(state?.actions) ? state.actions : [];
  const questions = Array.isArray(state?.questions) ? state.questions : [];
  const aliasOverride = projectAliases ? { projectAliases } : null;

  const allQuestionCards = questions
    .filter((q) => isQuestionLiveForDeck(q, q.threadKey ? rowsByKey.get(q.threadKey) : null, prefs))
    .map((q) => buildSupervisorCard(q, { rowsByKey, threadsByKey, prsByKey, actions, prefs, blockingResolver, activeGoalResolver, now }))
    .sort((a, b) => a.rank - b.rank || String(b.noticedAt ?? "").localeCompare(String(a.noticedAt ?? "")));
  const questionCards = allQuestionCards.filter((card) => card.needsYou !== false);

  const prefCards = buildProgressivePreferenceCards(prefs, { now });
  const cards = [...questionCards, ...prefCards].map(({ rank: _rank, ...card }) => ({
    ...card,
    project: deriveCardProject(card, card.threadKey ? rowsByKey.get(card.threadKey) : null, aliasOverride)
  }));
  const allCards = [...allQuestionCards, ...prefCards].map(({ rank: _rank, ...card }) => ({
    ...card,
    project: deriveCardProject(card, card.threadKey ? rowsByKey.get(card.threadKey) : null, aliasOverride)
  }));

  const activeSummary = buildActiveSummary(snapshot, cards);
  const autonomy = buildAutonomySummary(actions, prefs, questionCards.length, now);
  const catchUpSummary = buildCatchUpSummary(cards, activeSummary);

  return {
    // Keep non-actionable completion cards addressable for Context/Inspect and
    // the explicit archive flow; clients filter them from Needs You by needsYou.
    cards: allCards,
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
