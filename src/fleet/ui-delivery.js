// Computer-use delivery: types supervisor text into the real app that shows a
// thread (Conductor or the Codex app) and presses send, instead of running a
// CLI. Drives the standalone Open Computer Use binary through its app agent,
// which holds Accessibility and Screen Recording (the daemon's node does not).
//
// Fail closed. Every step either proves it is safe to go on or returns
// "blocked" (nothing typed, retry later) / "failed" (see detail). Never
// overwrites a draft, never presses send after a failed check, never uses the
// clipboard, never launches an app, and opens a deep link only while the
// owner is away from the keyboard. One delivery at a time (see UI_LOCK).

import fs from "node:fs";
import path from "node:path";
import { ensureDir } from "../file-utils.js";
import { OcuTransport, readOcuPermissions } from "../integrations/ocu-transport.js";
import { parseOcuPermissions } from "../integrations/open-computer-use-executor.js";
import { DEFAULTS, SUPERVISOR_PREFIX, UI_APPS, clampText, redactSecrets, runCommand, uiTargetFor } from "./contracts.js";

const MIN = 60_000;
// OCU get_app_state budget. The composer and Send button sit at the end of a
// long transcript, so the default 1200-node tree can cut them off.
const STATE_TREE_NODES = 3000;
const PERMISSION_OK_TTL_MS = 10 * MIN;
// `doctor` opens Open Computer Use's onboarding window when a grant is
// missing, so a failed probe is not repeated every tick.
const PERMISSION_FAIL_TTL_MS = 30 * MIN;
const CONFIRM_CHARS = 60;
const TOKEN_MAX = 40;
const EVIDENCE_KEPT = 200;
const SNIPPET_MAX = 64 * 1024;
const DETAIL_MAX = 200;
const TYPING_MS_PER_CHAR = 25;
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
const COMPOSER_HINT = /composer|message|prompt|reply|follow[- ]?up|ask (?:codex|anything)|type a|send a/i;
const STOP_LABEL = /^(stop|stop generating|stop response|stop agent|interrupt|cancel turn)\b/i;
const PROMPT_LABEL = /^(allow|allow once|always allow|allow for (?:this )?session|approve|deny|don't allow|do not allow|reject|yes, allow)\b/i;
const SEND_LABEL = /^(send|send message|submit)\b/i;
// What navigation may click: sidebar rows and tabs, or a label inside one.
const ROW_ROLES = /^(row|outline row|cell|tab|radio button)$/;
const NAV_ROLES = /^(row|outline row|cell|tab|radio button|button|static text)$/;

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

// Exactly one composer: prefer editables labelled (or inside a form labelled)
// like a composer; with none labelled, a single editable is the composer.
export function findComposer(state) {
  const editables = (state?.elements ?? []).filter(isEditable);
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

export function isComposerFocused(state, composer) {
  if (!composer) return false;
  if (state?.focusedId !== null && state?.focusedId !== undefined) return state.focusedId === composer.id;
  return composer.focused;
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
// matched.
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
  const shown = new Set([identityToken(state.windowTitle), ...selected.map(labelToken), ...pages].filter(Boolean));
  for (const other of identity?.conflicts ?? []) {
    if (!tokens.includes(other) && shown.has(other)) return { ok: false, reason: "could not verify thread: another thread is open" };
  }
  for (const token of tokens) {
    const found = title.includes(token)
      || selected.some((element) => element.search.includes(token))
      || headings.some((element) => labelToken(element) === token)
      || pages.includes(token);
    if (!found) return { ok: false, reason: `could not verify thread: "${token}" is not the open thread` };
  }
  return { ok: true, reason: null };
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
  if (target.titleShared || others.some(({ target: t }) => identityToken(t.title) === title)) {
    // The title cannot tell the twins apart; only a deep link by id that
    // visibly moves the app onto that title can (see steps).
    return { ...blocked("ambiguous: two threads share this title"), tokens: [title], shared: true };
  }
  return { tokens: [title], conflicts: distinct(others.map(({ target: t }) => identityToken(t.title)), [title]), ambiguous: false, reason: null };
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

export function createPresenceProbe({ bins = {}, run = runCommand, timeoutMs = DEFAULTS.uiStepTimeoutMs } = {}) {
  const exec = async (cmd, args) => {
    try {
      const result = await run(cmd, args, { timeoutMs });
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
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
} = {}) {
  const limits = { ...DEFAULTS, ...(config.limits ?? {}) };
  const bins = config.bins ?? {};
  const presence = probe ?? createPresenceProbe({ bins, run, timeoutMs: limits.uiStepTimeoutMs });
  const makeTransport = transportFactory ?? (({ timeoutMs }) => new OcuTransport(bins.ocu, { timeoutMs, appAgentProxy: true }));
  const readPermissions = permissionProbe
    ?? (async () => parseOcuPermissions(await readOcuPermissions(bins.ocu, undefined, { appAgentProxy: true, timeoutMs: limits.uiStepTimeoutMs })));
  let permissionCache = null;

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
    const timer = setTimeout(() => controller.abort(), limits.uiDeliveryTimeoutMs + typingMs);
    const ctx = { phase: "check", transport: null, evidence: [], text, request, stepTimeoutMs: limits.uiStepTimeoutMs + typingMs };
    try {
      return await steps(request, controller.signal, ctx);
    } catch (error) {
      return await recover(error, ctx, controller.signal.aborted);
    } finally {
      clearTimeout(timer);
      try { ctx.transport?.close(); } catch { /* already closed */ }
    }
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
    const result = await ctx.transport.call("get_app_state", { app: ctx.request.target.bundleId, text_limit: "max", max_tree_nodes: STATE_TREE_NODES }, signal);
    const state = parseAppState(result);
    if (state.bundleId && state.bundleId !== ctx.request.target.bundleId) throw new StepError(`app state came from ${state.bundleId}`);
    return state;
  }

  async function click(ctx, element, signal) {
    const app = ctx.request.target.bundleId;
    // Accessibility first, then a direct post to the app's process. Neither
    // moves the pointer; the global-pointer fallback stays disabled.
    try {
      await ctx.transport.call("click", { app, element_index: element.id, click_method: "accessibility" }, signal);
    } catch {
      await ctx.transport.call("click", { app, element_index: element.id, click_method: "app_post" }, signal);
    }
  }

  const press = (ctx, key, signal) => ctx.transport.call("press_key", { app: ctx.request.target.bundleId, key }, signal);

  // Removes only what this delivery typed: the composer was proven empty
  // before typing, and it must now hold our text (or a start of it), so
  // select-all in the focused composer selects nothing of the owner's.
  async function clearComposer(ctx, signal) {
    try {
      let state = await readState(ctx, signal);
      let { composer } = findComposer(state);
      if (!composer) return false;
      if (!normalizeUiText(composer.value)) return true;
      if (!looksLikeOurs(composer.value, ctx.text) || !verifyIdentity(state, ctx.request.identity).ok) return false;
      if (!isComposerFocused(state, composer)) {
        await click(ctx, composer, signal);
        state = await readState(ctx, signal);
        ({ composer } = findComposer(state));
        if (!composer || !isComposerFocused(state, composer)) return false;
      }
      await press(ctx, "super+a", signal);
      await press(ctx, "BackSpace", signal);
      state = await readState(ctx, signal);
      ({ composer } = findComposer(state));
      return Boolean(composer) && !normalizeUiText(composer.value);
    } catch {
      return false;
    }
  }

  async function ownerCheck(ctx, target, { ownerWasIdle, frontBefore }) {
    const front = await presence.frontApp();
    const idle = await presence.idleMs();
    const idleNow = idle !== null && idle >= limits.uiOwnerIdleMs;
    if (!idleNow && (front === target.bundleId || front === null)) return `owner using ${target.name}`;
    if (!ownerWasIdle && front !== frontBefore) return "frontmost app changed";
    return null;
  }

  // Background accessibility clicks only: the sidebar row, then the session
  // tab. Clicks only an element whose own label is exactly the token (a row
  // may add text after it), never a link, and only when exactly one matches;
  // a label inside a row clicks the row.
  async function navigateByClicks(ctx, state, identity, signal) {
    if (identity.ids && state.elements.some((element) => WEB_AREA_ROLE.test(element.role) && conductorIds(element.fields.url).workspaceId)) {
      return navigateConductor(ctx, state, identity, signal);
    }
    for (const token of identity.tokens) {
      if (verifyIdentity(state, { tokens: [token] }).ok) continue;
      const matches = state.elements.filter((element) => {
        if (!NAV_ROLES.test(element.role) || isEditable(element)) return false;
        const label = normalizeUiText(element.label || element.fields.title || element.fields.description || "").toLowerCase();
        if (identityToken(label) === token) return true;
        return ROW_ROLES.test(element.role) && label.startsWith(`${token} `);
      });
      if (matches.length !== 1) return;
      let pick = matches[0];
      if (!ROW_ROLES.test(pick.role)) pick = ancestors(pick).slice(0, 3).find((node) => ROW_ROLES.test(node.role)) ?? pick;
      await click(ctx, pick, signal);
      await sleep(limits.uiPollMs);
      state = await readState(ctx, signal);
    }
  }

  // Conductor: the sidebar link to exactly this workspace (an in-app
  // tauri://localhost link, never an outside one), then the session's tab
  // when exactly one tab carries its title. The page URL then proves it.
  async function navigateConductor(ctx, state, identity, signal) {
    const { workspaceId } = identity.ids;
    const shown = () => state.elements.filter((element) => WEB_AREA_ROLE.test(element.role)).map((element) => conductorIds(element.fields.url)).find((ids) => ids.workspaceId);
    if (shown()?.workspaceId !== workspaceId) {
      const links = state.elements.filter((element) => element.role === "link"
        && /\]\(tauri:\/\/localhost\/repository\/[\w-]+\/workspace\/([\w-]+)\)$/.exec(element.label)?.[1] === workspaceId);
      if (links.length !== 1) return;
      await click(ctx, links[0], signal);
      await sleep(limits.uiPollMs);
      state = await readState(ctx, signal);
    }
    if (!identity.tab || shown()?.sessionId === identity.ids.sessionId) return;
    const tabs = state.elements.filter((element) => element.role === "tab" && element.search.includes(identity.tab));
    if (tabs.length !== 1) return;
    await click(ctx, tabs[0], signal);
  }

  async function steps(request, signal, ctx) {
    const { target, identity = { tokens: [] } } = request;
    const text = ctx.text;
    if (!target?.bundleId) return outcome(ctx, "blocked", "no app shows this thread");
    // Only the apps in UI_APPS are ever driven.
    if (!ALLOWED_BUNDLES.has(target.bundleId)) return outcome(ctx, "blocked", `${target.bundleId} is not an app the fleet types into`);
    if (!text) return outcome(ctx, "blocked", "empty message");

    // 0. Readiness, fresh.
    const ready = await readiness();
    if (!ready.ready) return outcome(ctx, "blocked", `computer use not ready: ${ready.detail}`);
    // A shared title goes on only through its id link (checked below).
    if (identity.ambiguous && !(identity.shared && target.deepLink)) return outcome(ctx, "blocked", identity.reason ?? "ambiguous thread");
    if (!identity.tokens?.length && !identity.ids) return outcome(ctx, "blocked", identity.reason ?? "nothing to verify the thread by");

    // 1. Presence: never launch the app; never type while the owner uses it.
    const running = await presence.appRunning(target.bundleId);
    if (running === null) return outcome(ctx, "blocked", `could not tell whether ${target.name} is running`);
    if (!running) return outcome(ctx, "blocked", `${target.name} is not running`);
    const frontBefore = await presence.frontApp();
    const idle = await presence.idleMs();
    const ownerWasIdle = idle !== null && idle >= limits.uiOwnerIdleMs;
    if (!ownerWasIdle && (frontBefore === target.bundleId || frontBefore === null)) return outcome(ctx, "blocked", `owner using ${target.name}`);

    // 2. Navigate to the thread.
    ctx.transport = makeTransport({ timeoutMs: ctx.stepTimeoutMs });
    let state = await readState(ctx, signal);
    let verified = verifyIdentity(state, identity);
    if (identity.shared) {
      // A twin may be the one on screen: only the id link, while the owner
      // is away, starting from another thread, proves which one opened.
      if (!ownerWasIdle) return outcome(ctx, "blocked", identity.reason);
      if (verified.ok) return outcome(ctx, "blocked", `${identity.reason}; a thread with that title is already open`);
    }
    if (!verified.ok) {
      if (ownerWasIdle) {
        // A deep link can bring the app forward; only while the owner is away.
        if (!(await presence.openUrl(target.deepLink))) return outcome(ctx, "blocked", `could not open the ${target.name} link`);
      } else {
        await navigateByClicks(ctx, state, identity, signal);
      }
      const deadline = now() + limits.uiNavigateMs;
      do {
        await sleep(limits.uiPollMs);
        state = await readState(ctx, signal);
        verified = verifyIdentity(state, identity);
      } while (!verified.ok && now() < deadline);
      if (!verified.ok) return outcome(ctx, "blocked", verified.reason);
      const moved = await ownerCheck(ctx, target, { ownerWasIdle, frontBefore });
      if (moved) return outcome(ctx, "blocked", moved);
    }

    // 3. Guards on what the thread shows.
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

    // 4. Composer: exactly one, and empty. Exactly this message left unsent
    // by an earlier attempt is ours: it is sent as is, never retyped.
    let found = findComposer(state);
    if (!found.composer) return outcome(ctx, "blocked", found.reason);
    const leftover = normalizeUiText(found.composer.value) === normalizeUiText(text);
    if (normalizeUiText(found.composer.value) && !leftover) return outcome(ctx, "blocked", "draft in composer: not overwriting it");
    const beforeCount = transcriptCount(state, needle, found.composer);
    keep(ctx, "before", state);
    const holds = (composer) => normalizeUiText(composer.value) === (leftover ? normalizeUiText(text) : "");

    // 5. Focus the composer without moving the pointer: accessibility first,
    // then one event posted to the app's process.
    await click(ctx, found.composer, signal);
    state = await readState(ctx, signal);
    found = findComposer(state);
    if (found.composer && !isComposerFocused(state, found.composer) && holds(found.composer)) {
      await ctx.transport.call("click", { app: target.bundleId, element_index: found.composer.id, click_method: "app_post" }, signal);
      state = await readState(ctx, signal);
      found = findComposer(state);
    }
    if (!found.composer || !isComposerFocused(state, found.composer)) return outcome(ctx, "failed", "could not focus the composer; nothing typed");
    if (!holds(found.composer)) return outcome(ctx, "blocked", "draft in composer: not overwriting it");
    if (!verifyIdentity(state, identity).ok) return outcome(ctx, "blocked", "thread changed before typing");

    // 6. Type, one line.
    ctx.phase = "typing";
    if (!leftover) await ctx.transport.call("type_text", { app: target.bundleId, text }, signal);
    ctx.phase = "typed";

    // 7. Same thread, and the composer holds exactly our text.
    state = await readState(ctx, signal);
    if (!verifyIdentity(state, identity).ok) {
      // Our text stays with the thread it was typed into; the thread on
      // screen now may hold the owner's draft, so nothing is cleared.
      keep(ctx, "after", state);
      return outcome(ctx, "blocked", "thread changed before send; our text may be left as a draft in the thread, check it");
    }
    found = findComposer(state);
    if (!found.composer || normalizeUiText(found.composer.value) !== normalizeUiText(text)) {
      const cleared = await clearComposer(ctx, signal);
      keep(ctx, "after", state);
      return outcome(ctx, "failed", `text mismatch, not sent${cleared ? "; cleared our text" : "; could not clear the composer, check it"}`);
    }
    const changed = hasStopButton(state) ? "turn started before send"
      : hasPermissionPrompt(state) ? "permission prompt appeared before send"
      : await ownerCheck(ctx, target, { ownerWasIdle, frontBefore });
    if (changed) {
      const cleared = await clearComposer(ctx, signal);
      return outcome(ctx, "blocked", `${changed}; ${cleared ? "cleared our text" : "could not clear the composer, check it"}`);
    }

    // 8. Send: the Send button, else Return in the focused composer.
    ctx.phase = "sending";
    const send = findSendButton(state);
    let pressed = false;
    if (send) {
      try {
        await ctx.transport.call("click", { app: target.bundleId, element_index: send.id, click_method: "accessibility" }, signal);
        pressed = true;
      } catch {
        // Press Return only if the click provably did nothing.
        const after = await readState(ctx, signal);
        const again = findComposer(after).composer;
        if (!again || normalizeUiText(again.value) !== normalizeUiText(text) || transcriptCount(after, needle, again) > beforeCount) {
          ctx.phase = "sent";
          throw new StepError("send click failed midway");
        }
      }
    }
    if (!pressed) await press(ctx, "Return", signal);
    ctx.phase = "sent";

    // 9. Confirm: composer empty and one more transcript copy of our text.
    const deadline = now() + limits.uiConfirmMs;
    do {
      await sleep(limits.uiPollMs);
      state = await readState(ctx, signal);
      const composer = findComposer(state).composer;
      const empty = composer ? !normalizeUiText(composer.value) : false;
      if (empty && transcriptCount(state, needle, composer) > beforeCount) {
        keep(ctx, "after", state);
        return outcome(ctx, "sent", leftover ? `sent the text an earlier attempt left in ${target.name}` : `typed into ${target.name}`);
      }
    } while (now() < deadline);
    keep(ctx, "after", state);
    return outcome(ctx, "failed", "unconfirmed: may have been sent; check the thread before retrying", { unconfirmed: true });
  }

  async function recover(error, ctx, timedOut) {
    const reason = timedOut ? "delivery timed out" : detailText(error?.message ?? error) || "Open Computer Use error";
    if (ctx.phase === "check") return outcome(ctx, "failed", `${reason}; nothing typed`);
    if (ctx.phase === "sending" || ctx.phase === "sent") {
      return outcome(ctx, "failed", `${reason}; unconfirmed: may have been sent; check the thread before retrying`, { unconfirmed: true });
    }
    // Typed, not sent: a fresh engine, bounded by one step, clears our text.
    let cleared = false;
    try {
      try { ctx.transport?.close(); } catch { /* already closed */ }
      ctx.transport = makeTransport({ timeoutMs: limits.uiStepTimeoutMs });
      const signal = AbortSignal.timeout(limits.uiStepTimeoutMs * 2);
      cleared = await clearComposer(ctx, signal);
    } catch {
      cleared = false;
    }
    return outcome(ctx, "failed", `${reason}; not sent; ${cleared ? "cleared our text" : "our text may still be in the composer"}`);
  }

  // The owner's apps, checked once per tick so computer-use-first can fall
  // back to the CLI for a thread whose app is closed.
  const appRunning = (bundleId) => presence.appRunning(bundleId);

  return { readiness, deliver, appRunning };
}
