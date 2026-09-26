// Fleet supervisor tick: read every source, classify each coding thread,
// decide with policy + playbooks, then act according to the mode.
//   observe  record what it would do ("planned"), send nothing
//   propose  record "proposed" actions the owner can send with one tap
//   auto     deliver templated nudges/escalations, within the limits
// Needs-you questions are raised in every mode. The constructor has no side
// effects; hosted-interface calls start() on listen and stop() on close.

import path from "node:path";
import { resolveDataDir } from "../data-dir.js";
import { MODES, clampTail, clampText, parsePrRef, resolveFleetConfig, runCommand } from "./contracts.js";
import { classifyThread, mergeThreads } from "./classify.js";
import { createExecutor } from "./executor.js";
import { createNotifier } from "./notify.js";
import { BUNDLED_PLAYBOOKS_DIR, loadPlaybooks, userPlaybooksDir } from "./playbooks.js";
import { chooseRoute, decideInfra, decideThread, dedupeDecisions, infraHealth } from "./policy.js";
import { FleetStore } from "./store.js";
import * as buildbot3 from "./sources/buildbot3.js";
import * as claude from "./sources/claude.js";
import * as codex from "./sources/codex.js";
import * as conductor from "./sources/conductor.js";
import * as github from "./sources/github.js";
import * as processes from "./sources/processes.js";

const MIN = 60_000;
const SOURCE_TIMEOUT_MS = 90_000;
const GIT_CONCURRENCY = 8;
const MAX_BRANCH_LOOKUPS = 8;
const BRANCH_LOOKUP_TTL_MS = 30 * MIN;
const START_DELAY_MS = 5_000;
const MUTE_MS = 24 * 60 * MIN;
const SENDING = new Set(["nudge", "escalate-manager"]);
const OPEN_ACTION = new Set(["planned", "proposed"]);
const TRUNK_BRANCHES = new Set(["main", "master", "HEAD", "develop", "staging"]);
const INFRA_KINDS = ["bb3", "lb"];
const BLOCKED_STATES = new Set(["infra-blocked", "waiting-ci"]);
// A manager escalation shares one cooldown per incident, whichever thread
// or infra check raised it (same keys decideInfra uses).
const INCIDENT_KEYS = Object.freeze({ "manager-bb3": "infra:bb3", "manager-lb": "infra:lb" });
// A delivered or failed escalation starts the cooldown; a failed route must
// not be retried every tick (same rule as the nudge ledger).
const ESCALATION_STATUSES = new Set(["sent", "failed"]);
// The snapshot row shows the decision that acts when a thread got two.
const DECISION_RANK = Object.freeze({ nudge: 3, "escalate-manager": 3, "ask-user": 2, wait: 1, none: 0 });

function withTimeout(promise, ms, name) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${name} timed out after ${Math.round(ms / 1000)}s`)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      try { results[index] = await fn(items[index], index); } catch { results[index] = null; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function emptyBb3() {
  return { reachable: null, checkedAt: null, gate: { state: null, reason: null, since: null }, fullQueue: null, quickQueue: null, load: null, runs: [], timersDead: [], error: null };
}

// Limit and unreachable questions come in bursts (one account cap hits every
// thread at once), so they collapse into one line each. Identical titles
// (the same BuildBot3 problem seen by a thread and by infra) collapse too.
const GROUPED_KINDS = Object.freeze({
  limit: { dedupeKey: "limit:group", options: ["wait", "added"], match: ["wait", "added"], title: (n, reset) => `${n} threads capped. Reset ${reset}. Add acct?`, body: (labels) => `Waiting on reset: ${labels}.` },
  open: { dedupeKey: "open:group", options: ["opened", "skip"], title: (n) => `${n} stuck, can't reach. Open them?`, body: (labels) => `No live session to message: ${labels}.` }
});

function threadLabel(thread) {
  if (!thread) return "?";
  const pr = /#(\d+)$/.exec(thread.prRefs?.[0] ?? "")?.[1];
  const name = thread.workspace ?? clampText(String(thread.title ?? "").replace(/[<>]/g, ""), 24);
  return pr ? `${name} #${pr}` : name;
}

function formatReset(iso) {
  const at = Date.parse(iso ?? "");
  if (!Number.isFinite(at)) return "soon";
  return new Date(at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function groupQuestions(asks, byKey) {
  const out = [];
  const titles = new Set();
  const groups = { limit: [], open: [] };
  const single = (decision) => ({
    ...decision.question,
    threadKey: decision.threadKey.startsWith("infra:") ? null : decision.threadKey,
    prRef: byKey.get(decision.threadKey)?.prRefs?.[0] ?? null,
    playbook: decision.playbook
  });
  for (const decision of asks) {
    const kind = decision.question.kind;
    // Only questions with the group's exact choices merge; a model-limit
    // question ("switched" / "wait") keeps its own wording and buttons.
    const match = GROUPED_KINDS[kind]?.match;
    const sameChoices = !match || JSON.stringify(decision.question.options) === JSON.stringify(match);
    if (groups[kind] && sameChoices) { groups[kind].push(decision); continue; }
    const titleKey = kind === "infra" && decision.question.options?.includes("retry") ? `${decision.threadKey}:${decision.question.title}` : decision.question.title;
    if (titles.has(titleKey)) continue;
    titles.add(titleKey);
    out.push(single(decision));
  }
  for (const [kind, list] of Object.entries(groups)) {
    if (list.length === 1) out.push(single(list[0]));
    if (list.length < 2) continue;
    const spec = GROUPED_KINDS[kind];
    const threads = list.map((decision) => byKey.get(decision.threadKey)).filter(Boolean);
    const resets = threads.map((thread) => thread.error?.resetAt).filter(Boolean).sort();
    out.push({
      kind, dedupeKey: spec.dedupeKey, options: spec.options, playbook: null, threadKey: null, prRef: null,
      threadKeys: list.map((decision) => decision.threadKey),
      title: spec.title(list.length, formatReset(resets[0])),
      body: spec.body(threads.map(threadLabel).join(", "))
    });
  }
  return out;
}

function incidentKey(action) {
  const key = String(action?.threadKey ?? "");
  if (key.startsWith("infra:")) return key;
  return action?.kind === "escalate-manager" ? (INCIDENT_KEYS[action.playbook] ?? null) : null;
}

function effectiveDecisions(decisions) {
  const out = new Map();
  for (const decision of decisions) {
    const current = out.get(decision.threadKey);
    if (!current || (DECISION_RANK[decision.action] ?? 0) >= (DECISION_RANK[current.action] ?? 0)) out.set(decision.threadKey, decision);
  }
  return out;
}

function ownerDelivery(answer) {
  // Options are fixed strings chosen by policy, never agent text.
  return `Owner answer: ${answer}. Continue with that.`;
}

// "retry" on a logged-out / disk-full question means the owner fixed it.
const RETRY_DELIVERY = "Owner fixed the blocker (login or disk). Retry: continue where you stopped.";
// "added" on an account-cap question means new capacity: resume now.
const ADDED_DELIVERY = "Owner added account capacity. Continue where you stopped.";

export class FleetSupervisor {
  // forceMode pins the mode over the owner's saved choice (the dry-run CLI).
  constructor({ dataDir, runtime = null, config = null, deps = {}, skip = {}, forceMode = null } = {}) {
    this.dataDirOption = dataDir ?? null;
    this.forceMode = MODES.includes(forceMode) ? forceMode : null;
    this.runtime = runtime;
    this.deps = deps ?? {};
    this.skip = { bb3: false, github: false, ...skip };
    this.config = config?.paths && config?.limits ? config : resolveFleetConfig(process.env, config ?? {});
    this._store = null;
    this._executor = null;
    this._notifier = null;
    this._playbooks = null;
    this.timer = null;
    this.kickTimer = null;
    this.running = null;
    this.lastTickAt = null;
    this.lastError = null;
    this.lastThreads = new Map();
    this.branchLookups = new Map();
    this.answering = new Set();
  }

  now() {
    return typeof this.deps.now === "function" ? this.deps.now() : Date.now();
  }

  get dataDir() {
    return this.dataDirOption ?? resolveDataDir();
  }

  get store() {
    if (!this._store) {
      this._store = new FleetStore({
        dir: path.join(this.dataDir, "fleet"), defaultMode: this.config.mode, limits: this.config.limits, now: () => this.now()
      });
    }
    return this._store;
  }

  get mode() {
    return this.forceMode ?? this.store.mode ?? this.config.mode;
  }

  get executor() {
    if (this.deps.executor) return this.deps.executor;
    this._executor ??= createExecutor({ config: this.config, run: this.deps.run, store: this.store });
    return this._executor;
  }

  get notifier() {
    if (this.deps.notifier) return this.deps.notifier;
    this._notifier ??= createNotifier({ config: this.config, store: this.store, runtime: this.runtime, fetchImpl: this.deps.fetchImpl });
    return this._notifier;
  }

  playbooks() {
    // Reloaded each tick so an edited playbook file applies without a restart.
    try {
      this._playbooks = loadPlaybooks({ bundledDir: BUNDLED_PLAYBOOKS_DIR, userDir: userPlaybooksDir(this.dataDir) });
    } catch {
      this._playbooks ??= new Map();
    }
    return this._playbooks;
  }

  start() {
    if (!this.config.enabled || this.timer) return false;
    const fire = (reason) => this.tick({ reason }).catch(() => { /* recorded in lastError */ });
    this.timer = setInterval(() => fire("interval"), this.config.tickMs);
    this.timer.unref?.();
    this.kickTimer = setTimeout(() => fire("start"), START_DELAY_MS);
    this.kickTimer.unref?.();
    return true;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.kickTimer) clearTimeout(this.kickTimer);
    this.timer = null;
    this.kickTimer = null;
  }

  tick({ reason = "manual" } = {}) {
    if (this.running) return this.running;
    this.running = this._tick(reason)
      .then((snapshot) => { this.lastError = null; return snapshot; })
      .catch((error) => {
        this.lastError = clampText(error?.message ?? String(error), 300);
        throw error;
      })
      .finally(() => { this.running = null; });
    return this.running;
  }

  getState() {
    const store = this.store;
    return {
      mode: this.mode,
      enabled: Boolean(this.config.enabled),
      running: Boolean(this.running),
      lastTickAt: this.lastTickAt ?? store.snapshot?.at ?? null,
      lastError: this.lastError,
      snapshot: store.snapshot,
      questions: store.openQuestions(),
      actions: store.actions(50),
      settings: {
        tickMinutes: Math.round(this.config.tickMs / MIN),
        lookbackHours: this.config.lookbackHours,
        push: this.config.push ?? null,
        relayModel: this.config.relayModel,
        managerRef: this.config.managerRef
      }
    };
  }

  setMode(mode) {
    if (!MODES.includes(mode)) return null;
    if (mode !== "propose") {
      for (const action of this.store.actions(this.config.limits.maxActionsKept)) {
        if (action.status === "proposed") this.store.updateAction(action.id, { status: "stale", detail: "mode changed" });
      }
    }
    return this.store.setMode(mode);
  }

  dismissQuestion(id) {
    const question = this.store.question(id);
    if (!question || question.status !== "open") return null;
    this.applyOverride(question, "dismiss");
    this.resolveOutreach(question, "dismiss", "dismissed");
    return this.store.dismissQuestion(id);
  }

  // The outreach copy (Mac overlay, G2) must not keep asking after the
  // question closed on /fleet or by itself.
  resolveOutreach(question, decision, status) {
    if (!question?.outreachId) return;
    try { this.runtime?.outreach?.resolve?.(question.outreachId, decision, { status }); } catch { /* best-effort */ }
  }

  async resumeAll(question, message) {
    const keys = question.threadKeys ?? (question.threadKey ? [question.threadKey] : []);
    let sent = 0;
    let blocked = 0;
    for (const key of keys) {
      if (question.deliveredThreadKeys?.includes(key)) { sent += 1; continue; }
      const thread = this.lastThreads.get(key);
      const route = thread ? chooseRoute(thread, this.mode === "auto" ? "auto" : "propose") : null;
      if (!thread || !route) { blocked += 1; continue; }
      const delivery = await this.executor.deliver({ thread, message, route, playbook: "owner-answer" });
      this.store.recordNudge(thread.key, { playbook: "owner-answer", route, status: delivery.status === "sent" ? "owner-answer" : delivery.status });
      if (delivery.status === "sent") {
        sent += 1;
        this.store.markQuestionDelivered(question.id, key);
      }
      else blocked += 1;
    }
    return { status: blocked || !sent ? "blocked" : "sent", route: null, detail: `${sent} resumed, ${blocked} not reachable; open the thread and retry if needed` };
  }

  async answerQuestion(id, answer) {
    if (this.answering.has(id)) return null;
    const question = this.store.question(id);
    if (!question || question.status !== "open") return null;
    if (answer === "dismiss") return { question: this.dismissQuestion(id), delivery: null };
    // Every surface (page, outreach, future callers) gets the same check:
    // only the fixed options policy offered can reach an agent.
    if (!(question.options ?? []).includes(answer)) return null;
    this.answering.add(id);
    try {
      let delivery = null;
      if (question.kind === "limit" && answer === "added") {
        delivery = await this.resumeAll(question, ADDED_DELIVERY);
      }
      // An owner answer to the agent's own question, or "retry" after the owner
      // fixed a login/disk blocker, is an explicit instruction: every mode.
      const retry = question.kind === "infra" && answer === "retry";
      if ((question.kind === "agent-ask" || retry) && question.threadKey && answer !== "open thread") {
        const thread = this.lastThreads.get(question.threadKey);
        const route = thread ? chooseRoute(thread, this.mode === "auto" ? "auto" : "propose") : null;
        if (!thread || !route) {
          delivery = { status: "blocked", route: null, detail: thread ? "no live route: open the thread to answer" : "thread not seen since restart: scan first" };
        } else {
          const message = retry ? RETRY_DELIVERY : ownerDelivery(answer);
          delivery = await this.executor.deliver({ thread, message, route, playbook: "owner-answer" });
          // Starts the cooldown but does not spend the no-progress nudge budget.
          this.store.recordNudge(thread.key, { playbook: "owner-answer", route, status: delivery.status === "sent" ? "owner-answer" : delivery.status });
        }
      }
      // A failed or unreachable delivery remains actionable on every surface.
      if (delivery && delivery.status !== "sent") return { question: this.store.question(id), delivery };
      if (answer === "open thread") return { question, delivery: { status: "blocked", route: null, detail: "Answer in the original thread, then scan again." } };
      const answered = this.store.answerQuestion(id, answer);
      this.resolveOutreach(question, answer, "acted");
      this.applyOverride(question, answer);
      return { question: answered, delivery };
    } finally {
      this.answering.delete(id);
    }
  }

  applyOverride(question, answer) {
    const keys = question.threadKeys ?? (question.threadKey ? [question.threadKey] : []);
    for (const key of keys) {
      if (question.kind === "stuck" && answer === "keep going") this.store.resetAttempts(key);
      if ((question.kind === "stuck" && answer === "stop") || (question.kind === "open" && answer === "skip")) {
        this.store.mute(key, this.now() + MUTE_MS);
      }
    }
  }

  async sendProposed(actionId) {
    if (this.mode !== "propose") return null;
    const action = this.store.action(actionId);
    if (!action || action.status !== "proposed") return null;
    const thread = this.lastThreads.get(action.targetKey);
    if (!thread) {
      const updated = this.store.updateAction(actionId, { status: "blocked", detail: "thread not seen in the last scan" });
      return { action: updated, delivery: { status: "blocked", route: action.route, detail: updated?.detail ?? null } };
    }
    const delivery = await this.executor.deliver({ thread, message: action.message, route: action.route, playbook: action.playbook, actionId });
    this.recordSend(action, delivery);
    return { action: this.store.action(actionId), delivery };
  }

  recordSend(action, delivery) {
    const at = new Date(this.now()).toISOString();
    const incident = incidentKey(action);
    if (incident && ESCALATION_STATUSES.has(delivery.status)) this.store.recordEscalation(incident, at);
    if (String(action.threadKey ?? "").startsWith("infra:")) return;
    this.store.recordNudge(action.threadKey, { at, playbook: action.playbook, route: action.route, status: delivery.status }, action.progressMark);
  }

  async _tick(reason) {
    const started = this.now();
    const mode = this.mode;
    const config = { ...this.config, mode };
    const run = this.deps.run ?? runCommand;
    const d = this.deps;
    const sourceErrors = {};
    const previous = this.store.snapshot;
    const guard = (name, fn, fallback) => withTimeout(Promise.resolve().then(fn), SOURCE_TIMEOUT_MS, name)
      .catch((error) => {
        sourceErrors[name] = clampText(error?.message ?? String(error), 200);
        return fallback;
      });

    let peers = new Map();
    try { peers = (d.readLivePeers ?? claude.readLivePeers)(config) ?? new Map(); } catch (error) { sourceErrors.peers = clampText(error?.message, 200); }

    const [codexThreads, claudeThreads, conductorThreads, lbErrors, localVerify, bb3, lb] = await Promise.all([
      guard("codex", () => (d.listCodexThreads ?? codex.listCodexThreads)(config, { now: started, run }), []),
      guard("claude", () => (d.listClaudeThreads ?? claude.listClaudeThreads)(config, { now: started, peers }), []),
      guard("conductor", () => (d.listConductorThreads ?? conductor.listConductorThreads)(config, { now: started, peers }), []),
      guard("lbErrors", () => (d.readCodexLbErrors ?? codex.readCodexLbErrors)(config, { now: started }), []),
      guard("processes", () => (d.findLocalHeavyVerification ?? processes.findLocalHeavyVerification)(config, { run }), []),
      this.skip.bb3 ? null : guard("bb3", () => (d.probeBuildBot3 ?? buildbot3.probeBuildBot3)(config, { run, now: started, previous: previous?.infra?.bb3 ?? null }), null),
      guard("lb", () => (d.checkLb ?? buildbot3.checkLb)(config, { fetchImpl: d.fetchImpl, now: started }), null)
    ]);

    const threads = mergeThreads({ codex: codexThreads ?? [], claude: claudeThreads ?? [], conductor: conductorThreads ?? [] });
    const manager = (d.findManagerSession ?? conductor.findManagerSession)(config, threads) ?? null;
    const inScope = threads
      .filter((thread) => !thread.excluded)
      .sort((a, b) => String(b.lastActivityAt ?? "").localeCompare(String(a.lastActivityAt ?? "")))
      .slice(0, config.limits.maxThreads);

    const localGit = await this.readGit(inScope, config, run, sourceErrors);
    await this.resolvePrRefs(inScope, localGit, config, run, sourceErrors);
    const prs = await this.fetchPrs(inScope, config, run, sourceErrors);

    const infra = {
      bb3: bb3 ?? { ...emptyBb3(), error: this.skip.bb3 ? "skipped" : (sourceErrors.bb3 ?? null) },
      lb: { healthy: lb?.healthy ?? null, detail: lb?.detail ?? null, watchLine: lb?.watchLine ?? null, recentErrors: lbErrors ?? [] },
      localVerify: (localVerify ?? []).map((row) => ({ ...row, threadKey: processes.matchThreadByCwd(row.cwd, inScope) }))
    };

    const playbooks = this.playbooks();
    const store = this.store;
    const mutedKeys = store.mutedKeys();
    const items = [];
    for (const thread of inScope) {
      const pr = prs.get(thread.prRefs?.[0]) ?? null;
      const git = localGit.get(thread.cwd) ?? null;
      let classified;
      try {
        classified = classifyThread(thread, { pr, localGit: git, infra, now: started, config });
      } catch (error) {
        classified = { state: "idle-no-pr", reason: `classify failed: ${clampText(error?.message, 80)}`, blockers: [], readiness: null };
      }
      let decision;
      if (mutedKeys.has(thread.key)) {
        decision = { threadKey: thread.key, state: classified.state, action: "none", playbook: null, message: null, reason: "muted by owner", blockers: [], question: null, route: null, notBefore: store.mutedUntil(thread.key), targetKey: thread.key, progressMark: null };
      } else {
        decision = decideThread(classified, thread, { ledger: store.ledgerFor(thread.key), escalationLedger: store, mutedKeys, playbooks, config, now: started, pr, mode, infra, manager });
      }
      items.push({ thread, classified, pr, ledger: store.ledgerFor(thread.key), decision });
    }

    const blockedKeys = { bb3: store.infraBlocked("bb3"), lb: store.infraBlocked("lb") };
    const infraDecisions = decideInfra(infra, { ledger: store, playbooks, config, now: started, threads: items, manager, mode, blockedKeys, mutedKeys });
    const health = infraHealth(infra, { config, now: started });
    this.trackInfraBlocked(health, items, blockedKeys);
    if (bb3) store.setInfraDown("bb3", health.bb3.down);
    if (lb) store.setInfraDown("lb", health.lb.down);

    // A muted thread keeps only its "muted by owner" line: nothing that
    // infra recovery or any other path decided for it may send or ask.
    const decisions = dedupeDecisions([...infraDecisions, ...items.map((item) => item.decision)])
      .filter((decision) => !mutedKeys.has(decision.threadKey) || decision.action === "none");
    const byKey = new Map(threads.map((thread) => [thread.key, thread]));
    if (manager) byKey.set(manager.key, manager);
    this.lastThreads = byKey;

    await this.act(decisions, { mode, byKey, manager, started, config, items });

    const finished = this.now();
    const snapshot = this.buildSnapshot({ reason, started, finished, mode, threads, inScope, items, decisions, infra, sourceErrors, manager });
    store.recordSnapshot(snapshot);
    this.lastTickAt = snapshot.at;
    try { this.runtime?.events?.emit?.("fleet", { at: snapshot.at, reason, counts: snapshot.counts }); } catch { /* listeners never break a tick */ }
    return snapshot;
  }

  // While an outage lasts, remember every thread blocked on it; the recovery
  // tick resumes them (policy reads blockedKeys) and then the list is cleared.
  trackInfraBlocked(health, items, previous) {
    for (const kind of INFRA_KINDS) {
      if (health[kind].down) {
        const current = items
          .filter(({ classified }) => classified.infraKind === kind && BLOCKED_STATES.has(classified.state))
          .map(({ thread }) => thread.key);
        this.store.setInfraBlocked(kind, [...previous[kind], ...current]);
      } else if (health[kind].up) {
        this.store.setInfraBlocked(kind, []);
      }
    }
  }

  async readGit(inScope, config, run, sourceErrors) {
    const cwds = [...new Set(inScope.map((thread) => thread.cwd).filter(Boolean))];
    const read = this.deps.readLocalGit ?? github.readLocalGit;
    const results = new Map();
    try {
      const values = await withTimeout(mapLimit(cwds, GIT_CONCURRENCY, (cwd) => read(cwd, config, { run })), SOURCE_TIMEOUT_MS, "git");
      cwds.forEach((cwd, index) => { if (values[index]) results.set(cwd, values[index]); });
    } catch (error) {
      sourceErrors.git = clampText(error?.message, 200);
    }
    for (const thread of inScope) {
      const git = results.get(thread.cwd);
      if (!git) continue;
      thread.repo ??= git.remote ?? null;
      if (!thread.branch && git.branch && git.branch !== "HEAD") thread.branch = git.branch;
    }
    return results;
  }

  async resolvePrRefs(inScope, localGit, config, run, sourceErrors) {
    if (this.skip.github) return;
    const find = this.deps.findPrForBranch ?? github.findPrForBranch;
    const now = this.now();
    let lookups = 0;
    // Unseen branches precede expired negative results, then oldest first.
    const candidates = [...inScope].sort((a, b) => (this.branchLookups.get(`${a.repo}:${a.branch}`)?.at ?? -Infinity) - (this.branchLookups.get(`${b.repo}:${b.branch}`)?.at ?? -Infinity));
    for (const thread of candidates) {
      if (thread.prRefs?.length || !thread.repo || !thread.branch || TRUNK_BRANCHES.has(thread.branch)) continue;
      const cacheKey = `${thread.repo}:${thread.branch}`;
      const cached = this.branchLookups.get(cacheKey);
      if (cached && now - cached.at < BRANCH_LOOKUP_TTL_MS) {
        if (cached.ref) thread.prRefs = [cached.ref];
        continue;
      }
      if (lookups >= MAX_BRANCH_LOOKUPS) continue;
      lookups += 1;
      try {
        const ref = await withTimeout(Promise.resolve(find(thread.repo, thread.branch, config, { run })), 20_000, "pr lookup");
        this.branchLookups.set(cacheKey, { ref: ref ?? null, at: now });
        if (ref) thread.prRefs = [ref];
      } catch (error) {
        sourceErrors.prLookup = clampText(error?.message, 200);
      }
    }
  }

  async fetchPrs(inScope, config, run, sourceErrors) {
    if (this.skip.github) return new Map();
    const refs = [...new Set(inScope.map((thread) => thread.prRefs?.[0]).filter((ref) => parsePrRef(ref)))];
    if (!refs.length) return new Map();
    try {
      const fetch = this.deps.fetchPrStates ?? github.fetchPrStates;
      return (await withTimeout(Promise.resolve(fetch(refs, config, { run })), SOURCE_TIMEOUT_MS, "github")) ?? new Map();
    } catch (error) {
      sourceErrors.github = clampText(error?.message, 200);
      return new Map();
    }
  }

  async act(decisions, { mode, byKey, manager, started, config }) {
    const store = this.store;
    const at = new Date(started).toISOString();
    const asked = new Set();
    const openActions = store.actions(config.limits.maxActionsKept).filter((action) => OPEN_ACTION.has(action.status));
    const seenActions = new Set();
    let sends = 0;

    const asks = decisions.filter((decision) => decision.action === "ask-user" && decision.question);
    for (const fields of groupQuestions(asks, byKey)) {
      const question = store.upsertQuestion(fields);
      asked.add(question.dedupeKey);
      // The owner already answered or dismissed this one; stay quiet.
      if (question.suppressed) continue;
      try { await this.notifier.notifyQuestion(question); } catch { /* notification is best-effort */ }
    }

    for (const decision of decisions) {
      if (!SENDING.has(decision.action) || !decision.message) continue;
      if (decision.notBefore && Date.parse(decision.notBefore) > started) continue;
      const targetKey = decision.action === "escalate-manager" ? (decision.targetKey ?? manager?.key ?? null) : decision.threadKey;
      const target = targetKey ? byKey.get(targetKey) : null;
      const record = {
        threadKey: decision.threadKey, targetKey, playbook: decision.playbook, route: decision.route,
        message: decision.message, reason: decision.reason, progressMark: decision.progressMark ?? null, kind: decision.action
      };
      const existing = openActions.find((action) => action.threadKey === record.threadKey && action.playbook === record.playbook);
      if (existing) seenActions.add(existing.id);

      if (mode !== "auto" || !target || !decision.route) {
        const status = mode === "propose" && target && decision.route ? "proposed" : "planned";
        if (existing) store.updateAction(existing.id, { ...record, status, at });
        else store.recordAction({ ...record, status, at });
        continue;
      }
      if (sends >= config.limits.maxSendsPerTick) continue;
      sends += 1;
      const delivery = await this.executor.deliver({ thread: target, message: decision.message, route: decision.route, playbook: decision.playbook, actionId: existing?.id ?? null });
      if (!existing && !delivery.actionId) store.recordAction({ ...record, status: delivery.status, detail: delivery.detail, at });
      else if (delivery.actionId) store.updateAction(delivery.actionId, { reason: record.reason, message: record.message, threadKey: record.threadKey, targetKey });
      this.recordSend(record, delivery);
    }

    // A planned/proposed action the policy no longer wants is stale.
    for (const action of openActions) {
      if (!seenActions.has(action.id)) store.updateAction(action.id, { status: "stale" });
    }
    // A question whose condition is gone closes itself once its thread was
    // decided again this tick without asking.
    for (const question of store.openQuestions()) {
      if (asked.has(question.dedupeKey)) continue;
      const decided = question.threadKey ? decisions.some((decision) => decision.threadKey === question.threadKey) : false;
      const supervisorOwned = !question.threadKey && /^(infra:|limit:group|open:group)/.test(String(question.dedupeKey ?? ""));
      if (decided || supervisorOwned) {
        store.resolveQuestion(question.id);
        this.resolveOutreach(question, "resolved", "dismissed");
      }
    }
  }

  buildSnapshot({ reason, started, finished, mode, threads, inScope, items, decisions, infra, sourceErrors, manager }) {
    const byState = {};
    const decisionFor = effectiveDecisions(decisions);
    const rows = items.map(({ thread, classified, pr }) => {
      byState[classified.state] = (byState[classified.state] ?? 0) + 1;
      const decision = decisionFor.get(thread.key) ?? null;
      return {
        key: thread.key,
        kind: thread.kind,
        title: clampText(thread.title, 100),
        workspace: thread.workspace ?? null,
        repo: thread.repo ?? null,
        branch: thread.branch ?? null,
        agentStatus: thread.agentStatus,
        state: classified.state,
        reason: clampText(classified.reason, 160),
        blockers: (classified.blockers ?? []).slice(0, 6),
        pr: pr
          ? { ref: pr.ref, url: pr.url, state: pr.state, title: clampText(pr.title, 100), ci: pr.ci, unresolvedThreads: pr.unresolvedThreads, mergeState: pr.mergeState, head: String(pr.headOid ?? "").slice(0, 10) }
          : (thread.prRefs?.[0] ? { ref: thread.prRefs[0], url: null, state: null } : null),
        lastActivityAt: thread.lastActivityAt ?? null,
        lastAgentText: clampTail(thread.lastAgentText, 600),
        error: thread.error ? { kind: thread.error.kind, resetAt: thread.error.resetAt ?? null } : null,
        live: Boolean(thread.live),
        route: chooseRoute(thread, mode),
        decision: decision ? { action: decision.action, playbook: decision.playbook, reason: clampText(decision.reason, 160), notBefore: decision.notBefore ?? null } : null
      };
    });
    const infraDecisions = decisions.filter((decision) => decision.threadKey.startsWith("infra:"))
      .map((decision) => ({ key: decision.threadKey, action: decision.action, reason: clampText(decision.reason, 200), notBefore: decision.notBefore ?? null }));
    const sources = { codex: 0, claude: 0, conductor: 0 };
    for (const thread of threads) sources[thread.kind] = (sources[thread.kind] ?? 0) + 1;
    return {
      at: new Date(finished).toISOString(),
      reason,
      durationMs: finished - started,
      mode,
      counts: {
        threads: threads.length,
        inScope: inScope.length,
        sources,
        byState,
        needsYou: this.store.openQuestions().length,
        actions: decisions.filter((decision) => SENDING.has(decision.action)).length
      },
      manager: manager ? { key: manager.key, title: clampText(manager.title, 80), live: Boolean(manager.live), agentStatus: manager.agentStatus, error: manager.error?.kind ?? null } : null,
      threads: rows,
      infra,
      infraDecisions,
      sourceErrors
    };
  }
}
