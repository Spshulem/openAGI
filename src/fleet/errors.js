// Classifies the text of a failed agent turn into one of ERROR_KINDS.
// Patterns come from real Codex, Claude, and Conductor error strings seen
// on the owner's machine (docs/superpowers/specs/2026-09-26-fleet-supervisor-design.md).
// Returns null when the text is not an infrastructure error.

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

const RULES = [
  // Order matters: the most specific signal wins.
  { kind: "model-limit", pattern: /You've reached your \w[\w .-]* limit|Switch to another model|Selected model is at capacity|model is at capacity/i },
  { kind: "session-limit", pattern: /You've hit your (?:session|weekly|daily) limit/i },
  { kind: "usage-limit", pattern: /You've hit your usage limit|usage_limit_exceeded|usageLimitExceeded|out of usage credits|usage_limit_reached/i },
  { kind: "logged-out", pattern: /Not logged in|Please run \/login|authentication_failed|OAuth token (?:has )?expired/i },
  { kind: "disk-full", pattern: /ENOSPC|no space left on device/i },
  { kind: "lb", pattern: /No available accounts|degraded mode|session bridge is cooling down|Previous response owner account|Invalid [`']?previous_response_id|continuity sources conflict|CODEX_LB_API_KEY|100\.99\.3\.113:2455|Incorrect API key provided/i },
  { kind: "overloaded", pattern: /\b529\b|Overloaded|server_overloaded|serverOverloaded|\b50[0234]\b.*(?:error|Internal|Bad Gateway|Unavailable)|Internal server error|rate_limit_error|\b429\b/i },
  { kind: "network", pattern: /ENOTFOUND|ECONNRESET|ETIMEDOUT|Can't reach the API server|Unable to connect to API|Connection (?:failed|closed mid-response)|stream disconnected|request timed out|error sending request/i }
];

// Parses "resets 12am (America/Los_Angeles)", "resets Sep 28 at 9am (...)",
// and Codex "Try again at Sep 24th, 2026 9:25 AM." into an ISO time. The
// time is interpreted in the machine's local zone, which is the owner's
// zone for this daemon; unparseable text returns null.
export function parseResetAt(text, now = new Date()) {
  const source = String(text ?? "");
  const claude = /resets\s+(?:(\w{3})\w*\s+(\d{1,2})\s+at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i.exec(source);
  const codex = /[Tt]ry again at\s+(?:(\w{3})\w*\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\s+)?(\d{1,2}):(\d{2})\s*(AM|PM)/.exec(source);
  let month; let day; let year; let hour; let minute; let meridiem;
  if (claude) {
    [, month, day, hour, minute, meridiem] = claude;
  } else if (codex) {
    [, month, day, year, hour, minute, meridiem] = codex;
  } else {
    return null;
  }
  let h = Number(hour) % 12;
  if (/pm/i.test(meridiem)) h += 12;
  const base = new Date(now.getTime());
  const date = new Date(
    year ? Number(year) : base.getFullYear(),
    month && MONTHS[month.toLowerCase()] !== undefined ? MONTHS[month.toLowerCase()] : base.getMonth(),
    day ? Number(day) : base.getDate(),
    h, minute ? Number(minute) : 0, 0, 0
  );
  if (Number.isNaN(date.getTime())) return null;
  // A bare time ("resets 12am") that already passed today means tomorrow.
  if (!month && date.getTime() <= now.getTime()) date.setDate(date.getDate() + 1);
  return date.toISOString();
}

export function classifyErrorText(text, now = new Date()) {
  const source = String(text ?? "");
  if (!source.trim()) return null;
  for (const rule of RULES) {
    if (rule.pattern.test(source)) {
      const resetAt = rule.kind === "session-limit" || rule.kind === "usage-limit" ? parseResetAt(source, now) : null;
      return { kind: rule.kind, resetAt };
    }
  }
  return null;
}

// Codex task_complete.error codes map straight to kinds; "other" falls back
// to the message text.
export function classifyCodexErrorCode(code, message, now = new Date()) {
  const normalized = String(code ?? "").toLowerCase();
  if (normalized === "usage_limit_exceeded" || normalized === "usagelimitexceeded") {
    return { kind: "usage-limit", resetAt: parseResetAt(message, now) };
  }
  if (normalized === "server_overloaded" || normalized === "serveroverloaded") return { kind: "model-limit", resetAt: null };
  if (normalized === "http_connection_failed" || normalized === "httpconnectionfailed") return { kind: "network", resetAt: null };
  return classifyErrorText(message, now) ?? (message ? { kind: "other", resetAt: null } : null);
}
