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

import crypto from "node:crypto";
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
// Presence is read from HIDIdleTime alone, and any input there counts as the
// owner's. Open Computer Use types into a settable composer by setting its
// accessibility value and clicks through accessibility, neither of which
// posts a HID event; its key presses (Return) and keyboard-fallback typing
// do, and nothing that follows them needs the owner away except putting
// their app back, which then simply waits for real idle.
// After a Return send, the owner's app goes back on a later readiness check
// once nothing but that key has happened and they have been away long
// enough; given up after this long.
const RESTORE_PENDING_MS = 30 * MIN;
const RESTORE_KEY_SLACK_MS = 2000;
// A presence check (idle, front app, idle) is trusted only if it took at most
// this long: a slower one may describe a moment that has passed, so the send
// waits for a fresh one instead. Real lsappinfo and ioreg calls take ~50 ms.
const PRESENCE_FRESH_MS = 3000;
// Frontmost while the screen saver runs or the login window shows.
const SCREEN_SAVER_APPS = new Set(["com.apple.ScreenSaver.Engine", "com.apple.loginwindow"]);
// OCU calls that act on the app (reads do not).
const INPUT_TOOLS = new Set(["click", "type_text", "press_key", "set_value", "scroll", "drag", "perform_secondary_action"]);
// Open Computer Use's "Apple event error -10005: cgWindowNotFound".
const APP_UNREADABLE = /cgWindowNotFound|-10005/i;
// Unsent text is never erased (see step 8 of the delivery).
const LEFT_AS_DRAFT = "our text is left as a draft, check it";
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
// trip back: the node's result upload may take its full 10 s
// (src/node-control.js) plus processing, so the driver ends this long before it.
export const DEADLINE_MARGIN_MS = 15_000;
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
// OCU 0.3.6 appends "Frame: x=.., y=.., w=.., h=.." to an element's line; it
// is geometry, never part of the label ("Approve for me Frame: ...").
const FIELD_MARKER = /(?:^|,?\s+)(Value|Placeholder|ID|Description|Help|Title|URL|Frame): /g;
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
// A permission or approval card: at least two of these exact labels side by
// side, one of them positive. "Approve for me" (Codex's permission-mode
// menu) and a lone "Run" in a transcript are not one.
const POSITIVE_PROMPT_BUTTONS = new Set(["allow", "allow once", "always allow", "allow for this session", "allow for session", "yes, allow",
  "approve", "approve once", "approve and run", "always approve", "accept", "yes", "run"]);
const PROMPT_BUTTONS = new Set([...POSITIVE_PROMPT_BUTTONS, "deny", "don't allow", "do not allow", "reject", "decline", "no"]);
// The guard that stops typing is wider: any one of these on its own, as a
// plain own-page button, means a card may be waiting (the old detector's
// vocabulary, matched exactly so "Approve for me" is not one). Generic
// "yes", "no" and "run" count only as part of a card above.
const GUARD_PROMPT_BUTTONS = new Set([...PROMPT_BUTTONS].filter((label) => !["yes", "no", "run", "accept", "decline"].includes(label)));
// Shortcut hints a button label can carry: "Allow once ⌘↩", "Deny (esc)", "Yes [y]".
const SHORTCUT_SUFFIX = /(?:\s*(?:[\u2318\u2325\u21e7\u2303\u21a9\u21b5\u23ce\u238b\u232b\ufe0e]+|[([][^()[\]]{1,6}[)\]]))+$/u;
// Pop-ups and menus hold choices for settings, never a card's answer.
const MENU_ROLES = /^(pop up button|menu button|menu|menu item|menu bar item|combo box)$/;
const PROMPT_TEXT_MAX = 300;
// Plain buttons that resume a stopped turn; clicked only when exactly one shows.
const RESUME_LABELS = new Set(["resume goal", "retry", "resume"]);
const SCREEN_TEXT_MAX = 1500;
const SEND_LABEL = /^(send|send message|submit)\b/i;
// A window title's app suffix ("madrid — Conductor").
const APP_TITLE_SUFFIX = /\s+[—–-]\s+(?:conductor|codex|chatgpt)$/i;
// A sidebar row's trailing diff stats ("+12k -48", "+✱✱").
const ROW_STATS = /(?:\s+[+-](?:[\d.,]+[kKmM]?|✱+))+$/;

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

// A card button's label without a trailing shortcut hint ("Allow once ⌘↩").
function cardLabel(element) {
  return cleanChoice(buttonLabel(element));
}

function cleanChoice(text) {
  return normalizeUiText(text).replace(SHORTCUT_SUFFIX, "").trim();
}

// Lowercased label for matching card buttons ("Don’t Allow" -> "don't allow").
function choiceLabel(element) {
  return choiceText(buttonLabel(element));
}

function choiceText(text) {
  return cleanChoice(text).toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/[.!:\u2026]+$/, "").trim();
}

// A plain own-page button: not a pop-up or menu, not inside one, not in an
// in-app browser page.
function ownPlainButtons(state, bundleId) {
  const ownPage = OWN_PAGE[bundleId] ?? null;
  return (state?.elements ?? []).filter((element) => BUTTON_ROLE.test(element.role) && !MENU_ROLES.test(element.role)
    && !element.disabled && !(ownPage && inOtherPage(element, ownPage))
    && !ancestors(element).some((node) => MENU_ROLES.test(node.role)));
}

// OCU wraps a labelled button in an unlabelled frame button: the card is the
// nearest ancestor that is not a button.
function cardOf(element) {
  for (let node = element.parent; node; node = node.parent) if (!BUTTON_ROLE.test(node.role)) return node;
  return null;
}

// Every element under node, in tree order (OCU prints depth-first).
function descendants(state, node) {
  const elements = state?.elements ?? [];
  const start = elements.indexOf(node);
  if (start < 0) return [];
  const out = [];
  for (let index = start + 1; index < elements.length && elements[index].depth > node.depth; index += 1) out.push(elements[index]);
  return out;
}

function cardText(state, card) {
  const textOf = (node) => descendants(state, node).filter((element) => !BUTTON_ROLE.test(element.role) && !isEditable(element))
    .map((element) => normalizeUiText([element.label, element.value].filter(Boolean).join(" "))).filter(Boolean).join(" ");
  // A card whose buttons sit in their own row: the question is beside it.
  const text = textOf(card) || (card.parent ? textOf(card.parent) : "");
  return clampText(redactSecrets(text), PROMPT_TEXT_MAX);
}

// The newest permission or approval card on the app's own page, with its
// elements (internal), or null.
function findPrompt(state, bundleId = state?.bundleId) {
  const cards = new Map();
  for (const element of ownPlainButtons(state, bundleId)) {
    if (!PROMPT_BUTTONS.has(choiceLabel(element))) continue;
    const card = cardOf(element);
    if (!card) continue;
    if (!cards.has(card)) cards.set(card, []);
    cards.get(card).push(element);
  }
  let found = null;
  for (const [card, buttons] of cards) {
    if (buttons.length < 2 || !buttons.some((element) => POSITIVE_PROMPT_BUTTONS.has(choiceLabel(element)))) continue;
    // Tree order: the last card is the newest in the transcript.
    found = { card, buttons };
  }
  if (!found) return null;
  const labels = [...new Set(found.buttons.map(cardLabel))];
  const text = cardText(state, found.card);
  const stateId = crypto.createHash("sha256").update(JSON.stringify([bundleId ?? null, text, labels])).digest("hex").slice(0, 16);
  return { ...found, text, labels, stateId };
}

// What a blocked delivery reports and fleet_screen shows: the card's question,
// its exact button labels, and an id that changes when the card does.
export function promptButtons(state, bundleId = state?.bundleId) {
  const found = findPrompt(state, bundleId);
  return found ? { text: found.text, buttons: found.labels, stateId: found.stateId } : null;
}

// The guard before typing: a full card, or any one plain own-page button
// with a permission label. Wider than what fleet_click may click.
export function hasPermissionPrompt(state, bundleId = state?.bundleId) {
  return promptButtons(state, bundleId) !== null || guardLabels(state, bundleId).length > 0;
}

function guardLabels(state, bundleId = state?.bundleId) {
  return [...new Set(ownPlainButtons(state, bundleId).filter((element) => GUARD_PROMPT_BUTTONS.has(choiceLabel(element))).map(cardLabel))];
}

// What blocks a send: { prompt } when it is a card fleet_click can answer,
// { labels } when only the wider guard saw one, or null.
function promptBlock(state, bundleId) {
  const prompt = promptButtons(state, bundleId);
  if (prompt) return { prompt };
  const labels = guardLabels(state, bundleId);
  return labels.length ? { labels } : null;
}

function promptBlockDetail(block, lead) {
  return block.prompt ? `${lead}: answer it first (fleet_click), then send again`
    : `${lead} (${block.labels.join(", ")}): answer it first`;
}

// Own-page Resume / Retry buttons, by exact label.
function resumeButtons(state, bundleId = state?.bundleId) {
  return ownPlainButtons(state, bundleId).filter((element) => RESUME_LABELS.has(choiceLabel(element)));
}

// What one thread's screen shows, for the owner (untrusted text: an agent
// wrote it). No input, no composer contents.
export function screenSummary(state, bundleId = state?.bundleId) {
  const composer = findComposer(state, bundleId).composer;
  const ownPage = OWN_PAGE[bundleId] ?? null;
  const text = (state?.elements ?? []).filter((element) => !BUTTON_ROLE.test(element.role) && !isEditable(element)
    && !(ownPage && inOtherPage(element, ownPage)) && /text|heading/.test(element.role))
    .map((element) => normalizeUiText(element.label || element.value)).filter(Boolean).join("\n");
  return {
    prompt: promptButtons(state, bundleId),
    running: hasStopButton(state),
    resume: [...new Set(resumeButtons(state, bundleId).map(buttonLabel))],
    draft: Boolean(composer && normalizeUiText(composer.value)),
    // The tail: the newest messages sit at the end of the transcript.
    text: String(redactSecrets(text.slice(-SCREEN_TEXT_MAX * 2))).slice(-SCREEN_TEXT_MAX)
  };
}

// Only the app's own page: an in-app browser tab's Submit is no chat's Send.
export function findSendButton(state, bundleId = state?.bundleId) {
  const ownPage = OWN_PAGE[bundleId] ?? null;
  const buttons = (state?.elements ?? []).filter((element) => BUTTON_ROLE.test(element.role) && !element.disabled && SEND_LABEL.test(buttonLabel(element))
    && !(ownPage && inOtherPage(element, ownPage)));
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
  const selected = state.elements.filter((element) => element.selected);
  const headings = state.elements.filter((element) => HEADING_ROLE.test(element.role));
  // Exactly the page label, never text inside it: a transcript can name every
  // other thread. A heading can be markdown in any thread's transcript, and an
  // in-app browser page can carry any title.
  const ownPage = OWN_PAGE[state.bundleId];
  const appPages = webAreas.filter((element) => !ownPage || ownPage.test(String(element.fields.url ?? ""))).map(labelToken).filter(Boolean);
  // Conflicts and proof read the same chrome: an in-app browser page or tab
  // can carry any title without another thread being open.
  const ownSelected = selected.filter((element) => !(ownPage && inOtherPage(element, ownPage)));
  const shown = new Set([identityToken(state.windowTitle), ...ownSelected.map(labelToken), ...appPages].filter(Boolean));
  const altTokens = identity?.altTokens ?? [];
  for (const other of identity?.conflicts ?? []) {
    if (!tokens.includes(other) && !altTokens.includes(other) && shown.has(other)) return { ok: false, reason: "could not verify thread: another thread is open" };
  }
  // Proof comes only from the app's own chrome: never an in-app browser tab
  // or page, and (in the apps the fleet drives, whose page holds the
  // transcript) never a heading, which can be markdown in another thread.
  const labelled = (token) => (!ownPage && headings.some((element) => labelToken(element) === token)) || appPages.includes(token);
  // Exactly the token, never a longer title that starts with it ("fix login"
  // is not "fix login redirect"); a sidebar row may add its diff stats.
  const shows = (element, token) => identityToken(normalizeUiText(element.label || element.fields.title || "").replace(ROW_STATS, "")) === token;
  const found = (token) => identityToken(normalizeUiText(state.windowTitle).replace(APP_TITLE_SUFFIX, "")) === token
    || ownSelected.some((element) => shows(element, token))
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
  // Automation runs, reviews and subagents never show in the app's sidebar.
  const others = (threads ?? []).filter((other) => other && other.key !== thread?.key && !other.archived && other.excluded !== "automation")
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
const RESTART_POLL_MS = 1000;

// The longest one restart can take, from its sequence below: idle (1
// command), frontApp (2), appRunning (1), quit (1) and open (1), and two waits
// that each can overrun their 30 s by one more appRunning and poll, then the
// settle. Every command may run to its timeout plus kill grace.
export function restartMaxMs(limits = DEFAULTS) {
  const command = limits.uiStepTimeoutMs + limits.uiKillGraceMs;
  return 6 * command + 2 * (RESTART_WAIT_MS + command + RESTART_POLL_MS) + RESTART_SETTLE_MS;
}

// open (in the background), quit and restart one of the apps the fleet
// drives, on the owner's instruction or an owner-written playbook. A quit is
// the app's own (an AppleScript quit it may hold up with a dialog), never a
// kill, and never while the owner is using that app.
export function createAppController({ bins = {}, run = runCommand, probe = null, limits = DEFAULTS, now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  const presence = probe ?? createPresenceProbe({ bins, run, timeoutMs: limits.uiStepTimeoutMs });
  const waitFor = async (bundleId, want) => {
    const deadline = now() + RESTART_WAIT_MS;
    do {
      if ((await presence.appRunning(bundleId)) === want) return true;
      await sleep(RESTART_POLL_MS);
    } while (now() < deadline);
    return false;
  };
  const exec = async (cmd, args) => {
    try { await run(cmd, args, { timeoutMs: limits.uiStepTimeoutMs }); } catch { /* checked by waitFor */ }
  };
  const appFor = (appKey) => UI_APPS[appKey] ?? null;
  const unknown = (appKey) => ({ ok: false, detail: `${appKey} is not an app the fleet opens or quits` });
  const ownerUsing = async (app) => {
    const idle = await presence.idleMs();
    return (await presence.frontApp()) === app.bundleId && !(idle !== null && idle >= limits.uiOwnerIdleMs);
  };
  const quit = async (app) => {
    const running = await presence.appRunning(app.bundleId);
    // null: lsappinfo could not tell. Never report a quit that was not tried.
    if (running === null) return { ok: false, detail: `could not tell whether ${app.name} is running (lsappinfo failed); nothing was quit` };
    if (running === false) return { ok: true, wasRunning: false, detail: `${app.name} is not running` };
    // A quit the app holds up (an "are you sure" dialog) is not forced.
    await exec("osascript", ["-e", `tell application id "${app.bundleId}" to quit`]);
    if (!(await waitFor(app.bundleId, false))) return { ok: false, wasRunning: true, detail: `${app.name} did not quit: it may be asking to confirm quit` };
    return { ok: true, wasRunning: true, detail: `quit ${app.name}` };
  };
  const launch = async (app) => {
    await exec(bins.open ?? "open", ["-g", "-b", app.bundleId]);
    if (!(await waitFor(app.bundleId, true))) return { ok: false, wasRunning: false, detail: `${app.name} did not start` };
    await sleep(RESTART_SETTLE_MS);
    return { ok: true, wasRunning: false, detail: `opened ${app.name}` };
  };
  return {
    async open(appKey) {
      const app = appFor(appKey);
      if (!app) return unknown(appKey);
      if (await presence.appRunning(app.bundleId)) return { ok: true, wasRunning: true, detail: `${app.name} is already running` };
      return launch(app);
    },
    async quit(appKey) {
      const app = appFor(appKey);
      if (!app) return unknown(appKey);
      if (await ownerUsing(app)) return { ok: false, detail: `you are using ${app.name}` };
      return quit(app);
    },
    async restart(appKey) {
      const app = appFor(appKey);
      if (!app) return { ok: false, detail: `${appKey} is not an app the fleet restarts` };
      if (await ownerUsing(app)) return { ok: false, detail: `you are using ${app.name}` };
      const quitting = await quit(app);
      if (!quitting.ok) return quitting;
      const opening = await launch(app);
      if (!opening.ok) return opening;
      return { ok: true, wasRunning: quitting.wasRunning, detail: `restarted ${app.name}` };
    }
  };
}

// The account-switch playbook's restart; same controller.
export const createAppRestarter = createAppController;

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
// An input whose engine exited unanswered may still run in the app agent,
// and nothing cancels it there, a restart included: typing stays paused this
// long after, and the pause is kept on disk so a restart does not lift it.
export const ORPHAN_HOLD_MS = 30 * MIN;

export function createInputLatch({ now = Date.now } = {}) {
  const open = new Set();
  let orphanedAt = null;
  let file = null;
  // On disk from the moment an input is in flight (a restart may come before
  // it answers) until it is proven done; a run that finds it treats it as
  // orphaned from then.
  const write = (state) => {
    if (!file) return;
    try { ensureDir(path.dirname(file)); fs.writeFileSync(file, JSON.stringify(state), { mode: 0o600 }); } catch { /* held in memory still */ }
  };
  const clear = () => {
    if (file) try { fs.rmSync(file, { force: true }); } catch { /* retried next time */ }
  };
  const orphaned = () => {
    if (orphanedAt === null) return false;
    if (now() - orphanedAt < ORPHAN_HOLD_MS) return true;
    orphanedAt = null;
    if (!open.size) clear();
    return false;
  };
  const orphan = () => {
    orphanedAt = now();
    write({ orphanedAt: new Date(orphanedAt).toISOString() });
  };
  return {
    get held() { return orphaned() || open.size > 0; },
    get detail() {
      if (orphaned()) return `an earlier input call never answered and may still run in Open Computer Use; typing paused until ${new Date(orphanedAt + ORPHAN_HOLD_MS).toISOString().slice(11, 16)} UTC`;
      return open.size ? "an earlier input call has not finished; typing paused until it answers" : null;
    },
    // Keeps the pause in this file, and picks up one left by an earlier run.
    persistTo(path_) {
      file = path_;
      try {
        const saved = JSON.parse(fs.readFileSync(file, "utf8")) ?? {};
        const at = Date.parse(saved.orphanedAt ?? saved.inFlightSince ?? "");
        if (Number.isFinite(at)) orphanedAt = Math.max(orphanedAt ?? at, at);
      } catch { /* none */ }
    },
    hold(settled) {
      const token = {};
      open.add(token);
      if (orphanedAt === null) write({ inFlightSince: new Date(now()).toISOString() });
      Promise.resolve(settled).then((result) => {
        open.delete(token);
        if (result?.completed !== true) orphan();
        else if (!open.size && orphanedAt === null) clear();
      }, () => {
        open.delete(token);
        orphan();
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
  uiLock = UI_LOCK,
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

  // The owner's app a Return send could not put back yet (see restoreFront).
  let pendingRestore = null;

  async function retryRestore() {
    const pending = pendingRestore;
    if (!pending) return;
    // Waiting on a timed-out input: nothing moves until it answered.
    if (!Number.isFinite(pending.keyEnd)) {
      if (now() - pending.since > RESTORE_PENDING_MS) pendingRestore = null;
      return;
    }
    if (now() - pending.keyEnd > RESTORE_PENDING_MS) { pendingRestore = null; return; }
    try {
      // open -b launches an app that quit meanwhile; never that. Probed
      // first: it can be slow, and the snapshot below must be the last word.
      if ((await presence.appRunning(pending.frontBefore)) !== true) { pendingRestore = null; return; }
      // The same idle, front app, idle snapshot as ownerReason.
      const taken = now();
      const idleBefore = await presence.idleMs();
      const front = await presence.frontApp();
      const idleAfter = await presence.idleMs();
      if (now() - taken > PRESENCE_FRESH_MS) return;
      const idle = idleBefore === null || idleAfter === null ? null : Math.min(idleBefore, idleAfter);
      // Input after our key is the owner's, or another app is in front (the
      // screen saver too): they took over, nothing to put back.
      if (idle === null || front !== pending.bundleId || now() - idle > pending.keyEnd + RESTORE_KEY_SLACK_MS) { pendingRestore = null; return; }
      if (!ownerAway(idle)) return;
      pendingRestore = null;
      await presence.activate(pending.frontBefore);
    } catch { /* tried again at the next check */ }
  }

  // Fresh at every send; cheap enough to run once per tick as well.
  async function readiness() {
    const notReady = (detail) => ({ ready: false, detail });
    await retryRestore();
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
    return runRequest(request, (ctx, signal) => steps(request, signal, ctx));
  }

  // Every request's one budget and its cleanup: the owner's app goes back
  // and the transport closes whatever happened.
  async function runRequest(request, body) {
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
      slowest: 0, slowestProbe: null, ownerSeen: false, activated: false, inFront: false, frontBefore: null, inputInFlight: false };
    try {
      return await body(ctx, controller.signal);
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
    if (!ctx.activated || ctx.ownerSeen || !ctx.frontBefore || ctx.frontBefore === target?.bundleId || SCREEN_SAVER_APPS.has(ctx.frontBefore)) return;
    if (ctx.inputInFlight) {
      // Nothing moves while it may still land; once it answers done, the
      // owner's app goes back the deferred way (retryRestore), never if not.
      const pending = { frontBefore: ctx.frontBefore, bundleId: target.bundleId, keyEnd: null, since: now() };
      pendingRestore = pending;
      Promise.resolve(ctx.inputSettled).then((result) => {
        if (pendingRestore !== pending) return;
        if (result?.completed === true) pending.keyEnd = now();
        else pendingRestore = null;
      }, () => { if (pendingRestore === pending) pendingRestore = null; });
      return;
    }
    // A deep link can bring the app forward before navigation fails: what
    // counts is that the target is in front now, which the check below probes.
    ctx.inFront = true;
    // Within the cleanup budget; probeNow starts a probe only if it fits.
    ctx.deadline = ctx.hardEndsAt;
    try {
      // open -b launches an app that quit meanwhile; never that.
      if ((await probeNow(ctx, "appRunning", ctx.frontBefore)) !== true) return;
      // The same quick check as before typing, right before the switch: the
      // target still in front, no screen saver, the owner away.
      const reason = await ownerReason(ctx, target);
      if (reason) {
        // Our own Return reset the idle clock: retried later (retryRestore).
        if (Number.isFinite(ctx.keyEnd) && /^owner using /.test(reason)) pendingRestore = { frontBefore: ctx.frontBefore, bundleId: target.bundleId, keyEnd: ctx.keyEnd };
        return;
      }
      await probeNow(ctx, "activate", ctx.frontBefore);
    } catch { /* best-effort */ }
  }

  // Away: no input for uiOwnerIdleMs.
  function ownerAway(idle) {
    return idle !== null && idle !== undefined && idle >= limits.uiOwnerIdleMs;
  }

  function sawOwner(ctx) {
    ctx.ownerSeen = true;
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
  // No probe starts past the deadline in force, nor unless it can finish
  // (every command at its timeout and kill grace) before the hard end.
  function probeNow(ctx, name, ...args) {
    const commands = name === "frontApp" ? 2 : 1;
    if (now() >= ctx.deadline || now() + commands * commandMs > ctx.hardEndsAt) throw new StepError("delivery timed out");
    return presence[name](...args);
  }

  // One OCU action. Each ends with a fresh snapshot, so it gets a read's
  // budget. One that timed out may still be running (nothing cancels it):
  // no more input after it.
  async function act(ctx, name, args, signal, { timeoutMs = limits.uiReadTimeoutMs } = {}) {
    if (ctx.inputInFlight) throw new StepError("an input call timed out");
    const input = INPUT_TOOLS.has(name);
    if (input) {
      // The owner may have started an OpenAGI computer-use session since
      // readiness: never input alongside it.
      let active = [];
      try { active = activeSessions() ?? []; } catch { active = []; }
      if (active.length) throw new StepError("an OpenAGI computer-use session is active");
    }
    // Held, and on disk, before the call goes out: a restart while it is
    // pending must find it. Released once it is known to have ended.
    let settle = null;
    if (input) inputLatch.hold(new Promise((resolve) => { settle = resolve; }));
    const start = now();
    let result;
    try {
      result = await ctx.transport.call(name, args, signal, { timeoutMs: within(ctx, timeoutMs) });
      settle?.({ completed: true });
    } catch (error) {
      if (error?.inFlight) {
        ctx.inputInFlight = true;
        ctx.inputSettled = error.settled;
        if (settle) Promise.resolve(error.settled).then(settle, () => settle({ completed: false }));
        else inputLatch.hold(error.settled);
      } else {
        // Answered with an error: it ran its course.
        settle?.({ completed: true });
      }
      throw error;
    } finally {
      if (name !== "type_text") ctx.slowest = Math.max(ctx.slowest, now() - start);
    }
    return result;
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

  const press = (ctx, key, signal) => act(ctx, "press_key", { app: ctx.request.target.bundleId, key }, signal);

  // Null while it is still safe to go on. Once the target is in front it
  // must stay there: typing goes to the frontmost app.
  async function ownerCheck(ctx, target) {
    const start = now();
    const reason = await ownerReason(ctx, target);
    // Its slowest round is what the owner checks still ahead cost (step 7).
    ctx.slowestProbe = Math.max(ctx.slowestProbe ?? 0, now() - start);
    // An unread front app is a probe hiccup, not the owner: putting their app
    // back still re-probes before it moves anything.
    if (reason && reason !== "front app unknown") sawOwner(ctx);
    return reason;
  }

  async function ownerReason(ctx, target) {
    // The front app is read last, so a screen saver that started during the
    // idle probe (or a slow read before it) is seen: nothing comes forward over it.
    const taken = now();
    const idleBefore = await probeNow(ctx, "idleMs");
    const front = await probeNow(ctx, "frontApp");
    if (SCREEN_SAVER_APPS.has(front)) return "screen saver on";
    const idleAfter = await probeNow(ctx, "idleMs");
    // Each probe can stall: only a quick check describes now.
    if (now() - taken > PRESENCE_FRESH_MS) return "presence check too slow";
    const idle = idleBefore === null || idleAfter === null ? null : Math.min(idleBefore, idleAfter);
    if (!ownerAway(idle)) {
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
    // That probe can take a command's timeout and kill grace: the owner may
    // have come back, switched apps, or the screen saver started meanwhile.
    const back = await ownerCheck(ctx, target);
    if (back) return back;
    // Marked before the result: an activation that worked but timed out
    // still gets the owner's app put back (cleanup probes the front app).
    ctx.activated = true;
    if (!(await probeNow(ctx, "activate", target.bundleId))) return false;
    const deadline = now() + limits.uiActivateMs;
    do {
      if ((await probeNow(ctx, "frontApp")) === target.bundleId) return true;
      await sleep(limits.uiPollMs);
    } while (now() < deadline);
    return (await probeNow(ctx, "frontApp")) === target.bundleId;
  }

  // Steps 0-2 of every request: readiness, presence, then the thread open
  // and verified. needFront: the request types, so the owner must be away
  // before anything happens. A read or an accessibility click (no front
  // needed) proceeds with the owner at the keyboard while the thread is
  // already on screen; the deep link, which moves the app, still waits for
  // them to be away. Returns { blocked } or { state }.
  async function openThread(ctx, signal, { needFront, navigate = true }) {
    const { target, identity = { tokens: [] } } = ctx.request;
    const blocked = (detail) => ({ blocked: outcome(ctx, "blocked", detail) });

    // 0. Readiness, fresh.
    const ready = await readiness();
    if (!ready.ready) return blocked(`computer use not ready: ${ready.detail}`);
    // A shared title goes on only through its id link (checked below).
    if (identity.ambiguous && !(identity.shared && target.deepLink)) return blocked(identity.reason ?? "ambiguous thread");
    if (!identity.tokens?.length && !identity.ids) return blocked(identity.reason ?? "nothing to verify the thread by");

    // 1. Presence: never launch the app; act only while the owner is away,
    // since typing needs the app in front. Readiness may have used up the
    // request's time: no probe starts past it.
    const running = await probeNow(ctx, "appRunning", target.bundleId);
    if (running === null) return blocked(`could not tell whether ${target.name} is running`);
    if (!running) return blocked(`${target.name} is not running`);
    const frontBefore = await probeNow(ctx, "frontApp");
    if (SCREEN_SAVER_APPS.has(frontBefore)) return blocked("screen saver on");
    let ownerHere = false;
    if (!ownerAway(await probeNow(ctx, "idleMs"))) {
      sawOwner(ctx);
      ownerHere = true;
      if (needFront) {
        if (frontBefore === target.bundleId || frontBefore === null) return blocked(`owner using ${target.name}`);
        return blocked(`waiting for idle: ${target.name} must be in front to type`);
      }
    }
    // Unknown is not safe: a failed probe can hide the screen saver, and the
    // owner's app could not be put back.
    if (frontBefore === null) return blocked("front app unknown");
    ctx.frontBefore = frontBefore;

    // 2. Navigate to the thread: the deep link, in the background. A read
    // can take tens of seconds, so the owner is checked again after it.
    ctx.transport = makeTransport({ timeoutMs: limits.uiStepTimeoutMs });
    // Marked before the first read: an Open Computer Use read can bring the
    // app forward by itself, and the owner's app then goes back (restoreFront
    // re-probes first and moves nothing that did not move).
    ctx.activated = true;
    let state = await readState(ctx, signal);
    let verified = verifyIdentity(state, identity);
    // A twin may be the one on screen: only the id link, starting from
    // another thread, proves which one opened.
    if (identity.shared && verified.ok) return blocked(`${identity.reason}; a thread with that title is already open`);
    // Likewise a first-message label: a thread the catalog does not label
    // that way can show it. It counts only once a link moved the app onto it.
    if (verified.byAlt) return blocked("could not verify thread: only its first message is shown, which another thread can show too; open another thread");
    if (!verified.ok) {
      // A background read that may not move the app (Propose mode).
      if (!navigate) return blocked(`${target.name} shows another thread; not moving it`);
      // The link switches the owner's app to another thread: never under them.
      if (!needFront && ownerHere) return blocked(`owner at the keyboard: ${target.name} shows another thread; open it there`);
      const back = await ownerCheck(ctx, target);
      if (back) return blocked(back);
      // The link can bring the app forward itself (Codex does), even when the
      // command then fails: the owner's app is put back at the end all the same.
      ctx.activated = true;
      if (!(await probeNow(ctx, "openUrl", target.deepLink))) return blocked(`could not open the ${target.name} link`);
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
      if (!verified.ok) return blocked(verified.reason);
    }
    return { state };
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

    // 0-2. Ready, the owner away, the thread open and verified.
    const opened = await openThread(ctx, signal, { needFront: true });
    if (opened.blocked) return opened.blocked;
    let state = opened.state;
    let verified;

    // 3. The app in front, then the thread checked again. Fresh owner check
    // first: nothing comes forward over an owner who came back.
    const moved = await ownerCheck(ctx, target);
    if (moved) return outcome(ctx, "blocked", moved);
    if ((await probeNow(ctx, "frontApp")) !== target.bundleId) {
      const brought = await bringToFront(ctx, target);
      if (brought !== true) return outcome(ctx, "blocked", brought || `could not bring ${target.name} to the front`);
      state = await readState(ctx, signal);
      verified = verifyIdentity(state, identity);
      if (!verified.ok) return outcome(ctx, "blocked", verified.reason);
    }
    ctx.inFront = true;

    // 4. Guards on what the thread shows.
    if (hasStopButton(state)) return outcome(ctx, "blocked", "turn running (Stop is visible)");
    // The card's buttons go back with the block, so the owner can answer it
    // from anywhere (fleet_click) instead of opening the app.
    const shown = promptBlock(state, target.bundleId);
    if (shown) return outcome(ctx, "blocked", promptBlockDetail(shown, "permission prompt visible"), shown.prompt ? { prompt: shown.prompt } : {});
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
    // The presence probes still ahead (the owner checks before typing and
    // after the read that follows it, and the idle read that marks our
    // typing) count at this delivery's slowest owner check each; with none
    // measured, at every command's timeout and kill grace (frontApp runs
    // two, idleMs one).
    const left = ctx.endsAt - now();
    const probeRound = ctx.slowestProbe ?? 3 * commandMs;
    if (left < (leftover ? 3 : 4) * ctx.slowest + (leftover ? 0 : ctx.typingMs) + (leftover ? 2 : 3) * probeRound) {
      return outcome(ctx, "blocked", `not enough time left to type and confirm (${Math.round(left / 1000)} s); nothing typed`);
    }
    const beforeTyping = await ownerCheck(ctx, target);
    if (beforeTyping) return outcome(ctx, "blocked", beforeTyping);
    ctx.phase = "typing";
    if (!leftover) await act(ctx, "type_text", { app: target.bundleId, text }, signal, { timeoutMs: limits.uiReadTimeoutMs + ctx.typingMs });
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
    // Nothing typed is ever erased: a select-all and delete cannot be told
    // apart from erasing what the owner typed meanwhile. Unsent text stays
    // as a draft (a retry sends exactly it), and the outcome says to check it.
    const back = await ownerCheck(ctx, target);
    if (back) return outcome(ctx, "blocked", `${back}; ${LEFT_AS_DRAFT}`);
    if (!found.composer || normalizeUiText(found.composer.value) !== normalizeUiText(text)) {
      keep(ctx, "after", state);
      return outcome(ctx, "failed", `text mismatch, not sent; ${LEFT_AS_DRAFT}`);
    }
    const raised = promptBlock(state, target.bundleId);
    const changed = hasStopButton(state) ? "turn started before send"
      : raised ? "permission prompt appeared before send"
      : null;
    if (changed) return outcome(ctx, "blocked", `${changed}; ${LEFT_AS_DRAFT}`, raised?.prompt ? { prompt: raised.prompt } : {});

    // 9. Send: the Send button, else Return in the focused composer. Out of
    // time before either: still "typed", nothing sent.
    within(ctx, 1);
    ctx.phase = "sending";
    const send = findSendButton(state, target.bundleId);
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
        state = after;
      }
    }
    if (!pressed) {
      // Return goes to whatever has focus: the same guards as before typing,
      // on the latest read, right before the key. A failed click may still
      // have started a turn or raised a prompt.
      const composer = composerIn(ctx, state).composer;
      if (!composer || !isComposerFocused(state, composer) || !verifyIdentity(state, identity).ok) return outcome(ctx, "blocked", `send not pressed: the composer lost focus or the thread changed; ${LEFT_AS_DRAFT}`);
      const card = promptBlock(state, target.bundleId);
      const started = hasStopButton(state) ? "turn started before send" : card ? "permission prompt appeared before send" : null;
      if (started) return outcome(ctx, "blocked", `${started}; ${LEFT_AS_DRAFT}`, card?.prompt ? { prompt: card.prompt } : {});
      const away = await ownerCheck(ctx, target);
      if (away) return outcome(ctx, "blocked", `${away}; ${LEFT_AS_DRAFT}`);
      await press(ctx, "Return", signal);
      ctx.keyEnd = now();
    }
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
    // Open Computer Use 0.3.5-0.3.6 cannot find the app's window (a
    // WindowServer state an app restart or reboot clears): nothing about the
    // thread is known, so it is its own kind the supervisor can count.
    if (!timedOut && ctx.phase === "check" && APP_UNREADABLE.test(`${error?.message ?? ""} ${error?.ocuText ?? ""}`)) {
      return outcome(ctx, "blocked", `can't read ${ctx.request.target?.name ?? "the app"}: Open Computer Use finds no window (cgWindowNotFound); nothing typed`, { code: "appUnreadable" });
    }
    const reason = timedOut ? "delivery timed out" : detailText(error?.message ?? error) || "Open Computer Use error";
    if (ctx.phase === "check") return outcome(ctx, "failed", `${reason}; nothing typed`);
    if (ctx.phase === "sending" || ctx.phase === "sent") {
      return outcome(ctx, "failed", `${reason}; unconfirmed: may have been sent; check the thread before retrying`, { unconfirmed: true });
    }
    // Typed, not sent: the text stays as a draft (see step 8).
    return outcome(ctx, "failed", `${reason}; not sent; ${LEFT_AS_DRAFT}`);
  }

  // One read or click at a time with every other app request (deliveries
  // hold the same lock in the executor).
  async function locked(fn) {
    const result = await uiLock.run(fn, { waitMs: limits.uiLockWaitMs });
    return result.busy ? { status: "blocked", detail: "busy: another app request is running; retry" } : result.value;
  }

  // Reads one thread's screen: its permission card (buttons and stateId),
  // whether a turn runs, any Resume button, and the transcript's tail. No
  // input; the thread already on screen is read even with the owner at the
  // keyboard. request: { target, identity, evidenceName, deadlineAt }
  async function inspect(request = {}) {
    return locked(() => runRequest(request, async (ctx, signal) => {
      const target = request.target;
      if (!target?.bundleId || !ALLOWED_BUNDLES.has(target.bundleId)) return outcome(ctx, "blocked", "no app the fleet reads shows this thread");
      const opened = await openThread(ctx, signal, { needFront: false, navigate: request.navigate !== false });
      if (opened.blocked) return opened.blocked;
      keep(ctx, "screen", opened.state);
      return outcome(ctx, "read", `read ${target.name}`, { screen: screenSummary(opened.state, target.bundleId) });
    }));
  }

  // Which element a label names on this screen: a button of the current
  // permission card (its stateId, when given, must still match), or the one
  // Resume goal / Retry / Resume button. Anything else is refused with the
  // labels that are clickable.
  function clickChoice(state, label, stateId, bundleId) {
    const want = choiceText(label);
    const prompt = findPrompt(state, bundleId);
    const resumes = resumeButtons(state, bundleId);
    const clickable = [...new Set([...(prompt?.labels ?? []), ...resumes.map(buttonLabel)])];
    const refuse = (detail, status = "failed") => ({ status, detail, prompt: prompt ? { text: prompt.text, buttons: prompt.labels, stateId: prompt.stateId } : null });
    if (prompt && prompt.labels.some((shown) => choiceText(shown) === want)) {
      if (stateId && stateId !== prompt.stateId) return refuse("prompt changed; read again", "blocked");
      const matches = prompt.buttons.filter((element) => choiceLabel(element) === want);
      if (matches.length !== 1) return refuse(`"${label}" is on ${matches.length} buttons; not clicking`);
      return { element: matches[0], label: buttonLabel(matches[0]), gone: (next) => findPrompt(next, bundleId)?.stateId !== prompt.stateId };
    }
    if (RESUME_LABELS.has(want)) {
      const matches = resumes.filter((element) => choiceLabel(element) === want);
      if (matches.length === 1) {
        return { element: matches[0], label: buttonLabel(matches[0]),
          gone: (next) => hasStopButton(next) || !resumeButtons(next, bundleId).some((element) => choiceLabel(element) === want) };
      }
      if (matches.length > 1) return refuse(`"${label}" is on ${matches.length} buttons; not clicking`);
    }
    return refuse(`"${label}" is not a button the fleet clicks here; clickable: ${clickable.length ? clickable.join(", ") : "none"}`);
  }

  // Clicks one permission-card or Resume button by its exact label, through
  // accessibility (no foreground, no pointer), then re-reads until the card
  // is gone. request: { target, identity, label, stateId, evidenceName, deadlineAt }
  async function clickLabel(request = {}) {
    return locked(() => runRequest(request, async (ctx, signal) => {
      const target = request.target;
      if (!target?.bundleId || !ALLOWED_BUNDLES.has(target.bundleId)) return outcome(ctx, "blocked", "no app the fleet drives shows this thread");
      if (!normalizeUiText(request.label)) return outcome(ctx, "blocked", "no label to click");
      if (inputLatch.held) return outcome(ctx, "blocked", `computer use not ready: ${inputLatch.detail}; nothing clicked`);
      const opened = await openThread(ctx, signal, { needFront: false });
      if (opened.blocked) return opened.blocked;
      let state = opened.state;
      const choice = clickChoice(state, request.label, request.stateId ?? null, target.bundleId);
      if (!choice.element) return outcome(ctx, choice.status, choice.detail, choice.prompt ? { prompt: choice.prompt } : {});
      keep(ctx, "before", state);
      ctx.phase = "sending";
      await click(ctx, choice.element, signal);
      ctx.phase = "sent";
      const deadline = now() + limits.uiConfirmMs;
      do {
        await sleep(limits.uiPollMs);
        state = await readState(ctx, signal);
        if (choice.gone(state)) {
          keep(ctx, "after", state);
          const next = promptButtons(state, target.bundleId);
          return outcome(ctx, "sent", `clicked ${choice.label} in ${target.name}`, next ? { prompt: next } : {});
        }
      } while (now() < deadline);
      keep(ctx, "after", state);
      return outcome(ctx, "failed", `clicked ${choice.label}, but it still shows; read the thread again before retrying`, { unconfirmed: true });
    }));
  }

  // The owner's apps, checked once per tick so computer-use-first can fall
  // back to the CLI for a thread whose app is closed.
  const appRunning = (bundleId) => presence.appRunning(bundleId);

  // One ioreg read for the idle watcher: never readiness, never OCU.
  const idleMs = () => presence.idleMs();
  return { readiness, deliver, inspect, clickLabel, appRunning, idleMs };
}
