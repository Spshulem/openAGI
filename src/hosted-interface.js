import http from "node:http";
import { EventEmitter } from "node:events";
import { createDefaultRuntime } from "./abi-runtime.js";
import {
  buildSetCookie,
  checkAuth,
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

  if (runtime.tunnelWatcher) {
    runtime.tunnelWatcher.on("tunnel-url", (data) => events.emit("tunnel", { op: "url", ...data }));
    runtime.tunnelWatcher.on("tunnel-changed", (data) => events.emit("tunnel", { op: "changed", ...data }));
    runtime.tunnelWatcher.start();
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

      if (method === "GET" && pathname === "/mcp") return sendJson(res, 200, runtime.mcp.listServers());
      if (method === "GET" && pathname === "/mcp/tools") return sendJson(res, 200, runtime.mcp.listTools());
      if (method === "POST" && pathname.match(/^\/mcp\/connect\/[^/]+$/)) {
        const name = decodeURIComponent(pathname.split("/")[3]);
        try {
          const status = await runtime.mcp.connect(name);
          events.emit("mcp", { op: "connect", name });
          return sendJson(res, 200, status);
        } catch (error) {
          return sendJson(res, 400, { error: error.message });
        }
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
      return sendJson(res, 500, { error: error.message });
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
    .msg { max-width: 700px; padding: 10px 12px; border-radius: 10px; line-height: 1.5; white-space: pre-wrap; word-wrap: break-word; }
    .msg.user { background: var(--user); align-self: flex-end; }
    .msg.assistant { background: var(--assistant); border: 1px solid var(--line); align-self: flex-start; }
    .msg .meta { color: var(--muted); font-size: 11px; margin-bottom: 4px; }
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

    .pane { flex: 1; overflow: auto; padding: 16px 20px; }
    .pane h2 { margin: 0 0 12px; font-size: 18px; }
    .pane h3 { margin: 18px 0 6px; font-size: 13px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); }
    .grid { display: grid; gap: 10px; }
    .grid.two { grid-template-columns: 1fr 1fr; }
    .card { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 12px; }
    .card .name { font-weight: 700; }
    .card .desc { color: var(--muted); font-size: 12px; margin-top: 2px; }
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

document.querySelectorAll("nav button").forEach((btn) => {
  btn.addEventListener("click", () => switchTab(btn.dataset.tab));
});

newBtn.addEventListener("click", () => {
  if (state.tab === "chat") {
    state.sessionId = null;
    state.messages = [];
    state.from = "browser-" + Date.now();
    renderTab();
  } else if (state.tab === "cron") {
    openCronComposer();
  } else if (state.tab === "skills") {
    refreshSkills(true);
  } else if (state.tab === "mcp") {
    openMcpComposer();
  }
});

async function switchTab(tab) {
  state.tab = tab;
  document.querySelectorAll("nav button").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  if (tab === "chat") {
    sidebar.style.display = "";
    sidebarTitle.textContent = "Sessions";
    newBtn.textContent = "+ New";
    await refreshSessions();
  } else if (tab === "cron") {
    sidebar.style.display = "";
    sidebarTitle.textContent = "Schedules";
    newBtn.textContent = "+ Schedule";
    await refreshCron();
  } else if (tab === "skills") {
    sidebar.style.display = "";
    sidebarTitle.textContent = "Skills";
    newBtn.textContent = "↻ Reload";
    await refreshSkills();
  } else if (tab === "mcp") {
    sidebar.style.display = "";
    sidebarTitle.textContent = "MCP Servers";
    newBtn.textContent = "+ Register";
    await refreshMcp();
  } else if (tab === "agents") {
    sidebar.style.display = "none";
    await renderAgents();
  } else if (tab === "memory") {
    sidebar.style.display = "none";
    await renderMemory();
  } else if (tab === "channels") {
    sidebar.style.display = "none";
    await renderChannels();
  } else if (tab === "budget") {
    sidebar.style.display = "none";
    await renderBudget();
  } else if (tab === "outcomes") {
    sidebar.style.display = "none";
    await renderOutcomes();
  } else if (tab === "scrutiny") {
    sidebar.style.display = "none";
    await renderScrutiny();
  } else if (tab === "vocab") {
    sidebar.style.display = "none";
    await renderVocab();
  } else if (tab === "health") {
    sidebar.style.display = "none";
    await renderHealth();
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
  div.innerHTML = \`<div class="meta">\${escapeHtml(meta)}</div>\${escapeHtml(msg.content ?? "")}\`;
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
  const skills = await fetchJson("/skills");
  sidebarList.innerHTML = skills.length === 0 ? '<li class="empty">No skills loaded</li>' : "";
  for (const s of skills) {
    const li = document.createElement("li");
    li.innerHTML = \`<div class="title">\${escapeHtml(s.name)}</div><div class="preview">\${escapeHtml(s.description ?? "")}</div>\`;
    li.addEventListener("click", () => renderSkillDetail(s));
    sidebarList.appendChild(li);
  }
  if (skills.length > 0) renderSkillDetail(skills[0]);
  else main.innerHTML = '<div class="pane"><div class="empty">No skills found. Drop SKILL.md files into .openagi/skills/&lt;name&gt;/</div></div>';
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
  main.innerHTML = \`
    <div class="pane">
      <h2>\${escapeHtml(server.name)}</h2>
      <div class="row" style="gap: 6px;">
        <span class="badge \${server.connected ? 'ok' : ''}">\${server.connected ? "connected" : "disconnected"}</span>
        <span class="badge">trust: \${escapeHtml(server.trustLevel)}</span>
        <span class="badge">transport: \${escapeHtml(server.transport)}</span>
      </div>
      <h3>Command</h3>
      <pre>\${escapeHtml((server.command ?? "—") + " " + (server.args ?? []).join(" "))}</pre>
      <h3>Tools</h3>
      <pre>\${escapeHtml((server.tools ?? []).join("\\n") || "(none)")}</pre>
      <div class="row" style="gap: 8px; margin-top: 12px;">
        <button id="connBtn">\${server.connected ? "Disconnect" : "Connect"}</button>
        <button class="secondary" id="callBtn">Call tool…</button>
      </div>
      <pre id="mcpOut" class="ok" style="margin-top: 12px;"></pre>
    </div>
  \`;
  $("connBtn").addEventListener("click", async () => {
    const path = server.connected ? "disconnect" : "connect";
    try {
      const res = await postJson(\`/mcp/\${path}/\${encodeURIComponent(server.name)}\`, {});
      $("mcpOut").textContent = JSON.stringify(res, null, 2);
      refreshMcp();
    } catch (err) {
      $("mcpOut").textContent = "[error] " + err.message;
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

function openMcpComposer() {
  main.innerHTML = \`
    <div class="pane">
      <h2>Register MCP server</h2>
      <form class="form" id="mcpForm">
        <div><label>Name</label><input name="name" required></div>
        <div><label>Command</label><input name="command" placeholder="npx" required></div>
        <div><label>Args (one per line)</label><textarea name="args" rows="3" placeholder="-y\n@modelcontextprotocol/server-filesystem\n/tmp"></textarea></div>
        <div><label>Trust level</label><select name="trustLevel"><option>trusted</option><option>untrusted</option></select></div>
        <div><button type="submit">Register</button></div>
      </form>
    </div>
  \`;
  $("mcpForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const obj = Object.fromEntries(fd.entries());
    obj.args = (obj.args ?? "").split("\\n").map((s) => s.trim()).filter(Boolean);
    await postJson("/mcp/register", obj);
    refreshMcp();
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
  main.innerHTML = '<div class="pane"><h2>Memory</h2><h3>Short</h3><div id="ms"></div><h3>Medium</h3><div id="mm"></div><h3>Long</h3><div id="ml"></div></div>';
  fillMemory($("ms"), snap.short);
  fillMemory($("mm"), snap.medium);
  fillMemory($("ml"), snap.long);
}

function fillMemory(container, items) {
  container.innerHTML = "";
  if (!items || items.length === 0) {
    container.innerHTML = '<div class="empty">(none)</div>';
    return;
  }
  for (const m of items) {
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = \`<div class="row between"><span class="name">\${escapeHtml(m.id)}</span><span class="badge">strength \${(m.strength ?? 0).toFixed(2)}</span></div><div class="desc">\${escapeHtml(m.content)}</div>\`;
    container.appendChild(card);
  }
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
  main.innerHTML = \`
    <div class="pane">
      <h2>Budget</h2>
      <div class="card">
        <div class="row between"><span class="name">Today (\${escapeHtml(b.today)})</span><span class="badge \${pct > 90 ? 'err' : pct > 70 ? 'warn' : 'ok'}">\${pct.toFixed(0)}% of limit</span></div>
        <div style="margin-top:10px; height: 8px; background: var(--panel-2); border-radius: 4px; overflow: hidden;">
          <div style="width: \${pct}%; height: 100%; background: var(--accent);"></div>
        </div>
        <div class="row" style="gap: 16px; margin-top: 12px;">
          <div><span class="desc">Spent</span><div style="font-size: 22px; font-weight: 700;">$\${b.spentUsd.toFixed(4)}</div></div>
          <div><span class="desc">Remaining</span><div style="font-size: 22px; font-weight: 700;">$\${b.remainingUsd.toFixed(4)}</div></div>
          <div><span class="desc">Daily limit</span><div style="font-size: 22px; font-weight: 700;">$\${b.dailyUsdLimit.toFixed(2)}</div></div>
          <div><span class="desc">Calls</span><div style="font-size: 22px; font-weight: 700;">\${b.calls}</div></div>
        </div>
        <h3>Tokens today</h3>
        <pre>input: \${b.tokens.input}\\noutput: \${b.tokens.output}\\ncache_read: \${b.tokens.cacheRead}\\ncache_write: \${b.tokens.cacheWrite}</pre>
      </div>
      <h3>Last 14 days</h3>
      <div id="budgetHistory" class="grid"></div>
      <p class="desc" style="margin-top: 12px;">Limit is set via <code>OPENAGI_DAILY_USD_LIMIT</code> in <code>.openagi/.env</code>.</p>
    </div>
  \`;
  const hist = $("budgetHistory");
  for (const d of b.history ?? []) {
    const c = document.createElement("div");
    c.className = "card";
    c.innerHTML = \`<div class="row between"><span class="name">\${escapeHtml(d.date)}</span><span>$\${d.usd.toFixed(4)} · \${d.calls} call\${d.calls===1?"":"s"}</span></div>\`;
    hist.appendChild(c);
  }
}

async function renderOutcomes() {
  const data = await fetchJson("/outcomes?limit=40&windowDays=7");
  const agg = data.aggregate ?? {};
  const recent = data.recent ?? [];
  main.innerHTML = \`
    <div class="pane">
      <h2>Outcomes</h2>
      <div class="row" style="gap:16px;margin-bottom:16px;">
        <div class="card grow"><span class="desc">7-day avg quality</span><div style="font-size:22px;font-weight:700;">\${agg.avgQuality ?? "—"}</div></div>
        <div class="card grow"><span class="desc">Resolved</span><div style="font-size:22px;font-weight:700;">\${agg.resolved ?? 0} / \${agg.total ?? 0}</div></div>
        <div class="card grow"><span class="desc">Pending</span><div style="font-size:22px;font-weight:700;">\${agg.pending ?? 0}</div></div>
      </div>
      <h3>By kind (7d)</h3>
      <pre>\${escapeHtml(JSON.stringify(agg.byKind ?? {}, null, 2))}</pre>
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
  main.innerHTML = \`
    <div class="pane">
      <h2>Scrutiny</h2>
      <div class="row" style="gap:8px;margin-bottom:12px;">
        <button id="fitBtn">Run fit now</button>
        <button class="secondary" id="judgeBtn">Run LLM judge</button>
      </div>
      <pre id="scrOut" class="ok"></pre>
      <h3>Judges</h3>
      <div class="grid two" id="judges"></div>
      <h3>Fitter status</h3>
      <pre>\${escapeHtml(JSON.stringify(data.fitter ?? {}, null, 2))}</pre>
      <h3>Pending proposals</h3>
      <div id="pendingList"></div>
    </div>
  \`;
  const judges = $("judges");
  for (const [name, j] of Object.entries(data.weights ?? {})) {
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = \`<div class="name">\${escapeHtml(name)}</div>
      <div class="desc">weights</div><pre>\${escapeHtml(JSON.stringify(j.weights, null, 2))}</pre>
      <div class="desc">thresholds</div><pre>\${escapeHtml(JSON.stringify(j.thresholds, null, 2))}</pre>\`;
    judges.appendChild(card);
  }
  const pl = $("pendingList");
  if (!pending || !pending.proposals?.length) {
    pl.innerHTML = '<div class="empty">no pending proposals</div>';
  } else {
    for (const p of pending.proposals) {
      const c = document.createElement("div");
      c.className = "card";
      c.innerHTML = \`<div class="row between"><span class="name">cycle \${p.cycle} · \${p.applied ? "applied" : "pending"}</span>
        <button class="secondary" data-apply="\${p.cycle}" \${p.applied ? "disabled" : ""}>Apply</button></div>
        <pre>\${escapeHtml(JSON.stringify(p.proposals, null, 2))}</pre>\`;
      pl.appendChild(c);
    }
    pl.querySelectorAll("[data-apply]").forEach((b) => b.addEventListener("click", async () => {
      await postJson(\`/scrutiny/pending/\${b.getAttribute("data-apply")}/apply\`, {});
      renderScrutiny();
    }));
  }
  $("fitBtn").addEventListener("click", async () => {
    $("scrOut").textContent = "fitting…";
    try { $("scrOut").textContent = JSON.stringify(await postJson("/scrutiny/fit", {}), null, 2); }
    catch (e) { $("scrOut").textContent = "[err] " + e.message; }
  });
  $("judgeBtn").addEventListener("click", async () => {
    $("scrOut").textContent = "running judge…";
    try { $("scrOut").textContent = JSON.stringify(await postJson("/scrutiny/judge", {}), null, 2); }
    catch (e) { $("scrOut").textContent = "[err] " + e.message; }
  });
}

async function renderVocab() {
  const data = await fetchJson("/vocabulary");
  main.innerHTML = \`
    <div class="pane">
      <h2>Vocabulary</h2>
      <div class="row" style="gap:16px;margin-bottom:12px;">
        <div class="card grow"><span class="desc">Total tags</span><div style="font-size:22px;font-weight:700;">\${data.snapshot?.total ?? 0}</div></div>
        <div class="card grow"><span class="desc">Proposed merges</span><div style="font-size:22px;font-weight:700;">\${data.proposedMerges?.length ?? 0}</div></div>
        <div class="card grow"><span class="desc">Dormant tags</span><div style="font-size:22px;font-weight:700;">\${data.proposedDeprecations?.length ?? 0}</div></div>
      </div>
      \${data.proposedMerges?.length ? '<button id="applyMergesBtn">Apply all merges</button>' : ""}
      <pre id="vocabOut" class="ok"></pre>
      <h3>Merge proposals</h3>
      <pre>\${escapeHtml(JSON.stringify(data.proposedMerges ?? [], null, 2))}</pre>
      <h3>Top 30 tags by usage</h3>
      <pre>\${escapeHtml((data.snapshot?.tags ?? []).slice(0, 30).map(t => \`\${t.tag} · \${t.count}\`).join("\\n"))}</pre>
      <h3>Dormant (last seen > 60d)</h3>
      <pre>\${escapeHtml((data.proposedDeprecations ?? []).slice(0, 30).map(t => \`\${t.tag} · \${t.lastSeen}\`).join("\\n") || "(none)")}</pre>
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
  main.innerHTML = \`
    <div class="pane">
      <h2>Health</h2>
      <h3>Findings</h3>
      <div class="grid" id="findings"></div>
      <h3>Specialists</h3>
      <pre>\${escapeHtml(JSON.stringify(a.specialists, null, 2))}</pre>
      <h3>Memory</h3>
      <pre>\${escapeHtml(JSON.stringify(a.memory, null, 2))}</pre>
      <h3>Cron upcoming</h3>
      <pre>\${escapeHtml(JSON.stringify(a.cron?.upcoming ?? [], null, 2))}</pre>
      <h3>Outcomes</h3>
      <pre>\${escapeHtml(JSON.stringify(a.outcomes, null, 2))}</pre>
      <h3>MCP</h3>
      <pre>\${escapeHtml(JSON.stringify(a.mcp ?? [], null, 2))}</pre>
    </div>
  \`;
  const f = $("findings");
  if (!a.findings?.length) {
    f.innerHTML = '<div class="empty">all systems nominal</div>';
  } else {
    for (const finding of a.findings) {
      const c = document.createElement("div");
      c.className = "card";
      const cls = finding.severity === "warn" ? "warn" : finding.severity === "err" ? "err" : "ok";
      c.innerHTML = \`<div class="row between"><span class="name">\${escapeHtml(finding.area)}</span><span class="badge \${cls}">\${escapeHtml(finding.severity)}</span></div><div class="desc">\${escapeHtml(finding.note)}</div>\`;
      f.appendChild(c);
    }
  }
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
evt.addEventListener("mcp", () => { if (state.tab === "mcp") refreshMcp(); });

setInterval(refreshHealth, 5000);
refreshHealth();
switchTab("chat");
</script>
</body>
</html>`;
}
