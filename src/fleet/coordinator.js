// Master Coordinator capabilities for FleetSupervisor:
//   - listWorkspaces: cross-host workspace/project inventory + overlap detection
//   - readChatTranscript: deep on-demand transcript reader (including sleeping Paseo chats)
//   - inspectRepoStatus: live GitHub PRs, CI rollups, recent merges, releases + session cross-ref
//   - startPaseoSession: spawns a new Paseo coding session in the right workspace & host
//   - batchActCards: rapid multi-card triage with per-card safety preflight

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  SUPERVISOR_PREFIX,
  clampText,
  codexExecBarred,
  isSelfThread,
  openChatFor,
  parsePaseoThreadKey,
  parsePrRef,
  redactSecrets,
  runCommand
} from "./contracts.js";
import { chooseRoute } from "./policy.js";
import { readThreadConversation } from "./conversation.js";
import { normalizePaseoImages } from "./paseo-delivery.js";
import { collectArchiveThreads } from "./search.js";
import { hostApi, isLocalPaseoUrl, paseoThread, withPaseo } from "./sources/paseo.js";

const OPAQUE_ID_RE = /^(?:paseo chat|wks_[0-9a-f]+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{6,})$/i;
const REPO_SLUG_RE = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/;

function cleanName(value) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed || OPAQUE_ID_RE.test(trimmed)) return null;
  return trimmed;
}

export function deriveProjectInfo({ cwd = null, workspace = null, projectName = null, repo = null, prRefs = [] } = {}) {
  const resolvedRepo = (typeof repo === "string" && REPO_SLUG_RE.test(repo.trim()) ? repo.trim() : null)
    ?? parsePrRef(prRefs?.[0])?.repo
    ?? null;
  const rawCwd = typeof cwd === "string" && cwd.trim() ? cwd.trim().replace(/\/+$/, "") : null;
  const ws = cleanName(workspace);
  const explicitProj = projectName && !/imported history/i.test(String(projectName))
    ? cleanName(projectName)
    : null;

  let project = null;
  let worktree = null;
  const migrated = Boolean(rawCwd && rawCwd.includes("/paseo/migrated/"));

  if (rawCwd) {
    const wtMatch = /\/(?:\.paseo|paseo)\/worktrees\/([^/]+)\/([^/]+)/.exec(rawCwd);
    const condWsMatch = /\/conductor\/workspaces\/([^/]+)\/([^/]+)/.exec(rawCwd);
    const condDotMatch = /\/([^/]+)\/\.conductor\/([^/]+)/.exec(rawCwd);
    const condRepoMatch = /\/conductor\/repos\/([^/]+)/.exec(rawCwd);
    const codexWtMatch = /\/codex-worktrees\/[0-9a-f]+\/([^/]+)/i.exec(rawCwd);
    const devMatch = /(?:\/Users\/[^/]+|\/home\/[^/]+)\/(?:Dev|Developer|Code|Projects|Repos)\/([^/]+)/i.exec(rawCwd);
    if (wtMatch) {
      project = wtMatch[1];
      worktree = wtMatch[2];
    } else if (condWsMatch) {
      project = condWsMatch[1];
      worktree = condWsMatch[2];
    } else if (condDotMatch) {
      project = condDotMatch[1];
      worktree = condDotMatch[2];
    } else if (condRepoMatch) {
      project = condRepoMatch[1];
    } else if (codexWtMatch) {
      project = codexWtMatch[1];
    } else if (devMatch) {
      project = devMatch[1];
    } else if (!/\/imported history(?:\/|$)/i.test(rawCwd)) {
      const base = path.basename(rawCwd);
      if (base && base !== "." && base !== "/" && !OPAQUE_ID_RE.test(base) && !/^\d{3,6}$/.test(base)) {
        project = base;
      }
    }
  }

  if (!project && explicitProj && !/^\d{3,6}$/.test(explicitProj)) {
    project = explicitProj;
  }

  const repoShort = resolvedRepo ? (resolvedRepo.split("/")[1] ?? null) : null;
  if (repoShort) {
    if (!project || project.toLowerCase() !== repoShort.toLowerCase()) {
      project = repoShort;
    }
  }
  if (!project && ws) {
    project = ws;
  }

  const label = project || ws || "unknown";
  return {
    key: label.toLowerCase(),
    name: label,
    worktree: worktree || (ws && ws.toLowerCase() !== label.toLowerCase() ? ws : null),
    repo: resolvedRepo,
    cwd: rawCwd,
    migrated
  };
}

function scoreWorkspaceTarget({ cwd, migrated, worktree, status, updatedAt }) {
  if (!cwd) return -1000;
  let score = 0;
  if (!migrated) score += 40;
  if (!worktree && !cwd.includes("/.conductor/") && !cwd.includes("/worktrees/")) score += 20;
  if (status === "running") score += 10;
  else if (status === "idle") score += 6;
  const ts = Date.parse(updatedAt ?? "") || 0;
  score += Math.min(10, Math.max(0, ts / 1e12));
  return score;
}

function isThreadArchived(thread) {
  return Boolean(thread?.archived || thread?.state === "archived");
}

function normalizeSessionState(thread) {
  if (isThreadArchived(thread)) return "archived";
  const raw = thread?.agentStatus ?? thread?.state ?? "unknown";
  if (thread?.excluded === "closed" || raw === "closed") return "sleeping";
  if (raw === "waiting" || thread?.meta?.blockedOnOwner) return "waiting";
  if (raw === "error" || thread?.error) return "error";
  if (raw === "running") return "running";
  if (raw === "idle") {
    if (thread?.kind === "claude" && thread?.live?.status === "busy") return "running";
    return "idle";
  }
  if (thread?.live === true || thread?.live?.status === "busy" || thread?.live?.status === "running") {
    return "running";
  }
  return String(raw || "idle");
}

function mergeDiscoveredIntoKnown(supervisor, thread) {
  if (!thread?.key || typeof supervisor?.recordDiscoveredThread !== "function") return thread;
  return supervisor.recordDiscoveredThread(thread);
}

// Collapses legacy Codex/Claude/Conductor/Antigravity rows that are already
// represented by a Paseo session (either via `excluded === "paseo-migrated"`
// or matching `meta.aliases`) so coordinator session counts, host ownership,
// PR links, and overlap warnings never double-count one physical session.
function collapseMigratedThreads(threads) {
  const list = [...threads].filter((t) => t?.key);
  const paseoByKey = new Map();
  const aliasOwnerKey = new Map();

  for (const t of list) {
    if (t.kind !== "paseo") continue;
    const copy = {
      ...t,
      prRefs: [...(t.prRefs ?? [])],
      meta: { ...(t.meta ?? {}), aliases: [...(t.meta?.aliases ?? [])] }
    };
    paseoByKey.set(copy.key, copy);
    for (const alias of copy.meta.aliases) {
      if (alias) aliasOwnerKey.set(alias, copy.key);
    }
  }

  const out = [];
  for (const t of list) {
    if (t.kind === "paseo") continue;
    const ownerKey = aliasOwnerKey.get(t.key)
      ?? (t.claudeSessionId ? aliasOwnerKey.get(`claude:${t.claudeSessionId}`) : null)
      ?? (t.meta?.claudeKey ? aliasOwnerKey.get(t.meta.claudeKey) : null)
      ?? null;
    if (ownerKey && paseoByKey.has(ownerKey)) {
      const owner = paseoByKey.get(ownerKey);
      owner.prRefs = [...new Set([...(owner.prRefs ?? []), ...(t.prRefs ?? [])])];
      owner.repo = owner.repo ?? t.repo ?? null;
      if (!owner.branch && t.branch && owner.meta?.isLocalHost !== false) {
        owner.branch = t.branch;
      }
      if (!owner.meta.aliases.includes(t.key)) owner.meta.aliases.push(t.key);
      continue;
    }
    if (t.excluded === "paseo-migrated") continue;
    out.push(t);
  }

  return [...paseoByKey.values(), ...out];
}

const PASEO_PROJECTS_CACHE_TTL_MS = 10 * 60_000;
const paseoProjectsByHostCache = new Map();

function parsePaseoProjectRepo(projectKey) {
  const m = /^remote:github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/i.exec(String(projectKey ?? "").trim());
  return m ? m[1] : null;
}

async function raceTimeout(promise, ms) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("timed out")), ms);
        timer.unref?.();
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function loadPaseoProjectsMap(api, serverId, { useCache = true } = {}) {
  if (typeof api?.projects?.list !== "function") return new Map();
  const now = Date.now();
  const cached = useCache ? paseoProjectsByHostCache.get(serverId) : null;
  if (cached && now - cached.at < PASEO_PROJECTS_CACHE_TTL_MS) {
    return cached.map;
  }
  const fetchPromise = (async () => {
    const res = await api.projects.list();
    const list = res?.projects ?? res?.entries ?? [];
    const map = new Map();
    for (const prj of Array.isArray(list) ? list : []) {
      if (!prj?.projectId) continue;
      if (prj.projectKind === "non_git" && /imported history/i.test(String(prj.projectDisplayName ?? ""))) {
        continue;
      }
      map.set(prj.projectId, {
        projectId: prj.projectId,
        projectKey: prj.projectKey ?? null,
        repo: parsePaseoProjectRepo(prj.projectKey),
        displayName: cleanName(prj.projectCustomName || prj.projectDisplayName) ?? null,
        rootPath: typeof prj.projectRootPath === "string" && prj.projectRootPath.trim() ? prj.projectRootPath.trim() : null
      });
    }
    if (useCache) paseoProjectsByHostCache.set(serverId, { at: Date.now(), map });
    return map;
  })();

  try {
    return await raceTimeout(fetchPromise, 5_000);
  } catch {
    // Let slow initial cold scan populate cache in background if still running, fall back to stale cache or empty map now.
    fetchPromise.catch(() => {});
    return cached?.map ?? new Map();
  }
}

async function fetchPaseoHostInventory(config, { includeArchived = false, factory } = {}) {
  if (!config?.paseo?.enabled) return { hosts: [], threads: [], emptyWorkspaces: [] };
  const inventoryConfig = {
    ...config,
    paseo: { ...config.paseo, timeoutMs: Math.min(config.paseo.timeoutMs ?? 30_000, 30_000) }
  };
  const selfIsLocal = isLocalPaseoUrl(inventoryConfig.paseo?.url);
  const useProjectCache = !factory;
  return withPaseo(inventoryConfig, async (client, signal) => {
    const directory = await client.hosts.list();
    const selfId = directory?.self?.serverId ?? "local";
    const selfLabel = directory?.self?.label || directory?.self?.hostname || "local";
    const hostEntries = [
      { serverId: selfId, label: selfLabel, status: "online" },
      ...(directory?.hosts ?? [])
        .filter((h) => h?.serverId && h.enabled && h.status === "online" && h.serverId !== selfId)
        .map((h) => ({ serverId: h.serverId, label: h.label || h.hostname || h.serverId, status: "online" }))
    ];

    const perHost = await Promise.all(hostEntries.map(async (host) => {
      signal.throwIfAborted();
      const hostThreads = [];
      const hostEmptyWorkspaces = [];
      let api;
      try {
        api = await hostApi(client, host.serverId, directory);
      } catch {
        return { hostThreads, hostEmptyWorkspaces };
      }

      const [projectsById, workspacesById] = await Promise.all([
        loadPaseoProjectsMap(api, host.serverId, { useCache: useProjectCache }),
        (async () => {
          const map = new Map();
          if (typeof api?.workspaces?.list !== "function") return map;
          try {
            const wsRes = await raceTimeout(api.workspaces.list({ page: { limit: 200 } }), 8_000);
            for (const ws of wsRes?.entries ?? []) {
              if (!ws?.id) continue;
              const labels = Array.isArray(ws.labels)
                ? ws.labels.filter((l) => typeof l === "string" && l.trim()).map((l) => l.trim())
                : [];
              const dir = ws.workspaceDirectory ?? ws.directory ?? ws.projectRootPath ?? null;
              const projName = cleanName(ws.projectCustomName || ws.projectDisplayName) ?? null;
              if (ws.projectKind === "non_git" && /imported history/i.test(String(ws.projectDisplayName ?? ""))) {
                continue;
              }
              map.set(ws.id, {
                id: ws.id,
                projectId: ws.projectId ?? null,
                projectName: projName,
                projectRootPath: typeof ws.projectRootPath === "string" && ws.projectRootPath.trim() ? ws.projectRootPath.trim() : null,
                name: cleanName(ws.title || ws.name) ?? null,
                directory: typeof dir === "string" && dir.trim() ? dir.trim() : null,
                archivedAt: ws.archivingAt ?? ws.archivedAt ?? null,
                labels
              });
            }
          } catch { /* workspaces.list is optional across daemon builds */ }
          return map;
        })()
      ]);

      for (const ws of workspacesById.values()) {
        if (ws.archivedAt && !includeArchived) continue;
        if (/imported history/i.test(String(ws.projectName ?? "")) && !(ws.labels?.length > 0)) continue;
        const prj = ws.projectId ? projectsById.get(ws.projectId) : null;
        const wsDir = ws.projectRootPath ?? prj?.rootPath ?? ws.directory ?? null;
        if (!wsDir) continue;
        hostEmptyWorkspaces.push({
          serverId: host.serverId,
          hostLabel: host.label,
          cwd: wsDir,
          workspace: ws.name ?? null,
          projectName: prj?.displayName ?? ws.projectName ?? null,
          repo: prj?.repo ?? null,
          labels: ws.labels
        });
      }

      for (const prj of projectsById.values()) {
        if (!prj.rootPath) continue;
        hostEmptyWorkspaces.push({
          serverId: host.serverId,
          hostLabel: host.label,
          cwd: prj.rootPath,
          workspace: prj.displayName ?? null,
          projectName: prj.displayName ?? null,
          repo: prj.repo ?? null,
          labels: []
        });
      }

      let cursor;
      const seen = new Set();
      for (let page = 0; page < 8; page += 1) {
        signal.throwIfAborted();
        const res = await api.agents.list({
          filter: { includeArchived: Boolean(includeArchived), includeBackground: true },
          sort: [{ key: "updated_at", direction: "desc" }],
          page: { limit: 100, ...(cursor ? { cursor } : {}) }
        });
        for (const entry of res?.entries ?? []) {
          const agent = entry?.agent ?? entry;
          if (!agent?.id) continue;
          if (!includeArchived && agent.archivedAt) continue;
          const row = paseoThread(agent, host.serverId, [], true);
          const wsMeta = agent.workspaceId ? workspacesById.get(agent.workspaceId) : null;
          const prjMeta = wsMeta?.projectId ? projectsById.get(wsMeta.projectId) : null;
          if (!row.repo && prjMeta?.repo) row.repo = prjMeta.repo;
          if (!row.workspace && wsMeta?.name) row.workspace = clampText(wsMeta.name, 80);
          row.meta.hostLabel = host.label;
          row.meta.rawStatus = agent.status ?? "idle";
          row.meta.isLocalHost = Boolean(selfIsLocal && host.serverId === selfId);
          row.meta.paseoWorkspaceName = wsMeta?.name ?? null;
          row.meta.paseoProjectName = prjMeta?.displayName ?? wsMeta?.projectName ?? null;
          row.meta.paseoLabels = wsMeta?.labels ?? [];
          row.meta.paseoProjectRoot = prjMeta?.rootPath ?? wsMeta?.projectRootPath ?? null;
          hostThreads.push(row);
        }
        if (!res?.pageInfo?.hasMore) break;
        cursor = res.pageInfo.nextCursor;
        if (!cursor || seen.has(cursor)) break;
        seen.add(cursor);
      }
      return { hostThreads, hostEmptyWorkspaces };
    }));

    return {
      hosts: hostEntries,
      threads: perHost.flatMap((h) => h.hostThreads),
      emptyWorkspaces: perHost.flatMap((h) => h.hostEmptyWorkspaces)
    };
  }, factory);
}

export async function listWorkspaces(supervisor, { query = "", includeArchived = false, limit = 30, maxSessionsPerWorkspace = null, factory } = {}) {
  const maxWorkspaces = Math.min(60, Math.max(1, Number(limit) || 30));
  const byKey = new Map();
  const hostLabels = new Map();

  for (const [k, t] of supervisor?.knownThreads ?? []) {
    if (k && t && (includeArchived || !isThreadArchived(t))) byKey.set(k, t);
  }
  for (const [k, t] of supervisor?.lastThreads ?? []) {
    if (k && t && (includeArchived || !isThreadArchived(t))) byKey.set(k, t);
  }

  let emptyWorkspaces = [];
  if (supervisor?.config?.paseo?.enabled) {
    try {
      const live = await fetchPaseoHostInventory(supervisor.config, { includeArchived, factory });
      emptyWorkspaces = live.emptyWorkspaces ?? [];
      for (const h of live.hosts ?? []) hostLabels.set(h.serverId, h.label);
      for (const fresh of live.threads ?? []) {
        const merged = mergeDiscoveredIntoKnown(supervisor, fresh);
        byKey.set(fresh.key, merged);
      }
    } catch {
      // Degrade gracefully to cached scan threads when Paseo WS is temporarily unreachable.
    }
  }

  const state = supervisor?.getState?.() ?? {};
  const cardPrByThread = new Map();
  for (const c of state.cards ?? []) {
    if (c?.threadKey && c?.prRef) cardPrByThread.set(c.threadKey, c.prRef);
  }

  const groups = new Map();
  const ensureGroup = (info) => {
    let group = groups.get(info.key);
    if (!group) {
      group = {
        id: info.key,
        name: info.name,
        repo: info.repo ?? null,
        counts: { running: 0, idle: 0, sleeping: 0, archived: 0, total: 0 },
        hostsMap: new Map(),
        prSessions: new Map(),
        activeCwdSessions: new Map(),
        candidates: [],
        sessions: []
      };
      groups.set(info.key, group);
    } else if (!group.repo && info.repo) {
      group.repo = info.repo;
    }
    return group;
  };

  const repoByRootPath = new Map();
  const knownRepoByCompactName = new Map();
  const noteKnownRepo = (slug) => {
    if (!slug || !REPO_SLUG_RE.test(slug)) return;
    const short = slug.split("/")[1] ?? "";
    const compact = short.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (compact) knownRepoByCompactName.set(compact, slug);
  };
  for (const ws of emptyWorkspaces) {
    if (ws.repo) {
      noteKnownRepo(ws.repo);
      if (ws.cwd) repoByRootPath.set(`${ws.serverId}:${ws.cwd.replace(/\/+$/, "")}`, ws.repo);
    }
  }
  for (const t of byKey.values()) {
    const tRepo = t?.repo ?? parsePrRef(t?.prRefs?.[0])?.repo ?? null;
    if (tRepo) {
      noteKnownRepo(tRepo);
      const tCwd = (t?.meta?.paseoProjectRoot || t?.meta?.paseoCwd || t?.cwd || "").replace(/\/+$/, "");
      const tSrv = t?.meta?.serverId ?? (t?.kind === "paseo" ? parsePaseoThreadKey(t.key)?.serverId : null) ?? "local";
      if (tCwd) repoByRootPath.set(`${tSrv}:${tCwd}`, tRepo);
    }
  }
  const inferRepoFromLabels = (labels) => {
    for (const raw of labels ?? []) {
      const slash = String(raw ?? "").indexOf("/");
      if (slash <= 0) continue;
      const compact = String(raw).slice(0, slash).toLowerCase().replace(/[^a-z0-9]/g, "");
      if (compact && knownRepoByCompactName.has(compact)) return knownRepoByCompactName.get(compact);
    }
    return null;
  };
  const lookupRootRepo = (serverId, cwd) => {
    if (!cwd) return null;
    const norm = cwd.replace(/\/+$/, "");
    const direct = repoByRootPath.get(`${serverId}:${norm}`);
    if (direct) return direct;
    for (const [k, r] of repoByRootPath) {
      if (k.startsWith(`${serverId}:`) && norm.startsWith(`${k.slice(serverId.length + 1)}/`)) {
        return r;
      }
    }
    return null;
  };

  for (const ws of emptyWorkspaces) {
    const inferredRepo = ws.repo ?? lookupRootRepo(ws.serverId, ws.cwd) ?? inferRepoFromLabels(ws.labels);
    const info = deriveProjectInfo({ cwd: ws.cwd, workspace: ws.workspace, projectName: ws.projectName, repo: inferredRepo });
    if (info.key === "unknown") continue;
    const group = ensureGroup(info);
    const wsScore = scoreWorkspaceTarget({ cwd: ws.cwd, migrated: info.migrated, worktree: info.worktree, status: "idle", updatedAt: null });
    group.candidates.push({
      serverId: ws.serverId,
      hostLabel: ws.hostLabel,
      cwd: ws.cwd,
      score: wsScore
    });
    const hostBucket = group.hostsMap.get(ws.serverId) ?? {
      serverId: ws.serverId,
      label: ws.hostLabel,
      count: 0,
      activeCount: 0,
      preferredCwd: ws.cwd,
      bestScore: wsScore
    };
    if (wsScore > (hostBucket.bestScore ?? -Infinity)) {
      hostBucket.bestScore = wsScore;
      hostBucket.preferredCwd = ws.cwd;
    }
    group.hostsMap.set(ws.serverId, hostBucket);
  }

  const effectiveSelfConfig = supervisor?.config
    ? { ...supervisor.config, selfSessionIds: [...(supervisor.config.selfSessionIds ?? []), ...(supervisor?.store?.selfSessions?.() ?? [])] }
    : null;
  let countedSessions = 0;

  for (const thread of collapseMigratedThreads(byKey.values())) {
    if (!thread?.key) continue;
    if (thread.excluded === "self" || (effectiveSelfConfig && isSelfThread(thread, effectiveSelfConfig))) continue;
    const cwd = thread.meta?.paseoCwd ?? thread.cwd ?? null;
    const serverId = thread.meta?.serverId ?? (thread.kind === "paseo" ? parsePaseoThreadKey(thread.key)?.serverId : null) ?? "local";
    const cardRefs = [thread.key, ...(thread.meta?.aliases ?? [])]
      .map((k) => cardPrByThread.get(k))
      .filter(Boolean);
    const prRefs = [...new Set([
      ...(thread.prRefs ?? []),
      ...cardRefs
    ].filter(Boolean))];
    const resolvedRepo = thread.repo
      ?? lookupRootRepo(serverId, thread.meta?.paseoProjectRoot || cwd)
      ?? inferRepoFromLabels(thread.meta?.paseoLabels);
    const info = deriveProjectInfo({
      cwd,
      workspace: thread.workspace,
      projectName: thread.meta?.paseoProjectName ?? null,
      repo: resolvedRepo,
      prRefs
    });
    const group = ensureGroup(info);

    const sessionState = normalizeSessionState(thread);
    countedSessions += 1;
    group.counts.total += 1;
    if (sessionState === "archived") group.counts.archived += 1;
    else if (sessionState === "sleeping") group.counts.sleeping += 1;
    else if (sessionState === "running" || sessionState === "waiting") group.counts.running += 1;
    else group.counts.idle += 1;

    const hostLabel = thread.meta?.hostLabel ?? hostLabels.get(serverId) ?? serverId;

    if (cwd && thread.kind === "paseo") {
      const candidateScore = scoreWorkspaceTarget({
        cwd,
        migrated: info.migrated,
        worktree: info.worktree,
        status: sessionState,
        updatedAt: thread.lastActivityAt
      });
      group.candidates.push({ serverId, hostLabel, cwd, score: candidateScore });
    }

    const hostEntry = group.hostsMap.get(serverId) ?? { serverId, label: hostLabel, count: 0, activeCount: 0, preferredCwd: cwd ?? null, bestScore: -Infinity };
    hostEntry.count += 1;
    if (sessionState === "running" || sessionState === "waiting" || sessionState === "idle") {
      hostEntry.activeCount = (hostEntry.activeCount ?? 0) + 1;
    }
    if (cwd) {
      const sc = scoreWorkspaceTarget({ cwd, migrated: info.migrated, worktree: info.worktree, status: sessionState, updatedAt: thread.lastActivityAt });
      if (sc > (hostEntry.bestScore ?? -Infinity)) {
        hostEntry.bestScore = sc;
        hostEntry.preferredCwd = cwd;
      }
    }
    group.hostsMap.set(serverId, hostEntry);

    if (sessionState !== "archived") {
      for (const ref of prRefs) {
        const list = group.prSessions.get(ref) ?? [];
        list.push({ key: thread.key, title: thread.title, state: sessionState, host: hostLabel });
        group.prSessions.set(ref, list);
      }
      if (cwd && sessionState === "running") {
        const cwdKey = `${serverId}:${cwd}`;
        const list = group.activeCwdSessions.get(cwdKey) ?? [];
        list.push({ key: thread.key, title: thread.title, state: sessionState, host: hostLabel, cwd });
        group.activeCwdSessions.set(cwdKey, list);
      }
    }

    const blockedOnPermission = Boolean(
      thread.meta?.pendingPermission || thread.meta?.pendingCard || thread.meta?.blockedOnOwner || thread.meta?.prompt
    );
    const hasRoute = thread.kind === "paseo"
      ? sessionState !== "archived"
      : sessionState !== "archived"
        && !codexExecBarred(thread)
        && Boolean(chooseRoute(thread, "propose", supervisor?.lastDelivery ?? { mode: "cli", ready: null }));

    group.sessions.push({
      key: thread.key,
      kind: thread.kind,
      title: clampText(redactSecrets(thread.title || thread.workspace || thread.key), 120),
      workspace: info.worktree ?? cleanName(thread.workspace) ?? null,
      workspaceId: thread.meta?.workspaceId ?? null,
      paseoLabels: Array.isArray(thread.meta?.paseoLabels) ? thread.meta.paseoLabels.slice(0, 6) : [],
      cwd,
      serverId: thread.kind === "paseo" ? serverId : null,
      host: hostLabel,
      provider: thread.meta?.provider ?? thread.kind,
      state: sessionState,
      wakeable: hasRoute,
      blockedOnPermission,
      prRefs: prRefs.slice(0, 4),
      lastActivityAt: thread.lastActivityAt ?? null,
      snippet: clampText(redactSecrets(thread.lastAgentText || thread.reason || ""), 220) || null,
      openChat: thread.openChat ?? openChatFor(thread)
    });
  }

  const needle = String(query ?? "").trim().toLowerCase();
  const workspaces = [];

  for (const group of groups.values()) {
    group.sessions.sort((a, b) => {
      const rank = (s) => (s.state === "running" || s.state === "waiting" ? 0 : s.state === "error" ? 1 : s.state === "idle" ? 2 : s.state === "sleeping" ? 3 : 4);
      return rank(a) - rank(b) || String(b.lastActivityAt ?? "").localeCompare(String(a.lastActivityAt ?? ""));
    });

    if (needle) {
      const groupMatch = group.name.toLowerCase().includes(needle)
        || String(group.repo ?? "").toLowerCase().includes(needle)
        || [...group.hostsMap.values()].some((h) => String(h.preferredCwd ?? "").toLowerCase().includes(needle) || String(h.label ?? "").toLowerCase().includes(needle));
      const matchingSessions = groupMatch
        ? group.sessions
        : group.sessions.filter((s) =>
            s.title.toLowerCase().includes(needle)
            || String(s.cwd ?? "").toLowerCase().includes(needle)
            || String(s.workspace ?? "").toLowerCase().includes(needle)
            || s.prRefs.some((r) => r.toLowerCase().includes(needle))
          );
      if (!groupMatch && matchingSessions.length === 0) continue;
      if (!groupMatch) group.sessions = matchingSessions;
    }

    group.candidates.sort((a, b) => b.score - a.score);
    const bestTarget = group.candidates[0] ?? null;

    const overlaps = [];
    for (const [prRef, list] of group.prSessions) {
      if (list.length >= 2) {
        overlaps.push({
          kind: "same_pr",
          target: prRef,
          detail: `${list.length} sessions reference ${prRef}`,
          sessions: list.slice(0, 5)
        });
      }
    }
    for (const [, list] of group.activeCwdSessions) {
      const running = list.filter((s) => s.state === "running");
      if (running.length >= 2) {
        const dirName = path.basename(running[0].cwd) || running[0].cwd;
        overlaps.push({
          kind: "concurrent_cwd",
          target: running[0].cwd,
          detail: `${running.length} running chats are editing ${dirName} simultaneously`,
          sessions: running.slice(0, 5)
        });
      }
    }

    const perWorkspaceSessions = Number.isInteger(maxSessionsPerWorkspace) && maxSessionsPerWorkspace > 0
      ? Math.min(200, maxSessionsPerWorkspace)
      : (needle ? 25 : 8);
    workspaces.push({
      id: group.id,
      name: group.name,
      repo: group.repo,
      counts: group.counts,
      defaultTarget: bestTarget
        ? { serverId: bestTarget.serverId, hostLabel: bestTarget.hostLabel, cwd: bestTarget.cwd }
        : null,
      hosts: [...group.hostsMap.values()].map(({ bestScore: _b, ...h }) => h),
      referencedPrs: [...group.prSessions.keys()].slice(0, 12),
      overlaps,
      recentChats: group.sessions.slice(0, perWorkspaceSessions),
      latestActivityAt: group.sessions[0]?.lastActivityAt ?? null
    });
  }

  workspaces.sort((a, b) =>
    (b.counts.running - a.counts.running)
    || (b.overlaps.length - a.overlaps.length)
    || (b.counts.idle - a.counts.idle)
    || String(b.latestActivityAt ?? "").localeCompare(String(a.latestActivityAt ?? ""))
    || a.name.localeCompare(b.name)
  );

  const filteredSessionsCount = needle
    ? workspaces.reduce((sum, w) => sum + (w.counts?.total ?? 0), 0)
    : countedSessions;

  return {
    scannedAt: new Date().toISOString(),
    query: needle || null,
    totalWorkspaces: workspaces.length,
    totalSessions: filteredSessionsCount,
    workspaces: workspaces.slice(0, maxWorkspaces)
  };
}

export async function readChatTranscript(supervisor, { key, limit = 20, factory } = {}) {
  const cleanKey = typeof key === "string" ? key.trim() : "";
  if (!cleanKey) throw new Error("Pass a session key (e.g. paseo:<serverId>.<agentId>).");
  const maxMessages = Math.min(60, Math.max(1, Number(limit) || 20));

  if (cleanKey.startsWith("paseo:") && supervisor?.config?.paseo?.enabled) {
    const parsed = parsePaseoThreadKey(cleanKey);
    if (!parsed) throw new Error(`Invalid Paseo thread key "${clampText(cleanKey, 120)}".`);
    try {
      const readCfg = {
        ...supervisor.config,
        paseo: { ...supervisor.config.paseo, timeoutMs: Math.min(supervisor.config.paseo.timeoutMs ?? 20_000, 20_000) }
      };
      return await withPaseo(readCfg, async (client, signal) => {
        const directory = await client.hosts.list();
        const api = await hostApi(client, parsed.serverId, directory);
        const ref = api.agents.ref(parsed.agentId);
        const history = await ref.timeline.refetch({
          direction: "tail",
          limit: Math.min(160, Math.max(40, maxMessages * 4))
        });
        signal.throwIfAborted();
        if (history?.error) throw new Error(String(history.error));
        const agent = history?.agent ?? ref.current() ?? { id: parsed.agentId, status: "idle" };
        const entries = Array.isArray(history?.entries) ? history.entries : [];
        const freshThread = paseoThread(agent, parsed.serverId, entries, true);
        mergeDiscoveredIntoKnown(supervisor, freshThread);

        const messages = entries
          .filter((e) => ["user_message", "assistant_message", "error"].includes(e?.item?.type))
          .slice(-maxMessages)
          .map((e) => {
            if (e.item.type === "error") {
              return {
                role: "error",
                text: clampText(redactSecrets(String(e.item.message ?? "")), 1200),
                at: e.timestamp ?? null
              };
            }
            const rawText = String(e.item.text ?? "");
            const isSup = e.item.type === "user_message" && rawText.startsWith(SUPERVISOR_PREFIX);
            return {
              role: isSup ? "supervisor" : e.item.type === "user_message" ? "user" : "assistant",
              text: redactSecrets(rawText).slice(-3000),
              at: e.timestamp ?? null
            };
          });

        return {
          key: cleanKey,
          kind: "paseo",
          title: freshThread.title,
          workspace: freshThread.workspace,
          repo: freshThread.repo,
          prRefs: freshThread.prRefs ?? [],
          serverId: parsed.serverId,
          cwd: agent.cwd ?? null,
          status: agent.archivedAt ? "archived" : (agent.status ?? "idle"),
          wakeable: !agent.archivedAt,
          pendingCard: freshThread.meta?.pendingCard ?? null,
          pendingPermission: freshThread.meta?.pendingPermission ?? null,
          messageCount: messages.length,
          messages,
          openChat: openChatFor(freshThread)
        };
      }, factory);
    } catch (err) {
      // Fall back to local/cached transcript if host is temporarily offline.
      const fallback = supervisor?.lastThreads?.get(cleanKey) ?? supervisor?.knownThreads?.get(cleanKey) ?? null;
      if (!fallback) throw new Error(`Could not read Paseo chat "${clampText(cleanKey, 120)}": ${clampText(err?.message ?? String(err), 160)}`);
    }
  }

  let thread = supervisor?.lastThreads?.get(cleanKey) ?? supervisor?.knownThreads?.get(cleanKey) ?? null;
  if (!thread && cleanKey.startsWith("antigravity:")) {
    const cid = cleanKey.slice("antigravity:".length);
    const archives = await collectArchiveThreads({
      query: cid,
      homeDir: supervisor?.config?.paths?.home ?? os.homedir(),
      includeRemotePaseoHosts: Boolean(supervisor?.config?.paseo?.enabled)
    });
    thread = archives.get(cleanKey) ?? null;
    if (thread) mergeDiscoveredIntoKnown(supervisor, thread);
  }
  if (!thread) {
    const conv = await supervisor?.threadConversation?.(cleanKey);
    if (!conv) throw new Error(`No session found with key "${clampText(cleanKey, 120)}". Call fleet_workspaces or fleet_search first.`);
    return {
      key: cleanKey,
      kind: cleanKey.split(":")[0] || "unknown",
      title: cleanKey,
      status: "idle",
      prRefs: [],
      messageCount: (conv.messages ?? []).slice(-maxMessages).length,
      messages: (conv.messages ?? []).slice(-maxMessages).map((m) => ({
        role: m.role,
        text: redactSecrets(String(m.text ?? "")).slice(-3000),
        at: m.at ?? null
      }))
    };
  }

  const conv = await readThreadConversation(thread, supervisor.config);
  const messages = (conv?.messages ?? []).slice(-maxMessages).map((m) => ({
    role: m.role,
    text: redactSecrets(String(m.text ?? "")).slice(-3000),
    at: m.at ?? null
  }));
  return {
    key: cleanKey,
    kind: thread.kind,
    title: thread.title ?? cleanKey,
    workspace: thread.workspace ?? null,
    repo: thread.repo ?? null,
    prRefs: thread.prRefs ?? [],
    cwd: thread.meta?.paseoCwd ?? thread.cwd ?? null,
    status: normalizeSessionState(thread),
    wakeable: !isThreadArchived(thread),
    messageCount: messages.length,
    messages,
    openChat: thread.openChat ?? openChatFor(thread)
  };
}

function parseGitRemoteRepo(remoteUrl) {
  const raw = String(remoteUrl ?? "").trim().replace(/\.git$/i, "");
  const httpsMatch = /github\.com[/:]([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/i.exec(raw);
  return httpsMatch ? httpsMatch[1] : null;
}

const ROLLUP_FAILED_CONCLUSIONS = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"]);
const ROLLUP_FAILED_STATES = new Set(["FAILURE", "ERROR"]);
const ROLLUP_PENDING_STATUSES = new Set(["IN_PROGRESS", "QUEUED", "WAITING", "PENDING", "REQUESTED"]);
const ROLLUP_PENDING_STATES = new Set(["PENDING", "EXPECTED"]);

function summarizeStatusRollup(rollup) {
  if (!Array.isArray(rollup) || rollup.length === 0) {
    return { ciState: "NONE", failingChecks: [], pendingChecks: [] };
  }
  const failing = [];
  const pending = [];
  for (const item of rollup) {
    const label = String(item?.name || item?.context || "check").trim();
    const status = String(item?.status ?? "").toUpperCase();
    const conclusion = String(item?.conclusion ?? "").toUpperCase();
    const state = String(item?.state ?? "").toUpperCase();
    if (ROLLUP_FAILED_CONCLUSIONS.has(conclusion) || ROLLUP_FAILED_STATES.has(state)) {
      failing.push(label);
    } else if ((status && status !== "COMPLETED" && ROLLUP_PENDING_STATUSES.has(status)) || ROLLUP_PENDING_STATES.has(state) || ROLLUP_PENDING_STATES.has(conclusion)) {
      pending.push(label);
    }
  }
  const ciState = failing.length > 0 ? "FAILURE" : pending.length > 0 ? "PENDING" : "SUCCESS";
  return {
    ciState,
    failingChecks: [...new Set(failing)].slice(0, 6),
    pendingChecks: [...new Set(pending)].slice(0, 6)
  };
}

async function resolveRepoSlug(supervisor, { repo, workspace, runImpl, ghBin, factory }) {
  const rawRepo = typeof repo === "string" ? repo.trim().replace(/^https:\/\/github\.com\//i, "").replace(/\/+$/, "") : "";
  if (REPO_SLUG_RE.test(rawRepo)) return rawRepo;

  const targetName = (rawRepo || String(workspace ?? "").trim()).toLowerCase();
  if (!targetName) throw new Error("Provide repo ('owner/name') or workspace name (e.g. 'bb-recorder').");

  const mergedThreadMap = new Map([
    ...(supervisor?.knownThreads ?? []),
    ...(supervisor?.lastThreads ?? [])
  ]);
  const allThreads = collapseMigratedThreads(mergedThreadMap.values());
  const state = supervisor?.getState?.() ?? {};
  const candidateRepos = new Map();
  const noteRepo = (slug) => {
    if (!slug || !REPO_SLUG_RE.test(slug)) return;
    candidateRepos.set(slug, (candidateRepos.get(slug) ?? 0) + 1);
  };

  for (const t of allThreads) {
    const info = deriveProjectInfo({ cwd: t?.meta?.paseoCwd ?? t?.cwd, workspace: t?.workspace, repo: t?.repo, prRefs: t?.prRefs });
    if (info.key === targetName || String(t?.workspace ?? "").toLowerCase() === targetName) {
      noteRepo(info.repo);
      for (const ref of t?.prRefs ?? []) noteRepo(parsePrRef(ref)?.repo);
    }
    const directRepo = t?.repo ?? parsePrRef(t?.prRefs?.[0])?.repo ?? null;
    if (directRepo && directRepo.split("/")[1]?.toLowerCase() === targetName) {
      noteRepo(directRepo);
    }
  }
  for (const c of state.cards ?? []) {
    const cRepo = c?.repo ?? parsePrRef(c?.prRef)?.repo ?? null;
    if (cRepo && (cRepo.split("/")[1]?.toLowerCase() === targetName || String(c?.workspace ?? "").toLowerCase() === targetName)) {
      noteRepo(cRepo);
    }
  }

  if (candidateRepos.size > 0) {
    return [...candidateRepos.entries()].sort((a, b) => b[1] - a[1])[0][0];
  }

  // Probe local checkout git remote ONLY for paths verified to belong to this computer.
  let localPaseoServerId;
  const resolveLocalPaseoServerId = async () => {
    if (localPaseoServerId !== undefined) return localPaseoServerId;
    if (!supervisor?.config?.paseo?.enabled || !isLocalPaseoUrl(supervisor.config.paseo?.url)) {
      localPaseoServerId = null;
      return null;
    }
    try {
      const probeCfg = {
        ...supervisor.config,
        paseo: { ...supervisor.config.paseo, timeoutMs: Math.min(supervisor.config.paseo.timeoutMs ?? 5000, 5000) }
      };
      localPaseoServerId = await withPaseo(probeCfg, async (client) => (await client.hosts.list())?.self?.serverId ?? null, factory);
    } catch {
      localPaseoServerId = null;
    }
    return localPaseoServerId;
  };

  for (const t of allThreads) {
    const cwd = t?.kind === "paseo" ? (t?.meta?.paseoCwd ?? null) : (t?.cwd ?? null);
    if (!cwd) continue;
    const info = deriveProjectInfo({ cwd, workspace: t?.workspace });
    if (info.key !== targetName) continue;

    let ownedLocally = t?.kind !== "paseo";
    if (t?.kind === "paseo") {
      if (t.meta?.isLocalHost === true) {
        ownedLocally = true;
      } else if (t.meta?.isLocalHost === false) {
        ownedLocally = false;
      } else if (t.meta?.serverId) {
        const selfId = await resolveLocalPaseoServerId();
        ownedLocally = Boolean(selfId && t.meta.serverId === selfId);
      }
    }
    if (!ownedLocally) continue;

    try {
      if (fs.existsSync(cwd)) {
        const gitRes = await runImpl("git", ["-C", cwd, "remote", "get-url", "origin"], { timeoutMs: 4000 });
        if (gitRes.code === 0) {
          const parsed = parseGitRemoteRepo(gitRes.stdout);
          if (parsed) return parsed;
        }
      }
    } catch { /* ignore */ }
  }

  // Generic GitHub CLI lookup across authenticated orgs/user.
  const searchRes = await runImpl(
    ghBin,
    ["search", "repos", targetName, "--limit", "8", "--json", "fullName,updatedAt"],
    { timeoutMs: 10_000 }
  );
  if (searchRes.code === 0 && searchRes.stdout) {
    try {
      const items = JSON.parse(searchRes.stdout);
      if (Array.isArray(items) && items.length > 0) {
        const exact = items
          .filter((it) => String(it?.fullName ?? "").split("/")[1]?.toLowerCase() === targetName)
          .sort((a, b) => String(b?.updatedAt ?? "").localeCompare(String(a?.updatedAt ?? "")));
        if (exact[0]?.fullName) return exact[0].fullName;
      }
    } catch { /* ignore */ }
  }

  throw new Error(`Could not resolve GitHub owner/repo for "${clampText(rawRepo || workspace, 80)}". Pass repo as "owner/name".`);
}

export async function inspectRepoStatus(supervisor, { repo = null, workspace = null, limit = 15, run = null, factory = null } = {}) {
  const runImpl = run ?? supervisor?.deps?.run ?? runCommand;
  const ghBin = supervisor?.config?.bins?.gh ?? "gh";
  const maxOpen = Math.min(30, Math.max(1, Number(limit) || 15));
  const resolvedRepo = await resolveRepoSlug(supervisor, { repo, workspace, runImpl, ghBin, factory });

  const [openRes, mergedRes, releaseRes] = await Promise.all([
    runImpl(
      ghBin,
      [
        "pr", "list", "--repo", resolvedRepo, "--state", "open", "--limit", String(maxOpen),
        "--json", "number,title,headRefName,baseRefName,isDraft,mergeStateStatus,reviewDecision,statusCheckRollup,updatedAt,url"
      ],
      { timeoutMs: 15_000 }
    ),
    runImpl(
      ghBin,
      [
        "pr", "list", "--repo", resolvedRepo, "--state", "merged", "--limit", "10",
        "--json", "number,title,headRefName,mergedAt,url"
      ],
      { timeoutMs: 12_000 }
    ),
    runImpl(
      ghBin,
      [
        "release", "list", "--repo", resolvedRepo, "--limit", "5",
        "--json", "tagName,name,publishedAt,isDraft,isPrerelease"
      ],
      { timeoutMs: 10_000 }
    ).catch(() => ({ code: 1, stdout: "[]", stderr: "" }))
  ]);

  if (openRes.code !== 0) {
    throw new Error(`GitHub PR query failed for ${resolvedRepo}: ${clampText(redactSecrets(openRes.stderr || openRes.stdout || "gh error"), 200)}`);
  }

  let rawOpen = [];
  let rawMerged = [];
  let rawReleases = [];
  try { rawOpen = JSON.parse(openRes.stdout || "[]"); } catch { rawOpen = []; }
  try { if (mergedRes.code === 0) rawMerged = JSON.parse(mergedRes.stdout || "[]"); } catch { rawMerged = []; }
  try { if (releaseRes.code === 0) rawReleases = JSON.parse(releaseRes.stdout || "[]"); } catch { rawReleases = []; }

  const allThreads = collapseMigratedThreads(
    new Map([
      ...(supervisor?.knownThreads ?? []),
      ...(supervisor?.lastThreads ?? [])
    ]).values()
  );

  const matchSessionsForPr = (prRef, headRef) => {
    const linked = [];
    for (const t of allThreads) {
      if (!t?.key || isThreadArchived(t)) continue;
      const refs = t.prRefs ?? [];
      const samePr = refs.includes(prRef);
      const threadRepo = t.repo ?? parsePrRef(refs[0])?.repo ?? null;
      const sameBranch = Boolean(
        headRef &&
        t.branch &&
        t.branch === headRef &&
        threadRepo &&
        threadRepo.toLowerCase() === resolvedRepo.toLowerCase()
      );
      if (!samePr && !sameBranch) continue;
      linked.push({
        key: t.key,
        title: clampText(redactSecrets(t.title || t.workspace || t.key), 100),
        state: normalizeSessionState(t),
        serverId: t.meta?.serverId ?? null
      });
    }
    return linked;
  };

  const openPrs = (Array.isArray(rawOpen) ? rawOpen : []).map((pr) => {
    const ref = `${resolvedRepo}#${pr.number}`;
    const rollup = summarizeStatusRollup(pr.statusCheckRollup);
    const linkedSessions = matchSessionsForPr(ref, pr.headRefName);
    const activeOwners = linkedSessions.filter((s) => ["running", "waiting", "idle"].includes(s.state));
    return {
      number: pr.number,
      ref,
      title: clampText(redactSecrets(String(pr.title ?? "")), 160),
      url: pr.url ?? null,
      headRef: pr.headRefName ?? null,
      baseRef: pr.baseRefName ?? null,
      isDraft: Boolean(pr.isDraft),
      mergeState: pr.mergeStateStatus ?? null,
      reviewDecision: pr.reviewDecision ?? null,
      ciState: rollup.ciState,
      failingChecks: rollup.failingChecks,
      pendingChecks: rollup.pendingChecks,
      updatedAt: pr.updatedAt ?? null,
      linkedSessions: linkedSessions.slice(0, 6),
      orphaned: !pr.isDraft && activeOwners.length === 0,
      overlapping: linkedSessions.length >= 2
    };
  });

  const recentlyMerged = (Array.isArray(rawMerged) ? rawMerged : []).map((pr) => ({
    number: pr.number,
    ref: `${resolvedRepo}#${pr.number}`,
    title: clampText(redactSecrets(String(pr.title ?? "")), 160),
    headRef: pr.headRefName ?? null,
    mergedAt: pr.mergedAt ?? null,
    url: pr.url ?? null
  }));

  const releases = (Array.isArray(rawReleases) ? rawReleases : []).map((rel) => ({
    tag: rel.tagName ?? null,
    name: clampText(redactSecrets(String(rel.name || rel.tagName || "")), 120),
    publishedAt: rel.publishedAt ?? null,
    isDraft: Boolean(rel.isDraft),
    isPrerelease: Boolean(rel.isPrerelease)
  }));

  return {
    repo: resolvedRepo,
    checkedAt: new Date().toISOString(),
    summary: {
      openCount: openPrs.length,
      greenReadyCount: openPrs.filter((p) => !p.isDraft && p.ciState === "SUCCESS" && p.mergeState !== "DIRTY").length,
      ciFailingCount: openPrs.filter((p) => p.ciState === "FAILURE").length,
      draftCount: openPrs.filter((p) => p.isDraft).length,
      orphanedCount: openPrs.filter((p) => p.orphaned).length,
      overlappingPrCount: openPrs.filter((p) => p.overlapping).length
    },
    openPrs,
    recentlyMerged,
    releases
  };
}

function tokenizeMatchQuery(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function normalizeEffortId(raw) {
  const clean = String(raw ?? "").trim().toLowerCase();
  if (!clean) return null;
  if (clean === "med") return "medium";
  if (clean === "maximum") return "max";
  return clean;
}

function matchThinkingOptionId(modelObj, effort) {
  const norm = normalizeEffortId(effort);
  if (!norm) return null;
  const opts = Array.isArray(modelObj?.thinkingOptions) ? modelObj.thinkingOptions : [];
  if (opts.length === 0) return norm;
  const aliases = norm === "max" ? ["max", "xhigh", "high"]
    : norm === "xhigh" ? ["xhigh", "max", "high"]
      : [norm];
  for (const candidate of aliases) {
    const exact = opts.find((o) => String(o?.id ?? "").toLowerCase() === candidate
      || String(o?.label ?? "").toLowerCase() === candidate);
    if (exact?.id) return exact.id;
  }
  const fuzzy = opts.find((o) => {
    const hay = `${o?.id ?? ""} ${o?.label ?? ""}`.toLowerCase();
    return aliases.some((a) => hay.includes(a));
  });
  return fuzzy?.id ?? norm;
}

export async function resolvePaseoAgentConfig(api, cwd, {
  provider = null,
  model = null,
  effort = null,
  modeId = null
} = {}) {
  const rawProv = typeof provider === "string" ? provider.trim() : "";
  const rawModel = typeof model === "string" ? model.trim() : "";
  const KNOWN_PROVIDERS = new Set(["codex", "claude", "opencode", "gemini", "cursor"]);

  let explicitFamily = null;
  let modelQuery = rawModel || null;
  if (rawProv.includes("/")) {
    const slashIdx = rawProv.indexOf("/");
    explicitFamily = rawProv.slice(0, slashIdx).trim().toLowerCase() || null;
    modelQuery = modelQuery ?? (rawProv.slice(slashIdx + 1).trim() || null);
  } else if (rawProv) {
    const lowerProv = rawProv.toLowerCase();
    if (KNOWN_PROVIDERS.has(lowerProv)) {
      explicitFamily = lowerProv;
    } else if (!modelQuery) {
      modelQuery = rawProv;
    }
  }

  let snap = null;
  if (typeof api?.providers?.waitForReady === "function") {
    try { snap = await api.providers.waitForReady({ cwd, timeoutMs: 8000 }); } catch { snap = null; }
  }
  if (!snap && typeof api?.providers?.snapshot === "function") {
    try { snap = await api.providers.snapshot({ cwd }); } catch { snap = null; }
  }

  const entries = Array.isArray(snap?.entries) ? snap.entries.filter((e) => e?.status === "ready") : [];
  if (entries.length > 0) {
    const orderedEntries = explicitFamily
      ? [
          ...entries.filter((e) => String(e.provider ?? "").toLowerCase() === explicitFamily),
          ...entries.filter((e) => String(e.provider ?? "").toLowerCase() !== explicitFamily)
        ]
      : [
          ...entries.filter((e) => String(e.provider ?? "").toLowerCase() === "codex"),
          ...entries.filter((e) => String(e.provider ?? "").toLowerCase() === "claude"),
          ...entries.filter((e) => !["codex", "claude"].includes(String(e.provider ?? "").toLowerCase()))
        ];

    if (modelQuery) {
      const qLower = modelQuery.toLowerCase();
      const qTokens = tokenizeMatchQuery(modelQuery);
      let bestMatch = null;
      let bestScore = 0;

      for (const entry of orderedEntries) {
        const famMatchBonus = explicitFamily && String(entry.provider ?? "").toLowerCase() === explicitFamily ? 2 : 0;
        for (const m of entry.models ?? []) {
          const mid = String(m?.id ?? "").trim();
          const mlabel = String(m?.label ?? "").trim();
          if (!mid) continue;
          const midLower = mid.toLowerCase();
          const labelLower = mlabel.toLowerCase();
          if (midLower === qLower || labelLower === qLower) {
            bestMatch = { entry, model: m };
            bestScore = 100 + famMatchBonus;
            break;
          }
          const hayTokens = tokenizeMatchQuery(`${mid} ${mlabel} ${entry.provider ?? ""}`);
          if (qTokens.length > 0 && qTokens.every((t) => hayTokens.includes(t) || midLower.includes(t) || labelLower.includes(t))) {
            const score = 50 + qTokens.length + famMatchBonus + (m?.isDefault ? 1 : 0);
            if (score > bestScore) {
              bestScore = score;
              bestMatch = { entry, model: m };
            }
          }
        }
        if (bestScore >= 100) break;
      }

      if (bestMatch) {
        const thinkingOptionId = matchThinkingOptionId(bestMatch.model, effort);
        return {
          provider: `${bestMatch.entry.provider}/${bestMatch.model.id}`,
          model: bestMatch.model.id,
          ...(thinkingOptionId ? { thinkingOptionId } : {}),
          ...(typeof modeId === "string" && modeId.trim() ? { modeId: modeId.trim() } : {})
        };
      }
    }

    const picked = (explicitFamily
      ? entries.find((e) => String(e.provider ?? "").toLowerCase() === explicitFamily)
      : null)
      ?? orderedEntries[0];
    const pickedModel = picked?.models?.find((m) => m?.isDefault) ?? picked?.models?.[0] ?? null;
    if (picked?.provider && (modelQuery || pickedModel?.id)) {
      const chosenModelId = modelQuery || pickedModel.id;
      const thinkingOptionId = matchThinkingOptionId(pickedModel, effort);
      return {
        provider: `${picked.provider}/${chosenModelId}`,
        model: chosenModelId,
        ...(thinkingOptionId ? { thinkingOptionId } : {}),
        ...(typeof modeId === "string" && modeId.trim() ? { modeId: modeId.trim() } : {})
      };
    }
  }

  const fallbackFamily = explicitFamily || (modelQuery && /claude|sonnet|opus|haiku/i.test(modelQuery) ? "claude" : "codex");
  const fallbackSpec = modelQuery ? `${fallbackFamily}/${modelQuery}` : (rawProv || fallbackFamily);
  const thinkingOptionId = normalizeEffortId(effort);
  return {
    provider: fallbackSpec,
    ...(modelQuery ? { model: modelQuery } : {}),
    ...(thinkingOptionId ? { thinkingOptionId } : {}),
    ...(typeof modeId === "string" && modeId.trim() ? { modeId: modeId.trim() } : {})
  };
}

export async function startPaseoSession(supervisor, {
  workspace = null,
  cwd = null,
  serverId = null,
  title = null,
  prompt = "",
  provider = null,
  model = null,
  effort = null,
  modeId = null,
  images = null,
  factory
} = {}) {
  if (!supervisor?.config?.paseo?.enabled) {
    throw new Error("Paseo integration is not enabled on this supervisor.");
  }
  const cleanPrompt = typeof prompt === "string" ? prompt.trim() : "";
  if (!cleanPrompt || cleanPrompt.length > 4000) {
    throw new Error("Prompt must be 1-4000 characters.");
  }
  const normalizedImages = normalizePaseoImages(images);
  const cleanTitle = typeof title === "string" && title.trim() ? clampText(title.trim(), 100) : null;

  const explicitServerId = typeof serverId === "string" && serverId.trim() ? serverId.trim() : null;
  let resolvedServerId = explicitServerId;
  let resolvedCwd = typeof cwd === "string" && cwd.trim() ? cwd.trim().replace(/\/+$/, "") : null;
  let workspaceLabel = cleanName(workspace);
  let inferredWorkspace = false;

  if (!resolvedServerId || !resolvedCwd) {
    const inventory = await listWorkspaces(supervisor, {
      query: workspaceLabel || "",
      includeArchived: true,
      limit: 60,
      factory
    });

    if (!workspaceLabel && !resolvedCwd) {
      const candidates = (inventory.workspaces ?? []).filter((w) => w?.defaultTarget?.cwd && w?.defaultTarget?.serverId
        && (!explicitServerId || w.hosts?.some((h) => h.serverId === explicitServerId && h.preferredCwd)));
      if (candidates.length === 0) {
        throw new Error("No online Paseo workspace was found. Call fleet_workspaces or pass workspace/cwd explicitly.");
      }
      const promptHay = `${cleanTitle ?? ""} ${cleanPrompt}`.toLowerCase();
      const promptTokens = new Set(tokenizeMatchQuery(promptHay));
      const matched = candidates.find((w) => {
        const idTok = tokenizeMatchQuery(w.id).join(" ");
        const nameTok = tokenizeMatchQuery(w.name).join(" ");
        const repoLeaf = w.repo ? String(w.repo).split("/").pop().toLowerCase() : "";
        return (idTok && promptTokens.has(idTok))
          || (nameTok && promptTokens.has(nameTok))
          || (repoLeaf && promptTokens.has(repoLeaf));
      }) ?? candidates
        .slice()
        .sort((a, b) => ((b.activeCount ?? 0) * 4 + (b.totalChats ?? 0)) - ((a.activeCount ?? 0) * 4 + (a.totalChats ?? 0)))[0];
      const hostMatch = explicitServerId
        ? matched.hosts?.find((h) => h.serverId === explicitServerId && h.preferredCwd)
        : null;
      resolvedServerId = explicitServerId ?? matched.defaultTarget.serverId;
      resolvedCwd = hostMatch?.preferredCwd ?? matched.defaultTarget.cwd;
      workspaceLabel = matched.name;
      inferredWorkspace = true;
    } else if (resolvedCwd && !resolvedServerId) {
      const exactHosts = new Map();
      const relatedHosts = new Map();
      const noteCandidate = (hostId, rawCandidateCwd, wsName) => {
        const cleanCandidate = typeof rawCandidateCwd === "string" ? rawCandidateCwd.trim().replace(/\/+$/, "") : "";
        if (!hostId || !cleanCandidate) return;
        if (cleanCandidate === resolvedCwd) {
          if (!exactHosts.has(hostId)) exactHosts.set(hostId, wsName);
          return;
        }
        if (cleanCandidate.startsWith(`${resolvedCwd}/`) || resolvedCwd.startsWith(`${cleanCandidate}/`)) {
          if (!relatedHosts.has(hostId)) relatedHosts.set(hostId, wsName);
        }
      };

      for (const w of inventory.workspaces) {
        for (const s of w.recentChats ?? []) noteCandidate(s.serverId, s.cwd, w.name);
        for (const h of w.hosts ?? []) noteCandidate(h.serverId, h.preferredCwd, w.name);
      }

      if (exactHosts.size > 1) {
        throw new Error(
          `Directory "${clampText(resolvedCwd, 80)}" exists on multiple Paseo hosts (${[...exactHosts.keys()].join(", ")}). Pass serverId explicitly.`
        );
      }
      if (exactHosts.size === 1) {
        const [[hostId, wsName]] = [...exactHosts.entries()];
        resolvedServerId = hostId;
        workspaceLabel ??= wsName;
      } else if (relatedHosts.size > 1) {
        throw new Error(
          `Directory "${clampText(resolvedCwd, 80)}" matches multiple Paseo hosts (${[...relatedHosts.keys()].join(", ")}). Pass serverId explicitly.`
        );
      } else if (relatedHosts.size === 1) {
        const [[hostId, wsName]] = [...relatedHosts.entries()];
        resolvedServerId = hostId;
        workspaceLabel ??= wsName;
      } else {
        throw new Error(
          `Could not determine which Paseo host owns directory "${clampText(resolvedCwd, 80)}". Pass serverId explicitly or pass workspace.`
        );
      }
    } else {
      const needle = (workspaceLabel || "").toLowerCase();
      const hasSelectedHost = (w) => !explicitServerId || Boolean(w.hosts?.some((h) => h.serverId === explicitServerId && h.preferredCwd));
      const exactMatch = (w) => w.id === needle || w.name.toLowerCase() === needle || String(w.repo ?? "").toLowerCase() === needle;
      const partialMatch = (w) => w.name.toLowerCase().includes(needle) || String(w.repo ?? "").toLowerCase().includes(needle);
      const matched = inventory.workspaces.find((w) => exactMatch(w) && hasSelectedHost(w))
        ?? inventory.workspaces.find((w) => partialMatch(w) && hasSelectedHost(w))
        ?? inventory.workspaces.find(exactMatch)
        ?? inventory.workspaces.find(partialMatch);

      if (!matched?.defaultTarget?.cwd || !matched?.defaultTarget?.serverId) {
        throw new Error(
          `No Paseo workspace matching "${clampText(workspaceLabel, 80)}" was found on any online host. Call fleet_workspaces to see available workspaces.`
        );
      }
      resolvedServerId ??= matched.defaultTarget.serverId;
      if (!resolvedCwd) {
        const hostMatch = matched.hosts?.find((h) => h.serverId === resolvedServerId && h.preferredCwd);
        if (explicitServerId && !hostMatch?.preferredCwd) {
          throw new Error(
            `Workspace "${clampText(workspaceLabel || matched.name, 80)}" has no known directory on Paseo host "${clampText(explicitServerId, 80)}".`
          );
        }
        resolvedCwd = hostMatch?.preferredCwd ?? matched.defaultTarget.cwd;
      }
      workspaceLabel ??= matched.name;
    }
  }

  const createCfg = {
    ...supervisor.config,
    paseo: { ...supervisor.config.paseo, timeoutMs: Math.min(supervisor.config.paseo.timeoutMs ?? 30_000, 30_000) }
  };

  const created = await withPaseo(createCfg, async (client, signal) => {
    const directory = await client.hosts.list();
    const api = await hostApi(client, resolvedServerId, directory);
    const agentConfig = await resolvePaseoAgentConfig(api, resolvedCwd, { provider, model, effort, modeId });
    signal.throwIfAborted();
    const handle = await api.agents.create({
      config: agentConfig,
      cwd: resolvedCwd,
      ...(cleanTitle ? { title: cleanTitle } : {}),
      prompt: cleanPrompt
    });
    const snap = typeof handle?.current === "function" ? handle.current() : null;
    const agentId = handle?.id ?? snap?.id;
    if (!agentId) throw new Error("Paseo host did not return a created agent ID.");
    if (normalizedImages.length > 0 && typeof api?.agents?.ref === "function") {
      try {
        await api.agents.ref(agentId).send("Attached image(s) from the owner.", {
          messageId: randomUUID(),
          activeTurnBehavior: "steer",
          images: normalizedImages
        });
      } catch { /* initial prompt already started */ }
    }
    const providerSpec = agentConfig.provider;
    const modelSpec = agentConfig.model ?? providerSpec.split("/")[1] ?? null;
    const agentRecord = snap ?? {
      id: agentId,
      status: "running",
      cwd: resolvedCwd,
      title: cleanTitle ?? `${workspaceLabel || path.basename(resolvedCwd)} coordinator`,
      provider: providerSpec.split("/")[0],
      model: modelSpec,
      updatedAt: new Date().toISOString()
    };
    const thread = paseoThread(agentRecord, resolvedServerId, [
      { item: { type: "user_message", text: cleanPrompt }, timestamp: new Date().toISOString() }
    ], true);
    return { thread, agentId, providerSpec, modelSpec, effortSpec: agentConfig.thinkingOptionId ?? null };
  }, factory);

  mergeDiscoveredIntoKnown(supervisor, created.thread);
  supervisor.store?.recordAction?.({
    kind: "session-start",
    playbook: "owner-start-session",
    threadKey: created.thread.key,
    route: "paseo-create",
    status: "sent",
    by: "owner",
    reason: clampText(`started Paseo session in ${workspaceLabel || resolvedCwd}: ${cleanTitle || cleanPrompt}`, 240)
  });
  supervisor.emitFleet?.("session-started");

  return {
    status: "started",
    key: created.thread.key,
    serverId: resolvedServerId,
    agentId: created.agentId,
    title: created.thread.title,
    workspace: workspaceLabel ?? deriveProjectInfo({ cwd: resolvedCwd }).name,
    inferredWorkspace,
    cwd: resolvedCwd,
    provider: created.providerSpec,
    model: created.modelSpec,
    effort: created.effortSpec,
    openChat: openChatFor(created.thread)
  };
}

export function isGreenMergeablePrCard(card) {
  if (!card?.prRef) return false;
  if (card.kind !== "merge_ready" && card.kind !== "pr_ready") return false;
  if (card.primaryAction?.op !== "merge" || card.primaryAction?.label !== "Merge PR") return false;
  if (["FAILURE", "ERROR", "PENDING", "IN_PROGRESS"].includes(String(card.ciState ?? "").toUpperCase())) return false;
  if (String(card.mergeState ?? "").toUpperCase() === "DIRTY") return false;
  return true;
}

const VALID_BATCH_OPS = new Set([
  "merge_green", "defer", "dismiss", "fix_ci", "primary", "secondary", "merge", "answer", "reply"
]);
const VALID_BATCH_FILTERS = new Set(["green_prs", "ci_failed", "questions", "non_pr", "all"]);

export function normalizeBatchCardsInput({
  op = null,
  filter = null,
  cardIds = null
} = {}) {
  const normOp = typeof op === "string" ? op.trim().toLowerCase() : "";
  if (!VALID_BATCH_OPS.has(normOp)) {
    throw new Error("Pass a valid batch op ('merge_green', 'defer', 'dismiss', 'fix_ci', 'primary', 'secondary', 'merge', 'answer', 'reply').");
  }
  const normFilter = typeof filter === "string" && filter.trim() ? filter.trim().toLowerCase() : null;
  if (normFilter && !VALID_BATCH_FILTERS.has(normFilter)) {
    throw new Error("Pass a valid batch filter ('green_prs', 'ci_failed', 'questions', 'non_pr', 'all').");
  }
  if (cardIds !== null && cardIds !== undefined) {
    if (!Array.isArray(cardIds) || cardIds.length === 0 || !cardIds.every((id) => typeof id === "string" && id.trim().length > 0)) {
      throw new Error("cardIds must be a non-empty array of card ID strings.");
    }
  }
  const explicitIds = Array.isArray(cardIds)
    ? [...new Set(cardIds.map((id) => String(id ?? "").trim()).filter(Boolean))].slice(0, 25)
    : null;

  if (!explicitIds?.length && !normFilter && normOp !== "merge_green" && normOp !== "fix_ci") {
    throw new Error("Pass explicit cardIds or a filter ('green_prs', 'ci_failed', 'questions', 'all') for batch card actions.");
  }

  return {
    normOp,
    cardOp: normOp === "merge_green" ? "merge" : normOp,
    normFilter,
    explicitIds
  };
}

export function selectBatchTargetCards(openCards, {
  normOp,
  normFilter = null,
  explicitIds = null,
  maxCards = 25
} = {}) {
  const maxBatch = Math.min(25, Math.max(0, Number.isInteger(maxCards) ? maxCards : 25));
  const list = Array.isArray(openCards) ? openCards : [];
  let targets = explicitIds?.length
    ? explicitIds.map((id) => list.find((c) => c.id === id || c.questionId === id)).filter(Boolean)
    : [...list];

  if (normOp === "merge_green" || normFilter === "green_prs") {
    targets = targets.filter(isGreenMergeablePrCard);
  } else if (normFilter === "ci_failed" || (normOp === "fix_ci" && !explicitIds?.length)) {
    targets = targets.filter((c) => c.kind === "ci_failed" || c.primaryAction?.op === "fix_ci");
  } else if (normFilter === "questions" || normFilter === "non_pr") {
    targets = targets.filter((c) => c.kind !== "merge_ready" && c.kind !== "pr_ready" && c.kind !== "ci_failed");
  }

  return targets.slice(0, maxBatch);
}

export async function batchActCards(supervisor, {
  op = null,
  filter = null,
  cardIds = null,
  value = null,
  deadlineAt = null,
  maxCards = 25
} = {}) {
  const openCards = Array.isArray(supervisor?.getState?.()?.cards) ? supervisor.getState().cards : [];
  const { normOp, cardOp, normFilter, explicitIds } = normalizeBatchCardsInput({ op, filter, cardIds });
  const targets = selectBatchTargetCards(openCards, { normOp, normFilter, explicitIds, maxCards });
  if (targets.length === 0) {
    return {
      ok: true,
      op: cardOp,
      total: 0,
      succeeded: 0,
      halted: 0,
      detail: "No open decision cards matched that batch filter.",
      results: []
    };
  }

  const results = [];
  let succeeded = 0;
  let halted = 0;
  for (const card of targets) {
    const outcome = await supervisor.actCard(card.id, {
      op: cardOp,
      ...(value != null ? { value } : {}),
      deadlineAt
    });
    const itemOk = Boolean(outcome && outcome.ok !== false);
    if (itemOk) succeeded += 1;
    else halted += 1;
    results.push({
      cardId: card.id,
      headline: clampText(card.headline ?? card.id, 100),
      prRef: card.prRef ?? null,
      ok: itemOk,
      status: outcome?.status ?? (outcome ? "done" : "closed"),
      detail: clampText(outcome?.detail ?? "", 180) || null
    });
  }

  return {
    ok: halted === 0,
    op: cardOp,
    total: targets.length,
    succeeded,
    halted,
    detail: `Processed ${targets.length} card${targets.length === 1 ? "" : "s"}: ${succeeded} succeeded${halted ? `, ${halted} halted` : ""}.`,
    results
  };
}
