// A single agent ask that carries several independent questions ("1. Reviewers:
// who approves …? 2. Certificates: which host …?") is shown as those
// questions, each with its own choices or free text, recommendation and what
// it unblocks — never as one canned "Answer all questions" / "Approve
// recommended choices" answer. Answers are sent to the agent as plain text,
// partial answers allowed; nothing here approves a merge, deploy or
// permission request.

import crypto from "node:crypto";

export const MAX_QUESTION_ITEMS = 20;

// Blanket answers a reviewer may attach to a multi-question ask. They hide
// the questions and could read as approval, so they are never offered.
export const GROUP_OPTION_RE = /^\s*(?:answer\s+(?:all|every|each)(?:\s+(?:the|of\s+the))?\s+questions?|approve\s+(?:all\s+)?(?:the\s+)?recommend(?:ed|ations?)(?:\s+(?:choices|options|answers))?|accept\s+(?:all\s+)?(?:the\s+)?recommend(?:ed|ations?)(?:\s+choices)?|approve\s+all|answer\s+questions?|resolve\s+(?:all\s+)?(?:release\s+)?decisions)\s*$/i;

const ITEM_START_RE = /^\s*(?:[-*•]\s*)?(\d{1,2})[.)]\s+(.*)$/;
const LABEL_RE = /^\*\*([^*]{2,80}?)\s*:?\s*\*\*\s*:?\s*(.*)$|^([A-Z][^:?.!]{1,60}):\s+(.*)$/;
const YES_NO_RE = /^(?:should|shall|is|are|do|does|did|can|could|may|will|would|must|has|have)\b/i;
const RECOMMEND_RE = /\b(?:recommend(?:s|ed|ation)?|suggests?|prefers?|leans?\s+(?:toward|to))\b/i;
const UNBLOCKS_RE = /\b(?:unblocks?|blocks?|blocker\s+for|blocking|needed\s+(?:for|before)|required\s+(?:for|before)|so\s+(?:that\s+)?[^.?!]{3,60}\s+can|until\s+(?:this|then)|before\s+[^.?!]{3,60}\s+can)\b/i;

function clean(text, max = 400) {
  const t = String(text ?? "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

function sentences(text) {
  return String(text ?? "").split(/(?<=[.?!])\s+(?=[A-Z0-9"'(#*])/).map((s) => s.trim()).filter(Boolean);
}

function stableId(index, label, question) {
  const basis = `${String(label || question).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 80)}`;
  return `q${index}-${crypto.createHash("sha1").update(basis).digest("hex").slice(0, 8)}`;
}

// "restart it, or move it to another model" -> two choices; a yes/no
// question -> Yes / No; anything else is answered in words.
function inferChoices(question) {
  const all = sentences(question);
  const asks = all.filter((s) => /\?\s*$/.test(s));
  // The asking sentence; an item phrased as a plain instruction ("restart
  // it, or move it to another model.") is still a choice between the two.
  const last = (asks[asks.length - 1] ?? all.find((s) => /,?\s+or\s+/i.test(s)) ?? "").replace(/^.*?:\s*/, "");
  const split = /^(.*\S),?\s+or\s+([^,;?]{2,60}?)\s*[?.!]?\s*$/i.exec(last);
  if (split && !/^(?:who|which|what|where|when|how)\b/i.test(last)) {
    const before = split[1];
    const b = split[2].trim();
    // The first alternative is the phrase parallel to the second: what
    // follows the last "be / is / are / to / whether / either / :" (or the
    // whole clause when short).
    const marker = /(?:^|\s)(?:be|is|are|to|whether|either|use|keep|choose)\s+(?!.*\s(?:be|is|are|to|whether|either|use|keep|choose)\s)(.+)$/i.exec(before);
    let a = (marker ? marker[1] : before).replace(/^(?:should\s+(?:i|we|they|it)\s+|do\s+(?:i|we)\s+)/i, "").replace(/[,;]\s*$/, "").trim();
    if (a.split(/\s+/).length > 8) a = "";
    if (a && b && a.toLowerCase() !== b.toLowerCase() && b.split(/\s+/).length <= 8) return [sentenceCase(a), sentenceCase(b)];
  }
  if (asks.length && asks.every((s) => YES_NO_RE.test(s.replace(/^.*?:\s*/, "")) && !/,?\s+or\s+/i.test(s))) return ["Yes", "No"];
  return [];
}

function sentenceCase(s) {
  const t = String(s ?? "").trim();
  return t ? t[0].toUpperCase() + t.slice(1) : t;
}

// Numbered questions in an agent message, in their original order. Only a
// list with at least two items that ask something counts; the last such
// list wins (the agent's current questions, not an earlier recap).
export function extractQuestionItems(text) {
  const lines = String(text ?? "").replace(/\r/g, "").split("\n");
  const lists = [];
  let current = null;
  for (const line of lines) {
    const m = ITEM_START_RE.exec(line);
    if (m) {
      const n = Number(m[1]);
      if (!current || n !== current.at(-1).index + 1) {
        if (n !== 1) { current = null; continue; }
        current = [];
        lists.push(current);
      }
      current.push({ index: n, body: m[2] });
    } else if (current && line.trim() && !/^\s*#{1,6}\s/.test(line) && !/^[A-Z][A-Za-z ]{2,40}:\s*$/.test(line.trim())) {
      // A wrapped or indented continuation of the current item.
      if (/^\s+\S/.test(line) || !/^[A-Z][^.]{0,40}:\s/.test(line.trim())) current.at(-1).body += ` ${line.trim()}`;
      else current = null;
    } else if (current && !line.trim()) {
      // A blank line may sit between items; a following non-item ends it.
    }
  }
  const asking = lists.filter((list) => list.length >= 2 && list.filter((it) => /\?/.test(it.body)).length >= 2);
  const list = asking.at(-1);
  if (!list) return [];
  return list.slice(0, MAX_QUESTION_ITEMS).map((it) => {
    const raw = it.body.trim();
    const lm = LABEL_RE.exec(raw);
    const label = lm ? clean(lm[1] ?? lm[3], 80).replace(/:$/, "") : null;
    const rest = lm ? (lm[2] ?? lm[4] ?? "") : raw;
    const parts = sentences(rest);
    const questionParts = parts.filter((s) => /\?/.test(s));
    const question = clean(questionParts.length ? questionParts.join(" ") : rest, 400);
    const recommendation = clean(parts.find((s) => RECOMMEND_RE.test(s) && !/\?\s*$/.test(s)) ?? "", 240) || null;
    const unblocks = clean(parts.find((s) => UNBLOCKS_RE.test(s) && !/\?\s*$/.test(s) && s !== recommendation) ?? "", 240) || null;
    const context = clean(parts.filter((s) => !/\?/.test(s) && s !== recommendation && s !== unblocks).join(" "), 300) || null;
    return {
      itemId: stableId(it.index, label, question),
      index: it.index,
      label,
      question,
      context,
      choices: inferChoices(rest),
      freeText: true,
      recommendation,
      unblocks
    };
  });
}

// The fullest numbered list among the agent's own texts (a saved excerpt is
// often clipped at the front).
export function questionItemsFor(texts = []) {
  let best = [];
  for (const text of texts) {
    if (typeof text !== "string" || !text) continue;
    const items = extractQuestionItems(text);
    if (items.length > best.length) best = items;
  }
  return best;
}

// The agent's own headline decision (its DECISION CONTEXT block), when it is
// not one of the numbered questions, is the first item: it must not be
// hidden behind the list.
export function mainDecisionItem(ctx, items = []) {
  const question = clean(ctx?.decision ?? "", 400);
  if (!ctx?.agentSupplied || !question || !Array.isArray(ctx.options) || !ctx.options.length) return null;
  const key = (t) => String(t ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 60);
  if (items.some((it) => key(it.question) && (key(it.question).includes(key(question).slice(0, 40)) || key(question).includes(key(it.question).slice(0, 40))))) return null;
  return {
    itemId: `main-${crypto.createHash("sha1").update(key(question)).digest("hex").slice(0, 8)}`,
    index: 0,
    label: "Main decision",
    question,
    context: null,
    choices: ctx.options.map((o) => clean(o?.label ?? o, 80)).filter(Boolean).slice(0, 4),
    freeText: true,
    recommendation: clean(String(ctx.recommendation ?? "").replace(/^recommend(?:ation)?:\s*/i, ""), 240) || null,
    unblocks: clean(ctx.blocked ?? "", 240) || null
  };
}

export const ITEM_STATUSES = new Set(["unanswered", "skipped", "queued", "delivered", "failed"]);

// Items with their saved answer state, and a summary for the card.
export function withItemState(items, itemAnswers = {}) {
  const out = items.map((item) => {
    const saved = itemAnswers?.[item.itemId] ?? null;
    const status = saved && ITEM_STATUSES.has(saved.status) ? saved.status : "unanswered";
    return {
      ...item,
      state: {
        status,
        answer: typeof saved?.answer === "string" ? saved.answer : null,
        at: saved?.at ?? null,
        detail: saved?.detail ?? null
      }
    };
  });
  const count = (s) => out.filter((i) => i.state.status === s).length;
  const summary = {
    total: out.length,
    unanswered: count("unanswered"),
    skipped: count("skipped"),
    queued: count("queued"),
    delivered: count("delivered"),
    failed: count("failed")
  };
  summary.open = summary.unanswered + summary.skipped + summary.failed;
  return { items: out, summary };
}

export const ANSWERS_ONLY_NOTE = "These are answers to your questions only. They do not approve any merge, deploy, permission or other action; ask for those separately.";

// One plain-text reply to the agent: each answered question by number and
// label, skipped ones named as still open. A group or recommended answer is
// never sent on the owner's behalf: only the words the owner chose.
export function composeItemsReply(items, { answers = [], skipped = [] } = {}) {
  const byId = new Map(items.map((i) => [i.itemId, i]));
  const lines = [];
  const answered = [];
  for (const entry of answers) {
    const item = byId.get(entry?.itemId);
    const text = clean(entry?.answer, 1200);
    if (!item || !text || GROUP_OPTION_RE.test(text)) continue;
    answered.push(item.itemId);
    lines.push(`${item.index ? `${item.index}. ` : ""}${item.label ? `${item.label}: ` : ""}${text}`);
  }
  const skippedItems = skipped.map((id) => byId.get(id)).filter(Boolean).filter((i) => !answered.includes(i.itemId));
  if (!lines.length && !skippedItems.length) return null;
  const parts = [];
  if (lines.length) parts.push(`Answers to your questions (${lines.length} of ${items.length}):`, ...lines);
  if (skippedItems.length) {
    parts.push("", `Not answered yet (still open, I'll come back to them): ${skippedItems.map((i) => `${i.index}${i.label ? ` ${i.label}` : ""}`).join(", ")}.`);
  }
  parts.push("", ANSWERS_ONLY_NOTE);
  return { text: parts.join("\n"), answered, skipped: skippedItems.map((i) => i.itemId) };
}
