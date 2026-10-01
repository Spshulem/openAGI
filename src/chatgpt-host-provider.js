import { createHash } from "node:crypto";

const RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";

function credentialFingerprint(accessToken) {
  let identity = accessToken;
  try {
    const claims = JSON.parse(Buffer.from(accessToken.split(".")[1], "base64url").toString("utf8"));
    const account = claims?.["https://api.openai.com/auth"]?.chatgpt_account_id;
    if (typeof claims?.sub === "string" && claims.sub && typeof account === "string" && account) {
      identity = `${claims.sub}\0${account}`;
    }
  } catch { /* Opaque tokens are pinned by their own bytes. */ }
  return createHash("sha256").update(identity).digest("hex");
}

function receiptResponseIdHash(responseId) {
  if (typeof responseId !== "string" || !responseId || responseId.length > 256) {
    throw Object.assign(new Error("ChatGPT response omitted its correlation id."), { code: "CHATGPT_PROTOCOL" });
  }
  return createHash("sha256").update(responseId).digest("hex");
}

function codexInput(input) {
  return input.map((item) => {
    if (item.type || !["user", "assistant"].includes(item.role)) return item;
    if (typeof item.content === "string") {
      return { ...item, content: [{ type: item.role === "user" ? "input_text" : "output_text", text: item.content }] };
    }
    return item;
  });
}

function accountHeaders(accessToken) {
  try {
    const encoded = accessToken.split(".")[1];
    if (!encoded || encoded.length > 8192) return {};
    const claims = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"))["https://api.openai.com/auth"];
    const headers = {};
    if (typeof claims?.chatgpt_account_id === "string" && /^[\w-]{1,128}$/.test(claims.chatgpt_account_id)) {
      headers["ChatGPT-Account-ID"] = claims.chatgpt_account_id;
    }
    const residency = claims?.chatgpt_data_residency || claims?.chatgpt_compute_residency;
    if (typeof residency === "string" && /^[\w-]{1,64}$/.test(residency)) {
      headers["x-openai-internal-codex-residency"] = residency;
    }
    return headers;
  } catch { return {}; }
}

function validateFunctionCalls(items, advertisedTools) {
  const seen = new Set();
  for (const item of items) {
    if (item?.type !== "function_call") continue;
    const id = item.call_id;
    if (typeof id !== "string" || !id || id.length > 256 || seen.has(id)
      || typeof item.name !== "string" || !advertisedTools.has(item.name)
      || typeof item.arguments !== "string") {
      throw Object.assign(new Error("Invalid ChatGPT tool response."), { code: "CHATGPT_PROTOCOL" });
    }
    let args;
    try { args = JSON.parse(item.arguments); }
    catch { throw Object.assign(new Error("Invalid ChatGPT tool arguments."), { code: "CHATGPT_PROTOCOL" }); }
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      throw Object.assign(new Error("Invalid ChatGPT tool arguments."), { code: "CHATGPT_PROTOCOL" });
    }
    seen.add(id);
  }
  return [...seen];
}

export class ChatGptHostResponsesProvider {
  #base;
  #turnCredentials = new WeakMap();
  #turnCallIds = new WeakMap();
  #turnReports = new WeakMap();

  constructor({ oauth, baseProvider, fetchImpl = globalThis.fetch, consumeSse, qualified = false, pinnedModel = false, ownerOnly = false, capabilityTier = null, selectionGeneration = null, readSelection = null } = {}) {
    if (!oauth?.getAccessToken || !baseProvider?.generate || !consumeSse) {
      throw new TypeError("Host-owned ChatGPT OAuth and OpenAGI Responses loop are required.");
    }
    this.oauth = oauth;
    this.#base = baseProvider;
    this.fetchImpl = fetchImpl;
    this.consumeSse = consumeSse;
    this.qualified = qualified === true;
    this.pinnedModel = pinnedModel;
    this.ownerOnly = ownerOnly;
    this.capabilityTier = capabilityTier;
    this.selectionGeneration = selectionGeneration;
    this.readSelection = typeof readSelection === "function" ? readSelection : null;
    if (this.capabilityTier === "provisional-chat-only") {
      this.#base.maxToolHops = 1;
      this.#base.noFinalRetry = true;
    }
    this.providerId = "openai-chatgpt";
    this.model = baseProvider.model;
    this.reasoningEffort = baseProvider.reasoningEffort;
    this.timeoutMs = baseProvider.timeoutMs;
    this.streamLimits = baseProvider.streamLimits;
    this.#base.preserveEncryptedReasoning = this.capabilityTier !== "provisional-chat-only";
    this.#base.postResponses = this.#postResponses.bind(this);
    this.#base.postResponsesStream = this.#postResponsesStream.bind(this);
  }

  isConfigured() { return Boolean(this.oauth && this.qualified); }

  assertQualified() {
    if (!this.isConfigured()) {
      throw Object.assign(new Error("Host-owned ChatGPT inference is not qualified."), { code: "CHATGPT_NOT_QUALIFIED" });
    }
  }

  async generate(options) {
    this.assertQualified();
    if (this.ownerOnly && ((options.task ?? "chat") !== "chat" || options.agent?.role === "specialist"
      || options.context?.channel !== "local" || options.context?.localOwner !== true)) {
      throw Object.assign(new Error("ChatGPT subscription is limited to interactive owner chat."), { code: "CHATGPT_PROVENANCE_DENIED" });
    }
    const provisionalChatOnly = this.capabilityTier === "provisional-chat-only";
    if (provisionalChatOnly && typeof options.context?.assertChatGptOwnerAuthority !== "function") {
      throw Object.assign(new Error("ChatGPT subscription is limited to interactive owner chat."), {
        code: "CHATGPT_PROVENANCE_DENIED"
      });
    }
    let selectedModel = this.#base.resolveModel(options);
    if (provisionalChatOnly && !this.pinnedModel) {
      throw Object.assign(new Error("ChatGPT requires an exact selected account model."), { code: "CHATGPT_MODEL_SELECTION_REQUIRED" });
    }
    if (provisionalChatOnly) await this.assertSelectionCurrent();
    if (provisionalChatOnly && selectedModel !== this.model) {
      throw Object.assign(new Error("ChatGPT model is not the selected account model."), { code: "CHATGPT_MODEL_UNAVAILABLE" });
    }
    // A provisional chat turn has exactly one upstream request: the Responses
    // POST. The selected model was already verified during owner-only account
    // discovery and may not silently fall back; a later entitlement change is
    // therefore reported by the terminal Responses result, not by a per-turn
    // catalogue fetch.
    if (!provisionalChatOnly && typeof this.oauth.listModels === "function") {
      const models = await this.oauth.listModels();
      if (!Array.isArray(models) || models.length === 0) {
        throw Object.assign(new Error("ChatGPT account models unavailable."), { code: "CHATGPT_CATALOG_UNAVAILABLE" });
      }
      if (!models.includes(selectedModel)) {
        if (provisionalChatOnly) {
          throw Object.assign(new Error("ChatGPT model unavailable for this account."), { code: "CHATGPT_MODEL_UNAVAILABLE" });
        }
        if (options.model || this.pinnedModel || selectedModel !== this.model) {
          throw Object.assign(new Error("ChatGPT model unavailable for this account."), { code: "CHATGPT_MODEL_UNAVAILABLE" });
        }
        selectedModel = models[0];
      }
    }
    // A failed turn cannot leave a displayed provisional answer. The existing
    // OpenAGI tool loop remains authoritative; it never delegates tool execution.
    const context = { ...(options.context ?? {}) };
    this.#turnCallIds.set(context, new Set());
    const reports = [];
    this.#turnReports.set(context, reports);
    Object.defineProperties(context, {
      __chatgptCheckCredential: { value: async () => { await this.boundAccessToken(context); } }
    });
    const result = await this.#base.generate({ ...options, model: selectedModel, context,
      ...(provisionalChatOnly ? { tools: [], toolRegistry: null, maxToolHops: 1 } : {}),
      onTextDelta: () => {}, onProgress: (event) => {
      options.onProgress?.({ ...event, provider: "openai-chatgpt" });
    } });
    context.signal?.throwIfAborted();
    await context.__chatgptCheckCredential();
    context.signal?.throwIfAborted();
    const modelReported = reports.length && reports.every((model) => model === selectedModel)
      ? selectedModel : null;
    if (provisionalChatOnly && modelReported !== selectedModel) {
      throw Object.assign(new Error("ChatGPT response did not attest the requested model."), { code: "CHATGPT_MODEL_MISMATCH" });
    }
    const operationalReceipt = provisionalChatOnly ? {
      schema: "openagi.codex-provisional-turn.v1",
      scope: "owner-interactive-chat-only",
      transport: "chatgpt-codex-responses",
      capabilityTier: "provisional-chat-only",
      modelRequested: selectedModel,
      modelReported,
      reasoningEffortConfigured: this.reasoningEffort,
      reasoningEffortEffective: "unknown",
      terminalResponse: "completed",
      toolEffects: "none",
      responseIdSha256: receiptResponseIdHash(result.id)
    } : null;
    options.onTextDelta?.({ text: result.text, reset: true, provider: "openai-chatgpt", model: selectedModel });
    context.signal?.throwIfAborted();
    return {
      ...result, id: provisionalChatOnly ? null : result.id, model: selectedModel,
      toolCalls: provisionalChatOnly ? [] : result.toolCalls,
      provider: "openai-chatgpt", modelRequested: selectedModel, modelReported,
      reasoningEffortConfigured: this.reasoningEffort, reasoningEffortEffective: provisionalChatOnly ? "unknown" : null,
      ...(operationalReceipt ? { operationalReceipt } : {}),
      usage: { billingMode: "chatgpt-subscription", usd: null }
    };
  }

  async assertSelectionCurrent() {
    if (typeof this.selectionGeneration !== "string" || !this.oauth.getCredentialGeneration) {
      throw Object.assign(new Error("ChatGPT model selection requires the current OAuth credential generation."), {
        code: "CHATGPT_MODEL_SELECTION_STALE"
      });
    }
    let credentialGeneration;
    try { credentialGeneration = await this.oauth.getCredentialGeneration(); }
    catch { credentialGeneration = null; }
    this.assertSelectionBinding(credentialGeneration);
  }

  assertSelectionBinding(credentialGeneration) {
    let selection = null;
    try { selection = this.readSelection?.() ?? null; }
    catch { selection = null; }
    if (credentialGeneration !== this.selectionGeneration
      || (this.readSelection && (selection?.model !== this.model
        || selection?.credentialGeneration !== this.selectionGeneration))) {
      throw Object.assign(new Error("ChatGPT model selection is stale for the current OAuth credential."), {
        code: "CHATGPT_MODEL_SELECTION_STALE"
      });
    }
  }

  async postResponses(body, context = {}) {
    throw Object.assign(new Error("Raw ChatGPT Responses transport is private to the host-owned provider loop."), {
      code: "CHATGPT_TRANSPORT_PRIVATE"
    });
  }

  async postResponsesStream(body, context = {}) {
    throw Object.assign(new Error("Raw ChatGPT Responses transport is private to the host-owned provider loop."), {
      code: "CHATGPT_TRANSPORT_PRIVATE"
    });
  }

  async boundAccessToken(context) {
    context.signal?.throwIfAborted();
    const generationBefore = await this.oauth.getCredentialGeneration?.();
    const accessToken = await this.oauth.getAccessToken();
    context.signal?.throwIfAborted();
    const generationAfter = await this.oauth.getCredentialGeneration?.();
    const binding = `${generationAfter ?? "no-generation"}:${credentialFingerprint(accessToken)}`;
    const previousBinding = this.#turnCredentials.get(context);
    if (generationBefore !== generationAfter || (previousBinding && previousBinding !== binding)) {
      throw Object.assign(new Error("ChatGPT credential changed during the turn."), { code: "CHATGPT_CREDENTIAL_CHANGED" });
    }
    if (this.capabilityTier === "provisional-chat-only") {
      this.assertSelectionBinding(generationBefore);
      this.assertSelectionBinding(generationAfter);
    }
    this.#turnCredentials.set(context, binding);
    return { accessToken, generation: generationAfter };
  }

  async #postResponses(body, context = {}) {
    return this.#postResponsesStream(body, context);
  }

  async #postResponsesStream(body, context = {}) {
    this.assertQualified();
    const { accessToken, generation: generationAfter } = await this.boundAccessToken(context);
    const tools = body.tools?.map((tool) => tool.type === "function" && tool.function
      ? { type: "function", ...tool.function }
      : tool);
    const request = {
      ...body, input: codexInput(body.input), stream: true, store: false,
      ...(tools ? { tools, tool_choice: "auto" } : {})
    };
    if (body.reasoning && this.capabilityTier !== "provisional-chat-only") request.include = ["reasoning.encrypted_content"];
    // `localOwner` is established at HTTP admission, while a tunnel or setup
    // change can make the listener public during token binding. The host-owned
    // callback is injected only by the local transport and must authorize the
    // exact dispatch point.
    await context.assertChatGptOwnerAuthority?.();
    const response = await this.fetchImpl(RESPONSES_URL, {
      method: "POST", redirect: "error",
      signal: context.signal ? AbortSignal.any([context.signal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs),
      headers: {
        "content-type": "application/json", accept: "text/event-stream",
        authorization: `Bearer ${accessToken}`,
        "user-agent": "OpenAGI/0.0.26", originator: "openagi",
        ...accountHeaders(accessToken)
      },
      body: JSON.stringify(request)
    });
    context.signal?.throwIfAborted();
    // Never propagate upstream error bodies: they can contain sensitive input.
    const mediaType = String(response.headers.get("content-type") ?? "").split(";", 1)[0].trim().toLowerCase();
    // The Codex backend has returned HTTP 200 with no Content-Type in the
    // isolated pilot. Only an absent type may be parsed: the bounded SSE
    // reader and terminal/model checks below must still prove completion.
    // An explicitly non-SSE type, failed status or absent body stays denied.
    if (!response.ok || (mediaType && mediaType !== "text/event-stream") || !response.body?.getReader) {
      const transportContentType = mediaType === "text/event-stream" ? "sse"
        : mediaType === "application/json" ? "json"
          : mediaType === "text/html" ? "html" : mediaType ? "other" : "missing";
      throw Object.assign(new Error("ChatGPT Responses transport rejected the request."), {
        code: "CHATGPT_TRANSPORT", transportStatus: Number.isInteger(response.status) ? response.status : null,
        transportContentType
      });
    }
    const output = [];
    let completed = null;
    await this.consumeSse(response.body, (event) => {
      if (event.data === "[DONE]") {
        if (!completed) throw Object.assign(new Error("ChatGPT stream ended before its terminal response."), { code: "CHATGPT_PROTOCOL" });
        return true;
      }
      if (completed) throw Object.assign(new Error("Duplicate ChatGPT terminal response."), { code: "CHATGPT_PROTOCOL" });
      let payload;
      try { payload = JSON.parse(event.data); }
      catch { throw Object.assign(new Error("Invalid ChatGPT SSE event."), { code: "CHATGPT_PROTOCOL" }); }
      const type = payload?.type ?? event.name;
      if (type === "response.output_item.done") {
        if (payload.item && typeof payload.item === "object") output.push(payload.item);
      } else if (type === "response.completed") {
        completed = payload.response;
      } else if (type === "response.failed" || type === "response.incomplete" || type === "error") {
        throw Object.assign(new Error("ChatGPT response did not complete."), { code: "CHATGPT_RESPONSE_FAILED" });
      }
    }, null, this.streamLimits);
    context.signal?.throwIfAborted();
    if ((await this.oauth.getCredentialGeneration?.()) !== generationAfter) {
      throw Object.assign(new Error("ChatGPT credential changed during the turn."), { code: "CHATGPT_CREDENTIAL_CHANGED" });
    }
    if (!completed || completed.status !== "completed" || completed.error) {
      throw Object.assign(new Error("ChatGPT response did not complete."), { code: "CHATGPT_RESPONSE_FAILED" });
    }
    // In the owner-only subscription route, do not run host tools or publish
    // text without server-authored model identity for this exact response.
    if ((this.ownerOnly && completed.model !== body.model)
      || (completed.model != null && completed.model !== body.model)) {
      throw Object.assign(new Error("ChatGPT response reported a different model."), { code: "CHATGPT_MODEL_MISMATCH" });
    }
    if (completed.output != null && !Array.isArray(completed.output)) {
      throw Object.assign(new Error("Invalid ChatGPT response output."), { code: "CHATGPT_PROTOCOL" });
    }
    const advertised = new Set((request.tools ?? []).map((tool) => tool?.name));
    const streamedIds = validateFunctionCalls(output, advertised);
    // Codex may send output_item.done frames but a terminal output: [].
    // Keep the streamed message rather than asking for an extra model turn.
    // A terminal [] still cannot confirm any streamed function call below.
    const terminalOutput = Array.isArray(completed.output) && completed.output.length
      ? completed.output : output;
    if (typeof completed.output_text === "string" && completed.output_text.trim()) {
      const itemText = terminalOutput
        .filter((item) => item?.type === "message" || item?.role === "assistant")
        .flatMap((item) => (item.content ?? []).flatMap((part) =>
          [part?.text, part?.value, part?.refusal].filter((value) => typeof value === "string")))
        .join("\n").trim();
      if (itemText !== completed.output_text.trim()) {
        throw Object.assign(new Error("Contradictory ChatGPT terminal text."), { code: "CHATGPT_PROTOCOL" });
      }
    }
    const terminalIds = validateFunctionCalls(terminalOutput, advertised);
    const streamedCalls = output.filter((item) => item.type === "function_call");
    const terminalCalls = terminalOutput.filter((item) => item.type === "function_call");
    if (Array.isArray(completed.output) && ((completed.output.length === 0 && streamedIds.length > 0)
      || streamedIds.length !== terminalIds.length || streamedIds.some((id, i) =>
      id !== terminalIds[i] || streamedCalls[i].name !== terminalCalls[i].name
      || streamedCalls[i].arguments !== terminalCalls[i].arguments))) {
      throw Object.assign(new Error("Contradictory ChatGPT tool response."), { code: "CHATGPT_PROTOCOL" });
    }
    let seenCallIds = this.#turnCallIds.get(context);
    if (!seenCallIds) {
      seenCallIds = new Set();
      this.#turnCallIds.set(context, seenCallIds);
    }
    for (const id of terminalIds) {
      if (seenCallIds.has(id)) {
        throw Object.assign(new Error("Replayed ChatGPT tool call."), { code: "CHATGPT_PROTOCOL" });
      }
    }
    for (const id of terminalIds) seenCallIds.add(id);
    this.#turnReports.get(context)?.push(typeof completed.model === "string" ? completed.model : null);
    context.signal?.throwIfAborted();
    return { ...completed, output: terminalOutput };
  }
}
