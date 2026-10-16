import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { readJsonFile, writeJsonAtomic, writeTextAtomic } from "./file-utils.js";
import { nowIso } from "./utils.js";
import { personaPath, applyPersona } from "./persona.js";
import { SHARED_THREADS, sharedSessionId } from "./shared-conversations.js";
import { BUCKETS, QUEUES, STATUSES } from "./task-store.js";

// Offline copy of the Mac agent (spec 2026-10-16 section 3).
//
// Mac:   buildMirrorSnapshot  -> GET /mobile/mirror
//        importOfflineWork    <- POST /mobile/offline-import
// Phone: importMirrorSnapshot <- POST /mirror/import
//        listOfflineWork      -> GET /mirror/offline
//        markOfflineWorkSent  <- POST /mirror/offline/sent
//
// Only additions travel back to the Mac. The phone journals what it imported
// in <dataDir>/mirror/state.json (the baseline); anything on the phone that is
// not in the baseline and not yet marked sent is offline work.

export const MIRROR_VERSION = 1;
export const MIRROR_MAX_BYTES = 5 * 1024 * 1024;
const OFFLINE_ORIGIN = "phone-offline";

const LIMITS = Object.freeze({
  messagesPerThread: 2000,
  memories: 5000,
  tasks: 2000,
  skills: 200,
  messageContent: 64 * 1024,
  memoryContent: 16 * 1024,
  persona: 64 * 1024,
  skillContent: 64 * 1024,
  taskTitle: 2000,
  taskDescription: 20 * 1024,
  shortString: 200,
  isoString: 64,
  tags: 50,
  metadataBytes: 16 * 1024
});
// Offline work is bounded tighter than a snapshot: it is what one phone did
// while the Mac was away, and a longer backlog pages over several sends.
const OFFLINE_LIMITS = Object.freeze({ messagesPerThread: 500, tasks: 500, memories: 2000 });

const MESSAGE_ID = /^[\w-]{1,200}$/; // same as shared-conversations
const ITEM_ID = /^[\w.:-]{1,200}$/;
const NODE_ID = /^[\w.:-]{1,200}$/;
const SKILL_NAME = /^[A-Za-z0-9][\w.-]{0,79}$/;
const MEMORY_TIERS = new Set(["short", "medium", "long"]);
const MESSAGE_ROLES = new Set(["user", "assistant"]);
const TERMINAL_TASK = new Set(["completed", "cancelled"]);
const SECRET_TAGS = new Set(["secret", "secrets", "credential", "credentials", "password", "api-key", "apikey", "token"]);
// Message metadata that is safe and useful to carry. Tool calls, screen
// context, owner authority and turn state never travel: they are large,
// private, or would grant trust on the other device.
const MESSAGE_METADATA_KEYS = ["provider", "model", "status", "code", "sourceNodeId", "sourceName", "thread", "origin", "fromNodeId", "originId"];

export class MirrorError extends Error {
  constructor(code, status, message) {
    super(message);
    this.name = "MirrorError";
    this.code = code;
    this.status = status;
  }
}
const fail = (code, status, message) => new MirrorError(code, status, message);
const bad = (message) => fail("invalid_mirror", 400, message);

// ─── Secrets ───────────────────────────────────────────────────────────────

// Token-shaped strings only. Unlike redactFailureDiagnostic this keeps URLs
// and paths, which are legitimate memory and chat content.
export function redactSecrets(value) {
  return String(value ?? "")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [REDACTED]")
    .replace(/\b(?:sk|sk-ant|sk-proj|rk|pk_live|sk_live|xox[baprs])-[A-Za-z0-9_-]{8,}/g, "[REDACTED]")
    .replace(/\b(?:ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{8,}/g, "[REDACTED]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[REDACTED]")
    .replace(/([?&](?:api[_-]?key|key|token|secret|password|access_token)=)[^&#\s]+/gi, "$1[REDACTED]")
    .replace(/\b([A-Z][A-Z0-9_]*(?:API_KEY|_KEY|_TOKEN|_SECRET|_PASSWORD))\s*[=:]\s*[^\s,;]+/g, "$1=[REDACTED]");
}

function isSecretMemory(item) {
  return (item.tags ?? []).some(tag => SECRET_TAGS.has(String(tag).toLowerCase()));
}

// ─── Small helpers ─────────────────────────────────────────────────────────

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const sha = (text) => createHash("sha256").update(text).digest("hex");
const byteLength = (value) => Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
const clip = (text, max) => (text.length > max ? text.slice(0, max) : text);
const shortOr = (v, max) => (typeof v === "string" && v.length <= max ? v : undefined);
const boundedTags = (tags) => (Array.isArray(tags) ? tags.filter(t => typeof t === "string" && t.length <= LIMITS.shortString).slice(0, LIMITS.tags) : []);
// Oversized metadata is dropped rather than failing the whole snapshot.
const boundedMeta = (meta) => (isPlainObject(meta) && byteLength(meta) <= LIMITS.metadataBytes ? meta : null);

function requireStore(runtime) {
  const store = runtime?.agentHost?.store;
  if (!store?.getSession || !store?.saveSession) throw fail("mirror_unavailable", 503, "Conversation history is not configured.");
  return store;
}

function requireDataDir(dataDir) {
  if (typeof dataDir !== "string" || !dataDir) throw new Error("mirror: dataDir is required");
  return dataDir;
}

function statePath(dataDir) { return path.join(dataDir, "mirror", "state.json"); }
function skillsDir(dataDir) { return path.join(dataDir, "skills"); }

function emptyState() {
  return {
    version: MIRROR_VERSION, importedAt: null, cursor: null,
    baseline: { threadMessageIds: { agent: [], supervisor: [] }, memoryIds: [], taskIds: [] },
    sent: { messageIds: [], memoryIds: [], taskIds: [] },
    skills: [], personaHash: null
  };
}

function readState(dataDir) {
  const raw = readJsonFile(statePath(dataDir), null);
  const base = emptyState();
  if (!isPlainObject(raw)) return base;
  const ids = (v) => (Array.isArray(v) ? v.filter(x => typeof x === "string") : []);
  return {
    ...base,
    importedAt: typeof raw.importedAt === "string" ? raw.importedAt : null,
    cursor: typeof raw.cursor === "string" ? raw.cursor : null,
    baseline: {
      threadMessageIds: Object.fromEntries(SHARED_THREADS.map(t => [t, ids(raw.baseline?.threadMessageIds?.[t])])),
      memoryIds: ids(raw.baseline?.memoryIds),
      taskIds: ids(raw.baseline?.taskIds)
    },
    sent: { messageIds: ids(raw.sent?.messageIds), memoryIds: ids(raw.sent?.memoryIds), taskIds: ids(raw.sent?.taskIds) },
    skills: ids(raw.skills),
    personaHash: typeof raw.personaHash === "string" ? raw.personaHash : null
  };
}

function writeState(dataDir, state) { writeJsonAtomic(statePath(dataDir), state); }

function pickMessageMetadata(metadata) {
  if (!isPlainObject(metadata)) return {};
  const out = {};
  for (const key of MESSAGE_METADATA_KEYS) {
    const v = metadata[key];
    if (typeof v === "string" && v.length <= LIMITS.shortString) out[key] = v;
  }
  return out;
}

function isVisibleMessage(m) {
  return isPlainObject(m) && MESSAGE_ROLES.has(m.role) && typeof m.content === "string" && typeof m.id === "string" && MESSAGE_ID.test(m.id);
}

// Native FileBackedAgentStore message shape with private metadata dropped.
function projectMessage(m) {
  return {
    id: m.id, role: m.role, content: clip(redactSecrets(m.content), LIMITS.messageContent),
    agentId: shortOr(m.agentId, LIMITS.shortString * 2) ?? "main",
    channel: shortOr(m.channel, LIMITS.shortString * 2),
    from: shortOr(m.from, LIMITS.shortString * 2),
    createdAt: shortOr(m.createdAt, LIMITS.isoString) ?? nowIso(),
    metadata: pickMessageMetadata(m.metadata)
  };
}

const MEMORY_STRING_FIELDS = ["rawContentHash", "source", "scope", "kind", "fidelity", "createdAt", "lastAccessedAt", "lastObservedAt", "lastDecayedAt"];
const MEMORY_NUMBER_FIELDS = ["strength", "novelty", "risk", "specificity", "dangerLevel", "repetition"];

// Native MemorySystem item shape, every field type-checked.
function projectMemory(item, { redact = true } = {}) {
  const content = clip(redact ? redactSecrets(item.content) : item.content, LIMITS.memoryContent);
  const out = { id: item.id, tier: item.tier, content, tags: boundedTags(item.tags) };
  for (const key of MEMORY_STRING_FIELDS) { const v = shortOr(item[key], LIMITS.shortString); if (v !== undefined) out[key] = v; }
  for (const key of MEMORY_NUMBER_FIELDS) if (Number.isFinite(item[key])) out[key] = Math.min(1, Math.max(0, item[key]));
  out.locked = item.locked === true;
  out.metadata = boundedMeta(item.metadata) ?? {};
  out.createdAt ??= nowIso();
  out.lastAccessedAt ??= out.createdAt;
  out.lastObservedAt ??= out.createdAt;
  out.lastDecayedAt ??= out.createdAt;
  out.source ??= "runtime";
  out.scope ??= "main";
  out.kind ??= "raw";
  out.strength ??= 0.5;
  return out;
}

const TASK_STRING_FIELDS = ["description", "category", "source", "sourceId", "sourceUrl", "dueDate", "scheduledFor", "parentGoalId", "createdAt", "updatedAt", "completedAt", "completedVia"];

// Native TaskStore task shape. Agent-queue leases are device-local and never
// travel: a lease taken on the Mac must not park the task on the phone.
function projectTask(task) {
  const out = {
    id: task.id, queue: task.queue, title: clip(task.title, LIMITS.taskTitle),
    bucket: BUCKETS.includes(task.bucket) ? task.bucket : "today",
    status: STATUSES.includes(task.status) ? task.status : "pending",
    priority: Number.isFinite(task.priority) ? Math.min(100, Math.max(0, task.priority)) : 50,
    tags: boundedTags(task.tags),
    dependsOn: Array.isArray(task.dependsOn) ? task.dependsOn.filter(t => typeof t === "string" && ITEM_ID.test(t)).slice(0, LIMITS.tags) : []
  };
  for (const key of TASK_STRING_FIELDS) out[key] = shortOr(task[key], 2000) ?? null;
  out.description = clip(redactSecrets(typeof task.description === "string" ? task.description : ""), LIMITS.taskDescription);
  if (isPlainObject(task.sourceMeta)) {
    const { agentLease: _lease, ...rest } = task.sourceMeta;
    out.sourceMeta = boundedMeta(rest);
  } else out.sourceMeta = null;
  out.createdAt ??= nowIso();
  out.updatedAt ??= out.createdAt;
  return out;
}

function allMemories(runtime) {
  return runtime?.memory?.items instanceof Map ? [...runtime.memory.items.values()] : [];
}
function allTasks(runtime) {
  return runtime?.tasks?.tasks instanceof Map ? [...runtime.tasks.tasks.values()] : [];
}
function byCreated(a, b) { return String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")); }

// ─── Mac: snapshot ─────────────────────────────────────────────────────────

function readUserSkills(dataDir) {
  const dir = skillsDir(dataDir), out = [];
  let entries = [];
  try { entries = fs.readdirSync(dir).sort(); } catch { return out; }
  for (const name of entries) {
    if (out.length >= LIMITS.skills) break;
    if (!SKILL_NAME.test(name)) continue;
    const file = path.join(dir, name, "SKILL.md");
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.size > LIMITS.skillContent) continue;
      out.push({ name, content: redactSecrets(fs.readFileSync(file, "utf8")) });
    } catch { /* not a skill */ }
  }
  return out;
}

function readPersonaText(dataDir) {
  try {
    const text = fs.readFileSync(personaPath(dataDir), "utf8");
    return text.trim() ? clip(redactSecrets(text), LIMITS.persona) : null;
  } catch { return null; }
}

function rankMemory(a, b) {
  const tierRank = { long: 0, medium: 1, short: 2 };
  return (b.locked === true) - (a.locked === true)
    || (tierRank[a.tier] ?? 3) - (tierRank[b.tier] ?? 3)
    || (b.strength ?? 0) - (a.strength ?? 0)
    || String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? ""));
}

export function buildMirrorSnapshot(runtime, { dataDir, maxMessages = 500, maxMemories = 2000 } = {}) {
  requireDataDir(dataDir);
  const store = requireStore(runtime);
  let messageCap = Math.max(0, Math.min(Math.floor(maxMessages), LIMITS.messagesPerThread));
  let memoryCap = Math.max(0, Math.min(Math.floor(maxMemories), LIMITS.memories));

  const threadsAll = Object.fromEntries(SHARED_THREADS.map(thread => [
    thread, store.getSession(sharedSessionId(thread)).messages.filter(isVisibleMessage).map(projectMessage)
  ]));
  const memoriesAll = allMemories(runtime)
    .filter(item => typeof item?.id === "string" && ITEM_ID.test(item.id) && MEMORY_TIERS.has(item.tier) && typeof item.content === "string")
    .filter(item => !item.metadata?.supersededBy && !isSecretMemory(item))
    .sort(rankMemory)
    .map(item => projectMemory(item));
  const tasks = allTasks(runtime)
    .filter(task => typeof task?.id === "string" && ITEM_ID.test(task.id) && QUEUES.includes(task.queue) && typeof task.title === "string" && task.title.trim())
    .filter(task => !TERMINAL_TASK.has(task.status))
    .sort(byCreated).slice(-LIMITS.tasks)
    .map(projectTask);
  const persona = readPersonaText(dataDir);
  const skills = readUserSkills(dataDir);

  // Shrink history and memory until the snapshot fits the import cap.
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const body = {
      persona, skills,
      memories: memoriesAll.slice(0, memoryCap),
      tasks,
      threads: Object.fromEntries(SHARED_THREADS.map(t => [t, messageCap ? threadsAll[t].slice(-messageCap) : []]))
    };
    const cursor = sha(JSON.stringify(body)).slice(0, 32);
    const snapshot = { version: MIRROR_VERSION, source: { createdAt: nowIso(), cursor }, ...body };
    if (byteLength(snapshot) <= MIRROR_MAX_BYTES) return snapshot;
    messageCap = Math.floor(messageCap / 2);
    memoryCap = Math.floor(memoryCap / 2);
  }
  throw fail("mirror_too_large", 413, "The mirror snapshot does not fit the size limit.");
}

// ─── Validation ────────────────────────────────────────────────────────────

function checkSize(input) {
  let size;
  try { size = byteLength(input); } catch { throw bad("Input must be JSON."); }
  if (size > MIRROR_MAX_BYTES) throw fail("mirror_too_large", 413, "Input exceeds the 5 MB limit.");
}

function checkKeys(obj, allowed, label) {
  for (const key of Object.keys(obj)) if (!allowed.includes(key)) throw bad(`${label} has an unknown field: ${key.slice(0, 50)}.`);
}

function checkString(value, max, label, { optional = false, nullable = false } = {}) {
  if (value === undefined && optional) return;
  if (value === null && nullable) return;
  if (typeof value !== "string" || value.length > max) throw bad(`${label} must be a string of at most ${max} characters.`);
}

function checkArray(value, max, label) {
  if (!Array.isArray(value)) throw bad(`${label} must be an array.`);
  if (value.length > max) throw fail("mirror_too_large", 413, `${label} has more than ${max} items.`);
}

function checkMetadata(value, label) {
  if (value === undefined || value === null) return;
  if (!isPlainObject(value) || byteLength(value) > LIMITS.metadataBytes) throw bad(`${label} must be an object under 16 KB.`);
}

function checkMessage(m, label) {
  if (!isPlainObject(m)) throw bad(`${label} must be an object.`);
  if (typeof m.id !== "string" || !MESSAGE_ID.test(m.id)) throw bad(`${label}.id is invalid.`);
  if (!MESSAGE_ROLES.has(m.role)) throw bad(`${label}.role must be user or assistant.`);
  checkString(m.content, LIMITS.messageContent, `${label}.content`);
  checkString(m.createdAt, LIMITS.isoString, `${label}.createdAt`, { optional: true });
  for (const key of ["agentId", "channel", "from"]) checkString(m[key], LIMITS.shortString * 2, `${label}.${key}`, { optional: true, nullable: true });
  checkMetadata(m.metadata, `${label}.metadata`);
}

function checkMemory(item, label) {
  if (!isPlainObject(item)) throw bad(`${label} must be an object.`);
  if (typeof item.id !== "string" || !ITEM_ID.test(item.id)) throw bad(`${label}.id is invalid.`);
  if (!MEMORY_TIERS.has(item.tier)) throw bad(`${label}.tier is invalid.`);
  checkString(item.content, LIMITS.memoryContent, `${label}.content`);
  if (item.tags !== undefined) {
    checkArray(item.tags, LIMITS.tags, `${label}.tags`);
    for (const tag of item.tags) checkString(tag, LIMITS.shortString, `${label}.tags[]`);
  }
  for (const key of MEMORY_STRING_FIELDS) checkString(item[key], LIMITS.shortString, `${label}.${key}`, { optional: true, nullable: true });
  for (const key of MEMORY_NUMBER_FIELDS) {
    if (item[key] !== undefined && item[key] !== null && !Number.isFinite(item[key])) throw bad(`${label}.${key} must be a number.`);
  }
  if (item.locked !== undefined && typeof item.locked !== "boolean") throw bad(`${label}.locked must be a boolean.`);
  checkMetadata(item.metadata, `${label}.metadata`);
}

function checkTask(task, label) {
  if (!isPlainObject(task)) throw bad(`${label} must be an object.`);
  if (typeof task.id !== "string" || !ITEM_ID.test(task.id)) throw bad(`${label}.id is invalid.`);
  if (!QUEUES.includes(task.queue)) throw bad(`${label}.queue is invalid.`);
  checkString(task.title, LIMITS.taskTitle, `${label}.title`);
  if (!task.title.trim()) throw bad(`${label}.title is empty.`);
  if (task.status !== undefined && !STATUSES.includes(task.status)) throw bad(`${label}.status is invalid.`);
  if (task.bucket !== undefined && !BUCKETS.includes(task.bucket)) throw bad(`${label}.bucket is invalid.`);
  if (task.priority !== undefined && task.priority !== null && !Number.isFinite(task.priority)) throw bad(`${label}.priority must be a number.`);
  checkString(task.description, LIMITS.taskDescription, `${label}.description`, { optional: true, nullable: true });
  for (const key of TASK_STRING_FIELDS.filter(k => k !== "description")) checkString(task[key], 2000, `${label}.${key}`, { optional: true, nullable: true });
  for (const key of ["tags", "dependsOn"]) {
    if (task[key] === undefined || task[key] === null) continue;
    checkArray(task[key], LIMITS.tags, `${label}.${key}`);
    for (const v of task[key]) checkString(v, LIMITS.shortString, `${label}.${key}[]`);
  }
  checkMetadata(task.sourceMeta, `${label}.sourceMeta`);
}

function checkThreads(threads, perThread, label) {
  if (!isPlainObject(threads)) throw bad(`${label} must be an object.`);
  checkKeys(threads, SHARED_THREADS, label);
  for (const thread of SHARED_THREADS) {
    const list = threads[thread] ?? [];
    checkArray(list, perThread, `${label}.${thread}`);
    list.forEach((m, i) => checkMessage(m, `${label}.${thread}[${i}]`));
  }
}

function checkVersion(input, label) {
  if (!isPlainObject(input)) throw bad(`${label} must be an object.`);
  if (input.version !== MIRROR_VERSION) throw fail("unsupported_version", 400, `Unsupported ${label} version.`);
}

export function validateMirrorSnapshot(snapshot) {
  checkSize(snapshot);
  checkVersion(snapshot, "snapshot");
  checkKeys(snapshot, ["version", "source", "persona", "skills", "memories", "tasks", "threads"], "snapshot");
  if (!isPlainObject(snapshot.source)) throw bad("snapshot.source must be an object.");
  checkKeys(snapshot.source, ["createdAt", "cursor"], "snapshot.source");
  checkString(snapshot.source.createdAt, LIMITS.isoString, "snapshot.source.createdAt");
  checkString(snapshot.source.cursor, 128, "snapshot.source.cursor");
  checkString(snapshot.persona, LIMITS.persona, "snapshot.persona", { nullable: true });
  checkArray(snapshot.skills, LIMITS.skills, "snapshot.skills");
  const names = new Set();
  snapshot.skills.forEach((skill, i) => {
    if (!isPlainObject(skill)) throw bad(`snapshot.skills[${i}] must be an object.`);
    checkKeys(skill, ["name", "content"], `snapshot.skills[${i}]`);
    if (typeof skill.name !== "string" || !SKILL_NAME.test(skill.name)) throw bad(`snapshot.skills[${i}].name is invalid.`);
    if (names.has(skill.name)) throw bad(`snapshot.skills[${i}].name is a duplicate.`);
    names.add(skill.name);
    checkString(skill.content, LIMITS.skillContent, `snapshot.skills[${i}].content`);
  });
  checkArray(snapshot.memories, LIMITS.memories, "snapshot.memories");
  snapshot.memories.forEach((item, i) => checkMemory(item, `snapshot.memories[${i}]`));
  checkArray(snapshot.tasks, LIMITS.tasks, "snapshot.tasks");
  snapshot.tasks.forEach((task, i) => checkTask(task, `snapshot.tasks[${i}]`));
  checkThreads(snapshot.threads, LIMITS.messagesPerThread, "snapshot.threads");
  return snapshot;
}

export function validateOfflineWork(work) {
  checkSize(work);
  checkVersion(work, "offline work");
  checkKeys(work, ["version", "since", "messages", "tasks", "memories", "truncated"], "work");
  checkString(work.since, LIMITS.isoString, "work.since", { optional: true, nullable: true });
  if (work.truncated !== undefined && typeof work.truncated !== "boolean") throw bad("work.truncated must be a boolean.");
  checkThreads(work.messages, OFFLINE_LIMITS.messagesPerThread, "work.messages");
  checkArray(work.tasks, OFFLINE_LIMITS.tasks, "work.tasks");
  work.tasks.forEach((task, i) => checkTask(task, `work.tasks[${i}]`));
  checkArray(work.memories, OFFLINE_LIMITS.memories, "work.memories");
  work.memories.forEach((item, i) => checkMemory(item, `work.memories[${i}]`));
  return work;
}

// ─── Phone: offline journal ────────────────────────────────────────────────

function collectOffline(runtime, state, { limits = null } = {}) {
  const store = requireStore(runtime);
  const sentMessages = new Set(state.sent.messageIds);
  let truncated = false;
  const cap = (list, max) => {
    if (limits && list.length > max) { truncated = true; return list.slice(0, max); }
    return list;
  };
  const messages = {};
  for (const thread of SHARED_THREADS) {
    const baseline = new Set(state.baseline.threadMessageIds[thread]);
    const list = store.getSession(sharedSessionId(thread)).messages
      .filter(m => isVisibleMessage(m) && !baseline.has(m.id) && !sentMessages.has(m.id));
    messages[thread] = cap(list, OFFLINE_LIMITS.messagesPerThread);
  }
  const taskBaseline = new Set(state.baseline.taskIds), taskSent = new Set(state.sent.taskIds);
  const tasks = cap(allTasks(runtime)
    .filter(t => typeof t?.id === "string" && ITEM_ID.test(t.id) && QUEUES.includes(t.queue) && typeof t.title === "string" && t.title.trim())
    .filter(t => !taskBaseline.has(t.id) && !taskSent.has(t.id))
    .sort(byCreated), OFFLINE_LIMITS.tasks);
  const memBaseline = new Set(state.baseline.memoryIds), memSent = new Set(state.sent.memoryIds);
  const memories = cap(allMemories(runtime)
    .filter(m => typeof m?.id === "string" && ITEM_ID.test(m.id) && MEMORY_TIERS.has(m.tier) && typeof m.content === "string")
    .filter(m => !m.metadata?.supersededBy && !memBaseline.has(m.id) && !memSent.has(m.id))
    .sort(byCreated), OFFLINE_LIMITS.memories);
  return { messages, tasks, memories, truncated };
}

// Everything created on the phone since the last import, oldest first. When
// more is pending than one send carries, `truncated` is true; mark this page
// sent and list again for the rest.
export function listOfflineWork(runtime, { dataDir } = {}) {
  requireDataDir(dataDir);
  const state = readState(dataDir);
  const raw = collectOffline(runtime, state, { limits: true });
  const work = {
    version: MIRROR_VERSION,
    since: state.importedAt,
    messages: Object.fromEntries(SHARED_THREADS.map(t => [t, raw.messages[t].map(projectMessage)])),
    tasks: raw.tasks.map(projectTask),
    memories: raw.memories.map(item => projectMemory(item, { redact: false })),
    truncated: raw.truncated
  };
  // Shed the newest items until the page fits what the Mac will accept.
  while (byteLength(work) > MIRROR_MAX_BYTES) {
    const longest = [work.messages.agent, work.messages.supervisor, work.tasks, work.memories].sort((a, b) => b.length - a.length)[0];
    if (!longest.length) break;
    longest.length = Math.floor(longest.length / 2);
    work.truncated = true;
  }
  return work;
}

export function markOfflineWorkSent(runtime, { dataDir, work } = {}) {
  requireDataDir(dataDir);
  validateOfflineWork(work);
  const state = readState(dataDir);
  const sent = { messageIds: new Set(state.sent.messageIds), taskIds: new Set(state.sent.taskIds), memoryIds: new Set(state.sent.memoryIds) };
  const before = sent.messageIds.size + sent.taskIds.size + sent.memoryIds.size;
  for (const thread of SHARED_THREADS) for (const m of work.messages[thread] ?? []) sent.messageIds.add(m.id);
  for (const t of work.tasks) sent.taskIds.add(t.id);
  for (const m of work.memories) sent.memoryIds.add(m.id);
  const next = { ...state, sent: { messageIds: [...sent.messageIds], taskIds: [...sent.taskIds], memoryIds: [...sent.memoryIds] } };
  writeState(dataDir, next);
  return { marked: sent.messageIds.size + sent.taskIds.size + sent.memoryIds.size - before };
}

// ─── Phone: import snapshot ────────────────────────────────────────────────

function writeSkills(dataDir, skills, previousNames) {
  const dir = skillsDir(dataDir);
  const incoming = new Set(skills.map(s => s.name));
  for (const skill of skills) writeTextAtomic(path.join(dir, skill.name, "SKILL.md"), skill.content);
  // Remove only skills an earlier import wrote; phone-made skills stay.
  for (const name of previousNames) {
    if (incoming.has(name) || !SKILL_NAME.test(name)) continue;
    const skillDir = path.join(dir, name);
    try { fs.rmSync(path.join(skillDir, "SKILL.md"), { force: true }); } catch { /* already gone */ }
    try { if (fs.readdirSync(skillDir).length === 0) fs.rmdirSync(skillDir); } catch { /* keep */ }
  }
}

function writePersona(runtime, dataDir, persona, previousHash) {
  const file = personaPath(dataDir);
  if (typeof persona === "string") {
    writeTextAtomic(file, persona);
    applyPersona(runtime, dataDir);
    return sha(persona);
  }
  // The Mac has no persona: drop ours only if an earlier import wrote it.
  let current = null;
  try { current = fs.readFileSync(file, "utf8"); } catch { /* none */ }
  if (current !== null && previousHash && sha(current) === previousHash) {
    fs.rmSync(file, { force: true });
    runtime?.agentHost?.store?.setAgent?.("main", { name: "Main Agent", systemPrompt: "", role: "root" });
  }
  return null;
}

function indexMessages(runtime, sessionId, messages) {
  const index = runtime?.sessionIndex;
  if (!index?.indexMessage) return;
  for (const m of messages) index.indexMessage(sessionId, m.agentId ?? "main", m).catch(() => {});
}

// Replaces the phone's mirrored data with the snapshot. Unsent offline work
// (not in the last baseline, not marked sent) is kept; everything else is
// replaced. Importing the same snapshot twice gives the same result.
export function importMirrorSnapshot(runtime, snapshot, { dataDir } = {}) {
  requireDataDir(dataDir);
  validateMirrorSnapshot(snapshot);
  const store = requireStore(runtime);
  const state = readState(dataDir);
  const offline = collectOffline(runtime, state);
  const importedAt = nowIso();

  // Threads: snapshot history, then this phone's unsent messages.
  const threadMessageIds = {};
  for (const thread of SHARED_THREADS) {
    const sessionId = sharedSessionId(thread);
    const incoming = snapshot.threads[thread] ?? [];
    const ids = new Set(incoming.map(m => m.id));
    const kept = offline.messages[thread].filter(m => !ids.has(m.id));
    const mirrored = incoming.map(m => ({ ...projectMessage(m), content: m.content }));
    const session = store.getSession(sessionId);
    store.saveSession({
      ...session,
      messages: [...mirrored, ...kept],
      metadata: { ...(session.metadata ?? {}), historyArchived: false, archivedMessageCount: 0, mirror: { cursor: snapshot.source.cursor, importedAt } }
    });
    indexMessages(runtime, sessionId, mirrored);
    threadMessageIds[thread] = [...ids];
  }

  // Memories.
  const memory = runtime?.memory;
  const memoryIds = snapshot.memories.map(m => m.id);
  let keptMemories = 0;
  if (memory?.items instanceof Map) {
    const keep = new Map(offline.memories.map(m => [m.id, m]));
    const incoming = new Set(memoryIds);
    for (const id of [...memory.items.keys()]) {
      if (incoming.has(id) || keep.has(id)) continue;
      memory.items.delete(id);
      memory.dropPrincipleVector?.(id);
    }
    for (const item of snapshot.memories) memory.items.set(item.id, projectMemory(item, { redact: false }));
    keptMemories = [...keep.keys()].filter(id => !incoming.has(id)).length;
    if (typeof memory.persist === "function") memory.persist("mirror-import", { cursor: snapshot.source.cursor, imported: memoryIds.length, kept: keptMemories });
    runtime.reconcilePrincipleVectors?.();
  }

  // Open tasks.
  const tasksStore = runtime?.tasks;
  const taskIds = snapshot.tasks.map(t => t.id);
  let keptTasks = 0;
  if (tasksStore?.tasks instanceof Map) {
    const keep = new Set(offline.tasks.map(t => t.id));
    const incoming = new Set(taskIds);
    for (const id of [...tasksStore.tasks.keys()]) if (!incoming.has(id) && !keep.has(id)) tasksStore.tasks.delete(id);
    for (const task of snapshot.tasks) tasksStore.tasks.set(task.id, projectTask(task));
    keptTasks = [...keep].filter(id => !incoming.has(id)).length;
    tasksStore.snapshot?.();
  }

  const personaHash = writePersona(runtime, dataDir, snapshot.persona, state.personaHash);
  writeSkills(dataDir, snapshot.skills, state.skills);
  runtime?.skills?.reload?.();

  writeState(dataDir, {
    version: MIRROR_VERSION, importedAt, cursor: snapshot.source.cursor,
    baseline: { threadMessageIds, memoryIds, taskIds },
    // Sent items not in this snapshot were just replaced; nothing left to track.
    sent: { messageIds: [], memoryIds: [], taskIds: [] },
    skills: snapshot.skills.map(s => s.name),
    personaHash
  });

  return {
    cursor: snapshot.source.cursor, importedAt,
    threads: Object.fromEntries(SHARED_THREADS.map(t => [t, threadMessageIds[t].length])),
    memories: memoryIds.length, tasks: taskIds.length, skills: snapshot.skills.length, persona: snapshot.persona !== null,
    kept: {
      messages: SHARED_THREADS.reduce((n, t) => n + offline.messages[t].filter(m => !threadMessageIds[t].includes(m.id)).length, 0),
      tasks: keptTasks, memories: keptMemories
    }
  };
}

// ─── Mac: import offline work ──────────────────────────────────────────────

function existingMessageIds(store, sessionId) {
  const session = store.getSession(sessionId);
  const ids = new Set(session.messages.map(m => m?.id).filter(Boolean));
  if (session.metadata?.historyArchived === true && typeof store.archivedMessages === "function") {
    for (const m of store.archivedMessages(sessionId)) if (m?.id) ids.add(m.id);
  }
  return ids;
}

// Appends what the phone did offline. Never edits or deletes an existing
// item; a retried send is a no-op because every item is deduped by its id or
// the origin id stored with the copy.
export function importOfflineWork(runtime, work, { dataDir, fromNodeId } = {}) {
  requireDataDir(dataDir);
  if (typeof fromNodeId !== "string" || !NODE_ID.test(fromNodeId)) throw bad("fromNodeId is required.");
  validateOfflineWork(work);
  const store = requireStore(runtime);
  const origin = { origin: OFFLINE_ORIGIN, fromNodeId };
  const result = { added: { messages: 0, tasks: 0, memories: 0 }, skipped: { messages: 0, tasks: 0, memories: 0 } };

  for (const thread of SHARED_THREADS) {
    const sessionId = sharedSessionId(thread);
    const seen = existingMessageIds(store, sessionId);
    const appended = [];
    for (const m of [...(work.messages[thread] ?? [])].sort(byCreated)) {
      if (seen.has(m.id)) { result.skipped.messages += 1; continue; }
      seen.add(m.id);
      const message = {
        id: m.id, role: m.role, content: m.content, agentId: "main", channel: "node",
        from: m.role === "user" ? `node:${fromNodeId}:offline` : "openagi",
        createdAt: typeof m.createdAt === "string" ? m.createdAt : nowIso(),
        metadata: { ...origin, thread, ...(m.role === "user" ? { sourceNodeId: fromNodeId } : {}) }
      };
      store.appendMessage(sessionId, message);
      appended.push(message);
      result.added.messages += 1;
    }
    indexMessages(runtime, sessionId, appended);
  }

  const tasks = runtime?.tasks;
  if (work.tasks.length && typeof tasks?.add !== "function") throw fail("mirror_unavailable", 503, "Tasks are not configured.");
  for (const task of work.tasks) {
    const known = tasks.get(task.id) || allTasks(runtime).some(t => t?.sourceMeta?.originId === task.id);
    if (known) { result.skipped.tasks += 1; continue; }
    const { agentLease: _lease, ...meta } = isPlainObject(task.sourceMeta) ? task.sourceMeta : {};
    const status = task.status === "blocked" || task.status === "in_progress" ? "pending" : task.status;
    const created = tasks.add({
      title: task.title, description: task.description ?? "",
      bucket: task.bucket === "done" ? undefined : task.bucket,
      priority: task.priority ?? 50, category: task.category ?? null, tags: task.tags ?? [],
      sourceId: task.sourceId ?? null, sourceUrl: task.sourceUrl ?? null,
      sourceMeta: { ...meta, ...origin, originId: task.id },
      status: TERMINAL_TASK.has(status) ? "pending" : status,
      dueDate: task.dueDate ?? null, scheduledFor: task.scheduledFor ?? null,
      parentGoalId: task.parentGoalId && tasks.getGoal?.(task.parentGoalId) ? task.parentGoalId : null
    }, { source: typeof task.source === "string" ? task.source : "manual", queue: task.queue });
    if (status === "completed") tasks.complete(created.id, OFFLINE_ORIGIN);
    else if (status === "cancelled") tasks.update(created.id, { status: "cancelled" });
    result.added.tasks += 1;
  }

  const memory = runtime?.memory;
  if (work.memories.length && typeof memory?.remember !== "function") throw fail("mirror_unavailable", 503, "Memory is not configured.");
  for (const item of work.memories) {
    const known = memory.items?.has?.(item.id) || allMemories(runtime).some(m =>
      m?.metadata?.originId === item.id || (item.rawContentHash && m?.rawContentHash === item.rawContentHash && !m?.metadata?.supersededBy));
    if (known) { result.skipped.memories += 1; continue; }
    const { supersededBy: _s, ...meta } = isPlainObject(item.metadata) ? item.metadata : {};
    memory.remember({
      content: item.content, tags: item.tags ?? [], source: item.source ?? "runtime", scope: item.scope ?? "main", kind: item.kind ?? "raw",
      risk: item.risk, novelty: item.novelty, specificity: item.specificity, repetition: item.repetition, locked: item.locked === true
    }, { id: item.id, tier: item.tier, now: item.createdAt, metadata: { ...meta, ...origin, originId: item.id } });
    result.added.memories += 1;
  }

  return result;
}
