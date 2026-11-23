// Antigravity conversations (Google's agent app), read-only. Its language
// server keeps one summary row per conversation in conversation_summaries.db
// and each conversation's steps, as protobuf blobs, in conversations/<id>.db.
// Both are SQLite in WAL mode and the owner's live work. Closed databases
// are immutable reads; open ones are copied into a private temporary folder
// and opened read-only there, then removed. No app files are written. The
// loopback API adds quota reset times; its csrf token is never stored.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { classifyErrorText } from "../errors.js";
import {
  ANTIGRAVITY_LS, SUPERVISOR_PREFIX, antigravityOpenChat, clampTail, clampTailLines, clampText, isSupervisorOwnPrompt, openImmutableDb, openReadOnlyDb,
  redactSecrets, runCommand, threadKey, toIso
} from "../contracts.js";

// Step types and statuses (the server's CortexStepType and CortexStepStatus).
const STEP = Object.freeze({ USER_INPUT: 14, PLANNER_RESPONSE: 15, ERROR_MESSAGE: 17, SYSTEM_MESSAGE: 101 });
const STEP_WAITING = 9;
// PENDING, RUNNING, GENERATING, QUEUED: the step is still being worked on.
const STEP_ACTIVE = new Set([1, 2, 8, 11]);
const RUN_BUSY = new Set(["RUNNING", "BUSY", "CANCELING"]);
const LIMIT_KINDS = new Set(["session-limit", "usage-limit"]);
// The newest steps read per conversation. Tool steps sit between replies,
// so this reaches the last reply, the last owner message and any error.
const TAIL_STEPS = 80;
// A step can hold a whole tool output; the fields read come first.
const PAYLOAD_MAX = 256 * 1024;
const STEPS_SQL = `SELECT idx, step_type, status, substr(step_payload, 1, ${PAYLOAD_MAX}) AS payload FROM steps ORDER BY idx DESC LIMIT ?`;
// conversation file -> { stamp, summary }: steps are decoded again only
// when the conversation's summary row moved.
const stepCache = new Map();
const STEP_CACHE_MAX = 300;
// language server pid -> its plain-HTTP (Connect RPC) port.
const lsPorts = new Map();
const LS_TIMEOUT_MS = 5_000;
const HEALTH_TIMEOUT_MS = 2_000;

// ---------- protobuf wire format (only the fields read below) ----------

function readVarint(buf, at) {
  let value = 0;
  let scale = 1;
  for (let i = 0; i < 10; i += 1) {
    if (at >= buf.length) return null;
    const byte = buf[at];
    at += 1;
    value += (byte & 0x7f) * scale;
    scale *= 128;
    if (byte < 0x80) return [value, at];
  }
  return null;
}

// One message's top-level fields: number -> values (varints as numbers,
// length-delimited ones as bytes). A cut-off or malformed buffer stops the
// read and keeps what came before it.
export function protoFields(buf) {
  const out = new Map();
  if (!buf?.length) return out;
  let at = 0;
  while (at < buf.length) {
    const key = readVarint(buf, at);
    if (!key) break;
    at = key[1];
    const field = Math.floor(key[0] / 8);
    const wire = key[0] % 8;
    if (!field) break;
    let value = null;
    if (wire === 0) {
      const read = readVarint(buf, at);
      if (!read) break;
      [value, at] = read;
    } else if (wire === 1) at += 8;
    else if (wire === 5) at += 4;
    else if (wire === 2) {
      const length = readVarint(buf, at);
      if (!length || length[1] + length[0] > buf.length) break;
      value = buf.subarray(length[1], length[1] + length[0]);
      at = length[1] + length[0];
    } else break;
    if (at > buf.length) break;
    if (!out.has(field)) out.set(field, []);
    out.get(field).push(value);
  }
  return out;
}

const first = (fields, number) => fields.get(number)?.[0];
const asText = (value) => (value && typeof value !== "number" ? Buffer.from(value).toString("utf8") : "");

function nested(fields, ...numbers) {
  let current = fields;
  for (const number of numbers) {
    const value = first(current, number);
    if (!value || typeof value === "number") return new Map();
    current = protoFields(value);
  }
  return current;
}

// A google.protobuf.Timestamp: 1 seconds, 2 nanos.
function timestampOf(fields) {
  const seconds = first(fields, 1);
  if (typeof seconds !== "number" || seconds <= 0) return null;
  return toIso(seconds * 1000 + Math.floor((first(fields, 2) ?? 0) / 1e6));
}

// The parts of one step the supervisor reads: f1 type, f4 status, f5
// metadata (f5.1 created), f19 user input (19.2 text), f20 planner response
// (20.1 response, 20.8 modified response), f24 error message (24.3: 1 the
// message shown, 2 short error, 5 details JSON), f114 system message (114.1).
export function decodeStep(row) {
  const fields = protoFields(row.payload ?? row.step_payload);
  const type = first(fields, 1) ?? row.step_type ?? null;
  const status = first(fields, 4) ?? row.status ?? null;
  const at = timestampOf(nested(fields, 5, 1));
  const step = { idx: row.idx ?? null, type, status, at, text: "" };
  if (type === STEP.USER_INPUT) step.text = asText(first(nested(fields, 19), 2)).trim();
  else if (type === STEP.PLANNER_RESPONSE) {
    const planner = nested(fields, 20);
    step.text = (asText(first(planner, 8)) || asText(first(planner, 1))).trim();
  } else if (type === STEP.SYSTEM_MESSAGE) step.text = asText(first(nested(fields, 114), 1)).trim();
  else if (type === STEP.ERROR_MESSAGE) {
    const error = nested(fields, 24, 3);
    const shown = asText(first(error, 1)).trim();
    const short = asText(first(error, 2)).trim();
    const details = asText(first(error, 5)).trim();
    const code = first(error, 7);
    step.text = shown || short || (typeof code === "number" ? `error ${code}` : "error");
    step.error = { text: step.text, detail: [short, details].filter(Boolean).join("\n"), model: /"model"\s*:\s*"([^"]+)"/.exec(details)?.[1] ?? null };
  }
  return step;
}

// A message agentapi send-message delivered ("[Message] timestamp=...
// sender=system ... content=<text>"): the supervisor's own when the text
// starts with its prefix.
function isSupervisorMessage(text) {
  return /\bsender=system\b/.test(text) && text.includes(`content=${SUPERVISOR_PREFIX}`);
}

// Newest step first. An error stands only while no later owner message,
// agent reply or delivered message moved the conversation on.
export function summarizeSteps(rows) {
  const summary = {
    lastAgentText: "", lastAgentAt: null, lastUserText: "", lastUserAt: null, lastSupervisorAt: null,
    lastStepAt: null, error: null, waiting: false, active: false
  };
  let moved = false;
  for (const [index, row] of rows.entries()) {
    let step;
    try { step = decodeStep(row); } catch { continue; }
    if (index === 0) {
      summary.lastStepAt = step.at;
      summary.active = STEP_ACTIVE.has(step.status);
    }
    // A tool step waiting for the owner's approval comes after the reply that asked for it.
    if (step.status === STEP_WAITING && !moved) summary.waiting = true;
    if (step.type === STEP.USER_INPUT) {
      if (!summary.lastUserAt && step.text) {
        summary.lastUserText = step.text;
        summary.lastUserAt = step.at;
      }
      moved = true;
    } else if (step.type === STEP.PLANNER_RESPONSE) {
      if (!summary.lastAgentText && step.text) {
        summary.lastAgentText = step.text;
        summary.lastAgentAt = step.at;
      }
      moved = true;
    } else if (step.type === STEP.SYSTEM_MESSAGE) {
      if (isSupervisorMessage(step.text)) {
        if (!summary.lastSupervisorAt) summary.lastSupervisorAt = step.at;
        moved = true;
      }
    } else if (step.type === STEP.ERROR_MESSAGE && !moved && !summary.error && step.error) {
      summary.error = { ...step.error, at: step.at };
    }
  }
  return summary;
}

// ---------- SQLite ----------

// Copy an open WAL database before reading: SQLite never touches the app's
// side files, even if the app closes them during the read. A changing copy
// fails closed; an immutable fallback would miss the newest WAL rows.
export async function readAntigravityDb(file, read, { open = openReadOnlyDb, immutable = openImmutableDb, copy = fs.copyFileSync } = {}) {
  const wal = `${file}-wal`;
  let dir = null;
  let db = null;
  try {
    if (fs.existsSync(wal)) {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-ag-read-"));
      const snapshot = path.join(dir, "snapshot.db");
      const files = [file, wal];
      if (fs.existsSync(`${file}-shm`)) files.push(`${file}-shm`);
      const before = files.map((name) => fs.statSync(name));
      files.forEach((name, index) => copy(name, `${snapshot}${["", "-wal", "-shm"][index]}`));
      // The shared-memory reader marks can change without changing the data.
      for (const index of [0, 1]) {
        const after = fs.statSync(files[index]);
        if (after.ino !== before[index].ino || after.size !== before[index].size || after.mtimeMs !== before[index].mtimeMs) throw new Error("Antigravity database changed during snapshot");
      }
      db = await open(snapshot);
    } else db = await immutable(file);
    if (!db) throw new Error("Antigravity database unavailable");
    return { value: read(db) };
  } finally {
    try { db?.close(); } catch { /* ignore */ }
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
}

// "2026-10-14 14:50:09.778434+00:00"; Go's zero time ("0001-01-01 ...") is none.
function dbTime(value) {
  const text = String(value ?? "").trim();
  if (!text || text.startsWith("0001-")) return null;
  const iso = toIso(text.replace(" ", "T"));
  return iso && Date.parse(iso) > Date.UTC(2000, 0, 1) ? iso : null;
}

const truthy = (value) => value === true || value === 1 || value === "1" || value === "true";

function workspaceDir(value) {
  let uris = [];
  try { uris = JSON.parse(String(value ?? "")); } catch { return null; }
  const uri = Array.isArray(uris) ? uris.find((entry) => typeof entry === "string" && entry.startsWith("file://")) : null;
  if (!uri) return null;
  try { return fileURLToPath(uri); } catch { return null; }
}

async function readSteps(file, stamp, { fresh = false, readDatabase = readAntigravityDb } = {}) {
  const cached = stepCache.get(file);
  if (!fresh && cached && cached.stamp === stamp) return cached.summary;
  if (!fs.existsSync(file)) {
    if (fresh) throw new Error("Antigravity steps unavailable");
    return summarizeSteps([]);
  }
  const read = await readDatabase(file, (db) => db.prepare(STEPS_SQL).all(TAIL_STEPS));
  if (!read) throw new Error("Antigravity steps unavailable");
  const summary = summarizeSteps(read?.value ?? []);
  if (stepCache.size >= STEP_CACHE_MAX) stepCache.delete(stepCache.keys().next().value);
  stepCache.set(file, { stamp, summary });
  return summary;
}

// The run's status without its enum prefix: "RUNNING", "IDLE", ...
export function runStatusOf(value) {
  return String(value ?? "").replace(/^CASCADE_RUN_STATUS_/, "");
}

// A busy run (or an active newest step) with no step for the silent window.
// It is stalled only when no language server runs: a live server may be on
// one long tool step, or on a subagent whose steps go to its own database.
function silentBusy(row, steps, lastActivityAt, now, limits) {
  if (!RUN_BUSY.has(runStatusOf(row.status)) && !steps.active) return false;
  return now - (Date.parse(lastActivityAt ?? "") || 0) >= limits.silentTurnMs;
}

// Even when the language server stays running, a busy run or not_fully_idle
// conversation with zero new steps past liveServerStallMs (default 2h) is
// wedged (e.g. a 15-16h hung Antigravity subagent or background command).
function liveServerStalled(row, steps, lastActivityAt, now, limits) {
  if (truthy(row.killed) || steps.waiting) return false;
  if (!RUN_BUSY.has(runStatusOf(row.status)) && !steps.active && !truthy(row.not_fully_idle)) return false;
  const threshold = limits.liveServerStallMs ?? 2 * 60 * 60_000;
  return now - (Date.parse(lastActivityAt ?? "") || 0) >= threshold;
}

function statusOf(row, steps, lastActivityAt, now, limits, serverAlive) {
  if (truthy(row.killed)) return "aborted";
  if (steps.waiting) return "waiting";
  if (liveServerStalled(row, steps, lastActivityAt, now, limits)) return "stalled";
  if (RUN_BUSY.has(runStatusOf(row.status)) || steps.active) {
    // A server that died mid-run leaves its row busy.
    return !serverAlive && silentBusy(row, steps, lastActivityAt, now, limits) ? "stalled" : "running";
  }
  // not_fully_idle on an idle run: background commands or subagents still
  // run after the reply (the app shows a spinner and "Stop execution").
  if (truthy(row.not_fully_idle)) return "waiting";
  if (steps.error) return "error";
  return runStatusOf(row.status) === "IDLE" ? "idle" : "unknown";
}

function threadErrorOf(stepError, fallbackAt, now, excerptMax) {
  if (!stepError) return null;
  // "Resets in 37m19s" counts from when the error was written, not from now.
  const at = Date.parse(stepError.at ?? fallbackAt ?? "");
  const classified = classifyErrorText(`${stepError.text}\n${stepError.detail ?? ""}`, new Date(Number.isFinite(at) ? at : now))
    ?? { kind: "other", resetAt: null };
  return { kind: classified.kind, text: clampText(redactSecrets(stepError.text), excerptMax), resetAt: classified.resetAt };
}

const lastActivityOf = (row, steps) => [dbTime(row.last_modified_time), steps.lastStepAt].filter(Boolean).sort().at(-1) ?? null;

function buildThread(row, steps, { config, now, serverAlive }) {
  const { limits } = config;
  const id = String(row.conversation_id);
  const cwd = workspaceDir(row.workspace_uris);
  const lastActivityAt = lastActivityOf(row, steps);
  const agentStatus = statusOf(row, steps, lastActivityAt, now, limits, serverAlive);
  const error = agentStatus === "error" ? threadErrorOf(steps.error, lastActivityAt, now, limits.excerptMax) : null;
  const lastUserAt = dbTime(row.last_user_input_time) ?? steps.lastUserAt;
  const title = String(row.title ?? "").trim() || path.basename(cwd ?? "") || "Antigravity conversation";
  const self = (config.selfSessionIds ?? []).includes(id) || isSupervisorOwnPrompt(steps.lastUserText);
  const thread = {
    key: threadKey("antigravity", id),
    kind: "antigravity",
    id,
    title: clampText(redactSecrets(title), limits.titleMax),
    cwd,
    // The supervisor reads the repo and branch from the workspace's git.
    repo: null,
    branch: null,
    workspace: null,
    claudeSessionId: null,
    agentStatus,
    lastActivityAt,
    lastAgentText: clampTail(redactSecrets(steps.lastAgentText), limits.excerptMax),
    lastAgentTail: clampTail(redactSecrets(steps.lastAgentText), limits.reviewTailMax),
    lastAgentFull: clampTailLines(redactSecrets(steps.lastAgentText), limits.fullTextMax),
    lastAgentFullAt: steps.lastAgentAt,
    lastAgentAt: steps.lastAgentAt,
    lastUserText: clampText(redactSecrets(steps.lastUserText), limits.excerptMax),
    lastUserAt,
    error,
    openTasks: [],
    prRefs: [],
    // Antigravity has no peer to relay to; the app itself takes messages.
    live: null,
    writerLocked: false,
    archived: false,
    excluded: self ? "self" : !cwd ? "no-repo" : null,
    meta: {
      app: "antigravity",
      model: steps.error?.model ?? null,
      file: null,
      turnStartedAt: lastUserAt,
      abortReason: agentStatus === "aborted" ? "aborted by user" : null,
      abortedAt: agentStatus === "aborted" ? lastActivityAt : null,
      lastSupervisorAt: steps.lastSupervisorAt,
      // A tool step waits for the owner's approval in the app (background
      // work is "waiting" too, but on nothing the owner holds).
      blockedOnOwner: agentStatus === "waiting" && steps.waiting,
      runStatus: String(row.status ?? "") || null,
      notFullyIdle: truthy(row.not_fully_idle),
      ...(liveServerStalled(row, steps, lastActivityAt, now, limits) ? { silentStuck: true } : {}),
      projectId: String(row.project_id ?? "") || null,
      stepCount: Number(row.step_count) || 0,
      openChat: null,
      resetFrom: error?.resetAt ? "error" : null
    }
  };
  thread.meta.openChat = antigravityOpenChat(thread);
  return thread;
}

// ---------- the running language server ----------

// The running Antigravity language server: { pid, address } with the csrf
// token as a non-enumerable property, so logging or JSON never shows it.
// null when the app is not running or its RPC port does not answer.
export async function findLanguageServer(config, { run = runCommand, fetchImpl = globalThis.fetch } = {}) {
  const binary = config?.bins?.antigravityLs ?? ANTIGRAVITY_LS;
  let ps;
  try { ps = await run(config?.bins?.ps ?? "ps", ["-axww", "-o", "pid=,command="], { timeoutMs: 10_000 }); } catch { return null; }
  if (!ps || ps.code !== 0) return null;
  let found = null;
  for (const line of String(ps.stdout ?? "").split("\n")) {
    const match = /^\s*(\d+)\s+(\S+)(.*)$/.exec(line);
    if (!match || match[2] !== binary) continue;
    const token = /\s--csrf_token[= ](\S+)/.exec(match[3])?.[1];
    if (token) { found = { pid: Number(match[1]), token }; break; }
  }
  if (!found) return null;
  const known = lsPorts.get(found.pid);
  const ports = known && await healthy(known, fetchImpl) ? [known] : await listeningPorts(config, found.pid, run, fetchImpl);
  if (!ports.length) return null;
  lsPorts.set(found.pid, ports[0]);
  const server = { pid: found.pid, address: `127.0.0.1:${ports[0]}` };
  Object.defineProperty(server, "csrfToken", { value: found.token, enumerable: false });
  return server;
}

// The server listens on two loopback ports: HTTPS for the app's UI and plain
// HTTP for RPC. Only the RPC port answers GET /healthz over http with 200.
async function listeningPorts(config, pid, run, fetchImpl) {
  let result;
  try { result = await run(config?.bins?.lsof ?? "lsof", ["-nP", "-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN", "-Fn"], { timeoutMs: 10_000 }); } catch { return []; }
  const ports = [...new Set(String(result?.stdout ?? "").split("\n")
    .map((line) => /^n(?:127\.0\.0\.1|\[::1\]|localhost):(\d+)$/.exec(line.trim())?.[1]).filter(Boolean).map(Number))];
  for (const port of ports) if (await healthy(port, fetchImpl)) return [port];
  return [];
}

async function healthy(port, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/healthz`, { signal: controller.signal });
    return response?.status === 200;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function callLanguageServer(server, method, body = {}, { fetchImpl = globalThis.fetch, timeoutMs = LS_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`http://${server.address}/exa.language_server_pb.LanguageServerService/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-codeium-csrf-token": server.csrfToken },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    if (!response?.ok) throw new Error(`Antigravity ${method}: HTTP ${response?.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

// "Gemini 4 Argon (High)" -> "gemini"; the error's "gemini-4-argon-high" too.
// Quota is shared per family (all Gemini models, all Claude models).
function quotaFamily(name) {
  return String(name ?? "").trim().toLowerCase().split(/[\s-]+/)[0] || null;
}

// GetUserStatus: each model's remaining fraction (proto3 omits 0, so missing
// means none left) and when its window resets. null when unreadable.
export async function readQuota(server, { fetchImpl = globalThis.fetch } = {}) {
  const body = await callLanguageServer(server, "GetUserStatus", {}, { fetchImpl });
  const configs = body?.userStatus?.cascadeModelConfigData?.clientModelConfigs;
  if (!Array.isArray(configs)) return null;
  return configs.filter((entry) => entry?.label && entry.quotaInfo).map((entry) => {
    const fraction = Number(entry.quotaInfo.remainingFraction);
    return {
      label: String(entry.label),
      family: quotaFamily(entry.label),
      remaining: Number.isFinite(fraction) ? fraction : 0,
      resetAt: toIso(entry.quotaInfo.resetTime)
    };
  });
}

// The limit's reset as the quota shows it now: the error's own time when the
// model's family has quota again (the reset has passed), else the family's
// window reset. The reset time means something only while quota is used up.
// An exact reset in the error (quotaResetTimeStamp) is never moved earlier:
// the error and the quota can count different windows, so a family that
// shows quota left may still be over the limit that stopped this run.
// null when the quota cannot tell, or tells nothing past the error's own.
export function quotaResetFor(thread, quota) {
  const error = thread?.error;
  if (!error || !LIMIT_KINDS.has(error.kind) || !Array.isArray(quota) || !quota.length) return null;
  const family = quotaFamily(thread.meta?.model);
  const pool = family ? quota.filter((entry) => entry.family === family) : quota;
  if (!pool.length) return null;
  const spent = pool.filter((entry) => !(entry.remaining > 0));
  let resetAt = null;
  if (!spent.length) resetAt = thread.lastActivityAt ?? null;
  else if (family) resetAt = spent.map((entry) => entry.resetAt).filter((at) => Number.isFinite(Date.parse(at ?? ""))).sort().at(-1) ?? null;
  const exact = Date.parse(error.resetAt ?? "");
  if (!resetAt || (Number.isFinite(exact) && !(Date.parse(resetAt) > exact))) return null;
  return resetAt;
}

// The running language server, looked up at most once per listing and only
// when something needs it. null when none runs or the lookup fails.
function serverLookup(options, config) {
  let found;
  return async () => {
    if (options.languageServer !== undefined) return options.languageServer;
    found ??= findLanguageServer(config, { run: options.run ?? runCommand, fetchImpl: options.fetchImpl ?? globalThis.fetch }).catch(() => null);
    return found;
  };
}

async function applyQuota(threads, options, server) {
  const limited = threads.filter((thread) => LIMIT_KINDS.has(thread.error?.kind));
  if (!limited.length) return;
  const { fetchImpl = globalThis.fetch } = options;
  let quota = null;
  try {
    const found = await server();
    if (found) quota = await readQuota(found, { fetchImpl });
  } catch {
    // No quota read: the error's own reset time stands.
  }
  if (!quota) return;
  for (const thread of limited) {
    const resetAt = quotaResetFor(thread, quota);
    if (!resetAt) continue;
    thread.error = { ...thread.error, resetAt };
    thread.meta.resetFrom = "quota";
  }
}

// ---------- the source ----------

export async function listAntigravityThreads(config, options = {}) {
  const home = config?.paths?.antigravityHome;
  if (!home || config?.antigravity?.enabled === false) return [];
  const file = path.join(home, "conversation_summaries.db");
  // No Antigravity install is an empty list. An unreadable database throws,
  // so the supervisor records a source error instead of seeing zero threads.
  if (!fs.existsSync(file)) return [];
  const read = await readAntigravityDb(file, (db) => db.prepare("SELECT * FROM conversation_summaries").all());
  if (!read) throw new Error("Antigravity database unavailable");
  const { now = Date.now() } = options;
  const cutoff = now - config.lookbackHours * 3_600_000;
  // options.only: just these conversations (a send-time re-read), whatever their age.
  const only = Array.isArray(options.only) ? new Set(options.only.map(String)) : null;
  const rows = read.value
    .filter((row) => row?.conversation_id)
    // Subagents (research, self) run under a parent conversation and are
    // reached through it, like Claude sidechains.
    .filter((row) => !(Number(row.nesting_depth) > 0) && !String(row.parent_conversation_id ?? ""))
    .map((row) => ({ row, at: Date.parse(dbTime(row.last_modified_time) ?? "") || 0 }))
    .filter((entry) => (only ? only.has(String(entry.row.conversation_id)) : entry.at >= cutoff))
    .sort((a, b) => b.at - a.at || String(a.row.conversation_id).localeCompare(String(b.row.conversation_id)));
  const entries = [];
  let inScope = 0;
  let excluded = 0;
  for (const { row } of rows) {
    if (inScope >= config.limits.maxThreads) break;
    const id = String(row.conversation_id);
    if (!workspaceDir(row.workspace_uris) && excluded >= config.limits.maxThreads) continue;
    // A conversation whose steps cannot be read still shows, from its summary row.
    let steps;
    try {
      steps = await readSteps(path.join(home, "conversations", `${id}.db`), `${row.last_modified_time}|${row.step_count}|${row.status}|${row.not_fully_idle}`, { fresh: Boolean(only), readDatabase: options.readDatabase });
    } catch (error) {
      if (only) throw error;
      steps = summarizeSteps([]);
    }
    const thread = buildThread(row, steps, { config, now, serverAlive: true });
    if (thread.excluded) {
      if (excluded >= config.limits.maxThreads) continue;
      excluded += 1;
    } else inScope += 1;
    entries.push({ row, steps });
  }
  const server = serverLookup(options, config);
  // A busy row silent past the window is stalled only with no server running.
  const silent = entries.some(({ row, steps }) => silentBusy(row, steps, lastActivityOf(row, steps), now, config.limits));
  const serverAlive = silent ? Boolean(await server()) : true;
  let room = config.limits.maxThreads - inScope;
  const threads = entries.map(({ row, steps }) => buildThread(row, steps, { config, now, serverAlive }))
    .filter((thread) => !thread.excluded || room-- > 0);
  if (!only) await applyQuota(threads, options, server);
  return threads;
}
