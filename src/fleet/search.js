// Deep fleet conversation search and customer-bug session router.
// Searches the supervisor's latest scan + discovery cache (including chats
// outside the 60-row Auto shortlist) plus local and registered-Paseo-host
// Antigravity FTS5 / brain artifact / Paseo agent archives using NFKD-normalized
// BM25 scoring—without mutating any database or sending anything.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { clampText, openChatFor, openReadOnlyDb, redactSecrets } from "./contracts.js";

const execFileAsync = promisify(execFileCb);

function normalize(text) {
  const raw = String(text ?? "");
  const decomposed = typeof raw.normalize === "function" ? raw.normalize("NFKD") : raw;
  return decomposed.replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

const bounded = (text, size = 8000) => redactSecrets(String(text ?? "")).slice(-size);

const ROUTING_STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "to", "for", "of", "in", "on", "at", "by", "with", "from", "into",
  "is", "are", "was", "were", "be", "been", "being", "it", "its", "this", "that", "these", "those",
  "hey", "hi", "please", "can", "could", "would", "you", "go", "ping", "nudge", "tell", "ask", "send",
  "find", "check", "look", "update", "solve", "fix", "chat", "thread", "session", "agent", "customer",
  "user", "had", "has", "have", "hit", "got", "saw", "seeing", "issue", "problem", "bug", "error", "about",
  "which", "what", "where", "who", "when", "how", "believe", "think", "built", "made", "created", "did", "worked"
]);

const PROVIDER_TERMS = new Set(["antigravity", "claude", "codex", "conductor", "paseo"]);

function tokenize(text) {
  return normalize(text)
    .split(/[^a-z0-9_./#-]+/)
    .map((t) => t.replace(/^[./#-]+|[./#-]+$/g, ""))
    .filter((t) => t.length >= 2);
}

export function extractQueryTerms(query, { natural = false } = {}) {
  const rawTerms = [...new Set(normalize(String(query ?? "").trim()).split(/\s+/).filter(Boolean))];
  const alphaTerms = tokenize(query);
  const informative = alphaTerms.filter((t) => !ROUTING_STOP_WORDS.has(t));
  const useNaturalSubset = natural || rawTerms.length >= 4;
  const effectiveTerms = useNaturalSubset && informative.length >= 2 ? [...new Set(informative)] : rawTerms;
  return { rawTerms, effectiveTerms, useNaturalSubset };
}

const CODE_PATH_OWNERS = new Set(["src", "app", "packages", "apps", "lib", "test", "tests", "server", "client", "docs", "scripts"]);

function extractTranscriptPrRefs(text) {
  const seen = [];
  const raw = String(text ?? "");
  const rawMatches = [];
  const collect = (index, repo, num) => {
    const cleanRepo = String(repo ?? "").trim().replace(/\.git$/i, "");
    const cleanNum = String(num ?? "").trim();
    const owner = cleanRepo.split("/")[0] ?? "";
    if (!owner || CODE_PATH_OWNERS.has(owner.toLowerCase()) || !/^\d+$/.test(cleanNum)) return;
    rawMatches.push({ index: Number.isFinite(index) ? index : 0, ref: `${cleanRepo}#${cleanNum}` });
  };
  for (const m of raw.matchAll(/https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/(\d+)/g)) {
    collect(m.index, m[1], m[2]);
  }
  for (const m of raw.matchAll(/\bgh\s+pr\s+(?:view|checks|merge|edit|diff|ready)\s+(\d+)[^\n]{0,120}?--repo[=\s]+([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/g)) {
    collect(m.index, m[2], m[1]);
  }
  for (const m of raw.matchAll(/\bgh\s+pr\s+(?:view|checks|merge|edit|diff|ready)\s+--repo[=\s]+([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\s+(\d+)\b/g)) {
    collect(m.index, m[1], m[2]);
  }
  for (const m of raw.matchAll(/(?<![A-Za-z0-9_./:-])([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)\b/g)) {
    collect(m.index, m[1], m[2]);
  }
  rawMatches.sort((a, b) => a.index - b.index);
  for (const { ref } of rawMatches) {
    const existingIdx = seen.indexOf(ref);
    if (existingIdx !== -1) seen.splice(existingIdx, 1);
    seen.push(ref);
  }
  return seen.reverse().slice(0, 8);
}

function readBoundedHeadTail(filePath, headBytes = 131072, tailBytes = 393216) {
  let fd = null;
  try {
    const st = fs.statSync(filePath);
    if (!st.isFile() || st.size === 0) return "";
    if (st.size <= headBytes + tailBytes) {
      return fs.readFileSync(filePath, "utf8");
    }
    fd = fs.openSync(filePath, "r");
    const headBuf = Buffer.alloc(headBytes);
    const hRead = fs.readSync(fd, headBuf, 0, headBytes, 0);
    const tailBuf = Buffer.alloc(tailBytes);
    const tRead = fs.readSync(fd, tailBuf, 0, tailBytes, Math.max(0, st.size - tailBytes));
    return `${headBuf.subarray(0, hRead).toString("utf8")}\n${tailBuf.subarray(0, tRead).toString("utf8")}`;
  } catch {
    return "";
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}

function extractReadableJsonlLines(rawSample) {
  const out = [];
  for (const line of String(rawSample ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj?.type === "user" || obj?.type === "assistant") {
        const content = obj.message?.content;
        if (typeof content === "string" && content.trim()) {
          out.push(content.trim().slice(0, 3000));
        } else if (Array.isArray(content)) {
          for (const block of content) {
            if (typeof block?.text === "string" && block.text.trim()) {
              out.push(block.text.trim().slice(0, 3000));
            } else if (block?.type === "tool_result" && typeof block.content === "string" && /github\.com\/[^\s]+\/pull\/\d+|#\d+/.test(block.content)) {
              out.push(block.content.trim().slice(0, 1500));
            }
          }
        }
      } else if (obj?.type === "event_msg" && typeof obj.payload?.message === "string") {
        out.push(obj.payload.message.trim().slice(0, 3000));
      }
    } catch {
      if (/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+/.test(trimmed)) {
        out.push(trimmed.slice(0, 1500));
      }
    }
  }
  return out.join("\n");
}

function resolveClaudeTranscriptPath(homeDir, cwd, sessionId) {
  if (!sessionId || !/^[A-Za-z0-9_.-]+$/.test(sessionId)) return null;
  if (cwd) {
    const slug = String(cwd).replace(/[^A-Za-z0-9_-]/g, "-");
    const direct = path.join(homeDir, ".claude", "projects", slug, `${sessionId}.jsonl`);
    if (fs.existsSync(direct)) return direct;
  }
  const projectsRoot = path.join(homeDir, ".claude", "projects");
  try {
    for (const d of fs.readdirSync(projectsRoot, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const candidate = path.join(projectsRoot, d.name, `${sessionId}.jsonl`);
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch { /* ignore */ }
  return null;
}

function scanRecentClaudeTranscripts(homeDir, contentTerms, paseoCatalog, maxRecentFiles = 40) {
  const results = new Map();
  if (!contentTerms.length) return results;
  const projectsRoot = path.join(homeDir, ".claude", "projects");
  const candidates = [];
  try {
    for (const dir of fs.readdirSync(projectsRoot, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      const dirPath = path.join(projectsRoot, dir.name);
      let files = [];
      try { files = fs.readdirSync(dirPath, { withFileTypes: true }); } catch { continue; }
      for (const f of files) {
        if (!f.isFile() || !f.name.endsWith(".jsonl")) continue;
        const fp = path.join(dirPath, f.name);
        try {
          const st = fs.statSync(fp);
          if (st.size > 0) candidates.push({ fp, sid: f.name.slice(0, -6), mtimeMs: st.mtimeMs });
        } catch { /* ignore */ }
      }
    }
  } catch {
    return results;
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const { fp, sid, mtimeMs } of candidates.slice(0, maxRecentFiles)) {
    const rawSample = readBoundedHeadTail(fp, 32768, 98304);
    if (!rawSample) continue;
    const lowerRaw = normalize(rawSample);
    if (!contentTerms.some((t) => lowerRaw.includes(t))) continue;
    const cleanText = extractReadableJsonlLines(rawSample) || rawSample.slice(-12000);
    const lowerClean = normalize(cleanText);
    if (!contentTerms.some((t) => lowerClean.includes(t))) continue;
    const excerpt = extractArtifactExcerpt(cleanText, lowerClean, contentTerms, 8000);
    const prRefs = extractTranscriptPrRefs(rawSample);
    const linked = paseoCatalog.byNativeId.get(sid) ?? null;
    if (linked) {
      const key = `paseo:${linked.serverId}.${linked.id}`;
      results.set(key, {
        key,
        kind: "paseo",
        id: linked.id,
        title: clampText(linked.title, 120),
        workspace: linked.workspaceName || (linked.cwd ? path.basename(linked.cwd) : null),
        repo: prRefs[0]?.split("#")[0] ?? inferRepoFromPath(linked.cwd),
        branch: null,
        prRefs,
        agentStatus: linked.archived ? "closed" : linked.status,
        state: linked.archived ? "archived" : linked.status,
        live: linked.status === "running",
        lastActivityAt: linked.updatedAt ?? new Date(mtimeMs).toISOString(),
        lastAgentText: redactSecrets(excerpt).slice(-600),
        lastAgentFull: redactSecrets(excerpt),
        meta: {
          serverId: linked.serverId,
          provider: linked.provider || "claude",
          paseoCwd: linked.cwd,
          aliases: [`claude:${sid}`],
          conversation: [{ role: "assistant", text: redactSecrets(excerpt) }]
        }
      });
    } else {
      const key = `claude:${sid}`;
      results.set(key, {
        key,
        kind: "claude",
        id: sid,
        title: clampText(`Claude session ${sid.slice(0, 8)}`, 120),
        workspace: null,
        repo: prRefs[0]?.split("#")[0] ?? null,
        branch: null,
        prRefs,
        agentStatus: "idle",
        state: "idle",
        live: false,
        lastActivityAt: new Date(mtimeMs).toISOString(),
        lastAgentText: redactSecrets(excerpt).slice(-600),
        lastAgentFull: redactSecrets(excerpt),
        meta: {
          provider: "claude",
          file: fp,
          aliases: [`claude:${sid}`],
          conversation: [{ role: "assistant", text: redactSecrets(excerpt) }]
        }
      });
    }
  }
  return results;
}

function buildRows(state, cachedThreads = new Map()) {
  const byKey = new Map((state?.snapshot?.threads ?? []).filter((row) => row?.key).map((row) => [row.key, row]));
  // Discovery and archive indexes see more sessions than the 60-row Auto shortlist;
  // include them read-only so search and routing can find any session.
  for (const [key, thread] of cachedThreads ?? []) {
    if (!byKey.has(key) && thread) {
      byKey.set(key, {
        ...thread,
        key,
        state: thread.state || thread.excluded || thread.agentStatus || "unknown",
        openChat: thread.openChat ?? openChatFor(thread)
      });
    }
  }
  for (const card of state?.cards ?? []) {
    const key = card?.threadKey ?? card?.threadKeys?.[0] ?? null;
    if (!key || byKey.has(key) || card.kind === "preference") continue;
    byKey.set(key, {
      key,
      kind: key.split(":")[0] || "unknown",
      title: card.sessionTitle || card.headline || key,
      workspace: card.workspace ?? null,
      repo: card.repo ?? null,
      branch: card.branch ?? null,
      pr: card.prContext ? {
        ref: card.prContext.ref ?? card.prRef ?? null,
        title: card.prContext.title ?? null,
        bodySummary: card.prContext.bodySummary ?? null
      } : (card.prRef ? { ref: card.prRef, title: null } : null),
      prRefs: card.prRef ? [card.prRef] : [],
      state: card.kind === "merge_ready" ? "ready-needs-human" : "needs-human",
      live: false,
      lastActivityAt: card.noticedAt ?? null,
      lastAgentText: card.agentSummary || card.summary || "",
      openChat: card.openChat ?? null
    });
  }
  for (const q of state?.questions ?? []) {
    const key = q?.threadKey ?? q?.threadKeys?.[0] ?? null;
    if (!key || byKey.has(key) || q?.status !== "open") continue;
    const snap = q.contextSnapshot ?? null;
    byKey.set(key, {
      key,
      kind: key.split(":")[0] || "unknown",
      title: snap?.threadTitle || q.title || key,
      workspace: snap?.workspace ?? null,
      repo: snap?.repo ?? null,
      branch: snap?.branch ?? null,
      pr: snap?.pr ?? (q.prRef ? { ref: q.prRef } : null),
      prRefs: q.prRef ? [q.prRef] : [],
      state: q.kind === "ready" ? "ready-needs-human" : "needs-human",
      live: false,
      lastActivityAt: q.askedAt ?? q.createdAt ?? null,
      lastAgentText: q.askContext || snap?.agentSummary || q.body || "",
      openChat: q.openChat ?? null
    });
  }
  return [...byKey.values()];
}

function buildRowDocument(row, state, cachedThreads = new Map()) {
  const cached = cachedThreads?.get?.(row.key) ?? null;
  const matchingCards = (state?.cards ?? []).filter(
    (c) => c && c.kind !== "preference" && (c.threadKey === row.key || c.threadKeys?.includes?.(row.key))
  );
  const title = bounded(row.title || row.workspace || row.key, 300);
  const cardPrRefs = matchingCards.map((c) => c.prRef ?? c.prContext?.ref).filter(Boolean);
  const allPrRefs = [...new Set([row.pr?.ref, ...(row.prRefs ?? []), ...(cached?.prRefs ?? []), ...cardPrRefs].filter(Boolean))];
  const prRef = allPrRefs[0] ?? "";
  const prTitle = bounded(row.pr?.title || matchingCards.find((c) => c.prContext?.title)?.prContext?.title || "", 200);
  const prBody = bounded(row.pr?.bodySummary || matchingCards.find((c) => c.prContext?.bodySummary)?.prContext?.bodySummary || "", 4000);
  const provider = cached?.meta?.provider ?? row.provider ?? row.kind ?? "";
  const aliases = Array.isArray(cached?.meta?.aliases) ? cached.meta.aliases.join(" ") : "";
  const context = [
    prTitle,
    prBody,
    cached?.lastUserText,
    cached?.lastAgentFull || row.lastAgentText,
    ...(cached?.meta?.conversation ?? []).slice(-60).map((m) => m?.text),
    ...(state?.questions ?? [])
      .filter((q) => q?.threadKey === row.key || q?.threadKeys?.includes(row.key))
      .map((q) => `${q.title ?? ""}\n${q.body ?? ""}`),
    ...matchingCards.map((c) => `${c.headline ?? ""}\n${c.summary ?? ""}\n${c.agentSummary ?? ""}`)
  ]
    .filter(Boolean)
    .map((text) => bounded(text))
    .join("\n")
    .slice(-120000);

  const metadata = [
    title,
    row.workspace ?? "",
    row.repo ?? "",
    row.branch ?? "",
    allPrRefs.join(" "),
    prTitle,
    provider,
    aliases,
    cached?.meta?.paseoCwd ?? "",
    row.key
  ].join("\n");
  const normTitle = normalize(title);
  const normMeta = normalize(metadata);
  const normContext = normalize(context);
  const haystack = `${normMeta}\n${normContext}`;
  return {
    row,
    cached,
    title,
    prRef: prRef || null,
    prTitle: prTitle || null,
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
    let contentMatchedTerms = 0;
    const dl = Math.max(1, doc.tokens.length);
    for (const term of queryTerms) {
      const inTitle = doc.normTitle.includes(term);
      const inMeta = doc.normMeta.includes(term);
      const inContext = doc.normContext.includes(term);
      if (!inTitle && !inMeta && !inContext) continue;
      matchedTerms += 1;
      if (!PROVIDER_TERMS.has(term)) contentMatchedTerms += 1;
      const termHits = doc.tokens.filter((tok) => tok === term || tok.includes(term)).length || 1;
      const weightedTf = termHits + (inTitle ? 4 : 0) + (inMeta ? 2.5 : 0);
      const idf = Math.log(1 + (N - (df.get(term) ?? 0) + 0.5) / ((df.get(term) ?? 0) + 0.5));
      const tfNorm = (weightedTf * (k1 + 1)) / (weightedTf + k1 * (1 - b + b * (dl / avgDl)));
      score += Math.max(0.25, idf) * tfNorm;
    }
    return { doc, score, matchedTerms, contentMatchedTerms };
  });
}

function inferRepoFromPath(cwd) {
  const clean = String(cwd ?? "").trim();
  if (!clean) return null;
  const parts = clean.split(/[\\/]+/).filter(Boolean);
  const worktreesIdx = parts.lastIndexOf(".worktrees");
  if (worktreesIdx > 0) return parts[worktreesIdx - 1];
  const paseoWtIdx = parts.lastIndexOf("worktrees");
  if (paseoWtIdx >= 0 && parts[paseoWtIdx + 1]) return parts[paseoWtIdx + 1];
  return parts.at(-1) ?? null;
}

function readLocalPaseoCatalog(homeDir) {
  const paseoDir = path.join(homeDir, ".paseo");
  let serverId = "local";
  try {
    const rawId = fs.readFileSync(path.join(paseoDir, "server-id"), "utf8").trim();
    if (rawId) serverId = rawId;
  } catch { /* optional */ }

  const agentsRoot = path.join(paseoDir, "agents");
  const agents = [];
  const byNativeId = new Map();
  let dirs = [];
  try {
    dirs = fs.readdirSync(agentsRoot, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return { serverId, agents, byNativeId };
  }

  for (const dir of dirs) {
    let files = [];
    try {
      files = fs.readdirSync(path.join(agentsRoot, dir.name));
    } catch { continue; }
    for (const name of files) {
      if (!name.endsWith(".json")) continue;
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(agentsRoot, dir.name, name), "utf8"));
        if (!raw || typeof raw.id !== "string") continue;
        const entry = {
          id: raw.id,
          serverId,
          title: typeof raw.title === "string" && raw.title.trim() ? raw.title.trim() : "Paseo chat",
          provider: String(raw.provider ?? "paseo").toLowerCase(),
          cwd: typeof raw.cwd === "string" ? raw.cwd : null,
          workspaceId: typeof raw.workspaceId === "string" ? raw.workspaceId : null,
          archived: Boolean(raw.archivedAt),
          status: typeof raw.status === "string" ? raw.status : "idle",
          updatedAt: raw.updatedAt ?? raw.lastActivityAt ?? raw.createdAt ?? null,
          sessionId: raw.persistence?.sessionId ?? raw.runtimeInfo?.sessionId ?? null,
          handoffSource: raw.labels?.handoff_source ?? null,
          migrationSourceId: raw.labels?.["migration.sourceId"] ?? null,
          migrationAgentId: raw.labels?.["migration.source-agent-id"] ?? null,
          workspaceName: raw.labels?.["migration.conductorWorkspaceName"] ?? null
        };
        agents.push(entry);
        const isHistoryCopy = /^history copy\b/i.test(entry.title);
        for (const nativeId of [entry.sessionId, entry.handoffSource, entry.migrationSourceId, entry.migrationAgentId]) {
          if (!nativeId || typeof nativeId !== "string") continue;
          const prev = byNativeId.get(nativeId);
          if (!prev || (prev.isHistoryCopy && !isHistoryCopy)) {
            byNativeId.set(nativeId, { ...entry, isHistoryCopy });
          }
        }
      } catch { /* ignore unreadable metadata */ }
    }
  }
  return { serverId, agents, byNativeId };
}

function buildFtsMatchExpressions(terms) {
  const safe = terms
    .filter((t) => !PROVIDER_TERMS.has(t))
    .map((t) => t.replace(/[^a-z0-9_]/gi, ""))
    .filter((t) => t.length >= 2)
    .slice(0, 6);
  if (safe.length === 0) return [];
  const quoted = safe.map((t) => `"${t}"*`);
  if (quoted.length === 1) return [quoted[0]];
  if (quoted.length === 2) return [quoted.join(" AND "), quoted.join(" OR ")];
  const pairs = [];
  for (let i = 0; i < quoted.length; i++) {
    for (let j = i + 1; j < quoted.length; j++) {
      pairs.push(`(${quoted[i]} AND ${quoted[j]})`);
    }
  }
  return [quoted.join(" AND "), pairs.join(" OR "), quoted.join(" OR ")];
}

async function queryAntigravitySummaryDb(dbPath, terms) {
  if (!fs.existsSync(dbPath)) return new Map();
  const ftsQueries = buildFtsMatchExpressions(terms);
  if (ftsQueries.length === 0) return new Map();
  const contentTerms = terms.filter((t) => !PROVIDER_TERMS.has(t));
  const excerptTerms = contentTerms.length > 0 ? contentTerms : terms;

  let tmpDir = null;
  let db = null;
  const byConv = new Map();
  try {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-ag-search-"));
    const tmpDb = path.join(tmpDir, "summaries.db");
    for (const ext of ["", "-wal", "-shm"]) {
      if (fs.existsSync(dbPath + ext)) {
        fs.copyFileSync(dbPath + ext, tmpDb + ext);
      }
    }
    db = await openReadOnlyDb(tmpDb);
    if (!db) return byConv;

    const seenRows = new Set();
    for (const expr of ftsQueries) {
      let rows = [];
      try {
        rows = db.prepare(
          "SELECT conversation_id, title, workspace, last_modified_time, user_body, agent_body FROM conversations_fts WHERE conversations_fts MATCH ? ORDER BY bm25(conversations_fts) LIMIT 45"
        ).all(expr);
      } catch { rows = []; }
      for (const r of rows) {
        const cid = typeof r?.conversation_id === "string" ? r.conversation_id.trim() : "";
        if (!cid) continue;
        const userBody = String(r.user_body ?? "");
        const agentBody = String(r.agent_body ?? "");
        const rowSig = `${cid}:${userBody.length}:${agentBody.length}:${userBody.slice(0, 64)}:${agentBody.slice(0, 64)}:${agentBody.slice(-64)}`;
        if (seenRows.has(rowSig)) continue;
        seenRows.add(rowSig);
        const current = byConv.get(cid) ?? {
          id: cid,
          title: "",
          workspace: "",
          updatedAt: null,
          chunks: []
        };
        if (!current.title && r.title) current.title = String(r.title).trim();
        if (!current.workspace && r.workspace) current.workspace = String(r.workspace).trim();
        if (!current.updatedAt && r.last_modified_time) current.updatedAt = String(r.last_modified_time);
        const combined = `${userBody}\n${agentBody}`.trim();
        if (combined && current.chunks.length < 6) {
          current.chunks.push(extractArtifactExcerpt(combined, normalize(combined), excerptTerms, 5000));
        }
        byConv.set(cid, current);
      }
      if (byConv.size >= 12) break;
    }

    if (byConv.size > 0) {
      for (const [cid, info] of byConv) {
        if (info.title && info.updatedAt) continue;
        try {
          const summary = db.prepare(
            "SELECT title, workspace_uris, last_modified_time FROM conversation_summaries WHERE conversation_id = ?"
          ).get(cid);
          if (summary) {
            if (!info.title && summary.title) info.title = String(summary.title).trim();
            if (!info.workspace && summary.workspace_uris) info.workspace = String(summary.workspace_uris).trim();
            if (!info.updatedAt && summary.last_modified_time) info.updatedAt = String(summary.last_modified_time);
          }
        } catch { /* optional table */ }
      }
    }
  } catch {
    // Ignore transient copy/read errors.
  } finally {
    try { db?.close?.(); } catch { /* ignore */ }
    if (tmpDir) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
  return byConv;
}

function extractArtifactExcerpt(text, lower, contentTerms, maxLen = 6000) {
  if (!text || text.length <= maxLen) return String(text ?? "");
  const rawLower = text.toLowerCase();
  const hits = [];
  for (const term of contentTerms.slice(0, 6)) {
    if (!term) continue;
    const rawIdx = rawLower.indexOf(term);
    const idx = rawIdx !== -1 ? rawIdx : lower.indexOf(term);
    if (idx === -1) continue;
    hits.push({ idx, end: Math.min(text.length, idx + term.length) });
  }
  if (hits.length === 0) return text.slice(0, maxLen);
  hits.sort((a, b) => a.idx - b.idx);
  const sep = "\n…\n";
  const sepBudget = Math.max(0, hits.length - 1) * sep.length;
  const perHitBudget = Math.max(120, Math.floor((maxLen - sepBudget) / hits.length));
  const prePad = Math.floor(perHitBudget * 0.4);
  const intervals = [];
  for (const hit of hits) {
    const termLen = Math.max(1, hit.end - hit.idx);
    const postPad = Math.max(40, perHitBudget - prePad - termLen);
    const start = Math.max(0, hit.idx - prePad);
    const end = Math.min(text.length, hit.end + postPad);
    const prev = intervals.at(-1);
    if (prev && start <= prev.end + 24) {
      prev.end = Math.max(prev.end, end);
    } else {
      intervals.push({ start, end });
    }
  }
  return intervals.map(({ start, end }) => text.slice(start, end)).join(sep).slice(0, maxLen);
}

function scanAntigravityBrainDocs(homeDir, terms, existingMap = new Map()) {
  const contentTerms = terms.filter((t) => !PROVIDER_TERMS.has(t));
  if (contentTerms.length === 0) return existingMap;

  for (const sub of [".gemini/antigravity-cli/brain", ".gemini/antigravity/brain"]) {
    const brainRoot = path.join(homeDir, sub);
    let convDirs = [];
    try {
      convDirs = fs.readdirSync(brainRoot, { withFileTypes: true }).filter((d) => d.isDirectory());
    } catch { continue; }

    for (const d of convDirs) {
      const cid = d.name;
      const convPath = path.join(brainRoot, cid);
      const mdFiles = [];
      for (const relDir of ["", "scratch"]) {
        const target = relDir ? path.join(convPath, relDir) : convPath;
        let entries = [];
        try {
          entries = fs.readdirSync(target, { withFileTypes: true });
        } catch { continue; }
        for (const e of entries) {
          if (e.isFile() && e.name.endsWith(".md")) {
            mdFiles.push(path.join(target, e.name));
          }
        }
      }
      for (const fp of mdFiles.slice(0, 12)) {
        try {
          const st = fs.statSync(fp);
          if (st.size > 512 * 1024) continue;
          const text = fs.readFileSync(fp, "utf8");
          const lower = normalize(text);
          if (!contentTerms.some((t) => lower.includes(t))) continue;
          const cur = existingMap.get(cid) ?? {
            id: cid,
            title: "",
            workspace: "",
            updatedAt: new Date(st.mtimeMs).toISOString(),
            chunks: []
          };
          if (cur.chunks.length < 8) {
            cur.chunks.push(extractArtifactExcerpt(text, lower, contentTerms, 6000));
          }
          existingMap.set(cid, cur);
        } catch { /* ignore */ }
      }
    }
  }
  return existingMap;
}

function buildArchiveThreadEntry(cid, info, paseoCatalog) {
  const cleanChunks = (info.chunks ?? []).map((c) => redactSecrets(String(c ?? "")).trim()).filter(Boolean);
  const combinedText = cleanChunks.join("\n\n").slice(-24000);
  const conversation = cleanChunks.map((text) => ({ role: "assistant", text }));
  const linkedPaseo = paseoCatalog.byNativeId.get(cid) ?? null;
  if (linkedPaseo) {
    const key = `paseo:${linkedPaseo.serverId}.${linkedPaseo.id}`;
    const repo = inferRepoFromPath(linkedPaseo.cwd);
    return [
      key,
      {
        key,
        kind: "paseo",
        id: linkedPaseo.id,
        title: clampText(linkedPaseo.title || info.title || `Antigravity ${cid.slice(0, 8)}`, 120),
        workspace: linkedPaseo.cwd ? path.basename(linkedPaseo.cwd) : null,
        repo,
        branch: null,
        agentStatus: linkedPaseo.archived ? "closed" : linkedPaseo.status,
        state: linkedPaseo.archived ? "archived" : linkedPaseo.status,
        live: linkedPaseo.status === "running",
        lastActivityAt: linkedPaseo.updatedAt ?? info.updatedAt ?? null,
        lastAgentText: combinedText.slice(-600),
        lastAgentFull: combinedText,
        meta: {
          serverId: linkedPaseo.serverId,
          provider: linkedPaseo.provider || "antigravity",
          paseoCwd: linkedPaseo.cwd,
          aliases: [`antigravity:${cid}`],
          conversation
        }
      }
    ];
  }

  const key = `antigravity:${cid}`;
  const cleanWorkspace = String(info.workspace ?? "").replace(/^[\s["']+|[\s\]"']+$/g, "").replace(/^file:\/\//, "").split(/[,\s"'\]]+/)[0] || null;
  const repo = inferRepoFromPath(cleanWorkspace);
  return [
    key,
    {
      key,
      kind: "antigravity",
      id: cid,
      title: clampText(info.title || `Antigravity ${cid.slice(0, 8)}`, 120),
      workspace: cleanWorkspace ? path.basename(cleanWorkspace) : null,
      repo,
      branch: null,
      agentStatus: "idle",
      state: "idle",
      live: false,
      lastActivityAt: info.updatedAt ?? null,
      lastAgentText: combinedText.slice(-600),
      lastAgentFull: combinedText,
      meta: {
        provider: "antigravity",
        aliases: [`antigravity:${cid}`],
        conversation
      }
    }
  ];
}

function upsertArchiveEntry(map, key, next) {
  const prev = map.get(key);
  if (!prev) {
    map.set(key, next);
    return;
  }
  const prevFull = prev.lastAgentFull || "";
  const nextFull = next.lastAgentFull || "";
  const mergedFull = prevFull && nextFull
    ? (prevFull.includes(nextFull) ? prevFull : `${prevFull}\n\n${nextFull}`.slice(-24000))
    : (prevFull || nextFull);
  const prRefs = [...new Set([...(prev.prRefs ?? []), ...(next.prRefs ?? [])])].slice(0, 8);
  const seenTexts = new Set();
  const conversation = [...(prev.meta?.conversation ?? []), ...(next.meta?.conversation ?? [])].filter((m) => {
    const t = String(m?.text ?? "").trim();
    if (!t || seenTexts.has(t)) return false;
    seenTexts.add(t);
    return true;
  });
  map.set(key, {
    ...prev,
    ...next,
    title: prev.title && prev.title !== "Paseo chat" ? prev.title : (next.title || prev.title),
    workspace: prev.workspace ?? next.workspace ?? null,
    repo: prRefs[0]?.split("#")[0] ?? prev.repo ?? next.repo ?? null,
    prRefs,
    live: Boolean(prev.live || next.live),
    lastActivityAt: String(next.lastActivityAt ?? "") > String(prev.lastActivityAt ?? "")
      ? next.lastActivityAt
      : (prev.lastActivityAt ?? next.lastActivityAt ?? null),
    lastAgentText: mergedFull ? mergedFull.slice(-600) : (prev.lastAgentText || next.lastAgentText || ""),
    lastAgentFull: mergedFull,
    meta: {
      ...(prev.meta ?? {}),
      ...(next.meta ?? {}),
      aliases: [...new Set([...(prev.meta?.aliases ?? []), ...(next.meta?.aliases ?? [])])],
      conversation
    }
  });
}

const SSH_ARCHIVE_SEARCH_PY = `
import base64, glob, json, os, re, shutil, sqlite3, sys, tempfile

payload = json.loads(base64.b64decode(sys.argv[2]).decode("utf-8"))
terms = [str(t).lower() for t in payload.get("terms", []) if str(t).strip()]
content_terms = [t for t in terms if t not in ("antigravity", "claude", "codex", "conductor", "paseo")]
safe_fts = ["".join(ch for ch in t if ch.isalnum() or ch == "_") for t in content_terms]
safe_fts = [t for t in safe_fts if len(t) >= 2][:8]

home = os.path.expanduser("~")
server_id = "remote"
sid_file = os.path.join(home, ".paseo", "server-id")
if os.path.exists(sid_file):
    try:
        server_id = open(sid_file, "r", encoding="utf-8", errors="ignore").read().strip() or "remote"
    except Exception:
        pass

def read_head_tail(fp, head_b=131072, tail_b=393216):
    try:
        sz = os.path.getsize(fp)
        if sz <= 0:
            return ""
        with open(fp, "rb") as f:
            if sz <= head_b + tail_b:
                return f.read().decode("utf-8", "ignore")
            h = f.read(head_b).decode("utf-8", "ignore")
            f.seek(max(0, sz - tail_b))
            t = f.read().decode("utf-8", "ignore")
            return h + "\\n" + t
    except Exception:
        return ""

def excerpt(txt, max_len=4500):
    if not txt:
        return ""
    if len(txt) <= max_len:
        return txt
    low = txt.lower()
    q_terms = (content_terms or terms)[:6]
    hits = []
    for t in q_terms:
        if not t:
            continue
        pos = low.find(t)
        if pos != -1:
            hits.append((pos, min(len(txt), pos + len(t))))
    if not hits:
        return txt[:max_len]
    hits.sort(key=lambda x: x[0])
    sep = "\\n...\\n"
    per_hit = max(120, (max_len - max(0, len(hits) - 1) * len(sep)) // len(hits))
    pre_pad = int(per_hit * 0.4)
    intervals = []
    for s_idx, e_idx in hits:
        post_pad = max(40, per_hit - pre_pad - max(1, e_idx - s_idx))
        st = max(0, s_idx - pre_pad)
        en = min(len(txt), e_idx + post_pad)
        if intervals and st <= intervals[-1][1] + 24:
            intervals[-1][1] = max(intervals[-1][1], en)
        else:
            intervals.append([st, en])
    return sep.join(txt[st:en] for st, en in intervals)[:max_len]

def extract_prs(txt):
    seen = []
    hits = []
    skip = {"src", "app", "packages", "apps", "lib", "test", "tests", "server", "client", "docs", "scripts"}
    for m in re.finditer(r"https://github\\.com/([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)/pull/(\\d+)", txt):
        r, n = m.group(1), m.group(2)
        if r.split("/")[0].lower() not in skip:
            hits.append((m.start(), r + "#" + n))
    for m in re.finditer(r"(?<![A-Za-z0-9_./:-])([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)#(\\d+)\\b", txt):
        r, n = m.group(1), m.group(2)
        if r.split("/")[0].lower() not in skip:
            hits.append((m.start(), r + "#" + n))
    hits.sort(key=lambda x: x[0])
    for _, ref in hits:
        if ref in seen:
            seen.remove(ref)
        seen.append(ref)
    seen.reverse()
    return seen[:8]

by_native = {}
paseo_agents = []
for p in glob.glob(os.path.join(home, ".paseo", "agents", "*", "*.json")):
    try:
        raw = json.load(open(p, "r", encoding="utf-8", errors="ignore"))
        if not isinstance(raw, dict) or not raw.get("id"):
            continue
        title = (raw.get("title") or "Paseo chat").strip()
        labels = raw.get("labels") or {}
        pers = raw.get("persistence") or {}
        entry = {
            "id": raw["id"],
            "serverId": server_id,
            "title": title,
            "provider": str(raw.get("provider") or "paseo").lower(),
            "cwd": raw.get("cwd"),
            "sessionId": pers.get("sessionId"),
            "workspaceName": labels.get("migration.conductorWorkspaceName"),
            "archived": bool(raw.get("archivedAt")),
            "status": str(raw.get("status") or "idle"),
            "updatedAt": raw.get("updatedAt") or raw.get("lastActivityAt") or raw.get("createdAt"),
            "isHistoryCopy": title.lower().startswith("history copy")
        }
        paseo_agents.append(entry)
        for nid in (pers.get("sessionId"), labels.get("handoff_source"), labels.get("migration.sourceId"), labels.get("migration.source-agent-id")):
            if isinstance(nid, str) and nid:
                prev = by_native.get(nid)
                if not prev or (prev["isHistoryCopy"] and not entry["isHistoryCopy"]):
                    by_native[nid] = entry
    except Exception:
        pass

hits = {}
seen_fts_rows = set()
if safe_fts:
    quoted = ['"' + t + '"*' for t in safe_fts[:6]]
    if len(quoted) == 1:
        exprs = [quoted[0]]
    elif len(quoted) == 2:
        exprs = [" AND ".join(quoted), " OR ".join(quoted)]
    else:
        pairs = ["(" + quoted[i] + " AND " + quoted[j] + ")" for i in range(len(quoted)) for j in range(i + 1, len(quoted))]
        exprs = [" AND ".join(quoted), " OR ".join(pairs), " OR ".join(quoted)]
    for rel_db in (".gemini/antigravity/conversation_summaries.db", ".gemini/antigravity-cli/conversation_summaries.db"):
        src = os.path.join(home, rel_db)
        if not os.path.exists(src):
            continue
        try:
            with tempfile.TemporaryDirectory() as td:
                dst = os.path.join(td, "s.db")
                for ext in ("", "-wal", "-shm"):
                    if os.path.exists(src + ext):
                        shutil.copy2(src + ext, dst + ext)
                con = sqlite3.connect(dst)
                cur = con.cursor()
                for expr in exprs:
                    try:
                        rows = cur.execute(
                            "SELECT conversation_id, title, workspace, last_modified_time, user_body, agent_body FROM conversations_fts WHERE conversations_fts MATCH ? ORDER BY bm25(conversations_fts) LIMIT 35",
                            (expr,),
                        ).fetchall()
                    except Exception:
                        rows = []
                    for cid, title, ws, lmt, ub, ab in rows:
                        if not cid:
                            continue
                        ub_s = ub or ""
                        ab_s = ab or ""
                        sig = (cid, len(ub_s), len(ab_s), ub_s[:48], ab_s[:48], ab_s[-48:])
                        if sig in seen_fts_rows:
                            continue
                        seen_fts_rows.add(sig)
                        rec = hits.setdefault(cid, {"id": cid, "title": title or "", "workspace": ws or "", "updatedAt": lmt, "chunks": []})
                        if not rec["title"] and title:
                            rec["title"] = title
                        if not rec["workspace"] and ws:
                            rec["workspace"] = ws
                        if not rec["updatedAt"] and lmt:
                            rec["updatedAt"] = lmt
                        combined = (ub_s + "\\n" + ab_s).strip()
                        if combined and len(rec["chunks"]) < 6:
                            rec["chunks"].append(excerpt(combined, 4500))
                    if len(hits) >= 12:
                        break
                con.close()
        except Exception:
            pass

brain_scanned = 0
for rel_brain in (".gemini/antigravity-cli/brain", ".gemini/antigravity/brain"):
    if brain_scanned >= 160:
        break
    root = os.path.join(home, rel_brain)
    if not os.path.isdir(root):
        continue
    for d in os.listdir(root):
        if brain_scanned >= 160:
            break
        cdir = os.path.join(root, d)
        if not os.path.isdir(cdir):
            continue
        for sub in ("", "scratch"):
            tdir = os.path.join(cdir, sub) if sub else cdir
            if not os.path.isdir(tdir):
                continue
            for fn in os.listdir(tdir)[:8]:
                if not fn.endswith(".md"):
                    continue
                brain_scanned += 1
                fp = os.path.join(tdir, fn)
                try:
                    if os.path.getsize(fp) > 512 * 1024:
                        continue
                    txt = open(fp, "r", encoding="utf-8", errors="ignore").read()
                    low = txt.lower()
                    if content_terms and any(t in low for t in content_terms):
                        rec = hits.setdefault(d, {"id": d, "title": "", "workspace": "", "updatedAt": None, "chunks": []})
                        if len(rec["chunks"]) < 6:
                            rec["chunks"].append(excerpt(txt, 5000))
                except Exception:
                    pass

out = []
seen_paseo_ids = set()
for cid, rec in list(hits.items())[:25]:
    linked_pa = by_native.get(cid)
    if linked_pa and linked_pa.get("id"):
        seen_paseo_ids.add(linked_pa["id"])
    out.append({"cid": cid, "rec": rec, "paseo": linked_pa})
matched_paseo = []
for pa in paseo_agents:
    if pa["id"] in seen_paseo_ids:
        continue
    hay = (pa["title"] + " " + (pa["cwd"] or "") + " " + (pa.get("workspaceName") or "") + " " + pa["provider"]).lower()
    cnt = sum(1 for t in content_terms if t in hay) if content_terms else 0
    if cnt > 0:
        seen_paseo_ids.add(pa["id"])
        matched_paseo.append((cnt, pa))
matched_paseo.sort(key=lambda x: (x[0], x[1].get("updatedAt") or ""), reverse=True)
codex_files = None
for _, pa in matched_paseo[:20]:
    rec = None
    sid = pa.get("sessionId")
    cwd = pa.get("cwd") or ""
    if isinstance(sid, str) and sid:
        if cwd:
            slug = re.sub("[^A-Za-z0-9_-]", "-", cwd)
            cf = os.path.join(home, ".claude", "projects", slug, sid + ".jsonl")
            if os.path.isfile(cf):
                sample = read_head_tail(cf)
                if sample:
                    prs = extract_prs(sample)
                    rec = {"id": sid, "title": pa["title"], "workspace": cwd, "updatedAt": pa.get("updatedAt"), "chunks": [excerpt(sample, 6000)], "prRefs": prs}
        if rec is None and re.match(r"^[A-Za-z0-9_.-]+$", sid):
            if codex_files is None:
                codex_files = sorted(glob.glob(os.path.join(home, ".codex", "sessions", "*", "*", "*", "*.jsonl")), reverse=True)[:400]
            for cxf in codex_files:
                if sid in os.path.basename(cxf):
                    sample = read_head_tail(cxf)
                    if sample:
                        prs = extract_prs(sample)
                        rec = {"id": sid, "title": pa["title"], "workspace": cwd, "updatedAt": pa.get("updatedAt"), "chunks": [excerpt(sample, 6000)], "prRefs": prs}
                    break
    out.append({"cid": sid, "rec": rec, "paseo": pa})
print(json.dumps(out[:45]))
`.trim();

async function queryRemotePaseoSshArchives(homeDir, terms, execFileImpl = execFileAsync) {
  const hostsFile = path.join(homeDir, ".paseo", "hosts.json");
  let hosts = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(hostsFile, "utf8"));
    if (Array.isArray(parsed)) hosts = parsed;
  } catch {
    return new Map();
  }

  const sshTargets = [];
  for (const h of hosts) {
    if (!h?.enabled) continue;
    const conn = typeof h.connection === "string" ? h.connection.trim() : "";
    if (!conn.startsWith("ssh://")) continue;
    const rawHost = conn.slice("ssh://".length).split(/[/?#]/)[0].trim();
    if (!rawHost || rawHost.startsWith("-") || !/^[A-Za-z0-9._@-]{1,80}$/.test(rawHost)) continue;
    sshTargets.push({ host: rawHost, serverId: h.serverId || "remote", label: h.label || rawHost });
  }

  const scriptB64 = Buffer.from(SSH_ARCHIVE_SEARCH_PY, "utf8").toString("base64");
  const payloadB64 = Buffer.from(JSON.stringify({ terms }), "utf8").toString("base64");
  const remoteCmd = `python3 -c 'import base64,sys;exec(base64.b64decode(sys.argv[1]).decode())' ${scriptB64} ${payloadB64}`;
  const ctlDir = path.join(homeDir, ".ssh", "openagi-cm");
  try {
    fs.mkdirSync(ctlDir, { recursive: true, mode: 0o700 });
  } catch { /* optional multiplexing dir */ }
  const sshControlArgs = fs.existsSync(ctlDir)
    ? ["-o", "ControlMaster=auto", "-S", path.join(ctlDir, "%C"), "-o", "ControlPersist=30m"]
    : [];

  const out = new Map();
  await Promise.all(sshTargets.slice(0, 3).map(async ({ host, serverId: fallbackServerId }) => {
    try {
      const { stdout } = await execFileImpl(
        "ssh",
        ["-n", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", ...sshControlArgs, host, remoteCmd],
        { timeout: 25000, maxBuffer: 2 * 1024 * 1024 }
      );
      const items = JSON.parse(String(stdout ?? "[]"));
      if (!Array.isArray(items)) return;
      for (const item of items) {
        const linked = item?.paseo ?? null;
        const rec = item?.rec ?? null;
        const cid = item?.cid ?? null;
        const cleanChunks = (rec?.chunks ?? []).map((c) => redactSecrets(String(c ?? "")).trim()).filter(Boolean);
        const combinedText = cleanChunks.join("\n\n").slice(-24000);
        const conversation = cleanChunks.map((text) => ({ role: "assistant", text }));
        if (linked?.id) {
          const sid = linked.serverId || fallbackServerId;
          const key = `paseo:${sid}.${linked.id}`;
          const prRefs = Array.isArray(rec?.prRefs) ? rec.prRefs.slice(0, 8) : [];
          upsertArchiveEntry(out, key, {
            key,
            kind: "paseo",
            id: linked.id,
            title: clampText(linked.title || rec?.title || "Paseo chat", 120),
            workspace: linked.workspaceName || (linked.cwd ? path.basename(linked.cwd) : null),
            repo: prRefs[0]?.split("#")[0] ?? inferRepoFromPath(linked.cwd),
            branch: null,
            prRefs,
            agentStatus: linked.archived ? "closed" : (linked.status || "idle"),
            state: linked.archived ? "archived" : (linked.status || "idle"),
            live: linked.status === "running",
            lastActivityAt: linked.updatedAt ?? rec?.updatedAt ?? null,
            lastAgentText: combinedText.slice(-600),
            lastAgentFull: combinedText,
            meta: {
              serverId: sid,
              provider: linked.provider || "paseo",
              paseoCwd: linked.cwd ?? null,
              aliases: cid ? [`${linked.provider || "antigravity"}:${cid}`] : [],
              conversation
            }
          });
        } else if (cid && rec) {
          const key = `antigravity:${cid}`;
          upsertArchiveEntry(out, key, {
            key,
            kind: "antigravity",
            id: cid,
            title: clampText(rec.title || `Antigravity ${String(cid).slice(0, 8)}`, 120),
            workspace: null,
            repo: inferRepoFromPath(rec.workspace),
            branch: null,
            agentStatus: "idle",
            state: "idle",
            live: false,
            lastActivityAt: rec.updatedAt ?? null,
            lastAgentText: combinedText.slice(-600),
            lastAgentFull: combinedText,
            meta: {
              provider: "antigravity",
              aliases: [`antigravity:${cid}`],
              conversation
            }
          });
        }
      }
    } catch {
      // Offline/unreachable SSH host never blocks fleet search.
    }
  }));
  return out;
}

export async function collectArchiveThreads({
  query,
  homeDir = os.homedir(),
  includeRemotePaseoHosts = false,
  execFileImpl = execFileAsync
} = {}) {
  const { effectiveTerms } = extractQueryTerms(query, { natural: true });
  if (effectiveTerms.length === 0) return new Map();

  const paseoCatalog = readLocalPaseoCatalog(homeDir);
  const [agDesktop, agCli, remoteMap] = await Promise.all([
    queryAntigravitySummaryDb(path.join(homeDir, ".gemini", "antigravity", "conversation_summaries.db"), effectiveTerms),
    queryAntigravitySummaryDb(path.join(homeDir, ".gemini", "antigravity-cli", "conversation_summaries.db"), effectiveTerms),
    includeRemotePaseoHosts ? queryRemotePaseoSshArchives(homeDir, effectiveTerms, execFileImpl) : Promise.resolve(new Map())
  ]);

  const mergedAg = new Map(agDesktop);
  for (const [cid, info] of agCli) {
    const existing = mergedAg.get(cid);
    if (!existing) {
      mergedAg.set(cid, info);
    } else {
      if (!existing.title && info.title) existing.title = info.title;
      if (!existing.workspace && info.workspace) existing.workspace = info.workspace;
      existing.chunks = [...existing.chunks, ...info.chunks].slice(0, 8);
    }
  }
  scanAntigravityBrainDocs(homeDir, effectiveTerms, mergedAg);

  const archiveThreads = new Map(remoteMap);
  for (const [cid, info] of mergedAg) {
    const [key, thread] = buildArchiveThreadEntry(cid, info, paseoCatalog);
    upsertArchiveEntry(archiveThreads, key, thread);
  }

  const contentTerms = effectiveTerms.filter((t) => !PROVIDER_TERMS.has(t));
  if (contentTerms.length > 0) {
    const matchedMeta = [];
    for (const entry of paseoCatalog.agents) {
      const key = `paseo:${entry.serverId}.${entry.id}`;
      if (archiveThreads.has(key)) continue;
      const hay = normalize(`${entry.title} ${entry.cwd ?? ""} ${entry.workspaceName ?? ""} ${entry.provider}`);
      const hitCount = contentTerms.filter((t) => hay.includes(t)).length;
      if (hitCount > 0) matchedMeta.push({ hitCount, entry, key });
    }
    matchedMeta.sort((a, b) => b.hitCount - a.hitCount || String(b.entry.updatedAt ?? "").localeCompare(String(a.entry.updatedAt ?? "")));
    for (const [idx, { entry, key }] of matchedMeta.entries()) {
      let prRefs = [];
      let combinedText = "";
      if (idx < 16 && entry.sessionId) {
        const cf = resolveClaudeTranscriptPath(homeDir, entry.cwd, entry.sessionId);
        if (cf) {
          const sample = readBoundedHeadTail(cf);
          if (sample) {
            prRefs = extractTranscriptPrRefs(sample);
            const cleanText = extractReadableJsonlLines(sample) || sample.slice(-12000);
            const lowerClean = normalize(cleanText);
            combinedText = redactSecrets(extractArtifactExcerpt(cleanText, lowerClean, contentTerms, 8000));
          }
        }
      }
      archiveThreads.set(key, {
        key,
        kind: "paseo",
        id: entry.id,
        title: clampText(entry.title, 120),
        workspace: entry.workspaceName || (entry.cwd ? path.basename(entry.cwd) : null),
        repo: prRefs[0]?.split("#")[0] ?? inferRepoFromPath(entry.cwd),
        branch: null,
        prRefs,
        agentStatus: entry.archived ? "closed" : entry.status,
        state: entry.archived ? "archived" : entry.status,
        live: entry.status === "running",
        lastActivityAt: entry.updatedAt ?? null,
        lastAgentText: combinedText.slice(-600),
        lastAgentFull: combinedText,
        meta: {
          serverId: entry.serverId,
          provider: entry.provider,
          paseoCwd: entry.cwd,
          aliases: [entry.sessionId, entry.handoffSource, entry.migrationSourceId, entry.migrationAgentId]
            .filter(Boolean)
            .map((id) => `${entry.provider}:${id}`),
          conversation: combinedText ? [{ role: "assistant", text: combinedText }] : []
        }
      });
    }

    const recentClaude = scanRecentClaudeTranscripts(homeDir, contentTerms, paseoCatalog, 40);
    for (const [key, thread] of recentClaude) {
      if (!archiveThreads.has(key)) archiveThreads.set(key, thread);
    }
  }

  return archiveThreads;
}

export function mergeThreadsWithArchives(liveThreads = new Map(), archiveThreads = new Map(), { existingOnly = false } = {}) {
  if (!archiveThreads || archiveThreads.size === 0) return liveThreads ?? new Map();
  const merged = new Map(liveThreads ?? []);
  for (const [key, arch] of archiveThreads) {
    const existing = merged.get(key);
    if (!existing) {
      if (!existingOnly) merged.set(key, arch);
      continue;
    }
    const archText = arch?.lastAgentFull || arch?.lastAgentText || "";
    const mergedPrRefs = [...new Set([...(existing.prRefs ?? []), ...(arch?.prRefs ?? [])])];
    if (!archText && mergedPrRefs.length === (existing.prRefs ?? []).length) continue;
    merged.set(key, {
      ...existing,
      prRefs: mergedPrRefs,
      repo: existing.repo ?? arch?.repo ?? null,
      lastAgentFull: archText ? (existing.lastAgentFull ? `${archText}\n${existing.lastAgentFull}` : archText) : existing.lastAgentFull,
      meta: {
        ...(existing.meta ?? {}),
        provider: existing.meta?.provider ?? arch.meta?.provider,
        aliases: [...new Set([...(existing.meta?.aliases ?? []), ...(arch.meta?.aliases ?? [])])],
        conversation: [
          ...(arch.meta?.conversation ?? []),
          ...(existing.meta?.conversation ?? [])
        ]
      }
    });
  }
  return merged;
}

export function searchFleet(state, { query, limit = 20, natural = false, includeScores = false } = {}, cachedThreads = new Map()) {
  if (typeof query !== "string" || !query.trim() || query.length > 300) {
    throw new Error("Query must be 1-300 characters.");
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new Error("Limit must be 1-50.");
  }
  const { rawTerms, effectiveTerms, useNaturalSubset } = extractQueryTerms(query, { natural });
  const nonProviderCount = effectiveTerms.filter((t) => !PROVIDER_TERMS.has(t)).length;

  const rows = buildRows(state, cachedThreads);
  const docs = rows.map((row) => buildRowDocument(row, state, cachedThreads));
  const withContext = docs.filter((d) => Boolean(d.context)).length;

  // Queries made only of punctuation (e.g. "[.*") that match literal substring
  // nowhere must return 0 cleanly.
  const scored = computeBm25Scores(docs, effectiveTerms);
  const matches = [];
  for (const { doc, score, matchedTerms, contentMatchedTerms } of scored) {
    const allRawMatch = rawTerms.length > 0 && rawTerms.every((term) => doc.haystack.includes(term));
    const minRequired = useNaturalSubset && effectiveTerms.length >= 2
      ? Math.max(2, Math.ceil(effectiveTerms.length * 0.45))
      : effectiveTerms.length;
    const strongTwoTermPartial = useNaturalSubset
      && effectiveTerms.length === 2
      && matchedTerms === 1
      && contentMatchedTerms >= 1
      && effectiveTerms.some((t) => !PROVIDER_TERMS.has(t) && t.length >= 4 && (doc.normTitle.includes(t) || doc.normMeta.includes(t) || score >= 2.2));

    if (!allRawMatch && !(useNaturalSubset && matchedTerms >= minRequired) && !strongTwoTermPartial) continue;
    // Never match solely on a provider name like "antigravity" when the query also has subject terms.
    if (nonProviderCount > 0 && contentMatchedTerms === 0) continue;

    const nonProviderTerms = effectiveTerms.filter((t) => !PROVIDER_TERMS.has(t));
    const snippetTerms = nonProviderTerms.length > 0 ? nonProviderTerms : effectiveTerms;
    const snippetLine = doc.context
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .find((line) => snippetTerms.some((term) => normalize(line).includes(term)))
      || doc.row.reason
      || doc.title;

    const liveBonus = doc.row.live || doc.row.agentStatus === "running" ? 1.5 : 0;
    const exactBonus = allRawMatch ? 6 : 0;
    const coverageBonus = matchedTerms > 1 ? matchedTerms * 2.5 : 0;

    matches.push({
      key: doc.row.key,
      title: doc.title,
      repo: doc.row.repo ?? null,
      branch: doc.row.branch ?? null,
      prRef: doc.prRef,
      prTitle: doc.prTitle ?? null,
      live: Boolean(doc.row.live || doc.row.agentStatus === "running"),
      state: doc.row.state ?? "unknown",
      lastActivityAt: doc.row.lastActivityAt ?? null,
      snippet: bounded(snippetLine, 500),
      openChat: doc.row.openChat ?? null,
      score: score + exactBonus + liveBonus + coverageBonus,
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
    scope: "Supervisor scan, cached recent messages, and local/Paseo Antigravity FTS5 & artifact archives."
  };
}

export function rankCombinedSearchResults(rows = [], query = "") {
  const weights = { title: 4.5, prTitle: 3.5, workspace: 2.5, repo: 2.5, branch: 2.5, pr: 3, text: 1.5 };
  const qLower = normalize(String(query ?? "").trim());
  const { effectiveTerms } = extractQueryTerms(query, { natural: true });
  const contentTerms = effectiveTerms.filter((t) => !PROVIDER_TERMS.has(t));
  const terms = contentTerms.length > 0 ? contentTerms : effectiveTerms;
  const byKey = new Map();
  for (const row of rows) {
    if (!row?.key) continue;
    const fields = {
      title: normalize(row.title),
      prTitle: normalize(row.prTitle),
      workspace: normalize(row.workspace),
      repo: normalize(row.repo),
      branch: normalize(row.branch),
      pr: normalize(row.prRef),
      text: normalize(row.snippet)
    };
    let score = typeof row.score === "number" && Number.isFinite(row.score) ? row.score : 0;
    if (score === 0 && terms.length > 0) {
      for (const term of terms) {
        let hit = 0;
        for (const [field, weight] of Object.entries(weights)) {
          if ((fields[field] ?? "").includes(term)) hit += weight;
        }
        score += hit;
      }
      if (qLower && qLower.length >= 3) {
        if (fields.title.includes(qLower) || fields.prTitle.includes(qLower) || fields.pr.includes(qLower) || fields.branch.includes(qLower)) score += 6;
        else if (fields.text.includes(qLower)) score += 4;
      }
      if (row.live) score += 0.4;
      if (!["done", "excluded", "archived"].includes(row.state)) score += 0.3;
    }
    const prev = byKey.get(row.key);
    if (!prev || score > prev.score) {
      const { score: _omit, ...cleanRow } = row;
      byKey.set(row.key, { score, row: cleanRow });
    }
  }
  return [...byKey.values()]
    .sort(
      (a, b) =>
        b.score - a.score
        || String(b.row.lastActivityAt ?? "").localeCompare(String(a.row.lastActivityAt ?? ""))
        || a.row.key.localeCompare(b.row.key)
    )
    .map((entry) => entry.row);
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
