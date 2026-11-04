// Native Paseo reads. Never creates/imports/reloads an agent or changes its mode.
import { createPaseoClient } from "@getpaseo/client";
import { SUPERVISOR_PREFIX, clampText, redactSecrets } from "../contracts.js";

export async function withPaseo(config, operation, factory = createPaseoClient) {
  const settings = config.paseo ?? {};
  const url = new URL(settings.url ?? "ws://127.0.0.1:6767/ws");
  if (!["ws:", "wss:"].includes(url.protocol) || url.username || url.password) throw new Error("Invalid Paseo endpoint");
  if (url.protocol === "ws:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new Error("Remote Paseo endpoints require wss");
  const client = factory({ url: url.href, password: settings.password, reconnect: { enabled: false }, connectTimeoutMs: 5000 });
  const abort = new AbortController();
  let timer;
  try {
    return await Promise.race([
      (async () => { await client.connect(); abort.signal.throwIfAborted(); return operation(client, abort.signal); })(),
      new Promise((_, reject) => { timer = setTimeout(() => { abort.abort(); reject(new Error("Paseo request timed out")); }, settings.timeoutMs ?? 20000); })
    ]);
  } finally { clearTimeout(timer); abort.abort(); await client.close(); }
}

export async function hostApi(client, serverId, directory = null) {
  directory ??= await client.hosts.list();
  if (directory.self.serverId === serverId) return client;
  if (!directory.hosts.some(h => h.serverId === serverId && h.enabled && h.status === "online")) throw new Error("Paseo host unavailable");
  return client.hosts.client(serverId);
}

export function paseoThread(agent, serverId, entries = [], historyKnown = true) {
  const messages = entries.filter(e => ["user_message", "assistant_message"].includes(e.item?.type));
  const users = messages.filter(e => e.item.type === "user_message");
  const owner = users.findLast(e => !e.item.text?.startsWith(SUPERVISOR_PREFIX));
  const supervisor = users.findLast(e => e.item.text?.startsWith(SUPERVISOR_PREFIX));
  const assistant = messages.findLast(e => e.item.type === "assistant_message");
  const aliases = [];
  const source = agent.labels?.["migration.source"], sourceId = agent.labels?.["migration.sourceId"];
  if (["codex", "claude", "conductor", "antigravity"].includes(source) && sourceId) aliases.push(`${source}:${sourceId}`);
  const nativeId = agent.persistence?.sessionId ?? agent.runtimeInfo?.sessionId;
  if (["codex", "claude"].includes(agent.provider) && nativeId) aliases.push(`${agent.provider}:${nativeId}`);
  const text = redactSecrets(assistant?.item.text ?? "").slice(-8000);
  return {
    key: `paseo:${serverId}.${agent.id}`, kind: "paseo", id: agent.id,
    title: clampText(redactSecrets(agent.title ?? "Paseo chat"), 100),
    // Paseo owns its workspace. No local git/stat probes of its paths: a
    // registered host may use the same path for a different repository.
    cwd: null, workspace: agent.workspaceId, repo: null, branch: null,
    agentStatus: agent.pendingPermissions?.length ? "waiting" : agent.activeTurn || agent.status === "initializing" ? "running"
      : ["running", "idle", "error"].includes(agent.status) ? agent.status : "unknown",
    archived: Boolean(agent.archivedAt),
    excluded: agent.archivedAt || agent.status === "closed" ? "closed" : !historyKnown ? "history-unavailable" : null,
    lastActivityAt: agent.updatedAt, lastUserAt: owner?.timestamp ?? agent.lastUserMessageAt ?? null,
    lastUserText: redactSecrets(owner?.item.text ?? "").slice(-8000), lastAgentAt: assistant?.timestamp ?? null,
    lastAgentText: text.slice(-600), lastAgentTail: text, lastAgentFull: text,
    error: null, openTasks: [], prRefs: [], live: null, writerLocked: false,
    meta: { serverId, workspaceId: agent.workspaceId, paseoCwd: agent.cwd, provider: agent.provider,
      aliases, updatedAt: agent.updatedAt, blockedOnOwner: Boolean(agent.pendingPermissions?.length),
      lastSupervisorAt: supervisor?.timestamp ?? null, historyKnown,
      conversation: messages.map(e => ({ role: e.item.type === "user_message" ? "user" : "assistant", text: redactSecrets(e.item.text ?? "").slice(-8000), at: e.timestamp })) }
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
    return withPaseo(config, async (client, signal) => {
      const directory = await client.hosts.list();
      const ids = [...new Set([directory.self.serverId, ...(config.paseo.serverIds ?? [])])];
      const inventory = [];
      for (const id of ids) {
        signal.throwIfAborted();
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
      }
      const live = new Set(inventory.map(r => r.key));
      for (const key of cache.keys()) if (!live.has(key)) cache.delete(key);
      const candidates = inventory.filter(({ agent: a, key }) => !a.archivedAt && ["idle", "error"].includes(a.status)
        && cache.get(key)?.stamp !== a.updatedAt).sort((a, b) => (cache.get(a.key)?.attempted ?? 0) - (cache.get(b.key)?.attempted ?? 0));
      const budget = Math.min(24, Math.max(1, config.paseo.historyPerScan ?? 12));
      for (let offset = 0; offset < Math.min(budget, candidates.length); offset += 4) {
        signal.throwIfAborted();
        await Promise.all(candidates.slice(offset, Math.min(offset + 4, budget)).map(async row => {
          const { api, agent: a, key } = row;
          cache.set(key, { attempted: Date.now() });
          try {
            const history = await api.agents.ref(a.id).timeline.refetch({ direction: "tail", limit: 12 });
            signal.throwIfAborted();
            row.agent = history.agent ?? a;
            // Cache only bounded text messages, not code, tool output or images.
            const entries = history.entries.filter(e => ["user_message", "assistant_message"].includes(e.item?.type))
              .map(e => ({ timestamp: e.timestamp, item: { type: e.item.type, text: String(e.item.text ?? "").slice(-8000) } }));
            cache.set(key, { attempted: Date.now(), stamp: row.agent.updatedAt, entries });
          } catch { /* uncertain history stays excluded and is tried later */ }
        }));
      }
      signal.throwIfAborted();
      return inventory.map(({ agent: a, id, key }) => {
        const history = cache.get(key);
        const known = ["running", "initializing", "closed"].includes(a.status) || (history?.stamp === a.updatedAt);
        return paseoThread(a, id, known ? history?.entries ?? [] : [], known);
      });
    }, factory);
  };
}
