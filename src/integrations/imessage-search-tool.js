// Main-side read-only iMessage search. The preferred transport is a paired
// Mac's authenticated outbound capability channel; the legacy direct HTTP
// service remains available for compatibility when explicitly configured.

const CAPABILITY = "imessage-search";
const OPERATION = "search";
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_QUERY_BYTES = 2 * 1024;
const MAX_PERSON_BYTES = 320;

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function boundedString(value, label, maxBytes, { optional = true } = {}) {
  if (value === undefined || value === null) {
    if (optional) return null;
    throw new Error(`${label} is required`);
  }
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new Error(`${label} is invalid or too long`);
  }
  return value;
}

function normalizeArgs(raw = {}) {
  if (!isPlainObject(raw)) throw new Error("search arguments must be an object");
  const allowed = new Set(["query", "person", "days", "limit", "node"]);
  if (Object.keys(raw).some((key) => !allowed.has(key))) throw new Error("unsupported search field");
  const query = boundedString(raw.query, "query", MAX_QUERY_BYTES) ?? "";
  const person = boundedString(raw.person, "person", MAX_PERSON_BYTES);
  const node = boundedString(raw.node, "node", 200);
  const days = raw.days == null ? null : raw.days;
  const limit = raw.limit == null ? 20 : raw.limit;
  if (days !== null && (!Number.isSafeInteger(days) || days < 1 || days > 3650)) {
    throw new Error("days must be an integer from 1 to 3650");
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("limit must be an integer from 1 to 100");
  }
  return { query, person, days, limit, node };
}

function legacyEndpoint(env) {
  const configured = String(env?.OPENAGI_IMESSAGE_NODE ?? "").trim();
  if (!configured) return null;
  try {
    const url = new URL(configured);
    const loopback = url.hostname === "127.0.0.1" || url.hostname === "::1" || url.hostname === "localhost";
    if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
      || url.username || url.password || url.search || url.hash
      || (url.pathname !== "/" && url.pathname !== "")) return null;
    return { base: url.origin, token: env?.OPENAGI_IMESSAGE_NODE_TOKEN ?? null };
  } catch {
    return null;
  }
}

function readyCandidates(runtime) {
  return (runtime.nodeCapabilities?.list?.(CAPABILITY) ?? []).filter((record) => (
    record?.capabilities?.some?.((capability) => (
      capability.id === CAPABILITY
      && capability.ready === true
      && capability.operations?.includes?.(OPERATION)
    ))
  ));
}

async function readJsonLimited(response, maxBytes = MAX_RESPONSE_BYTES) {
  if (response?.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value?.byteLength ?? 0;
        if (total > maxBytes) throw new Error("response-too-large");
        chunks.push(Buffer.from(value));
      }
    } finally {
      reader.releaseLock?.();
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }
  if (typeof response?.text === "function") {
    const value = await response.text();
    if (Buffer.byteLength(value, "utf8") > maxBytes) throw new Error("response-too-large");
    return JSON.parse(value);
  }
  const value = await response?.json?.();
  if (Buffer.byteLength(JSON.stringify(value ?? {}), "utf8") > maxBytes) throw new Error("response-too-large");
  return value;
}

function clipUtf8(value, maxBytes) {
  const source = typeof value === "string" ? value : "";
  if (Buffer.byteLength(source, "utf8") <= maxBytes) return source;
  let out = "";
  let used = 0;
  for (const character of source) {
    const size = Buffer.byteLength(character, "utf8");
    if (used + size > maxBytes) break;
    out += character;
    used += size;
  }
  return out;
}

function publicResults(body, limit) {
  const source = Array.isArray(body?.results) ? body.results.slice(0, limit) : [];
  const results = [];
  for (const row of source) {
    if (!row || typeof row !== "object") continue;
    results.push({
      from: row.fromMe === true ? "me" : clipUtf8(row.handle, MAX_PERSON_BYTES),
      at: typeof row.date === "string" ? row.date.slice(0, 64) : null,
      text: clipUtf8(row.text, 32 * 1024)
    });
  }
  while (Buffer.byteLength(JSON.stringify({ count: results.length, results }), "utf8") > MAX_RESPONSE_BYTES) {
    results.pop();
  }
  return { count: results.length, results, truncated: body?.truncated === true || source.length > results.length };
}

async function callLegacy(endpoint, args, fetchImpl, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetchImpl(`${endpoint.base}/search`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(endpoint.token ? { authorization: `Bearer ${endpoint.token}` } : {})
      },
      body: JSON.stringify({ query: args.query, handle: args.person, days: args.days, limit: args.limit }),
      redirect: "manual",
      signal: controller.signal
    });
    if (!response?.ok) throw new Error("legacy-search-failed");
    return publicResults(await readJsonLimited(response), args.limit);
  } finally {
    clearTimeout(timer);
  }
}

export function registerImessageSearchTool(runtime, {
  fetchImpl = globalThis.fetch,
  env = process.env,
  timeoutMs = 5_000
} = {}) {
  if (runtime.tools.has?.("search_imessages")) return { registered: true, existing: true };
  const hasCapabilityFacade = Boolean(runtime.nodeCapabilities?.resolve && runtime.nodeCapabilities?.dispatch);
  const legacy = legacyEndpoint(env);
  if (!hasCapabilityFacade && !legacy) {
    return { registered: false, reason: "no paired iMessage capability or secure legacy endpoint" };
  }

  runtime.tools.register({
    name: "search_imessages",
    sideEffects: false,
    description: "Search iMessage history on an explicitly enabled paired Mac. Results are newest-first. If multiple capable Macs are online, select one by its node name or ID.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Text to search for (substring match)." },
        person: { type: "string", description: "Optional phone number or email handle filter." },
        days: { type: "integer", minimum: 1, maximum: 3650, description: "Only messages from the last N days." },
        limit: { type: "integer", minimum: 1, maximum: 100, description: "Maximum results (default 20)." },
        node: { type: "string", description: "Paired node name or ID. Required when more than one ready iMessage node is online." }
      },
      additionalProperties: false
    },
    handler: async (rawArgs) => {
      let args;
      try { args = normalizeArgs(rawArgs); }
      catch (error) { return { error: error.message }; }

      if (hasCapabilityFacade) {
        // Local providers are measured asynchronously after the hosted facade
        // is installed. Refresh at invocation so the first real search does not
        // depend on an unrelated visit to the Nodes page.
        try { await runtime.nodeCapabilities.refresh?.(); } catch { /* remote candidates may still be usable */ }
        const candidates = readyCandidates(runtime);
        if (!args.node && candidates.length > 1) {
          return { error: "Multiple iMessage-capable nodes are online; specify the node name or ID." };
        }
        const record = runtime.nodeCapabilities.resolve(CAPABILITY, {
          nodeId: args.node,
          nodeName: args.node
        });
        if (record) {
          try {
            const body = await runtime.nodeCapabilities.dispatch(
              record.nodeId,
              CAPABILITY,
              OPERATION,
              { query: args.query, person: args.person, days: args.days, limit: args.limit },
              { timeoutMs }
            );
            return publicResults(body, args.limit);
          } catch {
            return { error: "The selected iMessage node could not complete the search." };
          }
        }
        if (args.node || candidates.length > 0 || !legacy) {
          return { error: "No matching ready iMessage-search node is available." };
        }
      }

      try {
        return await callLegacy(legacy, args, fetchImpl, timeoutMs);
      } catch {
        return { error: "The configured legacy iMessage service could not complete the search." };
      }
    }
  });
  return { registered: true, transport: hasCapabilityFacade ? "paired-node" : "legacy" };
}
