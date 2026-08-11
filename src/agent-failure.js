const PUBLIC_FAILURES = Object.freeze({
  budget: "Daily budget exceeded",
  "provider-auth": "The model provider needs attention. Check its API key in Settings.",
  "provider-rate-limit": "The model provider is temporarily rate-limited. Try again shortly.",
  "provider-timeout": "The model provider timed out. Check its connection and try again.",
  "provider-unavailable": "The model provider is unavailable. Check its connection and try again.",
  "agent-error": "The agent couldn't complete that request. Check the local daemon log for details."
});

const loggedFailures = new WeakSet();

// Provider and tool errors are remote input. Reduce them to a small, stable
// public taxonomy before they reach chat history, HTTP responses, or browser
// events; the detailed diagnostic belongs only in the daemon's local log.
export function classifyAgentFailure(error) {
  const code = safeErrorField(error, "code");
  const name = safeErrorField(error, "name");
  const message = safeErrorMessage(error);
  const detail = `${code} ${name} ${message}`;

  if (code === "BUDGET_EXCEEDED" || /\b(?:daily )?budget\b|spend cap/i.test(detail)) {
    return { code: "budget", message: PUBLIC_FAILURES.budget };
  }
  if (/\b(?:401|403)\b|api[_ -]?key|credential|authentication|unauthori[sz]ed|forbidden/i.test(detail)) {
    return { code: "provider-auth", message: PUBLIC_FAILURES["provider-auth"] };
  }
  if (/\b(?:429|rate limit|too many requests|insufficient_quota)\b/i.test(detail)) {
    return { code: "provider-rate-limit", message: PUBLIC_FAILURES["provider-rate-limit"] };
  }
  if (/AbortError|TimeoutError|timed? out|absolute timeout|idle timeout|ETIMEDOUT/i.test(detail)) {
    return { code: "provider-timeout", message: PUBLIC_FAILURES["provider-timeout"] };
  }
  if (/\b(?:ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|UND_ERR_[A-Z_]+)\b|network|fetch failed|provider unavailable|request failed with 5\d\d|stream (?:ended|was unavailable)/i.test(detail)) {
    return { code: "provider-unavailable", message: PUBLIC_FAILURES["provider-unavailable"] };
  }
  return { code: "agent-error", message: PUBLIC_FAILURES["agent-error"] };
}

export function publicAgentFailure(error, sessionId = null) {
  const failure = classifyAgentFailure(error);
  return {
    code: failure.code,
    error: failure.message,
    sessionId: boundedString(sessionId, 500) || null
  };
}

export function logAgentFailure(error, context = {}) {
  if (error && (typeof error === "object" || typeof error === "function")) {
    if (loggedFailures.has(error)) return;
    loggedFailures.add(error);
  }

  const failure = classifyAgentFailure(error);
  const diagnostic = redactFailureDiagnostic(safeErrorDiagnostic(error)).slice(0, 16_000);
  const record = {
    at: new Date().toISOString(),
    event: "agent-turn-failed",
    code: failure.code,
    sessionId: boundedString(context.sessionId, 500) || null,
    requestId: boundedString(context.requestId, 200) || null,
    diagnostic: diagnostic || "Unknown agent error"
  };
  try { process.stderr.write(`[openagi] ${JSON.stringify(record)}\n`); } catch { /* diagnostics are best-effort */ }
}

export function redactFailureDiagnostic(value) {
  return String(value ?? "")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [REDACTED]")
    .replace(/\b(?:sk|sk-ant|xox[baprs])-?[A-Za-z0-9_-]{8,}\b/gi, "[REDACTED]")
    .replace(/\b(?:ghp|github_pat)_[A-Za-z0-9_]{8,}\b/gi, "[REDACTED]")
    .replace(/([?&](?:api[_-]?key|key|token|secret|password|access_token)=)[^&#\s]+/gi, "$1[REDACTED]")
    .replace(/\b((?:OPENAI|ANTHROPIC|OPENAGI)_[A-Z0-9_]*(?:KEY|TOKEN)|API[_-]?KEY)\s*[=:]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    // Preserve a useful origin while dropping URL userinfo, paths and query
    // material supplied by a remote/compatible provider.
    .replace(/\bhttps?:\/\/[^\s"'<>]+/gi, (raw) => {
      try {
        const parsed = new URL(raw);
        return `${parsed.protocol}//${parsed.host}/[REDACTED]`;
      } catch {
        return "[REDACTED_URL]";
      }
    })
    .replace(/\bfile:\/\/\/[^\s)]+/gi, "file:///[LOCAL_PATH]")
    .replace(/(^|[\s(])\/(?:Users|home|private|var|tmp|opt|Volumes)\/[^\s):]+/gm, "$1[LOCAL_PATH]")
    .replace(/\b[A-Za-z]:\\(?:Users|Temp|Windows)\\[^\s):]+/g, "[LOCAL_PATH]");
}

function safeErrorField(error, key) {
  try { return typeof error?.[key] === "string" ? error[key].slice(0, 500) : ""; } catch { return ""; }
}

function safeErrorMessage(error) {
  try {
    if (typeof error?.message === "string") return error.message.slice(0, 16_000);
    if (typeof error === "string") return error.slice(0, 16_000);
  } catch { /* fall through */ }
  return "";
}

function safeErrorDiagnostic(error) {
  try {
    if (typeof error?.stack === "string" && error.stack) return error.stack;
  } catch { /* fall through */ }
  return safeErrorMessage(error);
}

function boundedString(value, max) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}
