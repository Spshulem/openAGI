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

export const INTENT_FAMILIES = Object.freeze({
  approve: {
    pattern: /\b(approve|approved|click|press|tap|hit|allow|accept|confirm|answer|choose|pick|select|resume|retry)\b/i,
    tools: ["fleet_click", "fleet_answer_question"]
  },
  message: {
    pattern: /\b(send|tell|message|reply|respond|say|ask|nudge|write|answer)\b/i,
    tools: ["fleet_send_message", "reply_to_coding_agent"]
  },
  app: {
    pattern: /\b(open|close|quit|restart|relaunch|reopen|launch|reboot)\b/i,
    tools: ["fleet_app"]
  },
  computer: {
    pattern: /\b(computer|screen|mac|desktop|click|type|window|browser|computer use)\b/i,
    tools: ["start_computer_use_session"]
  },
  coding: {
    pattern: /\b(start|run|launch|kick off|spin up|fix|repair|implement|code|coding|agent|watch|monitor|codex|claude)\b/i,
    tools: ["start_coding_agent", "watch_coding_agent"]
  }
});

export function intentFamilies(text) {
  const value = String(text ?? "");
  return Object.entries(INTENT_FAMILIES).filter(([, family]) => family.pattern.test(value)).map(([name]) => name);
}

// True only when one of the families the owner's text names covers the tool.
// Tools outside every family never pass: a tainted turn asks for the code.
export function intentCovers(intent, toolName) {
  return intentFamilies(intent).some((name) => INTENT_FAMILIES[name].tools.includes(toolName));
}

// The owner's text, plus the previous assistant message when the text is only
// an assent ("yes" carries the meaning of what it answers).
export function ownerIntentText(text, messages = []) {
  const own = String(text ?? "").trim();
  if (!matchConfirmation(own)) return own;
  const previous = [...(messages ?? [])].reverse().find((message) => message?.role === "assistant" && typeof message.content === "string");
  return previous ? `${own}\n${previous.content.slice(0, 2000)}` : own;
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
const FILLER = new Set(["please", "it", "that", "this", "for", "me", "now", "then", "and", "just", "the", "one", "code", "number", "thanks", "thank", "you"]);

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
