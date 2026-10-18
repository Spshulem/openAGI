// Fleet stays on the coding computer. Main reaches it over the existing
// enrolled-node control channel; no owner token, shell, or arbitrary URL crosses it.
import path from "node:path";
import { randomUUID } from "node:crypto";
import { resolveFleetConfig } from "./contracts.js";
import { fixRevision } from "./feedback.js";
import { FleetStore } from "./store.js";
import { THREAD_KIND_PATTERN } from './contracts.js';
import { createFleetRoute } from './routes.js';
import { assertFixAllowed, suggestionFix } from './suggestions.js';

const THREAD_ROUTE = new RegExp(String.raw`^\/fleet\/api\/(state|scan|mode|send|screen|click|feedback|diagnose|suggestions|suggestions\/[A-Za-z0-9_-]{1,80}|fixes|fixes\/[A-Za-z0-9_-]{1,80}\/(stop|revise)|apps\/(conductor|codex)\/(open|quit|restart|running)|questions\/[A-Za-z0-9_-]{1,80}|actions\/[A-Za-z0-9_-]{1,80}\/send|threads\/(?:${THREAD_KIND_PATTERN})(:|%3A)[A-Za-z0-9_.-]{1,120}(\/(push|mute|unmute))?)$`);

export function createFleetCapability(supervisor) {
  const route = createFleetRoute({ supervisor });
  return {
    async health() {
      return { capability: { id: 'fleet-supervisor', ready: true, operations: ['request'], detail: 'Fleet on this computer' } };
    },
    // expiresAt: the broker's deadline for this command (from its dispatch,
    // so time queued before this Mac picked it up counts): app sends end
    // inside it.
    async invoke(operation, payload, { expiresAt = null } = {}) {
      if (operation !== 'request' || !payload || typeof payload.path !== 'string'
          || !THREAD_ROUTE.test(payload.path)
          || !['GET', 'POST'].includes(payload.method)) throw new Error('Unsupported fleet request');
      const deadlineAt = Date.parse(expiresAt ?? '');
      const url = new URL(payload.path, 'http://localhost');
      if (payload.path === '/fleet/api/diagnose') for (const key of ['window', 'area']) {
        if (typeof payload.body?.[key] === 'string') url.searchParams.set(key, payload.body[key]);
      }
      const response = await route(payload.method, payload.path, url, async () => payload.body ?? {},
        { deadlineAt: Number.isFinite(deadlineAt) ? deadlineAt : null, remote: true });
      return { response, state: supervisor.getState() };
    }
  };
}

const REQUEST_TIMEOUT_MS = 120000;
// A request that types into an app waits for the whole UI delivery (a Codex
// one runs 1-3 min): uiDeliveryTimeoutMs, then uiCleanupMs for clearing on
// failure and putting the owner's app back, which the driver never runs
// past. Both count from the request's start (probes, lock wait and earlier
// sends in it included), and end inside the command's expiresAt (time queued
// before the Mac picked it up included). The broker's own ceiling (dispatch
// in src/node-control.js), so the main does not report a failure for an
// answer the Mac then sends.
const DELIVERY_TIMEOUT_MS = 5 * 60 * 1000;
// A click waits for the card to go; an app quit or restart for the app.
const DELIVERING = /^\/fleet\/api\/(send|click|apps\/[^/]+\/[^/]+|questions\/[^/]+|actions\/[^/]+\/send|threads\/[^/]+\/push)$/;

export class RemoteFleetSupervisor {
  constructor({ runtime, nodeId, intervalMs = 30000, dataDir = null }) {
    this.runtime = runtime;
    this.nodeId = nodeId;
    this.intervalMs = intervalMs;
    this.selfFixHub = dataDir ? new SelfFixHub({ runtime, store: new FleetStore({ dir: path.join(dataDir, "fleet-self-fix") }) }) : null;
    this.state = { mode: 'observe', enabled: true, running: false, lastTickAt: null, lastError: 'Waiting for the fleet computer', snapshot: null, questions: [], actions: [], settings: { remoteNode: nodeId } };
    this.refreshing = null;
    this.timer = null;
    this.pendingOutreachDecisions = new Map();
    // Glasses dismissals the computer was offline for, sent on the next refresh.
    this.pendingDismissals = new Set();
    this.lastEmitted = null;
  }
  getState() {
    const state = structuredClone(this.state);
    if (this.selfFixHub) {
      state.fixes = this.selfFixHub.store.fixes();
      state.questions = [...state.questions, ...this.selfFixHub.store.openQuestions()];
    }
    return state;
  }
  beginOutreachDecision(id) {
    this.pendingOutreachDecisions.set(id, (this.pendingOutreachDecisions.get(id) ?? 0) + 1);
  }
  finishOutreachDecision(id) {
    const count = this.pendingOutreachDecisions.get(id) ?? 0;
    if (count <= 1) this.pendingOutreachDecisions.delete(id);
    else this.pendingOutreachDecisions.set(id, count - 1);
  }
  async request(method, path, body) {
    let reached = false;
    let status = null;
    try {
      const result = await this.runtime.nodeCapabilities.dispatch(this.nodeId, 'fleet-supervisor', 'request', { method, path, body }, { timeoutMs: method === 'POST' && DELIVERING.test(path) ? DELIVERY_TIMEOUT_MS : REQUEST_TIMEOUT_MS });
      if (!result?.state || !Array.isArray(result.state.questions) || !Array.isArray(result.state.actions)) throw new Error('Invalid fleet response');
      reached = true;
      this.state = { ...result.state, settings: { ...result.state.settings, remoteNode: this.nodeId } };
      this.mirrorQuestions();
      status = result.response?.status ?? null;
      if (status !== 200) throw new Error(result.response?.body?.error || 'Fleet request failed');
      return result.response.body;
    } catch (error) {
      const missingThread = reached && status === 404 && method === 'GET' && /^\/fleet\/api\/threads\/[^/]+$/.test(path);
      if (!missingThread) this.state.lastError = 'Fleet computer unavailable or request failed. Retry when it is online.';
      // Preserve the last snapshot/questions through connection outages.
      throw Object.assign(new Error(missingThread ? error.message : this.state.lastError), { reached, status });
    }
  }
  refresh() {
    if (!this.refreshing) {
      this.refreshing = this.request('GET', '/fleet/api/state')
        .then(async (body) => { await this.selfFixHub?.sync().catch(() => {}); return body; })
        .then(async (body) => { await this.replayDismissals(); return body; })
        .then((body) => { this.emitIfChanged(); return body; })
        .finally(() => { this.refreshing = null; });
    }
    return this.refreshing;
  }
  // The main's push sender listens for "fleet" like a local supervisor's
  // tick. Only a new snapshot or a changed set of open questions is news.
  emitIfChanged() {
    try {
      const state = this.getState();
      const signature = JSON.stringify([state.snapshot?.at ?? null, state.questions.map(q => q.id).sort()]);
      if (signature === this.lastEmitted) return;
      this.lastEmitted = signature;
      this.runtime?.events?.emit?.("fleet", { at: state.snapshot?.at ?? null, reason: "remote-refresh", counts: state.snapshot?.counts ?? null });
    } catch { /* listeners never break a refresh */ }
  }
  async tick() { await this.request('POST', '/fleet/api/scan'); return this.state.snapshot; }
  async setMode(mode) { if (mode === "observe") await this.selfFixHub?.stop("all"); await this.request('POST', '/fleet/api/mode', { mode }); return this.state.mode; }
  async answerQuestion(id, answer) {
    if (this.selfFixHub?.store.question(id)) return this.selfFixHub.answer(id, answer);
    const card = this.state.questions.find(q => q.id === id);
    if (this.selfFixHub && card?.kind === 'suggestion' && answer === 'Fix it' && (card.options ?? []).includes(answer)) {
      const result = await this.respondSuggestion(card.meta?.suggestionId, answer);
      return { question: { ...card, status: 'answered', answer }, delivery: null, fix: result?.fix ?? null };
    }
    return this.request('POST', `/fleet/api/questions/${id}`, { answer });
  }
  // replay: a dismissal that could not reach the computer is kept and sent
  // again once it is back (the glasses already dropped the question).
  async dismissQuestion(id, { replay = false } = {}) {
    if (this.selfFixHub?.store.question(id)) return this.selfFixHub.store.dismissQuestion(id);
    try {
      const body = await this.request('POST', `/fleet/api/questions/${id}`, { dismiss: true });
      this.pendingDismissals.delete(id);
      return body.question;
    } catch (error) {
      if (replay && !error.reached) this.pendingDismissals.add(id);
      else this.pendingDismissals.delete(id);
      throw error;
    }
  }
  async replayDismissals() {
    for (const id of [...this.pendingDismissals]) {
      // Closed on the computer meanwhile: nothing left to dismiss.
      if (!this.state.questions.some(q => q.id === id)) { this.pendingDismissals.delete(id); continue; }
      try { await this.dismissQuestion(id, { replay: true }); } catch { /* kept if still unreachable */ }
    }
  }
  // Brings back a question the computer's review closed.
  async reopenReviewed(id) { return (await this.request('POST', `/fleet/api/questions/${id}`, { reopen: true })).question; }
  async sendProposed(id) { return this.request('POST', `/fleet/api/actions/${id}/send`); }
  async sendOwnerMessage(threadKey, message, { queue = false } = {}) { return this.request('POST', '/fleet/api/send', { threadKey, message, ...(queue === true ? { queue: true } : {}) }); }
  async screenThread(threadKey) {
    const { state: _state, ...screen } = await this.request('POST', '/fleet/api/screen', { threadKey });
    return screen;
  }
  async clickThread(threadKey, label, { stateId = null } = {}) {
    const body = await this.request('POST', '/fleet/api/click', { threadKey, label, ...(stateId ? { stateId } : {}) });
    return { delivery: body.delivery ?? null, prompt: body.prompt ?? null };
  }
  // Feedback and self-fix requests live with the fleet, on the computer.
  async recordFeedback(input) { return (await this.request('POST', '/fleet/api/feedback', input)).feedback; }
  async feedback() { return (await this.request('GET', '/fleet/api/feedback')).feedback ?? []; }
  async diagnose(options = {}) { return this.request('GET', '/fleet/api/diagnose', options); }
  async suggestions() { return (await this.request('GET', '/fleet/api/suggestions')).suggestions ?? []; }
  // Fix it queues in this main's hub (where fixes are listed, revised and
  // stopped); the computer only links the suggestion to that fix id.
  async respondSuggestion(id, choice) {
    if (!this.selfFixHub || String(choice ?? '').toLowerCase() !== 'fix it') return this.request('POST', `/fleet/api/suggestions/${id}`, { choice });
    const { suggestion } = await this.request('GET', `/fleet/api/suggestions/${id}`);
    if (suggestion.status !== 'open') return { suggestion, fix: null };
    assertFixAllowed(this.selfFixHub.store, suggestion.area, Date.now());
    const fix = await this.selfFixHub.queue(suggestionFix(suggestion));
    return { ...(await this.request('POST', `/fleet/api/suggestions/${id}`, { choice, fixId: fix.id })), fix };
  }
  async queueFix(input) { if (this.selfFixHub) return this.selfFixHub.queue(input); return (await this.request('POST', '/fleet/api/fixes', input)).fix; }
  async fixes() { if (this.selfFixHub) return this.selfFixHub.store.fixes(); return (await this.request('GET', '/fleet/api/fixes')).fixes ?? []; }
  async reviseFix(id, instructions) { if (this.selfFixHub) return this.selfFixHub.revise(id, instructions); return (await this.request('POST', `/fleet/api/fixes/${id}/revise`, { instructions })).fix; }
  async stopFix(id) { if (this.selfFixHub) return this.selfFixHub.stop(id); return (await this.request('POST', `/fleet/api/fixes/${id}/stop`)).stopped ?? []; }

  // A thread the computer's last scan does not have is null, not an outage.
  async threadDetail(threadKey) {
    try {
      return (await this.request('GET', `/fleet/api/threads/${encodeURIComponent(threadKey)}`)).thread ?? null;
    } catch (error) {
      if (error.status === 404) return null;
      throw error;
    }
  }
  async pushNow(threadKey) {
    const body = await this.request('POST', `/fleet/api/threads/${encodeURIComponent(threadKey)}/push`);
    return { delivery: body.delivery ?? null, action: body.action ?? null };
  }
  async muteThread(threadKey, { hours } = {}) {
    return { until: (await this.request('POST', `/fleet/api/threads/${encodeURIComponent(threadKey)}/mute`, hours === undefined ? {} : { hours })).muted ?? null };
  }
  async unmuteThread(threadKey) {
    await this.request('POST', `/fleet/api/threads/${encodeURIComponent(threadKey)}/unmute`);
    return { until: null };
  }
  async runningInApp(app) {
    return (await this.request('GET', `/fleet/api/apps/${app}/running`)).running ?? null;
  }
  async appAction(app, action, { expectRunning = [] } = {}) {
    return (await this.request('POST', `/fleet/api/apps/${app}/${action}`, { expectRunning })).result;
  }
  start() {
    if (this.timer) return;
    this.refresh().catch(() => {});
    this.timer = setInterval(() => this.refresh().catch(() => {}), this.intervalMs);
    this.timer.unref?.();
  }
  stop() { clearInterval(this.timer); this.timer = null; }
  mirrorQuestions() {
    const outreach = this.runtime.outreach;
    if (!outreach) return;
    const openIds = new Set(this.getState().questions.map(q => q.id));
    for (const item of outreach.list()) {
      if (item.sourceRef?.kind === 'fleet' && ['unseen', 'seen'].includes(item.status)
          && (item.sourceRef.nodeId !== this.nodeId
            || (!openIds.has(item.sourceRef.id) && !this.pendingOutreachDecisions.has(item.sourceRef.id)))) {
        outreach.resolve(item.id, 'resolved', { status: 'dismissed' });
      }
    }
    const items = outreach.list();
    for (const q of this.getState().questions) {
      const shown = { title: q.title, summary: q.card || q.body, actions: [...(q.options ?? []), "dismiss"] };
      // A question the computer closed on a blip and reopened keeps its id:
      // its old copy comes back, so the glasses do not ping for it again.
      const last = q.reopenedAt ? items.find(item => item.sourceRef?.kind === 'fleet' && item.sourceRef.id === q.id && item.sourceRef.nodeId === this.nodeId) : null;
      const item = (last && outreach.reopen?.(last.id))
        || outreach.append({ type: 'fleet-question', sourceRef: { kind: 'fleet', id: q.id, nodeId: this.nodeId },
          ...shown, needsDecision: true, dedupeOpen: true });
      // A reworded question ("4 stuck" -> "5 stuck") updates that copy in place.
      if (item?.id) outreach.update?.(item.id, shown);
    }
  }
}

// Hub-owned records survive a Mac outage. Only the pinned coding node runs fixes.
export class SelfFixHub {
  constructor({ store, runtime, config = resolveFleetConfig(), nodeId = process.env.OPENAGI_CODING_SUPERVISOR_NODE }) {
    this.store = store; this.runtime = runtime; this.config = config; this.nodeId = nodeId;

  }
  async dispatch(operation, payload = {}) {
    if (!this.nodeId || !this.runtime?.nodeCapabilities?.dispatch) throw new Error("Coding node is offline or not configured.");
    const snapshot = await this.runtime.nodeCapabilities.dispatch(this.nodeId, "self-fix", operation, payload, { timeoutMs: 30000 });
    if (!Array.isArray(snapshot?.fixes) || !Array.isArray(snapshot?.selfSessions)) throw new Error("Invalid self-fix response.");
    for (const fix of snapshot.fixes) {
      const existing = this.store.fix(fix.id);
      if (!existing) continue;
      let revision = this.store.fixCommands()["revise:" + fix.id];
      if (revision && (fix.ownerRounds ?? 0) >= 1 && !fix.revisionRequests?.includes(revision.payload.requestId)) {
        this.store.clearFixCommand("revise:" + fix.id);
        revision = null;
      }
      if (revision && fix.state === "owner-ask" && !fix.revisionRequests?.includes(revision.payload.requestId)) continue;
      // A stop the Mac has not received yet wins over stale status.
      if (existing.state === "abandoned" && fix.state !== "abandoned") continue;
      const stateChanged = existing.state !== fix.state;
      this.store.updateFix(fix.id, fix);
      if (stateChanged && !snapshot.actions?.length) this.store.recordAction({ kind: "self-fix", fixId: fix.id, state: fix.state, status: fix.state === "failed" ? "failed" : "done" });
    }
    const knownActions = new Set(this.store.actions(1000).map((action) => action.id));
    for (const action of snapshot.actions ?? []) {
      if (action.kind === "self-fix" && this.store.fix(action.fixId) && !knownActions.has(action.id)) this.store.recordAction(action);
    }
    if (snapshot.areaLocks && typeof snapshot.areaLocks === "object") {
      this.store.state.fixLocks = structuredClone(snapshot.areaLocks);
      this.store._save();
    }
    for (const session of snapshot.selfSessions) this.store.addSelfSession(session.id, session.fixId);
    for (const question of snapshot.questions ?? []) {
      if (question.dedupeKey?.startsWith("self-fix:failed:") || question.dedupeKey === "self-fix:token") {
        if (this.store.state.questions.some((item) => item.dedupeKey === question.dedupeKey && ["answered", "dismissed"].includes(item.status))) continue;
      }
      if (question.kind === "self-fix" && this.store.fix(question.meta?.fixId)?.state !== "owner-ask") continue;
      this.store.upsertQuestion(question);
    }
    for (const fix of this.store.fixes().filter((item) => item.state !== "owner-ask")) {
      const question = this.store.openQuestions().find((item) => item.dedupeKey === "self-fix:" + fix.id);
      if (question) this.store.resolveQuestion(question.id);
    }
    return snapshot;
  }
  async queue(input) {
    if (this.config.selfFix.mode === "off") throw new Error("Self-fix is off.");
    if (input.auto && (this.config.selfFix.mode !== "auto" || !(input.confidence >= 0.8))) throw new Error("Auto fixes need high confidence and auto mode.");
    const fix = this.store.queueFix(input);
    if (input.auto) this.store.updateFix(fix.id, { auto: true, confidence: input.confidence });
    this.store.recordAction({ kind: "self-fix", fixId: fix.id, state: "queued", status: "done" });
    await this.dispatch("start", { fix: this.store.fix(fix.id), auto: input.auto, confidence: input.confidence }).catch(() => {});
    return this.store.fix(fix.id);
  }
  async sync() {
    if (!this.nodeId || !this.runtime?.nodeCapabilities?.dispatch) return;
    for (const [key, command] of Object.entries(this.store.fixCommands()).filter(([, command]) => command.operation === "stop")) {
      await this.dispatch(command.operation, command.payload);
      this.store.clearFixCommand(key);
    }
    if (Object.values(this.store.fixCommands()).some((command) => command.operation === "revise")) await this.dispatch("list");
    for (const fix of this.store.fixes().filter((item) => item.state === "queued" && !this.store.fixCommands()["revise:" + item.id])) await this.dispatch("start", { fix, auto: fix.auto, confidence: fix.confidence });
    for (const [key, command] of Object.entries(this.store.fixCommands()).filter(([, command]) => command.operation !== "stop")) {
      const fix = this.store.fix(command.payload.id);
      if (command.operation === "revise" && fix && ((fix.ownerRounds ?? 0) >= 1 || ["done", "failed", "abandoned"].includes(fix.state)) && !fix.revisionRequests?.includes(command.payload.requestId)) {
        this.store.clearFixCommand(key);
        continue;
      }
      await this.dispatch(command.operation, command.payload);
      this.store.clearFixCommand(key);
    }
    if (this.store.fixes().some((fix) => !["done", "failed", "abandoned"].includes(fix.state))) await this.dispatch("list");
  }
  async revise(id, instructions) {
    const fix = this.store.fix(id);
    if (!fix) return null;
    if (["done", "failed", "abandoned"].includes(fix.state)) throw new Error("Only running or open fixes can be revised.");
    if ((fix.ownerRounds ?? 0) >= 1 || this.store.fixCommands()["revise:" + id]) throw new Error("Owner revision round cap reached.");
    const command = { operation: "revise", payload: { id, instructions, requestId: randomUUID() } };
    // Validate locally but do not duplicate the revision on node readback.
    fixRevision(fix, instructions);
    this.store.queueFixCommand("revise:" + id, command);
    if (fix.state === "owner-ask") {
      this.store.resolveQuestion(this.store.openQuestions().find((question) => question.dedupeKey === "self-fix:" + id)?.id);
      this.store.updateFix(id, { state: "queued", pendingRevision: instructions });
    }
    await this.dispatch(command.operation, command.payload).then(() => this.store.clearFixCommand("revise:" + id)).catch(() => {});
    return this.store.fix(id);
  }
  async stop(id) {
    const stopped = this.store.stopFix(id);
    for (const [key, command] of Object.entries(this.store.fixCommands())) if (command.operation === "revise" && (id === "all" || command.payload.id === id)) this.store.clearFixCommand(key);
    const command = { operation: "stop", payload: { id } };
    this.store.queueFixCommand("stop:" + id, command);
    await this.dispatch(command.operation, command.payload).then(() => this.store.clearFixCommand("stop:" + id)).catch(() => {});
    return stopped;
  }
  async answer(id, answer) {
    const question = this.store.question(id);
    if (!question || question.status !== "open" || !question.options.includes(answer)) return null;
    if (question.kind !== "self-fix") return { question: this.store.answerQuestion(id, answer), delivery: { status: "sent", detail: "Acknowledged" } };
    const fixId = question.meta?.fixId;
    if (answer === "Request changes") return { question, delivery: { status: "blocked", detail: "Use self_fix_revise or POST fixes/" + fixId + "/revise with your change instructions." } };
    if (answer === "Close PR") await this.dispatch("close", { id: fixId });
    return { question: this.store.answerQuestion(id, answer), delivery: { status: "sent", detail: answer === "Review PR" ? question.prRef : "PR closed" } };
  }
}
