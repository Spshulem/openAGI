import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { createHostedInterface } from "../src/hosted-interface.js";

let script;

test.before(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-navigation-"));
  const priorModel = process.env.OPENAGI_LOCAL_MODEL;
  process.env.OPENAGI_LOCAL_MODEL = "navigation-test";
  let app;
  try {
    app = createHostedInterface({ dataDir }, { host: "127.0.0.1", port: 0, tickerMs: 0, dataDir, authToken: "" });
    const { url } = await app.listen();
    const response = await fetch(url);
    assert.equal(response.status, 200);
    const html = await response.text();
    script = html.match(/<script[^>]*>([\s\S]*)<\/script>/)?.[1];
    assert.ok(script, "dashboard script must be served");
    assert.doesNotThrow(() => new vm.Script(script));
  } finally {
    await app?.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    if (priorModel === undefined) delete process.env.OPENAGI_LOCAL_MODEL;
    else process.env.OPENAGI_LOCAL_MODEL = priorModel;
  }
});

function functionSource(name) {
  const start = script.search(new RegExp("(?:async )?function " + name + "\\("));
  const end = script.indexOf("\n}", start);
  assert.ok(start >= 0 && end > start, `dashboard must define ${name}`);
  return script.slice(start, end + 2);
}

class Element {
  constructor() {
    this.style = {};
    this.dataset = {};
    this.children = [];
    this.classes = new Set();
    this.classList = { toggle: (name, enabled) => enabled ? this.classes.add(name) : this.classes.delete(name) };
  }
  set innerHTML(value) { this.html = value; this.children = []; }
  get innerHTML() { return this.html; }
  appendChild(child) { this.children.push(child); }
  addEventListener() {}
  setAttribute() {}
  removeAttribute() {}
  closest() { return null; }
}

function harness({ entries = ["http://localhost/?tab=chat"], index = entries.length - 1, fetchJson = async () => [] } = {}) {
  entries = entries.slice();
  const location = {
    get href() { return entries[index]; },
    get search() { return new URL(entries[index]).search; }
  };
  const historyWrites = [];
  const history = {
    pushState(_state, _title, url) {
      historyWrites.push("push");
      entries.splice(index + 1, entries.length, String(url));
      index++;
    },
    replaceState(_state, _title, url) {
      historyWrites.push("replace");
      entries[index] = String(url);
    }
  };
  const nodes = Object.fromEntries(["sidebar", "sidebarList", "sidebarTitle", "newSession", "main", "pageTitle", "body"].map(id => [id, new Element()]));
  const buttons = ["chat", "memory", "cron"].map(tab => {
    const button = new Element();
    button.dataset.tab = tab;
    button.textContent = tab;
    return button;
  });
  const document = {
    getElementById: id => nodes[id] ?? null,
    querySelector(selector) {
      if (selector === ".body") return nodes.body;
      return buttons.find(button => selector.includes('data-tab="' + button.dataset.tab + '"')) ?? null;
    },
    querySelectorAll: () => buttons,
    createElement: () => new Element()
  };
  const openedSessions = [];
  const context = vm.createContext({
    state: { tab: "chat", sessions: [], sessionId: null, freshChatRequested: true },
    window: { location }, document, history, URL, URLSearchParams, CSS: { escape: value => value },
    $: document.getElementById,
    main: nodes.main, sidebar: nodes.sidebar, sidebarList: nodes.sidebarList,
    sidebarTitle: nodes.sidebarTitle, newBtn: nodes.newSession,
    fetchJson, escapeHtml: value => value,
    closeNavigation() {}, syncNodesAutoRefresh() {}, renderTab() {}, renderChat() {}, renderMemory() {}, refreshCron() {},
    loadSession() { throw new Error("tests should not auto-select a conversation"); },
    openSessionDeepLink: async (...args) => { openedSessions.push(args); return true; }
  });
  const names = ["showSidebar", "switchTab", "refreshSessions", "restoreHistoryLocation", "deepLinkSessionId", "deepLinkRequestId"];
  vm.runInContext(names.map(functionSource).join("\n"), context);
  vm.runInContext('const VALID_TABS = new Set(["chat", "memory", "cron"]);', context);
  return {
    context, nodes, entries, location, historyWrites, openedSessions,
    get index() { return index; },
    async go(delta) {
      index += delta;
      await context.restoreHistoryLocation();
    },
    async initialize() {
      const start = script.indexOf("const initialTab =");
      assert.ok(start >= 0);
      await vm.runInContext(script.slice(start), context);
    }
  };
}

test("saving the first conversation restores Sessions and + New without leaving Chat", async () => {
  let sessions = [];
  const h = harness({ fetchJson: async () => sessions });
  await h.context.switchTab("chat");
  assert.equal(h.nodes.sidebar.style.display, "none");
  assert.ok(h.nodes.body.classes.has("no-sidebar"));

  sessions = [{ id: "first-chat", title: "First useful result", updatedAt: "2026-11-14T09:00:00Z" }];
  await h.context.refreshSessions();
  assert.equal(h.context.state.tab, "chat");
  assert.equal(h.nodes.sidebar.style.display, "");
  assert.ok(!h.nodes.body.classes.has("no-sidebar"));
  assert.equal(h.nodes.newSession.textContent, "+ New");
  assert.equal(h.nodes.sidebarList.children.length, 1);

  sessions = [];
  await h.context.refreshSessions();
  assert.equal(h.nodes.sidebar.style.display, "none", "an empty list returns to the welcome layout");
});

test("a late Chat session refresh cannot change another tab's sidebar", async () => {
  for (const tab of ["memory", "cron"]) {
    let release;
    const h = harness({ fetchJson: () => new Promise(resolve => { release = resolve; }) });
    const loadingChat = h.context.switchTab("chat");
    await h.context.switchTab(tab);
    h.nodes.sidebarList.innerHTML = "another tab's list";
    release([{ id: "first-chat", title: "First result" }]);
    await loadingChat;
    assert.equal(h.context.state.tab, tab);
    assert.equal(h.nodes.sidebar.style.display, tab === "cron" ? "" : "none");
    assert.equal(h.nodes.sidebarList.innerHTML, "another tab's list");
    assert.equal(h.context.state.sessions[0].id, "first-chat", "cache still refreshes");
  }
});

test("initial tabless URLs replace history and preserve conversation and composer handoffs", async () => {
  for (const search of ["", "?session=overlay%3Auser%3Amain&request=request-1", "?compose=remember&pending=approval-1&onboarding=1"]) {
    const h = harness({ entries: ["http://localhost/previous", "http://localhost/" + search] });
    await h.initialize();
    assert.equal(h.entries.length, 2, "opening Chat must not create a history entry");
    assert.equal(h.index, 1);
    assert.deepEqual(h.historyWrites, ["replace"]);
    const expected = new URL("http://localhost/" + search);
    expected.searchParams.set("tab", "chat");
    assert.equal(h.location.href, expected.href);
    if (search.includes("session=")) assert.deepEqual(h.openedSessions, [["overlay:user:main", "request-1"]]);
  }
});

test("Back and Forward through tabless or unknown-tab entries never push or discard forward history", async () => {
  for (const search of ["", "?tab=unknown", "?session=overlay%3Auser%3Amain&request=request-1"]) {
    const entries = ["http://localhost/" + search, "http://localhost/?tab=memory"];
    const h = harness({ entries });
    for (let i = 0; i < 2; i++) {
      await h.go(-1);
      assert.equal(h.context.state.tab, "chat");
      assert.equal(h.index, 0, "Back must stay at the restored entry");
      assert.equal(h.location.href, entries[0]);
      await h.go(1);
      assert.equal(h.context.state.tab, "memory");
      assert.equal(h.location.href, entries[1]);
    }
    assert.deepEqual(h.entries, entries);
    assert.deepEqual(h.historyWrites, []);
  }
});

test("ordinary in-app tab changes still create one navigable history entry", async () => {
  const h = harness({ entries: ["http://localhost/?tab=chat&session=old&request=request-old&compose=remember&pending=old"] });
  await h.context.switchTab("memory");
  assert.equal(h.location.search, "?tab=memory");
  assert.deepEqual(h.historyWrites, ["push"]);
  await h.context.switchTab("memory");
  assert.equal(h.entries.length, 2, "rendering the current tab must not add another entry");
  await h.go(-1);
  assert.equal(h.context.state.tab, "chat");
  assert.equal(h.openedSessions[0][0], "old");
  await h.go(1);
  assert.equal(h.context.state.tab, "memory");
});
