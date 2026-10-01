import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { buildCodexSandboxLaunch } from "./codex-sandbox.js";
import { createCodexEgressBroker } from "./codex-egress.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const TEST_FIXTURE_TOKEN = Symbol.for("openagi.codex.test-fixture");
const DEFAULT_TURN_TIMEOUT_MS = 120_000;
const DEFAULT_INTERRUPT_TIMEOUT_MS = 5_000;
const DEFAULT_LOGIN_TIMEOUT_MS = 300_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 3_000;
const DEFAULT_MAX_FRAME_BYTES = 1_048_576;
const DEFAULT_MAX_BUFFER_BYTES = 2_097_152;
const DEFAULT_MAX_PENDING_REQUESTS = 32;
const SAFE_PARENT_ENV = ["PATH", "LANG", "LC_ALL", "TZ"];
const CHAT_ONLY_DISABLED_FEATURES = [
  "apps",
  "browser_use",
  "computer_use",
  "hooks",
  "image_generation",
  "multi_agent",
  "plugins",
  "remote_plugin",
  "shell_tool",
  "skill_search",
  "unified_exec",
  "view_image"
];
const STRICT_CONFIG_OVERRIDES = [
  "approval_policy=\"never\"",
  "sandbox_mode=\"read-only\"",
  "web_search=\"disabled\"",
  ...CHAT_ONLY_DISABLED_FEATURES.map((feature) => `features.${feature}=false`),
  "agents.enabled=false",
  "computer_use.default_app_access=\"deny\"",
  "history.persistence=\"none\"",
  "analytics.enabled=false",
  "feedback.enabled=false",
  "forced_login_method=\"chatgpt\"",
  "cli_auth_credentials_store=\"file\"",
  "mcp_servers={}"
];
const DEFAULT_APP_SERVER_ARGS = [
  "app-server",
  "--stdio",
  "--strict-config",
  ...STRICT_CONFIG_OVERRIDES.flatMap((value) => ["-c", value])
];

export class CodexAppServerError extends Error {
  constructor(message, { code = "CODEX_APP_SERVER", cause = null } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "CodexAppServerError";
    this.code = code;
  }
}

export class CodexAppServerClient {
  #preLoginReceipt = null;
  #fixtureLaunch;
  #launchCommand;
  #launchArgs;

  constructor(options = {}) {
    const requestedCommand = options.command;
    const suppliedArgs = options.args;
    const requestedArgs = Array.isArray(suppliedArgs) ? Object.freeze([...suppliedArgs]) : suppliedArgs;
    const fixtureToken = options[TEST_FIXTURE_TOKEN];
    this.#launchCommand = requestedCommand ?? process.env.OPENAGI_CODEX_BIN ?? "codex";
    this.#fixtureLaunch = isTestFixture({
      command: requestedCommand, args: requestedArgs, [TEST_FIXTURE_TOKEN]: fixtureToken
    });
    if (suppliedArgs !== undefined && !this.#fixtureLaunch) {
      throw new CodexAppServerError("Custom Codex app-server arguments are not permitted.", { code: "CODEX_CONFIG" });
    }
    this.#launchArgs = this.#fixtureLaunch ? requestedArgs : Object.freeze([...DEFAULT_APP_SERVER_ARGS]);
    this.sandboxed = !this.#fixtureLaunch && process.platform === "linux";
    this.egressBroker = null;
    this.brokerClosing = null;
    this.expectedSha256 = nonEmptyString(options.expectedSha256 ?? process.env.OPENAGI_CODEX_SHA256)?.toLowerCase() ?? null;
    this.codexHome = path.resolve(options.codexHome ?? path.join(process.cwd(), ".openagi-codex"));
    this.workDir = path.resolve(options.workDir ?? path.join(this.codexHome, "work"));
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.turnTimeoutMs = options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
    this.interruptTimeoutMs = options.interruptTimeoutMs ?? DEFAULT_INTERRUPT_TIMEOUT_MS;
    this.loginTimeoutMs = options.loginTimeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
    this.maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
    this.maxBufferBytes = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
    this.maxPendingRequests = options.maxPendingRequests ?? DEFAULT_MAX_PENDING_REQUESTS;
    this.proc = null;
    this.state = "stopped";
    this.buffer = "";
    this.nextId = 1;
    this.pending = new Map();
    this.connecting = null;
    this.generation = 0;
    this.lifecycleEpoch = 0;
    this.initializeResult = null;
    this.lastError = null;
    this.activeTurn = null;
    this.startedThreadId = null;
    this.pendingLogin = null;
    this.startingLogin = false;
    this.readiness = "protocol-unsupported";
    this.serverRequestsDenied = 0;
    this.binarySha256 = null;
    this.version = null;
  }

  get fixtureLaunch() { return this.#fixtureLaunch; }
  get command() { return this.#launchCommand; }
  get args() { return this.#launchArgs; }

  status() {
    return {
      state: this.state,
      pid: this.proc?.pid ?? null,
      generation: this.generation,
      initialized: Boolean(this.initializeResult),
      lastError: this.lastError,
      readiness: this.readiness,
      loginPending: Boolean(this.pendingLogin),
      preLoginQualified: Boolean(this.#preLoginReceipt),
      serverRequestsDenied: this.serverRequestsDenied,
      binarySha256: this.binarySha256,
      version: this.version,
      sandboxed: this.sandboxed
    };
  }

  async connect() {
    if (this.initializeResult && this.proc
      && ["ready", "starting-thread", "running", "interrupting"].includes(this.state)) return this.initializeResult;
    if (this.connecting) return this.connecting;
    this.connecting = this.#connect().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  async #connect() {
    const lifecycleEpoch = this.lifecycleEpoch;
    if (this.state !== "stopped") {
      throw new CodexAppServerError(`Cannot start app-server from state ${this.state}.`, { code: "CODEX_STATE" });
    }
    if (!this.#fixtureLaunch && !this.sandboxed) {
      this.readiness = "unsupported-platform";
      throw new CodexAppServerError("Codex requires the qualified Linux sandbox.", { code: "CODEX_UNSUPPORTED_PLATFORM" });
    }
    if (this.sandboxed && (!this.expectedSha256 || !path.isAbsolute(this.#launchCommand))) {
      this.readiness = "binary-unverified";
      throw new CodexAppServerError("Sandboxed Codex requires an absolute pinned executable and SHA-256.", { code: "CODEX_BINARY_UNVERIFIED" });
    }
    if (this.brokerClosing) await this.brokerClosing;
    if (lifecycleEpoch !== this.lifecycleEpoch) {
      throw new CodexAppServerError("Codex was closed during startup.", { code: "CODEX_PROCESS_EXIT" });
    }
    const profileFd = this.#prepareDirectories();
    let pinned;
    this.state = "starting";
    this.generation += 1;
    const generation = this.generation;

    let proc;
    let relayFd = null;
    try {
      pinned = this.#inspectBinary();
      if (this.sandboxed) {
        this.egressBroker = createCodexEgressBroker({ profileDir: this.codexHome });
        await this.egressBroker.start();
        if (lifecycleEpoch !== this.lifecycleEpoch || this.state !== "starting") {
          throw new CodexAppServerError("Codex was closed during startup.", { code: "CODEX_PROCESS_EXIT" });
        }
        relayFd = fs.openSync(new URL("./codex-proxy-relay.py", import.meta.url), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      }
      const launch = this.sandboxed
        ? buildCodexSandboxLaunch({ pin: pinned, profileDir: this.codexHome, profileFd, args: this.#launchArgs, relayFd })
        : { command: pinned?.command ?? this.#launchCommand, args: this.#launchArgs,
            cwd: this.workDir, env: this.#buildEnv(), stdio: ["pipe", "pipe", "pipe", ...(pinned ? [pinned.fd] : [])] };
      proc = spawn(launch.command, launch.args, {
        cwd: launch.cwd, env: launch.env, stdio: launch.stdio, shell: false
      });
    } catch (error) {
      await this.#stopBroker();
      this.state = "stopped";
      throw error;
    } finally {
      if (relayFd !== null) fs.closeSync(relayFd);
      pinned?.close();
      if (profileFd !== null) fs.closeSync(profileFd);
    }
    this.proc = proc;
    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");
    proc.stdout.on("data", (chunk) => this.#handleStdout(chunk, generation));
    proc.stderr.on("data", (chunk) => this.#handleStderr(chunk));
    proc.stdin.on("error", () => {
      if (generation !== this.generation || this.state === "stopping" || this.state === "tainted") return;
      this.#taint(new CodexAppServerError("Codex app-server input failed.", { code: "CODEX_PROCESS_EXIT" }));
    });
    proc.on("error", (error) => this.#handleExit(error, generation));
    proc.on("exit", (code, signal) => {
      this.#handleExit(new CodexAppServerError(`Codex app-server exited (${code ?? signal ?? "unknown"}).`, {
        code: "CODEX_PROCESS_EXIT"
      }), generation);
    });

    this.state = "initializing";
    try {
      const result = await this.#request("initialize", {
        clientInfo: { name: "openagi", version: "0.1.0" },
        capabilities: {
          experimentalApi: false,
          requestAttestation: false,
          extensions: null
        }
      });
      const expectedHome = this.sandboxed ? "/profile" : fs.realpathSync(this.codexHome);
      const reportedHome = this.sandboxed ? result?.codexHome : fs.realpathSync(String(result?.codexHome ?? ""));
      if (reportedHome !== expectedHome) {
        throw new CodexAppServerError("Codex app-server reported an unexpected CODEX_HOME.", {
          code: "CODEX_HOME_MISMATCH"
        });
      }
      this.initializeResult = Object.freeze({ ...result, codexHome: reportedHome });
      this.version = nonEmptyString(result?.serverInfo?.version)
        ?? nonEmptyString(result?.userAgent)
        ?? this.version;
      this.#notify("initialized", {});
      this.state = "ready";
      return this.initializeResult;
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async getAccount() {
    await this.connect();
    const result = await this.#request("account/read", { refreshToken: false });
    if (!result?.account) this.readiness = "login-required";
    else if (result.account.type !== "chatgpt") this.readiness = "auth-mode-mismatch";
    return result;
  }

  async startLogin({ mode } = {}) {
    // A host browser cannot reach the OAuth callback inside our network namespace.
    // Device authorization is the only supported flow until a callback bridge is qualified.
    if (mode !== "device") {
      throw new CodexAppServerError("Unsupported Codex login mode.", { code: "CODEX_LOGIN_MODE" });
    }
    // No production receipt issuer exists until the credential-free canaries
    // and exact runtime dependencies are qualified. Never let owner auth alone
    // authorize a credential-bearing request.
    if (!this.#fixtureLaunch && !this.#preLoginReceipt) {
      throw new CodexAppServerError("Codex pre-login isolation has not been qualified.", {
        code: "CODEX_PRELOGIN_REQUIRED"
      });
    }
    await this.connect();
    if (this.activeTurn || this.state === "starting-thread" || this.pendingLogin || this.startingLogin) {
      throw new CodexAppServerError("Codex is already busy with a turn or login.", { code: "CODEX_BACKPRESSURE" });
    }
    this.startingLogin = true;
    try {
      return await this.#startLogin(mode);
    } finally {
      this.startingLogin = false;
    }
  }

  async #startLogin(mode) {
    try {
      const result = await this.#request("account/login/start", { type: "chatgptDeviceCode" });
      const loginId = nonEmptyString(result?.loginId);
      if (!loginId || result?.type !== "chatgptDeviceCode") {
        throw new CodexAppServerError("Codex returned a malformed login response.", { code: "CODEX_PROTOCOL" });
      }
      const publicLogin = { type: result.type, loginId, userCode: nonEmptyString(result.userCode), verificationUrl: validatedHttpsUrl(result.verificationUrl) };
      if (!publicLogin.userCode) {
        throw new CodexAppServerError("Codex returned an invalid device code.", { code: "CODEX_PROTOCOL" });
      }
      const timer = setTimeout(() => {
        this.#clearPendingLogin();
        this.#taint(new CodexAppServerError("Codex login expired.", { code: "CODEX_LOGIN_EXPIRED" }));
      }, this.loginTimeoutMs);
      timer.unref?.();
      this.pendingLogin = { loginId, mode, generation: this.generation, timer };
      this.readiness = "login-required";
      return publicLogin;
    } catch (error) {
      if (error.code !== "CODEX_BACKPRESSURE") this.#taint(error);
      throw error;
    }
  }

  async cancelLogin(loginId) {
    const pending = this.pendingLogin;
    if (!pending || pending.generation !== this.generation || pending.loginId !== loginId) {
      throw new CodexAppServerError("Unknown or expired Codex login.", { code: "CODEX_LOGIN_EXPIRED" });
    }
    let result;
    try {
      result = await this.#request("account/login/cancel", { loginId });
    } catch (error) {
      this.#taint(error);
      throw error;
    }
    this.#clearPendingLogin();
    if (result?.status !== "canceled") {
      await this.close();
      throw new CodexAppServerError("Codex could not confirm login cancellation.", { code: "CODEX_LOGIN_EXPIRED" });
    }
    return { status: "canceled" };
  }

  async logout() {
    await this.connect();
    if (this.activeTurn) throw new CodexAppServerError("Cannot log out during a Codex turn.", { code: "CODEX_BACKPRESSURE" });
    await this.#request("account/logout", {});
    this.#clearPendingLogin();
    this.readiness = "login-required";
    return { status: "logged-out" };
  }

  async listModels({ includeHidden = false, pageSize = 100, maxModels = 500 } = {}) {
    await this.connect();
    const models = [];
    const seenCursors = new Set();
    let cursor = null;
    do {
      if (cursor !== null) {
        if (seenCursors.has(cursor)) {
          throw new CodexAppServerError("Codex model pagination repeated a cursor.", { code: "CODEX_PROTOCOL" });
        }
        seenCursors.add(cursor);
      }
      const page = await this.#request("model/list", { cursor, includeHidden, limit: pageSize });
      if (!page || !Array.isArray(page.data)) {
        throw new CodexAppServerError("Codex returned a malformed model catalog.", { code: "CODEX_PROTOCOL" });
      }
      models.push(...page.data);
      if (models.length > maxModels) {
        throw new CodexAppServerError("Codex model catalog exceeded its configured limit.", { code: "CODEX_BACKPRESSURE" });
      }
      cursor = typeof page.nextCursor === "string" && page.nextCursor ? page.nextCursor : null;
    } while (cursor !== null);
    return models;
  }

  async inspectReadiness({ model } = {}) {
    await this.connect();
    if (!this.expectedSha256 || !this.binarySha256) {
      this.readiness = "binary-unverified";
      return { ...this.status(), reason: "binary-hash-not-pinned" };
    }

    const account = await this.getAccount();
    if (!account?.account) return { ...this.status(), reason: "login-required" };
    if (account.account.type !== "chatgpt") {
      this.readiness = "auth-mode-mismatch";
      return { ...this.status(), reason: "chatgpt-auth-required" };
    }

    const models = await this.listModels();
    if (model && !models.some((entry) => entry?.id === model || entry?.model === model)) {
      this.readiness = "model-unavailable";
      return { ...this.status(), reason: "model-not-listed" };
    }

    const [config, experimentalFeatures, configRequirements] = await Promise.all([
      this.#request("config/read", { cwd: this.sandboxed ? "/profile/work" : this.workDir, includeLayers: true }),
      this.#request("experimentalFeature/list", { cursor: null, limit: 100 }),
      this.#request("configRequirements/read", {})
    ]);
    const effectiveConfig = config?.config;
    if (!Array.isArray(experimentalFeatures?.data) || experimentalFeatures?.nextCursor) {
      this.readiness = "isolation-failed";
      return { ...this.status(), reason: "effective-feature-unverified" };
    }
    if (effectiveConfig?.approval_policy !== "never"
      || effectiveConfig?.sandbox_mode !== "read-only"
      || effectiveConfig?.web_search !== "disabled") {
      this.readiness = "isolation-failed";
      return { ...this.status(), reason: "effective-config-unsafe" };
    }
    for (const feature of CHAT_ONLY_DISABLED_FEATURES) {
      const values = [
        ...collectFeatureValues(config, feature),
        ...collectFeatureValues(experimentalFeatures, feature)
      ];
      if (new Set(values).size > 1) {
        this.readiness = "isolation-failed";
        return { ...this.status(), reason: "effective-feature-disagreement" };
      }
      if (values.length === 0) {
        this.readiness = "isolation-failed";
        return { ...this.status(), reason: "effective-feature-unverified" };
      }
      if (values.includes(true)) {
        this.readiness = "isolation-failed";
        return { ...this.status(), reason: "effective-feature-enabled" };
      }
    }
    if (hasConfiguredValue(configRequirements?.requirements)) {
      this.readiness = "isolation-failed";
      return { ...this.status(), reason: "effective-requirements-present" };
    }

    const catalogCwd = this.sandboxed ? "/profile/work" : this.workDir;
    const [mcpServers, apps, plugins, skills, hooks] = await Promise.all([
      this.#request("mcpServerStatus/list", { cursor: null, detail: "toolsAndAuthOnly", limit: 100, threadId: null }),
      this.#request("app/list", { cursor: null, forceRefetch: false, limit: 100, threadId: null }),
      this.#request("plugin/list", { cwds: [catalogCwd], forceRefetch: false, marketplaceKinds: ["local"] }),
      this.#request("skills/list", { cwds: [catalogCwd], forceReload: false }),
      this.#request("hooks/list", { cwds: [catalogCwd] })
    ]);
    if (![mcpServers?.data, apps?.data, plugins?.marketplaces, skills?.data, hooks?.data].every(Array.isArray)
      || mcpServers?.nextCursor || apps?.nextCursor
      || plugins?.marketplaceLoadErrors?.length
      || skills.data.some((entry) => !Array.isArray(entry?.skills) || !Array.isArray(entry?.errors) || entry.errors.length)
      || hooks.data.some((entry) => !Array.isArray(entry?.hooks) || !Array.isArray(entry?.errors)
        || entry.errors.length || !Array.isArray(entry?.warnings) || entry.warnings.length)
      || plugins.marketplaces.some((entry) => !Array.isArray(entry?.plugins))) {
      this.readiness = "isolation-failed";
      return { ...this.status(), reason: "integration-catalog-unverified" };
    }
    const catalogHasEntries =
      arrayHasEntries(mcpServers?.data)
      || arrayHasEntries(apps?.data)
      || plugins?.marketplaces?.some((marketplace) => arrayHasEntries(marketplace?.plugins)) === true
      || skills?.data?.some((entry) => arrayHasEntries(entry?.skills)) === true
      || hooks?.data?.some((entry) => arrayHasEntries(entry?.hooks)) === true;
    if (catalogHasEntries) {
      this.readiness = "isolation-failed";
      return { ...this.status(), reason: "integration-catalog-not-empty" };
    }

    this.readiness = "canary-required";
    return { ...this.status(), reason: "negative-canaries-not-run" };
  }

  async getLimits() {
    await this.connect();
    return { quota: await this.#request("account/rateLimits/read", { excludeResetCreditDetails: true, supportsLunaReserve: false }) };
  }

  async runChatTurn(options = {}) {
    // Stock app-server cannot attest an effective reasoning tier per response.
    // No production inference until an official semantic contract, matching
    // notification and exact-runtime admission are implemented and qualified.
    if (!this.#fixtureLaunch) {
      throw new CodexAppServerError("Codex served identity and effort are not qualified.", {
        code: "CODEX_ATTESTATION_REQUIRED"
      });
    }
    await this.connect();
    if (options.signal?.aborted) throw abortError();
    if (this.activeTurn || ["starting-thread", "running", "interrupting"].includes(this.state)) {
      throw new CodexAppServerError("Codex already has an active turn.", { code: "CODEX_BACKPRESSURE" });
    }
    if (options.ephemeral !== true || options.approvalPolicy !== "never" || options.sandbox !== "read-only") {
      throw new CodexAppServerError("Codex chat-only requires an ephemeral, no-approval, read-only thread.", {
        code: "CODEX_ISOLATION"
      });
    }

    this.state = "starting-thread";
    this.startedThreadId = null;
    let threadResponse;
    try {
      threadResponse = await this.#request("thread/start", {
        approvalPolicy: "never",
        approvalsReviewer: "user",
        cwd: this.sandboxed ? "/profile/work" : this.workDir,
        developerInstructions: options.developerInstructions ?? null,
        ephemeral: true,
        model: options.model ?? null,
        sandbox: "read-only"
      });
    } catch (error) {
      if (error.code === "CODEX_BACKPRESSURE") this.state = "ready";
      else this.#taint(error);
      throw error;
    }
    const threadId = nonEmptyString(threadResponse?.thread?.id);
    if (this.startedThreadId && this.startedThreadId !== threadId) {
      const error = new CodexAppServerError("Codex thread lifecycle identity did not match its response.", { code: "CODEX_PROTOCOL" });
      this.#taint(error);
      throw error;
    }
    if (!threadId || threadResponse.approvalPolicy !== "never"
      || threadResponse.sandbox?.type !== "readOnly" || threadResponse.sandbox.networkAccess !== false
      || typeof threadResponse.cwd !== "string" || path.resolve(threadResponse.cwd) !== (this.sandboxed ? "/profile/work" : this.workDir)) {
      const error = new CodexAppServerError("Codex returned unsafe effective thread settings.", { code: "CODEX_ISOLATION" });
      this.#taint(error);
      throw error;
    }
    if (options.signal?.aborted) {
      this.#taint(new CodexAppServerError("Codex thread creation was cancelled.", { code: "CODEX_CANCELLED" }));
      throw abortError();
    }

    let settle;
    let rejectTurn;
    const completion = new Promise((resolve, reject) => {
      settle = resolve;
      rejectTurn = reject;
    });
    // The start request may reject before we reach `await completion`.
    void completion.catch(() => {});
    const timer = setTimeout(() => {
      const error = new CodexAppServerError("Codex turn timed out.", { code: "CODEX_TIMEOUT" });
      rejectTurn(error);
      this.#taint(error);
    }, this.turnTimeoutMs);
    timer.unref?.();
    this.activeTurn = {
      generation: this.generation,
      threadId,
      turnId: null,
      requestedModel: options.model ?? null,
      requestedEffort: options.effort ?? null,
      observedModel: null,
      observedEffort: null,
      acknowledged: false,
      terminal: null,
      delivered: false,
      usage: { inputTokens: null, outputTokens: null, quota: null },
      onTextDelta: typeof options.onTextDelta === "function" ? options.onTextDelta : null,
      settle,
      reject: rejectTurn,
      timer,
      signal: options.signal ?? null,
      abortHandler: null,
      abortRequested: false,
      abortConfirmed: false,
      interrupting: false,
      interruptTimer: null
    };
    const activeTurn = this.activeTurn;
    activeTurn.abortHandler = () => {
      activeTurn.abortRequested = true;
      if (activeTurn.turnId) this.#interruptActiveTurn(activeTurn);
    };
    activeTurn.signal?.addEventListener("abort", activeTurn.abortHandler, { once: true });
    if (activeTurn.signal?.aborted) activeTurn.abortHandler();

    this.state = "running";
    try {
      const turnResponse = await this.#request("turn/start", {
        threadId,
        input: [{ type: "text", text: buildTurnInput(options) }],
        model: options.model ?? null,
        effort: options.effort ?? null,
        approvalPolicy: "never",
        sandboxPolicy: { type: "readOnly", networkAccess: false }
      });
      const turnId = nonEmptyString(turnResponse?.turn?.id);
      if (!turnId) throw new CodexAppServerError("Codex returned an invalid turn identifier.", { code: "CODEX_PROTOCOL" });
      if (this.activeTurn && !this.activeTurn.turnId) this.activeTurn.turnId = turnId;
      if (this.activeTurn?.turnId !== turnId) {
        throw new CodexAppServerError("Codex turn identity changed during startup.", { code: "CODEX_PROTOCOL" });
      }
      this.activeTurn.acknowledged = true;
      if (this.activeTurn.abortRequested) this.#interruptActiveTurn(this.activeTurn);
      this.#deliverTerminal(this.activeTurn);
      return await completion;
    } catch (error) {
      if (this.activeTurn) this.activeTurn.reject(error);
      // The server may already be executing a turn even when the start
      // acknowledgement was lost. It cannot be reused until recycled.
      if (this.state !== "tainted" && error.code !== "CODEX_BACKPRESSURE"
        && !(error.name === "AbortError" && this.activeTurn?.abortConfirmed)) this.#taint(error);
      throw error;
    } finally {
      if (this.activeTurn) {
        clearTimeout(this.activeTurn.timer);
        clearTimeout(this.activeTurn.interruptTimer);
        this.activeTurn.signal?.removeEventListener("abort", this.activeTurn.abortHandler);
      }
      this.activeTurn = null;
      if (["running", "starting-thread", "interrupting"].includes(this.state)) this.state = "ready";
    }
  }

  async #interruptActiveTurn(turn) {
    if (turn !== this.activeTurn || turn.interrupting || !turn.turnId) return;
    turn.interrupting = true;
    this.state = "interrupting";
    turn.interruptTimer = setTimeout(() => {
      this.#taint(new CodexAppServerError("Codex did not confirm interruption.", { code: "CODEX_INTERRUPT_TIMEOUT" }));
    }, this.interruptTimeoutMs);
    turn.interruptTimer.unref?.();
    try {
      await this.#request("turn/interrupt", { threadId: turn.threadId, turnId: turn.turnId }, { timeoutMs: this.interruptTimeoutMs });
    } catch (error) {
      this.#taint(error);
    }
  }

  async close() {
    this.lifecycleEpoch += 1;
    this.#preLoginReceipt = null;
    const proc = this.proc;
    this.proc = null;
    this.connecting = null;
    this.initializeResult = null;
    this.#clearPendingLogin();
    if (this.activeTurn) {
      clearTimeout(this.activeTurn.timer);
      clearTimeout(this.activeTurn.interruptTimer);
      this.activeTurn.signal?.removeEventListener("abort", this.activeTurn.abortHandler);
      this.activeTurn.reject(new CodexAppServerError("Codex app-server closed during a turn.", { code: "CODEX_PROCESS_EXIT" }));
      this.activeTurn = null;
    }
    this.state = "stopping";
    this.#rejectPending(new CodexAppServerError("Codex app-server closed.", { code: "CODEX_PROCESS_EXIT" }));
    if (!proc) {
      this.state = "stopped";
      await this.#stopBroker();
      return;
    }

    const exited = new Promise((resolve) => {
      if (proc.exitCode !== null || proc.signalCode !== null) resolve();
      else proc.once("exit", resolve);
    });
    try { proc.stdin.end(); } catch { /* already closed */ }
    const graceful = await this.#waitFor(exited, Math.min(250, this.shutdownTimeoutMs));
    if (!graceful && proc.exitCode === null && proc.signalCode === null) {
      try { proc.kill("SIGTERM"); } catch { /* already gone */ }
      const terminated = await this.#waitFor(exited, this.shutdownTimeoutMs);
      if (!terminated && proc.exitCode === null && proc.signalCode === null) {
        try { proc.kill("SIGKILL"); } catch { /* already gone */ }
        await this.#waitFor(exited, this.shutdownTimeoutMs);
      }
    }
    this.buffer = "";
    this.state = "stopped";
    await this.#stopBroker();
  }

  async #stopBroker() {
    if (this.egressBroker) {
      const broker = this.egressBroker;
      this.egressBroker = null;
      this.brokerClosing = broker.close().finally(() => { this.brokerClosing = null; });
    }
    if (this.brokerClosing) await this.brokerClosing;
  }

  #inspectBinary() {
    if (!path.isAbsolute(this.#launchCommand)) {
      if (this.expectedSha256) {
        this.readiness = "binary-unverified";
        throw new CodexAppServerError("A pinned Codex binary must use an absolute path.", {
          code: "CODEX_BINARY_UNVERIFIED"
        });
      }
      this.binarySha256 = null;
      return null;
    }
    let pinned;
    try {
      pinned = pinExecutable(this.#launchCommand);
      this.binarySha256 = pinned.sha256;
    } catch (cause) {
      this.readiness = "not-installed";
      throw new CodexAppServerError("The configured Codex binary is unavailable.", {
        code: "CODEX_NOT_INSTALLED",
        cause
      });
    }
    if (this.expectedSha256 && this.binarySha256 !== this.expectedSha256) {
      pinned.close();
      this.readiness = "binary-mismatch";
      throw new CodexAppServerError("The Codex binary does not match the pinned SHA-256.", {
        code: "CODEX_BINARY_MISMATCH"
      });
    }
    return pinned;
  }

  #prepareDirectories() {
    if (this.sandboxed && this.workDir !== path.join(this.codexHome, "work")) {
      throw new CodexAppServerError("Codex work directory must be inside its private profile.", { code: "CODEX_ISOLATION" });
    }
    const flags = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
    let rootFd = null;
    try {
      fs.mkdirSync(this.codexHome, { recursive: true, mode: 0o700 });
      rootFd = fs.openSync(this.codexHome, flags);
      const rootStat = fs.fstatSync(rootFd);
      const uid = process.getuid?.();
      if (!rootStat.isDirectory() || (uid !== undefined && rootStat.uid !== uid)) throw new Error("Invalid Codex profile owner.");
      fs.fchmodSync(rootFd, 0o700);
      const children = this.sandboxed ? ["work", "home", "tmp", "xdg-config", "xdg-data"] : [];
      for (const name of children) {
        const anchored = `/proc/self/fd/${rootFd}/${name}`;
        try { fs.mkdirSync(anchored, { mode: 0o700 }); }
        catch (error) { if (error.code !== "EEXIST") throw error; }
        const fd = fs.openSync(anchored, flags);
        try {
          if (uid !== undefined && fs.fstatSync(fd).uid !== uid) throw new Error("Invalid Codex subdirectory owner.");
          fs.fchmodSync(fd, 0o700);
        } finally { fs.closeSync(fd); }
      }
      if (!this.sandboxed) {
        for (const dir of [this.workDir, path.join(this.codexHome, "home"), path.join(this.codexHome, "tmp"), path.join(this.codexHome, "xdg-config"), path.join(this.codexHome, "xdg-data")]) {
          fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
          const fd = fs.openSync(dir, flags);
          try { fs.fchmodSync(fd, 0o700); } finally { fs.closeSync(fd); }
        }
      }
      const current = fs.lstatSync(this.codexHome);
      if (!current.isDirectory() || current.dev !== rootStat.dev || current.ino !== rootStat.ino) throw new Error("Codex profile path changed.");
      this.codexHome = fs.realpathSync(this.codexHome);
      this.workDir = fs.realpathSync(this.workDir);
      if (this.sandboxed) return rootFd;
      fs.closeSync(rootFd);
      return null;
    } catch {
      if (rootFd !== null) fs.closeSync(rootFd);
      throw new CodexAppServerError("Codex profile directory is not a private real directory.", { code: "CODEX_ISOLATION" });
    }
  }

  #buildEnv() {
    const env = {};
    for (const key of SAFE_PARENT_ENV) {
      if (typeof process.env[key] === "string") env[key] = process.env[key];
    }
    env.CODEX_HOME = this.codexHome;
    env.HOME = path.join(this.codexHome, "home");
    env.TMPDIR = path.join(this.codexHome, "tmp");
    env.XDG_CONFIG_HOME = path.join(this.codexHome, "xdg-config");
    env.XDG_DATA_HOME = path.join(this.codexHome, "xdg-data");
    return env;
  }

  #request(method, params, { timeoutMs = this.requestTimeoutMs } = {}) {
    if (!this.proc?.stdin?.writable) {
      return Promise.reject(new CodexAppServerError("Codex app-server is not writable.", { code: "CODEX_PROCESS_EXIT" }));
    }
    if (this.pending.size >= this.maxPendingRequests) {
      return Promise.reject(new CodexAppServerError("Codex request concurrency exceeded its configured limit.", { code: "CODEX_BACKPRESSURE" }));
    }
    const id = `openagi-${this.generation}-${this.nextId++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CodexAppServerError(`Codex request timed out: ${method}.`, { code: "CODEX_TIMEOUT" }));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer, method, generation: this.generation });
      try {
        this.#write({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  #notify(method, params) {
    this.#write({ method, params });
  }

  #write(frame) {
    const encoded = JSON.stringify(frame);
    if (Buffer.byteLength(encoded, "utf8") > this.maxFrameBytes) {
      throw new CodexAppServerError("Outbound Codex frame exceeded its configured limit.", { code: "CODEX_BACKPRESSURE" });
    }
    this.proc.stdin.write(`${encoded}\n`);
  }

  #handleStdout(chunk, generation) {
    if (generation !== this.generation || this.state === "tainted" || this.state === "stopping") return;
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer, "utf8") > this.maxBufferBytes) {
      this.#taint(new CodexAppServerError("Codex stdout buffer exceeded its configured limit.", { code: "CODEX_PROTOCOL" }));
      return;
    }
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      if (Buffer.byteLength(line, "utf8") > this.maxFrameBytes) {
        this.#taint(new CodexAppServerError("Codex frame exceeded its configured limit.", { code: "CODEX_PROTOCOL" }));
        return;
      }
      let frame;
      try { frame = JSON.parse(line); }
      catch {
        this.#taint(new CodexAppServerError("Codex emitted malformed JSON.", { code: "CODEX_PROTOCOL" }));
        return;
      }
      this.#handleFrame(frame, generation);
      if (this.state === "tainted" || this.state === "stopping") return;
    }
  }

  #handleFrame(frame, generation) {
    if (!frame || Array.isArray(frame) || typeof frame !== "object") {
      this.#taint(new CodexAppServerError("Codex emitted an invalid frame envelope.", { code: "CODEX_PROTOCOL" }));
      return;
    }
    if (Object.hasOwn(frame, "id") && (Object.hasOwn(frame, "result") || Object.hasOwn(frame, "error")) && !Object.hasOwn(frame, "method")) {
      const id = String(frame.id);
      const pending = this.pending.get(id);
      if (!pending || pending.generation !== generation) {
        this.#taint(new CodexAppServerError("Codex emitted a response for an unknown request.", { code: "CODEX_PROTOCOL" }));
        return;
      }
      this.pending.delete(id);
      clearTimeout(pending.timer);
      if (Object.hasOwn(frame, "result") && Object.hasOwn(frame, "error")) {
        pending.reject(new CodexAppServerError("Codex response contained both result and error.", { code: "CODEX_PROTOCOL" }));
      } else if (Object.hasOwn(frame, "error")) {
        pending.reject(new CodexAppServerError(`Codex ${pending.method} failed.`, { code: "CODEX_REMOTE" }));
      } else {
        pending.resolve(frame.result);
      }
      return;
    }
    if (!Object.hasOwn(frame, "id") && typeof frame.method === "string" && Object.hasOwn(frame, "params")) {
      this.#handleNotification(frame.method, frame.params, generation);
      return;
    }
    if (Object.hasOwn(frame, "id") && typeof frame.method === "string") {
      this.serverRequestsDenied += 1;
      try {
        this.#write({
          id: frame.id,
          error: {
            code: -32601,
            message: "OpenAGI chat-only mode denies all app-server requests."
          }
        });
      } catch { /* process recycling below is the final safety boundary */ }
      this.#taint(new CodexAppServerError("Codex attempted a prohibited server request.", { code: "CODEX_ISOLATION" }));
      return;
    }
    this.#taint(new CodexAppServerError("Codex emitted an unexpected request or notification.", { code: "CODEX_PROTOCOL" }));
  }

  #handleNotification(method, params, generation) {
    if (method === "account/login/completed") {
      const pending = this.pendingLogin;
      if (!pending || pending.generation !== generation || nonEmptyString(params?.loginId) !== pending.loginId) {
        this.#taint(new CodexAppServerError("Codex completed an unknown login.", { code: "CODEX_PROTOCOL" }));
        return;
      }
      this.#clearPendingLogin();
      this.readiness = params?.success === true ? "protocol-unsupported" : "login-required";
      return;
    }
    if (["account/updated", "account/rateLimits/updated", "remoteControl/status/changed"].includes(method)) return;
    if (method === "thread/started" && this.state === "starting-thread") {
      const threadId = nonEmptyString(params?.thread?.id);
      if (threadId && !this.startedThreadId) {
        this.startedThreadId = threadId;
        return;
      }
    }
    const turn = this.activeTurn;
    if (!turn || turn.generation !== generation) {
      this.#taint(new CodexAppServerError(`Codex emitted ${method} outside an active turn.`, { code: "CODEX_PROTOCOL" }));
      return;
    }
    const threadId = nonEmptyString(params?.threadId);
    const eventTurnId = nonEmptyString(params?.turnId ?? params?.turn?.id);
    if (method === "turn/completed" && (!nonEmptyString(params?.turn?.id)
      || (params?.turnId !== undefined && nonEmptyString(params.turnId) !== nonEmptyString(params.turn.id)))) {
      this.#taint(new CodexAppServerError("Codex completed a turn with ambiguous identity.", { code: "CODEX_PROTOCOL" }));
      return;
    }
    if (threadId !== turn.threadId || (turn.turnId && eventTurnId && eventTurnId !== turn.turnId)) {
      this.#taint(new CodexAppServerError("Codex emitted an event for a different thread or turn.", { code: "CODEX_PROTOCOL" }));
      return;
    }
    if (!turn.turnId && eventTurnId) turn.turnId = eventTurnId;

    if (method === "turn/started") return;
    if (method === "item/agentMessage/delta") {
      if (typeof params?.delta !== "string") {
        this.#taint(new CodexAppServerError("Codex emitted an invalid text delta.", { code: "CODEX_PROTOCOL" }));
        return;
      }
      // Never expose a provisional delta. The terminal result is the only
      // text eligible for delivery; production additionally requires an
      // upstream served-identity contract before dispatch.
      return;
    }
    if (method === "thread/tokenUsage/updated") {
      const last = params?.tokenUsage?.last;
      turn.usage = {
        inputTokens: nonNegativeIntegerOrNull(last?.inputTokens),
        outputTokens: nonNegativeIntegerOrNull(last?.outputTokens),
        quota: null
      };
      return;
    }
    if (method === "model/rerouted") {
      // This is a reroute indication, not a receipt for every response.
      // In particular, it says nothing about the effort actually applied.
      return;
    }
    if (method === "item/started") {
      const type = params?.item?.type;
      if (["userMessage", "agentMessage", "reasoning"].includes(type)) return;
      this.#taint(new CodexAppServerError(`Codex attempted a prohibited ${type ?? "unknown"} item.`, { code: "CODEX_ISOLATION" }));
      return;
    }
    if (method === "item/completed") {
      const item = params?.item;
      if (item?.type === "agentMessage" || ["userMessage", "reasoning"].includes(item?.type)) return;
      this.#taint(new CodexAppServerError(`Codex completed a prohibited ${item?.type ?? "unknown"} item.`, { code: "CODEX_ISOLATION" }));
      return;
    }
    if (method === "turn/completed") {
      const completed = params?.turn;
      if (turn.terminal || turn.delivered) {
        this.#taint(new CodexAppServerError("Codex completed the same turn more than once.", { code: "CODEX_PROTOCOL" }));
        return;
      }
      clearTimeout(turn.interruptTimer);
      if (turn.abortRequested) {
        turn.abortConfirmed = completed?.status === "interrupted";
        if (!turn.abortConfirmed) {
          this.#taint(new CodexAppServerError("Codex did not confirm turn interruption.", { code: "CODEX_INTERRUPT_TIMEOUT" }));
          return;
        }
        turn.terminal = { status: "interrupted" };
        turn.reject(abortError());
        return;
      }
      const completedItems = Array.isArray(completed?.items) ? completed.items : null;
      if (completedItems?.some((item) => !["agentMessage", "userMessage", "reasoning"].includes(item?.type))) {
        this.#taint(new CodexAppServerError("Codex disclosed a prohibited item in the completed turn.", { code: "CODEX_ISOLATION" }));
        return;
      }
      const authoritative = completedItems
        ? [...completedItems].reverse().find((item) => item?.type === "agentMessage" && typeof item.text === "string" && item.text.trim())
        : null;
      if (completed?.status !== "completed" || !authoritative) {
        turn.terminal = { status: "failed" };
        turn.reject(new CodexAppServerError(`Codex turn ended with status ${completed?.status ?? "unknown"}.`, { code: "CODEX_TURN_FAILED" }));
        return;
      }
      turn.terminal = { status: "completed", text: authoritative.text };
      queueMicrotask(() => this.#deliverTerminal(turn));
      return;
    }
    if (["warning", "configWarning", "deprecationNotice", "model/verification", "model/safetyBuffering/updated", "turn/moderationMetadata", "item/reasoning/summaryTextDelta", "item/reasoning/summaryPartAdded", "item/reasoning/textDelta"].includes(method)) return;
    this.#taint(new CodexAppServerError(`Codex emitted prohibited notification ${method}.`, { code: "CODEX_ISOLATION" }));
  }

  #deliverTerminal(turn) {
    if (turn !== this.activeTurn || !turn.acknowledged || turn.delivered
      || turn.terminal?.status !== "completed" || this.state !== "running" || turn.abortRequested) return;
    turn.delivered = true;
    const text = turn.terminal.text;
    try { turn.onTextDelta?.(text); }
    catch {
      this.#taint(new CodexAppServerError("Codex output delivery failed.", { code: "CODEX_STREAM_FAILED" }));
      return;
    }
    turn.settle({
      turnId: turn.turnId,
      text,
      requestedModel: turn.requestedModel,
      observedModel: turn.observedModel,
      requestedEffort: turn.requestedEffort,
      observedEffort: turn.observedEffort,
      usage: turn.usage
    });
  }

  #handleStderr(chunk) {
    const text = String(chunk ?? "").trim();
    if (text) this.lastError = "Codex app-server reported a bounded diagnostic.";
  }

  #handleExit(error, generation) {
    if (generation !== this.generation) return;
    this.lastError = error.message;
    this.#clearPendingLogin();
    this.readiness = "protocol-unsupported";
    if (this.state !== "stopping" && this.state !== "tainted") this.state = "stopped";
    if (this.proc?.exitCode !== null || this.proc?.signalCode !== null) this.proc = null;
    this.#rejectPending(error);
    if (this.activeTurn) this.activeTurn.reject(error);
    void this.#stopBroker().catch(() => {
      this.lastError = "Codex egress cleanup failed.";
      this.readiness = "isolation-failed";
    });
  }

  #taint(error) {
    this.lastError = error.message;
    this.state = "tainted";
    this.#clearPendingLogin();
    this.#rejectPending(error);
    if (this.activeTurn) {
      clearTimeout(this.activeTurn.timer);
      clearTimeout(this.activeTurn.interruptTimer);
      this.activeTurn.reject(error);
    }
    const proc = this.proc;
    if (proc && proc.exitCode === null && proc.signalCode === null) {
      try { proc.kill("SIGKILL"); } catch { /* already gone */ }
    }
  }

  #rejectPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  #clearPendingLogin() {
    if (this.pendingLogin?.timer) clearTimeout(this.pendingLogin.timer);
    this.pendingLogin = null;
  }

  async #waitFor(promise, timeoutMs) {
    let timer;
    try {
      return await Promise.race([
        promise.then(() => true),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs);
          timer.unref?.();
        })
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}

function isTestFixture(options) {
  if (process.env.NODE_TEST_CONTEXT !== "child-v8"
    || options[TEST_FIXTURE_TOKEN] !== true
    || options.command !== process.execPath
    || !Array.isArray(options.args)
    || options.args.length < 1 || options.args.length > 2
    || typeof options.args[0] !== "string"
    || (options.args.length === 2 && typeof options.args[1] !== "string")
    || (options.args.length === 2 && !/^--mode=[a-z-]{1,64}$/.test(options.args[1]))) return false;
  try {
    return fs.realpathSync(options.args[0]) === fs.realpathSync(new URL("../test/fixtures/fake-codex-app-server.js", import.meta.url));
  } catch {
    return false;
  }
}

function buildTurnInput(options) {
  const sections = [];
  if (Array.isArray(options.messages) && options.messages.length) {
    const history = options.messages.map((message) => `${message.role === "assistant" ? "assistant" : "user"}: ${String(message.content ?? "")}`);
    sections.push(`[history]\n${history.join("\n")}\n[/history]`);
  }
  if (typeof options.turnContext === "string" && options.turnContext) sections.push(options.turnContext);
  sections.push(String(options.input ?? ""));
  return sections.join("\n\n");
}

// Bind hash verification and execution to one open inode, even if its
// pathname is replaced before spawn. Stdio descriptor 3 is inherited by exec.
export function pinExecutable(filename) {
  if (process.platform !== "linux") throw new Error("Executable descriptor pinning requires Linux.");
  const resolved = fs.realpathSync(filename);
  const fd = fs.openSync(resolved, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error("Codex executable is not a regular file.");
    const sha256 = crypto.createHash("sha256").update(fs.readFileSync(fd)).digest("hex");
    let closed = false;
    return {
      fd,
      sha256,
      command: "/proc/self/fd/3",
      close() {
        if (closed) return;
        closed = true;
        fs.closeSync(fd);
      }
    };
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function arrayHasEntries(value) {
  return Array.isArray(value) && value.length > 0;
}

function hasConfiguredValue(value) {
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.some(hasConfiguredValue);
  if (typeof value === "object") return Object.values(value).some(hasConfiguredValue);
  return true;
}

function collectFeatureValues(root, featureName) {
  const values = [];
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    if (value.name === featureName && typeof value.enabled === "boolean") values.push(value.enabled);
    for (const [key, child] of Object.entries(value)) {
      if (key === featureName && typeof child === "boolean") values.push(child);
      else visit(child);
    }
  };
  visit(root);
  return values;
}

function nonNegativeIntegerOrNull(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function abortError() {
  const error = new Error("Codex turn was cancelled.");
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  return error;
}

function validatedHttpsUrl(value) {
  let parsed;
  try { parsed = new URL(String(value)); }
  catch { throw new CodexAppServerError("Codex returned an invalid verification URL.", { code: "CODEX_PROTOCOL" }); }
  if (parsed.protocol !== "https:" || parsed.hostname !== "auth.openai.com" || parsed.port
    || parsed.username || parsed.password) {
    throw new CodexAppServerError("Codex returned an untrusted verification URL.", { code: "CODEX_PROTOCOL" });
  }
  return parsed.toString();
}
