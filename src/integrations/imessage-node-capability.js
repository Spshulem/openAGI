import os from "node:os";
import path from "node:path";
import { searchMessages } from "./imessage-bridge.js";

export const IMESSAGE_SEARCH_CAPABILITY = "imessage-search";
export const IMESSAGE_SEARCH_OPERATION = "search";

const DEFAULT_DB_PATH = path.join(os.homedir(), "Library", "Messages", "chat.db");
const DEFAULT_RESULT_BYTES = 1024 * 1024;
const DEFAULT_MESSAGE_TEXT_BYTES = 32 * 1024;
const MAX_QUERY_BYTES = 2 * 1024;
const MAX_PERSON_BYTES = 320;
const MAX_DAYS = 3650;
const MAX_LIMIT = 100;

const ENABLED_VALUES = new Set(["1", "true", "yes"]);
const ALLOWED_SEARCH_KEYS = new Set(["query", "person", "days", "limit"]);

function publicError(code, detail = null) {
  const error = new Error(detail ? `${code}: ${detail}` : code);
  error.code = code;
  return error;
}

export function isImessageSearchEnabled(env = process.env) {
  return ENABLED_VALUES.has(String(env?.OPENAGI_IMESSAGE_SEARCH ?? "").trim().toLowerCase());
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function boundedOptionalString(value, name, maxBytes) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw publicError("invalid-search-request", `${name} must be a string`);
  }
  if (Buffer.byteLength(value, "utf8") > maxBytes) {
    throw publicError("invalid-search-request", `${name} is too long`);
  }
  return value;
}

export function normalizeImessageSearchArgs(payload = {}) {
  if (!isPlainObject(payload)) {
    throw publicError("invalid-search-request", "search arguments must be an object");
  }
  for (const key of Object.keys(payload)) {
    if (!ALLOWED_SEARCH_KEYS.has(key)) {
      throw publicError("invalid-search-request", "unsupported field");
    }
  }

  const query = boundedOptionalString(payload.query, "query", MAX_QUERY_BYTES) ?? "";
  const person = boundedOptionalString(payload.person, "person", MAX_PERSON_BYTES);

  let days = null;
  if (payload.days !== undefined && payload.days !== null) {
    if (!Number.isSafeInteger(payload.days) || payload.days < 1 || payload.days > MAX_DAYS) {
      throw publicError("invalid-search-request", `days must be an integer from 1 to ${MAX_DAYS}`);
    }
    days = payload.days;
  }

  let limit = 20;
  if (payload.limit !== undefined && payload.limit !== null) {
    if (!Number.isSafeInteger(payload.limit) || payload.limit < 1 || payload.limit > MAX_LIMIT) {
      throw publicError("invalid-search-request", `limit must be an integer from 1 to ${MAX_LIMIT}`);
    }
    limit = payload.limit;
  }

  return { query, handle: person, days, limit };
}

function readinessCategory(error) {
  const code = String(error?.code ?? "").toUpperCase();
  const message = String(error?.message ?? "").toLowerCase();

  if (
    code === "ERR_UNKNOWN_BUILTIN_MODULE"
    || code === "MODULE_NOT_FOUND"
    || message.includes("node:sqlite")
    || message.includes("sqlite unavailable")
  ) {
    return "sqlite-unavailable";
  }
  if (
    code === "EACCES"
    || code === "EPERM"
    || code === "SQLITE_AUTH"
    || message.includes("full disk access")
    || message.includes("operation not permitted")
    || message.includes("permission denied")
  ) {
    return "full-disk-access-required";
  }
  return "database-unavailable";
}

async function defaultReadinessProbe(dbPath) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    try { db.exec("PRAGMA query_only = 1; PRAGMA busy_timeout = 2000;"); } catch { /* best-effort hardening */ }
    db.prepare("SELECT 1 FROM message LIMIT 1").get();
  } finally {
    db.close();
  }
}

function clipUtf8(value, maxBytes) {
  const source = typeof value === "string" ? value : "";
  if (Buffer.byteLength(source, "utf8") <= maxBytes) return { value: source, clipped: false };
  let bytes = 0;
  let output = "";
  for (const character of source) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > maxBytes) break;
    output += character;
    bytes += size;
  }
  return { value: output, clipped: true };
}

function sanitizeResultRow(raw, textBytes) {
  if (!raw || typeof raw !== "object") return null;
  const handle = raw.handle === null || raw.handle === undefined
    ? null
    : clipUtf8(String(raw.handle), MAX_PERSON_BYTES).value;
  const date = typeof raw.date === "string" ? raw.date.slice(0, 64) : null;
  const text = clipUtf8(raw.text, textBytes);
  return {
    row: {
      handle,
      fromMe: raw.fromMe === true,
      date,
      text: text.value
    },
    clipped: text.clipped
  };
}

function boundSearchResults(rawRows, limit, { maxResultBytes, maxMessageTextBytes }) {
  if (!Array.isArray(rawRows)) throw publicError("database-unavailable");

  const rows = rawRows.slice(0, limit);
  const results = [];
  let truncated = rawRows.length > limit;
  // Leave room for the envelope and bounded metadata even when a small limit is
  // injected by a test or an embedded caller.
  const initialTextBudget = Math.min(maxMessageTextBytes, Math.max(0, maxResultBytes - 768));

  for (const raw of rows) {
    let textBudget = initialTextBudget;
    let sanitized = sanitizeResultRow(raw, textBudget);
    if (!sanitized) {
      truncated = true;
      continue;
    }
    let candidate = [...results, sanitized.row];
    let envelope = { count: candidate.length, results: candidate, truncated: true };

    // JSON escaping can be larger than the UTF-8 source (for example control
    // characters). Reduce only this row until the complete response fits.
    while (Buffer.byteLength(JSON.stringify(envelope), "utf8") > maxResultBytes && textBudget > 0) {
      textBudget = Math.floor(textBudget / 2);
      sanitized = sanitizeResultRow(raw, textBudget);
      candidate = [...results, sanitized.row];
      envelope = { count: candidate.length, results: candidate, truncated: true };
    }
    if (Buffer.byteLength(JSON.stringify(envelope), "utf8") > maxResultBytes) {
      truncated = true;
      break;
    }
    if (sanitized.clipped || textBudget < initialTextBudget) truncated = true;
    results.push(sanitized.row);
  }

  const response = { count: results.length, results, truncated };
  // maxResultBytes is clamped to at least 1 KiB, and every metadata field is
  // bounded, so this should be unreachable. Keep the invariant explicit.
  if (Buffer.byteLength(JSON.stringify(response), "utf8") > maxResultBytes) {
    throw publicError("database-unavailable");
  }
  return response;
}

export function createImessageNodeCapability({
  env = process.env,
  dbPath = env?.IMESSAGE_DB_PATH || DEFAULT_DB_PATH,
  search = searchMessages,
  readinessProbe = defaultReadinessProbe,
  now = () => Date.now(),
  maxResultBytes = DEFAULT_RESULT_BYTES,
  maxMessageTextBytes = DEFAULT_MESSAGE_TEXT_BYTES
} = {}) {
  const resultBytes = Math.max(1024, Math.min(DEFAULT_RESULT_BYTES, Number(maxResultBytes) || DEFAULT_RESULT_BYTES));
  const messageTextBytes = Math.max(0, Math.min(DEFAULT_MESSAGE_TEXT_BYTES, Number(maxMessageTextBytes) || DEFAULT_MESSAGE_TEXT_BYTES));

  const health = async () => {
    const checkedAt = new Date(now()).toISOString();
    if (!isImessageSearchEnabled(env)) {
      return {
        ok: false,
        service: "imessage",
        capability: {
          id: IMESSAGE_SEARCH_CAPABILITY,
          ready: false,
          operations: [],
          detail: "disabled",
          checkedAt
        }
      };
    }
    try {
      await readinessProbe(dbPath);
      return {
        ok: true,
        service: "imessage",
        capability: {
          id: IMESSAGE_SEARCH_CAPABILITY,
          ready: true,
          operations: [IMESSAGE_SEARCH_OPERATION],
          detail: "ready",
          checkedAt
        }
      };
    } catch (error) {
      return {
        ok: false,
        service: "imessage",
        capability: {
          id: IMESSAGE_SEARCH_CAPABILITY,
          ready: false,
          operations: [],
          detail: readinessCategory(error),
          checkedAt
        }
      };
    }
  };

  const invoke = async (operation, payload = {}) => {
    if (operation !== IMESSAGE_SEARCH_OPERATION) {
      throw publicError("unsupported-node-operation");
    }
    if (!isImessageSearchEnabled(env)) {
      throw publicError("imessage-search-disabled");
    }
    const args = normalizeImessageSearchArgs(payload);
    try {
      const rows = await search(dbPath, args);
      return boundSearchResults(rows, args.limit, {
        maxResultBytes: resultBytes,
        maxMessageTextBytes: messageTextBytes
      });
    } catch (error) {
      throw publicError(readinessCategory(error));
    }
  };

  return {
    id: IMESSAGE_SEARCH_CAPABILITY,
    health,
    invoke
  };
}
