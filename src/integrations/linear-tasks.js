// Linear → TaskStore source. Polls Linear's GraphQL API for the viewer's
// assigned issues every 5 minutes (cron job) and creates / updates tasks
// in the user queue. Env-gated: silently no-ops if LINEAR_API_KEY is unset.
//
// Each Linear issue becomes ONE OpenAGI task. The mapping is keyed by
// `linear:<issue.id>` in `sourceId` so re-polling doesn't duplicate.
// When the issue's state changes to completed/canceled in Linear, the
// task gets marked done (completedVia="linear-poll").

const LINEAR_ENDPOINT = "https://api.linear.app/graphql";
const POLL_INTERVAL_MS = 5 * 60 * 1000;

const ASSIGNED_ISSUES_QUERY = `
  query MyIssues($limit: Int!) {
    viewer {
      assignedIssues(first: $limit, orderBy: priority) {
        nodes {
          id
          identifier
          title
          description
          priority
          priorityLabel
          state { id name type }
          dueDate
          project { id name }
          team { id name key }
          url
          updatedAt
        }
      }
    }
  }
`;

export class LinearTaskSource {
  constructor(options = {}) {
    this.runtime = options.runtime;
    this._apiKey = options.apiKey ?? null;
    this.includeCompleted = options.includeCompleted ?? false;
    this.lastSyncedAt = null;
  }

  // Read the env live (not a constructor snapshot) so a key added after boot
  // — setup-wizard save, manual .env edit — starts syncing on the next cron
  // tick without a daemon restart.
  get apiKey() {
    return this._apiKey ?? process.env.LINEAR_API_KEY ?? null;
  }

  isConfigured() {
    return Boolean(this.apiKey);
  }

  async query(graphql, variables = {}) {
    const res = await fetch(LINEAR_ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: this.apiKey
      },
      body: JSON.stringify({ query: graphql, variables })
    });
    if (!res.ok) throw new Error(`Linear API ${res.status}`);
    const json = await res.json();
    if (json.errors?.length) throw new Error(`Linear: ${json.errors[0].message}`);
    return json.data;
  }

  /**
   * Poll Linear and reconcile against the OpenAGI TaskStore.
   * Returns { created, updated, completed } counts.
   */
  async sync(opts = {}) {
    const result = await this._sync(opts);
    // Surfaced via /integrations/status so skip reasons are visible.
    this.lastSyncResult = { at: new Date().toISOString(), ...result };
    return result;
  }

  async _sync({ now = new Date() } = {}) {
    if (!this.isConfigured()) return { skipped: true, reason: "LINEAR_API_KEY not set" };
    if (!this.runtime?.tasks?.add) return { skipped: true, reason: "task store not available" };

    let data;
    try {
      data = await this.query(ASSIGNED_ISSUES_QUERY, { limit: 50 });
    } catch (err) {
      return { skipped: true, reason: `linear api: ${err.message}` };
    }

    const issues = data?.viewer?.assignedIssues?.nodes ?? [];
    let created = 0;
    let updated = 0;
    let completed = 0;

    // Build an id-indexed map of existing Linear-sourced tasks once, so
    // we don't iterate the full task list per issue.
    const existing = new Map();
    for (const t of this.runtime.tasks.list({ limit: 500 })) {
      if (t.source === "linear" && t.sourceId) existing.set(t.sourceId, t);
    }

    for (const issue of issues) {
      const sourceId = `linear:${issue.id}`;
      const isDone = issue.state?.type === "completed" || issue.state?.type === "canceled";
      const matched = existing.get(sourceId);

      if (matched) {
        // Issue exists as a task — check for state changes.
        if (isDone && matched.status !== "completed") {
          this.runtime.tasks.complete(matched.id, "linear-poll");
          completed += 1;
        } else if (!isDone && (matched.title !== issue.title || matched.priority !== mapPriority(issue.priority))) {
          this.runtime.tasks.update(matched.id, {
            title: issue.title,
            priority: mapPriority(issue.priority),
            dueDate: issue.dueDate,
            description: issue.description ?? matched.description
          });
          updated += 1;
        }
      } else if (!isDone || this.includeCompleted) {
        // New task.
        this.runtime.tasks.add(
          {
            title: `${issue.identifier} — ${issue.title}`,
            description: issue.description ?? "",
            priority: mapPriority(issue.priority),
            bucket: pickBucket(issue.dueDate, now),
            dueDate: issue.dueDate ?? null,
            tags: [issue.team?.key, issue.project?.name].filter(Boolean),
            sourceId,
            sourceUrl: issue.url,
            sourceMeta: {
              identifier: issue.identifier,
              team: issue.team?.name,
              project: issue.project?.name,
              state: issue.state?.name,
              linearUpdatedAt: issue.updatedAt
            }
          },
          { source: "linear", queue: "user" }
        );
        created += 1;
      }
    }

    this.lastSyncedAt = now.toISOString();
    return { created, updated, completed, scanned: issues.length };
  }
}

// Linear priority is 0 (no priority) - 4 (urgent). OpenAGI is 0-100.
function mapPriority(p) {
  switch (p) {
    case 1: return 95;  // Urgent
    case 2: return 80;  // High
    case 3: return 55;  // Medium
    case 4: return 30;  // Low
    default: return 50; // No priority set
  }
}

// If the issue is due today/tomorrow → today. Within a week → this_week.
// Else → someday. No due date → this_week (the autolist convention).
function pickBucket(dueDateIso, now = new Date()) {
  if (!dueDateIso) return "this_week";
  const due = Date.parse(dueDateIso);
  if (!Number.isFinite(due)) return "this_week";
  const days = (due - now.getTime()) / (24 * 3600 * 1000);
  if (days < 1.5) return "today";
  if (days < 7) return "this_week";
  // Story 8: tasks with a real due date land in the appropriate medium-
  // horizon bucket instead of all collapsing into "someday." 35d ≈ this
  // month, 95d ≈ this quarter, 365d ≈ this year, beyond that → someday.
  if (days < 35) return "this_month";
  if (days < 95) return "this_quarter";
  if (days < 365) return "this_year";
  return "someday";
}

export function registerLinearTaskSource(runtime, options = {}) {
  const source = options.source ?? new LinearTaskSource({ runtime, ...options });
  // Register the source + cron job even when LINEAR_API_KEY is missing at
  // boot (same pattern as the BuildBetter source): sync() self-gates on
  // isConfigured(), which reads the env live, so a key added later via the
  // setup wizard is picked up on the next 5-min tick — previously the cron
  // job was never installed and Linear stayed dead until a restart.
  if (runtime.cron?.addJob) {
    runtime.cron.addJob({
      id: "linear-task-sync",
      name: "Linear assigned-issues → tasks",
      enabled: true,
      task: "linear-task-sync",
      intervalMs: POLL_INTERVAL_MS
    });
  }
  runtime.linearTaskSource = source;
  return { registered: true, idle: !source.isConfigured() };
}
