import path from "node:path";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { ensureDir, readJsonFile, safeFilename, writeJsonAtomic, writeTextAtomic } from "./file-utils.js";
import { createId, nowIso } from "./utils.js";
import { resolveDataDir } from "./data-dir.js";

const LEGACY_TOOL_ARGUMENT_PARSE_MAX_BYTES = 1_048_576;
const LEGACY_SESSION_MIGRATION_MAX_BYTES = 16 * 1024 * 1024;

export class InMemoryAgentStore {
  constructor(options = {}) {
    this.agents = new Map();
    this.sessions = new Map();
    if (options.ensureDefault !== false) this.ensureAgent({ id: "main", name: "Main Agent", role: "root" });
  }

  ensureAgent(agent) {
    const existing = this.agents.get(agent.id);
    if (existing) return existing;
    const created = normalizeAgent(agent);
    this.agents.set(created.id, created);
    return created;
  }

  // Overwrite fields on an agent (unlike ensureAgent, which no-ops if it
  // exists). Used to apply persona.md to the main agent on every boot.
  setAgent(id, fields) {
    const merged = normalizeAgent({ ...(this.agents.get(id) ?? { id }), ...fields, id });
    this.agents.set(id, merged);
    return merged;
  }

  createAgent(agent = {}) {
    const id = agent.id ?? createId("agent");
    return this.ensureAgent({ ...agent, id });
  }

  getAgent(id = "main") {
    return this.agents.get(id) ?? this.ensureAgent({ id, name: id });
  }

  listAgents() {
    return [...this.agents.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  sessionKey({ channel = "local", from = "user", agentId = "main", sessionId }) {
    return sessionId ?? `${channel}:${from}:${agentId}`;
  }

  getSession(sessionId) {
    return this.sessions.get(sessionId) ?? {
      id: sessionId,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      messages: [],
      metadata: {}
    };
  }

  saveSession(session) {
    this.sessions.set(session.id, {
      ...session,
      updatedAt: nowIso()
    });
  }

  appendMessage(sessionId, message) {
    const session = this.getSession(sessionId);
    session.messages.push(normalizeMessage(message));
    this.saveSession(session);
    return this.getSession(sessionId);
  }

  listSessions({ prefix = "", limit = Infinity } = {}) {
    return [...this.sessions.values()]
      .filter(session => session.id.startsWith(prefix))
      .map((session) => ({
        id: session.id,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        messageCount: session.messages?.length ?? 0,
        lastMessage: session.messages?.at(-1)?.content ?? ""
      }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit);
  }
}

export class FileBackedAgentStore extends InMemoryAgentStore {
  constructor(options = {}) {
    super({ ensureDefault: false });
    this.dir = options.dir ?? path.join(resolveDataDir(), "agent-host");
    this.agentsPath = path.join(this.dir, "agents.json");
    this.sessionsDir = path.join(this.dir, "sessions");
    this.archivesDir = path.join(this.dir, "session-archives");
    this.maxActiveMessages = options.maxActiveMessages ?? 2000;
    this.retainedMessages = options.retainedMessages ?? 1000;
    this.maxSessionBytes = options.maxSessionBytes ?? 16 * 1024 * 1024;
    if (!Number.isSafeInteger(this.maxActiveMessages) || this.maxActiveMessages < 2
      || !Number.isSafeInteger(this.retainedMessages) || this.retainedMessages < 1 || this.retainedMessages >= this.maxActiveMessages
      || !Number.isSafeInteger(this.maxSessionBytes) || this.maxSessionBytes < 1024) throw new Error("Invalid session history limits");
    ensureDir(this.sessionsDir);
    this._migrateLegacyComputerTypeSessions();
    this.load();
    if (options.ensureDefault !== false) this.ensureAgent({ id: "main", name: "Main Agent", role: "root" });
  }

  load() {
    const store = readJsonFile(this.agentsPath, { version: 1, agents: [] });
    this.agents = new Map();
    for (const agent of store.agents ?? []) {
      if (agent.id) this.agents.set(agent.id, agent);
    }
    return this.listAgents();
  }

  saveAgents() {
    writeJsonAtomic(this.agentsPath, {
      version: 1,
      updatedAt: nowIso(),
      agents: this.listAgents()
    });
  }

  ensureAgent(agent) {
    const existing = this.agents.get(agent.id);
    if (existing) return existing;
    const created = normalizeAgent(agent);
    this.agents.set(created.id, created);
    this.saveAgents();
    return created;
  }

  // Overwrite fields on an agent (unlike ensureAgent). Used to apply
  // persona.md to the main agent on every boot. Skips the disk write when
  // nothing actually changed (avoids needless churn on every restart).
  setAgent(id, fields) {
    const before = this.agents.get(id);
    const merged = normalizeAgent({ ...(before ?? { id }), ...fields, id });
    if (before && before.name === merged.name && before.systemPrompt === merged.systemPrompt) return before;
    this.agents.set(id, merged);
    this.saveAgents();
    return merged;
  }

  createAgent(agent = {}) {
    const id = agent.id ?? createId("agent");
    return this.ensureAgent({ ...agent, id });
  }

  getAgent(id = "main") {
    return this.agents.get(id) ?? this.ensureAgent({ id, name: id });
  }

  listAgents() {
    return [...this.agents.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  sessionKey({ channel = "local", from = "user", agentId = "main", sessionId }) {
    return sessionId ?? `${channel}:${from}:${agentId}`;
  }

  sessionPath(sessionId) {
    return path.join(this.sessionsDir, `${safeFilename(sessionId)}.json`);
  }

  getSession(sessionId) {
    const filePath = this.sessionPath(sessionId);
    this.assertSessionSize(filePath);
    const session = readJsonFile(filePath, {
      id: sessionId,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      messages: [],
      metadata: {}
    });
    return sanitizeSessionFile(filePath, session);
  }

  saveSession(session) {
    let persisted = sanitizePersistedSession({
      ...session,
      updatedAt: nowIso()
    }).session;
    // Models already use only the most recent turns. Preserve older messages
    // in immutable owner-only chunks instead of rewriting months of history
    // synchronously on every foreground/background message.
    if (Array.isArray(persisted.messages) && persisted.messages.length > this.maxActiveMessages) {
      const archived = persisted.messages.slice(0, -this.retainedMessages);
      const chunk = { sessionId: session.id, messages: archived };
      const hash = createHash("sha256").update(JSON.stringify(chunk)).digest("hex");
      const archive = path.join(this.archivesDir, `${safeFilename(session.id)}.history`, `${hash}.json`);
      // Archive first: a failed active write leaves the old history intact;
      // replay uses the same content-addressed chunk, not a duplicate archive.
      if (!fs.existsSync(archive)) writeJsonAtomic(archive, chunk);
      persisted = { ...persisted, messages: persisted.messages.slice(-this.retainedMessages),
        metadata: { ...persisted.metadata, archivedMessageCount: (persisted.metadata?.archivedMessageCount ?? 0) + archived.length,
          historyArchived: true } };
    }
    const serialized = `${JSON.stringify(persisted, null, 2)}\n`;
    if (Buffer.byteLength(serialized) > this.maxSessionBytes) {
      throw Object.assign(new Error("Session history exceeds the safe size limit. Preserve an archive before repairing it."), { code: "SESSION_TOO_LARGE" });
    }
    writeTextAtomic(this.sessionPath(session.id), serialized);
  }

  assertSessionSize(filePath) {
    let size;
    try { size = fs.statSync(filePath).size; } catch (error) { if (error.code === "ENOENT") return; throw error; }
    if (size > this.maxSessionBytes) throw Object.assign(new Error("Session history is too large to load safely. It has not been changed; archive and repair it first."), { code: "SESSION_TOO_LARGE" });
  }

  appendMessage(sessionId, message) {
    const session = this.getSession(sessionId);
    session.messages.push({
      ...normalizeMessage(message)
    });
    this.saveSession(session);
    return this.getSession(sessionId);
  }

  listSessions({ prefix = "", limit = Infinity } = {}) {
    const entries = [];
    let candidates = readDirSafe(this.sessionsDir).filter(entry => entry.endsWith(".json") && (!prefix || entry.startsWith(safeFilename(prefix))));
    // Bound active-session reads for scoped history, newest writes first. Do
    // not let filesystem enumeration order hide recently updated conversations.
    if (Number.isFinite(limit)) candidates = candidates.map(entry => ({ entry, modified: fs.statSync(path.join(this.sessionsDir, entry)).mtimeMs }))
      .sort((a, b) => b.modified - a.modified).slice(0, limit).map(item => item.entry);
    for (const entry of candidates) {
      const filePath = path.join(this.sessionsDir, entry);
      try { this.assertSessionSize(filePath); } catch (error) {
        if (error.code !== "SESSION_TOO_LARGE") throw error;
        entries.push({ id: entry.slice(0, -5), recoveryNeeded: true, messageCount: null, createdAt: "", updatedAt: "",
          lastMessage: "History is too large to load safely. The original file is preserved." });
        continue;
      }
      const session = sanitizeSessionFile(filePath, readJsonFile(filePath, null));
      if (session) {
        entries.push({
          id: session.id,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          messageCount: session.messages?.length ?? 0,
          lastMessage: session.messages?.at(-1)?.content ?? ""
        });
      }
    }
    return entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  _migrateLegacyComputerTypeSessions() {
    // Upgrade privacy repair happens at construction, not only when a user
    // happens to open an old chat. Each file is bounded before parsing so one
    // corrupt/hostile transcript cannot multiply startup memory pressure.
    for (const entry of readDirSafe(this.sessionsDir)) {
      if (!entry.endsWith(".json")) continue;
      const filePath = path.join(this.sessionsDir, entry);
      let size;
      try { size = fs.statSync(filePath).size; } catch { continue; }
      if (!Number.isSafeInteger(size) || size < 0 || size > LEGACY_SESSION_MIGRATION_MAX_BYTES) continue;
      sanitizeSessionFile(filePath, readJsonFile(filePath, null));
    }
  }
}

function normalizeAgent(agent) {
  return {
    id: agent.id,
    name: agent.name ?? agent.id,
    role: agent.role ?? "agent",
    parentId: agent.parentId ?? null,
    scope: agent.scope ?? "",
    systemPrompt: agent.systemPrompt ?? "",
    createdAt: agent.createdAt ?? nowIso(),
    updatedAt: nowIso(),
    metadata: agent.metadata ?? {}
  };
}

function normalizeMessage(message) {
  return {
    id: message.id ?? createId("msg"),
    role: message.role,
    content: message.content,
    agentId: message.agentId,
    channel: message.channel,
    from: message.from,
    createdAt: message.createdAt ?? nowIso(),
    metadata: message.metadata ?? {}
  };
}

function readDirSafe(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

// Old releases persisted model tool-call arguments verbatim in chat session
// JSON. That included the text supplied to computer_type. New writes redact
// sensitive arguments in AgentHost, but an upgrade must also remove the raw
// values that are already durable. Keep this migration at the store boundary:
// every transcript load is sanitized and, when necessary, atomically replaced
// before the caller receives it.
function sanitizeSessionFile(filePath, session) {
  if (!session || typeof session !== "object") return session;
  const sanitized = sanitizePersistedSession(session);
  if (sanitized.changed) writeJsonAtomic(filePath, sanitized.session);
  return sanitized.session;
}

function sanitizePersistedSession(session) {
  if (!session || typeof session !== "object" || !Array.isArray(session.messages)) {
    return { session, changed: false };
  }

  let messages = session.messages;
  let changed = false;
  for (let messageIndex = 0; messageIndex < session.messages.length; messageIndex += 1) {
    const message = session.messages[messageIndex];
    const toolCalls = message?.metadata?.toolCalls;
    if (!Array.isArray(toolCalls)) continue;

    let safeToolCalls = toolCalls;
    let messageChanged = false;
    for (let callIndex = 0; callIndex < toolCalls.length; callIndex += 1) {
      const result = sanitizeComputerTypeCall(toolCalls[callIndex]);
      if (!result.changed) continue;
      if (!messageChanged) safeToolCalls = toolCalls.slice();
      safeToolCalls[callIndex] = result.call;
      messageChanged = true;
    }
    if (!messageChanged) continue;

    if (!changed) messages = session.messages.slice();
    messages[messageIndex] = {
      ...message,
      metadata: {
        ...message.metadata,
        toolCalls: safeToolCalls
      }
    };
    changed = true;
  }

  return {
    session: changed ? { ...session, messages } : session,
    changed
  };
}

function sanitizeComputerTypeCall(call) {
  if (!call || typeof call !== "object" || call.name !== "computer_type") {
    return { call, changed: false };
  }

  let safeCall = call;
  let changed = false;
  // `arguments` is the current transcript shape. Accept `args` as well so an
  // older pre-release shape cannot retain the same sensitive value forever.
  for (const key of ["arguments", "args"]) {
    if (!Object.hasOwn(call, key)) continue;
    const result = sanitizeComputerTypeArguments(call[key]);
    if (!result.changed) continue;
    if (!changed) safeCall = { ...call };
    safeCall[key] = result.arguments;
    changed = true;
  }
  return { call: safeCall, changed };
}

function sanitizeComputerTypeArguments(args) {
  if (typeof args === "string") {
    // Some provider-era transcripts stored the JSON argument payload as a
    // string. Bound reparsing so an oversized legacy value cannot multiply
    // memory pressure during startup; a large value is still fully redacted.
    if (Buffer.byteLength(args, "utf8") <= LEGACY_TOOL_ARGUMENT_PARSE_MAX_BYTES) {
      try {
        const parsed = JSON.parse(args);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          // A valid legacy JSON payload can be normalized without losing its
          // non-sensitive fields. If it contains no text, leave the original
          // representation alone rather than treating the whole payload as a
          // typed value.
          return sanitizeComputerTypeArguments(parsed);
        } else if (typeof parsed === "string") {
          return { arguments: { text: redactedText(parsed) }, changed: true };
        }
        return { arguments: args, changed: false };
      } catch {
        // A non-JSON string is conservatively treated as the typed value. Do
        // not include it in an error or warning: migration logs are durable too.
      }
    }
    return { arguments: { text: redactedText(args) }, changed: true };
  }

  if (!args || typeof args !== "object" || Array.isArray(args) || !Object.hasOwn(args, "text")) {
    return { arguments: args, changed: false };
  }

  const text = args.text;
  if (isRedactedText(text)) return { arguments: args, changed: false };
  return {
    arguments: {
      ...args,
      text: typeof text === "string" ? redactedText(text) : { redacted: true }
    },
    changed: true
  };
}

function redactedText(value) {
  let characterCount = 0;
  for (const _character of value) characterCount += 1;
  return {
    redacted: true,
    characterCount,
    byteCount: Buffer.byteLength(value, "utf8")
  };
}

function isRedactedText(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && value.redacted === true);
}
