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
let base;
let previousProviderKey;
const hostedSource = fs.readFileSync(new URL("../src/hosted-interface.js", import.meta.url), "utf8");

test.before(async () => {
  previousProviderKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-only";
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-computer-history-dashboard-"));
  app = createHostedInterface({ dataDir }, {
    host: "127.0.0.1",
    port: 0,
    tickerMs: 0,
    dataDir,
    authToken: ""
  });
  const listened = await app.listen();
  base = listened.url ?? `http://127.0.0.1:${listened.port}`;
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
  assert.match(renderer, /history-app-icon/, "each history row must identify its source app with an accessible icon");
  assert.match(renderer, /proactive\/suggestions\?status=pending&category=skill&limit=200&view=summary/,
    "history should load a bounded summary of pending skill suggestions without a second surface");
  assert.match(renderer, /encodeURIComponent\(id\)/, "skill suggestion ids must be encoded before reaching the accept route");
  assert.match(renderer, /result\.skillCreateError/, "retryable skill creation failures must not be reported as success");
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

test("Computer Use history renders the complete semantic action vocabulary without exposing values", () => {
  const renderer = between(dashboardScript, "async function renderComputerUse()", "async function renderActivity()");
  for (const kind of [
    "list_apps", "activate_app", "click_element", "drag", "paste", "set_value",
    "select_text", "secondary_action", "scroll_element"
  ]) {
    assert.match(renderer, new RegExp(`case "${kind}"`), `missing readable ${kind} history copy`);
  }
  assert.match(renderer, /textCharacterCount/);
  assert.match(renderer, /valueCharacterCount/);
  assert.match(renderer, /Double-click/);
  assert.match(renderer, /Triple-click/);
  assert.match(renderer, /args\.button/);
  assert.match(renderer, /args\.durationMs/);
  assert.match(renderer, /args\.toY/);
  assert.doesNotMatch(renderer, /args\.text\b|args\.value\b/, "sensitive values must never be rendered from action history");
});

test("history suggestion feed is category-filtered, bounded, and summary-only", async () => {
  const suggestedDir = path.join(dataDir, "skills-suggested");
  fs.mkdirSync(suggestedDir, { recursive: true });
  for (const [index, proposedAt] of [[1, "2026-08-19T17:00:00.000Z"], [2, "2026-08-19T18:00:00.000Z"]]) {
    fs.writeFileSync(path.join(suggestedDir, `sug_summary_${index}.json`), JSON.stringify({
      id: `sug_summary_${index}`,
      proposedAt,
      status: "pending",
      sequence: { apps: ["com.openai.codex"], occurrences: [{ private: "must not leave compact view" }] },
      proposal: {
        name: `release-triage-${index}`,
        description: "A reusable release workflow",
        body: "private full skill body"
      }
    }));
  }

  const response = await fetch(`${base}/proactive/suggestions?status=pending&category=skill&limit=1&view=summary`);
  assert.equal(response.status, 200);
  const suggestions = await response.json();
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].id, "sug_summary_2", "the newest matching suggestion wins the bounded view");
  assert.deepEqual(suggestions[0].sequence.apps, ["com.openai.codex"]);
  assert.equal(suggestions[0].proposal.description, "A reusable release workflow");
  assert.equal("body" in suggestions[0].proposal, false);
  assert.equal("draftBody" in suggestions[0], false);
  assert.equal("occurrences" in suggestions[0].sequence, false);
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
  assert.match(rendered, /class="history-app-icon/);
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
  assert.match(rendered, /title="Chrome"/);
  assert.match(rendered, /title="Codex"/);
  assert.match(rendered, /title="Finder"/);
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
  assert.match(rendered, /class="history-app-icon/);
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
    "com.apple.UserNotificationCenter",
    "com.tinyspeck.slackmacgap",
    "us.zoom.xos",
    "com.apple.MobileSMS",
    "com.apple.Calendar",
    "com.github.GitHubClient",
    "com.example.thirteenth"
  ].map((app) => ({ kind: "activity", at, app, event: "focus" })));

  const rendered = elements.actResults.innerHTML;
  assert.match(rendered, /Activity across World of Warcraft, Wispr Flow, and 11 more apps/);
  assert.match(rendered, /title="World of Warcraft"/);
  assert.match(rendered, /title="Wispr Flow"/);
  assert.match(rendered, />\+1</);
  assert.equal((rendered.match(/class="history-app-icon/g) ?? []).length, 12,
    "twelve icon tiles plus one overflow chip keeps a long period scannable");
});

test("history attaches an escaped skill suggestion to matching app evidence", () => {
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
    Math,
    Number,
    Set,
    String,
    $: (id) => elements[id] ?? null,
    escapeHtml: (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[character])
  });
  vm.runInContext(`${helpers}\nthis.renderActivityResults = renderActivityResults;`, context);

  context.renderActivityResults([{
    kind: "activity",
    at: "2026-08-19T16:50:00.000Z",
    app: "com.openai.codex",
    window: "Release coordination"
  }], { suggestions: [{
    id: 'sug_"><img src=x onerror=alert(1)>',
    status: "pending",
    category: "skill",
    title: "release triage",
    rationale: "Turn staging, pull request, and rollout checks into a reusable <script>workflow</script>.",
    proposedAt: "2026-08-19T16:55:00.000Z",
    sequence: { apps: ["com.openai.codex"] }
  }, {
    id: "sug_unrelated",
    status: "pending",
    category: "skill",
    title: "unrelated",
    proposedAt: "2026-08-19T16:55:00.000Z",
    sequence: { apps: ["com.apple.finder"] }
  }] });

  const rendered = elements.actResults.innerHTML;
  assert.match(rendered, /class="history-skill-card"/);
  assert.match(rendered, /Create Release Triage skill/);
  assert.match(rendered, /&lt;script&gt;workflow&lt;\/script&gt;/);
  assert.doesNotMatch(rendered, /<script>|<img\s|unrelated/);
  assert.match(rendered, /data-history-skill="sug_&quot;&gt;&lt;img/,
    "suggestion ids remain inert when copied into the action data attribute");
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
