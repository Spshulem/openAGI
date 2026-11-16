// Native Paseo reads. Never creates/imports/reloads an agent or changes its mode.
import os from "node:os";
import { SUPERVISOR_PREFIX, clampText, cleanCardItem, redactSecrets, parsePrRef } from "../contracts.js";
import { classifyErrorText } from "../errors.js";

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

function extractPaseoPendingCard(agent) {
  const rawQuestions = agent?.persistence?.metadata?.asyncQuestions;
  if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) return null;
  const unresolved = rawQuestions.filter((q) => q && typeof q === "object" && q.resolution == null && String(q.question ?? "").trim());
  if (!unresolved.length) return null;
  const items = unresolved.map((q, index) => cleanCardItem({
    index,
    itemId: String(q.id ?? index),
    header: q.header ?? null,
    question: q.question ?? "",
    options: Array.isArray(q.options)
      ? q.options.map((opt) => (typeof opt === "string" ? opt : opt?.label ?? opt?.value ?? "")).filter(Boolean)
      : [],
    multiSelect: Boolean(q.multiSelect),
    freeText: q.freeText !== false,
    at: q.askedAt ?? q.createdAt ?? agent.updatedAt ?? null
  }));
  if (!items.length) return null;
  return {
    app: "paseo",
    cardId: String(unresolved[0].id ?? `paseo-${agent.id}`),
    at: items[0].at ?? agent.updatedAt ?? null,
    count: rawQuestions.length,
    items
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

// A provider failure is a separate timeline item, not an assistant reply.
// Keep it out of conversation/PR extraction, but pass it to the existing
// infrastructure policy. Quoted errors and failed tools are not turn failures.
function currentError(agent, entries) {
  if (agent.archivedAt || agent.activeTurn || ["running", "initializing", "closed"].includes(agent.status)) return null;
  let failure = null;
  for (const entry of entries) {
    if (["user_message", "assistant_message"].includes(entry.item?.type)) failure = null;
    else if (entry.item?.type === "error") failure = entry;
  }
  // A newer retry may fall outside the bounded history page. A current
  // error snapshot is authoritative even when its event is outside that page.
  if (Date.parse(agent.lastUserMessageAt) > Date.parse(failure?.timestamp)) failure = null;
  const snapshotError = agent.status === "error" ? redactSecrets(agent.lastError ?? "").slice(0, 8000).trim() : "";
  if (!snapshotError && !failure && agent.status !== "error") return null;
  const eventError = redactSecrets(failure?.item.message ?? "").slice(0, 8000).trim();
  const message = snapshotError || eventError || "Paseo agent reported an error.";
  const at = failure && (!snapshotError || snapshotError === eventError) ? failure.timestamp : agent.updatedAt;
  const now = new Date(Number.isFinite(Date.parse(at)) ? Date.parse(at) : Date.now());
  return { ...(classifyErrorText(message, now) ?? { kind: "other", resetAt: null }), text: clampText(message, 1000) };
}

export function paseoThread(agent, serverId, entries = [], historyKnown = true) {
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
  const text = redactSecrets(assistant?.item.text ?? "").slice(-8000);
  const prRefs = extractPaseoPrRefs(messages, agent.title ?? "");
  const pendingCard = extractPaseoPendingCard(agent);
  const rawWorkspace = String(agent.workspaceId ?? "").trim();
  const conductorWorkspace = String(agent.labels?.["migration.conductorWorkspaceName"] ?? "").trim()
    || (/\/\.conductor\/([^/]+)/.exec(String(agent.cwd ?? ""))?.[1] ?? "");
  const cleanWorkspace = rawWorkspace && !/^wks_[0-9a-f]+$/i.test(rawWorkspace)
    ? clampText(rawWorkspace, 80)
    : (conductorWorkspace ? clampText(conductorWorkspace, 80) : null);
  return {
    key: `paseo:${serverId}.${agent.id}`, kind: "paseo", id: agent.id,
    title: clampText(redactSecrets(agent.title ?? "Paseo chat"), 100),
    // Paseo owns its workspace. No local git/stat probes of its paths: a
    // registered host may use the same path for a different repository.
    cwd: null, workspace: cleanWorkspace, repo: parsePrRef(prRefs[0])?.repo ?? null, branch: null,
    agentStatus: agent.pendingPermissions?.length ? "waiting" : agent.activeTurn || agent.status === "initializing" ? "running"
      : ["running", "idle", "error"].includes(agent.status) ? agent.status : "unknown",
    archived: Boolean(agent.archivedAt),
    excluded: agent.archivedAt || agent.status === "closed" ? "closed" : !historyKnown ? "history-unavailable" : null,
    lastActivityAt: agent.updatedAt, lastUserAt: owner?.timestamp ?? agent.lastUserMessageAt ?? null,
    lastUserText: redactSecrets(owner?.item.text ?? "").slice(-8000), lastAgentAt: assistant?.timestamp ?? null,
    lastAgentText: text.slice(-600), lastAgentTail: text, lastAgentFull: text,
    error: currentError(agent, entries), openTasks: [], prRefs, live: null, writerLocked: false,
    meta: { serverId, workspaceId: agent.workspaceId, paseoCwd: agent.cwd, provider: agent.provider,
      model: clampText(redactSecrets(agent.model ?? ""), 100) || null,
      aliases, updatedAt: agent.updatedAt, blockedOnOwner: Boolean(agent.pendingPermissions?.length),
      requiresAttention: Boolean(agent.requiresAttention), attentionReason: agent.attentionReason ?? null,
      ...(pendingCard ? { pendingCard } : {}),
      lastSupervisorAt: supervisor?.timestamp ?? null, historyKnown,
      conversation: messages.filter(e => e.item.type !== "user_message" || !e.item.text?.startsWith(SUPERVISOR_PREFIX)).map(e => ({ role: e.item.type === "user_message" ? "user" : "assistant", text: redactSecrets(e.item.text ?? "").slice(-8000), at: e.timestamp })) }
  };
}

// One source per supervisor: bounded memory and history work, with oldest
// attempted reads first so a slow chat cannot starve the rest of a migration.
export function createPaseoSource({ factory } = {}) {
  const cache = new Map();
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
      const explicitSet = new Set([directory.self.serverId, ...explicitIds]);
      const ids = [...new Set([directory.self.serverId, ...explicitIds, ...autoIds])];
      const inventory = [];
      for (const id of ids) {
        signal.throwIfAborted();
        const isRequiredHost = explicitSet.has(id);
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
      const candidates = inventory.filter(({ agent: a, key }) => !a.archivedAt && ["idle", "error"].includes(a.status)
        && cache.get(key)?.stamp !== a.updatedAt).sort((a, b) =>
          ((cache.get(a.key)?.attempted ?? 0) - (cache.get(b.key)?.attempted ?? 0))
          || (Number(Boolean(b.agent.requiresAttention)) - Number(Boolean(a.agent.requiresAttention)))
          || ((Date.parse(b.agent.updatedAt ?? "") || 0) - (Date.parse(a.agent.updatedAt ?? "") || 0)));
      const scanStartedAt = meta.startedAt ?? Date.now();
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
            // Cache bounded messages and provider errors, never tool output or
            // images. Dropping error items hides failures from the next scan.
            const entries = history.entries.filter(e => ["user_message", "assistant_message", "error"].includes(e.item?.type))
              .slice(-24)
              .map(e => ({ timestamp: e.timestamp, item: e.item.type === "error"
                ? { type: "error", message: redactSecrets(e.item.message ?? "").slice(0, 8000) }
                : { type: e.item.type, text: redactSecrets(e.item.text ?? "").slice(-8000) } }));
            cache.set(key, { attempted: Date.now(), stamp: row.agent.updatedAt, entries });
          } catch { /* uncertain history stays excluded and is tried later */ }
        }));
      }
      signal.throwIfAborted();
      const out = inventory.map(({ agent: a, id, key }) => {
        const history = cache.get(key);
        const known = ["running", "initializing", "closed"].includes(a.status) || (history?.stamp === a.updatedAt);
        return paseoThread(a, id, known ? history?.entries ?? [] : [], known);
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
