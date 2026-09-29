import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULTS, uiTargetFor } from "../src/fleet/contracts.js";
import {
  createPresenceProbe, createUiDriver, createUiLock, findComposer, flattenMessage, looksLikeOurs, parseAppState, parseBundleIdLine,
  conductorIds, parseConsoleSession, parseFrontAsn, parseIdleMs, uiIdentity, verifyIdentity
} from "../src/fleet/ui-delivery.js";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489", "hex").toString("base64");
const MESSAGE = "[OpenAGI supervisor] Ready to merge? CI red: lint. Fix it, push, and report the new head.";

// A scripted stand-in for Conductor as Open Computer Use would describe it.
// Nothing here talks to a real app.
function fakeApp(overrides = {}) {
  const app = {
    bundleId: "com.conductor.app",
    windowTitle: "Conductor",
    workspaces: ["madrid", "cairo"],
    selected: "madrid",
    heading: null,
    composer: "",
    focused: null,
    selectAll: false,
    transcript: ["[OpenAGI supervisor] earlier note", "Pushed the fix."],
    stop: false,
    prompt: false,
    sendButton: true,
    // Hooks a test can use to misbehave.
    onType: null,
    onSend: null,
    onClickRow: (name) => { app.selected = name; },
    // The page element: Codex labels it with the open thread's title,
    // Conductor puts the open workspace and session in its URL.
    page: null,
    // Conductor sidebar links: { label, url, session }.
    links: [],
    onClickLink: (link) => { app.page = { ...app.page, url: `${link.url}?activeTabType=session&sessionId=${link.session}` }; },
    ...overrides
  };
  app.render = () => {
    const lines = [`App=${app.bundleId} (pid 42)`, `Window: ${JSON.stringify(app.windowTitle)}, App: Conductor.`, "0 standard window Conductor"];
    if (app.page) lines.push(`  90 HTML content ${app.page.label ?? ""}, URL: ${app.page.url ?? "app://-/index.html"}`);
    app.links.forEach((link, index) => lines.push(`  ${70 + index} link [${link.label}](${link.url})`));
    app.workspaces.forEach((name, index) => lines.push(`  ${index + 1} row${app.selected === name ? " (selected)" : ""} ${name}`));
    if (app.heading) lines.push(`  5 heading ${app.heading}`);
    app.transcript.forEach((text, index) => lines.push(`  ${20 + index} static text ${text}`));
    lines.push("  60 group composer");
    lines.push(`    61 text entry area (settable, string)${app.composer ? ` Value: ${app.composer}` : ""}`);
    if (app.sendButton) lines.push("  62 button Send");
    if (app.stop) lines.push("  63 button Stop");
    if (app.prompt) lines.push("  64 button Allow once");
    if (app.focused) lines.push(`The focused UI element is ${app.focused} text entry area.`);
    return { isError: false, content: [{ type: "text", text: `${lines.join("\n")}\n` }, { type: "image", mimeType: "image/png", data: PNG }] };
  };
  return app;
}

function fakeTransport(app, { failOn = null } = {}) {
  const transport = {
    calls: [],
    closed: 0,
    async call(name, args) {
      transport.calls.push({ name, args: { ...args } });
      if (failOn && failOn(name, args, transport.calls.length)) throw new Error("Open Computer Use stopped, timed out, or disconnected; delivery is unconfirmed.");
      if (name === "get_app_state") return app.render();
      if (name === "click") {
        const id = String(args.element_index);
        if (id === "61") app.focused = "61";
        else if (id === "62") {
          if (app.onSend) app.onSend();
          else if (app.composer) { app.transcript.push(app.composer); app.composer = ""; }
        } else if (app.links[Number(id) - 70]) {
          app.onClickLink(app.links[Number(id) - 70]);
        } else {
          const index = Number(id) - 1;
          if (app.workspaces[index]) app.onClickRow(app.workspaces[index]);
        }
        return { isError: false, content: [] };
      }
      if (name === "type_text") {
        if (app.focused !== "61") throw new Error("type_text requires a focused editable text element");
        app.composer += app.onType ? app.onType(args.text) : args.text;
        return { isError: false, content: [] };
      }
      if (name === "press_key") {
        if (args.key === "super+a") app.selectAll = true;
        else if (args.key === "BackSpace" && app.selectAll) { app.composer = ""; app.selectAll = false; }
        else if (args.key === "Return" && app.composer) {
          if (app.onSend) app.onSend();
          else { app.transcript.push(app.composer); app.composer = ""; }
        }
        return { isError: false, content: [] };
      }
      return { isError: false, content: [] };
    },
    close() { transport.closed += 1; }
  };
  return transport;
}

function fakeProbe(overrides = {}) {
  const probe = {
    front: "com.google.Chrome",
    idle: 1_000,
    running: true,
    screen: { locked: false, secureInput: false, onConsole: true },
    opened: [],
    onOpen: null,
    async frontApp() { return probe.front; },
    async appRunning() { return probe.running; },
    async idleMs() { return probe.idle; },
    async session() { return probe.screen; },
    async openUrl(url) { probe.opened.push(url); probe.onOpen?.(url); return true; },
    ...overrides
  };
  return probe;
}

const conductorThread = (extra = {}) => ({
  key: "conductor:s1", kind: "conductor", id: "s1", title: "Fix billing", workspace: "madrid", archived: false,
  meta: { conductorWorkspaceId: "w-madrid", conductorSessionId: "s1", conductorSessionTitle: "Fix billing", conductorWorkspaceSessions: 1 }, ...extra
});

function setup(t, { app = fakeApp(), probe = fakeProbe(), transportOptions = {}, driverOptions = {}, evidence = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-ui-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let clock = Date.parse("2026-09-27T12:00:00.000Z");
  const transports = [];
  let permissionChecks = 0;
  const driver = createUiDriver({
    config: { bins: { ocu: "/fake/OpenComputerUse" }, limits: { ...DEFAULTS } },
    probe,
    transportFactory: (options) => { const transport = fakeTransport(app, transportOptions); transport.options = options; transports.push(transport); return transport; },
    permissionProbe: async () => { permissionChecks += 1; return { accessibility: true, screenRecording: true }; },
    binaryReady: () => true,
    computerUseEnabled: () => true,
    activeSessions: () => [],
    evidenceDir: evidence ? path.join(dir, "evidence") : null,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    ...driverOptions
  });
  const thread = conductorThread();
  const target = uiTargetFor(thread);
  const request = (extra = {}) => ({ text: MESSAGE, target, identity: uiIdentity(thread, target, [thread]), evidenceName: "fa_test", ...extra });
  const calls = () => transports.flatMap((transport) => transport.calls);
  return { app, probe, driver, transports, calls, request, dir, get permissionChecks() { return permissionChecks; } };
}

const names = (calls) => calls.map((call) => call.name);
const typed = (calls) => calls.filter((call) => call.name === "type_text").map((call) => call.args.text);

test("happy path: verify, focus, type one line, check, send, confirm", async (t) => {
  const f = setup(t);
  const result = await f.driver.deliver(f.request());
  assert.equal(result.status, "sent", result.detail);
  assert.match(result.detail, /typed into Conductor/);
  assert.deepEqual(names(f.calls()), ["get_app_state", "click", "get_app_state", "type_text", "get_app_state", "click", "get_app_state"]);
  const [, focus, , , , send] = f.calls();
  assert.deepEqual(focus.args, { app: "com.conductor.app", element_index: "61", click_method: "accessibility" });
  assert.deepEqual(send.args, { app: "com.conductor.app", element_index: "62", click_method: "accessibility" });
  assert.deepEqual(typed(f.calls()), [MESSAGE]);
  assert.equal(f.app.transcript.at(-1), MESSAGE);
  assert.equal(f.app.composer, "");
  assert.deepEqual(f.probe.opened, [], "thread already shown: no deep link");
  assert.equal(f.transports.length, 1);
  assert.equal(f.transports[0].closed, 1, "transport always closed");
  assert.equal(result.evidence.length, 2);
  for (const file of result.evidence) {
    assert.match(path.basename(file), /^fa_test-(before|after)\.png$/);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  }
  assert.equal(result.unconfirmed, undefined);
});

test("messages are flattened to one line before typing", async (t) => {
  assert.equal(flattenMessage("line one\nline two\r\n\n- item\tthree\u2028end  "), "line one line two - item three end");
  const f = setup(t);
  const result = await f.driver.deliver(f.request({ text: "[OpenAGI supervisor] Waiting on BuildBot3.\nGate: blocked.\n\nRuns: #12 full 40m." }));
  assert.equal(result.status, "sent", result.detail);
  const [text] = typed(f.calls());
  assert.equal(text, "[OpenAGI supervisor] Waiting on BuildBot3. Gate: blocked. Runs: #12 full 40m.");
  assert.doesNotMatch(text, /[\r\n]/);
});

test("the owner active in the target app blocks before any UI call", async (t) => {
  const f = setup(t, { probe: fakeProbe({ front: "com.conductor.app", idle: 3_000 }) });
  const result = await f.driver.deliver(f.request());
  assert.equal(result.status, "blocked");
  assert.match(result.detail, /owner using Conductor/);
  assert.equal(f.transports.length, 0);
});

test("the target app not running blocks and is never launched", async (t) => {
  const f = setup(t, { probe: fakeProbe({ running: false }) });
  const result = await f.driver.deliver(f.request());
  assert.equal(result.status, "blocked");
  assert.match(result.detail, /Conductor is not running/);
  assert.equal(f.transports.length, 0);
  assert.deepEqual(f.probe.opened, []);
});

test("readiness failures block without touching the app", async (t) => {
  const cases = [
    [{ driverOptions: { computerUseEnabled: () => false } }, /computer use is off/],
    [{ driverOptions: { binaryReady: () => false } }, /OPENAGI_FLEET_OCU_PATH/],
    [{ driverOptions: { activeSessions: () => [{ id: "cu-1" }] } }, /computer-use session is active/],
    [{ driverOptions: { permissionProbe: async () => ({ accessibility: true, screenRecording: false }) } }, /Accessibility and Screen Recording/],
    [{ probe: fakeProbe({ screen: { locked: true, secureInput: false, onConsole: true } }) }, /screen locked/],
    [{ probe: fakeProbe({ screen: { locked: false, secureInput: true, onConsole: true } }) }, /secure input/],
    [{ probe: fakeProbe({ screen: { locked: false, secureInput: false, onConsole: false } }) }, /not the console session/],
    [{ probe: fakeProbe({ screen: null }) }, /screen state unknown/]
  ];
  for (const [options, pattern] of cases) {
    const f = setup(t, options);
    const ready = await f.driver.readiness();
    assert.equal(ready.ready, false);
    assert.match(ready.detail, pattern);
    const result = await f.driver.deliver(f.request());
    assert.equal(result.status, "blocked");
    assert.match(result.detail, pattern);
    assert.equal(f.transports.length, 0);
  }
});

test("the permission probe is cached between checks", async (t) => {
  const f = setup(t);
  assert.equal((await f.driver.readiness()).ready, true);
  assert.equal((await f.driver.readiness()).ready, true);
  assert.equal(f.permissionChecks, 1);
});

test("only Conductor and the Codex app are ever driven", async (t) => {
  const f = setup(t);
  const result = await f.driver.deliver(f.request({ target: { ...uiTargetFor(conductorThread()), bundleId: "com.apple.Terminal" } }));
  assert.equal(result.status, "blocked");
  assert.match(result.detail, /not an app the fleet types into/);
  assert.equal(f.transports.length, 0);
});

test("an ambiguous thread identity blocks before any UI call", async (t) => {
  const f = setup(t);
  const result = await f.driver.deliver(f.request({ identity: { tokens: [], ambiguous: true, reason: "ambiguous: two threads share this title" } }));
  assert.equal(result.status, "blocked");
  assert.match(result.detail, /ambiguous/);
  assert.equal(f.transports.length, 0);
});

test("owner active elsewhere: background row click, never a deep link", async (t) => {
  const f = setup(t, { app: fakeApp({ selected: "cairo" }) });
  const result = await f.driver.deliver(f.request());
  assert.equal(result.status, "sent", result.detail);
  assert.deepEqual(f.probe.opened, []);
  const rowClick = f.calls().find((call) => call.name === "click");
  assert.deepEqual(rowClick.args, { app: "com.conductor.app", element_index: "1", click_method: "accessibility" });
});

test("owner away: the deep link opens in the background", async (t) => {
  const app = fakeApp({ selected: "cairo", onClickRow: () => {} });
  const probe = fakeProbe({ idle: 10 * 60_000, onOpen: () => { app.selected = "madrid"; } });
  const f = setup(t, { app, probe });
  const result = await f.driver.deliver(f.request());
  assert.equal(result.status, "sent", result.detail);
  assert.deepEqual(probe.opened, ["conductor://workspace?id=w-madrid&session=s1"]);
});

test("a thread that cannot be verified is blocked and nothing is typed", async (t) => {
  const f = setup(t, { app: fakeApp({ selected: "cairo", onClickRow: () => {} }) });
  const result = await f.driver.deliver(f.request());
  assert.equal(result.status, "blocked");
  assert.match(result.detail, /could not verify thread/);
  assert.deepEqual(typed(f.calls()), []);
  assert.deepEqual(f.probe.opened, []);
  // Plain transcript text naming the workspace is not proof.
  const state = parseAppState(fakeApp({ selected: "cairo", transcript: ["madrid is waiting on CI"] }).render());
  assert.equal(verifyIdentity(state, { tokens: ["madrid"] }).ok, false);
  const titled = parseAppState(fakeApp({ selected: "cairo", windowTitle: "madrid — Conductor" }).render());
  assert.equal(verifyIdentity(titled, { tokens: ["madrid"] }).ok, true);
});

// From real app states (2026-09-29): Codex titles its window "ChatGPT" and
// labels the page with the open thread; Conductor titles its window
// "Conductor" and names the open workspace and session only in the page URL.
const CODEX_STATE = [
  "App=com.openai.codex (pid 48009)",
  'Window: "ChatGPT", App: ChatGPT.',
  "0 standard window ChatGPT, Secondary Actions: Raise",
  "\t1 container (settable, string) ChatGPT",
  "\t\t2 scroll area",
  "\t\t\t3 HTML content Scope native mobile migration, URL: app://-/index.html",
  "\t\t\t\t40 button Plan interactive reports migration (5)",
  "\t\t\t\t41 static text I'll check Plan interactive reports migration (5) next."
].join("\n");
const CONDUCTOR_URL = "tauri://localhost/repository/8e9afc2d-4507-4e1c-a41f-060884800531/workspace/693f5c83-2477-4e68-8391-e65883017205?activeTabType=session&sessionId=32114e3f-5d03-4511-b7d9-38587833288e&gitPanelTab=changes&gitDiff=all";
const CONDUCTOR_STATE = [
  "App=com.conductor.app (pid 19036)",
  'Window: "Conductor", App: Conductor.',
  "0 standard window Conductor, Secondary Actions: Raise",
  "\t1 scroll area",
  `\t\t2 HTML content Tauri + React + Typescript, URL: ${CONDUCTOR_URL}`,
  "\t\t\t21 link [Add a reusable feature-onboarding framework +5.3k -60](tauri://localhost/repository/8e9afc2d-4507-4e1c-a41f-060884800531/workspace/c5a9a5e9-327d-4f1a-aa00-4598165bd180)",
  "\t\t\t111 text apia",
  "\t\t\t117 tab (selected) Close chat Canny issue prevention Nikhil Value: on"
].join("\n");
const stateOf = (text) => parseAppState({ content: [{ type: "text", text }] });

test("Codex is verified by the page label, never by sidebar or transcript text", () => {
  const state = stateOf(CODEX_STATE);
  const page = state.elements.find((element) => element.role === "html content");
  assert.equal(page.label, "Scope native mobile migration");
  assert.equal(page.fields.url, "app://-/index.html");
  assert.equal(verifyIdentity(state, { tokens: ["scope native mobile migration"] }).ok, true);
  // Named in the sidebar and the transcript, but not the open thread.
  assert.equal(verifyIdentity(state, { tokens: ["plan interactive reports migration (5)"] }).ok, false);
  // Another known thread on the page is a mismatch.
  assert.match(verifyIdentity(state, { tokens: ["fix billing"], conflicts: ["scope native mobile migration"] }).reason, /another thread is open/);
});

test("Conductor is verified by the workspace and session ids in the page URL", () => {
  assert.deepEqual(conductorIds(CONDUCTOR_URL), { workspaceId: "693f5c83-2477-4e68-8391-e65883017205", sessionId: "32114e3f-5d03-4511-b7d9-38587833288e" });
  assert.deepEqual(conductorIds("tauri://localhost/repository/r/workspace/w1"), { workspaceId: "w1", sessionId: null });
  const state = stateOf(CONDUCTOR_STATE);
  const ids = { workspaceId: "693f5c83-2477-4e68-8391-e65883017205", sessionId: "32114e3f-5d03-4511-b7d9-38587833288e" };
  // The directory name ("apia") is only plain text there, so names alone fail.
  assert.equal(verifyIdentity(state, { tokens: ["apia"] }).ok, false);
  assert.equal(verifyIdentity(state, { tokens: ["apia"], ids }).ok, true);
  assert.match(verifyIdentity(state, { tokens: [], ids: { ...ids, sessionId: "other" } }).reason, /another session is open/);
  // A sidebar link naming another workspace is not the open page.
  assert.equal(verifyIdentity(state, { tokens: [], ids: { workspaceId: "c5a9a5e9-327d-4f1a-aa00-4598165bd180", sessionId: ids.sessionId } }).ok, false);
  const noTab = stateOf(CONDUCTOR_STATE.replace(/\?activeTabType=session&sessionId=[^&]+/, "?activeTabType=file"));
  assert.match(verifyIdentity(noTab, { tokens: [], ids }).reason, /no session tab open/);
});

test("Conductor with the owner active elsewhere: clicks the in-app link to the workspace, proves it by URL", async (t) => {
  const app = fakeApp({
    workspaces: [],
    page: { label: "Tauri + React + Typescript", url: "tauri://localhost/repository/r1/workspace/w-cairo?activeTabType=session&sessionId=s9" },
    links: [
      { label: "Cairo work +1 -1", url: "tauri://localhost/repository/r1/workspace/w-cairo", session: "s9" },
      { label: "Fix billing +12 -3", url: "tauri://localhost/repository/r1/workspace/w-madrid", session: "s1" }
    ]
  });
  const f = setup(t, { app });
  const result = await f.driver.deliver(f.request());
  assert.equal(result.status, "sent", result.detail);
  assert.deepEqual(f.probe.opened, [], "owner active: no deep link");
  assert.ok(f.calls().some((call) => call.name === "click" && call.args.element_index === "71"), "clicked the madrid link");
  assert.equal(f.app.transcript.at(-1), MESSAGE);
});

test("Conductor showing another session after navigation is blocked, nothing typed", async (t) => {
  const app = fakeApp({ workspaces: [], page: { label: "x", url: "tauri://localhost/repository/r1/workspace/w-madrid?activeTabType=session&sessionId=s2" } });
  const f = setup(t, { app });
  const result = await f.driver.deliver(f.request());
  assert.equal(result.status, "blocked");
  assert.match(result.detail, /another session is open/);
  assert.deepEqual(typed(f.calls()), []);
});

test("a shared Codex title goes on only through the id link, from another open thread", async (t) => {
  const codexThread = { key: "codex:t5", kind: "codex", id: "t5", title: "Plan interactive reports migration (5)", archived: false, meta: { codexTitleShared: true } };
  const target = uiTargetFor(codexThread);
  const identity = uiIdentity(codexThread, target, [codexThread]);
  assert.equal(identity.shared, true);
  const codexApp = (label) => fakeApp({ bundleId: "com.openai.codex", windowTitle: "ChatGPT", workspaces: [], page: { label, url: "app://-/index.html" } });

  // Owner away, another thread open: the id link moves the page onto the title.
  const moved = codexApp("Scope native mobile migration");
  const away = fakeProbe({ idle: 10 * 60_000, onOpen: () => { moved.page = { ...moved.page, label: codexThread.title }; } });
  const f = setup(t, { app: moved, probe: away });
  const sent = await f.driver.deliver(f.request({ target, identity }));
  assert.equal(sent.status, "sent", sent.detail);
  assert.deepEqual(away.opened, ["codex://threads/t5"]);

  // A thread with that title already open may be the twin: blocked.
  const g = setup(t, { app: codexApp(codexThread.title), probe: fakeProbe({ idle: 10 * 60_000 }) });
  const already = await g.driver.deliver(g.request({ target, identity }));
  assert.equal(already.status, "blocked");
  assert.match(already.detail, /already open/);
  assert.deepEqual(typed(g.calls()), []);

  // Owner active: no deep link, so no way to prove it.
  const h = setup(t, { app: codexApp("Scope native mobile migration") });
  const active = await h.driver.deliver(h.request({ target, identity }));
  assert.equal(active.status, "blocked");
  assert.match(active.detail, /two threads share this title/);
});

test("a draft in the composer is never overwritten", async (t) => {
  const f = setup(t, { app: fakeApp({ composer: "half-written owner note" }) });
  const result = await f.driver.deliver(f.request());
  assert.equal(result.status, "blocked");
  assert.match(result.detail, /draft in composer/);
  assert.deepEqual(names(f.calls()), ["get_app_state"]);
  assert.equal(f.app.composer, "half-written owner note");
});

test("a running turn or a permission prompt blocks", async (t) => {
  for (const [overrides, pattern] of [[{ stop: true }, /turn running/], [{ prompt: true }, /permission prompt/]]) {
    const f = setup(t, { app: fakeApp(overrides) });
    const result = await f.driver.deliver(f.request());
    assert.equal(result.status, "blocked");
    assert.match(result.detail, pattern);
    assert.deepEqual(typed(f.calls()), []);
  }
});

test("a text mismatch clears our text and never sends", async (t) => {
  const app = fakeApp({ onType: (text) => text.replace("lint.", "lint…") });
  const f = setup(t, { app });
  const result = await f.driver.deliver(f.request());
  assert.equal(result.status, "failed");
  assert.match(result.detail, /text mismatch, not sent; cleared our text/);
  const keys = f.calls().filter((call) => call.name === "press_key").map((call) => call.args.key);
  assert.deepEqual(keys, ["super+a", "BackSpace"]);
  assert.equal(f.calls().filter((call) => call.name === "click" && call.args.element_index === "62").length, 0, "Send never clicked");
  assert.equal(app.composer, "");
  assert.equal(app.transcript.includes(MESSAGE), false);
});

test("a thread change before send blocks without clearing another thread's composer", async (t) => {
  const app = fakeApp();
  app.onType = (text) => { app.selected = "cairo"; return text; };
  const f = setup(t, { app });
  const result = await f.driver.deliver(f.request());
  assert.equal(result.status, "blocked");
  assert.match(result.detail, /thread changed before send/);
  assert.equal(f.calls().filter((call) => call.name === "press_key").length, 0);
  assert.equal(f.calls().filter((call) => call.name === "click" && call.args.element_index === "62").length, 0);
});

test("the owner coming back before send clears our text and blocks", async (t) => {
  const probe = fakeProbe();
  const app = fakeApp();
  app.onType = (text) => { probe.front = "com.conductor.app"; probe.idle = 200; return text; };
  const f = setup(t, { app, probe });
  const result = await f.driver.deliver(f.request());
  assert.equal(result.status, "blocked");
  assert.match(result.detail, /owner using Conductor; cleared our text/);
  assert.equal(app.composer, "");
  assert.equal(app.transcript.includes(MESSAGE), false);
});

test("a send that never shows in the transcript is failed and unconfirmed", async (t) => {
  const app = fakeApp({ onSend: () => {} });
  const f = setup(t, { app });
  const result = await f.driver.deliver(f.request());
  assert.equal(result.status, "failed");
  assert.equal(result.unconfirmed, true);
  assert.match(result.detail, /unconfirmed: may have been sent; check the thread/);
});

test("an earlier identical message in the transcript does not confirm a new send", async (t) => {
  const app = fakeApp({ transcript: [MESSAGE], onSend: () => { app.composer = ""; } });
  const f = setup(t, { app });
  const result = await f.driver.deliver(f.request());
  assert.equal(result.status, "failed");
  assert.equal(result.unconfirmed, true);
});

test("a retry after an unconfirmed send that did land is not sent twice", async (t) => {
  const f = setup(t, { app: fakeApp({ transcript: ["older", MESSAGE] }) });
  const result = await f.driver.deliver(f.request({ previousUnconfirmed: { priorCount: 0 } }));
  assert.equal(result.status, "sent");
  assert.match(result.detail, /already in thread/);
  assert.deepEqual(typed(f.calls()), []);
});

test("an unconfirmed send reports the copies seen before it; a retry needs a new copy", async (t) => {
  const first = fakeApp({ transcript: [MESSAGE], onSend: () => { first.composer = ""; } });
  const f = setup(t, { app: first });
  const unsure = await f.driver.deliver(f.request());
  assert.equal(unsure.unconfirmed, true);
  assert.equal(unsure.priorCount, 1);
  // The older copy alone does not prove the uncertain attempt landed.
  const g = setup(t, { app: fakeApp({ transcript: [MESSAGE] }) });
  const retried = await g.driver.deliver(g.request({ previousUnconfirmed: { priorCount: 1 } }));
  assert.equal(retried.status, "sent", retried.detail);
  assert.doesNotMatch(retried.detail, /already in thread/);
  assert.equal(typed(g.calls()).length, 1);
  // Fewer copies than before: the transcript is not all visible, so wait.
  const h = setup(t, { app: fakeApp({ transcript: ["older"] }) });
  const unsureAgain = await h.driver.deliver(h.request({ previousUnconfirmed: { priorCount: 1 } }));
  assert.equal(unsureAgain.status, "blocked");
  assert.deepEqual(typed(h.calls()), []);
});

test("without a Send button, Return in the focused composer sends", async (t) => {
  const f = setup(t, { app: fakeApp({ sendButton: false }) });
  const result = await f.driver.deliver(f.request());
  assert.equal(result.status, "sent", result.detail);
  assert.deepEqual(f.calls().filter((call) => call.name === "press_key").map((call) => call.args.key), ["Return"]);
});

test("a transport failure before typing fails closed and closes the transport", async (t) => {
  const f = setup(t, { transportOptions: { failOn: (name) => name === "get_app_state" } });
  const result = await f.driver.deliver(f.request());
  assert.equal(result.status, "failed");
  assert.match(result.detail, /nothing typed/);
  assert.equal(f.transports[0].closed, 1);
  assert.deepEqual(typed(f.calls()), []);
});

test("a transport failure after typing clears our text with a fresh engine", async (t) => {
  const app = fakeApp();
  const f = setup(t, { app, transportOptions: { failOn: (name, _args, n) => name === "get_app_state" && n === 5 } });
  const result = await f.driver.deliver(f.request());
  assert.equal(result.status, "failed");
  assert.match(result.detail, /not sent; cleared our text/);
  assert.equal(f.transports.length, 2);
  assert.ok(f.transports.every((transport) => transport.closed >= 1));
  assert.equal(app.composer, "");
});

test("a transport failure after send is unconfirmed", async (t) => {
  const f = setup(t, { transportOptions: { failOn: (name, args) => name === "click" && args.element_index === "62" } });
  const app = f.app;
  app.onSend = () => {};
  const result = await f.driver.deliver(f.request());
  // The click threw and the composer still held our text, so Return was pressed.
  assert.equal(result.status, "failed");
  assert.equal(result.unconfirmed, true);
  assert.deepEqual(f.calls().filter((call) => call.name === "press_key").map((call) => call.args.key), ["Return"]);
});

test("the composer must be the only text area, and focus must land in it", async (t) => {
  const two = parseAppState({ content: [{ type: "text", text: 'App=com.openai.codex (pid 9)\nWindow: "Codex", App: Codex.\n0 standard window Codex\n  1 text entry area (settable, string)\n  2 text entry area (settable, string)\n' }] });
  assert.match(findComposer(two).reason, /composer ambiguous/);
  const labelled = parseAppState({ content: [{ type: "text", text: 'App=com.openai.codex (pid 9)\n0 standard window Codex\n  1 search text field (settable, string) Search\n  2 text entry area (settable, string) Placeholder: Ask Codex anything\n  3 text entry area (settable, string) Notes\n' }] });
  assert.equal(findComposer(labelled).composer.id, "2");
  const f = setup(t, { app: fakeApp() });
  f.app.render = ((render) => () => { const out = render(); out.content[0].text = out.content[0].text.replace(/The focused UI element is 61[^\n]*\n?/, ""); return out; })(f.app.render);
  const result = await f.driver.deliver(f.request());
  assert.equal(result.status, "failed");
  assert.match(result.detail, /could not focus the composer; nothing typed/);
  assert.deepEqual(typed(f.calls()), []);
});

test("parseAppState reads header, window, elements, fields, and focus", () => {
  const state = parseAppState(fakeApp({ composer: "hi there", focused: "61", heading: "madrid" }).render());
  assert.equal(state.bundleId, "com.conductor.app");
  assert.equal(state.pid, 42);
  assert.equal(state.windowTitle, "Conductor");
  assert.equal(state.focusedId, "61");
  const composer = state.elements.find((element) => element.id === "61");
  assert.equal(composer.role, "text entry area");
  assert.deepEqual(composer.flags, ["settable", "string"]);
  assert.equal(composer.value, "hi there");
  assert.equal(composer.parent.id, "60");
  const row = state.elements.find((element) => element.id === "1");
  assert.equal(row.role, "row");
  assert.equal(row.selected, true);
  assert.equal(row.label, "madrid");
  assert.ok(state.image);
});

test("looksLikeOurs only matches the text this delivery typed", () => {
  assert.equal(looksLikeOurs(MESSAGE, MESSAGE), true);
  assert.equal(looksLikeOurs(MESSAGE.slice(0, 30), MESSAGE), true);
  assert.equal(looksLikeOurs(`${MESSAGE.slice(0, 40)}…`, MESSAGE), true);
  assert.equal(looksLikeOurs("owner's own draft", MESSAGE), false);
  assert.equal(looksLikeOurs("[Open", MESSAGE), false);
  assert.equal(looksLikeOurs("", MESSAGE), false);
});

test("uiIdentity asks for the workspace, the session title when needed, and refuses shared names", () => {
  const madrid = conductorThread();
  const target = uiTargetFor(madrid);
  const one = uiIdentity(madrid, target, [madrid]);
  assert.deepEqual(one.tokens, ["madrid"]);
  const tabMeta = (id, title, extra = {}) => ({ conductorWorkspaceId: "w-madrid", conductorSessionId: id, conductorSessionTitle: title, conductorWorkspaceSessions: 2, ...extra });
  // A second tab the fleet knows about, or a tab count above one from the
  // database: the tab title must be shown too.
  const sibling = conductorThread({ key: "conductor:s2", id: "s2", title: "Review nits", meta: tabMeta("s2", "Review nits") });
  const withSibling = uiIdentity(madrid, target, [madrid, sibling]);
  assert.deepEqual(withSibling.tokens, ["madrid", "fix billing"]);
  assert.ok(withSibling.conflicts.includes("review nits"), "the sibling tab being open is a mismatch");
  const twoTabs = conductorThread({ meta: tabMeta("s1", "Fix billing") });
  assert.deepEqual(uiIdentity(twoTabs, uiTargetFor(twoTabs), [twoTabs]).tokens, ["madrid", "fix billing"]);
  // Tab count unknown (older rows): the title is required as well.
  const unknownCount = conductorThread({ meta: { conductorWorkspaceId: "w-madrid", conductorSessionId: "s1", conductorSessionTitle: "Fix billing" } });
  assert.deepEqual(uiIdentity(unknownCount, uiTargetFor(unknownCount), [unknownCount]).tokens, ["madrid", "fix billing"]);
  // Shared or missing titles cannot tell tabs apart by name: those give no
  // name tokens, and only the page URL's ids can prove the session.
  const byIdOnly = (identity) => {
    assert.equal(identity.ambiguous, false);
    assert.deepEqual(identity.tokens, []);
    assert.equal(identity.ids.workspaceId, "w-madrid");
  };
  const twin = conductorThread({ key: "conductor:s2", id: "s2", meta: tabMeta("s2", "Fix billing") });
  byIdOnly(uiIdentity(madrid, target, [madrid, twin]));
  const shared = conductorThread({ meta: tabMeta("s1", "Fix billing", { conductorTitleShared: true }) });
  byIdOnly(uiIdentity(shared, uiTargetFor(shared), [shared]));
  const untitled = conductorThread({ title: "madrid", meta: tabMeta("s1", null) });
  byIdOnly(uiIdentity(untitled, uiTargetFor(untitled), [untitled]));
  const otherRepo = conductorThread({ key: "conductor:s9", id: "s9", meta: { conductorWorkspaceId: "w-other", conductorSessionId: "s9", conductorWorkspaceSessions: 1 } });
  byIdOnly(uiIdentity(madrid, target, [madrid, otherRepo]));
  const cairo = conductorThread({ key: "conductor:s5", id: "s5", workspace: "cairo", meta: { conductorWorkspaceId: "w-cairo", conductorSessionId: "s5", conductorWorkspaceSessions: 1 } });
  assert.deepEqual(uiIdentity(madrid, target, [madrid, cairo]).conflicts, ["cairo"]);

  const codex = { key: "codex:t1", kind: "codex", id: "t1", title: "Fix the upload retry bug", meta: {} };
  const codexTarget = uiTargetFor(codex);
  assert.deepEqual(uiIdentity(codex, codexTarget, [codex]).tokens, ["fix the upload retry bug"]);
  const same = { ...codex, key: "codex:t2", id: "t2" };
  assert.equal(uiIdentity(codex, codexTarget, [codex, same]).ambiguous, true);
  const generic = { ...codex, title: "Codex 1234abcd" };
  assert.deepEqual(uiIdentity(generic, uiTargetFor(generic), [generic]).tokens, []);
});

test("verifyIdentity: selected rows and exact headings prove the thread; another open thread is a mismatch", () => {
  const madridShown = parseAppState(fakeApp().render());
  assert.equal(verifyIdentity(madridShown, { tokens: ["madrid"], conflicts: ["cairo"] }).ok, true);
  const cairoShown = parseAppState(fakeApp({ selected: "cairo", heading: "madrid" }).render());
  // The heading alone would pass, but the selected row is another workspace.
  assert.equal(verifyIdentity(cairoShown, { tokens: ["madrid"] }).ok, true);
  const conflict = verifyIdentity(cairoShown, { tokens: ["madrid"], conflicts: ["cairo"] });
  assert.equal(conflict.ok, false);
  assert.match(conflict.reason, /another thread is open/);
  // A heading must be exactly the token, not merely mention it.
  const mention = parseAppState(fakeApp({ selected: "cairo", heading: "madrid is blocked on CI" }).render());
  assert.equal(verifyIdentity(mention, { tokens: ["madrid"] }).ok, false);
  assert.equal(verifyIdentity(null, { tokens: ["madrid"] }).ok, false);
  assert.equal(verifyIdentity(madridShown, { tokens: [] }).ok, false);
});

test("presence probes parse lsappinfo and ioreg output", async () => {
  assert.equal(parseFrontAsn("ASN:0x0-0x16016:\n"), "ASN:0x0-0x16016:");
  assert.equal(parseBundleIdLine('[ NULL ]  ASN:0x0-0x16016: (in front) \n    bundleID="com.google.Chrome"\n'), "com.google.Chrome");
  assert.equal(parseIdleMs('  |   "HIDIdleTime" = 659028416\n'), 659);
  assert.equal(parseIdleMs("nothing"), null);
  const unlocked = '"IOConsoleLocked" = No\n"IOConsoleUsers" = ({"kCGSSessionOnConsoleKey"=Yes,"kCGSSessionUserNameKey"="shooby"})';
  assert.deepEqual(parseConsoleSession(unlocked), { locked: false, secureInput: false, onConsole: true });
  const locked = '"IOConsoleUsers" = ({"CGSSessionScreenIsLocked"=Yes,"kCGSSessionOnConsoleKey"=Yes,"kCGSSessionSecureInputPID"=812})';
  assert.deepEqual(parseConsoleSession(locked), { locked: true, secureInput: true, onConsole: true });
  assert.equal(parseConsoleSession(""), null);

  const calls = [];
  const outputs = {
    front: "ASN:0x0-0x86b86b:\n",
    info: '    bundleID="com.conductor.app"\n',
    find: 'ASN:0x0-0x86b86b-"Conductor":\n',
    idle: '"HIDIdleTime" = 150000000000\n',
    root: unlocked,
    open: ""
  };
  const run = async (cmd, args) => {
    calls.push([cmd, ...args]);
    const key = cmd === "/usr/bin/open" ? "open" : args[0] === "front" ? "front" : args[0] === "info" ? "info" : args[0] === "find" ? "find" : args.includes("IOHIDSystem") ? "idle" : "root";
    return { code: 0, stdout: outputs[key], stderr: "", timedOut: false, error: null };
  };
  const probe = createPresenceProbe({ bins: { lsappinfo: "/usr/bin/lsappinfo", ioreg: "/usr/sbin/ioreg", open: "/usr/bin/open" }, run });
  assert.equal(await probe.frontApp(), "com.conductor.app");
  assert.equal(await probe.appRunning("com.conductor.app"), true);
  assert.equal(await probe.idleMs(), 150_000);
  assert.deepEqual(await probe.session(), { locked: false, secureInput: false, onConsole: true });
  assert.equal(await probe.openUrl("codex://threads/t1"), true);
  assert.deepEqual(calls.at(-1), ["/usr/bin/open", "-g", "codex://threads/t1"]);
  assert.deepEqual(calls[1], ["/usr/bin/lsappinfo", "info", "-only", "bundleID", "ASN:0x0-0x86b86b:"]);
  const failing = createPresenceProbe({ bins: {}, run: async () => ({ code: 1, stdout: "", stderr: "x", timedOut: false, error: null }) });
  assert.equal(await failing.appRunning("com.conductor.app"), null);
  assert.equal(await failing.frontApp(), null);
});

test("the UI lock runs one delivery at a time and reports busy after the wait", async () => {
  const lock = createUiLock();
  const order = [];
  let releaseFirst;
  const first = lock.run(() => new Promise((resolve) => { order.push("first:start"); releaseFirst = () => { order.push("first:end"); resolve(1); }; }));
  const second = lock.run(async () => { order.push("second"); return 2; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["first:start"]);
  assert.equal(lock.busy, true);
  const impatient = await lock.run(async () => { order.push("never"); }, { waitMs: 5 });
  assert.deepEqual(impatient, { busy: true });
  releaseFirst();
  assert.deepEqual(await first, { busy: false, value: 1 });
  assert.deepEqual(await second, { busy: false, value: 2 });
  assert.deepEqual(order, ["first:start", "first:end", "second"]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(lock.busy, false);
});

test("Codex: owner away opens codex://threads/<id> with no prefill, then verifies by title", async (t) => {
  const app = fakeApp({ bundleId: "com.openai.codex", workspaces: [], selected: null, windowTitle: "Codex" });
  const probe = fakeProbe({ idle: 10 * 60_000, onOpen: () => { app.windowTitle = "Fix the upload retry bug"; } });
  const f = setup(t, { app, probe });
  const thread = { key: "codex:t1", kind: "codex", id: "0199-abc", title: "Fix the upload retry bug", meta: { originator: "Codex Desktop" } };
  const target = uiTargetFor(thread);
  const result = await f.driver.deliver({ text: MESSAGE, target, identity: uiIdentity(thread, target, [thread]), evidenceName: "fa_codex" });
  assert.equal(result.status, "sent", result.detail);
  assert.match(result.detail, /typed into Codex/);
  assert.deepEqual(probe.opened, ["codex://threads/0199-abc"]);
  assert.ok(f.calls().every((call) => call.args.app === "com.openai.codex"), "only the target bundle id is driven");
});

test("the frontmost app changing while the owner is active aborts before typing", async (t) => {
  const probe = fakeProbe();
  const app = fakeApp({ selected: "cairo", onClickRow: (name) => { app.selected = name; probe.front = "com.apple.Terminal"; } });
  const f = setup(t, { app, probe });
  const result = await f.driver.deliver(f.request());
  assert.equal(result.status, "blocked");
  assert.match(result.detail, /frontmost app changed/);
  assert.deepEqual(typed(f.calls()), []);
});

test("navigation never clicks a link, and never guesses between two matches", async (t) => {
  const app = fakeApp({ selected: "cairo" });
  const render = app.render;
  app.render = () => {
    const out = render();
    out.content[0].text = out.content[0].text.replace("  1 row madrid", "  1 link madrid");
    return out;
  };
  const f = setup(t, { app });
  const result = await f.driver.deliver(f.request());
  assert.equal(result.status, "blocked");
  assert.equal(f.calls().filter((call) => call.name === "click").length, 0);

  const twice = fakeApp({ selected: "cairo", workspaces: ["madrid", "cairo", "madrid"] });
  const g = setup(t, { app: twice });
  assert.equal((await g.driver.deliver(g.request())).status, "blocked");
  assert.equal(g.calls().filter((call) => call.name === "click").length, 0);
});

test("focus falls back to one event posted to the app when accessibility did not focus", async (t) => {
  const app = fakeApp();
  const f = setup(t, { app });
  // Accessibility press on the composer does nothing; app_post focuses it.
  const driver = createUiDriver({
    config: { bins: { ocu: "/fake/OpenComputerUse" }, limits: { ...DEFAULTS } },
    probe: f.probe,
    transportFactory: () => {
      const inner = fakeTransport(app);
      const wrapped = {
        calls: inner.calls,
        closed: 0,
        async call(name, args) {
          if (name === "click" && args.element_index === "61" && args.click_method === "accessibility") { inner.calls.push({ name, args: { ...args } }); return { isError: false, content: [] }; }
          return inner.call(name, args);
        },
        close() { wrapped.closed += 1; }
      };
      f.transports.push(wrapped);
      return wrapped;
    },
    permissionProbe: async () => ({ accessibility: true, screenRecording: true }),
    binaryReady: () => true,
    computerUseEnabled: () => true,
    sleep: async () => {}
  });
  const result = await driver.deliver(f.request());
  assert.equal(result.status, "sent", result.detail);
  const focusClicks = f.calls().filter((call) => call.name === "click" && call.args.element_index === "61").map((call) => call.args.click_method);
  assert.deepEqual(focusClicks, ["accessibility", "app_post"]);
});

test("the transport is closed even when the UI never answers in time", async (t) => {
  const app = fakeApp();
  const hung = [];
  const f = setup(t, {
    app,
    driverOptions: {
      config: { bins: { ocu: "/fake/OpenComputerUse" }, limits: { ...DEFAULTS, uiDeliveryTimeoutMs: 20, uiStepTimeoutMs: 20 } },
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5))),
      now: Date.now,
      transportFactory: () => {
        const transport = {
          calls: [],
          closed: 0,
          call: (name, args, signal) => new Promise((resolve, reject) => {
            transport.calls.push({ name, args });
            hung.push(name);
            signal?.addEventListener("abort", () => reject(new Error("Open Computer Use stopped, timed out, or disconnected; delivery is unconfirmed.")), { once: true });
          }),
          close() { transport.closed += 1; }
        };
        f.transports.push(transport);
        return transport;
      }
    }
  });
  const result = await f.driver.deliver(f.request());
  assert.equal(result.status, "failed");
  assert.match(result.detail, /timed out; nothing typed/);
  assert.equal(f.transports[0].closed, 1);
  assert.deepEqual(hung, ["get_app_state"]);
});

test("exactly our message left unsent in the composer is sent as is, never retyped or counted as sent", async (t) => {
  const f = setup(t, { app: fakeApp({ composer: MESSAGE }) });
  const result = await f.driver.deliver(f.request({ previousUnconfirmed: true }));
  assert.equal(result.status, "sent", result.detail);
  assert.match(result.detail, /earlier attempt left/);
  assert.deepEqual(typed(f.calls()), [], "nothing typed on top of it");
  assert.equal(f.app.transcript.at(-1), MESSAGE);
  assert.equal(f.app.composer, "");
  // Anything else in the composer is the owner's draft.
  const g = setup(t, { app: fakeApp({ composer: `${MESSAGE} plus the owner's edit` }) });
  const kept = await g.driver.deliver(g.request({ previousUnconfirmed: true }));
  assert.equal(kept.status, "blocked");
  assert.match(kept.detail, /draft in composer/);
});

test("the read-only probe script reports what a delivery would see", async () => {
  const { probeText } = await import("../scripts/fleet-ui-probe.mjs");
  const text = fakeApp({ composer: "draft", stop: true }).render().content[0].text;
  const report = probeText(text, ["madrid", "cairo"]);
  assert.equal(report.app, "com.conductor.app");
  assert.equal(report.window, "Conductor");
  assert.deepEqual(report.selected, ['1 row "madrid"']);
  assert.equal(report.composer.element, "61 text entry area");
  assert.equal(report.composer.empty, false);
  assert.equal(report.send, '62 button "Send"');
  assert.equal(report.stopVisible, true);
  assert.equal(report.identity.ok, false);
  assert.match(report.identity.reason, /cairo/);
});
