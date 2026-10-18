// Model provider that runs on the owner's ChatGPT plan (Sign in with ChatGPT).
//
// Same interface as OpenAIResponsesProvider and built on it: the tool loop,
// streaming parse, context trimming and turn-spend logic are all reused. What
// changes is the transport, through a fetch wrapper:
//   - Authorization is the ChatGPT OAuth access token (refreshed as needed),
//     not an API key;
//   - every request is store:false, stream:true, and drops the fields the
//     plan-usage route rejects;
//   - function tools are grouped in a namespace;
//   - 401 refreshes once, then fails as chatgpt-signed-out; a usage limit
//     fails as chatgpt-plan-limit (also when it arrives mid-stream).
//
// Docs:
//   https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference
//   https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations
//   https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery
//
// OpenAIResponsesProvider is constructed inside the constructor (composition,
// not `extends`) so model-provider.js can import this file without an
// import-cycle TDZ error.

import { OpenAIResponsesProvider } from "./model-provider.js";
import { ModelRouter } from "./model-router.js";
import { resolveDataDir } from "./data-dir.js";
import { ChatGPTAuthError, getAccessToken, isPlanUsable } from "./chatgpt-auth.js";

/// Public Responses API; never ChatGPT's backend-api (models-and-inference#2).
export const CHATGPT_API_BASE_URL = "https://api.openai.com/v1";
/// The docs' own example model. Real choices come from listModels().
export const CHATGPT_DEFAULT_MODEL = "gpt-6.1-sol";
/// Preview limitations: "Group function/custom tools in namespaces or supply
/// them through additional_tools input items." Namespace shape is from
/// https://developers.openai.com/api/docs/guides/tools-tool-search.
export const CHATGPT_TOOL_NAMESPACE = "openagi";

// Responses fields the plan-usage route rejects (preview-limitations).
const UNSUPPORTED_FIELDS = [
  "background", "conversation", "max_output_tokens", "max_tool_calls", "metadata",
  "moderation", "multi_agent", "prompt", "prompt_cache_retention", "safety_identifier",
  "temperature", "top_logprobs", "top_p", "truncation", "user", "previous_response_id"
];

const PLAN_LIMIT_MESSAGE = "Your ChatGPT plan's usage limit is reached for now. Check ChatGPT Settings > Usage, or add an API key to keep going.";
const SIGNED_OUT_MESSAGE = "ChatGPT sign-in is needed. Sign in with ChatGPT again.";

export class ChatGPTPlanError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = "ChatGPTPlanError";
    this.code = code;
    Object.assign(this, extra);
  }
}

/// Map an upstream status / Responses error code to a ChatGPTPlanError.
export function planErrorFor({ status, upstreamCode, detail, requestId }) {
  const extra = { status, upstreamCode: upstreamCode ?? null, requestId: requestId ?? null };
  if (status === 429 || upstreamCode === "subscription_sharing_usage_limit_exceeded") {
    return new ChatGPTPlanError("chatgpt-plan-limit", PLAN_LIMIT_MESSAGE, extra);
  }
  if (status === 401 || upstreamCode === "subscription_sharing_invalid_user") {
    return new ChatGPTPlanError("chatgpt-signed-out", SIGNED_OUT_MESSAGE, extra);
  }
  if (upstreamCode === "subscription_sharing_user_not_eligible") {
    return new ChatGPTPlanError("chatgpt-not-eligible", "This ChatGPT account or workspace can't use its plan in OpenAGI. Add an API key instead.", extra);
  }
  if (status === 503 || upstreamCode === "subscription_sharing_usage_unavailable" || upstreamCode === "subscription_sharing_user_unavailable") {
    return new ChatGPTPlanError("chatgpt-unavailable", "ChatGPT plan usage is briefly unavailable. Try again in a minute.", extra);
  }
  const why = detail ? `: ${detail}` : "";
  return new ChatGPTPlanError("chatgpt-request-failed", `ChatGPT plan request failed (${status ?? upstreamCode ?? "error"})${why}`, extra);
}

function requestIdOf(response) {
  return response?.headers?.get?.("x-request-id") ?? response?.headers?.get?.("openai-request-id") ?? null;
}

async function errorFromResponse(response) {
  const text = await response.text().catch(() => "");
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  // Direct-admission failures can be {"detail": "..."} instead of an error object.
  const upstreamCode = json?.error?.code ?? null;
  const detail = json?.error?.message ?? (typeof json?.detail === "string" ? json.detail : null);
  return planErrorFor({ status: response.status, upstreamCode, detail, requestId: requestIdOf(response) });
}

/// Rewrites a Responses request body for the plan-usage route.
export function toPlanRequestBody(body, { namespace = CHATGPT_TOOL_NAMESPACE } = {}) {
  const next = { ...body, store: false, stream: true };
  for (const field of UNSUPPORTED_FIELDS) delete next[field];
  if (Array.isArray(next.tools) && next.tools.length > 0 && namespace) {
    const functions = next.tools.filter((tool) => tool?.type === "function" || tool?.type === "custom");
    const others = next.tools.filter((tool) => !(tool?.type === "function" || tool?.type === "custom"));
    next.tools = functions.length > 0
      ? [...others, { type: "namespace", name: namespace, description: "OpenAGI tools.", tools: functions }]
      : others;
    // Replayed function_call items carry the namespace the call came from.
    if (functions.length > 0 && Array.isArray(next.input)) {
      next.input = next.input.map((item) => (item?.type === "function_call" && !item.namespace ? { ...item, namespace } : item));
    }
  }
  return next;
}

/// Pass SSE bytes through untouched, but turn a response.failed / error event
/// that carries a plan-usage code into a stream error with a stable code, so
/// the caller sees chatgpt-plan-limit instead of a bare message.
function watchPlanFailures(body, requestId) {
  const decoder = new TextDecoder();
  let pending = "";
  return body.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      pending += decoder.decode(chunk, { stream: true });
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        let payload;
        try { payload = JSON.parse(line.slice(5).trim()); } catch { continue; }
        const type = payload?.type;
        if (type !== "response.failed" && type !== "error") continue;
        const error = payload.response?.error ?? payload.error ?? payload;
        const code = error?.code ?? null;
        if (typeof code === "string" && (code.startsWith("subscription_sharing_") || code.startsWith("chatpass_"))) {
          controller.error(planErrorFor({ status: null, upstreamCode: code, detail: error?.message, requestId }));
          return;
        }
      }
      controller.enqueue(chunk);
    }
  }));
}

export class ChatGPTPlanProvider {
  constructor(options = {}) {
    this.name = "chatgpt";
    this.dataDir = options.dataDir ?? resolveDataDir();
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.toolNamespace = options.toolNamespace ?? CHATGPT_TOOL_NAMESPACE;
    const model = options.model ?? process.env.CHATGPT_MODEL ?? CHATGPT_DEFAULT_MODEL;
    this.inner = new OpenAIResponsesProvider({
      ...options,
      // Placeholder so the inner provider's key check passes; the real
      // bearer is set per request in planFetch.
      apiKey: "chatgpt-oauth",
      baseUrl: CHATGPT_API_BASE_URL,
      model,
      router: options.router ?? new ModelRouter({ envPrefix: "CHATGPT", baseModel: model }),
      fetchImpl: (url, init) => this.planFetch(url, init)
    });
    // Every request on this route streams (stream:true is required).
    this.inner.postResponses = (body, context) => this.inner.postResponsesStream(body, context, null);
  }

  get model() { return this.inner.model; }
  set model(value) {
    this.inner.model = value;
    if (this.inner.router) this.inner.router.baseModel = value;
  }
  get maxToolHops() { return this.inner.maxToolHops; }
  get budgetGuard() { return this.inner.budgetGuard; }
  get router() { return this.inner.router; }

  isConfigured() {
    return isPlanUsable(this.dataDir);
  }

  resolveModel(args) {
    return this.inner.resolveModel(args);
  }

  async generate(args = {}) {
    if (!this.isConfigured()) throw new ChatGPTPlanError("chatgpt-signed-out", SIGNED_OUT_MESSAGE);
    const relabel = (fn) => (typeof fn === "function"
      ? (event) => fn(event?.provider === "openai" ? { ...event, provider: "chatgpt" } : event)
      : fn);
    const result = await this.inner.generate({
      ...args,
      onProgress: relabel(args.onProgress),
      onTextDelta: relabel(args.onTextDelta)
    });
    return { ...result, provider: "chatgpt" };
  }

  /// The signed-in account's model catalog for a picker:
  /// [{ slug, displayName }] in server order (models-and-inference#1).
  async listModels() {
    const response = await this.authorizedFetch(`${CHATGPT_API_BASE_URL}/models`, { method: "GET", headers: { accept: "application/json" } });
    if (!response.ok) throw await errorFromResponse(response);
    const json = await response.json().catch(() => ({}));
    return (Array.isArray(json?.models) ? json.models : [])
      .filter((entry) => entry?.visibility === "list")
      .map((entry) => ({ slug: entry.slug, displayName: entry.display_name ?? entry.slug }));
  }

  async token(options = {}) {
    try {
      return await getAccessToken({ dataDir: this.dataDir, fetchImpl: this.fetchImpl, ...options });
    } catch (error) {
      if (error instanceof ChatGPTAuthError && error.code === "chatgpt-signed-out") {
        throw new ChatGPTPlanError("chatgpt-signed-out", SIGNED_OUT_MESSAGE, { cause: error });
      }
      throw error;
    }
  }

  /// Sends with the current bearer; on 401 refreshes once and retries.
  async authorizedFetch(url, init = {}) {
    const send = (token) => this.fetchImpl(url, {
      ...init,
      headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}` }
    });
    const token = await this.token();
    let response = await send(token);
    if (response.status === 401) {
      await response.body?.cancel?.().catch(() => {});
      const fresh = await this.token({ forceRefresh: true, staleToken: token });
      response = await send(fresh);
      if (response.status === 401) throw await errorFromResponse(response);
    }
    return response;
  }

  /// fetch used by the inner OpenAIResponsesProvider for POST /responses.
  async planFetch(url, init = {}) {
    let body = init.body;
    if (typeof body === "string") {
      try { body = JSON.stringify(toPlanRequestBody(JSON.parse(body), { namespace: this.toolNamespace })); } catch { /* not JSON: send as-is */ }
    }
    const response = await this.authorizedFetch(url, {
      ...init,
      headers: { ...(init.headers ?? {}), accept: "text/event-stream", "content-type": "application/json" },
      body
    });
    if (!response.ok) throw await errorFromResponse(response);
    if (!response.body || !String(response.headers?.get?.("content-type") ?? "").includes("text/event-stream")) return response;
    return new Response(watchPlanFailures(response.body, requestIdOf(response)), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    });
  }
}
