// Computer-use delivery: types supervisor text into the real app that shows a
// thread (Conductor or the Codex app) and presses send, instead of running a
// CLI. Drives the standalone Open Computer Use binary through its app agent,
// which holds Accessibility and Screen Recording (the daemon's node does not).
//
// Fail closed. Every step either proves it is safe to go on or returns
// "blocked" (nothing typed, retry later) / "failed" (see detail). Never
// overwrites a draft, never presses send after a failed check, never uses the
// clipboard, never launches an app, and acts only while the owner is away
// from the keyboard: Open Computer Use reports focus and types only into the
// frontmost app, so the target is brought forward for the send and the
// owner's previous app put back. One delivery at a time (see UI_LOCK).

import fs from "node:fs";
import path from "node:path";
import { ensureDir } from "../file-utils.js";
import { OcuTransport, readOcuPermissions } from "../integrations/ocu-transport.js";
import { parseOcuPermissions } from "../integrations/open-computer-use-executor.js";
import { DEFAULTS, SUPERVISOR_PREFIX, UI_APPS, clampText, redactSecrets, runCommand, uiTargetFor } from "./contracts.js";

const MIN = 60_000;
// OCU get_app_state budget. The composer and Send button sit at the end of a
// long transcript, so the default 1200-node tree can cut them off. Codex's
// composer sits near node 1500-2300 with its sidebar open.
const STATE_TREE_NODES = 3000;
const STATE_TREE_NODES_BY_APP = { "com.openai.codex": 6000 };
// Apps whose first read after a deep link can still show the previous thread.
const SLOW_NAVIGATION = new Set(["com.openai.codex"]);
// The fleet's own app agent, apart from the owner's other sessions.
const OCU_AGENT_NAMESPACE = "openagi-fleet";
// The fleet's own keys (and keyboard-fallback typing) reset HIDIdleTime; an
// owner's last input within this slack of when the fleet's last finished key
// or typing call posted it is the fleet's. Accessibility clicks post no HID event.
const OWN_INPUT_SLACK_MS = 1500;
// How long after a key or typing call starts (typing time added) OCU can
// still be posting its input, before the call's closing snapshot.
const OWN_INPUT_POST_MS = 5000;
// Frontmost while the screen saver runs or the login window shows.
const SCREEN_SAVER_APPS = new Set(["com.apple.ScreenSaver.Engine", "com.apple.loginwindow"]);
const PERMISSION_OK_TTL_MS = 10 * MIN;
// `doctor` opens Open Computer Use's onboarding window when a grant is
// missing, so a failed probe is not repeated every tick.
const PERMISSION_FAIL_TTL_MS = 30 * MIN;
const CONFIRM_CHARS = 60;
const TOKEN_MAX = 40;
// A first-message title this short ("continue") proves nothing.
const ALT_TOKEN_MIN = 12;
const EVIDENCE_KEPT = 200;
const SNIPPET_MAX = 64 * 1024;
const DETAIL_MAX = 200;
const TYPING_MS_PER_CHAR = 25;
// A remote caller's deadline is the main's clock and its answer needs the
// trip back: the driver ends this long before it.
const DEADLINE_MARGIN_MS = 5000;
const ALLOWED_BUNDLES = new Set(Object.values(UI_APPS).map((app) => app.bundleId));

// ---------------------------------------------------------------------------
// Text helpers

// A newline typed into a composer presses Return and sends early, so every
// message goes in as one line.
export function flattenMessage(text) {
  return String(text ?? "")
    .replace(/[\r\n\u2028\u2029\u0085]+/g, " ")
    .replace(/[\t\v\f]/g, " ")
    .replace(/[\u0000-\u0008\u000e-\u001f\u007f]/g, "")
    .replace(/ {2,}/g, " ")
    .trim();
}

// Whitespace-insensitive comparison form for text read back from the UI.
export function normalizeUiText(text) {
  return String(text ?? "")
    .replace(/[\u200b\u200c\u200d\ufeff]/g, "")
    .replace(/[\s\u00a0]+/g, " ")
    .trim();
}

function detailText(value) {
  return clampText(redactSecrets(value), DETAIL_MAX);
}

// Lowercased, bounded identity token; UIs truncate long titles.
export function identityToken(value) {
  const text = normalizeUiText(String(value ?? "").replace(/<[^>]{0,200}>/g, " ").replace(/(…|\.\.\.)$/, "")).toLowerCase();
  const cut = text.slice(0, TOKEN_MAX).trim();
  return cut.length >= 3 ? cut : null;
}

// ---------------------------------------------------------------------------
// Open Computer Use app state

// Role phrases OCU prints before an element's label (AX role descriptions).
// Longest first so "search text field" is not read as "search".
const ROLE_PHRASES = [
  "search text field", "secure text field", "text entry area", "standard window", "disclosure triangle", "pop up button", "html content",
  "menu bar item", "radio button", "menu button", "outline row", "scroll area", "value indicator", "static text", "text field",
  "text area", "text view", "check box", "combo box", "menu item", "tab group", "split group", "web area", "scroll bar",
  "heading", "button", "link", "row", "cell", "tab", "group", "image", "list", "table", "outline", "toolbar", "dialog", "sheet",
  "window", "form"
].sort((a, b) => b.length - a.length);
const FIELD_MARKER = /(?:^|,?\s+)(Value|Placeholder|ID|Description|Help|Title|URL): /g;
const EDITABLE_ROLES = new Set(["text entry area", "text area", "text field", "text view", "combo box"]);
const HEADING_ROLE = /^heading$/;
// The page itself: Codex labels it with the open thread's title, Conductor
// puts the open workspace and session ids in its URL.
const WEB_AREA_ROLE = /^(html content|web area)$/;
const BUTTON_ROLE = /button$/;
const COMPOSER_HINT = /composer|message|prompt|reply|follow[- ]?up|ask (?:codex|anything)|do anything|type a|send a/i;
// The app's own page; any other web area is an in-app browser tab (Codex's
// shows GitHub, whose comment box is no composer).
const OWN_PAGE = { "com.openai.codex": /^app:\/\//, "com.conductor.app": /^tauri:\/\/localhost/ };
const STOP_LABEL = /^(stop|stop generating|stop response|stop agent|interrupt|cancel turn)\b/i;
const PROMPT_LABEL = /^(allow|allow once|always allow|allow for (?:this )?session|approve|deny|don't allow|do not allow|reject|yes, allow)\b/i;
const SEND_LABEL = /^(send|send message|submit)\b/i;

function parseElementLine(depth, id, rest) {
  let body = String(rest ?? "");
  const secondary = body.search(/,? Secondary Actions: /);
  if (secondary >= 0) body = body.slice(0, secondary);
  const lower = body.toLowerCase();
  let role = ROLE_PHRASES.find((phrase) => lower === phrase || lower.startsWith(`${phrase} `) || lower.startsWith(`${phrase}(`) || lower.startsWith(`${phrase},`));
  if (!role) role = lower.split(/[\s(,]/)[0] ?? "";
  body = body.slice(role.length).trim();
  let flags = [];
  const flagMatch = /^\(([^)]*)\)\s*/.exec(body);
  if (flagMatch) {
    flags = flagMatch[1].split(",").map((flag) => flag.trim().toLowerCase()).filter(Boolean);
    body = body.slice(flagMatch[0].length);
  }
  const fields = {};
  const markers = [...body.matchAll(FIELD_MARKER)];
  const label = (markers.length ? body.slice(0, markers[0].index) : body).replace(/[,\s]+$/, "").trim();
  markers.forEach((match, index) => {
    const start = match.index + match[0].length;
    const end = index + 1 < markers.length ? markers[index + 1].index : body.length;
    fields[match[1].toLowerCase()] = body.slice(start, end).replace(/,\s*$/, "");
  });
  const value = fields.value ?? "";
  const search = normalizeUiText([label, value, fields.title, fields.description, fields.help, fields.id].filter(Boolean).join(" ")).toLowerCase();
  const hint = normalizeUiText([label, fields.placeholder, fields.description, fields.help, fields.id].filter(Boolean).join(" "));
  return {
    id: String(id), depth, role, flags, label, value, fields, search, hint,
    selected: flags.includes("selected"),
    focused: flags.includes("focused"),
    disabled: flags.includes("disabled") || flags.includes("dimmed")
  };
}

// Parses OCU get_app_state output: "App=<bundle> (pid N)", `Window: "<title>",
// App: <name>.`, one "<indent><index> <role> ..." line per element, and an
// optional "The focused UI element is <index> ..." line.
export function parseAppState(result) {
  const content = Array.isArray(result?.content) ? result.content : [];
  const text = content.filter((item) => item?.type === "text" && typeof item.text === "string").map((item) => item.text).join("\n");
  const image = content.find((item) => item?.type === "image" && item.mimeType === "image/png" && typeof item.data === "string")?.data ?? null;
  const lines = text.split("\n");
  const header = /^App=(\S+) \(pid (\d+)\)/.exec(lines[0] ?? "");
  let windowTitle = "";
  const windowMatch = /^Window: ("(?:[^"\\]|\\.)*"), App: /.exec(lines[1] ?? "");
  if (windowMatch) {
    try { windowTitle = String(JSON.parse(windowMatch[1])); } catch { windowTitle = windowMatch[1].slice(1, -1); }
  }
  const elements = [];
  for (const line of lines.slice(header ? 1 : 0)) {
    const match = /^(\s*)(\d+) (.+)$/.exec(line);
    if (!match) continue;
    elements.push(parseElementLine(match[1].replace(/\t/g, "  ").length, match[2], match[3]));
  }
  // Parents from indentation, for "inside the composer form" hints.
  const stack = [];
  for (const element of elements) {
    while (stack.length && stack[stack.length - 1].depth >= element.depth) stack.pop();
    element.parent = stack[stack.length - 1] ?? null;
    stack.push(element);
  }
  const focusedMatch = /The focused UI element is\s+(\d+)\b/.exec(text);
  return {
    bundleId: header?.[1] ?? null,
    pid: header ? Number(header[2]) : null,
    windowTitle,
    elements,
    focusedId: focusedMatch?.[1] ?? null,
    text,
    image
  };
}

function ancestors(element) {
  const out = [];
  for (let node = element?.parent; node; node = node.parent) out.push(node);
  return out;
}

function isEditable(element) {
  if (EDITABLE_ROLES.has(element.role)) return true;
  return element.flags.includes("settable") && /text/.test(element.role) && !/search|secure/.test(element.role);
}

function inOtherPage(element, ownPage) {
  const page = ancestors(element).find((node) => WEB_AREA_ROLE.test(node.role));
  return Boolean(page) && !ownPage.test(String(page.fields.url ?? ""));
}

// Exactly one composer: prefer editables labelled (or inside a form labelled)
// like a composer; with none labelled, a single editable is the composer.
// Never a combo box (URL bar, "Search chats"), never inside an in-app
// browser page, and in Conductor only inside its "composer" container (its
// "Terminal input" is a shell).
export function findComposer(state, bundleId = state?.bundleId) {
  const ownPage = OWN_PAGE[bundleId] ?? null;
  const editables = (state?.elements ?? []).filter((element) => isEditable(element) && element.role !== "combo box"
    && !(ownPage && inOtherPage(element, ownPage))
    && !(bundleId === "com.conductor.app" && (/terminal input/i.test(element.hint)
      || !ancestors(element).some((node) => normalizeUiText(node.label).toLowerCase() === "composer"))));
  if (!editables.length) return { composer: null, reason: "composer not found" };
  const hinted = editables.filter((element) => COMPOSER_HINT.test(element.hint) || ancestors(element).some((node) => COMPOSER_HINT.test(node.hint)));
  const pool = hinted.length ? hinted : editables;
  if (pool.length === 1) return { composer: pool[0], reason: null };
  return { composer: null, reason: `composer ambiguous (${pool.length} text areas)` };
}

function buttonLabel(element) {
  return normalizeUiText(element.label || element.fields.description || element.fields.title || "");
}

export function hasStopButton(state) {
  return (state?.elements ?? []).some((element) => BUTTON_ROLE.test(element.role) && STOP_LABEL.test(buttonLabel(element)));
}

export function hasPermissionPrompt(state) {
  return (state?.elements ?? []).some((element) => BUTTON_ROLE.test(element.role) && PROMPT_LABEL.test(buttonLabel(element)));
}

export function findSendButton(state) {
  const buttons = (state?.elements ?? []).filter((element) => BUTTON_ROLE.test(element.role) && !element.disabled && SEND_LABEL.test(buttonLabel(element)));
  return buttons.length === 1 ? buttons[0] : null;
}

// True when the composer holds (part of) the text this delivery typed. Only
// then is it ours to clear: a changed thread can show the owner's own draft.
export function looksLikeOurs(value, text) {
  const have = normalizeUiText(value);
  const ours = normalizeUiText(text);
  if (!have || !ours) return false;
  if (ours.startsWith(have)) return have.length >= Math.min(ours.length, SUPERVISOR_PREFIX.length);
  return have.startsWith(ours.slice(0, Math.min(ours.length, SUPERVISOR_PREFIX.length + 10)));
}

// Only OCU's focus line counts; it prints one only for the frontmost app.
export function isComposerFocused(state, composer) {
  return Boolean(composer) && state?.focusedId === composer.id;
}

// How many transcript elements show the needle. Text fields never count: a
// composer (recognised or not) holding our text is not a sent message.
export function transcriptCount(state, needle, composer = null) {
  const want = normalizeUiText(needle).toLowerCase();
  if (!want) return 0;
  return (state?.elements ?? []).filter((element) => element !== composer && element.id !== composer?.id && !isEditable(element)
    && normalizeUiText(`${element.label} ${element.value}`).toLowerCase().includes(want)).length;
}

function labelToken(element) {
  return identityToken(element.label || element.fields.title || element.fields.description || "");
}

// The thread is shown only if every identity token is in the window title or
// a selected element (sidebar row, tab), or is exactly a heading. Plain
// transcript or sidebar text is not enough: a manager thread's transcript can
// name every other workspace. A selected element or window title that is
// exactly another known thread of the same app is a mismatch, whatever else
// matched. altTokens (Codex's first-message label) prove it only as exactly
// the app's own page label, when the name does not, never past a conflict;
// byAlt then says so (steps accept that only after a link).
export function verifyIdentity(state, identity) {
  const tokens = identity?.tokens ?? [];
  if (!state) return { ok: false, reason: "no app state" };
  const webAreas = state.elements.filter((element) => WEB_AREA_ROLE.test(element.role));
  // Conductor's page URL names the open workspace and session: exact proof,
  // whatever the sidebar or tab titles say.
  if (identity?.ids) {
    const shownIds = webAreas.map((element) => conductorIds(element.fields.url)).find((ids) => ids.workspaceId);
    if (shownIds) {
      if (shownIds.workspaceId === identity.ids.workspaceId && shownIds.sessionId === identity.ids.sessionId) return { ok: true, reason: null };
      return { ok: false, reason: shownIds.sessionId ? "could not verify thread: another session is open" : "could not verify thread: no session tab open" };
    }
  }
  if (!tokens.length) return { ok: false, reason: "nothing to verify the thread by" };
  const title = normalizeUiText(state.windowTitle).toLowerCase();
  const selected = state.elements.filter((element) => element.selected);
  const headings = state.elements.filter((element) => HEADING_ROLE.test(element.role));
  // Exactly the page label, never text inside it: a transcript can name
  // every other thread.
  const pages = webAreas.map(labelToken).filter(Boolean);
  // A heading can be markdown in any thread's transcript, and an in-app
  // browser page can carry any title: a first message only as the app's page.
  const ownPage = OWN_PAGE[state.bundleId];
  const appPages = webAreas.filter((element) => !ownPage || ownPage.test(String(element.fields.url ?? ""))).map(labelToken).filter(Boolean);
  const shown = new Set([identityToken(state.windowTitle), ...selected.map(labelToken), ...pages].filter(Boolean));
  const altTokens = identity?.altTokens ?? [];
  for (const other of identity?.conflicts ?? []) {
    if (!tokens.includes(other) && !altTokens.includes(other) && shown.has(other)) return { ok: false, reason: "could not verify thread: another thread is open" };
  }
  const labelled = (token) => headings.some((element) => labelToken(element) === token) || pages.includes(token);
  const found = (token) => title.includes(token)
    || selected.some((element) => element.search.includes(token))
    || labelled(token);
  const missing = tokens.find((token) => !found(token));
  if (!missing) return { ok: true, reason: null };
  // A selected browser tab or the window title can hold any text.
  if (altTokens.length && altTokens.every((token) => appPages.includes(token))) return { ok: true, reason: null, byAlt: true };
  return { ok: false, reason: `could not verify thread: "${missing}" is not the open thread` };
}

// Workspace and session ids from a Conductor page URL, e.g.
// tauri://localhost/repository/<r>/workspace/<w>?activeTabType=session&sessionId=<s>
export function conductorIds(url) {
  const text = String(url ?? "");
  const workspaceId = /\/workspace\/([\w-]{1,80})(?:[/?#]|$)/.exec(text)?.[1] ?? null;
  const sessionId = /[?&]sessionId=([\w-]{1,80})(?:&|#|$)/.exec(text)?.[1] ?? null;
  return { workspaceId, sessionId };
}

// ---------------------------------------------------------------------------
// Which thread tokens prove the right thread is open

function isUntitled(value, extra = []) {
  const token = identityToken(value);
  return !token || token === "untitled" || extra.some((other) => other && identityToken(other) === token);
}

const distinct = (values, mine) => [...new Set(values.filter((value) => value && !mine.includes(value)))];

// Names that prove a Conductor session when its page shows no URL.
function conductorIdentity(target, others) {
  const blocked = (reason, ambiguous = true) => ({ tokens: [], conflicts: [], ambiguous, reason });
  const workspace = identityToken(target.workspace);
  if (!workspace) return blocked("no workspace name to verify", false);
  const elsewhere = others.filter(({ target: t }) => t.workspaceId !== target.workspaceId);
  if (elsewhere.some(({ target: t }) => identityToken(t.workspace) === workspace)) return blocked("ambiguous: two workspaces share this name");
  const siblings = others.filter(({ target: t }) => t.workspaceId === target.workspaceId && t.sessionId !== target.sessionId);
  const workspaceConflicts = elsewhere.map(({ target: t }) => identityToken(t.workspace));
  // One tab: the workspace name proves it. More tabs, or a count the
  // source could not read: the tab title must be shown too.
  if (!siblings.length && target.sessionCount === 1) {
    return { tokens: [workspace], conflicts: distinct(workspaceConflicts, [workspace]), ambiguous: false, reason: null };
  }
  const title = identityToken(target.title);
  if (isUntitled(target.title, [target.workspace, target.sessionId])) {
    return blocked("ambiguous: several sessions in the workspace and this one has no title");
  }
  if (target.titleShared || siblings.some(({ target: t }) => identityToken(t.title) === title)) {
    return blocked("ambiguous: two sessions share this title");
  }
  const siblingTitles = siblings.map(({ target: t }) => identityToken(t.title));
  return { tokens: [workspace, title], conflicts: distinct([...workspaceConflicts, ...siblingTitles], [workspace, title]), ambiguous: false, reason: null };
}

// threads: every thread the supervisor knows, to detect shared names and to
// recognise another thread being open (conflicts).
export function uiIdentity(thread, target, threads = []) {
  if (!target) return { tokens: [], conflicts: [], ambiguous: false, reason: "no app shows this thread" };
  const others = (threads ?? []).filter((other) => other && other.key !== thread?.key && !other.archived)
    .map((other) => ({ other, target: uiTargetFor(other) }))
    .filter((entry) => entry.target && entry.target.app === target.app && entry.target.targetKey !== target.targetKey);
  const blocked = (reason, ambiguous = true) => ({ tokens: [], conflicts: [], ambiguous, reason });
  if (target.app === "conductor") {
    const legacy = conductorIdentity(target, others);
    // The page URL proves the session by id, so shared or missing names do
    // not matter there; the names stay for Conductor builds without it.
    if (target.workspaceId && target.sessionId) {
      const tab = isUntitled(target.title, [target.workspace, target.sessionId]) ? null : identityToken(target.title);
      return { ...legacy, ids: { workspaceId: target.workspaceId, sessionId: target.sessionId }, tab, ambiguous: false, reason: null };
    }
    return legacy;
  }
  const title = identityToken(target.title);
  if (!title || /^codex [0-9a-f-]{8}$/i.test(title)) return blocked("no thread title to verify", false);
  // Another thread labelled by its first message can show our name too.
  if (target.titleShared || others.some(({ target: t }) => identityToken(t.title) === title || identityToken(t.altTitle) === title)) {
    // The title cannot tell the twins apart; only a deep link by id that
    // visibly moves the app onto that title can (see steps).
    return { ...blocked("ambiguous: two threads share this title"), tokens: [title], shared: true };
  }
  const otherLabels = others.flatMap(({ target: t }) => [identityToken(t.title), identityToken(t.altTitle)]);
  // The first message proves the thread only when no other thread can be
  // labelled with it.
  const alt = identityToken(target.altTitle);
  const altTokens = alt && alt.length >= ALT_TOKEN_MIN && alt !== title && !target.altTitleShared && !otherLabels.includes(alt) ? [alt] : [];
  return { tokens: [title], altTokens, conflicts: distinct(otherLabels, [title, ...altTokens]), ambiguous: false, reason: null };
}

// ---------------------------------------------------------------------------
// Presence and session probes (no permissions needed)

export function parseFrontAsn(stdout) {
  return /(ASN:0x[0-9a-f]+-0x[0-9a-f]+:?)/i.exec(String(stdout ?? ""))?.[1] ?? null;
}

export function parseBundleIdLine(stdout) {
  return /bundleID="([^"]+)"/.exec(String(stdout ?? ""))?.[1] ?? null;
}

// ioreg reports HIDIdleTime in nanoseconds.
export function parseIdleMs(stdout) {
  const match = /"HIDIdleTime"\s*=\s*(\d+)/.exec(String(stdout ?? ""));
  return match ? Math.floor(Number(match[1]) / 1e6) : null;
}

export function parseConsoleSession(stdout) {
  const text = String(stdout ?? "");
  if (!/IOConsoleUsers|IOConsoleLocked/.test(text)) return null;
  // Every session dictionary counts (fast user switching lists several):
  // any holder blocks typing.
  const securePid = [...text.matchAll(/"kCGSSessionSecureInputPID"\s*=\s*(\d+)/g)].map((match) => Number(match[1])).find((pid) => pid > 0) ?? 0;
  return {
    locked: /"IOConsoleLocked"\s*=\s*Yes/.test(text) || /"CGSSessionScreenIsLocked"\s*=\s*Yes/.test(text),
    secureInput: securePid > 0,
    secureInputPid: securePid > 0 ? securePid : null,
    onConsole: /"kCGSSessionOnConsoleKey"\s*=\s*Yes/.test(text) ? true : /"kCGSSessionOnConsoleKey"\s*=\s*No/.test(text) ? false : null
  };
}

// "/Applications/BuildBetter Staging.app/Contents/MacOS/BuildBetter Staging" -> "BuildBetter Staging".
export function appNameFromPath(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const bundle = /([^/]+)\.app(?:\/|$)/.exec(text)?.[1];
  return clampText(bundle ?? path.basename(text), 60) || null;
}

export function createPresenceProbe({ bins = {}, run = runCommand, timeoutMs = DEFAULTS.uiStepTimeoutMs, killGraceMs = DEFAULTS.uiKillGraceMs } = {}) {
  const exec = async (cmd, args) => {
    try {
      const result = await run(cmd, args, { timeoutMs, killGraceMs });
      return result && !result.error && !result.timedOut && result.code === 0 ? String(result.stdout ?? "") : null;
    } catch {
      return null;
    }
  };
  const lsappinfo = bins.lsappinfo ?? "lsappinfo";
  const ioreg = bins.ioreg ?? "ioreg";
  return {
    async frontApp() {
      const asn = parseFrontAsn(await exec(lsappinfo, ["front"]));
      return asn ? parseBundleIdLine(await exec(lsappinfo, ["info", "-only", "bundleID", asn])) : null;
    },
    async appRunning(bundleId) {
      const out = await exec(lsappinfo, ["find", `bundleid=${bundleId}`]);
      return out === null ? null : /ASN:/.test(out);
    },
    async idleMs() {
      return parseIdleMs(await exec(ioreg, ["-c", "IOHIDSystem", "-d", "4", "-r", "-k", "HIDIdleTime"]));
    },
    async session() {
      const session = parseConsoleSession(await exec(ioreg, ["-n", "Root", "-d1"]));
      // Which app holds secure input, so the owner knows what to click away from.
      if (session?.secureInputPid) session.secureInputApp = appNameFromPath(await exec(bins.ps ?? "ps", ["-o", "comm=", "-p", String(session.secureInputPid)]));
      return session;
    },
    // -g: do not bring the app forward. Only used while the owner is away.
    async openUrl(url) {
      const out = await exec(bins.open ?? "open", ["-g", url]);
      return out !== null;
    },
    // Brings a running app to the front (no -g). Only while the owner is away.
    async activate(bundleId) {
      const out = await exec(bins.open ?? "open", ["-b", bundleId]);
      return out !== null;
    }
  };
}

// ---------------------------------------------------------------------------
// App restart, only when an owner-written playbook asks (restart_apps)

// Some apps read a new login only at launch, so after the owner switches
// accounts their capped chats keep failing until the app restarts. Only the
// apps the fleet types into, never while the owner is using that app, and
// never a launch the owner did not ask for.
const RESTART_WAIT_MS = 30_000;
const RESTART_SETTLE_MS = 10_000;

export function createAppRestarter({ bins = {}, run = runCommand, probe = null, limits = DEFAULTS, now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  const presence = probe ?? createPresenceProbe({ bins, run, timeoutMs: limits.uiStepTimeoutMs });
  const waitFor = async (bundleId, want) => {
    const deadline = now() + RESTART_WAIT_MS;
    do {
      if ((await presence.appRunning(bundleId)) === want) return true;
      await sleep(1000);
    } while (now() < deadline);
    return false;
  };
  const exec = async (cmd, args) => {
    try { await run(cmd, args, { timeoutMs: limits.uiStepTimeoutMs }); } catch { /* checked by waitFor */ }
  };
  return {
    async restart(appKey) {
      const app = UI_APPS[appKey];
      if (!app) return { ok: false, detail: `${appKey} is not an app the fleet restarts` };
      const idle = await presence.idleMs();
      if ((await presence.frontApp()) === app.bundleId && !(idle !== null && idle >= limits.uiOwnerIdleMs)) return { ok: false, detail: `you are using ${app.name}` };
      if (await presence.appRunning(app.bundleId)) {
        // A quit the app holds up (an "are you sure" dialog) is not forced.
        await exec("osascript", ["-e", `tell application id "${app.bundleId}" to quit`]);
        if (!(await waitFor(app.bundleId, false))) return { ok: false, detail: `${app.name} did not quit` };
      }
      await exec(bins.open ?? "open", ["-g", "-b", app.bundleId]);
      if (!(await waitFor(app.bundleId, true))) return { ok: false, detail: `${app.name} did not start` };
      await sleep(RESTART_SETTLE_MS);
      return { ok: true, detail: `restarted ${app.name}` };
    }
  };
}

// ---------------------------------------------------------------------------
// One UI delivery at a time, process-wide

export function createUiLock() {
  let tail = Promise.resolve();
  let holders = 0;
  return {
    get busy() { return holders > 0; },
    // Resolves { busy: true } when the lock is not free within waitMs.
    async run(fn, { waitMs = Infinity } = {}) {
      const previous = tail;
      let release;
      const mine = new Promise((resolve) => { release = resolve; });
      tail = previous.then(() => mine);
      holders += 1;
      let timer = null;
      const waited = Number.isFinite(waitMs)
        ? await Promise.race([previous.then(() => true), new Promise((resolve) => { timer = setTimeout(() => resolve(false), Math.max(0, waitMs)); })])
        : await previous.then(() => true);
      if (timer) clearTimeout(timer);
      if (!waited) {
        // Keep the chain intact: this slot frees as soon as the one ahead does.
        previous.then(() => { holders -= 1; release(); });
        return { busy: true };
      }
      try {
        return { busy: false, value: await fn() };
      } finally {
        holders -= 1;
        release();
      }
    }
  };
}

export const UI_LOCK = createUiLock();

// Nothing cancels an input call that timed out in the app agent, and no
// estimate says when it ends: no delivery (a remote send included) types
// until its late answer shows it finished. If its engine exits first the
// agent may still be running it: typing stays paused until the daemon
// restarts. settled: the transport's inFlight promise ({ completed }).
export function createInputLatch() {
  const open = new Set();
  let orphaned = false;
  return {
    get held() { return orphaned || open.size > 0; },
    get detail() {
      if (orphaned) return "an earlier input call has not finished and its engine exited; typing paused until OpenAGI restarts";
      return open.size ? "an earlier input call has not finished; typing paused until it answers or OpenAGI restarts" : null;
    },
    hold(settled) {
      const token = {};
      open.add(token);
      Promise.resolve(settled).then((result) => {
        open.delete(token);
        if (result?.completed !== true) orphaned = true;
      }, () => {
        open.delete(token);
        orphaned = true;
      });
    }
  };
}

export const UI_INPUT_LATCH = createInputLatch();

// ---------------------------------------------------------------------------
// Evidence

function saveEvidence(dir, name, state) {
  if (!dir || !state) return null;
  try {
    ensureDir(dir);
    const safe = String(name).replace(/[^\w.-]+/g, "_").slice(0, 120);
    let file;
    if (state.image) {
      file = path.join(dir, `${safe}.png`);
      fs.writeFileSync(file, Buffer.from(state.image, "base64"), { mode: 0o600 });
    } else {
      file = path.join(dir, `${safe}.txt`);
      fs.writeFileSync(file, redactSecrets(state.text ?? "").slice(0, SNIPPET_MAX), { mode: 0o600 });
    }
    pruneEvidence(dir);
    return file;
  } catch {
    return null;
  }
}

function pruneEvidence(dir) {
  try {
    const files = fs.readdirSync(dir)
      .filter((name) => /\.(png|txt)$/.test(name))
      .map((name) => ({ file: path.join(dir, name), at: fs.statSync(path.join(dir, name)).mtimeMs }))
      .sort((a, b) => b.at - a.at);
    for (const { file } of files.slice(EVIDENCE_KEPT)) fs.rmSync(file, { force: true });
  } catch { /* best-effort */ }
}

// ---------------------------------------------------------------------------
// The driver

function isComputerUseEnabled(env = process.env) {
  // Same rule as isComputerUseEnabled in integrations/computer-use.js: the
  // dashboard toggle is the kill switch for every computer-use path.
  const value = String(env.OPENAGI_COMPUTER_USE ?? "").toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

function defaultBinaryReady(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return path.isAbsolute(file);
  } catch {
    return false;
  }
}

class StepError extends Error {}

export function createUiDriver({
  config = {},
  run = runCommand,
  probe = null,
  transportFactory = null,
  permissionProbe = null,
  activeSessions = () => [],
  computerUseEnabled = () => isComputerUseEnabled(),
  binaryReady = defaultBinaryReady,
  evidenceDir = null,
  inputLatch = UI_INPUT_LATCH,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
} = {}) {
  const limits = { ...DEFAULTS, ...(config.limits ?? {}) };
  const bins = config.bins ?? {};
  const presence = probe ?? createPresenceProbe({ bins, run, timeoutMs: limits.uiStepTimeoutMs, killGraceMs: limits.uiKillGraceMs });
  // The longest one presence command can take.
  const commandMs = limits.uiStepTimeoutMs + limits.uiKillGraceMs;
  const makeTransport = transportFactory ?? (({ timeoutMs }) => new OcuTransport(bins.ocu, { timeoutMs, appAgentProxy: true, agentNamespace: OCU_AGENT_NAMESPACE }));
  const readPermissions = permissionProbe
    ?? (async () => parseOcuPermissions(await readOcuPermissions(bins.ocu, undefined, { appAgentProxy: true, agentNamespace: OCU_AGENT_NAMESPACE, timeoutMs: limits.uiStepTimeoutMs })));
  let permissionCache = null;
  // When this driver's last key or typing input landed, across deliveries:
  // the next delivery in the same tick must not read it as the owner.
  let lastOwnInput = null;

  const permissions = async () => {
    const at = now();
    if (permissionCache && at - permissionCache.at < (permissionCache.ok ? PERMISSION_OK_TTL_MS : PERMISSION_FAIL_TTL_MS)) return permissionCache;
    let ok = false;
    let detail = "Open Computer Use needs Accessibility and Screen Recording on this Mac";
    try {
      const granted = await readPermissions();
      ok = Boolean(granted?.accessibility && granted?.screenRecording);
    } catch {
      detail = "Open Computer Use permission check failed";
    }
    permissionCache = { at, ok, detail: ok ? null : detail };
    return permissionCache;
  };

  // Fresh at every send; cheap enough to run once per tick as well.
  async function readiness() {
    const notReady = (detail) => ({ ready: false, detail });
    try {
      if (!computerUseEnabled()) return notReady("computer use is off (OPENAGI_COMPUTER_USE)");
      if (!bins.ocu || !binaryReady(bins.ocu)) return notReady("Open Computer Use not found: set OPENAGI_FLEET_OCU_PATH");
      let active = [];
      try { active = activeSessions() ?? []; } catch { active = []; }
      if (active.length) return notReady("an OpenAGI computer-use session is active");
      if (inputLatch.held) return notReady(inputLatch.detail);
      const session = await presence.session();
      if (!session) return notReady("screen state unknown");
      if (session.locked) return notReady("screen locked");
      if (session.secureInput) return notReady(`secure input is on: ${session.secureInputApp ? `${session.secureInputApp} has a password field focused` : "a password field has focus"}`);
      if (session.onConsole === false) return notReady("not the console session");
      const granted = await permissions();
      if (!granted.ok) return notReady(granted.detail);
      return { ready: true, detail: null };
    } catch (error) {
      return notReady(`readiness check failed: ${detailText(error?.message ?? error)}`);
    }
  }

  // request: { text, target, identity, previousUnconfirmed, evidenceName }
  async function deliver(request = {}) {
    const text = flattenMessage(request.text);
    // type_text is one call that can outlast a normal step on a long message.
    const typingMs = Math.ceil(text.length * TYPING_MS_PER_CHAR);
    const controller = new AbortController();
    // Not unref'd: the abort must fire even if a hung call holds nothing else open.
    // Typing comes out of the same budget (checked before it starts).
    // Clearing and putting the owner's app back get uiCleanupMs more and
    // never run past it, so a remote send ends inside the broker's 5 min.
    // spentMs: what the request already spent before this delivery (its
    // probes, earlier sends); both caps count from the request's start.
    // deadlineAt: when a remote caller stops waiting (the broker's expiry,
    // queue time before this Mac picked it up included): everything,
    // cleanup too, ends DEADLINE_MARGIN_MS before it.
    const start = now() - Math.max(0, Number(request.spentMs) || 0);
    const callerEndsAt = Number.isFinite(request.deadlineAt) ? request.deadlineAt - DEADLINE_MARGIN_MS : Infinity;
    const hardEndsAt = Math.min(start + limits.uiDeliveryTimeoutMs + limits.uiCleanupMs, callerEndsAt);
    const endsAt = Math.min(start + limits.uiDeliveryTimeoutMs, hardEndsAt - limits.uiCleanupMs);
    const timer = setTimeout(() => controller.abort(), Math.max(0, endsAt - now()));
    const ctx = { phase: "check", transport: null, evidence: [], text, request, typingMs, endsAt, deadline: endsAt, hardEndsAt,
      slowest: 0, ownInput: lastOwnInput, ownerSeen: false, activated: false, inFront: false, frontBefore: null, inputInFlight: false };
    try {
      return await steps(request, controller.signal, ctx);
    } catch (error) {
      return await recover(error, ctx, controller.signal.aborted || now() >= ctx.endsAt);
    } finally {
      clearTimeout(timer);
      await restoreFront(ctx);
      try { ctx.transport?.close(); } catch { /* already closed */ }
    }
  }

  // The owner's previous app goes back in front, only if the target is still
  // there and the owner has not come back (never pull an app from under them).
  // Never while an input call that timed out may still be running: it
  // would land in the owner's app.
  async function restoreFront(ctx) {
    const target = ctx.request.target;
    if (ctx.inputInFlight || !ctx.activated || ctx.ownerSeen || !ctx.frontBefore || ctx.frontBefore === target?.bundleId || SCREEN_SAVER_APPS.has(ctx.frontBefore)) return;
    // Each probe only if it ends inside the request's budget with every
    // command at its timeout and kill grace (frontApp runs two).
    const fits = (commands) => now() + commands * commandMs <= ctx.hardEndsAt;
    try {
      if (!fits(2) || (await presence.frontApp()) !== target.bundleId) return;
      if (!fits(1) || !ownerAway(ctx, await presence.idleMs())) return;
      // open -b launches an app that quit meanwhile; never that.
      if (!fits(1) || (await presence.appRunning(ctx.frontBefore)) !== true) return;
      if (fits(1)) await presence.activate(ctx.frontBefore);
    } catch { /* best-effort */ }
  }

  // Away: no input for uiOwnerIdleMs, or the last input is the driver's own
  // last key or typing (which reset the idle clock), as markOwnInput saw it.
  // Not the whole call: the owner can type during a slow one.
  function ownerAway(ctx, idle) {
    if (idle === null || idle === undefined) return false;
    if (idle >= limits.uiOwnerIdleMs) return true;
    if (!Number.isFinite(ctx.ownInput)) return false;
    return Math.abs(now() - idle - ctx.ownInput) <= OWN_INPUT_SLACK_MS;
  }

  // Once the owner is seen, only real idle time counts again: no discount
  // for the fleet's input, now or in the next delivery.
  function sawOwner(ctx) {
    ctx.ownerSeen = true;
    ctx.ownInput = lastOwnInput = null;
  }

  // No call runs past the deadline in force: the steps', then clearing's.
  function within(ctx, ms) {
    const left = ctx.deadline - now();
    if (left <= 0) throw new StepError("delivery timed out");
    return Math.min(ms, left);
  }

  // No probe starts past the deadline in force; the one running then (two
  // commands at most, kill grace included), or readiness (two commands and
  // the permission check), is what uiCleanupMs allows for.
  function probeNow(ctx, name, ...args) {
    if (now() >= ctx.deadline) throw new StepError("delivery timed out");
    return presence[name](...args);
  }

  // One OCU action. Each ends with a fresh snapshot, so it gets a read's
  // budget. Keys and typing may post HID events: only a call that finished
  // marks when (never after the owner was seen). One that timed out may
  // still be running (nothing cancels it): no more input after it.
  async function act(ctx, name, args, signal, { timeoutMs = limits.uiReadTimeoutMs, hid = false } = {}) {
    if (ctx.inputInFlight) throw new StepError("an input call timed out");
    const start = now();
    let result;
    try {
      result = await ctx.transport.call(name, args, signal, { timeoutMs: within(ctx, timeoutMs) });
    } catch (error) {
      if (error?.inFlight) {
        ctx.inputInFlight = true;
        inputLatch.hold(error.settled);
      }
      throw error;
    } finally {
      if (name !== "type_text") ctx.slowest = Math.max(ctx.slowest, now() - start);
    }
    if (hid && !ctx.ownerSeen) await markOwnInput(ctx, start, name === "type_text" ? ctx.typingMs : 0);
    return result;
  }

  // The input lands before the call's closing snapshot (10-25 s in Codex),
  // so the call's end is not when: the idle clock says. It is the fleet's
  // only inside the time the input itself takes; later input is the owner's.
  async function markOwnInput(ctx, start, inputMs) {
    if (now() + commandMs > ctx.deadline) return;
    try {
      const idle = await presence.idleMs();
      if (idle === null || idle === undefined) return;
      const at = now() - idle;
      if (at >= start - OWN_INPUT_SLACK_MS && at <= start + inputMs + OWN_INPUT_POST_MS) ctx.ownInput = lastOwnInput = at;
    } catch { /* nothing marked */ }
  }

  // An unconfirmed outcome carries how many copies the thread showed before
  // this attempt, so a retry needs a new copy, not any old one.
  const outcome = (ctx, status, detail, extra = {}) => ({
    status, detail: detailText(detail), evidence: ctx.evidence.length ? [...ctx.evidence] : undefined,
    ...(extra.unconfirmed && Number.isInteger(ctx.priorCount) ? { priorCount: ctx.priorCount } : {}),
    ...extra
  });

  const keep = (ctx, label, state) => {
    const file = saveEvidence(evidenceDir, `${ctx.request.evidenceName ?? `ui-${now()}`}-${label}`, state);
    if (file) ctx.evidence.push(file);
  };

  async function readState(ctx, signal) {
    if (signal?.aborted) throw new StepError("delivery timed out");
    const app = ctx.request.target.bundleId;
    const start = now();
    const result = await ctx.transport.call("get_app_state", { app, text_limit: "max", max_tree_nodes: STATE_TREE_NODES_BY_APP[app] ?? STATE_TREE_NODES }, signal, { timeoutMs: within(ctx, limits.uiReadTimeoutMs) });
    ctx.slowest = Math.max(ctx.slowest, now() - start);
    const state = parseAppState(result);
    if (state.bundleId && state.bundleId !== app) throw new StepError(`app state came from ${state.bundleId}`);
    return state;
  }

  const composerIn = (ctx, state) => findComposer(state, ctx.request.target.bundleId);

  // Accessibility only: it does not move the pointer or post events that
  // reset the owner's idle clock.
  const click = (ctx, element, signal) => act(ctx, "click", { app: ctx.request.target.bundleId, element_index: element.id, click_method: "accessibility" }, signal);

  const press = (ctx, key, signal) => act(ctx, "press_key", { app: ctx.request.target.bundleId, key }, signal, { hid: true });

  // Removes only what this delivery typed: the composer was proven empty
  // before typing, and it must now hold our text (or a start of it), so
  // select-all in the focused composer selects nothing of the owner's.
  // With the owner back, only exactly our text, already focused: they may
  // have added words, or be typing in another field a click would steal.
  async function clearComposer(ctx, signal, { ownerPresent = false } = {}) {
    try {
      let state = await readState(ctx, signal);
      let { composer } = composerIn(ctx, state);
      if (!composer) return false;
      if (!normalizeUiText(composer.value)) return true;
      if (!looksLikeOurs(composer.value, ctx.text) || !verifyIdentity(state, ctx.request.identity).ok) return false;
      if (ownerPresent && (normalizeUiText(composer.value) !== normalizeUiText(ctx.text) || !isComposerFocused(state, composer))) return false;
      if (!isComposerFocused(state, composer)) {
        await click(ctx, composer, signal);
        state = await readState(ctx, signal);
        ({ composer } = composerIn(ctx, state));
        if (!composer || !isComposerFocused(state, composer)) return false;
      }
      await press(ctx, "super+a", signal);
      await press(ctx, "BackSpace", signal);
      state = await readState(ctx, signal);
      ({ composer } = composerIn(ctx, state));
      return Boolean(composer) && !normalizeUiText(composer.value);
    } catch (error) {
      if (ctx.inputInFlight) throw error;
      return false;
    }
  }

  // Null while it is still safe to go on. Once the target is in front it
  // must stay there: typing goes to the frontmost app.
  async function ownerCheck(ctx, target) {
    const reason = await ownerReason(ctx, target);
    if (reason) sawOwner(ctx);
    return reason;
  }

  async function ownerReason(ctx, target) {
    const front = await probeNow(ctx, "frontApp");
    // It can start during a slow read: nothing comes forward over it.
    if (SCREEN_SAVER_APPS.has(front)) return "screen saver on";
    const idle = await probeNow(ctx, "idleMs");
    if (!ownerAway(ctx, idle)) {
      if (front === target.bundleId || front === null) return `owner using ${target.name}`;
      if (!ctx.inFront) return `waiting for idle: ${target.name} must be in front to type`;
    }
    if (front === null) return "front app unknown";
    if (ctx.inFront && front !== target.bundleId) return "frontmost app changed";
    return null;
  }

  async function bringToFront(ctx, target) {
    // open -b launches an app that quit meanwhile; never that.
    if ((await probeNow(ctx, "appRunning", target.bundleId)) !== true) return false;
    if (!(await probeNow(ctx, "activate", target.bundleId))) return false;
    ctx.activated = true;
    const deadline = now() + limits.uiActivateMs;
    do {
      if ((await probeNow(ctx, "frontApp")) === target.bundleId) return true;
      await sleep(limits.uiPollMs);
    } while (now() < deadline);
    return (await probeNow(ctx, "frontApp")) === target.bundleId;
  }

  async function steps(request, signal, ctx) {
    const { target, identity = { tokens: [] } } = request;
    const text = ctx.text;
    if (!target?.bundleId) return outcome(ctx, "blocked", "no app shows this thread");
    // Only the apps in UI_APPS are ever driven.
    if (!ALLOWED_BUNDLES.has(target.bundleId)) return outcome(ctx, "blocked", `${target.bundleId} is not an app the fleet types into`);
    if (!text) return outcome(ctx, "blocked", "empty message");
    // Not ready, like readiness says: the paused-nudge alert tells the owner.
    if (inputLatch.held) return outcome(ctx, "blocked", `computer use not ready: ${inputLatch.detail}; nothing typed`);
    if (now() >= ctx.endsAt) return outcome(ctx, "blocked", "no time left in this request for another app send; nothing typed, retry");

    // 0. Readiness, fresh.
    const ready = await readiness();
    if (!ready.ready) return outcome(ctx, "blocked", `computer use not ready: ${ready.detail}`);
    // A shared title goes on only through its id link (checked below).
    if (identity.ambiguous && !(identity.shared && target.deepLink)) return outcome(ctx, "blocked", identity.reason ?? "ambiguous thread");
    if (!identity.tokens?.length && !identity.ids) return outcome(ctx, "blocked", identity.reason ?? "nothing to verify the thread by");

    // 1. Presence: never launch the app; act only while the owner is away,
    // since typing needs the app in front. Readiness may have used up the
    // request's time: no probe starts past it.
    const running = await probeNow(ctx, "appRunning", target.bundleId);
    if (running === null) return outcome(ctx, "blocked", `could not tell whether ${target.name} is running`);
    if (!running) return outcome(ctx, "blocked", `${target.name} is not running`);
    const frontBefore = await probeNow(ctx, "frontApp");
    if (SCREEN_SAVER_APPS.has(frontBefore)) return outcome(ctx, "blocked", "screen saver on");
    if (!ownerAway(ctx, await probeNow(ctx, "idleMs"))) {
      sawOwner(ctx);
      if (frontBefore === target.bundleId || frontBefore === null) return outcome(ctx, "blocked", `owner using ${target.name}`);
      return outcome(ctx, "blocked", `waiting for idle: ${target.name} must be in front to type`);
    }
    // Unknown is not safe: a failed probe can hide the screen saver, and the
    // owner's app could not be put back.
    if (frontBefore === null) return outcome(ctx, "blocked", "front app unknown");
    ctx.frontBefore = frontBefore;

    // 2. Navigate to the thread: the deep link, in the background. A read
    // can take tens of seconds, so the owner is checked again after it.
    ctx.transport = makeTransport({ timeoutMs: limits.uiStepTimeoutMs });
    let state = await readState(ctx, signal);
    let verified = verifyIdentity(state, identity);
    // A twin may be the one on screen: only the id link, starting from
    // another thread, proves which one opened.
    if (identity.shared && verified.ok) return outcome(ctx, "blocked", `${identity.reason}; a thread with that title is already open`);
    // Likewise a first-message label: a thread the catalog does not label
    // that way can show it. It counts only once a link moved the app onto it.
    if (verified.byAlt) return outcome(ctx, "blocked", "could not verify thread: only its first message is shown, which another thread can show too; open another thread");
    if (!verified.ok) {
      const back = await ownerCheck(ctx, target);
      if (back) return outcome(ctx, "blocked", back);
      if (!(await probeNow(ctx, "openUrl", target.deepLink))) return outcome(ctx, "blocked", `could not open the ${target.name} link`);
      // The link can bring the app forward itself (Codex does): the owner's
      // app is put back at the end all the same.
      ctx.activated = true;
      // At least two reads, even when the first matches: the sidebar row
      // can switch before the page and composer do. The latest read decides,
      // and only its elements are used.
      const deadline = now() + (SLOW_NAVIGATION.has(target.bundleId) ? limits.uiNavigateSlowMs : limits.uiNavigateMs);
      let reads = 0;
      do {
        await sleep(limits.uiPollMs);
        state = await readState(ctx, signal);
        reads += 1;
        verified = verifyIdentity(state, identity);
      } while (reads < 2 || (!verified.ok && now() < deadline));
      if (!verified.ok) return outcome(ctx, "blocked", verified.reason);
    }

    // 3. The app in front, then the thread checked again. Fresh owner check
    // first: nothing comes forward over an owner who came back.
    const moved = await ownerCheck(ctx, target);
    if (moved) return outcome(ctx, "blocked", moved);
    if ((await probeNow(ctx, "frontApp")) !== target.bundleId) {
      if (!(await bringToFront(ctx, target))) return outcome(ctx, "blocked", `could not bring ${target.name} to the front`);
      state = await readState(ctx, signal);
      verified = verifyIdentity(state, identity);
      if (!verified.ok) return outcome(ctx, "blocked", verified.reason);
    }
    ctx.inFront = true;

    // 4. Guards on what the thread shows.
    if (hasStopButton(state)) return outcome(ctx, "blocked", "turn running (Stop is visible)");
    if (hasPermissionPrompt(state)) return outcome(ctx, "blocked", "permission prompt visible: open it");
    const needle = text.slice(0, SUPERVISOR_PREFIX.length + 1 + CONFIRM_CHARS);
    const copies = transcriptCount(state, text);
    if (request.previousUnconfirmed) {
      const prior = Number.isInteger(request.previousUnconfirmed.priorCount) ? request.previousUnconfirmed.priorCount : 0;
      if (copies > prior) {
        keep(ctx, "before", state);
        return outcome(ctx, "sent", "already in thread (the earlier unconfirmed send landed)");
      }
      // Fewer copies than before the uncertain send: the transcript is not
      // all on screen, so it cannot tell whether that send landed.
      if (copies < prior) return outcome(ctx, "blocked", "cannot tell whether the earlier unconfirmed send landed; check the thread");
    }
    ctx.priorCount = copies;

    // 5. Composer: exactly one, and empty. Exactly this message left unsent
    // by an earlier attempt is ours: it is sent as is, never retyped.
    let found = composerIn(ctx, state);
    if (!found.composer) return outcome(ctx, "blocked", found.reason);
    const leftover = normalizeUiText(found.composer.value) === normalizeUiText(text);
    if (normalizeUiText(found.composer.value) && !leftover) return outcome(ctx, "blocked", "draft in composer: not overwriting it");
    const beforeCount = transcriptCount(state, needle, found.composer);
    keep(ctx, "before", state);
    const holds = (composer) => normalizeUiText(composer.value) === (leftover ? normalizeUiText(text) : "");

    // 6. Focus the composer with an accessibility click; OCU reports focus
    // only for the frontmost app, so that is checked first.
    const beforeFocus = await ownerCheck(ctx, target);
    if (beforeFocus) return outcome(ctx, "blocked", beforeFocus);
    if (!isComposerFocused(state, found.composer)) {
      await click(ctx, found.composer, signal);
      state = await readState(ctx, signal);
      found = composerIn(ctx, state);
    }
    if (!found.composer || !isComposerFocused(state, found.composer)) return outcome(ctx, "failed", "could not focus the composer; nothing typed");
    if (!holds(found.composer)) return outcome(ctx, "blocked", "draft in composer: not overwriting it");
    if (!verifyIdentity(state, identity).ok) return outcome(ctx, "blocked", "thread changed before typing");

    // 7. Type, one line, only with time left to type, read, send and read
    // the confirmation at this delivery's slowest call: cut short after the
    // send, a delivery can only report "may have been sent". The owner once
    // more, right before: the click and read above can take tens of seconds.
    const left = ctx.endsAt - now();
    if (left < (leftover ? 3 : 4) * ctx.slowest + (leftover ? 0 : ctx.typingMs)) {
      return outcome(ctx, "blocked", `not enough time left to type and confirm (${Math.round(left / 1000)} s); nothing typed`);
    }
    const beforeTyping = await ownerCheck(ctx, target);
    if (beforeTyping) return outcome(ctx, "blocked", beforeTyping);
    ctx.phase = "typing";
    if (!leftover) await act(ctx, "type_text", { app: target.bundleId, text }, signal, { timeoutMs: limits.uiReadTimeoutMs + ctx.typingMs, hid: true });
    ctx.phase = "typed";

    // 8. Same thread, and the composer holds exactly our text.
    state = await readState(ctx, signal);
    if (!verifyIdentity(state, identity).ok) {
      // Our text stays with the thread it was typed into; the thread on
      // screen now may hold the owner's draft, so nothing is cleared.
      keep(ctx, "after", state);
      return outcome(ctx, "blocked", "thread changed before send; our text may be left as a draft in the thread, check it");
    }
    found = composerIn(ctx, state);
    // The owner first: text that does not match may be theirs.
    const back = await ownerCheck(ctx, target);
    if (back) {
      const cleared = await clearComposer(ctx, signal, { ownerPresent: true });
      return outcome(ctx, "blocked", `${back}; ${cleared ? "cleared our text" : "our text may still be in the composer"}`);
    }
    if (!found.composer || normalizeUiText(found.composer.value) !== normalizeUiText(text)) {
      const cleared = await clearComposer(ctx, signal);
      keep(ctx, "after", state);
      return outcome(ctx, "failed", `text mismatch, not sent${cleared ? "; cleared our text" : "; could not clear the composer, check it"}`);
    }
    const changed = hasStopButton(state) ? "turn started before send"
      : hasPermissionPrompt(state) ? "permission prompt appeared before send"
      : null;
    if (changed) {
      const cleared = await clearComposer(ctx, signal);
      return outcome(ctx, "blocked", `${changed}; ${cleared ? "cleared our text" : "could not clear the composer, check it"}`);
    }

    // 9. Send: the Send button, else Return in the focused composer.
    ctx.phase = "sending";
    const send = findSendButton(state);
    let pressed = false;
    if (send) {
      try {
        await click(ctx, send, signal);
        pressed = true;
      } catch (error) {
        if (ctx.inputInFlight) throw error;
        // Press Return only if the click provably did nothing.
        const after = await readState(ctx, signal);
        const again = composerIn(ctx, after).composer;
        if (!again || normalizeUiText(again.value) !== normalizeUiText(text) || transcriptCount(after, needle, again) > beforeCount) {
          ctx.phase = "sent";
          throw new StepError("send click failed midway");
        }
      }
    }
    if (!pressed) await press(ctx, "Return", signal);
    ctx.phase = "sent";

    // 10. Confirm: composer empty and one more transcript copy of our text.
    const deadline = now() + limits.uiConfirmMs;
    do {
      await sleep(limits.uiPollMs);
      state = await readState(ctx, signal);
      const composer = composerIn(ctx, state).composer;
      const empty = composer ? !normalizeUiText(composer.value) : false;
      if (empty && transcriptCount(state, needle, composer) > beforeCount) {
        keep(ctx, "after", state);
        return outcome(ctx, "sent", leftover ? `sent the text an earlier attempt left in ${target.name}` : `typed into ${target.name}`);
      }
    } while (now() < deadline);
    keep(ctx, "after", state);
    return outcome(ctx, "failed", "unconfirmed: may have been sent; check the thread before retrying", { unconfirmed: true });
  }

  // An input call that timed out may still be running: nothing is cleared,
  // typed, or brought forward after it. Worded to stop the tick's other app
  // sends too (supervisor UI_STALLED).
  const inFlightOutcome = (ctx) => outcome(ctx, "failed", "Open Computer Use timed out on input; unconfirmed: check the thread before retrying", { unconfirmed: true });

  async function recover(error, ctx, timedOut) {
    if (ctx.inputInFlight) return inFlightOutcome(ctx);
    const reason = timedOut ? "delivery timed out" : detailText(error?.message ?? error) || "Open Computer Use error";
    if (ctx.phase === "check") return outcome(ctx, "failed", `${reason}; nothing typed`);
    if (ctx.phase === "sending" || ctx.phase === "sent") {
      return outcome(ctx, "failed", `${reason}; unconfirmed: may have been sent; check the thread before retrying`, { unconfirmed: true });
    }
    // Typed, not sent: a fresh engine clears our text, bounded by about
    // two slow reads and by what is left of uiCleanupMs.
    ctx.deadline = ctx.hardEndsAt;
    let cleared = false;
    try {
      try { ctx.transport?.close(); } catch { /* already closed */ }
      const left = ctx.hardEndsAt - now();
      if (left > 0) {
        ctx.transport = makeTransport({ timeoutMs: limits.uiStepTimeoutMs });
        const signal = AbortSignal.timeout(Math.min(limits.uiReadTimeoutMs * 2, left));
        cleared = await clearComposer(ctx, signal, { ownerPresent: ctx.ownerSeen });
      }
    } catch {
      cleared = false;
    }
    if (ctx.inputInFlight) return inFlightOutcome(ctx);
    return outcome(ctx, "failed", `${reason}; not sent; ${cleared ? "cleared our text" : "our text may still be in the composer"}`);
  }

  // The owner's apps, checked once per tick so computer-use-first can fall
  // back to the CLI for a thread whose app is closed.
  const appRunning = (bundleId) => presence.appRunning(bundleId);

  return { readiness, deliver, appRunning };
}
