// Project -> Theme/Workstream clustering, Paseo native workspace label sync,
// Scoped Project Supervisor hierarchy, and Manager-Level Goal Dispatch
// ("Go work on <feature> in <project>").

import { clampText, redactSecrets } from "./contracts.js";
import { listWorkspaces, readChatTranscript, startPaseoSession } from "./coordinator.js";
import { DEFAULT_DECISIONS_MODEL, DEFAULT_DECISIONS_TIMEOUT_MS, DEFAULT_DECISIONS_URL, matchGoalWithDecisions } from "./decisions-gate.js";

// Valid Paseo WorkspaceLabelColor enum values from `@getpaseo/protocol`.
export const PASEO_LABEL_COLORS = Object.freeze([
  "sky",
  "emerald",
  "violet",
  "amber",
  "orange",
  "pink",
  "indigo",
  "teal",
  "blue",
  "red"
]);

const THEME_RULES = [
  {
    name: "Audio, Video & Capture",
    color: "sky",
    pattern: /\b(audio|video|record(?:er|ing)?|mic(?:rophone)?|capture|call[- ]?detect|screen[- ]?capture|transcri(?:be|pt|ption)|whisper|speaker|diariz|stream[- ]?upload|bot[- ]?join|media[- ]?track)\b/i
  },
  {
    name: "Mobile (iOS & Android)",
    color: "violet",
    pattern: /\b(ios|android|mobile|swift(?:ui)?|xcode|apk|react[- ]?native|capacitor|iphone|ipad|kotlin|testflight|watchos)\b/i
  },
  {
    name: "Sales, CRM & Signals",
    color: "emerald",
    pattern: /\b(crm|hubspot|salesforce|attio|deal|pipeline|sales|signal|meddic|prospect|account[- ]?exec|coaching|battlecard|win[- ]?loss|objection)\b/i
  },
  {
    name: "Search, SEO & Citations",
    color: "amber",
    pattern: /\b(seo|citation|strictly|serp|ranking|keyword|backlink|crawl|index(?:ing|er)|aeo|geo|perplexity|search[- ]?visibility|schema[- ]?markup|sitemap)\b/i
  },
  {
    name: "AI Agents & Supervisor",
    color: "indigo",
    pattern: /\b(agent|supervisor|bob|llm|prompt|rag|embedding|decisions|autonomous|orchestrat|subagent|fleet|model[- ]?router|chat[- ]?assistant)\b/i
  },
  {
    name: "Reports, Docs & Summaries",
    color: "teal",
    pattern: /\b(report|summary|summaries|digest|brief|prd|notetaker|template|export|slide|deck|transcript[- ]?view|recap)\b/i
  },
  {
    name: "Integrations & Webhooks",
    color: "orange",
    pattern: /\b(mcp|slack|linear|jira|notion|zapier|webhook|oauth|calendar|zoom|teams|google[- ]?meet|sync|connector)\b/i
  },
  {
    name: "Billing, Auth & Permissions",
    color: "pink",
    pattern: /\b(billing|stripe|subscription|seat|pricing|invoice|auth|sso|saml|rbac|permission|workspace[- ]?access|login|onboarding[- ]?gate)\b/i
  },
  {
    name: "Release, Packaging & QA",
    color: "amber",
    pattern: /\b(release|notariz|dmg|installer|auto[- ]?update|sparkle|electron[- ]?builder|changelog|version[- ]?bump|e2e|playwright|qa|smoke[- ]?test)\b/i
  },
  {
    name: "Infrastructure & CI",
    color: "blue",
    pattern: /\b(infra|ci|cd|github[- ]?actions|workflow|docker|k8s|terraform|redis|postgres|prisma|migration|queue|worker|latency|cache|buildbot|deploy)\b/i
  },
  {
    name: "UI, UX & Frontend",
    color: "violet",
    pattern: /\b(ui|ux|sidebar|modal|drawer|layout|theme|dark[- ]?mode|table|filter|navigation|component|css|tailwind|chart|dashboard)\b/i
  }
];

const IGNORED_PASEO_LABELS = new Set(["history", "imported", "imported history", "default", "misc"]);

const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "work", "working",
  "make", "please", "can", "you", "hey", "let", "lets", "go", "get", "check", "see",
  "what", "whats", "left", "need", "needs", "want", "wanna", "thing", "stuff", "chat",
  "session", "agent", "project", "workspace", "update", "fix", "add", "build", "create",
  "start", "new", "existing", "current", "currently", "there", "here", "have", "has",
  "about", "inside", "also", "just", "like", "out", "right", "now"
]);

function slugify(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "general";
}

function deterministicColor(name) {
  let hash = 0;
  const str = String(name ?? "");
  for (let i = 0; i < str.length; i += 1) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return PASEO_LABEL_COLORS[Math.abs(hash) % PASEO_LABEL_COLORS.length];
}

function displayProjectLabel(projectName) {
  const clean = String(projectName ?? "").trim();
  if (!clean) return "Workspace";
  if (clean.toLowerCase() === "buildbetter" || clean.toLowerCase() === "bbapp") return "BuildBetter";
  return clean;
}

function sameProjectGroup(groupPrefix, projectName) {
  const g = String(groupPrefix ?? "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  const p = String(projectName ?? "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!g || !p) return false;
  if (g === p) return true;
  if ((g === "buildbetter" || g === "bbapp") && (p === "buildbetter" || p === "bbapp")) return true;
  return false;
}

export function inferSessionTheme(session = {}, projectName = "") {
  const rawLabels = Array.isArray(session?.paseoLabels) ? session.paseoLabels : [];
  for (const raw of rawLabels) {
    const trimmed = String(raw ?? "").trim();
    if (!trimmed || IGNORED_PASEO_LABELS.has(trimmed.toLowerCase())) continue;
    const slashIdx = trimmed.indexOf("/");
    if (slashIdx > 0) {
      const prefix = trimmed.slice(0, slashIdx).trim();
      const suffix = trimmed.slice(slashIdx + 1).trim();
      if (suffix && !IGNORED_PASEO_LABELS.has(suffix.toLowerCase())) {
        const themeName = sameProjectGroup(prefix, projectName) ? suffix : `${prefix} · ${suffix}`;
        return {
          name: themeName,
          color: deterministicColor(themeName),
          source: "paseo-label",
          rawLabel: trimmed
        };
      }
    }
    return {
      name: trimmed,
      color: deterministicColor(trimmed),
      source: "paseo-label",
      rawLabel: trimmed
    };
  }

  const primaryText = [session?.title, session?.workspace].filter(Boolean).join(" ");
  const secondaryText = [session?.cwd, ...(session?.prRefs ?? []), session?.snippet].filter(Boolean).join(" ");

  let bestRule = null;
  let bestScore = 0;
  for (const rule of THEME_RULES) {
    let score = 0;
    const pMatches = primaryText.match(new RegExp(rule.pattern.source, "gi"));
    const sMatches = secondaryText.match(new RegExp(rule.pattern.source, "gi"));
    if (pMatches) score += pMatches.length * 3;
    if (sMatches) score += sMatches.length;
    if (score > bestScore) {
      bestScore = score;
      bestRule = rule;
    }
  }

  if (bestRule && bestScore > 0) {
    return {
      name: bestRule.name,
      color: bestRule.color,
      source: "auto",
      rawLabel: null
    };
  }

  return {
    name: "General & Standalone",
    color: "sky",
    source: "auto",
    rawLabel: null
  };
}

export async function buildFleetHierarchy(supervisor, { project = null, includeArchived = false, limit = 40, factory = null } = {}) {
  const wsResult = await listWorkspaces(supervisor, {
    query: project ? String(project).trim() : "",
    includeArchived: Boolean(includeArchived),
    limit,
    maxSessionsPerWorkspace: 120,
    factory
  });

  const state = supervisor?.getState?.() ?? {};
  const openCards = Array.isArray(state.cards) ? state.cards : [];
  const cardsByThread = new Map();
  const cardsByPr = new Map();
  for (const card of openCards) {
    if (card?.threadKey) {
      const list = cardsByThread.get(card.threadKey) ?? [];
      list.push(card);
      cardsByThread.set(card.threadKey, list);
    }
    if (card?.prRef) {
      const list = cardsByPr.get(card.prRef) ?? [];
      list.push(card);
      cardsByPr.set(card.prRef, list);
    }
  }

  let totalThemes = 0;
  let totalRunning = 0;
  let totalOverlaps = 0;
  const projects = [];

  for (const ws of wsResult.workspaces ?? []) {
    totalRunning += ws.counts?.running ?? 0;
    totalOverlaps += (ws.overlaps ?? []).length;

    const themeBuckets = new Map();
    const projectCardMap = new Map();

    for (const session of ws.recentChats ?? []) {
      const inferred = inferSessionTheme(session, ws.name);
      const themeId = slugify(inferred.name);
      let bucket = themeBuckets.get(themeId);
      if (!bucket) {
        bucket = {
          id: themeId,
          name: inferred.name,
          color: inferred.color,
          labelPath: `${displayProjectLabel(ws.name)}/${inferred.name}`,
          source: inferred.source,
          counts: { running: 0, idle: 0, sleeping: 0, archived: 0, total: 0 },
          needsYouCount: 0,
          prRefsSet: new Set(),
          latestActivityAt: null,
          sessions: []
        };
        themeBuckets.set(themeId, bucket);
      } else if (inferred.source === "paseo-label") {
        bucket.source = "paseo-label";
      }

      bucket.counts.total += 1;
      if (session.state === "running" || session.state === "waiting") bucket.counts.running += 1;
      else if (session.state === "sleeping") bucket.counts.sleeping += 1;
      else if (session.state === "archived") bucket.counts.archived += 1;
      else bucket.counts.idle += 1;

      for (const ref of session.prRefs ?? []) bucket.prRefsSet.add(ref);
      if (!bucket.latestActivityAt || String(session.lastActivityAt ?? "") > bucket.latestActivityAt) {
        bucket.latestActivityAt = session.lastActivityAt ?? bucket.latestActivityAt;
      }

      const linkedCards = [
        ...(cardsByThread.get(session.key) ?? []),
        ...(session.prRefs ?? []).flatMap((r) => cardsByPr.get(r) ?? [])
      ];
      const uniqueCards = [];
      const seenCardIds = new Set();
      for (const c of linkedCards) {
        if (!c?.id || seenCardIds.has(c.id)) continue;
        seenCardIds.add(c.id);
        uniqueCards.push({
          id: c.id,
          headline: c.headline,
          category: c.category,
          recommendedLabel: c.primaryAction?.label ?? null
        });
        projectCardMap.set(c.id, {
          id: c.id,
          headline: c.headline,
          category: c.category,
          threadKey: c.threadKey ?? session.key,
          prRef: c.prRef ?? null,
          recommendedLabel: c.primaryAction?.label ?? null
        });
      }
      if (uniqueCards.length > 0) {
        bucket.needsYouCount += uniqueCards.length;
      }

      bucket.sessions.push({
        ...session,
        theme: inferred.name,
        themeId,
        themeSource: inferred.source,
        needsYouCount: uniqueCards.length,
        cards: uniqueCards
      });
    }

    const themes = [...themeBuckets.values()]
      .map(({ prRefsSet, ...b }) => ({
        ...b,
        prRefs: [...prRefsSet].slice(0, 8)
      }))
      .sort((a, b) =>
        (b.counts.running - a.counts.running)
        || (b.needsYouCount - a.needsYouCount)
        || ((a.name === "General & Standalone" ? 1 : 0) - (b.name === "General & Standalone" ? 1 : 0))
        || (b.counts.total - a.counts.total)
        || String(b.latestActivityAt ?? "").localeCompare(String(a.latestActivityAt ?? ""))
      );

    totalThemes += themes.length;
    const projectCards = [...projectCardMap.values()];

    projects.push({
      id: ws.id,
      name: ws.name,
      supervisorTitle: `${ws.name} Supervisor`,
      repo: ws.repo ?? null,
      counts: ws.counts,
      needsYouCount: projectCards.length,
      defaultTarget: ws.defaultTarget ?? null,
      hosts: ws.hosts ?? [],
      overlaps: ws.overlaps ?? [],
      referencedPrs: ws.referencedPrs ?? [],
      latestActivityAt: ws.latestActivityAt ?? null,
      cards: projectCards,
      themes
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    projectFilter: project ? String(project).trim() : null,
    totalProjects: projects.length,
    totalThemes,
    totalSessions: wsResult.totalSessions ?? 0,
    generalSupervisor: {
      title: "General Supervisor",
      runningCount: totalRunning,
      needsYouCount: openCards.length,
      overlapCount: totalOverlaps,
      headline:
        openCards.length > 0
          ? `${openCards.length} decision${openCards.length === 1 ? "" : "s"} waiting · ${totalRunning} active across ${projects.length} project${projects.length === 1 ? "" : "s"}`
          : `${totalRunning} active coding session${totalRunning === 1 ? "" : "s"} across ${projects.length} project${projects.length === 1 ? "" : "s"}`
    },
    projects
  };
}

async function applyPaseoWorkspaceLabelsViaDaemon(config, assignmentsByHost) {
  const [{ DaemonClient }, { createHostClient, createHostChannelTransport, HostTransportBudget }] = await Promise.all([
    import("@getpaseo/client/internal/daemon-client"),
    import("@getpaseo/client/node")
  ]);

  const budget = new HostTransportBudget();
  const origin = createHostClient(
    config.paseo.url ?? "ws://127.0.0.1:6767/ws",
    {
      clientId: `openagi-label-sync-${Date.now()}`,
      ...(config.paseo.password ? { password: config.paseo.password } : {}),
      reconnect: { enabled: false }
    },
    budget
  );

  const results = [];
  try {
    await origin.connect();
    const directory = await origin.listHosts();
    const selfId = directory?.self?.serverId ?? "local";

    for (const [serverId, items] of assignmentsByHost) {
      let hostClient = origin;
      let closeRemote = null;
      try {
        if (serverId !== selfId && serverId !== "local") {
          const scopeId = `label-sync-${Math.random().toString(36).slice(2, 10)}`;
          const routeId = await origin.openHostRoute(serverId, scopeId);
          hostClient = new DaemonClient({
            url: "ws://routed-host/ws",
            clientId: scopeId,
            transportFactory: createHostChannelTransport(origin, serverId, scopeId, routeId),
            reconnect: { enabled: false }
          });
          closeRemote = async () => {
            try { await hostClient.close(); } catch { /* ignore */ }
          };
          await hostClient.connect();
        }

        for (const item of items) {
          try {
            await hostClient.setWorkspaceLabel({
              workspaceId: item.workspaceId,
              label: { name: item.labelName, color: item.color },
              assigned: true
            });
            results.push({ ...item, ok: true });
          } catch (err) {
            results.push({ ...item, ok: false, error: clampText(err?.message ?? String(err), 140) });
          }
        }
      } catch (err) {
        for (const item of items) {
          results.push({ ...item, ok: false, error: clampText(err?.message ?? String(err), 140) });
        }
      } finally {
        if (closeRemote) await closeRemote();
      }
    }
  } finally {
    try { await origin.close(); } catch { /* ignore */ }
  }
  return results;
}

export async function syncThemesToPaseoLabels(supervisor, { project = null, dryRun = false, pinnedAssignments = null, factory = null, setLabelImpl = null } = {}) {
  let planned;
  if (Array.isArray(pinnedAssignments)) {
    planned = pinnedAssignments.filter((item) =>
      item?.workspaceId && /^wks_/i.test(item.workspaceId) && typeof item.labelName === "string" && item.labelName.trim()
    ).map((item) => ({
      serverId: item.serverId || "local",
      host: item.host || item.serverId || "local",
      workspaceId: item.workspaceId,
      project: item.project ?? null,
      theme: item.theme ?? null,
      labelName: item.labelName.trim(),
      color: PASEO_LABEL_COLORS.includes(item.color) ? item.color : "sky",
      sampleSessionTitle: item.sampleSessionTitle ?? null
    }));
  } else {
    const hierarchy = await buildFleetHierarchy(supervisor, { project, includeArchived: false, limit: 50, factory });
    const workspaceVotes = new Map();

    for (const prj of hierarchy.projects) {
      for (const theme of prj.themes) {
        if (theme.name === "General & Standalone") continue;
        for (const session of theme.sessions) {
          if (session.kind !== "paseo" || !session.workspaceId || !/^wks_/i.test(session.workspaceId)) continue;
          if (Array.isArray(session.paseoLabels) && session.paseoLabels.some((l) => !IGNORED_PASEO_LABELS.has(String(l).toLowerCase()))) {
            continue;
          }
          const compositeKey = `${session.serverId || "local"}:${session.workspaceId}`;
          const existing = workspaceVotes.get(compositeKey);
          const voteWeight = session.state === "running" ? 3 : session.state === "idle" ? 2 : 1;
          if (!existing || voteWeight > existing.weight) {
            workspaceVotes.set(compositeKey, {
              serverId: session.serverId || "local",
              host: session.host || session.serverId || "local",
              workspaceId: session.workspaceId,
              project: prj.name,
              theme: theme.name,
              labelName: theme.labelPath,
              color: PASEO_LABEL_COLORS.includes(theme.color) ? theme.color : "sky",
              sampleSessionTitle: session.title,
              weight: voteWeight
            });
          }
        }
      }
    }

    planned = [...workspaceVotes.values()].map(({ weight: _w, ...rest }) => rest);
  }
  if (dryRun || planned.length === 0) {
    return {
      ok: true,
      dryRun: Boolean(dryRun),
      plannedCount: planned.length,
      appliedCount: 0,
      failedCount: 0,
      assignments: planned
    };
  }

  let outcomes;
  if (typeof setLabelImpl === "function") {
    outcomes = [];
    for (const item of planned) {
      try {
        await setLabelImpl(item);
        outcomes.push({ ...item, ok: true });
      } catch (err) {
        outcomes.push({ ...item, ok: false, error: clampText(err?.message ?? String(err), 140) });
      }
    }
  } else {
    if (!supervisor?.config?.paseo?.enabled) {
      throw new Error("Paseo integration is not enabled on this supervisor.");
    }
    const byHost = new Map();
    for (const item of planned) {
      const list = byHost.get(item.serverId) ?? [];
      list.push(item);
      byHost.set(item.serverId, list);
    }
    outcomes = await applyPaseoWorkspaceLabelsViaDaemon(supervisor.config, byHost);
  }

  const appliedCount = outcomes.filter((o) => o.ok).length;
  const failedCount = outcomes.length - appliedCount;
  supervisor?.store?.recordAction?.({
    kind: "sync-themes",
    playbook: "paseo-labels",
    threadKey: null,
    status: failedCount === 0 ? "done" : "partial",
    by: "owner",
    reason: clampText(`synced ${appliedCount}/${outcomes.length} Paseo workspace theme labels${project ? ` for ${project}` : ""}`, 220)
  });

  return {
    ok: failedCount === 0 || appliedCount > 0,
    dryRun: false,
    plannedCount: planned.length,
    appliedCount,
    failedCount,
    assignments: outcomes
  };
}

function extractKeywords(text) {
  return [...new Set(
    String(text ?? "")
      .toLowerCase()
      .split(/[^a-z0-9_#-]+/)
      .map((t) => t.trim())
      .filter((t) => t.length >= 3 && !STOPWORDS.has(t))
  )];
}

function lexicalSimilarity(goal, goalTerms, text, { state = "idle", lastActivityAt = null } = {}) {
  if (!goalTerms.length) return 0;
  const hay = String(text ?? "").toLowerCase();
  if (!hay) return 0;

  let matched = 0;
  let rareBonus = 0;
  for (const term of goalTerms) {
    if (hay.includes(term)) {
      matched += 1;
      if (term.length >= 6 || /\d/.test(term)) rareBonus += 0.08;
    }
  }
  if (matched === 0) return 0;

  let bigramBonus = 0;
  for (let i = 0; i < goalTerms.length - 1; i += 1) {
    const phrase = `${goalTerms[i]} ${goalTerms[i + 1]}`;
    if (hay.includes(phrase)) bigramBonus += 0.18;
  }

  const coverage = matched / Math.min(goalTerms.length, 5);
  const stateBonus = state === "running" || state === "waiting" ? 0.06 : state === "idle" ? 0.03 : 0;
  const ageHours = lastActivityAt ? Math.max(0, (Date.now() - (Date.parse(lastActivityAt) || 0)) / 3_600_000) : 999;
  const recencyBonus = ageHours <= 24 ? 0.04 : ageHours <= 72 ? 0.02 : 0;
  return Math.min(1, coverage * 0.65 + rareBonus + bigramBonus + stateBonus + recencyBonus);
}

function clampTitleFromGoal(goal, projectName) {
  const cleaned = String(goal ?? "")
    .replace(/^(?:hey\s*,?\s*)?(?:please\s+)?(?:go\s+)?(?:work\s+on|build|fix|implement|add|update|investigate|check\s+on)\s+(?:this\s+|the\s+)?/i, "")
    .trim();
  const base = cleaned || String(goal ?? "").trim();
  return clampText(base || `${projectName} task`, 72);
}

function formatManagerDirective(goal, projectName) {
  const cleanGoal = String(goal ?? "").trim();
  return `${cleanGoal}\n\n(Routed by ${projectName} Supervisor — continue in this session if already in scope, verify your changes, and report concise status when ready.)`;
}

function resolveTargetProject(projects, explicitProject, goal) {
  if (explicitProject) {
    const q = String(explicitProject).trim().toLowerCase();
    const exact = projects.find((p) =>
      p.id === q
      || p.name.toLowerCase() === q
      || String(p.repo ?? "").toLowerCase() === q
      || String(p.repo ?? "").split("/")[1]?.toLowerCase() === q
    );
    if (exact) return exact;
    const partial = projects.find((p) =>
      p.name.toLowerCase().includes(q)
      || q.includes(p.name.toLowerCase())
      || String(p.repo ?? "").toLowerCase().includes(q)
    );
    if (partial) return partial;
  }

  const lowerGoal = String(goal ?? "").toLowerCase();
  const mentioned = projects.filter((p) => {
    const pName = p.name.toLowerCase();
    if (pName.length < 3 || pName === "unknown") return false;
    const escaped = pName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, "i").test(lowerGoal)) return true;
    if ((pName === "ai-seo" || pName === "aiseo") && /\b(?:ai[- ]?seo|my\s+seo)\b/i.test(lowerGoal)) return true;
    if ((pName === "bb-recorder" || pName === "bbrecorder") && /\bbb[- ]?recorder\b/i.test(lowerGoal)) return true;
    if (pName === "buildbetter" && /\b(?:buildbetter|bbapp)\b/i.test(lowerGoal)) return true;
    return false;
  });
  if (mentioned.length === 1) return mentioned[0];
  if (projects.length === 1) return projects[0];
  return null;
}

export async function dispatchManagerGoal(
  supervisor,
  {
    project = null,
    theme = null,
    goal = "",
    mode = "auto",
    targetKey = null,
    serverId = null,
    cwd = null,
    provider = null,
    factory = null,
    decisionsFetch = null,
    deadlineAt = null
  } = {}
) {
  const cleanGoal = String(goal ?? "").trim();
  if (!cleanGoal) {
    throw new Error("Provide a non-empty manager goal or directive.");
  }
  if (cleanGoal.length > 4000) {
    throw new Error("Goal exceeds 4,000 characters.");
  }

  const normalizedMode = ["preview", "auto", "execute", "force_new"].includes(String(mode ?? "auto").toLowerCase())
    ? String(mode ?? "auto").toLowerCase()
    : "auto";

  // Explicit session override (e.g. confirming a previewed chat from UI).
  if (targetKey && normalizedMode !== "preview" && normalizedMode !== "force_new") {
    const cleanKey = String(targetKey).trim();
    const sent = await supervisor.sendOwnerMessage(cleanKey, formatManagerDirective(cleanGoal, project || "Project"), { deadlineAt });
    const ok = sent?.delivery?.status === "sent";
    supervisor?.store?.recordAction?.({
      kind: "dispatch-goal",
      playbook: "manager-dispatch",
      threadKey: cleanKey,
      status: ok ? "sent" : "blocked",
      by: "owner",
      reason: clampText(`manager goal routed to ${cleanKey}: ${cleanGoal}`, 240)
    });
    return {
      ok,
      status: ok ? "routed_existing" : "blocked",
      project: project ? { id: String(project).toLowerCase(), name: String(project) } : null,
      matchedSession: { key: cleanKey },
      delivery: sent?.delivery ?? null
    };
  }

  // Always load full project list when `project` is unset so goal inference works,
  // or scoped when `project` is provided (falling back to full list if needed).
  let hierarchy = await buildFleetHierarchy(supervisor, {
    project: project ? String(project).trim() : null,
    includeArchived: false,
    limit: 50,
    factory
  });
  let targetProject = resolveTargetProject(hierarchy.projects, project, cleanGoal);
  if (!targetProject && project) {
    hierarchy = await buildFleetHierarchy(supervisor, { project: null, includeArchived: false, limit: 50, factory });
    targetProject = resolveTargetProject(hierarchy.projects, project, cleanGoal);
  }
  if (!targetProject) {
    const available = hierarchy.projects.slice(0, 8).map((p) => p.name).join(", ");
    throw new Error(
      project
        ? `Could not find project "${clampText(project, 80)}". Available projects: ${available || "none"}.`
        : `Specify which project this goal belongs to (available: ${available || "none"}).`
    );
  }

  const inferredTheme = inferSessionTheme({ title: cleanGoal }, targetProject.name);
  const themeFilter = theme ? String(theme).trim().toLowerCase() : null;

  const allSessions = targetProject.themes
    .filter((t) => !themeFilter || t.id === themeFilter || t.name.toLowerCase().includes(themeFilter))
    .flatMap((t) => t.sessions)
    .filter((s) => s.wakeable !== false && s.state !== "archived");

  const goalTerms = extractKeywords(cleanGoal).filter((t) => t !== targetProject.id && t !== targetProject.name.toLowerCase());

  const preRanked = allSessions
    .map((s) => {
      const surfaceText = [s.title, s.workspace, s.theme, ...(s.prRefs ?? []), s.snippet].filter(Boolean).join(" ");
      return {
        session: s,
        surfaceScore: lexicalSimilarity(cleanGoal, goalTerms, surfaceText, s),
        recentContext: s.snippet ?? "",
        transcriptMessages: []
      };
    })
    .sort((a, b) =>
      (b.surfaceScore - a.surfaceScore)
      || ((a.session.state === "running" ? 0 : a.session.state === "idle" ? 1 : 2) - (b.session.state === "running" ? 0 : b.session.state === "idle" ? 1 : 2))
      || String(b.session.lastActivityAt ?? "").localeCompare(String(a.session.lastActivityAt ?? ""))
    );

  // Inspect actual Paseo/local chat transcripts for top 4 candidates so we match
  // workstreams discussed inside the conversation even when chat titles are terse!
  if (normalizedMode !== "force_new" && preRanked.length > 0) {
    const topToRead = preRanked.slice(0, 4);
    await Promise.all(topToRead.map(async (entry) => {
      try {
        let timer;
        const tr = await Promise.race([
          readChatTranscript(supervisor, { key: entry.session.key, limit: 8, factory }),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error("transcript timeout")), 5_000);
            timer.unref?.();
          })
        ]).finally(() => clearTimeout(timer));
        if (Array.isArray(tr?.messages) && tr.messages.length > 0) {
          entry.transcriptMessages = tr.messages.slice(-4).map((m) => ({
            role: m.role,
            text: clampText(redactSecrets(m.text ?? ""), 280),
            at: m.at ?? null
          }));
          entry.recentContext = tr.messages
            .slice(-6)
            .map((m) => `[${m.role}]: ${clampText(m.text ?? "", 320)}`)
            .join("\n");
        }
      } catch {
        // Keep surface snippet if transcript fetch times out.
      }
    }));
  }

  for (const entry of preRanked) {
    const combinedText = [
      entry.session.title,
      entry.session.workspace,
      entry.session.theme,
      ...(entry.session.prRefs ?? []),
      entry.recentContext
    ].filter(Boolean).join("\n");
    entry.lexicalScore = Math.max(entry.surfaceScore, lexicalSimilarity(cleanGoal, goalTerms, combinedText, entry.session));
    entry.decisionProb = null;
  }

  preRanked.sort((a, b) => b.lexicalScore - a.lexicalScore);

  const decisionsCfg = supervisor?.config?.decisions ?? {};
  let usedDecisionsModel = false;
  if (normalizedMode !== "force_new" && preRanked.length > 0 && decisionsCfg.enabled && decisionsCfg.apiKey) {
    const matcherCandidates = preRanked.slice(0, 6).map((e) => ({
      key: e.session.key,
      title: e.session.title,
      theme: e.session.theme,
      state: e.session.state,
      prRefs: e.session.prRefs,
      recentContext: e.recentContext
    }));
    const decisionRes = await matchGoalWithDecisions({
      goal: cleanGoal,
      project: targetProject.name,
      candidates: matcherCandidates,
      apiKey: decisionsCfg.apiKey,
      url: decisionsCfg.url || DEFAULT_DECISIONS_URL,
      model: decisionsCfg.model || DEFAULT_DECISIONS_MODEL,
      timeoutMs: decisionsCfg.timeoutMs || DEFAULT_DECISIONS_TIMEOUT_MS,
      fetchImpl: decisionsFetch ?? supervisor?.deps?.decisionsFetch ?? globalThis.fetch
    });
    if (decisionRes.ok) {
      usedDecisionsModel = true;
      for (const entry of preRanked) {
        if (decisionRes.scores.has(entry.session.key)) {
          entry.decisionProb = decisionRes.scores.get(entry.session.key);
        }
      }
    }
  }

  for (const entry of preRanked) {
    entry.finalScore = typeof entry.decisionProb === "number"
      ? entry.decisionProb * 0.75 + entry.lexicalScore * 0.25
      : entry.lexicalScore;
  }
  preRanked.sort((a, b) => b.finalScore - a.finalScore);

  const best = preRanked[0] ?? null;
  const strongExistingMatch = normalizedMode !== "force_new" && Boolean(best) && (
    usedDecisionsModel
      ? ((best.decisionProb ?? 0) >= 0.55 || ((best.decisionProb ?? 0) >= 0.42 && best.lexicalScore >= 0.45))
      : best.lexicalScore >= 0.34
  );

  const resolvedCwd = cwd || targetProject.defaultTarget?.cwd || null;
  const resolvedServerId = serverId || targetProject.defaultTarget?.serverId || null;
  const suggestedTitle = clampTitleFromGoal(cleanGoal, targetProject.name);
  const newSessionTarget = {
    serverId: resolvedServerId,
    hostLabel: targetProject.defaultTarget?.hostLabel ?? resolvedServerId,
    cwd: resolvedCwd,
    suggestedTitle
  };
  const projectSummary = {
    id: targetProject.id,
    name: targetProject.name,
    supervisorTitle: targetProject.supervisorTitle,
    repo: targetProject.repo
  };

  const formatCandidate = (entry) => entry ? ({
    key: entry.session.key,
    title: entry.session.title,
    theme: entry.session.theme,
    state: entry.session.state,
    host: entry.session.host,
    serverId: entry.session.serverId,
    cwd: entry.session.cwd,
    prRefs: entry.session.prRefs,
    confidence: Number(entry.finalScore.toFixed(2)),
    decisionProbability: typeof entry.decisionProb === "number" ? Number(entry.decisionProb.toFixed(2)) : null,
    lexicalScore: Number(entry.lexicalScore.toFixed(2)),
    transcriptPreview: entry.transcriptMessages,
    openChat: entry.session.openChat ?? null
  }) : null;

  if (strongExistingMatch) {
    const matchedSummary = formatCandidate(best);
    const alternatives = preRanked.slice(1, 4).filter((e) => e.finalScore >= 0.22).map(formatCandidate);

    if (normalizedMode === "preview") {
      return {
        ok: true,
        status: "suggest_existing",
        project: projectSummary,
        inferredTheme: inferredTheme.name,
        candidatesChecked: allSessions.length,
        matchedSession: matchedSummary,
        alternatives,
        newSessionTarget
      };
    }

    const directive = formatManagerDirective(cleanGoal, targetProject.name);
    const sent = await supervisor.sendOwnerMessage(best.session.key, directive, { deadlineAt });
    const delivered = sent?.delivery?.status === "sent";
    supervisor?.store?.recordAction?.({
      kind: "dispatch-goal",
      playbook: "manager-dispatch",
      threadKey: best.session.key,
      status: delivered ? "sent" : "blocked",
      by: "owner",
      reason: clampText(`routed manager goal to existing ${targetProject.name} session "${best.session.title}" (conf=${matchedSummary.confidence})`, 240)
    });
    supervisor?.emitFleet?.("goal-dispatched");
    return {
      ok: delivered,
      status: delivered ? "routed_existing" : "blocked",
      project: projectSummary,
      inferredTheme: best.session.theme || inferredTheme.name,
      candidatesChecked: allSessions.length,
      matchedSession: matchedSummary,
      alternatives,
      newSessionTarget,
      delivery: sent?.delivery ?? null
    };
  }

  if (normalizedMode === "preview") {
    return {
      ok: true,
      status: "suggest_new",
      project: projectSummary,
      inferredTheme: inferredTheme.name,
      candidatesChecked: allSessions.length,
      topExistingCandidate: formatCandidate(best),
      newSessionTarget
    };
  }

  const created = await (typeof supervisor?.startPaseoSession === "function"
    ? supervisor.startPaseoSession({
        workspace: targetProject.name,
        cwd: resolvedCwd,
        serverId: resolvedServerId,
        title: suggestedTitle,
        prompt: cleanGoal,
        provider,
        factory
      })
    : startPaseoSession(supervisor, {
        workspace: targetProject.name,
        cwd: resolvedCwd,
        serverId: resolvedServerId,
        title: suggestedTitle,
        prompt: cleanGoal,
        provider,
        factory
      }));

  supervisor?.store?.recordAction?.({
    kind: "dispatch-goal",
    playbook: "manager-dispatch-new",
    threadKey: created.key,
    status: "sent",
    by: "owner",
    reason: clampText(`started new ${targetProject.name} session "${suggestedTitle}" for manager goal`, 240)
  });
  supervisor?.emitFleet?.("goal-started-session");

  return {
    ok: true,
    status: "started_new",
    project: projectSummary,
    inferredTheme: inferredTheme.name,
    candidatesChecked: allSessions.length,
    createdSession: created
  };
}
