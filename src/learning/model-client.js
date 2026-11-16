import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Client for an optional local scoring service: a process on this machine
// that scores proposals, turns, signals and memory items over HTTP. The
// runtime never needs it. With OPENAGI_MODEL_URL unset the client is inert:
// it sends no requests, reads no files, starts no timers, and every method
// answers "no score" (null, or false for usable()).
//
// When it is configured, every failure (service down, refused, timeout,
// non-200, bad JSON, wrong shape) also answers "no score". Nothing here
// throws into a caller. Each request carries a bearer token read once from
// OPENAGI_MODEL_TOKEN_FILE. The client is enabled only when both variables
// are set; with no token file configured, or a missing or malformed one, it
// stays off. Only loopback addresses are accepted, so the token and the text
// being scored never leave the machine.

export const DEFAULT_TIMEOUT_MS = 250;
export const HEALTH_TTL_MS = 60_000;
export const BREAKER_FAILURES = 3;
export const BREAKER_COOLDOWN_MS = 60_000;

const TOKEN_PATTERN = /^[\x21-\x7e]{1,512}$/;
const KEEP_TEXT_FIELDS = ["text", "tier", "kind", "source"];
const KEEP_NUMBER_FIELDS = ["novelty", "risk", "repetition", "specificity", "strength"];

export class ModelClient {
  constructor({
    url = process.env.OPENAGI_MODEL_URL,
    tokenFile = process.env.OPENAGI_MODEL_TOKEN_FILE,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    fetchImpl = globalThis.fetch,
    now = Date.now
  } = {}) {
    this.baseUrl = loopbackBaseUrl(url);
    // There is no default token file: without one the client stays off.
    this.tokenFile = this.baseUrl ? tokenFilePath(tokenFile) : null;
    this.timeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
    this.fetchImpl = fetchImpl;
    this.now = typeof now === "function" ? now : Date.now;
    this._token = undefined; // undefined: not read yet; null: unavailable
    this._failures = 0;
    this._openUntil = 0;
    this._probing = false;
    this._health = null; // { value, at }
    this._healthInFlight = null;
  }

  // False unless both a loopback url and a token file are configured and the
  // token file holds a token. The file is only read once both are set.
  enabled() {
    if (!this.baseUrl || !this.tokenFile || typeof this.fetchImpl !== "function") return false;
    return this._readToken() !== null;
  }

  // GET /health, cached for HEALTH_TTL_MS. Concurrent callers share one request.
  async health() {
    if (!this.enabled()) return null;
    if (this._health && this.now() - this._health.at < HEALTH_TTL_MS) return this._health.value;
    if (!this._healthInFlight) {
      this._healthInFlight = this._call("GET", "/health", undefined, parseHealth)
        .then((value) => {
          this._health = value ? { value, at: this.now() } : null;
          return value;
        })
        .catch(() => {
          this._health = null;
          return null;
        })
        .finally(() => {
          this._healthInFlight = null;
        });
    }
    return this._healthInFlight;
  }

  // Whether the service reports this head as usable, from the cached health;
  // false while the health is unknown. A missing or stale cache starts a
  // background refresh: a stale answer holds until it lands, and a failed
  // refresh forgets it.
  usable(head) {
    if (!this.enabled()) return false;
    const cached = this._health;
    if (!cached || this.now() - cached.at >= HEALTH_TTL_MS) this.health().catch(() => {});
    const health = cached?.value;
    if (!health || health.ok !== true || !Object.hasOwn(health.heads, String(head))) return false;
    return health.heads[String(head)].usable === true;
  }

  async scoreSuggestion(payload) {
    const body = pickStrings(payload, ["title", "rationale", "category"]);
    if (!body) return null;
    return this._call("POST", "/score/suggestion", body, (json) =>
      isProbability(json?.p_accept) ? { pAccept: json.p_accept, version: versionOf(json.version) } : null);
  }

  async scoreTurn(payload) {
    const body = pickStrings(payload, ["agent_text", "prev_owner_text", "provider"]);
    if (!body) return null;
    return this._call("POST", "/score/turn", body, (json) =>
      isProbability(json?.p_stop) && isProbability(json?.p_nudge)
        ? { pStop: json.p_stop, pNudge: json.p_nudge, version: versionOf(json.version) }
        : null);
  }

  // value is null when the service has no trained value head.
  async scoreSignal(payload) {
    const body = pickStrings(payload, ["text", "channel"]);
    if (!body) return null;
    return this._call("POST", "/score/signal", body, (json) =>
      isPlainObject(json) && (json.value === null || isProbability(json.value))
        ? { value: json.value, version: versionOf(json.version) }
        : null);
  }

  // items: [{ id, text, tier, kind, source, novelty, risk, repetition, specificity, strength }]
  async keepScores(items) {
    if (!Array.isArray(items)) return null;
    const body = { items: items.map(keepItem).filter(Boolean) };
    if (body.items.length === 0) return null;
    return this._call("POST", "/memory/keep", body, (json) => {
      if (!isPlainObject(json) || !isPlainObject(json.scores)) return null;
      const scores = Object.fromEntries(Object.entries(json.scores).filter(([, p]) => isProbability(p)));
      return { scores, version: versionOf(json.version) };
    });
  }

  // cluster is null when no topic is close enough.
  async clusterOf(text) {
    if (typeof text !== "string" || text.length === 0) return null;
    return this._call("POST", "/cluster-of", { text }, (json) => {
      if (!isPlainObject(json) || !isClusterId(json.cluster, { allowNull: true })) return null;
      return { cluster: json.cluster, similarity: Number.isFinite(json.similarity) ? json.similarity : null };
    });
  }

  // -> [{ cluster, n7d }]
  async clusters() {
    return this._call("GET", "/clusters", undefined, (json) => {
      if (!Array.isArray(json)) return null;
      return json
        .filter((entry) => isPlainObject(entry) && isClusterId(entry.cluster) && Number.isFinite(entry.n_7d))
        .map((entry) => ({ cluster: entry.cluster, n7d: entry.n_7d }));
    });
  }

  _readToken() {
    if (this._token !== undefined) return this._token;
    this._token = null;
    try {
      const token = fs.readFileSync(this.tokenFile, "utf8").trim();
      if (TOKEN_PATTERN.test(token)) this._token = token;
    } catch {
      // Missing or unreadable token file: the client stays disabled.
    }
    return this._token;
  }

  _breakerOpen() {
    return this._failures >= BREAKER_FAILURES && this.now() < this._openUntil;
  }

  // After the cooldown the breaker is half-open: exactly one trial request
  // goes out, and every other caller gets null until that trial settles.
  _admit() {
    if (this._failures < BREAKER_FAILURES) return true;
    if (this.now() < this._openUntil || this._probing) return false;
    this._probing = true;
    return true;
  }

  // One request, bounded by timeoutMs. parse maps the JSON body to the
  // result, or to null when its shape is wrong. Never throws.
  async _call(method, endpoint, body, parse) {
    if (!this.enabled() || !this._admit()) return null;
    const probe = this._probing === true;
    try {
      const result = parse(await this._fetchJson(method, endpoint, body)) ?? null;
      if (result === null) throw new Error("unexpected response shape");
      this._failures = 0;
      this._openUntil = 0;
      return result;
    } catch {
      this._failures += 1;
      if (this._failures >= BREAKER_FAILURES) this._openUntil = this.now() + BREAKER_COOLDOWN_MS;
      return null;
    } finally {
      if (probe) this._probing = false;
    }
  }

  async _fetchJson(method, endpoint, body) {
    const signal = AbortSignal.timeout(this.timeoutMs);
    const fetchImpl = this.fetchImpl;
    const headers = { accept: "application/json", authorization: `Bearer ${this._token}` };
    const init = { method, headers, signal, redirect: "error" };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const request = (async () => {
      const res = await fetchImpl(`${this.baseUrl}${endpoint}`, init);
      if (!res || res.status !== 200) {
        try {
          await res?.body?.cancel?.();
        } catch {
          // Nothing to release.
        }
        throw new Error(`status ${res?.status}`);
      }
      return res.json();
    })();
    // The deadline holds even if the fetch implementation ignores the signal.
    return withDeadline(request, signal);
  }
}

// "off" when the client is missing or disabled, or the flag is "off".
// "live" only when the flag is exactly "live". Anything else (including
// unset) is "shadow": scores are computed and recorded but change nothing.
export function learnedMode(flagValue, client) {
  try {
    if (!client || typeof client.enabled !== "function" || !client.enabled()) return "off";
  } catch {
    return "off";
  }
  if (flagValue === "off") return "off";
  if (flagValue === "live") return "live";
  return "shadow";
}

function loopbackBaseUrl(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (!isLoopbackHost(parsed.hostname)) return null;
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
}

function isLoopbackHost(hostname) {
  return hostname === "localhost" || hostname === "[::1]" || /^127(\.\d{1,3}){3}$/.test(hostname);
}

function tokenFilePath(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  let file = value.trim();
  if (file === "~" || file.startsWith("~/")) file = path.join(os.homedir(), file.slice(1));
  // A relative path would depend on the launch directory; refuse it.
  return path.isAbsolute(file) ? file : null;
}

function withDeadline(promise, signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error("timeout"));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

function parseHealth(json) {
  if (!isPlainObject(json)) return null;
  const heads = isPlainObject(json.heads)
    ? Object.fromEntries(
        Object.entries(json.heads)
          .filter(([, head]) => isPlainObject(head))
          .map(([name, head]) => [name, {
            labels: Number.isFinite(head.labels) ? head.labels : null,
            auroc: Number.isFinite(head.auroc) ? head.auroc : null,
            usable: head.usable === true
          }])
      )
    : {};
  const thresholds = isPlainObject(json.thresholds)
    ? Object.fromEntries(Object.entries(json.thresholds).filter(([, value]) => isProbability(value)))
    : {};
  return {
    ok: json.ok === true,
    version: versionOf(json.version),
    trainedThrough: typeof json.trained_through === "string" ? json.trained_through : null,
    heads,
    thresholds
  };
}

function keepItem(item) {
  if (!isPlainObject(item)) return null;
  if (typeof item.id !== "string" && !Number.isFinite(item.id)) return null;
  const out = { id: String(item.id) };
  for (const key of KEEP_TEXT_FIELDS) out[key] = typeof item[key] === "string" ? item[key] : null;
  for (const key of KEEP_NUMBER_FIELDS) out[key] = Number.isFinite(item[key]) ? item[key] : null;
  return out;
}

function pickStrings(payload, keys) {
  if (!isPlainObject(payload)) return null;
  return Object.fromEntries(keys.map((key) => [key, typeof payload[key] === "string" ? payload[key] : ""]));
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isProbability(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isClusterId(value, { allowNull = false } = {}) {
  if (value === null) return allowNull;
  return Number.isFinite(value) || (typeof value === "string" && value.length > 0);
}

function versionOf(value) {
  if (typeof value === "string") return value;
  if (Number.isFinite(value)) return String(value);
  return null;
}
