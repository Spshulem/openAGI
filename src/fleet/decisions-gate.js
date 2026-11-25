// Lightweight predicate gate & matcher backed by OpenAI's `/v1/decisions`
// endpoint (`model: "gpt-6-luna"`). Bills input tokens only (`output_tokens: 0`,
// ~$0.10 / 1M input tokens ≈ $0.00003 per thread check) via `OPENAI_API_KEY`
// without touching the `codex-lb` subscription quota pool.
//
// Powers three supervisor capabilities:
//   1. Pre-nudge keep-alive gate: filters unprompted background nudges so genuinely
//      stalled in-scope sessions stay alive while completed/passive sessions sleep.
//   2. Manager goal -> existing-session matcher: decides whether an existing chat
//      in a workspace/theme already owns a new directive vs spinning up a new chat.
//   3. Smart theme classifier: assigns unlabelled sessions to project workstreams.

import crypto from "node:crypto";
import { clampTail, clampText, redactSecrets } from "./contracts.js";

export const DEFAULT_DECISIONS_URL = "https://api.openai.com/v1/decisions";
export const DEFAULT_DECISIONS_MODEL = "gpt-6-luna";
export const DEFAULT_DECISIONS_TIMEOUT_MS = 8_000;
export const DEFAULT_KEEP_ALIVE_THRESHOLD = 0.5;
export const DEFAULT_NEEDS_OWNER_THRESHOLD = 0.6;
export const DECISIONS_BATCH_MAX = 20;
const CACHE_TTL_MS = 6 * 60 * 60_000;
const CACHE_MAX_ENTRIES = 800;

function isLoopbackHost(hostname) {
  const clean = String(hostname ?? "").replace(/^\[|\]$/g, "").toLowerCase();
  return clean === "127.0.0.1" || clean === "localhost" || clean === "::1";
}

export function validateDecisionsUrl(rawUrl = DEFAULT_DECISIONS_URL) {
  try {
    const parsed = new URL(rawUrl || DEFAULT_DECISIONS_URL);
    if (parsed.username || parsed.password) return null;
    if (parsed.protocol === "https:") return parsed.toString();
    if (parsed.protocol === "http:" && isLoopbackHost(parsed.hostname)) return parsed.toString();
    return null;
  } catch {
    return null;
  }
}

function scrubKey(text, apiKey) {
  const raw = String(text ?? "");
  if (!apiKey || apiKey.length < 8) return redactSecrets(raw);
  return redactSecrets(raw.split(apiKey).join("[REDACTED]"));
}

function cacheDigest(parts) {
  return crypto.createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32);
}

function maskElapsed(text) {
  return String(text ?? "").replace(
    /\b((?:waiting|waited|no word in|queued|elapsed|idle|silent|full verify|quick verify)\s+(?:for\s+)?)\d+(?:\.\d+)?\s?(?:ms|s|m|h|d|min|mins|minutes?|hours?|days?)\b/gi,
    "$1#"
  );
}

export async function callDecisionsEndpoint({
  input,
  questions,
  apiKey,
  url = DEFAULT_DECISIONS_URL,
  model = DEFAULT_DECISIONS_MODEL,
  timeoutMs = DEFAULT_DECISIONS_TIMEOUT_MS,
  fetchImpl = globalThis.fetch
} = {}) {
  const cleanKey = typeof apiKey === "string" ? apiKey.trim() : "";
  const validUrl = validateDecisionsUrl(url);
  if (!cleanKey || !validUrl || typeof fetchImpl !== "function") {
    return { ok: false, error: "decisions endpoint not configured" };
  }
  if (!Array.isArray(questions) || questions.length === 0) {
    return { ok: true, probabilities: new Map(), inputTokens: 0, model };
  }

  const serializedInput = typeof input === "string" ? input : JSON.stringify(input);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(500, Number(timeoutMs) || DEFAULT_DECISIONS_TIMEOUT_MS));
  timer.unref?.();

  try {
    const res = await fetchImpl(validUrl, {
      method: "POST",
      redirect: "error",
      headers: {
        Authorization: `Bearer ${cleanKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: model || DEFAULT_DECISIONS_MODEL,
        input: serializedInput,
        questions
      }),
      signal: controller.signal
    });
    const json = await res.json().catch(() => null);
    if (!res.ok || !Array.isArray(json?.answers)) {
      const msg = json?.error?.message || `HTTP ${res.status}`;
      return { ok: false, error: clampText(scrubKey(msg, cleanKey), 160) };
    }
    const probabilities = new Map();
    for (const ans of json.answers) {
      if (ans?.name && typeof ans.probability === "number" && Number.isFinite(ans.probability)) {
        probabilities.set(String(ans.name), Math.max(0, Math.min(1, ans.probability)));
      }
    }
    return {
      ok: true,
      probabilities,
      inputTokens: Number(json?.usage?.input_tokens) || 0,
      model: String(json?.model ?? model)
    };
  } catch (err) {
    return {
      ok: false,
      error: clampText(scrubKey(err?.message ?? String(err), cleanKey), 160) || "decisions request failed"
    };
  } finally {
    clearTimeout(timer);
  }
}

export function createDecisionsKeepAliveGate({
  config = {},
  env = {},
  fetchImpl = globalThis.fetch,
  now = Date.now
} = {}) {
  const settings = config?.decisions ?? {};
  const apiKey = String(settings.apiKey ?? env?.OPENAI_API_KEY ?? "").trim();
  const url = validateDecisionsUrl(settings.url ?? env?.OPENAGI_DECISIONS_URL ?? DEFAULT_DECISIONS_URL);
  const model = String(settings.model ?? env?.OPENAGI_DECISIONS_MODEL ?? DEFAULT_DECISIONS_MODEL).trim() || DEFAULT_DECISIONS_MODEL;
  const timeoutMs = Number(settings.timeoutMs) > 0 ? Number(settings.timeoutMs) : DEFAULT_DECISIONS_TIMEOUT_MS;
  const keepAliveThreshold = typeof settings.threshold === "number" ? settings.threshold : DEFAULT_KEEP_ALIVE_THRESHOLD;
  const needsOwnerThreshold = typeof settings.needsOwnerThreshold === "number" ? settings.needsOwnerThreshold : DEFAULT_NEEDS_OWNER_THRESHOLD;
  const enabled = Boolean(settings.enabled) && Boolean(apiKey) && Boolean(url);

  const cache = new Map();

  function pruneCache(ts) {
    for (const [k, entry] of cache) {
      if (ts - entry.at >= CACHE_TTL_MS) cache.delete(k);
    }
    while (cache.size > CACHE_MAX_ENTRIES) {
      const oldestKey = cache.keys().next().value;
      if (!oldestKey) break;
      cache.delete(oldestKey);
    }
  }

  function keyFor({ thread, decision, pr, classified }) {
    return cacheDigest([
      thread?.key ?? "",
      thread?.lastActivityAt ?? "",
      thread?.lastAgentAt ?? "",
      thread?.lastUserAt ?? "",
      pr?.ref ?? "",
      pr?.headOid ?? "",
      pr?.state ?? "",
      pr?.ci?.state ?? "",
      pr?.mergeState ?? "",
      decision?.playbook ?? "",
      classified?.state ?? "",
      maskElapsed(decision?.message ?? "")
    ]);
  }

  async function evaluateBatch(entries, { started = now() } = {}) {
    if (!enabled || !Array.isArray(entries) || entries.length === 0) {
      return new Map();
    }
    pruneCache(started);

    const verdicts = new Map();
    const uncached = [];

    for (const entry of entries) {
      const cKey = keyFor(entry);
      const hit = cache.get(cKey);
      const ttlMs = config?.judge?.enabled && entry?.decision?.requiresJudge ? 10 * 60_000 : CACHE_TTL_MS;
      if (hit && started - hit.at < ttlMs) {
        verdicts.set(entry.thread.key, { ...hit.verdict, cached: true });
      } else {
        uncached.push({ ...entry, cKey });
      }
    }

    for (let offset = 0; offset < uncached.length; offset += DECISIONS_BATCH_MAX) {
      const slice = uncached.slice(offset, offset + DECISIONS_BATCH_MAX);
      const payloadItems = slice.map(({ thread, decision, pr, classified }, idx) => ({
        idx,
        title: clampText(redactSecrets(thread?.title || thread?.workspace || thread?.key || ""), 100),
        playbook: decision?.playbook ?? "nudge",
        classified_state: classified?.state ?? "idle",
        pr: pr
          ? {
              ref: pr.ref ?? null,
              state: pr.state ?? null,
              isDraft: Boolean(pr.isDraft),
              ci: pr.ci?.state ?? null,
              failing: (pr.ci?.failing ?? []).slice(0, 4)
            }
          : null,
        planned_nudge: clampText(redactSecrets(decision?.message ?? ""), 280),
        last_owner_message: clampTail(redactSecrets(thread?.lastUserText ?? ""), 360),
        last_agent_message: clampTail(
          redactSecrets(thread?.lastAgentFull || thread?.lastAgentTail || thread?.lastAgentText || ""),
          1100
        )
      }));

      const questions = [];
      for (let idx = 0; idx < slice.length; idx += 1) {
        questions.push({
          type: "predicate",
          name: `c${idx}_keep_alive`,
          instructions:
            `Inspect \`candidates[${idx}]\`. Did this coding session stop with unfinished in-scope work ` +
            `(such as promised next steps, newly completed or failed CI checks on its PR, or incomplete verification) ` +
            `such that sending a short continuation prompt will help it finish autonomously without needing human approval? ` +
            `Answer low if the session already finished its task, was explicitly stopped by the owner, or is waiting on an active background/CI run.`
        });
        questions.push({
          type: "predicate",
          name: `c${idx}_needs_owner`,
          instructions:
            `Inspect \`candidates[${idx}]\`. Is this coding session genuinely blocked on a human product decision, ` +
            `merge/release authorization, or missing credential/access that only the owner can provide?`
        });
      }

      const res = await callDecisionsEndpoint({
        input: { candidates: payloadItems },
        questions,
        apiKey,
        url,
        model,
        timeoutMs,
        fetchImpl
      });

      if (!res.ok) {
        for (const item of slice) {
          verdicts.set(item.thread.key, { action: "error", error: res.error });
        }
        continue;
      }

      for (let idx = 0; idx < slice.length; idx += 1) {
        const item = slice[idx];
        const pKeep = res.probabilities.get(`c${idx}_keep_alive`) ?? 0;
        const pOwner = res.probabilities.get(`c${idx}_needs_owner`) ?? 0;
        let verdict;
        if (pOwner >= needsOwnerThreshold) {
          verdict = {
            action: "ask-owner",
            pKeepAlive: pKeep,
            pNeedsOwner: pOwner,
            inputTokens: Math.round(res.inputTokens / slice.length),
            reason: `needs owner decision (p=${pOwner.toFixed(2)})`
          };
        } else if (pKeep >= keepAliveThreshold) {
          verdict = {
            action: "send",
            pKeepAlive: pKeep,
            pNeedsOwner: pOwner,
            inputTokens: Math.round(res.inputTokens / slice.length),
            reason: `keep-alive approved (p=${pKeep.toFixed(2)})`
          };
        } else {
          verdict = {
            action: "wait",
            pKeepAlive: pKeep,
            pNeedsOwner: pOwner,
            inputTokens: Math.round(res.inputTokens / slice.length),
            reason: `no nudge needed (p=${pKeep.toFixed(2)})`
          };
        }
        cache.set(item.cKey, { verdict, at: started });
        verdicts.set(item.thread.key, verdict);
      }
    }

    return verdicts;
  }

  return {
    enabled,
    model,
    url,
    evaluateBatch,
    cacheSize: () => cache.size
  };
}

export async function matchGoalWithDecisions({
  goal,
  project,
  candidates,
  apiKey,
  url = DEFAULT_DECISIONS_URL,
  model = DEFAULT_DECISIONS_MODEL,
  timeoutMs = DEFAULT_DECISIONS_TIMEOUT_MS,
  fetchImpl = globalThis.fetch
} = {}) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return { ok: false, scores: new Map() };
  }
  const capped = candidates.slice(0, 10);
  const input = {
    project: String(project ?? ""),
    owner_directive: clampText(redactSecrets(String(goal ?? "")), 800),
    sessions: capped.map((s, idx) => ({
      idx,
      key: s.key,
      title: clampText(redactSecrets(s.title ?? ""), 120),
      theme: s.theme ?? null,
      state: s.state ?? "idle",
      prRefs: (s.prRefs ?? []).slice(0, 4),
      recent_context: clampText(redactSecrets(s.recentContext || s.snippet || ""), 900)
    }))
  };
  const questions = capped.map((_, idx) => ({
    type: "predicate",
    name: `s${idx}_match`,
    instructions:
      `Does existing coding session \`sessions[${idx}]\` already own or actively work on the exact feature, bug, or workstream ` +
      `described in \`owner_directive\` for project \`project\`, so the supervisor should route \`owner_directive\` into \`sessions[${idx}]\` ` +
      `instead of starting a brand-new coding session?`
  }));

  const res = await callDecisionsEndpoint({
    input,
    questions,
    apiKey,
    url,
    model,
    timeoutMs,
    fetchImpl
  });
  if (!res.ok) return { ok: false, error: res.error, scores: new Map() };

  const scores = new Map();
  capped.forEach((s, idx) => {
    const p = res.probabilities.get(`s${idx}_match`);
    if (typeof p === "number") scores.set(s.key, p);
  });
  return { ok: true, scores, inputTokens: res.inputTokens };
}

export async function evaluateQuestionsRelevanceWithDecisions({
  items,
  apiKey,
  url = DEFAULT_DECISIONS_URL,
  model = DEFAULT_DECISIONS_MODEL,
  timeoutMs = DEFAULT_DECISIONS_TIMEOUT_MS,
  fetchImpl = globalThis.fetch
} = {}) {
  if (!Array.isArray(items) || items.length === 0) {
    return { ok: false, scores: new Map() };
  }
  const capped = items.slice(0, 12);
  const input = {
    watched_questions: capped.map((item, idx) => ({
      idx,
      question_id: item.id,
      kind: item.kind ?? "agent-ask",
      asked_at: item.askedAt ?? null,
      question_title: clampText(redactSecrets(item.title ?? ""), 160),
      question_body: clampText(redactSecrets(item.body ?? ""), 400),
      thread_status: item.threadStatus ?? "idle",
      last_owner_at: item.lastOwnerAt ?? null,
      last_owner_text: clampText(redactSecrets(item.lastOwnerText ?? ""), 400),
      last_agent_at: item.lastAgentAt ?? null,
      last_agent_text: clampTail(redactSecrets(item.lastAgentText ?? ""), 700),
      recent_messages: Array.isArray(item.recentMessages)
        ? item.recentMessages.slice(-5).map((m) => ({
            role: m.role,
            at: m.at ?? null,
            text: clampText(redactSecrets(m.text ?? ""), 280)
          }))
        : []
    }))
  };
  const questions = capped.map((_, idx) => ({
    type: "predicate",
    name: `q${idx}_still_relevant`,
    instructions:
      `Inspect \`watched_questions[${idx}]\`. Is the coding session STILL blocked or waiting on the owner for the exact question/decision ` +
      `described in \`question_title\` / \`question_body\` (raised at \`asked_at\`), so the Supervisor should keep showing this card to the owner? ` +
      `Answer FALSE (low probability) if the owner already replied or followed up after \`asked_at\`, if the agent already moved on to later work, ` +
      `or if the question was an optional offer that is now out of date.`
  }));

  const res = await callDecisionsEndpoint({
    input,
    questions,
    apiKey,
    url,
    model,
    timeoutMs,
    fetchImpl
  });
  if (!res.ok) return { ok: false, error: res.error, scores: new Map() };

  const scores = new Map();
  capped.forEach((item, idx) => {
    const p = res.probabilities.get(`q${idx}_still_relevant`);
    if (typeof p === "number") scores.set(item.id, p);
  });
  return { ok: true, scores, inputTokens: res.inputTokens };
}

const ownerIntentClarityCache = new Map();
const OWNER_INTENT_CACHE_TTL_MS = 30 * 60_000;
const OWNER_INTENT_CACHE_MAX = 400;

// Evaluates whether the authenticated owner's words clearly authorize a
// side-effecting tool call in light of the immediately preceding assistant
// question/recommendation, using OpenAI's `/v1/decisions` predicate endpoint.
// Never includes untrusted third-party tool outputs in `input`.
export async function evaluateOwnerIntentClarityWithDecisions({
  ownerIntent,
  previousAssistantText = "",
  toolName,
  actionSummary = "",
  apiKey,
  url = DEFAULT_DECISIONS_URL,
  model = DEFAULT_DECISIONS_MODEL,
  timeoutMs = 4_500,
  threshold = 0.5,
  fetchImpl = globalThis.fetch
} = {}) {
  const intent = String(ownerIntent ?? "").trim();
  const tool = String(toolName ?? "").trim();
  const cleanKey = typeof apiKey === "string" ? apiKey.trim() : "";
  if (!intent || !tool || !cleanKey) {
    return { ok: false, clear: false, error: "missing owner intent clarity arguments" };
  }
  if (
    fetchImpl === globalThis.fetch
    && (!url || url === DEFAULT_DECISIONS_URL)
    && !(cleanKey.startsWith("sk-") && cleanKey.length >= 20)
  ) {
    return { ok: false, clear: false, error: "non-live test key" };
  }

  const nowTs = Date.now();
  const cKey = cacheDigest([
    intent,
    String(previousAssistantText ?? "").slice(-800),
    tool,
    String(actionSummary ?? "").slice(0, 300)
  ]);
  const hit = ownerIntentClarityCache.get(cKey);
  if (hit && nowTs - hit.at < OWNER_INTENT_CACHE_TTL_MS) {
    return hit.value;
  }

  const inputPayload = {
    previous_assistant_message: clampTail(redactSecrets(String(previousAssistantText ?? "")), 800),
    authenticated_owner_message: clampText(redactSecrets(intent), 500),
    proposed_tool_action: {
      tool,
      summary: clampText(redactSecrets(String(actionSummary ?? "")), 300)
    }
  };
  const res = await callDecisionsEndpoint({
    input: inputPayload,
    questions: [
      {
        type: "predicate",
        name: "owner_clearly_authorized",
        instructions:
          "Did `authenticated_owner_message` clearly authorize, confirm, select, or ask the assistant to execute " +
          "`proposed_tool_action` (for example saying 'yes', 'ok', 'continue', 'skip', choosing an option, or giving " +
          "a clear follow-up instruction directly in response to `previous_assistant_message`), as opposed to " +
          "asking a passive read-only status/summary question where this action was never requested?"
      }
    ],
    apiKey: cleanKey,
    url,
    model,
    timeoutMs,
    fetchImpl
  });
  if (!res.ok) {
    return { ok: false, clear: false, error: res.error };
  }
  const prob = res.probabilities.get("owner_clearly_authorized");
  if (typeof prob !== "number") {
    return { ok: false, clear: false, error: "decisions omitted probability" };
  }
  const result = {
    ok: true,
    clear: prob >= threshold,
    probability: prob,
    model: res.model
  };
  if (ownerIntentClarityCache.size >= OWNER_INTENT_CACHE_MAX) {
    const oldest = ownerIntentClarityCache.keys().next().value;
    if (oldest) ownerIntentClarityCache.delete(oldest);
  }
  ownerIntentClarityCache.set(cKey, { at: nowTs, value: result });
  return result;
}
