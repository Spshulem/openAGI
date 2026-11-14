// Deep fleet conversation search and customer-bug session router.
// Searches the supervisor's latest scan + discovery cache (including chats
// outside the 60-row Auto shortlist) using NFKD-normalized BM25 scoring over
// titles, repos, branches, PR refs, open questions, and recent transcript
// turns—without triggering a scan or sending anything.

import { clampText, openChatFor, redactSecrets } from "./contracts.js";

const normalize = (text) =>
  String(text ?? "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase();

const bounded = (text, size = 8000) => redactSecrets(String(text ?? "")).slice(-size);

const ROUTING_STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "to", "for", "of", "in", "on", "at", "by", "with", "from", "into",
  "is", "are", "was", "were", "be", "been", "being", "it", "its", "this", "that", "these", "those",
  "hey", "hi", "please", "can", "could", "would", "you", "go", "ping", "nudge", "tell", "ask", "send",
  "find", "check", "look", "update", "solve", "fix", "chat", "thread", "session", "agent", "customer",
  "user", "had", "has", "have", "hit", "got", "saw", "seeing", "issue", "problem", "bug", "error", "about"
]);

function tokenize(text) {
  return normalize(text)
    .split(/[^a-z0-9_./#-]+/u)
    .map((t) => t.replace(/^[./#-]+|[./#-]+$/g, ""))
    .filter((t) => t.length >= 2);
}

function buildRows(state, cachedThreads = new Map()) {
  const byKey = new Map((state?.snapshot?.threads ?? []).filter((row) => row?.key).map((row) => [row.key, row]));
  // Discovery sees more sessions than the 60-row Auto shortlist; include them
  // read-only so search and routing can find any discovered session.
  for (const [key, thread] of cachedThreads ?? []) {
    if (!byKey.has(key) && thread) {
      byKey.set(key, {
        ...thread,
        key,
        state: thread.excluded || thread.agentStatus || "unknown",
        openChat: openChatFor(thread)
      });
    }
  }
  return [...byKey.values()];
}

function buildRowDocument(row, state, cachedThreads = new Map()) {
  const cached = cachedThreads?.get?.(row.key) ?? null;
  const title = bounded(row.title || row.workspace || row.key, 300);
  const prRef = row.pr?.ref ?? cached?.prRefs?.[0] ?? "";
  const prTitle = bounded(row.pr?.title ?? "", 200);
  const context = [
    cached?.lastUserText,
    cached?.lastAgentFull || row.lastAgentText,
    ...(cached?.meta?.conversation ?? []).slice(-60).map((m) => m?.text),
    ...(state?.questions ?? [])
      .filter((q) => q?.threadKey === row.key || q?.threadKeys?.includes(row.key))
      .map((q) => `${q.title ?? ""}\n${q.body ?? ""}`)
  ]
    .filter(Boolean)
    .map((text) => bounded(text))
    .join("\n")
    .slice(-120000);

  const metadata = [title, row.workspace ?? "", row.repo ?? "", row.branch ?? "", prRef, prTitle, row.key].join("\n");
  const normTitle = normalize(title);
  const normMeta = normalize(metadata);
  const normContext = normalize(context);
  const haystack = `${normMeta}\n${normContext}`;
  return {
    row,
    cached,
    title,
    prRef: prRef || null,
    context,
    metadata,
    normTitle,
    normMeta,
    normContext,
    haystack,
    tokens: tokenize(haystack)
  };
}

function computeBm25Scores(docs, queryTerms) {
  const N = Math.max(1, docs.length);
  const avgDl = docs.reduce((sum, d) => sum + d.tokens.length, 0) / N || 1;
  const df = new Map();
  for (const term of queryTerms) {
    let count = 0;
    for (const doc of docs) {
      if (doc.haystack.includes(term)) count += 1;
    }
    df.set(term, count);
  }

  const k1 = 1.2;
  const b = 0.75;
  return docs.map((doc) => {
    let score = 0;
    let matchedTerms = 0;
    const dl = Math.max(1, doc.tokens.length);
    for (const term of queryTerms) {
      const inTitle = doc.normTitle.includes(term);
      const inMeta = doc.normMeta.includes(term);
      const inContext = doc.normContext.includes(term);
      if (!inTitle && !inMeta && !inContext) continue;
      matchedTerms += 1;
      const termHits = doc.tokens.filter((tok) => tok === term || tok.includes(term)).length || 1;
      const weightedTf = termHits + (inTitle ? 4 : 0) + (inMeta ? 2.5 : 0);
      const idf = Math.log(1 + (N - (df.get(term) ?? 0) + 0.5) / ((df.get(term) ?? 0) + 0.5));
      const tfNorm = (weightedTf * (k1 + 1)) / (weightedTf + k1 * (1 - b + b * (dl / avgDl)));
      score += Math.max(0.25, idf) * tfNorm;
    }
    return { doc, score, matchedTerms };
  });
}

export function searchFleet(state, { query, limit = 20, natural = false, includeScores = false } = {}, cachedThreads = new Map()) {
  if (typeof query !== "string" || !query.trim() || query.length > 300) {
    throw new Error("Query must be 1-300 characters.");
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new Error("Limit must be 1-50.");
  }
  const rawTerms = [...new Set(normalize(query.trim()).split(/\s+/).filter(Boolean))];
  const alphaTerms = tokenize(query);
  const informative = alphaTerms.filter((t) => !ROUTING_STOP_WORDS.has(t));
  const useNaturalSubset = natural || rawTerms.length >= 4;
  const effectiveTerms = useNaturalSubset && informative.length >= 2 ? [...new Set(informative)] : rawTerms;

  const rows = buildRows(state, cachedThreads);
  const docs = rows.map((row) => buildRowDocument(row, state, cachedThreads));
  const withContext = docs.filter((d) => Boolean(d.context)).length;

  // Queries made only of punctuation (e.g. "[.*") that match literal substring
  // nowhere must return 0 cleanly.
  const scored = computeBm25Scores(docs, effectiveTerms);
  const matches = [];
  for (const { doc, score, matchedTerms } of scored) {
    const allRawMatch = rawTerms.length > 0 && rawTerms.every((term) => doc.haystack.includes(term));
    const minRequired = useNaturalSubset && effectiveTerms.length >= 2
      ? Math.max(2, Math.ceil(effectiveTerms.length * 0.45))
      : effectiveTerms.length;

    if (!allRawMatch && !(useNaturalSubset && matchedTerms >= minRequired)) continue;

    const snippetLine = doc.context
      .split("\n")
      .find((line) => effectiveTerms.some((term) => normalize(line).includes(term)))
      || doc.row.reason
      || doc.title;

    const liveBonus = doc.row.live || doc.row.agentStatus === "running" ? 1.5 : 0;
    const exactBonus = allRawMatch ? 6 : 0;

    matches.push({
      key: doc.row.key,
      title: doc.title,
      repo: doc.row.repo ?? null,
      branch: doc.row.branch ?? null,
      prRef: doc.prRef,
      live: Boolean(doc.row.live || doc.row.agentStatus === "running"),
      state: doc.row.state ?? "unknown",
      lastActivityAt: doc.row.lastActivityAt ?? null,
      snippet: bounded(snippetLine, 500),
      openChat: doc.row.openChat ?? null,
      score: score + exactBonus + liveBonus,
      matchedTerms
    });
  }

  matches.sort(
    (a, b) =>
      b.score - a.score
      || String(b.lastActivityAt ?? "").localeCompare(String(a.lastActivityAt ?? ""))
      || a.key.localeCompare(b.key)
  );

  return {
    query: query.trim(),
    results: matches.slice(0, limit).map(({ score: _score, matchedTerms: _matched, ...row }) => row),
    ...(includeScores ? { scoredResults: matches.slice(0, limit) } : {}),
    total: matches.length,
    scannedAt: state?.snapshot?.at ?? null,
    coverage: { threads: rows.length, withContext },
    scope: "Latest supervisor scan and cached recent messages; older history and undiscovered chats are not searched."
  };
}

export function buildBugDispatchMessage(issueText) {
  const clean = clampText(redactSecrets(String(issueText ?? "").trim()), 1500);
  return `Customer issue reported via Supervisor:\n${clean}\n\nPlease investigate the root cause in this branch/area, add or update a regression test, and report back once the fix is ready.`;
}

function inferDominantRepo(state, cachedThreads) {
  const counts = new Map();
  for (const row of buildRows(state, cachedThreads)) {
    if (row.repo) counts.set(row.repo, (counts.get(row.repo) ?? 0) + 1);
  }
  let best = null;
  let bestCount = 0;
  for (const [repo, count] of counts) {
    if (count > bestCount) {
      best = repo;
      bestCount = count;
    }
  }
  return best;
}

// Routes a natural-language bug report or task to the right coding session:
//   - High-confidence (>= 0.85) active session -> action: "auto_dispatch"
//   - Ambiguous / archived / low-confidence -> action: "picker" with top
//     candidates + "Start new coding chat in <repo>" fallback.
export async function routeCustomerIssue({ text, state, cachedThreads = new Map(), runModel = null } = {}) {
  const raw = String(text ?? "").trim();
  if (!raw || raw.length > 2000) {
    throw new Error("Issue description must be 1-2000 characters.");
  }
  const searchQuery = raw.slice(0, 300);
  const searched = searchFleet(state, { query: searchQuery, limit: 8, natural: true, includeScores: true }, cachedThreads);
  const top = searched.scoredResults ?? [];
  const inferredRepo = top[0]?.repo ?? inferDominantRepo(state, cachedThreads);

  if (top.length === 0) {
    return {
      query: raw,
      action: "picker",
      confidence: 0,
      primary: null,
      candidates: [],
      fallbackNewChat: {
        repo: inferredRepo,
        label: inferredRepo ? `Start new Paseo chat in ${inferredRepo}` : "Start new Paseo coding chat"
      },
      suggestedMessage: buildBugDispatchMessage(raw)
    };
  }

  // Compute deterministic BM25 margin confidence in [0, 0.98].
  const firstScore = top[0].score;
  const secondScore = top[1]?.score ?? 0;
  const marginRatio = secondScore > 0 ? (firstScore - secondScore) / Math.max(1, firstScore) : 1;
  let primaryIndex = 0;
  let confidence = Math.min(
    0.96,
    0.52 + Math.min(0.24, firstScore * 0.025) + Math.min(0.2, marginRatio * 0.25)
  );
  if (!top[0].live || ["done", "excluded", "archived"].includes(top[0].state)) {
    confidence = Math.min(confidence, 0.72);
  }
  let pickerReason = top[0].prRef
    ? `Matched ${top[0].prRef} (${top[0].title})`
    : `Matched recent context in ${top[0].title}`;

  // Optional structured LLM decisions refinement when provided by caller.
  if (typeof runModel === "function" && top.length > 1) {
    try {
      const prompt = [
        "Pick the single best coding session to handle this issue, or mark ambiguous if uncertain.",
        `Issue: ${JSON.stringify(raw.slice(0, 600))}`,
        `Candidates: ${JSON.stringify(top.slice(0, 5).map((c, idx) => ({
          index: idx,
          key: c.key,
          title: c.title,
          repo: c.repo,
          branch: c.branch,
          prRef: c.prRef,
          live: c.live,
          state: c.state,
          snippet: c.snippet.slice(0, 200)
        })))}`,
        'Respond ONLY with JSON: {"index": number, "confidence": number, "reason": string}'
      ].join("\n");
      const rawReply = await runModel(prompt);
      const parsed = typeof rawReply === "string" ? JSON.parse(rawReply) : rawReply;
      if (parsed && Number.isInteger(parsed.index) && parsed.index >= 0 && parsed.index < top.length) {
        primaryIndex = parsed.index;
        if (typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)) {
          confidence = Math.max(0, Math.min(0.99, parsed.confidence));
        }
        if (typeof parsed.reason === "string" && parsed.reason.trim()) {
          pickerReason = clampText(redactSecrets(parsed.reason.trim()), 180);
        }
      }
    } catch {
      // Deterministic BM25 ranking stands on model timeout/error.
    }
  }

  const ordered = [top[primaryIndex], ...top.filter((_, idx) => idx !== primaryIndex)].slice(0, 4);
  const candidates = ordered.map((item, idx) => ({
    key: item.key,
    title: item.title,
    repo: item.repo,
    branch: item.branch,
    prRef: item.prRef,
    state: item.state,
    live: item.live,
    snippet: item.snippet,
    openChat: item.openChat,
    confidence: idx === 0 ? Number(confidence.toFixed(2)) : Number(Math.max(0.15, confidence * (item.score / Math.max(1, ordered[0].score)) * 0.85).toFixed(2)),
    reason: idx === 0 ? pickerReason : (item.prRef ? `Also touched ${item.prRef}` : "Related transcript terms")
  }));

  const primary = candidates[0];
  const autoDispatch = confidence >= 0.85 && primary.live && !["done", "excluded", "archived"].includes(primary.state);

  return {
    query: raw,
    action: autoDispatch ? "auto_dispatch" : "picker",
    confidence: Number(confidence.toFixed(2)),
    primary,
    candidates,
    fallbackNewChat: {
      repo: primary.repo ?? inferredRepo,
      label: (primary.repo ?? inferredRepo)
        ? `Start new Paseo chat in ${primary.repo ?? inferredRepo}`
        : "Start new Paseo coding chat"
    },
    suggestedMessage: buildBugDispatchMessage(raw)
  };
}
