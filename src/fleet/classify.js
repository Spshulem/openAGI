// Pure classifier: one thread + its PR + infra -> one supervisor state.
// No I/O. Agent text is only matched against patterns here; nothing from it
// is copied into anything another agent will read.

import { DEFAULTS, ERROR_KINDS, SUPERVISOR_PREFIX, msSince } from "./contracts.js";

const DELIBERATE_STOP_MS = 60_000;

// Re-exported for callers that already import it from here.
export { SUPERVISOR_PREFIX };

// The agent ended its turn to wait on CI, a verify, or a deploy.
export const WAITING_PATTERNS = Object.freeze([
  /\bCI (?:is |still )*(?:running|pending|queued|in progress)\b/i,
  /\bwatch(?:ing|er)\b[^.?!\n]{0,60}\b(?:CI|checks?|runs?|bb-verify|bb-quick|verif\w*|deploy\w*|builds?)\b/i,
  /\bwaiting (?:on|for)\b[^.?!\n]{0,60}\b(?:CI|checks?|runs?|bb-verify|bb-quick|verif\w*|BuildBot ?3|bb3|deploy\w*|builds?|queue)\b/i,
  /\bbb-(?:verify|quick)\b[^.?!\n]{0,40}\b(?:running|queued|in progress|pending)\b/i,
  /\b(?:verifier|verify|verification)\s+(?:run\s+)?\d*\s*(?:is\s+)?(?:still\s+)?(?:running|queued)\b/i,
  /\bI'll (?:report|post|share)\b[^.?!\n]{0,40}\b(?:verdict|result|when)\b/i,
  /\bwhen (?:it|CI|the run|they) (?:lands?|finish(?:es)?|completes?)\b/i,
  /\bqueued (?:with|behind) \d+/i
]);

// Permission phrasing. The answer is "yes" only when the step asked about is
// on IN_SCOPE_STEP_PATTERNS and no out-of-scope topic is near it.
export const IN_SCOPE_ASK_PATTERNS = Object.freeze([
  /\b(?:do you )?want me to\b/i,
  /\bwould you like me to\b/i,
  /\b(?:should|shall|may|can) I\b/i,
  /\bsay (?:go|the word)\b/i,
  /\b(?:ok|okay)(?: for me)? to\b[^.?!\n]{0,80}\?/i,
  /\blet me know if you want\b/i,
  /\b(?:proceed|go ahead)\?/i
]);

// Topics only the owner can decide, from the owner's own escalation list.
export const OUT_OF_SCOPE_PATTERNS = Object.freeze([
  { topic: "admin", pattern: /--admin\b|\badmin[- ]merge\b|\bbypass\w*\b[^.?!\n]{0,30}\b(?:protection|rules?|policy)\b/i },
  { topic: "approval", pattern: /\bapprov(?:e|al|als|ing)\b/i },
  // Any mention of prod: releases, prod databases, prod migrations.
  { topic: "production", pattern: /\bprod(?:uction)?\b|\blive (?:site|db|database|env(?:ironment)?)\b/i },
  { topic: "merge", pattern: /\b(?:merge|land)\s+(?:it|this|them|both|all|these|those|the (?:PRs?|stack|branch))\b|\bmerge\s+(?:PR\s*)?#?\d+\b|\bmerge (?:to|into) main\b|\bmerge (?:as|when) (?:they|it|each)\b/i },
  { topic: "credentials", pattern: /\bpassword\b|\bcredentials?\b|\bAUP\b|\bOAuth\b|\bre-?auth\w*\b|\/login\b|\b2FA\b|\bAPI key\b|\byour click\b|\bsecrets?\b|\b(?:access|auth|secret|private|signing|deploy|service)[- ](?:keys?|tokens?)\b|\b(?:rotate|regenerate|revoke|roll|reissue)\b[^.?!\n]{0,40}\b(?:keys?|tokens?|creds|certs?|certificates?)\b/i },
  { topic: "money", pattern: /\bcredits\b|\btop[- ]?up\b|\bupgrade (?:the |your )?plan\b|\bbilling\b|\bpurchase\b|\$\d/i },
  { topic: "delete", pattern: /\b(?:delete|remove|stop|kill|reap|shut ?down|tear ?down|clean ?up)\b[^.?!\n]{0,50}\b(?:other|others'?|another|their|someone else's)\b|\b(?:stop|delete|remove|tear ?down|shut ?down)\s+(?!(?:my|our|its) own\b)[^.?!\n]{0,40}\bpreviews?\b|\btake (?:it|this|that|them|these|those) down\b|\breclaim\b|\bprune\b|\bwipe\b/i },
  { topic: "reboot", pattern: /\breboot\w*|\bpower[- ]?cycle\b|\b(?:restart|bounce|shut ?down|stop)\b[^.?!\n]{0,40}\b(?:buildbot ?3|bb3|100\.99\.3\.113|docker\w*|colima|orbstack|daemons?|the (?:box|host|machine|vm))\b|\b(?:buildbot ?3|bb3|docker\w*)\b[^.?!\n]{0,30}\b(?:restart|bounce)\w*/i },
  { topic: "cancel", pattern: /\b(?:cancel|kill|stop|abort|terminate|pkill)\w*\b(?!\s+(?:my|our|its)\b)[^.?!\n]{0,25}\b(?:runs?|jobs?|verif\w*|bb-(?:quick|verify)|builds?|previews?|containers?|workflows?|processes|queue)\b/i },
  { topic: "history", pattern: /\bforce[- ]?push\w*|\bpush\b[^.?!\n]{0,40}(?:--force\b|\s-f\b)|\breset\s+--hard\b|\brewrit\w*\b[^.?!\n]{0,20}\bhistory\b/i },
  { topic: "main", pattern: /\bpush\w*\s+(?:[\w-]+\s+){0,2}(?:to|into|onto|on|over)\s+(?:origin[ /])?(?:main|master)\b|\bpush\w*\s+(?:origin\s+)?(?:HEAD:)?(?:main|master)\b|\b(?:straight|directly|right)\s+(?:to|into|onto|on)\s+(?:origin[ /])?(?:main|master)\b|\bcommit\w*\s+(?:directly\s+|straight\s+)?(?:to|on|into)\s+(?:main|master)\b/i },
  { topic: "database", pattern: /\b(?:drop|truncate)\b[^.?!\n]{0,40}\b(?:tables?|databases?|db|schemas?|collections?|indexes)\b|\bdelete\b[^.?!\n]{0,30}\b(?:rows?|records?|tables?)\b|\bDELETE FROM\b|\b(?:run|apply|execute|roll ?back)\b[^.?!\n]{0,30}\bmigrations?\b|\bmigrat\w*\b[^.?!\n]{0,40}\b(?:db|database|shared|staging)\b|\breseed\b/i }
]);

// The only asks answered "yes" without the owner: routine steps on the
// agent's own PR. Anything else, however it is phrased, goes to the owner.
export const IN_SCOPE_STEP_PATTERNS = Object.freeze([
  // bb-quick / bb-verify on BuildBot3 for its own PR.
  /\bbb-(?:quick|verify)\b/i,
  /\bverif\w*\b[^.?!\n]{0,30}\bon (?:buildbot ?3|bb3)\b/i,
  // Push its own branch. Force-push and push to main are caught above.
  /\bpush(?:ed|ing)?\b(?![^.?!\n]{0,30}\b(?:tags?|releases?)\b)(?=\s*(?:[.?!,;]|$)|\s+(?:it|this|that|them|these|those|now|again|up|and|then|everything|the (?:fix(?:es)?|changes?|commits?|branch|update|head)|my (?:fix(?:es)?|changes?|commits?|branch)|(?:up )?to (?:origin|the remote|the PR|the branch|my branch|this branch|remote)\b))/i,
  // Resolve or reply to review threads.
  /\b(?:resolve|reply(?: to)?|respond to|address|answer|fix)\b[^.?!\n]{0,40}\b(?:threads?|comments?|reviews?|nits?|feedback)\b/i,
  // Merge or rebase main into its own branch. "Merge into main" is caught above.
  /\b(?:merg(?:e|ed|ing)|pull(?:ed|ing)?)\s+(?:in\s+)?(?:the latest\s+)?(?:origin\/)?(?:main|master)\b/i,
  /\brebas(?:e|ed|ing)\b[^.?!\n]{0,30}\b(?:main|master)\b/i,
  // Rerun CI.
  /\b(?:re-?run|re-?trigger|retry|restart|kick)\b[^.?!\n]{0,30}\b(?:CI|checks?|jobs?|workflows?|tests?|builds?)\b/i,
  // Open or update its own PR.
  /\b(?:open|create|raise|file|update|edit|draft|put up)\b[^.?!\n]{0,30}\b(?:PR|pull request)\b/i,
  /\bfollow-?up PR\b/i,
  // Retake screenshots or start its own BuildBot3 preview.
  /\b(?:re-?take|take|capture|grab|attach|add|redo)\b[^.?!\n]{0,20}\bscreenshots?\b/i,
  /\b(?:start|spin up|bring up|launch|create|rebuild|refresh)\b(?![^.?!\n]{0,40}\b(?:other|others'?|another|their|someone)\b)[^.?!\n]{0,30}\bpreview\b/i,
  // Clean up its own worktree.
  /\b(?:clean ?up|remove|delete)\s+(?:my|our|its|this|the)\s+(?:own\s+)?(?:worktree|workspace)\b/i
]);

// "Say go." or "Proceed?" names no step: the sentence before it does.
const BARE_ASK = /^(?:(?:ok(?:ay)?|so)[,.]?\s+)?(?:say (?:go|the word)|(?:(?:shall|should|can|may) I\s+|(?:do you )?want me to\s+|ok(?:ay)? to\s+)?(?:proceed|go ahead|continue|do (?:it|this|that|so))(?:\s+now)?|(?:do you )?want me to|(?:should|shall) I)\W*$/i;

// The agent wants a decision, not permission.
const NEED_YOU_PATTERNS = [
  /\bneeds? you\b/i,
  /\bneeds? your\b/i,
  /\bneed (?:one of these |something |a decision )?from you\b/i,
  /\bwhat I'd like from you\b/i,
  /\byour call\b/i,
  /\bwhich (?:one|option|do you|would you)\b/i,
  /\bplease confirm\b/i,
  /\b(?:blocked|waiting) on you\b/i,
  /\byou must do\b(?![\W_]{0,8}(?:none|nothing|n\/a)\b)/i,
  /(?<!\b(?:not|no longer|never)\s+)\bstill need your\b/i,
  /(?<!\b(?:not|no longer|never|nothing(?: here)?(?: is)?|isn't|is not|aren't|are not)\s+(?:\w+\s+){0,2})\bblocked on\W{0,3}(?:you|your|the owner)\b/i
];

// The agent ended its turn saying it will keep going ("Next: wire the
// settings page", "I'll open the PR after the tests"): nothing will wake it
// but a nudge. Only its last few sentences count, each at its start, and
// never one waiting on the owner or naming an owner-only step (see
// promisedWork): real finals like "Say go and I'll publish" or "Next:
// promote to production" must never read as a promise.
export const PROMISED_WORK_PATTERNS = Object.freeze([
  /^I(?:'ll| will| am going to|'m going to)\s+(?!(?:be|keep|only|never|not|also|wait|stop|leave|hold|pause|stand|let|report back when you|check back|circle back)\b)\w/i,
  /^(?:next(?:\s+steps?|\s+up)?|then|after that)\s*:\s*(?!(?:none|nothing|n\/a|nope|no(?:thing)? (?:more|else|left)|you|your|owner)\b)[a-z]/i,
  /^(?:now\s+)?(?:running|starting|kicking off|re-?running)\s+(?:the|a|an|full|my|all|both)\b/i,
  /^(?:continuing|moving on to)\b/i
]);

// Reports that mention "you" but ask for nothing.
const NOT_ASK = /\bnothing\b[^.?!\n]{0,25}\b(?:from|for) you\b|\bnothing needs you\b|\bno action (?:needed|required)\b|\byou\W{0,3}nothing\b|\bnothing (?:that )?you (?:must|need to|have to) do\b/i;
const CHOICE_WORDS = /\bwhich\b|\bpick\b|\bchoose\b|\boption\b|\bor\b/i;

const BB3_DOWN_PATTERNS = [
  /\b(?:buildbot ?3|bb3|100\.99\.3\.113)\b[^.?!\n]{0,60}\b(?:down|unreachable|not reachable|unavailable|frozen|rebooting|jammed)\b/i,
  /\bblocked on (?:buildbot ?3|bb3)\b/i
];

const BLOCKED_ON_OWNER_ASK = Object.freeze({ topic: "approval", text: "Blocked on a permission prompt or dialog.", options: Object.freeze(["opened", "later"]) });

const STOPPED = new Set(["aborted", "stalled", "error"]);
const PR_DONE = new Set(["MERGED", "CLOSED"]);
const CI_RED = new Set(["FAILURE", "ERROR"]);
const CI_RUNNING = new Set(["PENDING", "EXPECTED"]);

// One colour per thread for the phone and chat tools. Red: the owner or an
// outage has it stuck. Yellow: it will stall without a push. Green: moving,
// or finished. Gray: out of scope or a state this build does not know.
const HEALTH_BY_STATE = Object.freeze({
  running: "green", "waiting-ci": "green", "local-verify": "green", "asked-in-scope": "green", done: "green",
  "pr-not-ready": "yellow", "idle-no-pr": "yellow", "ready-needs-human": "yellow", stopped: "yellow",
  "needs-human": "red", "infra-blocked": "red"
});

// error is the row's error (any non-null value). A turn that ended on an
// error is red whatever the PR says, unless the agent is running again.
export function threadHealth(state, error = null) {
  if (state === "excluded" || !Object.hasOwn(HEALTH_BY_STATE, state)) return "gray";
  if (state !== "running" && error != null) return "red";
  return HEALTH_BY_STATE[state];
}

// A Claude transcript and a Conductor session are the same agent when the
// Conductor row points at the transcript's session id. Conductor owns status.
export function mergeThreads({ codex = [], claude = [], conductor = [] } = {}) {
  const merged = conductor.filter(Boolean).map((thread) => ({ ...thread }));
  const byClaudeId = new Map();
  for (const thread of merged) if (thread.claudeSessionId) byClaudeId.set(thread.claudeSessionId, thread);
  const loose = [];
  for (const thread of claude.filter(Boolean)) {
    const target = byClaudeId.get(thread.claudeSessionId ?? thread.id);
    if (target) foldClaudeInto(target, thread);
    else loose.push({ ...thread });
  }
  return [...codex.filter(Boolean).map((thread) => ({ ...thread })), ...merged, ...loose];
}

function foldClaudeInto(target, claude) {
  target.prRefs = [...new Set([...(target.prRefs ?? []), ...(claude.prRefs ?? [])])];
  target.live = target.live ?? claude.live ?? null;
  target.error = target.error ?? claude.error ?? null;
  if (!target.lastAgentText) {
    target.lastAgentText = claude.lastAgentText ?? "";
    target.lastAgentTail = claude.lastAgentTail ?? "";
    target.lastAgentAt = claude.lastAgentAt ?? target.lastAgentAt ?? null;
  }
  target.cwd = target.cwd || claude.cwd || null;
  target.branch = target.branch || claude.branch || null;
  target.repo = target.repo || claude.repo || null;
  // The newer owner message wins so the owner-recent guard sees it.
  if (isAfter(claude.lastUserAt, target.lastUserAt)) {
    target.lastUserAt = claude.lastUserAt;
    target.lastUserText = claude.lastUserText ?? "";
  }
  if (isAfter(claude.lastActivityAt, target.lastActivityAt)) target.lastActivityAt = claude.lastActivityAt;
  if (!target.openTasks?.length && claude.openTasks?.length) target.openTasks = claude.openTasks;
  if (!target.excluded && claude.excluded === "self") target.excluded = "self";
  target.meta = { ...(claude.meta ?? {}), ...(target.meta ?? {}), claudeKey: claude.key };
}

export function prReadiness(pr, localGit) {
  const local = localGit ?? {};
  if (!pr) {
    return { ready: false, blockers: [], onlyHumanLeft: false, progressMark: { head: local.head ?? null, unresolved: null } };
  }
  const progressMark = { head: pr.headOid || local.head || null, unresolved: Number.isFinite(pr.unresolvedThreads) ? pr.unresolvedThreads : null };
  if (PR_DONE.has(pr.state)) return { ready: false, blockers: [], onlyHumanLeft: false, progressMark };

  const blockers = [];
  // A worktree on another branch says nothing about this PR's head.
  const sameBranch = !local.branch || !pr.headRef || local.branch === pr.headRef;
  if (sameBranch && local.head !== pr.headOid && Number(local.ahead) > 0) blockers.push("unpushed commits");
  else if (sameBranch && local.head && pr.headOid && local.head !== pr.headOid) blockers.push("local head differs");
  // Unpushed work cannot be ruled out when git did not answer.
  else if (local.unreadable) blockers.push("local git unknown");
  if (sameBranch && local.head === pr.headOid && local.dirty === true) blockers.push("uncommitted work");
  // A git status that did not answer is the supervisor's gap, not agent work.
  else if (sameBranch && local.head === pr.headOid && Object.hasOwn(local, "dirty") && local.dirty === null) blockers.push("local git unknown");

  const ci = pr.ci ?? {};
  if (CI_RED.has(ci.state) || ci.failing?.length) blockers.push(`CI red: ${ciNames(ci.failing)}`);
  else if (CI_RUNNING.has(ci.state)) blockers.push("CI running");
  else if (!ci.state) blockers.push("no CI on head");

  if (Number(pr.unresolvedThreads) > 0) blockers.push(`${pr.unresolvedThreads} open threads`);
  else if (pr.threadsTruncated) blockers.push("100+ threads, not all read");
  // Requested changes are work for the agent, not an approval for the owner.
  if (pr.reviewDecision === "CHANGES_REQUESTED") blockers.push("changes requested");
  if (pr.mergeState === "DIRTY" || pr.mergeable === "CONFLICTING") blockers.push("merge conflicts");
  else if (pr.mergeState === "BEHIND") blockers.push("branch behind base");
  // GitHub computes mergeability lazily; unknown is never "ready".
  else if (!pr.mergeable || pr.mergeable === "UNKNOWN" || !pr.mergeState || pr.mergeState === "UNKNOWN") blockers.push("mergeability unknown");
  if (pr.codexReview?.reviewedHead === false) blockers.push("Codex review not on head");
  if (pr.qa?.required === true && pr.qa?.freshOnHead !== true) blockers.push("UI QA missing");
  if (pr.isDraft) blockers.push("draft");

  const onlyHumanLeft = blockers.length === 0 && (pr.reviewDecision === "REVIEW_REQUIRED" || pr.mergeState === "BLOCKED");
  return { ready: blockers.length === 0 && !onlyHumanLeft, blockers, onlyHumanLeft, progressMark };
}

function ciNames(failing) {
  const names = (failing ?? []).map((name) => String(name)).filter(Boolean);
  if (!names.length) return "checks";
  return names.length > 3 ? `${names.slice(0, 3).join(", ")} +${names.length - 3}` : names.join(", ");
}

export function classifyThread(thread, { pr = null, localGit = null, infra = null, now = Date.now(), config = null } = {}) {
  const limits = { ...DEFAULTS, ...(config?.limits ?? {}) };
  const readiness = prReadiness(pr, localGit);
  const result = (state, reason, extra = {}) => ({
    state, reason, blockers: [], readiness, infraKind: null, ask: null, wait: null, ...extra
  });

  const excluded = exclusionReason(thread, { pr, localGit, config });
  if (excluded) return result("excluded", excluded);
  if (isRunning(thread, now, limits)) return result("running", "turn in progress");
  // A live session on a permission prompt or dialog waits on the owner's
  // click. A nudge cannot clear it.
  if (thread.meta?.blockedOnOwner === true) return result("needs-human", "blocked on a permission prompt", { ask: { ...BLOCKED_ON_OWNER_ASK, options: [...BLOCKED_ON_OWNER_ASK.options] } });
  // Codex request_user_input: the real question is structured, not in the text.
  if (thread.meta?.pendingQuestion && !prSettledAfter(pr, Date.parse(thread.meta.pendingQuestion.at ?? ""), structuredAskAt(thread))) {
    const pending = thread.meta.pendingQuestion;
    return result("needs-human", "agent asks: structured question", { ask: { topic: "decision", structured: true, text: pending.text ?? String(pending), options: pending.options?.length ? pending.options : ["open thread"], key: pending.key ?? null } });
  }

  // Once the owner replied, the agent's last words are stale.
  const text = agentSpokeLast(thread) ? String(thread.lastAgentText ?? "") : "";

  const infraKind = infraBlockKind(thread, infra, text);
  if (infraKind) return result("infra-blocked", `blocked: ${infraKind}`, { infraKind });

  // A turn that ended without finishing (an app restart kills open turns
  // without a word; something other than the owner interrupted it) is
  // stopped whatever its PR says. Its last words are mid-work, not a wait
  // or an ask, and a merged or missing PR does not mean the work is done.
  if (thread.agentStatus === "stalled" || (thread.agentStatus === "aborted" && !deliberateStop(thread))) {
    return result("stopped", thread.agentStatus === "aborted" ? "turn interrupted mid-work" : "turn stopped mid-work, no end written");
  }

  // A laptop verify often shows up as a background-task wait. It is the
  // violation, not a CI wait, so it must not be swallowed by waiting-ci.
  const localVerify = matchLocalVerify(thread, infra);
  let wait = localVerify ? null : waitSignal(thread, text, now);
  // "CI is pending. Blocked on your approval.": an explicit owner ask beats
  // a wait the agent only wrote down.
  if (wait?.source === "text" && detectAsk(text)?.kind === "needs-human" && !prSettledAfter(pr, Date.parse(thread.lastAgentAt ?? ""))) wait = null;
  if (wait) return result("waiting-ci", wait.reason, { wait, infraKind: wait.taskKind ? "bb3" : null });
  if (localVerify) {
    return result("local-verify", "heavy verification on the laptop", {
      localVerify: { pid: localVerify.pid ?? null, ageSec: localVerify.ageSec ?? null }
    });
  }

  const ask = prSettledAfter(pr, Date.parse(thread.lastAgentAt ?? "")) ? null : detectAsk(text);
  if (ask?.kind === "needs-human") return result("needs-human", `agent asks: ${ask.topic}`, { ask });
  if (ask?.kind === "in-scope") return result("asked-in-scope", "agent asked to do an in-scope step", { ask });

  if (pr && pr.state === "OPEN") {
    if (readiness.blockers.length) return result("pr-not-ready", readiness.blockers.join("; "), { blockers: readiness.blockers });
    return result("ready-needs-human", readiness.onlyHumanLeft ? "only a human approval left" : "ready; merge is the owner's");
  }
  // The agent spoke last and stopped: did it say it would keep going? Only
  // when its PR is known: none (looked up, or nothing to look up), or merged
  // (a closed one was dropped). An unread or not-yet-looked-up PR decides
  // nothing.
  const prKnown = pr ? pr.state === "MERGED" : !thread.prRefs?.length && (!thread.branch || thread.prLookedUp === true);
  const idle = text && prKnown && thread.agentStatus !== "error" ? { promised: promisedWork(text) } : null;
  if (pr && PR_DONE.has(pr.state)) return result("done", `PR ${pr.state.toLowerCase()}`, idle ? { idle } : {});
  return result("idle-no-pr", thread.prRefs?.length ? "PR state unknown" : "no PR", idle ? { idle } : {});
}

// A PR merged or closed after the agent asked has answered the ask, but only
// if it existed when the agent asked: one opened later is new work (west-
// monroe asked, then #6954 was opened and merged). An ask made after the
// merge ("merged; QA it on staging?") stands, and so does one whose times
// are unknown. lastMs: the agent's latest words, which may repeat the ask.
function prSettledAfter(pr, askMs, lastMs = askMs) {
  if (!pr || !PR_DONE.has(pr.state) || !Number.isFinite(askMs)) return false;
  const openedAt = Date.parse(pr.createdAt ?? "");
  const doneAt = Date.parse(pr.mergedAt ?? pr.closedAt ?? "");
  return Number.isFinite(openedAt) && openedAt <= askMs && Number.isFinite(doneAt) && doneAt > lastMs;
}

// The agent's later words may repeat the structured ask, so the later time
// counts. A question with no time of its own is never settled.
function structuredAskAt(thread) {
  const askedAt = Date.parse(thread.meta?.pendingQuestion?.at ?? "");
  if (!Number.isFinite(askedAt)) return NaN;
  const agentAt = Date.parse(thread.lastAgentAt ?? "");
  return Number.isFinite(agentAt) ? Math.max(askedAt, agentAt) : askedAt;
}

function exclusionReason(thread, { pr, localGit, config }) {
  if (thread.excluded) return thread.excluded;
  if (thread.archived) return "archived";
  const self = config?.selfSessionIds ?? [];
  if (self.includes(thread.id) || (thread.claudeSessionId && self.includes(thread.claudeSessionId))) return "self";
  const hasRepo = thread.repo || localGit?.remote || pr?.repo;
  if (!hasRepo && !thread.branch && !thread.prRefs?.length) return "no-repo";
  return null;
}

// The owner pressed stop: their message came within a minute before the
// abort. A supervisor message is never the owner's.
export function deliberateStop(thread) {
  if (thread.agentStatus !== "aborted") return false;
  if (String(thread.lastUserText ?? "").startsWith(SUPERVISOR_PREFIX)) return false;
  const userAt = Date.parse(thread.lastUserAt ?? "");
  // Later metadata writes bump lastActivityAt; the source's abort time does not move.
  const abortAt = Date.parse(thread.meta?.abortedAt ?? thread.lastActivityAt ?? "");
  if (!Number.isFinite(userAt) || !Number.isFinite(abortAt)) return false;
  const gap = abortAt - userAt;
  return gap >= 0 && gap <= DELIBERATE_STOP_MS;
}

function isRunning(thread, now, limits) {
  if (thread.agentStatus === "running") return true;
  // The peer registry's "busy" is reliable for plain Claude sessions only;
  // Conductor status comes from its own DB.
  if (thread.kind === "claude" && thread.live?.status === "busy") return true;
  if (thread.agentStatus === "unknown") {
    const age = msSince(thread.lastActivityAt, now);
    return age !== null && age < limits.runningWindowMs;
  }
  return false;
}

function agentSpokeLast(thread) {
  const agentAt = Date.parse(thread.lastAgentAt ?? "");
  const userAt = Date.parse(thread.lastUserAt ?? "");
  if (!Number.isFinite(agentAt) || !Number.isFinite(userAt)) return true;
  if (String(thread.lastUserText ?? "").startsWith(SUPERVISOR_PREFIX)) return true;
  return agentAt >= userAt;
}

function infraBlockKind(thread, infra, text) {
  const kind = thread.error?.kind;
  if (kind && kind !== "other" && ERROR_KINDS.includes(kind)) return kind;
  // Codex-lb stalls never reach the rollout; they only show in the log DB.
  const lbHit = (infra?.lb?.recentErrors ?? []).some((entry) => entry.threadIds?.includes(thread.id));
  if (thread.kind === "codex" && STOPPED.has(thread.agentStatus) && lbHit) return "lb";
  if (text && BB3_DOWN_PATTERNS.some((pattern) => pattern.test(text))) return "bb3";
  return null;
}

function matchLocalVerify(thread, infra) {
  const keys = new Set([thread.key, thread.meta?.claudeKey].filter(Boolean));
  return (infra?.localVerify ?? []).find((proc) => (proc.threadKey && keys.has(proc.threadKey))
    || (!proc.threadKey && isUnder(proc.cwd, thread.cwd))) ?? null;
}

function isUnder(child, parent) {
  if (!child || !parent) return false;
  const base = parent.endsWith("/") ? parent : `${parent}/`;
  return child === parent || child.startsWith(base);
}

function waitSignal(thread, text, now) {
  if (thread.agentStatus === "waiting") {
    const task = oldestTask(thread.openTasks);
    const taskKind = task ? verifyKind(task) : null;
    const since = task?.startedAt ?? thread.lastAgentAt ?? thread.lastActivityAt;
    const label = taskKind === "full" ? "bb-verify --full" : taskKind === "quick" ? "bb-quick" : "a background task";
    return { source: "task", taskKind, ageMs: msSince(since, now), reason: `waiting on ${label}` };
  }
  if (text && WAITING_PATTERNS.some((pattern) => pattern.test(text))) {
    return { source: "text", taskKind: null, ageMs: msSince(thread.lastAgentAt ?? thread.lastActivityAt, now), reason: "ended turn to wait on CI or verify" };
  }
  return null;
}

// The owner holds a step, anywhere in the message: an offer, a go, a pick,
// an approval, a login, anything addressed to "you".
const OWNER_GATE = /\byou(?:r|rs|rself)?\b|\b(?:tell|ping|let|show|send|give) me\b|\bsay\s+(?:["\u201c'*]|go\b|yes\b|continue\b|the word\b)|\bI need\b|\bplease\b|\b(?:once|after|when|until) (?:he|she|they|the owner|spencer)\b|\b(?:pick|choose)\b|\b(?:name|confirm|approve)\s+(?:them|one|it|which)\b|\bdecisions?\b|(?:^|\n)[\W_]*(?:do|action|owner|todo|to-do)[\W_]*:/i;
// An offer ("If you want, I'll...") is not a promise.
const CONDITIONAL = /^(?:if|when|should|let me know|happy to|want me to)\b/i;
// Steps that leave the agent's own branch: never pushed by a nudge.
// Past tense ("PR #123 merged. Next: update the docs") reports a step done.
const OWNER_STEP = /\b(?:merg(?:e|es|ing)|releas(?:e|es|ing)|deploy(?:s|ing|ment)?|publish(?:es|ing)?|promot(?:e|es|ing)|ship(?:s|ping)?|upload(?:s|ing)?|e-?mail(?:s|ing)?|post(?:s|ing)? (?:it|this|them|to)|send (?:it|this|them|the|an?)|customers?|invoic(?:e|es|ing)|tag(?:ging)? (?:a |the )?(?:release|version))\b/i;
// A report, not a plan: test results, finished work, a bug description.
const REPORTED = /\b(?:pass(?:ed|es|ing)?|fail(?:ed|s|ing)?|green|red|done|complete[d]?|finished|merged|broken|bugs?|crash(?:es|ed)?|(?:is|are|was|were|does|do|can|wo)n't|(?:is|are|does) not)\b|\d+\/\d+/i;

// The last three sentences, as written: tables and bare links are skipped.
function closingSentences(text) {
  return splitSentences(String(text).replace(/[\u2018\u2019]/g, "'"))
    .map((sentence) => sentence.replace(/^[-*>#\d.)\s]+|\*\*|__|`/g, "").trim())
    .filter((sentence) => sentence && !/^\|/.test(sentence) && !/^\[[^\]]*\]\([^)]*\)\W*$/.test(sentence))
    .slice(-3);
}

// One of the closing sentences promises more of the agent's own work; no
// closing sentence is a question; and nothing in the message waits on the
// owner or names an owner-only step.
function promisedWork(text) {
  const plain = String(text).replace(/[\u2018\u2019]/g, "'");
  if (OWNER_GATE.test(plain) || OWNER_STEP.test(plain) || OUT_OF_SCOPE_PATTERNS.some(({ pattern }) => pattern.test(plain))) return false;
  const closing = closingSentences(plain);
  if (closing.some((sentence) => /\?\W*$/.test(sentence))) return false;
  // "I'll investigate why CI is failing": in a promise, status words name
  // the work. A later report closes it ("I'll run the tests. Done.").
  let open = false;
  for (const sentence of closing) {
    if (CONDITIONAL.test(sentence)) continue;
    if (PROMISED_WORK_PATTERNS[0].test(sentence) || (!REPORTED.test(sentence) && PROMISED_WORK_PATTERNS.some((pattern) => pattern.test(sentence)))) open = true;
    else if (REPORTED.test(sentence)) open = false;
  }
  return open;
}

function oldestTask(tasks) {
  const list = (tasks ?? []).filter(Boolean);
  if (!list.length) return null;
  return list.reduce((oldest, task) => (isAfter(oldest.startedAt, task.startedAt) ? task : oldest));
}

// Task descriptions are agent-written; they are matched, never repeated.
function verifyKind(task) {
  const text = `${task.description ?? ""} ${task.kind ?? ""}`;
  if (/bb-quick/i.test(text)) return "quick";
  if (/bb-verify|full verif/i.test(text)) return "full";
  return null;
}

function detectAsk(text) {
  if (!text) return null;
  const sentences = splitSentences(text);
  const askIndexes = sentences.map((sentence, index) => (isAsk(sentence) ? index : -1)).filter((index) => index >= 0);
  if (!askIndexes.length) return null;
  const askText = askIndexes.map((index) => sentences[index]).join(" ");
  const options = listedOptions(text);
  const recommended = /\(recommended\)/i.test(text);
  // The topic comes from the ask region only. A risky step anywhere else in
  // the closing message (a force-push two sentences before "Should I push?")
  // still keeps the ask with the owner, under a neutral topic: "$0.50 per
  // post" in a recap does not make a merge offer a spend. Several separate
  // questions (apia: client IPs? the password bugs? shared views?) get the
  // neutral topic too, and a login or prod topic must be the step asked for.
  const region = askRegion(sentences, askIndexes);
  const step = askRegion(sentences, askIndexes, true);
  const hit = separateQuestions(sentences, askIndexes) > 1 ? null
    : OUT_OF_SCOPE_PATTERNS.find(({ topic, pattern }) => pattern.test(STEP_TOPICS.has(topic) ? step : region));
  if (hit) return { kind: "needs-human", topic: hit.topic, options, text: askText };
  if (OUT_OF_SCOPE_PATTERNS.some(({ pattern }) => pattern.test(text))) return { kind: "needs-human", topic: "decision", options, text: askText };
  const isChoice = options.length >= 2 && CHOICE_WORDS.test(askText);
  // The agent already picked one: taking "(recommended)" is in scope only
  // when that option is itself a routine PR step.
  if (isChoice) {
    const pick = sentences.find((sentence) => /\(recommended\)/i.test(sentence));
    const routine = recommended && pick && isRoutineStep(pick);
    return { kind: routine ? "in-scope" : "needs-human", topic: routine ? "in-scope" : "choice", options, text: askText };
  }
  if (NEED_YOU_PATTERNS.some((p) => p.test(askText))) return { kind: "needs-human", topic: "decision", options, text: askText };
  // A bare question with no permission phrasing: let the PR state decide.
  const permission = askIndexes.filter((index) => IN_SCOPE_ASK_PATTERNS.some((p) => p.test(sentences[index])));
  if (!permission.length) return null;
  // Every permission ask must name a routine PR step; the default is the owner.
  if (permission.every((index) => isRoutineStep(stepText(sentences, index)))) return { kind: "in-scope", topic: "in-scope", options, text: askText };
  return { kind: "needs-human", topic: "permission", options, text: askText };
}

function isRoutineStep(text) {
  return IN_SCOPE_STEP_PATTERNS.some((pattern) => pattern.test(text));
}

// "I'd do this as a follow-up PR. Say go." -> the step is the stated plan.
const PLAN_WORDS = /\b(?:I'd|I would|I'll|I will|I can|I could|I'm going to|I plan to|next(?: step)?:|plan:)/i;

function stepText(sentences, index) {
  const sentence = sentences[index];
  if (!BARE_ASK.test(sentence) || index === 0) return sentence;
  const before = sentences[index - 1];
  return PLAN_WORDS.test(before) ? `${before} ${sentence}` : sentence;
}

// Whether any sentence asks the owner something, by the rules detectAsk uses.
export function asksOwner(text) {
  return splitSentences(text ?? "").some(isAsk);
}

function isAsk(sentence) {
  if (NOT_ASK.test(sentence)) return false;
  return /\?\s*$/.test(sentence)
    || IN_SCOPE_ASK_PATTERNS.some((pattern) => pattern.test(sentence))
    || NEED_YOU_PATTERNS.some((pattern) => pattern.test(sentence));
}

// The ask, the options after it, and the sentence before a bare ask
// ("--admin merges now. Which?"): a short ask names no step itself.
// stepOnly drops what comes before "want me to" / "should I" in an ask.
function askRegion(sentences, askIndexes, stepOnly = false) {
  const picked = new Set();
  for (const index of askIndexes) {
    if (index > 0 && sentences[index].split(/\s+/).length <= BARE_ASK_WORDS) picked.add(index - 1);
    picked.add(index);
    for (let next = index + 1; next < sentences.length && OPTION_LINE.test(sentences[next]); next += 1) picked.add(next);
  }
  return [...picked].sort((a, b) => a - b)
    .map((index) => (stepOnly && askIndexes.includes(index) ? fromAskPhrase(sentences[index]) : sentences[index])).join(" ");
}

// "The prod deploy is done; want me to close the ticket?" asks to close a ticket.
function fromAskPhrase(sentence) {
  const at = sentence.search(LEADING_ASK);
  return at > 0 ? sentence.slice(at) : sentence;
}

// Questions, not follow-ons: "Can I clear the caches? Or free space another
// way?" is one question.
function separateQuestions(sentences, askIndexes) {
  return askIndexes.filter((index) => /\?\s*$/.test(sentences[index]) && !/^(?:[-*•]\s*)?(?:or|else|otherwise)\b/i.test(sentences[index])).length;
}

const OPTION_LINE = /^(?:[1-9]|[A-C])[.)]\s/;
const BARE_ASK_WORDS = 5;
// A passing noun can name these ("the password bugs", "a production
// customer"), so they count only in the step the agent asks to take.
const STEP_TOPICS = new Set(["credentials", "production"]);
// Ask phrases that come before the step they ask about.
const LEADING_ASK = /\b(?:(?:do you )?want me to|would you like me to|(?:should|shall|may|can) I|(?:ok|okay)(?: for me)? to|let me know if you want)\b/i;

function splitSentences(text) {
  return String(text).split(/(?<=[^\d\s][.?!])\s+|\n+/).map((part) => part.trim()).filter(Boolean);
}

// "1. X 2. Y" or "A) X B) Y" -> ["1", "2"]. At most three buttons.
function listedOptions(text) {
  const labels = [];
  for (const match of String(text).matchAll(/(?:^|[\s(])([1-9]|[A-C])[.)]\s+\S/g)) {
    if (!labels.includes(match[1])) labels.push(match[1]);
  }
  const numeric = labels.filter((label) => /\d/.test(label));
  const lettered = labels.filter((label) => /[A-C]/.test(label));
  const pick = numeric[0] === "1" && numeric.includes("2") ? numeric : lettered[0] === "A" && lettered.includes("B") ? lettered : [];
  return pick.slice(0, 3);
}

function isAfter(a, b) {
  const left = Date.parse(a ?? "");
  const right = Date.parse(b ?? "");
  if (!Number.isFinite(left)) return false;
  return !Number.isFinite(right) || left > right;
}
