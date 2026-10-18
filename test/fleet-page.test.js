import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { fleetPage } from "../src/fleet/page.js";
import { DEFAULTS } from "../src/fleet/contracts.js";

function pageScript() {
  const scripts = [...fleetPage.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.equal(scripts.length, 1, "exactly one plain <script> tag (sendHtml stamps the nonce)");
  return scripts[0];
}

test("fleet page is a standalone document with the four sections", () => {
  assert.match(fleetPage, /^<!doctype html>/i);
  for (const text of ["Needs you", "Doing", "Infra", "Fleet", "Scan now", 'href="/"']) {
    assert.ok(fleetPage.includes(text), text);
  }
  for (const mode of ["observe", "propose", "auto"]) assert.ok(fleetPage.includes('data-mode="' + mode + '"'), mode);
});

test("fleet page script parses", () => {
  assert.doesNotThrow(() => new vm.Script(pageScript()));
});

test("fleet page obeys the CSP and template rules", () => {
  const script = pageScript();
  const html = fleetPage.replace(/<script>[\s\S]*?<\/script>/, "");
  assert.doesNotMatch(fleetPage, /`/, "no backticks");
  assert.doesNotMatch(fleetPage, /\$\{/, "no dollar-brace");
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i, "no inline on* handlers in markup");
  assert.doesNotMatch(script, /\bon[a-z]+\s*=\s*["']/i, "no on* attribute strings in script");
  assert.doesNotMatch(script, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/, "text only, never HTML sinks");
  assert.doesNotMatch(script, /<script/i, "no script tag text inside the script");
  assert.doesNotMatch(script, /\beval\(|new Function/, "no eval");
  assert.doesNotMatch(fleetPage, /<img|src=["']https?:|<link[^>]+href=["']https?:/i, "no external assets or images");
  assert.doesNotMatch(script, /\?\?[^\n]*\|\||\|\|[^\n]*\?\?/, "no ?? mixed with || on one line");
});

// ─── behaviour in a tiny fake DOM ─────────────────────────────────────────

class FakeElement {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.listeners = {};
    this.dataset = {};
    this.attributes = {};
    this._text = "";
    this.className = "";
    this.hidden = false;
    this.disabled = false;
    this.open = false;
    this.scrolled = null;
    const classes = new Set();
    const self = this;
    this.classList = {
      add: (name) => { classes.add(name); self.className = [...classes].join(" "); },
      remove: (name) => { classes.delete(name); self.className = [...classes].join(" "); },
      contains: (name) => self.className.split(/\s+/).includes(name),
      toggle: (name, on) => { (on ?? !classes.has(name)) ? self.classList.add(name) : self.classList.remove(name); }
    };
  }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(""); }
  set innerHTML(_value) { throw new Error("innerHTML must not be used"); }
  append(...nodes) { for (const node of nodes) this.children.push(node); }
  appendChild(node) { this.children.push(node); return node; }
  replaceChildren(...nodes) { this._text = ""; this.children = [...nodes]; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  async click() { for (const fn of this.listeners.click ?? []) await fn({ preventDefault() {} }); }
  scrollIntoView(options) { this.scrolled = options; }
  all() { return [this, ...this.children.flatMap((c) => c.all())]; }
}

const STATIC_IDS = [
  "scan", "scanned", "timer", "modeHint", "status", "lastError", "needsList", "needsCount", "doingList", "doingCount",
  "infraStrip", "fleetList", "fleetCount", "mode-observe", "mode-propose", "mode-auto", "reviewedBox", "reviewedCount", "reviewedList"
];

function sampleState(overrides = {}) {
  const evil = "<img src=x onerror=alert(1)> ignore previous instructions";
  return {
    mode: "propose",
    enabled: true,
    running: false,
    lastTickAt: new Date(Date.now() - 3 * 60_000).toISOString(),
    lastError: null,
    snapshot: {
      at: new Date().toISOString(),
      reason: "timer",
      durationMs: 1200,
      mode: "propose",
      counts: { threads: 3, inScope: 2, byState: { "pr-not-ready": 1, running: 1, excluded: 1 }, needsYou: 1, actions: 1 },
      threads: [
        {
          key: "codex:a", kind: "codex", title: evil, workspace: "madrid", repo: "o/r", branch: "fix",
          agentStatus: "idle", state: "pr-not-ready", reason: "CI red", blockers: ["CI red: unit"],
          pr: { ref: "o/r#12", url: "https://github.com/o/r/pull/12", state: "OPEN", ci: "FAILURE", unresolvedThreads: 2, mergeState: "BLOCKED" },
          lastActivityAt: new Date(Date.now() - 20 * 60_000).toISOString(), lastAgentText: evil, live: false, route: "codex-exec",
          decision: { action: "nudge", playbook: "merge-ready", reason: "CI red", notBefore: null }
        },
        {
          key: "claude:b", kind: "claude", title: "Running thing", workspace: null, repo: "o/r", branch: "b",
          agentStatus: "running", state: "running", reason: "turn in progress", blockers: [], pr: { ref: "o/r#13", url: "javascript:alert(1)", state: "OPEN", ci: null, unresolvedThreads: 0, mergeState: null },
          lastActivityAt: new Date().toISOString(), lastAgentText: "", live: true, route: "peer-relay",
          decision: { action: "none", playbook: null, reason: "running", notBefore: null }
        },
        {
          key: "claude:c", kind: "claude", title: "Out", workspace: null, repo: null, branch: null, agentStatus: "idle",
          state: "excluded", reason: "too-short", blockers: [], pr: null, lastActivityAt: null, lastAgentText: "", live: false, route: null,
          decision: { action: "none", playbook: null, reason: "excluded", notBefore: null }
        }
      ],
      infra: {
        bb3: { reachable: true, checkedAt: null, gate: { state: "blocked", reason: "x", since: new Date(Date.now() - 40 * 60_000).toISOString() }, fullQueue: 11, quickQueue: 2, load: [1, 1, 1], runs: [{ pid: 1, kind: "full", pr: 6522, head: "abc", ageSec: 3000, owner: "madrid" }], timersDead: ["lb-guard"], error: null },
        lb: { healthy: false, detail: "503", watchLine: null, recentErrors: [] },
        localVerify: [{ pid: 9, command: "pnpm build", cwd: "/x", ageSec: 60, threadKey: "codex:a" }]
      },
      storage: { volumes: [{ id: "data", freeGb: 137.4, totalGb: 1858, mounted: true, identityOk: true, low: true, critical: false }, { id: "sd", freeGb: 63, totalGb: 1863, mounted: true, identityOk: false }], lastFreed: { gb: 8.2, at: new Date().toISOString(), what: "safe cleanup" }, pendingAsks: 1 },
      sourceErrors: { github: evil }
    },
    questions: [
      { id: "fq_one", dedupeKey: "k", kind: "agent-ask", threadKey: "codex:a", prRef: "o/r#12", title: evil, body: evil, options: ["Yes", "No"], status: "open", answer: null, createdAt: new Date().toISOString() }
    ],
    actions: [
      { id: "fa_one", at: new Date().toISOString(), threadKey: "codex:a", targetKey: "codex:a", playbook: "merge-ready", route: "codex-exec", message: evil, status: "proposed", detail: null, reason: "CI red" },
      { id: "fa_two", at: new Date(Date.now() - 60_000).toISOString(), threadKey: "infra:bb3", targetKey: "conductor:m", playbook: "manager-bb3", route: "peer-relay", message: "BB3 slow", status: "sent", detail: null, reason: "gate" }
    ],
    ...overrides
  };
}

function boot({ search = "", state = sampleState(), confirmResult = true, promptResult = null } = {}) {
  const elements = new Map(STATIC_IDS.map((id) => [id, new FakeElement(id.startsWith("mode-") ? "button" : "div")]));
  for (const mode of ["observe", "propose", "auto"]) elements.get("mode-" + mode).dataset.mode = mode;
  const requests = [];
  const responses = [];
  let currentState = state;
  const fetch = async (path, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    requests.push({ path, method: init.method ?? "GET", body });
    const pending = responses.shift();
    const next = pending ? await pending : null;
    if (next) return { ok: next.status < 400, status: next.status, json: async () => next.body };
    return { ok: true, status: 200, json: async () => currentState };
  };
  const timers = [];
  const confirms = [];
  const docListeners = {};
  const context = vm.createContext({
    document: {
      getElementById: (id) => elements.get(id) ?? null,
      createElement: (tag) => new FakeElement(tag),
      addEventListener: (type, fn) => { (docListeners[type] ??= []).push(fn); },
      visibilityState: "visible"
    },
    window: { matchMedia: () => ({ matches: true }), prompt: () => promptResult },
    location: { search },
    URLSearchParams,
    fetch,
    confirm: (text) => { confirms.push(text); return confirmResult; },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    Date, Math, JSON, Map, Set, Array, Object, String, Number, Promise, Error, isFinite, encodeURIComponent
  });
  vm.runInContext(pageScript(), context);
  return {
    elements, requests, responses, timers, confirms, context,
    setState(next) { currentState = next; },
    el: (id) => elements.get(id)
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
async function settle() { for (let i = 0; i < 10; i += 1) await flush(); }

function findAll(root, predicate) {
  return root.all().filter(predicate);
}

test("page renders state with text only and neutralises unsafe links", async () => {
  const page = boot();
  await settle();
  assert.equal(page.requests[0].path, "/fleet/api/state");
  const needs = page.el("needsList");
  assert.ok(needs.textContent.includes("<img src=x onerror=alert(1)>"), "untrusted title is plain text");
  const optionButtons = findAll(needs, (e) => e.tagName === "BUTTON");
  assert.deepEqual(optionButtons.map((b) => b.textContent), ["Yes", "No", "Dismiss"]);
  const fleet = page.el("fleetList");
  const links = findAll(fleet, (e) => e.tagName === "A");
  assert.ok(links.some((a) => a.href === "https://github.com/o/r/pull/12"));
  assert.ok(links.every((a) => /^https:\/\/github\.com\//.test(a.href)), "only GitHub https links");
  assert.ok(links.every((a) => a.rel.includes("noopener")));
  assert.ok(fleet.textContent.includes("PR not ready"));
  assert.ok(page.el("infraStrip").textContent.includes("blocked"));
  assert.ok(page.el("infraStrip").textContent.includes("github"));
  assert.ok(page.el("infraStrip").textContent.includes("137 GB free"), "disk free on the infra strip");
  // Low by the manager's own threshold (an env override), not a fixed 100.
  assert.equal(findAll(page.el("infraStrip"), (e) => e.textContent === "137 GB free")[0].className, "warn");
  assert.ok(page.el("infraStrip").textContent.includes("63 GB free, unverified"));
  const doing = page.el("doingList");
  assert.equal(findAll(doing, (e) => e.tagName === "BUTTON" && e.textContent === "Send").length, 1, "Send only on proposed");
  assert.equal(page.el("mode-propose").getAttribute("aria-pressed"), "true");
  assert.equal(page.el("mode-auto").getAttribute("aria-pressed"), "false");
  assert.equal(page.el("scan").disabled, false);
  assert.ok(page.timers.some((t) => t.ms === 30_000), "polls every 30 s");
});

test("tapping an option posts the answer and re-renders from the reply", async () => {
  const page = boot();
  await settle();
  const answered = sampleState({ questions: [] });
  page.responses.push({ status: 200, body: { question: { id: "fq_one", status: "answered" }, delivery: { status: "sent" }, state: answered } });
  const yes = findAll(page.el("needsList"), (e) => e.tagName === "BUTTON" && e.textContent === "Yes")[0];
  await yes.click();
  await settle();
  const post = page.requests.find((r) => r.method === "POST");
  assert.equal(post.path, "/fleet/api/questions/fq_one");
  assert.deepEqual(post.body, { answer: "Yes" });
  assert.ok(page.el("needsList").textContent.includes("Nothing needs you"));
  assert.ok(page.el("status").textContent.length > 0);
});

test("dismiss posts { dismiss: true }", async () => {
  const page = boot();
  await settle();
  page.responses.push({ status: 200, body: { question: { id: "fq_one", status: "dismissed" }, state: sampleState({ questions: [] }) } });
  const dismiss = findAll(page.el("needsList"), (e) => e.tagName === "BUTTON" && e.textContent === "Dismiss")[0];
  await dismiss.click();
  await settle();
  const post = page.requests.find((r) => r.method === "POST");
  assert.deepEqual(post.body, { dismiss: true });
});

test("Send on a proposed action posts to the send route", async () => {
  const page = boot();
  await settle();
  page.responses.push({ status: 200, body: { action: { id: "fa_one", status: "sent" }, delivery: { status: "sent" }, state: sampleState() } });
  const send = findAll(page.el("doingList"), (e) => e.tagName === "BUTTON" && e.textContent === "Send")[0];
  await send.click();
  await settle();
  assert.ok(page.requests.some((r) => r.method === "POST" && r.path === "/fleet/api/actions/fa_one/send"));
});

test("auto mode asks confirm first; declining sends nothing", async () => {
  const page = boot({ confirmResult: false });
  await settle();
  await page.el("mode-auto").click();
  await settle();
  assert.equal(page.confirms.length, 1);
  assert.equal(page.requests.some((r) => r.path === "/fleet/api/mode"), false);
  await page.el("mode-observe").click();
  await settle();
  const post = page.requests.find((r) => r.path === "/fleet/api/mode");
  assert.deepEqual(post.body, { mode: "observe" });
  assert.equal(page.confirms.length, 1, "observe needs no confirm");
});

test("Scan now disables while running and posts a scan", async () => {
  const page = boot();
  await settle();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const originalFetch = page.context.fetch;
  page.context.fetch = async (path, init) => {
    if (path === "/fleet/api/scan") await gate;
    return originalFetch(path, init);
  };
  const clicking = page.el("scan").click();
  await flush();
  assert.equal(page.el("scan").disabled, true);
  release();
  await clicking;
  await settle();
  assert.ok(page.requests.some((r) => r.method === "POST" && r.path === "/fleet/api/scan"));
  assert.equal(page.el("scan").disabled, false);
});

test("server-side running scan also disables the button", async () => {
  const page = boot({ state: sampleState({ running: true }) });
  await settle();
  assert.equal(page.el("scan").disabled, true);
});

test("?q=<id> scrolls to and highlights that card", async () => {
  const page = boot({ search: "?q=fq_one" });
  await settle();
  const card = findAll(page.el("needsList"), (e) => e.dataset.id === "fq_one")[0];
  assert.ok(card, "card rendered");
  assert.ok(card.classList.contains("flash"));
  assert.ok(card.scrolled, "scrolled into view");
});

test("empty state before the first scan", async () => {
  const page = boot({ state: { mode: "observe", enabled: false, running: false, lastTickAt: null, lastError: null, snapshot: null, questions: [], actions: [] } });
  await settle();
  assert.ok(page.el("needsList").textContent.includes("Nothing needs you"));
  assert.ok(page.el("fleetList").textContent.length > 0);
  assert.ok(page.el("scanned").textContent.includes("Not scanned"));
  assert.equal(page.el("reviewedBox").hidden, true, "no review closes, no list");
});

test("questions the supervisor cleared list compactly with category, reason and time; Reopen posts { reopen: true }", async () => {
  const evil = "<img src=x onerror=alert(1)>";
  const clearedAt = new Date(Date.now() - 5 * 60_000).toISOString();
  const closed = { id: "fq_rev", title: evil, status: "resolved", resolvedBy: "review", reviewCategory: "done-elsewhere", reviewReason: "PR merged " + evil, answeredAt: clearedAt };
  const reopened = { ...closed, status: "open", resolvedBy: null, pinned: true, createdAt: new Date().toISOString(), options: ["yes", "no"] };
  const page = boot({ state: sampleState({ reviewClosed: [closed] }) });
  await settle();
  assert.ok(fleetPage.includes("Cleared by supervisor"));
  assert.equal(page.el("reviewedBox").hidden, false);
  assert.equal(page.el("reviewedCount").textContent, "1");
  const list = page.el("reviewedList");
  assert.ok(list.textContent.includes(evil), "plain text");
  assert.ok(list.textContent.includes("Done elsewhere"), "category label");
  assert.ok(list.textContent.includes("PR merged"), "reason");
  const at = findAll(list, (e) => e.textContent === "cleared 5m ago")[0];
  assert.ok(at, "time");
  assert.ok(at.title.length > 0, "exact time on hover");
  const reopen = findAll(list, (e) => e.tagName === "BUTTON" && e.textContent === "Reopen")[0];
  assert.match(reopen.className, /\bsm\b/, "compact button");
  page.responses.push({ status: 200, body: { question: reopened, state: sampleState({ reviewClosed: [], questions: [reopened] }) } });
  await reopen.click();
  await settle();
  const post = page.requests.find((r) => r.method === "POST");
  assert.equal(post.path, "/fleet/api/questions/fq_rev");
  assert.deepEqual(post.body, { reopen: true });
  assert.equal(page.el("reviewedBox").hidden, true);
  assert.match(page.el("status").textContent, /Reopened/);
  const card = findAll(page.el("needsList"), (e) => e.dataset.id === "fq_rev")[0];
  assert.ok(card.classList.contains("flash") && card.scrolled, "the reopened card is shown");
  assert.ok(card.textContent.includes("You reopened it. The supervisor had said: PR merged"), "the overridden close reads as such");
});

test("a duplicate names the open question it duplicates", async () => {
  const closed = { id: "fq_dup", title: "#12 ready. Merge?", status: "resolved", resolvedBy: "review", reviewCategory: "duplicate", reviewReason: "same PR", duplicateOf: "fq_one", answeredAt: new Date().toISOString() };
  const page = boot({ state: sampleState({ reviewClosed: [closed, { ...closed, id: "fq_dup2", duplicateOf: "fq_gone" }] }) });
  await settle();
  const rows = findAll(page.el("reviewedList"), (e) => e.className === "item cleared");
  assert.equal(rows.length, 2);
  assert.ok(rows[0].textContent.includes("Duplicate"));
  assert.ok(rows[0].textContent.includes("same as: <img src=x onerror=alert(1)>"), "the kept question's title, as text");
  assert.equal(rows[1].textContent.includes("same as:"), false, "a target no longer open is not named");
});

test("a failed Reopen shows the error, re-enables the button and reloads", async () => {
  const closed = { id: "fq_rev", title: "Merge?", status: "resolved", resolvedBy: "review", reviewCategory: "stale", reviewReason: "merged", answeredAt: new Date().toISOString() };
  const page = boot({ state: sampleState({ reviewClosed: [closed] }) });
  await settle();
  page.responses.push({ status: 409, body: { error: "Only a question the review closed can be reopened." } });
  const reopen = findAll(page.el("reviewedList"), (e) => e.tagName === "BUTTON" && e.textContent === "Reopen")[0];
  const before = page.requests.length;
  await reopen.click();
  await settle();
  assert.match(page.el("status").textContent, /Only a question the review closed/);
  assert.equal(page.el("status").className, "status err");
  assert.equal(reopen.disabled, false);
  assert.ok(page.requests.slice(before).some((r) => r.method === "GET" && r.path === "/fleet/api/state"), "reloads the list");
});

test("an open question shows why the supervisor kept it, with the full reason on hover", async () => {
  const long = "Owner must pick: the agent asked at 09:12 whether to merge #12 with admin override. " + "x".repeat(200);
  const kept = { id: "fq_kept", dedupeKey: "k2", kind: "ready", title: "#12 ready. Merge?", options: ["merged", "later"], status: "open", createdAt: new Date().toISOString(), reviewCategory: "live", reviewReason: long, reviewedAt: new Date().toISOString() };
  const plain = { id: "fq_plain", dedupeKey: "k3", kind: "ready", title: "#13 ready. Merge?", options: ["merged", "later"], status: "open", createdAt: new Date().toISOString() };
  const page = boot({ state: sampleState({ questions: [kept, plain] }) });
  await settle();
  const cards = findAll(page.el("needsList"), (e) => e.tagName === "ARTICLE");
  const note = findAll(cards[0], (e) => e.tagName === "P" && e.textContent.startsWith("Supervisor: "))[0];
  assert.ok(note, "secondary line");
  assert.ok(note.textContent.length < long.length, "clipped on the card");
  assert.ok(note.title.startsWith(long), "full reason on hover");
  assert.match(note.title, /reviewed /);
  assert.equal(cards[1].textContent.includes("Supervisor:"), false, "no review, no line");
});

test("Oldest run skips queued runs and uses policy's slow limits", async () => {
  assert.doesNotMatch(fleetPage, /FLEET_(?:FULL|QUICK)_SLOW_SEC/, "limits filled in");
  const fullSlowSec = DEFAULTS.fullRunSlowMs / 1000;
  const oldestPill = async (runs) => {
    const state = sampleState();
    state.snapshot.infra.bb3.runs = runs;
    const page = boot({ state });
    await settle();
    const pill = findAll(page.el("infraStrip"), (e) => e.className === "pill" && e.textContent.startsWith("Oldest run"))[0];
    return { text: pill.textContent, tone: pill.children[0].className };
  };
  const full = (pr, ageSec, queued) => ({ pid: pr, kind: "full", pr, head: "abc", ageSec, owner: null, queued });
  // Hours in the queue, and a 40-min admitted run past the old 30-min line.
  let pill = await oldestPill([full(1, 4 * 3600, true), full(2, 40 * 60, false)]);
  assert.match(pill.text, /#2$/, "the queued run is not the oldest");
  assert.equal(pill.tone, "dim", "under fullRunSlowMs is not slow");
  pill = await oldestPill([full(3, fullSlowSec, false)]);
  assert.equal(pill.tone, "warn", "slow from fullRunSlowMs");
  pill = await oldestPill([full(4, 4 * 3600, true)]);
  assert.match(pill.text, /none$/, "only queued runs: none running");
  const quick = { pid: 5, kind: "quick", pr: 5, head: "abc", ageSec: DEFAULTS.quickVerifyEscalateMs / 1000, owner: null };
  pill = await oldestPill([quick]);
  assert.equal(pill.tone, "warn", "quick runs keep quickVerifyEscalateMs");
  pill = await oldestPill([full(2, 40 * 60, false), quick, null]);
  assert.match(pill.text, /#5$/, "an older full run under its limit does not hide a slow quick run");
  assert.equal(pill.tone, "warn");
});

test("Watching groups threads by what the supervisor waits on, longest first, with how long", async () => {
  const at = (min) => new Date(Date.now() - min * 60_000).toISOString();
  const base = sampleState();
  const row = (key, title, watch, extra = {}) => ({
    key, kind: "conductor", title, workspace: null, repo: "o/r", branch: "b", agentStatus: "waiting", state: "waiting-ci", reason: "waiting",
    blockers: [], pr: { ref: "o/r#1", url: "https://github.com/o/r/pull/1", state: "OPEN", ci: null }, lastActivityAt: at(1), lastAgentText: "",
    live: false, route: null, decision: null, watch, ...extra
  });
  const threads = [
    row("conductor:w1", "Short wait", { group: "waiting", since: at(5), waitingOn: "BuildBot3 full run", waitSince: at(5), runningSince: at(9) }),
    row("conductor:w2", "Long wait", { group: "waiting", since: at(42), waitingOn: "BuildBot3 full run", waitSince: at(42), runningSince: at(50) }),
    row("conductor:r1", "Busy", { group: "working", since: at(12), waitingOn: null, waitSince: null, runningSince: at(12) }, { agentStatus: "running", state: "running" }),
    row("claude:x", "Out", null, { state: "excluded" })
  ];
  const page = boot({ state: { ...base, snapshot: { ...base.snapshot, threads } } });
  await settle();
  const fleet = page.el("fleetList");
  const text = fleet.textContent;
  assert.ok(text.includes("Waiting on CI or BuildBot3"));
  assert.ok(text.includes("Working"));
  assert.ok(text.includes("on BuildBot3 full run for 42m"));
  assert.ok(text.includes("for 12m"));
  assert.ok(text.indexOf("Working") < text.indexOf("Waiting on CI or BuildBot3"), "groups in watch order");
  assert.ok(text.indexOf("Long wait") < text.indexOf("Short wait"), "longest wait first");
  assert.ok(text.includes("Turn running"));
});

// ─── open chat, row detail and row actions ────────────────────────────────

function watchState() {
  const at = (min) => new Date(Date.now() - min * 60_000).toISOString();
  const base = sampleState();
  const row = (key, title, watch, extra = {}) => ({
    key, kind: "conductor", title, workspace: "remote-dev", repo: "o/r", branch: "b", agentStatus: "idle", state: "pr-not-ready", reason: "waiting",
    blockers: [], pr: { ref: "o/r#7", url: "https://github.com/o/r/pull/7", state: "OPEN", ci: null }, lastActivityAt: at(1), lastAgentText: "",
    live: false, route: "computer-use", decision: null, watch, muted: null, lastOwnerAt: null,
    openChat: { app: "conductor", url: "conductor://workspace?id=w1&session=s1", label: "remote-dev · Codex LB Transcript open (Conductor)", note: null },
    ...extra
  });
  const threads = [
    row("conductor:d1", "Capacity fix", { group: "you", since: at(90), waitingOn: "your answer", waitSince: null, runningSince: null }),
    row("conductor:p1", "Stalled PR", { group: "push", since: at(30), waitingOn: null, waitSince: null, runningSince: null }, {
      decision: { action: "wait", reason: "owner is driving this thread" },
      pushPreview: { action: "nudge", playbook: "merge-ready", reason: "idle 30m with CI green", message: "CI is green. Merge when ready." }
    }),
    row("conductor:p2", "No plan", { group: "push", since: at(20), waitingOn: null, waitSince: null, runningSince: null }, {
      decision: { action: "wait", playbook: null, reason: "cooldown after the last nudge", notBefore: null, message: null }
    }),
    row("claude:t1", "Terminal", { group: "working", since: at(4), waitingOn: null, waitSince: null, runningSince: at(4) }, {
      kind: "claude", openChat: { app: "claude", url: null, label: "openAGI · Claude Code terminal", note: "No link opens a terminal session." }
    }),
    row("conductor:m1", "Muted one", { group: "push", since: at(50), waitingOn: null, waitSince: null, runningSince: null }, {
      muted: new Date(Date.now() + 3600_000).toISOString(), openChat: { app: "conductor", url: "javascript:alert(1)", label: "x", note: null }
    })
  ];
  const ask = {
    id: "fq_cap", kind: "agent-ask", threadKey: "conductor:d1", title: "Which BuildBot3 capacity fix should be applied?", body: "Pick one.",
    options: ["Add a slot", "Raise the timeout"], status: "open", createdAt: at(10), askedAt: at(180),
    chatLabel: "remote-dev · Codex LB Transcript open (Conductor)", answerIn: "here", risky: false,
    openChat: { app: "conductor", url: "conductor://workspace?id=w1&session=s1", label: "remote-dev · Codex LB Transcript open (Conductor)", note: null }
  };
  return { ...base, questions: [ask], actions: [], snapshot: { ...base.snapshot, threads } };
}

function rowOf(page, title) {
  return findAll(page.el("fleetList"), (e) => e.tagName === "DETAILS" && e.className.includes("thread") && e.textContent.includes(title))[0];
}

async function expand(row) {
  row.open = true;
  for (const fn of row.listeners.toggle ?? []) await fn({});
  await settle();
}

test("question cards say which chat, when the agent asked, and link straight to it", async () => {
  const page = boot({ state: watchState() });
  await settle();
  const needs = page.el("needsList");
  assert.ok(needs.textContent.includes("in remote-dev · Codex LB Transcript open (Conductor)"));
  assert.ok(needs.textContent.includes("asked 3h ago"), "the agent's ask time, not when the card was made");
  const open = findAll(needs, (e) => e.tagName === "A" && e.textContent === "Open chat");
  assert.equal(open.length, 1);
  assert.equal(open[0].href, "conductor://workspace?id=w1&session=s1");
});

test("a question answered only in the agent's app leads with Open chat and says so", async () => {
  const state = watchState();
  state.questions = [{ ...state.questions[0], kind: "agent-card", answerIn: "agent app", options: ["opened"],
    openChat: { app: "codex", url: "codex://threads/01a13388", label: "amex · Codex", note: null } }];
  const page = boot({ state });
  await settle();
  const opts = findAll(page.el("needsList"), (e) => e.className === "opts")[0];
  assert.equal(opts.children[0].tagName, "A", "the way to the app comes first");
  assert.equal(opts.children[0].href, "codex://threads/01a13388");
  assert.ok(opts.children[0].className.includes("primary"));
  assert.ok(page.el("needsList").textContent.includes("Answer this in Codex. Nothing is sent from here."));
});

test("a risky ask shows all its words before any button, with no highlighted default", async () => {
  const state = watchState();
  const long = "Release 0.0.56 to production. ".repeat(40) + "THE END";
  state.questions = [{ ...state.questions[0], title: "docs #43: cut production release?", risky: true, askContext: long, options: ["Release", "Hold"] }];
  const page = boot({ state });
  await settle();
  const card = findAll(page.el("needsList"), (e) => e.tagName === "ARTICLE")[0];
  const order = card.all();
  const warn = order.findIndex((e) => e.className === "risk");
  const quote = order.findIndex((e) => e.tagName === "BLOCKQUOTE");
  const firstButton = order.findIndex((e) => e.tagName === "BUTTON");
  assert.ok(warn >= 0 && warn < quote && quote < firstButton, "warning, then the full text, then the buttons");
  assert.equal(order[quote].className, "quote", "not clamped");
  assert.ok(order[quote].textContent.endsWith("THE END"));
  assert.ok(findAll(card, (e) => e.tagName === "BUTTON").every((b) => !b.className.includes("primary")));
});

test("Watching rows link to their chat; a chat no link opens names itself and why", async () => {
  const page = boot({ state: watchState() });
  await settle();
  const cap = rowOf(page, "Capacity fix");
  const summary = cap.children[0];
  const link = findAll(summary, (e) => e.tagName === "A" && e.textContent === "Open chat")[0];
  assert.equal(link.href, "conductor://workspace?id=w1&session=s1");
  assert.ok(summary.textContent.includes("remote-dev · Codex LB Transcript open (Conductor)"));
  const term = rowOf(page, "Terminal");
  assert.equal(findAll(term, (e) => e.tagName === "A" && e.textContent === "Open chat").length, 0);
  assert.ok(term.textContent.includes("openAGI · Claude Code terminal"));
  assert.ok(term.textContent.includes("No link opens a terminal session."));
  const muted = rowOf(page, "Muted one");
  assert.equal(findAll(muted, (e) => e.tagName === "A" && /^javascript:/.test(e.href)).length, 0, "only conductor:// and codex:// links");
});

test("expanding a row loads its detail: last message, PR with CI, owner's last word, next step", async () => {
  const state = watchState();
  const thread = state.snapshot.threads.find((row) => row.key === "conductor:p1");
  for (const field of ["pr", "decision", "lastOwnerAt"]) delete thread[field];
  const page = boot({ state });
  await settle();
  const row = rowOf(page, "Stalled PR");
  page.responses.push({ status: 200, body: { thread: {
    key: "conductor:p1", agentStatus: "idle", lastAgentMessage: { text: "Done. Waiting for review <b>x</b>", at: new Date(Date.now() - 25 * 60_000).toISOString() },
    lastOwnerAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
    pr: { ref: "o/r#7", url: "https://github.com/o/r/pull/7", state: "OPEN", title: "Fix LB", ci: { state: "FAILURE", failing: ["unit"], pending: ["e2e"] }, unresolvedThreads: 1, mergeState: "BLOCKED" },
    watch: { group: "push", since: new Date(Date.now() - 30 * 60_000).toISOString(), waitingOn: null },
    decision: { action: "nudge", playbook: "merge-ready", reason: "idle 30m with CI green", notBefore: null, message: "CI is green. Merge when ready." },
    openChat: { app: "conductor", url: "conductor://workspace?id=w1&session=s1", label: "remote-dev · Remote dev setup (Conductor)", note: null },
    scannedAt: new Date().toISOString()
  } } });
  await expand(row);
  const get = page.requests.find((r) => r.path.startsWith("/fleet/api/threads/"));
  assert.equal(get.path, "/fleet/api/threads/conductor%3Ap1");
  assert.equal(get.method, "GET");
  const text = rowOf(page, "Stalled PR").textContent;
  assert.ok(text.includes("Done. Waiting for review <b>x</b>"), "last message as plain text");
  assert.ok(text.includes("Agent last spoke25m ago"));
  assert.ok(text.includes("You last wrote2h ago"));
  assert.ok(text.includes("CI FAILURE, failing: unit, pending: e2e"));
  assert.ok(text.includes("Fix LB"));
  assert.ok(text.includes("Nextnudge (merge-ready)"));
  assert.ok(text.includes("Whyidle 30m with CI green"));
  assert.ok(text.includes("Waits onNeeds a push, for 30m"));
});

test("a row whose detail is gone says so instead of failing", async () => {
  const page = boot({ state: watchState() });
  await settle();
  page.responses.push({ status: 404, body: { error: "not found" } });
  await expand(rowOf(page, "Stalled PR"));
  assert.ok(rowOf(page, "Stalled PR").textContent.includes("not in the last scan; scan again"));
});

test("Push now shows the planned words first, posts the push and reports a refusal", async () => {
  const page = boot({ state: watchState() });
  await settle();
  const row = rowOf(page, "Stalled PR");
  const order = row.all();
  const quote = order.findIndex((e) => e.tagName === "BLOCKQUOTE" && e.textContent === "CI is green. Merge when ready.");
  const push = order.findIndex((e) => e.tagName === "BUTTON" && e.textContent === "Push now");
  assert.ok(quote >= 0 && quote < push, "the words come before the button");
  page.responses.push({ status: 200, body: { delivery: { status: "blocked", route: "computer-use", detail: "waits on your answer first: Pick one" }, action: null, state: watchState() } });
  await order[push].click();
  await settle();
  const post = page.requests.find((r) => r.method === "POST");
  assert.equal(post.path, "/fleet/api/threads/conductor%3Ap1/push");
  assert.deepEqual(post.body, {});
  assert.equal(page.el("status").textContent, "Not pushed: waits on your answer first: Pick one");
  assert.ok(page.el("status").className.includes("err"));
});

test("Push now appears only with a planned nudge; otherwise the row says why", async () => {
  const page = boot({ state: watchState() });
  await settle();
  const none = rowOf(page, "No plan");
  assert.equal(findAll(none, (e) => e.tagName === "BUTTON" && e.textContent === "Push now").length, 0);
  assert.ok(none.textContent.includes("No nudge planned yet: cooldown after the last nudge"));
  const you = rowOf(page, "Capacity fix");
  assert.equal(findAll(you, (e) => e.tagName === "BUTTON" && e.textContent === "Push now").length, 0, "never over your open question");
  const muted = rowOf(page, "Muted one");
  assert.equal(findAll(muted, (e) => e.tagName === "BUTTON" && e.textContent === "Push now").length, 0);
});

test("Mute posts 24 hours; a muted row offers Unmute", async () => {
  const page = boot({ state: watchState() });
  await settle();
  const until = new Date(Date.now() + 24 * 3600_000).toISOString();
  page.responses.push({ status: 200, body: { muted: until, state: watchState() } });
  const mute = findAll(rowOf(page, "Stalled PR"), (e) => e.tagName === "BUTTON" && e.textContent === "Mute 24h")[0];
  await mute.click();
  await settle();
  let post = page.requests.filter((r) => r.method === "POST").at(-1);
  assert.equal(post.path, "/fleet/api/threads/conductor%3Ap1/mute");
  assert.deepEqual(post.body, { hours: 24 });
  assert.ok(page.el("status").textContent.startsWith("Muted until"));
  const muted = rowOf(page, "Muted one");
  assert.ok(muted.textContent.includes("muted"));
  page.responses.push({ status: 200, body: { muted: null, state: watchState() } });
  await findAll(muted, (e) => e.tagName === "BUTTON" && e.textContent === "Unmute")[0].click();
  await settle();
  post = page.requests.filter((r) => r.method === "POST").at(-1);
  assert.equal(post.path, "/fleet/api/threads/conductor%3Am1/unmute");
});

test("a Waiting on you row carries its question's options and Dismiss", async () => {
  const page = boot({ state: watchState() });
  await settle();
  const row = rowOf(page, "Capacity fix");
  const labels = findAll(row, (e) => e.tagName === "BUTTON").map((b) => b.textContent);
  assert.deepEqual(labels.slice(0, 3), ["Add a slot", "Raise the timeout", "Dismiss"]);
  assert.ok(row.textContent.includes("asked 3h ago in remote-dev · Codex LB Transcript open (Conductor)"));
  page.responses.push({ status: 200, body: { question: { id: "fq_cap", status: "answered" }, delivery: { status: "sent" }, state: watchState() } });
  await findAll(row, (e) => e.tagName === "BUTTON" && e.textContent === "Raise the timeout")[0].click();
  await settle();
  const post = page.requests.find((r) => r.method === "POST");
  assert.equal(post.path, "/fleet/api/questions/fq_cap");
  assert.deepEqual(post.body, { answer: "Raise the timeout" });
});

test("open thread is a chat link, never an answer button", async () => {
  const state = watchState();
  state.questions[0].options = ["A", "open thread", "B"];
  const page = boot({ state });
  await settle();
  const buttons = findAll(page.el("needsList"), (e) => e.tagName === "BUTTON");
  assert.deepEqual(buttons.map((b) => b.textContent), ["A", "B", "Dismiss"]);
});

test("Push now stays disabled through polling during a send", async () => {
  const page = boot({ state: watchState() });
  await settle();
  let release;
  page.responses.push(new Promise((resolve) => { release = resolve; }));
  const push = () => findAll(rowOf(page, "Stalled PR"), (e) => e.tagName === "BUTTON" && e.textContent === "Push now")[0];
  const send = push().click();
  await settle();
  await page.timers.find((timer) => timer.ms === 30_000).fn();
  await settle();
  assert.equal(push().disabled, true);
  await push().click();
  assert.equal(page.requests.filter((r) => r.method === "POST").length, 1);
  release({ status: 200, body: { delivery: { status: "sent" }, state: watchState() } });
  await send;
});

test("a refreshed row wins over cached detail after dismissing its question", async () => {
  const state = watchState();
  const page = boot({ state });
  await settle();
  page.responses.push({ status: 200, body: { thread: {
    key: "conductor:d1", watch: { group: "you", waitingOn: "your answer" },
    pr: { ref: "o/r#99", title: "Stale PR" }, decision: { action: "ask-owner", reason: "Stale decision" },
    muted: new Date(Date.now() + 3600_000).toISOString(),
    lastAgentMessage: { text: "Longer agent message" }
  } } });
  await expand(rowOf(page, "Capacity fix"));
  const fresh = structuredClone(state);
  fresh.questions = [];
  const thread = fresh.snapshot.threads[0];
  thread.watch = { group: "push", waitingOn: "ready to continue" };
  thread.pr = { ref: "o/r#8", title: "Current PR" };
  thread.decision = { action: "wait", reason: "Current decision" };
  page.responses.push({ status: 200, body: { state: fresh } });
  await findAll(rowOf(page, "Capacity fix"), (e) => e.tagName === "BUTTON" && e.textContent === "Dismiss")[0].click();
  await settle();
  let text = rowOf(page, "Capacity fix").textContent;
  assert.ok(text.includes("ready to continue"));
  assert.ok(text.includes("Current PR"));
  assert.ok(text.includes("Current decision"));
  assert.ok(text.includes("Longer agent message"));
  assert.doesNotMatch(text, /your answer|Stale PR|Stale decision|Muted until/);
  assert.equal(page.requests.filter((r) => r.path.startsWith("/fleet/api/threads/")).length, 1, "detail remains cached");
  thread.pr = null;
  thread.decision = null;
  page.setState(fresh);
  await page.el("scan").click();
  await settle();
  text = rowOf(page, "Capacity fix").textContent;
  assert.doesNotMatch(text, /Stale PR|Stale decision|Current PR|Current decision/);
});


test("Antigravity thread details show how to open the conversation as plain text", async () => {
  const state = sampleState();
  const thread = state.snapshot.threads[0];
  thread.kind = "antigravity";
  const note = "Open Antigravity and pick it in the sidebar. <img src=x>";
  thread.openChat = { note };
  const page = boot({ state });
  await settle();
  assert.ok(page.el("fleetList").textContent.includes(note));
  assert.equal(findAll(page.el("fleetList"), (e) => e.tagName === "IMG").length, 0);
});

test("improvement plans render as text with no coding option for setup and reviewing leaves the card open", async () => {
  const state = sampleState({ questions: [{ id: 'fq_plan', kind: 'suggestion', title: 'Setup needed', body: 'Budget exhausted', status: 'open',
    options: ['Review plan', 'Not now', 'Never'], meta: { plan: { label: 'Setup needed', nextAction: '<img src=x> Review the budget window', acceptance: 'Requested turn succeeds' } } }] });
  const f = boot({ state });
  await new Promise(resolve => setImmediate(resolve));
  assert.match(f.el('needsList').textContent, /<img src=x> Review the budget window/);
  assert.match(f.el('needsList').textContent, /Success check: Requested turn succeeds/);
  assert.ok(!f.el('needsList').all().some(e => e.tagName === 'IMG'));
  assert.ok(!f.el('needsList').all().some(e => e.tagName === 'BUTTON' && e.textContent === 'Fix it'));
  const review = f.el('needsList').all().find(e => e.tagName === 'BUTTON' && e.textContent === 'Review plan');
  await review.click();
  assert.deepEqual(f.requests.find(r => r.method === 'POST').body, { answer: 'Review plan' });
  assert.match(f.el('status').textContent, /No action taken/);
});

test('clarification cards collect an answer and show its unresolved state as text', async () => {
  const question = { id: 'fq_clarify', kind: 'suggestion', title: 'Which workflow?', status: 'open', options: ['Answer question', 'Review plan'],
    meta: { plan: { remedy: 'clarification', label: 'Ask a question', nextAction: 'What was expected?', acceptance: 'Verified outcome' } } };
  const f = boot({ state: sampleState({ questions: [question] }), promptResult: '<img src=x> synthetic answer' });
  await settle();
  const answered = structuredClone(question);
  answered.meta.clarification = { answer: '<img src=x> synthetic answer', answeredAt: new Date().toISOString() };
  f.responses.push({ status: 200, body: { state: sampleState({ questions: [answered] }), nonResolving: true } });
  await f.el('needsList').all().find(e => e.tagName === 'BUTTON' && e.textContent === 'Answer question').click();
  assert.deepEqual(f.requests.find(r => r.method === 'POST').body, { answer: 'Answer question', clarification: '<img src=x> synthetic answer' });
  assert.match(f.el('needsList').textContent, /Your clarification: <img src=x> synthetic answer/);
  assert.match(f.el('status').textContent, /still unresolved/);
  assert.equal(f.el('needsList').all().some(e => e.tagName === 'IMG'), false);
});
