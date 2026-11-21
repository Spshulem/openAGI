// Proof that a turn is the authenticated owner's, and what that owner asked
// for. A principal is minted only by transport code right after its auth
// passed (hosted-interface /message, a paired phone, a G2 tap) and travels in
// handleMessage options, never in a body. The voice relay mints one only
// after token auth and the owner's own gesture (hotkey, mic button, G2 tap),
// never on a wake word. The brand lives in a module-private
// WeakSet, so no JSON value, model argument, tool result or journal replay can
// ever pass isOwnerPrincipal.

const PRINCIPALS = new WeakSet();
const VIAS = new Set(["owner", "overlay", "phone", "g2", "voice"]);

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
const LEAD = String.raw`(?:^|[.,;:!?\n]|\b(?:and|then|please|pls|now|also|just|ok|okay|sure|yes|yeah|yep|so|let's|lets|go ahead and|help me|(?:can|could|would|will) you|(?:want|need|like|love) you to)\b)\s*(?:(?:please|pls|just|now|also|go)\s+)*`;

const ARTICLES = String.raw`(?:(?:a|an|the|my|another|new|up)\s+)*`;
const CODING_AGENT = String.raw`(?:codex|claude code|cursor|coding (?:agents?|sessions?|runs?|tasks?))`;

// Message recipients. "tell" never takes a question word or a thing to tell
// ("tell if", "tell the difference", "tell a joke"); a bare name after "to"
// must end the clause, so "write a thread to summarize this" names no one.
const NOT_TOLD = String.raw`(?!(?:me|us|you|yourself|if|whether|what|how|why|when|where|which|who|whose|a|an|(?:them|these|those|it)\s+apart|(?:(?:the|some|any|this|that|these|those|your|my|our)\s+)?(?:difference|truth|time|story|stories|jokes?|lies?|fortunes?|tales?))\b)`;
const NOT_NAME = String.raw`(?:me|us|my|your|our|his|her|their|them|him|it|the|a|an|this|that|these|those|some|any|everyone|everybody|someone|somebody)\b`;
const TARGET_NOUN = String.raw`(?:${CODING_AGENT}|paseo|claude|conductor|agents?|agens?|agnets?|threads?|chats?|sessions?|workspaces?|worktrees?)\b(?!['’]s)`;
const NAMED_RECIPIENT = String.raw`${ARTICLES}(?:(?!(?:about|of|for|on|in|from|with|regarding|to|and|that)\b)[\w-]+\s+){0,2}?${TARGET_NOUN}`;
const CLAUSE_END = String.raw`(?=\s*(?:$|[.,;:!?\n]|(?:and|then|now|please|so|saying|with|that|too|in|on|via)\b))`;
const TO_RECIPIENT = String.raw`(?:${NAMED_RECIPIENT}|(?!${NOT_NAME})[\w-]+(?:['’]s\s+(?:[\w-]+\s+)?${TARGET_NOUN}|${CLAUSE_END}))`;

export const INTENT_FAMILIES = Object.freeze({
  approve: {
    pattern: [
      String.raw`(?:click|press|tap|hit|approve|allow|accept|confirm|choose|pick|select|resume|retry|deny|reject|decline|answer|defer|dismiss|skip|veto|continue|proceed)\b`,
      String.raw`(?:merge|ship)\s+(?:it|this|that|all|every|green|ready|the\s+(?:pr|pull request|prs|pull requests|[\w-]+\s+one)|prs?\b|#\d+|and\s+deploy\b)`,
      String.raw`(?:batch|triage|clear|sweep)\b[^.!?\n]{0,80}?\b(?:cards?|prs?|pull requests?|questions?|approvals?|queue)\b`,
      String.raw`(?:go for it|go ahead|do (?:it|that)|looks (?:good|fine)|sounds (?:good|fine)|fine (?:with|by) me|works for me|lgtm|hold off|not yet|ping me less|make (?:this|that|it) (?:my )?(?:default|automatic)|keep current|(?:use\s+(?:the\s+)?)?recommended(?:\s+(?:one|option))?)\b`,
      String.raw`don['’]?t do that\b`
    ].join("|"),
    tools: ["fleet_click", "fleet_answer_question", "fleet_act_card", "fleet_batch_cards", "fleet_preferences"]
  },
  // Master-coordinator intent: coordinating across workspaces/chats, checking
  // in with sessions, driving a repo toward a release, or spinning up a fresh
  // Paseo session in the right workspace. Passive questions ("what did codex
  // say?", "what's the latest?") still match nothing here.
  coordinate: {
    pattern: [
      String.raw`(?:co+rdinate|cordinate|sync(?:\s+up)?|orchestrate|align|huddle)\s+(?:together|with|across|in|on)\b(?!\s+(?:me|us|my\s+calendar)\b)`,
      String.raw`(?:co+rdinate|cordinate)\b[^.!?\n]{0,120}?\b(?:workspaces?|chats?|threads?|sessions?|agents?|paseo|codex|claude|conductor|repos?|prs?|releases?|supervisors?)\b`,
      String.raw`(?:check(?:\s+in)?|follow\s+up|work|reach\s+out)\s+with\s+${TO_RECIPIENT}`,
      String.raw`(?:have|get|make|let)\s+${NAMED_RECIPIENT}\s+(?:to\s+)?(?:check(?!\s+the\s+(?:news|weather|stock|email|calendar)\b)|verify|test|finish|complete|ship|merge|rebase|update|report|sync|co+rdinate|cordinate|wrap\s+up|cut|prepare|deploy|continue|run|push)\b`,
      String.raw`(?:start|create|open|spin\s+up|launch|kick\s+off|fire\s+up)\s+${ARTICLES}(?:(?:paseo|new|fresh|coordinator|release|qa)\s+)*(?:chats?|sessions?|threads?|coordinators?|workers?)\b`,
      String.raw`(?:kick|spin|fire)\s+${ARTICLES}(?:(?:paseo|new|fresh|coordinator|release|qa)\s+)*(?:chats?|sessions?|threads?|coordinators?|workers?)\s+(?:off|up)\b`,
      String.raw`(?:(?:yes|yeah|yep|yup|sure|ok|okay)\b[,!.\s]+)?(?:gpt|claude|sonnet|opus|haiku|codex|gemini|o[134]\b|sol\b|model\b|(?:low|medium|high|max)\s+effort\b)(?:[^.!?\n]|\.(?=\d)){0,80}?\bin\s+paseo\b`,
      String.raw`(?:start|create|open|run|use)\b(?:[^.!?\n]|\.(?=\d)){0,80}?\bin\s+paseo\b`,
      String.raw`(?:in|inside|for)\s+(?:(?:the|my)\s+)?[\w-]+\s+(?:workspace|project|repo|supervisor)\b\s*[,;:]?\s*(?:(?:please|go|let['’]?s|lets)\s+)*(?:work\s+on|implement|build|fix|add|ship|update)\b`,
      String.raw`work\s+on\b[^.!?\n]{0,100}?\b(?:(?:in|inside|for)\s+(?:(?:the|my)\s+)?[\w-]+\s+(?:workspace|project|repo|supervisor)|prs?|pull requests?|branch(?:es)?|repos?|repository|codebase|workspaces?|paseo|codex|claude|conductor)\b`
    ].join("|"),
    tools: ["fleet_send_message", "fleet_start_session", "fleet_dispatch_goal", "reply_to_coding_agent"]
  },
  themes: {
    pattern: String.raw`(?:sync|apply|assign|update)\b[^.!?\n]{0,60}?\b(?:paseo\s+(?:workspace\s+|theme\s+)?labels?|workspace\s+(?:theme\s+)?labels?|theme\s+labels?)\b`,
    tools: ["fleet_sync_themes"]
  },
  organize: {
    pattern: [
      String.raw`(?:create|add|delete|remove)\s+(?:(?:a|an|the|new)\s+)?(?:openagi\s+)?(?:project|subchannel)\b`,
      String.raw`(?:move|assign|put)\s+${NAMED_RECIPIENT}\s+(?:to|into|under)\s+(?:(?:the|a)\s+)?(?:project|theme|subchannel|#)\b`
    ].join("|"),
    tools: ["fleet_organize_project"]
  },
  // Messaging needs a recipient, so "write a summary of these results", "tell
  // if this site is legit" or "write a twitter thread" never lets read text
  // message a coding agent: "tell amman to continue", "ask amman to", "reply
  // to the recorder chat", "reply yes to amman", "write in the codex chat",
  // "send amman go ahead", or an agent named after ask or answer.
  message: {
    pattern: [
      String.raw`(?:tell|ping|nudge)\s+${NOT_TOLD}\w`,
      String.raw`message\s+${NOT_TOLD}(?!(?:received|sent|delivered|read|history|log|box|board)\b)\w`,
      String.raw`(?:reply|respond|write back|answer back)\s+to\s+(?!(?:me|us)\b)\w`,
      String.raw`(?:send|write|reply|respond|answer)\b[^.;!?\n]{0,120}?\bto\s+${TO_RECIPIENT}`,
      String.raw`(?:forward|pass along|route)\b[^.;!?\n]{0,120}?\bto\s+${TO_RECIPIENT}`,
      String.raw`attach\s+(?:the\s+|this\s+|that\s+|my\s+)?(?:it|that|this|these|images?|photos?|pics?|pictures?|screenshots?|screen\s*shots?|screen\s*grabs?)(?!\s+to\s+me\b)\b`,
      String.raw`(?:in|on)\s+${NAMED_RECIPIENT}\s*[,;:]?\s*(?:(?:can|could|would|will) you\s+)?(?:please\s+)?(?:send|forward)\s+(?:it|this|that|these)\b`,
      String.raw`(?:ask|answer)\s+${NAMED_RECIPIENT}`,
      String.raw`(?:have|get)\s+${NAMED_RECIPIENT}\s+(?:to\s+)?(?:fix|solve|patch|debug|investigate|repair|handle)\b`,
      String.raw`(?:send|write|reply|respond|answer)\s+(?:back\s+)?(?:to|in|on|into)\s+${NAMED_RECIPIENT}`,
      String.raw`ask\s+(?!(?:me|us|you|yourself|a|an|the|some|any|questions?|them|everyone|people|this|that)\b)[\w-]+\s+to\b`,
      String.raw`send\s+(?!${NOT_NAME}|(?:over|out|back|off|email|emails|messages?|texts?)\b)[\w-]+(?:\s*[:,]|\s+(?:yes|no|yep|nope|ok|okay|sure|go ahead|continue|proceed|approved?|stop|keep going|do it|ship it|lgtm|thanks|thank you|(?:a|the)\s+(?:message|note|reply))\b)`
    ].join("|"),
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
  // Coding needs coding phrasing, not just a verb, so "get the latest news",
  // "have the agent check the news" or "get codex's status" never launch an
  // agent: a coding verb said on its own ("implement dark mode"), a dispatch
  // verb right before a coding agent or session ("use codex to", "spin up a
  // coding agent"), a bare agent or Claude only with a coding verb after it
  // ("have claude fix ..."), or a repair verb in text naming code (below).
  coding: {
    pattern: [
      String.raw`(?:implement|debug|refactor)\b`,
      String.raw`(?:start|launch|kick off|spin up|fire up|use|run|send)\s+${ARTICLES}${CODING_AGENT}\b(?!['’]s)`,
      String.raw`(?:have|get|make|ask|let)\s+${ARTICLES}${CODING_AGENT}\s+to\b`,
      String.raw`(?:start|launch|kick off|spin up|fire up|send|have|get|make|ask|let)\s+${ARTICLES}(?:${CODING_AGENT}|claude|agents?)\s+(?:in\s+)?(?:to\s+)?(?:(?:go|please|now|then)\s+)?(?:fix|repair|build|implement|debug|refactor|patch|rebase)\b`
    ].join("|"),
    tools: ["start_coding_agent", "watch_coding_agent", "fleet_dispatch_goal"]
  },
  // "fix the G2 upload page", "check CI on PR 142 and fix it": a repair verb
  // counts only when the text names code somewhere.
  repair: {
    verbs: "fix|repair|build|patch",
    nouns: /\b(bugs?|tests?|(?:the|a|my|this|that|failing|broken|ci) builds?|ci|prs?|pull requests?|branch(?:es)?|repo|repository|code|codebase|crash(?:es)?|errors?|regressions?|features?|issues?|pages?|screens?|modules?|flows?|functions?|endpoints?)\b/i,
    tools: ["start_coding_agent", "watch_coding_agent", "fleet_dispatch_goal"]
  },
  // Watching an agent: "watch codex", "monitor the claude session".
  watch: {
    pattern: String.raw`(?:watch|monitor|keep an eye on|keep watching|stop watching)\s+(?:(?:a|an|the|my|that|this)\s+)*(?:codex|claude|cursor|coding agents?|agents?|coding sessions?)\b(?!'s)`,
    tools: ["watch_coding_agent"]
  },
  // Daily spend budget: "add $25 to my budget", "+$10 today", "set daily budget to $50".
  budget: {
    pattern: [
      String.raw`(?:add|raise|increase|bump|set|change|update|adjust|top\s*up|extend|give\s+me|put)\b[^.!?\n]{0,80}?\b(?:daily\s+)?(?:budget|spend(?:\s+(?:limit|cap))?)\b`,
      String.raw`(?:add|top\s*up|bump)\s+\+?\s*\$\s*\d+(?:\.\d{1,2})?(?:\s+(?:more|extra|for\s+today|today|to\s+(?:the\s+|my\s+)?(?:daily\s+)?(?:budget|limit)))?\b`,
      String.raw`\+\s*\$\s*\d+(?:\.\d{1,2})?(?:\s+(?:more|extra|for\s+today|today|to\s+(?:the\s+|my\s+)?(?:daily\s+)?(?:budget|limit)))?(?=\s*(?:$|[.,;!?\n]))`,
      String.raw`reset\s+(?:today['’]?s\s+)?(?:extra|bonus)\s+budget\b`
    ].join("|"),
    tools: ["update_budget"]
  }
});

const FAMILY_PATTERNS = new Map(Object.entries(INTENT_FAMILIES).map(([name, family]) =>
  [name, new RegExp(`${LEAD}${family.pattern ? `(?:${family.pattern})` : `(?:${family.verbs})\\b`}`, "i")]));

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

const SUPERVISOR_DIRECTIVE_RE = new RegExp(
  `${LEAD}(?:` + [
    String.raw`(?:ask|tell|have|get|make|let)\s+(?!(?:me|us|you|yourself|if|whether|what|how|why|when|where|which|who)\b)\S`,
    String.raw`(?:send|attach|forward|pass(?:\s+along)?|route|ping|nudge|message|reply|respond|answer)\b(?!\s+(?:me|us)\b)`,
    String.raw`(?:run|execute|diagnose|co+rdinate|cordinate|sync|orchestrate|work\s+on|fix|repair|patch|build|implement|debug|refactor|rebase|ship|merge|deploy|start|create|spin\s+up|launch|kick\s+off|approve|allow|confirm|defer|dismiss|skip|veto|retry|try\s+again)\b`,
    String.raw`(?:kick|spin|fire)\s+[^.!?\n]{1,40}?\b(?:off|up)\b`,
    String.raw`(?:(?:yes|yeah|yep|yup|sure|ok|okay)\b[,!.\s]+)?(?:gpt|claude|sonnet|opus|haiku|codex|gemini|o[134]\b|sol\b|model\b|(?:low|medium|high|max)\s+effort\b)(?:[^.!?\n]|\.(?=\d)){0,80}?\bin\s+paseo\b`,
    String.raw`(?:go\s+ahead|go\s+for\s+it|do\s+(?:it|that)|sounds\s+(?:good|fine)|looks\s+(?:good|fine)|fine\s+(?:with|by)\s+me|works\s+for\s+me|lgtm)\b`
  ].join("|") + `)`,
  "i"
);

const PROPOSED_ACTION_RE =
  /\?|\b(?:my recommendation|recommended|want me to|would you like|should i|shall i|continue,\s*inspect|or skip|reply with|choose one|option\s*[1-4a-d]|pending confirmation|delivery is pending|dropped before|no new chat was created|brief (?:has not been|was not) sent|timed out|could not|couldn['’]t)\b/i;

const CONVERSATIONAL_ASSENT_RE =
  /^\s*(?:yes|yeah|yep|yup|sure|ok|okay|alright|continue|proceed|go ahead|do it|do that|do it again|run it again|try again|retry|sounds good|looks good|lgtm|skip(?:\s+it)?|defer(?:\s+it)?|next(?:\s+one)?|(?:the\s+)?(?:first|second|third)(?:\s+one)?|option\s*[1-4a-d]|[1-4])(?:\s*[.!])?(?:\s+(?:please|now|and\s+(?:continue|move\s+on|next)))?\s*$/i;

const CONVERSATIONAL_REFUSAL_RE =
  /\b(?:no|nope|don['’]?t|do not|wait|hold off|stop|cancel)\b/i;

export function assistantProposedActionOrQuestion(previousAssistantText) {
  const prev = String(previousAssistantText ?? "").trim();
  if (!prev) return false;
  return PROPOSED_ACTION_RE.test(prev);
}

// When the assistant just asked a clear question or recommended a concrete action
// (e.g. "Continue, inspect the thread further, or skip?"), short owner replies
// like "yes", "continue", "skip", or "option 1" count as clear authorization
// without requiring a confirmation code.
// A spoken request that is nothing but "tell <chat> <message>": "tell amman
// ship it" sends "ship it" to amman with no code read back. The whole
// sentence must be that shape, so "don't", "should I", a second chat or a
// trailing condition all still ask, and the message may hold only plain
// words and punctuation: anything comparison would drop (another script,
// symbols, emoji) could ride along unheard. names: the target's labels.
const spokenWords = (value) => String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const PLAIN_MESSAGE = /^[A-Za-z0-9\s.,!?'’";:()-]+$/;
const SPOKEN_LEAD = "(?:(?:hey|ok|okay|so|please) )*";
const SPOKEN_VERB = "(?:tell|ask|message|ping|nudge|text|send|reply to|write to)";
const SPOKEN_TAIL = "(?: please| thanks| thank you)?";

export function spokenRequestNamesTarget(intent, { names = [], message = "" } = {}) {
  if (!PLAIN_MESSAGE.test(String(message ?? ""))) return false;
  const said = spokenWords(intent);
  const text = spokenWords(message);
  if (!said || !text) return false;
  return names.map(spokenWords).some((name) => name.length >= 3
    && new RegExp(`^${SPOKEN_LEAD}${SPOKEN_VERB} ${name} (?:to |that )?(?:please )?${text}${SPOKEN_TAIL}$`).test(said));
}

export function isConversationalAssentOrChoice(intent, previousAssistantText) {
  const value = String(intent ?? "").trim();
  if (!value || value.length > 120) return false;
  if (!assistantProposedActionOrQuestion(previousAssistantText)) return false;
  if (CONVERSATIONAL_REFUSAL_RE.test(value)) return false;
  if (matchConfirmation(value)?.decision === "approve") return true;
  return CONVERSATIONAL_ASSENT_RE.test(value);
}

// Principle-based Supervisor Auto-Approve check: allows natural owner directives
// (including pronouns like "have them run that", conversational "yes" to a
// question, or typos) in the Supervisor chat while still blocking passive
// status queries ("what's going on?", "what did X say?") from executing
// side-effecting tools on untrusted transcript reads.
export function isSupervisorActionableDirective(intent, options = {}) {
  const value = String(intent ?? "").trim();
  if (!value) return false;
  if (intentFamilies(value).length > 0) return true;
  if (isConversationalAssentOrChoice(value, options.previousAssistantText)) return true;
  return SUPERVISOR_DIRECTIVE_RE.test(value);
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
  "fine with me", "fine by me", "works for me",
  "go for it", "ship it", "merge it", "looks good", "looks fine", "sounds good", "sounds fine",
  "go ahead", "do it", "do that", "send it", "run it", "yes please",
  "yes", "yeah", "yep", "yup", "ok", "okay", "sure", "approve", "approved", "confirm", "confirmed", "proceed", "allow", "lgtm"
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

const BATCH_WORDS = new Set(["all", "everything"]);
const MULTI_FILLER = new Set([...FILLER, "codes", "numbers", "of", "them", "these", "those", "to"]);

// Typed owner confirmations can approve or deny multiple pending codes in one
// message ("yes 60, yes 19, yes 78", "approve 60 19 78", "yes all", "yes both").
// Single-code and codeless confirms delegate to matchConfirmation so voice/single rules hold.
export function matchConfirmations(text) {
  const single = matchConfirmation(text);
  if (single) {
    return { decision: single.decision, codes: single.code ? [single.code] : [], all: false };
  }
  const raw = String(text ?? "").trim().toLowerCase();
  if (!raw || raw.length > 200) return null;
  const words = raw.replace(/[’]/g, "'").replace(/[^a-z0-9' ]+/g, " ").split(/\s+/).filter(Boolean);
  const codes = [];
  let all = false;
  let both = false;
  let yes = 0;
  let no = 0;
  for (let index = 0; index < words.length;) {
    const word = words[index];
    if (/^\d{2,3}$/.test(word)) {
      if (!codes.includes(word)) codes.push(word);
      index += 1;
      continue;
    }
    if (BATCH_WORDS.has(word)) {
      all = true;
      index += 1;
      continue;
    }
    if (word === "both") {
      both = true;
      index += 1;
      continue;
    }
    const refusal = consume(words, index, NO_PHRASES);
    if (refusal) { no += 1; index += refusal; continue; }
    const assent = consume(words, index, YES_PHRASES);
    if (assent) { yes += 1; index += assent; continue; }
    if (MULTI_FILLER.has(word)) { index += 1; continue; }
    return null;
  }
  if (both && all) return null;
  if (both && codes.length > 0 && codes.length !== 2) return null;
  if (!all && !both && codes.length < 2) return null;
  const decision = yes && !no ? "approve" : no && !yes ? "deny" : null;
  if (!decision) return null;
  if (both && codes.length === 0) {
    return { decision, codes: [], all: true, count: 2 };
  }
  return { decision, codes, all };
}

// Strict parser for standalone owner budget commands so the owner can top up
// or adjust the daily budget in chat even when the current daily budget is
// already exhausted (0 LLM tokens required).
export function parseDirectBudgetCommand(text) {
  const raw = String(text ?? "").trim();
  if (!raw || raw.length > 160 || /\?\s*$/.test(raw)) return null;
  const cleaned = raw.replace(/^[.,;:!?\s]+|[.,;:!?\s]+$/g, "");

  if (/^(?:please\s+)?reset\s+(?:my\s+|the\s+)?(?:today['’]?s\s+)?(?:extra|bonus)\s+budget$/i.test(cleaned)) {
    return { resetTodayBonus: true };
  }

  const plusOnly = /^(?:please\s+)?(?:\+\s*\$?\s*(\d+(?:\.\d{1,2})?)|(?:add|top\s*up|bump)\s+\+?\s*\$\s*(\d+(?:\.\d{1,2})?))(?:\s+(?:more|extra|for\s+today|today|to\s+(?:my\s+|the\s+)?(?:daily\s+)?(?:budget|spend(?:\s+limit)?|limit)))?$/i.exec(cleaned)
    ?? /^(?:please\s+)?(?:add|top\s*up|put|give\s+me)\s+\+?\s*\$?\s*(\d+(?:\.\d{1,2})?)\s+(?:more\s+|extra\s+)?(?:to|onto|into|for)\s+(?:my\s+|the\s+|today['’]?s\s+)?(?:daily\s+)?(?:budget|spend(?:\s+limit)?)$/i.exec(cleaned);
  if (plusOnly) {
    const amount = Number(plusOnly[1] ?? plusOnly[2]);
    if (Number.isFinite(amount) && amount >= 0.01 && amount <= 10000) {
      return { addUsdToday: amount };
    }
  }

  const setLimit = /^(?:please\s+)?(?:set|change|update|raise|increase|bump)\s+(?:my\s+|the\s+)?(?:daily\s+)?(?:budget|spend\s+(?:limit|cap))(?:\s+limit)?\s+to\s+\$?\s*(\d+(?:\.\d{1,2})?)(?:\s*(?:\/\s*day|per\s+day|a\s+day|daily))?$/i.exec(cleaned);
  if (setLimit) {
    const limit = Number(setLimit[1]);
    if (Number.isFinite(limit) && limit >= 0.5 && limit <= 10000) {
      return { dailyUsdLimit: limit };
    }
  }

  return null;
}
