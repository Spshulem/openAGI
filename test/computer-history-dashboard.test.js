import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { createHostedInterface } from "../src/hosted-interface.js";

let app;
let dataDir;
let dashboardHtml;
let dashboardScript;
let previousProviderKey;
const hostedSource = fs.readFileSync(new URL("../src/hosted-interface.js", import.meta.url), "utf8");

test.before(async () => {
  previousProviderKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-only";
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-computer-history-dashboard-"));
  app = createHostedInterface({}, {
    host: "127.0.0.1",
    port: 0,
    tickerMs: 0,
    dataDir,
    authToken: ""
  });
  const listened = await app.listen();
  const base = listened.url ?? `http://127.0.0.1:${listened.port}`;
  const response = await fetch(`${base}/`, { headers: { accept: "text/html" } });
  assert.equal(response.status, 200);
  dashboardHtml = await response.text();
  const scriptMatch = dashboardHtml.match(/<script[^>]*>([\s\S]*)<\/script>/);
  assert.ok(scriptMatch, "dashboard inline script was not emitted");
  dashboardScript = scriptMatch[1];
  assert.doesNotThrow(() => new vm.Script(dashboardScript), "emitted dashboard JavaScript must parse");
});

test.after(async () => {
  await app?.close();
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  if (previousProviderKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = previousProviderKey;
});

function between(source, startText, endText) {
  const start = source.indexOf(startText);
  const end = source.indexOf(endText, start);
  assert.ok(start >= 0 && end > start, `could not isolate ${startText}`);
  return source.slice(start, end);
}

test("Computer History uses measured capture status and a day-grouped, paginated timeline", () => {
  assert.match(dashboardHtml, />Computer History<\/button>/);
  assert.match(dashboardHtml, /class="history-status-card"/);
  assert.match(dashboardHtml, /class="history-entry"/);

  const renderer = between(dashboardScript, "async function renderActivity()", "function revealDeepLinkedRecord");
  const loading = renderer.indexOf("Loading computer history");
  const firstRequest = renderer.indexOf('fetchJson("/observations/stats")');
  assert.ok(loading >= 0 && loading < firstRequest, "loading state must render before history requests begin");

  assert.match(renderer, /historyBucketKey\(row\)/, "raw focus events must be distilled into bounded work periods");
  assert.match(renderer, /historyDayKey\(period\?\.at\)/, "work periods must be grouped by local day");
  assert.match(renderer, /historyHourKey\(period\?\.at\)/, "work periods must be grouped into expandable hours");
  assert.match(renderer, /kinds: "activity,frame"/, "transcripts must be excluded before server-side pagination");
  assert.match(renderer, /history-entry-time/, "each history row must keep a readable time");
  assert.match(renderer, /history-app-label/, "each history row must identify its source app with text");
  assert.match(renderer, /state\.activityFilter\.limit \+= HISTORY_PAGE_SIZE/, "Load more must expand the bounded query");
  assert.match(renderer, /results\.length > requestedLimit/, "pagination must be based on a one-row lookahead");
  assert.match(hostedSource, /Math\.min\(5_000, Number\.isFinite\(parsedLimit\)/,
    "private OCR search responses must remain server-bounded");

  assert.match(renderer, /This dashboard cannot tell whether capture is paused, disabled, or the capture Mac is offline/);
  assert.match(renderer, /How to pause/);
  assert.match(renderer, /Manage exclusions/);
  assert.match(renderer, /aria-controls="historyControlHelp"/);
  assert.doesNotMatch(renderer, /Capture enabled/, "received observations must not be misreported as the capture toggle state");
  assert.doesNotMatch(renderer, /Clear history|Delete history|observations\/prune/, "the usability redesign must not add destructive history actions");
});

test("history rows escape observation content and expose empty/load-more states", () => {
  const helpers = between(dashboardScript, "function historyCleanText", "function renderActivityError");
  const elements = {
    actResults: {
      innerHTML: "",
      attributes: {},
      setAttribute(name, value) { this.attributes[name] = value; }
    },
    historyResultMeta: { textContent: "" },
    historyLoadMoreWrap: { hidden: true }
  };
  const context = vm.createContext({
    Map,
    Date,
    Intl,
    Number,
    String,
    $: (id) => elements[id] ?? null,
    escapeHtml: (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[character])
  });
  vm.runInContext(`${helpers}\nthis.renderActivityResults = renderActivityResults;`, context);

  context.renderActivityResults([{
    kind: "frame",
    at: new Date().toISOString(),
    app: 'Browser"><img src=x onerror=alert(1)>',
    window: "Project <script>alert(1)</script>",
    snippet: "Found <mark>needle</mark> beside <img src=x>"
  }], { query: "needle", hasMore: true });

  const rendered = elements.actResults.innerHTML;
  assert.match(rendered, /<details class="history-day" open>/);
  assert.match(rendered, /<details class="history-hour" open>/);
  assert.match(rendered, /<time class="history-entry-time"/);
  assert.match(rendered, /class="history-app-label"/);
  assert.doesNotMatch(rendered, /<script>|<img\s/, "private observation text must never become executable markup");
  assert.match(rendered, /&lt;script&gt;/, "untrusted window titles stay visible as escaped text");
  assert.doesNotMatch(rendered, /<mark>/, "search markup is stripped before rendering private text");
  assert.equal(elements.historyLoadMoreWrap.hidden, false);
  assert.match(elements.historyResultMeta.textContent, /more available/);

  context.renderActivityResults([], { query: "missing", hasMore: false });
  assert.match(elements.actResults.innerHTML, /No matching activity/);
  assert.equal(elements.historyLoadMoreWrap.hidden, true);
});

test("history coalesces repeated focus events into ten-minute work periods and humanizes app ids", () => {
  const helpers = between(dashboardScript, "function historyCleanText", "function renderActivityError");
  const elements = {
    actResults: { innerHTML: "", setAttribute() {} },
    historyResultMeta: { textContent: "" },
    historyLoadMoreWrap: { hidden: true }
  };
  const context = vm.createContext({
    Map,
    Date,
    Intl,
    Number,
    String,
    $: (id) => elements[id] ?? null,
    escapeHtml: (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[character])
  });
  vm.runInContext(`${helpers}\nthis.renderActivityResults = renderActivityResults;`, context);

  context.renderActivityResults([
    { kind: "activity", at: "2026-08-16T17:08:00.000Z", app: "com.google.Chrome", event: "focus" },
    { kind: "activity", at: "2026-08-16T17:04:00.000Z", app: "com.openai.codex", event: "focus" },
    { kind: "activity", at: "2026-08-16T16:54:00.000Z", app: "com.apple.finder", event: "focus" }
  ]);

  const rendered = elements.actResults.innerHTML;
  assert.equal((rendered.match(/class="history-entry"/g) ?? []).length, 2);
  assert.match(rendered, />Chrome</);
  assert.match(rendered, />Codex</);
  assert.match(rendered, />Finder</);
  assert.doesNotMatch(rendered, /com\.google\.Chrome|com\.openai\.codex|com\.apple\.finder/);
  assert.match(elements.historyResultMeta.textContent, /2 work periods from 3 observations/);
});

test("history exposes OCR-backed screen evidence inside day and hour groups", () => {
  const helpers = between(dashboardScript, "function historyCleanText", "function renderActivityError");
  const elements = {
    actResults: { innerHTML: "", setAttribute() {} },
    historyResultMeta: { textContent: "" },
    historyLoadMoreWrap: { hidden: true }
  };
  const context = vm.createContext({
    Map,
    Date,
    Intl,
    Number,
    String,
    $: (id) => elements[id] ?? null,
    escapeHtml: (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[character])
  });
  vm.runInContext(`${helpers}\nthis.renderActivityResults = renderActivityResults;`, context);

  context.renderActivityResults([
    { kind: "frame", ref: "safe-frame", at: "2026-08-19T17:08:00.000Z", app: "com.openai.codex", window: "History UI", text: "OCR source" },
    { kind: "activity", ref: "42", at: "2026-08-19T17:04:00.000Z", app: "com.openai.codex", window: "History UI" },
    { kind: "activity", ref: "41", at: "2026-08-19T16:54:00.000Z", app: "com.apple.finder", window: "Files" }
  ]);

  const rendered = elements.actResults.innerHTML;
  assert.equal((rendered.match(/class="history-hour"/g) ?? []).length, 2);
  assert.match(rendered, /1 OCR-backed screen capture/);
  assert.match(rendered, /data-source-count="2"/);
  assert.match(rendered, /class="history-app-mark"/);
});

test("history keeps long multi-app periods readable", () => {
  const helpers = between(dashboardScript, "function historyCleanText", "function renderActivityError");
  const elements = {
    actResults: { innerHTML: "", setAttribute() {} },
    historyResultMeta: { textContent: "" },
    historyLoadMoreWrap: { hidden: true }
  };
  const context = vm.createContext({
    Map,
    Date,
    Intl,
    Number,
    String,
    $: (id) => elements[id] ?? null,
    escapeHtml: (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[character])
  });
  vm.runInContext(`${helpers}\nthis.renderActivityResults = renderActivityResults;`, context);

  const at = "2026-08-16T17:08:00.000Z";
  context.renderActivityResults([
    "com.blizzard.worldofwarcraft",
    "com.wispr.wispr-flow",
    "com.openai.codex",
    "com.google.Chrome",
    "com.apple.finder",
    "wine preloader",
    "com.apple.UserNotificationCenter"
  ].map((app) => ({ kind: "activity", at, app, event: "focus" })));

  const rendered = elements.actResults.innerHTML;
  assert.match(rendered, /Activity across World of Warcraft, Wispr Flow, and 5 more apps/);
  assert.match(rendered, />World of Warcraft</);
  assert.match(rendered, />Wispr Flow</);
  assert.match(rendered, />\+1 more</);
  assert.equal((rendered.match(/class="history-app-label"/g) ?? []).length, 7,
    "six named apps plus one overflow chip keeps a long period scannable");
});

test("Ask about your history deep-links to Chat with an editable starter prompt", async () => {
  const openHistoryChat = between(dashboardScript, "async function openHistoryChat()", "function revealDeepLinkedRecord");
  let replaced = null;
  let selectedTab = null;
  const context = vm.createContext({
    URL,
    window: { location: { href: "http://openagi.test/?tab=activity" } },
    history: { replaceState(_state, _title, next) { replaced = next; } },
    async switchTab(tab) { selectedTab = tab; }
  });
  vm.runInContext(`${openHistoryChat}\nthis.openHistoryChat = openHistoryChat;`, context);
  await context.openHistoryChat();

  const next = new URL(replaced);
  assert.equal(next.searchParams.get("tab"), "chat");
  assert.equal(next.searchParams.get("compose"), "ask-history");
  assert.equal(selectedTab, "chat");
  assert.match(dashboardScript, /"ask-history": "Summarize what I was working on recently/);
});
