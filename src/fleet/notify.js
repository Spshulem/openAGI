// Turns a needs-you question into a local outreach item and, only when the
// owner opted in, one BuzzKit phone push. The push endpoint file holds a
// credential: it is read at call time and never stored, returned, or logged.

import fs from "node:fs";
import { DEFAULTS, clampText } from "./contracts.js";

const HOUR_MS = 60 * 60 * 1000;
const PUSH_TIMEOUT_MS = 5_000;
// Matches the body cap the installed BuzzKit hook uses.
const PUSH_BODY_MAX = 180;

export function isQuietHour(date, quietHours = DEFAULTS.quietHours) {
  const hour = date.getHours();
  const { start, end } = quietHours ?? DEFAULTS.quietHours;
  if (start === end) return false;
  // Overnight windows (22 -> 8) wrap past midnight.
  return start > end ? hour >= start || hour < end : hour >= start && hour < end;
}

function outreachActions(options) {
  const actions = (Array.isArray(options) ? options : []).filter((option) => option && option !== "dismiss");
  return [...new Set(actions), "dismiss"];
}

function deepLink(publicUrl, id) {
  const base = String(publicUrl ?? "").trim().replace(/\/+$/, "");
  return base ? `${base}/fleet?q=${encodeURIComponent(id)}` : null;
}

export function createNotifier({
  config,
  store = null,
  runtime = null,
  fetchImpl = globalThis.fetch,
  readFile = fs.readFileSync,
  now = () => new Date(),
  log = console.warn
} = {}) {
  const limits = { ...DEFAULTS, ...(config?.limits ?? {}) };
  const current = () => {
    const value = now();
    return value instanceof Date ? value : new Date(value);
  };
  const skip = (reason) => ({ pushed: false, skipped: reason });

  const isQuietHours = (date = current()) => isQuietHour(date, limits.quietHours);

  const readEndpoint = () => {
    try {
      const text = String(readFile(config?.paths?.buzzEndpointFile, "utf8")).trim();
      return /^https:\/\/\S+$/.test(text) ? text : null;
    } catch {
      return null;
    }
  };

  const postOutreach = (question) => {
    const outreach = runtime?.outreach;
    if (typeof outreach?.append !== "function") return null;
    try {
      const item = outreach.append({
        type: "fleet-question",
        sourceRef: { kind: "fleet", id: question.id },
        title: clampText(question.title, limits.titleMax),
        summary: clampText(question.body, limits.bodyMax),
        needsDecision: true,
        actions: outreachActions(question.options),
        dedupeOpen: true
      });
      return item?.id ?? null;
    } catch {
      return null;
    }
  };

  const push = async (question, at) => {
    if (config?.push !== "buzzkit") return skip("push-off");
    if (question.pushedAt) return skip("already-pushed");
    if (isQuietHours(at)) return skip("quiet-hours");
    if ((store?.pushesSince?.(HOUR_MS, at.getTime()) ?? 0) >= limits.pushPerHour) return skip("hourly-cap");
    const endpoint = readEndpoint();
    if (!endpoint) return skip("no-endpoint");
    if (typeof fetchImpl !== "function") return skip("no-fetch");
    const body = clampText(question.body, PUSH_BODY_MAX);
    const url = deepLink(config?.publicUrl, question.id);
    const message = {
      title: clampText(question.title, limits.titleMax),
      ...(body ? { body } : {}),
      agent: "openagi-fleet",
      important: true,
      ...(url ? { url } : {})
    };
    try {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(message),
        signal: AbortSignal.timeout(PUSH_TIMEOUT_MS)
      });
      if (!response?.ok) {
        log(`[fleet] phone push failed (status ${response?.status ?? "unknown"})`);
        return skip("push-failed");
      }
    } catch (error) {
      // Fetch errors can embed the URL, so only the error class is logged.
      log(`[fleet] phone push failed (${error?.name ?? "error"})`);
      return skip("push-failed");
    }
    store?.recordPush?.(at.toISOString());
    return { pushed: true, skipped: null };
  };

  async function notifyQuestion(question) {
    if (!question?.id) return { outreachId: null, pushed: false, skipped: "no-question" };
    // The stored copy knows what earlier ticks already sent.
    const latest = store?.question?.(question.id) ?? question;
    if (latest.status && latest.status !== "open") return { outreachId: null, pushed: false, skipped: "closed" };
    const at = current();
    const outreachId = latest.outreachId ?? postOutreach(latest);
    const result = await push(latest, at);
    if (store && ((outreachId && outreachId !== latest.outreachId) || result.pushed)) {
      store.markQuestionNotified?.(latest.id, { outreachId, pushedAt: result.pushed ? at.toISOString() : undefined });
    }
    return { outreachId: outreachId ?? null, pushed: result.pushed, skipped: result.skipped };
  }

  return { notifyQuestion, isQuietHours };
}
