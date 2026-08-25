// test/overlay-continue-in-chat.test.js
//
// "Continue in chat" in the Quick Ask popover used to open `/?tab=chat` with
// no payload at all (OverlayView.swift:166), so the user landed in a blank
// composer and had to retype the question they had just asked and re-read the
// answer they had just lost. The whole point of "continue" is continuity.
//
// The mechanism the fix uses is the one that already exists: OverlayState.ask()
// -> AppState.askOverlay() POSTs /message with channel "overlay", and
// AgentStore.sessionKey({channel:"overlay", from:"user", agentId:"main"})
// returns a REAL, file-backed session id ("overlay:user:main") that the reply
// names in `session.id`. So the button deep-links to that session rather than
// replaying text: full history, the screen context that was attached, and
// answers far longer than any URL could carry all survive the hop.
//
// These tests drive the SHIPPED code. The server half runs against a booted
// daemon over HTTP; the dashboard half extracts the exact functions the browser
// runs out of the served page and executes them.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let cached = null;

// One daemon serves both halves. A provider key has to be present or
// isFirstRun() is true and GET / 302s to the setup wizard instead of the
// dashboard — but the model provider is then swapped for the deterministic
// one so the /message turn below never touches the network.
async function boot() {
  if (cached) return cached;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-continue-chat-"));
  process.env.OPENAGI_DATA_DIR = dataDir;
  process.env.OPENAGI_AUTH_TOKEN = "";
  process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "sk-ant-not-a-real-key";
  const { _resetDataDirCache } = await import("../src/data-dir.js");
  _resetDataDirCache();
  const { createDurableRuntime, createHostedInterface } = await import("../src/index.js");
  const { DeterministicModelProvider } = await import("../src/model-provider.js");
  const runtime = createDurableRuntime({ dataDir });
  runtime.agentHost.modelProvider = new DeterministicModelProvider();
  const app = createHostedInterface(runtime, { host: "127.0.0.1", port: 0, tickerMs: 0, dataDir, authToken: null });
  const listened = await app.listen();
  const base = listened.url ?? `http://127.0.0.1:${listened.port}`;
  const html = await (await fetch(`${base}/`)).text();
  const m = html.match(/<script[^>]*>([\s\S]*)<\/script>/);
  assert.ok(m, "dashboard must contain an inline script");
  cached = { runtime, app, base, html, script: m[1] };
  return cached;
}

test.after(async () => { await cached?.app?.close?.(); });

/// Pull one top-level function out of the served dashboard source so the test
/// runs the browser's own code rather than a copy of it.
function extractFunction(script, name) {
  let start = script.indexOf(`async function ${name}(`);
  if (start < 0) start = script.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `the served dashboard has no ${name}() — the chat tab cannot honour the deep link`);
  const end = script.indexOf("\n}", start);
  assert.ok(end > start, `could not find the end of ${name}()`);
  return script.slice(start, end + 2);
}

function escapeHtmlSource(script) {
  const line = script.split("\n").find((l) => l.startsWith("function escapeHtml("));
  assert.ok(line, "could not locate escapeHtml in the served dashboard");
  return line;
}

// ─── The premise: the overlay ask really does create a durable session ───────

test("premise: an overlay ask persists a session and the reply names its id", async () => {
  const { base } = await boot();
  // Byte-for-byte the body AppState.askOverlay(text:screenContext:) sends.
  const res = await fetch(`${base}/message`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      text: "what should I do with these old tasks?",
      channel: "overlay",
      metadata: { screenContext: { app: "Safari", window: "Backlog — Linear", text: "19 open items" } }
    })
  });
  assert.equal(res.status, 200);
  const turn = await res.json();
  assert.ok(turn.session?.id, "the /message reply must name the session — the deep link is built from it");
  assert.equal(turn.session.id, "overlay:user:main");

  const session = await (await fetch(`${base}/sessions/${encodeURIComponent(turn.session.id)}`)).json();
  assert.equal(session.messages.length, 2, "the question AND the answer are both on the server");
  assert.equal(session.messages[0].content, "what should I do with these old tasks?");
  assert.equal(session.messages[0].channel, "overlay");
  assert.equal(session.messages[1].role, "assistant");
  assert.equal(session.messages[1].content, turn.reply);
  assert.equal(
    session.messages[0].metadata.screenContext.app,
    "Safari",
    "the screen context the answer used is stored with the turn, so the dashboard can show it"
  );
});

// ─── The route the chat tab arrives on ──────────────────────────────────────

test("the ?token= redirect keeps the deep link instead of throwing the query away", async () => {
  // AppState.openDashboard appends "&token=..." to EVERY dashboard open, and
  // checkAuth answers a query token with setCookie:true before it ever looks
  // at the cookie — so this redirect runs on every single click of every deep
  // link the Mac app has. It redirected to `url.pathname`, i.e. bare "/", which
  // discarded ?tab, ?session, ?suggestion, ?pending and ?compose alike. That is
  // the other half of "Continue in chat drops me in a blank chat": even a
  // perfect link never survived the hop.
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-deeplink-token-"));
  const { createDurableRuntime, createHostedInterface } = await import("../src/index.js");
  const runtime = createDurableRuntime({ dataDir });
  const app = createHostedInterface(runtime, {
    host: "127.0.0.1", port: 0, tickerMs: 0, dataDir, authToken: "deep-link-token"
  });
  const listened = await app.listen();
  const base = listened.url ?? `http://127.0.0.1:${listened.port}`;
  try {
    const res = await fetch(
      `${base}/?tab=chat&session=overlay%3Auser%3Amain&token=deep-link-token`,
      { redirect: "manual" }
    );
    assert.equal(res.status, 302, "the query token is exchanged for a cookie via a redirect");
    const location = res.headers.get("location");
    assert.ok(!location.includes("token="), "the token itself must still be stripped from the URL");
    const query = new URLSearchParams(location.split("?")[1] ?? "");
    assert.equal(query.get("tab"), "chat", "the tab survived the redirect");
    assert.equal(query.get("session"), "overlay:user:main", "the session deep link survived the redirect");
  } finally { await app.close(); }
});

// ─── The dashboard half: honouring ?session= ─────────────────────────────────

test("the chat tab resolves the ?session= the popover deep-links to", async () => {
  const { script } = await boot();
  const deepLinkSessionId = new Function(
    `${extractFunction(script, "deepLinkSessionId")}; return deepLinkSessionId;`
  )();
  assert.equal(deepLinkSessionId("?tab=chat&session=overlay:user:main&token=abc"), "overlay:user:main");
  // Percent-encoded ids have to survive too — AppState encodes the value.
  assert.equal(deepLinkSessionId("?tab=chat&session=local%3Abrowser-17%3Amain"), "local:browser-17:main");
});

test("no ?session= means no deep link (plain /?tab=chat still opens a fresh chat)", async () => {
  const { script } = await boot();
  const deepLinkSessionId = new Function(
    `${extractFunction(script, "deepLinkSessionId")}; return deepLinkSessionId;`
  )();
  assert.equal(deepLinkSessionId("?tab=chat"), null);
  assert.equal(deepLinkSessionId(""), null);
  assert.equal(deepLinkSessionId("?tab=chat&session="), null);
  assert.equal(deepLinkSessionId("?tab=chat&session=%20%20"), null);
});

test("the popup request id survives the handoff query", async () => {
  const { script } = await boot();
  const deepLinkRequestId = new Function(
    `${extractFunction(script, "deepLinkRequestId")}; return deepLinkRequestId;`
  )();
  assert.equal(deepLinkRequestId("?tab=chat&request=ask_123"), "ask_123");
  assert.equal(deepLinkRequestId("?tab=chat&request=ask%3Aencoded"), "ask:encoded");
  assert.equal(deepLinkRequestId("?tab=chat"), null);
});

test("a bare Chat open chooses newest interactive history, not background sessions", async () => {
  const { script } = await boot();
  const latestInteractiveSession = new Function(
    `${extractFunction(script, "latestInteractiveSession")}; return latestInteractiveSession;`
  )();
  const sessions = [
    { id: "cron:hourly:main" },
    { id: "autopilot:agent-pulse" },
    { id: "overlay:user:main" },
    { id: "local:browser:main" }
  ];
  assert.equal(latestInteractiveSession(sessions).id, "overlay:user:main");
  assert.equal(latestInteractiveSession(sessions.slice(0, 2)), null);
  assert.match(script, /!state\.freshChatRequested && !requestedSession[\s\S]{0,180}latestInteractiveSession\(state\.sessions\)/);
  assert.match(script, /freshChatRequested = true[\s\S]{0,180}renderTab\(\)/, "+ New must remain an intentionally empty composer");
});

test("opening the deep link loads the overlay conversation into the chat thread", async () => {
  const { script, base } = await boot();
  // Real payload from the real daemon — this is what the browser would fetch.
  const real = await (await fetch(`${base}/sessions/${encodeURIComponent("overlay:user:main")}`)).json();
  assert.ok(real.messages.length >= 2, "premise: the previous test left a two-message overlay session");

  const state = { sessionId: null, messages: [], channel: "local", from: "browser" };
  const calls = { rendered: 0, sessions: 0, toasts: [] };
  const openSessionDeepLink = new Function(
    "fetchJson", "state", "refreshSessions", "renderChat", "showToast",
    `${extractFunction(script, "openSessionDeepLink")}; return openSessionDeepLink;`
  )(
    async () => real,
    state,
    async () => { calls.sessions += 1; },
    () => { calls.rendered += 1; },
    (msg, ok) => calls.toasts.push({ msg, ok })
  );

  const ok = await openSessionDeepLink("overlay:user:main");
  assert.equal(ok, true);
  assert.equal(state.sessionId, "overlay:user:main", "the follow-up message must continue THIS session");
  assert.equal(state.messages.length, real.messages.length, "the whole history came across, not just the last turn");
  assert.equal(state.channel, "overlay", "replies keep the channel the conversation started on");
  assert.equal(state.from, "user");
  assert.equal(calls.rendered, 1, "the thread is re-rendered with the loaded history");
  assert.deepEqual(calls.toasts, [], "a healthy handoff is silent");
});

test("a reused session stays queued until the newly handed-off request is persisted", async () => {
  const { script } = await boot();
  const oldMessages = [
    { role: "user", content: "old question", channel: "overlay", from: "user", metadata: { requestId: "req_old" } },
    { role: "assistant", content: "old answer", channel: "overlay", from: "user", metadata: { requestId: "req_old" } }
  ];
  const state = { sessionId: null, messages: [], channel: "local", from: "browser" };
  let fetches = 0;
  const openSessionDeepLink = new Function(
    "fetchJson", "state", "refreshSessions", "renderChat", "showToast", "setTimeout",
    `${extractFunction(script, "openSessionDeepLink")}; return openSessionDeepLink;`
  )(
    async () => {
      fetches += 1;
      return { id: "overlay:user:main", messages: oldMessages };
    },
    state,
    async () => {},
    () => {},
    () => {},
    (fn) => fn()
  );

  assert.equal(await openSessionDeepLink("overlay:user:main", "req_new"), true);
  assert.equal(fetches, 4, "old history must not make a brand-new request look loaded");
  assert.equal(state.activeRequestId, "req_new");
  assert.equal(state.activeRequestStage, "queued");
  assert.equal(typeof state.activeRequestMissingSince, "number");
  assert.equal(state.messages.length, 2, "existing history remains visible while the new turn arrives");
});

test("a stale deep link says so instead of silently showing a blank chat", async () => {
  const { script } = await boot();
  const state = { sessionId: "should-not-be-claimed", messages: [], channel: "local", from: "browser" };
  const toasts = [];
  const openSessionDeepLink = new Function(
    "fetchJson", "state", "refreshSessions", "renderChat", "showToast",
    `${extractFunction(script, "openSessionDeepLink")}; return openSessionDeepLink;`
  )(
    // GET /sessions/:id answers with an empty shell for an id it never saw
    // (agent-store getSession returns a default) — never a 404.
    async () => ({ id: "gone:user:main", messages: [] }),
    state,
    async () => {},
    () => {},
    (msg, ok) => toasts.push({ msg, ok })
  );

  const ok = await openSessionDeepLink("gone:user:main");
  assert.equal(ok, false);
  assert.equal(state.sessionId, null, "an empty session must not be adopted as the live one");
  assert.equal(toasts.length, 1, "the user is told the conversation is gone");
  assert.equal(toasts[0].ok, false);
});

test("a failed session fetch is reported, not swallowed into an empty thread", async () => {
  const { script } = await boot();
  const state = { sessionId: null, messages: [], channel: "local", from: "browser" };
  const toasts = [];
  const openSessionDeepLink = new Function(
    "fetchJson", "state", "refreshSessions", "renderChat", "showToast",
    `${extractFunction(script, "openSessionDeepLink")}; return openSessionDeepLink;`
  )(
    async () => { throw new Error("daemon offline"); },
    state,
    async () => {},
    () => {},
    (msg, ok) => toasts.push({ msg, ok })
  );

  assert.equal(await openSessionDeepLink("overlay:user:main"), false);
  assert.equal(toasts.length, 1);
  assert.match(toasts[0].msg, /daemon offline/);
});

test("the bootstrap actually consumes the deep link on load", async () => {
  const { script } = await boot();
  assert.match(
    script,
    /openSessionDeepLink\(initialSession, initialRequest\)/,
    "deepLinkSessionId/openSessionDeepLink exist but nothing calls them on page load"
  );
});

test("dashboard distinguishes a persisted pending request from completed and failed turns", async () => {
  const { script } = await boot();
  const requestState = new Function(
    `const CHAT_REQUEST_STALE_MS = 30 * 60 * 1000;
     ${extractFunction(script, "messageRequestId")}
     ${extractFunction(script, "messageRequestStatus")}
     ${extractFunction(script, "requestState")}
     return requestState;`
  )();
  const user = { role: "user", content: "clean this up", metadata: { requestId: "req_1" } };
  assert.equal(requestState([user], "req_1").status, "pending");
  assert.equal(requestState([user, { role: "assistant", content: "done" }], "req_1").status, "complete");
  const failed = { role: "assistant", content: "Could not finish", metadata: { requestId: "req_1", status: "failed" } };
  assert.equal(requestState([user, failed], "req_1").status, "failed");

  const secondUser = { role: "user", content: "and this", metadata: { requestId: "req_2" } };
  const secondReply = { role: "assistant", content: "second done", metadata: { requestId: "req_2" } };
  const firstReply = { role: "assistant", content: "first done", metadata: { requestId: "req_1" } };
  const interleaved = [user, secondUser, secondReply, firstReply];
  assert.equal(requestState(interleaved, "req_1").message, firstReply);
  assert.equal(requestState(interleaved, "req_2").message, secondReply);

  const orphan = { role: "user", content: "old", createdAt: "2020-01-01T00:00:00.000Z", metadata: { requestId: "req_old" } };
  assert.equal(requestState([orphan], "req_old").status, "interrupted");
});

test("dashboard composer consumes lifecycle frames instead of appearing disconnected", async () => {
  const { script } = await boot();
  assert.doesNotThrow(() => new Function(script), "the complete generated dashboard script must parse");
  const postMessageStream = new Function(
    "fetch", "TextDecoder", "Uint8Array",
    `${extractFunction(script, "postMessageStream")}; return postMessageStream;`
  )(
    async () => new Response([
      'event: status\ndata: {"stage":"thinking"}\n\n',
      'event: heartbeat\ndata: {"stage":"tool"}\n\n',
      'event: delta\ndata: {"text":"Live answer","reset":true,"model":"gpt-test"}\n\n',
      'event: final\ndata: {"reply":"finished","session":{"id":"overlay:user:main"}}\n\n'
    ].join(""), { headers: { "content-type": "text/event-stream" } }),
    TextDecoder,
    Uint8Array
  );
  const seen = [];
  const result = await postMessageStream({ text: "work" }, (event, data) => seen.push([event, data]));
  assert.equal(result.reply, "finished");
  assert.deepEqual(seen.slice(0, 2).map(([event, data]) => [event, data.stage]), [["status", "thinking"], ["heartbeat", "tool"]]);
  assert.deepEqual(seen[2], ["delta", { text: "Live answer", reset: true, model: "gpt-test" }]);
  assert.match(script, /event === "delta"[\s\S]{0,100}updateStreamingAssistant\(requestId, data\)/);
  assert.match(script, /function renderStreamingAssistant\([\s\S]{0,1200}renderMarkdown\(state\.activeRequestText\)/);
  assert.match(script, /function renderPageChatComposer\([\s\S]{0,2600}postMessageStream\([\s\S]{0,800}event === "delta"/);
});

test("same-session completion reloads the durable thread", async () => {
  const { script } = await boot();
  assert.match(script, /data\.sessionId === state\.sessionId[\s\S]{0,700}refreshActiveChatSession\(data\.sessionId/);
  assert.match(script, /const waitingForPersistence = !outcome && Boolean\(id\)/);
  assert.match(script, /outcome\?\.status === "pending" \|\| waitingForPersistence\)[\s\S]{0,120}refreshActiveChatSession/);
});

test("transport loss stays pending while explicit daemon failure is terminal", async () => {
  const { script } = await boot();
  assert.match(script, /err\.terminal === true \? "failed" : "disconnected"/);
  assert.match(script, /currentSend\.disabled = outcome\?\.status === "pending"/);
  assert.match(script, /waitingForPersistence[\s\S]{0,500}CHAT_REQUEST_STALE_MS/);
  assert.match(script, /Request interrupted[\s\S]{0,300}Review any task changes before retrying/);
});

test("Mac Quick Ask names the session before waiting and offers the handoff in every state", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const appState = fs.readFileSync(path.join(root, "mac/Sources/OpenAGI/AppState.swift"), "utf8");
  const overlay = fs.readFileSync(path.join(root, "mac/Sources/OpenAGI/Overlay/OverlayView.swift"), "utf8");
  assert.match(appState, /let sessionId = lastAskSessionId \?\? "overlay:user:main"/);
  assert.match(appState, /lastAskSessionId = sessionId[\s\S]{0,900}"sessionId": sessionId/);
  assert.match(appState, /setValue\("text\/event-stream", forHTTPHeaderField: "Accept"\)/);
  assert.match(appState, /case "delta"[\s\S]{0,350}onTextDelta\?\(delta\.text, delta\.reset == true\)/);
  assert.match(overlay, /if state\.isLoading[\s\S]{0,1200}if !state\.answer\.isEmpty[\s\S]{0,250}answerBody/);
  assert.match(overlay, /if state\.isLoading[\s\S]{0,900}Continue in main app/);
  assert.match(overlay, /else if let err = state\.error[\s\S]{0,900}Open in main app/);
});

test("Mac Quick Ask owns a durable inline approval surface", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const appState = fs.readFileSync(path.join(root, "mac/Sources/OpenAGI/AppState.swift"), "utf8");
  const overlay = fs.readFileSync(path.join(root, "mac/Sources/OpenAGI/Overlay/OverlayView.swift"), "utf8");
  const approvals = fs.readFileSync(path.join(root, "mac/Sources/OpenAGI/Overlay/PendingApprovalConsumer.swift"), "utf8");

  assert.match(approvals, /path: "\/pending-actions\?status=pending"/);
  assert.match(approvals, /path: "\/pending-actions\/\\\(id\)\/\\\(decision\)"/);
  assert.match(approvals, /refreshGeneration &\+= 1[\s\S]{0,180}let generation = refreshGeneration/);
  assert.match(approvals, /guard generation == refreshGeneration else \{ return \}[\s\S]{0,100}items = decoded\.actions/);
  assert.match(approvals, /terminalDecisionError\(statusCode: http\.statusCode, data: data\)[\s\S]{0,500}items\.removeAll/);
  assert.match(approvals, /sourceSessionId = try c\.decodeIfPresent\(Context\.self, forKey: \.context\)\?\.sessionId/);
  assert.match(approvals, /lastChatSessionId = terminal\.chatSessionId \?\? lastChatSessionId/);
  assert.match(approvals, /let isComputerUseApproval = Self\.isComputerUseApproval/);
  assert.match(approvals, /if isComputerUseApproval \{[\s\S]{0,250}lastChatSessionId = sourceSessionId \?\? lastChatSessionId/);
  assert.match(approvals, /if isComputerUseApproval \{[\s\S]{0,350}activeComputerSessionId = decoded\?\.result\?\.sessionId/);
  assert.match(overlay, /"Approval needed" : "Approvals needed"/);
  assert.match(overlay, /Button\("Approve & run"\)/);
  assert.match(overlay, /Button\("Open chat"\) \{ app\.openChatSession\(approvals\.lastChatSessionId\) \}/);
  assert.match(overlay, /ForEach\(approvals\.items\)[\s\S]{0,500}\.frame\(maxHeight: 230\)/);
  assert.match(overlay, /Open all approvals in main app/);
  assert.match(overlay, /await approvals\.refresh\(\)/);
  assert.match(appState, /if event == "pending-action"[\s\S]{0,700}PendingApprovalConsumer\.shared\.refresh\(\)[\s\S]{0,300}OverlayState\.shared\.expanded = true/);
  assert.match(appState, /if event == "pending-action-resolved"[\s\S]{0,160}PendingApprovalConsumer\.shared\.refresh\(\)/);
});

// ─── Screen context must not vanish in the hop ──────────────────────────────

test("a turn that used screen context says so in the thread", async () => {
  const { script } = await boot();
  const screenContextChip = new Function(
    `${escapeHtmlSource(script)}\n${extractFunction(script, "screenContextChip")}; return screenContextChip;`
  )();

  const chip = screenContextChip({ screenContext: { app: "Safari", window: "Backlog — Linear", text: "19 open items" } });
  assert.ok(chip.includes("Safari"), "the app whose window was read is named");
  assert.ok(chip.includes("Backlog"), "the window title is named");
  assert.equal(screenContextChip({}), "", "no context, no chip");
  assert.equal(screenContextChip(null), "", "no metadata, no chip");
  assert.equal(screenContextChip({ screenContext: {} }), "", "an empty context is not evidence of anything");

  // Screen text is attacker-influenced (it is whatever was on screen), so the
  // chip has to be escaped like everything else the dashboard renders.
  const evil = screenContextChip({ screenContext: { app: '<img src=x onerror=alert(1)>', text: "x" } });
  assert.ok(!evil.includes("<img"), `screen context escaped into markup: ${evil}`);
});

test("appendMessage renders the chip for user turns", async () => {
  const { script } = await boot();
  const body = extractFunction(script, "appendMessage");
  assert.match(body, /screenContextChip\(/, "appendMessage drops the screen-context chip on the floor");
});
