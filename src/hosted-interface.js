import http from "node:http";
import fsSync from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { createDefaultRuntime } from "./abi-runtime.js";
import { resolveDataDir } from "./data-dir.js";
import { readJsonFile, writeJsonAtomic } from "./file-utils.js";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";

const PACKAGE_VERSION = createRequire(import.meta.url)("../package.json").version;
import {
  buildSetCookie,
  checkAuth,
  checkOrigin,
  isPublicRoute,
  verifyTelegramSecret,
  verifyBuildBetterWebhook
} from "./auth.js";
import { ChannelManager } from "./channels.js";
import { inferToneScore } from "./outcome-store.js";
import { isFirstRun, renderWizard, saveEnv } from "./setup-wizard.js";
import {
  NodeRegistry,
  readOrCreateIdentity,
  resolveBuildInfo,
  statusFor,
  compareVersions,
  newestOf
} from "./node-registry.js";
import { ServiceProbe, adoptRemoteServices, mergeServices } from "./service-nodes.js";
import { readNodeConfig, writeNodeConfig } from "./cli-client.js";
import { composeBrief, dismissFocus } from "./daily-brief.js";
import { queryReviewQueue, ReviewQueueQueryError } from "./review-queue.js";
import { safeJoinOrNull, LABEL_SEGMENT } from "./path-guard.js";
import { assertSafeStdioSpec } from "./mcp-registry.js";
import { summarizeRegisterMcpServer } from "./tool-registry.js";
import { logAgentFailure, publicAgentFailure } from "./agent-failure.js";
import { NodeControlBroker, createNodeControlWorker, sanitizeNodeCapabilities, pinnedRemoteOrigin } from "./node-control.js";
import { createComputerExecutor } from "./integrations/computer-server.js";
import {
  createImessageNodeCapability,
  isImessageSearchEnabled
} from "./integrations/imessage-node-capability.js";

export function createHostedInterface(runtime = createDefaultRuntime(), options = {}) {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 43210;
  // Read these dynamically so the setup wizard can update them mid-flight.
  const getAuthToken = () => options.authToken ?? process.env.OPENAGI_AUTH_TOKEN ?? null;
  const getPublicUrl = () => options.publicUrl ?? process.env.OPENAGI_PUBLIC_URL ?? null;
  const getTelegramSecret = () => options.telegramSecret ?? process.env.TELEGRAM_WEBHOOK_SECRET ?? null;
  let channels =
    options.channels ??
    (runtime.agentHost
      ? new ChannelManager({
          agentHost: runtime.agentHost,
          runtime,
          dir: options.channelsDir,
          telegramToken: options.telegramToken
        })
      : null);

  // dataDir is resolved ONCE here and threaded explicitly into both
  // NodeRegistry's dir and the cache path below — NodeRegistry must NOT be
  // allowed to fall back to its own default (which calls resolveDataDir()
  // independently), because resolveDataDir() memoizes its first result for
  // the whole process; two hosted-interface instances in the same test
  // process (a main + a node) would otherwise silently collide on the same
  // directory the first one resolved.
  const dataDir = options.dataDir ?? resolveDataDir();
  const nodeRegistry = options.nodeRegistry ?? new NodeRegistry({ dir: options.nodesDir ?? path.join(dataDir, "nodes") });
  const nodeControlBroker = options.nodeControlBroker ?? new NodeControlBroker(options.nodeControlOptions);
  const localIdentity = readOrCreateIdentity(dataDir);
  let localCapabilityCache = [];
  const capabilityFacade = {
    list(capabilityId) {
      const names = new Map(nodeRegistry.list().map((entry) => [entry.nodeId, entry.name]));
      const localCapabilities = capabilityId
        ? localCapabilityCache.filter((capability) => capability.id === capabilityId)
        : localCapabilityCache;
      const local = localCapabilities.length ? [{
        nodeId: localIdentity.nodeId,
        name: localIdentity.name || "This Mac",
        capabilities: localCapabilities,
        local: true,
        seenAt: new Date().toISOString()
      }] : [];
      const remote = nodeControlBroker.list(capabilityId)
        .filter((entry) => entry.nodeId !== localIdentity.nodeId)
        .map((entry) => ({ ...entry, name: names.get(entry.nodeId) ?? null }));
      return [...local, ...remote];
    },
    resolve(capabilityId, selector = {}) {
      const candidates = this.list(capabilityId).filter((entry) => (
        entry.capabilities?.some?.((capability) => capability.id === capabilityId && capability.ready)
      ));
      const rawSelector = selector.nodeId ?? selector.nodeName ?? null;
      if (typeof rawSelector !== "string" || !rawSelector.trim()) return candidates.length === 1 ? candidates[0] : null;
      const value = rawSelector.trim().toLowerCase();
      const byId = candidates.find((entry) => entry.nodeId.toLowerCase() === value);
      if (byId) return byId;
      const named = candidates.filter((entry) => typeof entry.name === "string" && entry.name.toLowerCase() === value);
      return named.length === 1 ? named[0] : null;
    },
    async refresh() {
      localCapabilityCache = await localNodeCapabilities().catch(() => []);
      return this.list();
    },
    async dispatch(nodeId, capability, operation, payload, opts) {
      if (nodeId === localIdentity.nodeId) {
        const provider = activeNodeCapabilityProviders().get(capability);
        if (!provider) throw new Error("local node capability is disabled");
        const status = (await provider.health()).capability;
        if (status?.ready !== true || !status.operations?.includes?.(operation)) {
          throw new Error(status?.detail || "local node capability is not ready");
        }
        return await provider.invoke(operation, payload ?? {});
      }
      return nodeControlBroker.dispatch(nodeId, capability, operation, payload, opts);
    },
    cancelSession(sessionId, reason) {
      computerExecutor?.cancelSession?.(sessionId);
      return nodeControlBroker.cancelSession(sessionId, reason);
    },
    removeNode(nodeId, reason) {
      return nodeControlBroker.removeNode(nodeId, reason);
    }
  };
  runtime.nodeCapabilities = capabilityFacade;
  const nodesCachePath = path.join(dataDir, "nodes", "cache.json");
  // Service nodes (see service-nodes.js) are configured in the environment,
  // not registered by heartbeat. One probe instance per interface so its
  // result cache survives between requests; serviceEnv is a seam for tests
  // that need a main and a node with different configuration in one process.
  const serviceProbe = options.serviceProbe ?? new ServiceProbe(options.serviceProbeOptions);
  const getServiceEnv = () => options.serviceEnv ?? process.env;
  const allowInsecureNodeRelay = options.allowInsecureNodeRelay === true
    || String(process.env.OPENAGI_ALLOW_INSECURE_NODE_RELAY ?? "").toLowerCase() === "true"
    || process.env.OPENAGI_ALLOW_INSECURE_NODE_RELAY === "1";

  const events = new EventEmitter();
  events.setMaxListeners(50);

  const sseClients = new Set();
  function broadcast(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of sseClients) {
      try { res.write(payload); } catch { /* dropped */ }
    }
  }
  events.on("message", (data) => broadcast("message", data));
  events.on("cron", (data) => broadcast("cron", data));
  events.on("mcp", (data) => broadcast("mcp", data));
  events.on("tunnel", (data) => broadcast("tunnel", data));
  events.on("replay", (data) => broadcast("replay", data));
  events.on("skill-candidate", (data) => broadcast("skill-candidate", data));
  events.on("miner-result", (data) => broadcast("miner-result", data));
  events.on("cron-catchup", (data) => broadcast("cron-catchup", data));
  events.on("cron-job-timeout", (data) => broadcast("cron-job-timeout", data));
  events.on("cron-interrupted", (data) => broadcast("cron-interrupted", data));
  events.on("cron-tick-budget", (data) => broadcast("cron-tick-budget", data));
  events.on("proactive-suggestion", (data) => broadcast("proactive-suggestion", data));
  events.on("suggestion-resolved", (data) => broadcast("suggestion-resolved", data));
  events.on("task-updated", (data) => broadcast("task-updated", data));
  events.on("clarification-created", (data) => broadcast("clarification-created", data));
  events.on("clarification-resolved", (data) => broadcast("clarification-resolved", data));
  events.on("draft-created", (data) => broadcast("draft-created", data));
  events.on("draft-resolved", (data) => broadcast("draft-resolved", data));
  events.on("task-reminder", (data) => broadcast("task-reminder", data));
  events.on("task-auto-changed", (data) => broadcast("task-auto-changed", data));
  events.on("pending-action", (data) => broadcast("pending-action", data));
  events.on("pending-action-resolved", (data) => {
    broadcast("pending-action-resolved", data);
    // A decision made through the dashboard's direct approval route must also
    // clear the durable outreach copy used by the Mac overlay. Otherwise the
    // notification disappears but the same request remains actionable there.
    const outreachItem = runtime.outreach?.list?.().find((item) =>
      (item.status === "unseen" || item.status === "seen")
      && item.sourceRef?.kind === "pending-action"
      && item.sourceRef?.id === data.id
    );
    if (outreachItem) {
      const executionSucceeded = data.status === "approved" && data.executionSucceeded === true;
      const userDenied = data.status === "denied";
      const resolutionStatus = executionSucceeded ? "acted" : userDenied ? "dismissed" : "error";
      const decisionAction = data.status === "approved" || data.status === "interrupted" ? "do" : "dismiss";
      runtime.outreach.resolve(outreachItem.id, {
        action: decisionAction,
        by: data.decidedBy ?? (userDenied ? "user" : "system")
      }, {
        status: resolutionStatus,
        error: resolutionStatus === "error"
          ? data.error ?? "Approved action did not complete successfully."
          : null
      });
    }
  });
  events.on("daily-recap", (data) => broadcast("daily-recap", data));
  events.on("daily-plan", (data) => broadcast("daily-plan", data));
  events.on("task-unblocked", (data) => broadcast("task-unblocked", data));
  if (runtime.skillReplay) runtime.skillReplay.bindEvents(events);
  if (runtime.pendingActions?.bindEvents) runtime.pendingActions.bindEvents(events);
  if (runtime.computerUseLog?.bindEvents) runtime.computerUseLog.bindEvents(events);
  events.on("computer-use", (data) => broadcast("computer-use", data));
  events.on("outreach", (data) => broadcast("outreach", data));
  events.on("outreach-resolved", (data) => broadcast("outreach-resolved", data));

  // Expose the bus to runtime subsystems (pattern miner, session miner) so
  // they can emit "skill-candidate" without holding a reference to this
  // module. Set non-enumerably so JSON serialization of runtime stays clean.
  if (!runtime.events) {
    Object.defineProperty(runtime, "events", { value: events, enumerable: false });
  }
  // Proactive outreach mapper subscribes here: it was constructed before the
  // bus existed, so we late-bind the same bus now (mirrors bindEvents above).
  if (runtime.bindOutreachEvents) runtime.bindOutreachEvents(runtime.events);

  // Mid-run boot note: if the previous process died while a cron job handler
  // was executing, the file-backed scheduler kept a { runningJobId, startedAt }
  // marker. Emit it now (the outreach mapper above is already attached, so it
  // lands as a durable feed item) and clear it. Optional-chained because the
  // in-memory CronScheduler has no marker support.
  const interruptedJob = runtime.cron?.consumeInterruption?.();
  if (interruptedJob) {
    events.emit("cron-interrupted", {
      at: new Date().toISOString(),
      jobId: interruptedJob.runningJobId,
      jobName: interruptedJob.jobName,
      startedAt: interruptedJob.startedAt
    });
  }

  if (runtime.tunnelWatcher) {
    runtime.tunnelWatcher.on("tunnel-url", (data) => events.emit("tunnel", { op: "url", ...data }));
    runtime.tunnelWatcher.on("tunnel-changed", (data) => events.emit("tunnel", { op: "changed", ...data }));
    runtime.tunnelWatcher.start();
  }

  // Pending OAuth URLs per server, surfaced in the dashboard MCP tab.
  const pendingOauth = new Map();
  if (runtime.mcp) {
    runtime.mcp.onOauthRequired = ({ name, url }) => {
      pendingOauth.set(name, { url, at: new Date().toISOString() });
      events.emit("mcp", { op: "oauth-required", name, url });
    };
  }

  // How long accepting an MCP suggestion waits for the handshake before it
  // answers "registered, not connected yet". The popover blocks on that
  // request, so the wait has to stay inside a click's patience budget: a
  // local stdio handshake lands in well under a second and an http
  // initialize is one round-trip, while the slow paths (npx cold-download,
  // OAuth browser consent) run for minutes — mcp-client allows 300s for
  // initialize and mcp-http-client 5min — and must never hold the response
  // open. 3s clears the fast paths without making the button feel broken.
  const MCP_ACCEPT_CONNECT_MS = Number.parseInt(process.env.OPENAGI_MCP_ACCEPT_CONNECT_MS ?? "3000", 10);

  /// Connect an MCP server and report what ACTUALLY happened, so a caller can
  /// print the truth instead of assuming success. Never throws. Returns
  ///   { connected: true,  connectError: null }   handshake done, tools live
  ///   { connected: false, connectError: null }   registered, not connected —
  ///       either still handshaking past our wait, or waiting on the user to
  ///       finish an interactive authorization. NOT a failure.
  ///   { connected: false, connectError: "<reason>" }  it really failed.
  ///
  /// The OAuth carve-out is deliberate. mcp-oauth signals "needs the human"
  /// two ways: a typed error (code OAUTH_INTERACTIVE_REQUIRED) when the
  /// caller asked not to open a browser, and — on the interactive path this
  /// one uses — printAuthUrlFn → registry.onOauthRequired → pendingOauth,
  /// while the connect promise stays parked on the browser callback. Neither
  /// is an error; both mean "registered, needs authorization".
  ///
  /// `connected` is read back off the registry (the same source GET /mcp
  /// reports from) rather than inferred from the promise, so this response
  /// can never contradict what the MCP tab shows a second later.
  async function connectAndReport(name) {
    const isConnected = () =>
      Boolean(runtime.mcp?.listServers?.().find((s) => s.name === name)?.connected);
    if (typeof runtime.mcp?.connect !== "function") return { connected: isConnected(), connectError: null };
    // An OAuth prompt raised DURING this attempt proves we are parked on the
    // user, not broken. A pre-existing entry proves nothing (it can be stale),
    // so remember the mark we started from.
    const oauthMarkBefore = pendingOauth.get(name)?.at ?? null;
    const newOauthPrompt = () => {
      const at = pendingOauth.get(name)?.at ?? null;
      return at != null && at !== oauthMarkBefore;
    };

    let attempt;
    try {
      attempt = Promise.resolve(runtime.mcp.connect(name));
    } catch (error) {
      return { connected: isConnected(), connectError: error?.message ?? String(error) };
    }
    events.emit("mcp", { op: "connecting", name });
    // The attempt outlives our wait on purpose: the registry dedups it, the
    // dashboard learns the ending over SSE, and /mcp shows the real state.
    // These handlers also keep a late rejection from going unhandled.
    attempt.then(
      (status) => {
        pendingOauth.delete(name);
        events.emit("mcp", { op: "connected", name, tools: status?.tools ?? [] });
      },
      (error) => {
        // Once a usable token exists, the browser part succeeded. A later MCP
        // handshake failure must not keep the stale "OAuth required" banner.
        if (runtime.mcp?.hasOAuthToken?.(name)) pendingOauth.delete(name);
        events.emit("mcp", { op: "connect-error", name, error: error?.message ?? String(error) });
      }
    );

    let timer = null;
    // `rejected` is tracked as its own flag, not inferred from a truthy error:
    // a promise can reject with undefined, and that must still be classified
    // as a settled attempt rather than silently reading as "no error".
    const outcome = await Promise.race([
      attempt.then(() => ({ settled: true, rejected: false }), (error) => ({ settled: true, rejected: true, error })),
      new Promise((resolve) => { timer = setTimeout(() => resolve({ settled: false }), MCP_ACCEPT_CONNECT_MS); })
    ]);
    if (timer) clearTimeout(timer);

    // Timed out, or it resolved — either way the registry has the last word.
    if (!outcome.settled || !outcome.rejected) return { connected: isConnected(), connectError: null };
    if (outcome.error?.code === "OAUTH_INTERACTIVE_REQUIRED" || newOauthPrompt()) {
      return { connected: isConnected(), connectError: null };
    }
    const reason = outcome.error?.message ?? (outcome.error == null ? "connect failed" : String(outcome.error));
    return { connected: isConnected(), connectError: reason };
  }

  if (runtime.agentHost) {
    const original = runtime.agentHost.handleMessage.bind(runtime.agentHost);
    runtime.agentHost.handleMessage = async (input, handleOptions) => {
      try {
        const result = await original(input, handleOptions);
        events.emit("message", {
          sessionId: result.session.id,
          requestId: boundedProgressText(input?.metadata?.requestId, 200) || null,
          status: "complete",
          agent: result.agent,
          reply: result.reply,
          toolCalls: result.output?.scrutiny?.action ? [] : []
        });
        return result;
      } catch (error) {
        logAgentFailure(error, {
          sessionId: error?.openagiSessionId ?? null,
          requestId: error?.openagiRequestId ?? input?.metadata?.requestId ?? null
        });
        if (error?.openagiSessionId) {
          const failure = messageFailure(error, error.openagiSessionId);
          events.emit("message", {
            sessionId: error.openagiSessionId,
            requestId: error.openagiRequestId ?? null,
            status: "failed",
            code: failure.code,
            error: failure.error
          });
        }
        throw error;
      }
    };
  }

  const queuedApprovalContinuations = new Set();
  function queueApprovalContinuation(action, invokeResult) {
    if (
      action?.toolName !== "start_computer_use_session"
      || !invokeResult?.ok
      || !channels?.handleLocalMessage
      || !action.context?.sessionId
      || queuedApprovalContinuations.has(action.id)
    ) {
      return null;
    }
    queuedApprovalContinuations.add(action.id);
    const goal = String(action.args?.goal ?? action.summary ?? "the approved computer-use goal").slice(0, 500);
    const sessionId = action.context.sessionId;
    setImmediate(() => {
      channels.handleLocalMessage({
        channel: action.context.channel ?? "local",
        from: action.context.from ?? "user",
        agentId: action.context.agentId ?? "main",
        sessionId,
        text: "OpenAGI approval update: the user approved and started the computer-use session for this goal: "
          + goal
          + "\nContinue the original request now. First call computer_use_status and use the active session. Do not call start_computer_use_session again.",
        metadata: {
          requestId: "approval_" + action.id,
          runtimeEvent: "approval",
          approvalActionId: action.id
        }
      }).catch((error) => {
        logAgentFailure(error, { sessionId, requestId: "approval_" + action.id });
      });
    });
    return { status: "queued", sessionId };
  }

  let tickerHandle = null;
  let heartbeatHandle = null;
  let nodeControlWorker = null;
  let computerExecutor = null;
  let imessageNodeCapability = null;
  const tickerMs = options.tickerMs ?? Number.parseInt(process.env.OPENAGI_TICKER_MS ?? "10000", 10);

  const computerUseEnabledHere = () => {
    const value = String(process.env.OPENAGI_COMPUTER_USE ?? "").toLowerCase();
    return options.nodeControlEnabled ?? (value === "1" || value === "true" || value === "yes");
  };
  const activeNodeCapabilityProviders = () => {
    const providers = new Map();
    if (computerUseEnabledHere()) {
      computerExecutor ??= options.computerExecutor ?? createComputerExecutor();
      providers.set("computer-use", computerExecutor);
    }
    const serviceEnv = getServiceEnv();
    if (isImessageSearchEnabled(serviceEnv)) {
      imessageNodeCapability ??= options.imessageNodeCapability
        ?? createImessageNodeCapability({ env: serviceEnv });
      providers.set(imessageNodeCapability.id, imessageNodeCapability);
    }
    return providers;
  };
  const localNodeCapabilities = async () => {
    const capabilities = await Promise.all([...activeNodeCapabilityProviders().values()].map(async (provider) => {
      try { return (await provider.health()).capability; } catch { return null; }
    }));
    localCapabilityCache = sanitizeNodeCapabilities(capabilities.filter(Boolean));
    return localCapabilityCache;
  };
  const ensureNodeControlWorker = () => {
    if (nodeControlWorker || activeNodeCapabilityProviders().size === 0) return nodeControlWorker;
    const pairing = readNodeConfig(dataDir);
    if (!pairing?.remote || !pairing.nodeToken || pairing.nodeEnrollmentConfirmed !== true) return null;
    const identity = readOrCreateIdentity(dataDir);
    nodeControlWorker = createNodeControlWorker({
      remote: pairing.remote,
      token: pairing.nodeToken,
      nodeId: identity.nodeId,
      capabilities: localNodeCapabilities,
      execute: async (command) => {
        if (typeof command?.capability !== "string" || typeof command?.operation !== "string") {
          throw new Error("unsupported node capability command");
        }
        const provider = activeNodeCapabilityProviders().get(command.capability);
        if (!provider) throw new Error("node capability is disabled or unavailable");
        const capability = (await provider.health()).capability;
        if (capability?.ready !== true || !capability.operations?.includes?.(command.operation)) {
          throw new Error(capability?.detail || "node capability operation is not ready");
        }
        return await provider.invoke(command.operation, command.payload ?? {});
      },
      fetchImpl: options.nodeControlFetch ?? globalThis.fetch,
      pollMs: options.nodeControlPollMs,
      retryMs: options.nodeControlRetryMs,
      allowInsecureRemote: allowInsecureNodeRelay
    });
    nodeControlWorker.start();
    return nodeControlWorker;
  };
  const stopNodeControlWorker = async () => {
    const worker = nodeControlWorker;
    nodeControlWorker = null;
    await worker?.stop?.();
  };
  const ensureScopedNodeToken = async (pairing, identity) => {
    if (!pairing?.remote) return null;
    pinnedRemoteOrigin(pairing.remote, { allowInsecureRemote: allowInsecureNodeRelay });
    // Generate and persist the scoped credential BEFORE enrollment. If the
    // main stores its hash but the response is lost, this installation can
    // safely retry with the same token after a restart instead of becoming
    // permanently locked out of its stable node id.
    if (pairing.nodeToken && pairing.nodeEnrollmentConfirmed === true) return pairing.nodeToken;
    if (!pairing.token) throw new Error("node enrollment requires a one-time main pairing credential");
    const nodeToken = pairing.nodeToken ?? randomBytes(32).toString("base64url");
    pairing.nodeToken = nodeToken;
    pairing.nodeEnrollmentConfirmed = false;
    writeNodeConfig({
      remote: pairing.remote,
      token: pairing.token,
      nodeToken,
      nodeEnrollmentConfirmed: false
    }, dataDir);
    const enrollmentController = new AbortController();
    const enrollmentTimer = setTimeout(() => enrollmentController.abort(), 5_000);
    let response;
    try {
      response = await (options.nodeControlFetch ?? globalThis.fetch)(`${pairing.remote}/nodes/enroll`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${pairing.token}`
        },
        body: JSON.stringify({ nodeId: identity.nodeId, nodeToken }),
        redirect: "manual",
        signal: enrollmentController.signal
      });
    } finally { clearTimeout(enrollmentTimer); }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(body.error || `node enrollment rejected: ${response.status}`);
    }
    pairing.nodeEnrollmentConfirmed = true;
    pairing.token = null;
    writeNodeConfig({
      remote: pairing.remote,
      token: null,
      nodeToken,
      nodeEnrollmentConfirmed: true
    }, dataDir);
    return nodeToken;
  };

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host ?? `${host}:${port}`}`);
      const pathname = url.pathname;
      const method = req.method;
      const nodeScopedRoute = method === "POST" && [
        "/nodes/heartbeat", "/nodes/control/poll", "/nodes/control/result", "/nodes/revoke"
      ].includes(pathname);
      const nodeClientRoute = (method === "GET" && ["/nodes", "/tasks", "/integrations/status"].includes(pathname))
        || (method === "POST" && pathname === "/message");
      const requestNodeId = typeof req.headers["x-openagi-node-id"] === "string"
        ? req.headers["x-openagi-node-id"]
        : null;
      const scopedBearer = String(req.headers.authorization ?? "").startsWith("Bearer ")
        ? String(req.headers.authorization).slice(7)
        : null;
      // On an authenticated main, operational node routes accept ONLY the
      // credential enrolled for this stable node id. A main-wide dashboard
      // token must never let one paired node poll another node's control queue.
      const nodeScopedAuth = (nodeScopedRoute || nodeClientRoute)
        ? nodeRegistry.authenticate(requestNodeId, scopedBearer)
        : false;

      // Setup wizard. Available always (so you can re-run /setup to change keys),
      // but on first run it bypasses the auth gate since no token exists yet.
      const setupActive = isFirstRun();
      const setupRoutes = pathname === "/setup" || pathname === "/setup/save" || pathname === "/setup/test";

      if (setupActive && method === "GET" && pathname === "/") {
        res.writeHead(302, { Location: "/setup" });
        return res.end();
      }

      // CSRF gate — block cross-origin browser POSTs against any state-changing
      // route (always on, even before auth is configured). Webhook routes
      // self-authenticate so we exempt them.
      if (!isPublicRoute(pathname)) {
        const origin = checkOrigin(req);
        if (!origin.ok) {
          res.writeHead(403, { "content-type": "application/json; charset=utf-8" });
          return res.end(JSON.stringify({ error: "forbidden", reason: origin.reason }));
        }
      }

      // Auth gate. Webhooks self-validate, /health stays open, setup routes
      // bypass auth ONLY during first-run (no token exists yet).
      const extraCookies = [];
      const setupBypass = setupActive && setupRoutes;
      if (!isPublicRoute(pathname) && !setupBypass) {
        const auth = (nodeScopedRoute || nodeClientRoute) && requestNodeId
          ? { ok: nodeScopedAuth, reason: "missing or invalid scoped node credential" }
          : checkAuth(req, url, getAuthToken());
        if (!auth.ok) {
          // Browsers (Accept: text/html) get the login form on ANY failed GET,
          // not just GET /. After sign-in, redirect back to the original path.
          const accept = req.headers.accept ?? "";
          const wantsHtml = method === "GET" && accept.includes("text/html");
          if (wantsHtml && getAuthToken()) {
            const next = pathname + url.search;
            return sendHtml(res, 401, renderLoginPage(auth.reason ?? "auth required", next));
          }
          res.writeHead(401, {
            "content-type": "application/json; charset=utf-8",
            "WWW-Authenticate": "Bearer"
          });
          return res.end(JSON.stringify({ error: "unauthorized", reason: auth.reason ?? "auth required" }));
        }
        if (auth.setCookie) extraCookies.push(buildSetCookie(getAuthToken()));
      }

      // Sign-in: server-side cookie set, then redirect. Works without JS.
      // Public route — the token in the body IS the credential.
      if (method === "POST" && pathname === "/sign-in") {
        const form = await readForm(req);
        const expected = getAuthToken();
        const token = form.token ?? "";
        const next = (form.next && form.next.startsWith("/") && !form.next.startsWith("//")) ? form.next : "/";
        if (!expected || token !== expected) {
          return sendHtml(res, 401, renderLoginPage("invalid token", next));
        }
        res.writeHead(302, {
          Location: next,
          "Set-Cookie": buildSetCookie(expected)
        });
        return res.end();
      }

      // Setup wizard handlers — work both during first-run (auth-bypassed)
      // and after-auth (so users can re-edit env from the dashboard's Settings).
      if (method === "GET" && pathname === "/setup") {
        // Re-runs prefill from the live env: the existing auth token is
        // KEPT (a re-run used to silently rotate it on save), provider/
        // model/budget show their current values, and already-set secrets
        // get a "saved" marker instead of looking unconfigured.
        return sendHtml(res, 200, renderWizard({ existingEnv: process.env }), extraCookies);
      }
      if (method === "POST" && pathname === "/setup/save") {
        const body = await readJson(req);
        const dataDir = resolveDataDir();
        const result = saveEnv({ dataDir, values: body });
        try {
          const { createModelProvider } = await import("./model-provider.js");
          if (runtime.agentHost) {
            runtime.agentHost.modelProvider = createModelProvider({ budgetGuard: runtime.budget });
          }
        } catch { /* swallow */ }
        return sendJson(res, 200, result);
      }
      if (method === "POST" && pathname === "/setup/test") {
        const body = await readJson(req);
        if (!channels) return sendJson(res, 503, { error: "agent-host-disabled" });
        try {
          // ephemeral: the connectivity test must not seed a session, task,
          // memory item, or outcome — it's plumbing, not conversation.
          const turn = await channels.handleLocalMessage({ text: body.text ?? "Say hi in one short sentence.", from: "setup", ephemeral: true });
          return sendJson(res, 200, { reply: turn.reply, model: turn.model });
        } catch (error) {
          return sendJson(res, 500, messageFailure(error, error?.openagiSessionId ?? null));
        }
      }

      if (method === "GET" && pathname === "/" && extraCookies.length) {
        // Strip ?token from the URL after we set the cookie — and ONLY ?token.
        // This used to redirect to `url.pathname`, throwing the entire query
        // away. checkAuth answers a query token with setCookie:true BEFORE it
        // consults the cookie, and AppState.openDashboard appends "&token=" to
        // every dashboard open, so this branch runs on every click of every
        // deep link the Mac app has ever produced — and every one of them
        // (?tab=, ?session=, ?suggestion=, ?pending=, ?compose=, ?date=)
        // arrived at a bare "/" with its routing deleted. "Continue in chat"
        // landing on an empty default chat was this, as much as the missing
        // payload on the button.
        const params = new URLSearchParams(url.search);
        params.delete("token");
        const rest = params.toString();
        const clean = url.pathname + (rest ? "?" + rest : "");
        res.writeHead(302, { Location: clean, "Set-Cookie": extraCookies });
        return res.end();
      }

      if (method === "GET" && pathname === "/") return sendHtml(res, 200, renderApp(), extraCookies);
      // /health is a PUBLIC route (isPublicRoute in auth.js) and must stay one:
      // launchd, the Docker HEALTHCHECK and the setup wizard's post-restart
      // poll all need an answer before any credential exists. But it used to
      // hand every caller the whole of runtime.status(), which embeds
      // cron.listJobs() — and a job carries its `input` verbatim: the scheduled
      // prompt text, the SMS/Telegram recipient, the agent id — plus the
      // integration list, provider config and memory counts. Loopback-only that
      // is untidy; behind a tunnel (OPENAGI_PUBLIC_URL is supported, and
      // docker-compose.example.yml ships a cloudflared sidecar) it is an
      // uncredentialed dump of the user's private automation.
      //
      // So the route is split, not closed: liveness for everyone, full status
      // for a caller that passes the ordinary auth check. When no token is
      // configured checkAuth returns ok — that is the single-user loopback
      // install, which checkBindSafety() guarantees is reachable only from this
      // machine, and where the same caller can already open the dashboard.
      //
      // firstRun stays public deliberately: clients route the user to the setup
      // wizard on it, and isFirstRun() is only ever true when no token is set —
      // i.e. it is the constant false on exactly the exposed installs this is
      // protecting. The Mac tray reads provider/memory out of `status` and DOES
      // send its bearer token (AppState.get), so it keeps the full body.
      if (method === "GET" && pathname === "/health") {
        const probe = { ok: true, firstRun: isFirstRun() };
        if (checkAuth(req, url, getAuthToken()).ok) probe.status = runtime.status();
        return sendJson(res, 200, probe);
      }
      if (method === "GET" && pathname === "/memory") return sendJson(res, 200, runtime.memory.snapshot());
      if (method === "POST" && pathname === "/memory/remember") {
        // Direct memory import (auth-gated) — for migrations from another
        // agent, bulk seeding, or integrations. Body: { content, tags?,
        // importance?, scope?, source? }. Mirrors the `remember` tool.
        const body = await readJson(req);
        const content = String(body?.content ?? "").trim();
        if (!content) return sendJson(res, 400, { error: "content required" });
        const importance = body.importance ?? "normal";
        const item = runtime.memory.remember(
          {
            source: body.source ?? "import",
            scope: body.scope ?? "main",
            content,
            tags: ["import", ...(Array.isArray(body.tags) ? body.tags : [])],
            risk: importance === "high" ? 0.8 : importance === "low" ? 0.2 : 0.45,
            specificity: 0.7,
            repetition: 0.4,
            novelty: 0.5
          },
          { source: "memory-import", strength: importance === "high" ? 0.85 : 0.6 }
        );
        return sendJson(res, 200, { id: item.id, tier: item.tier });
      }
      if (method === "GET" && pathname === "/agents") return sendJson(res, 200, runtime.agentHost?.store.listAgents() ?? runtime.propagation.list());
      if (method === "GET" && pathname === "/specialists") {
        const includeRetired = url.searchParams.get("retired") === "1";
        return sendJson(res, 200, runtime.propagation.list({ includeRetired }));
      }
      if (method === "POST" && pathname.match(/^\/specialists\/[^/]+\/retire$/)) {
        const id = decodeURIComponent(pathname.split("/")[2]);
        const sp = runtime.propagation.retire(id, "manual");
        if (!sp) return sendJson(res, 404, { error: "unknown-specialist" });
        return sendJson(res, 200, sp);
      }
      if (method === "GET" && pathname === "/sessions") return sendJson(res, 200, runtime.agentHost?.store.listSessions() ?? []);
      if (method === "GET" && pathname.startsWith("/sessions/")) {
        const id = decodeURIComponent(pathname.slice("/sessions/".length));
        return sendJson(res, 200, runtime.agentHost?.store.getSession(id) ?? { error: "agent-host-disabled" });
      }
      if (method === "GET" && pathname === "/agent-host") return sendJson(res, 200, runtime.agentHost?.status() ?? { enabled: false });
      if (method === "POST" && /^\/nodes\/[^/]+\/revoke$/.test(pathname)) {
        const nodeId = decodeURIComponent(pathname.slice("/nodes/".length, -"/revoke".length));
        if (!nodeRegistry.isEnrolled(nodeId) && !nodeRegistry.list().some((entry) => entry.nodeId === nodeId)) {
          return sendJson(res, 404, { error: "unknown node" });
        }
        nodeControlBroker.removeNode(nodeId, "node credential was revoked by the main owner");
        nodeRegistry.revoke(nodeId);
        return sendJson(res, 200, { ok: true, nodeId, revoked: true });
      }
      if (method === "POST" && pathname === "/nodes/enroll") {
        const body = await readJsonLimited(req, 16 * 1024);
        if (typeof body.nodeId !== "string" || !body.nodeId || typeof body.nodeToken !== "string") {
          return sendJson(res, 400, { error: "nodeId and nodeToken are required" });
        }
        try {
          const enrollment = nodeRegistry.enroll(body.nodeId, body.nodeToken);
          return sendJson(res, 200, { nodeId: body.nodeId, enrolled: true, created: enrollment.created });
        } catch (error) {
          if (error.code === "NODE_ALREADY_ENROLLED") {
            return sendJson(res, 409, { error: error.message });
          }
          return sendJson(res, 400, { error: error.message });
        }
      }
      if (method === "POST" && pathname === "/nodes/heartbeat") {
        const body = await readJsonLimited(req, 128 * 1024).catch(() => ({}));
        if (body.nodeId !== requestNodeId) {
          return sendJson(res, 403, { error: "nodeId does not match scoped credential" });
        }
        // Type-checked, not just truthy: a non-string name/nodeId previously
        // persisted and crashed NodeRegistry.list()'s name.localeCompare sort
        // with a TypeError, taking down GET /nodes with a 500 until the
        // poisoned entry aged out. role is restricted to exactly "node" —
        // only this instance's own self-entry may ever claim role "main";
        // nothing arriving over the wire should be able to.
        if (typeof body.nodeId !== "string" || !body.nodeId || typeof body.name !== "string" || !body.name) {
          return sendJson(res, 400, { error: "nodeId and name are required and must be non-empty strings" });
        }
        if (body.role !== "node") {
          return sendJson(res, 400, { error: 'role must be "node"' });
        }
        if (body.url !== undefined && body.url !== null && typeof body.url !== "string") {
          return sendJson(res, 400, { error: "url must be a string or null" });
        }
        for (const field of ["version", "build", "buildSource"]) {
          if (body[field] !== undefined && body[field] !== null && typeof body[field] !== "string") {
            return sendJson(res, 400, { error: `${field} must be a string or null` });
          }
        }
        if (body.capabilities !== undefined && !Array.isArray(body.capabilities)) {
          return sendJson(res, 400, { error: "capabilities must be an array" });
        }
        nodeRegistry.upsert({
          nodeId: body.nodeId, name: body.name, role: body.role,
          url: body.url ?? null, version: body.version ?? null,
          // A node reports its own build identity (git SHA or bundle build
          // number). Without it a roster can only show package.json versions,
          // which have drifted behind the release tags and so cannot answer
          // "is this node up to date" — the whole point of the column.
          build: body.build ?? null, buildSource: body.buildSource ?? null,
          capabilities: sanitizeNodeCapabilities(body.capabilities)
        });
        return sendJson(res, 200, { ok: true });
      }
      if (method === "POST" && pathname === "/nodes/revoke") {
        const body = await readJsonLimited(req, 4 * 1024).catch(() => ({}));
        if (body.nodeId !== requestNodeId) {
          return sendJson(res, 403, { error: "nodeId does not match scoped credential" });
        }
        nodeControlBroker.removeNode(requestNodeId, "node credential was revoked");
        nodeRegistry.revoke(requestNodeId);
        return sendJson(res, 200, { ok: true, revoked: true });
      }
      if (method === "POST" && pathname === "/nodes/control/poll") {
        const body = await readJsonLimited(req, 128 * 1024);
        if (typeof body.nodeId !== "string" || !body.nodeId) {
          return sendJson(res, 400, { error: "nodeId is required" });
        }
        if (body.nodeId !== requestNodeId) {
          return sendJson(res, 403, { error: "nodeId does not match scoped credential" });
        }
        const registered = nodeRegistry.list().find((entry) => entry.nodeId === body.nodeId);
        if (!registered || statusFor(registered.lastSeenAt) !== "online") {
          return sendJson(res, 409, { error: "node must heartbeat before polling for control work" });
        }
        const timeoutMs = Math.max(1, Math.min(25_000, Number(body.timeoutMs) || 20_000));
        const command = await nodeControlBroker.poll(body.nodeId, body.capabilities, { timeoutMs });
        return sendJson(res, 200, { command });
      }
      if (method === "POST" && pathname === "/nodes/control/result") {
        const body = await readJsonLimited(req, 12 * 1024 * 1024);
        if (typeof body.nodeId !== "string" || typeof body.commandId !== "string") {
          return sendJson(res, 400, { error: "nodeId and commandId are required" });
        }
        if (body.nodeId !== requestNodeId) {
          return sendJson(res, 403, { error: "nodeId does not match scoped credential" });
        }
        const accepted = nodeControlBroker.deliver(body.nodeId, body.commandId, {
          result: body.result,
          error: typeof body.error === "string" ? body.error.slice(0, 500) : null
        });
        return sendJson(res, accepted ? 200 : 409, accepted ? { ok: true } : { error: "unknown or mismatched command" });
      }
      if (method === "GET" && pathname === "/nodes") {
        const identity = readOrCreateIdentity(dataDir);
        const pairing = readNodeConfig(dataDir);
        const build = resolveBuildInfo({ packageVersion: PACKAGE_VERSION });
        const now = Date.now();
        const nowIso = new Date(now).toISOString();

        // Kick the service probes off BEFORE the first await below, so a
        // sleeping service host and a slow main are waited on concurrently
        // rather than one after the other. describe() is budget-bounded and never
        // rejects; the .catch is only there so a programming error in the
        // probe can never turn the whole topology view into a 500.
        const localServicesPromise = Promise.resolve()
          .then(() => serviceProbe.describe({ env: getServiceEnv(), now }))
          .catch(() => []);
        const localCapabilitiesPromise = localNodeCapabilities().catch(() => []);

        // Every roster row is rebuilt from primitive facts — a name, a
        // timestamp, a version. A `status` that arrived over the wire or came
        // back out of nodes/cache.json is deliberately DROPPED: a liveness
        // verdict is only true at the instant it was computed, and replaying a
        // cached one is how a machine last seen on Jul 19 was still being
        // reported "online" two weeks later. Callers pass status explicitly.
        // statusBasis separates what we just measured (this machine is
        // answering; the main accepted or refused a connection a moment ago)
        // from what we are only recalling (a sibling's heartbeat as recorded
        // in a cache we can no longer refresh). The UI must not present the
        // second kind as a current fact.
        const row = (entry, { self = false, status, statusAsOf, statusBasis = "measured" }) => ({
          nodeId: typeof entry.nodeId === "string" ? entry.nodeId : null,
          name: typeof entry.name === "string" && entry.name ? entry.name : null,
          role: entry.role === "main" ? "main" : "node",
          url: typeof entry.url === "string" ? entry.url : null,
          version: typeof entry.version === "string" ? entry.version : null,
          build: typeof entry.build === "string" ? entry.build : null,
          buildSource: typeof entry.buildSource === "string" ? entry.buildSource : null,
          capabilities: sanitizeNodeCapabilities(entry.capabilities),
          lastSeenAt: typeof entry.lastSeenAt === "string" ? entry.lastSeenAt : null,
          status,
          statusAsOf: statusAsOf ?? null,
          statusBasis,
          self
        });
        // This machine is always part of its own topology, and it is the one
        // row we never have to guess at: it is answering this request, and we
        // read its build identity locally rather than from anyone's roster.
        const selfRow = (role) => row(
          {
            ...identity, role, url: getPublicUrl(),
            version: build.version, build: build.build, buildSource: build.buildSource,
            lastSeenAt: nowIso, capabilities: localCapabilities
          },
          { self: true, status: "online", statusAsOf: nowIso }
        );
        const hostLabel = (u) => { try { return new URL(u).host; } catch { return u; } };
        const reasonOf = (error) => String(
          error?.name === "AbortError" || error?.name === "TimeoutError"
            ? "no response within 5s"
            : (error?.message || error || "unknown error")
        ).slice(0, 200);

        const respond = (rows, rest) => {
          // Keep the first row for a given identity: mainRow and selfRow are
          // built from what we know locally, so they win over the copies of
          // themselves that a roster may also contain.
          const seen = new Set();
          const nodes = [];
          for (const r of rows) {
            const key = r.nodeId ?? `name:${r.name}`;
            if (seen.has(key)) continue;
            seen.add(key);
            nodes.push(r);
          }
          nodes.sort((a, b) => (
            a.role === b.role ? (a.name ?? "").localeCompare(b.name ?? "") : (a.role === "main" ? -1 : 1)
          ));
          const newestVersion = newestOf(nodes.map((n) => n.version));
          // A machine that was re-registered (identity.json regenerated after
          // a reinstall or a moved data dir) leaves an old row behind under
          // the same hostname. Dedupe can't merge them — the ids genuinely
          // differ — so label it rather than showing what looks like a second
          // machine that mysteriously went offline.
          const selfName = nodes.find((n) => n.self)?.name ?? null;
          for (const n of nodes) {
            n.staleRegistration = Boolean(!n.self && n.role !== "main" && selfName && n.name === selfName);
          }
          for (const n of nodes) {
            // Only claim "behind" when both versions actually parsed —
            // compareVersions returns null rather than pretending.
            n.behind = compareVersions(n.version, newestVersion) === -1;
            // Surfacing the EXISTING authenticated updater (bin/openagi.js ->
            // POST /control/update), not a new remote-execution channel: the
            // command runs from the operator's shell with their own token.
            //
            // A --remote target is only ever built from an address WE hold
            // locally (this machine, or the main in node.json). A sibling's
            // `url` arrives in its heartbeat, so a compromised node could set
            // it to a host it controls; printing "openagi update --remote
            // <that host> --token <your token>" would be a ready-made way to
            // get an operator to hand over their token. Those rows get no
            // command, and the UI tells the user to run it on the machine.
            if (n.self) n.updateCommand = "openagi update";
            else if (n.role === "main" && rest.pairedTo) n.updateCommand = `openagi update --remote ${rest.pairedTo}`;
            else n.updateCommand = null;
          }
          return sendJson(res, 200, {
            self: {
              nodeId: identity.nodeId,
              name: identity.name,
              role: rest.pairedTo ? "node" : "main",
              version: build.version,
              // package.json has drifted behind the git tags, so it is
              // reported separately instead of masquerading as the version.
              packageVersion: PACKAGE_VERSION,
              build: build.build,
              buildSource: build.buildSource,
              pairedTo: rest.pairedTo
            },
            nodes,
            newestVersion,
            updateCommand: "openagi update",
            ...rest,
            // Configured SERVICE endpoints — machines that do work for this
            // installation without being installs themselves. A separate key,
            // never mixed into `nodes`: an older client decodes `nodes` as
            // peers and would render a service as a permanently-unknown ghost
            // machine, whereas an unknown top-level key it simply ignores.
            // Always an array, so the shape never depends on configuration.
            services: Array.isArray(rest.services) ? rest.services : []
          });
        };

        const localCapabilities = await localCapabilitiesPromise;

        if (!pairing?.remote) {
          const others = nodeRegistry.list({ now })
            .map((e) => row(e, { status: statusFor(e.lastSeenAt, now), statusAsOf: nowIso }));
          return respond([selfRow("main"), ...others], {
            pairedTo: null, stale: false, cachedAt: null, unreachableReason: null,
            services: await localServicesPromise
          });
        }
        try {
          pinnedRemoteOrigin(pairing.remote, { allowInsecureRemote: allowInsecureNodeRelay });
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), 5000);
          let upstream;
          try {
            upstream = await fetch(`${pairing.remote}/nodes`, {
              headers: (pairing.nodeToken ?? pairing.token) ? {
                authorization: `Bearer ${pairing.nodeToken ?? pairing.token}`,
                ...(pairing.nodeToken ? { "x-openagi-node-id": identity.nodeId } : {})
              } : {},
              redirect: "manual",
              signal: ctrl.signal
            });
          } finally { clearTimeout(timer); }
          if (!upstream.ok) throw new Error(`main answered ${upstream.status}`);
          const upstreamJson = await upstream.json();
          const cached = { ...upstreamJson, cachedAt: nowIso };
          // Best-effort only: a fresh roster we already have in hand must
          // still be returned even if persisting it to disk fails (e.g. a
          // full disk, or a stale nodes/cache.json path that isn't a
          // directory) — caching is an optimization for the next request,
          // not a precondition for answering this one.
          try { writeJsonAtomic(nodesCachePath, cached); } catch { /* best-effort */ }
          // The main's own identity is upstream.self. Dropping it is why the
          // roster only ever contained this machine and the user could never
          // see the remote main it is paired to.
          const mainRow = row(
            { ...(upstreamJson?.self ?? {}), role: "main", url: pairing.remote, lastSeenAt: nowIso },
            { status: "online", statusAsOf: nowIso }
          );
          mainRow.name ??= hostLabel(pairing.remote);
          const siblings = (Array.isArray(upstreamJson?.nodes) ? upstreamJson.nodes : [])
            // Exactly one main exists and we synthesize it above from our own
            // pairing config; nothing arriving over the wire gets to claim it.
            .filter((e) => e && typeof e === "object" && e.role !== "main")
            .map((e) => row(e, { status: statusFor(e.lastSeenAt, now), statusAsOf: nowIso }));
          return respond([mainRow, selfRow("node"), ...siblings], {
            pairedTo: pairing.remote, stale: false, cachedAt: nowIso, unreachableReason: null,
            // The main carries its configured services onward. The user's
            // service node is wired up on the main and they are looking at
            // their laptop, so without this the machine stays invisible
            // exactly where they look for it. "reported" is the honest basis:
            // the main measured it a moment ago, we did not.
            services: mergeServices(
              await localServicesPromise,
              adoptRemoteServices(upstreamJson?.services, { originName: mainRow.name, basis: "reported" })
            )
          });
        } catch (error) {
          const cached = readJsonFile(nodesCachePath, null);
          const cachedAt = typeof cached?.cachedAt === "string" ? cached.cachedAt : null;
          // "unreachable" rather than "offline": we did not infer this from a
          // timestamp, we just tried to open a connection and it failed. The
          // main may be fine and the network may not be — say what we know.
          const mainRow = row(
            { ...(cached?.self ?? {}), role: "main", url: pairing.remote, lastSeenAt: cachedAt },
            { status: "unreachable", statusAsOf: nowIso }
          );
          mainRow.name ??= hostLabel(pairing.remote);
          const siblings = (Array.isArray(cached?.nodes) ? cached.nodes : [])
            .filter((e) => e && typeof e === "object" && e.role !== "main")
            // statusAsOf is the cache timestamp, not now: these rows are the
            // last thing we were told, and the UI says so.
            .map((e) => row(e, { status: statusFor(e.lastSeenAt, now), statusAsOf: cachedAt, statusBasis: "cached" }));
          return respond([mainRow, selfRow("node"), ...siblings], {
            pairedTo: pairing.remote, stale: true, cachedAt, unreachableReason: reasonOf(error),
            // Same rows, but we could not refresh them: "cached", so the age
            // the UI prints is the age of the main's probe, not of ours.
            services: mergeServices(
              await localServicesPromise,
              adoptRemoteServices(cached?.services, { originName: mainRow.name, basis: "cached" })
            )
          });
        }
      }
      if (method === "GET" && pathname === "/brief/today") {
        const rawLimit = Number.parseInt(url.searchParams.get("limit") ?? "5", 10);
        const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(10, rawLimit)) : 5;
        // Pass the already-resolved dataDir (const at hosted-interface.js:50)
        // rather than letting the composer call the memoizing resolveDataDir().
        return sendJson(res, 200, composeBrief(runtime, { now: new Date(), limit, dataDir }));
      }
      // Searchable, cursor-paginated view of everything eligible for the
      // Quick Ask review queue. It deliberately shares daily-brief's
      // eligibility rules, so the footer count and this destination cannot
      // describe different sets of records.
      if (method === "GET" && pathname === "/review-queue") {
        try {
          return sendJson(res, 200, queryReviewQueue(runtime, {
            dataDir,
            q: url.searchParams.get("q"),
            kind: url.searchParams.get("kind"),
            cursor: url.searchParams.get("cursor"),
            limit: url.searchParams.get("limit"),
            sort: url.searchParams.get("sort")
          }));
        } catch (error) {
          if (error instanceof ReviewQueueQueryError) {
            return sendJson(res, error.statusCode, { error: error.message });
          }
          throw error;
        }
      }
      // "Not today" on a daily-plan focus row that maps to no task. The whole
      // decision — where the record lives, how it expires, what a key is — is
      // in daily-brief.js next to the composer that has to honour it; this is
      // only the transport. `key` is DATA (it is compared inside a per-day file
      // named for the clock), so there is no path built from it to guard here.
      if (method === "POST" && pathname === "/brief/focus/dismiss") {
        const body = await readJson(req);
        const result = dismissFocus(runtime, { key: body?.key, now: new Date(), dataDir });
        return sendJson(res, result.ok ? 200 : 400, result);
      }
      if (method === "GET" && pathname === "/channels") {
        const status = channels?.status() ?? { enabled: false };
        const pub = getPublicUrl();
        const base = pub ? pub.replace(/\/$/, "") : null;
        const bbSecret = options.buildBetterWebhookSecret ?? process.env.BUILDBETTER_WEBHOOK_SECRET ?? null;
        return sendJson(res, 200, {
          ...status,
          publicUrl: pub,
          // The URL to paste into BuildBetter's webhook config. Only useful
          // once a public URL + webhook secret are set; secret goes in the
          // query string so webhook UIs that only take a URL still work.
          buildBetterWebhook: base && bbSecret ? `${base}/webhooks/buildbetter?secret=${encodeURIComponent(bbSecret)}` : null,
          buildBetterWebhookReady: Boolean(base && bbSecret)
        });
      }
      if (method === "GET" && pathname === "/channels/telegram/pairing-code") {
        // Auth-gated like every non-public route (isPublicRoute does not list
        // it, so the global checkAuth gate above already ran). Issues a fresh
        // one-time code and prints it to the daemon log too, so a headless
        // install can pair straight from daemon.log/journald.
        if (!channels?.telegram?.pairing) return sendJson(res, 503, { error: "agent-host-disabled" });
        const issued = channels.telegram.pairing.generateCode();
        console.log(`[openagi] telegram pairing code ${issued.code} (valid 10 min, single use) — send "/pair ${issued.code}" to the bot`);
        return sendJson(res, 200, issued);
      }
      if (method === "GET" && pathname === "/tools") return sendJson(res, 200, runtime.tools.list());

      if (method === "GET" && pathname === "/events") return handleSse(req, res, sseClients);

      if (method === "POST" && pathname === "/ingest") {
        const body = await readJson(req);
        const outputs = runtime.processIntegrationEvent(body.source ?? "abi", body.payload ?? body);
        return sendJson(res, 200, { outputs });
      }

      if (method === "POST" && pathname === "/message") {
        if (!channels) return sendJson(res, 503, { error: "agent-host-disabled" });
        const body = await readJson(req);
        // `ephemeral` (no session/memory/task) is an INTERNAL flag for the
        // setup-test path only — never let a public /message caller set it to
        // evade persistence.
        if (body && typeof body === "object") delete body.ephemeral;
        // Opt-in streaming keeps the existing JSON contract untouched. The
        // same auth and Origin gates above protect both forms; this is a direct
        // response stream, not a broadcast that another signed-in client can
        // accidentally observe.
        if (acceptsEventStream(req)) {
          return streamLocalMessage(res, channels, body);
        }
        // Chat must return a structured error, not a generic 500: the
        // dashboard needs to distinguish "budget cap hit" / "provider auth
        // failed" / "network blip" to show something actionable.
        try {
          const result = await channels.handleLocalMessage(body);
          return sendJson(res, 200, result);
        } catch (error) {
          return sendJson(res, 500, messageFailure(error, error?.openagiSessionId ?? null));
        }
      }

      if (method === "POST" && pathname === "/channels/telegram/webhook") {
        if (!channels) return sendJson(res, 503, { error: "agent-host-disabled" });
        const tg = verifyTelegramSecret({
          headerValue: req.headers["x-telegram-bot-api-secret-token"],
          expected: getTelegramSecret()
        });
        if (!tg.ok) return sendJson(res, 401, { error: "unauthorized", reason: tg.reason });
        const body = await readJson(req);
        const result = await channels.handleTelegramWebhook(body);
        return sendJson(res, 200, result);
      }

      if (method === "POST" && pathname === "/webhooks/buildbetter") {
        // Near-real-time push: BuildBetter pings here when a call finishes /
        // an extraction lands, and we trigger a sync immediately instead of
        // waiting for the 15-min poll. Fails closed without a configured
        // secret. The payload itself is advisory — we re-pull via the API
        // (which dedupes), so a spoofed body can't inject tasks.
        const expected = options.buildBetterWebhookSecret ?? process.env.BUILDBETTER_WEBHOOK_SECRET ?? null;
        const bb = verifyBuildBetterWebhook({
          headerValue: req.headers["x-buildbetter-webhook-secret"],
          queryValue: url.searchParams.get("secret"),
          expected
        });
        if (!bb.ok) return sendJson(res, 401, { error: "unauthorized", reason: bb.reason });
        await readJson(req).catch(() => ({})); // drain body; we don't trust it for ingestion
        const source = runtime.buildBetterTaskSource;
        // The source is always registered (so a mid-session MCP login works
        // without restart), so also check it's actually configured — otherwise
        // a sync would no-op. Returning 503 (not a false 202) lets BuildBetter
        // retry the delivery once credentials land.
        if (!source?.triggerSync || !source.isConfigured?.()) {
          return sendJson(res, 503, { error: "buildbetter source not configured" });
        }
        // Don't block the webhook response on the full sync — ack fast,
        // sync in the background (BuildBetter expects a quick 200).
        source.triggerSync().then(
          (r) => runtime.events?.emit?.("integration-sync", { source: "buildbetter", trigger: "webhook", ...r }),
          (err) => runtime.events?.emit?.("integration-sync", { source: "buildbetter", trigger: "webhook", error: err?.message })
        );
        return sendJson(res, 202, { accepted: true });
      }

      if (method === "GET" && pathname === "/budget") return sendJson(res, 200, runtime.budget?.status?.() ?? { error: "no-budget" });
      if (method === "GET" && pathname === "/budget/ledger") {
        const ledger = runtime.budget?.ledger;
        if (!ledger) return sendJson(res, 200, { error: "no-ledger" });
        // Cap at the ledger's retention window so the reported `days` always
        // matches the data actually returned (query/analytics clamp the same way).
        const maxDays = ledger.retentionDays ?? 30;
        const requested = Math.max(1, Number.parseInt(url.searchParams.get("days") ?? "30", 10) || 30);
        const days = Math.min(maxDays, requested);
        return sendJson(res, 200, { days, requestedDays: requested, retentionDays: maxDays, entries: ledger.query({ days }), analytics: ledger.analytics({ days }) });
      }

      // ─── Ambient capture / observations ─────────────────────────────────
      if (method === "POST" && pathname === "/observations") {
        const body = await readJson(req);
        const observations = Array.isArray(body) ? body : (Array.isArray(body.observations) ? body.observations : [body]);
        const sourceMachineId = (!Array.isArray(body) && typeof body.sourceMachineId === "string" && body.sourceMachineId) ? body.sourceMachineId : null;
        try {
          const result = await runtime.observations.record(observations, { sourceMachineId });
          return sendJson(res, 200, result);
        } catch (error) {
          return sendJson(res, 500, { error: error.message });
        }
      }
      if (method === "GET" && pathname === "/observations/search") {
        const query = url.searchParams.get("q") ?? null;
        const since = url.searchParams.get("since") ?? null;
        const until = url.searchParams.get("until") ?? null;
        const app = url.searchParams.get("app") ?? null;
        const machine = url.searchParams.get("machine") ?? null;
        const limit = Number.parseInt(url.searchParams.get("limit") ?? "25", 10);
        const results = await runtime.observations.search({ query, since, until, app, machine, limit });
        return sendJson(res, 200, results);
      }
      if (method === "GET" && pathname === "/observations/timeline") {
        const since = url.searchParams.get("since") ?? null;
        return sendJson(res, 200, await runtime.observations.timelineByHour({ since }));
      }
      if (method === "GET" && pathname === "/observations/stats") {
        return sendJson(res, 200, await runtime.observations.stats());
      }
      // Retention, routed through observation-retention.js so the HTTP surface
      // gets the same cutoffs, counts and refusals as the scheduled job.
      //
      // This used to call runtime.observations.prune(body) directly, whose
      // defaults are { olderThanDays: 90, framesOlderThanDays: 7 } — so an
      // empty POST silently deleted three weeks of frame OCR that the 28-day
      // pattern miner still reads, with no preview, no counts and no undo.
      // Now: DRY RUN unless the caller explicitly says { "apply": true }.
      if (method === "POST" && pathname === "/observations/prune") {
        const body = (await readJson(req).catch(() => ({}))) ?? {};
        const { pruneObservations } = await import("./observation-retention.js");
        const result = await pruneObservations(runtime.observations, {
          dryRun: body.apply !== true,
          ...(body.policy ? { policy: body.policy } : {}),
          ...(body.reclaim ? { reclaim: body.reclaim } : {}),
          logger: (line) => console.log(`[openagi] ${line}`)
        });
        return sendJson(res, 200, result);
      }

      if (method === "GET" && pathname === "/admin/provider") {
        const provider = runtime.agentHost?.modelProvider;
        return sendJson(res, 200, {
          current: provider?.constructor?.name ?? null,
          model: provider?.model ?? null,
          configured: provider?.isConfigured?.() ?? false,
          preference: process.env.OPENAGI_PROVIDER ?? "auto",
          available: {
            anthropic: Boolean(process.env.ANTHROPIC_API_KEY),
            openai: Boolean(process.env.OPENAI_API_KEY)
          }
        });
      }
      if (method === "POST" && pathname === "/admin/provider") {
        const body = await readJson(req);
        const choice = String(body.preference ?? "").toLowerCase();
        if (!["auto", "anthropic", "openai"].includes(choice)) {
          return sendJson(res, 400, { error: "preference must be one of: auto, anthropic, openai" });
        }
        process.env.OPENAGI_PROVIDER = choice;
        try {
          const { createModelProvider } = await import("./model-provider.js");
          if (runtime.agentHost) {
            runtime.agentHost.modelProvider = createModelProvider({ budgetGuard: runtime.budget });
          }
        } catch { /* swallow */ }
        // Also persist to .env so it survives restart.
        try {
          const { saveEnv } = await import("./setup-wizard.js");
          saveEnv({ values: { OPENAGI_PROVIDER: choice } });
        } catch { /* fall back to runtime-only */ }
        return sendJson(res, 200, {
          preference: choice,
          current: runtime.agentHost?.modelProvider?.constructor?.name ?? null,
          model: runtime.agentHost?.modelProvider?.model ?? null
        });
      }
      if (method === "GET" && pathname === "/audit") return sendJson(res, 200, runtime.introspector?.audit?.() ?? null);

      if (method === "GET" && pathname === "/scrutiny/weights") {
        const weights = {};
        if (runtime.scrutiny?.judges) {
          for (const [name, judge] of Object.entries(runtime.scrutiny.judges)) {
            weights[name] = { weights: judge.weights, thresholds: judge.thresholds };
          }
        } else if (runtime.scrutiny?.weights) {
          weights.single = { weights: runtime.scrutiny.weights, thresholds: runtime.scrutiny.thresholds };
        }
        return sendJson(res, 200, { weights, fitter: runtime.scrutinyFitter?.status?.() ?? null });
      }
      if (method === "GET" && pathname === "/scrutiny/pending") {
        return sendJson(res, 200, runtime.scrutinyFitter?.pending ?? null);
      }
      if (method === "POST" && pathname.match(/^\/scrutiny\/pending\/\d+\/apply$/)) {
        const cycle = Number.parseInt(pathname.split("/")[3], 10);
        const result = runtime.scrutinyFitter?.applyPending(cycle);
        if (!result) return sendJson(res, 404, { error: "no pending proposal for cycle" });
        return sendJson(res, 200, result);
      }
      if (method === "POST" && pathname === "/scrutiny/fit") {
        return sendJson(res, 200, runtime.scrutinyFitter?.fit() ?? { error: "no fitter" });
      }
      if (method === "GET" && pathname === "/outcomes") {
        const limit = Number.parseInt(url.searchParams.get("limit") ?? "50", 10);
        const kind = url.searchParams.get("kind");
        const window = Number.parseInt(url.searchParams.get("windowDays") ?? "7", 10);
        return sendJson(res, 200, {
          aggregate: runtime.outcomes?.aggregate(window) ?? null,
          recent: runtime.outcomes?.recent(limit, kind) ?? []
        });
      }

      if (method === "POST" && pathname === "/feedback") {
        const body = await readJson(req);
        const result = runtime.outcomes?.feedback(body.refId, body.qualityScore, body.note);
        if (!result) return sendJson(res, 404, { error: "no outcome found for refId" });
        return sendJson(res, 200, result);
      }

      if (method === "GET" && pathname === "/cron") return sendJson(res, 200, runtime.cron.listJobs());
      if (method === "POST" && pathname === "/cron") {
        const body = await readJson(req);
        const job = runtime.cron.addJob({
          id: body.id,
          name: body.name ?? "manual-prompt",
          enabled: body.enabled ?? true,
          task: body.task ?? "prompt",
          replace: true,
          input: body.input ?? {
            prompt: body.prompt ?? "(empty)",
            channel: body.channel ?? "local",
            target: body.target ?? null,
            agentId: body.agentId ?? "main",
            sessionId: body.sessionId
          },
          intervalMs: body.intervalSeconds ? body.intervalSeconds * 1000 : body.intervalMs,
          dailyAt: body.dailyAt,
          // Per-job override of the 10-minute default (see TIMEOUT_MS). For the
          // rare job that legitimately runs longer than every other job should
          // be allowed to.
          timeoutMs: body.timeoutSeconds ? body.timeoutSeconds * 1000 : body.timeoutMs,
          nextRunAt: body.delaySeconds ? new Date(Date.now() + body.delaySeconds * 1000).toISOString() : body.nextRunAt
        });
        events.emit("cron", { op: "add", job });
        return sendJson(res, 200, job);
      }
      if (method === "DELETE" && pathname.startsWith("/cron/")) {
        const id = decodeURIComponent(pathname.slice("/cron/".length));
        const removed = runtime.cron.removeJob(id);
        events.emit("cron", { op: "remove", id });
        return sendJson(res, 200, { removed });
      }
      // Recent runs, so a client that got a 202 can poll for the outcome.
      // Declared before the /cron/:id routes: "runs" is a reserved job id here.
      if (method === "GET" && pathname === "/cron/runs") {
        const limit = Math.min(Number.parseInt(url.searchParams.get("limit") ?? "20", 10) || 20, 100);
        return sendJson(res, 200, { running: runtime.cron.listRunning(), runs: runtime.cron.listRuns(limit) });
      }
      if (method === "GET" && pathname.match(/^\/cron\/runs\/[^/]+$/)) {
        const runId = decodeURIComponent(pathname.split("/")[3]);
        const run = runtime.cron.getRun(runId);
        if (!run) return sendJson(res, 404, { error: "unknown-run", runId });
        return sendJson(res, 200, run);
      }

      // Manual "Run now". This route MUST answer promptly with a real
      // outcome — it ran, it was accepted (poll for the result), or it was
      // refused. It previously awaited the handler with no timeout and only
      // answered when it settled, so a wedged handler left the user staring
      // at a button that did nothing, forever, with no feedback.
      if (method === "POST" && pathname.match(/^\/cron\/[^/]+\/run$/)) {
        const id = decodeURIComponent(pathname.split("/")[2]);
        const job = runtime.cron.listJobs().find((j) => j.id === id);
        if (!job) return sendJson(res, 404, { error: "unknown-job" });

        // Grace window: a job that finishes fast returns its result inline
        // (what the dashboard wants); anything slower gets a 202 + runId. The
        // connection is never held longer than this, whatever the handler does.
        const requested = Number.parseInt(url.searchParams.get("wait") ?? "", 10);
        const graceMs = Math.min(Number.isFinite(requested) && requested >= 0 ? requested : 1500, 10_000);

        const started = runtime.cron.runJobNow((j) => runtime.runJobTask(j), id, {
          source: "manual",
          onTimeout: (timedOutJob, timeoutMs) => {
            events.emit("cron-job-timeout", {
              at: new Date().toISOString(),
              jobId: timedOutJob.id,
              jobName: timedOutJob.name,
              source: "manual",
              timeoutMs
            });
          }
        });

        if (!started.started) {
          // Refused, with the reason and since when — never a silent stall.
          if (started.reason === "already-running") {
            return sendJson(res, 409, {
              status: "already-running",
              jobId: id,
              runId: started.running?.runId ?? null,
              startedAt: started.running?.startedAt ?? null,
              source: started.running?.source ?? null,
              poll: started.running?.runId ? `/cron/runs/${encodeURIComponent(started.running.runId)}` : null,
              message: "This job is already running. Wait for it to finish — running it twice concurrently is not safe."
            });
          }
          return sendJson(res, 404, { error: started.reason ?? "unknown-job", jobId: id });
        }

        let graceTimer = null;
        const settled = await Promise.race([
          started.promise,
          new Promise((resolve) => { graceTimer = setTimeout(() => resolve(null), graceMs); })
        ]);
        if (graceTimer) clearTimeout(graceTimer);

        if (!settled) {
          const pending = runtime.cron.getRun(started.runId);
          events.emit("cron", { op: "run-accepted", id, runId: started.runId });
          return sendJson(res, 202, {
            status: "accepted",
            jobId: id,
            runId: started.runId,
            startedAt: pending?.startedAt ?? null,
            timeoutMs: pending?.timeoutMs ?? null,
            poll: `/cron/runs/${encodeURIComponent(started.runId)}`,
            message: `Still running after ${graceMs}ms — poll the run for the outcome.`
          });
        }
        // Compact payload deliberately: the full handler result is fetched by
        // the caller from /cron/runs/:runId, not broadcast to every SSE client.
        events.emit("cron", { op: "run", id, runId: settled.runId, status: settled.status, durationMs: settled.durationMs });
        const status = settled.status === "ok" ? "ran" : settled.status;
        return sendJson(res, 200, {
          status,
          jobId: id,
          runId: settled.runId,
          durationMs: settled.durationMs,
          error: settled.error,
          result: settled.result
        });
      }

      if (method === "GET" && pathname === "/skills") return sendJson(res, 200, runtime.skills?.list() ?? []);
      if (method === "GET" && pathname === "/skills/suggested") return sendJson(res, 200, runtime.patternMiner?.list() ?? []);
      if (method === "POST" && pathname.match(/^\/skills\/replay\/[^/]+$/)) {
        const skill = decodeURIComponent(pathname.split("/")[3]);
        const body = await readJson(req).catch(() => ({}));
        try {
          const result = await runtime.skillReplay.run({ skill, dryRun: body.dryRun, confirm: body.confirm ?? "first-run" });
          return sendJson(res, 200, result);
        } catch (error) {
          return sendJson(res, 400, { error: error.message });
        }
      }
      if (method === "POST" && pathname.match(/^\/skills\/replay-result\/[^/]+$/)) {
        const jobId = decodeURIComponent(pathname.split("/")[3]);
        const body = await readJson(req).catch(() => ({}));
        const result = runtime.skillReplay.resolveJob(jobId, body);
        if (!result) return sendJson(res, 404, { error: "unknown job" });
        return sendJson(res, 200, { ok: true });
      }
      if (method === "GET" && pathname === "/skills/replay-jobs") {
        return sendJson(res, 200, runtime.skillReplay.list({ status: url.searchParams.get("status") }));
      }
      if (method === "POST" && pathname === "/integrations/connect-mcp") {
        // One-click register + connect for catalog entries. Used by the
        // unified Integrations tab so the user doesn't have to fill in
        // the MCP register form for known servers.
        //
        // Body: { catalogId, apiKey? } — apiKey is required when the
        // catalog entry has apiKeyEnvVar AND that env var isn't already
        // populated. We persist the key to .env (under the entry's
        // declared apiKeyEnvVar) so it survives restart, then register
        // the MCP with `${VAR}` indirection — never with a literal.
        const body = await readJson(req).catch(() => ({}));
        const catalogId = body.catalogId;
        if (!catalogId) return sendJson(res, 400, { error: "catalogId required" });
        const { MCP_CATALOG } = await import("./mcp-catalog.js");
        const entry = MCP_CATALOG.find((e) => e.id === catalogId);
        if (!entry) return sendJson(res, 404, { error: "not in catalog" });
        if (!entry.register) return sendJson(res, 400, { error: "catalog entry has no register info" });
        try {
          // API-key path: any catalog entry that declares apiKeyEnvVar
          // needs that env var populated before we register, regardless
          // of transport. http+bearer points spec.apiKey at the var;
          // stdio entries already reference it in their args/env block,
          // so we just need it on disk + in the registry's allowlist.
          if (entry.apiKeyEnvVar) {
            const incoming = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
            const existing = process.env[entry.apiKeyEnvVar] ?? "";
            if (incoming) {
              const { saveEnv } = await import("./setup-wizard.js");
              const dataDir = resolveDataDir();
              saveEnv({ dataDir, values: { [entry.apiKeyEnvVar]: incoming } });
            } else if (!existing) {
              return sendJson(res, 400, {
                error: `apiKey required (catalog entry '${entry.id}' uses ${entry.apiKeyEnvVar} which isn't set yet)`,
                apiKeyEnvVar: entry.apiKeyEnvVar
              });
            }
            runtime.mcp.allowEnvKey?.(entry.apiKeyEnvVar);
          }
          const spec = { name: entry.id, ...entry.register };
          if (entry.register.auth === "bearer" && entry.apiKeyEnvVar) {
            spec.apiKey = `\${${entry.apiKeyEnvVar}}`;
          }
          const server = runtime.mcp.registerServer(spec);
          if (runtime.mcp?.connect) {
            runtime.mcp.connect(server.name).catch(() => { /* OAuth path surfaces via SSE */ });
          }
          return sendJson(res, 200, { name: server.name, transport: server.transport });
        } catch (error) {
          return sendJson(res, 400, { error: error.message });
        }
      }
      if (method === "GET" && pathname === "/pending-actions") {
        const status = url.searchParams.get("status") || undefined;
        return sendJson(res, 200, {
          actions: runtime.pendingActions?.list({ status }) ?? []
        });
      }
      if (method === "GET" && pathname === "/outreach/feed") {
        const since = Number(url.searchParams.get("since") ?? 0);
        const items = runtime.outreach?.since(since) ?? [];
        return sendJson(res, 200, { items, cursor: runtime.outreach?.nextSeq ? runtime.outreach.nextSeq - 1 : since });
      }
      if (method === "GET" && pathname === "/outreach/digest") {
        const digest = runtime.outreach?.list().find((i) => i.type === "digest") ?? null;
        return sendJson(res, 200, { digest });
      }
      if (method === "GET" && pathname === "/outreach/config") {
        const c = runtime.outreachConfig;
        return sendJson(res, 200, c
          ? { enabled: c.enabled, destination: c.destination, cadenceHours: c.cadenceHours, quietHours: c.quietHours, stalledDays: c.stalledDays }
          : { enabled: false });
      }
      if (method === "POST" && pathname.startsWith("/outreach/") && pathname.endsWith("/act")) {
        const id = decodeURIComponent(pathname.slice("/outreach/".length, -"/act".length));
        const item = runtime.outreach?.get(id);
        if (!item) return sendJson(res, 404, { error: "unknown outreach item" });
        if (item.status === "acted" || item.status === "dismissed") {
          return sendJson(res, 200, { item });
        }
        const body = await readJson(req).catch(() => ({}));
        const action = String(body.action ?? "");
        try {
          const applied = await applyOutreachAction(runtime, item, action, body.note);
          if (applied?.pendingAction) {
            queueApprovalContinuation(applied.pendingAction, applied.invokeResult);
          }
          const status = action === "dismiss" ? "dismissed" : "acted";
          const updated = runtime.outreach.resolve(id, { action, by: "user", note: body.note ?? null }, { status });
          return sendJson(res, 200, { item: updated });
        } catch (error) {
          if (error?.code === "OUTREACH_ACTION_CONFLICT") {
            return sendJson(res, 409, { item: runtime.outreach.get(id), error: error.message });
          }
          const updated = runtime.outreach.resolve(id, { action, by: "user" }, { status: "error", error: error.message });
          return sendJson(res, 400, { item: updated, error: error.message });
        }
      }
      if (method === "POST" && pathname.startsWith("/outreach/") && pathname.endsWith("/feedback")) {
        const id = decodeURIComponent(pathname.slice("/outreach/".length, -"/feedback".length));
        const item = runtime.outreach?.get(id);
        if (!item) return sendJson(res, 404, { error: "unknown outreach item" });
        if (item.status === "acted" || item.status === "dismissed") {
          return sendJson(res, 200, { item });
        }
        const body = await readJson(req).catch(() => ({}));
        const verdict = String(body.verdict ?? "");
        if (verdict !== "up" && verdict !== "down") {
          return sendJson(res, 400, { error: "verdict must be 'up' or 'down'" });
        }
        try {
          await applyOutreachFeedback(runtime, item, verdict, body.note ?? null);
          const updated = runtime.outreach.resolve(id, { action: verdict, by: "user", note: body.note ?? null }, { status: "acted" });
          return sendJson(res, 200, { item: updated });
        } catch (error) {
          const updated = runtime.outreach.resolve(id, { action: verdict, by: "user" }, { status: "error", error: error.message });
          return sendJson(res, 400, { item: updated, error: error.message });
        }
      }
      if (method === "POST" && pathname.startsWith("/outreach/") && pathname.endsWith("/reply")) {
        const id = decodeURIComponent(pathname.slice("/outreach/".length, -"/reply".length));
        const item = runtime.outreach?.get(id);
        if (!item) return sendJson(res, 404, { error: "unknown outreach item" });
        if (!channels) return sendJson(res, 503, { error: "agent-host-disabled" });
        const body = await readJson(req);
        if (item.outcomeId && runtime.outcomes?.resolve) {
          try {
            runtime.outcomes.resolve(item.outcomeId, inferToneScore(String(body.text ?? "")), "user-followup", "tone of outreach reply");
          } catch { /* best effort */ }
        }
        const forward = `Re: "${item.title}" (${item.type}, actions: ${item.actions.join("/")}).\nUser says: ${body.text ?? ""}\nInterpret intent and take the appropriate action.`;
        const turn = await channels.handleLocalMessage({ text: forward, from: `outreach:${id}` });
        return sendJson(res, 200, { reply: turn.reply ?? null });
      }
      if (method === "POST" && pathname.startsWith("/pending-actions/") && pathname.endsWith("/approve")) {
        const id = decodeURIComponent(pathname.slice("/pending-actions/".length, -"/approve".length));
        let action = runtime.pendingActions?.get(id);
        if (!action) return sendJson(res, 404, { error: "unknown pending action" });
        if (action.status === "expired") {
          return sendJson(res, 410, { error: "approval expired; request it again" });
        }
        if (action.status !== "pending") return sendJson(res, 409, { error: `action already ${action.status}` });
        const claim = runtime.pendingActions?.claimForExecution?.(id, { claimedBy: "user" });
        if (!claim) {
          action = runtime.pendingActions?.get(id);
          return sendJson(res, 409, { error: `action already ${action?.status ?? "claimed"}` });
        }
        action = claim.action;
        // Re-invoke the original tool with the bypass flag so the gate
        // doesn't re-queue the same call. Persist the result on the action.
        const invokeResult = await runtime.tools.invoke(action.toolName, action.args, {
          ...action.context,
          __confirmed: true,
          __confirmationActionId: action.id
        });
        const executionError = invokeResult?.ok ? null : invokeResult?.error ?? "approved tool execution failed";
        recordApprovedActionOutcome(runtime, action, invokeResult);
        runtime.pendingActions.decide(id, {
          decision: "approve",
          decidedBy: "user",
          result: invokeResult.ok ? invokeResult.result : null,
          error: executionError,
          executionId: claim.executionId
        });
        const continuation = queueApprovalContinuation(action, invokeResult);
        return sendJson(res, invokeResult.ok ? 200 : 400, {
          ...invokeResult,
          ...(continuation ? { continuation } : {})
        });
      }
      if (method === "POST" && pathname.startsWith("/pending-actions/") && pathname.endsWith("/deny")) {
        const id = decodeURIComponent(pathname.slice("/pending-actions/".length, -"/deny".length));
        const action = runtime.pendingActions?.get(id);
        if (!action) return sendJson(res, 404, { error: "unknown pending action" });
        if (action.status !== "pending") return sendJson(res, 409, { error: `action already ${action.status}` });
        const body = await readJson(req).catch(() => ({}));
        runtime.pendingActions.decide(id, {
          decision: "deny",
          decidedBy: "user",
          error: body.reason ?? "denied by user"
        });
        return sendJson(res, 200, { id, status: "denied" });
      }
      if (method === "GET" && pathname === "/computer-use/log") {
        if (!runtime.computerUseLog) return sendJson(res, 503, { error: "no computer-use log" });
        const { computerUseReadiness } = await import("./integrations/computer-use.js");
        const limit = Number(url.searchParams.get("limit") ?? 100);
        const sessions = runtime.computerUseLog.listSessions();
        const actions = runtime.computerUseLog.listActions({ limit });
        const readiness = await computerUseReadiness({
          toolsRegistered: runtime.tools?.has?.("start_computer_use_session") ?? false,
          runtime
        });
        return sendJson(res, 200, {
          enabled: readiness.enabled,
          readiness,
          stats: runtime.computerUseLog.stats(),
          sessions,
          actions
        });
      }
      if (method === "POST" && pathname === "/computer-use/toggle") {
        // Flip OPENAGI_COMPUTER_USE on or off without a daemon restart.
        // Persists to .openagi/.env, mutates process.env, then registers
        // or unregisters the tools dynamically against the live registry.
        // Off-flip ends any active session so the agent doesn't reference
        // a tool that no longer exists on its next turn.
        const body = await readJson(req).catch(() => ({}));
        const enable = Boolean(body.enable);
        const { saveEnv } = await import("./setup-wizard.js");
        const { registerComputerUseTools, unregisterComputerUseTools } = await import("./integrations/computer-use.js");
        // saveEnv writes only allowlisted keys; OPENAGI_COMPUTER_USE has
        // to be in WIZARD_FIELDS (added in this commit) for the write to
        // land in .env. Use the interface's captured dataDir rather than
        // resolving it again: explicit per-instance overrides are authoritative
        // and resolveDataDir() memoizes globally within the process.
        if (enable) {
          saveEnv({ dataDir, values: { OPENAGI_COMPUTER_USE: "1" } });
          process.env.OPENAGI_COMPUTER_USE = "1";
        } else {
          saveEnv({ dataDir, values: {}, clear: ["OPENAGI_COMPUTER_USE"] });
          // saveEnv's clear path also strips process.env, but be explicit:
          delete process.env.OPENAGI_COMPUTER_USE;
        }
        if (enable) {
          registerComputerUseTools(runtime.tools, runtime);
          ensureNodeControlWorker();
        } else {
          // Close any active session before removing tools.
          const active = runtime.computerUseLog?.listSessions?.({ status: "active" }) ?? [];
          for (const s of active) {
            if (runtime.abortComputerUseSession) await runtime.abortComputerUseSession(s, "disabled via toggle");
            else runtime.computerUseLog.endSession(s.id, { reason: "disabled via toggle", status: "aborted" });
          }
          await computerExecutor?.close?.();
          unregisterComputerUseTools(runtime.tools);
          if (activeNodeCapabilityProviders().size === 0) await stopNodeControlWorker();
        }
        return sendJson(res, 200, { enabled: enable, tools: enable ? "registered" : "unregistered" });
      }
      if (method === "POST" && pathname.startsWith("/computer-use/sessions/") && pathname.endsWith("/abort")) {
        const id = decodeURIComponent(pathname.slice("/computer-use/sessions/".length, -"/abort".length));
        const existing = runtime.computerUseLog?.getSession?.(id);
        if (!existing) return sendJson(res, 404, { error: "unknown session" });
        if (runtime.abortComputerUseSession) await runtime.abortComputerUseSession(existing, "aborted via dashboard");
        else runtime.computerUseLog?.endSession(id, { reason: "aborted via dashboard", status: "aborted" });
        const session = runtime.computerUseLog?.getSession?.(id);
        if (!session) return sendJson(res, 404, { error: "unknown session" });
        return sendJson(res, 200, { id, status: session.status });
      }
      if (method === "POST" && pathname === "/control/restart") {
        // Bounce the daemon so .env changes pick up. The Mac app's
        // DaemonController has a terminationHandler that respawns after a
        // short backoff; bare-metal `npm run serve` users will need to
        // re-launch manually. The endpoint returns 202 immediately, then
        // schedules the exit so the response can flush.
        sendJson(res, 202, { restarting: true });
        setTimeout(() => process.exit(0), 200);
        return;
      }
      if (method === "GET" && pathname === "/control/update") {
        // Dry check — is a newer version available? (no changes applied)
        const { checkForUpdate } = await import("./self-update.js");
        return sendJson(res, 200, await checkForUpdate());
      }
      if (method === "POST" && pathname === "/control/update") {
        // Self-update: fast-forward the checkout, reinstall deps if needed,
        // then exit(0) so the supervisor (systemd Restart=always / launchd
        // KeepAlive / Mac DaemonController) respawns with the new code. No-op
        // with a reason when already current or not fast-forwardable.
        const { applyUpdate } = await import("./self-update.js");
        const result = await applyUpdate();
        sendJson(res, result.updated ? 202 : 200, result);
        if (result.updated) {
          runtime.events?.emit?.("self-update", { at: new Date().toISOString(), from: result.from, to: result.to });
          setTimeout(() => process.exit(0), 300); // respawn with new code
        }
        return;
      }
      if (method === "GET" && pathname === "/integrations/status") {
        // Unified integrations view. Every source/channel/MCP catalog
        // entry shows up here, with whichever paths apply (API key vs.
        // MCP) so the user has ONE place to configure everything.
        const { MCP_CATALOG, CATEGORIES } = await import("./mcp-catalog.js");
        const registeredMcps = runtime.mcp?.listServers?.() ?? [];
        const mcpStatus = (id) => {
          const wanted = String(id).toLowerCase();
          const compact = wanted.replace(/-/g, "");
          const server = registeredMcps.find((candidate) => {
            const name = String(candidate.name ?? "").toLowerCase();
            return name === wanted || name === compact;
          });
          const registered = Boolean(server);
          const authenticated = server?.auth === "oauth"
            ? Boolean(runtime.mcp.hasOAuthToken?.(server.name))
            : registered;
          return {
            registered,
            connected: Boolean(server?.connected),
            authenticated,
            configured: Boolean(server?.connected),
            mcpName: server?.name ?? null
          };
        };
        const integrations = [
          {
            id: "linear",
            name: "Linear",
            description: "Sync your assigned issues as tasks; let the agent search/create issues from chat.",
            paths: [
              {
                kind: "api",
                label: "Direct API (auto-poll)",
                configured: Boolean(runtime.linearTaskSource?.isConfigured?.()),
                envKeys: ["LINEAR_API_KEY"],
                lastSyncedAt: runtime.linearTaskSource?.lastSyncedAt ?? null,
                lastSync: runtime.linearTaskSource?.lastSyncResult ?? null,
                feeds: "tasks",
                detail: "Polls every 5 min. Assigned issues become tasks. Lin priority maps to bucket+priority."
              },
              {
                kind: "mcp",
                label: "MCP (on-demand)",
                catalogId: "linear",
                ...mcpStatus("linear")
              }
            ]
          },
          {
            id: "buildbetter",
            name: "BuildBetter",
            description: "Pull call action items / commitments / follow-ups as tasks. On-demand call search via MCP.",
            paths: [
              {
                kind: "api",
                label: "Direct API (auto-poll)",
                configured: Boolean(runtime.buildBetterTaskSource?.isConfigured?.()),
                envKeys: ["BUILDBETTER_API_KEY", "BUILDBETTER_USER_EMAIL", "BUILDBETTER_USER_NAME"],
                lastSyncedAt: runtime.buildBetterTaskSource?.lastSyncedAt ?? null,
                lastSync: runtime.buildBetterTaskSource?.lastSyncResult ?? null,
                feeds: "tasks",
                detail: "Polls every 15 min. action_item / commitment / follow_up extractions become tasks."
              },
              {
                kind: "mcp",
                label: "MCP (on-demand)",
                catalogId: "buildbetter",
                ...mcpStatus("buildbetter")
              }
            ]
          },
          {
            id: "rize",
            name: "Rize.io",
            description: "Time-tracking. Lets the agent answer 'what did I work on today?' and surface productivity patterns.",
            paths: [
              {
                kind: "api",
                label: "Direct API (agent tools)",
                configured: Boolean(process.env.RIZE_API_KEY),
                envKeys: ["RIZE_API_KEY"],
                feeds: "agent-tools",
                detail: "Adds rize_today_summary / rize_query / rize_recent_sessions agent tools."
              },
              {
                kind: "mcp",
                label: "MCP (on-demand)",
                catalogId: "rize",
                ...mcpStatus("rize")
              }
            ]
          },
          {
            id: "remarkable",
            name: "reMarkable",
            description: "Pull notes + handwritten content from your reMarkable tablet, plus parse task checkboxes.",
            paths: [
              {
                kind: "folder",
                label: "Inbox folder (Dropbox sync)",
                configured: true,
                feeds: "tasks",
                detail: "Drop .md/.txt files into ~/Library/Application Support/OpenAGI/inbox/ — sweeps every 30s for - [ ] checkboxes + TODO: lines. reMarkable → Dropbox sync → this folder is the canonical path. Also works for Obsidian/Bear."
              },
              {
                kind: "mcp",
                label: "reMarkable MCP",
                catalogId: "remarkable",
                ...mcpStatus("remarkable")
              }
            ]
          },
          {
            id: "imessage",
            name: "iMessage (text yourself as inbox)",
            description: "Reads ~/Library/Messages/chat.db read-only and converts messages from a 1:1 self-chat into tasks. macOS only · requires Full Disk Access · opt-in.",
            paths: [
              (() => {
                const s = runtime.imessagePoller?.status?.() ?? null;
                return {
                  kind: "api",
                  label: "Local SQLite poll",
                  configured: Boolean(s?.enabled && s?.readable && s?.selfHandle),
                  envKeys: ["IMESSAGE_ENABLED", "IMESSAGE_SELF_HANDLE", "IMESSAGE_INTERVAL_MS", "IMESSAGE_MODE"],
                  lastSyncedAt: s?.lastSyncedAt ?? null,
                  feeds: "tasks",
                  detail: !s
                    ? "Module not initialized."
                    : !s.enabled
                      ? "Disabled. Set IMESSAGE_ENABLED=1 + IMESSAGE_SELF_HANDLE in .env to turn on."
                      : !s.readable && s.dbExists
                        ? "⚠ Cannot read chat.db — grant Full Disk Access in System Settings → Privacy & Security → Full Disk Access, then restart the daemon."
                        : !s.selfHandle
                          ? "Set IMESSAGE_SELF_HANDLE to the iCloud email or phone you text yourself from."
                          : `Reading from ${s.selfHandle}. Last imported ROWID: ${s.lastImportedRowid ?? 0}.`
                };
              })()
            ]
          },
          {
            id: "telegram",
            name: "Telegram",
            kind: "channel",
            description: "Bot conversations. Webhook or long-polling.",
            paths: [
              {
                kind: "api",
                label: "Bot token",
                configured: Boolean(process.env.TELEGRAM_BOT_TOKEN),
                envKeys: ["TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET", "TELEGRAM_POLLING"]
              }
            ]
          },
        ];
        // Featured integrations (BuildBetter, Linear, Rize, …) are ALSO listed
        // in the browse catalog below — intentionally a duplicate, flagged so
        // the UI can say "this is the MCP version of an integration you also
        // have a non-MCP (API) path for above".
        const featuredIds = new Set(integrations.map((i) => i.id));
        const catalog = MCP_CATALOG
          .map((entry) => ({
            id: entry.id,
            name: entry.name,
            description: entry.description,
            category: entry.category,
            authType: entry.authType,
            status: entry.status,
            apiKeyEnvVar: entry.apiKeyEnvVar ?? null,
            apiKeyHelp: entry.apiKeyHelp ?? null,
            apiKeyConfigured: entry.apiKeyEnvVar ? Boolean(process.env[entry.apiKeyEnvVar]) : true,
            connectable: entry.status === "available" && Boolean(entry.register),
            ...mcpStatus(entry.id),
            featured: featuredIds.has(entry.id)
          }));
        return sendJson(res, 200, { integrations, catalog, categories: CATEGORIES });
      }
      if (method === "GET" && pathname === "/tasks") {
        if (!runtime.tasks?.list) return sendJson(res, 503, { error: "no task store" });
        const queue = url.searchParams.get("queue") || undefined;
        const bucket = url.searchParams.get("bucket") || undefined;
        const status = url.searchParams.get("status") || undefined;
        const limit = url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : undefined;
        return sendJson(res, 200, {
          tasks: runtime.tasks.list({ queue, bucket, status, limit }),
          stats: runtime.tasks.stats()
        });
      }
      if (method === "POST" && pathname === "/tasks") {
        if (!runtime.tasks?.add) return sendJson(res, 503, { error: "no task store" });
        const body = await readJson(req);
        try {
          const task = runtime.tasks.add(body, { source: body.source ?? "manual", queue: body.queue ?? "user" });
          return sendJson(res, 200, task);
        } catch (error) { return sendJson(res, 400, { error: error.message }); }
      }
      if (method === "GET" && pathname.match(/^\/tasks\/[^/]+$/)) {
        if (!runtime.tasks?.get) return sendJson(res, 503, { error: "no task store" });
        const id = decodeURIComponent(pathname.split("/")[2]);
        const task = runtime.tasks.get(id);
        return task ? sendJson(res, 200, task) : sendJson(res, 404, { error: "unknown task" });
      }
      if (method === "PATCH" && pathname.match(/^\/tasks\/[^/]+$/)) {
        if (!runtime.tasks?.update) return sendJson(res, 503, { error: "no task store" });
        const id = decodeURIComponent(pathname.split("/")[2]);
        const body = await readJson(req);
        const task = runtime.tasks.update(id, body);
        return task ? sendJson(res, 200, task) : sendJson(res, 404, { error: "unknown task" });
      }
      if (method === "POST" && pathname.match(/^\/tasks\/[^/]+\/complete$/)) {
        const id = decodeURIComponent(pathname.split("/")[2]);
        const body = await readJson(req).catch(() => ({}));
        const task = runtime.tasks.complete(id, body.completedVia ?? "manual");
        return task ? sendJson(res, 200, task) : sendJson(res, 404, { error: "unknown task" });
      }
      if (method === "DELETE" && pathname.match(/^\/tasks\/[^/]+$/)) {
        const id = decodeURIComponent(pathname.split("/")[2]);
        const ok = runtime.tasks.remove(id);
        return sendJson(res, ok ? 200 : 404, { ok, id });
      }
      // The undo for "stop asking" (POST /drafts/:id/stop-asking). Retiring a
      // task is allowed to be one tap precisely BECAUSE this exists: nothing was
      // deleted, so putting it back is a status change plus a note.
      //
      // It returns to "pending", not to sourceMeta.retired.fromStatus, and that
      // is deliberate. "Un-retire" means "you may work this again", and pending
      // is the only status the agent queue serves (agentPickNext filters on it);
      // restoring an in_progress task to in_progress would produce a task that
      // is un-retired and still invisible to the queue — the wedged state
      // task-store's whole lease design exists to prevent. The status it was
      // stopped from is preserved in the history entry, so nothing is lost.
      if (method === "POST" && pathname.match(/^\/tasks\/[^/]+\/unretire$/)) {
        if (!runtime.tasks?.get || !runtime.tasks?.update) return sendJson(res, 503, { error: "no task store" });
        const id = decodeURIComponent(pathname.split("/")[2]);
        const task = runtime.tasks.get(id);
        if (!task) return sendJson(res, 404, { error: "unknown task" });
        const retired = task.sourceMeta?.retired ?? null;
        if (!retired) return sendJson(res, 409, { error: "task was not retired" });
        const meta = { ...(task.sourceMeta ?? {}) };
        // Move the record into history rather than dropping it: `retired` has
        // to mean "is retired right now" for this route and the UI to be able to
        // tell, and the audit trail has to survive the undo. Both, not either.
        const history = Array.isArray(meta.retiredHistory) ? [...meta.retiredHistory] : [];
        history.push({ ...retired, revertedAt: new Date().toISOString(), revertedBy: "user" });
        delete meta.retired;
        meta.retiredHistory = history;
        const next = runtime.tasks.update(id, { status: "pending", sourceMeta: meta });
        return next ? sendJson(res, 200, next) : sendJson(res, 404, { error: "unknown task" });
      }
      // Clarification queue — the "ask me" loop. ids are looked up in an
      // in-memory Map (never a filesystem path), so the strict-id concern
      // from suggestion routes doesn't apply here.
      if (method === "GET" && pathname === "/tasks/reconciliation/calibration") {
        // Transparency: how the auto-complete threshold has self-tuned from
        // the user's clarification answers, per evidence-source combo.
        const { buildReconciliationCalibration } = await import("./reconciliation-calibration.js");
        const outcomes = runtime.outcomes?.recent?.(200, "clarification-answered") ?? [];
        return sendJson(res, 200, buildReconciliationCalibration(outcomes).summary);
      }
      if (method === "GET" && pathname === "/tasks/clarifications") {
        if (!runtime.clarifications?.list) return sendJson(res, 503, { error: "no clarification store" });
        const status = url.searchParams.get("status");
        return sendJson(res, 200, runtime.clarifications.list({ status: status === "null" ? null : (status ?? "pending") }));
      }
      if (method === "POST" && pathname.match(/^\/tasks\/clarifications\/[^/]+\/answer$/)) {
        if (!runtime.clarifications?.answer) return sendJson(res, 503, { error: "no clarification store" });
        const id = decodeURIComponent(pathname.split("/")[3]);
        const body = await readJson(req).catch(() => ({}));
        try {
          const result = runtime.clarifications.answer(id, body.answer);
          return result ? sendJson(res, 200, result) : sendJson(res, 404, { error: "unknown or already-resolved clarification" });
        } catch (error) { return sendJson(res, 400, { error: error.message }); }
      }
      // Drafts review queue — agent-produced artifacts awaiting approval.
      // ids are Map keys, never fs paths → no traversal surface.
      if (method === "GET" && pathname === "/drafts") {
        if (!runtime.drafts?.list) return sendJson(res, 503, { error: "no draft store" });
        const status = url.searchParams.get("status");
        return sendJson(res, 200, runtime.drafts.list({ status: status === "null" ? null : (status ?? "pending") }));
      }
      if (method === "PATCH" && pathname.match(/^\/drafts\/[^/]+$/)) {
        if (!runtime.drafts?.edit) return sendJson(res, 503, { error: "no draft store" });
        const id = decodeURIComponent(pathname.split("/")[2]);
        const body = await readJson(req).catch(() => ({}));
        const draft = runtime.drafts.edit(id, body);
        return draft ? sendJson(res, 200, draft) : sendJson(res, 404, { error: "unknown or already-resolved draft" });
      }
      if (method === "POST" && pathname.match(/^\/drafts\/[^/]+\/(approve|discard)$/)) {
        if (!runtime.drafts) return sendJson(res, 503, { error: "no draft store" });
        const parts = pathname.split("/");
        const id = decodeURIComponent(parts[2]);
        const action = parts[3];
        const draft = action === "approve" ? runtime.drafts.approve(id) : runtime.drafts.discard(id);
        return draft ? sendJson(res, 200, draft) : sendJson(res, 404, { error: "unknown or already-resolved draft" });
      }
      // "Stop asking" — discard this draft AND retire the task that generates
      // it. The /discard route above is deliberately the OTHER choice: it
      // resolves the artifact and leaves the task alone, which task-store reads
      // as "not this one, try again" (OPEN_DRAFT_STATUSES in task-store.js), so
      // the next autopilot pulse drafts it again. That is a real and often
      // correct behaviour, and it is also why the user's discards kept coming
      // back — measured on their install: 69 of 97 pending drafts belonged to a
      // task that already had one, and task_7d758c61ed194ddb had produced four.
      // Rather than guess which one a discard meant, both are offered.
      //
      // Returns BOTH halves of what happened, because they can differ: the
      // draft is always resolvable, the retirement can be skipped (no task, an
      // already-completed task) or fail, and the client must not report "won't
      // ask again" unless a task was actually retired.
      if (method === "POST" && pathname.match(/^\/drafts\/[^/]+\/stop-asking$/)) {
        if (!runtime.drafts?.get || !runtime.drafts?.discard) return sendJson(res, 503, { error: "no draft store" });
        const id = decodeURIComponent(pathname.split("/")[2]);
        // Read BEFORE discarding: discard() returns null for an already-resolved
        // draft, and the taskId on the stored record is the only way to know
        // what to retire in that case. A second client discarding the same row
        // must not cost the user their "stop asking".
        const existing = runtime.drafts.get(id);
        if (!existing) return sendJson(res, 404, { error: "unknown draft" });
        const resolved = runtime.drafts.discard(id);
        const retirement = retireGeneratingTask(runtime, existing.taskId ?? null, { draftId: id });
        return sendJson(res, 200, {
          draft: resolved ?? existing,
          // Whether THIS call resolved the draft. false means it was already
          // resolved (approved/sent/discarded) before we got here.
          discarded: Boolean(resolved),
          ...retirement
        });
      }
      if (method === "POST" && pathname.match(/^\/drafts\/[^/]+\/send$/)) {
        // Explicit user-initiated send: route the draft body through a REAL
        // outbound transport (telegram). This is the only path that
        // transmits externally; it's a deliberate dashboard action, not the
        // agent. We only mark the draft "sent" if delivery actually confirms.
        if (!runtime.drafts?.get) return sendJson(res, 503, { error: "no draft store" });
        if (!runtime.channels?.deliver) return sendJson(res, 503, { error: "no outbound channels" });
        const id = decodeURIComponent(pathname.split("/")[2]);
        const draft = runtime.drafts.get(id);
        if (!draft) return sendJson(res, 404, { error: "unknown draft" });
        if (draft.status === "sent") return sendJson(res, 409, { error: "draft already sent" });
        if (draft.status === "discarded") return sendJson(res, 409, { error: "draft was discarded" });
        const body = await readJson(req).catch(() => ({}));
        const channel = body.channel;
        const target = body.target ?? draft.recipient;
        if (channel !== "telegram") {
          return sendJson(res, 400, { error: "send requires channel 'telegram' (email has no native transport — copy the approved draft into your mail client)" });
        }
        if (!target) return sendJson(res, 400, { error: "no target/recipient for this send" });
        let result;
        try {
          result = await runtime.channels.deliver({ channel, target, text: draft.body, refId: draft.id });
        } catch (error) { return sendJson(res, 502, { error: error.message }); }
        if (result?.delivered === false) {
          return sendJson(res, 502, { error: result.reason ?? "delivery failed", result });
        }
        const sent = runtime.drafts.markSent(id, { channel, target, result });
        return sendJson(res, 200, { sent, result });
      }
      if (method === "POST" && pathname.match(/^\/tasks\/clarifications\/[^/]+\/dismiss$/)) {
        if (!runtime.clarifications?.dismiss) return sendJson(res, 503, { error: "no clarification store" });
        const id = decodeURIComponent(pathname.split("/")[3]);
        const item = runtime.clarifications.dismiss(id);
        return item ? sendJson(res, 200, item) : sendJson(res, 404, { error: "unknown or already-resolved clarification" });
      }
      if (method === "GET" && pathname === "/proactive/suggestions") {
        // Story 4: merge observer suggestions + miner candidates. Both go
        // through the unified envelope so the dashboard renders them with
        // the same card shape; source badge tells them apart.
        const { listAllSuggestions } = await import("./suggestion-feed.js");
        const status = url.searchParams.get("status");
        const id = url.searchParams.get("id");
        const suggestions = listAllSuggestions(runtime, {
          status: status === "null" ? null : (status ?? "pending")
        });
        return sendJson(res, 200, id ? suggestions.filter((item) => item.id === id) : suggestions);
      }
      if (method === "POST" && pathname === "/proactive/observe") {
        if (!runtime.proactiveObserver?.observe) return sendJson(res, 503, { error: "no observer" });
        try {
          const result = await runtime.proactiveObserver.observe({ force: true });
          return sendJson(res, 200, result);
        } catch (error) { return sendJson(res, 500, { error: error.message }); }
      }
      if (method === "POST" && pathname.match(/^\/proactive\/suggestions\/[^/]+\/(accept|reject|dismiss)$/)) {
        const parts = pathname.split("/");
        const id = decodeURIComponent(parts[3]);
        const action = parts[4];
        const status = action === "accept" ? "accepted" : action === "reject" ? "rejected" : "dismissed";
        // Story 4: status writes go through the unified feed so they
        // land in the right source file (observer OR miner). Same id
        // namespace; resolveSuggestion locates the file by id.
        const { findSuggestion, resolveSuggestion } = await import("./suggestion-feed.js");

        // reject / dismiss have no materialization step — the status write IS
        // the whole action, so they resolve straight away.
        if (status !== "accepted") {
          const resolved = resolveSuggestion(runtime, id, status);
          if (!resolved) return sendJson(res, 404, { error: "unknown suggestion" });
          // Let any open dashboard refresh its Suggestions tab live.
          events.emit("suggestion-resolved", { id, status, category: resolved.category ?? null });
          return sendJson(res, 200, resolved);
        }

        // Accept is transactional from the user's point of view: materialize
        // FIRST, record "accepted" only once the side effect actually landed.
        // Writing accepted up front and failing afterwards stranded the
        // suggestion — gone from the pending queue, nothing created, and no
        // way for the user to retry the thing they just said yes to.
        const candidate = findSuggestion(runtime, id);
        if (!candidate) return sendJson(res, 404, { error: "unknown suggestion" });

        // commit(): record the accept, then answer with the RESOLVED envelope
        // so status/resolvedAt in the body match what's on disk.
        const commit = (extra) => {
          // Null only if the record vanished between read and write; the side
          // effect still landed, so report it rather than 404 the user.
          const accepted = resolveSuggestion(runtime, id, "accepted") ?? { ...candidate, status: "accepted" };
          events.emit("suggestion-resolved", { id, status: "accepted", category: accepted.category ?? null });
          return sendJson(res, 200, { ...accepted, ...extra });
        };
        // fail(): nothing was written, so the suggestion is still pending and
        // the user can retry it from the same queue. The body keeps the exact
        // *Error field the Mac client and the dashboard key their message off.
        const fail = (extra) => sendJson(res, 200, { ...candidate, ...extra });

        // For MCP suggestions, accepting auto-registers + connects the server.
        if (candidate.category === "mcp" && candidate.mcpRegister && runtime.mcp?.registerServer) {
          const reg = candidate.mcpRegister;
          const name = candidate.mcpId ?? candidate.title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
          try {
            runtime.mcp.registerServer({ name, ...reg });
          } catch (error) {
            return fail({ registerError: error.message });
          }
          // The server IS registered now, so a connect failure must not undo
          // the accept. But it must not be reported as a connection either:
          // this used to fire-and-forget connect() with a swallowed rejection
          // and answer { registered }, which every client rendered as
          // "Connected <name>" — including for a server that could never be
          // reached. Wait (briefly) for the real outcome and say which of the
          // three it was: connected / registered-but-not-connected /
          // registered-but-connect-failed.
          const outcome = await connectAndReport(name);
          return commit({ registered: name, ...outcome });
        }
        // For task suggestions, accepting creates the task in the right
        // queue + bucket — through the same materializer the observer's
        // OPENAGI_AUTO_TASKS=1 path uses, so dedup (by suggestionId) and the
        // draft-only guardrails for agent-queue tasks apply identically.
        if (candidate.category === "task" && runtime.tasks?.add) {
          const { materializeTaskFromSuggestion } = await import("./proactive-observer.js");
          const task = materializeTaskFromSuggestion(runtime, candidate);
          if (!task) return fail({ taskCreateError: "could not create task" });
          return commit({ taskId: task.id });
        }
        // Story 1 + 6: accepting a skill suggestion materializes it into
        // a real SKILL.md file under the user skills dir. Dispatches by
        // source: observer suggestions use createSkillFromSuggestion
        // (Story 1 shape — flat title + draftBody), miner candidates use
        // createSkillFromCandidate (Story 6 shape — proposal.body +
        // sequence stats + scheduleHint). Both write to the same dir.
        if (candidate.category === "skill" && runtime.skills?.reload) {
          let result;
          try {
            const { createSkillFromSuggestion, createSkillFromCandidate } = await import("./skill-materialize.js");
            const isMined = candidate.source === "pattern-miner" || candidate.source === "session-miner";
            result = isMined
              ? createSkillFromCandidate({ runtime, candidate })
              : createSkillFromSuggestion({ runtime, suggestion: candidate });
            runtime.skills.reload();
          } catch (error) {
            return fail({ skillCreateError: error.message });
          }
          return commit({
            skillSlug: result.slug,
            skillPath: result.path,
            scheduleHint: result.scheduleHint ?? null,
            triggerHint: result.triggerHint ?? null,
            // When the candidate had a scheduleHint, the dashboard
            // asks the user whether to also create a cron job.
            requiresScheduleConfirm: Boolean(result.scheduleHint)
          });
        }
        // "knowledge" suggestions are things the observer learned about the
        // user. Accepting one used to be a no-op that still marked it
        // accepted — a Yes button that did nothing. Persist it into the same
        // memory store the `remember` tool writes to and hand back memoryId
        // so the client can say what actually happened.
        if (candidate.category === "knowledge") {
          if (!runtime.memory?.remember) return fail({ memoryCreateError: "no memory system", error: "no memory system" });
          const content = [candidate.title, candidate.rationale].filter(Boolean).join(" — ").trim();
          if (!content) return fail({ memoryCreateError: "suggestion has no title or rationale to remember", error: "suggestion has no title or rationale to remember" });
          let item;
          try {
            item = runtime.memory.remember(
              {
                source: candidate.source ?? "proactive-observer",
                scope: "main",
                content,
                tags: ["knowledge", "proactive-suggestion"],
                risk: 0.45,
                specificity: 0.7,
                repetition: 0.4,
                novelty: 0.6,
                metadata: { suggestionId: candidate.id, suggestionSource: candidate.source ?? null }
              },
              { source: "proactive-suggestion", strength: 0.7 }
            );
          } catch (error) {
            // `error` duplicates the message because the Mac client's outcome
            // reader keys off a fixed list that predates memoryCreateError.
            return fail({ memoryCreateError: error.message, error: error.message });
          }
          return commit({ memoryId: item.id, memoryTier: item.tier });
        }
        return commit({});
      }
      if (method === "POST" && pathname.match(/^\/skills\/[^/]+\/schedule$/)) {
        // Story 6: follow-up after accepting a miner candidate with
        // scheduleHint. User confirms (or skips) creating a cron job
        // that fires the new skill at the hinted time.
        const slug = decodeURIComponent(pathname.split("/")[2]);
        const body = await readJson(req).catch(() => ({}));
        if (!body.dailyAt) return sendJson(res, 400, { error: "dailyAt required, e.g. \"09:00\"" });
        if (!runtime.cron?.addJob) return sendJson(res, 503, { error: "no cron scheduler" });
        const job = runtime.cron.addJob({
          id: `skill-cron-${slug}`,
          name: `Auto-fire skill: ${slug}`,
          enabled: true,
          task: "prompt",
          dailyAt: body.dailyAt,
          input: { prompt: `Run the "${slug}" skill.`, channel: "local", target: null }
        });
        return sendJson(res, 200, { slug, jobId: job.id, dailyAt: body.dailyAt });
      }
      if (method === "GET" && pathname === "/proactive/preferences") {
        if (!runtime.suggestionFeedback) return sendJson(res, 503, { error: "no feedback module" });
        return sendJson(res, 200, {
          preferences: runtime.suggestionFeedback.readPreferences(),
          stats: runtime.suggestionFeedback.computeStats(),
          summary: runtime.suggestionFeedback.preferenceSummary(),
          multipliers: runtime.suggestionFeedback.categoryMultipliers()
        });
      }
      if (method === "POST" && pathname === "/proactive/preferences/mute") {
        if (!runtime.suggestionFeedback) return sendJson(res, 503, { error: "no feedback module" });
        const body = await readJson(req).catch(() => ({}));
        if (!body.category) return sendJson(res, 400, { error: "category required" });
        const muted = body.muted !== false;
        const prefs = runtime.suggestionFeedback.setMuted(body.category, muted);
        return sendJson(res, 200, { preferences: prefs });
      }
      if (method === "GET" && pathname.startsWith("/proactive/suggestions/") && pathname.endsWith("/outcome")) {
        // Story 2: did the thing this suggestion proposed actually pan out?
        // Returns the suggestion record + a summary of every outcome that
        // carried sourceSuggestionId === id (skill runs, task completions).
        const id = decodeURIComponent(pathname.slice("/proactive/suggestions/".length, -"/outcome".length));
        const all = runtime.proactiveObserver?.list?.() ?? [];
        const suggestion = (Array.isArray(all) ? all : []).find((s) => s.id === id);
        if (!suggestion) return sendJson(res, 404, { error: "unknown suggestion" });
        return sendJson(res, 200, {
          suggestion,
          outcomes: runtime.outcomes?.bySuggestion?.(id) ?? [],
          summary: runtime.outcomes?.aggregateBySuggestion?.(id) ?? null
        });
      }
      if (method === "GET" && pathname === "/recap/daily") {
        // Story 7: "what did I get done today" endpoint. Pulls the
        // structured recap; ?date=YYYY-MM-DD for past days.
        const { computeDailyRecap, renderDailyRecapMarkdown } = await import("./daily-recap.js");
        const dateParam = url.searchParams.get("date");
        const date = dateParam ? new Date(dateParam + "T12:00:00") : new Date();
        const recap = computeDailyRecap(runtime, { date });
        return sendJson(res, 200, {
          recap,
          markdown: renderDailyRecapMarkdown(recap)
        });
      }
      if (method === "GET" && pathname === "/plan/daily") {
        // Morning planner: forward-looking "what should I do today."
        // Read-only: never queues actions as a side effect (the cron does
        // that). We attach the REAL status of any actions the cron already
        // queued for this day so the dashboard shows drafted vs pending.
        const { computeDailyPlan, renderDailyPlanMarkdown, listQueuedPlanActions } = await import("./daily-planner.js");
        const dateParam = url.searchParams.get("date");
        const date = dateParam ? new Date(dateParam + "T12:00:00") : new Date();
        const plan = await computeDailyPlan(runtime, { date });
        plan.queuedActions = listQueuedPlanActions(runtime, plan.dateISO);
        return sendJson(res, 200, { plan, markdown: renderDailyPlanMarkdown(plan) });
      }
      if (method === "GET" && pathname === "/observations/recent-context") {
        if (!runtime.observations?.getRecentContext) return sendJson(res, 503, { error: "no observation store" });
        const minutes = Math.max(1, Math.min(60, Number(url.searchParams.get("minutes") ?? 10)));
        const ctx = await runtime.observations.getRecentContext({ minutes, maxChars: 1500, maxSnippets: 6 });
        return sendJson(res, 200, ctx);
      }
      if (method === "POST" && pathname === "/skills/mine") {
        // "Mine now" runs both miners so the user gets both activity-pattern
        // and chat-session candidates without having to know which is which.
        try {
          const [patternResult, sessionResult] = await Promise.all([
            runtime.patternMiner.mine().catch((err) => ({ error: err.message })),
            runtime.sessionMiner.mine().catch((err) => ({ error: err.message }))
          ]);
          runtime.events?.emit?.("miner-result", { source: "pattern-miner", manual: true, ...patternResult });
          runtime.events?.emit?.("miner-result", { source: "session-miner", manual: true, ...sessionResult });
          return sendJson(res, 200, { pattern: patternResult, session: sessionResult });
        } catch (error) { return sendJson(res, 500, { error: error.message }); }
      }
      if (method === "POST" && pathname.match(/^\/skills\/suggested\/[^/]+\/accept$/)) {
        const id = decodeURIComponent(pathname.split("/")[3]);
        try { return sendJson(res, 200, runtime.patternMiner.accept(id)); }
        catch (error) { return sendJson(res, 400, { error: error.message }); }
      }
      if (method === "POST" && pathname.match(/^\/skills\/suggested\/[^/]+\/reject$/)) {
        const id = decodeURIComponent(pathname.split("/")[3]);
        const body = await readJson(req).catch(() => ({}));
        const r = runtime.patternMiner.reject(id, body.reason);
        if (!r) return sendJson(res, 404, { error: "unknown candidate" });
        return sendJson(res, 200, r);
      }
      if (method === "POST" && pathname === "/skills/reload") {
        runtime.skills?.reload();
        return sendJson(res, 200, runtime.skills?.list() ?? []);
      }
      if (method === "POST" && pathname.match(/^\/skills\/[^/]+\/run$/)) {
        const name = decodeURIComponent(pathname.split("/")[2]);
        const body = await readJson(req);
        try {
          const result = await runtime.skills.run(name, { input: body.input ?? "", args: body.args ?? {} }, body.context ?? {});
          return sendJson(res, 200, result);
        } catch (error) {
          return sendJson(res, 400, { error: error.message });
        }
      }

      if (method === "GET" && pathname === "/mcp") {
        const servers = runtime.mcp.listServers().map((s) => ({
          ...s,
          connecting: runtime.mcp.isConnecting?.(s.name) ?? false,
          authenticated: s.auth === "oauth" ? Boolean(runtime.mcp.hasOAuthToken?.(s.name)) : null,
          // The authorization page may already have returned while the MCP
          // initialize request is still settling. Token presence is the
          // authoritative signal that login finished; don't render an old URL
          // as if the user still needs to authorize.
          pendingAuthUrl: runtime.mcp.hasOAuthToken?.(s.name)
            ? null
            : (pendingOauth.get(s.name)?.url ?? null)
        }));
        return sendJson(res, 200, servers);
      }
      if (method === "GET" && pathname === "/mcp/tools") return sendJson(res, 200, runtime.mcp.listTools());
      if (method === "POST" && pathname.match(/^\/mcp\/connect\/[^/]+$/)) {
        const name = decodeURIComponent(pathname.split("/")[3]);
        // Fire-and-forget so the OAuth dance doesn't block the HTTP response.
        // Dashboard polls /mcp and listens for SSE 'mcp' events to learn when
        // it's done (or if an OAuth URL needs to be opened).
        //
        // Always call connect(): the registry dedups in-flight attempts itself,
        // and a manual (interactive) connect made while a silent boot reconnect
        // is in flight must chain an interactive attempt after it — the silent
        // attempt can't open a browser and fails OAUTH_INTERACTIVE_REQUIRED,
        // which used to leave the Connect click doing nothing.
        runtime.mcp.connect(name)
          .then((status) => {
            pendingOauth.delete(name);
            events.emit("mcp", { op: "connected", name, tools: status?.tools ?? [] });
          })
          .catch((error) => {
            if (runtime.mcp.hasOAuthToken?.(name)) pendingOauth.delete(name);
            events.emit("mcp", { op: "connect-error", name, error: error.message });
          });
        events.emit("mcp", { op: "connecting", name });
        return sendJson(res, 202, { name, status: "connecting" });
      }
      if (method === "POST" && pathname.match(/^\/mcp\/clear-auth\/[^/]+$/)) {
        const name = decodeURIComponent(pathname.split("/")[3]);
        // SEC-3: the [^/]+ in the route above does NOT mean "one path segment".
        // url.pathname keeps percent-encoding, so "..%2F..%2F..%2Fvictim"
        // matches it, and decodeURIComponent then hands path.join a traversal —
        // which this handler used to unlinkSync. Validate the decoded name as a
        // single file stem (LABEL_SEGMENT, because real server names contain
        // spaces: the live install has "buildbetter staging.json") and assert
        // the resolved path is inside <dataDir>/mcp/auth before deleting.
        const authPath = safeJoinOrNull(
          path.join(dataDir, "mcp", "auth"),
          `${name}.json`,
          { pattern: LABEL_SEGMENT, label: "MCP server name" }
        );
        if (!authPath) return sendJson(res, 400, { error: "invalid MCP server name" });
        pendingOauth.delete(name);
        // "Forget login" is stronger than a transport disconnect: close the
        // active client and unregister its tools before deleting the cache, so
        // the dashboard and model cannot keep using a supposedly-forgotten
        // credential until restart.
        try {
          await runtime.mcp.disconnect?.(name);
          if (fsSync.existsSync(authPath)) fsSync.unlinkSync(authPath);
        } catch (error) {
          return sendJson(res, 500, { error: `could not forget OAuth login: ${error.message}` });
        }
        events.emit("mcp", { op: "oauth-forgotten", name });
        return sendJson(res, 200, { ok: true, disconnected: true, authenticated: false });
      }
      if (method === "POST" && pathname.match(/^\/mcp\/disconnect\/[^/]+$/)) {
        const name = decodeURIComponent(pathname.split("/")[3]);
        await runtime.mcp.disconnect(name);
        events.emit("mcp", { op: "disconnect", name });
        return sendJson(res, 200, { ok: true });
      }
      if (method === "POST" && pathname === "/mcp/connect-all") {
        const results = await runtime.mcp.connectAll();
        events.emit("mcp", { op: "connect-all", results });
        return sendJson(res, 200, results);
      }
      if (method === "POST" && pathname === "/mcp/call") {
        const body = await readJson(req);
        try {
          const result = await runtime.mcp.callTool(body.server, body.tool, body.args ?? {});
          return sendJson(res, 200, result);
        } catch (error) {
          return sendJson(res, 400, { error: error.message });
        }
      }
      if (method === "POST" && pathname === "/mcp/register") {
        const body = await readJson(req);
        // SEC-5: registering an MCP server spawns a process or hands a remote
        // host a live channel into this agent, which is why the agent-facing
        // register_mcp_server tool is `needsConfirmation: true`. This route
        // used to register straight away, so the one path a prompt-injected
        // page or an unauthenticated caller could reach was also the one path
        // with no human in the loop. Same queue, same approval card, same
        // executor as the tool.
        if (!runtime.pendingActions || !runtime.tools?.invoke) {
          return sendJson(res, 503, {
            error: "approval queue unavailable — refusing to register an MCP server unattended"
          });
        }
        // Fail closed BEFORE queueing: never ask a human to approve a spec the
        // registry would reject anyway (an approval prompt is a bad place to
        // learn your argv is malformed, and it trains people to click through).
        const inferredTransport = body?.transport ?? (body?.url ? "http" : body?.command ? "stdio" : null);
        if (inferredTransport === "stdio") {
          try {
            assertSafeStdioSpec(body);
          } catch (error) {
            return sendJson(res, 400, { error: error.message });
          }
        }
        const action = runtime.pendingActions.enqueue({
          toolName: "register_mcp_server",
          args: body,
          context: { source: "http", route: "/mcp/register" },
          summary: summarizeRegisterMcpServer(body ?? {}),
          reason: "MCP registration requested over HTTP"
        });
        // register_mcp_server's handler forwards a fixed subset of the spec, so
        // say plainly which keys will not survive approval rather than dropping
        // them silently (clientSecret/env/headers/cwd today — they have to be
        // set in mcp.json/.env until the tool's schema carries them).
        const CARRIED = new Set(["name", "transport", "command", "args", "url", "auth", "apiKey", "clientId", "scope", "trustLevel"]);
        const dropped = Object.keys(body ?? {}).filter((k) => !CARRIED.has(k));
        return sendJson(res, 202, {
          status: "awaiting_confirmation",
          actionId: action.id,
          summary: action.summary,
          droppedFields: dropped,
          message: "Queued for approval — approve it in the dashboard's Approvals card, or POST /pending-actions/<id>/approve."
        });
      }

      if (method === "POST" && pathname === "/tick") {
        const body = await readJson(req);
        const results = await runtime.tick(body.now ? new Date(body.now) : new Date());
        return sendJson(res, 200, { results });
      }

      return sendJson(res, 404, { error: "not-found" });
    } catch (error) {
      if (error?.openagiSessionId) {
        logAgentFailure(error, {
          sessionId: error.openagiSessionId,
          requestId: error.openagiRequestId ?? null
        });
        return sendJson(res, 500, messageFailure(error, error.openagiSessionId));
      }
      // Log so we can diagnose 500s instead of swallowing them.
      const logLine = `[${new Date().toISOString()}] 500 ${req.method} ${req.url} — ${error.message}\n${error.stack ?? ""}\n`;
      try { process.stderr.write(logLine); } catch { /* ignore */ }
      return sendJson(res, 500, { error: error.message, route: req.url });
    }
  });

  const app = {
    runtime,
    channels,
    events,
    server,
    // Test seam: inject a fake agent host so /outreach/:id/reply and the
    // /channels/* routes can be exercised without a real model. The route
    // handlers close over the `channels` variable, so reassigning it here
    // takes effect immediately.
    __setChannels(c) { channels = c; },
    get __heartbeatHandle() { return heartbeatHandle ?? undefined; },
    listen() {
      return new Promise((resolve) => {
        server.listen(port, host, () => {
          channels?.start();
          if (tickerMs > 0) {
            tickerHandle = setInterval(() => {
              runtime.tick().catch(() => { /* swallow */ });
              try {
                runtime.outcomes?.resolveSweep({ agentStore: runtime.agentHost?.store ?? null });
              } catch { /* swallow */ }
            }, tickerMs);
          }
          const pairing = readNodeConfig(dataDir);
          if (pairing?.remote) {
            const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 30_000;
            const heartbeatBuild = resolveBuildInfo({ packageVersion: PACKAGE_VERSION });
            let heartbeatFailStreak = 0;
            const sendHeartbeat = async () => {
              try {
                const identity = readOrCreateIdentity(dataDir);
                const scopedToken = await ensureScopedNodeToken(pairing, identity);
                const ctrl = new AbortController();
                const timer = setTimeout(() => ctrl.abort(), 5000);
                try {
                  const res = await (options.nodeControlFetch ?? globalThis.fetch)(`${pairing.remote}/nodes/heartbeat`, {
                    method: "POST",
                    headers: {
                      "content-type": "application/json",
                      "x-openagi-node-id": identity.nodeId,
                      ...(scopedToken ? { authorization: `Bearer ${scopedToken}` } : {})
                    },
                    body: JSON.stringify({
                      nodeId: identity.nodeId, name: identity.name, role: "node",
                      url: options.publicUrl ?? process.env.OPENAGI_PUBLIC_URL ?? null,
                      // Report the resolved build identity, not just
                      // package.json — the main's roster can only tell the
                      // user which machines are behind if the nodes say what
                      // they are actually running.
                      version: heartbeatBuild.version ?? PACKAGE_VERSION,
                      build: heartbeatBuild.build,
                      buildSource: heartbeatBuild.buildSource,
                      capabilities: await localNodeCapabilities().catch(() => [])
                    }),
                    redirect: "manual",
                    signal: ctrl.signal
                  });
                  if (!res.ok) throw new Error(`heartbeat rejected: ${res.status}`);
                } finally { clearTimeout(timer); }
                if (heartbeatFailStreak > 0) {
                  console.warn("[openagi] heartbeat to main recovered");
                }
                heartbeatFailStreak = 0;
                ensureNodeControlWorker();
              } catch (error) {
                heartbeatFailStreak += 1;
                if (heartbeatFailStreak === 1) {
                  console.warn(`[openagi] heartbeat to main failing (${error.message}) - will keep retrying`);
                }
              }
            };
            // Check in as soon as the listener is ready. Waiting one full
            // interval made a freshly-started node invisible for 30 seconds
            // (or longer when a custom interval was configured).
            sendHeartbeat().catch(() => {});
            heartbeatHandle = setInterval(() => { sendHeartbeat().catch(() => {}); }, heartbeatIntervalMs);
            ensureNodeControlWorker();
          }
          const address = server.address();
          const actualPort = typeof address === "object" && address ? address.port : port;
          resolve({ host, port: actualPort, url: `http://${host}:${actualPort}` });
        });
      });
    },
    close() {
      return new Promise((resolve, reject) => {
        if (tickerHandle) clearInterval(tickerHandle);
        if (heartbeatHandle) clearInterval(heartbeatHandle);
        for (const client of sseClients) try { client.end(); } catch { /* ignore */ }
        sseClients.clear();
        channels?.stop?.();
        runtime.tunnelWatcher?.stop?.();
        runtime.mcp?.disconnectAll?.().catch(() => {});
        Promise.resolve(computerExecutor?.close?.())
          .catch(() => {})
          .then(() => stopNodeControlWorker())
          .catch(() => {})
          .finally(() => {
            nodeControlBroker.close();
            server.close((error) => (error ? reject(error) : resolve()));
          });
      });
    }
  };

  return app;
}

function handleSse(req, res, clients) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive"
  });
  res.write(`event: hello\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);
  clients.add(res);
  const heartbeat = setInterval(() => {
    try { res.write(": ping\n\n"); } catch { /* dropped */ }
  }, 15000);
  req.on("close", () => {
    clearInterval(heartbeat);
    clients.delete(res);
  });
}

function acceptsEventStream(req) {
  return String(req.headers.accept ?? "")
    .split(",")
    .some((part) => part.trim().toLowerCase().split(";")[0] === "text/event-stream");
}

// Stream lifecycle for POST /message + Accept: text/event-stream:
//   status    { stage, at, ...safe progress fields }
//   session   { id, messageCount, agent } once the user turn is persisted
//   heartbeat { at, stage, sessionId } every 15s while work is outstanding
//   delta     { text, reset, at, provider, model, hop, sessionId, requestId }
//             visible assistant text only; reset replaces an earlier tool hop
//   final     the exact object returned by the legacy JSON endpoint
//   failure   { code, error, sessionId } for a terminal provider/agent error
//
// Delta frames are private to this direct authenticated response. They are not
// broadcast on /events or persisted as partial messages; the final durable
// assistant record remains authoritative and a disconnected client recovers it
// from the named session. Provider adapters expose text only, never reasoning,
// tool arguments or tool results.
async function streamLocalMessage(res, channels, body) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no"
  });
  res.flushHeaders?.();

  let connected = true;
  let stage = "queued";
  let sessionId = boundedProgressText(body?.sessionId, 500) || null;
  const requestId = boundedProgressText(body?.metadata?.requestId, 200) || null;
  const write = (event, data) => {
    if (!connected || res.destroyed || res.writableEnded) return false;
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      return true;
    } catch {
      connected = false;
      return false;
    }
  };

  write("status", { stage, at: new Date().toISOString(), ...(sessionId ? { sessionId } : {}), ...(requestId ? { requestId } : {}) });
  const heartbeat = setInterval(() => {
    write("heartbeat", { at: new Date().toISOString(), stage, sessionId, ...(requestId ? { requestId } : {}) });
  }, 15_000);
  res.on("close", () => {
    connected = false;
    clearInterval(heartbeat);
  });

  const onProgress = (raw) => {
    const progress = normalizeMessageProgress(raw);
    stage = progress.stage;
    if (progress.session?.id) {
      sessionId = progress.session.id;
      write("session", {
        id: progress.session.id,
        messageCount: progress.session.messageCount,
        agent: progress.agent ?? null,
        ...(requestId ? { requestId } : {})
      });
    } else if (progress.sessionId) {
      sessionId = progress.sessionId;
    }
    write("status", { ...progress, ...(requestId ? { requestId } : {}) });
  };

  const onTextDelta = (raw) => {
    const delta = normalizeMessageTextDelta(raw);
    if (!delta) return;
    if (delta.sessionId) sessionId = delta.sessionId;
    write("delta", {
      ...delta,
      ...(sessionId && !delta.sessionId ? { sessionId } : {}),
      ...(requestId ? { requestId } : {})
    });
  };

  try {
    const result = await channels.handleLocalMessage(body, { onProgress, onTextDelta });
    sessionId = boundedProgressText(result?.session?.id, 500) || sessionId;
    write("final", result);
  } catch (error) {
    write("failure", { ...messageFailure(error, error?.openagiSessionId ?? sessionId), ...(requestId ? { requestId } : {}) });
  } finally {
    clearInterval(heartbeat);
    if (connected && !res.writableEnded) res.end();
  }
}

function normalizeMessageTextDelta(raw) {
  if (typeof raw?.text !== "string" || raw.text.length === 0) return null;
  const delta = {
    // Do not trim: leading/trailing spaces are real model output tokens.
    text: raw.text.slice(0, 64_000),
    reset: raw.reset === true,
    at: boundedProgressText(raw?.at, 50) || new Date().toISOString()
  };
  for (const key of ["provider", "model"]) {
    const value = boundedProgressText(raw?.[key], 300);
    if (value) delta[key] = value;
  }
  const deltaSessionId = boundedProgressText(raw?.sessionId, 500);
  if (deltaSessionId) delta.sessionId = deltaSessionId;
  if (Number.isFinite(raw?.hop)) delta.hop = raw.hop;
  return delta;
}

function normalizeMessageProgress(raw) {
  const stage = boundedProgressText(raw?.stage, 40) || "thinking";
  const progress = {
    stage,
    at: boundedProgressText(raw?.at, 50) || new Date().toISOString()
  };
  const sessionId = boundedProgressText(raw?.sessionId, 500);
  if (sessionId) progress.sessionId = sessionId;
  const sessionRecordId = boundedProgressText(raw?.session?.id, 500);
  if (sessionRecordId) {
    progress.session = {
      id: sessionRecordId,
      messageCount: Number.isFinite(raw?.session?.messageCount) ? raw.session.messageCount : null
    };
  }
  const agentId = boundedProgressText(raw?.agent?.id, 300);
  if (agentId) {
    progress.agent = {
      id: agentId,
      name: boundedProgressText(raw?.agent?.name, 300) || agentId,
      role: boundedProgressText(raw?.agent?.role, 100) || null
    };
  }
  for (const key of ["provider", "model", "tool"]) {
    const value = boundedProgressText(raw?.[key], 300);
    if (value) progress[key] = value;
  }
  if (Number.isFinite(raw?.hop)) progress.hop = raw.hop;
  if (Number.isFinite(raw?.maxToolHops)) progress.maxToolHops = raw.maxToolHops;
  const code = boundedProgressText(raw?.code, 100);
  if (code) progress.code = code;
  return progress;
}

function boundedProgressText(value, max) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function messageFailure(error, sessionId = null) {
  return publicAgentFailure(error, sessionId);
}

// SEC-4: every HTML response this daemon serves gets a per-response nonce and
// a CSP built around it.
//
// Why nonce and not 'unsafe-inline': the payloads that reach this page arrive
// through prompt injection (OCR'd screen text, iMessage bodies, fetched pages)
// and land in the DOM via innerHTML. innerHTML never runs a <script> tag, so
// the vector is an event-handler ATTRIBUTE — onmouseover=, onerror=. A
// nonce-based script-src blocks inline handlers; 'unsafe-inline' explicitly
// permits them, which would make the header decorative.
//
// style-src deliberately keeps 'unsafe-inline'. The dashboard is built out of
// hundreds of style="" attributes plus one inline <style> block, and a nonce
// cannot cover an attribute — a nonce in style-src would silently disable
// 'unsafe-inline' and render the whole UI unstyled. Inline CSS cannot execute
// script in any browser this ships to; the escaping fixes are what stop the
// style="position:fixed;inset:0" overlay trick.
//
// The nonce is stamped onto the templates' own <script> tags here rather than
// in each template, so renderApp, renderLoginPage and the setup wizard are all
// covered without three copies of the same knowledge. Only our own HTML ever
// reaches this function.
const CSP_DIRECTIVES = [
  "default-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "object-src 'none'"
];

function sendHtml(res, status, value, cookies = []) {
  const nonce = randomBytes(18).toString("base64");
  const html = String(value).replace(/<script(?=[\s>])/gi, `<script nonce="${nonce}"`);
  const headers = {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(html),
    "content-security-policy": [`script-src 'nonce-${nonce}'`, ...CSP_DIRECTIVES].join("; "),
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer"
  };
  if (cookies.length) headers["Set-Cookie"] = cookies;
  res.writeHead(status, headers);
  res.end(html);
}

function renderLoginPage(reason, next = "/") {
  // Sanitise the redirect target so an attacker can't bounce the user
  // off-site after sign-in.
  const safeNext = typeof next === "string" && next.startsWith("/") && !next.startsWith("//") ? next : "/";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>OpenAGI · auth</title>
<style>body{font:14px/1.5 ui-sans-serif,system-ui;background:#0e1411;color:#e8efea;display:grid;place-items:center;min-height:100vh;margin:0}
form{background:#161d19;border:1px solid #2a352f;border-radius:10px;padding:24px;width:min(420px,90vw)}
h1{margin:0 0 4px;font-size:18px}p{color:#8da59a;margin:6px 0 16px;font-size:13px}
input{width:100%;padding:9px 12px;background:#0e1411;color:#e8efea;border:1px solid #2a352f;border-radius:6px;font:inherit;margin-bottom:10px}
button{background:#6fe1b1;color:#002219;border:0;padding:9px 14px;border-radius:6px;font-weight:700;cursor:pointer;width:100%}
.err{color:#f08080;margin-bottom:10px;font-size:12px}
.hint{color:#8da59a;font-size:12px;margin-top:14px}
.hint code{background:#0e1411;padding:2px 5px;border-radius:3px;border:1px solid #2a352f}</style></head>
<body><form method="POST" action="/sign-in" id="loginForm" enctype="application/x-www-form-urlencoded">
<h1>OpenAGI</h1><p>This daemon requires authentication.</p>
${reason ? `<div class="err">${escapeHtmlForLogin(reason)}</div>` : ""}
<input name="token" placeholder="Bearer token" autofocus required spellcheck="false" autocapitalize="off">
<input type="hidden" name="next" value="${escapeHtmlForLogin(safeNext)}">
<button type="submit">Sign in</button>
<div class="hint">Find your token in your data dir's <code>.env</code> as <code>OPENAGI_AUTH_TOKEN</code>.<br>If you're running the macOS app, click the menubar icon → <strong>Copy auth token</strong>.</div>
</form>
</body></html>`;
}

// SEC-4: single quotes too — this value lands in an attribute, and an
// attribute is just as happy to be delimited by ' as by ".
function escapeHtmlForLogin(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]);
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value, null, 2);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

// Task statuses a "stop asking" may retire FROM. Mirrors the allowlist in
// daily-brief.js, and the reason both exist is the "completed" case: flipping a
// completed task to cancelled would erase a real outcome the user earned in
// order to silence a row, so the composer never offers the button and the route
// refuses it even if something else asks.
const RETIRABLE_TASK_STATUSES = new Set(["pending", "in_progress", "blocked"]);

/// Retire the task that generates a draft, so it can never draft again.
///
/// HOW, and why this shape. task-store has no cancel()/retire() of its own —
/// verified by reading it — so this composes the primitives it does have:
/// status "cancelled" (a STATUSES member, and the one state agentPickNext's
/// `status === "pending"` filter and sweepStuckTasks' terminal check both
/// exclude, so a cancelled task is unreachable by every path that could
/// re-draft it) plus a sourceMeta stamp, which is where that store already
/// keeps agentLease / agentStall / agentReconcile / awaitingReview.
///
/// That choice is what buys the two properties this has to have:
///   - AUDIT TRAIL. update() appends the whole patch to tasks/<queue>.jsonl and
///     re-snapshots, so who/why/when/from-what lands in the same append-only
///     log as every other status change on that task — nothing bespoke to go
///     looking for later. An outcome is recorded alongside it (kind
///     "task-retired", low quality score) because "the agent made work I did
///     not want" is exactly the signal the outcome store exists to hold, and
///     complete() records the positive half the same way.
///   - REVERSIBLE. Nothing is deleted: the task keeps its id, title, body,
///     history and queue, and POST /tasks/:id/unretire puts it straight back
///     into the queue. `retired` is what makes the state legible to that route.
///
/// Never throws: the draft half of "stop asking" has already happened by the
/// time this runs, so a failure here is reported, not raised.
function retireGeneratingTask(runtime, taskId, { draftId = null, by = "user", reason = "stop-asking" } = {}) {
  if (!taskId) return { retired: null, retireSkipped: "no-generating-task" };
  if (typeof runtime.tasks?.get !== "function" || typeof runtime.tasks?.update !== "function") {
    return { retired: null, retireSkipped: "no-task-store" };
  }
  let task;
  try { task = runtime.tasks.get(taskId); } catch (error) { return { retired: null, retireError: error.message }; }
  if (!task) return { retired: null, retireSkipped: "task-not-found" };
  // Already cancelled counts as retired: the user's goal is the END STATE, and
  // reporting "couldn't stop it" about a task that is already stopped would be
  // false in the direction that matters.
  if (task.status === "cancelled") return { retired: task, retireSkipped: "already-retired" };
  if (!RETIRABLE_TASK_STATUSES.has(task.status ?? "pending")) {
    return { retired: null, retireSkipped: `not-retirable:${task.status}` };
  }
  const meta = { ...(task.sourceMeta ?? {}) };
  // The claim and the review are both over. Leaving these behind would keep the
  // task advertising a lease nobody holds and a review nobody owes.
  delete meta.agentLease;
  delete meta.awaitingReview;
  meta.retired = {
    at: new Date().toISOString(),
    by,
    reason,
    draftId,
    // What to put it back to, and what it looked like when it was stopped.
    fromStatus: task.status ?? null,
    fromBucket: task.bucket ?? null
  };
  let retired;
  try {
    retired = runtime.tasks.update(taskId, { status: "cancelled", sourceMeta: meta });
  } catch (error) {
    return { retired: null, retireError: error.message };
  }
  if (!retired) return { retired: null, retireSkipped: "task-not-found" };
  recordRetirementOutcome(runtime, retired, { draftId, by, reason });
  return { retired };
}

/// The learning half of the audit trail. Best-effort by construction: the
/// retirement is already committed to the task log when this runs, and a broken
/// outcome store must not turn a decision the user made into an error they see.
function recordRetirementOutcome(runtime, task, { draftId, by, reason }) {
  if (!runtime.outcomes?.record) return;
  try {
    const outcome = runtime.outcomes.record({
      kind: "task-retired",
      refId: task.id,
      metadata: {
        task: task.id,
        title: task.title,
        draftId,
        by,
        reason,
        // Lineage back to the proactive suggestion that materialized this task,
        // the same field complete() reports on — so "this proposal led to N
        // completed tasks" can finally be read against "…and N the user shut off".
        sourceSuggestionId: task.sourceMeta?.suggestionId ?? null
      }
    });
    // The lowest score any completed path assigns is 0.7 (auto-completed from
    // observed activity). "The user told this task to stop" is the opposite
    // signal and has to score below everything the positive path can produce.
    runtime.outcomes.resolve?.(outcome.id, 0.05, "task-retired");
  } catch { /* audit is a side effect; it never undoes the user's decision */ }
}

// Map an outreach action to the real action on the underlying source. Throws
// on a failed delegation so the route can mark the item status:"error".
async function applyOutreachAction(runtime, item, action, note) {
  if (action === "dismiss") return;
  if (action === "up" || action === "down") return applyOutreachFeedback(runtime, item, action, note);
  const ref = item.sourceRef ?? {};
  switch (ref.kind) {
    case "draft":
      if (action === "approve") { if (!runtime.drafts?.approve(ref.id)) throw new Error("draft not approvable"); return; }
      if (action === "edit") return;
      throw new Error(`unsupported draft action: ${action}`);
    case "task":
      // TaskStore has no dedicated cancel(); update(id,{status:"cancelled"})
      // is the canonical cancel path (returns the task, or null if unknown).
      if (action === "close") { if (!runtime.tasks?.update(ref.id, { status: "cancelled" })) throw new Error("task not cancellable"); return; }
      if (action === "keep" || action === "snooze") return;
      throw new Error(`unsupported task action: ${action}`);
    case "pending-action":
      if (action === "do") {
        let a = runtime.pendingActions?.get(ref.id);
        if (!a) throw new Error("pending action gone");
        if (a.status !== "pending") {
          throw outreachActionConflict(`pending action already ${a.status}`);
        }
        const claim = runtime.pendingActions?.claimForExecution?.(ref.id, { claimedBy: "user" });
        if (!claim) {
          const latest = runtime.pendingActions?.get(ref.id);
          throw outreachActionConflict(`pending action already ${latest?.status ?? "claimed"}`);
        }
        a = claim.action;
        const r = await runtime.tools.invoke(a.toolName, a.args, {
          ...a.context,
          __confirmed: true,
          __confirmationActionId: a.id
        });
        const executionError = r?.ok ? null : r?.error ?? "approved tool execution failed";
        recordApprovedActionOutcome(runtime, a, r);
        runtime.pendingActions.decide(ref.id, {
          decision: "approve",
          decidedBy: "user",
          result: r.ok ? r.result : null,
          error: executionError,
          executionId: claim.executionId
        });
        if (!r.ok) throw new Error(executionError);
        return { pendingAction: a, invokeResult: r };
      }
      throw new Error(`unsupported pending-action action: ${action}`);
    case "suggestion":
      if (action === "accept") return;
      throw new Error(`unsupported suggestion action: ${action}`);
    case "clarification":
      if (!runtime.clarifications?.answer) throw new Error("no clarification store");
      if (!runtime.clarifications.answer(ref.id, action)) throw new Error("clarification not answerable");
      return;
    case "skill-candidate": {
      if (action !== "accept") throw new Error(`unsupported skill-candidate action: ${action}`);
      const { findSuggestion, resolveSuggestion } = await import("./suggestion-feed.js");
      const candidate = findSuggestion(runtime, ref.id);
      if (!candidate) throw new Error("skill candidate gone");
      if (candidate.status === "accepted") return;
      const { createSkillFromCandidate } = await import("./skill-materialize.js");
      createSkillFromCandidate({ runtime, candidate });
      resolveSuggestion(runtime, ref.id, "accepted");
      runtime.skills?.reload?.();
      runtime.events?.emit?.("suggestion-resolved", { id: ref.id, status: "accepted", category: "skill" });
      return;
    }
    default:
      // No handler for this item kind — do NOT silently succeed. A silent
      // return here is indistinguishable from a real successful action in
      // the outreach history (the caller marks the item "acted" either way).
      throw new Error(`no handler for outreach item kind "${ref.kind}" with action "${action}"`);
  }
}

function outreachActionConflict(message) {
  const error = new Error(message);
  error.code = "OUTREACH_ACTION_CONFLICT";
  return error;
}

// Approval is only intent. Record an outcome at the point the confirmed tool
// actually returns, preserving the original autonomous/user provenance. This
// keeps queued approvals out of the scorecard while making the eventual work
// (including a real failure) measurable once—and only once—it executes.
function recordApprovedActionOutcome(runtime, action, invokeResult) {
  if (!runtime.outcomes?.record || !approvedInvocationWasAttempted(invokeResult)) return null;
  const origin = String(action?.context?.origin ?? action?.context?.channel ?? "local").toLowerCase();
  const kind = origin === "autopilot"
    ? "autopilot-fire"
    : origin === "cron"
      ? "cron-fire"
      : "tool-call";
  try {
    return runtime.outcomes.record({
      kind,
      refId: action.id,
      sessionId: action.context?.sessionId ?? null,
      agentId: action.context?.agentId ?? "main",
      channel: action.context?.channel ?? null,
      toolCalls: [{ name: action.toolName, ok: invokeResult?.ok === true }],
      metadata: {
        approvalActionId: action.id,
        approvedExecution: true,
        origin
      }
    });
  } catch {
    // Outcome accounting is an audit side effect. It must never undo a tool
    // action the user explicitly approved.
    return null;
  }
}

function approvedInvocationWasAttempted(invokeResult) {
  if (!invokeResult || typeof invokeResult !== "object") return false;
  if (invokeResult.ok !== true) return true;
  const result = invokeResult.result;
  const status = typeof result?.status === "string" ? result.status.toLowerCase() : null;
  if (["awaiting_confirmation", "skipped", "no-op", "noop"].includes(status)) return false;
  return !(result?.skipped === true || result?.noop === true || result?.noOp === true || result?.alreadyActive === true);
}

async function applyOutreachFeedback(runtime, item, verdict, note = null) {
  const score = verdict === "up" ? 0.9 : 0.15;
  const resolutionNote = note ?? `outreach thumbs-${verdict} on "${item.title}"`;
  let resolved = null;
  if (item.outcomeId && runtime.outcomes?.resolve) {
    resolved = runtime.outcomes.resolve(item.outcomeId, score, "explicit-rating", resolutionNote);
  }
  if (!resolved && runtime.outcomes?.record) {
    const fresh = runtime.outcomes.record({
      kind: "explicit-feedback",
      refId: item.id,
      metadata: { outreachType: item.type, sourceRef: item.sourceRef ?? null, verdict }
    });
    resolved = runtime.outcomes.resolve(fresh.id, score, "explicit-rating", resolutionNote);
  }
  if (item.sourceRef?.kind === "suggestion" && runtime.proactiveObserver?.resolve) {
    runtime.proactiveObserver.resolve(item.sourceRef.id, verdict === "up" ? "accepted" : "rejected", resolutionNote);
  }
  return resolved;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch (error) { reject(error); }
    });
    req.on("error", reject);
  });
}

function readJsonLimited(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    req.on("data", (chunk) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > maxBytes) {
        fail(new Error("request body too large"));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch (error) { reject(error); }
    });
    req.on("error", fail);
  });
}

function readForm(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      const params = new URLSearchParams(text);
      resolve(Object.fromEntries(params.entries()));
    });
    req.on("error", reject);
  });
}

function renderApp() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>OpenAGI</title>
  <style>
    :root {
      color-scheme: light dark;
      /* Legacy tokens — kept so existing inline-styled components don't
         drift visually while we migrate them to the shadcn-vocab layer. */
      --bg: #0e1411;
      --panel: #161d19;
      --panel-2: #1d2722;
      --text: #e8efea;
      --muted: #8da59a;
      --line: #2a352f;
      --accent: #6fe1b1;
      --accent-soft: #14322a;
      --user: #2c4338;
      --assistant: #1d2722;
      --warn: #f0b454;
      --err: #f08080;

      /* shadcn-vocab tokens. We've adopted the same names openclaw uses
         (which mirror shadcn) so future tabs / components have a stable
         palette + spacing scale to lean on. New work should reach for
         these first; legacy components keep using the originals above
         until they're migrated. */
      --background: var(--bg);
      --foreground: var(--text);
      --card: var(--panel);
      --card-foreground: var(--text);
      --popover: #1a221d;
      --popover-foreground: var(--text);
      --primary: var(--accent);
      --primary-foreground: #002219;
      --secondary: var(--panel-2);
      --secondary-foreground: var(--text);
      --muted-bg: var(--panel-2);
      --muted-foreground: var(--muted);
      --accent-bg: var(--accent-soft);
      --accent-foreground: var(--accent);
      --destructive: #b3463a;
      --destructive-foreground: #ffd9d4;
      --border: var(--line);
      --input: var(--panel-2);
      --ring: rgba(111, 225, 177, 0.45);

      /* Spacing scale (4px grid) and radius / typography — used by
         the primitive classes below. */
      --space-1: 4px;
      --space-2: 8px;
      --space-3: 12px;
      --space-4: 16px;
      --space-5: 24px;
      --space-6: 32px;
      --radius-sm: 4px;
      --radius: 8px;
      --radius-lg: 12px;
      --font-size-xs: 11px;
      --font-size-sm: 12px;
      --font-size-base: 14px;
      --font-size-lg: 16px;
      --shadow-sm: 0 1px 2px rgba(0,0,0,.25);
      --shadow: 0 4px 12px rgba(0,0,0,.30);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
      height: 100vh;
      overflow: hidden;
    }
    .app { display: grid; grid-template-rows: 48px 1fr; height: 100vh; }
    header {
      display: flex; align-items: center; gap: 16px;
      padding: 0 16px;
      background: var(--panel);
      border-bottom: 1px solid var(--line);
    }
    header h1 { font-size: 14px; font-weight: 700; margin: 0; letter-spacing: 0.02em; }
    header .status { color: var(--muted); font-size: 12px; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; min-width: 0; }
    header .status .status-pill { white-space: nowrap; padding: 2px 8px; border-radius: 10px; background: var(--bg); border: 1px solid var(--line); }
    nav { display: flex; gap: 4px; margin-left: auto; align-items: center; }
    nav button {
      background: transparent; border: 1px solid transparent; color: var(--muted);
      padding: 6px 10px; border-radius: 6px; cursor: pointer; font-size: 13px;
      font-family: inherit;
    }
    nav button.active { color: var(--text); background: var(--panel-2); border-color: var(--line); }
    nav button:hover { color: var(--text); }

    /* "More ▾" dropdown — clusters the 11 secondary tabs (build +
       diagnostics) so the primary nav stays under control. Hides
       behind a click; outside-click closes. */
    .nav-more { position: relative; }
    .nav-more-btn {
      background: transparent; border: 1px solid transparent; color: var(--muted);
      padding: 6px 10px; border-radius: 6px; cursor: pointer; font-size: 13px;
      font-family: inherit;
    }
    .nav-more-btn:hover, .nav-more.open .nav-more-btn { color: var(--text); background: var(--panel-2); border-color: var(--line); }
    .nav-more-panel {
      position: absolute; right: 0; top: calc(100% + 6px); z-index: 50;
      background: var(--popover); color: var(--popover-foreground);
      border: 1px solid var(--border); border-radius: var(--radius);
      box-shadow: var(--shadow);
      padding: var(--space-2); min-width: 220px;
      display: flex; flex-direction: column; gap: var(--space-3);
    }
    .nav-more-panel[hidden] { display: none; }
    .nav-more-section { display: flex; flex-direction: column; gap: 2px; }
    .nav-more-label {
      font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em;
      color: var(--muted-foreground); padding: 4px 8px 2px;
    }
    .nav-more-panel button {
      text-align: left; padding: 6px 10px; border-radius: var(--radius-sm);
      color: var(--text); background: transparent; border: 1px solid transparent;
      width: 100%; font-size: 13px; cursor: pointer; font-family: inherit;
    }
    .nav-more-panel button:hover { background: var(--muted-bg); }
    .nav-more-panel button.active { background: var(--accent-bg); color: var(--accent-foreground); }

    .body { display: grid; grid-template-columns: 280px 1fr; min-height: 0; }
    .body.no-sidebar { grid-template-columns: 1fr; }
    .sidebar {
      background: var(--panel);
      border-right: 1px solid var(--line);
      display: flex; flex-direction: column; min-height: 0;
    }
    .sidebar header.sub { height: 40px; padding: 0 12px; border-bottom: 1px solid var(--line); display: flex; align-items: center; justify-content: space-between; }
    .sidebar h2 { margin: 0; font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); }
    .sidebar .add { background: var(--accent-soft); color: var(--accent); border: 1px solid var(--line); border-radius: 4px; padding: 2px 8px; font-size: 12px; cursor: pointer; }
    .sidebar ul { list-style: none; margin: 0; padding: 4px; overflow: auto; flex: 1; }
    .sidebar li {
      padding: 8px 10px; border-radius: 6px; cursor: pointer; margin-bottom: 2px;
      display: flex; flex-direction: column; gap: 2px;
    }
    .sidebar li:hover { background: var(--panel-2); }
    .sidebar li.active { background: var(--panel-2); border: 1px solid var(--line); }
    .sidebar li .title { color: var(--text); font-weight: 600; font-size: 13px; }
    .sidebar li .preview { color: var(--muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    .main { display: flex; flex-direction: column; min-height: 0; }
    .thread { flex: 1; overflow: auto; padding: 16px 20px; display: flex; flex-direction: column; gap: 12px; }
    .msg { max-width: 720px; padding: 10px 12px; border-radius: 10px; line-height: 1.5; word-wrap: break-word; }
    .msg.user { background: var(--user); align-self: flex-end; white-space: pre-wrap; }
    .msg.assistant { background: var(--assistant); border: 1px solid var(--line); align-self: flex-start; }
    .msg.runtime { max-width: 680px; align-self: center; background: var(--accent-bg); border: 1px solid var(--accent); color: var(--text); }
    .msg .meta { color: var(--muted); font-size: 11px; margin-bottom: 4px; }
    .msg .body { display: block; }
    .msg .body p { margin: 0 0 8px; }
    .msg .body p:last-child { margin-bottom: 0; }
    .msg .body h2, .msg .body h3, .msg .body h4, .msg .body h5, .msg .body h6 { margin: 12px 0 6px; line-height: 1.25; }
    .msg .body h2 { font-size: 18px; }
    .msg .body h3 { font-size: 16px; }
    .msg .body h4 { font-size: 14px; color: var(--accent); }
    .msg .body h5, .msg .body h6 { font-size: 13px; color: var(--accent); }
    .msg .body ul, .msg .body ol { margin: 6px 0 8px; padding-left: 22px; }
    .msg .body li { margin: 2px 0; }
    .msg .body blockquote { margin: 6px 0; padding: 4px 12px; border-left: 3px solid var(--accent); color: var(--muted); }
    .msg .body blockquote p { margin: 0; }
    .msg .body a { color: var(--accent); }
    .msg .body code.md-inline { background: var(--bg); padding: 1px 5px; border-radius: 3px; font: 12px ui-monospace, Menlo, monospace; border: 1px solid var(--line); }
    .msg .body pre.md-code { margin: 8px 0; padding: 10px 12px; background: var(--bg); border: 1px solid var(--line); border-radius: 6px; overflow-x: auto; }
    .msg .body pre.md-code code { font: 12px/1.5 ui-monospace, Menlo, monospace; }
    .msg .body strong { font-weight: 700; }
    .msg .body .md-table-wrap { max-width: 100%; margin: 8px 0 12px; overflow-x: auto; border: 1px solid var(--line); border-radius: 6px; }
    .msg .body table.md-table { width: 100%; border-collapse: collapse; font-size: 13px; line-height: 1.4; }
    .msg .body table.md-table th, .msg .body table.md-table td { padding: 7px 9px; border-right: 1px solid var(--line); border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }
    .msg .body table.md-table th:last-child, .msg .body table.md-table td:last-child { border-right: 0; }
    .msg .body table.md-table tbody tr:last-child td { border-bottom: 0; }
    .msg .body table.md-table th { background: var(--panel-2); font-weight: 700; white-space: nowrap; }
    .msg .body table.md-table tbody tr:nth-child(even) { background: rgba(255,255,255,0.025); }
    .msg .body table.md-table .md-align-center { text-align: center; }
    .msg .body table.md-table .md-align-right { text-align: right; }
    .msg .body hr { border: 0; border-top: 1px solid var(--line); margin: 12px 0; }
    .composer { border-top: 1px solid var(--line); padding: 12px 16px; background: var(--panel); display: flex; gap: 8px; align-items: flex-end; }
    .composer textarea {
      flex: 1; min-height: 38px; max-height: 200px; resize: none;
      background: var(--bg); color: var(--text); border: 1px solid var(--line);
      border-radius: 8px; padding: 9px 12px; font: inherit; outline: none;
    }
    .composer textarea:focus { border-color: var(--accent); }
    .composer button {
      background: var(--accent); color: #002219; border: 0;
      padding: 9px 14px; border-radius: 8px; font-weight: 700; cursor: pointer;
    }
    .composer button:disabled { opacity: 0.5; cursor: not-allowed; }

    .pane { flex: 1; overflow: auto; padding: 24px 32px 60px; }
    .pane > * { max-width: 1180px; margin-left: auto; margin-right: auto; }
    .pane h2 { margin: 0 0 14px; font-size: 20px; letter-spacing: -0.01em; }
    .pane h3 { margin: 22px 0 8px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); font-weight: 600; }
    .pane > .row, .pane > .grid { max-width: 1180px; margin-left: auto; margin-right: auto; }
    .pane pre { max-height: 320px; overflow: auto; }
    .grid { display: grid; gap: 10px; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); }
    .grid.two { grid-template-columns: repeat(auto-fill, minmax(360px, 1fr)); }
    .grid.stats { grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 12px; }
    .card { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 14px; }
    .card .name { font-weight: 700; }
    .card .desc { color: var(--muted); font-size: 12px; margin-top: 4px; line-height: 1.5; }
    .card .stat-value { font-size: 22px; font-weight: 700; margin-top: 4px; }
    .muted { color: var(--muted); }

    /* Memory tab */
    .tier-pills { display: flex; gap: 4px; }
    .tier-pills button { background: var(--panel); color: var(--muted); border: 1px solid var(--line); padding: 6px 14px; border-radius: 18px; font: inherit; font-size: 12px; cursor: pointer; }
    .tier-pills button .count { color: var(--muted); margin-left: 6px; font-size: 11px; }
    .tier-pills button:hover { color: var(--text); border-color: #3a4a42; }
    .tier-pills button.active { background: var(--accent-soft); color: var(--accent); border-color: var(--accent); }
    .tier-pills button.active .count { color: var(--accent); }
    .mem-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 12px; max-width: 1180px; margin: 0 auto; }
    .mem-card { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 12px; display: flex; flex-direction: column; gap: 8px; min-height: 140px; }
    .mem-card.tier-short { border-left: 3px solid #6fe1b1; }
    .mem-card.tier-medium { border-left: 3px solid #f0b454; }
    .mem-card.tier-long { border-left: 3px solid #a98ef5; }
    .mem-head { display: flex; gap: 5px; flex-wrap: wrap; align-items: center; }
    .mem-head .badge.tier-short { background: rgba(111,225,177,0.12); color: #6fe1b1; border-color: rgba(111,225,177,0.3); }
    .mem-head .badge.tier-medium { background: rgba(240,180,84,0.12); color: #f0b454; border-color: rgba(240,180,84,0.3); }
    .mem-head .badge.tier-long { background: rgba(169,142,245,0.12); color: #a98ef5; border-color: rgba(169,142,245,0.3); }
    .mem-age { color: var(--muted); font-size: 11px; margin-left: auto; }
    .mem-content { font-size: 13px; line-height: 1.5; max-height: 8.4em; overflow: hidden; position: relative; word-break: break-word; }
    .mem-content::after { content: ""; position: absolute; bottom: 0; left: 0; right: 0; height: 1.6em; background: linear-gradient(transparent, var(--panel)); pointer-events: none; }
    .mem-tags { display: flex; gap: 4px; flex-wrap: wrap; }
    .chip { background: var(--bg); color: var(--muted); padding: 2px 8px; border-radius: 10px; font-size: 11px; border: 1px solid var(--line); white-space: nowrap; }

    /* OAuth banner */
    .warn-banner { border-color: var(--warn); background: rgba(240,180,84,0.08); margin: 12px 0; }
    .btn-primary { background: var(--accent); color: #002219; padding: 8px 14px; border-radius: 6px; font-weight: 700; text-decoration: none; display: inline-block; }
    .btn-primary:hover { opacity: 0.9; }
    .row { display: flex; gap: 8px; align-items: center; }
    .row.between { justify-content: space-between; }
    .row > .grow { flex: 1; }
    .badge { font-size: 11px; padding: 2px 6px; border-radius: 4px; background: var(--panel-2); color: var(--muted); border: 1px solid var(--line); }
    .badge.ok { color: var(--accent); }
    .badge.warn { color: var(--warn); }
    .badge.err { color: var(--err); }
    .badge.mcp { background: rgba(96,165,250,.16); color: #7fb3ff; border-color: rgba(96,165,250,.35); }
    .badge.muted { opacity: .65; }
    pre { margin: 0; white-space: pre-wrap; word-break: break-word; font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--text); }
    input, select, textarea {
      background: var(--bg); color: var(--text); border: 1px solid var(--line);
      border-radius: 6px; padding: 6px 10px; font: inherit; outline: none;
    }
    input:focus, textarea:focus, select:focus { border-color: var(--accent); }
    button.secondary { background: var(--panel-2); color: var(--text); border: 1px solid var(--line); padding: 6px 10px; border-radius: 6px; cursor: pointer; }
    button.secondary:hover { border-color: var(--accent); color: var(--accent); }
    .form { display: grid; gap: 8px; }
    .form label { font-size: 12px; color: var(--muted); display: block; margin-bottom: 2px; }
    .ok { color: var(--accent); }
    .err { color: var(--err); }
    .empty { color: var(--muted); padding: 16px; text-align: center; }

    /* ─── Primitive components (shadcn-style, vanilla CSS) ───────────────
       Every new feature should compose these instead of inline styles. */

    .ui-section { margin-top: var(--space-5); }
    .ui-section:first-child { margin-top: 0; }
    .ui-section-header { display: flex; align-items: center; gap: var(--space-2); margin-bottom: var(--space-3); }
    .ui-section-header h3 { margin: 0; font-size: var(--font-size-base); font-weight: 600; }
    .ui-section-header .ui-section-meta { color: var(--muted-foreground); font-weight: 400; font-size: var(--font-size-sm); }

    .ui-card {
      background: var(--card);
      color: var(--card-foreground);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: var(--space-3) var(--space-4);
    }
    .ui-card.ui-card-elev { box-shadow: var(--shadow-sm); }

    .ui-empty {
      color: var(--muted-foreground);
      background: var(--muted-bg);
      border: 1px dashed var(--border);
      border-radius: var(--radius);
      padding: var(--space-4);
      text-align: center;
      font-size: var(--font-size-sm);
    }

    .ui-btn {
      display: inline-flex; align-items: center; gap: var(--space-2); justify-content: center;
      background: var(--primary); color: var(--primary-foreground);
      border: 1px solid transparent; border-radius: var(--radius-sm);
      padding: 6px 12px; font-size: var(--font-size-sm); font-weight: 600;
      cursor: pointer; transition: opacity .12s ease, background .12s ease;
      font-family: inherit;
    }
    .ui-btn:hover:not(:disabled) { opacity: 0.9; }
    .ui-btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .ui-btn:focus-visible { outline: 2px solid var(--ring); outline-offset: 1px; }
    .ui-btn-secondary {
      background: var(--secondary); color: var(--secondary-foreground);
      border: 1px solid var(--border);
    }
    .ui-btn-secondary:hover:not(:disabled) { background: var(--card); }
    .ui-btn-ghost {
      background: transparent; color: var(--foreground);
      border: 1px solid transparent;
    }
    .ui-btn-ghost:hover:not(:disabled) { background: var(--muted-bg); }
    .ui-btn-destructive {
      background: var(--destructive); color: var(--destructive-foreground);
    }
    .ui-btn-sm { padding: 3px 9px; font-size: var(--font-size-xs); }

    .ui-input, .ui-textarea, .ui-select {
      background: var(--input); color: var(--foreground);
      border: 1px solid var(--border); border-radius: var(--radius-sm);
      padding: 6px 10px; font-size: var(--font-size-sm); font-family: inherit;
      width: 100%; outline: none;
    }
    .ui-input:focus, .ui-textarea:focus, .ui-select:focus { border-color: var(--primary); box-shadow: 0 0 0 2px var(--ring); }
    .ui-textarea { resize: vertical; min-height: 36px; line-height: 1.4; }

    .ui-badge {
      display: inline-flex; align-items: center; gap: 3px;
      font-size: var(--font-size-xs); padding: 2px 7px; border-radius: 999px;
      background: var(--muted-bg); color: var(--muted-foreground);
      border: 1px solid var(--border); white-space: nowrap;
    }
    .ui-badge-accent { background: var(--accent-bg); color: var(--accent-foreground); border-color: var(--accent-bg); }
    .ui-badge-warn { color: var(--warn); }
    .ui-badge-err { color: var(--err); border-color: rgba(240,128,128,.3); }

    .ui-divider { border: 0; border-top: 1px solid var(--border); margin: var(--space-4) 0; }

    .ui-row { display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap; }
    .ui-stack { display: flex; flex-direction: column; gap: var(--space-2); }
    .ui-grow { flex: 1; min-width: 0; }
    .ui-muted { color: var(--muted-foreground); }
    .ui-meta { font-size: var(--font-size-xs); color: var(--muted-foreground); }

    .ui-kbd {
      display: inline-block; font-family: ui-monospace, Menlo, monospace;
      font-size: 10px; padding: 1px 5px; border-radius: 3px;
      background: var(--muted-bg); border: 1px solid var(--border); color: var(--muted-foreground);
    }

    /* Toasts stack in the top-right and fade out at the end of their
       lifetime. Replaces the ad-hoc inline-styled toast we used before. */
    .ui-toast-stack {
      position: fixed; top: 20px; right: 20px; z-index: 99;
      display: flex; flex-direction: column; gap: var(--space-2);
      max-width: 360px; pointer-events: none;
    }
    .ui-toast {
      padding: 10px 14px; border-radius: var(--radius); font-size: 13px;
      line-height: 1.4; box-shadow: var(--shadow); pointer-events: auto;
      transition: opacity .35s ease, transform .35s ease;
    }
    .ui-toast-ok { background: #1a3a2a; color: #7be59c; border: 1px solid #2d5b40; }
    .ui-toast-err { background: #3a1a1a; color: #f08a8a; border: 1px solid #5b2d2d; }
    .ui-toast-leaving { opacity: 0; transform: translateX(8px); }

    /* (?) help marker for obscure terms. Hover shows a small tooltip with
       an explanation. Use uiHelp(text) to render. */
    .ui-help {
      display: inline-flex; align-items: center; justify-content: center;
      width: 14px; height: 14px; border-radius: 50%;
      background: var(--muted-bg); border: 1px solid var(--border);
      color: var(--muted-foreground); font-size: 10px; font-weight: 700;
      margin-left: 4px; cursor: help; position: relative; user-select: none;
      vertical-align: middle;
    }
    .ui-help:hover { color: var(--accent-foreground); background: var(--accent-bg); border-color: var(--accent-bg); }
    .ui-help:hover .ui-help-tip { display: block; }
    .ui-help .ui-help-tip {
      display: none; position: absolute; bottom: calc(100% + 6px); left: 50%;
      transform: translateX(-50%); z-index: 100;
      background: var(--popover); color: var(--popover-foreground);
      border: 1px solid var(--border); border-radius: var(--radius);
      padding: 8px 10px; font-size: 12px; font-weight: 400;
      width: max-content; max-width: 280px;
      box-shadow: var(--shadow); cursor: default; line-height: 1.4;
      text-align: left; white-space: normal;
    }

    /* Task list — rows have a clear hover affordance and a settled
       baseline grid (10px vertical pad keeps line-height aligned with
       checkbox baseline). */
    .ui-task-list { list-style: none; padding: 0; margin: 0; border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
    .ui-task-row {
      display: flex; gap: var(--space-3); align-items: flex-start;
      padding: 10px var(--space-3); border-bottom: 1px solid var(--border);
      transition: background .12s ease;
    }
    .ui-task-row:last-child { border-bottom: 0; }
    .ui-task-row:hover { background: var(--muted-bg); }
    .ui-task-check { margin-top: 4px; cursor: pointer; }
    .ui-task-title { font-weight: 500; font-size: var(--font-size-sm); }

    /* Page-chat composer (Tasks/Memory/Suggestions inline send-to-agent) */
    .page-chat .page-chat-input { /* already laid out inline; promote to token-driven */
      background: var(--input); color: var(--foreground);
      border: 1px solid var(--border); border-radius: var(--radius-sm);
    }
    .page-chat .page-chat-input:focus { border-color: var(--primary); box-shadow: 0 0 0 2px var(--ring); outline: none; }
    .page-chat .page-chat-send {
      background: var(--primary); color: var(--primary-foreground);
      border: 0; border-radius: var(--radius-sm); padding: 6px 14px;
      font-weight: 600; font-size: var(--font-size-sm); cursor: pointer;
    }
    .page-chat .page-chat-send:hover:not(:disabled) { opacity: 0.9; }
    .page-chat .page-chat-send:disabled { opacity: 0.5; cursor: not-allowed; }
  </style>
</head>
<body>
<div class="app">
  <header>
    <h1>OpenAGI</h1>
    <span id="status" class="status">connecting…</span>
    <nav id="nav">
      <!-- Primary tabs — the everyday surfaces. Keeps the nav readable
           on narrow windows; the other 11 tabs live behind "More ▾". -->
      <button data-tab="chat" class="active" title="Talk to your agent in natural language.">Chat</button>
      <button data-tab="tasks" title="My tasks + agent tasks. The agent's own queue gets drained every 30 min by the autopilot pulse.">Tasks</button>
      <button data-tab="review" title="Search and work through every open task, draft, clarification, and suggestion behind Quick Ask.">Review</button>
      <button data-tab="approvals" id="approvalsNav" title="Agent actions that require your explicit approval before they run.">Approvals <span id="approvalsNavCount" class="badge" hidden></span></button>
      <button data-tab="suggestions" title="Things the proactive observer noticed + agent actions awaiting your approval.">Suggestions</button>
      <button data-tab="memory" title="Short, medium, and long-term memory. Promotion happens automatically.">Memory</button>
      <button data-tab="integrations" title="Connect MCPs (Linear, GitHub, Stripe, …), sources (BuildBetter, Rize, inbox folder), and channels (Telegram).">Integrations</button>
      <div class="nav-more" id="navMore">
        <button id="navMoreBtn" class="nav-more-btn" type="button" title="Build + diagnostic tabs">More ▾</button>
        <div class="nav-more-panel" id="navMorePanel" hidden>
          <div class="nav-more-section">
            <div class="nav-more-label">Build</div>
            <button data-tab="mcp" title="Register custom MCP servers or manage already-registered ones.">MCP</button>
            <button data-tab="skills" title="Reusable named prompts. Mined from your activity, or hand-authored.">Skills</button>
            <button data-tab="cron" title="Scheduled prompts + the agent's autopilot pulse cron jobs.">Cron</button>
            <button data-tab="channels" title="Telegram / webhook channels the agent can deliver through.">Channels</button>
            <button data-tab="agents" title="Specialists the propagation controller has spawned for repeated tasks.">Agents</button>
            <button data-tab="nodes" title="Which machines are paired, which one is main, and who's online right now.">Nodes</button>
          </div>
          <div class="nav-more-section">
            <div class="nav-more-label">Diagnostics</div>
            <button data-tab="today" title="What you got done today — completed tasks, skills run, actions approved, time tracked, themes.">Today</button>
            <button data-tab="activity" title="Ambient capture log — what you were doing on screen (if capture is enabled).">Activity</button>
            <button data-tab="computer-use" title="Computer use (beta) — every action the agent intended to take, with the reasoning it gave.">Computer Use</button>
            <button data-tab="budget" title="Today's LLM spend + 14-day history.">Credits</button>
            <button data-tab="outcomes" title="Quality scores for completed agent work, 7d + 30d rolling.">Outcomes</button>
            <button data-tab="health" title="Memory saturation, specialist health, MCP status, upcoming cron.">Health</button>
            <button data-tab="scrutiny" title="Directional Adaptive Scrutiny — the 7-axis scorer's calibration + recent verdicts.">Scrutiny</button>
          </div>
        </div>
      </div>
      <button id="setupBtn" title="Re-run the setup wizard or edit credentials">⚙ Setup</button>
    </nav>
  </header>
  <div class="body">
    <aside class="sidebar" id="sidebar">
      <header class="sub">
        <h2 id="sidebarTitle">Sessions</h2>
        <button class="add" id="newSession">+ New</button>
      </header>
      <ul id="sidebarList"></ul>
    </aside>
    <section class="main" id="main"></section>
  </div>
</div>
<script>
const state = {
  tab: "chat",
  sessionId: null,
  activeRequestId: null,
  activeRequestStage: null,
  activeRequestError: null,
  activeRequestMissingSince: null,
  activeRequestText: "",
  activeRequestModel: "",
  freshChatRequested: false,
  sessions: [],
  agentId: "main",
  channel: "local",
  from: "browser",
  messages: [],
  health: null,
  review: {
    q: "",
    kind: "all",
    sort: "oldest",
    items: [],
    nextCursor: null,
    total: 0,
    byKind: {},
    summary: null
  }
};

const $ = (id) => document.getElementById(id);
const main = $("main");
const sidebar = $("sidebar");
const sidebarList = $("sidebarList");
const sidebarTitle = $("sidebarTitle");
const newBtn = $("newSession");

document.querySelectorAll("nav button[data-tab]").forEach((btn) => {
  btn.addEventListener("click", () => {
    switchTab(btn.dataset.tab);
    // Close the More dropdown if the click came from inside it, so the
    // user lands on the new tab with the panel out of the way.
    document.getElementById("navMore")?.classList.remove("open");
    const panel = document.getElementById("navMorePanel");
    if (panel) panel.hidden = true;
  });
});
// More dropdown: toggle on click, close on outside click or Escape.
(function initNavMore() {
  const wrap = document.getElementById("navMore");
  const btn = document.getElementById("navMoreBtn");
  const panel = document.getElementById("navMorePanel");
  if (!wrap || !btn || !panel) return;
  function toggle(open) {
    const next = typeof open === "boolean" ? open : panel.hidden;
    panel.hidden = !next;
    wrap.classList.toggle("open", next);
  }
  btn.addEventListener("click", (e) => { e.stopPropagation(); toggle(); });
  document.addEventListener("click", (e) => {
    if (!wrap.contains(e.target)) toggle(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") toggle(false);
  });
})();
document.getElementById("setupBtn")?.addEventListener("click", () => {
  window.location.href = "/setup";
});

// Small, dependency-free Markdown renderer for chat replies. It is block-aware
// so table syntax and list markers inside fenced code remain literal. Raw HTML
// is always escaped before any known-safe tags are created below.
// No backtick characters in this function's source so it can live inside the
// dashboard's outer template literal without escaping wars.
const BT = String.fromCharCode(96);
const FENCE = BT + BT + BT;
const INLINE_RE = new RegExp(BT + "([^" + BT + "\\\\n]+)" + BT, "g");
const FENCE_OPEN_RE = new RegExp("^ {0,3}" + FENCE + "([A-Za-z0-9_-]+)?\\\\s*$");
const FENCE_CLOSE_RE = new RegExp("^ {0,3}" + FENCE + "\\\\s*$");
const INLINE_TOKEN_OPEN = String.fromCharCode(0xE000);
const INLINE_TOKEN_CLOSE = String.fromCharCode(0xE001);

// Decide whether a markdown link target may become an href, and return the
// attribute-safe value if so. Parse with the URL parser rather than a regex:
// "java\\tscript:alert(1)" and "  javascript:alert(1)" both defeat naive
// prefix checks, and the parser normalizes them before we look at .protocol.
// The input arrives already HTML-escaped (renderMarkdown escapes first), so
// the entities we introduced are decoded before parsing and the parsed href is
// re-escaped on the way out.
function safeLinkHref(rawUrl) {
  const decoded = String(rawUrl)
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
  let parsed;
  try { parsed = new URL(decoded); } catch (e) { return null; }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return escapeHtml(parsed.href);
}

function renderInlineMarkdown(input) {
  let s = String(input ?? "");
  const codeSpans = [];
  s = s.replace(INLINE_RE, (_, code) => {
    const token = INLINE_TOKEN_OPEN + codeSpans.length + INLINE_TOKEN_CLOSE;
    codeSpans.push('<code class="md-inline">' + code + '</code>');
    return token;
  });

  s = s.replace(/\\*\\*([^*\\n]+)\\*\\*/g, "<strong>$1</strong>");
  s = s.replace(/~~([^~\\n]+)~~/g, "<s>$1</s>");
  s = s.replace(/(?<!\\w)\\*([^*\\n]+?)\\*(?!\\w)/g, "<em>$1</em>");
  s = s.replace(/(?<!\\w)_([^_\\n]+?)_(?!\\w)/g, "<em>$1</em>");

  // Links [text](url). The URL is parsed, not pattern-matched: only http(s)
  // becomes an anchor; unsafe or malformed targets remain literal text.
  s = s.replace(/\\[([^\\]]+)\\]\\(([^\\s)]+)\\)/g, (whole, text, rawUrl) => {
    const href = safeLinkHref(rawUrl);
    if (!href) return whole;
    return '<a href="' + href + '" target="_blank" rel="noopener noreferrer">' + text + '</a>';
  });

  for (let i = 0; i < codeSpans.length; i += 1) {
    s = s.replace(INLINE_TOKEN_OPEN + i + INLINE_TOKEN_CLOSE, codeSpans[i]);
  }
  return s;
}

function splitMarkdownTableRow(line) {
  let source = String(line ?? "").trim();
  if (source.startsWith("|")) source = source.slice(1);
  if (source.endsWith("|") && !source.endsWith("\\\\|")) source = source.slice(0, -1);
  const cells = [];
  let cell = "";
  let inCode = false;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "\\\\" && source[i + 1] === "|") {
      cell += "|";
      i += 1;
    } else if (ch === BT) {
      inCode = !inCode;
      cell += ch;
    } else if (ch === "|" && !inCode) {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += ch;
    }
  }
  cells.push(cell.trim());
  return cells;
}

function markdownTableAlignments(line) {
  const cells = splitMarkdownTableRow(line);
  if (cells.length < 2 || !cells.every((cell) => /^:?-{3,}:?$/.test(cell))) return null;
  return cells.map((cell) => cell.startsWith(":") && cell.endsWith(":")
    ? "center"
    : cell.endsWith(":") ? "right" : "left");
}

function renderMarkdownTable(headers, alignments, rows) {
  const classFor = (alignment) => alignment === "center"
    ? ' class="md-align-center"'
    : alignment === "right" ? ' class="md-align-right"' : "";
  const head = headers.map((cell, i) => '<th' + classFor(alignments[i]) + '>' + renderInlineMarkdown(cell) + '</th>').join("");
  const body = rows.map((row) => {
    const normalized = Array.from({ length: headers.length }, (_, i) => row[i] ?? "");
    return "<tr>" + normalized.map((cell, i) => '<td' + classFor(alignments[i]) + '>' + renderInlineMarkdown(cell) + '</td>').join("") + "</tr>";
  }).join("");
  return '<div class="md-table-wrap"><table class="md-table"><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table></div>';
}

function renderMarkdown(input) {
  if (!input) return "";
  // Escape HTML first. All HTML emitted after this point is a fixed tag or a
  // URL accepted and re-escaped by safeLinkHref.
  const escaped = String(input).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const lines = escaped.split(/\\n/);
  const blocks = [];
  let paragraph = [];
  let listTag = null;
  let listItems = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    blocks.push("<p>" + paragraph.map(renderInlineMarkdown).join("<br>") + "</p>");
    paragraph = [];
  };
  const flushList = () => {
    if (!listTag) return;
    blocks.push("<" + listTag + ">" + listItems.map((item) => "<li>" + renderInlineMarkdown(item) + "</li>").join("") + "</" + listTag + ">");
    listTag = null;
    listItems = [];
  };
  const flushText = () => { flushParagraph(); flushList(); };

  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    const fence = FENCE_OPEN_RE.exec(line);
    if (fence) {
      flushText();
      const code = [];
      i += 1;
      while (i < lines.length && !FENCE_CLOSE_RE.test(lines[i])) {
        code.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1;
      const langClass = fence[1] ? "md-code-block lang-" + fence[1] : "md-code-block";
      blocks.push('<pre class="md-code"><code class="' + langClass + '">' + code.join("\\n") + '</code></pre>');
      continue;
    }

    if (!line.trim()) {
      flushText();
      i += 1;
      continue;
    }

    const headers = line.includes("|") ? splitMarkdownTableRow(line) : [];
    const alignments = i + 1 < lines.length ? markdownTableAlignments(lines[i + 1]) : null;
    if (headers.length >= 2 && alignments && alignments.length === headers.length) {
      flushText();
      const rows = [];
      i += 2;
      while (i < lines.length && lines[i].trim() && lines[i].includes("|")) {
        const row = splitMarkdownTableRow(lines[i]);
        if (row.length < 2) break;
        rows.push(row);
        i += 1;
      }
      blocks.push(renderMarkdownTable(headers, alignments, rows));
      continue;
    }

    const heading = /^(#{1,6})\\s+(.*)$/.exec(line);
    if (heading) {
      flushText();
      const level = Math.min(6, heading[1].length + 1);
      blocks.push("<h" + level + ">" + renderInlineMarkdown(heading[2]) + "</h" + level + ">");
      i += 1;
      continue;
    }

    if (/^ {0,3}(?:-{3,}|_{3,}|\\*{3,})\\s*$/.test(line)) {
      flushText();
      blocks.push("<hr>");
      i += 1;
      continue;
    }

    if (line.startsWith("&gt;")) {
      flushText();
      const quote = [];
      while (i < lines.length && lines[i].startsWith("&gt;")) {
        quote.push(lines[i].replace(/^&gt; ?/, ""));
        i += 1;
      }
      blocks.push("<blockquote><p>" + quote.map(renderInlineMarkdown).join("<br>") + "</p></blockquote>");
      continue;
    }

    const unordered = /^ {0,3}[-*+]\\s+(.*)$/.exec(line);
    const ordered = /^ {0,3}\\d+[.)]\\s+(.*)$/.exec(line);
    if (unordered || ordered) {
      flushParagraph();
      const nextTag = unordered ? "ul" : "ol";
      if (listTag && listTag !== nextTag) flushList();
      listTag = nextTag;
      listItems.push((unordered ?? ordered)[1]);
      i += 1;
      continue;
    }

    flushList();
    paragraph.push(line);
    i += 1;
  }

  flushText();
  return blocks.join("");
}

// Small chat composer surface that any tab can embed at the top so the
// user can talk to the agent without leaving the structured view. The
// reply appears inline below the input; the optional onAfterSend hook
// re-runs the host tab's render to pick up state changes (e.g. a new
// task the agent just created via add_task).
function renderPageChatComposer(host, { placeholder = "Talk to your agent…", onAfterSend } = {}) {
  if (!host) return;
  host.innerHTML = \`
    <form class="page-chat" style="display:flex; gap:6px; margin-bottom:14px; align-items:flex-start;">
      <textarea class="page-chat-input" rows="1" placeholder="\${escapeHtml(placeholder)}" style="flex:1; min-width:200px; resize:vertical; padding:8px 10px; font:inherit;"></textarea>
      <button type="submit" class="page-chat-send">Send</button>
    </form>
    <div class="page-chat-reply" style="display:none;"></div>
  \`;
  const form = host.querySelector("form.page-chat");
  const input = host.querySelector(".page-chat-input");
  const sendBtn = host.querySelector(".page-chat-send");
  const reply = host.querySelector(".page-chat-reply");
  input.addEventListener("input", () => {
    input.style.height = "auto";
    input.style.height = Math.min(180, input.scrollHeight) + "px";
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    sendBtn.disabled = true;
    reply.style.display = "block";
    reply.innerHTML = '<div class="muted" style="padding:10px 12px;">Thinking…</div>';
    const requestId = newChatRequestId();
    let streamedText = "";
    const showStreamedReply = (model = "") => {
      reply.innerHTML = \`
        <div class="card" style="padding:12px; margin-bottom:14px;">
          <div class="muted" style="font-size:11px; margin-bottom:6px;">openagi\${model ? " → " + escapeHtml(model) : " is replying…"}</div>
          <div>\${renderMarkdown(streamedText)}</div>
          <div class="muted" style="margin-top:8px; font-size:11px;">Response is still streaming…</div>
        </div>
      \`;
    };
    try {
      const result = await postMessageStream({
        text,
        channel: state.channel ?? "local",
        from: state.from ?? "browser",
        agentId: state.agentId,
        sessionId: state.sessionId,
        metadata: { requestId, requestSource: "page-chat" }
      }, (event, data) => {
        if (event === "session" && data?.id) state.sessionId = data.id;
        if (event === "delta" && typeof data?.text === "string") {
          streamedText = data.reset === true ? data.text : streamedText + data.text;
          showStreamedReply(data.model ?? "");
        } else if ((event === "status" || event === "heartbeat") && !streamedText) {
          const label = data?.stage === "tool" ? "Using tools…" : data?.stage === "saving" ? "Saving the answer…" : "Thinking…";
          reply.innerHTML = '<div class="muted" style="padding:10px 12px;">' + label + '</div>';
        }
      });
      if (result.session?.id) state.sessionId = result.session.id;
      const continueHref = "/?tab=chat" + (state.sessionId ? "&session=" + encodeURIComponent(state.sessionId) : "");
      reply.innerHTML = \`
        <div class="card" style="padding:12px; margin-bottom:14px;">
          <div class="muted" style="font-size:11px; margin-bottom:6px;">openagi → \${escapeHtml(result.model?.model ?? "")}</div>
          <div>\${renderMarkdown(result.reply ?? "")}</div>
          <div style="margin-top:8px; font-size:11px;"><a href="\${escapeHtml(continueHref)}">continue in chat →</a></div>
        </div>
      \`;
      input.value = "";
      input.style.height = "auto";
      if (typeof onAfterSend === "function") {
        try { await onAfterSend(result); } catch { /* ignore */ }
      }
    } catch (err) {
      reply.innerHTML = \`<div class="card err" style="padding:10px 12px;">\${escapeHtml(err.message)}</div>\`;
    } finally {
      sendBtn.disabled = false;
    }
  });
}

function showToast(msg, ok = true) {
  // Stack toasts when multiple fire close together — the toast-stack
  // container is shared so they don't pile up at one position.
  let host = document.getElementById("toastStack");
  if (!host) {
    host = document.createElement("div");
    host.id = "toastStack";
    host.className = "ui-toast-stack";
    document.body.appendChild(host);
  }
  const t = document.createElement("div");
  t.className = "ui-toast " + (ok ? "ui-toast-ok" : "ui-toast-err");
  t.textContent = msg;
  host.appendChild(t);
  // Fade-out at 4s, remove at 4.5s so the transition has time.
  setTimeout(() => t.classList.add("ui-toast-leaving"), 4000);
  setTimeout(() => t.remove(), 4500);
}

// Accepting an MCP suggestion has three real endings, and the accept
// response now reports which one happened (connected + connectError).
// Say the true one — claiming "connected" for a server that never answered
// sent people to the MCP tab to find it sitting there disconnected.
function mcpAcceptMessage(res) {
  const name = res.registered;
  if (res.connectError) return "Registered " + name + " — connect failed: " + res.connectError;
  if (res.connected) return "✓ MCP " + name + " connected — opening MCP tab";
  return "Registered " + name + " — not connected yet (may need authorization)";
}

newBtn.addEventListener("click", async () => {
  if (state.tab === "chat") {
    state.sessionId = null;
    state.messages = [];
    state.activeRequestId = null;
    state.activeRequestStage = null;
    state.activeRequestError = null;
    state.activeRequestMissingSince = null;
    state.freshChatRequested = true;
    state.from = "browser-" + Date.now();
    renderTab();
  } else if (state.tab === "cron") {
    openCronComposer();
  } else if (state.tab === "skills") {
    // Triggers both miners (pattern + session) and shows scanned/found
    // counts so the user sees the system working even when nothing landed.
    const original = newBtn.textContent;
    newBtn.disabled = true;
    newBtn.textContent = "Mining…";
    try {
      const result = await postJson("/skills/mine", {});
      const p = result.pattern ?? {};
      const s = result.session ?? {};
      const totalNew = (p.candidates ?? 0) + (s.candidates ?? 0);
      const summary = totalNew > 0
        ? \`✨ \${totalNew} new candidate\${totalNew > 1 ? "s" : ""} — Pattern: \${p.candidates ?? 0}/\${p.mined ?? 0} · Session: \${s.candidates ?? 0}/\${s.mined ?? 0}\`
        : \`Mining done — Pattern: scanned \${p.mined ?? 0}, no new clusters · Session: scanned \${s.mined ?? 0}, no new clusters\`;
      showToast(summary, true);
      newBtn.textContent = totalNew > 0 ? \`✓ \${totalNew} new\` : "✓ Done";
      setTimeout(() => { newBtn.textContent = original; newBtn.disabled = false; }, 2400);
      await refreshSkills(true);
    } catch (err) {
      showToast("Mine failed: " + (err.message || String(err)), false);
      newBtn.textContent = "✗ Error";
      setTimeout(() => { newBtn.textContent = original; newBtn.disabled = false; }, 2400);
    }
  } else if (state.tab === "mcp") {
    openMcpComposer();
  }
});

async function switchTab(tab) {
  state.tab = tab;
  syncNodesAutoRefresh();
  document.querySelectorAll("nav button").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  const body = document.querySelector(".body");
  const showSidebar = (yes) => {
    sidebar.style.display = yes ? "" : "none";
    body.classList.toggle("no-sidebar", !yes);
  };

  if (tab === "chat") {
    showSidebar(true);
    sidebarTitle.textContent = "Sessions";
    newBtn.textContent = "+ New";
    await refreshSessions();
    // A bare Chat open should look like chat history, not an unexplained blank
    // composer. Select the newest human-facing session unless the user
    // explicitly pressed + New or a specific ?session= handoff is about to be
    // resolved. Background cron/autopilot transcripts stay out of this choice.
    const requestedSession = deepLinkSessionId(window.location.search);
    if (!state.sessionId && !state.freshChatRequested && !requestedSession) {
      const latest = latestInteractiveSession(state.sessions);
      if (latest) await loadSession(latest.id);
    }
  } else if (tab === "cron") {
    showSidebar(true);
    sidebarTitle.textContent = "Schedules";
    newBtn.textContent = "+ Schedule";
    await refreshCron();
  } else if (tab === "skills") {
    showSidebar(true);
    sidebarTitle.textContent = "Skills";
    newBtn.textContent = "✨ Mine now";
    state.skillsMineButton = true;
    await refreshSkills();
  } else if (tab === "mcp") {
    showSidebar(true);
    sidebarTitle.textContent = "MCP Servers";
    newBtn.textContent = "+ Register";
    await refreshMcp();
  } else if (tab === "agents") {
    showSidebar(false);
    await renderAgents();
  } else if (tab === "memory") {
    showSidebar(false);
    await renderMemory();
  } else if (tab === "nodes") {
    showSidebar(false);
    await renderNodes();
  } else if (tab === "channels") {
    showSidebar(false);
    await renderChannels();
  } else if (tab === "budget") {
    showSidebar(false);
    await renderBudget();
  } else if (tab === "outcomes") {
    showSidebar(false);
    await renderOutcomes();
  } else if (tab === "scrutiny") {
    showSidebar(false);
    await renderScrutiny();
  } else if (tab === "health") {
    showSidebar(false);
    await renderHealth();
  } else if (tab === "activity") {
    showSidebar(false);
    await renderActivity();
  } else if (tab === "computer-use") {
    showSidebar(false);
    await renderComputerUse();
  } else if (tab === "today") {
    showSidebar(false);
    await renderToday();
  } else if (tab === "review") {
    showSidebar(false);
    await renderReview();
  } else if (tab === "approvals") {
    showSidebar(false);
    await renderApprovals();
  } else if (tab === "tasks") {
    showSidebar(false);
    await renderTasks();
  } else if (tab === "integrations") {
    showSidebar(false);
    await renderIntegrations();
  } else if (tab === "suggestions") {
    showSidebar(false);
    await renderSuggestions();
  }
  renderTab();
}

function renderTab() {
  if (state.tab === "chat") return renderChat();
  // for other tabs, sidebar interaction drives main pane
}

async function refreshSessions() {
  const sessions = await fetchJson("/sessions");
  state.sessions = sessions;
  // A session refresh can finish after the user has switched to another tab.
  // Keep the cached list current, but never replace another tab's sidebar.
  if (state.tab !== "chat") return sessions;
  sidebarList.innerHTML = "";
  if (sessions.length === 0) {
    sidebarList.innerHTML = '<li class="empty">No sessions yet</li>';
  }
  for (const s of sessions) {
    const li = document.createElement("li");
    li.className = state.sessionId === s.id ? "active" : "";
    li.innerHTML = \`<div class="title">\${escapeHtml(s.id)}</div><div class="preview">\${escapeHtml(s.lastMessage || "")}</div>\`;
    li.addEventListener("click", () => loadSession(s.id));
    sidebarList.appendChild(li);
  }
  return sessions;
}

async function loadSession(id) {
  state.sessionId = id;
  state.freshChatRequested = false;
  const session = await fetchJson("/sessions/" + encodeURIComponent(id));
  // Sidebar clicks can race. If B (or + New) was selected while A's history
  // was in flight, A's late response must not overwrite B's conversation.
  if (state.tab !== "chat" || state.sessionId !== id) return false;
  const resolvedId = session?.id || id;
  state.sessionId = resolvedId;
  state.messages = session.messages ?? [];
  state.activeRequestId = latestChatRequestId(state.messages);
  state.activeRequestStage = null;
  state.activeRequestError = null;
  state.activeRequestMissingSince = null;
  state.activeRequestText = "";
  state.activeRequestModel = "";
  state.channel = state.messages[0]?.channel ?? "local";
  state.from = state.messages[0]?.from ?? "browser";
  await refreshSessions();
  if (state.tab !== "chat" || state.sessionId !== resolvedId) return false;
  renderChat();
  return true;
}

function latestInteractiveSession(sessions) {
  if (!Array.isArray(sessions)) return null;
  return sessions.find((session) => {
    const id = String(session?.id ?? "").toLowerCase();
    return id && !id.startsWith("autopilot:") && !id.startsWith("cron:");
  }) ?? null;
}

// Read the session id out of a chat deep link. The Quick Ask popover's
// "Continue in chat" button opens /?tab=chat&session=<id>&token=... where <id>
// is the server-side session the ask already created ("overlay:user:main"), so
// the handoff carries the real conversation instead of replaying text: full
// history, the screen context that was attached, and answers far longer than
// any URL could hold. Returns null for anything that is not a usable id so the
// caller falls through to a normal fresh chat.
function deepLinkSessionId(search) {
  try {
    const raw = new URLSearchParams(search).get("session");
    const id = (raw ?? "").trim();
    return id === "" ? null : id;
  } catch {
    return null;
  }
}

function deepLinkRequestId(search) {
  try {
    const raw = new URLSearchParams(search).get("request");
    const id = (raw ?? "").trim();
    return id === "" ? null : id;
  } catch {
    return null;
  }
}

// Land the user on the conversation named by the deep link. Returns true when
// the thread was actually loaded, false when we said so and left them on a
// fresh chat instead.
async function openSessionDeepLink(id, requestId = null) {
  let session = null;
  // The popup knows the session id before it opens POST /message, specifically
  // so its handoff is available while work is running. If the user clicks in
  // the tiny interval before the daemon persists the user turn, retry this
  // named request rather than declaring its brand-new session "gone".
  const attempts = requestId ? 4 : 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      session = await fetchJson("/sessions/" + encodeURIComponent(id));
    } catch (err) {
      if (attempt === attempts - 1) {
        showToast("Could not open that conversation: " + err.message, false);
        return false;
      }
    }
    const candidateMessages = Array.isArray(session?.messages) ? session.messages : [];
    const requestedTurnIsPresent = !requestId || candidateMessages.some((message) => {
      const metadata = message?.metadata;
      const value = metadata?.requestId ?? metadata?.request?.id;
      return typeof value === "string" && value.trim() === requestId;
    });
    // A reused overlay session already has old messages. Do not mistake that
    // history for the new handoff: wait briefly for this exact request to be
    // persisted, then adopt it as a durable queued request below.
    if (candidateMessages.length > 0 && requestedTurnIsPresent) break;
    if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
  }
  const messages = Array.isArray(session && session.messages) ? session.messages : [];
  // GET /sessions/:id answers with an empty shell for an id it has never seen
  // (agent-store getSession returns a default rather than 404ing), so "no
  // messages" is exactly how a purged or mistyped deep link looks. Say that,
  // rather than rendering an empty thread that looks identical to the bug this
  // whole deep link exists to fix.
  if (messages.length === 0 && !requestId) {
    state.sessionId = null;
    state.messages = [];
    showToast("That conversation is no longer available — starting a new one.", false);
    return false;
  }
  state.sessionId = (session && session.id) || id;
  state.freshChatRequested = false;
  state.messages = messages;
  state.activeRequestId = requestId;
  if (!state.activeRequestId) {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const value = messages[i]?.metadata?.requestId ?? messages[i]?.metadata?.request?.id;
      if (typeof value === "string" && value.trim()) {
        state.activeRequestId = value.trim();
        break;
      }
    }
  }
  state.activeRequestStage = null;
  state.activeRequestError = null;
  state.activeRequestText = "";
  state.activeRequestModel = "";
  const requestedTurnIsPresent = Boolean(requestId && messages.some((message) => {
    const metadata = message?.metadata;
    const value = metadata?.requestId ?? metadata?.request?.id;
    return typeof value === "string" && value.trim() === requestId;
  }));
  // The popup can hand off before routing or a same-session queue reaches the
  // store. Keep that named request visibly queued, block duplicate sends, and
  // let the recovery poll reconcile it once its user/assistant records appear.
  state.activeRequestMissingSince = requestId && !requestedTurnIsPresent ? Date.now() : null;
  if (state.activeRequestMissingSince) state.activeRequestStage = "queued";
  // Keep replying on the channel the conversation started on. An overlay ask
  // is channel "overlay" / from "user"; sending the follow-up as local/browser
  // would compute a different session key and fork the thread in two.
  state.channel = (messages[0] && messages[0].channel) || "local";
  state.from = (messages[0] && messages[0].from) || "browser";
  await refreshSessions();
  renderChat();
  return true;
}

function newChatRequestId() {
  try {
    if (globalThis.crypto?.randomUUID) return "req_" + globalThis.crypto.randomUUID().replaceAll("-", "");
  } catch { /* deterministic fallback below */ }
  return "req_" + Date.now().toString(36) + Math.random().toString(36).slice(2);
}

// Direct response streams outlive the DOM that started them. Only the request
// still selected in Chat may mutate visible conversation state; a completion
// for a session the user left remains durable on the server and is picked up
// from the session list/history instead.
function chatRequestOwnsVisibleState(current, sessionIds, requestId) {
  return current?.tab === "chat"
    && current?.activeRequestId === requestId
    && sessionIds.some((id) => Boolean(id) && current?.sessionId === id);
}

function messageRequestId(message) {
  const metadata = message?.metadata;
  const value = metadata?.requestId ?? metadata?.request?.id;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function messageRequestStatus(message) {
  const metadata = message?.metadata;
  const value = metadata?.requestStatus ?? metadata?.request?.status ?? metadata?.status;
  return typeof value === "string" ? value.toLowerCase() : null;
}

// Six provider hops can each consume the 120-second provider timeout. Thirty
// minutes leaves ample room for that plus tools while preventing a user turn
// stranded by a daemon crash from saying “working” and polling forever.
const CHAT_REQUEST_STALE_MS = 30 * 60 * 1000;
// A disconnected request is recoverable too: the daemon deliberately keeps a queued
// turn running after the direct HTTP stream drops. Keep reconciling its durable
// history until the same 30-minute stale cutoff used by every pending request.
const CHAT_REQUEST_LIVE_STAGES = ["queued", "routing", "accepted", "thinking", "model", "tool", "saving", "disconnected"];

function latestChatRequestId(messages) {
  for (let i = (messages?.length ?? 0) - 1; i >= 0; i -= 1) {
    const id = messageRequestId(messages[i]);
    if (id) return id;
  }
  return null;
}

function requestState(messages, requestId) {
  if (!requestId) return null;
  const userIndex = messages.findIndex((message) => message.role === "user" && messageRequestId(message) === requestId);
  if (userIndex < 0) return null;
  let laterIdentifiedRequest = false;
  for (let i = userIndex + 1; i < messages.length; i += 1) {
    const message = messages[i];
    const messageId = messageRequestId(message);
    if (message.role === "user" && messageId) {
      laterIdentifiedRequest = true;
      continue;
    }
    if (message.role !== "assistant") continue;
    // New records carry requestId on both sides. Legacy assistant records do
    // not, so adjacency remains the fallback only when no overlapping request
    // makes that inference ambiguous.
    if (messageId && messageId !== requestId) continue;
    if (!messageId && laterIdentifiedRequest) continue;
    const status = messageRequestStatus(message);
    if (status === "failed") return { status: "failed", message };
    return { status: "complete", message };
  }
  const userMessage = messages[userIndex];
  const createdAt = Date.parse(userMessage?.createdAt ?? "");
  if (Number.isFinite(createdAt) && Date.now() - createdAt > CHAT_REQUEST_STALE_MS) {
    return { status: "interrupted", message: userMessage };
  }
  return { status: "pending", message: userMessage };
}

function isPendingUserMessage(messages, index) {
  const message = messages[index];
  if (message?.role !== "user") return false;
  const id = messageRequestId(message);
  return Boolean(id && requestState(messages, id)?.status === "pending");
}

function activeChatRequestIsPending() {
  const id = state.activeRequestId || latestChatRequestId(state.messages);
  const persisted = requestState(state.messages, id);
  return persisted?.status === "pending"
    || (!persisted && Boolean(id) && CHAT_REQUEST_LIVE_STAGES.includes(state.activeRequestStage));
}

function chatStageLabel(stage) {
  return ({
    queued: "Queued",
    routing: "Choosing the right agent",
    accepted: "Request saved",
    thinking: "Thinking",
    model: "Waiting for the model",
    tool: "Using tools",
    saving: "Saving the answer",
    disconnected: "Connection lost — checking the saved request"
  })[stage] ?? "Working";
}

function renderChatRequestStatus() {
  const host = document.getElementById("chat-request-status");
  if (!host) return;
  const id = state.activeRequestId || latestChatRequestId(state.messages);
  const persisted = requestState(state.messages, id);
  const hasLiveProgress = CHAT_REQUEST_LIVE_STAGES.includes(state.activeRequestStage);
  const failed = state.activeRequestStage === "failed" || persisted?.status === "failed";
  const interrupted = state.activeRequestStage === "interrupted" || (!hasLiveProgress && persisted?.status === "interrupted");
  const pending = !failed && !interrupted && (persisted?.status === "pending" || hasLiveProgress);
  if (!failed && !interrupted && !pending) {
    host.innerHTML = "";
    return;
  }
  if (failed) {
    const persistedText = persisted?.message?.content;
    const detail = state.activeRequestError || persistedText || "The agent could not complete this request.";
    host.innerHTML = \`
      <div class="card err" style="padding:10px 12px; margin-bottom:10px;" role="status">
        <strong>Request failed.</strong> \${escapeHtml(detail)}
      </div>
    \`;
    return;
  }
  if (interrupted) {
    host.innerHTML = \`
      <div class="card warn-banner" style="padding:10px 12px; margin-bottom:10px;" role="status">
        <strong>Request interrupted.</strong> No completion was recorded. Review any task changes before retrying.
      </div>
    \`;
    return;
  }
  host.innerHTML = \`
    <div class="card" style="padding:10px 12px; margin-bottom:10px;" role="status" aria-live="polite">
      <span class="muted">◌ \${escapeHtml(chatStageLabel(state.activeRequestStage))}… This conversation updates automatically; you can keep this window open or come back later.</span>
    </div>
  \`;
}

let activeChatRefresh = null;
async function refreshActiveChatSession(id = state.sessionId, { force = false } = {}) {
  if (!id || state.tab !== "chat") return false;
  if (activeChatRefresh && !force) return activeChatRefresh;
  const request = (async () => {
    const session = await fetchJson("/sessions/" + encodeURIComponent(id));
    // The fetch may finish after a sidebar click or + New. Applying that stale
    // response would reopen the old conversation even though its stream handler
    // correctly detached, so verify the selection again at the async boundary.
    if (state.tab !== "chat" || state.sessionId !== id) return false;
    const messages = Array.isArray(session?.messages) ? session.messages : [];
    const before = state.messages.map((message) => message.id ?? [message.role, message.createdAt, message.content].join(":"))
      .join("|");
    const after = messages.map((message) => message.id ?? [message.role, message.createdAt, message.content].join(":"))
      .join("|");
    if (!force && before === after) return false;

    const draft = document.getElementById("input")?.value ?? "";
    const wasFocused = document.activeElement?.id === "input";
    state.sessionId = session?.id || id;
    state.messages = messages;
    state.channel = messages[0]?.channel ?? state.channel ?? "local";
    state.from = messages[0]?.from ?? state.from ?? "browser";
    const outcome = requestState(messages, state.activeRequestId);
    if (outcome) state.activeRequestMissingSince = null;
    else if (state.activeRequestId && CHAT_REQUEST_LIVE_STAGES.includes(state.activeRequestStage)) {
      // A disconnect can happen while this turn is still queued behind another
      // same-session turn, before AgentHost persists its user record. Remember
      // when it first went missing so polling recovers a late write but still
      // terminates at CHAT_REQUEST_STALE_MS after a daemon crash.
      state.activeRequestMissingSince ??= Date.now();
    }
    if (outcome?.status === "complete") {
      state.activeRequestStage = "complete";
      state.activeRequestError = null;
      state.activeRequestText = "";
      state.activeRequestModel = "";
    } else if (outcome?.status === "failed") {
      state.activeRequestStage = "failed";
      state.activeRequestText = "";
      state.activeRequestModel = "";
    } else if (outcome?.status === "interrupted") {
      state.activeRequestStage = "interrupted";
      state.activeRequestText = "";
      state.activeRequestModel = "";
    }
    renderChat();
    const input = document.getElementById("input");
    if (input && draft) {
      input.value = draft;
      input.dispatchEvent(new Event("input"));
      if (wasFocused) input.focus();
    }
    await refreshSessions();
    return true;
  })();
  activeChatRefresh = request;
  try { return await request; }
  finally { if (activeChatRefresh === request) activeChatRefresh = null; }
}

function renderChat() {
  main.innerHTML = \`
    <div id="chat-deeplink" style="margin-bottom:8px;"></div>
    <div id="chat-request-status"></div>
    <div class="thread" id="thread"></div>
    <form class="composer" id="composer">
      <textarea id="input" placeholder="Message your OpenAGI agent…" rows="1"></textarea>
      <button type="submit" id="send">Send</button>
    </form>
  \`;
  const thread = $("thread");
  if (state.messages.length === 0) {
    // First-run welcome card: when this user has never had any session
    // (just landed from /setup) and hasn't dismissed before, show the
    // 4 things worth doing next. localStorage dismiss persists across
    // sessions in the same browser; after the first real session exists,
    // we fall back to the lighter prompt automatically.
    const noSessions = (state.sessions ?? []).length === 0;
    let dismissed = false;
    try { dismissed = localStorage.getItem("openagi.welcomeDismissed") === "1"; } catch { /* ignore */ }
    thread.innerHTML = (noSessions && !dismissed) ? renderFirstRunWelcome() : renderChatPlaceholder();
  }
  for (let i = 0; i < state.messages.length; i += 1) {
    appendMessage(state.messages[i], false, { pending: isPendingUserMessage(state.messages, i) });
  }
  renderStreamingAssistant();
  renderChatRequestStatus();
  thread.scrollTop = thread.scrollHeight;
  // Render a deep-link panel above the thread when the user arrived
  // here via a notification with ?suggestion=<id> or ?pending=<id>.
  // The panel is the in-chat surface for proactive suggestions and
  // agent-action approvals — clicking buttons here calls the same
  // backend endpoints the Suggestions tab does.
  renderChatDeepLink();
  // First-run welcome card click routing. Each card has a data-welcome-target
  // saying where it should send the user. Dismiss persists in localStorage
  // so it doesn't reappear next session.
  document.querySelectorAll("[data-welcome-target]").forEach((card) => {
    card.addEventListener("click", () => {
      const target = card.dataset.welcomeTarget;
      if (target === "integrations") switchTab("integrations");
      else if (target === "tasks") switchTab("tasks");
      else if (target === "capture") {
        showToast("Open the menu bar icon → Capture → Enable to turn on screen observation.", true);
      } else if (target === "chat-self") {
        const inp = $("input");
        if (inp) { inp.value = "What can you do?"; inp.focus(); inp.dispatchEvent(new Event("input")); }
      }
    });
  });
  document.getElementById("dismissWelcome")?.addEventListener("click", () => {
    try { localStorage.setItem("openagi.welcomeDismissed", "1"); } catch { /* ignore */ }
    const thread = $("thread");
    if (thread) thread.innerHTML = renderChatPlaceholder();
  });
  const input = $("input");
  const composerBlocked = activeChatRequestIsPending();
  input.disabled = composerBlocked;
  $("send").disabled = composerBlocked;
  if (composerBlocked) input.placeholder = "Wait for the current request to finish…";
  // ?compose=<intent> seeds the input with a starter sentence so the user
  // can finish typing and Enter — agent picks up via add_task /
  // connect_catalog_mcp / etc tools. Used by the menu-bar "+ Add task"
  // button so its click drops you straight into a conversation rather
  // than a structured form.
  const composeIntent = new URLSearchParams(window.location.search).get("compose");
  if (composeIntent && state.messages.length === 0) {
    const seed = ({
      "add-task": "Add a task: ",
      "add-mcp": "Connect this MCP: ",
      "schedule": "Remind me to ",
      "remember": "Remember that "
    })[composeIntent];
    if (seed) {
      input.value = seed;
      input.dispatchEvent(new Event("input"));
      // Move caret to end so the user starts typing in the right spot.
      requestAnimationFrame(() => {
        input.setSelectionRange(seed.length, seed.length);
      });
      // Strip the query so reload / re-render doesn't re-seed.
      const url = new URL(window.location.href);
      url.searchParams.delete("compose");
      history.replaceState(null, "", url.toString());
    }
  }
  if (!composerBlocked) input.focus();
  input.addEventListener("input", () => {
    input.style.height = "auto";
    input.style.height = Math.min(200, input.scrollHeight) + "px";
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      $("composer").requestSubmit();
    }
  });
  $("composer").addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    const sendBtn = $("send");
    if (sendBtn.disabled) return;
    const requestId = newChatRequestId();
    if (!state.sessionId) {
      if (!state.from || state.from === "browser") state.from = "browser-" + newChatRequestId();
      state.sessionId = state.channel + ":" + state.from + ":" + state.agentId;
    }
    const submittedSessionId = state.sessionId;
    let requestSessionId = submittedSessionId;
    const ownsVisibleRequest = () => chatRequestOwnsVisibleState(
      state,
      [submittedSessionId, requestSessionId],
      requestId
    );
    const refreshDetachedSessionList = async () => {
      if (state.tab === "chat") await refreshSessions().catch(() => {});
    };
    state.freshChatRequested = false;
    state.activeRequestId = requestId;
    state.activeRequestStage = "queued";
    state.activeRequestError = null;
    state.activeRequestMissingSince = null;
    state.activeRequestText = "";
    state.activeRequestModel = "";
    input.value = "";
    input.style.height = "auto";
    const optimistic = {
      role: "user",
      content: text,
      from: state.from,
      channel: state.channel,
      createdAt: new Date().toISOString(),
      metadata: { requestId, requestSource: "dashboard" }
    };
    state.messages.push(optimistic);
    appendMessage(optimistic, true, { pending: true });
    renderChatRequestStatus();
    sendBtn.disabled = true;
    try {
      const result = await postMessageStream({
        text,
        channel: state.channel,
        from: state.from,
        agentId: state.agentId,
        sessionId: submittedSessionId,
        metadata: { requestId, requestSource: "dashboard" }
      }, (event, data) => {
        if (event === "session" && data?.id) {
          const wasVisible = ownsVisibleRequest();
          requestSessionId = data.id;
          if (wasVisible) state.sessionId = data.id;
          return;
        }
        if (!ownsVisibleRequest()) return;
        if (event === "status" || event === "heartbeat") {
          state.activeRequestStage = data?.stage ?? state.activeRequestStage;
          renderChatRequestStatus();
        } else if (event === "delta") {
          updateStreamingAssistant(requestId, data);
        }
      });
      const finalSessionId = result.session?.id || requestSessionId;
      if (ownsVisibleRequest()) {
        requestSessionId = finalSessionId;
        state.sessionId = finalSessionId;
        state.activeRequestStage = "complete";
        await refreshActiveChatSession(finalSessionId, { force: true });
      } else {
        await refreshDetachedSessionList();
      }
    } catch (err) {
      // An explicit daemon failure is terminal. A broken HTTP/SSE transport is
      // not: the daemon intentionally continues the already-persisted turn.
      // Keep it pending and let the session poll/global SSE reconcile it.
      if (ownsVisibleRequest()) {
        state.activeRequestStage = err.terminal === true ? "failed" : "disconnected";
        state.activeRequestError = err.message;
        // Prefer the daemon's persisted failure record when available. If the
        // connection itself died first, the local status remains visible and the
        // pending-session poll can still pick up a later completion.
        await refreshActiveChatSession(requestSessionId, { force: true }).catch(() => {});
        renderChatRequestStatus();
      } else {
        await refreshDetachedSessionList();
      }
    } finally {
      if (ownsVisibleRequest()) {
        const currentSend = $("send");
        const outcome = requestState(state.messages, state.activeRequestId);
        if (currentSend) currentSend.disabled = outcome?.status === "pending" || activeChatRequestIsPending();
      }
    }
  });
}

async function renderChatDeepLink() {
  const host = document.getElementById("chat-deeplink");
  if (!host) return;
  const qs = new URLSearchParams(window.location.search);
  const suggestionId = qs.get("suggestion");
  const pendingId = qs.get("pending");
  if (!suggestionId && !pendingId) {
    host.innerHTML = "";
    return;
  }
  // Loading shimmer while we fetch.
  host.innerHTML = '<div class="card" style="padding:12px;"><span class="muted">Loading…</span></div>';
  try {
    if (suggestionId) {
      const all = await fetchJson("/proactive/suggestions").catch(() => []);
      const sug = Array.isArray(all) ? all.find((s) => s.id === suggestionId) : null;
      if (!sug || sug.status !== "pending") {
        host.innerHTML = \`<div class="card" style="padding:10px 14px;"><span class="muted">This suggestion has already been \${escapeHtml(sug?.status ?? "removed")}.</span></div>\`;
        return;
      }
      const icon = ({ task: "📋", skill: "✨", mcp: "🔌", automation: "⚙️", knowledge: "💡" })[sug.category] ?? "🔔";
      host.innerHTML = \`
        <div class="card" style="padding:14px;">
          <div style="display:flex; gap:8px; align-items:center;">
            <span style="font-size:18px;">\${icon}</span>
            <span style="font-weight:600;">\${escapeHtml(sug.title || "OpenAGI noticed something")}</span>
            <span class="badge">\${escapeHtml(sug.category || "fyi")}</span>
          </div>
          <div class="muted" style="margin-top:6px; font-size:12px;">\${escapeHtml(sug.rationale || "")}</div>
          <div class="row" style="gap:8px; margin-top:10px;">
            <button id="dl-accept">Accept</button>
            <button id="dl-dismiss" class="secondary">Dismiss</button>
            <button id="dl-reject" class="secondary">Reject</button>
          </div>
        </div>
      \`;
      const handle = async (action) => {
        try {
          const res = await postJson(\`/proactive/suggestions/\${encodeURIComponent(suggestionId)}/\${action}\`, {});
          if (action === "accept" && res.taskId) {
            showToast("✓ Task added — opening Tasks", true);
            setTimeout(() => switchTab("tasks"), 600);
          } else if (action === "accept" && res.registered) {
            showToast(mcpAcceptMessage(res), !res.connectError);
            setTimeout(() => switchTab("mcp"), 600);
          } else {
            showToast(\`Suggestion \${action}d\`, true);
          }
          host.innerHTML = "";
          // Strip the suggestion query so reload doesn't re-render the card.
          const url = new URL(window.location.href);
          url.searchParams.delete("suggestion");
          history.replaceState(null, "", url.toString());
        } catch (err) {
          showToast(\`\${action} failed: \${err.message}\`, false);
        }
      };
      document.getElementById("dl-accept").addEventListener("click", () => handle("accept"));
      document.getElementById("dl-dismiss").addEventListener("click", () => handle("dismiss"));
      document.getElementById("dl-reject").addEventListener("click", () => handle("reject"));
    } else if (pendingId) {
      const list = await fetchJson("/pending-actions").catch(() => ({ actions: [] }));
      const action = (list.actions ?? []).find((a) => a.id === pendingId);
      if (!action || action.status !== "pending") {
        host.innerHTML = \`<div class="card" style="padding:10px 14px;"><span class="muted">This agent action has already been \${escapeHtml(action?.status ?? "removed")}.</span></div>\`;
        return;
      }
      host.innerHTML = \`
        <div class="card" style="padding:14px;">
          <div style="display:flex; gap:8px; align-items:center;">
            <span style="font-size:18px;">🤖</span>
            <span style="font-weight:600;">\${escapeHtml(action.summary || action.toolName)}</span>
            <span class="badge">\${escapeHtml(action.toolName)}</span>
          </div>
          \${action.reason ? \`<div class="muted" style="margin-top:6px; font-size:12px;">\${escapeHtml(action.reason)}</div>\` : ""}
          <details open style="margin-top:6px;"><summary class="muted" style="font-size:11px;">args</summary><pre style="font-size:11px; margin-top:4px;">\${escapeHtml(JSON.stringify(action.args, null, 2))}</pre></details>
          <div class="row" style="gap:8px; margin-top:10px;">
            <button id="dl-approve">Approve & run</button>
            <button id="dl-deny" class="secondary">Deny</button>
          </div>
        </div>
      \`;
      const handle = async (decision) => {
        document.getElementById("dl-approve").disabled = true;
        document.getElementById("dl-deny").disabled = true;
        try {
          const res = await postJson(\`/pending-actions/\${encodeURIComponent(pendingId)}/\${decision}\`, {});
          const summary = res?.continuation?.status === "queued"
            ? "Approved — the agent is continuing in this chat."
            : res?.result?.note ?? res?.result?.message ?? \`Action \${decision}d.\`;
          showToast(\`✓ \${summary}\`, true);
          host.innerHTML = '<div class="card ok" style="padding:10px 14px;">✓ ' + escapeHtml(summary) + '</div>';
          await refreshApprovalBadge();
          const url = new URL(window.location.href);
          url.searchParams.delete("pending");
          history.replaceState(null, "", url.toString());
        } catch (err) {
          showToast(\`\${decision} failed: \${err.message}\`, false);
          document.getElementById("dl-approve").disabled = false;
          document.getElementById("dl-deny").disabled = false;
        }
      };
      document.getElementById("dl-approve").addEventListener("click", () => handle("approve"));
      document.getElementById("dl-deny").addEventListener("click", () => handle("deny"));
    }
  } catch (err) {
    host.innerHTML = \`<div class="card" style="padding:10px 14px;"><span class="err">Failed to load: \${escapeHtml(err.message)}</span></div>\`;
  }
}

function renderChatPlaceholder() {
  // Lighter prompt shown after the first session exists — assumes the
  // user knows what kind of thing they can say. Kept terse on purpose.
  return '<div class="ui-empty" style="margin: var(--space-4) 0;">Start a new conversation. Try "Remind me in 60 seconds to drink water" or "Remember that my standup is 9am Mondays".</div>';
}

function renderFirstRunWelcome() {
  // First-run dashboard card. Points the user at the 4 high-value next
  // moves so they're not staring at an empty chat input wondering what
  // OpenAGI is for. Each card is a real link to the right tab/action,
  // no fake content. Kept compact — this is a welcome, not a tutorial.
  return \`
    <div class="ui-card ui-card-elev" style="margin: var(--space-4) 0; padding: var(--space-5);">
      <h2 style="margin: 0 0 var(--space-2); font-size: 18px;">Welcome to OpenAGI 👋</h2>
      <p class="ui-muted" style="margin: 0 0 var(--space-4);">You're set up. Here's what's worth doing first — talk to your agent any time you want, but most users start with one of these:</p>
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: var(--space-3);">
        <a class="ui-card" data-welcome-target="integrations" style="cursor:pointer; text-decoration:none; color:inherit;">
          <div style="font-weight: 600; margin-bottom: 4px;">🔌 Connect your tools</div>
          <div class="ui-meta">Link Linear, Notion, GitHub, Stripe, PostHog and ~20 more so the agent has real data to act on.</div>
        </a>
        <a class="ui-card" data-welcome-target="tasks" style="cursor:pointer; text-decoration:none; color:inherit;">
          <div style="font-weight: 600; margin-bottom: 4px;">📋 Add what's on your plate</div>
          <div class="ui-meta">Drop in tasks you're carrying. The agent will help you triage and remind you when they're due.</div>
        </a>
        <a class="ui-card" data-welcome-target="capture" style="cursor:pointer; text-decoration:none; color:inherit;">
          <div style="font-weight: 600; margin-bottom: 4px;">👀 Enable screen capture (optional)</div>
          <div class="ui-meta">Lets the proactive observer notice routines and propose skills. From the menu bar → Capture → Enable.</div>
        </a>
        <a class="ui-card" data-welcome-target="chat-self" style="cursor:pointer; text-decoration:none; color:inherit;">
          <div style="font-weight: 600; margin-bottom: 4px;">💬 Just say hi</div>
          <div class="ui-meta">Type "what can you do?" below. The agent will tell you what it has access to right now.</div>
        </a>
      </div>
      <button class="ui-btn ui-btn-ghost ui-btn-sm" id="dismissWelcome" style="margin-top: var(--space-3);">Don't show again</button>
    </div>
  \`;
}

// A Quick Ask turn can carry the text of the window the user was looking at
// (AppState.askOverlay attaches it as metadata.screenContext, and agent-host
// splices it into the prompt). That is a real input to the answer, so it has to
// be visible here — otherwise the handoff into chat silently drops the single
// piece of context that explains why the reply says what it says. The screen
// text itself is deliberately NOT dumped into the thread: it is whatever
// happened to be on screen, it can be thousands of characters, and it is
// already summarized by the answer. App + window + size is the honest receipt.
function screenContextChip(metadata) {
  const sc = metadata && metadata.screenContext;
  if (!sc || typeof sc !== "object") return "";
  const app = String(sc.app ?? "").trim();
  const window = String(sc.window ?? "").trim();
  const chars = typeof sc.text === "string" ? sc.text.trim().length : 0;
  if (!app && !window && chars === 0) return "";
  const where = [app || "active window", window].filter(Boolean).join(" — ");
  const size = chars > 0 ? " (" + chars + " chars)" : "";
  return '<div class="meta" title="Sent to the model with this message">📎 read from screen: ' +
    escapeHtml(where + size) + "</div>";
}

function appendMessage(msg, autoscroll = true, { pending = false } = {}) {
  const thread = $("thread");
  if (!thread) return;
  const div = document.createElement("div");
  const runtimeApproval = msg.metadata?.runtimeEvent === "approval";
  div.className = "msg " + (runtimeApproval ? "runtime" : msg.role === "user" ? "user" : "assistant");
  const meta = runtimeApproval
    ? "OpenAGI approval"
    : msg.role === "assistant" && msg.metadata?.model ? \`\${msg.metadata.model} · \${msg.metadata.provider ?? ""}\` : msg.from ?? "";
  // Assistant replies render markdown; user messages stay literal.
  const body = msg.role === "assistant" && !runtimeApproval ? renderMarkdown(msg.content ?? "") : escapeHtml(msg.content ?? "");
  const context = msg.role === "user" ? screenContextChip(msg.metadata) : "";
  const pendingNote = pending
    ? '<div class="meta" style="margin-top:5px;">◌ Agent is still working — this request is saved.</div>'
    : "";
  div.innerHTML = \`<div class="meta">\${escapeHtml(meta)}</div>\${context}<div class="body">\${body}</div>\${pendingNote}\`;
  thread.appendChild(div);
  if (autoscroll) thread.scrollTop = thread.scrollHeight;
}

// Keep transient model text outside state.messages: only the exact provider
// result that AgentHost persisted belongs in conversation history. The small
// buffer survives a tab re-render or a transport disconnect, then disappears
// as soon as the durable completed/failed record is fetched.
function updateStreamingAssistant(requestId, delta) {
  if (!requestId || requestId !== state.activeRequestId) return;
  if (typeof delta?.text !== "string" || delta.text.length === 0) return;
  state.activeRequestText = delta.reset === true
    ? delta.text
    : (state.activeRequestText ?? "") + delta.text;
  if (typeof delta.model === "string" && delta.model) state.activeRequestModel = delta.model;
  renderStreamingAssistant();
}

function renderStreamingAssistant() {
  const thread = $("thread");
  if (!thread || !state.activeRequestText || !activeChatRequestIsPending()) return;
  let div = Array.from(thread.querySelectorAll(".msg.assistant.streaming"))
    .find((candidate) => candidate.dataset.requestId === state.activeRequestId);
  if (!div) {
    div = document.createElement("div");
    div.className = "msg assistant streaming";
    div.dataset.requestId = state.activeRequestId ?? "";
    div.innerHTML = '<div class="meta"></div><div class="body" aria-live="polite"></div>';
    thread.appendChild(div);
  }
  const meta = div.querySelector(".meta");
  const body = div.querySelector(".body");
  if (meta) meta.textContent = state.activeRequestModel ? state.activeRequestModel + " · replying…" : "openagi · replying…";
  if (body) body.innerHTML = renderMarkdown(state.activeRequestText);
  thread.scrollTop = thread.scrollHeight;
}

async function refreshCron() {
  const jobs = await fetchJson("/cron");
  sidebarList.innerHTML = jobs.length === 0 ? '<li class="empty">No schedules</li>' : "";
  for (const j of jobs) {
    const li = document.createElement("li");
    li.innerHTML = \`<div class="title">\${escapeHtml(j.name)}</div><div class="preview">\${j.intervalMs ? \`every \${(j.intervalMs/1000).toFixed(0)}s\` : j.dailyAt ? \`daily \${j.dailyAt}\` : "—"} · next \${escapeHtml(new Date(j.nextRunAt).toLocaleString())}</div>\`;
    li.addEventListener("click", () => renderCronDetail(j));
    sidebarList.appendChild(li);
  }
  if (jobs.length > 0) renderCronDetail(jobs[0]);
  else openCronComposer();
}

function renderCronDetail(job) {
  main.innerHTML = \`
    <div class="pane">
      <h2>\${escapeHtml(job.name)}</h2>
      <div class="row" style="gap:6px; margin-bottom: 8px;">
        <span class="badge \${job.enabled ? 'ok' : 'warn'}">\${job.enabled ? "enabled" : "disabled"}</span>
        <span class="badge">task: \${escapeHtml(job.task)}</span>
        <span class="badge">next: \${escapeHtml(new Date(job.nextRunAt).toLocaleString())}</span>
        \${job.lastRunStatus ? \`<span class="badge \${job.lastRunStatus === "ok" ? "ok" : "warn"}">last run: \${escapeHtml(job.lastRunStatus)}\${job.lastRunSource ? " (" + escapeHtml(job.lastRunSource) + ")" : ""}</span>\` : ""}
      </div>
      <h3>Input</h3>
      <pre>\${escapeHtml(JSON.stringify(job.input ?? {}, null, 2))}</pre>
      <div class="row" style="gap:8px; margin-top: 16px;">
        <button class="secondary" id="runJob">Run now</button>
        <button class="secondary" id="deleteJob">Delete</button>
      </div>
      <pre id="jobResult" class="ok" style="margin-top: 12px;"></pre>
    </div>
  \`;
  // "Run now" never leaves the user waiting on an open socket: the route
  // answers within its grace window with ran / accepted / already-running, and
  // an accepted run is polled here until it reaches a terminal status.
  $("runJob").addEventListener("click", async () => {
    const btn = $("runJob");
    const out = $("jobResult");
    btn.disabled = true;
    out.className = "";
    out.textContent = "Starting…";
    try {
      const r = await fetch(\`/cron/\${encodeURIComponent(job.id)}/run\`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: "{}"
      });
      const body = await r.json().catch(() => ({}));
      if (r.status === 409) {
        out.className = "warn";
        out.textContent = "Already running since " + new Date(body.startedAt).toLocaleTimeString() + " — " + (body.message || "");
        return;
      }
      if (!r.ok) {
        out.className = "warn";
        out.textContent = "Failed: " + (body.error || r.status);
        return;
      }
      if (r.status !== 202) {
        out.className = body.status === "ran" ? "ok" : "warn";
        out.textContent = body.status + " in " + body.durationMs + "ms\\n" + JSON.stringify(body.result ?? body.error, null, 2);
        return;
      }
      out.textContent = "Running… (started " + new Date(body.startedAt).toLocaleTimeString() + ")";
      const deadline = Date.now() + Math.min((body.timeoutMs || 600000) + 30000, 3600000);
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const run = await fetchJson(body.poll).catch(() => null);
        if (!run) continue;
        if (run.status === "running") { out.textContent = "Running… " + Math.round((Date.now() - new Date(run.startedAt).getTime()) / 1000) + "s"; continue; }
        out.className = run.status === "ok" ? "ok" : "warn";
        out.textContent = run.status + " in " + run.durationMs + "ms\\n" + JSON.stringify(run.result ?? run.error, null, 2);
        return;
      }
      out.className = "warn";
      out.textContent = "Still running — check " + body.poll;
    } finally {
      // Deliberately no refreshCron() here: it re-renders the pane from the
      // first job and would wipe the outcome the user just asked for. The
      // last-run badge picks the status up on the next render.
      btn.disabled = false;
    }
  });
  $("deleteJob").addEventListener("click", async () => {
    await fetch(\`/cron/\${encodeURIComponent(job.id)}\`, { method: "DELETE" });
    refreshCron();
  });
}

function openCronComposer() {
  main.innerHTML = \`
    <div class="pane">
      <h2 style="margin-bottom: var(--space-2);">New schedule</h2>
      <p class="ui-muted" style="margin-bottom: var(--space-4);">Use this for one-off reminders, recurring agent pulses, or scheduled prompts. The agent's default pulse runs every 30 min — add custom ones here.</p>
      <form class="form" id="cronForm">
        <div style="margin-bottom: var(--space-3);">
          <label>Type</label>
          <select class="ui-select" name="task">
            <option value="prompt">prompt — runs once, replies to channel</option>
            <option value="autopilot">autopilot — proactive pulse, agent decides if it acts</option>
          </select>
        </div>
        <div style="margin-bottom: var(--space-3);"><label>Name</label><input class="ui-input" name="name" placeholder="morning-brief" required></div>
        <div style="margin-bottom: var(--space-3);">
          <label>Prompt (leave blank for autopilot to use the default review prompt)</label>
          <textarea class="ui-textarea" name="prompt" rows="3" placeholder="For autopilot: optional custom pulse prompt. For prompt: what the agent should run."></textarea>
        </div>
        <div class="ui-row" style="gap: var(--space-2); margin-bottom: var(--space-3);">
          <div class="ui-grow"><label>Delay (seconds)</label><input class="ui-input" name="delaySeconds" type="number" min="30" placeholder="60"></div>
          <div class="ui-grow"><label>Interval (seconds)</label><input class="ui-input" name="intervalSeconds" type="number" min="30" placeholder="600"></div>
          <div class="ui-grow"><label>Daily at</label><input class="ui-input" name="dailyAt" placeholder="09:00"></div>
        </div>
        <div class="ui-row" style="gap: var(--space-2); margin-bottom: var(--space-4);">
          <div class="ui-grow"><label>Channel</label>
            <select class="ui-select" name="channel"><option value="local">local</option><option value="telegram">telegram</option></select>
          </div>
          <div class="ui-grow"><label>Target (chatId)</label><input class="ui-input" name="target" placeholder="123456789"></div>
        </div>
        <button class="ui-btn" type="submit">Schedule</button>
      </form>
    </div>
  \`;
  $("cronForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const obj = Object.fromEntries(fd.entries());
    if (obj.delaySeconds) obj.delaySeconds = Number(obj.delaySeconds);
    if (obj.intervalSeconds) obj.intervalSeconds = Number(obj.intervalSeconds);
    const task = obj.task || "prompt";
    obj.task = task;
    obj.input = {
      prompt: obj.prompt || undefined,
      channel: obj.channel,
      target: obj.target || null,
      agentId: "main"
    };
    delete obj.prompt; delete obj.channel; delete obj.target;
    await postJson("/cron", obj);
    await refreshCron();
  });
}

async function refreshSkills(reload = false) {
  if (reload) await postJson("/skills/reload", {});
  const [skills, suggested] = await Promise.all([
    fetchJson("/skills"),
    fetchJson("/skills/suggested").catch(() => [])
  ]);
  const pendingSuggested = suggested.filter((s) => s.status === "pending");

  sidebarList.innerHTML = "";
  if (pendingSuggested.length > 0) {
    const header = document.createElement("li");
    header.style.color = "var(--accent)";
    header.style.fontSize = "11px";
    header.style.padding = "6px 10px 2px";
    header.textContent = \`✨ Suggested · \${pendingSuggested.length}\`;
    sidebarList.appendChild(header);
    for (const s of pendingSuggested) {
      const li = document.createElement("li");
      li.style.borderLeft = "2px solid var(--accent)";
      const sequenceLabels = Array.isArray(s.sequence?.actions)
        ? s.sequence.actions.map((a) => typeof a === "string" ? a : (a.label ?? a.action ?? a.key))
        : (s.sequence?.apps ?? []);
      li.innerHTML = \`<div class="title">\${escapeHtml(s.proposal.name)}</div><div class="preview">\${escapeHtml(s.proposal.description ?? sequenceLabels.join(" → "))}</div>\`;
      li.addEventListener("click", () => renderSuggestedDetail(s));
      sidebarList.appendChild(li);
    }
    const sep = document.createElement("li");
    sep.style.color = "var(--muted)";
    sep.style.fontSize = "11px";
    sep.style.padding = "10px 10px 2px";
    sep.textContent = "Active";
    sidebarList.appendChild(sep);
  }
  if (skills.length === 0 && pendingSuggested.length === 0) {
    sidebarList.innerHTML = '<li class="empty">No skills loaded</li>';
  }
  for (const s of skills) {
    const li = document.createElement("li");
    li.innerHTML = \`<div class="title">\${escapeHtml(s.name)}</div><div class="preview">\${escapeHtml(s.description ?? "")}</div>\`;
    li.addEventListener("click", () => renderSkillDetail(s));
    sidebarList.appendChild(li);
  }

  if (pendingSuggested.length > 0) renderSuggestedDetail(pendingSuggested[0]);
  else if (skills.length > 0) renderSkillDetail(skills[0]);
  else main.innerHTML = '<div class="pane"><div class="empty">No skills loaded yet. Drop a SKILL.md into <code>.openagi/skills/&lt;name&gt;/</code>, or let the hourly workflow miner surface a repeated routine.</div></div>';
}

function renderSuggestedDetail(candidate) {
  const seq = candidate.sequence ?? {
    count: candidate.cluster?.count ?? 0,
    actions: candidate.cluster?.keywords ?? [],
    apps: []
  };
  const detectedSteps = Array.isArray(seq.actions) && seq.actions.length > 0
    ? seq.actions.map((a) => ({
        label: typeof a === "string" ? a : (a.label ?? a.action ?? a.key),
        apps: typeof a === "string" ? [] : (a.apps ?? [])
      }))
    : (seq.apps ?? []).map((app) => ({ label: app, apps: [] }));
  const horizons = Array.isArray(seq.horizons) ? seq.horizons : [];
  main.innerHTML = \`
    <div class="pane">
      <div class="row" style="gap:6px;margin-bottom:6px;">
        <span class="badge ok">✨ suggested</span>
        <span class="badge">confidence \${(seq.confidence ?? 0).toFixed(2)}</span>
        <span class="badge">\${seq.count}× in last 28d</span>
        <span class="badge">~\${String(seq.startHour ?? 0).padStart(2, "0")}:00</span>
        \${horizons.map((h) => \`<span class="badge">\${escapeHtml(h)}</span>\`).join("")}
      </div>
      <h2>\${escapeHtml(candidate.proposal.name)}</h2>
      <p class="muted">\${escapeHtml(candidate.proposal.description ?? "")}</p>

      <h3>Detected action workflow</h3>
      <div class="row" style="gap:8px;flex-wrap:wrap;">\${detectedSteps.map((step) => \`<span class="chip" style="font-size:13px;padding:6px 12px;">\${escapeHtml(step.label)}\${step.apps.length ? \` <span class="muted">(\${escapeHtml(step.apps.join(" / "))})</span>\` : ""}</span>\`).join('<span class="muted" style="align-self:center;">→</span>')}</div>

      <h3>Proposed skill body</h3>
      <pre style="white-space:pre-wrap;">\${escapeHtml(candidate.proposal.body ?? "")}</pre>

      \${candidate.proposal.scheduleHint ? \`<h3>Suggested schedule</h3><p>\${escapeHtml(candidate.proposal.scheduleHint)}</p>\` : ""}
      \${candidate.proposal.triggerHint ? \`<h3>Suggested interaction trigger</h3><p>\${escapeHtml(typeof candidate.proposal.triggerHint === "string" ? candidate.proposal.triggerHint : JSON.stringify(candidate.proposal.triggerHint))}</p>\` : ""}

      <div class="row" style="gap:8px;margin-top:14px;">
        <button id="acceptSug">✓ Accept — write SKILL.md</button>
        <button class="secondary" id="rejectSug">✗ Reject</button>
      </div>
      <pre id="sugOut" class="ok" style="margin-top:12px;display:none;"></pre>
    </div>
  \`;
  const showOut = (text, cls) => {
    const o = $("sugOut");
    o.style.display = "block";
    o.className = cls === "err" ? "err" : "ok";
    o.textContent = text;
  };
  $("acceptSug").addEventListener("click", async () => {
    try {
      const result = await postJson(\`/skills/suggested/\${encodeURIComponent(candidate.id)}/accept\`, {});
      showOut("Accepted: " + JSON.stringify(result, null, 2));
      setTimeout(() => refreshSkills(true), 800);
    } catch (e) { showOut("[err] " + e.message, "err"); }
  });
  $("rejectSug").addEventListener("click", async () => {
    if (!confirm("Reject this suggestion?")) return;
    await postJson(\`/skills/suggested/\${encodeURIComponent(candidate.id)}/reject\`, {});
    refreshSkills();
  });
}

function renderSkillDetail(skill) {
  main.innerHTML = \`
    <div class="pane">
      <h2 style="margin-bottom: var(--space-2);">\${escapeHtml(skill.name)}</h2>
      <p class="ui-muted" style="margin-bottom: var(--space-4);">\${escapeHtml(skill.description ?? "")}</p>
      <div class="ui-section">
        <div class="ui-section-header"><h3>Run</h3></div>
        <form class="form" id="skillForm">
          <div style="margin-bottom: var(--space-3);">
            <label>Input</label>
            <textarea class="ui-textarea" name="input" rows="3" placeholder="Free-text input"></textarea>
          </div>
          <button class="ui-btn" type="submit">Run skill</button>
        </form>
      </div>
      <div class="ui-section">
        <div class="ui-section-header"><h3>Output</h3></div>
        <pre id="skillOut" class="ok"></pre>
      </div>
    </div>
  \`;
  $("skillForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = e.target.input.value;
    const out = $("skillOut");
    out.textContent = "running…";
    try {
      const res = await postJson(\`/skills/\${encodeURIComponent(skill.name)}/run\`, { input });
      out.textContent = res.output ?? JSON.stringify(res, null, 2);
    } catch (err) {
      out.textContent = "[error] " + err.message;
    }
  });
}

let selectedMcpName = null;
async function refreshMcp() {
  const servers = await fetchJson("/mcp");
  // Preserve scroll position across the full rebuild below — otherwise every
  // SSE "mcp" event (e.g. a connect finishing) snaps the list back to the top.
  const mcpScroller = sidebarList.scrollHeight > sidebarList.clientHeight ? sidebarList : sidebarList.parentElement;
  const mcpSavedScroll = mcpScroller ? mcpScroller.scrollTop : 0;
  sidebarList.innerHTML = "";
  // Always-visible Register button at the top of the MCP sidebar so the
  // user has an unambiguous entry point — separate from the magical
  // tab-aware newBtn at the very top of the sidebar.
  const addItem = document.createElement("li");
  addItem.style.cssText = "border-bottom:1px solid var(--line); padding:8px 10px; cursor:pointer;";
  addItem.innerHTML = '<div class="title" style="color:var(--accent);">+ Register new MCP</div><div class="preview" style="font-size:11px;">stdio · http+bearer · http+oauth</div>';
  addItem.addEventListener("click", () => {
    // Defensive: log + toast on click so even if openMcpComposer
    // throws, the user (and console) sees what happened. Several
    // bug reports about "nothing happens" — instrument so next time
    // it's diagnosable.
    console.log("[OpenAGI] MCP +Register clicked");
    try {
      openMcpComposer();
      console.log("[OpenAGI] openMcpComposer returned, composerOpen =", composerOpen);
    } catch (err) {
      console.error("[OpenAGI] openMcpComposer threw:", err);
      showToast("MCP composer error — check console: " + (err.message || err), false);
    }
  });
  sidebarList.appendChild(addItem);

  if (servers.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "No MCP servers registered yet — click + Register above.";
    sidebarList.appendChild(empty);
  }
  for (const s of servers) {
    const li = document.createElement("li");
    if (s.name === selectedMcpName) li.className = "active";
    // Tool names come off the wire from whatever MCP server was registered —
    // escape them here exactly as renderMcpDetail already does for the same
    // array. This row was the one place the array reached innerHTML raw.
    li.innerHTML = \`<div class="title">\${escapeHtml(s.name)} \${s.connected ? '<span class="badge ok">live</span>' : '<span class="badge">idle</span>'}</div><div class="preview">\${escapeHtml((s.tools ?? []).join(", ")) || "—"}</div>\`;
    li.addEventListener("click", () => {
      selectedMcpName = s.name;
      for (const el of sidebarList.querySelectorAll("li")) el.classList.remove("active");
      li.classList.add("active");
      renderMcpDetail(s);
    });
    sidebarList.appendChild(li);
  }
  // Restore the pre-rebuild scroll position now that the list is repopulated.
  if (mcpScroller) mcpScroller.scrollTop = mcpSavedScroll;
  // Show a hero "Register your first MCP" CTA in the main pane when empty.
  if (servers.length === 0) {
    main.innerHTML = \`
      <div class="pane">
        <h2>No MCP servers yet</h2>
        <p>MCP (Model Context Protocol) servers give the agent extra tools — connect Linear, GitHub, your filesystem, etc.</p>
        <p>Click the <strong>+ Register new MCP</strong> button on the left, or use a known catalog suggestion the proactive observer surfaces.</p>
        <button id="emptyRegBtn" style="margin-top:12px;">+ Register new MCP</button>
      </div>
    \`;
    document.getElementById("emptyRegBtn")?.addEventListener("click", () => openMcpComposer());
  } else {
    // Keep the user on the server they're working with — otherwise every SSE
    // refresh (e.g. a connect finishing) snaps the pane back to servers[0],
    // hiding the OAuth banner of the server they actually clicked Connect on.
    const sel = servers.find((s) => s.name === selectedMcpName) || servers[0];
    selectedMcpName = sel.name;
    renderMcpDetail(sel);
  }
}

function renderMcpDetail(server) {
  selectedMcpName = server.name;
  const transportLabel = server.transport === "http" ? \`http · \${escapeHtml(server.auth || "none")}\` : escapeHtml(server.transport);
  const endpoint = server.transport === "http"
    ? \`<pre>\${escapeHtml(server.url || "(no url)")}</pre>\`
    : \`<pre>\${escapeHtml((server.command ?? "—") + " " + (server.args ?? []).join(" "))}</pre>\`;
  const oauthBanner = server.pendingAuthUrl
    ? \`<div class="card warn-banner"><div class="row between" style="align-items:center;">
        <div><span class="name">⚠ OAuth required</span><div class="desc">Click below to authorize this server in your browser. The dashboard will refresh once it's done.</div></div>
        <a class="btn-primary" href="\${escapeHtml(server.pendingAuthUrl)}" target="_blank" rel="noopener">Open in browser</a>
       </div></div>\`
    : "";
  const connectingBanner = server.connecting && !server.connected
    ? \`<div class="card"><div class="row" style="align-items:center; gap:10px; flex-wrap:wrap;"><span class="name">⏳ Connecting…</span><span class="muted" style="flex:1; min-width:0;">waiting for handshake</span></div></div>\`
    : "";
  const errorBanner = server.lastError && !server.connecting && !server.connected
    ? \`<div class="card err"><div class="name">Connection failed</div><div class="desc">\${escapeHtml(server.lastError)}</div></div>\`
    : "";
  main.innerHTML = \`
    <div class="pane">
      <h2>\${escapeHtml(server.name)}</h2>
      <div class="row" style="gap: 6px;flex-wrap:wrap;">
        <span class="badge \${server.connected ? 'ok' : ''}">\${server.connected ? "connected" : "disconnected"}</span>
        <span class="badge">trust: \${escapeHtml(server.trustLevel)}</span>
        <span class="badge">transport: \${transportLabel}</span>
        \${server.auth === "oauth" ? \`<span class="badge \${server.authenticated ? 'ok' : ''}">\${server.authenticated ? "authorized" : "not authorized"}</span>\` : ""}
        \${server.pendingAuthUrl ? '<span class="badge warn">awaiting auth</span>' : ""}
      </div>
      \${oauthBanner}
      \${connectingBanner}
      \${errorBanner}
      <h3>Endpoint</h3>
      \${endpoint}
      <h3>Tools</h3>
      <pre>\${escapeHtml((server.tools ?? []).join("\\n") || "(none — connect to discover)")}</pre>
      <div class="row" style="gap: 8px; margin-top: 12px;flex-wrap:wrap;">
        <button id="connBtn" \${server.connecting ? "disabled" : ""}>\${server.connected ? "Disconnect" : "Connect"}</button>
        \${server.transport === "http" && server.auth === "oauth" ? \`<button class="secondary" id="clearAuthBtn">Forget login</button>\` : ""}
        <button class="secondary" id="callBtn">Call tool…</button>
      </div>
      <pre id="mcpOut" class="ok" style="margin-top: 12px;"></pre>
    </div>
  \`;
  $("connBtn").addEventListener("click", async () => {
    const path = server.connected ? "disconnect" : "connect";
    try {
      const res = await postJson(\`/mcp/\${path}/\${encodeURIComponent(server.name)}\`, {});
      $("mcpOut").textContent = res.status === "connecting" ? "Connecting in background — watch this page for the auth URL or tool list." : JSON.stringify(res, null, 2);
      refreshMcp();
    } catch (err) {
      $("mcpOut").textContent = "[error] " + err.message;
    }
  });
  const clearBtn = $("clearAuthBtn");
  if (clearBtn) clearBtn.addEventListener("click", async () => {
    if (!confirm("Disconnect " + server.name + " and forget its saved OAuth login? You can connect and authorize it again later.")) return;
    try {
      await postJson(\`/mcp/clear-auth/\${encodeURIComponent(server.name)}\`, {});
      showToast("Login forgotten. The integration is disconnected.", true);
      refreshMcp();
    } catch (error) {
      showToast("Could not forget login: " + error.message, false);
    }
  });
  $("callBtn").addEventListener("click", () => {
    const tool = prompt("Tool name?");
    if (!tool) return;
    const args = prompt("JSON args?", "{}");
    postJson("/mcp/call", { server: server.name, tool, args: JSON.parse(args || "{}") })
      .then((r) => $("mcpOut").textContent = JSON.stringify(r, null, 2))
      .catch((e) => $("mcpOut").textContent = "[error] " + e.message);
  });
}

let composerOpen = false;
function openMcpComposer() {
  composerOpen = true;
  main.innerHTML = \`
    <div class="pane">
      <h2 style="margin-bottom: var(--space-2);">Register MCP server</h2>
      <p class="ui-muted" style="margin-bottom: var(--space-4);">For one-click hosted MCPs (Stripe, GitHub, Linear, etc) use the <a href="/?tab=integrations">Integrations</a> catalog. This form is for custom servers — stdio processes or hosted URLs not in the catalog.</p>
      <form class="form" id="mcpForm">
        <div class="ui-section" style="margin-top: 0;">
          <div class="ui-section-header"><h3>Transport</h3></div>
          <div class="grid" style="grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));">
            <label class="opt"><input type="radio" name="kind" value="stdio" checked> <span><strong>stdio</strong><br><span class="ui-meta">spawn a local process</span></span></label>
            <label class="opt"><input type="radio" name="kind" value="http-oauth"> <span><strong>http + OAuth</strong><br><span class="ui-meta">hosted with browser auth</span></span></label>
            <label class="opt"><input type="radio" name="kind" value="http-bearer"> <span><strong>http + bearer</strong><br><span class="ui-meta">hosted with static API key</span></span></label>
          </div>
        </div>

        <div class="ui-section">
          <div class="ui-section-header"><h3>Server</h3></div>
          <div style="margin-bottom: var(--space-3);">
            <label>Name</label>
            <input class="ui-input" name="name" placeholder="e.g. filesystem" required>
          </div>

          <div data-kind="stdio" style="margin-bottom: var(--space-3);">
            <label>Command</label>
            <input class="ui-input" name="command" placeholder="npx">
          </div>
          <div data-kind="stdio">
            <label>Args (one per line)</label>
            <textarea class="ui-textarea" name="args" rows="3" placeholder="-y&#10;@modelcontextprotocol/server-filesystem&#10;/tmp"></textarea>
          </div>

          <div data-kind="http-oauth http-bearer" style="margin-bottom: var(--space-3);">
            <label>URL</label>
            <input class="ui-input" name="url" placeholder="https://mcp.example.com/mcp">
          </div>
          <div data-kind="http-bearer">
            <label>API key (or \\\${ENV_VAR})</label>
            <input class="ui-input" name="apiKey" placeholder="\\\${MY_MCP_KEY}">
          </div>
          <div data-kind="http-oauth" style="margin-bottom: var(--space-3);">
            <label>Pre-registered Client ID <span class="ui-meta">· optional, only if your auth server doesn't support dynamic registration</span></label>
            <input class="ui-input" name="clientId" placeholder="\\\${OAUTH_CLIENT_ID} or literal">
          </div>
          <div data-kind="http-oauth">
            <label>Client secret <span class="ui-meta">· optional, only for confidential clients</span></label>
            <input class="ui-input" type="password" name="clientSecret" autocomplete="off">
          </div>
        </div>

        <div class="ui-section">
          <div class="ui-section-header"><h3>Trust level</h3></div>
          <select class="ui-select" name="trustLevel">
            <option>trusted</option>
            <option>untrusted</option>
          </select>
          <div class="ui-meta" style="margin-top: var(--space-1);">Trusted servers can be called automatically; untrusted require explicit approval per call.</div>
        </div>

        <div class="ui-row" style="margin-top: var(--space-4);">
          <button class="ui-btn" type="submit" id="registerSubmit">Register</button>
          <button class="ui-btn ui-btn-ghost" type="button" id="cancelBtn">Cancel</button>
        </div>
        <pre id="mcpRegOut" class="ok" style="display:none;margin-top: var(--space-3);"></pre>
      </form>
    </div>
  \`;
  const showOut = (text, cls) => {
    const el = $("mcpRegOut");
    el.style.display = "block";
    el.className = cls === "err" ? "err" : "ok";
    el.textContent = text;
  };
  const updateKindVisibility = () => {
    const checked = document.querySelector('#mcpForm input[name="kind"]:checked');
    const kind = checked ? checked.value : "stdio";
    document.querySelectorAll("[data-kind]").forEach((el) => {
      el.style.display = el.dataset.kind.split(" ").includes(kind) ? "" : "none";
    });
  };
  document.querySelectorAll('#mcpForm input[name="kind"]').forEach((r) =>
    r.addEventListener("change", updateKindVisibility));
  updateKindVisibility();
  $("cancelBtn").addEventListener("click", () => { composerOpen = false; refreshMcp(); });

  // Defense in depth: bind both the form submit AND a direct click on the
  // Register button. Some environments (older Safari, browser extensions
  // intercepting forms) suppress the submit event; the click fallback uses
  // requestSubmit() which still triggers our handler if it's wired, and
  // falls back to invoking the same logic directly otherwise.
  const submitForm = async (e) => {
    if (e) e.preventDefault();
    const formEl = $("mcpForm");
    if (!formEl) return;
    if (formEl.dataset.submitting === "1") return;
    formEl.dataset.submitting = "1";
    const fd = new FormData(formEl);
    const kind = fd.get("kind") || "stdio";
    const body = {
      name: (fd.get("name") || "").trim(),
      trustLevel: fd.get("trustLevel") || "trusted"
    };
    if (kind === "stdio") {
      body.command = (fd.get("command") || "").trim();
      body.args = (fd.get("args") || "").split("\\n").map((s) => s.trim()).filter(Boolean);
    } else if (kind === "http-oauth") {
      body.url = (fd.get("url") || "").trim();
      body.auth = "oauth";
      const clientId = (fd.get("clientId") || "").trim();
      const clientSecret = (fd.get("clientSecret") || "").trim();
      if (clientId) body.clientId = clientId;
      if (clientSecret) body.clientSecret = clientSecret;
    } else if (kind === "http-bearer") {
      body.url = (fd.get("url") || "").trim();
      body.auth = "bearer";
      body.apiKey = (fd.get("apiKey") || "").trim();
    }
    const reset = () => { formEl.dataset.submitting = ""; };
    if (!body.name) { showOut("name is required", "err"); reset(); return; }
    if (kind === "stdio" && !body.command) { showOut("command is required for stdio", "err"); reset(); return; }
    if ((kind === "http-oauth" || kind === "http-bearer") && !body.url) { showOut("url is required for http", "err"); reset(); return; }
    if (kind === "http-bearer" && !body.apiKey) { showOut("apiKey is required for http+bearer", "err"); reset(); return; }

    const btn = $("registerSubmit");
    btn.disabled = true;
    btn.textContent = "Registering…";
    try {
      const result = await postJson("/mcp/register", body);
      // Registration is approval-gated now (SEC-5) — say so, rather than
      // claiming "Registered ✓" for something that has not run yet.
      if (result && result.status === "awaiting_confirmation") {
        const dropped = (result.droppedFields ?? []).length
          ? "\\nNot carried through approval: " + result.droppedFields.join(", ") + " — set these in mcp.json / .env."
          : "";
        showOut("Queued for approval — open the Approvals card and confirm it." + dropped);
      } else {
        showOut("Registered ✓ — " + JSON.stringify(result, null, 2));
      }
      composerOpen = false;
      setTimeout(() => refreshMcp(), 600);
    } catch (err) {
      showOut("Registration failed: " + (err.message || String(err)), "err");
      btn.disabled = false;
      btn.textContent = "Register";
      reset();
    }
  };
  $("mcpForm").addEventListener("submit", submitForm);
  $("registerSubmit").addEventListener("click", (e) => {
    // If the button is type=submit inside a form, the browser will fire
    // submit on its own — but if anything intercepts that path, this
    // explicit click handler still drives the registration.
    if (e.defaultPrevented) return;
    const f = $("mcpForm");
    if (!f) return;
    if (typeof f.requestSubmit === "function") {
      e.preventDefault();
      f.requestSubmit();
    } else {
      submitForm(e);
    }
  });
}

async function renderAgents() {
  const agents = await fetchJson("/agents");
  main.innerHTML = '<div class="pane"><h2>Agents</h2><div class="grid" id="agentList"></div></div>';
  const list = $("agentList");
  for (const a of agents) {
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = \`<div class="row between"><span class="name">\${escapeHtml(a.name)}</span><span class="badge">\${escapeHtml(a.role)}</span></div><div class="desc">\${escapeHtml(a.scope || a.systemPrompt || "—")}</div>\`;
    list.appendChild(card);
  }
}

async function renderMemory() {
  const snap = await fetchJson("/memory");
  state.memorySnap = snap;
  if (!state.memoryFilter) state.memoryFilter = { tier: "all", query: "" };
  renderMemoryView();
}

function renderMemoryView() {
  const snap = state.memorySnap || { short: [], medium: [], long: [] };
  const f = state.memoryFilter;
  const counts = { short: snap.short.length, medium: snap.medium.length, long: snap.long.length };
  const total = counts.short + counts.medium + counts.long;
  const principles = snap.long.filter((m) => m.kind === "principle").length;

  main.innerHTML = \`
    <div class="pane">
      <div class="row between" style="margin-bottom:14px;align-items:center;flex-wrap:wrap;gap:10px;">
        <h2 style="margin:0;">Memory <span class="muted" style="font-weight:400;font-size:14px;">· \${total} total · \${principles} principle\${principles===1?"":"s"}\${uiHelp("Principles are durable rules promoted from repeated raw memories. They live in long-tier and resist decay.")}</span></h2>
      </div>
      <div id="memoryPageChat"></div>
      <div class="row" style="gap:10px;align-items:center;margin-bottom:14px;flex-wrap:wrap;">
        <div class="tier-pills">
          <button data-tier="all" class="\${f.tier==='all'?'active':''}">All <span class="count">\${total}</span></button>
          <button data-tier="short" class="\${f.tier==='short'?'active':''}" title="RAM — what you need right now. Decays fastest.">Short <span class="count">\${counts.short}</span></button>
          <button data-tier="medium" class="\${f.tier==='medium'?'active':''}" title="Day-to-day. Promoted from short-tier when repeated; demoted to long if it sticks.">Medium <span class="count">\${counts.medium}</span></button>
          <button data-tier="long" class="\${f.tier==='long'?'active':''}" title="Lava — durable truths. Raw items + condensed principles that survived multiple reinforcements.">Long <span class="count">\${counts.long}</span></button>
        </div>
        <input type="search" id="memSearch" placeholder="search content or tags…" value="\${escapeHtml(f.query)}" style="flex:1;min-width:240px;">
      </div>
      <div class="mem-grid" id="memList"></div>
    </div>
  \`;
  renderPageChatComposer(document.getElementById("memoryPageChat"), {
    placeholder: 'e.g. "Remember that my standup is 9am Mondays" or "what do I remember about Sarah?"',
    onAfterSend: async () => {
      // Reply may have caused a remember/recall — refresh the snapshot.
      const snap = await fetchJson("/memory");
      state.memorySnap = snap;
      renderMemoryView();
    }
  });
  document.querySelectorAll("[data-tier]").forEach((b) =>
    b.addEventListener("click", () => { state.memoryFilter.tier = b.dataset.tier; renderMemoryView(); })
  );
  const search = $("memSearch");
  if (search) {
    search.addEventListener("input", (e) => {
      state.memoryFilter.query = e.target.value;
      fillMemoryGrid();
    });
  }
  fillMemoryGrid();
}

function fillMemoryGrid() {
  const snap = state.memorySnap || {};
  const f = state.memoryFilter;
  const list = $("memList");
  if (!list) return;

  let items = [];
  if (f.tier === "all" || f.tier === "short") items = items.concat((snap.short ?? []).map((m) => ({ ...m, _tier: "short" })));
  if (f.tier === "all" || f.tier === "medium") items = items.concat((snap.medium ?? []).map((m) => ({ ...m, _tier: "medium" })));
  if (f.tier === "all" || f.tier === "long") items = items.concat((snap.long ?? []).map((m) => ({ ...m, _tier: "long" })));

  if (f.query) {
    const q = f.query.toLowerCase();
    items = items.filter((m) =>
      (m.content || "").toLowerCase().includes(q) ||
      (m.tags || []).some((t) => String(t).toLowerCase().includes(q))
    );
  }

  items.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));

  if (items.length === 0) {
    list.innerHTML = '<div class="empty">No memory items match this filter.</div>';
    return;
  }

  list.innerHTML = items.map((m) => {
    const tags = (m.tags || []).slice(0, 6).map((t) => \`<span class="chip">\${escapeHtml(t)}</span>\`).join("");
    const kindBadge = m.kind === "principle" ? '<span class="badge ok">principle</span>' : "";
    const dangerBadge = (m.dangerLevel || 0) > 0.7 ? '<span class="badge err">⚠ danger</span>' : "";
    const scopeBadge = m.scope && m.scope !== "main" ? \`<span class="badge">\${escapeHtml(m.scope)}</span>\` : "";
    const age = m.createdAt ? timeAgo(m.createdAt) : "";
    return \`
      <div class="mem-card tier-\${m._tier}">
        <div class="mem-head">
          <span class="badge tier-\${m._tier}">\${m._tier}</span>
          \${kindBadge}\${dangerBadge}\${scopeBadge}
          <span class="badge">str \${(m.strength ?? 0).toFixed(2)}</span>
          <span class="mem-age">\${escapeHtml(age)}</span>
        </div>
        <div class="mem-content">\${escapeHtml(m.content || "")}</div>
        \${tags ? \`<div class="mem-tags">\${tags}</div>\` : ""}
      </div>
    \`;
  }).join("");
}

function timeAgo(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60000) return "just now";
  if (ms < 3600000) return Math.floor(ms / 60000) + "m ago";
  if (ms < 86400000) return Math.floor(ms / 3600000) + "h ago";
  return Math.floor(ms / 86400000) + "d ago";
}

// Status is a claim about right now, so every one of these is either measured
// (this machine is answering; the main just accepted or refused a connection)
// or derived from a timestamp we are showing next to it. "unreachable" is
// deliberately distinct from "offline": offline is an inference from an old
// heartbeat, unreachable is a connection we just tried and failed to make.
const NODE_STATUS = {
  online:      { badge: "ok",    label: "online" },
  offline:     { badge: "warn",  label: "offline" },
  unreachable: { badge: "err",   label: "unreachable" },
  unknown:     { badge: "muted", label: "unknown" }
};

// A service's liveness is a PROBE, not a heartbeat, so it gets its own
// vocabulary rather than borrowing "online/offline" — those words mean "a
// machine did or did not check in", and nothing here ever checks in.
const SERVICE_REACHABILITY = {
  reachable:         { badge: "ok",    label: "reachable" },
  unreachable:       { badge: "err",   label: "unreachable" },
  unknown:           { badge: "muted", label: "unknown" },
  "not-configured":  { badge: "muted", label: "not configured" }
};

function nodeBuildLabel(n) {
  if (!n.build) return "unknown";
  const origin = { git: "commit", "app-bundle": "build", env: "build" }[n.buildSource];
  return origin ? origin + " " + n.build : n.build;
}

let nodesRenderPromise = null;
let nodesRefreshTimer = null;

// Keep topology reasonably fresh without polling a panel the user cannot see.
// Re-entering the browser tab gets an immediate refresh; the 30-second timer
// exists only while both the Nodes app tab and this document are visible.
function syncNodesAutoRefresh() {
  if (nodesRefreshTimer) {
    clearInterval(nodesRefreshTimer);
    nodesRefreshTimer = null;
  }
  if (state.tab === "nodes" && !document.hidden) {
    nodesRefreshTimer = setInterval(() => {
      renderNodes({ showLoading: false });
    }, 30_000);
  }
}

document.addEventListener("visibilitychange", () => {
  syncNodesAutoRefresh();
  if (state.tab === "nodes" && !document.hidden) {
    renderNodes({ showLoading: false });
  }
});

// A slow main can make several refresh triggers coincide (tab entry, timer,
// visibility, and the button). Share one promise so those triggers produce one
// request and a late response cannot overwrite a different app tab.
function renderNodes(options = {}) {
  if (nodesRenderPromise) return nodesRenderPromise;
  let request;
  request = renderNodesOnce(options).finally(() => {
    if (nodesRenderPromise === request) nodesRenderPromise = null;
  });
  nodesRenderPromise = request;
  return request;
}

async function renderNodesOnce({ showLoading = true } = {}) {
  if (state.tab !== "nodes") return;
  if (showLoading) {
    main.innerHTML = \`
      <div class="pane" aria-busy="true">
        <h2>Nodes</h2>
        <div class="card"><div class="name">Loading nodes…</div><div class="desc">Checking this machine, paired installs, and connected services.</div></div>
      </div>
    \`;
  } else {
    const refresh = document.getElementById("nodesRefresh");
    if (refresh) {
      refresh.disabled = true;
      refresh.textContent = "Checking…";
    }
  }

  let data;
  try {
    data = await fetchJson("/nodes");
  } catch (error) {
    if (state.tab !== "nodes") return;
    main.innerHTML = \`
      <div class="pane">
        <h2>Nodes</h2>
        <div class="card">
          <div class="name err">Couldn't load nodes</div>
          <div class="desc">\${escapeHtml(error?.message ?? String(error))}</div>
          <div class="row" style="margin-top:8px;"><button id="nodesRetry">Try again</button></div>
        </div>
      </div>
    \`;
    document.getElementById("nodesRetry")?.addEventListener("click", () => renderNodes());
    return;
  }
  if (state.tab !== "nodes") return;
  const self = data.self ?? {};
  const nodes = Array.isArray(data.nodes) ? data.nodes : [];
  const isNode = self.role === "node";

  // The default experience when a main is down is this banner, not the table,
  // so it has to say three things plainly: we could not reach it, why, and
  // how old the rows below actually are.
  const banner = data.stale
    ? \`<div class="card warn-banner">
         <div class="name warn">Can't reach the main — showing what I last knew</div>
         <div class="desc">
           <code>\${escapeHtml(self.pairedTo ?? "")}</code> did not answer\${data.unreachableReason ? " (" + escapeHtml(data.unreachableReason) + ")" : ""}.
           \${data.cachedAt
             ? "Everything below except this machine is from " + escapeHtml(new Date(data.cachedAt).toLocaleString()) + " (" + escapeHtml(timeAgo(data.cachedAt)) + ") and may have changed since."
             : "This machine has never reached that main, so all it knows is that the pairing exists."}
         </div>
       </div>\`
    : "";

  const rows = nodes.map((n) => {
    const s = NODE_STATUS[n.status] ?? NODE_STATUS.unknown;
    // Only rows we are recalling get an "as of" — a measured status (this
    // machine, or a main we just failed to open a connection to) is true now,
    // and dating it would imply doubt we don't have.
    const recalled = n.statusBasis === "cached";
    const asOf = recalled && n.statusAsOf
      ? \`<div class="sub">as of \${escapeHtml(timeAgo(n.statusAsOf))}</div>\`
      : "";
    const seen = n.lastSeenAt
      ? escapeHtml(timeAgo(n.lastSeenAt)) + \`<div class="sub">\${escapeHtml(new Date(n.lastSeenAt).toLocaleString())}</div>\`
      : \`<span class="sub">never\${n.role === "main" ? " reached" : " heard from"}</span>\`;
    // A version read out of a cache we can no longer refresh does not support
    // the claim "up to date" — that machine may have been updated, or fallen
    // further behind, in the meantime. Only this machine's own version is
    // known to be current while the main is unreachable.
    const versionIsCurrent = !data.stale || n.self;
    const howToUpdate = n.updateCommand
      ? \`<div class="sub"><code>\${escapeHtml(n.updateCommand)}</code></div>\`
      : \`<div class="sub">run <code>openagi update</code> on that machine</div>\`;
    let update;
    if (n.behind) {
      update = \`<span class="badge warn">behind\${data.newestVersion ? " " + escapeHtml(data.newestVersion) : ""}</span>\`
        + (versionIsCurrent ? "" : \`<div class="sub">as of \${escapeHtml(timeAgo(data.cachedAt))}</div>\`)
        + howToUpdate;
    } else if (!n.version) {
      update = \`<span class="sub">version unknown</span>\`;
    } else if (versionIsCurrent) {
      update = \`<span class="sub">up to date</span>\`;
    } else {
      update = \`<span class="sub">last known \${escapeHtml(n.version)}\${data.cachedAt ? " (" + escapeHtml(timeAgo(data.cachedAt)) + ")" : ""} — can't verify now</span>\`;
    }
    const revoke = !isNode && !n.self
      ? \`<div style="margin-top:6px;"><button class="ui-btn ui-btn-destructive ui-btn-sm" data-revoke-node="\${escapeHtml(n.nodeId)}">Remove node</button></div>\`
      : "";
    const capabilityLabels = { "computer-use": "Computer use", "imessage-search": "iMessage search" };
    const capabilities = (Array.isArray(n.capabilities) ? n.capabilities : []).map((capability) => {
      const label = capabilityLabels[capability.id] ?? String(capability.id ?? "capability").replaceAll("-", " ");
      const stateLabel = capability.ready === true ? "ready" : "not ready";
      const stateClass = capability.ready === true ? "ok" : "warn";
      const operations = Array.isArray(capability.operations) && capability.operations.length
        ? \` · \${escapeHtml(capability.operations.join(", "))}\`
        : "";
      const detail = capability.detail ? \` · \${escapeHtml(capability.detail)}\` : "";
      return \`<div class="sub"><span class="badge \${stateClass}">\${escapeHtml(label)}: \${stateLabel}</span>\${operations}\${detail}</div>\`;
    }).join("");
    return \`
      <tr>
        <td>\${escapeHtml(n.name ?? "unknown")}\${n.self ? \` <span class="badge">this machine</span>\` : ""}\${n.staleRegistration ? \` <span class="badge muted" title="Same hostname as this machine but a different node id — an earlier install that never checked in again.">old registration</span>\` : ""}\${n.url ? \`<div class="sub">\${escapeHtml(n.url)}</div>\` : ""}\${capabilities}</td>
        <td>\${escapeHtml(n.role)}</td>
        <td><span class="badge \${s.badge}">\${escapeHtml(s.label)}</span>\${asOf}</td>
        <td>\${seen}</td>
        <td>\${escapeHtml(n.version ?? "unknown")}<div class="sub">\${escapeHtml(nodeBuildLabel(n))}</div></td>
        <td>\${update}\${revoke}</td>
      </tr>\`;
  }).join("");

  // Service nodes: machines that do work for this installation without being
  // installs themselves (for example, a host that serves iMessage search).
  // They sit in the SAME table so the whole topology reads as one thing, but every column
  // that only means something for a peer says so instead of being left blank —
  // a service has no heartbeat, no version and nothing to update.
  const services = Array.isArray(data.services) ? data.services : [];
  const connected = services.filter((s) => s.configured);
  const notConnected = services.filter((s) => !s.configured);

  const serviceRows = connected.map((s) => {
    // Own-property lookup, not a bare index: "constructor"/"__proto__" reach
    // Object.prototype and would sail past a nullish-coalescing fallback,
    // putting the word undefined into a class attribute. reachability arrives
    // over the wire from the main, so it is not ours to trust.
    const r = (Object.prototype.hasOwnProperty.call(SERVICE_REACHABILITY, s.reachability)
      && SERVICE_REACHABILITY[s.reachability]) || SERVICE_REACHABILITY.unknown;
    // How we know, in the user's terms. "live" is the only phrasing that gets
    // to imply "right now"; everything else is dated, including a result this
    // machine merely heard about from the main. A verdict with no usable
    // timestamp cannot be dated at all — say that, rather than letting
    // timeAgo(null) turn the unix epoch into "20000d ago".
    const when = s.checkedAt ? escapeHtml(timeAgo(s.checkedAt)) : "at an unknown time";
    let how;
    if (s.checkBasis === "live") how = "checked just now";
    else if (s.checkBasis === "cached") how = "checked " + when + " (cached)";
    else if (s.checkBasis === "reported") {
      how = "checked by " + escapeHtml(s.originName ?? "the main") + " " + when;
    } else how = "not checked yet";
    const where = s.origin === "main"
      ? \`<div class="sub">configured on \${escapeHtml(s.originName ?? "the main")}</div>\`
      : \`<div class="sub">configured on this machine</div>\`;
    return \`
      <tr>
        <td>\${escapeHtml(s.name ?? s.id ?? "service")}\${s.host ? \`<div class="sub">\${escapeHtml(s.host)}</div>\` : ""}\${s.purpose ? \`<div class="sub">\${escapeHtml(s.purpose)}</div>\` : ""}</td>
        <td>service\${where}</td>
        <td><span class="badge \${r.badge}">\${escapeHtml(r.label)}</span><div class="sub">\${how}</div>\${s.detail ? \`<div class="sub">\${escapeHtml(s.detail)}</div>\` : ""}</td>
        <td><span class="sub">n/a<div class="sub">probed, never heartbeats</div></span></td>
        <td><span class="sub">n/a<div class="sub">not an OpenAGI install</div></span></td>
        <td><span class="sub">managed on that machine</span></td>
      </tr>\`;
  }).join("");

  const notConnectedNote = notConnected.length
    ? \`<div class="sub" style="margin-top:8px;">Not connected: \${notConnected
        .map((s) => escapeHtml(s.name ?? s.id) + (s.detail ? " — " + escapeHtml(s.detail) : ""))
        .join(" · ")}</div>\`
    : "";

  // A version alone can't answer "is this up to date" — package.json has
  // drifted behind the release tags — so the build identity is always shown
  // next to it, and is the literal word "unknown" when it can't be determined.
  const selfBuild = self.build
    ? escapeHtml(nodeBuildLabel(self)) + " · " + escapeHtml(self.buildSource ?? "")
    : "build unknown — this install can't identify which commit it is running";

  main.innerHTML = \`
    <div class="pane">
      <h2>Nodes</h2>
      <div class="card">
        <div class="name">\${escapeHtml(self.name ?? "this machine")} <span class="badge">this machine</span> <span class="badge">\${isNode ? "node" : "main"}</span></div>
        <div class="desc">\${isNode
          ? "Paired to <code>" + escapeHtml(self.pairedTo ?? "") + "</code> — this machine heartbeats to that main."
          : "This machine is a main — other nodes heartbeat to it."}</div>
        <div class="desc">Version \${escapeHtml(self.version ?? "unknown")} · \${selfBuild}</div>
        \${self.packageVersion && self.packageVersion !== self.version
          ? \`<div class="sub">package.json says \${escapeHtml(self.packageVersion)}; the running build reports \${escapeHtml(self.version)}.</div>\`
          : ""}
        <div class="row" style="margin-top:8px;"><button id="nodesRefresh">Re-check now</button></div>
      </div>
      \${banner}
      <div class="desc" style="margin-top:12px;">
        Everything this installation talks to. <b>main</b> is the machine that holds the
        brain; <b>node</b>s are OpenAGI installs paired to it that check in every 30s;
        <b>service</b>s are machines that do one job for it (and never check in, so their
        row is a live probe, not a memory).
      </div>
      <div style="overflow-x:auto; margin-top:8px;">
        <table style="width:100%; border-collapse:collapse; text-align:left;">
          <thead><tr>
            <th>Machine or service</th><th>Role</th><th>Status</th><th>Last seen</th><th>Version</th><th>Update</th>
          </tr></thead>
          <tbody>\${rows}\${serviceRows}</tbody>
        </table>
      </div>
      \${notConnectedNote}
      <div class="desc" style="margin-top:12px;">
        OpenAGI does not push code to your machines. To update one, run
        <code>\${escapeHtml(data.updateCommand ?? "openagi update")}</code> on that machine
        (or <code>scripts/update.sh</code>); on macOS the app updates itself via Sparkle.
        Addresses reported by other nodes are shown for identification only — this page
        will not build a command that sends your token to one, and never renders the
        credential a service is configured with.
      </div>
    </div>
  \`;
  main.querySelectorAll("table th, table td").forEach((c) => {
    c.style.padding = "6px 10px";
    c.style.borderBottom = "1px solid var(--line)";
    c.style.verticalAlign = "top";
  });
  document.getElementById("nodesRefresh")?.addEventListener("click", () => renderNodes({ showLoading: false }));
  main.querySelectorAll("[data-revoke-node]").forEach((button) => {
    button.addEventListener("click", async () => {
      const nodeId = button.getAttribute("data-revoke-node");
      if (!nodeId || !confirm("Remove this node and revoke its control credential? It must be paired again before reconnecting.")) return;
      const response = await fetch(\`/nodes/\${encodeURIComponent(nodeId)}/revoke\`, { method: "POST", credentials: "include" });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        showToast("Couldn't remove node: " + (body.error || response.status), false);
        return;
      }
      showToast("Node removed and credential revoked.", true);
      renderNodes({ showLoading: false });
    });
  });
}

async function renderChannels() {
  const ch = await fetchJson("/channels");
  const bbWebhookLine = ch.buildBetterWebhook
    ? \`<div class="desc" style="margin-top:6px;">BuildBetter webhook: <code>\${escapeHtml(ch.buildBetterWebhook)}</code> <span class="sub">— paste into BuildBetter to sync calls instantly</span></div>\`
    : (ch.publicUrl ? \`<div class="desc" style="margin-top:6px;" class="sub">BuildBetter webhook: set <code>BUILDBETTER_WEBHOOK_SECRET</code> to enable instant call sync.</div>\` : "");
  const tunnelBlock = ch.publicUrl
    ? \`<div class="card"><div class="name">Public URL</div><div class="desc"><code>\${escapeHtml(ch.publicUrl)}</code></div>\${bbWebhookLine}</div>\`
    : \`<div class="card"><div class="name warn">No public URL</div><div class="desc">Run <code>npm run tunnel</code>, then set <code>OPENAGI_PUBLIC_URL</code> in .openagi/.env and restart.</div></div>\`;
  main.innerHTML = \`
    <div class="pane">
      <h2>Channels</h2>
      \${tunnelBlock}
      <div class="grid two" style="margin-top:12px;">
        <div class="card"><div class="name">Local · \${ch.local?.mode ?? ""}</div><div class="desc">Browser HTTP + SSE.</div></div>
        <div class="card"><div class="name">Telegram</div><div class="desc">\${ch.telegram?.configured ? "configured" : "no token"} · polling: \${ch.telegram?.polling ? "on" : "off"}</div></div>
      </div>
    </div>
  \`;
}

async function renderBudget() {
  const b = await fetchJson("/budget");
  const pct = Math.min(100, (b.spentUsd / Math.max(b.dailyUsdLimit, 0.0001)) * 100);
  const stateClass = pct > 90 ? "err" : pct > 70 ? "warn" : "ok";
  main.innerHTML = \`
    <div class="pane">
      <h2>Credits</h2>
      <div class="card">
        <div class="row between" style="align-items:center;">
          <span class="name">Today · \${escapeHtml(b.today)}</span>
          <span class="badge \${stateClass}">\${pct.toFixed(0)}% of limit</span>
        </div>
        <div style="margin-top:10px;height:8px;background:var(--panel-2);border-radius:4px;overflow:hidden;">
          <div style="width:\${pct}%;height:100%;background:var(--accent);transition:width .3s;"></div>
        </div>
      </div>

      <h3>Today</h3>
      <div class="grid stats">
        <div class="card"><span class="desc">Spent</span><div class="stat-value">$\${b.spentUsd.toFixed(4)}</div></div>
        <div class="card"><span class="desc">Remaining</span><div class="stat-value">$\${b.remainingUsd.toFixed(4)}</div></div>
        <div class="card"><span class="desc">Daily limit</span><div class="stat-value">$\${b.dailyUsdLimit.toFixed(2)}</div></div>
        <div class="card"><span class="desc">Calls</span><div class="stat-value">\${b.calls}</div></div>
        <div class="card"><span class="desc">Input tokens</span><div class="stat-value">\${b.tokens.input.toLocaleString()}</div></div>
        <div class="card"><span class="desc">Output tokens</span><div class="stat-value">\${b.tokens.output.toLocaleString()}</div></div>
        <div class="card"><span class="desc">Cache read</span><div class="stat-value">\${b.tokens.cacheRead.toLocaleString()}</div></div>
        <div class="card"><span class="desc">Cache write</span><div class="stat-value">\${b.tokens.cacheWrite.toLocaleString()}</div></div>
      </div>

      <h3>Last 14 days</h3>
      <div id="budgetHistory" class="grid"></div>
      <p class="desc" style="margin-top:12px;">Limit is set via <code>OPENAGI_DAILY_USD_LIMIT</code> in <code>.openagi/.env</code>.</p>
      <h3>Spend over time (30 days)</h3>
      <div id="creditChart" class="card"></div>
      <h3>By activity (30 days)</h3>
      <div id="creditByActivity" class="grid"></div>
      <h3>By model (30 days)</h3>
      <div id="creditByModel" class="grid"></div>
      <h3>Audit log</h3>
      <div id="creditLog"></div>
    </div>
  \`;
  const hist = $("budgetHistory");
  for (const d of (b.history ?? [])) {
    const c = document.createElement("div");
    c.className = "card";
    c.innerHTML = \`<div class="row between"><span class="name">\${escapeHtml(d.date)}</span><span class="muted">\${d.calls} call\${d.calls===1?"":"s"}</span></div><div class="stat-value">$\${d.usd.toFixed(4)}</div>\`;
    hist.appendChild(c);
  }
  const led = await fetchJson("/budget/ledger?days=30").catch(() => null);
  if (led && !led.error) {
    const days = led.analytics.byDay;
    const maxUsd = Math.max(0.0001, ...days.map((d) => d.usd));
    const bw = 100 / Math.max(days.length, 1);
    const bars = days.map((d, i) => {
      const h = Math.max(1, (d.usd / maxUsd) * 90);
      return \`<rect x="\${(i * bw).toFixed(2)}" y="\${(100 - h).toFixed(2)}" width="\${(bw * 0.8).toFixed(2)}" height="\${h.toFixed(2)}"><title>\${escapeHtml(d.date)}: $\${d.usd.toFixed(4)} (\${d.calls})</title></rect>\`;
    }).join("");
    $("creditChart").innerHTML = \`<svg viewBox="0 0 100 100" preserveAspectRatio="none" style="width:100%;height:120px;fill:var(--accent);">\${bars}</svg>\`;

    const fill = (id, items, key) => {
      const el = $(id); el.innerHTML = "";
      for (const it of items) {
        const c = document.createElement("div"); c.className = "card";
        c.innerHTML = \`<div class="row between"><span class="name">\${escapeHtml(String(it[key]))}</span><span class="muted">\${it.calls} call\${it.calls === 1 ? "" : "s"}</span></div><div class="stat-value">$\${it.usd.toFixed(4)}</div>\`;
        el.appendChild(c);
      }
    };
    fill("creditByActivity", led.analytics.byActivity, "activity");
    fill("creditByModel", led.analytics.byModel, "model");

    const log = $("creditLog");
    log.innerHTML = "";
    for (const e of led.entries.slice(0, 200)) {
      const t = (e.at || "").slice(0, 16).replace("T", " ");
      const tools = (e.tools || []).join(", ");
      const row = document.createElement("div"); row.className = "card";
      row.innerHTML = \`<div class="row between"><span class="name">\${escapeHtml(e.model || "?")}</span><span class="stat-value">$\${Number(e.usd || 0).toFixed(4)}</span></div><div class="muted" style="font-size:11px;">\${escapeHtml(t)} · \${escapeHtml(e.channel || "?")}\${e.agentId ? " · " + escapeHtml(e.agentId) : ""}\${tools ? " · " + escapeHtml(tools) : ""}</div>\`;
      log.appendChild(row);
    }
    if (led.entries.length > 200) {
      const more = document.createElement("p"); more.className = "desc";
      more.textContent = "Showing the most recent 200 of " + led.entries.length + " calls.";
      log.appendChild(more);
    }
  }
}

async function renderOutcomes() {
  const data = await fetchJson("/outcomes?limit=40&windowDays=7");
  const agg = data.aggregate ?? {};
  const recent = data.recent ?? [];
  const byKindCards = Object.entries(agg.byKind ?? {})
    .map(([k, v]) => \`<div class="card"><span class="desc">\${escapeHtml(k)}</span><div class="stat-value">\${v}</div></div>\`)
    .join("");
  main.innerHTML = \`
    <div class="pane">
      <h2>Outcomes <span class="muted" style="font-size:14px;font-weight:400;">· last 7 days</span></h2>
      <div class="grid stats">
        <div class="card"><span class="desc">Avg quality</span><div class="stat-value">\${agg.avgQuality ?? "—"}</div></div>
        <div class="card"><span class="desc">Resolved</span><div class="stat-value">\${agg.resolved ?? 0} <span class="muted" style="font-size:14px;">/ \${agg.total ?? 0}</span></div></div>
        <div class="card"><span class="desc">Pending</span><div class="stat-value">\${agg.pending ?? 0}</div></div>
      </div>
      \${byKindCards ? \`<h3>By kind</h3><div class="grid stats">\${byKindCards}</div>\` : ""}
      <h3>Recent</h3>
      <div class="grid" id="outcomeList"></div>
    </div>
  \`;
  const list = $("outcomeList");
  for (const o of recent) {
    const el = document.createElement("div");
    el.className = "card";
    const qBadge = typeof o.qualityScore === "number"
      ? \`<span class="badge \${o.qualityScore >= 0.7 ? "ok" : o.qualityScore >= 0.4 ? "warn" : "err"}">q=\${o.qualityScore.toFixed(2)}</span>\`
      : (o.resolved ? '<span class="badge">timeout</span>' : '<span class="badge warn">pending</span>');
    el.innerHTML = \`
      <div class="row between">
        <span class="name">\${escapeHtml(o.kind)} · \${escapeHtml(o.scrutinyAction ?? "—")}</span>
        \${qBadge}
      </div>
      <div class="desc">\${escapeHtml(o.sessionId ?? "")} · \${escapeHtml(o.channel ?? "")} · \${escapeHtml(new Date(o.at).toLocaleString())}</div>
      <div class="row" style="gap:6px;margin-top:8px;">
        <button class="secondary" data-feedback="\${escapeHtml(o.refId ?? "")}" data-score="0.95">👍 great</button>
        <button class="secondary" data-feedback="\${escapeHtml(o.refId ?? "")}" data-score="0.5">😐 ok</button>
        <button class="secondary" data-feedback="\${escapeHtml(o.refId ?? "")}" data-score="0.1">👎 bad</button>
      </div>
    \`;
    list.appendChild(el);
  }
  list.querySelectorAll("[data-feedback]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const refId = btn.getAttribute("data-feedback");
      const score = Number(btn.getAttribute("data-score"));
      if (!refId) { btn.textContent = "no refId"; return; }
      try {
        await postJson("/feedback", { refId, qualityScore: score });
        btn.textContent = "✓ rated";
        btn.disabled = true;
      } catch (err) { btn.textContent = "[err] " + err.message; }
    });
  });
}

async function renderScrutiny() {
  const data = await fetchJson("/scrutiny/weights");
  const pending = await fetchJson("/scrutiny/pending").catch(() => null);
  const fitter = data.fitter ?? {};
  const weightsBlock = (w) => Object.entries(w ?? {})
    .map(([k, v]) => \`<div class="row between" style="font-size:12px;padding:3px 0;"><span class="muted">\${escapeHtml(k)}</span><strong>\${typeof v === "number" ? v.toFixed(3) : escapeHtml(String(v))}</strong></div>\`)
    .join("");
  main.innerHTML = \`
    <div class="pane">
      <h2>Scrutiny <span class="muted" style="font-size:14px;font-weight:400;">· cycle \${fitter.cycles ?? 0} · \${fitter.autoApply ? "auto-apply" : "warmup"}\${fitter.restoredWeightsAt ? \` · calibrated \${escapeHtml(new Date(fitter.restoredWeightsAt).toLocaleDateString())}\` : ""}</span></h2>
      <div class="row" style="gap:8px;margin-bottom:14px;">
        <button id="fitBtn">Run fit now</button>
      </div>
      <pre id="scrOut" class="ok" style="display:none;"></pre>

      <h3>Judges</h3>
      <div class="grid two" id="judges"></div>

      <h3>Fitter status</h3>
      <div class="grid stats">
        <div class="card"><span class="desc">Cycles run</span><div class="stat-value">\${fitter.cycles ?? 0}</div></div>
        <div class="card"><span class="desc">Warmup cycles</span><div class="stat-value">\${fitter.warmupCycles ?? 0}</div></div>
        <div class="card"><span class="desc">Pending proposals</span><div class="stat-value">\${fitter.pendingProposals ?? 0}</div></div>
        <div class="card"><span class="desc">Last run</span><div class="stat-value" style="font-size:14px;">\${fitter.lastRunAt ? escapeHtml(new Date(fitter.lastRunAt).toLocaleString()) : "—"}</div></div>
      </div>

      <h3>Pending proposals</h3>
      <div id="pendingList" class="grid"></div>
    </div>
  \`;
  const judges = $("judges");
  for (const [name, j] of Object.entries(data.weights ?? {})) {
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = \`<div class="row between"><span class="name">\${escapeHtml(name)}</span></div>
      <div class="desc" style="margin:8px 0 4px;">weights</div>\${weightsBlock(j.weights)}
      <div class="desc" style="margin:10px 0 4px;">thresholds</div>\${weightsBlock(j.thresholds)}\`;
    judges.appendChild(card);
  }
  const pl = $("pendingList");
  if (!pending || !pending.proposals?.length) {
    pl.innerHTML = '<div class="empty">No pending proposals.</div>';
  } else {
    for (const p of pending.proposals) {
      const c = document.createElement("div");
      c.className = "card";
      c.innerHTML = \`<div class="row between"><span class="name">cycle \${p.cycle}</span>
        <span class="badge \${p.applied ? "ok" : "warn"}">\${p.applied ? "applied" : "pending"}</span></div>
        <details style="margin-top:8px;"><summary class="desc">view weight deltas</summary><pre>\${escapeHtml(JSON.stringify(p.proposals, null, 2))}</pre></details>
        <div class="row" style="margin-top:8px;"><button class="secondary" data-apply="\${p.cycle}" \${p.applied ? "disabled" : ""}>\${p.applied ? "Applied" : "Apply"}</button></div>\`;
      pl.appendChild(c);
    }
    pl.querySelectorAll("[data-apply]").forEach((b) => b.addEventListener("click", async () => {
      await postJson(\`/scrutiny/pending/\${b.getAttribute("data-apply")}/apply\`, {});
      renderScrutiny();
    }));
  }
  const showOut = (text) => { const el = $("scrOut"); el.style.display = "block"; el.textContent = text; };
  $("fitBtn").addEventListener("click", async () => {
    showOut("fitting…");
    try { showOut(JSON.stringify(await postJson("/scrutiny/fit", {}), null, 2)); }
    catch (e) { showOut("[err] " + e.message); }
  });
}

async function renderHealth() {
  const a = await fetchJson("/audit");
  const sp = a.specialists ?? {};
  const mem = a.memory ?? { counts: {}, saturation: {}, principles: 0 };
  const upcoming = a.cron?.upcoming ?? [];
  const out7 = a.outcomes?.last7Days ?? null;
  const out30 = a.outcomes?.last30Days ?? null;
  const mcp = a.mcp ?? [];

  const findingCards = !a.findings?.length
    ? '<div class="empty">All systems nominal.</div>'
    : a.findings.map((f) => {
        const cls = f.severity === "warn" ? "warn" : f.severity === "err" ? "err" : "ok";
        return \`<div class="card"><div class="row between"><span class="name">\${escapeHtml(f.area)}</span><span class="badge \${cls}">\${escapeHtml(f.severity)}</span></div><div class="desc">\${escapeHtml(f.note)}</div></div>\`;
      }).join("");

  const upcomingCards = upcoming.length === 0
    ? '<div class="empty">Nothing scheduled.</div>'
    : upcoming.map((j) => \`<div class="card"><div class="row between"><span class="name">\${escapeHtml(j.name)}</span><span class="badge">\${escapeHtml(j.task)}</span></div><div class="desc">next: \${escapeHtml(new Date(j.nextRunAt).toLocaleString())}</div></div>\`).join("");

  const mcpCards = mcp.length === 0
    ? '<div class="empty">No MCP servers registered.</div>'
    : mcp.map((s) => \`<div class="card"><div class="row between"><span class="name">\${escapeHtml(s.name)}</span><span class="badge \${s.connected ? "ok" : ""}">\${s.connected ? "live" : "idle"}</span></div><div class="desc">\${s.tools} tool\${s.tools===1?"":"s"}</div></div>\`).join("");

  main.innerHTML = \`
    <div class="pane">
      <h2>Health</h2>

      <h3>Findings</h3>
      <div class="grid">\${findingCards}</div>

      <h3>Specialists</h3>
      <div class="grid stats">
        <div class="card"><span class="desc">Active</span><div class="stat-value">\${sp.active ?? 0}</div></div>
        <div class="card"><span class="desc">Retired</span><div class="stat-value muted">\${sp.retired ?? 0}</div></div>
        <div class="card"><span class="desc">Dormant >14d</span><div class="stat-value">\${sp.dormant ?? 0}</div></div>
        <div class="card"><span class="desc">Low quality</span><div class="stat-value">\${sp.lowQuality ?? 0}</div></div>
      </div>

      <h3>Memory</h3>
      <div class="grid stats">
        <div class="card"><span class="desc">Short tier</span><div class="stat-value">\${mem.counts.short ?? 0}</div><div class="desc">\${((mem.saturation.short ?? 0) * 100).toFixed(0)}% saturated</div></div>
        <div class="card"><span class="desc">Medium tier</span><div class="stat-value">\${mem.counts.medium ?? 0}</div><div class="desc">\${((mem.saturation.medium ?? 0) * 100).toFixed(0)}% saturated</div></div>
        <div class="card"><span class="desc">Long tier</span><div class="stat-value">\${mem.counts.long ?? 0}</div><div class="desc">\${((mem.saturation.long ?? 0) * 100).toFixed(0)}% saturated</div></div>
        <div class="card"><span class="desc">Principles</span><div class="stat-value">\${mem.principles ?? 0}</div></div>
      </div>

      <h3>Outcomes</h3>
      <div class="grid stats">
        <div class="card"><span class="desc">7-day avg quality</span><div class="stat-value">\${out7?.avgQuality ?? "—"}</div><div class="desc">\${out7?.resolved ?? 0} / \${out7?.total ?? 0} resolved</div></div>
        <div class="card"><span class="desc">30-day avg quality</span><div class="stat-value">\${out30?.avgQuality ?? "—"}</div><div class="desc">\${out30?.resolved ?? 0} / \${out30?.total ?? 0} resolved</div></div>
        <div class="card"><span class="desc">Pending (7d)</span><div class="stat-value">\${out7?.pending ?? 0}</div></div>
      </div>

      <h3>Upcoming cron</h3>
      <div class="grid">\${upcomingCards}</div>

      <h3>MCP</h3>
      <div class="grid">\${mcpCards}</div>
    </div>
  \`;
}

function pendingActionCardHtml(action) {
  return '<div class="card" style="padding:14px; margin-bottom:10px;" data-pending-id="' + escapeHtml(action.id) + '">'
    + '<div style="display:flex; gap:8px; align-items:center;">'
    + '<span style="font-size:18px;">🤖</span>'
    + '<span style="font-weight:600;">' + escapeHtml(action.summary || action.toolName) + '</span>'
    + '<span class="badge">' + escapeHtml(action.toolName) + '</span>'
    + '</div>'
    + (action.reason ? '<div class="muted" style="margin-top:6px; font-size:12px;">' + escapeHtml(action.reason) + '</div>' : '')
    + '<details open style="margin-top:6px;"><summary class="muted" style="font-size:11px;">args</summary><pre style="font-size:11px; margin-top:4px;">'
    + escapeHtml(JSON.stringify(action.args, null, 2))
    + '</pre></details>'
    + '<div class="muted" style="margin-top:4px; font-size:11px;">queued ' + escapeHtml(new Date(action.createdAt).toLocaleString()) + '</div>'
    + '<div class="row" style="gap:8px; margin-top:10px;">'
    + '<button data-pending-action="approve">Approve & run</button>'
    + '<button data-pending-action="deny" class="secondary">Deny</button>'
    + '</div></div>';
}

function pendingActionsSectionHtml(actions, {
  heading = "Agent actions awaiting approval",
  empty = ""
} = {}) {
  if (!Array.isArray(actions) || actions.length === 0) return empty;
  return '<h3 style="margin-top:8px;">' + escapeHtml(heading) + ' <span class="badge">' + actions.length + '</span></h3>'
    + '<p class="muted">These actions have not run. Review the visible arguments, then approve or deny each one.</p>'
    + actions.map(pendingActionCardHtml).join("");
}

function decidedActionCardHtml(action) {
  const ok = action.status === "approved" && !action.error;
  const statusClass = ok ? "ok" : action.status === "denied" ? "muted" : "err";
  const outcome = action.error
    ? '<div class="desc err" style="margin-top:6px;">Failed: ' + escapeHtml(action.error) + '</div>'
    : action.result
      ? '<details style="margin-top:6px;"><summary class="muted" style="font-size:11px;">result</summary><pre style="font-size:11px; margin-top:4px;">' + escapeHtml(JSON.stringify(action.result, null, 2)) + '</pre></details>'
      : "";
  return '<div class="card" style="padding:12px; margin-bottom:8px;">'
    + '<div class="row between"><span class="name">' + escapeHtml(action.summary || action.toolName) + '</span>'
    + '<span class="badge ' + statusClass + '">' + escapeHtml(action.status) + '</span></div>'
    + '<div class="muted" style="font-size:11px; margin-top:4px;">'
    + escapeHtml(action.toolName) + ' · decided ' + escapeHtml(new Date(action.decidedAt || action.createdAt).toLocaleString())
    + '</div>' + outcome + '</div>';
}

async function refreshApprovalBadge() {
  const count = document.getElementById("approvalsNavCount");
  if (!count) return;
  try {
    const data = await fetchJson("/pending-actions?status=pending");
    const n = data.actions?.length ?? 0;
    count.textContent = String(n);
    count.hidden = n === 0;
  } catch {
    count.hidden = true;
  }
}

async function renderApprovals() {
  const data = await fetchJson("/pending-actions").catch(() => ({ actions: [] }));
  const actions = data.actions ?? [];
  const pending = actions.filter((action) => action.status === "pending");
  const decided = actions.filter((action) => action.status !== "pending").slice(0, 20);
  main.innerHTML = '<div class="pane">'
    + '<h2>Approvals</h2>'
    + '<p class="muted">This is the durable approval queue. A notification is only a shortcut to the same records shown here.</p>'
    + pendingActionsSectionHtml(pending, {
        empty: '<div class="ui-empty">Nothing is waiting for approval.</div>'
      })
    + '<h3 style="margin-top:18px;">Recent decisions</h3>'
    + (decided.length > 0
        ? decided.map(decidedActionCardHtml).join("")
        : '<div class="ui-empty">No approval decisions recorded yet.</div>')
    + '</div>';
  bindPendingActionButtons(async () => {
    await renderApprovals();
    await refreshApprovalBadge();
  });
  await refreshApprovalBadge();
}

async function renderSuggestions() {
  // Live view of everything the proactive observer has proposed and is
  // waiting on the user to accept/reject. Tasks → Tasks tab, MCPs →
  // auto-register, automations → notes, knowledge → just FYI.
  // Plus: pending agent-initiated actions (catalog connects, daemon
  // restarts) that need explicit human approval before they run.
  const targetSuggestionId = new URLSearchParams(window.location.search).get("suggestion");
  const suggestionPath = "/proactive/suggestions?status=pending"
    + (targetSuggestionId ? "&id=" + encodeURIComponent(targetSuggestionId) : "");
  const [list, pendingActions] = await Promise.all([
    fetchJson(suggestionPath).catch(() => []),
    fetchJson("/pending-actions?status=pending").catch(() => ({ actions: [] }))
  ]);
  const actions = pendingActions?.actions ?? [];

  const pendingActionsHtml = actions.length === 0 ? "" : \`
    <h3 style="margin-top:8px;">Agent actions awaiting approval <span class="badge">\${actions.length}</span></h3>
    <p class="muted">The agent proposed these — they only run if you approve.</p>
    \${actions.map((a) => \`
      <div class="card" style="padding:14px; margin-bottom:10px;" data-pending-id="\${escapeHtml(a.id)}">
        <div style="display:flex; gap:8px; align-items:center;">
          <span style="font-size:18px;">🤖</span>
          <span style="font-weight:600;">\${escapeHtml(a.summary || a.toolName)}</span>
          <span class="badge">\${escapeHtml(a.toolName)}</span>
        </div>
        \${a.reason ? \`<div class="muted" style="margin-top:6px; font-size:12px;">\${escapeHtml(a.reason)}</div>\` : ""}
        <details open style="margin-top:6px;"><summary class="muted" style="font-size:11px;">args</summary><pre style="font-size:11px; margin-top:4px;">\${escapeHtml(JSON.stringify(a.args, null, 2))}</pre></details>
        <div class="muted" style="margin-top:4px; font-size:11px;">queued \${escapeHtml(new Date(a.createdAt).toLocaleString())}</div>
        <div class="row" style="gap:8px; margin-top:10px;">
          <button data-pending-action="approve">Approve & run</button>
          <button data-pending-action="deny" class="secondary">Deny</button>
        </div>
      </div>
    \`).join("")}
  \`;

  if ((!Array.isArray(list) || list.length === 0) && actions.length === 0) {
    main.innerHTML = \`
      <div class="pane">
        <h2>Suggestions</h2>
        <div id="suggestionsPageChat"></div>
        <p class="muted">Nothing new to surface right now. The proactive observer runs every 10 minutes and proposes one concrete next thing — a task, a skill, an MCP to connect, or a small automation — when it sees something worth saying.</p>
        <p class="muted">If you want to force a run now: <code>POST /proactive/observe</code>.</p>
      </div>
    \`;
    renderPageChatComposer(document.getElementById("suggestionsPageChat"), {
      placeholder: 'e.g. "What did you notice today?" or "ignore screenshots from Discord"',
      onAfterSend: async () => { await renderSuggestions(); }
    });
    return;
  }
  if (!Array.isArray(list) || list.length === 0) {
    // Only pending agent actions, no proactive suggestions.
    main.innerHTML = \`
      <div class="pane">
        <h2>Suggestions</h2>
        <div id="suggestionsPageChat"></div>
        \${pendingActionsHtml}
      </div>
    \`;
    renderPageChatComposer(document.getElementById("suggestionsPageChat"), {
      placeholder: 'e.g. "approve the Stripe MCP" or "deny it, I changed my mind"',
      onAfterSend: async () => { await renderSuggestions(); }
    });
    bindPendingActionButtons();
    return;
  }

  const card = (s) => {
    const icon = ({ task: "📋", skill: "✨", mcp: "🔌", automation: "⚙️", knowledge: "💡" })[s.category] ?? "🔔";
    const proposedAt = s.proposedAt ? new Date(s.proposedAt).toLocaleString() : "";
    const meta = [];
    if (s.category === "task") {
      meta.push(\`queue: \${s.taskQueue ?? "user"}\`);
      meta.push(\`bucket: \${s.taskBucket ?? "today"}\`);
    } else if (s.category === "mcp" && s.mcpId) {
      meta.push(\`catalog id: \${s.mcpId}\`);
    }
    // Story 4: source badge differentiates miner-detected patterns
    // (real activity signal, sometimes with count + confidence) from
    // observer's one-shot proposals (LLM read of the last 10 min).
    const sourceBadge = s.source === "pattern-miner"
      ? '<span class="ui-badge" title="Detected by activity pattern miner — observed multiple times.">pattern</span>'
      : s.source === "session-miner"
        ? '<span class="ui-badge" title="Detected by chat-session miner — recurring across conversations.">session</span>'
        : s.source === "weekly-observer"
          ? '<span class="ui-badge" title="Mid-horizon observer — multi-day project thread, not a single moment.">7-day</span>'
          : "";
    // Story 5: when high-confidence signals bypass the judge's pass=true
    // veto, badge it so the user knows the LLM tried to skip this but
    // the deterministic confidence floor kept it.
    const bypassBadge = s.judgeBypass
      ? '<span class="ui-badge ui-badge-accent" title="High-confidence signal — bypassed the LLM judge.">auto-passed</span>'
      : "";
    let sequenceMeta = null;
    if (s.sequence) {
      const conf = (s.sequence.confidence ?? 0).toFixed(2);
      const hourPart = s.sequence.startHour != null
        ? " · around " + String(s.sequence.startHour).padStart(2, "0") + ":00"
        : "";
      sequenceMeta = "observed " + s.sequence.count + "× · confidence " + conf + hourPart;
    }
    return \`
      <div class="card" style="padding:14px; margin-bottom:10px;" data-suggestion-id="\${escapeHtml(s.id)}">
        <div class="row between" style="align-items:flex-start; gap:8px;">
          <div style="flex:1; min-width:0;">
            <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
              <span style="font-size:18px;">\${icon}</span>
              <span style="font-weight:600;">\${escapeHtml(s.title || "(untitled)")}</span>
              <span class="badge">\${escapeHtml(s.category || "?")}</span>
              \${sourceBadge}
              \${bypassBadge}
            </div>
            <div class="muted" style="margin-top:6px; font-size:12px;">\${escapeHtml(s.rationale || "")}</div>
            \${meta.length > 0 ? \`<div class="muted" style="margin-top:4px; font-size:11px;">\${meta.map(escapeHtml).join(" · ")}</div>\` : ""}
            \${sequenceMeta ? \`<div class="muted" style="margin-top:4px; font-size:11px;">\${escapeHtml(sequenceMeta)}</div>\` : ""}
            \${proposedAt ? \`<div class="muted" style="margin-top:4px; font-size:11px;">proposed \${escapeHtml(proposedAt)}</div>\` : ""}
          </div>
        </div>
        <div class="row" style="gap:8px; margin-top:10px;">
          <button data-action="accept">Accept</button>
          <button data-action="dismiss" class="secondary">Dismiss</button>
          <button data-action="reject" class="secondary">Reject</button>
        </div>
      </div>
    \`;
  };

  main.innerHTML = \`
    <div class="pane">
      <div class="ui-row" style="justify-content:space-between; align-items:flex-start;">
        <h2>Suggestions <span class="badge">\${list.length}</span></h2>
        \${targetSuggestionId ? '<button class="ui-btn ui-btn-ghost ui-btn-sm" id="showAllSuggestions">Show all suggestions</button>' : ""}
      </div>
      <div id="suggestionsPageChat"></div>
      <p class="muted">\${targetSuggestionId ? "Selected from Review. " : ""}Proactive observer proposed these from your recent on-screen activity. Accept routes to the right place — tasks land in the Tasks tab, MCPs auto-register, skills become drafts.</p>
      \${list.map(card).join("")}
      \${pendingActionsHtml}
    </div>
  \`;
  renderPageChatComposer(document.getElementById("suggestionsPageChat"), {
    placeholder: 'Talk to the agent about these…',
    onAfterSend: async () => { await renderSuggestions(); }
  });
  bindPendingActionButtons();
  $("showAllSuggestions")?.addEventListener("click", () => {
    const next = new URL(window.location.href);
    next.searchParams.delete("suggestion");
    history.replaceState(null, "", next.toString());
    renderSuggestions();
  });

  document.querySelectorAll("[data-suggestion-id]").forEach((el) => {
    const id = el.dataset.suggestionId;
    el.querySelectorAll("[data-action]").forEach((b) => {
      b.addEventListener("click", async () => {
        const action = b.dataset.action;
        try {
          const res = await postJson(\`/proactive/suggestions/\${id}/\${action}\`, {});
          if (action === "accept" && res.taskId) {
            showToast("✓ Task added — opening Tasks", true);
            setTimeout(() => switchTab("tasks"), 600);
          } else if (action === "accept" && res.registered) {
            showToast(mcpAcceptMessage(res), !res.connectError);
            setTimeout(() => switchTab("mcp"), 600);
          } else if (action === "accept") {
            showToast("✓ Accepted", true);
          } else {
            showToast(\`Suggestion \${action}d\`, true);
          }
          await renderSuggestions();
        } catch (err) {
          showToast("Action failed: " + err.message, false);
        }
      });
    });
  });
  revealDeepLinkedRecord("suggestion", "[data-suggestion-id]", "suggestionId");
}

function bindPendingActionButtons(onResolved = async () => {
  await renderSuggestions();
  await refreshApprovalBadge();
}) {
  document.querySelectorAll("[data-pending-id]").forEach((card) => {
    const id = card.dataset.pendingId;
    card.querySelectorAll("[data-pending-action]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const decision = btn.dataset.pendingAction;
        btn.disabled = true;
        const originalLabel = btn.textContent;
        btn.textContent = decision === "approve" ? "Running..." : "Denying...";
        try {
          const res = await postJson(\`/pending-actions/\${encodeURIComponent(id)}/\${decision}\`, {});
          if (decision === "approve") {
            const summary = res?.continuation?.status === "queued"
              ? "Approved — the agent is continuing in Chat."
              : res?.result?.note ?? res?.result?.message ?? \`Action ran (\${JSON.stringify(res?.result ?? res)})\`;
            showToast(\`✓ \${summary}\`, true);
          } else {
            showToast("Action denied.", true);
          }
          await onResolved();
        } catch (err) {
          showToast(\`\${decision} failed: \${err.message}\`, false);
          btn.disabled = false;
          btn.textContent = originalLabel;
        }
      });
    });
  });
}

async function renderIntegrations() {
  const data = await fetchJson("/integrations/status").catch(() => ({ integrations: [], catalog: [], categories: [] }));
  const integrations = data.integrations ?? [];
  const catalog = data.catalog ?? [];
  const categories = data.categories ?? [];

  const catalogCard = (e) => {
    let badge;
    if (e.connected) {
      badge = '<span class="ui-badge ui-badge-accent">on</span>';
    } else if (e.authenticated) {
      badge = '<span class="ui-badge">authorized</span>';
    } else if (e.registered) {
      badge = '<span class="ui-badge">sign in required</span>';
    } else if (e.status === "coming-soon") {
      badge = '<span class="ui-badge">soon</span>';
    } else {
      badge = '<span class="ui-badge">off</span>';
    }
    // Bearer-auth entries need an API key. Reveal an inline input here
    // when the env var isn't set yet — the click handler reads the value
    // from this field and POSTs it alongside the catalogId.
    const needsKey = e.connectable && !e.registered && e.apiKeyEnvVar && !e.apiKeyConfigured;
    const keyFieldId = \`cat-key-\${e.id}\`;
    let action;
    if (e.registered) {
      action = \`<a class="ui-btn ui-btn-ghost ui-btn-sm" href="/?tab=mcp">Manage →</a>\${e.authType === "oauth" ? \` <button class="ui-btn ui-btn-ghost ui-btn-sm" data-forget-mcp="\${escapeHtml(e.mcpName)}">Forget login</button>\` : ""}\`;
    } else if (e.connectable) {
      action = \`<button class="ui-btn ui-btn-sm add-mcp-btn" data-catalog-id="\${escapeHtml(e.id)}" data-int-id="\${escapeHtml(e.id)}" \${needsKey ? \`data-key-field-id="\${keyFieldId}"\` : ""}>+ Connect</button>\`;
    } else {
      const auth = e.authType === "oauth" ? "OAuth coming soon" : "Coming soon";
      action = \`<span class="ui-meta">\${auth}</span>\`;
    }
    const keyField = needsKey
      ? \`
        <div style="margin-top: var(--space-2);">
          <label style="display:block; font-size:10px; color: var(--muted-foreground); margin-bottom: 3px;">\${escapeHtml(e.apiKeyEnvVar)}\${e.apiKeyHelp ? \` — \${escapeHtml(e.apiKeyHelp)}\` : ""}</label>
          <input class="ui-input" type="password" id="\${keyFieldId}" autocomplete="off" placeholder="paste your key" style="font-size: 12px;">
        </div>
      \`
      : "";
    return \`
      <div class="ui-card" style="display: flex; flex-direction: column; gap: var(--space-2);">
        <div style="display: flex; align-items: flex-start; gap: var(--space-2);">
          <div class="ui-grow">
            <div style="font-weight: 600; font-size: 13px; display:flex; align-items:center; gap:6px;"><span>\${escapeHtml(e.name)}</span><span class="badge mcp" style="font-size:9px;">MCP</span></div>
            <div class="ui-meta" style="margin-top: 2px;">\${escapeHtml(e.description ?? "")}</div>
            \${e.featured ? '<div class="ui-meta" style="margin-top:3px; opacity:.85;">↑ Also available as a non-MCP (direct API) integration above</div>' : ""}
          </div>
          \${badge}
        </div>
        \${keyField}
        <div>\${action}</div>
      </div>
    \`;
  };

  const pathBlock = (it, p) => {
    const status = p.kind === "mcp"
      ? (p.connected
          ? '<span class="badge ok">on</span>'
          : p.authenticated
            ? '<span class="badge">authorized</span>'
            : p.registered
              ? '<span class="badge warn">sign in required</span>'
              : '<span class="badge">off</span>')
      : (p.configured ? '<span class="badge ok">on</span>' : '<span class="badge">off</span>');
    const lastSync = p.lastSyncedAt
      ? \`<div class="muted" style="font-size:11px; margin-top:4px;">last sync: \${escapeHtml(new Date(p.lastSyncedAt).toLocaleString())}</div>\`
      : "";
    const envBlock = p.envKeys?.length > 0
      ? \`<div class="muted" style="font-size:11px; margin-top:4px;">env: <code>\${p.envKeys.map(escapeHtml).join("</code> · <code>")}</code></div>\`
      : "";
    // Make the integration TYPE unmistakable: an MCP path vs a non-MCP
    // (direct API / file-drop) path. Two integrations can offer both.
    const kindBadge = p.kind === "mcp"
      ? '<span class="badge mcp">MCP</span>'
      : '<span class="badge muted">non-MCP</span>';
    let actions = "";
    let editForm = "";
    if (p.kind === "api" && p.envKeys?.length > 0) {
      const formId = \`form-\${it.id}-\${p.kind}\`;
      const editLabel = p.configured ? "Edit credentials" : "+ Add credentials";
      actions = \`<button class="edit-creds-btn" data-form-id="\${formId}" style="font-size:11px; padding:3px 8px;">\${editLabel}</button>\`;
      editForm = \`
        <form id="\${formId}" data-int-form class="edit-creds-form" style="display:none; margin-top:10px; padding:10px; background:rgba(255,255,255,.03); border-radius:6px;">
          \${p.envKeys.map((k) => \`
            <div style="margin-bottom:8px;">
              <label style="display:block; font-size:11px; margin-bottom:3px; color:var(--muted);">\${escapeHtml(k)}</label>
              <input type="\${k.includes("EMAIL") || k.includes("URL") || k.includes("FROM_NUMBER") || k.includes("USER_NAME") ? "text" : "password"}" name="\${escapeHtml(k)}" placeholder="\${p.configured ? "(leave blank to keep current)" : ""}" autocomplete="off" style="width:100%; padding:5px 7px; font-size:12px;">
            </div>
          \`).join("")}
          <div class="row" style="gap:6px; align-items:center;">
            <button type="submit" style="font-size:11px; padding:3px 10px;">Save</button>
            <button type="button" data-cancel="\${formId}" class="secondary" style="font-size:11px; padding:3px 10px;">Cancel</button>
            <span class="muted" style="font-size:11px;">Restart daemon afterwards from the menu bar to apply.</span>
          </div>
        </form>
      \`;
    } else if (p.kind === "mcp" && !p.registered) {
      actions = \`<button class="add-mcp-btn" data-catalog-id="\${escapeHtml(p.catalogId)}" data-int-id="\${escapeHtml(it.id)}" style="font-size:11px; padding:3px 8px;">+ Connect this MCP</button>\`;
    } else if (p.kind === "mcp" && p.registered) {
      actions = \`<a href="/?tab=mcp" style="font-size:11px;">Manage →</a> <button class="secondary" data-forget-mcp="\${escapeHtml(p.mcpName)}" style="font-size:11px; padding:3px 8px;">Forget login</button>\`;
    } else if (p.kind === "folder" && p.configured) {
      actions = \`<a href="/?tab=tasks" style="font-size:11px;">View tasks →</a>\`;
    }
    return \`
      <div style="border:1px solid var(--line); border-radius:6px; padding:10px 12px; margin-top:6px;">
        <div class="row between" style="align-items:center; gap:8px;">
          <div style="flex:1; min-width:0;">
            <div style="font-weight:500; font-size:13px; display:flex; align-items:center; gap:6px;">\${kindBadge}<span>\${escapeHtml(p.label)}</span></div>
            \${p.detail ? \`<div class="muted" style="font-size:11px; margin-top:2px;">\${escapeHtml(p.detail)}</div>\` : ""}
            \${envBlock}
            \${lastSync}
          </div>
          <div style="display:flex; gap:8px; align-items:center; flex-shrink:0;">
            \${status}
            \${actions}
          </div>
        </div>
        \${editForm}
      </div>
    \`;
  };

  main.innerHTML = \`
    <div class="pane">
      <h2>Integrations</h2>
      <p class="muted">Every source, channel, and MCP in one place. Each row shows all the paths you can use — direct API, MCP, or file-drop. Click "+ Connect this MCP" to register one with one click, or set credentials in <a href="/setup">/setup</a> step 5 / <code>.openagi/.env</code>.</p>

      \${integrations.map((it) => \`
        <div class="card" style="padding:14px; margin-bottom:12px;">
          <div class="row between" style="align-items:flex-start; gap:10px;">
            <div style="flex:1; min-width:0;">
              <div style="font-weight:600; font-size:15px;">\${escapeHtml(it.name)}</div>
              <div class="muted" style="font-size:12px; margin-top:3px;">\${escapeHtml(it.description ?? "")}</div>
            </div>
            \${(it.paths ?? []).some((p) => p.configured) ? '<span class="badge ok">active</span>' : '<span class="badge">inactive</span>'}
          </div>
          \${(it.paths ?? []).map((p) => pathBlock(it, p)).join("")}
        </div>
      \`).join("")}

      \${catalog.length > 0 ? \`
        <h2 style="margin-top:30px;">Browse MCP catalog</h2>
        <p class="muted">More servers — connect with one click when an integration is "available", or watch this list for OAuth-pending entries.</p>
        \${categories.map((cat) => {
          const inCat = catalog.filter((e) => e.category === cat.id);
          if (inCat.length === 0) return "";
          return \`
            <div style="margin-top:18px;">
              <h3 style="font-size:13px; text-transform:uppercase; letter-spacing:0.5px; color:var(--muted); margin-bottom:8px;">\${escapeHtml(cat.name)}</h3>
              <div style="display:grid; grid-template-columns:repeat(auto-fill, minmax(280px, 1fr)); gap:10px;">
                \${inCat.map((e) => catalogCard(e)).join("")}
              </div>
            </div>
          \`;
        }).join("")}
      \` : ""}
    </div>
  \`;

  document.querySelectorAll(".add-mcp-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const catalogId = btn.dataset.catalogId;
      const keyFieldId = btn.dataset.keyFieldId;
      const originalLabel = btn.textContent;
      let apiKey;
      if (keyFieldId) {
        const field = document.getElementById(keyFieldId);
        const v = field?.value?.trim();
        if (!v) {
          showToast("Paste the API key into the field above this button before connecting.", false);
          field?.focus();
          return;
        }
        apiKey = v;
      }
      btn.disabled = true;
      btn.textContent = "Connecting...";
      try {
        const result = await postJson("/integrations/connect-mcp", apiKey ? { catalogId, apiKey } : { catalogId });
        showToast(\`✓ Registered \${result.name ?? catalogId} MCP — opening MCP tab.\`, true);
        // If OAuth, the MCP page will show the auth URL via SSE.
        setTimeout(() => switchTab("mcp"), 800);
      } catch (err) {
        showToast(\`Connect failed: \${err.message}\`, false);
        btn.disabled = false;
        btn.textContent = originalLabel;
      }
    });
  });

  document.querySelectorAll("[data-forget-mcp]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const name = btn.dataset.forgetMcp;
      if (!name || !confirm("Disconnect " + name + " and forget its saved OAuth login? You can authorize it again later.")) return;
      btn.disabled = true;
      try {
        await postJson(\`/mcp/clear-auth/\${encodeURIComponent(name)}\`, {});
        showToast("Login forgotten. The integration is disconnected.", true);
        await renderIntegrations();
      } catch (error) {
        showToast("Could not forget login: " + error.message, false);
        btn.disabled = false;
      }
    });
  });

  // Inline credential edit forms — show/hide and submit to /setup/save.
  document.querySelectorAll(".edit-creds-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const form = document.getElementById(btn.dataset.formId);
      if (!form) return;
      form.style.display = form.style.display === "none" ? "" : "none";
    });
  });
  document.querySelectorAll("[data-cancel]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const form = document.getElementById(btn.dataset.cancel);
      if (form) form.style.display = "none";
    });
  });
  document.querySelectorAll(".edit-creds-form").forEach((form) => {
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const values = {};
      for (const [k, v] of fd.entries()) {
        const trimmed = String(v ?? "").trim();
        if (trimmed.length > 0) values[k] = trimmed;
      }
      if (Object.keys(values).length === 0) {
        showToast("Nothing to save (all fields empty)", false);
        return;
      }
      try {
        await postJson("/setup/save", values);
        showToast("✓ Credentials saved. Restart the daemon from the menu bar to apply.", true);
        await renderIntegrations();
      } catch (err) {
        showToast("Save failed: " + err.message, false);
      }
    });
  });
}

async function renderTasks() {
  state.taskFilter = state.taskFilter || { bucket: "all" };
  const targetTaskId = new URLSearchParams(window.location.search).get("task");
  if (targetTaskId) state.taskFilter.bucket = "all";
  const data = await fetchJson("/tasks?limit=200").catch(() => ({ tasks: [], stats: {} }));
  let tasks = data.tasks ?? [];
  if (targetTaskId && !tasks.some((task) => task.id === targetTaskId)) {
    const target = await fetchJson("/tasks/" + encodeURIComponent(targetTaskId)).catch(() => null);
    if (target) tasks = [target, ...tasks];
  }
  const stats = data.stats ?? {};
  const filterB = state.taskFilter.bucket;

  const taskRow = (t) => {
    const isOverdue = t.dueDate && Date.parse(t.dueDate) < Date.now() && t.status !== "completed";
    const dueDateStr = t.dueDate ? new Date(t.dueDate).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "";
    const sourceHref = t.sourceUrl ? safeLinkHref(t.sourceUrl) : null;
    const sourceBadge = t.source && t.source !== "manual"
      ? (sourceHref
          ? \`<a class="ui-badge" href="\${sourceHref}" target="_blank" rel="noopener noreferrer" style="text-decoration:none;">\${escapeHtml(t.source)} ↗</a>\`
          : \`<span class="ui-badge">\${escapeHtml(t.source)}</span>\`)
      : "";
    const titleStyle = t.status === "completed" ? "text-decoration:line-through; color:var(--muted-foreground);" : "";
    return \`
      <li data-task-id="\${t.id}" class="task ui-task-row">
        <input type="checkbox" \${t.status === "completed" ? "checked" : ""} data-action="toggle" class="ui-task-check">
        <div class="ui-grow">
          <div class="ui-row" style="gap: var(--space-2);">
            <span class="ui-task-title" style="\${titleStyle}">\${escapeHtml(t.title)}</span>
            <span class="ui-badge">\${t.bucket.replace("_", " ")}</span>
            \${t.priority >= 70 ? \`<span class="ui-badge ui-badge-err">P\${t.priority}</span>\` : ""}
            \${dueDateStr ? \`<span class="ui-badge \${isOverdue ? "ui-badge-err" : ""}">\${isOverdue ? "⏰ overdue " : "due "}\${dueDateStr}</span>\` : ""}
            \${sourceBadge}
          </div>
          \${t.description ? \`<div class="ui-meta" style="margin-top:4px;">\${escapeHtml(t.description.slice(0, 240))}</div>\` : ""}
          \${t.sourceMeta?.identifier ? \`<div class="ui-meta" style="margin-top:2px;">\${escapeHtml(t.sourceMeta.identifier)}\${t.sourceMeta.team ? " · " + escapeHtml(t.sourceMeta.team) : ""}\${t.sourceMeta.project ? " · " + escapeHtml(t.sourceMeta.project) : ""}</div>\` : ""}
          \${t.sourceMeta?.file ? \`<div class="ui-meta" style="margin-top:2px;">📎 \${escapeHtml(t.sourceMeta.file)} (line \${t.sourceMeta.line})</div>\` : ""}
        </div>
        <button data-action="delete" class="ui-btn ui-btn-ghost ui-btn-sm" title="Delete">×</button>
      </li>
    \`;
  };

  const inBucket = (t) => filterB === "all" || t.bucket === filterB;
  const userTasks = tasks.filter((t) => t.queue === "user" && inBucket(t));
  const agentTasks = tasks.filter((t) => t.queue === "agent" && inBucket(t));
  const userTotal = stats.user?.total ?? 0;
  const agentTotal = stats.agent?.total ?? 0;

  // Zero tasks EVER is almost always "no source is connected", not "inbox
  // zero". Diagnose it loudly instead of showing two empty sections: which
  // task sources are configured, and the last sync's skip reason when not.
  let gettingStarted = "";
  if (userTotal === 0 && agentTotal === 0) {
    const integ = await fetchJson("/integrations/status").catch(() => null);
    const taskSources = (integ?.integrations ?? []).filter((s) => ["linear", "buildbetter"].includes(s.id));
    const rows = taskSources.map((s) => {
      const api = (s.paths ?? []).find((p) => p.kind === "api");
      const ok = Boolean(api?.configured);
      const reason = api?.lastSync?.skipped ? api.lastSync.reason : (api?.lastSync?.signals?.skipped ? api.lastSync.signals.reason : null);
      const status = ok
        ? (reason ? \`connected — last sync skipped: \${escapeHtml(reason)}\` : "connected")
        : \`not connected (\${(api?.envKeys ?? []).slice(0, 1).map(escapeHtml).join("")} or MCP)\`;
      return \`<li style="margin:2px 0;"><strong>\${escapeHtml(s.name)}</strong>: <span class="\${ok && !reason ? "" : "ui-muted"}">\${status}</span></li>\`;
    }).join("");
    gettingStarted = \`
      <div class="card" style="margin-bottom: var(--space-4); border-left: 3px solid var(--warn, #d4a72c); padding: var(--space-3);">
        <div style="font-weight:600; margin-bottom:4px;">No tasks yet — here's why</div>
        <ul style="margin:4px 0 8px 16px; padding:0; font-size:13px;">\${rows || "<li>No task sources detected.</li>"}</ul>
        <div class="ui-meta">Connect a source in <a href="/?tab=integrations">Integrations</a>, drop .md/.txt files in ~/.openagi/inbox, or just tell the agent below: "remind me to…"</div>
      </div>\`;
  }

  main.innerHTML = \`
    <div class="pane">
      <h2>Tasks</h2>
      \${gettingStarted}
      <p class="ui-muted">Talk to the agent below to add, complete, or rearrange tasks. Or click checkboxes directly. <strong>My tasks</strong> are what you should do; <strong>Agent tasks</strong> are what OpenAGI is working on for you.</p>

      <div id="tasksPageChat"></div>

      <div class="ui-row" style="margin-bottom: var(--space-4);">
        <span class="ui-meta">bucket:</span>
        \${["all", "today", "this_week", "this_month", "this_quarter", "this_year", "someday", "done"].map((b) => \`<button class="ui-btn \${filterB === b ? "" : "ui-btn-ghost"} ui-btn-sm" data-bf="\${b}">\${b.replace(/_/g, " ")}</button>\`).join("")}
      </div>

      <section class="ui-section">
        <div class="ui-section-header">
          <h3>My tasks</h3>
          <span class="ui-section-meta">· \${userTotal} total</span>
        </div>
        \${userTasks.length === 0
          ? \`<div class="ui-empty">Nothing here. Try saying "remind me to call Sarah tomorrow" or "add a task to fix the mouse bug".</div>\`
          : \`<ul class="ui-task-list">\${userTasks.map(taskRow).join("")}</ul>\`}
      </section>

      <section class="ui-section">
        <div class="ui-section-header">
          <h3>Agent tasks</h3>
          <span class="ui-section-meta">· \${agentTotal} total</span>
        </div>
        <p class="ui-meta" style="margin: 0 0 var(--space-2);">Things OpenAGI has committed to do for you (or that the proactive observer queued).</p>
        \${agentTasks.length === 0
          ? \`<div class="ui-empty">No agent tasks. The agent will queue work here when it picks something up via the proactive observer or via "OpenAGI, please look into X" in chat.</div>\`
          : \`<ul class="ui-task-list">\${agentTasks.map(taskRow).join("")}</ul>\`}
      </section>
    </div>
  \`;

  renderPageChatComposer(document.getElementById("tasksPageChat"), {
    placeholder: 'e.g. "Add a task to fix the mouse bug today" or "show me what\\'s overdue"',
    onAfterSend: async () => { await renderTasks(); }
  });

  document.querySelectorAll("[data-bf]").forEach((b) => b.addEventListener("click", () => { state.taskFilter.bucket = b.dataset.bf; renderTasks(); }));

  document.querySelectorAll(".task").forEach((el) => {
    const id = el.dataset.taskId;
    el.querySelector('[data-action="toggle"]')?.addEventListener("change", async (e) => {
      if (e.target.checked) {
        await fetch(\`/tasks/\${id}/complete\`, { method: "POST", headers: { "content-type": "application/json" }, credentials: "include", body: "{}" });
      } else {
        await fetch(\`/tasks/\${id}\`, { method: "PATCH", headers: { "content-type": "application/json" }, credentials: "include", body: JSON.stringify({ status: "pending", bucket: "today" }) });
      }
      await renderTasks();
    });
    el.querySelector('[data-action="delete"]')?.addEventListener("click", async () => {
      if (!confirm("Delete this task?")) return;
      await fetch(\`/tasks/\${id}\`, { method: "DELETE", credentials: "include" });
      await renderTasks();
    });
  });
  revealDeepLinkedRecord("task", ".task", "taskId");
}

async function renderReview({ append = false } = {}) {
  const review = state.review;
  const previousScroll = append ? (main.querySelector(".pane")?.scrollTop ?? 0) : 0;
  const params = new URLSearchParams({ limit: "50", sort: review.sort });
  if (review.q) params.set("q", review.q);
  if (review.kind !== "all") params.set("kind", review.kind);
  if (append && review.nextCursor) params.set("cursor", review.nextCursor);

  if (!append) {
    main.innerHTML = '<div class="pane"><h2>Review</h2><div class="ui-empty">Loading open items…</div></div>';
  }

  let page;
  try {
    page = await fetchJson("/review-queue?" + params.toString());
  } catch (error) {
    main.innerHTML = \`
      <div class="pane">
        <h2>Review</h2>
        <div class="ui-empty">Couldn\\'t load the review queue. <button class="ui-btn ui-btn-sm" id="reviewRetry">Try again</button></div>
      </div>
    \`;
    $("reviewRetry")?.addEventListener("click", () => renderReview());
    return;
  }

  review.items = append ? [...review.items, ...(page.items ?? [])] : (page.items ?? []);
  review.nextCursor = page.nextCursor ?? null;
  review.total = page.total ?? 0;
  review.byKind = page.byKind ?? {};
  review.summary = page.summary ?? { total: review.total, byKind: review.byKind };

  const allCounts = review.summary.byKind ?? {};
  const kinds = [
    { key: "all", label: "All", count: review.summary.total ?? 0 },
    { key: "task", label: "Tasks", count: allCounts.tasks ?? 0 },
    { key: "draft", label: "Drafts", count: allCounts.drafts ?? 0 },
    { key: "clarification", label: "Clarifications", count: allCounts.clarifications ?? 0 },
    { key: "suggestion", label: "Suggestions", count: allCounts.suggestions ?? 0 }
  ];
  const icon = { task: "✓", draft: "📝", clarification: "?", suggestion: "💡" };
  const kindName = { task: "task", draft: "draft", clarification: "clarification", suggestion: "suggestion" };
  const cards = review.items.map((item) => {
    const created = item.createdAt && Number.isFinite(Date.parse(item.createdAt))
      ? new Date(item.createdAt).toLocaleString()
      : null;
    const meta = [
      kindName[item.kind] ?? item.kind,
      item.source,
      created,
      item.shownInQuickAsk ? "shown in Quick Ask" : null
    ].filter(Boolean);
    return \`
      <article class="ui-card" data-review-id="\${escapeHtml(item.id)}" style="margin-bottom:var(--space-2);">
        <div class="ui-row" style="align-items:flex-start; gap:var(--space-3);">
          <span aria-hidden="true" style="font-size:18px; line-height:1.4;">\${icon[item.kind] ?? "•"}</span>
          <div class="ui-grow">
            <div style="font-weight:600; line-height:1.4;">\${escapeHtml(item.title)}</div>
            \${item.summary ? \`<div class="ui-meta" style="margin-top:3px;">\${escapeHtml(item.summary)}</div>\` : ""}
            \${item.preview ? \`<div style="margin-top:7px; font-size:13px; line-height:1.5;">\${escapeHtml(item.preview)}</div>\` : ""}
            <div class="ui-meta" style="margin-top:7px;">\${meta.map(escapeHtml).join(" · ")}</div>
          </div>
          <a class="ui-btn ui-btn-ghost ui-btn-sm" href="\${escapeHtml(item.deepLink)}">Open</a>
        </div>
      </article>
    \`;
  }).join("");
  const quickReviewable = review.summary.quickAskReviewable ?? review.summary.quickAskShown ?? 0;
  const more = review.summary.moreThanQuickAsk ?? Math.max(0, (review.summary.total ?? 0) - quickReviewable);
  const filtered = Boolean(review.q || review.kind !== "all");

  main.innerHTML = \`
    <div class="pane">
      <div class="ui-row" style="justify-content:space-between; align-items:flex-start; gap:var(--space-4);">
        <div>
          <h2 style="margin:0;">Review <span class="ui-badge">\${review.summary.total ?? 0} open items</span></h2>
          <p class="ui-meta" style="margin:6px 0 0;">
            These are not all Tasks: the queue contains tasks, drafts, clarifications, and suggestions.
            Quick Ask currently shows \${quickReviewable} reviewable item\${quickReviewable === 1 ? "" : "s"}; \${more} more are searchable here.
          </p>
        </div>
        <button class="ui-btn ui-btn-ghost ui-btn-sm" id="reviewCleanup">Run cleanup now</button>
      </div>

      <form id="reviewSearchForm" class="ui-row" style="margin:var(--space-4) 0 var(--space-3); gap:var(--space-2); align-items:center;">
        <input class="ui-input ui-grow" id="reviewSearch" type="search" maxlength="300" value="\${escapeHtml(review.q)}" placeholder="Search titles, descriptions, sources, and draft text…">
        <select class="ui-input" id="reviewSort" aria-label="Sort review items">
          <option value="oldest" \${review.sort === "oldest" ? "selected" : ""}>Oldest first</option>
          <option value="newest" \${review.sort === "newest" ? "selected" : ""}>Newest first</option>
        </select>
        <button class="ui-btn ui-btn-sm" type="submit">Search</button>
      </form>

      <div class="ui-row" style="flex-wrap:wrap; gap:var(--space-2); margin-bottom:var(--space-3);">
        \${kinds.map((entry) => \`
          <button type="button" class="ui-btn ui-btn-sm \${review.kind === entry.key ? "" : "ui-btn-ghost"}" data-review-kind="\${entry.key}">
            \${entry.label} <span style="opacity:.75;">\${entry.count}</span>
          </button>
        \`).join("")}
      </div>

      <div class="ui-meta" style="margin-bottom:var(--space-2);">
        \${filtered ? \`\${review.total} matching · \` : ""}showing \${review.items.length}\${review.nextCursor ? " so far" : ""}
      </div>
      <div id="reviewCleanupStatus" class="ui-meta" style="margin-bottom:var(--space-2);" aria-live="polite"></div>
      \${cards || '<div class="ui-empty">No open items match this search.</div>'}
      \${review.nextCursor ? '<div style="text-align:center; margin-top:var(--space-4);"><button class="ui-btn ui-btn-ghost" id="reviewMore">Load 50 more</button></div>' : ""}
    </div>
  \`;

  $("reviewSearchForm")?.addEventListener("submit", (event) => {
    event.preventDefault();
    review.q = $("reviewSearch")?.value.trim() ?? "";
    review.nextCursor = null;
    renderReview();
  });
  document.querySelectorAll("[data-review-kind]").forEach((button) => {
    button.addEventListener("click", () => {
      review.kind = button.dataset.reviewKind;
      review.nextCursor = null;
      renderReview();
    });
  });
  $("reviewSort")?.addEventListener("change", (event) => {
    review.sort = event.target.value === "newest" ? "newest" : "oldest";
    review.nextCursor = null;
    renderReview();
  });
  $("reviewMore")?.addEventListener("click", () => renderReview({ append: true }));
  $("reviewCleanup")?.addEventListener("click", async () => {
    if (!confirm("Run conservative backlog cleanup now? It may retire stale duplicates and dead suggestions or drafts. Every automatic resolution records its evidence and can be reversed.")) return;
    const button = $("reviewCleanup");
    const status = $("reviewCleanupStatus");
    button.disabled = true;
    status.textContent = "Starting cleanup…";
    try {
      const run = await postJson("/cron/backlog-triage/run", {});
      if (run.status === "ran") {
        showToast("Cleanup finished.", true);
        await renderReview();
        return;
      }
      if (run.status !== "accepted" || !run.poll) {
        throw new Error(run.error || run.message || "Cleanup did not start (" + (run.status || "unknown status") + ").");
      }
      status.textContent = "Cleanup is running in the background. This page will refresh when it finishes.";
      // The scheduler's hard timeout is ten minutes. Poll through that
      // boundary with a grace minute, then make one authoritative final read;
      // an exact 300×2s loop could stop a fraction before the timeout status
      // landed and leave this button disabled forever.
      const pollDeadline = Date.now() + 11 * 60 * 1000;
      while (Date.now() < pollDeadline && state.tab === "review") {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const result = await fetchJson(run.poll).catch(() => null);
        if (!result || result.status === "running") continue;
        showToast(result.status === "ok" ? "Cleanup finished." : "Cleanup stopped: " + (result.error || result.status), result.status === "ok");
        await renderReview();
        return;
      }
      if (state.tab !== "review") return;
      const finalResult = await fetchJson(run.poll).catch(() => null);
      if (finalResult && finalResult.status !== "running") {
        showToast(finalResult.status === "ok" ? "Cleanup finished." : "Cleanup stopped: " + (finalResult.error || finalResult.status), finalResult.status === "ok");
        await renderReview();
        return;
      }
      throw new Error("Cleanup is still running or its final status could not be confirmed. Refresh this page to check again.");
    } catch (error) {
      status.textContent = "Cleanup status: " + (error.message || String(error));
      button.disabled = false;
    }
  });

  if (append) main.querySelector(".pane")?.scrollTo({ top: previousScroll });
}

async function renderToday() {
  // Story 7: the daily recap view. Pulls the same data the daily_recap
  // tool returns and renders it as a single-page view. Date picker lets
  // the user scroll back to past days; on mount, defaults to today.
  const qsDate = new URLSearchParams(window.location.search).get("date");
  const today = new Date().toISOString().slice(0, 10);
  const date = qsDate || today;
  const isTodayView = date === new Date().toISOString().slice(0, 10);
  const [data, clarifications, planResp, drafts, chStatus] = await Promise.all([
    fetchJson("/recap/daily?date=" + encodeURIComponent(date)).catch(() => null),
    fetchJson("/tasks/clarifications?status=pending").catch(() => []),
    isTodayView ? fetchJson("/plan/daily").catch(() => null) : Promise.resolve(null),
    isTodayView ? fetchJson("/drafts?status=pending").catch(() => []) : Promise.resolve([]),
    isTodayView ? fetchJson("/channels").catch(() => null) : Promise.resolve(null)
  ]);
  // Which real outbound transports exist? Only offer "Send" for these;
  // email has no native channel (the user copies it into their mail client).
  const sendChannels = [];
  if (chStatus?.telegram?.configured) sendChannels.push("telegram");
  if (!data) {
    main.innerHTML = '<div class="pane"><h2>Today</h2><div class="ui-empty">Couldn\\'t load today\\'s recap.</div></div>';
    return;
  }
  const r = data.recap;

  // "Your day" — the morning plan. Only for today; collapses when empty.
  const plan = planResp?.plan ?? null;
  const showPlan = date === today && plan && (plan.focus?.length || plan.agentWillDo?.length || plan.calendar?.length || plan.timeSensitive?.length);
  const planHtml = !showPlan ? "" : \`
    <section class="ui-section" id="planSection">
      <div class="ui-section-header"><h3>🗓 Your day</h3>\${plan.synthesized ? '<span class="ui-section-meta">· planned</span>' : ""}</div>
      \${plan.note ? \`<div class="ui-meta" style="margin-bottom: var(--space-2);">\${escapeHtml(plan.note)}</div>\` : ""}
      \${(plan.timeSensitive?.length ?? 0) === 0 ? "" : \`<div class="ui-row" style="flex-wrap:wrap; gap:var(--space-1); margin-bottom:var(--space-2);">\${plan.timeSensitive.map((s) => \`<span class="ui-badge ui-badge-accent">⚠️ \${escapeHtml(s)}</span>\`).join("")}</div>\`}
      \${(plan.calendar?.length ?? 0) === 0 ? "" : \`<div class="ui-meta" style="margin-bottom:6px;">📅 \${plan.calendar.slice(0,6).map((e) => escapeHtml((e.allDay ? "all day" : new Date(e.start).toISOString().slice(11,16)) + " " + e.summary)).join(" · ")}</div>\`}
      \${(plan.focus?.length ?? 0) === 0 ? "" : \`<div style="font-weight:600; margin:4px 0;">🎯 Focus</div><ul class="ui-stack" style="list-style:none; padding-left:0; gap:4px;">\${plan.focus.map((f) => \`<li>\${escapeHtml(f.title)}\${f.why ? \` <span class="ui-meta">— \${escapeHtml(f.why)}</span>\` : ""}</li>\`).join("")}</ul>\`}
      \${(() => {
        // Prefer the REAL queued agent tasks (with live status) over the
        // freshly-recomputed proposal, so the user sees drafted vs pending.
        const queued = plan.queuedActions ?? [];
        const statusIcon = (s) => s === "completed" ? "✅" : s === "in_progress" ? "⏳" : "•";
        const statusLabel = (s) => s === "completed" ? "drafted" : s === "in_progress" ? "working" : "queued";
        if (queued.length) {
          return \`<div style="font-weight:600; margin:8px 0 4px;">🤖 I'll handle</div><ul class="ui-stack" style="list-style:none; padding-left:0; gap:4px;">\${queued.map((a) => \`<li>\${statusIcon(a.status)} \${escapeHtml(a.title)} <span class="ui-meta">— \${statusLabel(a.status)}</span></li>\`).join("")}</ul>\`;
        }
        if ((plan.agentWillDo?.length ?? 0) === 0) return "";
        return \`<div style="font-weight:600; margin:8px 0 4px;">🤖 I'll handle</div><ul class="ui-stack" style="list-style:none; padding-left:0; gap:4px;">\${plan.agentWillDo.map((a) => \`<li>\${escapeHtml(a.action)}\${a.detail ? \` <span class="ui-meta">— \${escapeHtml(a.detail)}</span>\` : ""}</li>\`).join("")}</ul>\`;
      })()}
    </section>
  \`;

  // "Needs your call" — the clarification queue. Only shown for today (the
  // questions are about what just happened, not a historical date).
  const showClarify = date === today && Array.isArray(clarifications) && clarifications.length > 0;
  const clarifyHtml = !showClarify ? "" : \`
    <section class="ui-section" id="clarifySection">
      <div class="ui-section-header"><h3>❓ Needs your call</h3><span class="ui-section-meta">· \${clarifications.length}</span></div>
      <ul class="ui-stack" style="list-style:none; padding-left:0; gap: var(--space-2);">
        \${clarifications.map((c) => \`
          <li class="ui-card" data-clar="\${escapeHtml(c.id)}" style="padding: var(--space-3);">
            <div style="font-weight:600;">\${escapeHtml(c.question)}</div>
            \${c.context ? \`<div class="ui-meta" style="margin:4px 0;">\${escapeHtml(c.context)}\${Array.isArray(c.sources) && c.sources.length ? " · via " + escapeHtml(c.sources.join("+")) : ""}</div>\` : ""}
            <div class="ui-row" style="gap: var(--space-2); margin-top: var(--space-2); flex-wrap:wrap;">
              <button class="ui-btn ui-btn-accent" data-clar-answer="yes" data-id="\${escapeHtml(c.id)}">Yes, done</button>
              <button class="ui-btn" data-clar-answer="in_progress" data-id="\${escapeHtml(c.id)}">Still working</button>
              <button class="ui-btn" data-clar-answer="no" data-id="\${escapeHtml(c.id)}">Not yet</button>
              <button class="ui-btn ui-btn-ghost" data-clar-answer="dropped" data-id="\${escapeHtml(c.id)}">Dropped it</button>
            </div>
          </li>
        \`).join("")}
      </ul>
    </section>
  \`;

  // "Drafts for review" — agent-produced artifacts awaiting approval.
  const draftKindIcon = { email: "✉️", message: "💬", doc: "📄", outline: "🗒", reply: "↩️", other: "📝" };
  const showDrafts = date === today && Array.isArray(drafts) && drafts.length > 0;
  const draftsHtml = !showDrafts ? "" : \`
    <section class="ui-section" id="draftsSection">
      <div class="ui-section-header"><h3>📝 Drafts for review</h3><span class="ui-section-meta">· \${drafts.length}</span></div>
      <ul class="ui-stack" style="list-style:none; padding-left:0; gap: var(--space-2);">
        \${drafts.map((d) => \`
          <li class="ui-card" data-draft="\${escapeHtml(d.id)}" style="padding: var(--space-3);">
            <div style="font-weight:600;">\${draftKindIcon[d.kind] || "📝"} \${escapeHtml(d.title)}\${d.recipient ? \` <span class="ui-meta">→ \${escapeHtml(d.recipient)}</span>\` : ""}</div>
            <textarea class="ui-input" data-draft-body="\${escapeHtml(d.id)}" rows="6" style="width:100%; margin:var(--space-2) 0; font-family:inherit;">\${escapeHtml(d.body)}</textarea>
            <div class="ui-meta" style="margin-bottom:6px;">Draft only — nothing has been sent. Approving marks it ready; sending transmits via a real channel.</div>
            <div class="ui-row" style="gap: var(--space-2); flex-wrap:wrap; align-items:center;">
              <button class="ui-btn ui-btn-accent" data-draft-action="approve" data-id="\${escapeHtml(d.id)}">Approve</button>
              <button class="ui-btn" data-draft-action="save" data-id="\${escapeHtml(d.id)}">Save edits</button>
              <button class="ui-btn ui-btn-ghost" data-draft-action="discard" data-id="\${escapeHtml(d.id)}">Discard</button>
              \${!d.taskId ? "" : \`<button class="ui-btn ui-btn-ghost" data-draft-action="stop-asking" data-id="\${escapeHtml(d.id)}" title="Discard this draft AND retire the task that keeps producing it, so it never drafts again. Reversible from the Tasks tab.">Stop asking</button>\`}
              \${sendChannels.length === 0 ? "" : \`
                <span class="ui-meta" style="margin-left:auto;">Send via</span>
                <input class="ui-input" data-draft-target="\${escapeHtml(d.id)}" placeholder="\${d.recipient ? escapeHtml(d.recipient) : "recipient"}" style="width:auto; min-width:120px;">
                \${sendChannels.map((ch) => \`<button class="ui-btn" data-draft-send="\${escapeHtml(ch)}" data-id="\${escapeHtml(d.id)}">✈️ Telegram</button>\`).join("")}
              \`}
            </div>
          </li>
        \`).join("")}
      </ul>
    </section>
  \`;

  const section = (title, rows, renderRow) => rows.length === 0 ? "" : \`
    <section class="ui-section">
      <div class="ui-section-header"><h3>\${title}</h3><span class="ui-section-meta">· \${rows.length}</span></div>
      <ul class="ui-stack" style="list-style:none; padding-left:0; gap: var(--space-1);">\${rows.map(renderRow).join("")}</ul>
    </section>
  \`;

  main.innerHTML = \`
    <div class="pane">
      <div class="ui-row" style="justify-content: space-between; align-items: flex-start; margin-bottom: var(--space-3);">
        <div>
          <h2 style="margin: 0;">\${escapeHtml(r.date)}</h2>
          <div class="ui-meta">What you got done.</div>
        </div>
        <input type="date" id="todayDate" value="\${escapeHtml(date)}" class="ui-input" style="width: auto;">
      </div>

      <div class="ui-row" style="gap: var(--space-2); margin-bottom: var(--space-4);">
        <span class="ui-badge ui-badge-accent">\${r.counts.completedTasks ?? 0} tasks</span>
        <span class="ui-badge">\${r.counts.skillRuns ?? 0} skill runs</span>
        <span class="ui-badge">\${r.counts.approvedActions ?? 0} agent actions</span>
        \${r.activity?.hoursTracked ? \`<span class="ui-badge">\${r.activity.hoursTracked}h tracked</span>\` : ""}
      </div>

      \${planHtml}

      \${clarifyHtml}

      \${draftsHtml}

      \${section("✅ Completed", r.completedTasks, (t) => \`<li>\${escapeHtml(t.title)}\${t.queue === "agent" ? ' <span class="ui-meta">(agent)</span>' : ""}</li>\`)}
      \${section("✨ Skills run", r.skillRuns, (s) => \`<li>\${escapeHtml(s.skill ?? "(unknown)")}\${typeof s.qualityScore === "number" ? \` <span class="ui-meta">quality \${s.qualityScore.toFixed(2)}</span>\` : ""}</li>\`)}
      \${section("🤖 Agent actions approved", r.approvedActions, (a) => \`<li>\${escapeHtml(a.summary ?? a.toolName)}</li>\`)}
      \${(r.activity?.topApps?.length ?? 0) === 0 ? "" : \`
        <section class="ui-section">
          <div class="ui-section-header"><h3>⏱ Time</h3></div>
          <div class="ui-row" style="flex-wrap: wrap; gap: var(--space-2);">
            \${r.activity.topApps.map((a) => \`<span class="ui-badge"><strong>\${escapeHtml(a.app)}</strong> · \${a.hours}h</span>\`).join("")}
          </div>
        </section>
      \`}
      \${section("🧵 Themes", r.themes, (t) => \`<li>\${escapeHtml(t)}</li>\`)}
      \${section("🔓 Unblocked", r.unblocked, (u) => \`<li>\${escapeHtml(u.title)}</li>\`)}

      \${(r.counts.completedTasks ?? 0) + (r.counts.skillRuns ?? 0) + (r.counts.approvedActions ?? 0) === 0 && (r.activity?.hoursTracked ?? 0) < 0.5
        ? '<div class="ui-empty">Quiet day. Nothing logged.</div>'
        : ""}
    </div>
  \`;

  document.getElementById("todayDate")?.addEventListener("change", (e) => {
    const newDate = e.target.value;
    const url = new URL(window.location.href);
    url.searchParams.set("tab", "today");
    url.searchParams.set("date", newDate);
    history.replaceState(null, "", url.toString());
    renderToday();
  });

  // Clarification quick-answers. One tap resolves the task + records the
  // outcome server-side, then re-renders so the question disappears.
  main.querySelectorAll("[data-clar-answer]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-id");
      const answer = btn.getAttribute("data-clar-answer");
      btn.closest("[data-clar]")?.style && (btn.closest("[data-clar]").style.opacity = "0.5");
      try {
        await fetch("/tasks/clarifications/" + encodeURIComponent(id) + "/answer", {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ answer })
        });
        showToast("Thanks — updated.", true);
      } catch { showToast("Couldn't save that.", false); }
      renderToday();
    });
  });

  // Draft review actions. "Save edits" PATCHes the body without resolving;
  // approve/discard resolve. Approving never sends — it only marks ready.
  main.querySelectorAll("[data-draft-action]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-id");
      const action = btn.getAttribute("data-draft-action");
      const bodyEl = main.querySelector('[data-draft-body="' + id + '"]');
      try {
        if (action === "save") {
          await fetch("/drafts/" + encodeURIComponent(id), {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            credentials: "include",
            body: JSON.stringify({ body: bodyEl ? bodyEl.value : undefined })
          });
          showToast("Draft saved.", true);
          return; // keep it in the queue for further edits / approval
        }
        // Approve persists any in-progress edits first, then resolves.
        if (action === "approve" && bodyEl) {
          await fetch("/drafts/" + encodeURIComponent(id), {
            method: "PATCH", headers: { "content-type": "application/json" }, credentials: "include",
            body: JSON.stringify({ body: bodyEl.value })
          });
        }
        const resolveRes = await fetch("/drafts/" + encodeURIComponent(id) + "/" + action, { method: "POST", credentials: "include" });
        if (action === "stop-asking") {
          // Report the half that actually happened. The draft is always
          // resolvable; the retirement can be skipped (no generating task, an
          // already-completed one), and claiming "won't ask again" when nothing
          // was retired is the exact lie this pair of buttons exists to end.
          const out = await resolveRes.json().catch(() => ({}));
          if (out && out.retired) showToast("Discarded — won't ask again.", true);
          else if (out && out.retireError) showToast("Discarded, but couldn't stop the task: " + out.retireError, false);
          else showToast("Discarded. Nothing to stop — this draft has no live task behind it.", true);
        } else {
          showToast(action === "approve" ? "Approved — ready to use." : "Discarded.", true);
        }
      } catch { showToast("Couldn't update the draft.", false); }
      renderToday();
    });
  });

  // Send a draft through a real channel — explicit, confirmed, transmits.
  main.querySelectorAll("[data-draft-send]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-id");
      const channel = btn.getAttribute("data-draft-send");
      const targetEl = main.querySelector('[data-draft-target="' + id + '"]');
      const bodyEl = main.querySelector('[data-draft-body="' + id + '"]');
      const target = (targetEl && targetEl.value.trim()) || "";
      if (!target) { showToast("Enter a recipient first.", false); return; }
      if (!confirm("Send this draft via " + channel + " to " + target + "? This transmits for real.")) return;
      try {
        // Persist any edits to the body first so we send what's on screen.
        if (bodyEl) {
          await fetch("/drafts/" + encodeURIComponent(id), {
            method: "PATCH", headers: { "content-type": "application/json" }, credentials: "include",
            body: JSON.stringify({ body: bodyEl.value })
          });
        }
        const resp = await fetch("/drafts/" + encodeURIComponent(id) + "/send", {
          method: "POST", headers: { "content-type": "application/json" }, credentials: "include",
          body: JSON.stringify({ channel, target })
        });
        if (resp.ok) showToast("Sent via " + channel + ".", true);
        else { const e = await resp.json().catch(() => ({})); showToast("Send failed: " + (e.error || resp.status), false); }
      } catch { showToast("Send failed.", false); }
      renderToday();
    });
  });
  revealDeepLinkedRecord("draft", "[data-draft]", "draft");
  revealDeepLinkedRecord("clarification", "[data-clar]", "clar");
}

async function renderComputerUse() {
  // Computer-use beta — the agent's intent + reasoning log. Shows every
  // action the agent decided to take in a session, with the reasoning it gave.
  // A connected node executes; observation-only mode reads recent OCR and
  // refuses input honestly.
  const [data, pendingData] = await Promise.all([
    fetchJson("/computer-use/log?limit=200").catch(() => ({ sessions: [], actions: [], stats: {} })),
    fetchJson("/pending-actions?status=pending").catch(() => ({ actions: [] }))
  ]);
  const { sessions = [], actions = [], stats = {}, enabled = false, readiness = {} } = data;
  const computerApprovals = (pendingData.actions ?? []).filter((action) => action.toolName === "start_computer_use_session");
  const active = sessions.find((s) => s.status === "active");
  const modeCopy = readiness.mode === "control-ready"
    ? "Ready — privacy-filtered live screenshots plus click, type, key, move, and scroll actions execute through the selected computer-use node."
    : readiness.mode === "node-unreachable"
      ? "Enabled, but the configured computer-use node is unreachable. Screen reads fall back to recent OCR; input is refused."
      : readiness.mode === "observe-only"
        ? "Observation-only — the agent can inspect recent local OCR. Click, type, key, and move require a connected computer-use node; scroll is not yet supported."
        : "Off — enable it here before asking the agent to inspect or control the computer.";

  const computerActionCopy = (action) => {
    const args = action?.args && typeof action.args === "object" ? action.args : {};
    const text = (value, max = 100) => {
      if (value == null) return "";
      const valueText = typeof value === "string" ? value : String(value);
      return valueText.length > max ? valueText.slice(0, max) + "…" : valueText;
    };
    switch (action?.kind) {
      case "screenshot": return "Inspect the current screen";
      case "click": return "Click at x " + text(args.x) + ", y " + text(args.y);
      case "type": return "Type " + text(args.characterCount ?? 0) + " redacted character" + (args.characterCount === 1 ? "" : "s");
      case "key": return "Press “" + text(args.chord) + "”";
      case "move": return "Move the pointer to x " + text(args.x) + ", y " + text(args.y);
      case "scroll": return "Scroll by x " + text(args.deltaX ?? 0) + ", y " + text(args.deltaY ?? 0);
      default: {
        const details = Object.entries(args).slice(0, 4).map(([key, value]) => {
          const readable = value != null && typeof value === "object" ? "details recorded" : text(value, 60);
          return key.replaceAll("_", " ") + ": " + readable;
        });
        return details.length > 0 ? details.join(" · ") : "No extra details";
      }
    }
  };

  const sessionCard = (s) => {
    const sActions = actions.filter((a) => a.sessionId === s.id);
    const isActive = s.status === "active";
    const statusBadge = isActive
      ? '<span class="ui-badge ui-badge-accent">active</span>'
      : s.status === "aborted"
        ? '<span class="ui-badge ui-badge-err">aborted</span>'
        : '<span class="ui-badge">' + escapeHtml(s.status) + '</span>';
    return \`
      <div class="ui-card" style="margin-bottom: var(--space-3);">
        <div class="ui-row" style="justify-content: space-between;">
          <div class="ui-grow">
            <div style="font-weight: 600;">\${escapeHtml(s.goal || "(no goal stated)")}</div>
            <div class="ui-meta">Started \${escapeHtml(new Date(s.startedAt).toLocaleString())} · approved by \${escapeHtml(s.approvedBy ?? "?")} · \${sActions.length} action\${sActions.length === 1 ? "" : "s"}</div>
            \${s.endedAt ? \`<div class="ui-meta">Ended \${escapeHtml(new Date(s.endedAt).toLocaleString())}\${s.endReason ? " · " + escapeHtml(s.endReason) : ""}</div>\` : ""}
          </div>
          <div>\${statusBadge}</div>
        </div>
        \${isActive ? \`<div style="margin-top: var(--space-2);"><button class="ui-btn ui-btn-destructive ui-btn-sm" data-abort="\${escapeHtml(s.id)}">⛔ Stop session</button></div>\` : ""}
        \${sActions.length > 0 ? \`
          <details \${isActive ? "open" : ""} style="margin-top: var(--space-2);">
            <summary class="ui-meta" style="cursor: pointer;">\${sActions.length} action\${sActions.length === 1 ? "" : "s"}</summary>
            <ol style="margin: var(--space-2) 0 0; padding-left: var(--space-4);">
              \${sActions.slice().reverse().map((a) => \`
                <li style="margin-bottom: var(--space-2);">
                  <div><strong>\${escapeHtml(a.kind.replaceAll("_", " "))}</strong> — \${escapeHtml(computerActionCopy(a))}</div>
                  \${a.reasoning ? \`<div class="ui-meta">"\${escapeHtml(a.reasoning)}"</div>\` : '<div class="ui-meta" style="opacity:0.6;">(no reasoning given)</div>'}
                  <div class="ui-meta">\${escapeHtml(a.status)} · \${escapeHtml(new Date(a.createdAt).toLocaleTimeString())}</div>
                </li>
              \`).join("")}
            </ol>
          </details>
        \` : ""}
      </div>
    \`;
  };

  main.innerHTML = \`
    <div class="pane">
      <div class="ui-row" style="justify-content: space-between; align-items: flex-start; margin-bottom: var(--space-3);">
        <div>
          <h2 style="margin: 0;">Computer Use <span class="ui-badge">beta</span></h2>
          <div class="ui-meta" style="margin-top: 2px;">\${escapeHtml(modeCopy)}</div>
        </div>
        <button
          id="computerUseToggle"
          class="ui-btn \${enabled ? "" : "ui-btn-ghost"} ui-btn-sm"
          data-enabled="\${enabled ? "1" : "0"}"
          title="Toggle computer-use tools on or off without restarting the daemon. Off-flips any active session and unregisters the tools so the agent stops seeing them."
        >\${enabled ? "✓ Enabled" : "Disabled"}</button>
      </div>

      <p class="ui-muted">Every action the agent intends to take is recorded here with its stated reasoning. Sessions are user-approved (via the standard approval gate). You can abort an active session at any time.</p>

      \${pendingActionsSectionHtml(computerApprovals, {
        heading: "Computer-use requests awaiting approval"
      })}

      \${(stats.active ?? 0) > 1
        ? '<div class="card warn-banner"><div class="name">Multiple active sessions detected</div><div class="desc">This came from the old approval-loop bug. Only the newest session is used; stop the older sessions below. New approvals can no longer create duplicates.</div></div>'
        : ""}

      <div class="ui-card" style="margin: var(--space-3) 0;">
        <div class="ui-row" style="gap:var(--space-2); flex-wrap:wrap;">
          <span class="ui-badge \${readiness.screenshot && readiness.screenshot !== "disabled" ? "ui-badge-accent" : ""}">screen: \${escapeHtml(readiness.screenshot ?? "disabled")}</span>
          <span class="ui-badge \${readiness.inputAvailable ? "ui-badge-accent" : ""}">input: \${readiness.inputAvailable ? "ready" : "not ready"}</span>
          <span class="ui-badge">tools: \${readiness.toolsRegistered ? "registered" : "hidden"}</span>
        </div>
        <div style="margin-top:var(--space-3);">
          <button id="computerUseTry" class="ui-btn ui-btn-sm" \${enabled ? "" : "disabled"}>Try in Chat</button>
          <span class="ui-meta" style="margin-left:8px;">Starts with an explicit screen-inspection request; the session approval still appears before use.</span>
        </div>
      </div>

      <div class="ui-row" style="gap: var(--space-2); margin: var(--space-3) 0;">
        <span class="ui-badge">\${stats.sessions ?? 0} sessions</span>
        <span class="ui-badge ui-badge-accent">\${stats.active ?? 0} active</span>
        <span class="ui-badge">\${stats.actions ?? 0} actions</span>
      </div>

      \${sessions.length === 0
        ? \`<div class="ui-empty">No sessions yet. When the agent decides to use the computer, it has to call <code>start_computer_use_session</code> with a goal — you approve, then it can act.</div>\`
        : sessions.map(sessionCard).join("")}
    </div>
  \`;

  bindPendingActionButtons(async () => {
    await renderComputerUse();
    await refreshApprovalBadge();
  });

  document.querySelectorAll("[data-abort]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.abort;
      if (!confirm("Abort this computer-use session? The agent will be told to stop.")) return;
      try {
        await postJson(\`/computer-use/sessions/\${encodeURIComponent(id)}/abort\`, {});
        showToast("Session aborted.", true);
        await renderComputerUse();
      } catch (err) {
        showToast("Abort failed: " + err.message, false);
      }
    });
  });

  document.getElementById("computerUseTry")?.addEventListener("click", () => {
    switchTab("chat");
    requestAnimationFrame(() => {
      const input = document.getElementById("input");
      if (!input) return;
      input.value = "Use computer use to inspect what is on my screen right now. Tell me what you can see before taking any action.";
      input.dispatchEvent(new Event("input"));
      input.focus();
    });
  });

  const toggleBtn = document.getElementById("computerUseToggle");
  if (toggleBtn) {
    toggleBtn.addEventListener("click", async () => {
      const wasEnabled = toggleBtn.dataset.enabled === "1";
      const enable = !wasEnabled;
      // Enabling is one click; disabling needs a quick confirm because
      // it'll abort any active session.
      if (!enable && (stats.active ?? 0) > 0) {
        if (!confirm("Disable computer-use? This will abort " + stats.active + " active session(s).")) return;
      }
      toggleBtn.disabled = true;
      toggleBtn.textContent = enable ? "Enabling…" : "Disabling…";
      try {
        await postJson("/computer-use/toggle", { enable });
        showToast(enable ? "✓ Computer-use enabled. Tools registered." : "Computer-use disabled. Tools removed.", true);
        await renderComputerUse();
      } catch (err) {
        showToast("Toggle failed: " + err.message, false);
        toggleBtn.disabled = false;
        toggleBtn.textContent = wasEnabled ? "✓ Enabled" : "Disabled";
      }
    });
  }
}

async function renderActivity() {
  const stats = await fetchJson("/observations/stats").catch(() => ({}));
  state.activityFilter = state.activityFilter || { query: "" };
  main.innerHTML = \`
    <div class="pane">
      <h2>Activity <span class="muted" style="font-weight:400;font-size:14px;">· \${stats.mode === "sqlite" ? \`\${stats.activity ?? 0} events · \${stats.frames ?? 0} frames\` : \`mode: \${escapeHtml(stats.mode ?? "—")}\`}</span></h2>

      \${stats.mode !== "sqlite" && stats.mode !== "fallback-jsonl"
        ? '<div class="card warn-banner"><div class="name">Capture not running</div><div class="desc">Install the Mac app and grant Screen Recording + Accessibility permissions, or this view will be empty. Activity events appear as soon as the Mac app starts pushing.</div></div>'
        : ""}

      <div class="row" style="gap:10px;margin:14px 0;">
        <input type="search" id="actSearch" placeholder="Search OCR text or window titles…" value="\${escapeHtml(state.activityFilter.query)}" style="flex:1;">
        <select id="actSince" style="width:160px;">
          <option value="">All time</option>
          <option value="1h">Last hour</option>
          <option value="6h">Last 6 hours</option>
          <option value="24h" selected>Last 24 hours</option>
          <option value="7d">Last 7 days</option>
        </select>
      </div>

      <h3>Timeline (last 24h)</h3>
      <div id="timeline" class="card" style="padding:14px;"></div>

      <h3>Results</h3>
      <div id="actResults" class="grid"></div>
    </div>
  \`;
  const reload = async () => {
    const since = sinceFromOption($("actSince").value);
    const q = $("actSearch").value.trim();
    state.activityFilter.query = q;
    const results = await fetchJson("/observations/search?" + new URLSearchParams({
      ...(q ? { q } : {}),
      ...(since ? { since } : {}),
      limit: "60"
    }).toString());
    renderActivityResults(results);
  };
  const reloadTimeline = async () => {
    const tl = await fetchJson("/observations/timeline?since=" + encodeURIComponent(new Date(Date.now() - 24*3600*1000).toISOString()));
    renderTimeline(tl);
  };
  $("actSearch").addEventListener("input", debounce(reload, 250));
  $("actSince").addEventListener("change", reload);
  await Promise.all([reload(), reloadTimeline()]);
}

function sinceFromOption(value) {
  if (!value) return null;
  const m = { "1h": 1, "6h": 6, "24h": 24, "7d": 24 * 7 };
  const hours = m[value];
  if (!hours) return null;
  return new Date(Date.now() - hours * 3600 * 1000).toISOString();
}

function renderActivityResults(results) {
  const list = $("actResults");
  if (!list) return;
  if (!results || results.length === 0) {
    list.innerHTML = '<div class="empty">No matching activity yet.</div>';
    return;
  }
  list.innerHTML = results.map((r) => {
    const meta = [r.app, r.window].filter(Boolean).map(escapeHtml).join(" · ");
    const when = r.at ? new Date(r.at).toLocaleString() : "";
    const rawSnippet = r.snippet || r.text || r.window || r.event || "";
    // Stored observation text (BuildBetter transcripts, OCR of viewed pages)
    // is untrusted — escape it before innerHTML, but keep the FTS <mark>
    // highlight tags the search injects.
    const snippet = escapeHtml(rawSnippet).replaceAll("&lt;mark&gt;", "<mark>").replaceAll("&lt;/mark&gt;", "</mark>");
    return \`<div class="card">
      <div class="row between"><span class="name">\${escapeHtml(meta) || "(no app)"}</span><span class="muted" style="font-size:11px;">\${escapeHtml(when)}</span></div>
      <div class="desc" style="margin-top:6px;line-height:1.5;">\${snippet}</div>
    </div>\`;
  }).join("");
}

function renderTimeline(rows) {
  const host = $("timeline");
  if (!host) return;
  if (!rows || rows.length === 0) { host.innerHTML = '<div class="muted">No data in this window.</div>'; return; }
  // Group by hour, then show per-app stacked bars
  const byHour = new Map();
  const apps = new Set();
  for (const r of rows) {
    if (!byHour.has(r.hour)) byHour.set(r.hour, {});
    byHour.get(r.hour)[r.app || "—"] = r.n;
    apps.add(r.app || "—");
  }
  const sortedHours = [...byHour.keys()].sort();
  const max = Math.max(...rows.map((r) => r.n));
  const palette = ["#6fe1b1", "#f0b454", "#a98ef5", "#7ab8ff", "#f08080", "#94a9b1"];
  const appColor = {};
  [...apps].forEach((a, i) => appColor[a] = palette[i % palette.length]);
  host.innerHTML = \`
    <div style="display:grid;grid-template-columns:repeat(\${sortedHours.length},1fr);gap:2px;align-items:end;height:80px;">
      \${sortedHours.map((h) => {
        const cell = byHour.get(h);
        const total = Object.values(cell).reduce((a, b) => a + b, 0);
        const stack = Object.entries(cell).map(([app, n]) =>
          \`<div style="height:\${(n / max) * 100}%;background:\${appColor[app]};" title="\${escapeHtml(app)}: \${n}"></div>\`
        ).join("");
        return \`<div title="\${escapeHtml(h)}: \${total}" style="display:flex;flex-direction:column-reverse;height:100%;">\${stack}</div>\`;
      }).join("")}
    </div>
    <div style="display:flex;justify-content:space-between;color:var(--muted);font-size:11px;margin-top:6px;">
      <span>\${escapeHtml(sortedHours[0] ?? "")}</span>
      <span>\${escapeHtml(sortedHours.at(-1) ?? "")}</span>
    </div>
    <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:10px;">
      \${[...apps].map((a) => \`<span class="chip" style="border-color:\${appColor[a]};color:\${appColor[a]};">\${escapeHtml(a)}</span>\`).join("")}
    </div>
  \`;
}

function revealDeepLinkedRecord(paramName, selector, datasetKey) {
  const id = new URLSearchParams(window.location.search).get(paramName);
  if (!id) return;
  const row = [...main.querySelectorAll(selector)].find((candidate) => candidate.dataset?.[datasetKey] === id);
  if (!row) return;
  row.scrollIntoView({ block: "center" });
  row.style.outline = "2px solid var(--accent)";
  row.style.outlineOffset = "2px";
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

async function fetchJson(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(\`\${path} -> \${r.status}\`);
  return r.json();
}
async function postJson(path, body) {
  const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
  if (!r.ok) {
    const b = await r.json().catch(() => ({}));
    // Surface the structured error code (e.g. "budget") + status so callers
    // can tell "you hit your daily cap" apart from a network/agent failure.
    const err = new Error(b.code === "budget" ? (b.error ?? "Daily budget exceeded") + " — raise OPENAGI_DAILY_USD_LIMIT in setup." : (b.error ?? \`\${path} -> \${r.status}\`));
    err.code = b.code; err.status = r.status;
    throw err;
  }
  return r.json();
}

// Opt in to the daemon's direct lifecycle stream for a single chat request.
// Visible model text arrives incrementally as delta frames while provider
// adapters still reconstruct complete structured responses for tool loops. The
// final frame remains the exact JSON object legacy callers receive.
async function postMessageStream(body, onEvent = () => {}) {
  const r = await fetch("/message", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify(body ?? {})
  });
  const contentType = (r.headers.get("content-type") ?? "").toLowerCase();
  if (!contentType.includes("text/event-stream")) {
    const payload = await r.json().catch(() => ({}));
    if (!r.ok) {
      const err = new Error(payload.code === "budget"
        ? (payload.error ?? "Daily budget exceeded") + " — raise OPENAGI_DAILY_USD_LIMIT in setup."
        : (payload.error ?? "/message -> " + r.status));
      err.code = payload.code; err.status = r.status;
      err.terminal = true;
      throw err;
    }
    return payload;
  }
  if (!r.ok) {
    const err = new Error("/message -> " + r.status);
    err.status = r.status; err.terminal = true;
    throw err;
  }
  if (!r.body) throw new Error("The agent response stream was unavailable.");

  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let final = null;
  let failure = null;

  const consume = (frame) => {
    let event = "message";
    const data = [];
    for (const rawLine of frame.split(/\\r?\\n/)) {
      if (!rawLine || rawLine.startsWith(":")) continue;
      const colon = rawLine.indexOf(":");
      const field = colon < 0 ? rawLine : rawLine.slice(0, colon);
      let value = colon < 0 ? "" : rawLine.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "event") event = value || "message";
      if (field === "data") data.push(value);
    }
    if (data.length === 0) return;
    let payload;
    try { payload = JSON.parse(data.join("\\n")); }
    catch { return; }
    onEvent(event, payload);
    if (event === "final") final = payload;
    if (event === "failure") failure = payload;
  };

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    const frames = buffer.split(/\\r?\\n\\r?\\n/);
    buffer = frames.pop() ?? "";
    for (const frame of frames) consume(frame);
    if (done) break;
  }
  if (buffer.trim()) consume(buffer);
  if (failure) {
    const err = new Error(failure.code === "budget"
      ? (failure.error ?? "Daily budget exceeded") + " — raise OPENAGI_DAILY_USD_LIMIT in setup."
      : (failure.error ?? "The agent could not complete that request."));
    err.code = failure.code;
    err.terminal = true;
    throw err;
  }
  if (!final) throw new Error("The response stream ended before the agent finished.");
  return final;
}
// Both quote characters are escaped: nearly every caller drops the result into
// an attribute inside a template literal, and an unescaped ' or " ends that
// attribute and starts a new one (that is exactly how the markdown link
// injection worked).
function escapeHtml(s) { return String(s ?? "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]); }

// Inline help marker — renders a (?) chip with a hover tooltip. Use it for
// obscure terms in dense panes so users don't have to leave the page to
// understand what something means. Returns markup; caller composes it
// into the surrounding template literal.
// Example (with escaped dollar so the outer renderApp Node template
// doesn't try to interpolate it): Memory tier \\\${uiHelp("Short is RAM...")}
function uiHelp(text) {
  return \`<span class="ui-help" tabindex="0" aria-label="\${escapeHtml(text)}">?<span class="ui-help-tip">\${escapeHtml(text)}</span></span>\`;
}

async function refreshHealth() {
  try {
    const [h, b, p] = await Promise.all([
      fetchJson("/health"),
      fetchJson("/budget").catch(() => null),
      fetchJson("/admin/provider").catch(() => null)
    ]);
    state.health = h;
    const provider = h.status.agentHost?.provider ?? "—";
    const model = h.status.agentHost?.providerModel ?? "";
    const configured = h.status.agentHost?.providerConfigured;
    const providerLabel = model ? \`\${provider} · \${model}\` : provider;
    const budgetLabel = b ? \`$\${b.spentUsd.toFixed(2)} / $\${b.dailyUsdLimit.toFixed(2)}\` : "";
    // Render as discrete nowrap pills so the header wraps cleanly between
    // pieces instead of breaking mid-pill (which produced the orphaned
    // "· $0.07 / $10.00" line in the old textContent layout).
    const pills = [
      \`<span class="status-pill">online</span>\`,
      \`<span class="status-pill">\${escapeHtml(providerLabel)} \${configured ? "✓" : "(no key)"}</span>\`,
      budgetLabel ? \`<span class="status-pill">\${escapeHtml(budgetLabel)}</span>\` : ""
    ].filter(Boolean);
    $("status").innerHTML = pills.join("");
    if (p) renderProviderSwitch(p);
  } catch {
    $("status").innerHTML = '<span class="status-pill">offline</span>';
  }
}

async function refreshAmbientBadge() {
  let host = document.getElementById("ambientBadge");
  if (!host) {
    host = document.createElement("span");
    host.id = "ambientBadge";
    host.style.cssText = "margin-left:12px;font-size:12px;padding:3px 9px;border-radius:10px;border:1px solid var(--line);color:var(--muted);cursor:pointer;user-select:none;white-space:nowrap;";
    host.title = "Ambient context — what the agent sees from your screen. Click to view Activity tab.";
    host.addEventListener("click", () => switchTab("activity"));
    const slot = document.querySelector("header .status")?.parentElement;
    if (slot) slot.appendChild(host);
  }
  try {
    const ctx = await fetchJson("/observations/recent-context?minutes=10");
    const apps = ctx.apps?.length ?? 0;
    const snippets = ctx.snippets?.length ?? 0;
    if (apps === 0 && snippets === 0) {
      host.textContent = "👀 capture idle";
      host.style.color = "var(--muted)";
      host.style.borderColor = "var(--line)";
    } else {
      const topApp = ctx.apps?.[0]?.app?.split(".").pop() ?? "";
      host.textContent = \`👀 \${apps} app\${apps === 1 ? "" : "s"} · \${snippets} snippet\${snippets === 1 ? "" : "s"}\${topApp ? " · " + topApp : ""}\`;
      host.style.color = "var(--accent)";
      host.style.borderColor = "var(--accent)";
    }
  } catch {
    host.textContent = "👀 capture off";
    host.style.color = "var(--muted)";
    host.style.borderColor = "var(--line)";
  }
}

function renderProviderSwitch(p) {
  let host = document.getElementById("providerSwitch");
  if (!host) {
    host = document.createElement("span");
    host.id = "providerSwitch";
    host.style.marginLeft = "12px";
    host.style.fontSize = "12px";
    document.querySelector("header .status")?.parentElement?.appendChild(host);
  }
  const opts = [
    \`<option value="auto" \${p.preference === "auto" ? "selected" : ""}>auto</option>\`,
    \`<option value="anthropic" \${p.preference === "anthropic" ? "selected" : ""} \${!p.available?.anthropic ? "disabled" : ""}>Anthropic\${p.available?.anthropic ? "" : " (no key)"}</option>\`,
    \`<option value="openai" \${p.preference === "openai" ? "selected" : ""} \${!p.available?.openai ? "disabled" : ""}>OpenAI / ChatGPT\${p.available?.openai ? "" : " (no key)"}</option>\`
  ].join("");
  host.innerHTML = \`<label style="color:var(--muted);">model: <select id="providerSelect" style="background:var(--bg);color:var(--text);border:1px solid var(--line);border-radius:4px;padding:2px 6px;font-size:12px;">\${opts}</select></label>\`;
  document.getElementById("providerSelect").addEventListener("change", async (e) => {
    try {
      await postJson("/admin/provider", { preference: e.target.value });
      refreshHealth();
    } catch (err) { alert("Switch failed: " + err.message); }
  });
}

const evt = new EventSource("/events");
evt.addEventListener("message", (e) => {
  try {
    const data = JSON.parse(e.data);
    if (state.tab === "chat" && data.sessionId === state.sessionId) {
      // A dashboard opened while Quick Ask is still working did not make the
      // direct POST and therefore has no response callback of its own. Reload
      // the named session when the daemon announces completion. The old skip
      // left that dashboard showing "pending" forever even though the answer
      // had already been persisted.
      refreshActiveChatSession(data.sessionId, { force: true }).catch(() => {});
    } else {
      refreshSessions();
    }
  } catch {}
});
evt.addEventListener("cron", (e) => {
  // Schedule changes (add/remove) redraw the tab. A run starting or finishing
  // must NOT — refreshCron() re-renders the detail pane from the first job and
  // would wipe the outcome of the run the user is watching.
  let op = null;
  try { op = JSON.parse(e.data ?? "{}").op ?? null; } catch { op = null; }
  if (op === "run" || op === "run-accepted") return;
  if (state.tab === "cron") refreshCron();
});
evt.addEventListener("mcp", (e) => {
  if (state.tab === "mcp" && !composerOpen) refreshMcp();
  // Surface OAuth-required as a system notification if the page is unfocused
  try {
    const data = JSON.parse(e.data);
    if (data.op === "oauth-required" && document.hidden) {
      // Best-effort browser notification
      if ("Notification" in window && Notification.permission === "granted") {
        new Notification("OpenAGI · OAuth required", { body: data.name + " — open the MCP tab to authorize." });
      }
    }
  } catch {}
});

function refreshApprovalSurfaces() {
  refreshApprovalBadge();
  if (state.tab === "approvals") renderApprovals();
  else if (state.tab === "computer-use") renderComputerUse();
  else if (state.tab === "suggestions") renderSuggestions();
}
evt.addEventListener("pending-action", refreshApprovalSurfaces);
evt.addEventListener("pending-action-resolved", refreshApprovalSurfaces);

// New skill candidate proposed by the pattern miner or session miner.
// Refresh the Skills tab if the user is on it; otherwise show a browser
// notification (the Mac app also fires its own native notification — see
// AppState SSE handler).
evt.addEventListener("skill-candidate", (e) => {
  if (state.tab === "skills") refreshSkills(true);
  try {
    const data = JSON.parse(e.data);
    if ("Notification" in window && Notification.permission === "granted") {
      new Notification("OpenAGI learned a new skill candidate", {
        body: (data.name || "untitled") + (data.description ? " — " + data.description : "")
      });
    }
  } catch {}
});

// Proactive suggestion — the observer noticed something it can help with.
// Show as a high-prominence toast (clickable to accept/reject) and fire a
// browser notification so the user sees it even if the dashboard isn't
// foregrounded. The Mac app's SSE delegate will also fire a native
// notification.
evt.addEventListener("proactive-suggestion", (e) => {
  try {
    const data = JSON.parse(e.data);
    const tag = data.category === "mcp" ? "✨ MCP" : data.category === "skill" ? "✨ Skill" : data.category === "automation" ? "✨ Auto" : "✨ FYI";
    const body = (data.title || "Suggestion") + (data.rationale ? " — " + data.rationale : "");
    showToast(tag + ": " + body, true);
    if ("Notification" in window && Notification.permission === "granted") {
      new Notification("OpenAGI noticed something", { body });
    }
  } catch {}
});

// Tasks updated — refresh tasks tab if visible, otherwise quiet.
evt.addEventListener("task-updated", () => {
  if (state.tab === "tasks") renderTasks();
});

// Auto-changed task (observation-driven completion or in-progress).
// Surface as a toast so the user sees what we did and can revert.
evt.addEventListener("task-auto-changed", (e) => {
  try {
    const data = JSON.parse(e.data);
    const verb = data.action === "complete" ? "Completed" : "Started";
    const icon = data.action === "complete" ? "✓" : "▶";
    const conf = data.confidence ? \` (\${Math.round(data.confidence * 100)}%)\` : "";
    // Show which evidence sources corroborated, so an auto-change is never a
    // black box — e.g. "via ocr+rize".
    const srcs = Array.isArray(data.sources) && data.sources.length ? \` · via \${data.sources.join("+")}\` : "";
    showToast(\`\${icon} Auto-\${verb.toLowerCase()}: \${data.title}\${conf}\${data.evidence ? " — " + data.evidence : ""}\${srcs}\`, true);
    if (state.tab === "tasks") renderTasks();
  } catch {}
});

// Morning plan ready — toast + browser notification; refresh Today if open.
evt.addEventListener("daily-plan", (e) => {
  try {
    const data = JSON.parse(e.data);
    showToast("🗓 " + (data.title || "Your day is planned") + (data.body ? " — " + data.body : ""), true);
    if ("Notification" in window && Notification.permission === "granted") {
      new Notification(data.title || "Your day", { body: data.body || "" });
    }
    if (state.tab === "today") renderToday();
  } catch {}
});

// A draft is ready for review — agent finished a draft-only task. Toast +
// refresh Today so the draft card appears immediately.
evt.addEventListener("draft-created", (e) => {
  try {
    const data = JSON.parse(e.data);
    showToast("📝 Draft ready to review: " + (data.title || "untitled"), true);
    if ("Notification" in window && Notification.permission === "granted") {
      new Notification("Draft ready to review", { body: data.title || "" });
    }
    if (state.tab === "today") renderToday();
  } catch {}
});

// Clarification queued — the agent needs your call on a task. Toast +
// refresh the Today tab if it's open so the question appears immediately.
evt.addEventListener("clarification-created", (e) => {
  try {
    const data = JSON.parse(e.data);
    showToast("❓ " + (data.question || "Need your call on a task"), true);
    if ("Notification" in window && Notification.permission === "granted") {
      new Notification("Needs your call", { body: data.question || "" });
    }
    if (state.tab === "today") renderToday();
  } catch {}
});

// Task notification (created, morning digest, or due-date) — toast + browser notif.
evt.addEventListener("task-reminder", (e) => {
  try {
    const data = JSON.parse(e.data);
    const icon = data.kind === "digest" || data.kind === "created" ? "📋 " : "⏰ ";
    showToast(icon + data.title + (data.body ? " — " + data.body : ""), true);
    if ("Notification" in window && Notification.permission === "granted") {
      new Notification(data.title, { body: data.body || "" });
    }
  } catch {}
});

// Cron catch-up: jobs that should've run during a sleep window are
// firing now. Surface a toast so the user knows the system noticed.
evt.addEventListener("cron-catchup", (e) => {
  try {
    const data = JSON.parse(e.data);
    const n = data.count ?? 0;
    const names = (data.jobs ?? []).slice(0, 3).map((j) => j.name).join(", ");
    const extra = (data.jobs?.length ?? 0) > 3 ? " (+" + (data.jobs.length - 3) + " more)" : "";
    const word = n === 1 ? "job" : "jobs";
    const tail = names ? ": " + names : "";
    showToast("✓ Caught up " + n + " missed cron " + word + tail + extra, true);
  } catch {}
});

setInterval(refreshHealth, 5000);
refreshHealth();
refreshApprovalBadge();
setInterval(refreshAmbientBadge, 15000);
refreshAmbientBadge();
// Recovery path for a missed SSE event (dashboard opened after completion,
// laptop wake, EventSource reconnect). Poll only while the selected durable
// request genuinely has no terminal assistant message, so ordinary chat costs
// no background requests.
setInterval(() => {
  if (state.tab !== "chat" || !state.sessionId) return;
  const id = state.activeRequestId || latestChatRequestId(state.messages);
  const outcome = requestState(state.messages, id);
  const waitingForPersistence = !outcome && Boolean(id)
    && CHAT_REQUEST_LIVE_STAGES.includes(state.activeRequestStage);
  if (waitingForPersistence && state.activeRequestMissingSince
      && Date.now() - state.activeRequestMissingSince > CHAT_REQUEST_STALE_MS) {
    state.activeRequestStage = "interrupted";
    state.activeRequestMissingSince = null;
    renderChat();
  } else if (outcome?.status === "pending" || waitingForPersistence) {
    refreshActiveChatSession(state.sessionId).catch(() => {});
  } else if (outcome?.status === "interrupted" && state.activeRequestStage !== "interrupted") {
    state.activeRequestStage = "interrupted";
    renderChat();
  }
}, 2000);

// Honor ?tab=X in URL on first load — notifications + Mac tray menu deep-link
// to specific tabs and we need to land on them. Defaults to chat.
const VALID_TABS = new Set(["chat","tasks","review","approvals","memory","cron","skills","mcp","integrations","agents","nodes","channels","budget","outcomes","scrutiny","health","activity","suggestions","computer-use","today"]);
const initialTab = (() => {
  try {
    const t = new URLSearchParams(window.location.search).get("tab");
    return t && VALID_TABS.has(t) ? t : "chat";
  } catch { return "chat"; }
})();
// ?session=<id> rides along with ?tab=chat when the Quick Ask popover hands a
// conversation over. Resolved AFTER switchTab so the chat tab, its sidebar and
// its composer already exist; landing on a different tab ignores it entirely.
// This runs off the URL rather than any in-page state, so it works the same
// whether the dashboard was closed, already open on Tasks, or already open on
// a different chat session — every click is a fresh navigation.
const initialSession = deepLinkSessionId(window.location.search);
const initialRequest = deepLinkRequestId(window.location.search);
(async () => {
  await switchTab(initialTab);
  if (initialTab === "chat" && initialSession) await openSessionDeepLink(initialSession, initialRequest);
})();
</script>
</body>
</html>`;
}
