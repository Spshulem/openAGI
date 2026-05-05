// Rize.io integration. Self-registers tools on the runtime when RIZE_API_KEY is set.
// API docs: https://docs.rize.io/graphql-api/graphql-intro

const DEFAULT_ENDPOINT = "https://api.rize.io/api/v1/graphql";

export class RizeClient {
  constructor(options = {}) {
    this.apiKey = options.apiKey ?? process.env.RIZE_API_KEY;
    this.endpoint = options.endpoint ?? process.env.RIZE_GRAPHQL_ENDPOINT ?? DEFAULT_ENDPOINT;
    this.timeoutMs = options.timeoutMs ?? 30000;
  }

  isConfigured() {
    return Boolean(this.apiKey);
  }

  async query(query, variables = {}) {
    if (!this.apiKey) throw new Error("RIZE_API_KEY is not configured.");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(this.endpoint, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`
        },
        body: JSON.stringify({ query, variables })
      });
      const json = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(json?.errors?.[0]?.message ?? `Rize request failed with ${response.status}`);
      }
      if (json.errors?.length) {
        throw new Error(json.errors.map((e) => e.message).join("; "));
      }
      return json.data;
    } finally {
      clearTimeout(timer);
    }
  }
}

export function registerRizeIntegration(runtime, options = {}) {
  const client = options.client ?? new RizeClient(options);
  if (!client.isConfigured()) return { registered: false, reason: "RIZE_API_KEY not set" };

  runtime.tools.register({
    name: "rize_query",
    description: "Run a raw GraphQL query against the Rize.io API. Use for ad-hoc questions about the user's tracked time. Schema docs: https://docs.rize.io/graphql-api/graphql-intro",
    source: "integration:rize",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "GraphQL query or mutation string." },
        variables: { type: "object", description: "Variables object for the query.", additionalProperties: true }
      },
      required: ["query"],
      additionalProperties: false
    },
    handler: async (args) => client.query(args.query, args.variables ?? {})
  });

  runtime.tools.register({
    name: "rize_today_summary",
    description: "Get today's tracked time summary from Rize: total focus time, top categories, top projects.",
    source: "integration:rize",
    parameters: {
      type: "object",
      properties: {
        timezone: { type: "string", description: "IANA timezone (e.g. 'America/Los_Angeles'). Defaults to UTC." }
      },
      additionalProperties: false
    },
    handler: async () => {
      const start = startOfTodayIso();
      const end = endOfTodayIso();
      const data = await client.query(
        `query Today($start: ISO8601DateTime!, $end: ISO8601DateTime!) {
          summary(startTime: $start, endTime: $end) {
            totalSeconds
            focusSeconds
            categories { name totalSeconds }
            projects { name totalSeconds }
          }
        }`,
        { start, end }
      );
      return data?.summary ?? { totalSeconds: 0, focusSeconds: 0, categories: [], projects: [] };
    }
  });

  runtime.tools.register({
    name: "rize_recent_sessions",
    description: "List the user's most recent work sessions tracked by Rize.",
    source: "integration:rize",
    parameters: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 100, description: "Max sessions to return (default 10)." }
      },
      additionalProperties: false
    },
    handler: async (args) => {
      const limit = args.limit ?? 10;
      const data = await client.query(
        `query Sessions($first: Int!) {
          sessions(first: $first) {
            edges {
              node {
                id
                startTime
                endTime
                title
                category { name }
                project { name }
              }
            }
          }
        }`,
        { first: limit }
      );
      return (data?.sessions?.edges ?? []).map((e) => e.node);
    }
  });

  return { registered: true, tools: ["rize_query", "rize_today_summary", "rize_recent_sessions"] };
}

function startOfTodayIso() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

function endOfTodayIso() {
  const d = new Date();
  d.setHours(23, 59, 59, 999);
  return d.toISOString();
}
