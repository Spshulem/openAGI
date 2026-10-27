// Pure classifier: one thread + its PR + infra -> one supervisor state.
// No I/O. Agent text is only matched against patterns here; nothing from it
// is copied into anything another agent will read.

import { CARD_EXCLUSIONS, DEFAULTS, ERROR_KINDS, SUPERVISOR_PREFIX, clampText, liveCardItems, msSince, shortHash } from "./contracts.js";

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

// A tool named for the box ("bb3-watch", "bb3-doctor") is not the box.
const BB3_DOWN_PATTERNS = [
  /\b(?:buildbot ?3|bb3|100\.99\.3\.113)\b(?!-\w)[^.?!\n]{0,60}\b(?:down|unreachable|not reachable|unavailable|frozen|rebooting|jammed)\b/i,
  /\bblocked on (?:buildbot ?3|bb3)\b(?!-\w)/i
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
// What the supervisor is watching a thread for, as the owner reads it: one
// group, what it waits on, and since when (this scan's best guess; the
// supervisor keeps the earliest across scans while the group holds).
const WATCH_BY_STATE = Object.freeze({
  running: "working",
  "waiting-ci": "waiting",
  "needs-human": "you", "ready-needs-human": "you",
  "asked-in-scope": "push", "pr-not-ready": "push", stopped: "push", "local-verify": "push",
  "infra-blocked": "blocked",
  "idle-no-pr": "quiet", done: "quiet"
});
export const WATCH_GROUPS = Object.freeze(["you", "working", "waiting", "push", "blocked", "quiet"]);

function waitLabel(wait) {
  if (wait?.taskKind === "full") return "BuildBot3 full run";
  if (wait?.taskKind === "quick") return "bb-quick";
  if (wait?.source === "task") return "a background task";
  return "CI";
}

// askedAt: when an open question about this thread was put to the owner.
export function watchOf(thread, classified, { now = Date.now(), askedAt = null } = {}) {
  const state = classified?.state;
  if (!state || state === "excluded") return null;
  // Waiting on you only with a question the owner can see; one still held
  // for review leaves the thread with the supervisor for now.
  const own = ownWatchGroup(state);
  const group = askedAt ? "you" : own;
  const wait = classified.wait ?? null;
  const waitSince = Number.isFinite(wait?.ageMs) ? new Date(now - wait.ageMs).toISOString() : null;
  const busy = thread.agentStatus === "running" || thread.agentStatus === "waiting";
  const runningSince = busy ? (thread.meta?.turnStartedAt ?? null) : null;
  const waitingOn = group === "waiting" ? waitLabel(wait) : group === "you" ? "your answer" : null;
  const since = group === "you" ? askedAt
    : group === "waiting" ? waitSince
      : group === "working" ? runningSince
        : null;
  // otherwise: its group once the question closes (liveWatch reads it).
  const otherwise = group === "you" ? { group: own, waitingOn: own === "waiting" ? waitLabel(wait) : null } : undefined;
  return { group, since: since ?? thread.lastActivityAt ?? null, runningSince, waitSince, waitingOn, ...(otherwise ? { otherwise } : {}) };
}

// A state's group with no question open: one that asks the owner, unasked
// (held for review, or answered), is the supervisor's to push.
function ownWatchGroup(state) {
  const byState = WATCH_BY_STATE[state] ?? "quiet";
  return byState === "you" ? "push" : byState;
}

// A scan's watch brought up to now: "Waiting on you" only while a question
// the owner can see names the thread. askedAt: when the earliest such
// question was put to the owner (null: none open now). closedAt: when its
// last one closed; the group it falls back to starts there unless that
// group keeps its own clock (a wait, a turn).
export function liveWatch(watch, { state = null, askedAt = null, closedAt = null, muted = null } = {}) {
  if (!watch?.group) return watch ?? null;
  if (muted) return { ...watch, group: "quiet", waitingOn: null };
  if (askedAt) {
    const otherwise = watch.group === "you" ? watch.otherwise : { group: watch.group, waitingOn: watch.waitingOn ?? null };
    return { ...watch, group: "you", since: askedAt, waitingOn: "your answer", ...(otherwise ? { otherwise } : {}) };
  }
  if (watch.group !== "you") return watch;
  const { otherwise, ...rest } = watch;
  // A snapshot from before otherwise: the group its state maps to.
  const group = otherwise?.group ?? ownWatchGroup(state);
  const since = group === "waiting" ? watch.waitSince : group === "working" ? watch.runningSince : null;
  return { ...rest, group, since: since ?? closedAt ?? watch.since ?? null, waitingOn: otherwise?.waitingOn ?? null };
}

export function threadHealth(state, error = null) {
  if (state === "excluded" || !Object.hasOwn(HEALTH_BY_STATE, state)) return "gray";
  if (state !== "running" && error != null) return "red";
  return HEALTH_BY_STATE[state];
}

// A Claude transcript and a Conductor session are the same agent when the
// Conductor row points at the transcript's session id. Conductor owns status.
// Antigravity conversations and Copilot sessions stand alone.
export function mergeThreads({ codex = [], claude = [], conductor = [], antigravity = [], copilot = [] } = {}) {
  const merged = conductor.filter(Boolean).map((thread) => ({ ...thread }));
  const byClaudeId = new Map();
  for (const thread of merged) if (thread.claudeSessionId) byClaudeId.set(thread.claudeSessionId, thread);
  const loose = [];
  for (const thread of claude.filter(Boolean)) {
    const target = byClaudeId.get(thread.claudeSessionId ?? thread.id);
    if (target) foldClaudeInto(target, thread);
    else loose.push({ ...thread });
  }
  return [...codex.filter(Boolean).map((thread) => ({ ...thread })), ...merged, ...loose, ...antigravity.filter(Boolean).map((thread) => ({ ...thread })), ...copilot.filter(Boolean).map((thread) => ({ ...thread }))];
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
  // A Conductor tail that kept only a synthetic limit notice has an excerpt
  // but no real report; the transcript still holds the earlier reply.
  if (!target.lastAgentFull && claude.lastAgentFull) {
    target.lastAgentFull = claude.lastAgentFull;
    target.lastAgentFullAt = claude.lastAgentFullAt ?? null;
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
  const gates = Array.isArray(pr.gates) ? pr.gates : [];
  if (gates.length) {
    // The repo's required checks are the gate: other checks green or
    // skipped prove nothing, but a red or running one still blocks.
    for (const gate of gates) {
      const blocker = gateBlocker(gate);
      if (blocker) blockers.push(blocker);
    }
    const gateNames = new Set(gates.map((gate) => gate.name));
    const failing = (ci.failing ?? []).filter((name) => !gateNames.has(name));
    const pending = (ci.pending ?? []).filter((name) => !gateNames.has(name));
    if (failing.length || (CI_RED.has(ci.state) && !ci.failing?.length)) blockers.push(`CI red: ${ciNames(failing)}`);
    else if (pending.length || (CI_RUNNING.has(ci.state) && !ci.pending?.length)) blockers.push("CI running");
  } else if (CI_RED.has(ci.state) || ci.failing?.length) blockers.push(`CI red: ${ciNames(ci.failing)}`);
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

// "BuildBot3 full run missing" / "... unread" / "... failed" / "... pending" / "... skipped".
function gateBlocker(gate) {
  const label = gate.label || gate.name;
  if (gate.state === "SUCCESS") return null;
  // A lookup that failed to load is unknown, not proof it never ran.
  if (!gate.state) return gate.unread ? `${label} unread` : `${label} missing`;
  if (gate.state === "FAILURE") return `${label} failed`;
  return `${label} ${String(gate.state).toLowerCase()}`;
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
  // An open question card waits on the owner, and a merge does not answer
  // it. Automation and no-repo threads ask the owner too; never the
  // supervisor's own or an archived one. A Conductor card blocks its turn,
  // so nothing else moves until it is answered.
  const card = cardAsk(thread, excluded, config, now);
  if (card && card.card.app !== "codex") return result("needs-human", "agent asks: question card", { ask: card });
  const state = classifyRest(thread, { pr, infra, now, config, limits, readiness, result, excluded });
  if (!card) return state;
  // A Codex card does not block the turn ("continuing meanwhile"): a limit
  // reset, a stop, an outage or the PR is handled as ever, and the card is
  // asked beside it. A thread with nothing else to do asks the card alone.
  if (CARD_ALONE.has(state.state) && !state.idle?.promised) return result("needs-human", "agent asks: question card", { ask: card });
  return { ...state, card };
}

// States a Codex card replaces: nothing else would happen on them.
const CARD_ALONE = new Set(["running", "excluded", "idle-no-pr", "done"]);

function classifyRest(thread, { pr, infra, now, config, limits, readiness, result, excluded }) {
  if (excluded) return result("excluded", excluded);
  if (isRunning(thread, now, limits)) return result("running", "turn in progress");
  // A live session on a permission prompt or dialog waits on the owner's
  // click. A nudge cannot clear it.
  if (thread.meta?.blockedOnOwner === true) return result("needs-human", "blocked on a permission prompt", { ask: { ...BLOCKED_ON_OWNER_ASK, options: [...BLOCKED_ON_OWNER_ASK.options] } });
  // Codex request_user_input: the real question is structured, not in the text.
  // A card of acknowledgements ("Okay") only asks nothing.
  const cardOpen = thread.meta?.pendingCard?.items?.length > 0;
  if (thread.meta?.pendingQuestion && !cardOpen && !prSettledAfter(pr, Date.parse(thread.meta.pendingQuestion.at ?? ""), structuredAskAt(thread))) {
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
  const settled = prSettledAfter(pr, Date.parse(thread.lastAgentAt ?? ""));
  // The whole report, not the tail: its "Blocked on:" list is often above
  // the last 600 characters.
  const full = thread.lastAgentFull || text;
  // The whole report has its own time: a later synthetic notice moves only lastAgentAt.
  const fullSettled = thread.lastAgentFull ? prSettledAfter(pr, Date.parse(thread.lastAgentFullAt ?? thread.lastAgentAt ?? "")) : settled;
  const section = text && !fullSettled ? blockedOnSection(full) : null;
  // "Blocked on: your merge decision" on an open PR is the ready / not-ready
  // flow's question (merge it, or get it ready), not a call of its own.
  const blocked = section && pr?.state === "OPEN" ? withoutMergeCalls(section) : section;
  const listed = blocked?.mergeCalls.length ? dropLines(text, blocked.lines) : text;
  const askText = pr?.state === "OPEN" ? dropInlineMergeCalls(listed) : listed;
  // "CI is pending. Blocked on your approval.": an explicit owner ask beats
  // a wait the agent only wrote down.
  if (wait?.source === "text" && (detectAsk(askText)?.kind === "needs-human" || blocked?.owner.length) && !settled) wait = null;
  if (wait) return result("waiting-ci", wait.reason, { wait, infraKind: wait.taskKind ? "bb3" : null });
  if (localVerify) {
    return result("local-verify", "heavy verification on the laptop", {
      localVerify: { pid: localVerify.pid ?? null, ageSec: localVerify.ageSec ?? null }
    });
  }

  const ask = settled ? null : detectAsk(askText);
  // "Blocked on: your decision": the owner's, whatever else the list holds.
  // Its own answers beat a plain "your call" read from the same words; a
  // named topic (a merge, prod, creds) keeps the ask it came with.
  if (blocked?.owner.length && (ask?.kind !== "needs-human" || ask.topic === "decision")) {
    return result("needs-human", "agent asks: blocked on the owner", { ask: blockedAsk(blocked, full) });
  }
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

function cardAsk(thread, excluded, config, now) {
  const card = thread.meta?.pendingCard;
  if (!liveCardItems(card, now).length) return null;
  if (excluded && !CARD_EXCLUSIONS.has(excluded)) return null;
  const self = config?.selfSessionIds ?? [];
  if (thread.archived || self.includes(thread.id) || (thread.claudeSessionId && self.includes(thread.claudeSessionId))) return null;
  return { topic: "decision", card };
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
// abort, or the turn was one the supervisor started (ownerStoppedNudge).
export function deliberateStop(thread) {
  if (thread.agentStatus !== "aborted") return false;
  if (ownerStoppedNudge(thread)) return true;
  if (String(thread.lastUserText ?? "").startsWith(SUPERVISOR_PREFIX)) return false;
  const userAt = Date.parse(thread.lastUserAt ?? "");
  // Later metadata writes bump lastActivityAt; the source's abort time does not move.
  const abortAt = Date.parse(thread.meta?.abortedAt ?? thread.lastActivityAt ?? "");
  if (!Number.isFinite(userAt) || !Number.isFinite(abortAt)) return false;
  const gap = abortAt - userAt;
  return gap >= 0 && gap <= DELIBERATE_STOP_MS;
}

// Only the owner aborts a turn: Conductor writes "aborted by user", Claude and
// Codex "interrupted". An app restart writes no abort; that turn is stalled.
const OWNER_ABORT = /^(aborted by user|interrupted)$/i;

// The owner stopped a turn the supervisor started, at any point in it: a no
// to that nudge. Nothing goes to the thread until a new turn starts. Readers
// keep supervisor messages out of lastUserText and stamp meta.lastSupervisorAt
// instead, so the stopped turn is the supervisor's when that is the newest
// message; an older reader may still pass the message itself through.
export function ownerStoppedNudge(thread) {
  if (thread.agentStatus !== "aborted") return false;
  if (!OWNER_ABORT.test(String(thread.meta?.abortReason ?? "").trim())) return false;
  if (String(thread.lastUserText ?? "").startsWith(SUPERVISOR_PREFIX)) return true;
  const supervisorAt = Date.parse(thread.meta?.lastSupervisorAt ?? "");
  if (!Number.isFinite(supervisorAt)) return false;
  return !(Date.parse(thread.lastUserAt ?? "") > supervisorAt);
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

function detectAsk(raw) {
  if (!raw) return null;
  // "**Blocked on:** your call" reads as "Blocked on: your call".
  const text = stripMarkdown(raw);
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

function stripMarkdown(text) {
  return String(text ?? "").replace(/\*\*|__|`/g, "");
}

// A "Blocked on:" item only the owner can clear: their decision, call,
// approval, merge, review, pick or go-ahead. "Approval from Adam" names
// someone else, so only an approval from the owner counts.
const OWNER_BLOCKER = /\b(?:your|you|owner)\b[^.\n]{0,40}\b(?:decision|call|approv\w*|merge|review|sign-?off|pick|choice|go-?ahead)\b|\bmerge decision\b|\b(?:approval|review|sign-?off|decision|go-?ahead) from (?:you|the owner|spencer)\b|\bsudo\b/i;
// Items GitHub or time clears: checks running, a review not in yet.
const PASSIVE_BLOCKER = /\b(?:running|pending|queued|in progress|not (?:yet )?(?:reviewed|started|finished)|has(?:n't| not) reviewed|waiting (?:on|for))\b|^(?:CI|checks?|tests?|builds?)\W*$/i;
const NO_BLOCKER = /^(?:nothing|none|n\/a|nope|no(?:thing)? (?:blockers?|else))\b/i;
const BLOCKED_HEADER = /^[\s>#*_\-•]*blocked on\b[\s*_]*:?[\s*_]*(.*)$/i;
const BULLET = /^(\s*)(?:[-*•+]|\d+[.)]|[a-c][.)])\s+(.*)$/i;

// The agent's "Blocked on:" section: the header (any markdown) with what
// follows it on its line, then its bullets up to a blank line or the next
// header. Each item is tagged owner, passive or other; sub-bullets under an
// item are its options. "Blocked on: nothing" holds no items. The last
// header wins: an earlier one is often a quoted, older status.
export function blockedOnSection(text) {
  const lines = plainLines(text);
  const start = lines.findLastIndex((line) => BLOCKED_HEADER.test(line));
  if (start < 0) return null;
  const items = [];
  const inline = BLOCKED_HEADER.exec(lines[start])[1].trim();
  if (inline) items.push({ text: inline, options: [] });
  let indent = null;
  let end = start + 1;
  for (; end < lines.length; end += 1) {
    const line = lines[end];
    if (!line.trim()) {
      // A blank line between the header and its first bullet is allowed.
      if (items.length || indent !== null) break;
      continue;
    }
    const bullet = BULLET.exec(line);
    if (!bullet) {
      // An indented line goes on with the item above it; anything else is the next block.
      if (/^\s{2,}\S/.test(line) && items.length) { items.at(-1).text += ` ${line.trim()}`; continue; }
      break;
    }
    const depth = bullet[1].replace(/\t/g, "  ").length;
    if (indent === null) indent = depth;
    if (depth > indent && items.length) items.at(-1).options.push(bullet[2].trim());
    else items.push({ text: bullet[2].trim(), options: [] });
  }
  const tagged = items.filter((item) => item.text && !NO_BLOCKER.test(item.text))
    .map((item) => ({ ...item, tag: OWNER_BLOCKER.test(item.text) ? "owner" : PASSIVE_BLOCKER.test(item.text) ? "passive" : "other" }));
  const of = (tag) => tagged.filter((item) => item.tag === tag);
  return {
    items: tagged, owner: of("owner"), passive: of("passive"), other: of("other"), mergeCalls: [], start,
    // The section's own lines, for reading the rest of the message without it.
    lines: lines.slice(start, end).map((line) => line.trim()).filter(Boolean)
  };
}

function plainLines(text) {
  return stripMarkdown(text).replace(/[\u2018\u2019]/g, "'").split("\n");
}

// "Your merge decision", "your go to merge": only the merge itself.
const MERGE_CALL = /^(?:on\s+)?(?:your|the owner'?s?|owner)\s+(?:merge(?:\s+(?:decision|call|approval|go-?ahead|click|ok))?|(?:go(?:-?ahead)?|ok(?:ay)?|approval|decision|call|sign-?off|click)\s+(?:to|on|for)\s+(?:the\s+)?merg\w*)\b(.*)$/i;
const MORE_THAN_MERGE = /\b(?:and|also|plus|prod\w*|releas\w*|deploy\w*|sudo|decision|call|approv\w*|sign-?off|review)\b/i;

function isMergeCall(text) {
  const match = MERGE_CALL.exec(text);
  return Boolean(match) && !MORE_THAN_MERGE.test(match[1]);
}

function withoutMergeCalls(section) {
  const mergeCalls = section.owner.filter((item) => isMergeCall(item.text));
  if (!mergeCalls.length) return section;
  return { ...section, owner: section.owner.filter((item) => !mergeCalls.includes(item)), mergeCalls };
}

// "Pushed. Blocked on: your merge decision." written inline, dropped.
function dropInlineMergeCalls(text) {
  return stripMarkdown(text).replace(/\bblocked on\W{0,3}([^.;\n]*)[.;]?/gi, (all, item) => (isMergeCall(item.trim()) ? " " : all));
}

// The text (whitespace collapsed, as the tail is) without these lines.
function dropLines(text, lines) {
  let out = stripMarkdown(text).replace(/[\u2018\u2019]/g, "'").replace(/\s+/g, " ");
  for (const line of lines) {
    const plain = line.replace(/\s+/g, " ").trim();
    if (plain) out = out.split(plain).join(" ");
  }
  return out;
}

// Sub-bullets are answers only when they read as alternatives: two or
// three short ones, each a step ("Merge now", "Keep it"), an option
// ("Option A", "B)") or an "or". Details ("P1: migration drops the audit
// table") are not, and a tap would be relayed to the agent as a pick.
const CHOICE_LEAD = /^(?:option\s+\w+\b|[a-c][.):]\s|or\b|(?:merge|ship|keep|drop|fix|skip|wait|use|revert|split|defer|land|close|pin|let|make|add|remove|go|hold|accept|reject|approve|run|retry|rebase|leave|allow|deny|delete|stop|continue|proceed|cancel|switch|move|rename|push|pick|take|do|don't|ignore)\b)/i;

function alternatives(options) {
  const labels = [...new Set(options.map((option) => String(option).trim()).filter(Boolean))];
  if (labels.length < 2 || labels.length > 3) return [];
  return labels.every((label) => label.length <= 40 && CHOICE_LEAD.test(label)) ? labels : [];
}

// "Both need your call." over a list elsewhere in the report.
const CALL_HEADER = /\byour (?:call|decision|pick|choice)\b|\bneeds? (?:you|your)\b|\bfor you to (?:decide|pick)\b/i;

// The bulleted blocks outside the Blocked-on section whose lead line asks
// for the owner's call: { at, bullets }.
function callSections(text, blockedStart) {
  const lines = plainLines(text);
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (i === blockedStart || !CALL_HEADER.test(lines[i]) || BULLET.test(lines[i])) continue;
    const bullets = [];
    let indent = null;
    for (let j = i + 1; j < lines.length; j += 1) {
      const bullet = BULLET.exec(lines[j]);
      if (!bullet) {
        if (!lines[j].trim() && !bullets.length) continue;
        break;
      }
      const depth = bullet[1].replace(/\t/g, "  ").length;
      if (indent === null) indent = depth;
      if (depth <= indent) bullets.push(bullet[2].trim());
    }
    if (bullets.length) out.push({ at: i, bullets });
  }
  return out;
}

// The block an owner item points at: the nearest one in the direction it
// names ("the two P1s above"), else the only one in the report.
function pointedSection(owner, text, blockedStart) {
  const sections = callSections(text, blockedStart);
  const words = owner.map((item) => item.text).join(" ");
  if (/\babove\b/i.test(words)) return sections.filter((section) => section.at < blockedStart).at(-1) ?? null;
  if (/\bbelow\b/i.test(words)) return sections.find((section) => section.at > blockedStart) ?? null;
  return sections.length === 1 ? sections[0] : null;
}

// The owner items as one question. Answers come from the agent's own
// sub-bullets (one item), or the block it points at, only when they are
// alternatives; that block is shown as context either way. "open thread"
// always stays, and never a "later" that would be relayed as an answer.
function blockedAsk(blocked, full = "") {
  const owner = blocked.owner;
  const pointed = pointedSection(owner, full, blocked.start);
  const own = owner.length === 1 ? alternatives(owner[0].options) : [];
  const labels = (own.length ? own : alternatives(pointed?.bullets ?? [])).map((option) => clampText(option, 40));
  const text = owner.map((item) => item.text.replace(/[.;,\s]+$/, "")).join(" / ");
  const context = pointed ? pointed.bullets.slice(0, 3).map((bullet) => clampText(bullet, 90)).join(" | ") : "";
  // The choices are part of the ask: the same generic blocker over other
  // P1s or other sub-bullets is a new decision, not the one answered.
  const choices = [...owner.flatMap((item) => item.options ?? []), ...(pointed?.bullets ?? [])].map((choice) => String(choice).replace(/\s+/g, " ").trim()).filter(Boolean);
  const key = shortHash(choices.length ? [text, ...choices].join("\n") : text);
  return { topic: "decision", blocked: true, text, context, options: [...labels, "open thread"], key };
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
