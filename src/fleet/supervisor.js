// Fleet supervisor tick: read every source, classify each coding thread,
// decide with policy + playbooks, then act according to the mode.
//   observe  record what it would do ("planned"), send nothing
//   propose  record "proposed" actions the owner can send with one tap
//   auto     deliver templated nudges/escalations, within the limits
// Needs-you questions are raised in every mode. The constructor has no side
// effects; hosted-interface calls start() on listen and stop() on close.

import path from "node:path";
import { resolveDataDir } from "../data-dir.js";
import { MODES, SUPERVISOR_PREFIX, UI_APPS, clampTail, clampText, linkUiHosts, parsePrRef, redactSecrets, resolveFleetConfig, runCommand, uiTargetFor } from "./contracts.js";
import { classifyThread, mergeThreads, threadHealth } from "./classify.js";
import { createExecutor } from "./executor.js";
import { createNotifier } from "./notify.js";
import { BUNDLED_PLAYBOOKS_DIR, loadOwnerNotes, loadPlaybooks, userPlaybooksDir } from "./playbooks.js";
import { chooseRoute, decideInfra, decideThread, dedupeDecisions, infraHealth, ownerLabel } from "./policy.js";
import { createReviewRunner, reviewContext, reviewFingerprint, reviewQuestions } from "./review.js";
import { FleetStore } from "./store.js";
import { DEADLINE_MARGIN_MS, createAppRestarter, createUiDriver } from "./ui-delivery.js";
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
const SETTLED_PR_STATES = new Set(["MERGED", "CLOSED"]);
// How long a remembered outage thread hidden by a failed source waits for it.
const RECOVERY_HOLD_MS = 60 * MIN;
// A manager escalation shares one cooldown per incident, whichever thread
// or infra check raised it (same keys decideInfra uses).
const INCIDENT_KEYS = Object.freeze({ "manager-bb3": "infra:bb3", "manager-lb": "infra:lb" });
// A delivered or failed escalation starts the cooldown; a failed route must
// not be retried every tick (same rule as the nudge ledger).
const ESCALATION_STATUSES = new Set(["sent", "failed"]);
// The snapshot row shows the decision that acts when a thread got two.
const DECISION_RANK = Object.freeze({ nudge: 3, "escalate-manager": 3, "ask-user": 2, wait: 1, none: 0 });
// A changed or due question waits this long after the last review (new ones
// never wait); a failed review is not retried sooner than REVIEW_RETRY_MS.
const REVIEW_MIN_GAP_MS = 10 * MIN;
const REVIEW_RETRY_MS = 15 * MIN;
// An unchanged question kept again and again is re-checked at 1x, 2x, then
// at most 4x the review interval.
const REVIEW_BACKOFF_MAX = 2;

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
  open: { dedupeKey: "open:group", options: ["opened", "skip"], title: (n) => `${n} stuck, can't reach. Open them?`, body: (labels) => `No live session to message: ${labels}.` },
  // Always one question, even for one thread, so the owner's answer holds
  // while the set of failing threads changes under it.
  deliver: { dedupeKey: "deliver:group", options: ["done", "skip"], match: ["done", "skip"], minSize: 1, title: (n) => `${n} stopped. Nudges can't get through. Nudge ${n === 1 ? "it" : "them"}?`, body: (labels) => `Sends keep failing: ${labels}.` }
});
const SELF_FINDING_KINDS = new Set(["open", "deliver", "stuck", "paused"]);
// The owner's Scan now reviews at most this many batches (15 questions each).
const FORCED_REVIEW_ROUNDS = 4;
const GROUP_MAX = 50;
// Computer use unable to type this long, with nudges waiting on it: the owner
// hears why once (secure input held by an app, a locked screen), and the
// question closes itself when typing works again.
const PAUSED_ASK_MS = 30 * 60_000;

function pausedDeliveryDecision(delivery, blockedSince, now) {
  const waiting = blockedSince.size;
  const since = waiting ? Math.min(...blockedSince.values()) : null;
  if (!since || now - since < PAUSED_ASK_MS) return null;
  const minutes = Math.round((now - since) / 60_000);
  return {
    threadKey: "infra:computer-use", state: "infra", action: "ask-user", playbook: null, message: null, blockers: [],
    reason: `nudges paused: ${delivery.detail ?? "computer use not ready"}`, route: null, notBefore: null, targetKey: null, progressMark: null,
    question: {
      dedupeKey: "infra:computer-use", kind: "paused", threadKey: null,
      title: "Nudges paused: can't type into apps. Fix it?",
      body: `${delivery.detail ?? "Computer use is not ready"}. ${waiting} threads wait on a nudge, for ${minutes}m.`,
      options: ["fixed", "skip"]
    }
  };
}
// A resume of a stopped or capped turn goes before merge-ready chatter.
const SEND_FIRST = new Set(["resume", "infra-recovered"]);

// The label single questions use, so a group never names a thread by its
// session id or title (a first prompt, an automation prompt).
function threadLabel(thread) {
  if (!thread) return "?";
  const ref = thread.prRefs?.[0] ?? "";
  const pr = Number(/#(\d+)$/.exec(ref)?.[1]);
  return ownerLabel(thread, pr > 0 ? pr : null, parsePrRef(ref)?.repo);
}

function formatReset(iso) {
  const at = Date.parse(iso ?? "");
  if (!Number.isFinite(at)) return "soon";
  return new Date(at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function groupQuestions(asks, byKey) {
  const out = [];
  const titles = new Set();
  const groups = { limit: [], open: [], deliver: [] };
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
    const titleKey = kind === "infra" && !decision.question.options?.includes("retry")
      ? `infra:${decision.question.title}`
      : decision.question.dedupeKey ?? `${decision.threadKey}:${decision.question.title}:${decision.question.body}`;
    if (titles.has(titleKey)) continue;
    titles.add(titleKey);
    out.push(single(decision));
  }
  // The store keeps 50 members per question, so a bigger group splits.
  const chunks = Object.entries(groups).flatMap(([kind, all]) => (all.length <= GROUP_MAX ? [[kind, all, 0]]
    : Array.from({ length: Math.ceil(all.length / GROUP_MAX) }, (_, i) => [kind, all.slice(i * GROUP_MAX, (i + 1) * GROUP_MAX), i])));
  for (const [kind, list, part] of chunks) {
    const spec = GROUPED_KINDS[kind];
    const minSize = spec.minSize ?? 2;
    if (list.length === 1 && minSize > 1) out.push(single(list[0]));
    if (!list.length || list.length < minSize) continue;
    const threads = list.map((decision) => byKey.get(decision.threadKey)).filter(Boolean);
    // A delivery failure names its reason, so the owner knows what to fix.
    const labels = kind === "deliver"
      ? list.map((decision) => `${threadLabel(byKey.get(decision.threadKey))} (${String(decision.reason ?? "").replace(/^can't deliver: /, "")})`).join(", ")
      : threads.map(threadLabel).join(", ");
    const resets = threads.map((thread) => thread.error?.resetAt).filter(Boolean).sort();
    out.push({
      kind, dedupeKey: part ? `${spec.dedupeKey}:${part + 1}` : spec.dedupeKey, options: spec.options, playbook: null, threadKey: null, prRef: null,
      threadKeys: list.map((decision) => decision.threadKey),
      title: spec.title(list.length, formatReset(resets[0])),
      body: spec.body(labels)
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

// A snapshot saved before rows carried health still gives the phone one.
function withHealth(snapshot) {
  if (!Array.isArray(snapshot?.threads) || snapshot.threads.every((row) => row?.health)) return snapshot;
  return { ...snapshot, threads: snapshot.threads.map((row) => (row?.health ? row : { ...row, health: threadHealth(row?.state, row?.error ?? null) })) };
}

// Delivery that failed only because typing into the app has to wait (a
// strict computer-use Mac that cannot type now, or a typed send held back by
// the owner at the keyboard or a running turn). A CLI fallback's failure is
// not about typing, so it stays the owner's to see.
const TYPING_WAITS = /^(computer use not ready|owner using |turn running|frontmost app changed|secure input|waiting for idle|screen saver on|front app unknown)/;
// A computer-use send that ends this way stops the tick's other ones.
const UI_STALLED = /^(Open Computer Use timed out|Open Computer Use stopped|delivery timed out)/;
function typingWaits(thread, route, deliveryState, delivery) {
  if (!uiTargetFor(thread)) return false;
  if (!route) return deliveryState?.mode === "computer-use" && deliveryState?.ready === false;
  return route === "computer-use" && TYPING_WAITS.test(String(delivery?.detail ?? ""));
}
// A background (CLI) send of a kept answer reports whether it reached the
// agent later; until then the answer is not sent again.
const QUEUED_SENDING_MS = 15 * 60_000;

// Answers kept while the Mac could not type are dropped after this long; the
// paused-nudge alert has told the owner why by then.
const QUEUED_ANSWER_MS = 24 * 60 * 60_000;

function ownerDelivery(answer) {
  // Options are fixed strings chosen by policy, never agent text.
  return `Owner answer: ${answer}. Continue with that.`;
}

// "retry" on a logged-out / disk-full question means the owner fixed it.
const RETRY_DELIVERY = "Owner fixed the blocker (login or disk). Retry: continue where you stopped.";
// "added" on an account-cap question means new capacity: resume now.
const ADDED_DELIVERY = "Owner added account capacity. Continue where you stopped.";
const RESTART_REPEAT_MS = 10 * 60_000;

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
    // ref -> last MERGED or CLOSED read, for ticks GitHub cannot answer.
    this.settledPrs = new Map();
    this.answering = new Set();
    this._uiDriver = undefined;
    this.restartedAt = new Map();
    this._uiBlockedSince = null;
    this.lastDelivery = { mode: this.config.delivery ?? "cli", ready: null, detail: null, checkedAt: null };
    this._reviewRunner = null;
    this.lastReview = { at: null, failedAt: null, error: null };
    // New questions waiting on the review: hidden from the state the main
    // mirrors until the review has seen them.
    this.awaitingReview = new Set();
  }

  now() {
    return typeof this.deps.now === "function" ? this.deps.now() : Date.now();
  }

  get dataDir() {
    return this.dataDirOption ?? resolveDataDir();
  }

  // Loaded with the store, which opens on first use.
  get uiBlockedSince() {
    this._uiBlockedSince ??= this.store.uiBlockedSince();
    return this._uiBlockedSince;
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
    this._executor ??= createExecutor({
      config: this.config, run: this.deps.run, store: this.store, readLivePeers: this.deps.readLivePeers ?? claude.readLivePeers,
      ui: this.uiDriver, knownThreads: () => [...this.lastThreads.values()]
    });
    return this._executor;
  }

  // Types into Conductor / the Codex app. An injected executor (tests, the
  // dry-run scan) gets none, so readiness is never probed for it.
  get uiDriver() {
    if (this._uiDriver !== undefined) return this._uiDriver;
    if (this.deps.uiDriver !== undefined) this._uiDriver = this.deps.uiDriver;
    else if (this.deps.executor) this._uiDriver = null;
    else {
      this._uiDriver = createUiDriver({
        config: this.config,
        run: this.deps.run ?? runCommand,
        evidenceDir: path.join(this.store.dir, "logs", "ui"),
        activeSessions: () => this.runtime?.computerUseLog?.listSessions?.({ status: "active" }) ?? [],
        now: () => this.now()
      });
    }
    return this._uiDriver;
  }

  // { mode, ready, detail }: ready is null when not probed (cli, or no driver).
  async probeDelivery() {
    const mode = this.config.delivery ?? "cli";
    let state = { mode, ready: null, detail: null };
    const driver = mode === "cli" ? null : this.uiDriver;
    if (driver?.readiness) {
      try {
        const result = await withTimeout(Promise.resolve(driver.readiness()), SOURCE_TIMEOUT_MS, "computer-use readiness");
        state = { mode, ready: result?.ready === true, detail: result?.ready === true ? null : clampText(result?.detail ?? "not ready", 160) };
        if (state.ready && mode === "computer-use-first" && driver.appRunning) state.apps = await this.probeApps(driver);
      } catch (error) {
        state = { mode, ready: false, detail: clampText(`readiness check failed: ${error?.message ?? error}`, 160) };
      }
    }
    this.lastDelivery = { ...state, checkedAt: new Date(this.now()).toISOString() };
    return state;
  }

  // bundleId -> running (true/false), or null when it could not be told.
  async probeApps(driver) {
    const apps = {};
    for (const { bundleId } of Object.values(UI_APPS)) {
      try {
        apps[bundleId] = await withTimeout(Promise.resolve(driver.appRunning(bundleId)), SOURCE_TIMEOUT_MS, "app presence");
      } catch {
        apps[bundleId] = null;
      }
    }
    return apps;
  }

  // Why an answer or resume has no route, in the owner's words.
  noRouteDetail(thread, delivery) {
    if (!thread) return "thread not seen since restart: scan first";
    if (delivery?.mode === "computer-use") {
      if (!uiTargetFor(thread)) return "no app shows this thread (terminal session): open it to answer";
      if (delivery.ready === false) return `computer use not ready: ${delivery.detail ?? "check Open Computer Use"}`;
    }
    return "no live route: open the thread to answer";
  }

  // runModel for the review; tests inject a fake one.
  get reviewRunner() {
    if (this.deps.runModel) return this.deps.runModel;
    this._reviewRunner ??= createReviewRunner({ config: this.config, run: this.deps.run ?? runCommand });
    return this._reviewRunner;
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

  // deferUi: a scan that came through the node broker, which stops waiting
  // before a computer-use send would end; its app sends wait for the next
  // scheduled tick (CLI sends and the review still run).
  tick({ reason = "manual", deferUi = false } = {}) {
    // The owner's scan arriving mid-tick gets its own full recheck right
    // after, instead of riding on a scan that did not force the review.
    // Any local request in the queue lets that one type.
    if (this.running && (reason === "owner-scan" || reason === "chat")) {
      this.followUpDefersUi = (this.forcedFollowUp ? this.followUpDefersUi : true) && deferUi;
      this.forcedFollowUp ??= this.running.catch(() => {}).then(() => { this.forcedFollowUp = null; return this.tick({ reason, deferUi: this.followUpDefersUi }); });
      return this.forcedFollowUp;
    }
    if (this.running) return this.running;
    this.running = this._tick(reason, { deferUi })
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
    const questions = store.openQuestions().filter((question) => !this.awaitingReview.has(question.id));
    // A read can expire a question too (the /fleet page, the main's refresh)
    // while no tick runs.
    this.closeExpired();
    return {
      mode: this.mode,
      enabled: Boolean(this.config.enabled),
      running: Boolean(this.running),
      lastTickAt: this.lastTickAt ?? store.snapshot?.at ?? null,
      lastError: this.lastError,
      snapshot: withHealth(store.snapshot),
      questions,
      // So the owner can reopen a wrong close.
      reviewClosed: store.reviewClosed(),
      actions: store.actions(50),
      settings: {
        tickMinutes: Math.round(this.config.tickMs / MIN),
        lookbackHours: this.config.lookbackHours,
        push: this.config.push ?? null,
        relayModel: this.config.relayModel,
        managerRef: this.config.managerRef,
        delivery: this.lastDelivery.mode,
        deliveryReady: this.lastDelivery.ready,
        deliveryDetail: this.lastDelivery.detail,
        review: {
          enabled: Boolean(this.config.review?.enabled),
          model: this.config.review?.model ?? null,
          lastAt: this.lastReview.at ? new Date(this.lastReview.at).toISOString() : null,
          lastError: this.lastReview.error
        }
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

  // The owner reopens a question the review closed (a wrong call): same
  // record, and its outreach copy comes back. Pinned, so the review keeps
  // it until its ask changes.
  reopenReviewed(id) {
    const question = this.store.reopenReviewed(id);
    if (!question) return null;
    this.reopenOutreach(question);
    this.store.recordAction({
      kind: "review", playbook: "review", threadKey: question.threadKey ?? null, questionId: id, status: "done",
      reason: clampText(`owner reopened: ${question.title}`, 300)
    });
    return question;
  }

  // The outreach copy (Mac overlay, G2) must not keep asking after the
  // question closed on /fleet or by itself.
  resolveOutreach(question, decision, status) {
    if (!question?.outreachId) return;
    try { this.runtime?.outreach?.resolve?.(question.outreachId, decision, { status }); } catch { /* best-effort */ }
  }

  // An expired question's copy must not keep asking on the Mac or G2.
  closeExpired() {
    for (const question of this.store.takeExpired()) this.resolveOutreach(question, "expired", "dismissed");
  }

  reopenOutreach(question) {
    if (!question?.outreachId) return;
    try { this.runtime?.outreach?.reopen?.(question.outreachId); } catch { /* best-effort */ }
  }

  // startedAt: when the owner's request began (Date.now): an app send counts
  // its time from there, so a remote request ends inside the broker's 5 min.
  // deadlineAt: when a remote caller stops waiting, its queue time included.
  async resumeAll(question, message, settling = [], { restartApps = [], startedAt = Date.now(), deadlineAt = null } = {}) {
    const keys = question.threadKeys ?? (question.threadKey ? [question.threadKey] : []);
    const restarted = await this.restartHosts(keys, restartApps);
    if (restarted) return restarted;
    let sent = 0;
    let blocked = 0;
    let late = 0;
    const deliveryState = await this.probeDelivery();
    // A Conductor session and the Codex thread it hosts are one app
    // conversation: one typed send covers every key that maps to it.
    const typedInto = new Map();
    for (const key of keys) {
      // Read the store each time: a background resume that failed meanwhile
      // took its key back out, so that thread is sent again.
      if (this.store.question(question.id)?.deliveredThreadKeys?.includes(key)) { sent += 1; continue; }
      const thread = this.lastThreads.get(key);
      const route = thread ? chooseRoute(thread, this.mode === "auto" ? "auto" : "propose", deliveryState) : null;
      if (!thread || !route) { blocked += 1; continue; }
      const uiKey = route === "computer-use" ? uiTargetFor(thread)?.targetKey ?? null : null;
      if (uiKey && typedInto.has(uiKey)) {
        if (typedInto.get(uiKey)) { sent += 1; this.store.markQuestionDelivered(question.id, key); } else blocked += 1;
        continue;
      }
      // Past the caller's deadline it reports failure: no member starts then
      // (a relay or background resume would still land, and a retry repeat it).
      if (Number.isFinite(deadlineAt) && Date.now() >= deadlineAt - DEADLINE_MARGIN_MS) { late += 1; continue; }
      const delivery = await this.executor.deliver({ thread, message, route, playbook: "owner-answer", spentMs: Date.now() - startedAt, deadlineAt });
      if (uiKey) typedInto.set(uiKey, delivery.status === "sent");
      this.store.recordNudge(thread.key, { playbook: "owner-answer", route, status: delivery.status === "sent" ? "owner-answer" : delivery.status });
      if (delivery.status === "sent") {
        sent += 1;
        this.store.markQuestionDelivered(question.id, key);
        if (delivery.done) settling.push(delivery.done.then((reached) => (reached ? null : key)));
      }
      else blocked += 1;
    }
    return { status: blocked || late || !sent ? "blocked" : "sent", route: null, detail: `${sent} resumed, ${blocked} not reachable${late ? `, ${late} not sent (out of time)` : ""}; open the thread and retry if needed` };
  }

  // When each nudge first waited on computer use (Auto only: the other modes
  // never send on their own). A thread its source could not show this tick
  // (the scan failed, or hit its cap) keeps its time; one that no longer
  // waits drops it, so the age is always that of a nudge still waiting.
  trackUiBlocked(decisions, { mode, delivery, threads, sourceErrors, started, config }) {
    if (mode !== "auto" || delivery.ready !== false) { this.uiBlockedSince.clear(); this.store.setUiBlockedSince(this.uiBlockedSince); return; }
    const now = new Set(decisions.filter((decision) => decision?.uiBlocked).map((decision) => decision.threadKey));
    const seen = new Set(threads.map((thread) => thread.key));
    const hidden = (key) => {
      // infra:bb3 and infra:lb belong to their probes, not a thread source.
      const [kind, probe] = String(key).split(":");
      if (kind === "infra") return Boolean(sourceErrors[probe]);
      const capped = threads.filter((thread) => thread.kind === kind).length >= config.limits.maxThreads;
      return !seen.has(key) && (Boolean(sourceErrors[kind]) || capped);
    };
    for (const key of [...this.uiBlockedSince.keys()]) if (!now.has(key) && !hidden(key)) this.uiBlockedSince.delete(key);
    for (const key of now) if (!this.uiBlockedSince.has(key)) this.uiBlockedSince.set(key, started);
    this.store.setUiBlockedSince(this.uiBlockedSince);
  }

  // Owner answers kept while the Mac could not type. Each goes to its agent
  // once a route works, and only while the agent still asks that same thing
  // (this tick asked its dedupeKey): a stale "yes" must never land on a new
  // question. One the owner overtook in the thread is dropped quietly; one
  // older than a day, or whose thread is gone, goes back to the owner.
  async deliverQueuedAnswers({ byKey, started, cappedKinds, asked, decided, sourceUnknown, budget = Infinity, deferUi = false }) {
    // uiStalled: a computer-use send timed out or lost Open Computer Use;
    // the rest of the tick's typing waits (the send loop too).
    const contacted = { threads: new Set(), uiKeys: new Set(), sent: 0, uiStalled: false };
    let tries = 0;
    const queued = this.store.queuedAnswers();
    if (!queued.length) return contacted;
    const deliveryState = await this.probeDelivery();
    for (const question of queued) {
      const pending = question.pendingDelivery;
      const thread = byKey.get(question.threadKey);
      // A background send still settling decides this one.
      if (pending.sendingAt && started - Date.parse(pending.sendingAt) < QUEUED_SENDING_MS) continue;
      // A day without a way to type: back in front of the owner (unless the
      // same ask already is, or its thread is gone and nothing is left to answer).
      if (started - Date.parse(pending.since) > QUEUED_ANSWER_MS) {
        this.store.settleQueuedAnswer(question.id, "dropped");
        if (thread && !this.store.openQuestions().some((q) => q.dedupeKey === question.dedupeKey)) this.store.reopenQuestion(question.id, [], { answer: question.answer, asked: true });
        continue;
      }
      if (contacted.sent >= budget) continue;
      // Only the thread's own source matters here: a git or PR read that
      // failed says nothing about whether the agent can take the answer.
      if (sourceUnknown([question.threadKey])) continue;
      // A full scan leaves threads out; that is not proof this one is gone.
      if (!thread && cappedKinds.has(String(question.threadKey).split(":")[0])) continue;
      if (!thread) { this.store.settleQueuedAnswer(question.id, "dropped"); continue; }
      // Past the scan's thread cap this tick: nothing was decided for it.
      if (!decided.has(thread.key)) continue;
      const ownerSince = Date.parse(thread.lastUserAt ?? "") > Date.parse(question.answeredAt ?? "") && !String(thread.lastUserText ?? "").startsWith(SUPERVISOR_PREFIX);
      // An agent's own question must still stand. A "retry" after the owner
      // fixed a blocker is sent even though the blocker is no longer asked,
      // unless the agent has spoken since (it recovered, or asks something new).
      const agentSince = Date.parse(thread.lastAgentAt ?? "") > Date.parse(question.answeredAt ?? "");
      const stale = question.kind === "agent-ask" ? !asked.has(question.dedupeKey) : agentSince;
      if (ownerSince || stale) { this.store.settleQueuedAnswer(question.id, "superseded"); continue; }
      const route = chooseRoute(thread, this.mode === "auto" ? "auto" : "propose", deliveryState);
      if (!route) continue;
      if ((contacted.uiStalled || deferUi) && route === "computer-use") continue;
      // Failed tries are bounded too, like the send loop's.
      if (tries >= budget * 2) continue;
      tries += 1;
      const delivery = await this.executor.deliver({ thread, message: pending.message, route, playbook: "owner-answer" });
      this.store.recordNudge(thread.key, { playbook: "owner-answer", route, status: delivery.status === "sent" ? "owner-answer" : delivery.status, detail: delivery.detail ?? null });
      if (route === "computer-use" && UI_STALLED.test(String(delivery.detail ?? ""))) contacted.uiStalled = true;
      if (delivery.status !== "sent") continue;
      contacted.sent += 1;
      contacted.threads.add(thread.key);
      const uiKey = uiTargetFor(thread)?.targetKey;
      if (uiKey) contacted.uiKeys.add(uiKey);
      if (!delivery.done) { this.store.settleQueuedAnswer(question.id, "sent"); continue; }
      // A CLI child reports later whether it reached the agent.
      this.store.markQueuedSending(question.id);
      delivery.done
        .then((reached) => (reached ? this.store.settleQueuedAnswer(question.id, "sent") : this.store.markQueuedSending(question.id, null)))
        .catch(() => this.store.markQueuedSending(question.id, null));
    }
    return contacted;
  }

  // Restarts each listed app that shows one of these threads, once per ten
  // minutes (a second answer after a partial send does not restart again).
  // Returns a blocked delivery when it must not or could not restart.
  async restartHosts(keys, restartApps) {
    const threads = keys.map((key) => this.lastThreads.get(key)).filter(Boolean);
    for (const app of restartApps) {
      if (!threads.some((thread) => uiTargetFor(thread)?.app === app)) continue;
      if (this.now() - (this.restartedAt.get(app) ?? -Infinity) < RESTART_REPEAT_MS) continue;
      const name = UI_APPS[app]?.name ?? app;
      // A restart ends every running turn in that app, not just the capped ones.
      const busy = [...this.lastThreads.values()].filter((thread) => !keys.includes(thread.key) && thread.agentStatus === "running" && uiTargetFor(thread)?.app === app);
      if (busy.length) return { status: "blocked", route: null, detail: `${busy.length} chats still running in ${name}; a restart would stop them. Answer again when they finish.` };
      const result = await this.appRestarter.restart(app);
      this.store.recordAction({ kind: "restart", playbook: "account-switched", threadKey: null, status: result.ok ? "done" : "failed", reason: `restart ${name} after an account switch`, detail: result.detail, at: new Date(this.now()).toISOString() });
      if (!result.ok) return { status: "blocked", route: null, detail: `${result.detail}; answer again to retry` };
      this.restartedAt.set(app, this.now());
    }
    return null;
  }

  get appRestarter() {
    this._appRestarter ??= this.deps.appRestarter ?? createAppRestarter({ bins: this.config.bins ?? {}, run: this.deps.run ?? runCommand, limits: this.config.limits });
    return this._appRestarter;
  }

  async answerQuestion(id, answer, { deadlineAt = null } = {}) {
    const startedAt = Date.now();
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
      const settling = [];
      if (question.kind === "limit" && answer === "added") {
        // The owner's own copy of this playbook says what their apps need
        // after an account switch (a restart, a plain "retry").
        const playbook = this.playbooks().get("account-switched");
        delivery = await this.resumeAll(question, playbook?.body || ADDED_DELIVERY, settling, { restartApps: playbook?.restartApps ?? [], startedAt, deadlineAt });
      }
      // An owner answer to the agent's own question, or "retry" after the owner
      // fixed a login/disk blocker, is an explicit instruction: every mode.
      const retry = question.kind === "infra" && answer === "retry";
      if ((question.kind === "agent-ask" || retry) && question.threadKey && answer !== "open thread") {
        const thread = this.lastThreads.get(question.threadKey);
        const deliveryState = thread ? await this.probeDelivery() : null;
        const route = thread ? chooseRoute(thread, this.mode === "auto" ? "auto" : "propose", deliveryState) : null;
        const message = retry ? RETRY_DELIVERY : ownerDelivery(answer);
        if (!thread || !route) {
          delivery = { status: "blocked", route: null, detail: this.noRouteDetail(thread, deliveryState) };
        } else {
          delivery = await this.executor.deliver({ thread, message, route, playbook: "owner-answer", spentMs: Date.now() - startedAt, deadlineAt });
          if (delivery.done) settling.push(delivery.done.then((reached) => (reached ? null : thread.key)));
          // Starts the cooldown but does not spend the no-progress nudge budget.
          this.store.recordNudge(thread.key, { playbook: "owner-answer", route, status: delivery.status === "sent" ? "owner-answer" : delivery.status });
        }
        // The owner decided; only the typing has to wait (secure input, a
        // locked screen, the owner at the keyboard). Keep the answer and send
        // it once the Mac can type, instead of handing the question back.
        if (thread && delivery.status !== "sent" && answer !== "open thread" && typingWaits(thread, route, deliveryState, delivery)) {
          // A tick may have closed the question meanwhile; only a stored answer is "saved".
          const queued = this.store.queueAnswer(id, answer, message);
          if (queued) {
            this.resolveOutreach(question, answer, "acted");
            this.applyOverride(question, answer);
            return { question: queued, delivery: { status: "queued", route: null, detail: `Saved. It goes to the agent once the Mac can type (${delivery.detail}).` } };
          }
        }
      }
      // A background resume can fail while the others are still sending;
      // the group closes only once every thread has it.
      if (delivery?.status === "sent" && question.kind === "limit" && answer === "added") {
        const stored = this.store.question(id);
        // A tick may have resolved the group mid-send; only an open one counts.
        if (stored?.status === "open" && (stored.threadKeys ?? question.threadKeys ?? []).some((key) => !(stored.deliveredThreadKeys ?? []).includes(key))) {
          delivery = { ...delivery, status: "blocked", detail: "a resume failed before it reached its thread; answer again to retry" };
        }
      }
      // A failed or unreachable delivery remains actionable on every surface.
      if (delivery && delivery.status !== "sent") {
        this.reopenIfUndelivered(id, settling, answer);
        return { question: this.store.question(id), delivery };
      }
      if (answer === "open thread") return { question, delivery: { status: "blocked", route: null, detail: "Answer in the original thread, then scan again." } };
      const answered = this.store.answerQuestion(id, answer);
      this.resolveOutreach(question, answer, "acted");
      this.applyOverride(question, answer);
      this.reopenIfUndelivered(id, settling, answer);
      return { question: answered, delivery };
    } finally {
      this.answering.delete(id);
    }
  }

  // A background resume reports its exit only later, one thread at a time.
  // Attached after the answer was recorded, so even an instant failure finds
  // the final state; a newer, different answer from the owner stands.
  reopenIfUndelivered(id, settling, answer) {
    for (const outcome of settling) {
      outcome
        .then((key) => { if (key) this.store.reopenQuestion(id, [key], { answer }); })
        .catch(() => { /* best-effort */ });
    }
  }

  // The owner's own words to one thread (the supervisor chat's
  // fleet_send_message, after approval). Same delivery as an owner answer:
  // on a computer-use Mac it is typed into the app, never a CLI.
  async sendOwnerMessage(threadKey, message, { deadlineAt = null } = {}) {
    const startedAt = Date.now();
    const text = String(message ?? "").trim();
    if (!text) return { delivery: { status: "blocked", route: null, detail: "empty message" } };
    const thread = this.lastThreads.get(threadKey);
    const deliveryState = thread ? await this.probeDelivery() : null;
    const route = thread ? chooseRoute(thread, this.mode === "auto" ? "auto" : "propose", deliveryState) : null;
    if (!thread || !route) return { delivery: { status: "blocked", route: null, detail: this.noRouteDetail(thread, deliveryState) } };
    const delivery = await this.executor.deliver({ thread, message: text, route, playbook: "owner-message", spentMs: Date.now() - startedAt, deadlineAt });
    this.store.recordNudge(thread.key, { playbook: "owner-message", route, status: delivery.status === "sent" ? "owner-answer" : delivery.status });
    return { delivery: { status: delivery.status, route: delivery.route ?? route, detail: delivery.detail ?? null } };
  }

  applyOverride(question, answer) {
    const keys = question.threadKeys ?? (question.threadKey ? [question.threadKey] : []);
    for (const key of keys) {
      if (question.kind === "stuck" && answer === "keep going") this.store.resetAttempts(key);
      if (question.kind === "deliver") this.store.ackUndelivered(key);
      if ((question.kind === "stuck" && answer === "stop") || (question.kind === "open" && answer === "skip")) {
        this.store.mute(key, this.now() + MUTE_MS);
      }
    }
  }

  async sendProposed(actionId, { deadlineAt = null } = {}) {
    if (this.mode !== "propose") return null;
    const action = this.store.action(actionId);
    if (!action || action.status !== "proposed") return null;
    const thread = this.lastThreads.get(action.targetKey);
    if (!thread) {
      const updated = this.store.updateAction(actionId, { status: "blocked", detail: "thread not seen in the last scan" });
      return { action: updated, delivery: { status: "blocked", route: action.route, detail: updated?.detail ?? null } };
    }
    const delivery = await this.executor.deliver({ thread, message: action.message, route: action.route, playbook: action.playbook, actionId, deadlineAt });
    this.recordSend(action, delivery);
    return { action: this.store.action(actionId), delivery };
  }

  recordSend(action, delivery) {
    const at = new Date(this.now()).toISOString();
    const incident = incidentKey(action);
    if (incident && ESCALATION_STATUSES.has(delivery.status)) this.store.recordEscalation(incident, at);
    if (String(action.threadKey ?? "").startsWith("infra:")) return;
    // An escalation went to the manager, not this thread: history only, so it
    // spends neither the thread's nudge budget nor its cooldown.
    const status = action.kind === "escalate-manager" && delivery.status === "sent" ? "escalated" : delivery.status;
    const thread = this.lastThreads.get(action.threadKey);
    const threadActivityAt = thread ? (thread.lastAgentAt && Date.parse(thread.lastAgentAt) > Date.parse(thread.lastActivityAt ?? "") ? thread.lastAgentAt : thread.lastActivityAt) : null;
    this.store.recordNudge(action.threadKey, { at, playbook: action.playbook, route: action.route, status, detail: delivery.detail ?? null, threadActivityAt }, action.progressMark);
    // A counted nudge whose background child never reached the agent gives
    // back that one attempt. Owner answers and escalations counted none.
    if (status === "sent" && delivery.done) {
      delivery.done.then((reached) => { if (!reached) this.store.undoAttempt(action.threadKey); }).catch(() => { /* best-effort */ });
    }
  }

  async _tick(reason, { deferUi = false } = {}) {
    const started = this.now();
    // The owner asked for this scan ("Scan now", the chat): recheck every
    // open question, not only the new, changed or due ones.
    this.forceReview = reason === "owner-scan" || reason === "chat";
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

    // Conductor-hosted Codex threads learn which Conductor session shows them.
    const threads = linkUiHosts(mergeThreads({ codex: codexThreads ?? [], claude: claudeThreads ?? [], conductor: conductorThreads ?? [] }));
    const manager = (d.findManagerSession ?? conductor.findManagerSession)(config, threads) ?? null;
    const inScope = threads
      .filter((thread) => !thread.excluded)
      .sort((a, b) => String(b.lastActivityAt ?? "").localeCompare(String(a.lastActivityAt ?? "")))
      .slice(0, config.limits.maxThreads);

    const localGit = await this.readGit(inScope, config, run, sourceErrors);
    await this.resolvePrRefs(inScope, localGit, config, run, sourceErrors);
    const unreadPrs = new Set();
    const prs = this.withSettledPrs(await this.fetchPrs(inScope, config, run, sourceErrors, unreadPrs), unreadPrs);

    const infra = {
      bb3: bb3 ?? { ...emptyBb3(), error: this.skip.bb3 ? "skipped" : (sourceErrors.bb3 ?? null) },
      lb: { healthy: lb?.healthy ?? null, detail: lb?.detail ?? null, watchLine: lb?.watchLine ?? null, recentErrors: lbErrors ?? [], errorsUnknown: Boolean(sourceErrors.lbErrors) },
      localVerify: (localVerify ?? []).map((row) => ({ ...row, threadKey: processes.matchThreadByCwd(row.cwd, inScope) }))
    };

    const playbooks = this.playbooks();
    const store = this.store;
    const mutedKeys = store.mutedKeys();
    // Computer-use readiness, once per tick; the driver re-checks at each send.
    const delivery = await this.probeDelivery();
    const items = [];
    for (const thread of inScope) {
      const pr = prs.get(thread.prRefs?.[0]) ?? null;
      // No result for a worktree means git timed out or threw: unknown, not clean.
      const git = localGit.get(thread.cwd) ?? (thread.cwd ? { unreadable: true } : null);
      const gitUnreadable = Boolean(git?.unreadable);
      // A linked PR GitHub could not answer (gh failed or timed out) is unknown, not gone.
      const prUnreadable = !pr && unreadPrs.has(thread.prRefs?.[0]);
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
        decision = decideThread(classified, thread, { ledger: store.ledgerFor(thread.key), escalationLedger: store, mutedKeys, playbooks, config, now: started, pr, mode, infra, manager, delivery });
      }
      items.push({ thread, classified, pr, ledger: store.ledgerFor(thread.key), decision, gitUnreadable, prUnreadable });
    }

    const byItem = new Map(items.map(({ thread }) => [thread.key, thread]));
    const blockedKeys = { bb3: this.rememberedBlocked("bb3", byItem), lb: this.rememberedBlocked("lb", byItem) };
    const infraDecisions = decideInfra(infra, { ledger: store, playbooks, config, now: started, threads: items, manager, mode, blockedKeys, mutedKeys, delivery });
    // How long a nudge has waited on computer use, for telling the owner.
    // The live mode: the owner may have left Auto while this tick scanned.
    const queuedWaits = this.store.queuedAnswers().map((question) => ({ threadKey: question.threadKey, uiBlocked: true }));
    this.trackUiBlocked([...items.map((item) => item.decision), ...infraDecisions, ...queuedWaits], { mode: this.mode, delivery, threads, sourceErrors, started, config });
    const paused = pausedDeliveryDecision(delivery, this.uiBlockedSince, started);
    if (paused) infraDecisions.push(paused);
    const health = infraHealth(infra, { config, now: started });
    if (bb3) store.setInfraDown("bb3", health.bb3.down);
    if (lb) store.setInfraDown("lb", health.lb.down);

    // A muted thread keeps only its "muted by owner" line: nothing that
    // infra recovery or any other path decided for it may send or ask.
    const decisions = dedupeDecisions([...infraDecisions, ...items.map((item) => item.decision)])
      .filter((decision) => !mutedKeys.has(decision.threadKey) || decision.action === "none");
    const byKey = new Map(threads.map((thread) => [thread.key, thread]));
    if (manager) byKey.set(manager.key, manager);
    this.lastThreads = byKey;

    // A thread source that failed this tick is unknown, not empty: its
    // actions and questions wait for a tick that can see it.
    const unknownKinds = new Set(["codex", "claude", "conductor"].filter((kind) => sourceErrors[kind]));
    // A source that returned a full page may have evicted older live threads,
    // so a missing thread of that kind is not proof it is gone.
    const cappedKinds = new Set(["codex", "claude", "conductor"].filter((kind) => threads.filter((thread) => thread.kind === kind).length >= config.limits.maxThreads));
    const attempted = await this.act(decisions, { mode, byKey, manager, started, config, items, unknownKinds, cappedKinds, deferUi });
    this.trackInfraBlocked(health, items, blockedKeys, { recovering: infraDecisions, attempted, unknownKinds, mode, now: started });

    const finished = this.now();
    const snapshot = this.buildSnapshot({ reason, started, finished, mode, threads, inScope, items, decisions, infra, sourceErrors, manager, delivery });
    store.recordSnapshot(snapshot);
    this.lastTickAt = snapshot.at;
    try { this.runtime?.events?.emit?.("fleet", { at: snapshot.at, reason, counts: snapshot.counts }); } catch { /* listeners never break a tick */ }
    return snapshot;
  }

  // Remembered outage threads, minus any that moved on by themselves after
  // the infra came back (owner or agent active since): a late resume is stale.
  rememberedBlocked(kind, byItem) {
    const keys = this.store.infraBlocked(kind);
    const upAt = this.store.infraDown(kind) ? NaN : Date.parse(this.store.infraUpSince(kind) ?? "");
    if (!Number.isFinite(upAt)) return keys;
    const activeSince = (at) => Date.parse(at ?? "") > upAt;
    return keys.filter((key) => {
      const thread = byItem.get(key);
      return !thread || !(activeSince(thread.lastUserAt) || activeSince(thread.lastAgentAt));
    });
  }

  // While an outage lasts, remember every thread blocked on it; once it is up,
  // policy resumes them (it reads blockedKeys). Only a resume the send cap
  // held back is retried next tick; a wait means the owner or a recent nudge
  // already has the thread. A thread hidden by a failed source waits up to
  // RECOVERY_HOLD_MS for that source.
  trackInfraBlocked(health, items, previous, { recovering = [], attempted = new Set(), unknownKinds = new Set(), mode = "observe", now = this.now() } = {}) {
    for (const kind of INFRA_KINDS) {
      if (health[kind].down) {
        const current = items
          .filter(({ classified }) => classified.infraKind === kind && BLOCKED_STATES.has(classified.state))
          .map(({ thread }) => thread.key);
        this.store.setInfraBlocked(kind, [...previous[kind], ...current]);
      } else if (health[kind].up) {
        const pending = new Set(recovering
          .filter((decision) => !decision.threadKey.startsWith("infra:") && !attempted.has(decision.threadKey)
            && decision.action === "nudge" && mode === "auto" && decision.route)
          .map((decision) => decision.threadKey));
        const upAt = Date.parse(this.store.infraUpSince(kind) ?? "");
        const holdHidden = Number.isFinite(upAt) && now - upAt < RECOVERY_HOLD_MS;
        this.store.setInfraBlocked(kind, previous[kind].filter((key) => pending.has(key) || (holdHidden && unknownKinds.has(key.split(":")[0]))));
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
      // The local head tells a reused branch's new work from its old closed
      // PR, so a new head is a new lookup.
      const git = localGit.get(thread.cwd);
      const head = git?.branch === thread.branch ? (git.head ?? null) : null;
      const cached = this.branchLookups.get(cacheKey);
      const fresh = cached && now - cached.at < BRANCH_LOOKUP_TTL_MS;
      // An unknown head (git failed) keeps the cached answer, and so does a
      // thread past this tick's lookup budget: the last answer beats none.
      if (fresh && (head === null || cached.head === head || lookups >= MAX_BRANCH_LOOKUPS)) {
        if (cached.ref) thread.prRefs = [cached.ref];
        continue;
      }
      if (lookups >= MAX_BRANCH_LOOKUPS) continue;
      lookups += 1;
      try {
        const ref = await withTimeout(Promise.resolve(find(thread.repo, thread.branch, config, { run, head, cwd: head ? thread.cwd : null })), 20_000, "pr lookup");
        this.branchLookups.set(cacheKey, { ref: ref ?? null, at: now, head });
        if (ref) thread.prRefs = [ref];
      } catch (error) {
        sourceErrors.prLookup = clampText(error?.message, 200);
        if (cached?.ref) thread.prRefs = [cached.ref];
      }
    }
  }

  async fetchPrs(inScope, config, run, sourceErrors, unread = new Set()) {
    if (this.skip.github) return new Map();
    const refs = [...new Set(inScope.map((thread) => thread.prRefs?.[0]).filter((ref) => parsePrRef(ref)))];
    if (!refs.length) return new Map();
    try {
      const fetch = this.deps.fetchPrStates ?? github.fetchPrStates;
      return (await withTimeout(Promise.resolve(fetch(refs, config, { run, unread })), SOURCE_TIMEOUT_MS, "github")) ?? new Map();
    } catch (error) {
      sourceErrors.github = clampText(error?.message, 200);
      for (const ref of refs) unread.add(ref);
      return new Map();
    }
  }

  // MERGED and CLOSED are final. A ref GitHub could not answer this tick
  // keeps its last settled read, so an ask its merge settled is not raised
  // again as a new question. Only refs linked this tick stay remembered.
  withSettledPrs(prs, unread) {
    const out = new Map(prs);
    const kept = new Map();
    for (const [ref, pr] of prs) if (SETTLED_PR_STATES.has(pr?.state)) kept.set(ref, pr);
    for (const ref of unread) {
      const last = this.settledPrs.get(ref);
      if (!last) continue;
      kept.set(ref, last);
      out.set(ref, last);
    }
    this.settledPrs = kept;
    return out;
  }

  async act(decisions, { mode, byKey, manager, started, config, items = [], unknownKinds = new Set(), cappedKinds = new Set(), deferUi = false }) {
    const store = this.store;
    const fromFailedSource = (keys) => keys.some((key) => unknownKinds.has(String(key ?? "").split(":")[0]));
    // A thread whose git read or PR fetch failed this tick is unknown too: its
    // PR question must not close now and come back as a new push next tick.
    const gitUnknown = new Set(items.filter((item) => item.gitUnreadable || item.prUnreadable).map(({ thread }) => thread.key));
    const unknown = (keys) => fromFailedSource(keys) || keys.some((key) => gitUnknown.has(key));
    // With no settled read remembered (a fresh start), an unread PR cannot
    // tell a merge that settled an ask from a live one: an ask the
    // supervisor already closed waits for GitHub instead of coming back.
    const prUnknown = new Set(items.filter((item) => item.prUnreadable).map(({ thread }) => thread.key));
    const at = new Date(started).toISOString();
    const asked = new Set();
    const openActions = store.actions(config.limits.maxActionsKept).filter((action) => OPEN_ACTION.has(action.status));
    const seenActions = new Set();
    let sends = 0;
    // Threads a send was tried for this tick, whatever the outcome.
    const attempted = new Set();
    // One app thread can back two fleet threads (a Conductor session and the
    // Codex thread it hosts): type into it at most once per tick.
    const typedInto = new Set();

    const asks = decisions.filter((decision) => decision.action === "ask-user" && decision.question);
    // One the last review could not settle yet is still new.
    const shownBefore = new Set(store.openQuestions().map((question) => question.id).filter((id) => !this.awaitingReview.has(id)));
    const toNotify = [];
    for (const fields of groupQuestions(asks, byKey)) {
      // Rebuilt without a failed source's threads, a group would drop them,
      // or shrink to one thread and ask it twice; the open group stays as it
      // is until that source reads again.
      const spec = unknownKinds.size ? GROUPED_KINDS[fields.kind] : null;
      const covers = (q) => (fields.threadKeys ? true : (q.threadKeys ?? []).includes(fields.threadKey));
      const sameChoices = spec && (fields.threadKeys || JSON.stringify(fields.options) === JSON.stringify(spec.options));
      const open = sameChoices ? store.openQuestions().find((q) => q.dedupeKey === spec.dedupeKey && covers(q)) : null;
      if (open && fromFailedSource(open.threadKeys ?? [])) { asked.add(open.dedupeKey); continue; }
      if (fields.kind === "agent-ask" && prUnknown.has(fields.threadKey) && store.resolvedOnly(fields.dedupeKey)) continue;
      const question = store.upsertQuestion(fields);
      asked.add(question.dedupeKey);
      // The owner already answered or dismissed this one; stay quiet.
      if (question.suppressed) continue;
      toNotify.push({ id: question.id, reopened: Boolean(question.reopened) });
    }
    // The supervisor reviews its own list before a new question reaches the
    // owner, so junk never pings; the main does not see it before then either.
    this.awaitingReview = this.config.review?.enabled ? new Set(toNotify.map(({ id }) => id).filter((id) => !shownBefore.has(id))) : new Set();
    let unsettled = new Set();
    try {
      unsettled = await this.reviewOpenQuestions({ asked, byKey, items });
    } finally {
      // A new one the review did not get to (the batch cap, a deferred
      // close) waits for the next review; a failed review lets all out.
      this.awaitingReview = new Set([...this.awaitingReview].filter((id) => unsettled.has(id)));
    }
    for (const { id, reopened } of toNotify) {
      const question = store.question(id);
      if (question?.status !== "open" || this.awaitingReview.has(id)) continue;
      // A blip closed it: its own outreach copy comes back, not a new one.
      if (reopened) this.reopenOutreach(question);
      try { await this.notifier.notifyQuestion(question); } catch { /* notification is best-effort */ }
    }

    // A thread that just got the owner's answer gets no automatic nudge too.
    const answeredNow = await this.deliverQueuedAnswers({
      byKey, started, cappedKinds, asked, sourceUnknown: fromFailedSource, budget: config.limits.maxSendsPerTick, deferUi,
      decided: new Set(items.map((item) => item.thread.key))
    });
    // Kept answers share the tick's send budget, and their app conversations
    // (a Conductor tab and the Codex thread it hosts) get nothing else now.
    sends += answeredNow.sent;
    for (const key of answeredNow.uiKeys) typedInto.add(key);

    // Resumes first, then the thread tried longest ago, so a few threads that
    // cannot be reached never hold every slot while a stopped one waits.
    const lastTried = (decision) => Date.parse(store.ledgerFor(decision.threadKey).nudges.at(-1)?.at ?? "") || 0;
    const sendOrder = decisions
      .map((decision, index) => ({ decision, index, first: SEND_FIRST.has(decision.playbook) ? 0 : 1, tried: lastTried(decision) }))
      .sort((a, b) => a.first - b.first || a.tried - b.tried || a.index - b.index)
      .map(({ decision }) => decision);
    // Only a send that got past the app's checks spends a slot; blocked tries
    // are cheap but still bounded.
    let tries = 0;
    // A computer-use send that timed out or lost Open Computer Use leaves
    // the app agent busy or restarting: the rest of the tick's typing waits.
    let uiStalled = answeredNow.uiStalled === true;
    for (const decision of sendOrder) {
      if (!SENDING.has(decision.action) || !decision.message) continue;
      if (decision.notBefore && Date.parse(decision.notBefore) > started) continue;
      if (answeredNow.threads.has(decision.threadKey)) continue;
      const targetKey = decision.action === "escalate-manager" ? (decision.targetKey ?? manager?.key ?? null) : decision.threadKey;
      const target = targetKey ? byKey.get(targetKey) : null;
      const record = {
        threadKey: decision.threadKey, targetKey, playbook: decision.playbook, route: decision.route,
        message: decision.message, reason: decision.reason, progressMark: decision.progressMark ?? null, kind: decision.action
      };
      const existing = openActions.find((action) => action.threadKey === record.threadKey && action.playbook === record.playbook);
      if (existing) seenActions.add(existing.id);

      // The live mode, not the tick's: the owner may have left Auto mid-scan.
      const liveMode = this.mode;
      if (liveMode !== "auto" || !target || !decision.route) {
        const status = liveMode === "propose" && target && decision.route ? "proposed" : "planned";
        if (existing) store.updateAction(existing.id, { ...record, status, at });
        else store.recordAction({ ...record, status, at });
        continue;
      }
      if (sends >= config.limits.maxSendsPerTick || tries >= config.limits.maxSendsPerTick * 2) {
        decision.reason = `${decision.reason}; deferred: send cap`;
        continue;
      }
      if (uiStalled && decision.route === "computer-use") {
        decision.reason = `${decision.reason}; deferred: Open Computer Use stalled`;
        continue;
      }
      if (deferUi && decision.route === "computer-use") {
        decision.reason = `${decision.reason}; deferred: remote scan`;
        continue;
      }
      const uiKey = decision.route === "computer-use" ? uiTargetFor(target)?.targetKey ?? null : null;
      if (uiKey && typedInto.has(uiKey)) continue;
      if (uiKey) typedInto.add(uiKey);
      tries += 1;
      attempted.add(decision.threadKey);
      const delivery = await this.executor.deliver({ thread: target, message: decision.message, route: decision.route, playbook: decision.playbook, actionId: existing?.id ?? null });
      if (delivery.status !== "blocked") sends += 1;
      if (decision.route === "computer-use" && UI_STALLED.test(String(delivery.detail ?? ""))) uiStalled = true;
      if (!existing && !delivery.actionId) store.recordAction({ ...record, status: delivery.status, detail: delivery.detail, at });
      else if (delivery.actionId) store.updateAction(delivery.actionId, { reason: record.reason, message: record.message, threadKey: record.threadKey, targetKey });
      this.recordSend(record, delivery);
    }

    // A planned/proposed action the policy no longer wants is stale.
    for (const action of openActions) {
      if (!seenActions.has(action.id) && !unknown([action.threadKey])) store.updateAction(action.id, { status: "stale" });
    }
    // A question whose condition is gone closes itself once its thread was
    // decided again this tick without asking.
    for (const question of store.openQuestions()) {
      if (asked.has(question.dedupeKey)) continue;
      if (unknown(question.threadKeys ?? [question.threadKey])) continue;
      const decided = question.threadKey ? decisions.find((decision) => decision.threadKey === question.threadKey) : null;
      const supervisorOwned = !question.threadKey && /^(infra:|limit:group|open:group|deliver:group)/.test(String(question.dedupeKey ?? ""));
      // Its thread left the scan (aged out of the lookback) or is now out of
      // scope, while its source read fine: nothing is left to answer. A
      // source that hit its cap only proves absence for excluded threads.
      const known = question.threadKey ? byKey.get(question.threadKey) : null;
      const evictable = cappedKinds.has(String(question.threadKey ?? "").split(":")[0]);
      const threadGone = Boolean(question.threadKey) && (known ? Boolean(known.excluded) : !evictable);
      // A group member a capped scan left out may still be failing.
      if (!question.threadKey && (question.threadKeys ?? []).some((member) => !byKey.has(member) && cappedKinds.has(String(member).split(":")[0]))) continue;
      if (decided || supervisorOwned || threadGone) {
        const reason = decided ? `${decided.state}: ${decided.reason}` : threadGone ? `thread ${known?.excluded ?? "left the scan"}` : "no longer asked";
        store.resolveQuestion(question.id, reason);
        this.resolveOutreach(question, "resolved", "dismissed");
      }
    }
    this.closeExpired();
    return attempted;
  }

  // The supervisor manages its own needs-you list: one batched model call
  // judges which open questions still need the owner (see review.js). It
  // runs in every mode because it only edits the supervisor's own records
  // and outreach copies, never a thread. A failure fails open: the
  // questions go out as they would have without it. Returns the ids of
  // questions never reviewed that this review did not settle either.
  async reviewOpenQuestions({ asked, byKey, items = [] }) {
    const unsettled = new Set();
    const review = this.config.review;
    if (!review?.enabled) return unsettled;
    const store = this.store;
    const now = this.now();
    // Only questions asked this tick; the rest close or wait for their source.
    // The supervisor's own findings (it can't reach a thread, nudges made no
    // progress) are facts, not guesses about an agent: the review never
    // clears those.
    const open = store.openQuestions().filter((question) => asked.has(question.dedupeKey) && !SELF_FINDING_KINDS.has(question.kind));
    if (!open.length) return unsettled;
    if (this.lastReview.failedAt && now - this.lastReview.failedAt < REVIEW_RETRY_MS) return unsettled;
    const prs = new Map(items.filter((item) => item.pr?.ref).map((item) => [item.pr.ref, item.pr]));
    const states = new Map(items.map((item) => [item.thread.key, item.classified]));
    const scope = { threads: byKey, prs, states, limits: this.config.limits };
    const fingerprints = new Map(open.map((question) => [question.id, reviewFingerprint(question, scope)]));
    const unreviewed = (question) => !question.reviewedAt;
    const changed = (question) => Boolean(question.reviewedAt) && question.reviewFingerprint !== fingerprints.get(question.id);
    const backoff = (question) => 2 ** Math.min(question.reviewStreak ?? 0, REVIEW_BACKOFF_MAX);
    const due = (question) => now - Date.parse(question.reviewedAt ?? "") >= review.intervalMs * backoff(question);
    const forced = this.forceReview === true;
    const pending = forced ? open : open.filter((question) => unreviewed(question) || changed(question) || due(question));
    if (!pending.length) return unsettled;
    // Only a new question skips the gap, so a backlog past the batch cap
    // does not call the model every tick.
    if (!forced && !pending.some(unreviewed) && now - (this.lastReview.at ?? 0) < REVIEW_MIN_GAP_MS) return unsettled;
    // New, then changed, then the longest since its review: the batch cap
    // drops the tail, and the next review starts there.
    const rank = (question) => (unreviewed(question) ? 0 : changed(question) ? 1 : 2);
    const ordered = [...pending].sort((a, b) => rank(a) - rank(b) || String(a.reviewedAt ?? "").localeCompare(String(b.reviewedAt ?? "")));
    const others = open.filter((question) => !pending.includes(question));
    // One model call holds up to a batch; the owner's own scan keeps going
    // until every open question was rechecked (bounded).
    const settled = new Set();
    let remaining = ordered;
    for (let round = 0; remaining.length && round < (forced ? FORCED_REVIEW_ROUNDS : 1); round += 1) {
      let verdicts;
      try {
        const rest = [...others, ...ordered.filter((question) => !remaining.includes(question))];
        verdicts = await reviewQuestions({ questions: remaining, others: rest, contextFor: (question) => reviewContext(question, scope), runModel: this.reviewRunner, now, ownerNotes: loadOwnerNotes(this.dataDir) });
      } catch (error) {
        const detail = clampText(redactSecrets(error?.message ?? String(error)), 200);
        this.lastReview = { ...this.lastReview, failedAt: now, error: detail };
        store.recordAction({ kind: "review", playbook: "review", threadKey: null, status: "failed", reason: "review failed; questions go out unreviewed", detail });
        break;
      }
      this.lastReview = { at: now, failedAt: null, error: null };
      this.applyReview(verdicts, fingerprints);
      const answered = new Set(verdicts.map((verdict) => verdict.id));
      for (const verdict of verdicts) if (!verdict.deferred) settled.add(verdict.id);
      const next = remaining.filter((question) => !answered.has(question.id));
      if (next.length === remaining.length) break;
      remaining = next;
    }
    // A failed review lets every new question out, as before.
    if (this.lastReview.failedAt === now) return unsettled;
    for (const question of pending) if (unreviewed(question) && !settled.has(question.id)) unsettled.add(question.id);
    return unsettled;
  }

  applyReview(verdicts, fingerprints) {
    const store = this.store;
    const decisions = [];
    let deferred = 0;
    for (const verdict of verdicts) {
      // The owner may have answered or dismissed it while the model ran, or
      // be answering it now: the answer wins.
      const question = store.question(verdict.id);
      if (question?.status !== "open" || this.answering.has(verdict.id)) continue;
      // Over the close cap: left as it was for the next review.
      if (verdict.deferred) { deferred += 1; continue; }
      const fingerprint = fingerprints.get(question.id) ?? null;
      if (verdict.decision === "close") {
        const closed = store.closeByReview(question.id, { category: verdict.category, reason: verdict.reason, fingerprint, duplicateOf: verdict.duplicateOf ?? null });
        if (closed) {
          this.resolveOutreach(question, "resolved", "dismissed");
          store.recordAction({
            kind: "review", playbook: "review", threadKey: question.threadKey ?? null, questionId: question.id, status: "done",
            reason: clampText(`closed ${verdict.category}: ${question.title}. ${verdict.reason}`, 300)
          });
          decisions.push({ id: question.id, decision: "close", category: verdict.category, reason: verdict.reason, duplicateOf: verdict.duplicateOf ?? null });
          continue;
        }
      }
      // Only an agent's own question takes new choices: the others carry
      // meaning the supervisor acts on ("merged", "keep going", "added").
      const options = question.kind === "agent-ask" ? verdict.options ?? null : null;
      const kept = store.recordReview(question.id, { title: verdict.title ?? null, options, fingerprint, reason: verdict.reason, category: "live" });
      decisions.push({ id: question.id, decision: "keep", category: "live", reason: verdict.reason, title: kept?.title ?? question.title });
    }
    const closed = decisions.filter((decision) => decision.decision === "close").length;
    store.recordAction({
      kind: "review", playbook: "review", threadKey: null, status: "done",
      reason: `reviewed ${decisions.length}: ${closed} closed, ${decisions.length - closed} kept${deferred ? `, ${deferred} closes deferred` : ""}`, decisions
    });
  }

  buildSnapshot({ reason, started, finished, mode, threads, inScope, items, decisions, infra, sourceErrors, manager, delivery = null }) {
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
        health: threadHealth(classified.state, thread.error ?? null),
        reason: clampText(classified.reason, 160),
        blockers: (classified.blockers ?? []).slice(0, 6),
        pr: pr
          ? { ref: pr.ref, url: pr.url, state: pr.state, title: clampText(pr.title, 100), ci: pr.ci, unresolvedThreads: pr.unresolvedThreads, mergeState: pr.mergeState, head: String(pr.headOid ?? "").slice(0, 10) }
          : (thread.prRefs?.[0] ? { ref: thread.prRefs[0], url: null, state: null } : null),
        lastActivityAt: thread.lastActivityAt ?? null,
        lastAgentText: clampTail(thread.lastAgentText, 600),
        error: thread.error ? { kind: thread.error.kind, resetAt: thread.error.resetAt ?? null } : null,
        live: Boolean(thread.live),
        route: chooseRoute(thread, mode, delivery),
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
