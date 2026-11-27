// Decision-ready context: the one standard every owner ask is held to, whether
// it reaches the owner as a Needs You card, an outreach/phone notification, a
// scheduled Supervisor check-in, or an Active Work follow-up.
//
// Each ask must say, in plain English and from recorded evidence only:
//   1. the owner's original goal and what this project/item is,
//   2. what the owner assigned the agent to do,
//   3. what has been verified or tried, what changed, and what is blocked and
//      why the agent cannot proceed alone,
//   4. the exact decision now, the meaningful options with consequences, and
//      the recommendation.
//
// Nothing here invents a part. A part that cannot be recovered from the source
// chat, the PR, the tracked goal, or the owning agent's own reply is reported in
// `missing`, so the caller can ask the owning agent for it before surfacing the
// ask, or label the gap honestly if the agent cannot be reached.

import { iconsToWords, stripEmphasis } from "./decision-view.js";
import { clampText, parsePrRef, redactSecrets } from "./contracts.js";

// How long a new ask is held back while its owning agent supplies missing
// context. After this it surfaces anyway, with the gaps named, so nothing is
// lost because an agent never answered.
export const CONTEXT_REQUEST_WAIT_MS = 2 * 60 * 60 * 1000;

// The labeled block the owning agent is asked to reply with.
export const AGENT_CONTEXT_MARKER = "DECISION CONTEXT";

const NON_DECISION_OPTIONS = new Set(["dismiss", "later", "open thread", "opened", "wait", "skip", "check pr", "view chat"]);
const TRIVIAL_USER_MSG_RE = /^(?:\[openagi supervisor\]|continue\b|resume(?:\s+working)?\.?$|yes\.?$|no\.?$|ok(?:ay)?\.?$|go ahead\.?$|proceed\.?$|status\??$|what(?:'s| is) the status\??$|done\.?$|got it\.?$|allow\.?$|keep going\.?$)/i;
const SUPERVISOR_MSG_RE = /^\s*(?:\[openagi supervisor\]|openagi supervisor:|DECISION CONTEXT REQUEST)/i;

// Internal identifiers the owner should never have to read: Fleet question and
// action ids, tracked-work ids, outreach/message ids, raw thread keys and UUIDs.
const INTERNAL_ID_RES = [
  /`?\b(?:fq|fa|ftw|tw|awa|out|msg_sup(?:_delta)?|msg|fb|fix)_[A-Za-z0-9]{6,}\b`?/g,
  /`?\b(?:sess|agent|thr|thread|run)_[A-Za-z0-9_]{3,}\b`?/g,
  /`?\bFQ[-_ ]?\d{1,6}\b`?/g,
  /`?\b(?:paseo|git|wt|conductor|codex|claude|cursor|devices|antigravity|bb3|proc):[^\s,;)`'"\]]{3,}`?/g,
  /`?\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b`?/gi,
  /`?\bwks_[0-9a-f]{6,}\b`?/gi
];

export function stripInternalIds(text) {
  let out = String(text ?? "");
  for (const re of INTERNAL_ID_RES) out = out.replace(re, "");
  return out
    .replace(/\((?:id|ids|session|question|ref|key)?[\s:,]*\)/gi, "")
    .replace(/\s+([,.;:])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/^\s*(?:[-—:·]\s*)+/, "")
    .replace(/\s*·\s*:/g, ":")
    .trim();
}

function prose(value, max = 400) {
  const raw = String(value ?? "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/<\/?[a-z_-]+[^>]*>/gi, "")
    .replace(/\r/g, "")
    // Emphasis pairs only: "__cache__" in a path or "rm -rf **/build" is
    // command text the owner must see unchanged.
    .replace(/[\s\S]*/, (all) => stripEmphasis(all))
    .replace(/\n{2,}/g, "\n")
    .trim();
  const cleaned = stripInternalIds(redactSecrets(raw)).replace(/\n/g, " ").replace(/\s{2,}/g, " ").trim();
  return cleaned ? clampText(cleaned, max) : null;
}

function prLabel(ref) {
  const parsed = parsePrRef(ref);
  return parsed ? `PR #${parsed.number}` : null;
}

function prUrlFor(ref, url = null) {
  if (typeof url === "string" && /^https?:\/\//.test(url)) return url;
  const parsed = parsePrRef(ref);
  return parsed ? `https://github.com/${parsed.repo}/pull/${parsed.number}` : null;
}

// The owning agent's labeled reply to a context request, read from its latest
// message. Labels are matched loosely; an unlabeled reply supplies nothing.
const NO_DECISION_RE = /^\W*(?:not\s+set\b|none\b(?!\s+of\b)|n\/a\b|nothing\s+(?:to\s+decide|(?:is\s+)?needed|pending)\b|no\s+(?:explicit\s+|owner\s+|new\s+)?(?:question|decision|options?|recommendation|choice)s?\b|there\s+(?:is|are)\s+no\s+(?:question|decision|options?)\b|i\s+(?:did\s+not|didn't)\s+ask\b)/i;
// "None — keep the current setup" is a choice with its consequence, not a
// statement that there is nothing to choose.
const LABELED_CHOICE_RE = /^\W*[^—–:]{1,60}?\s*(?:—|–|:|\s-\s|→|=>)\s*\S/;
const statesNoDecision = (text) => NO_DECISION_RE.test(text) && !LABELED_CHOICE_RE.test(text);

export function parseAgentSuppliedContext(text) {
  const raw = String(text ?? "");
  const at = raw.toUpperCase().lastIndexOf(AGENT_CONTEXT_MARKER);
  if (at === -1) return null;
  const block = raw.slice(at + AGENT_CONTEXT_MARKER.length).replace(/^[\s:*#-]+/, "");
  // Whole-label matches only: "Option one all regions — because…" is an
  // option line, not an "Options:" header.
  const labels = {
    goal: /^(?:original\s+)?goal$|^what\s+this\s+is$|^project$/i,
    assignment: /^assign(?:ed|ment)$|^you\s+asked(?:\s+me)?(?:\s+to)?$|^task$/i,
    verified: /^verified$|^tried$|^tested$/i,
    changed: /^changed$|^what\s+changed$/i,
    blocked: /^blocked(?:\s+on|\s+because)?$|^why\s+(?:i|the agent)\s+can(?:no|')t(?:\s+proceed)?(?:\s+alone)?$|^can(?:no|')t\s+proceed(?:\s+alone)?$/i,
    decision: /^decision$|^question$/i,
    options: /^options?$/i,
    recommendation: /^recommend(?:ation|ed)?$/i
  };
  const out = {};
  let current = null;
  for (const line of block.split(/\n/)) {
    // The block ends where the agent restates its earlier questions.
    if (/^\s*(?:\*\*)?original\s+questions?\b/i.test(line)) break;
    const trimmed = line.replace(/^\s*(?:[-*•]|\d+[.)])?\s*\**/, "").trim();
    if (!trimmed) continue;
    const m = /^([A-Za-z][A-Za-z /']{1,40}?)\**\s*[:\-—]\s*(.*)$/.exec(trimmed);
    const field = m ? Object.keys(labels).find((name) => labels[name].test(m[1].trim())) : null;
    if (field) {
      // The first value in the block wins: an agent that restates its
      // original ask afterwards ("Blocked on: …") must not overwrite it.
      if (field !== "options" && out[field] !== undefined) { current = null; continue; }
      current = field;
      if (field === "options") {
        out.options = out.options ?? [];
        if (m[2].trim()) out.options.push(m[2].trim());
      } else {
        out[field] = m[2].trim();
      }
      continue;
    }
    if (current === "options") {
      out.options.push(trimmed);
    } else if (current) {
      out[current] = `${out[current]} ${trimmed}`.trim();
    }
  }
  // An agent stating there is no decision ("Not set by me", "No options
  // were offered", "None") has supplied nothing to decide.
  for (const field of ["decision", "recommendation"]) {
    if (out[field] && statesNoDecision(out[field])) delete out[field];
  }
  const options = (out.options ?? [])
    .filter((entry) => !statesNoDecision(entry))
    .map((entry) => {
      const parts = /^(.{1,80}?)(?:\s+(?:—|–|-|→|=>)|\s*:)\s+(.+)$/.exec(entry);
      return parts
        ? { label: prose(parts[1], 80), consequence: prose(parts[2], 220) }
        : { label: prose(entry, 80), consequence: null };
    })
    .filter((opt) => opt.label);
  const result = {
    goal: prose(out.goal, 360),
    assignment: prose(out.assignment, 360),
    verified: prose(out.verified, 360),
    changed: prose(out.changed, 360),
    blocked: prose(out.blocked, 300),
    decision: prose(out.decision, 300),
    options,
    recommendation: prose(out.recommendation, 240)
  };
  return Object.values(result).some((v) => (Array.isArray(v) ? v.length : Boolean(v))) ? result : null;
}

// Only the agent's latest message counts: a block from earlier in the chat
// may describe an older ask, and must never label a newer, different one.
// The block also has to name the same decision when the ask has options.
function latestAgentContext(messages, agentSummary) {
  const latest = [...(messages ?? [])].reverse().find((m) => m?.role !== "user")?.text ?? null;
  // Message windows keep only a message's tail; the fuller agent summary is
  // used when it is the same latest message.
  const tail = String(latest ?? "").trim().slice(-80);
  const sameFuller = agentSummary && (!latest || (tail && String(agentSummary).trim().endsWith(tail))) ? agentSummary : null;
  // Only the latest message counts, so an older block can't describe a newer
  // ask. Option labels are not required to match the question's: agents
  // word them differently, and rejecting on that discarded every real reply
  // (live 2026-11-23), which kept re-requesting the same context.
  return parseAgentSuppliedContext(latest) ?? parseAgentSuppliedContext(sameFuller);
}

function sourceRequest(messages) {
  const userMsgs = (messages ?? [])
    .filter((m) => m && m.role === "user" && typeof m.text === "string")
    .map((m) => m.text.trim())
    .filter((text) => text && !TRIVIAL_USER_MSG_RE.test(text) && !SUPERVISOR_MSG_RE.test(text)
      && !/^The previous turn stopped because of a temporary provider/i.test(text));
  if (!userMsgs.length) return { first: null, latest: null };
  const first = userMsgs.find((text) => text.length >= 28) ?? userMsgs[0];
  const latest = userMsgs[userMsgs.length - 1];
  return { first: prose(first, 360), latest: latest !== first ? prose(latest, 300) : null };
}

// The agent's own words for why it stopped, e.g. "Single owner action: run
// sudo xcodebuild -license accept". Read from its latest message only.
const BLOCKER_SENTENCE_RE = /\b(?:blocked|cannot|can't|can not|unable to|requires? (?:sudo|admin|your|owner|spencer|credentials?|approval)|needs? (?:your|owner|spencer|sudo|admin|credentials?|approval)|owner action|only you|waiting (?:on|for) (?:you|your|spencer|owner))\b/i;
// Card state lines that only restate "waiting for you" carry no reason.
const GENERIC_STATE_RE = /^(?:Paused at a decision checkpoint|Blocked at an external\/environment gate)/i;

// ---- "Where it stands": one plain status sentence (two at most) ----------

const STATUS_NOISE_RE = /^(?:-{2,}|\*{2,}|!\[|\[image\]|supervisor review:|not recoverable|agent's latest update:)/i;
const LAST_KNOWN_MS = 24 * 60 * 60 * 1000;

function tokens(text) {
  return new Set(String(text ?? "").toLowerCase().replace(/[^a-z0-9@#.\s]/g, " ").split(/\s+/).filter((w) => w.length > 2));
}

// Two sentences saying the same thing ("Google still blocks the channel…"
// and "Google still reports … permission…") count as one.
function similar(a, b) {
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.size || !tb.size) return false;
  let shared = 0;
  for (const w of ta) if (tb.has(w)) shared += 1;
  // Against the longer sentence: sharing a few words (a PR number, a
  // project name) with the decision is not a repeat.
  return shared / Math.max(ta.size, tb.size) >= 0.6;
}

function withoutChoiceLists(text) {
  const lines = String(text ?? "").replace(/\r/g, "").split("\n");
  const isItem = (l) => /^\s*(?:[-*•]|\d+[.)])\s+/.test(l);
  const out = [];
  let inChoices = false;
  for (const line of lines) {
    if (isItem(line)) {
      if (inChoices) continue;
      if (/^\s*\d+[.)]\s+/.test(line) && /\?/.test(line)) continue;
      out.push(line);
      continue;
    }
    inChoices = Boolean(line.trim()) && CHOICE_HEADER_RE.test(line) && !RESULT_HEADER_RE.test(line);
    if (!line.trim()) inChoices = false;
    out.push(line);
  }
  return out.join("\n");
}

function statusSentences(text) {
  // Only the decision's own choice lists are left out of "where it stands":
  // bullets right after a line asking for a choice, and numbered items that
  // ask something. Other bullets (test results, failures) are status.
  // Table rows are status in plain words, never pipes: one line per PR row,
  // each value named by its column.
  let header = null;
  const prose_ = withoutChoiceLists(text)
    .split(/\n/)
    .flatMap((line) => {
      if (!/^\s*\|.*\|\s*$/.test(line)) { header = null; return [line]; }
      const cells = line.trim().slice(1, -1).split("|").map((c) => iconsToWords(stripEmphasis(c).replace(/`/g, "")).trim());
      if (cells.every((c) => /^:?-{2,}:?$/.test(c) || !c)) return [];
      if (!header) { header = cells; return []; }
      if (!/#\d{1,7}\b/.test(cells[0] ?? "")) return [];
      const facts = cells.slice(1).map((c, i) => (c ? `${header[i + 1] || "Value"}: ${c}` : null)).filter(Boolean);
      return [`${cells[0]}: ${facts.join(", ")}.`];
    })
    .join("\n");
  return splitSentences(stripEmphasis(prose_.replace(/^-{2,}\s*/gm, "")).replace(/`/g, ""))
    .map((t) => t.replace(/^[-*•]\s+/, "").trim())
    // A clipped excerpt starts mid-sentence ("…eady say"); a lead-in ends in
    // ":" ("Decisions I need from you:"). Neither is a status.
    .filter((t) => t.length >= 6 && !/^…/.test(t) && !/:$/.test(t) && !/^\d+[.)]\s/.test(t))
    .filter((t) => !STATUS_NOISE_RE.test(t) && !/^\[?openagi supervisor\]?/i.test(t));
}

function messageMs(message) {
  const ms = Date.parse(message?.at ?? "");
  return Number.isFinite(ms) ? ms : null;
}

function isSubstantive(message) {
  const text = String(message?.text ?? "").trim();
  if (!text || /^!\[[^\]]*\]\([^)]*\)\s*$/.test(text)) return false;
  if (message?.role === "user" && (TRIVIAL_USER_MSG_RE.test(text) || SUPERVISOR_MSG_RE.test(text))) return false;
  return true;
}

function shortDate(ms) {
  return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

// Builds the status from the newest evidence: the agent's latest update, or
// the owner's newer update the agent has not answered yet. A blocker from
// before the newest update is "last known" and left to the details.
function buildStatus({ recentMessages, supplied, fallbacks, avoid, nowMs }) {
  const msgs = (recentMessages ?? []).filter(isSubstantive);
  const lastAgent = [...msgs].reverse().find((m) => m.role !== "user") ?? null;
  const lastUser = [...msgs].reverse().find((m) => m.role === "user") ?? null;
  const agentMs = messageMs(lastAgent);
  const userMs = messageMs(lastUser);
  const ownerNewer = lastUser && (agentMs === null ? !lastAgent : userMs !== null && userMs > agentMs);

  let picked = [];
  let atMs = null;
  if (supplied && (supplied.changed || supplied.blocked)) {
    picked = [supplied.changed, supplied.blocked].filter(Boolean).flatMap(statusSentences);
    atMs = agentMs;
  } else if (ownerNewer) {
    const said = statusSentences(lastUser.text)[0];
    picked = said ? [`You said: ${said.replace(/[.!]?$/, ".")} The agent hasn't replied yet.`] : [];
    atMs = userMs;
  } else if (lastAgent) {
    picked = statusSentences(lastAgent.text).filter((t) => !/\?$/.test(t));
    atMs = agentMs;
  }
  if (!picked.length) picked = fallbacks.filter(Boolean).flatMap(statusSentences);

  const out = [];
  for (const sentence of picked) {
    if (avoid.some((a) => a && similar(sentence, a))) continue;
    if (out.some((kept) => similar(sentence, kept))) continue;
    out.push(/[.!?…:)]$/.test(sentence) ? sentence : `${sentence}.`);
    if (out.length === 2) break;
  }
  if (!out.length) return null;
  let text = clampText(out.join(" "), 260);
  if (atMs !== null && Number.isFinite(nowMs) && nowMs - atMs > LAST_KNOWN_MS) {
    text = `Last known (${shortDate(atMs)}): ${text}`;
  }
  return text;
}

// Asks that carry no decision of their own ("needs your call. Answer?").
const GENERIC_ASK_RE = /^(?:answer\??|proceed\??|continue\??|question \d+.*|.{0,60}needs your (?:call|decision|input)\.?\s*(?:answer\?)?|.{0,40}\bAnswer\?)$/i;

export function isGenericAsk(text) {
  return GENERIC_ASK_RE.test(String(text ?? "").trim());
}

function splitSentences(text) {
  return String(text ?? "").replace(/\r/g, "").split(/(?<=[.!?])\s+|\n+/).map((t) => t.trim()).filter(Boolean);
}

function latestAgentText(agentSummary, messages) {
  return [...(messages ?? [])].reverse().find((m) => m?.role !== "user")?.text ?? agentSummary ?? "";
}

function agentBlockerSentence(agentSummary, messages) {
  const hit = splitSentences(latestAgentText(agentSummary, messages)).reverse().find((t) => BLOCKER_SENTENCE_RE.test(t) && t.length >= 12);
  return hit ? prose(hit, 260) : null;
}

// The decision an agent names without asking a question, e.g. "Blocked on:
// your decision on server port and iOS build" -> "Your decision on server
// port and iOS build."
const NAMED_DECISION_RE = /\byour (decision|call|approval|go-ahead|sign-off|choice) (on|for|to|about|between) ([^.;\n]{4,160})/i;

// Only a decision still pending counts ("Blocked on: your decision on X",
// "still needs your approval for Y"); "I applied your decision on X" is
// past work and must not replace the current ask.
const PENDING_RE = /\b(?:blocked|need(?:s|ed)?|waiting|wait on|still|pending|before|requires?|until)\b/i;
const PAST_RE = /\b(?:applied|used|made|took|followed|got|per|thanks for|as you (?:asked|decided)|implemented|did)\b[^.]{0,20}\byour (?:decision|call|choice|approval|go-ahead|sign-off)\b/i;

function agentNamedDecision(agentSummary, messages) {
  const sentences = splitSentences(String(latestAgentText(agentSummary, messages)).replace(/[*`]/g, "")).reverse();
  for (const sentence of sentences) {
    const m = NAMED_DECISION_RE.exec(sentence);
    if (!m || PAST_RE.test(sentence) || !PENDING_RE.test(sentence)) continue;
    return prose(`Your ${m[1].toLowerCase()} ${m[2].toLowerCase()} ${m[3].trim()}.`, 220);
  }
  return null;
}

// Choices the agent listed as a short bullet list ("- port 9803 first"),
// used only when the question itself carries no options. Only a list that
// directly follows a line asking for a choice counts: bullets after
// "Verified:" or other results are never decision options.
const CHOICE_HEADER_RE = /\?\s*\**\s*$|\b(?:options?|choices?|pick(?: one)?|choose|either|which (?:one|way))\b|\byour (?:decision|call|choice|approval|go-ahead|sign-off)\b/i;
const RESULT_HEADER_RE = /^\s*\**\s*(?:verified|tested|checked|done|completed|changed|passed|results?|what (?:changed|i did))\b/i;

function agentListedOptions(agentSummary, messages) {
  const lines = String(latestAgentText(agentSummary, messages)).replace(/\r/g, "").split("\n");
  const bullet = (l) => /^\s*(?:[-*•]|\d+[.)])\s+(.{2,80})$/.exec(l)?.[1]?.replace(/[*`]/g, "").trim() ?? null;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line.trim() || bullet(line)) continue;
    if (RESULT_HEADER_RE.test(line) || !CHOICE_HEADER_RE.test(line)) continue;
    const found = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      if (!lines[j].trim()) { if (found.length) break; continue; }
      const b = bullet(lines[j]);
      if (!b) break;
      found.push(b);
    }
    if (found.length >= 2 && found.length <= 5) return found;
  }
  return [];
}

// Related sub-decisions the agent numbered ("1. The video: … 2. App Home:
// …"), with each option placed under the one it belongs to. Only when every
// sub-decision gets at least one option and every option fits one.
function groupedDecisions(agentSummary, messages, options) {
  const items = [];
  for (const line of String(latestAgentText(agentSummary, messages)).replace(/\r/g, "").split("\n")) {
    const m = /^\s*(\d+)[.)]\s+\**([^:*\n]{2,40}?)\**\s*:\**\s*(.+)$/.exec(line.replace(/`/g, ""));
    if (m) items.push({ label: m[2].trim(), text: `${m[2]} ${m[3]}` });
  }
  if (items.length < 2 || options.length < 2) return null;
  const placed = items.map(() => []);
  for (const opt of options) {
    const words = [...tokens(opt.label)];
    const scores = items.map((it) => { const t = tokens(it.text); return words.filter((w) => t.has(w)).length; });
    const best = Math.max(...scores);
    if (best === 0 || scores.filter((x) => x === best).length > 1) return null;
    placed[scores.indexOf(best)].push(opt);
  }
  if (placed.some((p) => !p.length)) return null;
  return items.map((it, i) => ({ label: it.label, options: placed[i] }));
}

// A single action only the owner can take ("Single owner action: On
// BuildBot2, run sudo xcodebuild -license accept."). It is a decision with
// two real outcomes: do it (the agent continues) or not now.
// Affirmative only: a line that starts "Owner action:" (optionally
// "Single owner action:"). "No owner action required" or an action already
// done is not a decision.
const OWNER_ACTION_LINE_RE = /^\s*(?:[-*•]\s*)?(?:single\s+)?owner\s+action\s*:\s*(.{6,200})$/im;
const NOT_NEEDED_RE = /\b(?:no|not|none)\b[^.]{0,30}\b(?:required|needed|necessary)\b|\b(?:already|was)\s+(?:done|completed|handled|applied)\b/i;

function agentOwnerAction(agentSummary, messages) {
  const text = stripEmphasis(String(latestAgentText(agentSummary, messages)));
  const m = OWNER_ACTION_LINE_RE.exec(text);
  if (!m || NOT_NEEDED_RE.test(m[1])) return null;
  return prose(m[1], 200);
}

// The agent's own question, e.g. "Rotate the key, or hold?".
function agentQuestionSentence(agentSummary, messages) {
  const hit = splitSentences(latestAgentText(agentSummary, messages)).reverse().find((t) => /\?$/.test(t) && t.length >= 8 && !GENERIC_ASK_RE.test(t));
  return hit ? prose(hit.replace(/^[-*•]\s*/, ""), 260) : null;
}

function prUserStory(body) {
  const raw = String(body ?? "");
  const m = /(?:^|\n)##+\s*(?:User\s+story|Why|Goal|Problem|Context|Summary)\s*\n+([\s\S]*?)(?=\n##+\s|$)/i.exec(raw);
  return m?.[1] ? prose(m[1], 300) : null;
}

export function realDecisionOptions(options) {
  return (Array.isArray(options) ? options : [])
    .map((o) => String(o ?? "").trim())
    .filter((o) => o && !NON_DECISION_OPTIONS.has(o.toLowerCase()));
}

// FYIs and session errors are not decisions: they never count as "waiting on
// you" and never trigger a decision notification.
export function classifyAsk(question) {
  const kind = String(question?.kind ?? "").toLowerCase();
  if (kind === "completed") return "fyi";
  if (kind === "session-error") return "session_error";
  // "Nudges can't get through" is the Supervisor's own delivery recovery
  // (retry, failover, waiting out a quota), not an owner decision: it is
  // shown with session errors and never pushed or announced in check-ins.
  if (kind === "deliver" && !question?.threadKey) return "session_error";
  return "decision";
}

const OPTION_CONSEQUENCES = [
  [/^(?:merge(?: pr)?|approve (?:&|and) merge)$/i, (c) => `${c.prName ?? "The PR"} merges into the base branch. Deploying is a separate step.`],
  [/^approve$/i, (c) => (c.isMerge ? `${c.prName ?? "The PR"} merges into the base branch. Deploying is a separate step.` : null)],
  [/^merge (?:&|and) deploy$/i, (c) => `${c.prName ?? "The PR"} merges and then deploys.`],
  [/^(?:allow|yes, allow|approve)$/i, (c) => (c.command ? `The agent runs \`${clampText(c.command, 80)}\` and continues.` : "The agent takes the requested step and continues.")],
  [/^(?:deny|no)$/i, () => "The agent skips that step and stays paused until it hears how else to proceed."],
  [/^(?:later|wait|hold(?: off)?)$/i, () => "Nothing changes now; this stays open and the agent stays paused."],
  [/^snooze$/i, () => "Nothing changes now; this goal is out of view until the snooze ends, then comes back."],
  [/^(?:skip|dismiss)$/i, () => "This ask closes without an answer; the agent is not told to continue."],
  [/^resume (?:existing )?owner$/i, (c) => `${c.ownerName ? `${c.ownerName} is` : "The owning session is"} sent back to finish the remaining work.`],
  [/^confirm done$/i, () => "The goal is marked verified complete and stops being tracked."],
  [/^assign orphan$/i, () => "A session is assigned to own this open work again."],
  [/^propose archive$/i, () => "The finished session is proposed for archiving (you confirm before anything is archived)."],
  [/^(?:fix|retry|rebase)/i, () => "The owning session is sent back to do this before anything merges."],
  [/^(?:added|done|opened)$/i, () => "Tells the Supervisor you handled it, so it retries the stuck sessions."]
];

function optionConsequence(label, ctx) {
  for (const [re, fn] of OPTION_CONSEQUENCES) {
    if (!re.test(label)) continue;
    const text = fn(ctx);
    if (text) return text;
  }
  return null;
}

function humanOption(label) {
  const raw = String(label ?? "").trim();
  return raw ? raw[0].toUpperCase() + raw.slice(1) : raw;
}

// Builds the four-part context from whatever the caller can see. Inputs are
// all optional; the result says which parts are still missing.
export function buildDecisionContext({
  question = {},
  itemName = null,
  project = null,
  sessionTitle = null,
  prMeta = null,
  recentMessages = [],
  agentSummary = null,
  activeGoal = null,
  openChat = null,
  currentState = null,
  recommendation = null,
  reviewBrief = null,
  permission = null,
  followUp = null,
  contextRequest = null,
  now = Date.now()
} = {}) {
  const askType = followUp ? "decision" : classifyAsk(question);
  const supplied = latestAgentContext(recentMessages, agentSummary);
  const req = sourceRequest(recentMessages);
  const prRef = prMeta?.ref ?? question?.prRef ?? followUp?.prRef ?? null;
  const prName = prLabel(prRef);
  const prTitle = prose(prMeta?.title, 140);

  const projectName = prose(project, 60);
  const titleName = prose(sessionTitle, 90);
  const name = prose(itemName, 120)
    || (projectName && titleName && titleName.toLowerCase().includes(projectName.toLowerCase())
      ? titleName
      : [projectName, titleName].filter(Boolean).join(" · "))
    || (prName && prTitle ? `${prName}: ${prTitle}` : prName)
    || prose(followUp?.project, 80)
    || null;

  // 1. Goal + what this is.
  const goalFromTracked = activeGoal?.goal ? prose(activeGoal.goal, 300) : null;
  const goal = supplied?.goal
    || goalFromTracked
    || prUserStory(prMeta?.rawBody ?? prMeta?.bodySummary)
    || (reviewBrief?.context && !/^you asked/i.test(String(reviewBrief.context)) ? prose(reviewBrief.context, 300) : null)
    || req.first
    || null;

  // 2. What the owner assigned the agent.
  const trackedAssignment = activeGoal
    ? [activeGoal.nextAction ? prose(activeGoal.nextAction, 200) : null, activeGoal.doneCriteria ? `done when ${prose(activeGoal.doneCriteria, 160)}` : null].filter(Boolean).join("; ")
    : null;
  const assignment = supplied?.assignment
    || (req.first && req.first !== goal ? req.first : null)
    || trackedAssignment
    || (req.first && req.first === goal ? (req.latest ? `${req.first} Latest direction: ${req.latest}` : req.first) : null)
    || null;

  // 3. Verified / tried / changed / blocked.
  const verified = [];
  if (supplied?.verified) verified.push(supplied.verified);
  const ci = prMeta?.ciState ?? null;
  if (prName && ci) {
    if (ci === "SUCCESS") verified.push(`CI is green on ${prName}.`);
    else if (ci === "FAILURE" || ci === "ERROR") {
      const failing = (prMeta?.failingChecks ?? []).slice(0, 2).join(", ");
      verified.push(`CI is failing on ${prName}${failing ? ` (${failing})` : ""}.`);
    } else if (ci === "PENDING" || ci === "IN_PROGRESS") verified.push(`CI is still running on ${prName}.`);
  }
  if (Array.isArray(prMeta?.gates) && prMeta.gates.length) {
    verified.push(`Gates: ${prMeta.gates.map((g) => `${g.label} ${String(g.state ?? "unknown").toLowerCase()}`).join(", ")}.`);
  }
  if (question?.reviewedAt && question?.reviewReason) verified.push(`Supervisor review: ${prose(question.reviewReason, 200)}`);
  for (const link of (followUp?.evidenceLinks ?? []).filter((l) => l?.verified).slice(0, 2)) {
    verified.push(`${prose(link.label ?? link.kind, 60)} verified${link.state ? ` (${String(link.state).toLowerCase()})` : ""}.`);
  }
  const changedParts = [];
  if (supplied?.changed) changedParts.push(supplied.changed);
  if (prName && prTitle) {
    const stat = Number.isFinite(prMeta?.additions) && Number.isFinite(prMeta?.deletions) ? ` (+${prMeta.additions}/-${prMeta.deletions})` : "";
    changedParts.push(`${prName} "${prTitle}"${stat}.`);
  }
  if (reviewBrief?.whatChanged) changedParts.push(prose(reviewBrief.whatChanged, 300));
  else if (followUp?.lastMeaningfulProgress?.summary) changedParts.push(`Last progress: ${prose(followUp.lastMeaningfulProgress.summary, 240)}`);
  else if (agentSummary && !supplied) changedParts.push({ agentUpdate: String(agentSummary).slice(-800) });

  let blocked = supplied?.blocked ?? null;
  if (!blocked) {
    const kind = String(question?.kind ?? "");
    if (followUp?.whySurfaced) blocked = prose(followUp.whySurfaced, 260);
    else if (kind === "prompt") {
      blocked = permission?.command
        ? `It needs permission to run \`${clampText(permission.command, 100)}\`. Agents cannot grant their own tool permissions.`
        : "It is waiting for a tool permission. Agents cannot grant their own permissions.";
    } else if (kind === "ready" || question?.mergeAsk) {
      blocked = `Merging needs your approval because you review every merge${ci && ci !== "SUCCESS" ? `, and CI is ${String(ci).toLowerCase()}` : ""}.`;
    } else if (reviewBrief?.currentState) blocked = prose(reviewBrief.currentState, 240);
    else if (agentBlockerSentence(agentSummary, recentMessages)) blocked = agentBlockerSentence(agentSummary, recentMessages);
    else if (currentState && !GENERIC_STATE_RE.test(currentState)) blocked = prose(currentState, 240);
  }

  // 4. Decision, options with consequences, recommendation.
  const items = Array.isArray(question?.meta?.items) ? question.meta.items : [];
  const activeItem = items.find((it) => String(it?.itemId ?? "") === String(question?.meta?.itemId ?? "")) ?? items[0] ?? null;
  const askedLine = prose(String(question?.card || question?.body || "").split(/\n/).find((l) => /\?\s*$/.test(l.trim())), 280);
  const titleLine = prose(question?.title, 200);
  const decision = supplied?.decision
    || (activeItem?.question ? prose(activeItem.question, 280) : null)
    || (followUp?.verificationQuestion ? prose(followUp.verificationQuestion, 280) : null)
    || (question?.reviewedAt && reviewBrief?.decision ? prose(reviewBrief.decision, 280) : null)
    || (askedLine && !GENERIC_ASK_RE.test(askedLine) ? askedLine : null)
    || agentQuestionSentence(agentSummary, recentMessages)
    // A clear, non-generic question title outranks a recovered phrase.
    || (titleLine && !GENERIC_ASK_RE.test(titleLine) && /\?\s*$/.test(titleLine) ? titleLine : null)
    || agentNamedDecision(agentSummary, recentMessages)
    || (agentOwnerAction(agentSummary, recentMessages) ? `Do this yourself: ${agentOwnerAction(agentSummary, recentMessages)}` : null)
    || (titleLine && !GENERIC_ASK_RE.test(titleLine) ? titleLine : null)
    || null;

  // What changed, without repeating the blocker or the question verbatim.
  const changed = changedParts.map((part) => {
    if (typeof part === "string") return part;
    const used = [blocked, decision].filter(Boolean).map((t) => t.slice(0, 40).toLowerCase());
    const rest = splitSentences(part.agentUpdate)
      .filter((sentence) => !used.some((u) => prose(sentence, 400)?.toLowerCase().startsWith(u.slice(0, 30))))
      .filter((sentence) => !/\?\s*$/.test(sentence))
      .join(" ");
    return rest ? `Agent's latest update: ${prose(rest, 280)}` : null;
  }).filter(Boolean).join(" ") || null;

  // One short "where it stands": the newest evidence, without repeating the
  // goal or the decision; the full verified/changed/blocked stay as details.
  const status = buildStatus({
    recentMessages,
    supplied,
    // Without agent messages: what the work actually changed first (a PR's
    // summary), then a real blocker, then verification, never review notes.
    fallbacks: [
      followUp?.whySurfaced,
      followUp?.lastMeaningfulProgress?.summary,
      changed ? changed.replace(/^Agent's latest update:\s*/i, "") : null,
      blocked && !/^(?:It is waiting|It needs permission|Merging needs)/.test(blocked) ? blocked : null,
      ...verified.filter((v) => !/^Supervisor review:/i.test(v)),
      blocked
    ],
    avoid: [goal, decision, assignment],
    nowMs: Number(now)
  });

  const consequenceCtx = {
    prName: prName ?? null,
    command: permission?.command ?? null,
    ownerName: prose(followUp?.owner?.label, 60),
    isMerge: String(question?.kind ?? "") === "ready" || Boolean(question?.mergeAsk)
  };
  let options;
  if (supplied?.options?.length) {
    options = supplied.options.map((opt) => ({ label: opt.label, consequence: opt.consequence ?? optionConsequence(opt.label, consequenceCtx) }));
  } else if (followUp?.choices?.length) {
    options = followUp.choices.map((c) => ({ label: c.label, consequence: optionConsequence(c.label, consequenceCtx) }));
  } else {
    const fromQuestion = activeItem?.options?.length ? activeItem.options : realDecisionOptions(question?.options);
    const raw = fromQuestion.length ? fromQuestion : agentListedOptions(agentSummary, recentMessages);
    options = raw.map((opt) => {
      const text = String(opt).replace(/^\d+[.)]\s*/, "");
      const parts = /^(.{1,80}?)\s+(?:—|–|:|→)\s+(.+)$/.exec(text);
      const label = humanOption(parts ? parts[1] : text);
      return { label: prose(label, 80), consequence: parts ? prose(parts[2], 220) : optionConsequence(label, consequenceCtx) };
    });
  }
  options = options.filter((o) => o.label).slice(0, 5);
  const groups = options.length ? groupedDecisions(agentSummary, recentMessages, options) : null;
  if (!options.length && decision && /^Do this yourself:/.test(decision)) {
    options = [
      { label: "Done", consequence: "The agent continues once you have done it." },
      { label: "Not now", consequence: "It stays blocked; nothing changes." }
    ];
  }
  const rec = supplied?.recommendation
    || prose(recommendation, 240)
    || (question?.reviewedAt && reviewBrief?.recommendation ? prose(reviewBrief.recommendation, 240) : null)
    || null;

  const sources = [];
  const prUrl = prUrlFor(prRef, prMeta?.url);
  if (prUrl) sources.push({ label: prName && prTitle ? `${prName}: ${clampText(prTitle, 60)}` : (prName ?? "Pull request"), url: prUrl });
  if (openChat?.url && /^(?:https?|paseo|conductor|cursor|vscode|codex|claude):/.test(openChat.url)) {
    sources.push({ label: prose(openChat.label, 80) || name || "Source chat", url: openChat.url });
  }
  for (const link of followUp?.evidenceLinks ?? []) {
    if (sources.length >= 4) break;
    if (typeof link?.url === "string" && /^https?:\/\//.test(link.url) && !sources.some((s) => s.url === link.url)) {
      sources.push({ label: prose(link.label ?? link.kind, 60) || "Evidence", url: link.url });
    }
  }

  const progress = verified.length || changed ? true : false;
  const missing = [];
  if (!goal) missing.push("goal");
  if (!assignment) missing.push("assignment");
  if (!progress) missing.push("progress");
  if (!blocked) missing.push("blocked");
  if (!decision || !options.length) missing.push("decision");

  return {
    askType,
    itemName: name,
    goal,
    assignment,
    verified: verified.length ? verified.join(" ") : null,
    changed,
    blocked,
    status,
    groups,
    details: [verified.length ? `Verified: ${verified.join(" ")}` : null, changed ? `Changed: ${changed}` : null, blocked ? `Blocked: ${blocked}` : null].filter(Boolean).join("\n") || null,
    decision,
    options,
    recommendation: rec,
    sources,
    missing,
    complete: askType !== "decision" || missing.length === 0,
    agentSupplied: Boolean(supplied),
    contextRequested: Boolean(contextRequest?.at && contextRequest?.sent)
  };
}

const PART_LABELS = {
  goal: "your original goal",
  assignment: "what you assigned the agent",
  progress: "what was verified or changed",
  blocked: "why the agent can't proceed alone",
  decision: "the options for this decision"
};

// Plain-English rendering. `markdown` adds bold labels and links; the plain
// form is for outreach summaries and phone pushes.
export function renderDecisionContext(ctx, { markdown = false, compact = false, maxChars = null, preserveDecision = false } = {}) {
  if (!ctx) return "";
  if (Number.isFinite(maxChars) && maxChars > 0) {
    // Budget the earlier parts so the decision, options and recommendation
    // (part 4) always fit: they are what the owner acts on.
    const full = renderDecisionContext(ctx, { markdown, compact });
    if (full.length <= maxChars) return full;
    const per = Math.max(80, Math.floor(maxChars * 0.12));
    const cut = (v) => (v ? clampText(v, per) : v);
    const shortCtx = { ...ctx, goal: cut(ctx.goal), assignment: cut(ctx.assignment), status: cut(ctx.status) };
    const shorter = renderDecisionContext(shortCtx, { markdown, compact: true });
    if (shorter.length <= maxChars) return shorter;
    const lines = shorter.split("\n");
    const four = lines.findIndex((l) => /^4\. /.test(l));
    const head = lines.slice(0, four).join("\n");
    const tail = lines.slice(four).join("\n");
    const room = Math.max(0, maxChars - tail.length - 1);
    if (room > 40) return `${clampText(head, room)}\n${tail}`;
    // The decision and its options must never be cut: a caller that needs
    // them whole gets null and shows the decision in full or defers it.
    return preserveDecision ? null : clampText(tail, maxChars);
  }
  const b = (s) => (markdown ? `**${s}**` : s);
  // Only what is known is shown: an empty part is left out rather than
  // filled with "not recoverable" boilerplate (ctx.missing still records it).
  const lines = [];
  const what = ctx.itemName ? `${ctx.itemName}. ` : "";
  if (ctx.goal || ctx.itemName) lines.push(`1. ${b("Goal:")} ${what}${ctx.goal ?? ""}`.trimEnd());
  if (ctx.assignment && !similar(ctx.assignment, ctx.goal ?? "")) lines.push(`2. ${b("You asked the agent to:")} ${ctx.assignment}`);
  if (ctx.status) lines.push(`3. ${b("Where it stands:")} ${compact ? clampText(ctx.status, 220) : ctx.status}`);
  const optText = (o) => `${o.label}${o.consequence ? ` (${o.consequence.replace(/\.$/, "")})` : ""}`;
  const opts = ctx.groups?.length
    ? ctx.groups.map((g, i) => `(${i + 1}) ${g.label}: ${g.options.map(optText).join(" or ")}`).join(" ")
    : ctx.options.map(optText).join("; ");
  const rec = ctx.recommendation ? (/^recommend/i.test(ctx.recommendation) ? ctx.recommendation : `Recommendation: ${ctx.recommendation}`) : null;
  // Tradeoffs are shown when the source states them, and said to be missing
  // otherwise, never invented.
  const noTradeoffs = ctx.options.length > 0 && !ctx.options.some((o) => o.consequence);
  const four = [ctx.decision, opts ? `Options: ${opts.replace(/\.$/, "")}.` : null, noTradeoffs ? "Tradeoffs: not stated by the agent." : null, rec].filter(Boolean).join(" ");
  if (four) lines.push(`4. ${b("Decision now:")} ${four}`);
  if (ctx.sources.length) {
    lines.push(markdown
      ? `Sources: ${ctx.sources.map((s) => `[${s.label}](${s.url})`).join(" · ")}`
      : `Sources: ${ctx.sources.map((s) => `${s.label} ${s.url}`).join(" · ")}`);
  }
  return lines.join("\n");
}

// Text for compact copies (outreach, glasses, phone feeds): the four parts
// when the goal or assignment was recovered; otherwise the ask's own words,
// rather than a page of "not recoverable" lines. Gaps stay on the card.
export function decisionSummary(ctx, fallbackText, { maxChars = 1400 } = {}) {
  if (ctx && (ctx.goal || ctx.assignment)) return renderDecisionContext(ctx, { maxChars });
  return clampText(stripInternalIds(fallbackText ?? ""), maxChars);
}

// The message sent to the owning agent when an ask is missing context. It asks
// for facts the agent already has, in a block the Supervisor can parse, and
// says plainly that nothing is approved by this message.
export function buildContextRequestMessage(ctx) {
  const needed = ctx.missing.map((part) => `- ${PART_LABELS[part]}`).join("\n");
  return [
    "[OpenAGI Supervisor] Before your question goes to Spencer, it needs context he can decide from without opening this chat.",
    `Missing:\n${needed}`,
    "Reply with only facts from this chat and your own verification, in this exact block (no new work, no new question):",
    `${AGENT_CONTEXT_MARKER}`,
    "Goal: <Spencer's original goal, and what this project/item is>",
    "Assigned: <what Spencer asked you to do>",
    "Verified: <what you verified or tried>",
    "Changed: <what changed>",
    "Blocked: <what is blocked and why you cannot proceed alone>",
    "Decision: <the exact decision Spencer needs to make>",
    "Options:",
    "- <option> — <consequence>",
    "Recommendation: <your recommendation and why>",
    "Then end your reply by restating your original question and its options unchanged, so it stays open for Spencer.",
    "This is not an approval of anything pending. Keep waiting for Spencer's answer."
  ].join("\n");
}

// Whether a new ask should stay out of the owner's view while its owning agent
// fills in the gaps. Already-surfaced asks are never pulled back: they are
// reworked in place instead.
export function shouldHoldForContext(question, ctx, nowMs = Date.now()) {
  if (!ctx || ctx.askType !== "decision" || ctx.complete) return false;
  if (question?.outreachId || question?.pushedAt) return false;
  const req = question?.contextRequest;
  if (!req?.at || req.sent !== true) return false;
  const at = Date.parse(req.at);
  return Number.isFinite(at) && nowMs - at < CONTEXT_REQUEST_WAIT_MS;
}

// Derives context for a stored question from its persisted snapshot, for
// callers that do not have a live card (notifications, check-ins).
// The name of a grouped question: how many sessions and which, never one
// member standing in for the whole group.
export function groupItemName(question, lookup = () => null) {
  const keys = Array.isArray(question?.threadKeys) ? question.threadKeys : [];
  if (!keys.length) return null;
  const titles = keys.map((k) => prose(lookup(k)?.title, 40)).filter(Boolean);
  const head = `${keys.length} session${keys.length === 1 ? "" : "s"}`;
  return clampText(titles.length ? `${head}: ${titles.slice(0, 3).join(", ")}${keys.length > 3 ? ", …" : ""}` : head, 120);
}

export function decisionContextFromQuestion(question, { activeGoal = null, thread = null, recommendation = null, now = Date.now(), itemName = null } = {}) {
  const snap = question?.contextSnapshot && typeof question.contextSnapshot === "object" ? question.contextSnapshot : {};
  const pr = snap.pr && typeof snap.pr === "object" ? snap.pr : null;
  const messages = Array.isArray(thread?.meta?.conversation) && thread.meta.conversation.length
    ? thread.meta.conversation.slice(-6)
    : (Array.isArray(snap.recentMessages) && snap.recentMessages.length
        ? snap.recentMessages
        : (snap.lastUserText ? [{ role: "user", text: snap.lastUserText }] : []));
  const openChat = question?.openChat?.url ? question.openChat : null;
  const perm = thread?.meta?.pendingPermission;
  const permCmd = perm?.input?.command ?? perm?.command ?? null;
  const grouped = !question?.threadKey && Array.isArray(question?.threadKeys) && question.threadKeys.length > 0;
  return buildDecisionContext({
    question,
    itemName: itemName ?? (grouped ? groupItemName(question) : null),
    project: question?.project ?? null,
    sessionTitle: thread?.title ?? snap.threadTitle ?? snap.workspace ?? null,
    prMeta: pr ? { ...pr, rawBody: pr.bodySummary, failingChecks: pr.failingChecks ?? [] } : (question?.prRef ? { ref: question.prRef } : null),
    recentMessages: messages,
    agentSummary: thread?.lastAgentFull ?? snap.agentSummary ?? null,
    activeGoal,
    openChat,
    recommendation,
    reviewBrief: question?.reviewedAt ? question.reviewBrief : null,
    permission: permCmd ? { command: String(permCmd) } : null,
    contextRequest: question?.contextRequest ?? null,
    now
  });
}
