// Searchable, paginated view of every store-backed row eligible for Quick Ask.
//
// Eligibility lives in daily-brief.js, but Review enumerates raw records
// through listReviewEntities() rather than asking the brief composer to score
// and build actions for the whole backlog on every page request.

import { composeBrief, listReviewEntities } from "./daily-brief.js";

const REVIEW_KINDS = new Set(["task", "draft", "clarification", "suggestion"]);
const MAX_PAGE_SIZE = 100;

export class ReviewQueueQueryError extends Error {
  constructor(message) {
    super(message);
    this.name = "ReviewQueueQueryError";
    this.statusCode = 400;
  }
}

export function queryReviewQueue(runtime, options = {}) {
  const now = options.now ?? new Date();
  const kind = normalizeKind(options.kind);
  const query = String(options.q ?? "").trim().slice(0, 300).toLowerCase();
  const sort = options.sort === "newest" ? "newest" : "oldest";
  const limit = clampInt(options.limit, 1, MAX_PAGE_SIZE, 50);
  const cursor = decodeCursor(options.cursor);

  // Only the handful of Quick Ask rows need scores and action menus. This call
  // is task-bounded; the full Review inventory below is lightweight.
  const quick = composeBrief(runtime, {
    now,
    dataDir: options.dataDir,
    limit: clampInt(options.quickAskLimit, 1, 10, 5)
  });
  const entities = listReviewEntities(runtime, { dataDir: options.dataDir });
  const all = [
    ...entities.tasks.map(taskReviewRow),
    ...entities.drafts.map(draftReviewRow),
    ...entities.clarifications.map(clarificationReviewRow),
    ...entities.suggestions.map(suggestionReviewRow)
  ];
  const summary = summarize(all);
  const quickAskIds = new Set(quick.items
    .filter((item) => item?.entityRef?.id)
    .map((item) => entityKey(item.entityRef.kind, item.entityRef.id)));

  let matches = all.filter((row) => !kind || row.kind === kind);
  if (query) matches = matches.filter((row) => row._search.includes(query));
  matches.sort((a, b) => compareReviewRows(a, b, sort));
  const matchingTotal = matches.length;
  const matchingByKind = summarize(matches).byKind;
  if (cursor) {
    const cursorRow = { createdAt: cursor.createdAt, _sortKey: cursor.key };
    matches = matches.filter((row) => compareReviewRows(row, cursorRow, sort) > 0);
  }

  const page = matches.slice(0, limit);
  const hasMore = matches.length > page.length;
  const items = page.map((row) => {
    const { _search, _sortKey, ...publicRow } = row;
    return { ...publicRow, shownInQuickAsk: quickAskIds.has(entityKey(row.kind, row.id)) };
  });

  return {
    items,
    total: matchingTotal,
    byKind: matchingByKind,
    summary: {
      ...summary,
      quickAskVisible: quick.items.length,
      quickAskReviewable: quickAskIds.size,
      // Kept for compatible clients; this is the reviewable subset, not an
      // unbacked daily-plan focus row.
      quickAskShown: quickAskIds.size,
      moreThanQuickAsk: Math.max(0, summary.total - quickAskIds.size)
    },
    nextCursor: hasMore && page.length > 0 ? encodeCursor(page.at(-1)) : null,
    degraded: [...new Set([...(quick.degraded ?? []), ...(entities.degraded ?? [])])]
  };
}

function reviewRow({ kind, id, title, summary = null, preview = null, source = null, createdAt = null, search = [] }) {
  const normalizedId = String(id);
  const normalizedCreatedAt = validIso(createdAt);
  const normalizedTitle = String(title ?? "(untitled)");
  return {
    kind,
    id: normalizedId,
    title: normalizedTitle,
    summary: summary ? String(summary) : null,
    preview,
    source: source ? String(source) : null,
    createdAt: normalizedCreatedAt,
    deepLink: deepLinkFor(kind, normalizedId),
    _search: [kind, normalizedTitle, summary, source, ...search]
      .filter(Boolean).join("\n").toLowerCase(),
    _sortKey: `${normalizedCreatedAt ?? ""}\u0000${kind}\u0000${normalizedId}`
  };
}

function taskReviewRow(task) {
  return reviewRow({
    kind: "task",
    id: task.id,
    title: task.title,
    summary: task.description || null,
    source: task.source,
    createdAt: task.createdAt,
    search: [task.description, task.status, task.bucket, task.sourceMeta?.identifier]
  });
}

function draftReviewRow(draft) {
  const body = typeof draft.body === "string" ? draft.body : "";
  return reviewRow({
    kind: "draft",
    id: draft.id,
    title: draft.title,
    summary: ["draft waiting", draft.kind && draft.kind !== "other" ? draft.kind : null].filter(Boolean).join(" · "),
    preview: truncate(body.replace(/\s+/g, " ").trim(), 320),
    source: "agent",
    createdAt: draft.createdAt,
    search: [body, draft.kind, draft.recipient, draft.taskId]
  });
}

function clarificationReviewRow(clarification) {
  return reviewRow({
    kind: "clarification",
    id: clarification.id,
    title: clarification.question || "Did you finish this?",
    summary: clarification.context || "needs your call",
    source: "agent",
    createdAt: clarification.createdAt,
    search: [clarification.context, clarification.taskId, ...(clarification.sources ?? [])]
  });
}

function suggestionReviewRow(suggestion) {
  const described = firstSentence(suggestion.proposal?.description);
  const sequence = suggestion.sequence;
  const summary = sequence
    ? [
        sequence.count ? `seen ${sequence.count}x` : null,
        sequence.distinctDays > 1 ? `across ${sequence.distinctDays} days` : null,
        sequence.cadence?.type && sequence.cadence.type !== "irregular" ? `${sequence.cadence.type} cadence` : null
      ].filter(Boolean).join(" · ")
    : suggestion.rationale || null;
  return reviewRow({
    kind: "suggestion",
    id: suggestion.id,
    title: described || suggestion.title || "OpenAGI noticed something",
    summary,
    source: suggestion.source,
    createdAt: suggestion.proposedAt,
    search: [suggestion.title, suggestion.rationale, suggestion.proposal?.description, suggestion.proposal?.body]
  });
}

function summarize(rows) {
  const byKind = { tasks: 0, drafts: 0, clarifications: 0, suggestions: 0 };
  for (const row of rows) {
    if (row.kind === "task") byKind.tasks += 1;
    else if (row.kind === "draft") byKind.drafts += 1;
    else if (row.kind === "clarification") byKind.clarifications += 1;
    else if (row.kind === "suggestion") byKind.suggestions += 1;
  }
  return { total: rows.length, byKind };
}

function normalizeKind(value) {
  const kind = String(value ?? "").trim().toLowerCase();
  if (!kind || kind === "all") return null;
  const singular = kind.endsWith("s") ? kind.slice(0, -1) : kind;
  if (!REVIEW_KINDS.has(singular)) throw new ReviewQueueQueryError(`unknown review kind: ${kind}`);
  return singular;
}

function encodeCursor(row) {
  return Buffer.from(JSON.stringify({ key: row._sortKey, createdAt: row.createdAt }), "utf8").toString("base64url");
}

function decodeCursor(value) {
  if (value == null || value === "") return null;
  const cursor = String(value);
  if (cursor.length > 1_000) throw new ReviewQueueQueryError("invalid review cursor");
  try {
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!decoded || typeof decoded.key !== "string" || decoded.key.length > 1_000) throw new Error("bad key");
    if (decoded.createdAt !== null && validIso(decoded.createdAt) === null) throw new Error("bad date");
    return decoded;
  } catch {
    throw new ReviewQueueQueryError("invalid review cursor");
  }
}

function entityKey(kind, id) { return `${kind}:${id}`; }

// Missing timestamps are always last. Reversing the timestamp comparison for
// newest-first must not reverse that placement and put malformed legacy rows
// ahead of genuinely recent work.
function compareReviewRows(a, b, sort) {
  const aUndated = !a.createdAt;
  const bUndated = !b.createdAt;
  if (aUndated !== bUndated) return aUndated ? 1 : -1;
  if (aUndated) return compareSortKeys(a._sortKey, b._sortKey);
  return sort === "newest"
    ? compareSortKeys(b._sortKey, a._sortKey)
    : compareSortKeys(a._sortKey, b._sortKey);
}

function compareSortKeys(a, b) {
  return a === b ? 0 : (a < b ? -1 : 1);
}

function deepLinkFor(kind, id) {
  const encodedId = encodeURIComponent(id);
  if (kind === "task") return `/?tab=tasks&task=${encodedId}`;
  if (kind === "suggestion") return `/?tab=suggestions&suggestion=${encodedId}`;
  if (kind === "draft") return `/?tab=today&draft=${encodedId}`;
  return `/?tab=today&clarification=${encodedId}`;
}

function validIso(value) {
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function truncate(value, max) {
  const text = String(value ?? "");
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function firstSentence(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  const match = text.match(/^[\s\S]*?[.!?](?=\s|$)/);
  return (match ? match[0] : text).trim();
}
