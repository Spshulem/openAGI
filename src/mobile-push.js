import crypto from "node:crypto";
import { sealPushEnvelope } from "./mobile-push-envelope.js";

// Lock-screen Live Activity and "needs you" alerts for paired iPhones, sent
// through the push relay (relay/) as sealed envelopes the relay cannot read.
// See docs/superpowers/specs/2026-10-15-ios-supervisor-push-design.md.
//
// Driven by the same bus the dashboard's SSE uses: a "fleet" tick or an
// outreach change schedules one pass, which reads the supervisor's state and,
// per registration, starts/updates/ends the activity and alerts new open
// questions. Everything here is best-effort and must never throw into the
// supervisor or the route that triggered it: a relay outage costs a push,
// not a tick.
export const PUSH_RELAY_DEFAULT = "https://push.openagi.sh";

export const PUSH_TIMING = Object.freeze({
  debounceMs: 2_000,
  // Apple budgets Live Activity updates; a busy fleet must not burn them.
  updateEveryMs: 20_000,
  endAfterIdleMs: 2 * 60_000,
  dismissAfterMs: 15 * 60_000,
  // Apple ends a Live Activity at 8 h; restarting first keeps it on screen.
  restartAfterMs: 7.5 * 60 * 60_000,
  staleAfterMs: 30 * 60_000
});

const EVENTS = ["fleet", "outreach", "outreach-resolved"];
const GROUPS = ["you", "working", "waiting"];
const ROWS_MAX = 3;
const ROW_TITLE_MAX = 60;
const WAITING_ON_MAX = 40;
const ALERT_TITLE_MAX = 100;
const ALERT_BODY_MAX = 220;
const ALERT_OPTIONS_MAX = 3;
const ALERT_FALLBACK_TITLE = "Needs you";
// Same as Android's SupervisorAlerts.MAX_POSTS_PER_CHECK: a backlog drains
// over the following passes instead of five-plus pings at once.
const ALERTS_PER_PASS = 5;
// Same filter as Android: "dismiss" is the separate dismissal, and "open
// thread" asks for the agent's own app, so posting either answers nothing.
const NON_ACTIONS = new Set(["dismiss", "open thread"]);
// A backlog over the cap drains on a follow-up pass this long after.
const ALERT_BACKLOG_MS = 30_000;
const RETRY_MS = 30_000;
// The relay will not take this pass again; the phone must mint a new one.
const RENEW_ERRORS = new Set(["bad_pass", "pass_expired", "pass_revoked"]);
const SEALED_MAX = 3000;
const SEND_TIMEOUT_MS = 15_000;
const REPORTED_MAX = 50;

/// Cap a display string; the ellipsis counts toward the cap and the cut never
/// halves a surrogate pair (the same rule as Android's SupervisorAlerts.cap).
export function capText(value, max) {
  if (value.length <= max) return value;
  let end = max - 1;
  const code = value.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return `${value.slice(0, end).trimEnd()}…`;
}

const isoOrNull = (value) => (typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null);
const sinceMs = (row) => (row.since ? Date.parse(row.since) : -Infinity);

/// The activity plaintext (kind "activity") from FleetSupervisor.getState().
/// Active means a thread whose watch group is you, working or waiting.
export function buildActivity(state, now = new Date()) {
  const threads = Array.isArray(state?.snapshot?.threads) ? state.snapshot.threads : [];
  const counts = { you: 0, working: 0, waiting: 0 };
  const rows = [];
  for (const thread of threads) {
    const group = thread?.watch?.group;
    if (!GROUPS.includes(group)) continue;
    counts[group] += 1;
    const key = typeof thread.key === "string" ? thread.key : "";
    const title = (typeof thread.title === "string" ? thread.title.trim() : "") || key || "Untitled";
    const waitingOn = typeof thread.watch.waitingOn === "string" ? thread.watch.waitingOn.trim() : "";
    rows.push({
      key,
      title: capText(title, ROW_TITLE_MAX),
      group,
      waitingOn: waitingOn ? capText(waitingOn, WAITING_ON_MAX) : null,
      since: isoOrNull(thread.watch.since)
    });
  }
  rows.sort((a, b) => {
    const byGroup = GROUPS.indexOf(a.group) - GROUPS.indexOf(b.group);
    if (byGroup) return byGroup;
    const x = sinceMs(a);
    const y = sinceMs(b);
    return x === y ? 0 : y > x ? 1 : -1;
  });
  return { at: now.toISOString(), counts, rows: rows.slice(0, ROWS_MAX) };
}

export function alertOptions(options) {
  if (!Array.isArray(options)) return [];
  const kept = options.filter((option) => typeof option === "string" && option.trim()
    && !NON_ACTIONS.has(option.trim().toLowerCase()));
  return [...new Set(kept)].slice(0, ALERT_OPTIONS_MAX);
}

/// The alert plaintext (kind "alert") for one open question. Options pass
/// through untouched: the answer route accepts only an exact option string.
export function buildAlert(question) {
  const title = typeof question?.title === "string" ? question.title.trim() : "";
  const body = typeof question?.body === "string" ? question.body.trim() : "";
  return {
    questionId: question.id,
    title: capText(title || ALERT_FALLBACK_TITLE, ALERT_TITLE_MAX),
    body: capText(body, ALERT_BODY_MAX),
    options: alertOptions(question.options),
    threadKey: typeof question.threadKey === "string" ? question.threadKey : null
  };
}

// What decides "content changed": everything but the timestamp.
const contentHash = (activity) =>
  crypto.createHash("sha256").update(JSON.stringify({ counts: activity.counts, rows: activity.rows })).digest("hex");
const activeCount = (activity) => activity.counts.you + activity.counts.working + activity.counts.waiting;

export class MobilePush {
  constructor({
    store,
    supervisor,
    events = null,
    relayUrl = PUSH_RELAY_DEFAULT,
    fetch = globalThis.fetch,
    now = () => Date.now(),
    timers = { setTimeout, clearTimeout },
    timing = PUSH_TIMING,
    log = (line) => console.warn(line)
  }) {
    this.store = store;
    this.supervisor = supervisor;
    this.events = events;
    this.relayUrl = String(relayUrl || PUSH_RELAY_DEFAULT).replace(/\/+$/, "");
    this.fetch = fetch;
    this.now = now;
    this.timers = timers;
    this.timing = timing;
    this.log = log;
    // nodeId -> { pass, startedAt, lastHash, lastSentAt, lastYou, idleSince }.
    // Only startedAt is persisted (push.json); after a restart the rest is
    // rebuilt from it, and the next pass updates rather than starts.
    this.live = new Map();
    this.generations = new Map();
    this.reported = new Set();
    this.listener = () => this.changed();
    this.subscribed = false;
    this.stopped = false;
    this.debounceTimer = null;
    this.wakeTimer = null;
    this.flushing = null;
    this.again = false;
  }

  start() {
    this.stopped = false;
    if (this.subscribed || !this.events?.on) return;
    for (const name of EVENTS) this.events.on(name, this.listener);
    this.subscribed = true;
  }

  stop() {
    this.stopped = true;
    if (this.subscribed) {
      for (const name of EVENTS) this.events.off?.(name, this.listener);
      this.subscribed = false;
    }
    this.clearTimer("debounceTimer");
    this.clearTimer("wakeTimer");
  }

  /// Something the phone shows may have changed. One pass runs debounceMs
  /// after the first change of a burst.
  changed() {
    try {
      if (this.stopped) return;
      // Observe closes before debouncing delivery: a close and reopen may
      // otherwise collapse into a snapshot that still contains the same ID.
      let questions;
      try { questions = this.supervisor.getState()?.questions; }
      catch (error) { this.report(`could not read supervisor state: ${error?.message ?? error}`); }
      if (Array.isArray(questions)) {
        const open = new Set(questions.filter((q) => (q?.status ?? "open") === "open").map((q) => q?.id));
        for (const registration of this.store.list()) {
          const notified = registration.notified.filter((id) => open.has(id));
          if (notified.length !== registration.notified.length) this.store.setNotified(registration.nodeId, notified);
        }
      }
      if (this.debounceTimer) return;
      this.debounceTimer = this.setTimer(() => {
        this.debounceTimer = null;
        void this.flush();
      }, this.timing.debounceMs);
    } catch (error) {
      this.report(`could not schedule: ${error?.message ?? error}`);
    }
  }

  /// The phone registered again. With a new pass (a rotated token, a
  /// reinstall) its old activity is not ours to update: syncActivity sees the
  /// pass differ and the next change starts a new one. The same pass (the
  /// phone's routine re-POST) keeps the activity as it is.
  registrationChanged() {
    this.changed();
  }

  forget(nodeId) {
    this.generations.set(nodeId, (this.generations.get(nodeId) ?? 0) + 1);
    this.live.delete(nodeId);
  }

  /// The owner revoked the phone, so the phone never ends its own activity.
  /// Ended here, best effort, before the registration (and with it the only
  /// way to reach that activity) is dropped. Never rejects.
  async endActivity(registration) {
    if (!registration || registration.renew || registration.activities === false || registration.noLiveActivity) return;
    const live = this.live.get(registration.nodeId);
    if (live?.pass !== registration.pass && !registration.activity?.startedAt) return;
    let state = null;
    try { state = this.supervisor.getState(); } catch { /* end it empty */ }
    const now = this.now();
    try {
      await this.sendActivity(registration, "activity-end", buildActivity(state, new Date(now)), { dismissAt: this.epoch(now) });
    } catch (error) {
      this.report(`could not end ${registration.nodeId}'s Live Activity: ${error?.message ?? error}`);
    }
  }

  /// Run a pass now. Overlapping calls coalesce into one more pass; the
  /// promise never rejects.
  flush() {
    if (this.flushing) {
      this.again = true;
      return this.flushing;
    }
    this.flushing = (async () => {
      try {
        do {
          this.again = false;
          await this.pass();
        } while (this.again && !this.stopped);
      } catch (error) {
        this.report(`pass failed: ${error?.message ?? error}`);
      } finally {
        this.flushing = null;
      }
    })();
    return this.flushing;
  }

  async pass() {
    if (this.stopped) return;
    const registrations = this.store.list();
    if (!registrations.length) {
      this.live.clear();
      this.clearTimer("wakeTimer");
      return;
    }
    let state;
    try {
      state = this.supervisor.getState();
    } catch (error) {
      this.report(`could not read supervisor state: ${error?.message ?? error}`);
      return;
    }
    const now = this.now();
    const activity = buildActivity(state, new Date(now));
    const questions = Array.isArray(state?.questions)
      ? state.questions.filter((q) => typeof q?.id === "string" && q.id && (q.status ?? "open") === "open")
      : null;
    let wakeAt = null;
    const wakeBy = (due) => { if (due !== null && (wakeAt === null || due < wakeAt)) wakeAt = due; };
    for (const registration of registrations) {
      if (this.stopped) return;
      const generation = this.generations.get(registration.nodeId) ?? 0;
      const isCurrent = () => {
        const current = this.store.get(registration.nodeId);
        return !this.stopped && generation === (this.generations.get(registration.nodeId) ?? 0)
          && current?.pass === registration.pass && current?.key === registration.key;
      };
      if (!isCurrent()) continue;
      // Waiting for the phone to bring a new pass (POST /mobile/push answers
      // it renew: true); nothing more is sent with this one.
      if (registration.renew) {
        this.live.delete(registration.nodeId);
        continue;
      }
      const alerts = await this.sendAlerts(registration, questions, isCurrent);
      if (alerts.backlog) wakeBy(now + ALERT_BACKLOG_MS);
      if (alerts.stop) continue;
      wakeBy(await this.syncActivity(registration, activity, now, isCurrent));
    }
    this.scheduleWake(wakeAt);
  }

  // stop: the registration is gone or needs a new pass. backlog: open
  // questions are left over the per-pass cap.
  async sendAlerts(registration, questions, isCurrent) {
    if (!isCurrent()) return { stop: true, backlog: false };
    if (!questions) return { stop: false, backlog: false };
    const open = new Set(questions.map((q) => q.id));
    // Pruned to open ids, so a question that closes and reopens alerts again.
    const notified = registration.notified.filter((id) => open.has(id));
    // Permission affects delivery, not the history of questions that closed.
    if (registration.alerts === false) {
      this.store.setNotified(registration.nodeId, notified);
      return { stop: false, backlog: false };
    }
    const unsent = [...new Map(questions.filter((q) => !notified.includes(q.id)).map((q) => [q.id, q])).values()];
    const fresh = unsent.slice(0, ALERTS_PER_PASS);
    let sent = 0;
    for (const question of fresh) {
      const result = await this.send(registration, { type: "alert", sealed: this.sealAlert(registration.key, question), collapseId: question.id });
      if (!isCurrent()) return { stop: true, backlog: false };
      if (result === "gone" || result === "renew") return { stop: true, backlog: false };
      // Retry unsent questions even if no new fleet event arrives.
      if (result !== "ok") break;
      notified.push(question.id);
      sent += 1;
    }
    this.store.setNotified(registration.nodeId, notified);
    return { stop: false, backlog: unsent.length > sent };
  }

  // Returns when the next pass is due for this registration, or null.
  async syncActivity(registration, activity, now, isCurrent) {
    if (!isCurrent()) return null;
    const { nodeId } = registration;
    const t = this.timing;
    if (registration.activities === false || registration.noLiveActivity) {
      this.live.delete(nodeId);
      this.store.setActivity(nodeId, registration.pass, null);
      return null;
    }
    let live = this.live.get(nodeId) ?? null;
    if (live && live.pass !== registration.pass) {
      this.live.delete(nodeId);
      live = null;
    }
    if (!live) {
      // Read fresh, not from the pass's snapshot: an end earlier in this pass
      // (the 7.5 h restart) has already cleared it.
      const saved = this.store.get(nodeId);
      const startedAt = saved?.pass === registration.pass ? Date.parse(saved.activity?.startedAt ?? "") : NaN;
      if (Number.isFinite(startedAt)) {
        // A daemon restart: the phone still shows the activity we started.
        // What it shows is unknown, so the next pass updates it at once.
        live = { pass: registration.pass, startedAt, lastHash: null, lastSentAt: -Infinity, lastYou: Infinity, idleSince: null };
        this.live.set(nodeId, live);
      }
    }
    const active = activeCount(activity);
    const hash = contentHash(activity);

    if (!live) {
      if (active === 0) return null;
      const result = await this.sendActivity(registration, "activity-start", activity, { staleAt: this.epoch(now + t.staleAfterMs) });
      if (!isCurrent()) return null;
      if (result !== "ok") return result === "error" ? now + RETRY_MS : null;
      this.live.set(nodeId, { pass: registration.pass, startedAt: now, lastHash: hash, lastSentAt: now, lastYou: activity.counts.you, idleSince: null });
      this.store.setActivity(nodeId, registration.pass, { startedAt: new Date(now).toISOString() });
      return now + t.restartAfterMs;
    }

    if (active > 0 && now - live.startedAt >= t.restartAfterMs) {
      const ended = await this.sendActivity(registration, "activity-end", activity, { dismissAt: this.epoch(now) });
      if (!isCurrent()) return null;
      if (ended !== "ok") return now + RETRY_MS;
      this.live.delete(nodeId);
      this.store.setActivity(nodeId, registration.pass, null);
      return this.syncActivity(registration, activity, now, isCurrent);
    }

    if (active === 0) {
      live.idleSince ??= now;
      if (now - live.idleSince >= t.endAfterIdleMs) {
        const ended = await this.sendActivity(registration, "activity-end", activity, { dismissAt: this.epoch(now + t.dismissAfterMs) });
        if (!isCurrent()) return null;
        if (ended !== "ok") return now + RETRY_MS;
        this.live.delete(nodeId);
        this.store.setActivity(nodeId, registration.pass, null);
        return null;
      }
    } else {
      live.idleSince = null;
    }

    let due = active === 0 ? live.idleSince + t.endAfterIdleMs : live.startedAt + t.restartAfterMs;
    if (hash !== live.lastHash) {
      const nextAllowed = live.lastSentAt + t.updateEveryMs;
      if (now >= nextAllowed) {
        const rose = activity.counts.you > live.lastYou;
        const result = await this.sendActivity(registration, "activity-update", activity, {
          staleAt: this.epoch(now + t.staleAfterMs),
          ...(rose ? { priority: 10 } : {})
        });
        if (!isCurrent()) return null;
        if (result === "ok") Object.assign(live, { lastHash: hash, lastSentAt: now, lastYou: activity.counts.you });
        else if (result === "error") due = Math.min(due, now + RETRY_MS);
      } else {
        // The trailing send: the wake pass reads the latest state then.
        due = Math.min(due, nextAllowed);
      }
    }
    return due;
  }

  sendActivity(registration, type, activity, extra) {
    let plain = activity;
    let sealed = sealPushEnvelope(registration.key, "activity", plain);
    while (sealed.length > SEALED_MAX && plain.rows.length) {
      plain = { ...plain, rows: plain.rows.slice(0, -1) };
      sealed = sealPushEnvelope(registration.key, "activity", plain);
    }
    return this.send(registration, { type, sealed, ...extra });
  }

  sealAlert(key, question) {
    const plain = buildAlert(question);
    const sealed = sealPushEnvelope(key, "alert", plain);
    // Title and body are capped; only many long options can overflow. The
    // alert still says the supervisor needs the owner, and a tap opens it.
    return sealed.length > SEALED_MAX ? sealPushEnvelope(key, "alert", { ...plain, options: [] }) : sealed;
  }

  // "ok" | "gone" | "renew" | "error". Never throws, never logs a body.
  async send(registration, body) {
    let response;
    try {
      response = await this.fetch(`${this.relayUrl}/v1/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pass: registration.pass, ...body }),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS)
      });
    } catch (error) {
      this.report(`relay unreachable: ${error?.message ?? error}`);
      return "error";
    }
    let json = null;
    try { json = await response.json(); } catch { /* not JSON */ }
    if (json?.gone === true) {
      // Only the device token going means the phone is gone. A gone Live
      // Activity channel or start token leaves its alerts working.
      if (body.type === "alert") {
        this.dropGone(registration);
        return "gone";
      }
      this.alertsOnly(registration);
      return "error";
    }
    if (response.ok && json?.ok === true) {
      this.reported.clear();
      return "ok";
    }
    // The pass was registered without a push-to-start token: alerts only.
    if (response.status === 400 && RENEW_ERRORS.has(json?.error)) {
      this.live.delete(registration.nodeId);
      try { this.store.markRenew(registration.nodeId, registration.pass); } catch (error) {
        this.report(`could not record a pass to renew: ${error?.message ?? error}`);
      }
      this.report(`relay refused ${registration.nodeId}'s pass (${json.error}); waiting for the phone to renew it`);
      return "renew";
    }
    if (response.status === 400 && json?.error === "no_live_activity") {
      this.alertsOnly(registration);
      return "error";
    }
    const code = typeof json?.error === "string" ? json.error.slice(0, 80) : `HTTP ${response.status}`;
    this.report(`relay refused ${body.type}: ${code}`);
    return "error";
  }

  alertsOnly(registration) {
    this.live.delete(registration.nodeId);
    try { this.store.markNoLiveActivity(registration.nodeId, registration.pass); } catch (error) {
      this.report(`could not record an alerts-only pass: ${error?.message ?? error}`);
    }
  }

  // Only the pass the send used: a phone that re-registered meanwhile keeps
  // its new registration.
  dropGone({ nodeId, pass }) {
    if (this.live.get(nodeId)?.pass === pass) this.live.delete(nodeId);
    let removed = false;
    try {
      removed = this.store.removeIfPass(nodeId, pass);
    } catch (error) {
      this.report(`could not remove a gone registration: ${error?.message ?? error}`);
    }
    if (removed) this.log(`[openagi] mobile push: ${nodeId}'s push registration is gone at APNs; removed it`);
  }

  scheduleWake(at) {
    this.clearTimer("wakeTimer");
    if (at === null || this.stopped) return;
    this.wakeTimer = this.setTimer(() => {
      this.wakeTimer = null;
      void this.flush();
    }, Math.max(0, at - this.now()));
  }

  setTimer(fn, ms) {
    const handle = this.timers.setTimeout(fn, ms);
    handle?.unref?.();
    return handle;
  }

  clearTimer(name) {
    if (this[name]) this.timers.clearTimeout(this[name]);
    this[name] = null;
  }

  // APNs stale-date and dismissal-date are UNIX seconds.
  epoch(ms) {
    return Math.floor(ms / 1000);
  }

  // One line per distinct problem until a send succeeds again.
  report(message) {
    if (this.reported.has(message)) return;
    if (this.reported.size >= REPORTED_MAX) this.reported.clear();
    this.reported.add(message);
    this.log(`[openagi] mobile push: ${message}`);
  }
}
