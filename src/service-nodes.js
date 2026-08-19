// src/service-nodes.js
//
// SERVICE nodes — the machines that do work for this installation without
// being part of it.
//
// node-registry.js knows about PEERS: full OpenAGI installs that generate an
// identity.json, heartbeat every 30s, and report a version and a build. That
// is the only kind of machine the Nodes view could see, so a service-only host
// running `openagi imessage-server` did not appear anywhere. It has no daemon,
// no identity, and never heartbeats. It is known to the main only because the
// main's environment names it (OPENAGI_IMESSAGE_NODE), and its liveness is not
// a remembered timestamp but a question you have to go and ask.
//
// So a service is modelled as its own kind, deliberately NOT as a peer:
//
//   peer (node-registry)          service (here)
//   ------------------------      ---------------------------
//   nodeId, version, build        none of these exist — never invent them
//   lastSeenAt (it told us)       checkedAt (we went and looked)
//   status online/offline         reachability reachable/unreachable/
//     derived from a timestamp      not-configured/unknown, from a live probe
//
// Three rules the rest of this file exists to enforce:
//
//  1. A probe result is "live" ONLY if it completed during the request that is
//     reporting it. Anything else is "cached" and carries its age. The Nodes
//     A cached verdict must never be replayed as current; a probe cache that
//     does so merely moves the same stale-status bug one field over.
//  2. A probe must never hold the response. It runs in parallel with everything
//     else /nodes does and is raced against a budget; whatever has not answered
//     by then keeps running in the background to populate the cache for the
//     next request, and this request says "unknown" rather than waiting.
//  3. The credential never leaves this process. The token authenticates the
//     outbound probe and is registered as a secret so it can be scrubbed out of
//     any error text; embedded userinfo in the URL is converted to a header and
//     stripped from the address we display; query strings are dropped whole.
//     The host:port is fine to show — it is how the user identifies the box.

// Every service kind this installation knows how to connect to. Adding one is
// a matter of naming its env vars and its health route.
export const SERVICE_KINDS = [
  {
    id: "imessage",
    name: "iMessage pass-through",
    purpose: "Reads the Messages history on the Mac that holds chat.db, so the agent can answer questions about your texts.",
    urlEnv: "OPENAGI_IMESSAGE_NODE",
    tokenEnv: "OPENAGI_IMESSAGE_NODE_TOKEN",
    healthPath: "/health"
  },
  {
    id: "computer-use",
    name: "Computer use",
    purpose: "Captures a live screen and performs user-approved click, type, key, move, and scroll actions on a connected Mac.",
    urlEnv: "OPENAGI_COMPUTER_NODE",
    tokenEnv: "OPENAGI_COMPUTER_NODE_TOKEN",
    healthPath: "/health"
  }
];

export const REACHABILITY = new Set(["reachable", "unreachable", "not-configured", "unknown"]);
export const CHECK_BASIS = new Set(["live", "cached", "reported", "none"]);

const DEFAULT_TIMEOUT_MS = 2000;   // hard stop on a single probe
const DEFAULT_BUDGET_MS = 1200;    // how long /nodes will wait for probes at all
const DEFAULT_MIN_INTERVAL_MS = 1000; // don't re-probe more often than this
const MAX_DETAIL = 200;

const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
const clip = (v) => (v == null ? null : String(v).slice(0, MAX_DETAIL));

// Redact every known secret from free text before it is allowed anywhere near a
// response body. Probe failures are the risky path: a fetch error can quote the
// URL it was given, and that URL may carry userinfo.
export function scrubSecrets(text, secrets = []) {
  if (text == null) return null;
  let out = String(text);
  for (const s of secrets) {
    if (typeof s !== "string" || s.length < 4) continue;
    out = out.split(s).join("[redacted]");
  }
  // Belt and braces: any surviving scheme://user:pass@host loses its userinfo.
  return out.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, "$1");
}

// Parse a configured endpoint once, keeping the path-bearing probe base private
// while reducing the display address to its origin. Paths can be credentials
// just as readily as query strings (for example, an unguessable webhook-style
// route), so they must never be serialized into /nodes or its on-disk cache.
// Query and fragment are dropped entirely rather than inspected — no service
// here needs either one to be reachable.
function parseEndpoint(raw) {
  const value = str(raw);
  if (!value) return null;
  let u;
  try { u = new URL(value); } catch { return { endpoint: null, host: null, username: null, password: null, probeBase: null, invalid: true }; }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { endpoint: null, host: null, username: null, password: null, probeBase: null, invalid: true };
  }
  // Percent-decode so the credential we compare/scrub against is the literal
  // one — but never let a malformed escape throw, because that would take the
  // whole services list down with it.
  const decode = (v) => { if (!v) return null; try { return decodeURIComponent(v); } catch { return v; } };
  const username = decode(u.username);
  const password = decode(u.password);
  const probe = new URL(u.href);
  probe.username = "";
  probe.password = "";
  probe.search = "";
  probe.hash = "";
  const probeBase = probe.href.replace(/\/+$/, "");
  return { endpoint: u.origin, host: u.host, username, password, probeBase, invalid: false };
}

// Return only the address that is safe to show or propagate. The private probe
// base deliberately does not cross this exported sanitization boundary.
export function scrubEndpoint(raw) {
  const parsed = parseEndpoint(raw);
  if (!parsed) return null;
  const { endpoint, host, invalid } = parsed;
  return { endpoint, host, invalid };
}

// Turn the environment into a description of every service kind: what it is,
// where it lives, how to authenticate to it, and which strings are secret.
// Unconfigured kinds are still described — "not configured" is a fact the Nodes
// view should be able to state, and it is how the user learns the capability
// exists at all.
export function readServiceConfig({ env = process.env, kinds = SERVICE_KINDS } = {}) {
  return kinds.map((kind) => {
    const raw = str(env[kind.urlEnv]);
    const token = str(env[kind.tokenEnv]);
    if (!raw) {
      return {
        kind, configured: false, invalid: false, endpoint: null, host: null,
        probeUrl: null, probeHeaders: {}, secrets: []
      };
    }
    const parsed = parseEndpoint(raw);
    // The raw configured string is treated as a secret even when it has no
    // userinfo: a token can also hide in a path, and over-redacting one error
    // message costs nothing next to leaking a credential. The >= 4 floor keeps
    // a trivially short value from redacting half the sentence.
    const secrets = [token, parsed?.password, parsed?.username, raw, parsed?.probeBase, parsed?.probeBase && `${parsed.probeBase}${kind.healthPath}`]
      .filter((s) => typeof s === "string" && s.length >= 4);
    if (!parsed || parsed.invalid) {
      return {
        kind, configured: true, invalid: true, endpoint: null, host: null,
        probeUrl: null, probeHeaders: {}, secrets
      };
    }
    const headers = { accept: "application/json" };
    if (token) headers.authorization = `Bearer ${token}`;
    // Userinfo baked into the URL is converted to an explicit header so the
    // address we fetch — and therefore the address any error message quotes —
    // is the same scrubbed string we show the user.
    else if (parsed.username || parsed.password) {
      headers.authorization = `Basic ${Buffer.from(`${parsed.username ?? ""}:${parsed.password ?? ""}`).toString("base64")}`;
    }
    return {
      kind,
      configured: true,
      invalid: false,
      endpoint: parsed.endpoint,
      host: parsed.host,
      probeUrl: `${parsed.probeBase}${kind.healthPath}`,
      probeHeaders: headers,
      secrets
    };
  });
}

// Resolve as soon as everything settles OR the budget expires, whichever comes
// first — and never later than the budget. The timer is unref'd so a probe in
// flight can never be the reason a process refuses to exit.
function raceBudget(promises, budgetMs) {
  if (!promises.length) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    const timer = setTimeout(finish, budgetMs);
    if (typeof timer.unref === "function") timer.unref();
    Promise.allSettled(promises).then(() => { clearTimeout(timer); finish(); });
  });
}

export class ServiceProbe {
  constructor({
    fetchImpl = null,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    budgetMs = DEFAULT_BUDGET_MS,
    minIntervalMs = DEFAULT_MIN_INTERVAL_MS,
    kinds = SERVICE_KINDS
  } = {}) {
    // Resolved at call time so a test can swap globalThis.fetch, and so we
    // don't capture a fetch that hasn't been installed yet.
    this._fetch = fetchImpl ?? ((...args) => globalThis.fetch(...args));
    this._timeoutMs = timeoutMs;
    this._budgetMs = budgetMs;
    this._minIntervalMs = minIntervalMs;
    this._kinds = kinds;
    this._results = new Map();   // key -> { reachability, detail, checkedAt, at }
    this._inflight = new Map();  // key -> Promise (never rejects)
  }

  // Describe every service kind for a /nodes response. Never rejects, never
  // takes longer than budgetMs, and never reports a verdict it did not either
  // measure during this call or explicitly label as recalled.
  async describe({ env = process.env, now = Date.now() } = {}) {
    let configs;
    try { configs = readServiceConfig({ env, kinds: this._kinds }); } catch { return []; }

    // Snapshot what we already knew BEFORE kicking anything off. A result that
    // is a different object afterwards is one this request actually produced —
    // that identity check, not a timestamp comparison, is what makes "live"
    // mean live.
    const before = new Map();
    const started = [];
    for (const cfg of configs) {
      if (!cfg.configured || cfg.invalid) continue;
      const key = `${cfg.kind.id}|${cfg.probeUrl}`;
      before.set(key, this._results.get(key) ?? null);
      started.push(this._ensureProbe(key, cfg, now));
    }
    await raceBudget(started, this._budgetMs);
    const settledAt = Date.now();
    return configs.map((cfg) => this._entryFor(cfg, before, settledAt));
  }

  _ensureProbe(key, cfg, now) {
    const inflight = this._inflight.get(key);
    if (inflight) return inflight;
    const prev = this._results.get(key);
    // Rate-limit: a fresh-enough result is served as an explicitly CACHED
    // answer rather than re-probing. This keeps a dashboard refresh loop (or
    // two tabs) from hammering a service host, and the honesty cost is
    // paid in the response, which says the age out loud.
    if (prev && (now - prev.at) < this._minIntervalMs) return Promise.resolve();
    const promise = this._runProbe(key, cfg).finally(() => {
      if (this._inflight.get(key) === promise) this._inflight.delete(key);
    });
    this._inflight.set(key, promise);
    return promise;
  }

  // Always resolves. Writes its verdict into the result cache; a caller that
  // has already given up on the budget still gets the benefit next time.
  async _runProbe(key, cfg) {
    let verdict;
    try {
      const res = await this._fetch(cfg.probeUrl, {
        method: "GET",
        headers: cfg.probeHeaders,
        // Don't chase a redirect: it would carry the Authorization header to
        // wherever the redirect points.
        redirect: "manual",
        signal: AbortSignal.timeout(this._timeoutMs)
      });
      // The body is not part of the health contract. Cancel it rather than
      // materializing it: a misconfigured or compromised service can otherwise
      // stream an arbitrarily large response into this daemon's memory.
      try { await res.body?.cancel(); } catch { /* status is still authoritative */ }
      verdict = res.ok
        ? { reachability: "reachable", detail: null }
        : {
            reachability: "unreachable",
            detail: `the service answered HTTP ${res.status}${res.status === 401 || res.status === 403 ? " — it is running but rejected our token" : ""}`
          };
    } catch (error) {
      verdict = { reachability: "unreachable", detail: this._describeError(error, cfg) };
    }
    const at = Date.now();
    this._results.set(key, { ...verdict, at, checkedAt: new Date(at).toISOString() });
  }

  _describeError(error, cfg) {
    const name = error?.name;
    if (name === "TimeoutError" || name === "AbortError") {
      return `no answer within ${this._timeoutMs}ms — the machine may be asleep`;
    }
    const code = error?.cause?.code ?? error?.code ?? null;
    const raw = code ? `${code}${error?.message ? ` (${error.message})` : ""}` : (error?.message ?? "unknown error");
    return clip(scrubSecrets(raw, cfg.secrets));
  }

  _entryFor(cfg, before, now) {
    const base = {
      kind: "service",
      id: cfg.kind.id,
      name: cfg.kind.name,
      purpose: cfg.kind.purpose,
      endpoint: cfg.endpoint,
      host: cfg.host,
      configured: cfg.configured,
      origin: "local",
      originName: null
    };
    if (!cfg.configured) {
      return {
        ...base,
        reachability: "not-configured",
        detail: `Set ${cfg.kind.urlEnv} (and ${cfg.kind.tokenEnv}) to connect this service.`,
        checkedAt: null,
        checkBasis: "none",
        checkAgeMs: null
      };
    }
    if (cfg.invalid) {
      return {
        ...base,
        reachability: "unreachable",
        detail: `${cfg.kind.urlEnv} is not a usable http(s) URL, so this service was never contacted.`,
        checkedAt: null,
        checkBasis: "none",
        checkAgeMs: null
      };
    }
    const key = `${cfg.kind.id}|${cfg.probeUrl}`;
    const current = this._results.get(key) ?? null;
    if (!current) {
      // The probe is still running past the budget. Saying "unknown" is the
      // whole point: we have no evidence either way, and inventing one is how
      // this view lied to the user last time.
      return {
        ...base,
        reachability: "unknown",
        detail: `still checking — no answer within ${this._budgetMs}ms; this will resolve on the next refresh.`,
        checkedAt: null,
        checkBasis: "none",
        checkAgeMs: null
      };
    }
    const measuredHere = current !== before.get(key);
    return {
      ...base,
      reachability: current.reachability,
      detail: current.detail,
      checkedAt: current.checkedAt,
      checkBasis: measuredHere ? "live" : "cached",
      checkAgeMs: measuredHere ? 0 : Math.max(0, now - current.at)
    };
  }
}

// Take the `services` array off a main's /nodes response and re-describe it
// from this machine's point of view.
//
// Two things change on the way in. First, provenance: origin becomes "main" and
// the row carries the main's name, because a node did not measure any of this
// and must not imply that it did — checkBasis is "reported" (the main looked,
// just now, on our behalf) or "cached" (we are reading a roster we could not
// refresh). Second, distrust: the endpoint is re-scrubbed and the reachability
// value is re-validated here rather than being passed through, so a buggy or
// hostile main cannot inject a credentialed URL or an invented status word into
// this machine's UI.
//
// The trust implication, stated plainly: a main that does this advertises the
// host:port of every service it is configured with to every node paired to it.
// That is a real disclosure and it is a deliberate one. It is bounded by three
// things. The credential is NOT part of it — only the address is, and pairing
// already hands a node every sibling's self-reported url, so this discloses the
// same class of fact to the same audience. The node does not act on it: it
// never probes the endpoint (it has no token and no business holding one), it
// never builds a command out of it, and the address is display-only. And the
// alternative is worse in the way that matters — the user asked to see their
// machines, and the machine they look at is the node.
export function adoptRemoteServices(list, { originName = null, basis = "reported", now = Date.now() } = {}) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const id = str(raw.id);
    if (!id) continue;
    // Only real, configured services propagate. A main's "not configured"
    // placeholder is about the main's own setup and means nothing here.
    if (raw.configured !== true) continue;
    const parsed = scrubEndpoint(raw.endpoint);
    const checkedAt = str(raw.checkedAt);
    const t = checkedAt ? new Date(checkedAt).getTime() : NaN;
    out.push({
      kind: "service",
      id,
      name: str(raw.name) ?? id,
      purpose: clip(str(raw.purpose)),
      endpoint: parsed && !parsed.invalid ? parsed.endpoint : null,
      host: parsed && !parsed.invalid ? parsed.host : null,
      configured: true,
      reachability: REACHABILITY.has(raw.reachability) ? raw.reachability : "unknown",
      detail: clip(str(raw.detail)),
      checkedAt: Number.isFinite(t) ? checkedAt : null,
      checkBasis: basis,
      checkAgeMs: Number.isFinite(t) ? Math.max(0, now - t) : null,
      origin: "main",
      originName: str(originName)
    });
  }
  return out;
}

// One row per service id. A service this machine has configured itself is
// preferred over the main's report of the same id, because we measured it
// first-hand; a local "not configured" placeholder yields to a real one from
// the main, which is the ordinary case — the service is wired up on the main
// and the user is looking at their laptop.
export function mergeServices(local = [], remote = []) {
  const byId = new Map();
  for (const s of Array.isArray(local) ? local : []) {
    if (s && typeof s === "object" && str(s.id)) byId.set(s.id, s);
  }
  for (const s of Array.isArray(remote) ? remote : []) {
    if (!s || typeof s !== "object" || !str(s.id)) continue;
    const existing = byId.get(s.id);
    if (existing && existing.configured === true) continue;
    byId.set(s.id, s);
  }
  return [...byId.values()].sort((a, b) => String(a.id).localeCompare(String(b.id)));
}
