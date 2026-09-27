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
          || !/^\/fleet\/api\/(state|scan|mode|questions\/[A-Za-z0-9_-]{1,80}|actions\/[A-Za-z0-9_-]{1,80}\/send)$/.test(payload.path)
          || !['GET', 'POST'].includes(payload.method)) throw new Error('Unsupported fleet request');
      const response = await route(payload.method, payload.path, new URL(payload.path, 'http://localhost'), async () => payload.body ?? {});
      return { response, state: supervisor.getState() };
    }
  };
}

export class RemoteFleetSupervisor {
  constructor({ runtime, nodeId, intervalMs = 30000 }) {
    this.runtime = runtime;
    this.nodeId = nodeId;
    this.intervalMs = intervalMs;
    this.state = { mode: 'observe', enabled: true, running: false, lastTickAt: null, lastError: 'Waiting for the fleet computer', snapshot: null, questions: [], actions: [], settings: { remoteNode: nodeId } };
    this.refreshing = null;
    this.timer = null;
  }
  getState() { return structuredClone(this.state); }
  async request(method, path, body, { preserveOutreachDecisionFor = null } = {}) {
    try {
      // Peer relays may take 180 seconds on the coding Mac. Leave time for
      // its result to return before telling the owner that delivery failed.
      const result = await this.runtime.nodeCapabilities.dispatch(this.nodeId, 'fleet-supervisor', 'request', { method, path, body }, { timeoutMs: 200000 });
      if (!result?.state || !Array.isArray(result.state.questions) || !Array.isArray(result.state.actions)) throw new Error('Invalid fleet response');
      this.state = { ...result.state, settings: { ...result.state.settings, remoteNode: this.nodeId } };
      this.mirrorQuestions({ preserveOutreachDecisionFor });
      if (result.response?.status !== 200) throw new Error(result.response?.body?.error || 'Fleet request failed');
      return result.response.body;
    } catch (error) {
      this.state.lastError = 'Fleet computer unavailable or request failed. Retry when it is online.';
      // Preserve the last snapshot/questions through connection outages.
      throw new Error(this.state.lastError);
    }
  }
  refresh() {
    if (!this.refreshing) this.refreshing = this.request('GET', '/fleet/api/state').finally(() => { this.refreshing = null; });
    return this.refreshing;
  }
  async tick() { await this.request('POST', '/fleet/api/scan'); return this.state.snapshot; }
  async setMode(mode) { await this.request('POST', '/fleet/api/mode', { mode }); return this.state.mode; }
  async answerQuestion(id, answer) { return this.request('POST', `/fleet/api/questions/${id}`, { answer }); }
  async dismissQuestion(id, { preserveOutreachDecision = false } = {}) {
    return (await this.request('POST', `/fleet/api/questions/${id}`, { dismiss: true },
      { preserveOutreachDecisionFor: preserveOutreachDecision ? id : null })).question;
  }
  async sendProposed(id) { return this.request('POST', `/fleet/api/actions/${id}/send`); }
  start() {
    if (this.timer) return;
    this.refresh().catch(() => {});
    this.timer = setInterval(() => this.refresh().catch(() => {}), this.intervalMs);
    this.timer.unref?.();
  }
  stop() { clearInterval(this.timer); this.timer = null; }
  mirrorQuestions({ preserveOutreachDecisionFor = null } = {}) {
    const outreach = this.runtime.outreach;
    if (!outreach) return;
    const openIds = new Set(this.state.questions.map(q => q.id));
    for (const item of outreach.list()) {
      if (item.sourceRef?.kind === 'fleet' && ['unseen', 'seen'].includes(item.status)
          && (item.sourceRef.nodeId !== this.nodeId
            || (!openIds.has(item.sourceRef.id) && item.sourceRef.id !== preserveOutreachDecisionFor))) {
        outreach.resolve(item.id, 'resolved', { status: 'dismissed' });
      }
    }
    for (const q of this.state.questions) {
      outreach.append({ type: 'fleet-question', sourceRef: { kind: 'fleet', id: q.id, nodeId: this.nodeId },
        title: q.title, summary: q.body, needsDecision: true,
        actions: [...(q.options ?? []), "dismiss"], dedupeOpen: true });
    }
  }
}
