// Proof that a turn is the authenticated owner's, and what that owner asked
// for. A principal is minted only by transport code right after its auth
// passed (hosted-interface /message, a paired phone, a G2 tap) and travels in
// handleMessage options, never in a body. The brand lives in a module-private
// WeakSet, so no JSON value, model argument, tool result or journal replay can
// ever pass isOwnerPrincipal.

const PRINCIPALS = new WeakSet();
const VIAS = new Set(["owner", "overlay", "phone", "g2"]);

// OPENAGI_OWNER_AUTHORITY=off restores queue-everything approvals.
export function ownerAuthorityEnabled(env = process.env) {
  return String(env.OPENAGI_OWNER_AUTHORITY ?? "").trim().toLowerCase() !== "off";
}

export function ownerPrincipal(via, nodeId = null) {
  if (!VIAS.has(via)) throw new Error(`unknown owner transport: ${String(via).slice(0, 40)}`);
  const principal = Object.freeze({
    kind: "owner",
    via,
    nodeId: typeof nodeId === "string" && nodeId ? nodeId.slice(0, 200) : null
  });
  PRINCIPALS.add(principal);
  return principal;
}

export function isOwnerPrincipal(value, env = process.env) {
  return value !== null && typeof value === "object" && PRINCIPALS.has(value) && ownerAuthorityEnabled(env);
}

// Audit copy for the user message. Written by the server every turn and never
// read back as authority.
export function authorityRecord(principal) {
  if (!isOwnerPrincipal(principal)) return null;
  return { kind: principal.kind, via: principal.via, nodeId: principal.nodeId };
}

// ---------------------------------------------------------------------------
// Intent families. A tainted turn (an untrusted tool result was read) still
// runs a gated tool without a code when the owner's own words name its family.

// Each family is a set of command verbs said as a command: at the start of a
// sentence or clause, or after a lead-in ("please", "and", "can you", "I need
// you to"). Nouns ("codex", "agent") and question verbs ("say", "what did")
// never count, so "what is the Claude agent doing?" or "what did codex say?"
// names no action. A family with nouns also needs one of them somewhere in
// the text ("open Safari", not just "open").
const LEAD = String.raw`(?:^|[.,;:!?\n]|\b(?:and|then|please|pls|now|also|just|ok|okay|yes|yeah|yep|so|let's|lets|go ahead and|(?:can|could|would|will) you|(?:want|need) you to)\b)\s*(?:(?:please|just|now|also)\s+)*`;

export const INTENT_FAMILIES = Object.freeze({
  approve: {
    verbs: "click|press|tap|hit|approve|allow|accept|confirm|choose|pick|select|resume|retry|deny|reject|decline|answer",
    tools: ["fleet_click", "fleet_answer_question"]
  },
  message: {
    verbs: "send|tell(?!\\s+(?:me|us)\\b)|reply|respond|nudge|write|message|ask|ping|answer",
    tools: ["fleet_send_message", "reply_to_coding_agent"]
  },
  app: {
    verbs: "open|close|quit|restart|relaunch|reopen|launch|reboot|start",
    tools: ["fleet_app"]
  },
  computer: {
    verbs: "use|open|click|type|check|look|go|navigate|drive|control|take|show|read|scroll|switch|browse|press|fill|find|search|log",
    nouns: /\b(computer|screen|mac|desktop|window|browser|safari|chrome|firefox|finder|website|site|web ?page|tab|app)\b/i,
    tools: ["start_computer_use_session"]
  },
  // Coding needs coding phrasing, not just a verb: a dispatch verb right
  // before a coding agent ("have codex fix", "spin up a coding agent") or a
  // repair verb aimed at code ("fix the failing tests", "repair PR 12"), so
  // "get the latest news" or "watch the game" never launch an agent.
  coding: {
    pattern: String.raw`(?:(?:start|launch|kick off|spin up|fire up|get|have|put|watch|monitor)\s+(?:(?:a|an|the|my|another|new|up)\s+)*(?:codex|claude|cursor|coding agents?|agents?)\b|(?:fix|repair|implement|build|debug|refactor)\s+(?:[\w'#-]+\s+){0,3}?(?:bugs?|tests?|build|ci|prs?|pull requests?|branch|repo|repository|code|codebase|crash|error|regression|feature)\b)`,
    tools: ["start_coding_agent", "watch_coding_agent"]
  }
});

const FAMILY_PATTERNS = new Map(Object.entries(INTENT_FAMILIES).map(([name, family]) =>
  [name, new RegExp(`${LEAD}${family.pattern ?? `(?:${family.verbs})\\b`}`, "i")]));

export function intentFamilies(text) {
  const value = String(text ?? "");
  return Object.entries(INTENT_FAMILIES)
    .filter(([name, family]) => FAMILY_PATTERNS.get(name).test(value) && (!family.nouns || family.nouns.test(value)))
    .map(([name]) => name);
}

// True only when one of the families the owner's text names covers the tool.
// Tools outside every family never pass: a tainted turn asks for the code.
export function intentCovers(intent, toolName) {
  return intentFamilies(intent).some((name) => INTENT_FAMILIES[name].tools.includes(toolName));
}

// The intent a tainted turn is judged on: the owner's own words only. The
// previous assistant message is never added, since it can quote text a tool
// read; a bare "yes" confirms a card through its code (confirmSpoken).
export function ownerIntentText(text) {
  return String(text ?? "").trim();
}

// ---------------------------------------------------------------------------
// The spoken confirm. The whole text must be assent (or refusal) plus filler
// and at most one 2-3 digit code: "Yes. Please approve that", "yes 42",
// "do it", "no 17". Anything else, a bystander sentence included, is not one.

const YES_PHRASES = [
  "click approve", "click allow", "click yes", "click it", "press approve", "tap approve",
  "go ahead", "do it", "send it", "run it", "yes please",
  "yes", "yeah", "yep", "yup", "ok", "okay", "sure", "approve", "approved", "confirm", "confirmed", "proceed", "allow"
].map((phrase) => phrase.split(" "));
const NO_PHRASES = [
  "do not allow", "don't allow", "dont allow", "do not", "don't", "dont", "no", "nope", "cancel", "deny", "denied", "reject", "stop"
].map((phrase) => phrase.split(" "));
const FILLER = new Set(["please", "it", "that", "this", "for", "me", "now", "then", "and", "just", "the", "one", "code", "number"]);

function consume(words, index, phrases) {
  for (const phrase of phrases) {
    if (phrase.every((word, offset) => words[index + offset] === word)) return phrase.length;
  }
  return 0;
}

export function matchConfirmation(text) {
  const raw = String(text ?? "").trim().toLowerCase();
  if (!raw || raw.length > 120) return null;
  const words = raw.replace(/[’]/g, "'").replace(/[^a-z0-9' ]+/g, " ").split(/\s+/).filter(Boolean);
  let code = null;
  let yes = 0;
  let no = 0;
  for (let index = 0; index < words.length;) {
    const word = words[index];
    if (/^\d{2,3}$/.test(word)) {
      if (code !== null) return null;
      code = word;
      index += 1;
      continue;
    }
    // Longest phrase first, refusals before assent ("do not" before "do it").
    const refusal = consume(words, index, NO_PHRASES);
    if (refusal) { no += 1; index += refusal; continue; }
    const assent = consume(words, index, YES_PHRASES);
    if (assent) { yes += 1; index += assent; continue; }
    if (FILLER.has(word)) { index += 1; continue; }
    return null;
  }
  if (yes && !no) return { decision: "approve", code };
  if (no && !yes) return { decision: "deny", code };
  return null;
}
