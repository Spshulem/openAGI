// Searchable, paginated view of every store-backed row eligible for Quick Ask.
//
// This deliberately composes through daily-brief.js rather than reading tasks,
// drafts, clarifications and suggestions independently. "N more" and Review
// therefore share one eligibility policy, including muted categories and the
// focus-backed-task de-duplication that prevents the same task appearing twice.

import { composeBrief } from "./daily-brief.js";

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
  const cursorKey = decodeCursor(options.cursor);

  const quick = composeBrief(runtime, {
    now,
    dataDir: options.dataDir,
    limit: clampInt(options.quickAskLimit, 1, 10, 5),
    includeReviewMeta: true
  });

  // One composition is enough: includeReviewMeta keeps the five slot-selected
  // rows in `items` and exposes the complete eligible set in `reviewItems`.
  // A second 100k-item composition used to parse every suggestion file twice
  // and duplicate the full queue in memory on every page request.
  const all = (quick.reviewItems ?? quick.items)
    .filter((item) => item?.entityRef?.id && REVIEW_KINDS.has(item.entityRef.kind))
    .map(toReviewRow);
  const summary = summarize(all);
  const quickAskIds = new Set(quick.items
    .filter((item) => item?.entityRef?.id)
    .map((item) => entityKey(item.entityRef.kind, item.entityRef.id)));

  let matches = all.filter((row) => !kind || row.kind === kind);
  if (query) matches = matches.filter((row) => row._search.includes(query));
  matches.sort((a, b) => sort === "newest"
    ? compareSortKeys(b._sortKey, a._sortKey)
    : compareSortKeys(a._sortKey, b._sortKey));
  const matchingTotal = matches.length;
  const matchingByKind = summarize(matches).byKind;
  if (cursorKey) {
    matches = matches.filter((row) => sort === "newest" ? row._sortKey < cursorKey : row._sortKey > cursorKey);
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
    nextCursor: hasMore && page.length > 0 ? encodeCursor(page.at(-1)._sortKey) : null,
    degraded: [...new Set(quick.degraded ?? [])]
  };
}

function toReviewRow(item) {
  const kind = item.entityRef.kind;
  const id = String(item.entityRef.id);
  const createdAt = validIso(item.reviewCreatedAt);
  const title = String(item.reviewTitle ?? item.title ?? "(untitled)");
  const preview = kind === "draft" && typeof item.editValue === "string"
    ? truncate(item.editValue.replace(/\s+/g, " ").trim(), 320)
    : null;
  const searchable = [kind, title, item.title, item.why, item.source, item.editValue, item.reviewSearchText]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
  return {
    kind,
    id,
    title,
    summary: item.why ? String(item.why) : null,
    preview,
    source: item.source ? String(item.source) : null,
    createdAt,
    deepLink: deepLinkFor(kind, id),
    _search: searchable,
    _sortKey: `${createdAt ?? "9999-12-31T23:59:59.999Z"}\u0000${kind}\u0000${id}`
  };
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

function encodeCursor(key) {
  return Buffer.from(JSON.stringify({ key }), "utf8").toString("base64url");
}

function decodeCursor(value) {
  if (value == null || value === "") return null;
  const cursor = String(value);
  if (cursor.length > 1_000) throw new ReviewQueueQueryError("invalid review cursor");
  try {
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!decoded || typeof decoded.key !== "string" || decoded.key.length > 1_000) throw new Error("bad key");
    return decoded.key;
  } catch {
    throw new ReviewQueueQueryError("invalid review cursor");
  }
}

function entityKey(kind, id) { return `${kind}:${id}`; }

// Cursor filtering must use exactly the same bytewise ordering as the sort.
// String.localeCompare() is locale/case dependent, while `<` is not; mixing
// the two can skip rows whose ids differ only in case at the same timestamp.
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
