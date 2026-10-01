import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULTS, uiTargetFor } from "../src/fleet/contracts.js";
import {
  createInputLatch, createPresenceProbe, createUiDriver, createUiLock, findComposer, findSendButton, flattenMessage, looksLikeOurs, parseAppState, parseBundleIdLine,
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
    // OCU prints focus and types only for the frontmost app; setup() ties
    // this to the fake presence probe.
    frontmost: true,
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
    if (app.focused && app.frontmost) lines.push(`The focused UI element is ${app.focused} text entry area.`);
    return { isError: false, content: [{ type: "text", text: `${lines.join("\n")}\n` }, { type: "image", mimeType: "image/png", data: PNG }] };
  };
  return app;
}

// latency: (name, args) => ms a call takes; a call slower than its timeout
// fails like OCU's through the app agent (input marked inFlight: it may
// still land, until its late answer, late[i]({ completed: true })), else the
// clock moves on by that much.
function fakeTransport(app, { failOn = null, latency = null, advance = null } = {}) {
  const transport = {
    calls: [],
    closed: 0,
    late: [],
    async call(name, args, _signal, options = {}) {
      transport.calls.push({ name, args: { ...args }, options });
      if (failOn && failOn(name, args, transport.calls.length)) throw new Error("Open Computer Use stopped, timed out, or disconnected; delivery is unconfirmed.");
      const cost = latency?.(name, args) ?? 0;
      const limit = options.timeoutMs ?? transport.options?.timeoutMs ?? Infinity;
      if (cost > limit) {
        throw Object.assign(new Error(`Open Computer Use timed out after ${Math.round(limit / 1000)}s on ${name}`),
          name === "get_app_state" ? {} : { inFlight: true, settled: new Promise((resolve) => transport.late.push(resolve)) });
      }
      advance?.(cost);
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
        if (!app.frontmost || app.focused !== "61") throw new Error("type_text requires a focused editable text element");
        app.composer += app.onType ? app.onType(args.text) : args.text;
        return { isError: false, content: [] };
      }
      if (name === "press_key") {
        app.onKey?.(args.key);
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
    idle: 10 * 60_000,
    running: true,
    screen: { locked: false, secureInput: false, onConsole: true },
    opened: [],
    activated: [],
    onOpen: null,
    async frontApp() { return probe.front; },
    async appRunning() { return probe.running; },
    async idleMs() { return probe.idle; },
    async session() { return probe.screen; },
    async openUrl(url) { probe.opened.push(url); probe.onOpen?.(url); return true; },
    async activate(bundleId) { probe.activated.push(bundleId); probe.front = bundleId; return true; },
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
  Object.defineProperty(app, "frontmost", { get: () => probe.front === app.bundleId, configurable: true });
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
    inputLatch: createInputLatch(),
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    ...driverOptions
  });
  const thread = conductorThread();
  const target = uiTargetFor(thread);
  const request = (extra = {}) => ({ text: MESSAGE, target, identity: uiIdentity(thread, target, [thread]), evidenceName: "fa_test", ...extra });
  const calls = () => transports.flatMap((transport) => transport.calls);
  return { app, probe, driver, transports, calls, request, dir, now: () => clock, advance: (ms) => { clock += ms; }, get permissionChecks() { return permissionChecks; } };
}

const names = (calls) => calls.map((call) => call.name);
const typed = (calls) => calls.filter((call) => call.name === "type_text").map((call) => call.args.text);

test("happy path: verify, bring forward, focus, type one line, check, send, confirm, put the owner's app back", async (t) => {
  const f = setup(t);
  const result = await f.driver.deliver(f.request());
  assert.equal(result.status, "sent", result.detail);
  assert.match(result.detail, /typed into Conductor/);
  assert.deepEqual(names(f.calls()), ["get_app_state", "get_app_state", "click", "get_app_state", "type_text", "get_app_state", "click", "get_app_state"]);
  const [read, , focus, , , , send] = f.calls();
  assert.equal(read.args.max_tree_nodes, 3000);
  assert.deepEqual(f.probe.activated, ["com.conductor.app", "com.google.Chrome"], "brought forward, then the owner's app restored");
  assert.equal(f.probe.front, "com.google.Chrome");
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

test("owner active in another app: waits for idle, nothing opened, clicked, or brought forward", async (t) => {
  const f = setup(t, { app: fakeApp({ selected: "cairo" }), probe: fakeProbe({ idle: 1_000 }) });
  const result = await f.driver.deliver(f.request());
  assert.equal(result.status, "blocked");
  assert.equal(result.detail, "waiting for idle: Conductor must be in front to type");
  assert.equal(f.transports.length, 0);
  assert.deepEqual(f.probe.opened, []);
  assert.deepEqual(f.probe.activated, []);
});

test("owner away: the deep link opens in the background, then the app comes forward for the send", async (t) => {
  const app = fakeApp({ selected: "cairo", onClickRow: () => {} });
  const probe = fakeProbe({ idle: 10 * 60_000, onOpen: () => { app.selected = "madrid"; } });
  const f = setup(t, { app, probe });
  const result = await f.driver.deliver(f.request());
  assert.equal(result.status, "sent", result.detail);
  assert.deepEqual(probe.opened, ["conductor://workspace?id=w-madrid&session=s1"]);
  assert.deepEqual(probe.activated, ["com.conductor.app", "com.google.Chrome"]);
  assert.equal(f.calls().filter((call) => call.name === "click" && call.args.element_index === "1").length, 0, "no sidebar clicks");
});

test("the screen saver in front blocks before any UI call", async (t) => {
  for (const front of ["com.apple.ScreenSaver.Engine", "com.apple.loginwindow"]) {
    const f = setup(t, { probe: fakeProbe({ front }) });
    const result = await f.driver.deliver(f.request());
    assert.equal(result.status, "blocked");
    assert.equal(result.detail, "screen saver on");
    assert.equal(f.transports.length, 0);
    assert.deepEqual(f.probe.activated, []);
  }
});

test("an unknown front app blocks: it could hide the screen saver, and nothing could be put back", async (t) => {
  const f = setup(t, { probe: fakeProbe({ front: null }) });
  const result = await f.driver.deliver(f.request());
  assert.equal(result.status, "blocked");
  assert.equal(result.detail, "front app unknown");
  assert.equal(f.transports.length, 0);
  assert.deepEqual(f.probe.opened, []);
  assert.deepEqual(f.probe.activated, []);
});

test("the owner's app is not put back if they return while the running check is slow", async (t) => {
  const app = fakeApp({ selected: "cairo", onClickRow: () => {} });
  const probe = fakeProbe({ onOpen: () => { app.selected = "madrid"; } });
  const running = probe.appRunning;
  // Checking that Chrome still runs takes long enough for the owner to come
  // back and click into Slack.
  probe.appRunning = async (bundleId) => {
    if (bundleId === "com.google.Chrome") { probe.front = "com.tinyspeck.slackmacgap"; probe.idle = 500; }
    return running(bundleId);
  };
  const f = setup(t, { app, probe });
  const result = await f.driver.deliver(f.request());
  assert.equal(result.status, "sent", result.detail);
  assert.deepEqual(probe.activated, ["com.conductor.app"], "Chrome is not pulled over the owner");
});

test("a slow presence check after the send: the owner's app is not switched in on stale readings", async (t) => {
  const app = fakeApp({ selected: "cairo", onClickRow: () => {} });
  const probe = fakeProbe({ onOpen: () => { app.selected = "madrid"; } });
  const idle = probe.idleMs;
  const f = setup(t, { app, probe });
  probe.idleMs = async () => { if (app.transcript.includes(MESSAGE)) f.advance(4_000); return idle(); };
  const result = await f.driver.deliver(f.request());
  assert.equal(result.status, "sent", result.detail);
  assert.deepEqual(probe.activated, ["com.conductor.app"], "Chrome is not switched in");
});

test("an unknown front app after the fleet brought its app forward still puts the owner's app back", async (t) => {
  const app = fakeApp({ selected: "cairo", onClickRow: () => {} });
  const probe = fakeProbe({ onOpen: () => { app.selected = "madrid"; } });
  // One lsappinfo hiccup at the owner check after the activation settled.
  let reads = null;
  const activate = probe.activate;
  probe.activate = async (bundleId) => { if (bundleId === app.bundleId) reads = 0; return activate(bundleId); };
  probe.frontApp = async () => {
    if (reads !== null && ++reads === 2) return null;
    return probe.front;
  };
  const f = setup(t, { app, probe });
  const result = await f.driver.deliver(f.request());
  assert.equal(result.status, "blocked");
  assert.equal(result.detail, "front app unknown");
  assert.deepEqual(typed(f.calls()), []);
  assert.deepEqual(probe.activated, ["com.conductor.app", "com.google.Chrome"]);
});

test("the front app turning unknown during a slow read: nothing opened or brought forward", async (t) => {
  const app = fakeApp({ selected: "cairo", onClickRow: () => {} });
  const f = setup(t, { app, probe: fakeProbe({ onOpen: () => { app.selected = "madrid"; } }) });
  const render = app.render;
  app.render = () => { f.probe.front = null; return render(); };
  const result = await f.driver.deliver(f.request());
  assert.equal(result.status, "blocked");
  assert.equal(result.detail, "front app unknown");
  assert.deepEqual(f.probe.opened, []);
  assert.deepEqual(f.probe.activated, []);
  assert.deepEqual(typed(f.calls()), []);
});

test("an app that will not come forward blocks before typing", async (t) => {
  const probe = fakeProbe({ activate: async (bundleId) => { probe.activated.push(bundleId); return true; } });
  const f = setup(t, { probe });
  const result = await f.driver.deliver(f.request());
  assert.equal(result.status, "blocked");
  assert.equal(result.detail, "could not bring Conductor to the front");
  assert.deepEqual(typed(f.calls()), []);
  assert.deepEqual(probe.activated, ["com.conductor.app"], "nothing to restore: the owner's app never left the front");
});

test("keyboard-fallback typing is input like any other: no send until real idle, then the draft goes as is", async (t) => {
  // HIDIdleTime restarts at every event posted, the fleet's included: it
  // cannot be told apart from the owner's, so it counts as theirs.
  let hidAt = null;
  const probe = fakeProbe();
  const app = fakeApp();
  const f = setup(t, { app, probe });
  probe.idleMs = async () => (hidAt === null ? 10 * 60_000 : f.now() - hidAt);
  app.onType = (text) => { hidAt = f.now(); f.advance(3_000); return text; };
  const result = await f.driver.deliver(f.request());
  assert.equal(result.status, "blocked");
  assert.equal(result.detail, "owner using Conductor; our text is left as a draft, check it");
  assert.equal(app.composer, MESSAGE);
  // Once the input is old enough, the retry sends exactly that draft, untyped.
  f.advance(DEFAULTS.uiOwnerIdleMs);
  const retry = await f.driver.deliver(f.request());
  assert.equal(retry.status, "sent", retry.detail);
  assert.match(retry.detail, /sent the text an earlier attempt left/);
});

test("a thread that cannot be verified is blocked and nothing is typed", async (t) => {
  const f = setup(t, { app: fakeApp({ selected: "cairo", onClickRow: () => {} }) });
  const result = await f.driver.deliver(f.request());
  assert.equal(result.status, "blocked");
  assert.match(result.detail, /could not verify thread/);
  assert.deepEqual(typed(f.calls()), []);
  assert.equal(f.probe.opened.length, 1, "the deep link was tried");
  assert.deepEqual(f.probe.activated, [], "never brought forward");
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

test("Conductor: the deep link moves the page, proven by the URL, never a sidebar click", async (t) => {
  const app = fakeApp({
    workspaces: [],
    page: { label: "Tauri + React + Typescript", url: "tauri://localhost/repository/r1/workspace/w-cairo?activeTabType=session&sessionId=s9" },
    links: [
      { label: "Cairo work +1 -1", url: "tauri://localhost/repository/r1/workspace/w-cairo", session: "s9" },
      { label: "Fix billing +12 -3", url: "tauri://localhost/repository/r1/workspace/w-madrid", session: "s1" }
    ]
  });
  const probe = fakeProbe({ onOpen: () => { app.page = { ...app.page, url: "tauri://localhost/repository/r1/workspace/w-madrid?activeTabType=session&sessionId=s1" }; } });
  const f = setup(t, { app, probe });
  const result = await f.driver.deliver(f.request());
  assert.equal(result.status, "sent", result.detail);
  assert.deepEqual(f.probe.opened, ["conductor://workspace?id=w-madrid&session=s1"]);
  assert.equal(f.calls().filter((call) => call.name === "click" && Number(call.args.element_index) >= 70 && Number(call.args.element_index) < 80).length, 0);
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

  // Owner active: nothing happens until they are away.
  const h = setup(t, { app: codexApp("Scope native mobile migration"), probe: fakeProbe({ idle: 1_000 }) });
  const active = await h.driver.deliver(h.request({ target, identity }));
  assert.equal(active.status, "blocked");
  assert.match(active.detail, /^waiting for idle: Codex must be in front/);
  assert.equal(h.transports.length, 0);
});

test("a draft in the composer is never overwritten", async (t) => {
  const f = setup(t, { app: fakeApp({ composer: "half-written owner note" }) });
  const result = await f.driver.deliver(f.request());
  assert.equal(result.status, "blocked");
  assert.match(result.detail, /draft in composer/);
  assert.deepEqual(names(f.calls()), ["get_app_state", "get_app_state"]);
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

// The app's smart punctuation turns what was typed into a different string.
const SMART_TEXT = "[OpenAGI supervisor] Don't merge yet... CI red: lint. Fix it and report the new head.";
const smartly = (text) => text.replace("'", "\u2019").replace("...", "\u2026");

test("a text mismatch never sends, and nothing typed is ever erased", async (t) => {
  const app = fakeApp({ onType: smartly });
  const f = setup(t, { app });
  const result = await f.driver.deliver(f.request({ text: SMART_TEXT }));
  assert.equal(result.status, "failed");
  assert.equal(result.detail, "text mismatch, not sent; our text is left as a draft, check it");
  assert.equal(app.composer, smartly(SMART_TEXT));
  assert.equal(f.calls().filter((call) => call.name === "press_key").length, 0, "no select-all, no delete");
  assert.equal(f.calls().filter((call) => call.name === "click" && call.args.element_index === "62").length, 0, "Send never clicked");
  assert.equal(app.transcript.includes(MESSAGE), false);
});

test("any other change to our text is left alone: it may be the owner's", async (t) => {
  // Shorter than ours and still starting like ours: an owner's edit.
  const app = fakeApp({ onType: (text) => text.replace("lint. Fix it, push, and report the new head.", "lint. Wait.") });
  const f = setup(t, { app });
  const result = await f.driver.deliver(f.request());
  assert.equal(result.status, "failed");
  assert.match(result.detail, /text mismatch, not sent; our text is left as a draft, check it/);
  assert.equal(f.calls().filter((call) => call.name === "press_key").length, 0);
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

test("the owner coming back before send leaves our text as a draft, blocks, and keeps their app in front", async (t) => {
  const probe = fakeProbe();
  const app = fakeApp();
  const f = setup(t, { app, probe });
  // Input after the fleet's own last key, well past the slack.
  app.onType = (text) => { probe.idleMs = async () => { f.advance(1_400); return 200; }; return text; };
  const result = await f.driver.deliver(f.request());
  assert.equal(result.status, "blocked");
  // No key once they may be at the keys: what looked focused may be theirs.
  assert.equal(result.detail, "owner using Conductor; our text is left as a draft, check it");
  assert.equal(app.composer, MESSAGE);
  assert.equal(f.calls().filter((call) => call.name === "press_key").length, 0);
  assert.equal(app.transcript.includes(MESSAGE), false);
  assert.deepEqual(probe.activated, ["com.conductor.app"], "the previous app is not restored under the owner");
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

test("a transport failure after typing leaves our text as a draft: no second engine, no keys", async (t) => {
  const app = fakeApp();
  const f = setup(t, { app, transportOptions: { failOn: (name, _args, n) => name === "get_app_state" && n === 6 } });
  const result = await f.driver.deliver(f.request());
  assert.equal(result.status, "failed");
  assert.match(result.detail, /not sent; our text is left as a draft, check it$/);
  assert.equal(f.transports.length, 1);
  assert.ok(f.transports.every((transport) => transport.closed >= 1));
  assert.equal(app.composer, MESSAGE);
  assert.equal(f.calls().filter((call) => call.name === "press_key").length, 0);
});

test("a read failing after typing while the owner adds to our text: recovery leaves their words alone", async (t) => {
  const probe = fakeProbe();
  const app = fakeApp();
  const f = setup(t, { app, probe, transportOptions: { failOn: (name, _args, n) => name === "get_app_state" && n === 6 } });
  // The owner comes back and types after our text, well past the slack.
  app.onType = (text) => { probe.idleMs = async () => { f.advance(5_000); return 200; }; return `${text} wait`; };
  const result = await f.driver.deliver(f.request());
  assert.equal(result.status, "failed");
  assert.doesNotMatch(result.detail, /cleared our text/);
  assert.equal(app.composer, `${MESSAGE} wait`);
  assert.equal(f.calls().filter((call) => call.name === "press_key").length, 0, "no select-all or delete");
});

test("the owner back during a slow front-app lookup is seen before typing", async (t) => {
  const probe = fakeProbe();
  const front = probe.frontApp;
  const idle = probe.idleMs;
  // The owner comes back during the 7th front-app lookup, the last check
  // before typing: an idle read taken before that lookup still says away.
  let lookups = 0;
  let back = false;
  probe.frontApp = async () => { if (++lookups === 7) back = true; return front(); };
  probe.idleMs = async () => (back ? 200 : idle());
  const f = setup(t, { probe });
  const result = await f.driver.deliver(f.request());
  assert.equal(result.status, "blocked");
  assert.equal(result.detail, "owner using Conductor");
  assert.deepEqual(typed(f.calls()), []);
});

test("the screen saver starting during an idle probe: nothing brought forward over it", async (t) => {
  const app = fakeApp({ selected: "cairo", onClickRow: () => {} });
  const probe = fakeProbe({ onOpen: () => { app.selected = "madrid"; } });
  let idleReads = 0;
  // The 4th idle read is the owner check right before activation.
  probe.idleMs = async () => { if (++idleReads === 4) probe.front = "com.apple.ScreenSaver.Engine"; return probe.idle; };
  const f = setup(t, { app, probe });
  const result = await f.driver.deliver(f.request());
  assert.equal(result.status, "blocked");
  assert.equal(result.detail, "screen saver on");
  assert.deepEqual(probe.activated, []);
  assert.deepEqual(typed(f.calls()), []);
});

test("a failed Send click: no Return if the owner switched apps meanwhile", async (t) => {
  let probe = null;
  const f = setup(t, { transportOptions: { failOn: (name, args) => {
    if (name === "click" && args.element_index === "62") { probe.front = "com.tinyspeck.slackmacgap"; return true; }
    return false;
  } } });
  probe = f.probe;
  const result = await f.driver.deliver(f.request());
  assert.equal(result.status, "blocked");
  assert.match(result.detail, /our text is left as a draft, check it$/);
  assert.equal(f.calls().filter((call) => call.name === "press_key").length, 0, "no Return");
});

test("a window title proves only exactly the thread, not a longer title starting the same", () => {
  const longer = parseAppState(fakeApp({ selected: "cairo", windowTitle: "madrid redirect" }).render());
  assert.equal(verifyIdentity(longer, { tokens: ["madrid"] }).ok, false);
  const suffixed = parseAppState(fakeApp({ selected: "cairo", windowTitle: "madrid — Conductor" }).render());
  assert.equal(verifyIdentity(suffixed, { tokens: ["madrid"] }).ok, true);
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

// From real trees (2026-09-30): Codex's composer says "Do anything" and sits
// beside the in-app browser's URL combo box and a GitHub comment box;
// Conductor's session has a "Terminal input" text area too.
const CODEX_BROWSER_STATE = [
  "App=com.openai.codex (pid 38786)",
  'Window: "ChatGPT", App: ChatGPT.',
  "0 standard window ChatGPT, Secondary Actions: Raise",
  "\t1 container (settable, string) ChatGPT",
  "\t\t2 scroll area",
  "\t\t\t3 HTML content Fix billing, URL: app://-/index.html",
  "\t\t\t\t26 combo box (settable, string) Command menu Search chats",
  "\t\t\t\t30 group",
  "\t\t\t\t\t2296 text entry area (settable, string) Do anything Do anything\\n",
  "\t\t\t\t\t2327 combo box (settable, string) Search or enter a URL Value: github.com",
  "\t\t\t\t\t2338 HTML content Pull Request #6988, URL: https://github.com/buildbetter-app/buildbetter/pull/6988",
  "\t\t\t\t\t\t4832 text area (settable, string) Comment"
].join("\n");
const CONDUCTOR_TERMINAL_STATE = [
  "App=com.conductor.app (pid 72610)",
  'Window: "Conductor", App: Conductor.',
  "0 standard window Conductor, Secondary Actions: Raise",
  "\t1 scroll area",
  `\t\t2 HTML content Tauri + React + Typescript, URL: ${CONDUCTOR_URL}`,
  "\t\t\t174 container composer",
  "\t\t\t\t175 text entry area (settable, string) Secondary Actions: Show Writing Tools",
  "\t\t\t266 container",
  "\t\t\t\t267 text entry area (settable, string) Terminal input, Secondary Actions: Show Writing Tools"
].join("\n");

test("findComposer: Codex's Do anything box, never a combo box or the in-app browser", () => {
  assert.equal(findComposer(stateOf(CODEX_BROWSER_STATE)).composer.id, "2296");
  assert.equal(findComposer(stateOf(CODEX_BROWSER_STATE), "com.openai.codex").composer.id, "2296");
  // Without the composer, the single-editable fallback picks nothing left.
  const noComposer = stateOf(CODEX_BROWSER_STATE.replace(/\n\t+2296 [^\n]*/, ""));
  assert.equal(findComposer(noComposer).composer, null);
  assert.match(findComposer(noComposer).reason, /composer not found/);
});

test("findSendButton: only the app's own page, never an in-app browser Submit", () => {
  const withSubmit = stateOf(`${CODEX_BROWSER_STATE}\n\t\t\t\t\t\t4833 button Submit`);
  assert.equal(findSendButton(withSubmit, "com.openai.codex"), null);
  const withSend = stateOf(CODEX_BROWSER_STATE.replace("\t\t\t\t\t2327 combo box", "\t\t\t\t\t2297 button Send message\n\t\t\t\t\t2327 combo box") + "\n\t\t\t\t\t\t4833 button Submit");
  assert.equal(findSendButton(withSend, "com.openai.codex")?.id, "2297");
});

test("findComposer: Conductor's composer container only, never its Terminal input", () => {
  assert.equal(findComposer(stateOf(CONDUCTOR_TERMINAL_STATE)).composer.id, "175");
  const terminalOnly = stateOf(CONDUCTOR_TERMINAL_STATE.replace(/\n\t+174 [^\n]*\n\t+175 [^\n]*/, ""));
  assert.equal(findComposer(terminalOnly).composer, null);
  // An editable outside the composer container is not the composer either.
  const loose = stateOf(CONDUCTOR_TERMINAL_STATE.replace("174 container composer", "174 container"));
  assert.equal(findComposer(loose).composer, null);
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

test("verifyIdentity: selected rows prove the thread, a heading never does; another open thread is a mismatch", () => {
  const madridShown = parseAppState(fakeApp().render());
  assert.equal(verifyIdentity(madridShown, { tokens: ["madrid"], conflicts: ["cairo"] }).ok, true);
  const cairoShown = parseAppState(fakeApp({ selected: "cairo", heading: "madrid" }).render());
  // A heading can be markdown in another thread's transcript: no proof.
  assert.equal(verifyIdentity(cairoShown, { tokens: ["madrid"] }).ok, false);
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
  assert.deepEqual(parseConsoleSession(unlocked), { locked: false, secureInput: false, secureInputPid: null, onConsole: true });
  const locked = '"IOConsoleUsers" = ({"CGSSessionScreenIsLocked"=Yes,"kCGSSessionOnConsoleKey"=Yes,"kCGSSessionSecureInputPID"=812})';
  assert.deepEqual(parseConsoleSession(locked), { locked: true, secureInput: true, secureInputPid: 812, onConsole: true });
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
  assert.deepEqual(await probe.session(), { locked: false, secureInput: false, secureInputPid: null, onConsole: true });
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

test("an activation that worked but reported failure still gets the owner's app put back", async (t) => {
  // The thread is already open: no link, only the activation moves the app.
  const app = fakeApp();
  const probe = fakeProbe();
  const activate = probe.activate;
  probe.activate = async (bundleId) => { await activate(bundleId); return bundleId !== app.bundleId; };
  const f = setup(t, { app, probe });
  const result = await f.driver.deliver(f.request());
  assert.equal(result.status, "blocked");
  assert.match(result.detail, /could not bring Conductor to the front/);
  assert.deepEqual(probe.activated, ["com.conductor.app", "com.google.Chrome"]);
});

test("an in-app browser page titled like another thread is no conflict", () => {
  const target = uiTargetFor(auditThread);
  const identity = uiIdentity(auditThread, target, [auditThread, intruderThread]);
  const state = stateOf(CODEX_BROWSER_STATE
    .replace("HTML content Fix billing", "HTML content Audit OpenAI model versions")
    .replace("HTML content Pull Request #6988", "HTML content Intruder"));
  assert.deepEqual(verifyIdentity(state, identity), { ok: true, reason: null });
});

test("Codex coming forward on its link, then navigation failing: the owner's app is put back", async (t) => {
  const app = fakeApp({ bundleId: "com.openai.codex", workspaces: [], selected: null, windowTitle: "Another thread" });
  const probe = fakeProbe({ idle: 10 * 60_000, onOpen: () => { probe.front = "com.openai.codex"; } });
  const f = setup(t, { app, probe });
  const thread = { key: "codex:t1", kind: "codex", id: "0199-abc", title: "Fix the upload retry bug", meta: { originator: "Codex Desktop" } };
  const target = uiTargetFor(thread);
  const result = await f.driver.deliver({ text: MESSAGE, target, identity: uiIdentity(thread, target, [thread]), evidenceName: "fa_codex" });
  assert.equal(result.status, "blocked");
  assert.match(result.detail, /could not verify thread/);
  assert.deepEqual(typed(f.calls()), []);
  assert.deepEqual(probe.activated, ["com.google.Chrome"], "the link brought Codex forward; Chrome goes back");
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
  // Codex reads are slow and deep: their own budget. Every action ends with
  // a fresh snapshot, so it gets a read's budget; typing gets more.
  const reads = f.calls().filter((call) => call.name === "get_app_state");
  assert.ok(reads.every((call) => call.args.max_tree_nodes === 6000 && call.options.timeoutMs === DEFAULTS.uiReadTimeoutMs));
  assert.equal(f.calls().find((call) => call.name === "type_text").options.timeoutMs, DEFAULTS.uiReadTimeoutMs + Math.ceil(MESSAGE.length * 25));
  assert.ok(f.calls().filter((call) => call.name === "click").every((call) => call.options.timeoutMs === DEFAULTS.uiReadTimeoutMs));
  assert.equal(f.transports[0].options.timeoutMs, DEFAULTS.uiStepTimeoutMs);
});

test("another app coming to the front after the target was brought forward aborts before typing", async (t) => {
  const probe = fakeProbe();
  const app = fakeApp();
  const render = app.render;
  let reads = 0;
  app.render = () => { reads += 1; if (reads === 2) probe.front = "com.apple.Terminal"; return render(); };
  const f = setup(t, { app, probe });
  const result = await f.driver.deliver(f.request());
  assert.equal(result.status, "blocked");
  assert.match(result.detail, /frontmost app changed/);
  assert.deepEqual(typed(f.calls()), []);
  assert.equal(f.calls().filter((call) => call.name === "click").length, 0);
  assert.deepEqual(probe.activated, ["com.conductor.app"], "the app now in front is left alone");
});

test("a background app never reports focus, so nothing is typed into it", async (t) => {
  // The target never comes forward in time: OCU prints no focus line.
  const probe = fakeProbe({ activate: async (bundleId) => { probe.activated.push(bundleId); return true; } });
  const f = setup(t, { probe, driverOptions: { config: { bins: { ocu: "/fake/OpenComputerUse" }, limits: { ...DEFAULTS, uiActivateMs: 0 } } } });
  const result = await f.driver.deliver(f.request());
  assert.equal(result.status, "blocked");
  assert.deepEqual(typed(f.calls()), []);
  f.app.focused = "61";
  assert.equal(parseAppState(f.app.render()).focusedId, null);
  probe.front = "com.conductor.app";
  assert.equal(parseAppState(f.app.render()).focusedId, "61");
});

test("focus uses an accessibility click only, never an event posted to the app", async (t) => {
  const app = fakeApp();
  const f = setup(t, { app });
  // Accessibility press on the composer does nothing.
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
  assert.equal(result.status, "failed");
  assert.match(result.detail, /could not focus the composer; nothing typed/);
  const focusClicks = f.calls().filter((call) => call.name === "click" && call.args.element_index === "61").map((call) => call.args.click_method);
  assert.deepEqual(focusClicks, ["accessibility"]);
  assert.equal(f.calls().filter((call) => call.args.click_method === "app_post").length, 0);
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

test("a restart with every command at its timeout, and the app changing at the last check, ends inside restartMaxMs", async () => {
  const { createAppRestarter, restartMaxMs } = await import("../src/fleet/ui-delivery.js");
  const slow = DEFAULTS.uiStepTimeoutMs + DEFAULTS.uiKillGraceMs;
  // The app quits (then starts) only on the n-th check of each wait, when the
  // check itself started just before the wait's 30 s were up.
  for (const [call, flipAfter] of [[slow, 2], [slow - 1, 3], [14_000, 3], [1_000, 29]]) {
    let clock = 0;
    let running = true;
    let checks = 0;
    let phase = "quit";
    const probe = {
      frontApp: async () => { clock += 2 * call; return "com.google.Chrome"; },
      idleMs: async () => { clock += call; return 10 * 60_000; },
      appRunning: async () => {
        clock += call;
        if (phase === "wait" && ++checks >= flipAfter) { running = !running; checks = -Infinity; }
        return running;
      }
    };
    const run = async (cmd) => {
      clock += call;
      phase = "wait";
      checks = 0;
      return { code: 0, stdout: "", stderr: "" };
    };
    const restarter = createAppRestarter({ run, probe, now: () => clock, sleep: async (ms) => { clock += ms; } });
    const result = await restarter.restart("conductor");
    assert.ok(clock <= restartMaxMs(), `${clock} ms over ${restartMaxMs()} ms (${result.detail})`);
  }
});

test("the app restarter quits in the background, relaunches, and refuses while the owner uses the app", async () => {
  const { createAppRestarter } = await import("../src/fleet/ui-delivery.js");
  let clock = 0;
  const runs = [];
  let running = true;
  const run = async (cmd, args) => {
    runs.push([cmd, ...args]);
    if (cmd === "osascript") running = false;
    if (cmd === "open") running = true;
    return { code: 0, stdout: "", stderr: "" };
  };
  const probe = fakeProbe({ appRunning: async () => running });
  const restarter = createAppRestarter({ run, probe, now: () => clock, sleep: async (ms) => { clock += ms; } });
  const ok = await restarter.restart("conductor");
  assert.deepEqual(ok, { ok: true, detail: "restarted Conductor" });
  assert.deepEqual(runs, [["osascript", "-e", 'tell application id "com.conductor.app" to quit'], ["open", "-g", "-b", "com.conductor.app"]]);

  const busy = createAppRestarter({ run, probe: fakeProbe({ front: "com.conductor.app", idle: 1_000 }), now: () => clock, sleep: async (ms) => { clock += ms; } });
  assert.deepEqual(await busy.restart("conductor"), { ok: false, detail: "you are using Conductor" });

  // A quit held up by the app (a confirm dialog) is not forced.
  const stuck = createAppRestarter({ run: async () => ({ code: 0 }), probe: fakeProbe({ appRunning: async () => true }), now: () => clock, sleep: async (ms) => { clock += ms; } });
  assert.deepEqual(await stuck.restart("conductor"), { ok: false, detail: "Conductor did not quit" });
  assert.equal((await restarter.restart("finder")).ok, false);
});

test("the app holding secure input is named in the not-ready reason", async () => {
  const { appNameFromPath } = await import("../src/fleet/ui-delivery.js");
  assert.equal(appNameFromPath("/Applications/BuildBetter Staging.app/Contents/MacOS/BuildBetter Staging\n"), "BuildBetter Staging");
  assert.equal(appNameFromPath("/usr/sbin/loginwindow"), "loginwindow");
  assert.equal(appNameFromPath(""), null);
  const session = parseConsoleSession('"IOConsoleUsers" = ({"kCGSSessionSecureInputPID"=56400,"kCGSSessionOnConsoleKey"=Yes})');
  assert.equal(session.secureInput, true);
  assert.equal(session.secureInputPid, 56400);
  assert.equal(parseConsoleSession('"IOConsoleUsers" = ({"kCGSSessionSecureInputPID"=0})').secureInputPid, null);
  // Fast user switching: an off-console session first must not hide the holder.
  const multi = parseConsoleSession('"IOConsoleUsers" = ({"kCGSSessionSecureInputPID"=0,"kCGSSessionOnConsoleKey"=No},{"kCGSSessionSecureInputPID"=812,"kCGSSessionOnConsoleKey"=Yes})');
  assert.equal(multi.secureInput, true);
  assert.equal(multi.secureInputPid, 812);
  const probe = createPresenceProbe({ run: async (cmd) => ({ code: 0, stdout: cmd === "ps" ? "/Applications/BuildBetter Staging.app/Contents/MacOS/BuildBetter Staging\n" : '"IOConsoleUsers" = ({"kCGSSessionSecureInputPID"=56400,"kCGSSessionOnConsoleKey"=Yes})' }) });
  assert.equal((await probe.session()).secureInputApp, "BuildBetter Staging");
  const driver = createUiDriver({ config: { bins: { ocu: "/fake/ocu" }, limits: { ...DEFAULTS } }, probe: fakeProbe({ screen: { locked: false, secureInput: true, secureInputApp: "BuildBetter Staging", onConsole: true } }), binaryReady: () => true, computerUseEnabled: () => true, permissionProbe: async () => ({ accessibility: true, screenRecording: true }) });
  assert.deepEqual(await driver.readiness(), { ready: false, detail: "secure input is on: BuildBetter Staging has a password field focused" });
});

// HIDIdleTime as the Mac keeps it: only the owner's input and posted keys
// reset it; accessibility clicks and an AX value set (OCU's typing into a
// settable composer) do not.
function hidClock(f, { keysReset = true } = {}) {
  const clock = { at: f.now() - 10 * 60_000, touch: () => { clock.at = f.now(); } };
  f.probe.idleMs = async () => f.now() - clock.at;
  if (keysReset) f.app.onKey = clock.touch;
  return clock;
}

test("the owner coming back during the first slow read: nothing opened or brought forward", async (t) => {
  for (const selected of ["madrid", "cairo"]) {
    const app = fakeApp({ selected, onClickRow: () => {} });
    const f = setup(t, { app, probe: fakeProbe({ onOpen: () => { app.selected = "madrid"; } }) });
    const render = app.render;
    app.render = () => { f.probe.idleMs = async () => 500; return render(); };
    const result = await f.driver.deliver(f.request());
    assert.equal(result.status, "blocked", selected);
    assert.equal(result.detail, "waiting for idle: Conductor must be in front to type");
    assert.deepEqual(f.probe.opened, [], "no deep link over the owner");
    assert.deepEqual(f.probe.activated, [], "nothing brought forward");
    assert.equal(f.calls().filter((call) => call.name !== "get_app_state").length, 0);
  }
});

test("owner input during the focus click, then a slow read: seen before typing, nothing typed, their app kept", async (t) => {
  const clock = {};
  const f = setup(t, { transportOptions: { latency: (name) => (name === "get_app_state" ? 20_000 : 3_000), advance: (ms) => clock.advance(ms) } });
  clock.advance = f.advance;
  const hid = hidClock(f);
  const render = f.app.render;
  // The owner clicks in the frontmost target as the focus click returns.
  let touched = false;
  f.app.render = () => { if (f.app.focused === "61" && !touched) { touched = true; hid.at = f.now() - 20_000; } return render(); };
  const result = await f.driver.deliver(f.request());
  assert.equal(result.status, "blocked");
  assert.equal(result.detail, "owner using Conductor");
  assert.deepEqual(typed(f.calls()), []);
  assert.deepEqual(f.probe.activated, ["com.conductor.app"], "not pulled away from the owner");
});

test("owner input during a slow Send click is not the fleet's: the next delivery waits", async (t) => {
  const clock = {};
  const f = setup(t, { transportOptions: { latency: (name, args) => (name === "click" && args.element_index === "62" ? 5_000 : 0), advance: (ms) => clock.advance(ms) } });
  clock.advance = f.advance;
  // Typing sets the composer's value: no HID event.
  const hid = hidClock(f);
  f.app.onSend = () => { hid.at = f.now() - 1_000; f.app.transcript.push(f.app.composer); f.app.composer = ""; };
  const first = await f.driver.deliver(f.request());
  assert.equal(first.status, "sent", first.detail);
  assert.deepEqual(f.probe.activated, ["com.conductor.app"], "the owner is back: their app is not swapped in over them");
  f.advance(10_000);
  const next = await f.driver.deliver(f.request({ text: `${MESSAGE} Second note.` }));
  assert.equal(next.status, "blocked");
  assert.match(next.detail, /^owner using Conductor/);
  assert.equal(typed(f.calls()).length, 1);
});

test("once the owner is seen, no clearing keys are pressed and the next delivery waits for real idle", async (t) => {
  const f = setup(t);
  const hid = hidClock(f);
  const render = f.app.render;
  // After typing, the owner clicks into the thread and watches.
  f.app.render = () => { if (f.app.composer === MESSAGE && hid.at < f.now() - 60_000) { f.advance(5_000); hid.touch(); } return render(); };
  const result = await f.driver.deliver(f.request());
  assert.equal(result.status, "blocked");
  assert.equal(result.detail, "owner using Conductor; our text is left as a draft, check it");
  assert.deepEqual(f.probe.activated, ["com.conductor.app"], "not restored over the owner");
  f.advance(3_000);
  const next = await f.driver.deliver(f.request());
  assert.equal(next.status, "blocked");
  assert.equal(next.detail, "owner using Conductor");
  assert.equal(typed(f.calls()).length, 1);
});

test("the owner adding words after our text: nothing cleared, no keys, no click", async (t) => {
  const f = setup(t);
  const render = f.app.render;
  f.app.onType = (text) => {
    // They type a few seconds after our text went in.
    f.app.render = () => { if (!f.app.composer.endsWith("hold on")) { f.advance(3_000); f.app.composer += " wait, hold on"; } f.probe.idleMs = async () => 200; return render(); };
    return text;
  };
  const result = await f.driver.deliver(f.request());
  assert.equal(result.status, "blocked");
  assert.equal(result.detail, "owner using Conductor; our text is left as a draft, check it");
  assert.equal(f.app.composer, `${MESSAGE} wait, hold on`);
  assert.equal(f.calls().filter((call) => call.name === "press_key").length, 0);
  assert.equal(f.calls().filter((call) => call.name === "click").length, 1, "only the focus click before typing");
});

test("a deep link that brings the app forward itself still gets the owner's app put back", async (t) => {
  const app = fakeApp({ bundleId: "com.openai.codex", workspaces: [], selected: null, windowTitle: "Codex" });
  const probe = fakeProbe({ onOpen: () => { app.windowTitle = "Fix the upload retry bug"; probe.front = "com.openai.codex"; } });
  const f = setup(t, { app, probe });
  const thread = { key: "codex:t1", kind: "codex", id: "0199-abc", title: "Fix the upload retry bug", meta: { originator: "Codex Desktop" } };
  const target = uiTargetFor(thread);
  const result = await f.driver.deliver({ text: MESSAGE, target, identity: uiIdentity(thread, target, [thread]), evidenceName: "fa_codex" });
  assert.equal(result.status, "sent", result.detail);
  assert.deepEqual(probe.activated, ["com.google.Chrome"]);
  assert.equal(probe.front, "com.google.Chrome");
});

test("an app that quit is never launched to bring it forward or put it back", async (t) => {
  const f = setup(t);
  f.probe.appRunning = async (bundleId) => bundleId === "com.conductor.app";
  const result = await f.driver.deliver(f.request());
  assert.equal(result.status, "sent", result.detail);
  assert.deepEqual(f.probe.activated, ["com.conductor.app"], "Chrome quit: not relaunched");
  const g = setup(t);
  let checks = 0;
  g.probe.appRunning = async () => (checks += 1) === 1;
  const gone = await g.driver.deliver(g.request());
  assert.equal(gone.status, "blocked");
  assert.equal(gone.detail, "could not bring Conductor to the front");
  assert.deepEqual(g.probe.activated, []);
});

test("Codex-slow clicks and keys get a read's budget, not a step's", async (t) => {
  const clock = {};
  const app = fakeApp({ bundleId: "com.openai.codex", workspaces: [], selected: null, windowTitle: "Fix the upload retry bug", sendButton: false });
  const f = setup(t, { app, transportOptions: { latency: (name) => (name === "get_app_state" ? 20_000 : 12_000), advance: (ms) => clock.advance(ms) } });
  clock.advance = f.advance;
  const thread = { key: "codex:t1", kind: "codex", id: "0199-abc", title: "Fix the upload retry bug", meta: { originator: "Codex Desktop" } };
  const target = uiTargetFor(thread);
  const result = await f.driver.deliver({ text: MESSAGE, target, identity: uiIdentity(thread, target, [thread]), evidenceName: "fa_codex" });
  assert.equal(result.status, "sent", result.detail);
  assert.deepEqual(names(f.calls()).filter((name) => name !== "get_app_state"), ["click", "type_text", "press_key"]);
});

// Live 2026-09-30: Codex labelled thread 01a0cae7 ("Audit OpenAI model
// versions") by its first message, truncated, and the sidebar likewise.
const AUDIT_FIRST = "OpenAI just launched their GPT-6 models so for all of our Luna, Soul, and Terra ...";
const AUDIT_LABEL = "OpenAI just launched their GPT-6 models so for all of our L…";
const codexNamed = (id, title, firstMessageTitle, extra = {}) => ({
  key: `codex:${id}`, kind: "codex", id, title, archived: false, meta: { originator: "Codex Desktop", firstMessageTitle, ...extra }
});
const auditThread = codexNamed("01a0cae7-09a3-7023-a300-30b1c87d1553", "Audit OpenAI model versions", AUDIT_FIRST);
const intruderThread = codexNamed("0199-intruder", "Intruder", "continue");
const codexLabelled = (page, rows = []) => stateOf([
  "App=com.openai.codex (pid 38786)",
  'Window: "ChatGPT", App: ChatGPT.',
  "0 standard window ChatGPT, Secondary Actions: Raise",
  "\t1 container (settable, string) ChatGPT",
  "\t\t2 scroll area",
  `\t\t\t3 HTML content ${page}, URL: app://-/index.html`,
  ...rows.map((row, index) => `\t\t\t\t${40 + index} ${row}`)
].join("\n"));

test("a hidden automation's labels never make a real thread's name or first message look shared", () => {
  const target = uiTargetFor(auditThread);
  // A review run whose first message is our thread's name, kept in memory.
  const review = { ...codexNamed("0199-review", "Guardian", "Audit OpenAI model versions"), excluded: "automation" };
  const identity = uiIdentity(auditThread, target, [auditThread, review]);
  assert.equal(identity.ambiguous, false);
  assert.deepEqual(identity.altTokens, ["openai just launched their gpt-6 models"]);
  assert.equal(identity.conflicts.includes("guardian"), false);
  // The same thread shown in the sidebar does make it shared.
  assert.equal(uiIdentity(auditThread, target, [auditThread, { ...review, excluded: null }]).ambiguous, true);
});

test("Codex showing a thread by its first message: the alt title proves it, never past another thread", () => {
  const target = uiTargetFor(auditThread);
  assert.equal(target.altTitle, AUDIT_FIRST);
  assert.equal(target.altTitleShared, false);
  const identity = uiIdentity(auditThread, target, [auditThread, intruderThread]);
  assert.deepEqual(identity.tokens, ["audit openai model versions"]);
  assert.deepEqual(identity.altTokens, ["openai just launched their gpt-6 models"]);
  assert.ok(identity.conflicts.includes("intruder") && identity.conflicts.includes("continue"), "other threads' names and first messages are conflicts");
  assert.deepEqual(verifyIdentity(codexLabelled(AUDIT_LABEL, [`row (selected) ${AUDIT_LABEL}`, "row continue"]), identity), { ok: true, reason: null, byAlt: true });
  // Only exactly the app's page label: a selected browser tab can hold any text.
  assert.equal(verifyIdentity(codexLabelled("Daily investor pipeline push", [`tab (selected) ${AUDIT_FIRST} · Pull Request #6700`]), identity).ok, false);
  // Without the alt tokens the same screen fails as it did live.
  assert.match(verifyIdentity(codexLabelled(AUDIT_LABEL), { ...identity, altTokens: [] }).reason, /"audit openai model versions" is not the open thread/);
  // Another thread's name or first message shown: a mismatch, whatever the alt says.
  assert.match(verifyIdentity(codexLabelled(AUDIT_LABEL, ["row (selected) Intruder"]), identity).reason, /another thread is open/);
  assert.match(verifyIdentity(codexLabelled(AUDIT_LABEL, ["row (selected) continue"]), identity).reason, /another thread is open/);
  assert.equal(verifyIdentity(codexLabelled("continue"), identity).ok, false);
  // Mentioned in the transcript is not shown.
  assert.equal(verifyIdentity(codexLabelled("Daily investor pipeline push", [`static text ${AUDIT_LABEL}`]), identity).ok, false);
});

test("a shared, short, or clashing first-message title is never used to verify", () => {
  const altOf = (thread, threads = [thread]) => uiIdentity(thread, uiTargetFor(thread), threads).altTokens;
  assert.deepEqual(altOf(codexNamed("t-s", "Audit OpenAI model versions", AUDIT_FIRST, { codexFirstMessageShared: true })), []);
  assert.deepEqual(altOf(codexNamed("t-short", "Rename the bucket", "fix the bug")), []);
  assert.deepEqual(altOf(codexNamed("t-same", "Audit OpenAI model versions", "audit  OpenAI model versions")), []);
  // Another known thread named, or first-messaged, the same.
  assert.deepEqual(altOf(auditThread, [auditThread, codexNamed("t-named", AUDIT_FIRST, null)]), []);
  assert.deepEqual(altOf(auditThread, [auditThread, codexNamed("t-first", "Other work", AUDIT_FIRST)]), []);
  assert.deepEqual(altOf(codexNamed("t-none", "Fix the upload retry bug", null)), []);
});

test("a name another known thread's first message can show is shared: only a link that moves the app proves it", () => {
  const retry = codexNamed("t-retry", "Fix the upload retry bug", null);
  const labelled = codexNamed("t-work", "Retry work", "Fix the upload retry bug");
  const identity = uiIdentity(retry, uiTargetFor(retry), [retry, labelled]);
  assert.equal(identity.shared, true);
  assert.equal(identity.ambiguous, true);
});

test("a first-message label already open proves nothing: blocked, no link, nothing typed", async (t) => {
  const app = fakeApp({ bundleId: "com.openai.codex", windowTitle: "ChatGPT", workspaces: [], selected: null, page: { label: AUDIT_LABEL, url: "app://-/index.html" } });
  const f = setup(t, { app });
  const target = uiTargetFor(auditThread);
  const result = await f.driver.deliver({ text: MESSAGE, target, identity: uiIdentity(auditThread, target, [auditThread, intruderThread]), evidenceName: "fa_alt_open" });
  assert.equal(result.status, "blocked");
  assert.match(result.detail, /only its first message is shown/);
  assert.deepEqual(f.probe.opened, []);
  assert.deepEqual(typed(f.calls()), []);
});

test("Codex navigation reads at least twice after the link, within its slower window", async (t) => {
  const run = async (limits, readsUntilMoved, callMs = null) => {
    const app = fakeApp({ bundleId: "com.openai.codex", windowTitle: "ChatGPT", workspaces: [], selected: null, page: { label: "Daily investor pipeline push", url: "app://-/index.html" } });
    let pending = 0;
    const render = app.render;
    app.render = () => {
      if (pending && --pending === 0) app.page = { ...app.page, label: AUDIT_LABEL };
      return render();
    };
    const clock = {};
    const probe = fakeProbe({ onOpen: () => { pending = readsUntilMoved; } });
    const f = setup(t, { app, probe, transportOptions: { latency: (name) => callMs ?? (name === "get_app_state" ? 20_000 : 1_000), advance: (ms) => clock.advance(ms) },
      driverOptions: { config: { bins: { ocu: "/fake/OpenComputerUse" }, limits: { ...DEFAULTS, ...limits } } } });
    clock.advance = f.advance;
    const target = uiTargetFor(auditThread);
    const start = f.now();
    const result = await f.driver.deliver({ text: MESSAGE, target, identity: uiIdentity(auditThread, target, [auditThread, intruderThread]), evidenceName: "fa_alt" });
    // The fake clock never fires the real abort timer: the cap is checked here.
    assert.ok(f.now() - start <= DEFAULTS.uiDeliveryTimeoutMs, `${f.now() - start} ms`);
    return { result, probe, app, calls: f.calls() };
  };
  // The first read after the link outlasts the window and still shows the old thread.
  const two = await run({ uiNavigateSlowMs: 1_000 }, 2);
  assert.equal(two.result.status, "sent", two.result.detail);
  assert.deepEqual(two.probe.opened, ["codex://threads/01a0cae7-09a3-7023-a300-30b1c87d1553"]);
  assert.equal(two.app.transcript.at(-1), MESSAGE);
  // Codex's own window outlasts Conductor's 5 s: a third 20 s read still counts.
  const three = await run({}, 3);
  assert.equal(three.result.status, "sent", three.result.detail);
  const late = await run({ uiNavigateSlowMs: 1_000 }, 3);
  assert.equal(late.result.status, "blocked");
  assert.match(late.result.detail, /is not the open thread/);
  // Live-like 25 s for every call: two reads after the link leave too little
  // to type, send and confirm inside the cap, so nothing is typed.
  const slow = await run({}, 2, 25_000);
  assert.equal(slow.result.status, "blocked");
  assert.match(slow.result.detail, /^not enough time left to type and confirm \(\d+ s\); nothing typed$/);
  assert.deepEqual(typed(slow.calls), []);
  // At 17 s a call (the live low end), the same navigation is sent in time.
  const typical = await run({}, 2, 17_000);
  assert.equal(typical.result.status, "sent", typical.result.detail);
});

test("the screen saver starting during a slow read: nothing opened or brought forward over it", async (t) => {
  for (const selected of ["madrid", "cairo"]) {
    const app = fakeApp({ selected, onClickRow: () => {} });
    const f = setup(t, { app, probe: fakeProbe({ onOpen: () => { app.selected = "madrid"; } }) });
    const render = app.render;
    // Idle stays long: the owner is away, the Mac is not free to use.
    app.render = () => { f.probe.front = "com.apple.ScreenSaver.Engine"; return render(); };
    const result = await f.driver.deliver(f.request());
    assert.equal(result.status, "blocked", selected);
    assert.equal(result.detail, "screen saver on");
    assert.deepEqual(f.probe.opened, []);
    assert.deepEqual(f.probe.activated, [], "nothing brought forward over the screen saver");
    assert.deepEqual(typed(f.calls()), []);
  }
});

test("a delivery cut off after typing ends, clearing and restore included, inside its cap plus the cleanup, counted from the request's start", async (t) => {
  // spentMs: the request's probes before the send.
  for (const spentMs of [0, 500]) {
    const limits = { ...DEFAULTS, uiDeliveryTimeoutMs: 1_500, uiCleanupMs: 600, uiReadTimeoutMs: 2_000, uiStepTimeoutMs: 100, uiKillGraceMs: 0 };
    const app = fakeApp();
    const probe = fakeProbe();
    let hung = false;
    // After typing, reads never answer and every probe command takes its whole timeout.
    for (const [name, commands] of [["frontApp", 2], ["idleMs", 1], ["appRunning", 1], ["activate", 1]]) {
      const fn = probe[name];
      probe[name] = async (...args) => {
        if (hung) await new Promise((resolve) => setTimeout(resolve, commands * limits.uiStepTimeoutMs));
        return fn(...args);
      };
    }
    app.onType = (text) => { hung = true; return text; };
    const engines = [];
    const f = setup(t, {
      app, probe,
      driverOptions: {
        config: { bins: { ocu: "/fake/OpenComputerUse" }, limits },
        now: Date.now,
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5))),
        transportFactory: () => {
          const inner = fakeTransport(app);
          engines.push(inner);
          return {
            call: (name, args, signal, options = {}) => (hung && name === "get_app_state")
              ? new Promise((_resolve, reject) => {
                inner.calls.push({ name, args, options });
                const fail = () => { clearTimeout(timer); reject(new Error("Open Computer Use timed out")); };
                const timer = setTimeout(fail, options.timeoutMs);
                signal?.addEventListener("abort", fail, { once: true });
              })
              : inner.call(name, args, signal, options),
            close: () => inner.close()
          };
        }
      }
    });
    const start = Date.now();
    const result = await f.driver.deliver(f.request({ text: "[OpenAGI supervisor] hi", spentMs }));
    const took = Date.now() - start;
    assert.equal(result.status, "failed");
    assert.match(result.detail, /^delivery timed out; not sent/);
    assert.deepEqual(engines.flatMap((engine) => engine.calls).filter((call) => call.name === "type_text").length, 1);
    assert.ok(took <= limits.uiDeliveryTimeoutMs + limits.uiCleanupMs - spentMs + 150, `${spentMs}: ${took} ms`);
  }
});

test("an input call that times out may still land: unconfirmed, nothing cleared, typed, or brought forward after it", async (t) => {
  const f = setup(t, { transportOptions: { latency: (name) => (name === "type_text" ? 10 * 60_000 : 0) } });
  const result = await f.driver.deliver(f.request());
  assert.equal(result.status, "failed");
  assert.equal(result.detail, "Open Computer Use timed out on input; unconfirmed: check the thread before retrying");
  assert.equal(result.unconfirmed, true);
  assert.equal(f.transports.length, 1, "no fresh engine to clear with");
  assert.equal(names(f.calls()).at(-1), "type_text", "no call after it");
  assert.deepEqual(f.probe.activated, ["com.conductor.app"], "the owner's app is not put back under running input");
  // A Send click that times out: no Return after it.
  const g = setup(t, { transportOptions: { latency: (name, args) => (name === "click" && args.element_index === "62" ? 10 * 60_000 : 0) } });
  const send = await g.driver.deliver(g.request());
  assert.equal(send.status, "failed");
  assert.equal(send.detail, "Open Computer Use timed out on input; unconfirmed: check the thread before retrying");
  assert.equal(send.unconfirmed, true);
  assert.equal(g.calls().filter((call) => call.name === "press_key").length, 0);
  assert.equal(names(g.calls()).at(-1), "click");
  assert.deepEqual(g.probe.activated, ["com.conductor.app"]);
});

test("the owner's input during a slow typing call, or as a failed one ends, is theirs", async (t) => {
  const clock = {};
  const f = setup(t, { transportOptions: { latency: (name) => (name === "type_text" ? 20_000 : 0), advance: (ms) => clock.advance(ms) } });
  clock.advance = f.advance;
  const hid = hidClock(f);
  // Typing takes 20 s (an AX value set: no HID event); the owner clicks 10 s
  // in, well after the fleet's own input could still land.
  f.app.onType = (text) => { hid.at = f.now() - 10_000; return text; };
  const result = await f.driver.deliver(f.request());
  assert.equal(result.status, "blocked");
  assert.equal(result.detail, "owner using Conductor; our text is left as a draft, check it");
  assert.deepEqual(f.probe.activated, ["com.conductor.app"], "their app is not swapped in over them");
  // A key or typing call that failed marks nothing as the fleet's.
  let ghid = null;
  const g = setup(t, { transportOptions: { failOn: (name) => { if (name !== "type_text") return false; ghid.touch(); return true; } } });
  ghid = hidClock(g);
  const failed = await g.driver.deliver(g.request());
  assert.equal(failed.status, "failed");
  assert.deepEqual(g.probe.activated, ["com.conductor.app"], "the owner's input as it failed is theirs: nothing put back over them");
});

test("a Return send is input like any other: the owner's app waits for real idle, as does the next send", async (t) => {
  // Codex: the key lands, then a 12 s snapshot. Typing sets the value (no HID).
  const f = setup(t, { transportOptions: { latency: (name) => (name === "type_text" || name === "press_key" ? 12_000 : 0), advance: (ms) => f.advance(ms) } });
  const hid = hidClock(f, { keysReset: false });
  f.app.sendButton = false;
  f.app.onKey = () => { hid.at = f.now() - 12_000; };
  const result = await f.driver.deliver(f.request());
  assert.equal(result.status, "sent", result.detail);
  assert.equal(f.calls().filter((call) => call.name === "press_key").at(-1).args.key, "Return");
  assert.deepEqual(f.probe.activated, ["com.conductor.app"], "no switch until real idle");
  f.advance(20_000);
  const next = await f.driver.deliver(f.request({ text: `${MESSAGE} Second note.` }));
  assert.equal(next.status, "blocked");
  assert.match(next.detail, /^owner using Conductor/);
});

test("after an input call times out, nothing types until its late answer shows it finished, however long that takes", async (t) => {
  let slow = true;
  const f = setup(t, { transportOptions: { latency: (name) => (slow && name === "type_text" ? 10 * 60_000 : 0) } });
  assert.deepEqual(await f.driver.readiness(), { ready: true, detail: null });
  const first = await f.driver.deliver(f.request());
  assert.equal(first.detail, "Open Computer Use timed out on input; unconfirmed: check the thread before retrying");
  slow = false;
  f.app.composer = "";
  const count = f.calls().length;
  // Surfaced as not ready (the supervisor's paused-nudge alert), not a benign wait.
  assert.deepEqual(await f.driver.readiness(), { ready: false, detail: "an earlier input call has not finished; typing paused until it answers" });
  // Long past any estimate (close grace, a read, the typing time).
  f.advance(60 * 60_000);
  const next = await f.driver.deliver(f.request({ text: `${MESSAGE} Second note.` }));
  assert.equal(next.status, "blocked");
  assert.equal(next.detail, "computer use not ready: an earlier input call has not finished; typing paused until it answers; nothing typed");
  assert.equal(f.calls().length, count, "nothing read or typed");
  assert.equal(f.probe.activated.length, 1, "no other app brought forward");
  // The late answer arrives on the still-open engine: typing resumes.
  f.transports[0].late[0]({ completed: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await f.driver.readiness(), { ready: true, detail: null });
  const later = await f.driver.deliver(f.request({ text: `${MESSAGE} Second note.` }));
  assert.equal(later.status, "sent", later.detail);
});

test("the input latch is process-wide, and an engine that exits before the late answer keeps it 30 min, across restarts", async (t) => {
  let clock = Date.parse("2026-09-30T12:00:00.000Z");
  const latch = createInputLatch({ now: () => clock });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-latch-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "ui-input-orphaned.json");
  latch.persistTo(file);
  const f = setup(t, { transportOptions: { latency: (name) => (name === "type_text" ? 10 * 60_000 : 0) }, driverOptions: { inputLatch: latch } });
  const g = setup(t, { driverOptions: { inputLatch: latch } });
  await f.driver.deliver(f.request());
  // Another driver (another thread's delivery) sharing the latch types nothing.
  const other = await g.driver.deliver(g.request());
  assert.equal(other.status, "blocked");
  assert.match(other.detail, /^computer use not ready: an earlier input call has not finished; typing paused/);
  assert.deepEqual(g.calls(), []);
  f.transports[0].late[0]({ completed: false });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await g.driver.readiness(), { ready: false, detail: "an earlier input call never answered and may still run in Open Computer Use; typing paused until 12:30 UTC" });
  // A restart (a new latch reading the same file) keeps the pause.
  const restarted = createInputLatch({ now: () => clock });
  restarted.persistTo(file);
  assert.equal(restarted.held, true);
  // 30 min on, it lifts, and the file goes.
  clock += 30 * 60_000;
  assert.equal(restarted.held, false);
  assert.equal(fs.existsSync(file), false);
  // A timed-out input call with no way to see it end holds it as well.
  const bare = createInputLatch();
  bare.hold(undefined);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(bare.held, true);
});

test("after a Return send, the owner's app goes back once only that key happened and they are away", async (t) => {
  const f = setup(t);
  const hid = hidClock(f);
  f.app.sendButton = false;
  const result = await f.driver.deliver(f.request());
  assert.equal(result.status, "sent", result.detail);
  assert.deepEqual(f.probe.activated, ["com.conductor.app"], "not right after our own key");
  // Not away long enough yet: kept.
  f.advance(30_000);
  await f.driver.readiness();
  assert.deepEqual(f.probe.activated, ["com.conductor.app"]);
  // Away long enough, nothing since our key: Chrome goes back.
  f.advance(DEFAULTS.uiOwnerIdleMs);
  await f.driver.readiness();
  assert.deepEqual(f.probe.activated, ["com.conductor.app", "com.google.Chrome"]);

  // Input after our key is the owner's: nothing is put back, ever.
  const g = setup(t);
  const ghid = hidClock(g);
  g.app.sendButton = false;
  await g.driver.deliver(g.request());
  g.advance(10_000);
  ghid.touch();
  g.advance(DEFAULTS.uiOwnerIdleMs + 1_000);
  await g.driver.readiness();
  assert.deepEqual(g.probe.activated, ["com.conductor.app"]);
});

test("the owner back during the deferred restore's front-app probe: nothing switched", async (t) => {
  const f = setup(t);
  const hid = hidClock(f);
  f.app.sendButton = false;
  await f.driver.deliver(f.request());
  f.advance(DEFAULTS.uiOwnerIdleMs + 1_000);
  const front = f.probe.frontApp;
  f.probe.frontApp = async () => { hid.touch(); return front(); };
  await f.driver.readiness();
  assert.deepEqual(f.probe.activated, ["com.conductor.app"]);
});

test("an input that timed out after the app came forward: the owner's app goes back only once it answers done", async (t) => {
  let slow = true;
  const f = setup(t, { transportOptions: { latency: (name) => (slow && name === "type_text" ? 10 * 60_000 : 0) } });
  const result = await f.driver.deliver(f.request());
  assert.equal(result.unconfirmed, true);
  assert.deepEqual(f.probe.activated, ["com.conductor.app"], "nothing moves while it may land");
  f.advance(DEFAULTS.uiOwnerIdleMs + 1_000);
  await f.driver.readiness();
  assert.deepEqual(f.probe.activated, ["com.conductor.app"], "still unanswered");
  slow = false;
  f.transports[0].late[0]({ completed: true });
  await new Promise((resolve) => setImmediate(resolve));
  f.advance(DEFAULTS.uiOwnerIdleMs + 1_000);
  await f.driver.readiness();
  assert.deepEqual(f.probe.activated, ["com.conductor.app", "com.google.Chrome"]);
});

test("the in-flight pause is on disk at once, so a restart before the answer keeps it", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-latch-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "ui-input-orphaned.json");
  const latch = createInputLatch();
  latch.persistTo(file);
  latch.hold(new Promise(() => {}));
  assert.equal(fs.existsSync(file), true);
  const restarted = createInputLatch();
  restarted.persistTo(file);
  assert.equal(restarted.held, true);
  // Proven done in a run that saw it: the file goes.
  const done = createInputLatch();
  done.persistTo(path.join(dir, "other.json"));
  let finish;
  done.hold(new Promise((resolve) => { finish = resolve; }));
  finish({ completed: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fs.existsSync(path.join(dir, "other.json")), false);
});

test("a request that already spent its time before the send types nothing", async (t) => {
  const f = setup(t);
  const result = await f.driver.deliver(f.request({ spentMs: DEFAULTS.uiDeliveryTimeoutMs }));
  assert.equal(result.status, "blocked");
  assert.equal(result.detail, "no time left in this request for another app send; nothing typed, retry");
  assert.deepEqual(f.calls(), []);
  assert.equal(f.permissionChecks, 0, "nothing probed");
  // Readiness ran into the cap: no presence probe starts after it.
  const g = setup(t);
  const session = g.probe.session;
  g.probe.session = async () => { g.advance(30_000); return session(); };
  const late = await g.driver.deliver(g.request({ spentMs: DEFAULTS.uiDeliveryTimeoutMs - 20_000 }));
  assert.equal(late.status, "failed");
  assert.equal(late.detail, "delivery timed out; nothing typed");
  assert.deepEqual(g.calls(), []);
});

test("a remote request queued 200 s before this Mac picked it up ends inside the broker's deadline, typing nothing it cannot finish", async (t) => {
  // Codex-like: every call takes 20 s. The broker gives the command 300 s
  // from dispatch; it waited 200 s in the queue, so 100 s are left.
  const clock = {};
  const f = setup(t, { transportOptions: { latency: () => 20_000, advance: (ms) => clock.advance(ms) } });
  clock.advance = f.advance;
  const deadlineAt = f.now() + 100_000;
  const result = await f.driver.deliver(f.request({ deadlineAt }));
  assert.notEqual(result.status, "sent");
  assert.match(result.detail, /nothing typed/);
  assert.deepEqual(typed(f.calls()), [], "nothing typed");
  assert.ok(f.now() <= deadlineAt, `ended ${f.now() - deadlineAt} ms after the caller gave up`);
  // With the whole window left, the same send goes through.
  const g = setup(t, { transportOptions: { latency: () => 20_000, advance: (ms) => g.advance(ms) } });
  const fresh = g.now() + 300_000;
  const sent = await g.driver.deliver(g.request({ deadlineAt: fresh }));
  assert.equal(sent.status, "sent", sent.detail);
  assert.ok(g.now() <= fresh);
});

test("after the link, a first read that matches is read again: the latest decides what is used", async (t) => {
  const app = fakeApp({ bundleId: "com.openai.codex", windowTitle: "ChatGPT", workspaces: [], selected: null,
    page: { label: "Daily investor pipeline push", url: "app://-/index.html" }, composer: "half-written note for the pipeline" });
  const probe = fakeProbe({
    onOpen: () => {
      // The link brings Codex forward; its label switches a read before the composer does.
      probe.front = "com.openai.codex";
      app.page = { ...app.page, label: AUDIT_LABEL };
      const render = app.render;
      let reads = 0;
      app.render = () => { if (++reads === 2) app.composer = ""; return render(); };
    }
  });
  const f = setup(t, { app, probe });
  const target = uiTargetFor(auditThread);
  const result = await f.driver.deliver({ text: MESSAGE, target, identity: uiIdentity(auditThread, target, [auditThread, intruderThread]), evidenceName: "fa_nav" });
  assert.equal(result.status, "sent", result.detail);
  assert.equal(app.transcript.at(-1), MESSAGE);
  assert.deepEqual(names(f.calls()).slice(0, 4), ["get_app_state", "get_app_state", "get_app_state", "click"], "two reads after the link before the focus click");
});

test("a first-message title shows only as the app's page label, never a transcript heading or a browser page", async (t) => {
  const identity = uiIdentity(auditThread, uiTargetFor(auditThread), [auditThread, intruderThread]);
  assert.equal(verifyIdentity(codexLabelled("Daily investor pipeline push", [`heading ${AUDIT_LABEL}`]), identity).ok, false);
  const browser = stateOf([
    "App=com.openai.codex (pid 38786)",
    'Window: "ChatGPT", App: ChatGPT.',
    "0 standard window ChatGPT",
    "\t1 HTML content Daily investor pipeline push, URL: app://-/index.html",
    `\t\t2 HTML content ${AUDIT_LABEL}, URL: https://github.com/acme/app/pull/6700`
  ].join("\n"));
  assert.equal(verifyIdentity(browser, identity).ok, false);
  // The link lands on another thread whose transcript has that markdown heading: nothing typed.
  const app = fakeApp({ bundleId: "com.openai.codex", windowTitle: "ChatGPT", workspaces: [], selected: null, page: { label: "Daily investor pipeline push", url: "app://-/index.html" } });
  const f = setup(t, { app, probe: fakeProbe({ onOpen: () => { app.page = { ...app.page, label: "Other work" }; app.heading = AUDIT_LABEL; } }) });
  const target = uiTargetFor(auditThread);
  const result = await f.driver.deliver({ text: MESSAGE, target, identity, evidenceName: "fa_heading" });
  assert.equal(result.status, "blocked");
  assert.match(result.detail, /is not the open thread/);
  assert.deepEqual(typed(f.calls()), []);
});

test("the owner back, or the screen saver on, during the running check before activation: nothing brought forward", async (t) => {
  for (const [change, detail] of [
    [(probe) => { probe.idle = 1_000; }, "waiting for idle: Conductor must be in front to type"],
    [(probe) => { probe.idle = 1_000; probe.front = "com.apple.Safari"; }, "waiting for idle: Conductor must be in front to type"],
    [(probe) => { probe.front = "com.apple.ScreenSaver.Engine"; }, "screen saver on"]
  ]) {
    const probe = fakeProbe();
    let checks = 0;
    // The second running check is bringToFront's: it can take a command's
    // timeout, and the owner comes back meanwhile.
    probe.appRunning = async () => { if (++checks === 2) change(probe); return probe.running; };
    const f = setup(t, { probe });
    const result = await f.driver.deliver(f.request());
    assert.equal(result.status, "blocked");
    assert.equal(result.detail, detail);
    assert.deepEqual(f.probe.activated, [], "nothing activated over them");
    assert.deepEqual(typed(f.calls()), []);
  }
});

test("a slow presence check is not trusted: the send waits for a quick one, nothing typed", async (t) => {
  const probe = fakeProbe();
  const clock = {};
  // Idle probes stall for 2 s each: one owner check takes over 3 s.
  const idle = probe.idleMs;
  probe.idleMs = async () => { clock.advance(2_000); return idle(); };
  const f = setup(t, { probe });
  clock.advance = f.advance;
  const result = await f.driver.deliver(f.request());
  assert.equal(result.status, "blocked");
  assert.equal(result.detail, "presence check too slow");
  assert.deepEqual(typed(f.calls()), []);
  assert.deepEqual(f.app.transcript.slice(-1), ["Pushed the fix."]);
  // Quick probes describe now: it is sent.
  const quick = fakeProbe();
  const quickIdle = quick.idleMs;
  quick.idleMs = async () => { g.advance(500); return quickIdle(); };
  const g = setup(t, { probe: quick });
  const sent = await g.driver.deliver(g.request());
  assert.equal(sent.status, "sent", sent.detail);
});

test("slow probes never leave typed text unsent: nothing is typed", async (t) => {
  // frontApp 12.5 s and idleMs 15 s: refused before typing, whether by the
  // presence freshness rule or the typing budget.
  const probe = fakeProbe();
  const clock = {};
  const front = probe.frontApp;
  const idle = probe.idleMs;
  probe.frontApp = async () => { clock.advance(12_500); return front(); };
  probe.idleMs = async () => { clock.advance(15_000); return idle(); };
  const f = setup(t, { probe });
  clock.advance = f.advance;
  const result = await f.driver.deliver(f.request());
  assert.equal(result.status, "blocked");
  assert.match(result.detail, /^(presence check too slow|not enough time left to type and confirm \(\d+ s\); nothing typed)$/);
  assert.deepEqual(typed(f.calls()), []);
});
