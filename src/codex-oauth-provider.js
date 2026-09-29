const PROVIDER_ID = "openai-codex";
const DEFAULT_MODEL = "gpt-5.3-codex";
const MAX_HISTORY_MESSAGES = 20;
const MAX_TEXT_CHARS = 100_000;

export class CodexProviderError extends Error {
  constructor(message, { code = "CODEX_PROVIDER", cause = null } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "CodexProviderError";
    this.code = code;
  }
}

export class CodexOAuthProvider {
  constructor(options = {}) {
    if (!options.client) throw new TypeError("CodexOAuthProvider requires a Codex app-server client.");
    this.client = options.client;
    this.providerId = PROVIDER_ID;
    this.model = options.model ?? process.env.OPENAGI_CODEX_MODEL ?? DEFAULT_MODEL;
    this.reasoningEffort = options.reasoningEffort ?? process.env.OPENAGI_CODEX_REASONING_EFFORT ?? null;
    this.capabilityTier = "chat-only";
    this.allowedTasks = new Set(options.allowedTasks ?? ["chat"]);
  }

  isConfigured() {
    return this.client.status?.().readiness === "chat-ready";
  }

  status() {
    const clientStatus = this.client.status?.() ?? {};
    return {
      provider: PROVIDER_ID,
      model: this.model,
      reasoningEffort: this.reasoningEffort,
      capabilityTier: this.capabilityTier,
      ...clientStatus
    };
  }

  async generate(options = {}) {
    const task = options.task ?? "chat";
    if (!this.allowedTasks.has(task) || options.agent?.role === "specialist"
      || options.context?.channel !== "local" || options.context?.localOwner !== true) {
      throw new CodexProviderError(`Codex is not authorized for ${task} work.`, {
        code: "CODEX_PROVENANCE_DENIED"
      });
    }
    const readiness = this.client.status?.().readiness;
    if (readiness !== "chat-ready") {
      throw new CodexProviderError(`Codex is not ready (${readiness ?? "unknown"}).`, {
        code: readinessErrorCode(readiness)
      });
    }

    const requestedModel = options.model ?? this.model;
    const requestedEffort = options.reasoningEffort ?? this.reasoningEffort;
    let firstDelta = true;
    const onTextDelta = typeof options.onTextDelta === "function"
      ? (text) => {
        if (typeof text !== "string" || !text) return;
        options.onTextDelta({
          text,
          reset: firstDelta,
          provider: PROVIDER_ID,
          model: requestedModel
        });
        firstDelta = false;
      }
      : null;

    const result = await this.client.runChatTurn({
      ephemeral: true,
      approvalPolicy: "never",
      sandbox: "read-only",
      model: requestedModel,
      effort: requestedEffort,
      developerInstructions: buildDeveloperInstructions(options.instructions),
      input: boundedText(options.input, "input"),
      messages: normalizeMessages(options.messages),
      turnContext: boundedOptionalText(options.turnContext),
      signal: options.signal ?? options.context?.signal ?? null,
      onTextDelta
    });

    const text = typeof result?.text === "string" ? result.text.trim() : "";
    if (!text) {
      throw new CodexProviderError("Codex completed without a visible assistant message.", {
        code: "CODEX_EMPTY_RESPONSE"
      });
    }
    const observedModel = nonEmptyString(result.observedModel);
    const usage = result.usage ?? {};

    return {
      provider: PROVIDER_ID,
      model: observedModel ?? requestedModel,
      id: nonEmptyString(result.turnId) ?? null,
      text,
      toolCalls: [],
      usage: {
        billingMode: "chatgpt-subscription",
        usd: null,
        inputTokens: finiteNonNegativeIntegerOrNull(usage.inputTokens),
        outputTokens: finiteNonNegativeIntegerOrNull(usage.outputTokens),
        quota: usage.quota ?? null
      },
      requestedProvider: PROVIDER_ID,
      requestedModel,
      requestedEffort: requestedEffort ?? null,
      observedProvider: PROVIDER_ID,
      observedModel,
      observedEffort: nonEmptyString(result.observedEffort)
    };
  }

  async startLogin(options) {
    return this.client.startLogin(options);
  }

  async cancelLogin(loginId) {
    return this.client.cancelLogin(loginId);
  }

  async logout() {
    return this.client.logout();
  }

  async listModels() {
    return this.client.listModels();
  }

  async getAccount() {
    return this.client.getAccount();
  }

  async getLimits() {
    return this.client.getLimits();
  }

  async inspectReadiness() {
    return this.client.inspectReadiness({ model: this.model });
  }

  async close() {
    await this.client.close?.();
  }
}

export class CodexExplicitFallbackProvider {
  constructor({ primary, fallback, fallbackId }) {
    if (!primary || !fallback) throw new TypeError("Codex fallback requires primary and fallback providers.");
    this.primary = primary;
    this.fallback = fallback;
    this.fallbackId = fallbackId;
    this.providerId = PROVIDER_ID;
    this.model = primary.model;
    // The fallback enforces its own API-dollar budget only if it is invoked.
    this.budgetGuard = primary.budgetGuard ?? null;
  }

  isConfigured() {
    return this.primary.isConfigured();
  }

  status() {
    return {
      ...this.primary.status(),
      fallbackProvider: this.fallbackId,
      fallbackConfigured: this.fallback.isConfigured()
    };
  }

  async generate(options = {}) {
    let visibleOutput = false;
    try {
      return await this.primary.generate({
        ...options,
        onTextDelta: (event) => {
          visibleOutput = true;
          options.onTextDelta?.(event);
        }
      });
    } catch (error) {
      if (visibleOutput || (options.task ?? "chat") !== "chat" || !fallbackEligible(error)) throw error;
      const event = {
        stage: "provider-fallback",
        from: PROVIDER_ID,
        to: this.fallbackId,
        reason: error.code
      };
      try { options.onProgress?.(event); } catch { /* telemetry is advisory */ }
      const result = await this.fallback.generate(options);
      return {
        ...result,
        fallback: {
          from: PROVIDER_ID,
          to: this.fallbackId,
          reason: error.code
        }
      };
    }
  }

  startLogin(options) { return this.primary.startLogin(options); }
  cancelLogin(loginId) { return this.primary.cancelLogin(loginId); }
  logout() { return this.primary.logout(); }
  listModels() { return this.primary.listModels(); }
  getAccount() { return this.primary.getAccount(); }
  getLimits() { return this.primary.getLimits(); }
  inspectReadiness() { return this.primary.inspectReadiness(); }

  async close() {
    const providers = this.primary === this.fallback ? [this.primary] : [this.primary, this.fallback];
    const results = await Promise.allSettled(providers.map((provider) => provider.close?.()));
    const failure = results.find((result) => result.status === "rejected");
    if (failure) throw failure.reason;
  }
}

function fallbackEligible(error) {
  return new Set([
    "CODEX_LOGIN_REQUIRED",
    "CODEX_NOT_READY",
    "CODEX_NOT_INSTALLED"
  ]).has(error?.code);
}

function readinessErrorCode(readiness) {
  const codes = {
    "auth-mode-mismatch": "CODEX_AUTH_MODE",
    "binary-mismatch": "CODEX_BINARY_MISMATCH",
    "binary-unverified": "CODEX_BINARY_UNVERIFIED",
    "isolation-failed": "CODEX_ISOLATION",
    "login-required": "CODEX_LOGIN_REQUIRED",
    "model-unavailable": "CODEX_MODEL_UNAVAILABLE",
    "not-installed": "CODEX_NOT_INSTALLED",
    "protocol-unsupported": "CODEX_PROTOCOL"
  };
  return codes[readiness] ?? "CODEX_NOT_READY";
}

function buildDeveloperInstructions(instructions) {
  const base = boundedOptionalText(instructions);
  return [
    base,
    "This is a chat-only OpenAGI turn. You must not execute tools, commands, file operations, web searches, network actions, MCP calls, apps, plugins, skills, subagents, browser actions, image actions, or permission requests. If the request requires an unavailable action, explain that limitation instead of claiming the action succeeded."
  ].filter(Boolean).join("\n\n");
}

function normalizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages.slice(-MAX_HISTORY_MESSAGES).map((message) => ({
    role: message?.role === "assistant" ? "assistant" : "user",
    content: boundedText(String(message?.content ?? ""), "message")
  }));
}

function boundedText(value, field) {
  if (typeof value !== "string") throw new CodexProviderError(`${field} must be a string.`, { code: "CODEX_INPUT" });
  if (value.length > MAX_TEXT_CHARS) throw new CodexProviderError(`${field} exceeded its configured limit.`, { code: "CODEX_INPUT" });
  return value;
}

function boundedOptionalText(value) {
  if (value === undefined || value === null || value === "") return null;
  return boundedText(String(value), "context");
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function finiteNonNegativeIntegerOrNull(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}
