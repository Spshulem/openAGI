// BuildBetter → TaskStore source. Pulls action items / commitments /
// follow-ups from the user's recent calls (extractions tagged action_item,
// follow_up, task, commitment, priority). Polls every 15 min.
// Env-gated — silently no-ops if BUILDBETTER_API_KEY is unset.
//
// User identity (whose attendee the action item is "for") comes from
// BUILDBETTER_USER_EMAIL or BUILDBETTER_USER_NAME. If neither is set,
// the integration registers but warns once and stays idle.
//
// Adapted from autolist's apps/api/src/lib/integrations/buildbetter.ts
// to OpenAGI's task store + integration registry pattern.

const BUILDBETTER_ENDPOINT = "https://api.buildbetter.app/v1/graphql";
const POLL_INTERVAL_MS = 15 * 60 * 1000;
const LOOKBACK_DAYS = 7;

export class BuildBetterTaskSource {
  constructor(options = {}) {
    this.runtime = options.runtime;
    this.apiKey = options.apiKey ?? process.env.BUILDBETTER_API_KEY ?? null;
    this.userEmail = options.userEmail ?? process.env.BUILDBETTER_USER_EMAIL ?? null;
    this.userName = options.userName ?? process.env.BUILDBETTER_USER_NAME ?? null;
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
    return Boolean(this.apiKey) && Boolean(this.userEmail || this.userName);
  }

  async query(graphql, variables = {}) {
    const res = await fetch(BUILDBETTER_ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // BuildBetter's exact header spelling per their docs.
        "X-BuildBetter-Api-Key": this.apiKey
      },
      body: JSON.stringify({ query: graphql, variables })
    });
    if (!res.ok) throw new Error(`BuildBetter API ${res.status}`);
    const json = await res.json();
    if (json.errors?.length) throw new Error(`BuildBetter: ${json.errors[0].message}`);
    return json.data;
  }

  // Step 1: find recent calls the user attended.
  async getRecentCalls(sinceIso) {
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
    if (!this.apiKey) return { skipped: true, reason: "BUILDBETTER_API_KEY not set" };
    if (!this.userEmail && !this.userName) return { skipped: true, reason: "BUILDBETTER_USER_EMAIL or BUILDBETTER_USER_NAME required" };
    if (!this.runtime?.tasks?.add) return { skipped: true, reason: "task store not available" };

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
    if (!this.apiKey) return { skipped: true, reason: "BUILDBETTER_API_KEY not set" };
    if (!this.runtime?.observations?.record) return { skipped: true, reason: "no observation store" };

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
  const source = options.source ?? new BuildBetterTaskSource({ runtime, ...options });
  if (!source.isConfigured()) {
    return {
      registered: false,
      reason: source.apiKey
        ? "BUILDBETTER_USER_EMAIL or BUILDBETTER_USER_NAME required"
        : "BUILDBETTER_API_KEY not set"
    };
  }
  if (runtime.cron?.addJob) {
    runtime.cron.addJob({
      id: "buildbetter-task-sync",
      name: "BuildBetter call action items → tasks",
      enabled: true,
      task: "buildbetter-task-sync",
      intervalMs: POLL_INTERVAL_MS
    });
  }
  runtime.buildBetterTaskSource = source;
  return { registered: true };
}
