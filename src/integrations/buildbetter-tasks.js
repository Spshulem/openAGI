// BuildBetter → TaskStore source. Pulls action items / commitments /
// follow-ups from the user's recent calls (extractions tagged action_item,
// follow_up, task, commitment, priority). Polls every 15 min.
//
// Auth — two paths, in precedence order:
//   1. BUILDBETTER_API_KEY  → X-BuildBetter-Api-Key header.
//   2. The BuildBetter MCP OAuth connection (from the dashboard MCP tab) →
//      Authorization: Bearer <token>, silently refreshed, no browser needed.
//      With no API key set at all, connecting BuildBetter once via MCP is
//      enough for this poller to run.
//
// User identity (whose attendee the action item is "for") is auto-derived
// from the API key / OAuth session via the `me` GraphQL query. It only falls
// back to BUILDBETTER_USER_EMAIL / BUILDBETTER_USER_NAME when `me` can't
// pinpoint a single user (e.g. an org-scoped key).
//
// Adapted from autolist's apps/api/src/lib/integrations/buildbetter.ts
// to OpenAGI's task store + integration registry pattern.

import { McpOAuthClient } from "../mcp-oauth.js";
import { resolveDataDir } from "../data-dir.js";

const BUILDBETTER_ENDPOINT = "https://api.buildbetter.app/v1/graphql";
// Origin of the BuildBetter MCP server, used to build the OAuth client that
// reads the token cached under <dataDir>/mcp/auth/buildbetter.json. The actual
// silent refresh uses the discovery metadata stored in that cache, so this
// only needs to be correct enough to satisfy the constructor — prod and
// staging tokens both refresh fine once the cache exists.
const BUILDBETTER_MCP_RESOURCE_URL = "https://mcp.buildbetter.app";
const ME_QUERY = "query Me { me { person { first_name last_name email } } }";
const POLL_INTERVAL_MS = 15 * 60 * 1000;
const LOOKBACK_DAYS = 7;

export class BuildBetterTaskSource {
  constructor(options = {}) {
    this.runtime = options.runtime;
    this.apiKey = options.apiKey ?? process.env.BUILDBETTER_API_KEY ?? null;
    this.userEmail = options.userEmail ?? process.env.BUILDBETTER_USER_EMAIL ?? null;
    this.userName = options.userName ?? process.env.BUILDBETTER_USER_NAME ?? null;
    // OAuth fallback (option 2): reuse the BuildBetter MCP connection. The
    // client is built lazily so we never touch the filesystem / construct it
    // when an API key is set. dataDir + resourceUrl come from the MCP registry
    // when available so we read the exact same token cache the MCP client wrote.
    this.dataDir = options.dataDir ?? resolveDataDir();
    this.oauthResourceUrl = options.oauthResourceUrl ?? BUILDBETTER_MCP_RESOURCE_URL;
    this.oauthClient = options.oauthClient ?? null;
    this._oauthTried = false;
    // Identity auto-derivation (option 1): once we've successfully asked `me`,
    // don't ask again this process — even if it returned no user.
    this._identityResolved = false;
    this.lastSyncedAt = null;
    // Coalescing state for webhook-triggered syncs: if a sync is already
    // running when a ping arrives, we don't start a second — we just flag
    // that one more run is owed, and run it once when the current finishes.
    this._syncing = false;
    this._syncPending = false;
    const mode = (options.ingestMode ?? process.env.BUILDBETTER_INGEST_MODE ?? "signals").toLowerCase();
    this.ingestMode = ["signals", "transcripts", "both"].includes(mode) ? mode : "signals";
  }

  isConfigured() {
    // Identity is auto-derived now, so auth alone is enough: an API key, or a
    // previously-completed BuildBetter MCP OAuth connection.
    return Boolean(this.apiKey) || this._hasOAuthCache();
  }

  // Lazily build the OAuth client. Returns null if it can't be constructed.
  _oauth() {
    if (this.oauthClient) return this.oauthClient;
    if (this._oauthTried) return null;
    this._oauthTried = true;
    try {
      this.oauthClient = new McpOAuthClient({
        name: "buildbetter",
        resourceUrl: this.oauthResourceUrl,
        dataDir: this.dataDir
      });
    } catch {
      this.oauthClient = null;
    }
    return this.oauthClient;
  }

  // Sync probe: is there a usable cached OAuth token/refresh token on disk?
  _hasOAuthCache() {
    const client = this._oauth();
    if (!client) return false;
    try {
      const cache = client.loadCache();
      return Boolean(cache?.access_token || cache?.refresh_token);
    } catch {
      return false;
    }
  }

  // Silently obtain a Bearer token from the cached OAuth connection. Delegates
  // to the canonical token lifecycle in McpOAuthClient (cached-or-refresh, no
  // browser): ensureToken({interactive:false}) returns a valid token or throws
  // OAUTH_INTERACTIVE_REQUIRED / a refresh error, both of which mean "no token"
  // for a headless poller. Sharing this keeps us from drifting from how the
  // live MCP client refreshes the same cache.
  async _oauthToken() {
    const client = this._oauth();
    if (!client) return null;
    try {
      return await client.ensureToken({ interactive: false });
    } catch {
      return null;
    }
  }

  // Resolve auth headers: API key wins (preserves existing setups), else the
  // reused MCP OAuth token. Returns null when neither is available.
  async authHeaders() {
    // BuildBetter's exact header spelling per their docs.
    if (this.apiKey) return { "X-BuildBetter-Api-Key": this.apiKey };
    const token = await this._oauthToken();
    if (token) return { authorization: `Bearer ${token}` };
    return null;
  }

  // Best-effort: fill userEmail / userName from the authenticated session via
  // the `me` query. No-op once we already have an identity, or once we've
  // asked successfully (an org-scoped key legitimately returns no user — we
  // don't keep re-asking, we just fall back to the env-provided identity).
  async ensureIdentity() {
    if (this.userEmail || this.userName) return;
    if (this._identityResolved) return;
    try {
      const data = await this.query(ME_QUERY);
      this._identityResolved = true; // we successfully asked; don't repeat
      const p = data?.me?.person;
      if (p?.email) this.userEmail = p.email;
      const fullName = [p?.first_name, p?.last_name].filter(Boolean).join(" ").trim();
      if (!this.userEmail && fullName) this.userName = fullName;
    } catch {
      // transient (network / auth) — leave unresolved so we retry next sync.
    }
  }

  async query(graphql, variables = {}) {
    const auth = await this.authHeaders();
    if (!auth) {
      throw new Error("BuildBetter: no auth (set BUILDBETTER_API_KEY or connect BuildBetter from the MCP tab)");
    }
    const res = await fetch(BUILDBETTER_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", ...auth },
      body: JSON.stringify({ query: graphql, variables })
    });
    if (!res.ok) throw new Error(`BuildBetter API ${res.status}`);
    const json = await res.json();
    if (json.errors?.length) throw new Error(`BuildBetter: ${json.errors[0].message}`);
    return json.data;
  }

  // Step 1: find recent calls the user attended.
  async getRecentCalls(sinceIso) {
    // Auto-derive who "you" are before filtering by attendee.
    await this.ensureIdentity();
    const query = `
      query RecentCalls($since: timestamptz!, $limit: Int!) {
        interview(
          where: { started_at: { _gte: $since } }
          order_by: { started_at: desc }
          limit: $limit
        ) {
          id
          name
          started_at
          attendees {
            person { first_name last_name email }
          }
        }
      }
    `;
    const data = await this.query(query, { since: sinceIso, limit: 100 });
    const calls = data?.interview ?? [];
    // Filter to calls the user attended (by email or name).
    return calls.filter((call) => {
      return (call.attendees ?? []).some((a) => {
        const p = a.person ?? {};
        if (this.userEmail && p.email && p.email.toLowerCase() === this.userEmail.toLowerCase()) return true;
        if (this.userName) {
          const fullName = [p.first_name, p.last_name].filter(Boolean).join(" ").trim();
          if (fullName.toLowerCase() === this.userName.toLowerCase()) return true;
        }
        return false;
      });
    });
  }

  // Step 2: pull action-item-like extractions from those calls.
  async getActionItems(callIds, sinceIso) {
    if (callIds.length === 0) return [];
    const query = `
      query ActionItems($since: timestamptz!, $callIds: [bigint!]!) {
        extraction(
          where: {
            _and: [
              { display_ts: { _gte: $since } },
              { interview_id: { _in: $callIds } },
              { types: { type: { name: { _in: ["action_item", "follow_up", "task", "commitment", "priority"] } } } }
            ]
          }
          order_by: { display_ts: desc }
          limit: 200
        ) {
          id
          interview_id
          summary
          context
          display_ts
          types { type { name } }
        }
      }
    `;
    const data = await this.query(query, { since: sinceIso, callIds: callIds.map((id) => Number(id)) });
    return data?.extraction ?? [];
  }

  /**
   * Run one sync pass. Returns { created, updated, scanned } or skip reason.
   */
  async syncSignals({ now = new Date() } = {}) {
    if (!(await this.authHeaders())) return { skipped: true, reason: "no BuildBetter auth (set BUILDBETTER_API_KEY or connect BuildBetter via MCP)" };
    if (!this.runtime?.tasks?.add) return { skipped: true, reason: "task store not available" };
    await this.ensureIdentity();
    if (!this.userEmail && !this.userName) return { skipped: true, reason: "could not determine your BuildBetter identity (set BUILDBETTER_USER_EMAIL or BUILDBETTER_USER_NAME)" };

    const sinceIso = new Date(now.getTime() - LOOKBACK_DAYS * 86400 * 1000).toISOString();

    let calls;
    try {
      calls = await this.getRecentCalls(sinceIso);
    } catch (err) {
      return { skipped: true, reason: `recent calls: ${err.message}` };
    }
    if (calls.length === 0) return { scanned: 0, created: 0 };

    const callById = new Map(calls.map((c) => [String(c.id), c]));

    let extractions;
    try {
      extractions = await this.getActionItems(calls.map((c) => c.id), sinceIso);
    } catch (err) {
      return { skipped: true, reason: `extractions: ${err.message}` };
    }

    const existing = new Map();
    for (const t of this.runtime.tasks.list({ limit: 500 })) {
      if (t.source === "buildbetter" && t.sourceId) existing.set(t.sourceId, t);
    }

    let created = 0;
    for (const ex of extractions) {
      const sourceId = `buildbetter:${ex.id}`;
      if (existing.has(sourceId)) continue;
      const call = callById.get(String(ex.interview_id));
      const types = (ex.types ?? []).map((t) => t?.type?.name).filter(Boolean);
      const isPriority = types.includes("priority") || types.includes("commitment");

      this.runtime.tasks.add(
        {
          title: ex.summary?.trim() || "Action item from call",
          description: ex.context ?? "",
          priority: isPriority ? 75 : 55,
          bucket: "this_week",
          tags: types,
          sourceId,
          sourceUrl: call ? `https://app.buildbetter.app/interviews/${call.id}` : null,
          sourceMeta: {
            extractionId: ex.id,
            callId: call?.id,
            callName: call?.name,
            callStartedAt: call?.started_at,
            extractedAt: ex.display_ts,
            extractionTypes: types
          }
        },
        { source: "buildbetter", queue: "user" }
      );
      created += 1;
    }

    this.lastSyncedAt = now.toISOString();
    return { scanned: extractions.length, calls: calls.length, created };
  }

  // Fetch the full transcript text for a call, using the verified
  // interview → monologues schema. Returns "" when no transcript exists.
  async getTranscript(callId) {
    const query = `
      query Transcript($id: bigint!) {
        interview(where: { id: { _eq: $id } }, limit: 1) {
          id
          monologues(order_by: { start_sec: asc }) {
            speaker
            text
            attendee { person { first_name last_name } }
          }
        }
      }
    `;
    const data = await this.query(query, { id: Number(callId) });
    const iv = data?.interview?.[0];
    const rows = iv?.monologues ?? [];
    if (!rows.length) return "";
    return rows.map((m) => {
      const p = m.attendee?.person;
      const name = p ? [p.first_name, p.last_name].filter(Boolean).join(" ").trim() : "";
      const speaker = name || `Speaker ${m.speaker}`;
      return `${speaker}: ${m.text ?? ""}`.trim();
    }).filter(Boolean).join("\n");
  }

  // Record one transcript observation per recent call, deduped by ref.
  async syncTranscripts({ now = new Date() } = {}) {
    if (!(await this.authHeaders())) return { skipped: true, reason: "no BuildBetter auth (set BUILDBETTER_API_KEY or connect BuildBetter via MCP)" };
    if (!this.runtime?.observations?.record) return { skipped: true, reason: "no observation store" };
    // Transcripts are filtered to calls YOU attended, so without an identity
    // getRecentCalls matches nothing — skip with a clear reason instead of
    // silently recording zero transcripts (mirrors syncSignals).
    await this.ensureIdentity();
    if (!this.userEmail && !this.userName) return { skipped: true, reason: "could not determine your BuildBetter identity (set BUILDBETTER_USER_EMAIL or BUILDBETTER_USER_NAME)" };

    const sinceIso = new Date(now.getTime() - LOOKBACK_DAYS * 86400 * 1000).toISOString();
    let calls;
    try {
      calls = await this.getRecentCalls(sinceIso);
    } catch (err) {
      return { skipped: true, reason: `recent calls: ${err.message}` };
    }

    let created = 0;
    let failed = 0;
    for (const call of calls) {
      const ref = `buildbetter:call:${call.id}`;
      if (await this.runtime.observations.existsRef(ref)) continue;
      let text;
      try {
        text = await this.getTranscript(call.id);
      } catch (err) {
        failed += 1;
        continue; // skip this call; retry next sweep
      }
      if (!text) continue;
      await this.runtime.observations.record({
        kind: "transcript",
        at: call.started_at ?? now.toISOString(),
        app: "BuildBetter",
        window: call.name ?? "Call",
        text,
        ref
      });
      created += 1;
    }
    return { scanned: calls.length, created, failed };
  }

  // Mode-aware dispatcher invoked by the cron handler and triggerSync().
  async sync({ now = new Date() } = {}) {
    const out = {};
    if (this.ingestMode === "signals" || this.ingestMode === "both") {
      out.signals = await this.syncSignals({ now });
    }
    if (this.ingestMode === "transcripts" || this.ingestMode === "both") {
      out.transcripts = await this.syncTranscripts({ now });
    }
    return out;
  }

  // Webhook entry point: coalesce concurrent pings into a single in-flight
  // sync plus at most one trailing run, so a burst of extraction events for
  // one call doesn't fan out into a burst of BuildBetter API calls.
  async triggerSync({ now = new Date() } = {}) {
    if (this._syncing) {
      this._syncPending = true;
      return { coalesced: true };
    }
    this._syncing = true;
    try {
      let result = await this.sync({ now });
      while (this._syncPending) {
        this._syncPending = false;
        result = await this.sync({ now: new Date() });
      }
      return result;
    } finally {
      this._syncing = false;
    }
  }
}

export function registerBuildBetterTaskSource(runtime, options = {}) {
  // Reuse the MCP registry's view of the BuildBetter server (if connected) so
  // the OAuth fallback reads the exact token cache the MCP client wrote.
  const rec = runtime?.mcp?.servers?.get?.("buildbetter");
  const source = options.source ?? new BuildBetterTaskSource({
    runtime,
    dataDir: runtime?.mcp?.dataDir,
    oauthResourceUrl: rec?.resourceUrl ?? (rec?.url ? originOf(rec.url) : undefined),
    ...options
  });
  // Register the source + cron even when no credentials exist yet. Auth can
  // arrive mid-session — the user connects BuildBetter from the MCP tab and an
  // OAuth token cache appears — and the poller + webhook must start working
  // without a daemon restart. sync() self-gates on authHeaders(), so an
  // unconfigured source just no-ops each tick (a cheap cache check) until
  // credentials show up. Previously this returned early and left
  // runtime.buildBetterTaskSource unset, so a later MCP login was ignored
  // until restart (the cron reported "no buildbetter source", webhook 503'd).
  runtime.buildBetterTaskSource = source;
  if (runtime.cron?.addJob) {
    runtime.cron.addJob({
      id: "buildbetter-task-sync",
      name: "BuildBetter call action items → tasks",
      enabled: true,
      task: "buildbetter-task-sync",
      intervalMs: POLL_INTERVAL_MS
    });
  }
  return { registered: true, idle: !source.isConfigured() };
}

// Origin (scheme + host) of an MCP server URL, for the OAuth resource id.
function originOf(u) {
  try { return new URL(u).origin; } catch { return BUILDBETTER_MCP_RESOURCE_URL; }
}
