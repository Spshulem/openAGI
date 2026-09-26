// Pure classifier: one thread + its PR + infra -> one supervisor state.
// No I/O. Agent text is only matched against patterns here; nothing from it
// is copied into anything another agent will read.

import { DEFAULTS, ERROR_KINDS, SUPERVISOR_PREFIX, msSince } from "./contracts.js";

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

// Permission phrasing. With no out-of-scope topic, the answer is "yes".
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
  { topic: "production", pattern: /\b(?:release|deploy|ship|promote|cut)\w*\b[^.?!\n]{0,40}\bprod(?:uction)?\b|\bprod(?:uction)?\b[^.?!\n]{0,20}\b(?:release|deploy|push)\w*/i },
  { topic: "merge", pattern: /\b(?:merge|land)\s+(?:it|this|them|both|all|these|those|the (?:PRs?|stack|branch))\b|\bmerge\s+#?\d{3,}\b|\bmerge (?:to|into) main\b|\bmerge (?:as|when) (?:they|it|each)\b/i },
  { topic: "credentials", pattern: /\bpassword\b|\bcredentials?\b|\bAUP\b|\bOAuth\b|\bre-?auth\w*\b|\/login\b|\b2FA\b|\bAPI key\b|\byour click\b/i },
  { topic: "money", pattern: /\bcredits\b|\btop[- ]?up\b|\bupgrade (?:the |your )?plan\b|\bbilling\b|\bpurchase\b|\$\d/i },
  { topic: "delete", pattern: /\b(?:delete|remove|stop|kill|reap|shut ?down|tear ?down|clean ?up)\b[^.?!\n]{0,50}\b(?:other|others'?|another|their|someone else's)\b|\b(?:stop|delete|remove|tear ?down|shut ?down)\s+(?!(?:my|our|its) own\b)[^.?!\n]{0,40}\bpreviews?\b|\btake (?:it|this|that|them|these|those) down\b|\breclaim\b|\bprune\b|\bwipe\b/i }
]);

// The agent wants a decision, not permission.
const NEED_YOU_PATTERNS = [
  /\bneeds? you\b/i,
  /\bneeds? your\b/i,
  /\bneed (?:one of these |something |a decision )?from you\b/i,
  /\bwhat I'd like from you\b/i,
  /\byour call\b/i,
  /\bwhich (?:one|option|do you|would you)\b/i,
  /\bplease confirm\b/i,
  /\b(?:blocked|waiting) on you\b/i
];

// Reports that mention "you" but ask for nothing.
const NOT_ASK = /\bnothing\b[^.?!\n]{0,25}\b(?:from|for) you\b|\bnothing needs you\b|\bno action (?:needed|required)\b|\byou\W{0,3}nothing\b/i;
const CHOICE_WORDS = /\bwhich\b|\bpick\b|\bchoose\b|\boption\b|\bor\b/i;

const BB3_DOWN_PATTERNS = [
  /\b(?:buildbot ?3|bb3|100\.99\.3\.113)\b[^.?!\n]{0,60}\b(?:down|unreachable|not reachable|unavailable|frozen|rebooting|jammed)\b/i,
  /\bblocked on (?:buildbot ?3|bb3)\b/i
];

const STOPPED = new Set(["aborted", "stalled", "error"]);
const PR_DONE = new Set(["MERGED", "CLOSED"]);
const CI_RED = new Set(["FAILURE", "ERROR"]);
const CI_RUNNING = new Set(["PENDING", "EXPECTED"]);

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
  if (sameBranch && Number(local.ahead) > 0) blockers.push("unpushed commits");
  else if (sameBranch && local.head && pr.headOid && local.head !== pr.headOid) blockers.push("local head differs");

  const ci = pr.ci ?? {};
  if (CI_RED.has(ci.state) || ci.failing?.length) blockers.push(`CI red: ${ciNames(ci.failing)}`);
  else if (CI_RUNNING.has(ci.state)) blockers.push("CI running");
  else if (!ci.state) blockers.push("no CI on head");

  if (Number(pr.unresolvedThreads) > 0) blockers.push(`${pr.unresolvedThreads} open threads`);
  if (pr.mergeState === "DIRTY" || pr.mergeable === "CONFLICTING") blockers.push("merge conflicts");
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

  // Once the owner replied, the agent's last words are stale.
  const text = agentSpokeLast(thread) ? String(thread.lastAgentText ?? "") : "";

  const infraKind = infraBlockKind(thread, infra, text);
  if (infraKind) return result("infra-blocked", `blocked: ${infraKind}`, { infraKind });

  // A laptop verify often shows up as a background-task wait. It is the
  // violation, not a CI wait, so it must not be swallowed by waiting-ci.
  const localVerify = matchLocalVerify(thread, infra);
  const wait = localVerify ? null : waitSignal(thread, text, now);
  if (wait) return result("waiting-ci", wait.reason, { wait, infraKind: wait.taskKind ? "bb3" : null });
  if (localVerify) {
    return result("local-verify", "heavy verification on the laptop", {
      localVerify: { pid: localVerify.pid ?? null, ageSec: localVerify.ageSec ?? null }
    });
  }

  const ask = detectAsk(text);
  if (ask?.kind === "needs-human") return result("needs-human", `agent asks: ${ask.topic}`, { ask });
  if (ask?.kind === "in-scope") return result("asked-in-scope", "agent asked to do an in-scope step", { ask });

  if (pr && pr.state === "OPEN") {
    if (readiness.blockers.length) return result("pr-not-ready", readiness.blockers.join("; "), { blockers: readiness.blockers });
    return result("ready-needs-human", readiness.onlyHumanLeft ? "only a human approval left" : "ready; merge is the owner's");
  }
  if (pr && PR_DONE.has(pr.state)) return result("done", `PR ${pr.state.toLowerCase()}`);
  return result("idle-no-pr", thread.prRefs?.length ? "PR state unknown" : "no PR");
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
  // The risky step is often named just before the ask ("--admin merges now.
  // Which?") or in the options after it, so both count. Earlier recap does not.
  const region = askRegion(sentences, askIndexes);
  const hit = OUT_OF_SCOPE_PATTERNS.find(({ pattern }) => pattern.test(region));
  if (hit) return { kind: "needs-human", topic: hit.topic, options, text: askText };
  const isChoice = options.length >= 2 && CHOICE_WORDS.test(askText);
  if (isChoice && !recommended) return { kind: "needs-human", topic: "choice", options, text: askText };
  // The agent already picked one: taking "(recommended)" is in scope.
  if (isChoice) return { kind: "in-scope", topic: "in-scope", options, text: askText };
  if (NEED_YOU_PATTERNS.some((p) => p.test(askText))) return { kind: "needs-human", topic: "decision", options, text: askText };
  if (IN_SCOPE_ASK_PATTERNS.some((p) => p.test(askText))) return { kind: "in-scope", topic: "in-scope", options, text: askText };
  // A bare question with no permission phrasing: let the PR state decide.
  return null;
}

function isAsk(sentence) {
  if (NOT_ASK.test(sentence)) return false;
  return /\?\s*$/.test(sentence)
    || IN_SCOPE_ASK_PATTERNS.some((pattern) => pattern.test(sentence))
    || NEED_YOU_PATTERNS.some((pattern) => pattern.test(sentence));
}

function askRegion(sentences, askIndexes) {
  const picked = new Set();
  for (const index of askIndexes) {
    if (index > 0) picked.add(index - 1);
    picked.add(index);
    for (let next = index + 1; next < sentences.length && OPTION_LINE.test(sentences[next]); next += 1) picked.add(next);
  }
  return [...picked].sort((a, b) => a - b).map((index) => sentences[index]).join(" ");
}

const OPTION_LINE = /^(?:[1-9]|[A-C])[.)]\s/;

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
