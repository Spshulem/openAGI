// Curated catalog of known MCP servers, used for two purposes:
//
//   1. Proactive observer auto-suggest — when it sees a matching app
//      bundle id, hostname, or keyword in OCR, it can propose
//      "Connect this MCP" via category="mcp" suggestion.
//
//   2. Manual browse + connect from the Integrations dashboard tab.
//
// Each entry:
//   - id              stable slug, used as MCP server name when registered
//   - name            display name
//   - description     one-line summary
//   - category        for UI grouping
//   - authType        "api-key" | "oauth" — what the user has to set up
//   - status          "available" | "coming-soon" — coming-soon entries
//                     are listed but not connectable yet
//   - matches         optional — bundle ids / hostnames / keywords for
//                     proactive observer auto-suggest
//   - register        optional — { transport, url, auth, command, args }
//                     for one-click registration via /integrations/connect-mcp.
//                     Coming-soon entries can leave this null.

export const CATEGORIES = [
  { id: "project-management", name: "Project Management" },
  { id: "analytics", name: "Analytics & Product Intelligence" },
  { id: "developer-tools", name: "Developer Tools" },
  { id: "crm", name: "CRM & Customer" },
  { id: "design-docs", name: "Design & Docs" },
  { id: "communication", name: "Communication" },
  { id: "calls-meetings", name: "Calls & Meetings" },
  { id: "filesystem", name: "Filesystem" }
];

export const MCP_CATALOG = [
  // ─── Project Management ─────────────────────────────────────────────
  {
    id: "linear",
    name: "Linear",
    description: "Manage Linear issues, projects, and cycles.",
    category: "project-management",
    authType: "oauth",
    status: "available",
    matches: {
      bundleIds: ["com.linear", "com.linear.linear"],
      hostnames: ["linear.app", "linear.app/team"],
      keywords: ["linear", "linear.app", "issue tracker"]
    },
    register: { url: "https://mcp.linear.app/mcp", transport: "http", auth: "oauth" }
  },
  {
    id: "jira",
    name: "Jira & Confluence",
    description: "Access Jira issues and Confluence pages via Atlassian.",
    category: "project-management",
    authType: "oauth",
    status: "available",
    matches: { hostnames: ["atlassian.net", "jira.com", "confluence.com"], keywords: ["jira", "confluence"] },
    register: { url: "https://mcp.atlassian.com/v1/mcp", transport: "http", auth: "oauth" }
  },
  {
    id: "asana",
    name: "Asana",
    description: "Manage Asana tasks, projects, and workflows.",
    category: "project-management",
    authType: "oauth",
    status: "available",
    matches: { hostnames: ["asana.com"], keywords: ["asana"] },
    register: { url: "https://mcp.asana.com/v2/mcp", transport: "http", auth: "oauth" }
  },
  {
    id: "monday",
    name: "monday.com",
    description: "Access monday.com boards, items, and automations.",
    category: "project-management",
    authType: "oauth",
    status: "available",
    matches: { hostnames: ["monday.com"], keywords: ["monday.com"] },
    register: { url: "https://mcp.monday.com/mcp", transport: "http", auth: "oauth" }
  },
  {
    id: "clickup",
    name: "ClickUp",
    description: "Manage ClickUp tasks, spaces, and docs.",
    category: "project-management",
    authType: "oauth",
    status: "available",
    matches: { hostnames: ["clickup.com", "app.clickup.com"], keywords: ["clickup"] },
    register: { url: "https://mcp.clickup.com/mcp", transport: "http", auth: "oauth" }
  },

  // ─── Analytics & Product Intelligence ───────────────────────────────
  {
    id: "posthog",
    name: "PostHog",
    description: "Query PostHog analytics data and insights.",
    category: "analytics",
    authType: "api-key",
    status: "available",
    apiKeyEnvVar: "POSTHOG_MCP_API_KEY",
    apiKeyHelp: "Personal API key from PostHog → Settings → User API keys.",
    matches: { hostnames: ["posthog.com", "app.posthog.com"], keywords: ["posthog"] },
    register: { url: "https://mcp.posthog.com/sse", transport: "http", auth: "bearer" }
  },
  {
    id: "mixpanel",
    name: "Mixpanel",
    description: "Access Mixpanel analytics, funnels, and retention data.",
    category: "analytics",
    authType: "oauth",
    status: "available",
    matches: { hostnames: ["mixpanel.com"], keywords: ["mixpanel"] },
    register: { url: "https://mcp.mixpanel.com/mcp", transport: "http", auth: "oauth" }
  },
  {
    id: "amplitude",
    name: "Amplitude",
    description: "Query Amplitude analytics and behavioral data.",
    category: "analytics",
    authType: "oauth",
    status: "available",
    matches: { hostnames: ["amplitude.com"], keywords: ["amplitude"] },
    register: { url: "https://mcp.amplitude.com/mcp", transport: "http", auth: "oauth" }
  },
  {
    id: "pendo",
    name: "Pendo",
    description: "Access Pendo product analytics and user guides.",
    category: "analytics",
    authType: "oauth",
    status: "available",
    matches: { hostnames: ["pendo.io"], keywords: ["pendo"] },
    register: { url: "https://app.pendo.io/mcp/v0/shttp", transport: "http", auth: "oauth" }
  },
  {
    id: "datadog",
    name: "Datadog",
    description: "Query Datadog monitoring, metrics, and dashboards.",
    category: "analytics",
    authType: "oauth",
    status: "available",
    matches: { hostnames: ["datadoghq.com"], keywords: ["datadog"] },
    register: { url: "https://mcp.datadoghq.com/api/unstable/mcp-server/mcp", transport: "http", auth: "oauth" }
  },
  {
    id: "statsig",
    name: "Statsig",
    description: "Access Statsig feature flags and experiment results.",
    category: "analytics",
    authType: "api-key",
    status: "available",
    apiKeyEnvVar: "STATSIG_API_KEY",
    apiKeyHelp: "Console API key from Statsig → Project Settings → Keys & Environments.",
    matches: { hostnames: ["statsig.com", "console.statsig.com"], keywords: ["statsig"] },
    // Statsig's hosted MCP needs a custom `statsig-api-key` header, which
    // our http+bearer transport doesn't support directly. Use the
    // mcp-remote stdio bridge instead — same UX, different wire shape.
    register: {
      transport: "stdio",
      command: "npx",
      args: ["-y", "mcp-remote", "https://api.statsig.com/v1/mcp", "--header", "statsig-api-key=\${STATSIG_API_KEY}"]
    }
  },
  {
    id: "sentry",
    name: "Sentry",
    description: "Query Sentry error tracking and performance data.",
    category: "analytics",
    authType: "oauth",
    status: "available",
    matches: { hostnames: ["sentry.io"], keywords: ["sentry"] },
    register: { url: "https://mcp.sentry.dev/mcp", transport: "http", auth: "oauth" }
  },

  // ─── Developer Tools ────────────────────────────────────────────────
  {
    id: "github",
    name: "GitHub",
    description: "Access GitHub repos, issues, PRs, and actions.",
    category: "developer-tools",
    authType: "api-key",
    status: "available",
    matches: {
      bundleIds: ["com.github.GitHubDesktop"],
      hostnames: ["github.com"],
      keywords: ["github", "pull request", "PR #"]
    },
    register: { url: "https://api.githubcopilot.com/mcp/", transport: "http", auth: "oauth" }
  },
  {
    id: "stripe",
    name: "Stripe",
    description: "Access Stripe payments, customers, and subscriptions.",
    category: "developer-tools",
    authType: "api-key",
    status: "available",
    apiKeyEnvVar: "STRIPE_MCP_API_KEY",
    apiKeyHelp: "Restricted API key from Stripe → Developers → API keys (sk_live_… or rk_live_…).",
    matches: { hostnames: ["stripe.com", "dashboard.stripe.com"], keywords: ["stripe"] },
    register: { url: "https://mcp.stripe.com/", transport: "http", auth: "bearer" }
  },
  {
    id: "vercel",
    name: "Vercel",
    description: "Manage Vercel deployments, projects, and domains.",
    category: "developer-tools",
    authType: "oauth",
    status: "available",
    matches: { hostnames: ["vercel.com"], keywords: ["vercel"] },
    register: { url: "https://mcp.vercel.com", transport: "http", auth: "oauth" }
  },
  {
    id: "gitlab",
    name: "GitLab",
    description: "Access GitLab projects, merge requests, and pipelines (gitlab.com — for self-hosted, register manually with your instance URL).",
    category: "developer-tools",
    authType: "oauth",
    status: "available",
    matches: { hostnames: ["gitlab.com"], keywords: ["gitlab"] },
    register: { url: "https://gitlab.com/api/v4/mcp", transport: "http", auth: "oauth" }
  },
  {
    id: "cloudflare",
    name: "Cloudflare",
    description: "Manage Cloudflare workers, pages, and DNS.",
    category: "developer-tools",
    authType: "oauth",
    status: "available",
    matches: { hostnames: ["cloudflare.com", "dash.cloudflare.com"], keywords: ["cloudflare"] },
    register: { url: "https://mcp.cloudflare.com/mcp", transport: "http", auth: "oauth" }
  },
  {
    id: "supabase",
    name: "Supabase",
    description: "Access Supabase databases, auth, and storage.",
    category: "developer-tools",
    authType: "api-key",
    status: "available",
    apiKeyEnvVar: "SUPABASE_ACCESS_TOKEN",
    apiKeyHelp: "Personal access token from Supabase → Account → Access Tokens.",
    matches: { hostnames: ["supabase.com", "app.supabase.com"], keywords: ["supabase"] },
    // Supabase ships an stdio MCP via npm; the env block tells the
    // child process where to find the token (which the registry
    // expands from the user's .env at register time).
    register: {
      transport: "stdio",
      command: "npx",
      args: ["-y", "@supabase/mcp-server-supabase"],
      env: { SUPABASE_ACCESS_TOKEN: "\${SUPABASE_ACCESS_TOKEN}" }
    }
  },
  {
    id: "airtable",
    name: "Airtable",
    description: "Read and write Airtable bases, tables, fields, and records — create/update structured data.",
    category: "developer-tools",
    authType: "api-key",
    status: "available",
    apiKeyEnvVar: "AIRTABLE_API_KEY",
    apiKeyHelp: "Personal access token from Airtable → Builder hub → Personal access tokens (scopes: schema.bases:read, data.records:read, data.records:write).",
    matches: { hostnames: ["airtable.com"], keywords: ["airtable", "base", "no-code database"] },
    // Airtable ships an stdio MCP via npm; the token is read from the env, which
    // the registry expands from the user's .env at register time.
    register: {
      transport: "stdio",
      command: "npx",
      args: ["-y", "airtable-mcp-server"],
      env: { AIRTABLE_API_KEY: "\${AIRTABLE_API_KEY}" }
    }
  },
  {
    id: "neon",
    name: "Neon",
    description: "Manage Neon serverless Postgres databases and branches.",
    category: "developer-tools",
    authType: "oauth",
    status: "available",
    matches: { hostnames: ["neon.tech", "console.neon.tech"], keywords: ["neon"] },
    register: { url: "https://mcp.neon.tech/mcp", transport: "http", auth: "oauth" }
  },

  // ─── CRM & Customer ─────────────────────────────────────────────────
  {
    id: "hubspot",
    name: "HubSpot",
    description: "Access HubSpot CRM contacts, deals, and marketing data.",
    category: "crm",
    authType: "oauth",
    status: "available",
    matches: { hostnames: ["hubspot.com", "app.hubspot.com"], keywords: ["hubspot"] },
    register: { url: "https://mcp.hubspot.com/", transport: "http", auth: "oauth" }
  },
  {
    id: "intercom",
    name: "Intercom",
    description: "Query Intercom conversations and customer data.",
    category: "crm",
    authType: "oauth",
    status: "available",
    matches: { hostnames: ["intercom.com", "app.intercom.com"], keywords: ["intercom"] },
    register: { url: "https://mcp.intercom.com/mcp", transport: "http", auth: "oauth" }
  },
  {
    id: "attio",
    name: "Attio",
    description: "Access Attio CRM records and workflows.",
    category: "crm",
    authType: "oauth",
    status: "available",
    matches: { hostnames: ["attio.com", "app.attio.com"], keywords: ["attio"] },
    register: { url: "https://mcp.attio.com/mcp", transport: "http", auth: "oauth" }
  },

  // ─── Design & Docs ──────────────────────────────────────────────────
  {
    id: "notion",
    name: "Notion",
    description: "Read pages, databases, search workspace content via Notion's API.",
    category: "design-docs",
    authType: "oauth",
    status: "available",
    matches: { bundleIds: ["notion.id"], hostnames: ["notion.so", "notion.site"], keywords: ["notion"] },
    register: { url: "https://mcp.notion.com/sse", transport: "http", auth: "oauth" }
  },
  {
    id: "figma",
    name: "Figma",
    description: "Access Figma designs, components, and variables.",
    category: "design-docs",
    authType: "oauth",
    status: "available",
    matches: { hostnames: ["figma.com"], keywords: ["figma"] },
    register: { url: "https://mcp.figma.com/mcp", transport: "http", auth: "oauth" }
  },
  {
    id: "miro",
    name: "Miro",
    description: "Access Miro boards, frames, and sticky notes.",
    category: "design-docs",
    authType: "oauth",
    status: "available",
    matches: { hostnames: ["miro.com"], keywords: ["miro"] },
    register: { url: "https://mcp.miro.com/", transport: "http", auth: "oauth" }
  },
  {
    id: "webflow",
    name: "Webflow",
    description: "Manage Webflow sites, collections, and CMS items (Designer Bridge App must be open for canvas tools).",
    category: "design-docs",
    authType: "oauth",
    status: "available",
    matches: { hostnames: ["webflow.com"], keywords: ["webflow"] },
    register: { url: "https://mcp.webflow.com/sse", transport: "http", auth: "oauth" }
  },
  {
    id: "remarkable",
    name: "reMarkable",
    description: "Read your reMarkable tablet's documents + handwritten notes (via SamMorrowDrums/remarkable-mcp).",
    category: "design-docs",
    authType: "api-key",
    status: "available",
    matches: { hostnames: ["my.remarkable.com", "remarkable.com"], keywords: ["remarkable", "rmapi"] },
    register: { transport: "stdio", command: "npx", args: ["-y", "@sammorrowdrums/remarkable-mcp"] }
  },

  // ─── Communication ──────────────────────────────────────────────────
  {
    id: "slack",
    name: "Slack",
    description: "Access Slack channels, messages, and user data. Coming soon — Slack's hosted MCP requires you to register your own Slack app and provide its client_id + client_secret, which the wizard doesn't collect yet.",
    category: "communication",
    authType: "oauth",
    status: "coming-soon",
    matches: { bundleIds: ["com.tinyspeck.slackmacgap"], hostnames: ["slack.com", "app.slack.com"], keywords: ["slack"] }
    // The hosted MCP at https://mcp.slack.com/mcp uses confidential
    // OAuth — clientId/clientSecret are required, not just a redirect.
    // Holding this until we surface clientId/clientSecret collection
    // in the dashboard catalog card the same way we do API keys.
  },

  // ─── Calls & Meetings ───────────────────────────────────────────────
  {
    id: "buildbetter",
    name: "BuildBetter",
    description: "Search calls, read transcripts, list action items / commitments / signals from your BuildBetter workspace.",
    category: "calls-meetings",
    authType: "oauth",
    status: "available",
    matches: { hostnames: ["buildbetter.app", "app.buildbetter.app"], keywords: ["buildbetter", "action item", "interview"] },
    // url is a getter so BUILDBETTER_MCP_URL (e.g. a staging MCP server) is
    // read when the server is REGISTERED, not at module import — .env loads
    // after imports in the hosted-server boot order.
    register: { get url() { return process.env.BUILDBETTER_MCP_URL ?? "https://mcp.buildbetter.app/sse"; }, transport: "http", auth: "oauth" }
  },
  {
    id: "rize",
    name: "Rize.io",
    description: "Time-tracking + activity API. On-demand 'what was I working on yesterday?' queries via MCP.",
    category: "calls-meetings",
    authType: "oauth",
    status: "available",
    matches: { bundleIds: ["io.rize"], hostnames: ["rize.io", "my.rize.io"], keywords: ["rize", "rize.io"] },
    register: { url: "https://mcp.rize.io/sse", transport: "http", auth: "oauth" }
  },

  // ─── Filesystem ─────────────────────────────────────────────────────
  {
    id: "filesystem-tmp",
    name: "Filesystem (read-only on /tmp)",
    description: "Lets the agent read scratch files in /tmp for grounding.",
    category: "filesystem",
    authType: "api-key",
    status: "available",
    matches: { keywords: ["pbcopy", "/tmp/", "scratch"] },
    register: { transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] }
  }
];

// Given recent activity rows (apps + OCR snippets), return the MCP catalog
// entries whose match-criteria fire. Each result includes the trigger
// (which bundleId / keyword) so the proposal prompt can reference it.
// Only matches "available" entries — coming-soon are listed in the UI
// but not auto-suggested.
export function matchCatalog(activity, snippets, alreadyRegistered = new Set()) {
  const hits = [];
  const seenIds = new Set();
  const ocrText = (snippets ?? []).map((s) => s.text ?? "").join(" ").toLowerCase();
  const apps = new Set((activity ?? []).map((a) => (a.app ?? "").toLowerCase()));

  for (const entry of MCP_CATALOG) {
    if (entry.status !== "available") continue;
    if (alreadyRegistered.has(entry.id) || alreadyRegistered.has(entry.name.toLowerCase())) continue;
    if (seenIds.has(entry.id)) continue;

    let trigger = null;
    for (const bid of entry.matches?.bundleIds ?? []) {
      if (apps.has(bid.toLowerCase())) { trigger = `app: ${bid}`; break; }
    }
    if (!trigger) {
      for (const host of entry.matches?.hostnames ?? []) {
        if (ocrText.includes(host.toLowerCase())) { trigger = `host: ${host}`; break; }
      }
    }
    if (!trigger) {
      for (const kw of entry.matches?.keywords ?? []) {
        if (ocrText.includes(kw.toLowerCase())) { trigger = `keyword: ${kw}`; break; }
      }
    }
    if (trigger) {
      hits.push({ entry, trigger });
      seenIds.add(entry.id);
    }
  }
  return hits;
}
