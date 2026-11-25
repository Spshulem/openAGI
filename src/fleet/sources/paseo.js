// Native Paseo reads. Never creates/imports/reloads an agent or changes its mode.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SUPERVISOR_PREFIX, clampTailLines, clampText, cleanCardItem, redactSecrets, parsePrRef } from "../contracts.js";
import { classifyErrorText } from "../errors.js";

export function stripAgentInternalMarkup(raw) {
  return String(raw ?? "")
    .replace(/<oai-mem-citation\b[\s\S]*?(?:<\/oai-mem-citation>|$)/gi, "")
    .replace(/<(?:system_instruction|system-reminder|EXTREMELY_IMPORTANT|TASK_INSTRUCTION)\b[\s\S]*?(?:<\/(?:system_instruction|system-reminder|EXTREMELY_IMPORTANT|TASK_INSTRUCTION)>|$)/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function dedupeConsecutiveMessages(messages = []) {
  const out = [];
  for (const m of messages) {
    if (!m || typeof m.text !== "string") continue;
    const cleaned = stripAgentInternalMarkup(m.text);
    if (!cleaned) continue;
    const norm = cleaned.replace(/\s+/g, " ").trim();
    const prev = out.at(-1);
    if (prev && prev.role === m.role && prev._norm === norm) {
      prev.at = m.at ?? prev.at;
      continue;
    }
    out.push({ ...m, text: cleaned, _norm: norm });
  }
  return out.map(({ _norm: _ignored, ...rest }) => rest);
}

let paseoMetaCache = { dir: null, wsMtime: 0, prjMtime: 0, workspacesById: new Map(), projectsById: new Map() };

function readLocalPaseoWorkspaceIndex(config) {
  const explicitHome = typeof config?.paseo?.homeDir === "string" && config.paseo.homeDir.trim()
    ? config.paseo.homeDir.trim()
    : null;
  if (!explicitHome && (process.env.NODE_TEST_CONTEXT || process.env.OPENAGI_TEST_ISOLATION === "1" || config?.paseo?.projectsDir === false)) {
    return null;
  }
  const baseDir = path.join(explicitHome || path.join(os.homedir(), ".paseo"), "projects");
  try {
    const wsPath = path.join(baseDir, "workspaces.json");
    const prjPath = path.join(baseDir, "projects.json");
    const wsStat = fs.existsSync(wsPath) ? fs.statSync(wsPath) : null;
    const prjStat = fs.existsSync(prjPath) ? fs.statSync(prjPath) : null;
    if (!wsStat && !prjStat) return null;
    const wsMtime = wsStat?.mtimeMs ?? 0;
    const prjMtime = prjStat?.mtimeMs ?? 0;
    if (paseoMetaCache.dir === baseDir && paseoMetaCache.wsMtime === wsMtime && paseoMetaCache.prjMtime === prjMtime) {
      return paseoMetaCache;
    }
    const projectsById = new Map();
    if (prjStat) {
      const prjList = JSON.parse(fs.readFileSync(prjPath, "utf8"));
      if (Array.isArray(prjList)) {
        for (const p of prjList) {
          if (p?.projectId) projectsById.set(String(p.projectId), p);
        }
      }
    }
    const workspacesById = new Map();
    if (wsStat) {
      const wsList = JSON.parse(fs.readFileSync(wsPath, "utf8"));
      if (Array.isArray(wsList)) {
        for (const w of wsList) {
          if (w?.workspaceId) workspacesById.set(String(w.workspaceId), w);
        }
      }
    }
    paseoMetaCache = { dir: baseDir, wsMtime, prjMtime, workspacesById, projectsById };
    return paseoMetaCache;
  } catch {
    return null;
  }
}

const CODE_PATH_OWNERS = new Set(["src", "app", "packages", "apps", "lib", "test", "tests", "server", "client", "docs", "scripts"]);

function isLocalPaseoHost(hostname) {
  const clean = String(hostname ?? "").replace(/^\[|\]$/g, "").toLowerCase();
  if (["localhost", "127.0.0.1", "::1"].includes(clean)) return true;
  try {
    for (const entries of Object.values(os.networkInterfaces())) {
      for (const entry of entries ?? []) {
        if (String(entry?.address ?? "").toLowerCase() === clean) return true;
      }
    }
  } catch { /* ignore interface probe errors */ }
  return false;
}

export function isLocalPaseoUrl(rawUrl = "ws://127.0.0.1:6767/ws") {
  try {
    const parsed = new URL(rawUrl ?? "ws://127.0.0.1:6767/ws");
    return isLocalPaseoHost(parsed.hostname);
  } catch {
    return false;
  }
}

function extractPaseoPrRefs(messages, title = "") {
  const refs = [];
  const repos = [];
  const pushRef = (repo, num) => {
    const cleanRepo = String(repo ?? "").trim();
    const cleanNum = String(num ?? "").trim();
    const [owner] = cleanRepo.split("/");
    if (!owner || CODE_PATH_OWNERS.has(owner.toLowerCase()) || !/^\d+$/.test(cleanNum)) return;
    repos.push(cleanRepo);
    const ref = `${cleanRepo}#${cleanNum}`;
    if (!refs.includes(ref)) refs.push(ref);
  };
  for (const entry of messages.slice().reverse()) {
    const body = String(entry.item?.text ?? "");
    for (const m of body.matchAll(/https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/(\d+)/g)) {
      pushRef(m[1], m[2]);
    }
    for (const m of body.matchAll(/\bgh\s+pr\s+(?:view|checks|merge|edit|diff|ready)\s+(\d+)[^\n]{0,120}?--repo[=\s]+([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/g)) {
      pushRef(m[2], m[1]);
    }
    for (const m of body.matchAll(/\bgh\s+pr\s+(?:view|checks|merge|edit|diff|ready)\s+--repo[=\s]+([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\s+(\d+)\b/g)) {
      pushRef(m[1], m[2]);
    }
    for (const m of body.matchAll(/(?<![A-Za-z0-9_./:-])([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)\b/g)) {
      pushRef(m[1], m[2]);
    }
    for (const m of body.matchAll(/--repo[=\s]+([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/g)) {
      const [owner] = m[1].split("/");
      if (owner && !CODE_PATH_OWNERS.has(owner.toLowerCase())) repos.push(m[1]);
    }
  }
  const uniqueRepos = [...new Set(repos)];
  if (uniqueRepos.length === 1) {
    for (const m of String(title ?? "").matchAll(/(?:^|\s|\bPR\s*)#(\d+)\b/gi)) {
      pushRef(uniqueRepos[0], m[1]);
    }
  }
  return refs.slice(0, 8);
}

const OPAQUE_PASEO_ID = /^(?:wks_[0-9a-f]+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{6,})$/i;

function extractPaseoPendingCard(agent) {
  const perms = Array.isArray(agent?.pendingPermissions) ? agent.pendingPermissions : [];
  const questionPerms = perms.filter((p) => p && typeof p === "object" && p.kind === "question");
  if (questionPerms.length > 0) {
    const perm = questionPerms[0];
    const items = [];
    const permKey = String(perm.id || "perm");
    const pQuestions = Array.isArray(perm.input?.questions) ? perm.input.questions : [];
    if (pQuestions.length > 0) {
      for (let qIdx = 0; qIdx < pQuestions.length; qIdx += 1) {
        const q = pQuestions[qIdx];
        const qText = String(q?.question ?? q?.title ?? "").trim();
        if (!qText) continue;
        items.push(cleanCardItem({
          index: items.length,
          itemId: `${permKey}:${String(q?.id ?? qIdx)}`,
          header: q?.header ?? null,
          question: qText,
          options: Array.isArray(q?.options)
            ? q.options.map((opt) => (typeof opt === "string" ? opt : opt?.label ?? opt?.value ?? "")).filter(Boolean)
            : [],
          multiSelect: Boolean(q?.multiSelect),
          freeText: q?.freeText !== false,
          at: agent.updatedAt ?? null
        }));
      }
    } else if (String(perm.description ?? perm.input?.prompt ?? "").trim()) {
      items.push(cleanCardItem({
        index: items.length,
        itemId: permKey,
        header: perm.title ?? null,
        question: String(perm.description ?? perm.input?.prompt ?? "").trim(),
        options: [],
        multiSelect: false,
        freeText: true,
        at: agent.updatedAt ?? null
      }));
    }
    if (items.length > 0) {
      return {
        app: "paseo",
        cardId: String(perm.id ?? `paseo-${agent.id}`),
        requestId: String(perm.id ?? ""),
        at: items[0].at ?? agent.updatedAt ?? null,
        count: items.length,
        items
      };
    }
  }

  const rawQuestions = agent?.persistence?.metadata?.asyncQuestions;
  if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) return null;
  const extracted = [];
  let firstCardId = null;
  let firstRequestId = null;
  for (const q of rawQuestions) {
    if (!q || typeof q !== "object" || q.resolution != null) continue;
    if (String(q.question ?? "").trim()) {
      firstCardId ??= String(q.id ?? `paseo-${agent.id}`);
      if (q.requestId) firstRequestId ??= String(q.requestId);
      extracted.push({
        id: q.requestId ? `${q.requestId}:${q.id ?? extracted.length}` : q.id,
        header: q.header ?? null,
        question: q.question,
        options: q.options,
        multiSelect: q.multiSelect,
        freeText: q.freeText,
        at: q.askedAt ?? q.createdAt ?? agent.updatedAt ?? null
      });
    } else if (Array.isArray(q.item?.questions)) {
      const reqId = String(q.requestId ?? (q.item.id ? `permission-${q.item.id}` : `paseo-${agent.id}`));
      firstCardId ??= reqId;
      if (q.requestId || q.item.id) firstRequestId ??= reqId;
      for (let idx = 0; idx < q.item.questions.length; idx += 1) {
        const sub = q.item.questions[idx];
        if (!String(sub?.title ?? "").trim()) continue;
        extracted.push({
          id: `${reqId}:${idx}`,
          header: `Question ${idx + 1}`,
          question: sub.title,
          options: sub.options,
          multiSelect: false,
          freeText: true,
          at: agent.updatedAt ?? null
        });
      }
    }
  }
  if (!extracted.length) return null;
  const items = extracted.map((q, index) => cleanCardItem({
    index,
    itemId: String(q.id ?? index),
    header: q.header ?? null,
    question: q.question ?? "",
    options: Array.isArray(q.options)
      ? q.options.map((opt) => (typeof opt === "string" ? opt : opt?.label ?? opt?.value ?? "")).filter(Boolean)
      : [],
    multiSelect: Boolean(q.multiSelect),
    freeText: q.freeText !== false,
    at: q.at
  }));
  if (!items.length) return null;
  return {
    app: "paseo",
    cardId: firstCardId ?? `paseo-${agent.id}`,
    ...(firstRequestId ? { requestId: firstRequestId } : {}),
    at: items[0].at ?? agent.updatedAt ?? null,
    count: rawQuestions.length,
    items
  };
}

function extractPaseoPendingPermission(agent) {
  const perms = Array.isArray(agent?.pendingPermissions) ? agent.pendingPermissions : [];
  const blocking = perms.find((p) => p && typeof p === "object" && p.kind !== "question");
  if (!blocking) return null;
  const command = blocking.detail?.command ?? blocking.input?.command ?? blocking.input?.cmd ?? null;
  const filePath = blocking.detail?.filePath ?? blocking.input?.file_path ?? blocking.input?.path ?? null;
  return {
    id: blocking.id ? String(blocking.id) : null,
    kind: blocking.kind ? String(blocking.kind) : "tool",
    name: blocking.name ? clampText(redactSecrets(String(blocking.name)), 80) : null,
    title: blocking.title ? clampText(redactSecrets(String(blocking.title)), 120) : null,
    description: blocking.description ? clampText(redactSecrets(String(blocking.description)), 280) : null,
    command: command ? clampText(redactSecrets(String(command)), 240) : null,
    rawCommand: command ? redactSecrets(String(command)).slice(0, 2000) : null,
    ...(command && String(command).length > 2000 ? { rawCommandTruncated: true } : {}),
    filePath: filePath ? clampText(redactSecrets(String(filePath)), 200) : null,
    actions: Array.isArray(blocking.actions)
      ? blocking.actions
          .slice(0, 4)
          .map((a) => ({
            id: String(a?.id ?? ""),
            label: clampText(redactSecrets(String(a?.label ?? "")), 40),
            behavior: a?.behavior === "deny" ? "deny" : "allow"
          }))
          .filter((a) => a.label)
      : []
  };
}

export async function withPaseo(config, operation, factory) {
  const settings = config.paseo ?? {};
  const url = new URL(settings.url ?? "ws://127.0.0.1:6767/ws");
  if (!["ws:", "wss:"].includes(url.protocol) || url.username || url.password) throw new Error("Invalid Paseo endpoint");
  if (url.protocol === "ws:" && !isLocalPaseoHost(url.hostname)) throw new Error("Remote Paseo endpoints require wss");
  // The embedded mobile daemon omits desktop integrations. Load the SDK only
  // when Paseo is actually used, so disabled integrations cannot break boot.
  factory ??= (await import("@getpaseo/client")).createPaseoClient;
  const client = factory({ url: url.href, password: settings.password, reconnect: { enabled: false }, connectTimeoutMs: 5000 });
  const abort = new AbortController();
  const totalTimeoutMs = settings.timeoutMs ?? 60000;
  const scanStartedAt = Date.now();
  let timer;
  try {
    return await Promise.race([
      (async () => { await client.connect(); abort.signal.throwIfAborted(); return operation(client, abort.signal, { startedAt: scanStartedAt, timeoutMs: totalTimeoutMs }); })(),
      new Promise((_, reject) => { timer = setTimeout(() => { abort.abort(); reject(new Error("Paseo request timed out")); }, totalTimeoutMs); })
    ]);
  } finally { clearTimeout(timer); abort.abort(); await client.close(); }
}

export async function hostApi(client, serverId, directory = null) {
  directory ??= await client.hosts.list();
  if (directory.self.serverId === serverId) return client;
  if (!directory.hosts.some(h => h.serverId === serverId && h.enabled && h.status === "online")) throw new Error("Paseo host unavailable");
  return client.hosts.client(serverId);
}

// A provider's account-limit notice posted as the whole assistant reply,
// with or without Paseo's "[System Error]" prefix: Codex's "You've hit your
// usage limit ... try again at Nov 23rd, 2026 5:58 PM." An agent quoting
// such a notice inside a longer report is not one: the notice must open the
// message and the message must be short.
const PROVIDER_LIMIT_NOTICE = /^You['\u2019]ve (?:hit|reached) your (?:usage|session|weekly|daily) limit\b/i;
export function providerLimitNotice(text) {
  const plain = String(text ?? "").trim();
  return plain.length <= 600 && PROVIDER_LIMIT_NOTICE.test(plain);
}

// A provider failure is a separate timeline item, not an assistant reply.
// Keep it out of conversation/PR extraction, but pass it to the existing
// infrastructure policy. Quoted errors and failed tools are not turn failures.
function currentError(agent, entries) {
  if (agent.archivedAt) return null;
  let failure = null;
  for (const entry of entries) {
    if (entry.item?.type === "user_message") {
      failure = null;
    } else if (entry.item?.type === "assistant_message") {
      const rawText = String(entry.item?.text ?? "").trim();
      if (/^\[System Error\]/i.test(rawText) || providerLimitNotice(rawText)) {
        failure = {
          timestamp: entry.timestamp,
          isSystemErrorMsg: true,
          item: {
            type: "error",
            message: rawText.replace(/^\[System Error\]\s*/i, "").trim() || rawText
          }
        };
      } else {
        failure = null;
      }
    } else if (entry.item?.type === "error") {
      failure = entry;
    }
  }
  // A newer retry may fall outside the bounded history page. A current
  // error snapshot is authoritative even when its event is outside that page.
  if (Date.parse(agent.lastUserMessageAt) > Date.parse(failure?.timestamp)) failure = null;
  // An active turn or initializing/closed state clears old error events; only an
  // unrecovered `[System Error]` assistant message on a stuck `"running"` session
  // (where Paseo emitted the quota/auth error without clearing `status: "running"`)
  // remains an active error.
  if (agent.activeTurn || ["initializing", "closed"].includes(agent.status)) return null;
  if (agent.status === "running" && !failure?.isSystemErrorMsg) return null;
  const snapshotError = agent.status === "error" ? redactSecrets(agent.lastError ?? "").slice(0, 8000).trim() : "";
  if (!snapshotError && !failure && agent.status !== "error") return null;
  const eventError = redactSecrets(failure?.item.message ?? "").slice(0, 8000).trim();
  // The snapshot's lastError wins, unless only the timeline event names a
  // known failure (a generic "turn failed" beside Codex's quota notice).
  const eventAt = Number.isFinite(Date.parse(failure?.timestamp)) ? new Date(Date.parse(failure.timestamp)) : new Date();
  const useEvent = Boolean(eventError) && (!snapshotError || snapshotError === eventError
    || (!classifyErrorText(snapshotError, eventAt) && Boolean(classifyErrorText(eventError, eventAt))));
  const message = (useEvent ? eventError : snapshotError) || "Paseo agent reported an error.";
  const at = failure && (useEvent || !snapshotError) ? failure.timestamp : agent.updatedAt;
  const now = new Date(Number.isFinite(Date.parse(at)) ? Date.parse(at) : Date.now());
  return {
    ...(classifyErrorText(message, now) ?? { kind: "other", resetAt: null }),
    text: clampText(message, 1000),
    ...(failure?.timestamp ? { at: failure.timestamp } : {})
  };
}

export function paseoThread(agent, serverId, entries = [], historyKnown = true, { planArtifactPath = null, workspaceMeta = null, sleepingActive = false, silentStuck = false, lastProgressAt = null } = {}) {
  const messages = entries.filter(e => ["user_message", "assistant_message"].includes(e.item?.type));
  const users = messages.filter(e => e.item.type === "user_message");
  const owner = users.findLast(e => !e.item.text?.startsWith(SUPERVISOR_PREFIX));
  const supervisor = users.findLast(e => e.item.text?.startsWith(SUPERVISOR_PREFIX));
  const assistant = messages.findLast(e => e.item.type === "assistant_message");
  const aliases = [];
  const rawSource = String(agent.labels?.["migration.source"] ?? "").trim().toLowerCase();
  const sourceId = agent.labels?.["migration.sourceId"];
  if (["codex", "claude", "conductor", "antigravity"].includes(rawSource) && sourceId) aliases.push(`${rawSource}:${sourceId}`);
  const nativeId = agent.persistence?.sessionId ?? agent.runtimeInfo?.sessionId;
  const rawProvider = String(agent.provider ?? "").trim().toLowerCase();
  if (["codex", "claude", "antigravity"].includes(rawProvider) && nativeId) aliases.push(`${rawProvider}:${nativeId}`);
  const text = stripAgentInternalMarkup(redactSecrets(assistant?.item.text ?? "")).slice(-8000);
  const prRefs = extractPaseoPrRefs(messages, agent.title ?? "");
  const pendingCard = extractPaseoPendingCard(agent);
  const pendingPermission = extractPaseoPendingPermission(agent);
  const hasBlockingPermission = Boolean(pendingPermission) || (Boolean(agent.pendingPermissions?.length) && !pendingCard);
  const permissionFeature = (Array.isArray(agent.features) ? agent.features : [])
    .find((feature) => feature?.type === "select" && /permission|approval|sandbox|tool.?policy/i.test(`${feature.id} ${feature.label}`));
  const rawWorkspace = String(agent.workspaceId ?? "").trim();
  const conductorWorkspace = String(agent.labels?.["migration.conductorWorkspaceName"] ?? "").trim()
    || (/\/\.conductor\/([^/]+)/.exec(String(agent.cwd ?? ""))?.[1] ?? "");
  const cleanWorkspace = rawWorkspace && !OPAQUE_PASEO_ID.test(rawWorkspace)
    ? clampText(rawWorkspace, 80)
    : (conductorWorkspace ? clampText(conductorWorkspace, 80) : null);
  const agentLabels = {};
  if (agent.labels && typeof agent.labels === "object") {
    for (const k of ["theme", "migration.originalCwd", "migration.conductorWorkspaceName"]) {
      if (typeof agent.labels[k] === "string" && agent.labels[k].trim()) {
        agentLabels[k] = clampText(agent.labels[k].trim(), 200);
      }
    }
  }
  const paseoLabels = Array.isArray(workspaceMeta?.labels)
    ? workspaceMeta.labels.filter((l) => typeof l === "string" && l.trim()).slice(0, 8)
    : [];
  const conversation = dedupeConsecutiveMessages(
    messages
      .filter(e => e.item.type !== "user_message" || !e.item.text?.startsWith(SUPERVISOR_PREFIX))
      .map(e => ({ role: e.item.type === "user_message" ? "user" : "assistant", text: redactSecrets(e.item.text ?? "").slice(-8000), at: e.timestamp }))
  );
  const detectedError = currentError(agent, entries);
  // A session Paseo still reports "running" has an error here only when its
  // last turn ended in an unrecovered [System Error] with no active turn
  // (currentError): that turn failed, whatever the kind, so a transient one
  // (capacity, network) reaches the backoff instead of reading as running.
  const hardTerminalError = Boolean(
    detectedError && (["usage-limit", "session-limit", "model-limit", "logged-out", "disk-full"].includes(detectedError.kind)
      || agent.status === "running")
  );
  return {
    key: `paseo:${serverId}.${agent.id}`, kind: "paseo", id: agent.id,
    title: clampText(redactSecrets(agent.title ?? "Paseo chat"), 100),
    // Paseo owns its workspace. No local git/stat probes of its paths: a
    // registered host may use the same path for a different repository.
    cwd: null, workspace: cleanWorkspace, repo: parsePrRef(prRefs[0])?.repo ?? workspaceMeta?.repo ?? null, branch: workspaceMeta?.branch ?? null,
    agentStatus: hasBlockingPermission ? "waiting" : hardTerminalError ? "error" : silentStuck ? "stalled" : agent.activeTurn || agent.status === "initializing" ? "running"
      : ["running", "idle", "error"].includes(agent.status) ? agent.status
      : (sleepingActive && !agent.archivedAt && agent.status === "closed") ? "idle" : "unknown",
    archived: Boolean(agent.archivedAt),
    excluded: agent.archivedAt ? "closed"
      : (agent.status === "closed" && !sleepingActive) ? "closed"
      : !historyKnown ? "history-unavailable" : null,
    lastActivityAt: agent.updatedAt,
    // The newest timeline event a recent history read saw (null when
    // unknown). Unlike lastActivityAt (Paseo's updatedAt), it does not move
    // while an open turn produces nothing.
    ...(lastProgressAt ? { lastProgressAt } : {}),
    lastUserAt: owner?.timestamp ?? agent.lastUserMessageAt ?? null,
    lastUserText: stripAgentInternalMarkup(redactSecrets(owner?.item.text ?? "")).slice(-8000), lastAgentAt: assistant?.timestamp ?? null,
    lastAgentText: clampTailLines(text, 900), lastAgentTail: text, lastAgentFull: text,
    error: detectedError, openTasks: [], prRefs, live: null, writerLocked: false,
    meta: { serverId, workspaceId: agent.workspaceId, paseoCwd: agent.cwd, provider: agent.provider,
      model: clampText(redactSecrets(agent.model ?? ""), 100) || null,
      settings: {
        model: clampText(redactSecrets(agent.model ?? ""), 100) || null,
        reasoningEffort: clampText(redactSecrets(agent.effectiveThinkingOptionId ?? agent.thinkingOptionId ?? ""), 80) || null,
        permissions: permissionFeature?.value ? clampText(redactSecrets(permissionFeature.value), 80) : null,
        pendingPermissionCount: Array.isArray(agent.pendingPermissions) ? agent.pendingPermissions.length : 0,
        busy: Boolean(agent.activeTurn) || ["running", "initializing"].includes(agent.status),
        authoritative: false
      },
      aliases, createdAt: agent.createdAt ?? null, updatedAt: agent.updatedAt, blockedOnOwner: hasBlockingPermission,
      ...(!agent.archivedAt && agent.status === "closed" ? { paseoClosed: true } : {}),
      ...(silentStuck ? { silentStuck: true } : {}),
      requiresAttention: Boolean(agent.requiresAttention), attentionReason: agent.attentionReason ?? null,
      ...(Object.keys(agentLabels).length ? { agentLabels } : {}),
      ...(agentLabels.theme ? { theme: agentLabels.theme } : {}),
      ...(paseoLabels.length ? { paseoLabels } : {}),
      ...(workspaceMeta?.projectName ? { paseoProjectName: workspaceMeta.projectName } : {}),
      ...(workspaceMeta?.projectRoot ? { paseoProjectRoot: workspaceMeta.projectRoot } : {}),
      ...(planArtifactPath ? { hasPlanArtifact: true, planArtifactPath } : {}),
      ...(pendingCard ? { pendingCard } : {}),
      ...(pendingPermission ? { pendingPermission } : {}),
      lastSupervisorAt: supervisor?.timestamp ?? null, historyKnown,
      conversation }
  };
}

// One source per supervisor: bounded memory and history work, with oldest
// attempted reads first so a slow chat cannot starve the rest of a migration.
export function createPaseoSource({ factory } = {}) {
  const cache = new Map();
  // key -> { latestEventMs, fetchedAt }: the newest timeline event a
  // successful history read saw. Kept apart from the cache, which each fetch
  // resets, so a failed read never erases what is known about progress.
  const progress = new Map();
  let active;
  return function listPaseoThreads(config) {
    // Retain ownership even if an outer caller times out during client close.
    if (active) return active;
    active = scan(config).finally(() => { active = null; });
    return active;
  };
  async function scan(config) {
    if (!config.paseo?.enabled) return [];
    return withPaseo(config, async (client, signal, meta = {}) => {
      const directory = await client.hosts.list();
      const explicitIds = Array.isArray(config.paseo.serverIds) ? config.paseo.serverIds.filter(Boolean) : [];
      const autoHostsOn = !explicitIds.length && config.paseo.autoHosts !== false;
      const enabledHosts = (directory.hosts ?? []).filter((h) => h?.serverId && h.enabled);
      const autoIds = autoHostsOn
        ? enabledHosts.filter((h) => h.status === "online").map((h) => h.serverId)
        : [];
      const unknownHostIds = new Set(
        autoHostsOn
          ? enabledHosts.filter((h) => h.status !== "online").map((h) => h.serverId)
          : []
      );
      const ids = [...new Set([directory.self.serverId, ...explicitIds, ...autoIds])];
      const inventory = [];
      for (const id of ids) {
        signal.throwIfAborted();
        // Only the local Paseo daemon (`directory.self.serverId`) is mandatory for
        // a scan; a transient peer-relay failure on a remote configured host must
        // preserve cached peer state (`unknownHostIds`) instead of aborting local discovery.
        const isRequiredHost = id === directory.self.serverId;
        try {
          const api = await hostApi(client, id, directory);
          let cursor;
          const seen = new Set();
          for (let page = 0; page < 20; page++) {
            signal.throwIfAborted();
            const result = await api.agents.list({ filter: { includeArchived: false, includeBackground: true },
              sort: [{ key: "updated_at", direction: "desc" }], page: { limit: 100, ...(cursor ? { cursor } : {}) } });
            for (const { agent } of result.entries) inventory.push({ agent, id, api, key: `${config.paseo.url ?? "local"}:${id}:${agent.id}` });
            if (!result.pageInfo.hasMore) break;
            cursor = result.pageInfo.nextCursor;
            if (!cursor || seen.has(cursor) || page === 19) throw new Error("Paseo inventory incomplete; narrow configured hosts");
            seen.add(cursor);
          }
        } catch (err) {
          if (isRequiredHost || signal.aborted) throw err;
          unknownHostIds.add(id);
        }
      }
      const live = new Set(inventory.map(r => r.key));
      const urlPrefix = `${config.paseo.url ?? "local"}:`;
      for (const key of cache.keys()) {
        if (live.has(key)) continue;
        const retainedUnknown = [...unknownHostIds].some((hid) => key.startsWith(`${urlPrefix}${hid}:`));
        if (!retainedUnknown) cache.delete(key);
      }
      const scanStartedAt = meta.startedAt ?? Date.now();
      const lookbackMs = Math.max(1, Number(config.lookbackHours ?? 168)) * 3600_000;
      const liveStallMs = config.limits?.liveServerStallMs ?? 2 * 3600_000;
      const runningRefreshMs = 3 * 60_000;
      const isRecentSleeping = (a) => Boolean(
        !a.archivedAt && a.status === "closed" && (Date.parse(a.updatedAt ?? "") || 0) >= scanStartedAt - lookbackMs
      );
      // A turn that is open and not waiting on a permission.
      const isBusy = (a) => Boolean(
        !a.archivedAt
        && !a.pendingPermissions?.length
        && (a.activeTurn || ["running", "initializing"].includes(a.status))
      );
      // Paseo's own record has not changed for the stall window.
      const isSilentRunning = (a) => Boolean(
        isBusy(a)
        && (Date.parse(a.updatedAt ?? "") || 0) > 0
        && scanStartedAt - (Date.parse(a.updatedAt ?? "") || 0) >= liveStallMs
      );
      // agent.updatedAt is liveness, not progress: Paseo refreshes it while a
      // turn is open even if one tool call has produced nothing for hours
      // (2026-11-25: a recursive glob ran 10 h 44 m that way). A recent,
      // successful history read whose newest event is older than the stall
      // window is evidence of no progress; no recent read is no evidence.
      const progressFreshMs = 15 * 60_000;
      const progressOf = (key) => {
        const known = progress.get(key);
        return known && scanStartedAt - known.fetchedAt <= progressFreshMs ? known : null;
      };
      // The evidence must cover the current turn: a read taken before the
      // turn started (or before the owner's latest message) says nothing
      // about it, and silence is counted from the newest of the last event,
      // the turn's start and that message.
      const turnProgressMs = (a, key) => {
        const known = progressOf(key);
        if (!known) return null;
        const startedMs = Math.max(Date.parse(a.activeTurn?.startedAt ?? "") || 0, Date.parse(a.lastUserMessageAt ?? "") || 0);
        if (startedMs > known.fetchedAt) return null;
        return Math.max(known.latestEventMs, startedMs);
      };
      const isBusyWithoutProgress = (a, key) => {
        const latest = isBusy(a) ? turnProgressMs(a, key) : null;
        return latest !== null && scanStartedAt - latest >= liveStallMs;
      };
      const isRunningNeedsErrorProbe = (a, key) => Boolean(
        !a.archivedAt
        && (a.activeTurn || a.status === "running")
        && cache.get(key)?.stamp !== a.updatedAt
        && scanStartedAt - (cache.get(key)?.attempted ?? 0) >= runningRefreshMs
      );
      const candidates = inventory.filter(({ agent: a, key }) => !a.archivedAt
        && (["idle", "error"].includes(a.status) || isRecentSleeping(a) || isSilentRunning(a) || isRunningNeedsErrorProbe(a, key))
        && cache.get(key)?.stamp !== a.updatedAt).sort((a, b) =>
          (Number(a.agent.status === "closed") - Number(b.agent.status === "closed"))
          || ((cache.get(a.key)?.attempted ?? 0) - (cache.get(b.key)?.attempted ?? 0))
          || (Number(Boolean(b.agent.requiresAttention)) - Number(Boolean(a.agent.requiresAttention)))
          || ((Date.parse(b.agent.updatedAt ?? "") || 0) - (Date.parse(a.agent.updatedAt ?? "") || 0)));
      const totalTimeoutMs = meta.timeoutMs ?? config.paseo.timeoutMs ?? 60000;
      const perHistoryMs = config.paseo.historyTimeoutMs ?? 3000;
      const historyDeadline = scanStartedAt + Math.max(0, totalTimeoutMs - Math.min(3500, Math.floor(totalTimeoutMs * 0.2)));
      const budget = Math.min(80, Math.max(1, config.paseo.historyPerScan ?? 48));
      for (let offset = 0; offset < Math.min(budget, candidates.length); offset += 4) {
        signal.throwIfAborted();
        if (offset > 0 && Date.now() >= historyDeadline) break;
        const batchTimeoutMs = offset > 0
          ? Math.max(10, Math.min(perHistoryMs, historyDeadline - Date.now()))
          : Math.min(perHistoryMs, Math.max(20, historyDeadline - Date.now()));
        await Promise.all(candidates.slice(offset, Math.min(offset + 4, budget)).map(async row => {
          const { api, agent: a, key } = row;
          cache.set(key, { attempted: Date.now() });
          try {
            // A single slow imported history must not discard the entire fleet.
            let historyTimer;
            const history = await Promise.race([
              api.agents.ref(a.id).timeline.refetch({ direction: "tail", limit: 80 }),
              new Promise((_, reject) => { historyTimer = setTimeout(() => reject(new Error("History timed out")), batchTimeoutMs); })
            ]).finally(() => clearTimeout(historyTimer));
            signal.throwIfAborted();
            row.agent = history.agent ?? a;
            let lastUserIdx = -1;
            for (let i = history.entries.length - 1; i >= 0; i--) {
              if (history.entries[i]?.item?.type === "user_message") { lastUserIdx = i; break; }
            }
            let planArtifactPath = null;
            for (let i = Math.max(0, lastUserIdx + 1); i < history.entries.length; i++) {
              const it = history.entries[i]?.item;
              if (it?.type === "tool_call" && ["write_file", "edit_file"].includes(it.name)) {
                const targetPath = String(it.detail?.input?.Path ?? it.detail?.input?.path ?? "");
                if (/\/brain\/[^/]+\/[^/]+\.md$/i.test(targetPath) && !/\/scratch\//i.test(targetPath)) {
                  planArtifactPath = targetPath;
                }
              }
            }
            // Cache bounded messages and provider errors, never tool output or
            // images. Dropping error items hides failures from the next scan.
            const entries = history.entries.filter(e => ["user_message", "assistant_message", "error"].includes(e.item?.type))
              .slice(-24)
              .map(e => ({ timestamp: e.timestamp, item: e.item.type === "error"
                ? { type: "error", message: redactSecrets(e.item.message ?? "").slice(0, 8000) }
                : { type: e.item.type, text: redactSecrets(e.item.text ?? "").slice(-8000) } }));
            // Silence is measured across every fetched event (tool calls
            // included), not just the bounded message excerpts above.
            const latestEventMs = Math.max(0, ...history.entries.map(e => Date.parse(e?.timestamp ?? "") || 0));
            cache.set(key, { attempted: Date.now(), stamp: row.agent.updatedAt, entries, planArtifactPath, latestEventMs });
            if (latestEventMs > 0) progress.set(key, { latestEventMs, fetchedAt: Date.now() });
          } catch { /* uncertain history stays excluded and is tried later */ }
        }));
      }
      signal.throwIfAborted();
      const selfIsLocal = isLocalPaseoUrl(config.paseo?.url);
      const localIndex = selfIsLocal || config.paseo?.homeDir ? readLocalPaseoWorkspaceIndex(config) : null;
      const out = inventory.map(({ agent: a, id, key }) => {
        const history = cache.get(key);
        const sleepingActive = isRecentSleeping(a);
        const histEntries = history?.stamp === a.updatedAt ? (history?.entries ?? []) : [];
        const latestTimelineMs = Math.max(
          Date.parse(a.updatedAt ?? "") || 0,
          ...histEntries.map((e) => Date.parse(e?.timestamp ?? "") || 0),
          history?.stamp === a.updatedAt ? (history?.latestEventMs ?? 0) : 0
        );
        const silentStuck = (isSilentRunning(a) && scanStartedAt - latestTimelineMs >= liveStallMs) || isBusyWithoutProgress(a, key);
        const lastProgressMs = (isBusy(a) ? turnProgressMs(a, key) : progressOf(key)?.latestEventMs) ?? 0;
        const known = ["running", "initializing"].includes(a.status)
          || (a.status === "closed" && !sleepingActive)
          || (history?.stamp === a.updatedAt);
        let workspaceMeta = null;
        if (localIndex && id === directory.self?.serverId && a.workspaceId) {
          const wsObj = localIndex.workspacesById.get(String(a.workspaceId));
          const prjObj = wsObj?.projectId ? localIndex.projectsById.get(String(wsObj.projectId)) : null;
          const remoteMatch = /^remote:github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/i.exec(String(prjObj?.projectKey ?? ""));
          workspaceMeta = {
            labels: Array.isArray(wsObj?.labels) ? wsObj.labels : [],
            projectName: prjObj?.customName || prjObj?.displayName || null,
            projectRoot: prjObj?.rootPath || wsObj?.mainRepoRoot || null,
            repo: remoteMatch?.[1] ?? null,
            branch: wsObj?.branch ?? null
          };
        }
        const row = paseoThread(a, id, known ? history?.entries ?? [] : [], known, {
          planArtifactPath: known ? history?.planArtifactPath ?? null : null,
          workspaceMeta,
          sleepingActive,
          silentStuck,
          lastProgressAt: lastProgressMs > 0 ? new Date(lastProgressMs).toISOString() : null
        });
        row.meta.isLocalHost = Boolean(selfIsLocal && id === directory.self?.serverId);
        return row;
      });
      if (unknownHostIds.size > 0) {
        Object.defineProperty(out, "unknownThreadPrefixes", {
          value: [...unknownHostIds].map((hid) => `paseo:${hid}.`),
          enumerable: false
        });
      }
      return out;
    }, factory);
  };
}

export async function archivePaseoAgent(config, serverId, agentId, factory) {
  if (!config?.paseo?.enabled || !serverId || !agentId) return { ok: false, detail: "Paseo not configured." };
  return withPaseo(config, async (client) => {
    const api = await hostApi(client, serverId);
    const ref = api.agents.ref(agentId);
    if (typeof ref?.archive !== "function") {
      return { ok: false, detail: "Paseo host does not support agent archive." };
    }
    await ref.archive();
    return { ok: true, detail: "Archived in Paseo." };
  }, factory);
}

export async function unarchivePaseoAgent(config, serverId, agentId, factory) {
  if (!config?.paseo?.enabled || !serverId || !agentId) return { ok: false, detail: "Paseo not configured." };
  return withPaseo(config, async (client) => {
    const api = await hostApi(client, serverId);
    const ref = api.agents.ref(agentId);
    if (typeof ref?.reload !== "function") {
      return { ok: false, detail: "Paseo host does not support restoring archived chats." };
    }
    const res = await ref.reload();
    if (res?.agent?.archivedAt) {
      return { ok: false, detail: "Paseo kept the coding chat archived." };
    }
    return { ok: true, detail: "Restored coding chat in Paseo." };
  }, factory);
}
