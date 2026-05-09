import http from "node:http";
import fsSync from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { createDefaultRuntime } from "./abi-runtime.js";
import {
  buildSetCookie,
  checkAuth,
  checkOrigin,
  isPublicRoute,
  verifyTelegramSecret,
  verifyTwilioSignature
} from "./auth.js";
import { ChannelManager } from "./channels.js";
import { isFirstRun, renderWizard, saveEnv } from "./setup-wizard.js";

export function createHostedInterface(runtime = createDefaultRuntime(), options = {}) {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 43210;
  // Read these dynamically so the setup wizard can update them mid-flight.
  const getAuthToken = () => options.authToken ?? process.env.OPENAGI_AUTH_TOKEN ?? null;
  const getPublicUrl = () => options.publicUrl ?? process.env.OPENAGI_PUBLIC_URL ?? null;
  const getTwilioAuthToken = () => options.twilioAuthToken ?? process.env.TWILIO_AUTH_TOKEN ?? null;
  const getTelegramSecret = () => options.telegramSecret ?? process.env.TELEGRAM_WEBHOOK_SECRET ?? null;
  const channels =
    options.channels ??
    (runtime.agentHost
      ? new ChannelManager({
          agentHost: runtime.agentHost,
          runtime,
          dir: options.channelsDir,
          telegramToken: options.telegramToken,
          twilioAccountSid: options.twilioAccountSid,
          twilioAuthToken: options.twilioAuthToken,
          twilioFromNumber: options.twilioFromNumber
        })
      : null);

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
  events.on("proactive-suggestion", (data) => broadcast("proactive-suggestion", data));
  events.on("task-updated", (data) => broadcast("task-updated", data));
  events.on("task-reminder", (data) => broadcast("task-reminder", data));
  if (runtime.skillReplay) runtime.skillReplay.bindEvents(events);

  // Expose the bus to runtime subsystems (pattern miner, session miner) so
  // they can emit "skill-candidate" without holding a reference to this
  // module. Set non-enumerably so JSON serialization of runtime stays clean.
  if (!runtime.events) {
    Object.defineProperty(runtime, "events", { value: events, enumerable: false });
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

  if (runtime.agentHost) {
    const original = runtime.agentHost.handleMessage.bind(runtime.agentHost);
    runtime.agentHost.handleMessage = async (input) => {
      const result = await original(input);
      events.emit("message", {
        sessionId: result.session.id,
        agent: result.agent,
        reply: result.reply,
        toolCalls: result.output?.scrutiny?.action ? [] : []
      });
      return result;
    };
  }

  let tickerHandle = null;
  const tickerMs = options.tickerMs ?? Number.parseInt(process.env.OPENAGI_TICKER_MS ?? "10000", 10);

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host ?? `${host}:${port}`}`);
      const pathname = url.pathname;
      const method = req.method;

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
        const auth = checkAuth(req, url, getAuthToken());
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
        return sendHtml(res, 200, renderWizard(), extraCookies);
      }
      if (method === "POST" && pathname === "/setup/save") {
        const body = await readJson(req);
        const dataDir = process.env.OPENAGI_DATA_DIR ?? ".openagi";
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
          const turn = await channels.handleLocalMessage({ text: body.text ?? "Say hi in one short sentence.", from: "setup" });
          return sendJson(res, 200, { reply: turn.reply, model: turn.model });
        } catch (error) {
          return sendJson(res, 500, { error: error.message });
        }
      }

      if (method === "GET" && pathname === "/" && extraCookies.length) {
        // Strip ?token from URL after we set the cookie.
        const clean = url.pathname;
        res.writeHead(302, { Location: clean, "Set-Cookie": extraCookies });
        return res.end();
      }

      if (method === "GET" && pathname === "/") return sendHtml(res, 200, renderApp(), extraCookies);
      if (method === "GET" && pathname === "/health") return sendJson(res, 200, { ok: true, status: runtime.status() });
      if (method === "GET" && pathname === "/memory") return sendJson(res, 200, runtime.memory.snapshot());
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
      if (method === "GET" && pathname === "/channels") {
        const status = channels?.status() ?? { enabled: false };
        const pub = getPublicUrl();
        return sendJson(res, 200, { ...status, publicUrl: pub, twilioWebhook: pub ? `${pub.replace(/\/$/, "")}/channels/twilio/webhook` : null });
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
        const result = await channels.handleLocalMessage(body);
        return sendJson(res, 200, result);
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

      if (method === "POST" && pathname === "/channels/twilio/webhook") {
        if (!channels) return sendXml(res, 503, twiml("OpenAGI agent host is disabled."));
        const form = await readForm(req);
        const fullUrl = (getPublicUrl() ?? `http://${req.headers.host ?? `${host}:${port}`}`).replace(/\/$/, "") + req.url;
        const tw = verifyTwilioSignature({
          authToken: getTwilioAuthToken(),
          fullUrl,
          params: form,
          signature: req.headers["x-twilio-signature"]
        });
        if (!tw.ok) {
          return sendXml(res, 403, `<?xml version="1.0" encoding="UTF-8"?><Response><!-- ${tw.reason} --></Response>`);
        }
        const result = await channels.handleSmsMessage({
          from: form.From ?? form.from ?? "sms",
          text: form.Body ?? form.body ?? "",
          metadata: { messageSid: form.MessageSid, accountSid: form.AccountSid }
        });
        return sendXml(res, 200, twiml(result.reply));
      }

      if (method === "POST" && pathname === "/channels/sms/send") {
        if (!channels) return sendJson(res, 503, { error: "agent-host-disabled" });
        const body = await readJson(req);
        try {
          const result = await channels.sms.sendSms(body.to, body.text);
          return sendJson(res, 200, { ok: true, result });
        } catch (error) {
          return sendJson(res, 400, { ok: false, error: error.message });
        }
      }

      if (method === "GET" && pathname === "/budget") return sendJson(res, 200, runtime.budget?.status?.() ?? { error: "no-budget" });

      // ─── Ambient capture / observations ─────────────────────────────────
      if (method === "POST" && pathname === "/observations") {
        const body = await readJson(req);
        const observations = Array.isArray(body) ? body : (Array.isArray(body.observations) ? body.observations : [body]);
        try {
          const result = await runtime.observations.record(observations);
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
        const limit = Number.parseInt(url.searchParams.get("limit") ?? "25", 10);
        const results = await runtime.observations.search({ query, since, until, app, limit });
        return sendJson(res, 200, results);
      }
      if (method === "GET" && pathname === "/observations/timeline") {
        const since = url.searchParams.get("since") ?? null;
        return sendJson(res, 200, await runtime.observations.timelineByHour({ since }));
      }
      if (method === "GET" && pathname === "/observations/stats") {
        return sendJson(res, 200, await runtime.observations.stats());
      }
      if (method === "POST" && pathname === "/observations/prune") {
        const body = await readJson(req).catch(() => ({}));
        return sendJson(res, 200, await runtime.observations.prune(body));
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
      if (method === "GET" && pathname === "/vocabulary") {
        return sendJson(res, 200, {
          snapshot: runtime.vocabulary.snapshot(),
          proposedMerges: runtime.vocabulary.proposeMerges(),
          proposedDeprecations: runtime.vocabulary.proposeDeprecations()
        });
      }
      if (method === "POST" && pathname === "/vocabulary/apply-merges") {
        const body = await readJson(req);
        const merges = body.merges ?? runtime.vocabulary.proposeMerges();
        return sendJson(res, 200, runtime.vocabulary.applyMerges(merges));
      }

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
      if (method === "POST" && pathname === "/scrutiny/judge") {
        try {
          const result = await runtime.scrutinyJudge.judge();
          return sendJson(res, 200, result);
        } catch (error) {
          return sendJson(res, 500, { error: error.message });
        }
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
      if (method === "POST" && pathname.match(/^\/cron\/[^/]+\/run$/)) {
        const id = decodeURIComponent(pathname.split("/")[2]);
        const job = runtime.cron.listJobs().find((j) => j.id === id);
        if (!job) return sendJson(res, 404, { error: "unknown-job" });
        const result =
          job.task === "autopilot"
            ? await runtime.runAutopilot(job)
            : await runtime.runScheduledPrompt(job);
        events.emit("cron", { op: "run", id, result });
        return sendJson(res, 200, { result });
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
      if (method === "GET" && pathname === "/proactive/suggestions") {
        if (!runtime.proactiveObserver?.list) return sendJson(res, 503, { error: "no observer" });
        return sendJson(res, 200, runtime.proactiveObserver.list({ status: url.searchParams.get("status") }));
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
        const candidate = runtime.proactiveObserver.resolve(id, status);
        if (!candidate) return sendJson(res, 404, { error: "unknown suggestion" });

        // For MCP suggestions, accepting auto-registers + connects the server.
        if (status === "accepted" && candidate.category === "mcp" && candidate.mcpRegister && runtime.mcp?.registerServer) {
          try {
            const reg = candidate.mcpRegister;
            const name = candidate.mcpId ?? candidate.title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
            runtime.mcp.registerServer({ name, ...reg });
            runtime.mcp.connect?.(name).catch(() => { /* OAuth path surfaces via SSE */ });
            return sendJson(res, 200, { ...candidate, registered: name });
          } catch (error) {
            return sendJson(res, 200, { ...candidate, registerError: error.message });
          }
        }
        // For task suggestions, accepting creates the task in the right
        // queue + bucket. The proposal title becomes the task title.
        if (status === "accepted" && candidate.category === "task" && runtime.tasks?.add) {
          try {
            const task = runtime.tasks.add(
              {
                title: candidate.title,
                description: candidate.rationale,
                bucket: candidate.taskBucket ?? "today",
                sourceMeta: { suggestionId: id, observedApps: candidate.context?.apps }
              },
              { source: "proactive-observer", queue: candidate.taskQueue ?? "user" }
            );
            return sendJson(res, 200, { ...candidate, taskId: task.id });
          } catch (error) {
            return sendJson(res, 200, { ...candidate, taskCreateError: error.message });
          }
        }
        return sendJson(res, 200, candidate);
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
          pendingAuthUrl: pendingOauth.get(s.name)?.url ?? null
        }));
        return sendJson(res, 200, servers);
      }
      if (method === "GET" && pathname === "/mcp/tools") return sendJson(res, 200, runtime.mcp.listTools());
      if (method === "POST" && pathname.match(/^\/mcp\/connect\/[^/]+$/)) {
        const name = decodeURIComponent(pathname.split("/")[3]);
        // Fire-and-forget so the OAuth dance doesn't block the HTTP response.
        // Dashboard polls /mcp and listens for SSE 'mcp' events to learn when
        // it's done (or if an OAuth URL needs to be opened).
        if (!runtime.mcp.isConnecting?.(name)) {
          runtime.mcp.connect(name)
            .then((status) => {
              pendingOauth.delete(name);
              events.emit("mcp", { op: "connected", name, tools: status?.tools ?? [] });
            })
            .catch((error) => {
              events.emit("mcp", { op: "connect-error", name, error: error.message });
            });
          events.emit("mcp", { op: "connecting", name });
        }
        return sendJson(res, 202, { name, status: "connecting" });
      }
      if (method === "POST" && pathname.match(/^\/mcp\/clear-auth\/[^/]+$/)) {
        const name = decodeURIComponent(pathname.split("/")[3]);
        pendingOauth.delete(name);
        // Wipe cached OAuth tokens so the next connect starts a fresh flow.
        try {
          const authPath = path.join(process.env.OPENAGI_DATA_DIR ?? ".openagi", "mcp", "auth", `${name}.json`);
          if (fsSync.existsSync(authPath)) fsSync.unlinkSync(authPath);
        } catch { /* ignore */ }
        return sendJson(res, 200, { ok: true });
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
        const server = runtime.mcp.registerServer(body);
        return sendJson(res, 200, server);
      }

      if (method === "POST" && pathname === "/tick") {
        const body = await readJson(req);
        const results = await runtime.tick(body.now ? new Date(body.now) : new Date());
        return sendJson(res, 200, { results });
      }

      return sendJson(res, 404, { error: "not-found" });
    } catch (error) {
      // Log so we can diagnose 500s instead of swallowing them.
      const logLine = `[${new Date().toISOString()}] 500 ${req.method} ${req.url} — ${error.message}\n${error.stack ?? ""}\n`;
      try { process.stderr.write(logLine); } catch { /* ignore */ }
      return sendJson(res, 500, { error: error.message, route: req.url });
    }
  });

  return {
    runtime,
    channels,
    events,
    server,
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
          const address = server.address();
          const actualPort = typeof address === "object" && address ? address.port : port;
          resolve({ host, port: actualPort, url: `http://${host}:${actualPort}` });
        });
      });
    },
    close() {
      return new Promise((resolve, reject) => {
        if (tickerHandle) clearInterval(tickerHandle);
        for (const client of sseClients) try { client.end(); } catch { /* ignore */ }
        sseClients.clear();
        channels?.stop();
        runtime.tunnelWatcher?.stop?.();
        runtime.mcp?.disconnectAll?.().catch(() => {});
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  };
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

function sendHtml(res, status, value, cookies = []) {
  const headers = { "content-type": "text/html; charset=utf-8", "content-length": Buffer.byteLength(value) };
  if (cookies.length) headers["Set-Cookie"] = cookies;
  res.writeHead(status, headers);
  res.end(value);
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

function escapeHtmlForLogin(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"})[c]);
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value, null, 2);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

function sendXml(res, status, value) {
  res.writeHead(status, { "content-type": "text/xml; charset=utf-8", "content-length": Buffer.byteLength(value) });
  res.end(value);
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

function twiml(message) {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeXml(String(message ?? "").slice(0, 1400))}</Message></Response>`;
}

function escapeXml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
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
    header .status { color: var(--muted); font-size: 12px; }
    nav { display: flex; gap: 4px; margin-left: auto; }
    nav button {
      background: transparent; border: 1px solid transparent; color: var(--muted);
      padding: 6px 10px; border-radius: 6px; cursor: pointer; font-size: 13px;
    }
    nav button.active { color: var(--text); background: var(--panel-2); border-color: var(--line); }
    nav button:hover { color: var(--text); }

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
    .msg .meta { color: var(--muted); font-size: 11px; margin-bottom: 4px; }
    .msg .body { display: block; }
    .msg .body p { margin: 0 0 8px; }
    .msg .body p:last-child { margin-bottom: 0; }
    .msg .body h2, .msg .body h3, .msg .body h4 { margin: 12px 0 6px; line-height: 1.25; }
    .msg .body h2 { font-size: 18px; }
    .msg .body h3 { font-size: 16px; }
    .msg .body h4 { font-size: 14px; color: var(--accent); }
    .msg .body ul, .msg .body ol { margin: 6px 0 8px; padding-left: 22px; }
    .msg .body li { margin: 2px 0; }
    .msg .body blockquote { margin: 6px 0; padding: 4px 12px; border-left: 3px solid var(--accent); color: var(--muted); }
    .msg .body a { color: var(--accent); }
    .msg .body code.md-inline { background: var(--bg); padding: 1px 5px; border-radius: 3px; font: 12px ui-monospace, Menlo, monospace; border: 1px solid var(--line); }
    .msg .body pre.md-code { margin: 8px 0; padding: 10px 12px; background: var(--bg); border: 1px solid var(--line); border-radius: 6px; overflow-x: auto; }
    .msg .body pre.md-code code { font: 12px/1.5 ui-monospace, Menlo, monospace; }
    .msg .body strong { font-weight: 700; }
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
  </style>
</head>
<body>
<div class="app">
  <header>
    <h1>OpenAGI</h1>
    <span id="status" class="status">connecting…</span>
    <nav id="nav">
      <button data-tab="chat" class="active">Chat</button>
      <button data-tab="tasks">Tasks</button>
      <button data-tab="memory">Memory</button>
      <button data-tab="cron">Cron</button>
      <button data-tab="skills">Skills</button>
      <button data-tab="mcp">MCP</button>
      <button data-tab="agents">Agents</button>
      <button data-tab="channels">Channels</button>
      <button data-tab="budget">Budget</button>
      <button data-tab="outcomes">Outcomes</button>
      <button data-tab="scrutiny">Scrutiny</button>
      <button data-tab="vocab">Vocab</button>
      <button data-tab="health">Health</button>
      <button data-tab="activity">Activity</button>
      <button id="setupBtn" title="Open setup wizard">⚙ Setup</button>
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
  sessions: [],
  agentId: "main",
  channel: "local",
  from: "browser",
  messages: [],
  health: null
};

const $ = (id) => document.getElementById(id);
const main = $("main");
const sidebar = $("sidebar");
const sidebarList = $("sidebarList");
const sidebarTitle = $("sidebarTitle");
const newBtn = $("newSession");

document.querySelectorAll("nav button[data-tab]").forEach((btn) => {
  btn.addEventListener("click", () => switchTab(btn.dataset.tab));
});
document.getElementById("setupBtn")?.addEventListener("click", () => {
  window.location.href = "/setup";
});

// Tiny markdown renderer for chat replies. No backtick characters in this
// function's source so it can live inside the dashboard's outer template
// literal without escaping wars. BT = backtick built from char code.
const BT = String.fromCharCode(96);
const FENCE = BT + BT + BT;
const FENCE_RE = new RegExp(FENCE + "(\\\\w+)?\\\\n([\\\\s\\\\S]*?)" + FENCE, "g");
const INLINE_RE = new RegExp(BT + "([^" + BT + "\\\\n]+)" + BT, "g");

function renderMarkdown(input) {
  if (!input) return "";
  let s = String(input);

  // Escape HTML first — guarantees XSS safety even if the renderer is buggy.
  s = s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);

  // Fenced code blocks
  s = s.replace(FENCE_RE, (_, lang, code) => {
    const langClass = lang ? ' class="md-code-block lang-' + lang + '"' : ' class="md-code-block"';
    return '<pre class="md-code"><code' + langClass + '>' + code.replace(/\\n$/, "") + '</code></pre>';
  });

  // Inline code
  s = s.replace(INLINE_RE, '<code class="md-inline">$1</code>');

  // Headings
  s = s.replace(/^### (.*)$/gm, "<h4>$1</h4>");
  s = s.replace(/^## (.*)$/gm, "<h3>$1</h3>");
  s = s.replace(/^# (.*)$/gm, "<h2>$1</h2>");

  // Blockquotes
  s = s.replace(/^&gt; (.*)$/gm, "<blockquote>$1</blockquote>");

  // Bold then italic
  s = s.replace(/\\*\\*([^*\\n]+)\\*\\*/g, "<strong>$1</strong>");
  s = s.replace(/(?<!\\w)\\*([^*\\n]+?)\\*(?!\\w)/g, "<em>$1</em>");
  s = s.replace(/(?<!\\w)_([^_\\n]+?)_(?!\\w)/g, "<em>$1</em>");

  // Links [text](url)
  s = s.replace(/\\[([^\\]]+)\\]\\((https?:[^\\s)]+)\\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

  // Lists
  const lines = s.split(/\\n/);
  const out = [];
  let ulOpen = false, olOpen = false;
  for (const line of lines) {
    const ulMatch = /^[-*] (.*)$/.exec(line);
    const olMatch = /^\\d+\\. (.*)$/.exec(line);
    if (ulMatch) {
      if (olOpen) { out.push("</ol>"); olOpen = false; }
      if (!ulOpen) { out.push("<ul>"); ulOpen = true; }
      out.push("<li>" + ulMatch[1] + "</li>");
    } else if (olMatch) {
      if (ulOpen) { out.push("</ul>"); ulOpen = false; }
      if (!olOpen) { out.push("<ol>"); olOpen = true; }
      out.push("<li>" + olMatch[1] + "</li>");
    } else {
      if (ulOpen) { out.push("</ul>"); ulOpen = false; }
      if (olOpen) { out.push("</ol>"); olOpen = false; }
      out.push(line);
    }
  }
  if (ulOpen) out.push("</ul>");
  if (olOpen) out.push("</ol>");
  s = out.join("\\n");

  // Paragraphs
  s = s.replace(/\\n{2,}/g, "</p><p>").replace(/\\n/g, "<br>");
  return "<p>" + s + "</p>";
}

function showToast(msg, ok = true) {
  const t = document.createElement("div");
  t.style.cssText = "position:fixed;top:20px;right:20px;z-index:99;padding:10px 14px;border-radius:6px;font-size:13px;max-width:360px;box-shadow:0 4px 12px rgba(0,0,0,.3);font-family:inherit;line-height:1.4;" +
    (ok
      ? "background:#1a3a2a;color:#7be59c;border:1px solid #2d5b40;"
      : "background:#3a1a1a;color:#f08a8a;border:1px solid #5b2d2d;");
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 4500);
}

newBtn.addEventListener("click", async () => {
  if (state.tab === "chat") {
    state.sessionId = null;
    state.messages = [];
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
  } else if (tab === "vocab") {
    showSidebar(false);
    await renderVocab();
  } else if (tab === "health") {
    showSidebar(false);
    await renderHealth();
  } else if (tab === "activity") {
    showSidebar(false);
    await renderActivity();
  } else if (tab === "tasks") {
    showSidebar(false);
    await renderTasks();
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
}

async function loadSession(id) {
  state.sessionId = id;
  const session = await fetchJson("/sessions/" + encodeURIComponent(id));
  state.messages = session.messages ?? [];
  state.channel = state.messages[0]?.channel ?? "local";
  state.from = state.messages[0]?.from ?? "browser";
  await refreshSessions();
  renderChat();
}

function renderChat() {
  main.innerHTML = \`
    <div class="thread" id="thread"></div>
    <form class="composer" id="composer">
      <textarea id="input" placeholder="Message your OpenAGI agent…" rows="1"></textarea>
      <button type="submit" id="send">Send</button>
    </form>
  \`;
  const thread = $("thread");
  if (state.messages.length === 0) {
    thread.innerHTML = '<div class="empty">Start a new conversation. Try "Remind me in 60 seconds to drink water" or "Remember that my standup is 9am Mondays".</div>';
  }
  for (const m of state.messages) appendMessage(m, false);
  thread.scrollTop = thread.scrollHeight;
  const input = $("input");
  input.focus();
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
    input.value = "";
    input.style.height = "auto";
    appendMessage({ role: "user", content: text, from: state.from, channel: state.channel, createdAt: new Date().toISOString() });
    const sendBtn = $("send");
    sendBtn.disabled = true;
    try {
      const result = await postJson("/message", {
        text,
        channel: state.channel,
        from: state.from,
        agentId: state.agentId,
        sessionId: state.sessionId
      });
      state.sessionId = result.session.id;
      appendMessage({ role: "assistant", content: result.reply, from: "openagi", channel: state.channel, createdAt: result.createdAt, metadata: result.model });
      refreshSessions();
    } catch (err) {
      appendMessage({ role: "assistant", content: "[error] " + err.message });
    } finally {
      sendBtn.disabled = false;
    }
  });
}

function appendMessage(msg, autoscroll = true) {
  const thread = $("thread");
  if (!thread) return;
  const div = document.createElement("div");
  div.className = "msg " + (msg.role === "user" ? "user" : "assistant");
  const meta = msg.role === "assistant" && msg.metadata?.model ? \`\${msg.metadata.model} · \${msg.metadata.provider ?? ""}\` : msg.from ?? "";
  // Assistant replies render markdown; user messages stay literal.
  const body = msg.role === "assistant" ? renderMarkdown(msg.content ?? "") : escapeHtml(msg.content ?? "");
  div.innerHTML = \`<div class="meta">\${escapeHtml(meta)}</div><div class="body">\${body}</div>\`;
  thread.appendChild(div);
  if (autoscroll) thread.scrollTop = thread.scrollHeight;
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
  $("runJob").addEventListener("click", async () => {
    const res = await postJson(\`/cron/\${encodeURIComponent(job.id)}/run\`, {});
    $("jobResult").textContent = JSON.stringify(res, null, 2);
  });
  $("deleteJob").addEventListener("click", async () => {
    await fetch(\`/cron/\${encodeURIComponent(job.id)}\`, { method: "DELETE" });
    refreshCron();
  });
}

function openCronComposer() {
  main.innerHTML = \`
    <div class="pane">
      <h2>New schedule</h2>
      <form class="form" id="cronForm">
        <div><label>Type</label>
          <select name="task">
            <option value="prompt">prompt — runs once, replies to channel</option>
            <option value="autopilot">autopilot — proactive pulse, agent decides if it acts</option>
          </select>
        </div>
        <div><label>Name</label><input name="name" placeholder="morning-brief" required></div>
        <div><label>Prompt (leave blank for autopilot to use the default review prompt)</label>
          <textarea name="prompt" rows="3" placeholder="For autopilot: optional custom pulse prompt. For prompt: what the agent should run."></textarea>
        </div>
        <div class="row" style="gap: 8px;">
          <div class="grow"><label>Delay (seconds)</label><input name="delaySeconds" type="number" min="30" placeholder="60"></div>
          <div class="grow"><label>Interval (seconds)</label><input name="intervalSeconds" type="number" min="30" placeholder="600"></div>
          <div class="grow"><label>Daily at</label><input name="dailyAt" placeholder="09:00"></div>
        </div>
        <div class="row" style="gap: 8px;">
          <div class="grow"><label>Channel</label>
            <select name="channel"><option value="local">local</option><option value="sms">sms</option><option value="telegram">telegram</option></select>
          </div>
          <div class="grow"><label>Target (phone/chatId)</label><input name="target" placeholder="+15555550123"></div>
        </div>
        <div class="row"><button type="submit">Schedule</button></div>
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
      li.innerHTML = \`<div class="title">\${escapeHtml(s.proposal.name)}</div><div class="preview">\${escapeHtml(s.proposal.description ?? s.sequence.apps.join(" → "))}</div>\`;
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
  else main.innerHTML = '<div class="pane"><div class="empty">No skills loaded yet. Drop a SKILL.md into <code>.openagi/skills/&lt;name&gt;/</code>, or wait for the nightly pattern miner to surface routines.</div></div>';
}

function renderSuggestedDetail(candidate) {
  const seq = candidate.sequence;
  main.innerHTML = \`
    <div class="pane">
      <div class="row" style="gap:6px;margin-bottom:6px;">
        <span class="badge ok">✨ suggested</span>
        <span class="badge">confidence \${(seq.confidence ?? 0).toFixed(2)}</span>
        <span class="badge">\${seq.count}× in last 14d</span>
        <span class="badge">~\${String(seq.startHour ?? 0).padStart(2, "0")}:00</span>
      </div>
      <h2>\${escapeHtml(candidate.proposal.name)}</h2>
      <p class="muted">\${escapeHtml(candidate.proposal.description ?? "")}</p>

      <h3>Detected sequence</h3>
      <div class="row" style="gap:8px;flex-wrap:wrap;">\${seq.apps.map((a) => \`<span class="chip" style="font-size:13px;padding:6px 12px;">\${escapeHtml(a)}</span>\`).join('<span class="muted" style="align-self:center;">→</span>')}</div>

      <h3>Proposed skill body</h3>
      <pre style="white-space:pre-wrap;">\${escapeHtml(candidate.proposal.body ?? "")}</pre>

      \${candidate.proposal.scheduleHint ? \`<h3>Suggested schedule</h3><p>\${escapeHtml(candidate.proposal.scheduleHint)}</p>\` : ""}

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
      <h2>\${escapeHtml(skill.name)}</h2>
      <p class="muted">\${escapeHtml(skill.description ?? "")}</p>
      <h3>Run</h3>
      <form class="form" id="skillForm">
        <div><label>Input</label><textarea name="input" rows="3" placeholder="Free-text input"></textarea></div>
        <div><button type="submit">Run skill</button></div>
      </form>
      <h3>Output</h3>
      <pre id="skillOut" class="ok"></pre>
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

async function refreshMcp() {
  const servers = await fetchJson("/mcp");
  sidebarList.innerHTML = servers.length === 0 ? '<li class="empty">No MCP servers registered</li>' : "";
  for (const s of servers) {
    const li = document.createElement("li");
    li.innerHTML = \`<div class="title">\${escapeHtml(s.name)} \${s.connected ? '<span class="badge ok">live</span>' : '<span class="badge">idle</span>'}</div><div class="preview">\${(s.tools ?? []).join(", ") || "—"}</div>\`;
    li.addEventListener("click", () => renderMcpDetail(s));
    sidebarList.appendChild(li);
  }
  if (servers.length > 0) renderMcpDetail(servers[0]);
}

function renderMcpDetail(server) {
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
    ? \`<div class="card"><div class="row between" style="align-items:center;"><span class="name">⏳ Connecting…</span><span class="muted">waiting for handshake</span></div></div>\`
    : "";
  main.innerHTML = \`
    <div class="pane">
      <h2>\${escapeHtml(server.name)}</h2>
      <div class="row" style="gap: 6px;flex-wrap:wrap;">
        <span class="badge \${server.connected ? 'ok' : ''}">\${server.connected ? "connected" : "disconnected"}</span>
        <span class="badge">trust: \${escapeHtml(server.trustLevel)}</span>
        <span class="badge">transport: \${transportLabel}</span>
        \${server.pendingAuthUrl ? '<span class="badge warn">awaiting auth</span>' : ""}
      </div>
      \${oauthBanner}
      \${connectingBanner}
      <h3>Endpoint</h3>
      \${endpoint}
      <h3>Tools</h3>
      <pre>\${escapeHtml((server.tools ?? []).join("\\n") || "(none — connect to discover)")}</pre>
      <div class="row" style="gap: 8px; margin-top: 12px;flex-wrap:wrap;">
        <button id="connBtn" \${server.connecting ? "disabled" : ""}>\${server.connected ? "Disconnect" : "Connect"}</button>
        \${server.transport === "http" && server.auth === "oauth" ? \`<button class="secondary" id="clearAuthBtn">Re-auth (clear cached token)</button>\` : ""}
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
    if (!confirm("Clear cached OAuth token for " + server.name + "? Next Connect will run the auth flow again.")) return;
    await postJson(\`/mcp/clear-auth/\${encodeURIComponent(server.name)}\`, {});
    refreshMcp();
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
      <h2>Register MCP server</h2>
      <p class="muted">Three shapes are supported. Pick one:</p>
      <form class="form" id="mcpForm">
        <div class="grid" style="margin-bottom:14px;">
          <label class="opt"><input type="radio" name="kind" value="stdio" checked> stdio · spawn a local process</label>
          <label class="opt"><input type="radio" name="kind" value="http-oauth"> http + OAuth · hosted MCP with browser-based auth</label>
          <label class="opt"><input type="radio" name="kind" value="http-bearer"> http + bearer · hosted MCP with a static API key</label>
        </div>

        <div><label>Name</label><input name="name" placeholder="e.g. filesystem" required></div>

        <div data-kind="stdio">
          <label>Command</label><input name="command" placeholder="npx">
        </div>
        <div data-kind="stdio">
          <label>Args (one per line)</label>
          <textarea name="args" rows="3" placeholder="-y&#10;@modelcontextprotocol/server-filesystem&#10;/tmp"></textarea>
        </div>

        <div data-kind="http-oauth http-bearer">
          <label>URL</label>
          <input name="url" placeholder="https://mcp.example.com/mcp">
        </div>
        <div data-kind="http-bearer">
          <label>API key (or \${ENV_VAR})</label>
          <input name="apiKey" placeholder="\${MY_MCP_KEY}">
        </div>
        <div data-kind="http-oauth">
          <label>Pre-registered Client ID <span class="muted">· optional, only if your auth server doesn't support dynamic registration</span></label>
          <input name="clientId" placeholder="\${OAUTH_CLIENT_ID} or literal">
        </div>
        <div data-kind="http-oauth">
          <label>Client secret <span class="muted">· optional, only for confidential clients</span></label>
          <input type="password" name="clientSecret" autocomplete="off">
        </div>

        <div><label>Trust level</label><select name="trustLevel"><option>trusted</option><option>untrusted</option></select></div>
        <div class="row" style="gap:8px;"><button type="submit" id="registerSubmit">Register</button><button type="button" class="secondary" id="cancelBtn">Cancel</button></div>
        <pre id="mcpRegOut" class="ok" style="display:none;margin-top:10px;"></pre>
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
      showOut("Registered ✓ — " + JSON.stringify(result, null, 2));
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
        <h2 style="margin:0;">Memory <span class="muted" style="font-weight:400;font-size:14px;">· \${total} total · \${principles} principle\${principles===1?"":"s"}</span></h2>
      </div>
      <div class="row" style="gap:10px;align-items:center;margin-bottom:14px;flex-wrap:wrap;">
        <div class="tier-pills">
          <button data-tier="all" class="\${f.tier==='all'?'active':''}">All <span class="count">\${total}</span></button>
          <button data-tier="short" class="\${f.tier==='short'?'active':''}">Short <span class="count">\${counts.short}</span></button>
          <button data-tier="medium" class="\${f.tier==='medium'?'active':''}">Medium <span class="count">\${counts.medium}</span></button>
          <button data-tier="long" class="\${f.tier==='long'?'active':''}">Long <span class="count">\${counts.long}</span></button>
        </div>
        <input type="search" id="memSearch" placeholder="search content or tags…" value="\${escapeHtml(f.query)}" style="flex:1;min-width:240px;">
      </div>
      <div class="mem-grid" id="memList"></div>
    </div>
  \`;
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

async function renderChannels() {
  const ch = await fetchJson("/channels");
  const tunnelBlock = ch.publicUrl
    ? \`<div class="card"><div class="name">Public URL</div><div class="desc"><code>\${escapeHtml(ch.publicUrl)}</code></div><div class="desc" style="margin-top:6px;">Twilio webhook: <code>\${escapeHtml(ch.twilioWebhook)}</code></div></div>\`
    : \`<div class="card"><div class="name warn">No public URL</div><div class="desc">Run <code>npm run tunnel</code>, then set <code>OPENAGI_PUBLIC_URL</code> in .openagi/.env and restart.</div></div>\`;
  main.innerHTML = \`
    <div class="pane">
      <h2>Channels</h2>
      \${tunnelBlock}
      <div class="grid two" style="margin-top:12px;">
        <div class="card"><div class="name">Local · \${ch.local?.mode ?? ""}</div><div class="desc">Browser HTTP + SSE.</div></div>
        <div class="card"><div class="name">SMS / Twilio</div><div class="desc">\${ch.sms?.outboundConfigured ? '<span class="ok">outbound ready</span>' : '<span class="warn">outbound disabled — set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER</span>'} · from \${escapeHtml(ch.sms?.fromNumber ?? "—")}</div></div>
        <div class="card"><div class="name">Telegram</div><div class="desc">\${ch.telegram?.configured ? "configured" : "no token"} · polling: \${ch.telegram?.polling ? "on" : "off"}</div></div>
      </div>
      <h3>Send SMS test</h3>
      <form class="form" id="smsForm">
        <div class="row" style="gap: 8px;">
          <div class="grow"><label>To</label><input name="to" placeholder="+15555550123" required></div>
          <div class="grow"><label>Body</label><input name="text" placeholder="Hello from OpenAGI" required></div>
          <div><button type="submit">Send</button></div>
        </div>
      </form>
      <pre id="smsOut" class="ok"></pre>
    </div>
  \`;
  $("smsForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const obj = Object.fromEntries(fd.entries());
    try {
      const res = await postJson("/channels/sms/send", obj);
      $("smsOut").textContent = JSON.stringify(res, null, 2);
    } catch (err) {
      $("smsOut").textContent = "[error] " + err.message;
    }
  });
}

async function renderBudget() {
  const b = await fetchJson("/budget");
  const pct = Math.min(100, (b.spentUsd / Math.max(b.dailyUsdLimit, 0.0001)) * 100);
  const stateClass = pct > 90 ? "err" : pct > 70 ? "warn" : "ok";
  main.innerHTML = \`
    <div class="pane">
      <h2>Budget</h2>
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
    </div>
  \`;
  const hist = $("budgetHistory");
  for (const d of (b.history ?? [])) {
    const c = document.createElement("div");
    c.className = "card";
    c.innerHTML = \`<div class="row between"><span class="name">\${escapeHtml(d.date)}</span><span class="muted">\${d.calls} call\${d.calls===1?"":"s"}</span></div><div class="stat-value">$\${d.usd.toFixed(4)}</div>\`;
    hist.appendChild(c);
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
      <h2>Scrutiny <span class="muted" style="font-size:14px;font-weight:400;">· cycle \${fitter.cycles ?? 0} · \${fitter.autoApply ? "auto-apply" : "warmup"}</span></h2>
      <div class="row" style="gap:8px;margin-bottom:14px;">
        <button id="fitBtn">Run fit now</button>
        <button class="secondary" id="judgeBtn">Run LLM judge</button>
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
  $("judgeBtn").addEventListener("click", async () => {
    showOut("running judge…");
    try { showOut(JSON.stringify(await postJson("/scrutiny/judge", {}), null, 2)); }
    catch (e) { showOut("[err] " + e.message); }
  });
}

async function renderVocab() {
  const data = await fetchJson("/vocabulary");
  const merges = data.proposedMerges ?? [];
  const top = (data.snapshot?.tags ?? []).slice(0, 60);
  const dormant = (data.proposedDeprecations ?? []).slice(0, 30);
  const mergeCards = merges.length === 0
    ? '<div class="empty">No near-synonym candidates right now.</div>'
    : merges.map((m) =>
      \`<div class="card"><div class="row between"><span class="name">\${escapeHtml(m.winner)}</span><span class="badge">sim \${m.similarity}</span></div><div class="desc">absorbs <code>\${escapeHtml(m.loser)}</code> · \${m.winnerCount} use\${m.winnerCount===1?"":"s"}</div></div>\`
    ).join("");
  const tagChips = top.length === 0
    ? '<div class="empty">No tags yet.</div>'
    : \`<div class="mem-tags">\${top.map((t) => \`<span class="chip">\${escapeHtml(t.tag)} · \${t.count}</span>\`).join("")}</div>\`;
  const dormantList = dormant.length === 0
    ? '<div class="empty">Nothing dormant.</div>'
    : \`<div class="mem-tags">\${dormant.map((t) => \`<span class="chip">\${escapeHtml(t.tag)}</span>\`).join("")}</div>\`;
  main.innerHTML = \`
    <div class="pane">
      <h2>Vocabulary</h2>
      <div class="grid stats">
        <div class="card"><span class="desc">Total tags</span><div class="stat-value">\${data.snapshot?.total ?? 0}</div></div>
        <div class="card"><span class="desc">Proposed merges</span><div class="stat-value">\${merges.length}</div></div>
        <div class="card"><span class="desc">Dormant tags</span><div class="stat-value">\${dormant.length}</div></div>
      </div>
      \${merges.length ? '<div class="row" style="margin:12px 0;"><button id="applyMergesBtn">Apply all merges</button></div>' : ""}
      <div id="vocabOut" class="muted" style="font-size:12px;"></div>
      <h3>Merge proposals</h3>
      <div class="grid">\${mergeCards}</div>
      <h3>Most-used tags</h3>
      \${tagChips}
      <h3>Dormant (last seen > 60d)</h3>
      \${dormantList}
    </div>
  \`;
  const btn = $("applyMergesBtn");
  if (btn) btn.addEventListener("click", async () => {
    try {
      $("vocabOut").textContent = JSON.stringify(await postJson("/vocabulary/apply-merges", {}), null, 2);
      setTimeout(renderVocab, 1000);
    } catch (e) { $("vocabOut").textContent = "[err] " + e.message; }
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

async function renderTasks() {
  state.taskFilter = state.taskFilter || { queue: "user", bucket: "all" };
  const data = await fetchJson("/tasks?limit=200").catch(() => ({ tasks: [], stats: {} }));
  const tasks = data.tasks ?? [];
  const stats = data.stats ?? {};
  const filterQ = state.taskFilter.queue;
  const filterB = state.taskFilter.bucket;
  const filtered = tasks.filter((t) => {
    if (filterQ !== "all" && t.queue !== filterQ) return false;
    if (filterB !== "all" && t.bucket !== filterB) return false;
    return true;
  });

  const bucketCount = (q, b) => {
    if (!stats[q]) return 0;
    return stats[q][b] ?? 0;
  };

  main.innerHTML = \`
    <div class="pane">
      <h2>Tasks</h2>
      <p class="muted">Two queues — user todo (what you should do) and agent queue (what OpenAGI is working on).</p>

      <form class="form" id="taskForm" style="margin:12px 0 18px; display:flex; gap:6px; flex-wrap:wrap; align-items:center;">
        <input name="title" placeholder="Add a task..." required style="flex:2; min-width:240px;">
        <select name="queue" style="flex:0 0 auto;">
          <option value="user">user</option>
          <option value="agent">agent</option>
        </select>
        <select name="bucket" style="flex:0 0 auto;">
          <option value="today">today</option>
          <option value="this_week" selected>this week</option>
          <option value="someday">someday</option>
        </select>
        <button type="submit">+ Add</button>
      </form>

      <div class="row" style="gap:6px; flex-wrap:wrap; margin-bottom:12px;">
        <span class="muted" style="font-size:12px; align-self:center; margin-right:8px;">queue:</span>
        \${["all", "user", "agent"].map((q) => \`<button class="chip \${filterQ === q ? "on" : ""}" data-qf="\${q}">\${q}\${q !== "all" ? \` (\${(stats[q]?.total ?? 0)})\` : ""}</button>\`).join("")}
        <span class="muted" style="font-size:12px; align-self:center; margin:0 8px;">bucket:</span>
        \${["all", "today", "this_week", "someday", "done"].map((b) => \`<button class="chip \${filterB === b ? "on" : ""}" data-bf="\${b}">\${b.replace("_", " ")}\${b !== "all" && filterQ !== "all" ? \` (\${bucketCount(filterQ, b)})\` : ""}</button>\`).join("")}
      </div>

      \${filtered.length === 0 ? \`<div class="empty">No tasks. Add one above, or just say things like "remind me to X" in chat — I'll auto-create them.</div>\` : ""}

      <ul class="taskList" style="list-style:none; padding:0; margin:0;">
        \${filtered.map((t) => {
          const isOverdue = t.dueDate && Date.parse(t.dueDate) < Date.now() && t.status !== "completed";
          const dueDateStr = t.dueDate ? new Date(t.dueDate).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "";
          const sourceBadge = t.source && t.source !== "manual"
            ? (t.sourceUrl
                ? \`<a class="badge" href="\${escapeHtml(t.sourceUrl)}" target="_blank" rel="noopener" style="font-size:10px; text-decoration:none;">\${escapeHtml(t.source)} ↗</a>\`
                : \`<span class="badge" style="font-size:10px;">\${escapeHtml(t.source)}</span>\`)
            : "";
          return \`
          <li data-task-id="\${t.id}" class="task" style="display:flex; gap:10px; align-items:flex-start; padding:10px 12px; border-bottom:1px solid var(--line);">
            <input type="checkbox" \${t.status === "completed" ? "checked" : ""} data-action="toggle" style="margin-top:3px;">
            <div style="flex:1; min-width:0;">
              <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
                <span class="title" style="\${t.status === "completed" ? "text-decoration:line-through; color:var(--muted);" : ""}">\${escapeHtml(t.title)}</span>
                <span class="badge" style="font-size:10px;">\${t.queue}</span>
                <span class="badge" style="font-size:10px;">\${t.bucket.replace("_", " ")}</span>
                \${t.priority >= 70 ? \`<span class="badge err" style="font-size:10px;">P\${t.priority}</span>\` : ""}
                \${dueDateStr ? \`<span class="badge \${isOverdue ? "err" : ""}" style="font-size:10px;">\${isOverdue ? "⏰ overdue " : "due "}\${dueDateStr}</span>\` : ""}
                \${sourceBadge}
              </div>
              \${t.description ? \`<div class="muted" style="font-size:12px; margin-top:4px;">\${escapeHtml(t.description.slice(0, 240))}</div>\` : ""}
              \${t.sourceMeta?.identifier ? \`<div class="muted" style="font-size:11px; margin-top:2px;">\${escapeHtml(t.sourceMeta.identifier)}\${t.sourceMeta.team ? " · " + escapeHtml(t.sourceMeta.team) : ""}\${t.sourceMeta.project ? " · " + escapeHtml(t.sourceMeta.project) : ""}</div>\` : ""}
              \${t.sourceMeta?.file ? \`<div class="muted" style="font-size:11px; margin-top:2px;">📎 \${escapeHtml(t.sourceMeta.file)} (line \${t.sourceMeta.line})</div>\` : ""}
            </div>
            <button data-action="delete" class="secondary" style="align-self:flex-start; font-size:11px; padding:2px 8px;">×</button>
          </li>
        \`}).join("")}
      </ul>
    </div>
  \`;

  $("taskForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = { title: fd.get("title"), queue: fd.get("queue") || "user", bucket: fd.get("bucket") || "today" };
    try {
      await postJson("/tasks", body);
      e.target.reset();
      await renderTasks();
    } catch (err) {
      showToast("Add task failed: " + err.message, false);
    }
  });

  document.querySelectorAll("[data-qf]").forEach((b) => b.addEventListener("click", () => { state.taskFilter.queue = b.dataset.qf; renderTasks(); }));
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
    const snippet = r.snippet || r.text || r.window || r.event || "";
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
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? \`\${path} -> \${r.status}\`);
  return r.json();
}
function escapeHtml(s) { return String(s ?? "").replace(/[&<>"]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"})[c]); }

async function refreshHealth() {
  try {
    const [h, b, p] = await Promise.all([
      fetchJson("/health"),
      fetchJson("/budget").catch(() => null),
      fetchJson("/admin/provider").catch(() => null)
    ]);
    state.health = h;
    const m = h.status.memory ?? {};
    const provider = h.status.agentHost?.provider ?? "—";
    const budget = b ? \` · $\${b.spentUsd.toFixed(2)} / $\${b.dailyUsdLimit.toFixed(2)}\` : "";
    $("status").textContent = \`runtime online · \${provider} \${h.status.agentHost?.providerConfigured ? "✓" : "(no key)"} · short \${m.short || 0} / medium \${m.medium || 0} / long \${m.long || 0}\${budget}\`;
    if (p) renderProviderSwitch(p);
  } catch {
    $("status").textContent = "runtime offline";
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
    if (state.tab === "chat" && data.sessionId === state.sessionId && data.reply) {
      // already shown via direct response, skip
    } else {
      refreshSessions();
    }
  } catch {}
});
evt.addEventListener("cron", () => { if (state.tab === "cron") refreshCron(); });
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

// Task reminder (morning digest or due-date) — toast + browser notif.
evt.addEventListener("task-reminder", (e) => {
  try {
    const data = JSON.parse(e.data);
    showToast((data.kind === "digest" ? "📋 " : "⏰ ") + data.title + (data.body ? " — " + data.body : ""), true);
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
setInterval(refreshAmbientBadge, 15000);
refreshAmbientBadge();
switchTab("chat");
</script>
</body>
</html>`;
}
