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
  return [...byKey.values()];
}

function buildRowDocument(row, state, cachedThreads = new Map()) {
  const cached = cachedThreads?.get?.(row.key) ?? null;
  const title = bounded(row.title || row.workspace || row.key, 300);
  const prRef = row.pr?.ref ?? cached?.prRefs?.[0] ?? "";
  const prTitle = bounded(row.pr?.title ?? "", 200);
  const provider = cached?.meta?.provider ?? row.provider ?? row.kind ?? "";
  const aliases = Array.isArray(cached?.meta?.aliases) ? cached.meta.aliases.join(" ") : "";
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

  const metadata = [
    title,
    row.workspace ?? "",
    row.repo ?? "",
    row.branch ?? "",
    prRef,
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
          migrationSourceId: raw.labels?.["migration.sourceId"] ?? null
        };
        agents.push(entry);
        const isHistoryCopy = /^history copy\b/i.test(entry.title);
        for (const nativeId of [entry.sessionId, entry.handoffSource, entry.migrationSourceId]) {
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
          "SELECT conversation_id, title, workspace, last_modified_time, substr(user_body, 1, 2000) AS user_body, substr(agent_body, 1, 4000) AS agent_body FROM conversations_fts WHERE conversations_fts MATCH ? ORDER BY bm25(conversations_fts) LIMIT 45"
        ).all(expr);
      } catch { rows = []; }
      for (const r of rows) {
        const cid = typeof r?.conversation_id === "string" ? r.conversation_id.trim() : "";
        if (!cid) continue;
        const rowSig = `${cid}:${String(r.agent_body ?? "").slice(0, 80)}`;
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
        if (current.chunks.length < 6) {
          current.chunks.push(`${r.user_body ?? ""}\n${r.agent_body ?? ""}`.trim());
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
  const windows = [];
  for (const term of contentTerms) {
    const idx = lower.indexOf(term);
    if (idx === -1) continue;
    const start = Math.max(0, idx - 1200);
    const end = Math.min(text.length, idx + term.length + 1800);
    windows.push(text.slice(start, end));
    if (windows.length >= 3) break;
  }
  if (windows.length === 0) return text.slice(0, maxLen);
  return windows.join("\n…\n").slice(0, maxLen);
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
  const linkedPaseo = paseoCatalog.byNativeId.get(cid) ?? null;
  if (linkedPaseo) {
    const key = `paseo:${linkedPaseo.serverId}.${linkedPaseo.id}`;
    const repo = inferRepoFromPath(linkedPaseo.cwd);
    const combinedText = redactSecrets(info.chunks.join("\n\n")).slice(-24000);
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
          conversation: [{ role: "assistant", text: combinedText }]
        }
      }
    ];
  }

  const key = `antigravity:${cid}`;
  const cleanWorkspace = String(info.workspace ?? "").replace(/^[\s["']+|[\s\]"']+$/g, "").replace(/^file:\/\//, "").split(/[,\s"'\]]+/)[0] || null;
  const repo = inferRepoFromPath(cleanWorkspace);
  const combinedText = redactSecrets(info.chunks.join("\n\n")).slice(-24000);
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
        conversation: [{ role: "assistant", text: combinedText }]
      }
    }
  ];
}

const SSH_ARCHIVE_SEARCH_PY = `
import base64, glob, json, os, shutil, sqlite3, sys, tempfile

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

by_native = {}
paseo_agents = []
for p in glob.glob(os.path.join(home, ".paseo", "agents", "*", "*.json")):
    try:
        raw = json.load(open(p, "r", encoding="utf-8", errors="ignore"))
        if not isinstance(raw, dict) or not raw.get("id"):
            continue
        title = (raw.get("title") or "Paseo chat").strip()
        entry = {
            "id": raw["id"],
            "serverId": server_id,
            "title": title,
            "provider": str(raw.get("provider") or "paseo").lower(),
            "cwd": raw.get("cwd"),
            "archived": bool(raw.get("archivedAt")),
            "status": str(raw.get("status") or "idle"),
            "updatedAt": raw.get("updatedAt") or raw.get("lastActivityAt") or raw.get("createdAt"),
            "isHistoryCopy": title.lower().startswith("history copy")
        }
        paseo_agents.append(entry)
        labels = raw.get("labels") or {}
        pers = raw.get("persistence") or {}
        for nid in (pers.get("sessionId"), labels.get("handoff_source"), labels.get("migration.sourceId")):
            if isinstance(nid, str) and nid:
                prev = by_native.get(nid)
                if not prev or (prev["isHistoryCopy"] and not entry["isHistoryCopy"]):
                    by_native[nid] = entry
    except Exception:
        pass

hits = {}
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
                            "SELECT conversation_id, title, workspace, last_modified_time, substr(user_body, 1, 1500), substr(agent_body, 1, 3000) FROM conversations_fts WHERE conversations_fts MATCH ? ORDER BY bm25(conversations_fts) LIMIT 35",
                            (expr,),
                        ).fetchall()
                    except Exception:
                        rows = []
                    for cid, title, ws, lmt, ub, ab in rows:
                        if not cid:
                            continue
                        rec = hits.setdefault(cid, {"id": cid, "title": title or "", "workspace": ws or "", "updatedAt": lmt, "chunks": []})
                        if len(rec["chunks"]) < 5:
                            rec["chunks"].append(((ub or "") + "\\n" + (ab or "")).strip())
                    if len(hits) >= 12:
                        break
                con.close()
        except Exception:
            pass

brain_scanned = 0
for rel_brain in (".gemini/antigravity-cli/brain", ".gemini/antigravity/brain"):
    if len(hits) >= 12 or brain_scanned >= 120:
        break
    root = os.path.join(home, rel_brain)
    if not os.path.isdir(root):
        continue
    for d in os.listdir(root):
        if brain_scanned >= 120:
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
                            wins = []
                            for t in content_terms:
                                pos = low.find(t)
                                if pos != -1:
                                    wins.append(txt[max(0, pos - 1000):min(len(txt), pos + len(t) + 1500)])
                                if len(wins) >= 3:
                                    break
                            rec["chunks"].append(("\\n...\\n".join(wins))[:5000] if wins else txt[:5000])
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
    hay = (pa["title"] + " " + (pa["cwd"] or "") + " " + pa["provider"]).lower()
    cnt = sum(1 for t in content_terms if t in hay) if content_terms else 0
    if cnt > 0:
        matched_paseo.append((cnt, pa))
matched_paseo.sort(key=lambda x: -x[0])
for _, pa in matched_paseo[:20]:
    out.append({"cid": None, "rec": None, "paseo": pa})
print(json.dumps(out[:40]))
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
    ? ["-o", "ControlMaster=auto", "-o", `ControlPath=${path.join(ctlDir, "%C")}`, "-o", "ControlPersist=30m"]
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
        if (linked?.id) {
          const sid = linked.serverId || fallbackServerId;
          const key = `paseo:${sid}.${linked.id}`;
          const combinedText = redactSecrets((rec?.chunks ?? []).join("\n\n")).slice(-24000);
          out.set(key, {
            key,
            kind: "paseo",
            id: linked.id,
            title: clampText(linked.title || rec?.title || "Paseo chat", 120),
            workspace: linked.cwd ? path.basename(linked.cwd) : null,
            repo: inferRepoFromPath(linked.cwd),
            branch: null,
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
              aliases: cid ? [`antigravity:${cid}`] : [],
              conversation: combinedText ? [{ role: "assistant", text: combinedText }] : []
            }
          });
        } else if (cid && rec) {
          const key = `antigravity:${cid}`;
          const combinedText = redactSecrets((rec.chunks ?? []).join("\n\n")).slice(-24000);
          out.set(key, {
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
              conversation: combinedText ? [{ role: "assistant", text: combinedText }] : []
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
    archiveThreads.set(key, thread);
  }

  const contentTerms = effectiveTerms.filter((t) => !PROVIDER_TERMS.has(t));
  if (contentTerms.length > 0) {
    for (const entry of paseoCatalog.agents) {
      const key = `paseo:${entry.serverId}.${entry.id}`;
      if (archiveThreads.has(key)) continue;
      const hay = normalize(`${entry.title} ${entry.cwd ?? ""} ${entry.provider}`);
      if (contentTerms.some((t) => hay.includes(t))) {
        archiveThreads.set(key, {
          key,
          kind: "paseo",
          id: entry.id,
          title: clampText(entry.title, 120),
          workspace: entry.cwd ? path.basename(entry.cwd) : null,
          repo: inferRepoFromPath(entry.cwd),
          branch: null,
          agentStatus: entry.archived ? "closed" : entry.status,
          state: entry.archived ? "archived" : entry.status,
          live: entry.status === "running",
          lastActivityAt: entry.updatedAt ?? null,
          lastAgentText: "",
          lastAgentFull: "",
          meta: {
            serverId: entry.serverId,
            provider: entry.provider,
            paseoCwd: entry.cwd,
            aliases: [entry.sessionId, entry.handoffSource, entry.migrationSourceId]
              .filter(Boolean)
              .map((id) => `${entry.provider}:${id}`),
            conversation: []
          }
        });
      }
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
    if (!archText) continue;
    merged.set(key, {
      ...existing,
      lastAgentFull: existing.lastAgentFull ? `${archText}\n${existing.lastAgentFull}` : archText,
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

    if (!allRawMatch && !(useNaturalSubset && matchedTerms >= minRequired)) continue;
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
    scope: "Supervisor scan, cached recent messages, and local/Paseo Antigravity FTS5 & artifact archives."
  };
}

export function rankCombinedSearchResults(rows = [], query = "") {
  const weights = { title: 4.5, workspace: 2.5, repo: 2.5, branch: 2.5, pr: 3, text: 1.5 };
  const { qLower, effectiveTerms } = extractQueryTerms(query, { natural: true });
  const contentTerms = effectiveTerms.filter((t) => !PROVIDER_TERMS.has(t));
  const terms = contentTerms.length > 0 ? contentTerms : effectiveTerms;
  const byKey = new Map();
  for (const row of rows) {
    if (!row?.key) continue;
    const fields = {
      title: normalize(row.title),
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
        if (fields.title.includes(qLower) || fields.pr.includes(qLower) || fields.branch.includes(qLower)) score += 6;
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
