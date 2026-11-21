// Fleet stays on the coding computer. Main reaches it over the existing
// enrolled-node control channel; no owner token, shell, or arbitrary URL crosses it.
import path from "node:path";
import { randomUUID } from "node:crypto";
import { readJsonFile, writeJsonAtomic } from "../file-utils.js";
import { MODES, resolveFleetConfig } from "./contracts.js";
import { fixRevision } from "./feedback.js";
import { FleetStore } from "./store.js";
import { THREAD_KIND_PATTERN } from './contracts.js';
import { createFleetRoute } from './routes.js';
import { assertFixAllowed, suggestionFix } from './suggestions.js';
import { outreachActions } from './notify.js';
import { buildActiveSummary, buildCatchUpSummary, buildSupervisorCard, buildSupervisorDeck } from './cards.js';
import { batchActCards, normalizeBatchCardsInput } from './coordinator.js';
import { isSuppressedByQuietCadence, normalizePreferences } from './preferences.js';
import { rankCombinedSearchResults, searchFleet } from './search.js';

const THREAD_ROUTE = new RegExp(String.raw`^\/fleet\/api\/(state|scan|reconcile|mode|send|screen|click|feedback|diagnose|search|workspaces|hierarchy|active-work|active-work\/scan|active-work\/[A-Za-z0-9_-]{1,80}\/act|projects|projects\/[A-Za-z0-9_-]{1,80}|themes\/sync|dispatch|repo-status|preferences|route|tasks\/claim|sessions\/start|cards\/batch|cards\/[A-Za-z0-9:%_-]{1,160}\/act|suggestions|suggestions\/[A-Za-z0-9_-]{1,80}|fixes|fixes\/[A-Za-z0-9_-]{1,80}\/(stop|revise)|apps\/(conductor|codex)\/(open|quit|restart|running)|questions\/[A-Za-z0-9_-]{1,80}|actions\/[A-Za-z0-9_-]{1,80}\/send|threads\/(?:${THREAD_KIND_PATTERN})(:|%3A)[A-Za-z0-9_.-]{1,120}(\/(push|mute|unmute|transcript|organize|archive|unarchive))?)$`);

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
      if (payload.path === '/fleet/api/search') {
        if (typeof payload.body?.query === 'string') url.searchParams.set('query', payload.body.query);
        if (payload.body?.limit !== undefined) url.searchParams.set('limit', String(payload.body.limit));
      }
      if (payload.path === '/fleet/api/workspaces') {
        if (typeof payload.body?.query === 'string') url.searchParams.set('query', payload.body.query);
        if (payload.body?.includeArchived !== undefined) url.searchParams.set('includeArchived', String(Boolean(payload.body.includeArchived)));
        if (payload.body?.limit !== undefined) url.searchParams.set('limit', String(payload.body.limit));
      }
      if (payload.path === '/fleet/api/hierarchy') {
        if (typeof payload.body?.project === 'string') url.searchParams.set('project', payload.body.project);
        if (payload.body?.includeArchived !== undefined) url.searchParams.set('includeArchived', String(Boolean(payload.body.includeArchived)));
        if (payload.body?.limit !== undefined) url.searchParams.set('limit', String(payload.body.limit));
      }
      if (payload.path === '/fleet/api/active-work' && payload.method === 'GET') {
        if (typeof payload.body?.project === 'string') url.searchParams.set('project', payload.body.project);
        if (typeof payload.body?.theme === 'string') url.searchParams.set('theme', payload.body.theme);
        if (payload.body?.includeSnoozed !== undefined) url.searchParams.set('includeSnoozed', String(Boolean(payload.body.includeSnoozed)));
        if (payload.body?.includeDone !== undefined) url.searchParams.set('includeDone', String(Boolean(payload.body.includeDone)));
        if (payload.body?.limit !== undefined) url.searchParams.set('limit', String(payload.body.limit));
      }
      if (payload.path === '/fleet/api/repo-status') {
        if (typeof payload.body?.repo === 'string') url.searchParams.set('repo', payload.body.repo);
        if (typeof payload.body?.workspace === 'string') url.searchParams.set('workspace', payload.body.workspace);
        if (payload.body?.limit !== undefined) url.searchParams.set('limit', String(payload.body.limit));
      }
      if (/^\/fleet\/api\/threads\/[^/]+\/transcript$/.test(payload.path) && payload.body?.limit !== undefined) {
        url.searchParams.set('limit', String(payload.body.limit));
      }
      const response = await route(payload.method, payload.path, url, async () => payload.body ?? {},
        { deadlineAt: Number.isFinite(deadlineAt) ? deadlineAt : null, remote: true });
      return {
        response,
        state: supervisor.getState(),
        activeWork: typeof supervisor.getActiveWork === 'function' ? supervisor.getActiveWork() : null
      };
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
const DELIVERING = /^\/fleet\/api\/(send|click|route|dispatch|themes\/sync|tasks\/claim|sessions\/start|cards\/batch|cards\/[^/]+\/act|apps\/[^/]+\/[^/]+|questions\/[^/]+|actions\/[^/]+\/send|threads\/[^/]+\/(?:push|archive|unarchive))$/;

export class RemoteFleetSupervisor {
  constructor({ runtime, nodeId, intervalMs = 30000, dataDir = null }) {
    this.runtime = runtime;
    this.nodeId = nodeId;
    this.intervalMs = intervalMs;
    this.selfFixHub = dataDir ? new SelfFixHub({ runtime, store: new FleetStore({ dir: path.join(dataDir, "fleet-self-fix") }) }) : null;
    this.modeFile = dataDir ? path.join(dataDir, "fleet-remote-mode.json") : null;
    // Only the fleet computer knows its mode. Until it answers, this is the
    // last mode it reported (kept across restarts), or none: never a guess.
    this.reportedMode = this.lastReportedMode();
    this.state = { mode: this.reportedMode, enabled: true, running: false, lastTickAt: null, lastError: 'Waiting for the fleet computer', snapshot: null, questions: [], actions: [], settings: { remoteNode: nodeId } };
    this.refreshing = null;
    this.questionsAuthoritative = false;
    this.timer = null;
    this.pendingOutreachDecisions = new Map();
    // Glasses dismissals the computer was offline for, sent on the next refresh.
    this.pendingDismissals = new Set();
    this.lastEmitted = null;
    this.activeWorkSignature = null;
    this.requestSequence = 0;
    this.appliedSequence = 0;
  }
  lastReportedMode() {
    if (!this.modeFile) return null;
    try {
      const saved = readJsonFile(this.modeFile, null);
      // Another computer's report says nothing about this one.
      return saved?.nodeId === this.nodeId && MODES.includes(saved.mode) ? saved.mode : null;
    } catch {
      return null;
    }
  }
  noteReportedMode(mode) {
    if (mode === this.reportedMode || !MODES.includes(mode)) return;
    try {
      if (this.modeFile) writeJsonAtomic(this.modeFile, { nodeId: this.nodeId, mode });
      this.reportedMode = mode;
    } catch { /* unsaved: the next report writes it */ }
  }
  getState() {
    const state = structuredClone(this.state);
    state.questionsAuthoritative = this.questionsAuthoritative;
    state.modeConfirmed = this.questionsAuthoritative;
    const localFixQuestions = this.selfFixHub ? this.selfFixHub.store.openQuestions() : [];
    if (this.selfFixHub) {
      state.fixes = this.selfFixHub.store.fixes();
      state.questions = [...state.questions, ...localFixQuestions];
    }
    if (!Array.isArray(state.cards)) {
      const remoteAutonomy = state.autonomy ?? null;
      Object.assign(state, buildSupervisorDeck(state, { preferences: state.preferences }));
      if (remoteAutonomy) state.autonomy = remoteAutonomy;
    } else if (localFixQuestions.length > 0) {
      const prefs = normalizePreferences(state.preferences);
      const rowsByKey = new Map((state.snapshot?.threads ?? []).filter((r) => r?.key).map((r) => [r.key, r]));
      const actions = Array.isArray(state.actions) ? state.actions : [];
      const existingIds = new Set(state.cards.flatMap((c) => [c?.id, c?.questionId].filter(Boolean)));
      const localCards = localFixQuestions
        .filter((q) => q?.id && !existingIds.has(q.id) && !isSuppressedByQuietCadence(q, prefs))
        .map((q) => {
          const { rank: _rank, ...card } = buildSupervisorCard(q, { rowsByKey, actions, prefs });
          return card;
        });
      if (localCards.length > 0) {
        const nonPref = state.cards.filter((c) => c.kind !== 'preference');
        const prefCards = state.cards.filter((c) => c.kind === 'preference');
        state.cards = [...nonPref, ...localCards, ...prefCards];
        state.activeSummary = buildActiveSummary(state.snapshot, state.cards);
        state.catchUpSummary = buildCatchUpSummary(state.cards, state.activeSummary);
      }
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
    const sequence = ++this.requestSequence;
    let reached = false;
    let status = null;
    try {
      const isDelivering = method === 'POST' && (DELIVERING.test(path) || /^\/fleet\/api\/active-work\/[^/]+\/act$/.test(path));
      const result = await this.runtime.nodeCapabilities.dispatch(this.nodeId, 'fleet-supervisor', 'request', { method, path, body }, { timeoutMs: isDelivering ? DELIVERY_TIMEOUT_MS : REQUEST_TIMEOUT_MS });
      if (!result?.state || !Array.isArray(result.state.questions) || !Array.isArray(result.state.actions)) throw new Error('Invalid fleet response');
      reached = true;
      if (sequence >= this.appliedSequence) {
        this.appliedSequence = sequence;
        this.state = { ...result.state, settings: { ...result.state.settings, remoteNode: this.nodeId } };
        this.questionsAuthoritative = true;
        this.noteReportedMode(this.state.mode);
        this.mirrorQuestions();
        this.mirrorActiveWork(result.activeWork ?? result.response?.body?.activeWork ?? null);
        this.emitIfChanged();
      }
      status = result.response?.status ?? null;
      if (status !== 200) throw new Error(result.response?.body?.error || 'Fleet request failed');
      return result.response.body;
    } catch (error) {
      const rawMsg = String(error?.message ?? '');
      const unsupportedRoute = (reached && status === 404 && /unknown fleet route/i.test(rawMsg))
        || /unsupported fleet request|unknown fleet route/i.test(rawMsg);
      const missingThread = reached && status === 404 && method === 'GET' && /^\/fleet\/api\/threads\/[^/]+$/.test(path);
      const closedCard = reached && status === 404 && method === 'POST' && /^\/fleet\/api\/cards\/[^/]+\/act$/.test(path);
      const missingActiveWork = reached && status === 404 && method === 'POST' && /^\/fleet\/api\/active-work\/[^/]+\/act$/.test(path);
      const nonOutageError = missingThread || closedCard || missingActiveWork || unsupportedRoute;
      if (!nonOutageError && sequence >= this.appliedSequence) this.state.lastError = 'Fleet computer unavailable or request failed. Retry when it is online.';
      // Preserve the last snapshot/questions through connection outages.
      throw Object.assign(new Error(nonOutageError ? rawMsg : this.state.lastError), { reached, status, unsupportedRoute });
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
  // tick. Only a new snapshot or a changed set of open questions/cards is news.
  emitIfChanged() {
    try {
      const state = this.getState();
      const signature = JSON.stringify([
        state.mode,
        state.snapshot?.at ?? null,
        state.questions.map(q => q.id).sort(),
        (state.cards ?? []).map(c => c.id).sort(),
        this.activeWorkSignature,
        state.preferences?.mergePolicy ?? null,
        state.preferences?.cadence ?? null,
        state.preferences?.autoSlices ?? null
      ]);
      if (signature === this.lastEmitted) return;
      this.lastEmitted = signature;
      this.runtime?.events?.emit?.("fleet", { at: state.snapshot?.at ?? null, reason: "remote-refresh", counts: state.snapshot?.counts ?? null });
    } catch { /* listeners never break a refresh */ }
  }
  async tick() { await this.request('POST', '/fleet/api/scan'); return this.state.snapshot; }
  async setMode(mode) { if (mode === "observe") await this.selfFixHub?.stop("all"); await this.request('POST', '/fleet/api/mode', { mode }); return this.state.mode; }
  async answerQuestion(id, answer, { clarification = null } = {}) {
    if (this.selfFixHub?.store.question(id)) return this.selfFixHub.answer(id, answer);
    const card = this.state.questions.find(q => q.id === id);
    if (this.selfFixHub && card?.kind === 'suggestion' && answer === 'Fix it' && (card.options ?? []).includes(answer)) {
      const result = await this.respondSuggestion(card.meta?.suggestionId, answer);
      return { question: { ...card, status: 'answered', answer }, delivery: null, fix: result?.fix ?? null };
    }
    return this.request('POST', `/fleet/api/questions/${id}`, { answer, ...(clarification != null ? { clarification } : {}) });
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
  async replyQuestion(id, reply) { return this.request('POST', `/fleet/api/questions/${id}`, { reply }); }
  async reopenReviewed(id) { return (await this.request('POST', `/fleet/api/questions/${id}`, { reopen: true })).question; }
  async sendProposed(id) { return this.request('POST', `/fleet/api/actions/${id}/send`); }
  async sendOwnerMessage(threadKey, message, { queue = false, images = null } = {}) { return this.request('POST', '/fleet/api/send', { threadKey, message, ...(queue === true ? { queue: true } : {}), ...(Array.isArray(images) && images.length ? { images } : {}) }); }
  async reconcileOpenQuestions({ force = false } = {}) { return (await this.request('POST', '/fleet/api/reconcile', { force: force === true })).result; }
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
  async searchThreads(options = {}) {
    const limit = Number.isInteger(options?.limit) ? options.limit : 20;
    const peerNodes = (this.runtime?.nodeCapabilities?.list?.('fleet-supervisor') ?? [])
      .filter((n) => n?.nodeId && n.nodeId !== this.nodeId && typeof this.runtime?.nodeCapabilities?.dispatch === 'function');
    const fetchLimit = peerNodes.length > 0 ? Math.min(50, Math.max(limit, 30)) : limit;
    const fetchOptions = { ...options, limit: fetchLimit };
    let primaryRes = null;
    let primaryError = null;
    try {
      primaryRes = await this.request('GET', '/fleet/api/search', fetchOptions);
    } catch (error) {
      if (error.unsupportedRoute || error.status === 404) {
        if (!this.questionsAuthoritative) await this.request('GET', '/fleet/api/state').catch(() => {});
        if (this.questionsAuthoritative) this.state.lastError = null;
        primaryRes = searchFleet(this.getState(), { natural: true, ...fetchOptions });
      } else if (peerNodes.length === 0 || (error.reached && error.status === 400)) {
        throw error;
      } else {
        primaryError = error;
      }
    }

    if (peerNodes.length === 0) {
      return {
        ...primaryRes,
        results: (primaryRes?.results ?? []).slice(0, limit)
      };
    }

    let peerResponded = false;
    const peerLists = await Promise.all(peerNodes.slice(0, 4).map(async (peer) => {
      try {
        const res = await this.runtime.nodeCapabilities.dispatch(
          peer.nodeId,
          'fleet-supervisor',
          'request',
          { method: 'GET', path: '/fleet/api/search', body: fetchOptions },
          { timeoutMs: 28000 }
        );
        if (res?.response?.status === 200 && Array.isArray(res.response.body?.results)) {
          peerResponded = true;
          return res.response.body.results;
        }
      } catch { /* fall through to state search for older node versions */ }
      try {
        const stateRes = await this.runtime.nodeCapabilities.dispatch(
          peer.nodeId,
          'fleet-supervisor',
          'request',
          { method: 'GET', path: '/fleet/api/state' },
          { timeoutMs: 6000 }
        );
        if (stateRes?.state) {
          peerResponded = true;
          return searchFleet(stateRes.state, { natural: true, ...fetchOptions, includeScores: true }).scoredResults
            ?? searchFleet(stateRes.state, { natural: true, ...fetchOptions }).results;
        }
      } catch { /* peer offline or unreachable */ }
      return [];
    }));

    if (primaryError && !peerResponded) {
      throw primaryError;
    }

    let fallbackCachedResults = [];
    if (primaryError && this.questionsAuthoritative) {
      try {
        fallbackCachedResults = searchFleet(this.getState(), { natural: true, ...fetchOptions, includeScores: true }).scoredResults ?? [];
      } catch (err) {
        if (/Query must be|Limit must be/i.test(String(err?.message ?? ''))) throw err;
      }
    } else if (primaryError) {
      searchFleet({ snapshot: { threads: [] } }, { natural: true, ...fetchOptions });
    }

    const ranked = rankCombinedSearchResults(
      [...(primaryRes?.results ?? fallbackCachedResults), ...peerLists.flat()],
      options?.query ?? ''
    );
    return {
      query: String(options?.query ?? '').trim(),
      scannedAt: primaryRes?.scannedAt ?? this.state.snapshot?.at ?? null,
      scope: primaryRes?.scope ?? 'Peer fleet search (primary fleet computer offline).',
      ...primaryRes,
      results: ranked.slice(0, limit),
      total: ranked.length,
      ...(primaryError ? { partial: true, primaryError: primaryError.message } : {})
    };
  }
  async updatePreferences(input = {}) { return (await this.request('POST', '/fleet/api/preferences', input)).preferences; }
  async listWorkspaces(input = {}) { return this.request('GET', '/fleet/api/workspaces', input); }
  async getHierarchy(input = {}) { return this.request('GET', '/fleet/api/hierarchy', input); }
  async getOrganization() { return (await this.request('GET', '/fleet/api/projects')).organization; }
  async upsertProject(input = {}) { return this.request('POST', '/fleet/api/projects', input); }
  async deleteProject(projectId) { return this.request('DELETE', `/fleet/api/projects/${encodeURIComponent(projectId)}`); }
  async organizeThread(threadKey, input = {}) { return this.request('POST', `/fleet/api/threads/${encodeURIComponent(threadKey)}/organize`, input); }
  async syncThemes(input = {}) { return (await this.request('POST', '/fleet/api/themes/sync', input)).result ?? null; }
  async dispatchGoal(input = {}) { return (await this.request('POST', '/fleet/api/dispatch', input)).result ?? null; }
  async inspectRepoStatus(input = {}) { return this.request('GET', '/fleet/api/repo-status', input); }
  async startPaseoSession(input = {}) { return (await this.request('POST', '/fleet/api/sessions/start', input)).session ?? null; }
  async claimTask(input = {}) { return await this.request('POST', '/fleet/api/tasks/claim', input); }
  async getActiveWork(input = {}) { return this.request('GET', '/fleet/api/active-work', input); }
  async trackWork(input = {}) {
    const { state: _state, activeWork: _aw, ...rest } = await this.request('POST', '/fleet/api/active-work', input);
    return rest;
  }
  async scanActiveWork(input = {}) { return (await this.request('POST', '/fleet/api/active-work/scan', input)).pass ?? null; }
  async actActiveWork(id, input = {}) {
    try {
      return (await this.request('POST', `/fleet/api/active-work/${encodeURIComponent(id)}/act`, input)).result ?? null;
    } catch (error) {
      if (error.status === 404 && !error.unsupportedRoute) return null;
      throw error;
    }
  }
  async batchActCards(input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new Error('Pass a JSON object body.');
    }
    const { cardOp, explicitIds } = normalizeBatchCardsInput(input);
    const openLocalQuestions = this.selfFixHub ? this.selfFixHub.store.openQuestions() : [];
    if (openLocalQuestions.length === 0) {
      return (await this.request('POST', '/fleet/api/cards/batch', input)).result ?? null;
    }

    const localById = new Map();
    for (const q of openLocalQuestions) {
      if (q?.id) localById.set(q.id, q);
    }
    const matchesLocal = (rawId) => {
      const clean = String(rawId ?? '').trim();
      const stripped = clean.replace(/^question:/, '');
      return localById.has(clean) ? clean : (localById.has(stripped) ? stripped : null);
    };

    const buildLocalCards = (includeQuietSuppressed = false) => {
      const prefs = normalizePreferences(this.state.preferences);
      const rowsByKey = new Map((this.state.snapshot?.threads ?? []).filter((r) => r?.key).map((r) => [r.key, r]));
      const actions = Array.isArray(this.state.actions) ? this.state.actions : [];
      return openLocalQuestions
        .filter((q) => q?.id && (includeQuietSuppressed || !isSuppressedByQuietCadence(q, prefs)))
        .map((q) => {
          const { rank: _rank, ...card } = buildSupervisorCard(q, { rowsByKey, actions, prefs });
          return card;
        });
    };

    const combineBatchResults = (remoteRes, localRes, orderedIds = null) => {
      const remoteItems = Array.isArray(remoteRes?.results) ? remoteRes.results : [];
      const localItems = Array.isArray(localRes?.results) ? localRes.results : [];
      let mergedResults = [...remoteItems, ...localItems];
      if (orderedIds?.length) {
        const orderIndex = new Map(orderedIds.map((id, idx) => [id.replace(/^question:/, ''), idx]));
        mergedResults = [...mergedResults].sort(
          (a, b) => (orderIndex.get(String(a.cardId ?? '').replace(/^question:/, '')) ?? 999)
            - (orderIndex.get(String(b.cardId ?? '').replace(/^question:/, '')) ?? 999)
        );
      }
      const total = mergedResults.length;
      if (total === 0) {
        return {
          ok: true,
          op: cardOp,
          total: 0,
          succeeded: 0,
          halted: 0,
          detail: 'No open decision cards matched that batch filter.',
          results: []
        };
      }
      const succeeded = mergedResults.filter((r) => r.ok).length;
      const halted = total - succeeded;
      return {
        ok: halted === 0,
        op: cardOp,
        total,
        succeeded,
        halted,
        detail: `Processed ${total} card${total === 1 ? '' : 's'}: ${succeeded} succeeded${halted ? `, ${halted} halted` : ''}.`,
        results: mergedResults
      };
    };

    if (explicitIds?.length) {
      const localIds = [];
      const remoteIds = [];
      for (const rawId of explicitIds) {
        const localKey = matchesLocal(rawId);
        if (localKey) {
          if (!localIds.includes(localKey)) localIds.push(localKey);
        } else {
          remoteIds.push(rawId);
        }
      }
      const remoteRes = remoteIds.length > 0
        ? ((await this.request('POST', '/fleet/api/cards/batch', { ...input, cardIds: remoteIds })).result ?? null)
        : null;
      const localCards = buildLocalCards(true);
      const localRes = localIds.length > 0
        ? await batchActCards(
            { getState: () => ({ cards: localCards }), actCard: (id, act) => this.actCard(id, act) },
            { ...input, cardIds: localIds }
          )
        : null;
      if (localRes?.total > 0) this.emitIfChanged();
      return combineBatchResults(remoteRes, localRes, explicitIds);
    }

    const remoteRes = (await this.request('POST', '/fleet/api/cards/batch', input)).result ?? null;
    const remainingSlots = Math.max(0, 25 - (remoteRes?.total ?? 0));
    let localRes = null;
    if (remainingSlots > 0) {
      const visibleLocalCards = buildLocalCards(false);
      if (visibleLocalCards.length > 0) {
        localRes = await batchActCards(
          { getState: () => ({ cards: visibleLocalCards }), actCard: (id, act) => this.actCard(id, act) },
          { ...input, maxCards: remainingSlots }
        );
      }
    }
    if (localRes?.total > 0) this.emitIfChanged();
    return combineBatchResults(remoteRes, localRes);
  }
  async readChatTranscript({ key, limit = 20 } = {}) {
    const cleanKey = typeof key === 'string' ? key.trim() : '';
    if (!cleanKey) throw new Error('Pass a session key.');
    const path = `/fleet/api/threads/${encodeURIComponent(cleanKey)}/transcript`;
    try {
      const body = await this.request('GET', path, { limit });
      if (body?.transcript) return body.transcript;
    } catch (error) {
      if (error.status !== 404) throw error;
    }
    const peerNodes = (this.runtime?.nodeCapabilities?.list?.('fleet-supervisor') ?? [])
      .filter((n) => n?.nodeId && n.nodeId !== this.nodeId && typeof this.runtime?.nodeCapabilities?.dispatch === 'function');
    for (const peer of peerNodes.slice(0, 4)) {
      try {
        const res = await this.runtime.nodeCapabilities.dispatch(
          peer.nodeId,
          'fleet-supervisor',
          'request',
          { method: 'GET', path, body: { limit } },
          { timeoutMs: 15000 }
        );
        if (res?.response?.status === 200 && res.response.body?.transcript) {
          return res.response.body.transcript;
        }
      } catch { /* try next peer */ }
    }
    throw new Error(`No session found with key "${cleanKey.slice(0, 120)}".`);
  }
  async routeIssue(input = {}) {
    const { state: _state, ...rest } = await this.request('POST', '/fleet/api/route', input);
    return rest;
  }
  async actCard(cardId, input = {}) {
    if (this.selfFixHub && typeof cardId === 'string') {
      const qid = cardId.replace(/^question:/, '');
      const localQuestion = this.selfFixHub.store.question(qid);
      if (localQuestion && localQuestion.status === 'open') {
        const prefs = normalizePreferences(this.state.preferences);
        const rowsByKey = new Map((this.state.snapshot?.threads ?? []).filter((r) => r?.key).map((r) => [r.key, r]));
        const actions = Array.isArray(this.state.actions) ? this.state.actions : [];
        const localCard = buildSupervisorCard(localQuestion, { rowsByKey, actions, prefs });

        const normalizedOp = String(input?.op ?? 'primary').toLowerCase();
        const explicitValue = typeof input?.value === 'string' && input.value.trim() ? input.value.trim() : null;
        const resolvedAction = normalizedOp === 'secondary'
          ? localCard?.secondaryAction
          : normalizedOp === 'primary'
            ? localCard?.primaryAction
            : (localCard?.extraActions ?? []).find((a) => a.op === normalizedOp && (explicitValue == null || a.value === explicitValue)) ?? null;
        const effectiveOp = normalizedOp === 'primary' || normalizedOp === 'secondary'
          ? (resolvedAction?.op ?? 'answer')
          : normalizedOp;
        const effectiveValue = explicitValue ?? resolvedAction?.value ?? null;

        if (effectiveOp === 'defer' || effectiveOp === 'dismiss' || effectiveValue === 'dismiss') {
          return { ok: true, kind: 'defer', status: 'dismissed', question: this.selfFixHub.store.dismissQuestion(qid), delivery: null };
        }
        if (effectiveOp === 'merge' || effectiveOp === 'fix_ci') {
          return { ok: false, kind: effectiveOp, status: 'unsupported', detail: 'Self-fix question card does not support PR actions.' };
        }
        if (effectiveOp === 'reply' && !explicitValue) return null;
        const answer = effectiveValue ?? (localQuestion.options ?? []).find((opt) => opt !== 'dismiss') ?? null;
        if (!answer) return null;
        const res = await this.selfFixHub.answer(qid, answer);
        return res ? { ok: true, kind: 'answer', status: res.delivery?.status ?? 'done', ...res } : null;
      }
    }
    try {
      return (await this.request('POST', `/fleet/api/cards/${encodeURIComponent(cardId)}/act`, input)).result ?? null;
    } catch (error) {
      const legacyRouteMissing = Boolean(error.unsupportedRoute) || /unknown fleet route|unsupported fleet request/i.test(String(error?.message ?? ''));
      if (error.status === 404 && !legacyRouteMissing) return null;
      if (!legacyRouteMissing) throw error;
      if (!this.questionsAuthoritative) await this.request('GET', '/fleet/api/state').catch(() => {});
      if (this.questionsAuthoritative) this.state.lastError = null;
      const qid = String(cardId ?? '').replace(/^question:/, '');
      const curState = this.getState();
      const card = (curState.cards ?? []).find((c) => c.id === cardId || c.id === qid || c.questionId === qid) ?? null;
      const openQ = (curState.questions ?? []).find((q) => q.id === qid) ?? null;
      if (!openQ) return null;
      const op = String(input?.op ?? 'primary').toLowerCase();
      if (op === 'defer' || op === 'dismiss') {
        const question = await this.dismissQuestion(qid);
        return { ok: true, kind: 'defer', status: 'dismissed', question, delivery: null };
      }
      if (op === 'reply') {
        const hasImages = Array.isArray(input?.images) && input.images.length > 0;
        const replyText = (typeof input?.value === 'string' ? input.value.trim() : '') || (hasImages ? 'Please inspect the attached image(s).' : '');
        if (!replyText) return { ok: false, kind: 'reply', status: 'blocked', detail: 'Enter a reply to send.' };
        const eligibleForQuestionReply = !hasImages && (openQ.canReply === true
          || (openQ.canReply !== false && ['agent-ask', 'stuck', 'ready'].includes(openQ.kind) && Boolean(openQ.threadKey) && !((openQ.threadKeys ?? []).length > 1)));
        if (eligibleForQuestionReply) {
          const replied = await this.replyQuestion(qid, replyText);
          if (!replied) return { ok: false, kind: 'reply', status: 'closed', detail: 'Question already closed.' };
          const { state: _state, ...rest } = replied;
          return {
            ok: !rest.delivery || ['sent', 'queued'].includes(rest.delivery.status),
            kind: 'reply',
            status: rest.delivery?.status ?? 'done',
            detail: rest.delivery?.detail ?? 'Delivered reply to coding session.',
            ...rest
          };
        }
        const threadKey = card?.threadKey ?? openQ.threadKey ?? null;
        if (!threadKey) return { ok: false, kind: 'reply', status: 'blocked', detail: 'No coding session is linked to this card.' };
        const sent = await this.sendOwnerMessage(threadKey, replyText, { ...(hasImages ? { images: input.images } : {}) });
        return {
          ok: sent?.delivery?.status === 'sent',
          kind: 'reply',
          status: sent?.delivery?.status ?? 'blocked',
          detail: sent?.delivery?.detail ?? (sent?.delivery?.status === 'sent' ? 'Delivered reply to coding session.' : 'Could not deliver reply.'),
          delivery: sent?.delivery ?? null
        };
      }
      const chosen = typeof input?.value === 'string' && input.value
        ? input.value
        : op === 'secondary'
          ? card?.secondaryAction?.value
          : (card?.primaryAction?.value ?? (openQ.options ?? []).find((opt) => opt !== 'dismiss'));
      if (!chosen) return null;
      const res = await this.answerQuestion(qid, chosen, { clarification: input?.clarification ?? null });
      return res ? { ok: res.delivery?.status !== 'blocked', kind: 'answer', status: res.delivery?.status ?? 'done', detail: res.delivery?.detail ?? null, ...res } : null;
    }
  }
  async suggestions() { return (await this.request('GET', '/fleet/api/suggestions')).suggestions ?? []; }
  // Fix it queues in this main's hub (where fixes are listed, revised and
  // stopped); the computer only links the suggestion to that fix id.
  async respondSuggestion(id, choice, { clarification = null } = {}) {
    if (!this.selfFixHub || String(choice ?? '').toLowerCase() !== 'fix it') return this.request('POST', `/fleet/api/suggestions/${id}`, { choice, ...(clarification != null ? { clarification } : {}) });
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
    const path = `/fleet/api/threads/${encodeURIComponent(threadKey)}`;
    try {
      return (await this.request('GET', path)).thread ?? null;
    } catch (error) {
      if (error.status !== 404) throw error;
    }
    const peerNodes = (this.runtime?.nodeCapabilities?.list?.('fleet-supervisor') ?? [])
      .filter((n) => n?.nodeId && n.nodeId !== this.nodeId && typeof this.runtime?.nodeCapabilities?.dispatch === 'function');
    for (const peer of peerNodes.slice(0, 4)) {
      try {
        const res = await this.runtime.nodeCapabilities.dispatch(
          peer.nodeId,
          'fleet-supervisor',
          'request',
          { method: 'GET', path },
          { timeoutMs: 15000 }
        );
        if (res?.response?.status === 200 && res.response.body?.thread) {
          return res.response.body.thread;
        }
      } catch { /* try next peer */ }
    }
    return null;
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
  async archiveThread(threadKey, { confirmed = false } = {}) {
    if (confirmed !== true) {
      return { ok: false, status: 'confirmation_required', detail: 'Confirm archiving this coding chat first.' };
    }
    try {
      const body = await this.request('POST', `/fleet/api/threads/${encodeURIComponent(threadKey)}/archive`, { confirmed: true });
      return body.result ?? { ok: true, status: 'archived_session', threadKey, detail: 'Archived coding chat in Paseo.' };
    } catch (error) {
      return { ok: false, status: 'blocked', detail: String(error?.message ?? 'Could not archive coding chat.').slice(0, 200) };
    }
  }
  async unarchiveThread(threadKey) {
    try {
      const body = await this.request('POST', `/fleet/api/threads/${encodeURIComponent(threadKey)}/unarchive`, {});
      return body.result ?? { ok: true, status: 'unarchived_session', threadKey, detail: 'Restored coding chat in Paseo.' };
    } catch (error) {
      return { ok: false, status: 'blocked', detail: String(error?.message ?? 'Could not restore coding chat.').slice(0, 200) };
    }
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
    const currentState = this.getState();
    const liveQuestions = currentState.questions.filter((q) => !isSuppressedByQuietCadence(q, currentState.preferences));
    const openIds = new Set(liveQuestions.map(q => q.id));
    for (const item of outreach.list()) {
      if (item.sourceRef?.kind === 'fleet' && ['unseen', 'seen'].includes(item.status)
          && (item.sourceRef.nodeId !== this.nodeId
            || (!openIds.has(item.sourceRef.id) && !this.pendingOutreachDecisions.has(item.sourceRef.id)))) {
        outreach.resolve(item.id, 'resolved', { status: 'dismissed' });
      }
    }
    const items = outreach.list();
    for (const q of liveQuestions) {
      // Compact outreach clients cannot show the full deletion warning.
      // Keep storage decisions in the main app where that warning is visible.
      const shown = q.kind === 'storage'
        ? { title: q.title, summary: 'Storage cleanup can permanently delete files. Review the full warning and choose in the main app.', actions: ['dismiss'] }
        : { title: q.title, summary: q.card || q.body, actions: outreachActions(q.options) };
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

  mirrorActiveWork(activeWork) {
    const outreach = this.runtime?.outreach;
    if (!activeWork || !Array.isArray(activeWork.prompts)) return;
    const prompts = activeWork.prompts.filter((prompt) => prompt?.id && prompt?.mark);
    this.activeWorkSignature = JSON.stringify(prompts.map((prompt) => [prompt.id, prompt.mark]).sort());
    if (!outreach) return;
    const openIds = new Set(prompts.map((prompt) => String(prompt.id)));
    for (const item of outreach.list()) {
      if (item.sourceRef?.kind === 'active-work'
          && item.sourceRef.nodeId === this.nodeId
          && ['unseen', 'seen'].includes(item.status)
          && !openIds.has(String(item.sourceRef.id))) {
        outreach.resolve(item.id, 'resolved', { status: 'dismissed' });
      }
    }
    const existing = outreach.list();
    for (const prompt of prompts) {
      const sourceRef = { kind: 'active-work', id: prompt.id, nodeId: this.nodeId, mark: prompt.mark };
      const shown = {
        title: prompt.title,
        summary: prompt.summary,
        actions: Array.isArray(prompt.actions) && prompt.actions.length ? prompt.actions : ['dismiss']
      };
      const current = existing.find((item) => item.sourceRef?.kind === 'active-work'
        && item.sourceRef.nodeId === this.nodeId
        && String(item.sourceRef.id) === String(prompt.id));
      const markChanged = Boolean(current && current.sourceRef?.mark !== prompt.mark);
      let item = markChanged ? (outreach.reopen?.(current.id) ?? null) : current;
      if (!item && current && ['unseen', 'seen'].includes(current.status)) item = current;
      if (!item) {
        item = outreach.append({
          type: 'fleet-active-work',
          sourceRef,
          ...shown,
          needsDecision: false,
          // A dismissed record cannot be reopened for a changed mark. Do not
          // let an open-record dedupe rule suppress the replacement notice.
          dedupeOpen: !markChanged
        });
      }
      if (item?.id) outreach.update?.(item.id, { ...shown, sourceRef });
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
