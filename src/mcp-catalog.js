// Curated catalog of known MCP servers, keyed by app bundle id / hostname /
// keyword that signals "this user is engaging with X — they could probably
// benefit from connecting X's MCP." Used by the ProactiveObserver to surface
// "want to add this MCP?" suggestions.
//
// Conservative on purpose — only includes servers we're confident actually
// exist + map cleanly to a detectable app or domain. Better to miss a
// suggestion than spam the user with bogus ones.

export const MCP_CATALOG = [
  {
    id: "linear",
    name: "Linear",
    description: "Read/create/update issues, projects, sprints from your Linear workspace.",
    matches: {
      bundleIds: ["com.linear", "com.linear.linear"],
      hostnames: ["linear.app", "linear.app/team"],
      keywords: ["linear", "linear.app", "issue tracker"]
    },
    register: {
      url: "https://mcp.linear.app/sse",
      transport: "http",
      auth: "oauth"
    }
  },
  {
    id: "notion",
    name: "Notion",
    description: "Read pages, databases, search workspace content via Notion's API.",
    matches: {
      bundleIds: ["notion.id"],
      hostnames: ["notion.so", "notion.site"],
      keywords: ["notion"]
    },
    register: {
      url: "https://mcp.notion.com/sse",
      transport: "http",
      auth: "oauth"
    }
  },
  {
    id: "github",
    name: "GitHub",
    description: "Search repos, read PRs/issues, browse code without leaving the agent.",
    matches: {
      bundleIds: ["com.github.GitHubDesktop"],
      hostnames: ["github.com"],
      keywords: ["github", "pull request", "PR #"]
    },
    register: {
      url: "https://api.githubcopilot.com/mcp/",
      transport: "http",
      auth: "oauth"
    }
  },
  {
    id: "slack",
    name: "Slack",
    description: "Read messages, post to channels, search history.",
    matches: {
      bundleIds: ["com.tinyspeck.slackmacgap"],
      hostnames: ["slack.com", "app.slack.com"],
      keywords: ["slack", "DM ", "channel #"]
    },
    register: {
      // Slack itself doesn't run a hosted MCP yet; this is a placeholder for
      // the most common community implementation. Update when official ships.
      url: null,
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-slack"]
    }
  },
  {
    id: "rize",
    name: "Rize.io",
    description: "Time-tracking + activity API. On-demand 'what was I working on yesterday?' / project-time-aggregation queries via MCP.",
    matches: {
      bundleIds: ["io.rize"],
      hostnames: ["rize.io", "my.rize.io"],
      keywords: ["rize", "rize.io"]
    },
    register: {
      url: "https://mcp.rize.io/sse",
      transport: "http",
      auth: "oauth"
    }
  },
  {
    id: "buildbetter",
    name: "BuildBetter",
    description: "Search calls, read transcripts, list action items / commitments / signals from your BuildBetter workspace. Useful when you want on-demand call recall — pair with the BuildBetter direct API source for automatic action-item ingestion into tasks.",
    matches: {
      bundleIds: [],
      hostnames: ["buildbetter.app", "app.buildbetter.app"],
      keywords: ["buildbetter", "action item", "call summary", "interview"]
    },
    register: {
      url: "https://mcp.buildbetter.app/sse",
      transport: "http",
      auth: "oauth"
    }
  },
  {
    id: "remarkable",
    name: "reMarkable",
    description: "Read your reMarkable tablet's documents + handwritten notes. Implementation: github.com/SamMorrowDrums/remarkable-mcp. Pairs well with the inbox folder for full bidirectional task sync.",
    matches: {
      bundleIds: [],
      hostnames: ["my.remarkable.com", "remarkable.com"],
      keywords: ["remarkable", "rmapi"]
    },
    register: {
      transport: "stdio",
      command: "npx",
      args: ["-y", "@sammorrowdrums/remarkable-mcp"]
    }
  },
  {
    id: "filesystem-tmp",
    name: "Filesystem (read-only on /tmp)",
    description: "Lets the agent read scratch files in /tmp for grounding.",
    matches: {
      bundleIds: [],
      hostnames: [],
      keywords: ["pbcopy", "/tmp/", "scratch"]
    },
    register: {
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
    }
  }
];

// Given recent activity rows (apps + OCR snippets), return the MCP catalog
// entries whose match-criteria fire. Each result includes the trigger
// (which bundleId / keyword) so the proposal prompt can reference it.
export function matchCatalog(activity, snippets, alreadyRegistered = new Set()) {
  const hits = [];
  const seenIds = new Set();
  const ocrText = (snippets ?? []).map((s) => s.text ?? "").join(" ").toLowerCase();
  const apps = new Set((activity ?? []).map((a) => (a.app ?? "").toLowerCase()));

  for (const entry of MCP_CATALOG) {
    if (alreadyRegistered.has(entry.id) || alreadyRegistered.has(entry.name.toLowerCase())) continue;
    if (seenIds.has(entry.id)) continue;

    let trigger = null;
    for (const bid of entry.matches.bundleIds ?? []) {
      if (apps.has(bid.toLowerCase())) { trigger = `app: ${bid}`; break; }
    }
    if (!trigger) {
      for (const host of entry.matches.hostnames ?? []) {
        if (ocrText.includes(host.toLowerCase())) { trigger = `host: ${host}`; break; }
      }
    }
    if (!trigger) {
      for (const kw of entry.matches.keywords ?? []) {
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
