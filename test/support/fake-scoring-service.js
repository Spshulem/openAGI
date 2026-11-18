// An in-process stand-in for the optional local scoring service: a
// ModelClient wired to a fake fetch that answers each endpoint from `routes`
// ("METHOD /path" -> body object, or (body) => body or a promise of one;
// null answers 503).
import fs from "node:fs";
import path from "node:path";
import { ModelClient } from "../../src/learning/model-client.js";

export const FAKE_SERVICE_URL = "http://127.0.0.1:43211";

export function defaultRoutes() {
  return {
    "GET /health": {
      ok: true,
      model: "test",
      version: "v1",
      trained_through: "2026-01-31",
      heads: {
        t2: { labels: 200, auroc: 0.8, usable: true },
        value: { labels: 300, auroc: 0.7, usable: true },
        keep: { labels: 300, auroc: 0.7, usable: true }
      },
      thresholds: { suggestion: 0.3 }
    },
    "POST /score/suggestion": { p_accept: 0.6, version: "v1" },
    "POST /score/turn": { p_stop: 0.2, p_nudge: 0.1, version: "v1" },
    "POST /score/signal": { value: 0.9, version: "v1" },
    "POST /memory/keep": (body) => ({
      scores: Object.fromEntries((body?.items ?? []).map((item) => [item.id, 0.8])),
      version: "v1"
    }),
    "POST /cluster-of": { cluster: 7, similarity: 0.8 },
    "GET /clusters": [{ cluster: 7, n_7d: 12 }]
  };
}

/**
 * Returns { client, calls, routes }. calls is the list of "METHOD /path"
 * requests made, with their parsed bodies.
 */
export function fakeScoringService(dir, routeOverrides = {}) {
  const tokenFile = path.join(dir, "service.token");
  fs.writeFileSync(tokenFile, `${"a".repeat(64)}\n`, { mode: 0o600 });
  const routes = { ...defaultRoutes(), ...routeOverrides };
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const key = `${init.method ?? "GET"} ${new URL(url).pathname}`;
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ key, body });
    const route = routes[key];
    const json = typeof route === "function" ? await route(body) : route;
    if (json === null || json === undefined) return new Response("{}", { status: 503 });
    return new Response(JSON.stringify(json), { status: 200, headers: { "content-type": "application/json" } });
  };
  const client = new ModelClient({ url: FAKE_SERVICE_URL, tokenFile, fetchImpl, timeoutMs: 2000 });
  return { client, calls, routes };
}

/** Run fn with these environment variables set (undefined deletes), then restore them. */
export async function withEnv(vars, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(vars)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

export const LEARNED_ENV_UNSET = {
  OPENAGI_LEARNED_SUGGESTIONS: undefined,
  OPENAGI_LEARNED_SCRUTINY: undefined,
  OPENAGI_LEARNED_MEMORY: undefined,
  OPENAGI_LEARNED_PROPAGATION: undefined,
  OPENAGI_ROUTING_MODE: undefined
};
