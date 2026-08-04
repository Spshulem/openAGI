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
    /openSessionDeepLink\(initialSession\)/,
    "deepLinkSessionId/openSessionDeepLink exist but nothing calls them on page load"
  );
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
