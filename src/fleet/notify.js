// Turns a needs-you question into a local outreach item and, only when the
// owner opted in, one BuzzKit phone push. The push endpoint file holds a
// credential: it is read at call time and never stored, returned, or logged.

import fs from "node:fs";
import { DEFAULTS, clampText } from "./contracts.js";
import { isSuppressedByQuietCadence } from "./preferences.js";
import { classifyAsk, decisionSummary, isGenericAsk, stripInternalIds } from "./decision-context.js";
import { resolveBudgetTimeZone } from "../budget-guard.js";

const HOUR_MS = 60 * 60 * 1000;
const PUSH_TIMEOUT_MS = 5_000;
// Matches the body cap the installed BuzzKit hook uses.
const PUSH_BODY_MAX = 180;
// Outreach copies carry the full four-part context.
const CONTEXT_SUMMARY_MAX = 1400;
const QUIET_HOUR_FORMATTERS = new Map();

function parseQuietMinutes(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    const wrapped = ((value % 24) + 24) % 24;
    return Math.round(wrapped * 60) % (24 * 60);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    const match = /^(\d{1,2})(?::(\d{2}))?$/.exec(trimmed);
    if (!match) return null;
    const h = Number(match[1]);
    const m = match[2] !== undefined ? Number(match[2]) : 0;
    if (!Number.isInteger(h) || !Number.isInteger(m) || h < 0 || h > 24 || m < 0 || m > 59) return null;
    return ((h % 24) * 60) + m;
  }
  return null;
}

function minutesOfDayInTimeZone(date, timeZone) {
  const zone = resolveBudgetTimeZone(timeZone);
  if (!zone) return date.getHours() * 60 + date.getMinutes();
  try {
    let formatter = QUIET_HOUR_FORMATTERS.get(zone);
    if (!formatter) {
      formatter = new Intl.DateTimeFormat("en-US", {
        timeZone: zone,
        hour: "numeric",
        minute: "numeric",
        hourCycle: "h23"
      });
      QUIET_HOUR_FORMATTERS.set(zone, formatter);
    }
    const parts = formatter.formatToParts(date);
    const hour = Number(parts.find((p) => p.type === "hour")?.value);
    const minute = Number(parts.find((p) => p.type === "minute")?.value);
    if (Number.isFinite(hour) && Number.isFinite(minute)) {
      return ((hour % 24) * 60) + minute;
    }
  } catch { /* fallback to local clock */ }
  return date.getHours() * 60 + date.getMinutes();
}

export function resolveQuietTimeZone(runtime = null, config = null, env = process.env) {
  const candidates = [
    config?.notify?.timeZone,
    config?.timeZone,
    runtime?.budget?.timeZone,
    env?.OPENAGI_TIMEZONE,
    env?.OPENAGI_TIME_ZONE
  ];
  for (const candidate of candidates) {
    const resolved = resolveBudgetTimeZone(candidate);
    if (resolved) return resolved;
  }
  return null;
}

export function isQuietHour(date, quietHours = DEFAULTS.quietHours, timeZone = null) {
  if (quietHours === false || quietHours?.enabled === false) return false;
  const resolved = quietHours ?? DEFAULTS.quietHours;
  if (!resolved || typeof resolved !== "object" || Array.isArray(resolved)) return false;
  const start = parseQuietMinutes(resolved.start);
  const end = parseQuietMinutes(resolved.end);
  if (start === null || end === null || start === end) return false;
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return false;
  const nowMinutes = minutesOfDayInTimeZone(d, timeZone);
  // Overnight windows (22:00 -> 08:00) wrap past midnight.
  return start > end ? nowMinutes >= start || nowMinutes < end : nowMinutes >= start && nowMinutes < end;
}

export function outreachActions(options) {
  // Compact outreach buttons cannot collect clarification text or render a
  // non-resolving plan. Keep those actions in Fleet and voice.
  const actions = (Array.isArray(options) ? options : []).filter((option) =>
    typeof option === "string" && option
    && !["dismiss", "answer question", "review plan"].includes(option.toLowerCase()));
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
  log = console.warn,
  // Supplies the decision-ready context for a question (goal, assignment,
  // progress, decision). Without it the raw question text is shown.
  contextFor = null
} = {}) {
  const limits = { ...DEFAULTS, ...(config?.limits ?? {}) };
  const current = () => {
    const value = now();
    return value instanceof Date ? value : new Date(value);
  };
  const skip = (reason) => ({ pushed: false, skipped: reason });

  const isQuietHours = (date = current(), timeZone = resolveQuietTimeZone(runtime, config)) =>
    isQuietHour(date, config?.notify?.quietHours ?? limits.quietHours, timeZone);

  const readEndpoint = () => {
    try {
      const text = String(readFile(config?.paths?.buzzEndpointFile, "utf8")).trim();
      return /^https:\/\/\S+$/.test(text) ? text : null;
    } catch {
      return null;
    }
  };

  const contextOf = (question) => {
    if (typeof contextFor !== "function") return null;
    try { return contextFor(question) ?? null; } catch { return null; }
  };

  // Meaningful names, never internal ids, and the four-part context when the
  // supervisor can recover it. The same question always renders the same text,
  // so a refresh in place is not a new ping.
  const shown = (question) => {
    const ctx = contextOf(question);
    // The stored (often review-polished) title stands; only an empty or
    // generic one ("needs your call. Answer?") is replaced by the item's name
    // and the agent's actual question.
    const rawTitle = stripInternalIds(question.title);
    const generic = !rawTitle || isGenericAsk(rawTitle);
    const headline = generic && ctx?.decision ? ctx.decision : (rawTitle || "Needs your decision");
    const title = clampText(generic && ctx?.itemName && !headline.startsWith(ctx.itemName) ? `${ctx.itemName}: ${headline}` : headline, limits.titleMax);
    return {
      title,
      summary: ctx ? decisionSummary(ctx, question.body, { maxChars: CONTEXT_SUMMARY_MAX }) : clampText(stripInternalIds(question.body), limits.bodyMax),
      actions: outreachActions(question.options)
    };
  };

  const postOutreach = (question) => {
    const outreach = runtime?.outreach;
    if (typeof outreach?.append !== "function") return null;
    try {
      const item = outreach.append({
        type: "fleet-question",
        sourceRef: { kind: "fleet", id: question.id },
        ...shown(question),
        needsDecision: classifyAsk(question) === "decision",
        dedupeOpen: true
      });
      return item?.id ?? null;
    } catch {
      return null;
    }
  };

  // A reworded question ("4 stuck" -> "5 stuck") refreshes its open copy in
  // place, so the same item shows the new text without a second ping.
  const refreshOutreach = (outreachId, question) => {
    const outreach = runtime?.outreach;
    if (typeof outreach?.update !== "function") return;
    try { outreach.update(outreachId, shown(question)); } catch { /* best-effort */ }
  };

  const push = async (question, at) => {
    if (config?.push !== "buzzkit") return skip("push-off");
    if (question.kind === "completed") return skip("passive-completion");
    if (question.pushedAt || store?.hasPriorUnansweredPush?.(question, at.getTime())) return skip("already-pushed");
    if (isQuietHours(at)) return skip("quiet-hours");
    if ((store?.pushesSince?.(HOUR_MS, at.getTime()) ?? 0) >= limits.pushPerHour) return skip("hourly-cap");
    const endpoint = readEndpoint();
    if (!endpoint) return skip("no-endpoint");
    if (typeof fetchImpl !== "function") return skip("no-fetch");
    const ctx = contextOf(question);
    const body = clampText(
      ctx?.decision
        ? `${ctx.decision}${ctx.recommendation ? ` ${ctx.recommendation}` : ""}`
        : stripInternalIds(question.body),
      PUSH_BODY_MAX
    );
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

  async function notifyQuestion(question, { allowPush = true } = {}) {
    if (!question?.id) return { outreachId: null, pushed: false, skipped: "no-question" };
    // The stored copy knows what earlier ticks already sent.
    const latest = store?.question?.(question.id) ?? question;
    if (latest.status && latest.status !== "open") return { outreachId: null, pushed: false, skipped: "closed" };
    if (isSuppressedByQuietCadence(latest, store?.preferences?.())) {
      return { outreachId: null, pushed: false, skipped: "quiet-cadence" };
    }
    const at = current();
    // FYIs and session errors are visible in Fleet but are not decisions:
    // they never ping the phone.
    const isDecision = classifyAsk(latest) === "decision";
    const outreachId = latest.outreachId ?? postOutreach(latest);
    if (outreachId) {
      if (latest.outreachId) {
        try { runtime?.outreach?.reopen?.(outreachId); } catch { /* best-effort */ }
      }
      refreshOutreach(outreachId, latest);
    }
    const result = !isDecision ? skip("not-a-decision") : (allowPush ? await push(latest, at) : skip("suggestion-cap"));
    if (store && ((outreachId && outreachId !== latest.outreachId) || result.pushed)) {
      store.markQuestionNotified?.(latest.id, { outreachId, pushedAt: result.pushed ? at.toISOString() : undefined });
    }
    return { outreachId: outreachId ?? null, pushed: result.pushed, skipped: result.skipped };
  }

  return { notifyQuestion, isQuietHours };
}
