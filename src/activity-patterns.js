// Pure, deterministic activity-workflow analysis.
//
// Raw capture rows describe app/window focus. This module turns those rows
// into semantic actions, forms ordered occurrences without crossing machine
// streams, and measures the same workflow at action/hour/day/week horizons.
// It deliberately does not call a model or write state; PatternMiner owns the
// proposal gate and persistence.

const DEFAULT_MIN_OCCURRENCES = 3;
const DEFAULT_MIN_SEQUENCE_LENGTH = 2;
const DEFAULT_MAX_SEQUENCE_LENGTH = 6;
const DEFAULT_MAX_STEP_GAP_MINUTES = 180;
const DEFAULT_MAX_SEQUENCE_SPAN_MINUTES = 360;
const DUPLICATE_WINDOW_MS = 60 * 1000;
const ZONED_FORMATTERS = new Map();

const ACTION_RULES = [
  {
    key: "send-follow-up",
    label: "Work on a follow-up",
    pattern: /\b(follow[ -]?up|compose|reply|respond|draft(?:ing)? (?:an? )?(?:email|message)|send(?:ing)? (?:an? )?(?:email|message))\b/i
  },
  {
    key: "prepare-contract",
    label: "Work on a contract or proposal",
    pattern: /\b(contract|agreement|msa|sow|order[ -]?form|proposal|quote|docusign|panda\s?doc|ironclad|concord)\b/i
  },
  {
    key: "attend-call",
    label: "Work in a call or meeting",
    pattern: /\b(sales call|discovery|demo call|customer call|meeting|zoom|google meet|teams meeting|webex|facetime|huddle)\b/i
  },
  {
    key: "update-crm",
    label: "Update the CRM",
    pattern: /\b(crm|salesforce|hubspot|attio|close\.com|opportunity|deal|pipeline)\b/i
  },
  {
    key: "review-calendar",
    label: "Review the calendar",
    pattern: /\b(calendar|ical|schedule|agenda)\b/i
  },
  {
    key: "manage-task",
    label: "Manage a task or ticket",
    pattern: /\b(linear|jira|asana|trello|clickup|ticket|issue|task)\b/i
  },
  {
    key: "write-code",
    label: "Write or review code",
    pattern: /\b(github|gitlab|xcode|cursor|visual studio code|vscode|pull request|code review|commit)\b/i
  },
  {
    key: "send-message",
    label: "Read or send a message",
    pattern: /\b(slack|discord|messages|imessage|teams chat|mattermost)\b/i
  },
  {
    key: "work-on-document",
    label: "Work on a document",
    pattern: /\b(google docs|notion|microsoft word|pages|document|spreadsheet|sheets|presentation|slides)\b/i
  },
  {
    key: "work-with-email",
    label: "Work with email",
    pattern: /\b(gmail|outlook|apple mail|mailbox|inbox|email)\b/i
  }
];

const ACTION_LABELS = new Map(ACTION_RULES.map((rule) => [rule.key, rule.label]));
const CONTEXT_STOP_WORDS = new Set([
  "about", "after", "agenda", "agreement", "apple", "attend", "before", "browser",
  "calendar", "call", "chrome", "compose", "concord", "contract", "customer", "demo",
  "discovery", "docs", "document", "docusign", "draft", "email", "facetime", "follow",
  "from", "gmail", "google", "huddle", "inbox", "ironclad", "mail", "meeting", "message",
  "microsoft", "notion", "order", "outlook", "pandadoc", "pipeline", "prepare", "proposal",
  "quote", "reply", "review", "sales", "send", "sending", "slack", "teams", "this", "ticket",
  "update", "webex", "window", "with", "work", "zoom", "msa", "sow", "form"
]);

export function classifyActivityAction(row = {}) {
  const app = cleanText(row.app, 120) || "(unknown)";
  const window = cleanText(row.window, 240);
  const haystack = `${app} ${window}`;
  let rule = ACTION_RULES.find((candidate) => candidate.pattern.test(haystack));
  // A document titled "meeting notes" or a transcript archive is evidence of
  // post-call work, not proof that a live call is happening. Fall through to
  // the document/generic classifier unless the app itself is a meeting app.
  if (rule?.key === "attend-call" && /\b(notes?|transcript|recording|recap|summary|archive)\b/i.test(window) &&
      !/\b(zoom|google meet|microsoft teams|webex|facetime)\b/i.test(app)) {
    rule = ACTION_RULES.find((candidate) => candidate.key !== "attend-call" && candidate.pattern.test(haystack));
  }
  const key = rule?.key ?? `use-${slugify(app)}`;
  return {
    key,
    label: rule?.label ?? `Use ${app}`,
    app,
    window,
    at: normalizeIso(row.at),
    machineId: cleanText(row.sourceMachineId) || "default",
    contextTokens: extractContextTokens(app, window),
    semantic: Boolean(rule)
  };
}

export function analyzeActivityPatterns(activity = [], options = {}) {
  const minOccurrences = positiveInteger(options.minOccurrences, DEFAULT_MIN_OCCURRENCES);
  const minLen = positiveInteger(options.minLen ?? options.minSequenceLen, DEFAULT_MIN_SEQUENCE_LENGTH);
  const maxLen = Math.max(minLen, positiveInteger(options.maxLen ?? options.maxSequenceLen, DEFAULT_MAX_SEQUENCE_LENGTH));
  const maxStepGapMs = positiveNumber(options.maxStepGapMinutes, DEFAULT_MAX_STEP_GAP_MINUTES) * 60 * 1000;
  const maxSpanMs = positiveNumber(options.maxSequenceSpanMinutes, DEFAULT_MAX_SEQUENCE_SPAN_MINUTES) * 60 * 1000;
  const timeZone = resolveTimeZone(options.timeZone);

  // A machine stream is sequenced independently. Identical semantic pattern
  // keys are merged only after each occurrence has already been formed, so
  // two devices active at once cannot invent a cross-device transition.
  const byMachine = new Map();
  for (const row of activity) {
    if (!row || (!row.at && !row.ingestedAt)) continue;
    if (row.kind && row.kind !== "activity" && row.event !== "focus") continue;
    const action = classifyActivityAction({ ...row, at: row.at ?? row.ingestedAt });
    if (!action.at) continue;
    if (!byMachine.has(action.machineId)) byMachine.set(action.machineId, []);
    byMachine.get(action.machineId).push(action);
  }

  const rawByKey = new Map();
  for (const [machineId, rawStream] of byMachine) {
    const stream = collapseCaptureDuplicates(rawStream);
    for (let start = 0; start < stream.length; start += 1) {
      for (let len = minLen; len <= maxLen && start + len <= stream.length; len += 1) {
        const slice = stream.slice(start, start + len);
        const times = slice.map((step) => Date.parse(step.at));
        if (times.some((time) => !Number.isFinite(time))) continue;
        const gaps = times.slice(1).map((time, index) => time - times[index]);
        if (gaps.some((gap) => gap < 0 || gap > maxStepGapMs)) break;
        if (times[times.length - 1] - times[0] > maxSpanMs) break;
        if (slice.every((step) => step.key === slice[0].key)) continue;

        const context = measureOccurrenceContext(slice);
        // For transitions that imply causality, explicit mismatched entities
        // are evidence against the relationship: "Acme call -> Globex MSA"
        // should not be learned merely because the windows were adjacent.
        if (hasCausalContextMismatch(slice)) continue;

        const actionKeys = slice.map((step) => step.key);
        const key = actionKeys.join("→");
        const occurrence = {
          key,
          machineId,
          startIndex: start,
          endIndex: start + len - 1,
          startedAt: slice[0].at,
          endedAt: slice[slice.length - 1].at,
          durationMinutes: round((times[times.length - 1] - times[0]) / 60_000, 2),
          // Keep references to the normalized stream while counting. Copying
          // every step into every overlapping n-gram makes a 50k-row scan
          // needlessly allocate hundreds of MB; only the few retained
          // representative examples are materialized below.
          steps: slice,
          sharedContext: context.sharedTokens,
          contextConsistency: context.score,
          contextComparablePairs: context.comparablePairs
        };
        if (!rawByKey.has(key)) rawByKey.set(key, []);
        rawByKey.get(key).push(occurrence);
      }
    }
  }

  const patterns = [];
  for (const [key, rawOccurrences] of rawByKey) {
    const occurrences = selectIndependentOccurrences(rawOccurrences);
    if (occurrences.length < minOccurrences) continue;
    patterns.push(buildPattern(key, occurrences, timeZone));
  }

  const consolidated = suppressSubsumedPatterns(patterns);
  return consolidated.sort((a, b) =>
    b.confidence - a.confidence ||
    b.actionKeys.length - a.actionKeys.length ||
    b.count - a.count ||
    a.fingerprint.localeCompare(b.fingerprint)
  );
}

function collapseCaptureDuplicates(rows) {
  const sorted = rows.slice().sort((a, b) => a.at.localeCompare(b.at));
  const out = [];
  for (const row of sorted) {
    const previous = out[out.length - 1];
    if (previous) {
      const delta = Date.parse(row.at) - Date.parse(previous.at);
      const exactRetry = row.key === previous.key && row.app === previous.app && row.window === previous.window && delta <= DUPLICATE_WINDOW_MS;
      if (exactRetry) continue;
    }
    out.push(row);
  }
  return out;
}

function selectIndependentOccurrences(rawOccurrences) {
  const selected = [];
  const byMachine = new Map();
  for (const occurrence of rawOccurrences) {
    if (!byMachine.has(occurrence.machineId)) byMachine.set(occurrence.machineId, []);
    byMachine.get(occurrence.machineId).push(occurrence);
  }
  for (const occurrences of byMachine.values()) {
    occurrences.sort((a, b) => a.startIndex - b.startIndex || a.endIndex - b.endIndex);
    let lastEnd = -1;
    for (const occurrence of occurrences) {
      if (occurrence.startIndex <= lastEnd) continue;
      selected.push(occurrence);
      lastEnd = occurrence.endIndex;
    }
  }
  return selected.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

function suppressSubsumedPatterns(patterns) {
  const longestFirst = patterns.slice().sort((a, b) =>
    b.actionKeys.length - a.actionKeys.length || b.confidence - a.confidence || b.count - a.count
  );
  const kept = [];
  for (const candidate of longestFirst) {
    const subsumed = kept.some((parent) =>
      parent.actionKeys.length > candidate.actionKeys.length &&
      parent.count === candidate.count &&
      parent.distinctDays === candidate.distinctDays &&
      parent.distinctWeeks === candidate.distinctWeeks &&
      containsContiguous(parent.actionKeys, candidate.actionKeys)
    );
    if (!subsumed) kept.push(candidate);
  }
  return kept;
}

function containsContiguous(parent, child) {
  if (child.length > parent.length) return false;
  for (let start = 0; start + child.length <= parent.length; start += 1) {
    if (child.every((key, index) => parent[start + index] === key)) return true;
  }
  return false;
}

function buildPattern(key, occurrences, timeZone) {
  const actionKeys = key.split("→");
  const count = occurrences.length;
  const zoned = occurrences.map((occurrence) => zonedParts(occurrence.startedAt, timeZone));
  const dayKeys = new Set(zoned.map((part) => `${part.year}-${pad2(part.month)}-${pad2(part.day)}`));
  const weekKeys = new Set(zoned.map((part) => isoWeekKey(part.year, part.month, part.day)));
  const hourStats = circularHourStats(zoned.map((part) => part.hour + part.minute / 60));
  const weekdayCounts = frequencyMap(zoned.map((part) => part.weekday));
  const [typicalWeekday, typicalWeekdayCount] = topEntry(weekdayCounts);
  const weekdayStability = count > 0 ? typicalWeekdayCount / count : 0;
  const intervalsHours = occurrences.slice(1).map((occurrence, index) =>
    (Date.parse(occurrence.startedAt) - Date.parse(occurrences[index].startedAt)) / 3_600_000
  ).filter((value) => value >= 0);
  const medianIntervalHours = round(median(intervalsHours), 2);
  const cadence = inferCadence({
    count,
    distinctDays: dayKeys.size,
    distinctWeeks: weekKeys.size,
    typicalWeekday,
    weekdayStability,
    startHour: hourStats.meanHour,
    medianIntervalHours,
    timeZone
  });
  const lagStats = buildLagStats(actionKeys, occurrences);
  const durations = occurrences.map((occurrence) => occurrence.durationMinutes);
  const medianDurationMinutes = round(median(durations), 2);
  const horizons = ["action"];
  if (medianDurationMinutes <= 60) horizons.push("hour");
  if (dayKeys.size >= 2) horizons.push("day");
  if (weekKeys.size >= 2) horizons.push("week");

  const actions = actionKeys.map((actionKey, index) => {
    const steps = occurrences.map((occurrence) => occurrence.steps[index]).filter(Boolean);
    return {
      key: actionKey,
      action: actionKey,
      label: ACTION_LABELS.get(actionKey) ?? steps[0]?.label ?? humanize(actionKey),
      apps: rankedUnique(steps.map((step) => step.app)),
      windows: rankedUnique(steps.map((step) => step.window).filter(Boolean)).slice(0, 3)
    };
  });
  const apps = actions.map((action) => action.apps[0] ?? "(unknown)");

  const comparable = occurrences.filter((occurrence) => occurrence.contextComparablePairs > 0);
  const contextConsistency = comparable.length > 0
    ? average(comparable.map((occurrence) => occurrence.contextConsistency))
    : 0.5;
  const specificity = average(actionKeys.map((actionKey) => actionKey.startsWith("use-") ? 0 : 1));
  const lagStability = stabilityScore(durations);
  const confidenceComponents = {
    occurrenceCount: Math.min(1, count / 6),
    distinctDaySupport: Math.min(1, dayKeys.size / 3),
    timeOfDayStability: hourStats.stability,
    actionSpecificity: specificity,
    contextConsistency,
    lagStability,
    distinctWeekSupport: Math.min(1, weekKeys.size / 3)
  };
  const volumeBonus = count >= 8 ? 0.1 : count >= 5 ? 0.04 : 0;
  const lengthBonus = Math.min(0.06, Math.max(0, actionKeys.length - 2) * 0.02);
  const confidence = Math.min(1,
    confidenceComponents.occurrenceCount * 0.35 +
    confidenceComponents.distinctDaySupport * 0.1 +
    confidenceComponents.distinctWeekSupport * 0.05 +
    confidenceComponents.timeOfDayStability * 0.15 +
    confidenceComponents.actionSpecificity * 0.15 +
    confidenceComponents.contextConsistency * 0.1 +
    confidenceComponents.lagStability * 0.1 +
    volumeBonus + lengthBonus
  );
  const trigger = inferTrigger(actionKeys, actions);

  return {
    fingerprint: `actions:${key}`,
    actionKeys,
    actions,
    transitions: actionKeys.slice(0, -1).map((from, index) => ({
      from,
      to: actionKeys[index + 1],
      ...(lagStats.transitions[index] ?? {})
    })),
    apps,
    count,
    occurrenceCount: count,
    occurrences: occurrences.map((occurrence) => occurrence.startedAt),
    // Favor recent occurrences because frame/OCR retention is much shorter
    // than the 28-day activity lookback.
    examples: occurrences.slice(-3).map(({ startedAt, endedAt, durationMinutes, steps, sharedContext, machineId }) => ({
      startedAt,
      endedAt,
      durationMinutes,
      steps: steps.map(publicStep),
      sharedContext,
      machineId
    })),
    distinctDays: dayKeys.size,
    distinctWeeks: weekKeys.size,
    horizons,
    cadence,
    trigger,
    startHour: hourStats.meanHour,
    hourVariance: hourStats.variance,
    weekdayStability: round(weekdayStability, 3),
    medianIntervalHours,
    medianDurationMinutes,
    lagStats,
    confidenceComponents: mapRounded(confidenceComponents),
    confidence: round(confidence, 3)
  };
}

function inferCadence({ count, distinctDays, distinctWeeks, typicalWeekday, weekdayStability, startHour, medianIntervalHours, timeZone }) {
  let type = "irregular";
  if (distinctWeeks >= 3 && weekdayStability >= 0.67 && count / distinctWeeks <= 1.75) type = "weekly";
  else if (distinctDays >= 3 && distinctDays / count >= 0.6 && medianIntervalHours >= 12 && medianIntervalHours <= 72) type = "daily";
  else if (Number.isFinite(medianIntervalHours) && medianIntervalHours <= 6) type = "hourly";
  return {
    type,
    weekday: type === "weekly" ? typicalWeekday : null,
    startHour,
    timeZone,
    confidence: round(type === "weekly" ? weekdayStability : type === "daily" ? distinctDays / count : 0.5, 3)
  };
}

function inferTrigger(actionKeys, actions) {
  const first = actionKeys[0];
  // These are learned interactions, not calendar reminders: the first
  // observed action is the trigger for the remaining workflow. Cadence stays
  // attached as evidence (daily/weekly support), but never silently turns an
  // ordered behavior into an arbitrary clock cron.
  return {
    type: "after_action",
    action: first,
    label: `After ${String(actions[0]?.label ?? humanize(first)).toLowerCase()}`
  };
}

function buildLagStats(actionKeys, occurrences) {
  const transitions = [];
  for (let index = 0; index < actionKeys.length - 1; index += 1) {
    const values = occurrences.map((occurrence) => {
      const from = occurrence.steps[index];
      const to = occurrence.steps[index + 1];
      return (Date.parse(to.at) - Date.parse(from.at)) / 60_000;
    }).filter((value) => Number.isFinite(value) && value >= 0);
    transitions.push({
      medianMinutes: round(median(values), 2),
      p90Minutes: round(percentile(values, 0.9), 2)
    });
  }
  return {
    medianMinutes: round(median(transitions.map((transition) => transition.medianMinutes)), 2),
    transitions
  };
}

function measureOccurrenceContext(steps) {
  let comparablePairs = 0;
  let matchedPairs = 0;
  const shared = new Set();
  for (let index = 0; index < steps.length - 1; index += 1) {
    const left = new Set(steps[index].contextTokens);
    const right = new Set(steps[index + 1].contextTokens);
    if (left.size === 0 || right.size === 0) continue;
    comparablePairs += 1;
    const overlap = [...left].filter((token) => right.has(token));
    if (overlap.length > 0) matchedPairs += 1;
    for (const token of overlap) shared.add(token);
  }
  return {
    comparablePairs,
    matchedPairs,
    sharedTokens: [...shared],
    score: comparablePairs > 0 ? matchedPairs / comparablePairs : 0.5
  };
}

function hasCausalContextMismatch(steps) {
  for (let index = 0; index < steps.length - 1; index += 1) {
    const from = steps[index];
    const to = steps[index + 1];
    const causal =
      (from.key === "attend-call" && ["prepare-contract", "send-follow-up", "update-crm"].includes(to.key)) ||
      (from.key === "prepare-contract" && ["send-follow-up", "update-crm"].includes(to.key));
    if (!causal) continue;
    const left = new Set(from.contextTokens);
    const right = new Set(to.contextTokens);
    if (left.size === 0 || right.size === 0) continue;
    if (![...left].some((token) => right.has(token))) return true;
  }
  return false;
}

function publicStep(step) {
  return {
    key: step.key,
    action: step.key,
    label: step.label,
    app: step.app,
    window: step.window,
    at: step.at,
    contextTokens: step.contextTokens
  };
}

function extractContextTokens(app, window) {
  const appTokens = new Set(tokenize(app));
  return tokenize(window).filter((token) => !appTokens.has(token) && !CONTEXT_STOP_WORDS.has(token)).slice(0, 8);
}

function tokenize(text) {
  return String(text ?? "").toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) ?? [];
}

function circularHourStats(hours) {
  if (hours.length === 0) return { meanHour: null, variance: 12, stability: 0 };
  const angles = hours.map((hour) => (hour / 24) * Math.PI * 2);
  const sinMean = average(angles.map(Math.sin));
  const cosMean = average(angles.map(Math.cos));
  const resultant = Math.sqrt(sinMean ** 2 + cosMean ** 2);
  let angle = Math.atan2(sinMean, cosMean);
  if (angle < 0) angle += Math.PI * 2;
  return {
    meanHour: Math.round((angle / (Math.PI * 2)) * 24) % 24,
    variance: round((1 - resultant) * 12, 3),
    stability: round(resultant, 3)
  };
}

function zonedParts(value, timeZone) {
  let formatter = ZONED_FORMATTERS.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "long",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    });
    ZONED_FORMATTERS.set(timeZone, formatter);
  }
  const parts = Object.fromEntries(formatter.formatToParts(new Date(value)).map((part) => [part.type, part.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    weekday: parts.weekday,
    hour: Number(parts.hour),
    minute: Number(parts.minute)
  };
}

function isoWeekKey(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  const weekday = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - weekday);
  const weekYear = date.getUTCFullYear();
  const yearStart = new Date(Date.UTC(weekYear, 0, 1));
  const week = Math.ceil((((date - yearStart) / 86_400_000) + 1) / 7);
  return `${weekYear}-W${pad2(week)}`;
}

function resolveTimeZone(candidate) {
  const fallback = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const timeZone = candidate || fallback;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
    return timeZone;
  } catch {
    return fallback;
  }
}

function stabilityScore(values) {
  if (values.length <= 1) return 1;
  const middle = median(values);
  if (!Number.isFinite(middle) || middle === 0) return values.every((value) => value === 0) ? 1 : 0.5;
  const deviation = median(values.map((value) => Math.abs(value - middle)));
  return Math.max(0, 1 - deviation / Math.max(1, middle));
}

function frequencyMap(values) {
  const map = new Map();
  for (const value of values) map.set(value, (map.get(value) ?? 0) + 1);
  return map;
}

function topEntry(map) {
  return [...map.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))[0] ?? [null, 0];
}

function rankedUnique(values) {
  const counts = frequencyMap(values.filter(Boolean));
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([value]) => value);
}

function percentile(values, q) {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[index];
}

function median(values) {
  if (!values || values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function average(values) {
  if (!values || values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function mapRounded(object) {
  return Object.fromEntries(Object.entries(object).map(([key, value]) => [key, round(value, 3)]));
}

function normalizeIso(value) {
  const timestamp = Date.parse(value ?? "");
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function cleanText(value, maxLength = 240) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function slugify(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "unknown";
}

function humanize(value) {
  return String(value ?? "action").replace(/^use-/, "Use ").replace(/-/g, " ");
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function round(value, digits = 3) {
  if (!Number.isFinite(value)) return 0;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function pad2(value) {
  return String(value).padStart(2, "0");
}
