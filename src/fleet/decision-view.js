// The Needs You decision contract every client renders, in this order:
//   1. Goal: the owner's goal or user story, in plain language.
//   2. Status: what is done, what is blocked, what is unverified, and the
//      facts for each PR involved.
//   3. Decision: the exact choice, each option with its consequence, admin
//      bypass labelled plainly.
//   4. Recommendation: which option and why.
// Anything the source does not state is labelled unknown, never invented.
// Built only from the card's verified decision context and the agent's own
// words: no raw Markdown tables, internal routing or IDs reach the owner.

const BRACKET_LABEL_RE = /\[\s*\d+\s*\.[^\]]{0,60}\]\s*/g;
const SECTION_PREFIX_RE = /^\s*(?:recommend(?:ation|ed)?|decision|goal|status)\s*:\s*/i;
// Instructions about which agent or session should do the work, and the
// internal identifiers that come with them, are routing, not the goal.
const ROUTING_RE = /\b(?:route|routed|routing|re-?route|hand(?:ed|ing)?\s+(?:it\s+)?off|delegate[ds]?)\b[^.;]*\b(?:owner|agent|session|workspace|thread|chat)\b|\bif\s+viable\b|\bpaseo\b|\b(?:srv|wks|fq|msg)_[\w-]{4,}|\b(?:session|thread)\s+[0-9a-f]{8}(?:-[0-9a-f]{4}){0,4}\b|\bimported-history\b/i;
const UNVERIFIED_RE = /\b(?:not\s+(?:yet\s+)?(?:verified|checked|tested|confirmed|run)|unverified|untested|still\s+(?:running|queued|pending|in\s+progress)|(?:verification|ci|checks?|tests?|run)\s+(?:is\s+|are\s+)?(?:still\s+)?(?:running|queued|pending|in\s+progress)|hasn'?t\s+(?:picked|run|been\s+(?:verified|checked))|no\s+(?:ci|checks?|status)\s+(?:runs?\s+)?(?:has\s+|have\s+)?(?:shown|reported|appeared))\b/i;
const BLOCKED_RE = /\b(?:blocked|blocker|needs?\s+(?:your|an?|the|one|1)\b|requires?\b|still\s+(?:requires?|needs?|lacks?)|waiting\s+(?:on|for)|can(?:no|')t\s+(?:proceed|merge|approve|continue)|lacks?\b)/i;
const BYPASS_RE = /\b(?:admin(?:istrator)?\s+(?:rights|override|merge|bypass|privileges)|bypass(?:ing)?|override\s+(?:the\s+)?(?:required\s+)?review|over\s+(?:the\s+)?required\s+review|without\s+(?:the\s+)?(?:required\s+)?(?:review|approval)|skip(?:ping)?\s+(?:the\s+)?(?:required\s+)?review)\b/i;
const MERGE_RE = /\bmerge\b/i;
// A failed check or error is a blocker, never completed work; "no failing
// checks" is not a failure.
const FAILED_RE = /\b(?:fail(?:s|ed|ing|ure|ures)?|errored|errors?|broken|regress(?:ed|ion)|rejected|crash(?:ed|es|ing)?|timed\s*out)\b/i;
const NOT_FAILED_RE = /\b(?:no|zero|0|without|none)\s+(?:other\s+|new\s+|more\s+)?(?:failing|failures?|errors?|failed|regressions?)\b|\bnot\s+(?:fail|failing|broken)\b/i;
const isFailure = (s) => FAILED_RE.test(s) && !NOT_FAILED_RE.test(s);
// Words that reject what follows ("do not merge now", "rather than merging").
const NEGATION_RE = /\b(?:do\s+not|don'?t|does\s+not|should\s+not|shouldn'?t|not|never|avoid|instead\s+of|rather\s+than|against)\b[^.;!?]*/gi;

// A status icon that is the whole value says something: it becomes a word.
// An icon beside its own text is only decoration and is dropped.
export function iconsToWords(text) {
  return asText(text)
    .replace(/(^|[\s|(:])[✅✔☑]\uFE0F?(?=\s*(?:$|[|,;.)]))/gmu, "$1passed")
    .replace(/(^|[\s|(:])[❌✖✗]\uFE0F?(?=\s*(?:$|[|,;.)]))/gmu, "$1failed")
    .replace(/(^|[\s|(:])⚠\uFE0F?(?=\s*(?:$|[|,;.)]))/gmu, "$1warning")
    .replace(/[✅✔☑❌✖✗⚠]\uFE0F?\s*/gu, "");
}
const GENERIC_REC_RE = /\bif the caveats above look right\b|\bpick another option\b|\breply below\b|\bopen details\b|^\s*(?:recommend:\s*)?session finished\b/i;
const WAITS_FOR_REVIEW_RE = /\b(?:wait|after\s+(?:review|approval)|once\s+(?:reviewed|approved)|when\s+(?:reviewed|approved)|teammate|reviewer|stop\s+at)\b/i;
const STOP_WORDS = new Set(["the", "and", "for", "with", "both", "then", "now", "this", "that", "them", "its", "all", "a", "an", "to", "of", "on", "or", "it"]);

function asText(value) {
  return typeof value === "string" ? value : "";
}

function sentenceCase(text) {
  const t = String(text ?? "").trim();
  return t ? t[0].toUpperCase() + t.slice(1) : t;
}

function clamp(text, max) {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const at = cut.lastIndexOf(" ");
  return `${(at > max * 0.6 ? cut.slice(0, at) : cut).replace(/[\s,;:]+$/, "")}…`;
}

// "| PR | Certificate | … |" tables become one plain fact list per row.
export function markdownTableRows(text) {
  const lines = asText(text).split(/\n/);
  const rows = [];
  let header = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!/^\|.*\|$/.test(line)) { header = null; continue; }
    const cells = line.slice(1, -1).split("|").map((c) => iconsToWords(c.replace(/\*\*|__|`/g, "")).trim());
    if (cells.every((c) => /^:?-{2,}:?$/.test(c) || c === "")) continue;
    if (!header) { header = cells; continue; }
    rows.push(Object.fromEntries(cells.map((c, i) => [header[i] || `Column ${i + 1}`, c])));
  }
  return rows;
}

// One flat line per table row ("#8685 reports flag consolidation —
// Certificate: passed; Conflicts: none"), so a table never prints as pipes.
function tableToSentences(text) {
  const out = [];
  let buffer = [];
  const flush = () => {
    if (!buffer.length) return;
    for (const row of markdownTableRows(buffer.join("\n"))) {
      const entries = Object.entries(row).filter(([, v]) => v);
      if (!entries.length) continue;
      const [[, first], ...rest] = entries;
      out.push(`${first} — ${rest.map(([k, v]) => `${k}: ${v}`).join("; ")}`);
    }
    buffer = [];
  };
  for (const raw of asText(text).split(/\n/)) {
    if (/^\s*\|.*\|\s*$/.test(raw)) { buffer.push(raw); continue; }
    flush();
    out.push(raw);
  }
  flush();
  return out.join("\n");
}

// Plain owner-facing prose: no review-template labels ("[1. Agent Goal]"),
// no table pipes, no Markdown emphasis, no internal routing sentences.
export function cleanDecisionProse(text, { max = 600, dropRouting = true, keepLines = false } = {}) {
  // Only real table structure is residue: a row framed by pipes ("| PR |
  // CI |") or a separator ("|---|"). Shell operators ("npm test || rm …",
  // "a | b | c") are command text and stay.
  const residue = (s) => /^\s*\|.*\|\s*\.?\s*$/.test(s) || /\|\s*:?-{3,}:?\s*\|/.test(s) || /^\s*:?-{3,}(?:\s+:?-{3,})*\s*\.?\s*$/.test(s);
  const base = tableToSentences(iconsToWords(asText(text)))
    .replace(BRACKET_LABEL_RE, "")
    .replace(/\*\*|__/g, "")
    .replace(/`([^`]+)`/g, "$1");
  if (keepLines) {
    // Line structure ("Options:\n- Rotate key") is kept for clients that
    // render it; each line is cleaned on its own.
    const lines = base.split(/\n/).map((line) => {
      const bullet = /^\s*[-*•]\s+/.exec(line)?.[0] ?? "";
      const body = splitSentences(line.slice(bullet.length))
        .filter((s) => !residue(s) && (!dropRouting || !ROUTING_RE.test(s)))
        .join(" ")
        .replace(/[ \t]+/g, " ")
        .trim();
      return body ? `${bullet ? "- " : ""}${body}` : (line.trim() ? null : "");
    }).filter((l) => l !== null);
    const out = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
    return out ? (out.length > max ? `${out.slice(0, max - 1).trimEnd()}…` : out) : null;
  }
  // A table already flattened onto one line upstream leaves only pipe and
  // dash residue: that fragment is dropped, never shown.
  const t = splitSentences(base.replace(/^\s*[-*•]\s+/gm, ""))
    .filter((s) => !residue(s) && (!dropRouting || !ROUTING_RE.test(s)))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return t ? clamp(t, max) : null;
}

function splitSentences(text) {
  return asText(text)
    .split(/\n+|(?<=[.!?])\s+(?=[A-Z#(])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const PR_REF_RE = /#(\d{2,7})\b/;
const QUALIFIED_PR_RE = /(?:\b([\w.-]+\/[\w.-]+))?#(\d{2,7})\b/;

// Per-PR facts recovered from the agent's tables and the card's PR context.
function prFacts({ texts = [], prContext = null, prRef = null }) {
  // Keyed by the repository-qualified reference when the source gives one
  // (acme/api#123 and acme/web#123 are two PRs); a bare #123 joins the one
  // qualified PR with that number, if there is exactly one.
  const byRef = new Map();
  const refOf = (text) => {
    const m = QUALIFIED_PR_RE.exec(String(text ?? ""));
    return m ? (m[1] ? `${m[1]}#${m[2]}` : `#${m[2]}`) : null;
  };
  // One value per PR and column: sources are read oldest to newest (saved
  // snapshot, ask, live agent message, then live PR state), so a newer
  // value replaces an older one instead of sitting beside it.
  const add = (ref, title, facts) => {
    if (!ref) return;
    const entry = byRef.get(ref) ?? { ref, title: null, facts: new Map() };
    if (title && !entry.title) entry.title = clamp(title, 120);
    for (const [column, value] of facts) if (column && value) entry.facts.set(column, value);
    byRef.set(ref, entry);
  };
  for (const text of texts) {
    for (const row of markdownTableRows(text)) {
      const entries = Object.entries(row);
      const refCell = entries.find(([, v]) => PR_REF_RE.test(v));
      if (!refCell) continue;
      const ref = refOf(refCell[1]);
      const title = refCell[1].replace(QUALIFIED_PR_RE, "").replace(/^\W+|\W+$/g, "").trim() || null;
      const facts = entries
        .filter(([k]) => k !== refCell[0])
        .filter(([, v]) => v && !/^[-—–]$/.test(v))
        .map(([k, v]) => [k, v]);
      add(ref, title, facts);
    }
  }
  if (prContext && (prContext.ref || prRef)) {
    const ref = refOf(prContext.ref ?? prRef);
    if (ref) {
      const facts = [];
      if (prContext.ciState) facts.push(["CI", String(prContext.ciState).toLowerCase()]);
      if (prContext.mergeState) facts.push(["Merge state", String(prContext.mergeState).toLowerCase()]);
      add(ref, prContext.title ?? null, facts);
    }
  }
  for (const [key, entry] of [...byRef]) {
    if (!key.startsWith("#")) continue;
    const qualified = [...byRef.keys()].filter((k) => !k.startsWith("#") && k.endsWith(key));
    if (qualified.length !== 1) continue;
    const target = byRef.get(qualified[0]);
    if (entry.title && !target.title) target.title = entry.title;
    for (const [column, value] of entry.facts) if (!target.facts.has(column)) target.facts.set(column, value);
    byRef.delete(key);
  }
  return [...byRef.values()].slice(0, 6).map((entry) => ({
    ...entry,
    facts: [...entry.facts].map(([column, value]) => `${column}: ${value}`)
  }));
}

function normalizeWords(text) {
  return asText(text).toLowerCase().replace(/[^a-z0-9#\s]/g, " ").split(/\s+/).filter((w) => w && !STOP_WORDS.has(w));
}

// The option the recommendation names: an exact phrase first, then a clear
// word match. A tie names no option rather than guessing.
export function matchRecommendedOption(recommendation, options) {
  // What the recommendation rejects ("do not merge now") never counts as
  // what it recommends; an ambiguous match names no option.
  const rec = asText(recommendation).toLowerCase().replace(NEGATION_RE, " ");
  if (!rec.trim() || !Array.isArray(options) || !options.length) return null;
  const phrase = options.filter((o) => {
    const label = asText(o.label ?? o).toLowerCase().trim();
    return label.length >= 3 && new RegExp(`(?:^|[^a-z0-9])${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|[^a-z0-9])`).test(rec);
  });
  if (phrase.length === 1) return phrase[0];
  if (phrase.length > 1) return null;
  const recWords = new Set(normalizeWords(rec));
  const scored = options.map((o) => {
    const words = normalizeWords(o.label ?? o);
    const hit = words.filter((w) => recWords.has(w)).length;
    return { o, score: words.length ? hit / words.length : 0 };
  }).filter((s) => s.score >= 0.75).sort((a, b) => b.score - a.score);
  if (!scored.length) return null;
  if (scored.length > 1 && scored[0].score === scored[1].score) return null;
  return scored[0].o;
}

// Merging over a required review with admin rights, said plainly.
export function isAdminBypassOption(label, decisionText = "") {
  const l = asText(label);
  if (BYPASS_RE.test(l)) return true;
  return MERGE_RE.test(l) && !WAITS_FOR_REVIEW_RE.test(l) && BYPASS_RE.test(asText(decisionText));
}

export const ADMIN_BYPASS_NOTE = "Admin bypass: merges without the required review";

export function buildDecisionView({ ctx = null, options = [], recommendation = null, prContext = null, prRef = null, agentTexts = [], itemName = null } = {}) {
  const unknowns = [];

  // 1. Goal.
  const goalText = cleanDecisionProse(ctx?.goal, { max: 420 })
    || cleanDecisionProse(ctx?.assignment, { max: 420 });
  const name = cleanDecisionProse(ctx?.itemName || itemName, { max: 140 });
  const goal = { title: name || null, text: goalText || null, unknown: !goalText };
  if (!goalText) unknowns.push("Goal: not stated in the source");

  // 2. Status: done, blocked, unverified, per-PR facts.
  const statusSentences = [ctx?.verified, ctx?.changed, ctx?.status]
    .flatMap((t) => splitSentences(cleanDecisionProse(t, { max: 1200 })))
    .map((s) => s.replace(/^(?:Supervisor review|Verified|Changed|Agent's latest update)\s*:\s*/i, "").replace(/^At \d{4}-\d{2}-\d{2}T[\d:]+Z,\s*/, ""))
    .map(sentenceCase)
    .filter((s) => s.length > 3);
  const seen = new Set();
  const uniq = (list) => list.filter((s) => {
    const k = s.toLowerCase().slice(0, 60);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  // What is still unverified is often only in the agent's latest message.
  const agentSentences = agentTexts.slice(0, 2)
    .flatMap((t) => splitSentences(cleanDecisionProse(t, { max: 4000 })))
    .filter((s) => !/\?\s*$/.test(s));
  

  const prs = prFacts({ texts: agentTexts, prContext, prRef });
  // A PR's table row is shown once, as that PR's facts.
  const isPrRow = (s) => prs.some((p) => [p.ref, `#${p.ref.split("#")[1]}`].some((r) => s.startsWith(`${r} `) || s.startsWith(`${r}:`)) && /:\s/.test(s));
  const blockedList = uniq([
    ...(ctx?.blocked ? splitSentences(cleanDecisionProse(ctx.blocked, { max: 400 })) : []),
    ...statusSentences.filter((s) => (BLOCKED_RE.test(s) || isFailure(s)) && !UNVERIFIED_RE.test(s) && !isPrRow(s))
  ]).slice(0, 3);
  const unverified = uniq([...statusSentences, ...agentSentences].filter((s) => UNVERIFIED_RE.test(s) && !isPrRow(s))).slice(0, 3);
  const done = uniq(statusSentences.filter((s) => !UNVERIFIED_RE.test(s) && !BLOCKED_RE.test(s) && !isFailure(s) && !isPrRow(s))).slice(0, 4);
  const status = {
    done: done.map((s) => clamp(s, 240)),
    blocked: blockedList.map((s) => clamp(s, 240)),
    unverified: unverified.map((s) => clamp(s, 240)),
    prs,
    unknown: !done.length && !blockedList.length && !unverified.length && !prs.length
  };
  if (!done.length) unknowns.push("Done: nothing confirmed as done in the source");
  if (!unverified.length) unknowns.push("Unverified: the source does not say what is still unverified");

  // 3. Decision: exact choice, each option with its consequence.
  // The decision is shown as the source states it: a permission prompt's
  // command and paths are the decision, not routing.
  const question = cleanDecisionProse(ctx?.decision, { max: 500, dropRouting: false });
  const decisionText = [ctx?.decision, ...agentTexts].map(asText).join(" ");
  const ctxOptions = Array.isArray(ctx?.options) ? ctx.options : [];
  const rawOptions = (options.length ? options : ctxOptions.map((o) => o.label))
    .filter((o) => typeof o === "string" && !["dismiss", "open thread", "later"].includes(o.toLowerCase()));
  // Supervisor boilerplate ("'Merge now' if the caveats above look right",
  // "reply below with your call") is not a recommendation.
  const rawRec = asText(recommendation);
  const recText = GENERIC_REC_RE.test(rawRec) ? null : cleanDecisionProse(rawRec.replace(SECTION_PREFIX_RE, "").replace(/^Recommend:\s*/i, ""), { max: 400, dropRouting: false });
  const viewOptions = rawOptions.map((value) => {
    const fromCtx = ctxOptions.find((o) => asText(o.label).toLowerCase() === value.toLowerCase());
    const adminBypass = isAdminBypassOption(value, decisionText);
    const consequence = cleanDecisionProse(fromCtx?.consequence, { max: 240, dropRouting: false })
      || (adminBypass ? ADMIN_BYPASS_NOTE : null);
    return { value, label: sentenceCase(fromCtx?.label || value), consequence, adminBypass, recommended: false };
  });
  const recommendedOption = matchRecommendedOption(recText, viewOptions);
  if (recommendedOption) recommendedOption.recommended = true;
  const decision = { question: question || null, options: viewOptions, unknown: !question || !viewOptions.length };
  if (!question) unknowns.push("Decision: the exact choice is not stated in the source");
  if (viewOptions.length && viewOptions.every((o) => !o.consequence)) unknowns.push("Consequences: not stated for any option");

  // 4. Recommendation: which option and why.
  const why = recText && recommendedOption
    ? (recText.toLowerCase().replace(/[.!]+$/, "") === recommendedOption.label.toLowerCase() ? null : recText)
    : recText;
  const rec = {
    option: recommendedOption?.value ?? null,
    label: recommendedOption?.label ?? null,
    why: why || null,
    unknown: !recText
  };
  if (!recText) unknowns.push("Recommendation: none given");
  else if (!recommendedOption) unknowns.push("Recommendation: does not name one of the options");

  const evidence = (Array.isArray(ctx?.sources) ? ctx.sources : [])
    .filter((s) => typeof s?.url === "string" && /^https?:\/\//.test(s.url))
    .map((s) => ({ label: cleanDecisionProse(s.label, { max: 80, dropRouting: false }) || "Source", url: s.url }))
    .slice(0, 6);

  return { version: 1, goal, status, decision, recommendation: rec, unknowns, evidence };
}

// The card's action buttons follow the decision view: the recommended option
// is primary and marked, admin bypass is labelled, no option appears twice.
export function alignActionsWithDecisionView(view, { primaryAction, secondaryAction, extraActions = [] }) {
  const answerOps = new Set(["answer"]);
  const all = [primaryAction, secondaryAction, ...extraActions].filter(Boolean);
  const byValue = new Map();
  const unique = [];
  for (const action of all) {
    const key = `${action.op}:${String(action.value ?? action.label ?? "").toLowerCase()}`;
    const labelKey = `label:${String(action.label ?? "").toLowerCase()}`;
    if (byValue.has(key) || byValue.has(labelKey)) continue;
    byValue.set(key, true);
    byValue.set(labelKey, true);
    unique.push({ ...action });
  }
  const optionFor = (action) => (answerOps.has(action.op)
    ? view?.decision?.options?.find((o) => o.value.toLowerCase() === String(action.value ?? "").toLowerCase())
    : null);
  for (const action of unique) {
    const opt = optionFor(action);
    if (!opt) continue;
    if (opt.recommended) action.recommended = true;
    if (opt.adminBypass) {
      action.adminBypass = true;
      if (!/admin bypass/i.test(action.label)) action.label = `${action.label} (admin bypass)`;
    }
  }
  const recIndex = unique.findIndex((a) => a.recommended);
  if (recIndex > 0) unique.unshift(unique.splice(recIndex, 1)[0]);
  // Without a recommendation, a bypass is never the default button.
  if (recIndex < 0 && unique[0]?.adminBypass) {
    const safe = unique.findIndex((a) => a.op === "answer" && !a.adminBypass);
    if (safe > 0) unique.unshift(unique.splice(safe, 1)[0]);
  }
  const [first = null, second = null, ...rest] = unique;
  return { primaryAction: first, secondaryAction: second, extraActions: rest };
}

// Suggested replies are typing shortcuts, never a second copy of the option
// buttons and never a prefilled admin bypass.
export function cleanSuggestedReplies(replies, view) {
  const optionWords = (view?.decision?.options ?? []).map((o) => normalizeWords(o.value).join(" "));
  return (Array.isArray(replies) ? replies : []).filter((reply) => {
    const text = asText(reply);
    if (!text.trim()) return false;
    if (BYPASS_RE.test(text) || (MERGE_RE.test(text) && /\badmin\b/i.test(text))) return false;
    // A blanket approval ("Approved — finish all remaining…") on a card that
    // offers an admin bypass reads as approving the bypass: not offered.
    if (/^\s*(?:approved?|yes|go ahead|proceed|ship it)\b/i.test(text) && (view?.decision?.options ?? []).some((o) => o.adminBypass)) return false;
    // "Proceed with the recommended option" only when an option is recommended.
    if (/\brecommend(?:ed|ation)\b/i.test(text) && !view?.recommendation?.option) return false;
    const words = normalizeWords(text).join(" ");
    return !optionWords.some((o) => o && (words === o || words.startsWith(`${o} `) && words.split(" ").length - o.split(" ").length <= 3));
  });
}
