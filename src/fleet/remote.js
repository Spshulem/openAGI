// Fleet stays on the coding computer. Main reaches it over the existing
// enrolled-node control channel; no owner token, shell, or arbitrary URL crosses it.
import { createFleetRoute } from './routes.js';

export function createFleetCapability(supervisor) {
  const route = createFleetRoute({ supervisor });
  return {
    async health() {
      return { capability: { id: 'fleet-supervisor', ready: true, operations: ['request'], detail: 'Fleet on this computer' } };
    },
    async invoke(operation, payload) {
      if (operation !== 'request' || !payload || typeof payload.path !== 'string'
          || !/^\/fleet\/api\/(state|scan|mode|send|questions\/[A-Za-z0-9_-]{1,80}|actions\/[A-Za-z0-9_-]{1,80}\/send)$/.test(payload.path)
          || !['GET', 'POST'].includes(payload.method)) throw new Error('Unsupported fleet request');
      const response = await route(payload.method, payload.path, new URL(payload.path, 'http://localhost'), async () => payload.body ?? {});
      return { response, state: supervisor.getState() };
    }
  };
}

const REQUEST_TIMEOUT_MS = 120000;
// A request that types into an app waits for the whole UI delivery (a Codex
// one runs 1-3 min, plus clearing on failure). The broker's own ceiling, so
// the main does not report a failure for an answer the Mac then sends.
const DELIVERY_TIMEOUT_MS = 5 * 60 * 1000;
const DELIVERING = /^\/fleet\/api\/(send|questions\/[^/]+|actions\/[^/]+\/send)$/;

export class RemoteFleetSupervisor {
  constructor({ runtime, nodeId, intervalMs = 30000 }) {
    this.runtime = runtime;
    this.nodeId = nodeId;
    this.intervalMs = intervalMs;
    this.state = { mode: 'observe', enabled: true, running: false, lastTickAt: null, lastError: 'Waiting for the fleet computer', snapshot: null, questions: [], actions: [], settings: { remoteNode: nodeId } };
    this.refreshing = null;
    this.timer = null;
    // Glasses dismissals the computer was offline for, sent on the next refresh.
    this.pendingDismissals = new Set();
  }
  getState() { return structuredClone(this.state); }
  async request(method, path, body) {
    let reached = false;
    try {
      const result = await this.runtime.nodeCapabilities.dispatch(this.nodeId, 'fleet-supervisor', 'request', { method, path, body }, { timeoutMs: method === 'POST' && DELIVERING.test(path) ? DELIVERY_TIMEOUT_MS : REQUEST_TIMEOUT_MS });
      if (!result?.state || !Array.isArray(result.state.questions) || !Array.isArray(result.state.actions)) throw new Error('Invalid fleet response');
      reached = true;
      this.state = { ...result.state, settings: { ...result.state.settings, remoteNode: this.nodeId } };
      this.mirrorQuestions();
      if (result.response?.status !== 200) throw new Error(result.response?.body?.error || 'Fleet request failed');
      return result.response.body;
    } catch (error) {
      this.state.lastError = 'Fleet computer unavailable or request failed. Retry when it is online.';
      // Preserve the last snapshot/questions through connection outages.
      throw Object.assign(new Error(this.state.lastError), { reached });
    }
  }
  refresh() {
    if (!this.refreshing) {
      this.refreshing = this.request('GET', '/fleet/api/state')
        .then(async (body) => { await this.replayDismissals(); return body; })
        .finally(() => { this.refreshing = null; });
    }
    return this.refreshing;
  }
  async tick() { await this.request('POST', '/fleet/api/scan'); return this.state.snapshot; }
  async setMode(mode) { await this.request('POST', '/fleet/api/mode', { mode }); return this.state.mode; }
  async answerQuestion(id, answer) { return this.request('POST', `/fleet/api/questions/${id}`, { answer }); }
  // replay: a dismissal that could not reach the computer is kept and sent
  // again once it is back (the glasses already dropped the question).
  async dismissQuestion(id, { replay = false } = {}) {
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
  async sendOwnerMessage(threadKey, message) { return this.request('POST', '/fleet/api/send', { threadKey, message }); }
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
    const openIds = new Set(this.state.questions.map(q => q.id));
    for (const item of outreach.list()) {
      if (item.sourceRef?.kind === 'fleet' && item.sourceRef.nodeId === this.nodeId
          && ['unseen', 'seen'].includes(item.status) && !openIds.has(item.sourceRef.id)) {
        outreach.resolve(item.id, 'resolved', { status: 'dismissed' });
      }
    }
    const items = outreach.list();
    for (const q of this.state.questions) {
      const shown = { title: q.title, summary: q.body, actions: [...(q.options ?? []), "dismiss"] };
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
