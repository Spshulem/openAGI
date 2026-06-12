import path from "node:path";
import fs from "node:fs";
import { ensureDir, readJsonFile, safeFilename, writeJsonAtomic } from "./file-utils.js";
import { createId, nowIso } from "./utils.js";
import { resolveDataDir } from "./data-dir.js";

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

  listSessions() {
    return [...this.sessions.values()]
      .map((session) => ({
        id: session.id,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        messageCount: session.messages?.length ?? 0,
        lastMessage: session.messages?.at(-1)?.content ?? ""
      }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
}

export class FileBackedAgentStore extends InMemoryAgentStore {
  constructor(options = {}) {
    super({ ensureDefault: false });
    this.dir = options.dir ?? path.join(resolveDataDir(), "agent-host");
    this.agentsPath = path.join(this.dir, "agents.json");
    this.sessionsDir = path.join(this.dir, "sessions");
    ensureDir(this.sessionsDir);
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
    return readJsonFile(this.sessionPath(sessionId), {
      id: sessionId,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      messages: [],
      metadata: {}
    });
  }

  saveSession(session) {
    writeJsonAtomic(this.sessionPath(session.id), {
      ...session,
      updatedAt: nowIso()
    });
  }

  appendMessage(sessionId, message) {
    const session = this.getSession(sessionId);
    session.messages.push({
      ...normalizeMessage(message)
    });
    this.saveSession(session);
    return session;
  }

  listSessions() {
    const entries = [];
    for (const entry of readDirSafe(this.sessionsDir)) {
      if (!entry.endsWith(".json")) continue;
      const session = readJsonFile(path.join(this.sessionsDir, entry), null);
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
