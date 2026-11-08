// Standalone /fleet mini app: phone-first view of the fleet supervisor.
// String.raw keeps the client script byte-for-byte. Rules for this file:
// no backtick and no dollar-brace anywhere (they would end or interpolate the
// literal), no inline on* handlers (CSP), and every piece of dynamic data is
// rendered with textContent. Client code uses plain string concatenation.

import { DEFAULTS } from "./contracts.js";

export const fleetPage = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0e1411">
<title>Supervisor - OpenAGI</title>
<style>
:root{color-scheme:dark;--bg:#0e1411;--surface:#141d18;--raise:#1b2721;--line:#27372e;--text:#e6efe9;--soft:#c3d2c9;--muted:#8fa397;--accent:#6fe1b1;--ink:#05110b;--warn:#f0c36a;--hot:#ff8f7e}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:640px;margin:0 auto;padding:18px 16px 72px}
a{color:var(--accent);text-underline-offset:2px}
button{font:inherit;color:inherit;cursor:pointer}
button:disabled{opacity:.5;cursor:default}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.top{display:flex;align-items:center;justify-content:space-between;gap:12px}
h1{font-size:34px;line-height:1.05;margin:0;font-weight:750;letter-spacing:-.02em}
.btn{min-height:44px;padding:10px 16px;border-radius:12px;border:1px solid var(--line);background:var(--raise);font-weight:600}
.btn.primary{background:var(--accent);border-color:var(--accent);color:var(--ink)}
.btn.ghost{background:transparent;border-color:transparent;color:var(--muted)}
.seg{display:grid;grid-template-columns:repeat(3,1fr);gap:3px;padding:3px;margin-top:16px;background:var(--surface);border:1px solid var(--line);border-radius:12px}
.seg button{min-height:40px;border:0;border-radius:9px;background:transparent;color:var(--muted);font-weight:600}
.seg button[aria-pressed="true"]{background:var(--raise);color:var(--text);box-shadow:inset 0 0 0 1px var(--line)}
.seg button[data-mode="auto"][aria-pressed="true"]{color:var(--warn)}
.meta{display:flex;flex-wrap:wrap;justify-content:space-between;gap:4px 14px;margin-top:10px;font-size:14px;color:var(--muted)}
.hint{margin:6px 0 0;font-size:14px;color:var(--soft)}
.status{margin:10px 0 0;font-size:15px;color:var(--accent)}
.status.err,.lasterr{color:var(--hot)}
.status:empty,.lasterr:empty{display:none}
.lasterr{margin:8px 0 0;font-size:14px;overflow-wrap:anywhere}
h2{display:flex;align-items:baseline;gap:10px;margin:34px 0 12px;font-size:20px;font-weight:650}
h2 .n{color:var(--muted);font-weight:500;font-variant-numeric:tabular-nums}
.clear{margin:0;font-size:22px;font-weight:650;color:var(--accent)}
.empty{margin:0;color:var(--muted)}
.card{background:var(--surface);border:1px solid var(--line);border-left:5px solid var(--accent);border-radius:16px;padding:18px 16px 14px;margin-bottom:14px;scroll-margin:24px}
.card.flash{border-color:var(--accent);box-shadow:0 0 0 3px rgba(111,225,177,.35)}
.card h3{margin:0 0 6px;font-size:22px;line-height:1.25;font-weight:650;overflow-wrap:anywhere}
.card p{margin:10px 0 0;color:var(--soft);overflow-wrap:anywhere}
.card .note{font-size:13px;color:var(--muted)}
.ctx,.sub{display:flex;flex-wrap:wrap;align-items:center;gap:4px 12px;font-size:14px;color:var(--muted)}
.opts{display:grid;gap:10px;margin-top:16px}
.opts .btn{width:100%;min-height:56px;font-size:18px}
.opts .btn.ghost{min-height:44px;font-size:16px}
.list{border-top:1px solid var(--line)}
.item{padding:12px 0;border-bottom:1px solid var(--line)}
.head{display:flex;align-items:center;gap:10px}
.t{flex:1;min-width:0;font-weight:600;overflow-wrap:anywhere}
.sub{margin-top:4px}
.msg{margin:6px 0 0;font-size:14px;color:var(--soft);overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.why{margin:4px 0 0;font-size:13px;color:var(--muted);overflow-wrap:anywhere}
.item .btn{margin-top:10px;width:100%}
.item.cleared{padding:8px 0}
.cleared .t{font-weight:500}
.item .btn.sm{margin:0;width:auto;min-height:40px;padding:6px 14px;font-size:14px}
.chip{display:inline-block;padding:1px 9px;border:1px solid currentColor;border-radius:999px;font-size:12.5px;font-weight:600;line-height:1.6;white-space:nowrap}
.good{color:var(--accent)}.warn{color:var(--warn)}.hot{color:var(--hot)}.dim{color:var(--muted)}
.strip{display:flex;flex-wrap:wrap;gap:8px}
.pill{padding:8px 12px;background:var(--surface);border:1px solid var(--line);border-radius:12px;font-size:14px;color:var(--muted);overflow-wrap:anywhere;max-width:100%}
.pill b{margin-left:6px;font-weight:650}
details.group{margin-bottom:6px}
details>summary{list-style:none;cursor:pointer}
details>summary::-webkit-details-marker{display:none}
details.group>summary{display:flex;align-items:center;gap:10px;padding:10px 0}
details.group>summary .n{color:var(--muted);font-variant-numeric:tabular-nums}
details.group>summary::after{content:"+";margin-left:auto;color:var(--muted)}
details.group[open]>summary::after{content:"-"}
details.thread>summary{padding:0}
.live{color:var(--accent);font-size:13px;font-weight:600}
.blocker{margin-top:4px;font-size:14px;overflow-wrap:anywhere}
.more{margin-top:10px;padding:10px 12px;background:var(--surface);border-radius:12px;font-size:14px;color:var(--soft)}
.more p{margin:4px 0;overflow-wrap:anywhere}
.more .k{color:var(--muted);margin-right:6px}
.quote{margin:8px 0 0;padding:8px 10px;border-left:3px solid var(--line);color:var(--soft);white-space:pre-wrap;overflow-wrap:anywhere}
.quote.clamp{white-space:normal;display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden}
a.btn{display:inline-flex;align-items:center;justify-content:center;text-decoration:none;color:var(--text)}
a.btn.primary{color:var(--ink)}
.risk{margin:10px 0 0;font-size:14px;font-weight:650;color:var(--hot)}
.chats{display:grid;gap:6px;margin-top:10px;font-size:14px;color:var(--soft)}
.chats div{display:flex;flex-wrap:wrap;align-items:center;gap:4px 10px}
.acts{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
.item .acts .btn{margin:0;width:auto;flex:1 1 auto}
.ask{margin-top:10px;padding:10px 12px;border:1px solid var(--line);border-radius:12px}
.ask .t{display:block}
@media (prefers-reduced-motion:no-preference){.card{transition:box-shadow .4s ease,border-color .4s ease}}
@media (min-width:700px){.wrap{padding-top:32px}.opts{grid-template-columns:repeat(2,1fr)}.opts .btn.ghost{grid-column:1/-1}}
</style></head>
<body><div class="wrap">
<header>
  <div class="top"><h1>Supervisor</h1><button id="scan" class="btn primary" type="button">Scan now</button></div>
  <p class="hint">Your coding conversations, work in progress, and questions that need you. This works without glasses.</p>
  <div class="seg" role="group" aria-label="Mode">
    <button id="mode-observe" type="button" data-mode="observe" aria-pressed="false">Observe</button>
    <button id="mode-propose" type="button" data-mode="propose" aria-pressed="false">Propose</button>
    <button id="mode-auto" type="button" data-mode="auto" aria-pressed="false">Auto</button>
  </div>
  <p id="modeHint" class="hint"></p>
  <div class="meta"><span id="scanned">Loading</span><span id="timer"></span><a href="/">Dashboard</a></div>
  <p id="lastError" class="lasterr"></p>
  <p id="status" class="status" role="status" aria-live="polite"></p>
  <a id="reconnect" href="/?tab=nodes" target="_blank" rel="noopener noreferrer" hidden>Connection settings</a>
</header>
<main>
  <section aria-labelledby="needsH"><h2 id="needsH">Needs you <span id="needsCount" class="n"></span></h2><div id="needsList"></div>
    <details id="reviewedBox" class="group" hidden><summary><span>Cleared by supervisor</span><span id="reviewedCount" class="n"></span></summary><div id="reviewedList" class="list"></div></details></section>
  <section aria-labelledby="doingH"><h2 id="doingH">Doing <span id="doingCount" class="n"></span></h2><div id="doingList"></div></section>
  <section aria-labelledby="infraH"><h2 id="infraH">System status</h2><div id="infraStrip" class="strip"></div></section>
  <section aria-labelledby="fleetH"><h2 id="fleetH">Watching <span id="fleetCount" class="n"></span></h2><div id="fleetList"></div></section>
  <section aria-labelledby="fixesH"><h2 id="fixesH">Self-fixes</h2><div id="self-fixes"></div></section>
</main>
</div>
<script>
(function () {
  'use strict';
  var POLL_MS = 30000;
  var BUSY_POLL_MS = 5000;
  // Policy's limits, filled in from DEFAULTS below: an admitted run is slow
  // past these. A queued run is waiting for a slot, not slow.
  var SLOW_SEC = { full: FLEET_FULL_SLOW_SEC, quick: FLEET_QUICK_SLOW_SEC };
  var MODES = ['observe', 'propose', 'auto'];
  var MODE_HINT = {
    observe: 'Watching only. Sends nothing.',
    propose: 'Plans nudges. You tap Send.',
    auto: 'Sends nudges on its own, a few per scan.'
  };
  var STATE_ORDER = ['needs-human', 'ready-needs-human', 'stopped', 'asked-in-scope', 'pr-not-ready', 'infra-blocked', 'local-verify',
    'waiting-ci', 'running', 'idle-no-pr', 'done', 'excluded'];
  var STATE_LABEL = {
    'needs-human': 'Needs you', 'ready-needs-human': 'Ready, needs a human', stopped: 'Stopped mid-turn', 'asked-in-scope': 'Asked, in scope',
    'pr-not-ready': 'PR not ready', 'infra-blocked': 'Infra blocked', 'local-verify': 'Verifying on laptop',
    'waiting-ci': 'Waiting on CI', running: 'Running', 'idle-no-pr': 'Idle, no PR', done: 'Done', excluded: 'Out of scope'
  };
  var STATE_TONE = {
    'needs-human': 'hot', 'ready-needs-human': 'hot', stopped: 'warn', 'asked-in-scope': 'warn', 'pr-not-ready': 'warn',
    'infra-blocked': 'warn', 'local-verify': 'warn', 'waiting-ci': 'good', running: 'good', 'idle-no-pr': 'dim',
    done: 'dim', excluded: 'dim'
  };
  var COLLAPSED = { done: true, excluded: true, 'idle-no-pr': true, quiet: true };
  // Watching: what the supervisor watches each thread for (snapshot watch.group).
  var WATCH_ORDER = ['you', 'working', 'waiting', 'push', 'blocked', 'quiet'];
  var WATCH_LABEL = {
    you: 'Waiting on you', working: 'Working', waiting: 'Waiting on CI or BuildBot3', push: 'Needs a push',
    blocked: 'Blocked by infra', quiet: 'Quiet'
  };
  var WATCH_TONE = { you: 'hot', working: 'good', waiting: 'good', push: 'warn', blocked: 'warn', quiet: 'dim' };
  var ACTION_LABEL = { planned: 'Planned', proposed: 'Proposed', sent: 'Sent', 'dry-run': 'Dry run', blocked: 'Blocked', failed: 'Failed', done: 'Done' };
  var ACTION_TONE = { planned: 'dim', proposed: 'warn', sent: 'good', 'dry-run': 'dim', blocked: 'hot', failed: 'hot', done: 'good' };
  var ROUTE_LABEL = { 'codex-exec': 'Codex resume', 'peer-relay': 'live relay', 'claude-resume': 'Claude resume', 'computer-use': 'typed in app', 'antigravity-send': 'Antigravity message' };
  var INFRA_NAME = { 'infra:bb3': 'BuildBot3', 'infra:lb': 'Codex load balancer' };
  var CLEARED_LABEL = { stale: 'Stale', junk: 'Junk', duplicate: 'Duplicate', 'done-elsewhere': 'Done elsewhere' };
  var DOING_MAX = 20;

  var params = new URLSearchParams(location.search);
  var focusId = params.get('q') || '';
  var current = null;
  var scanning = false;
  var modeBusy = false;
  var timer = null;
  var errorShown = false;
  var openThreads = new Set();
  var groupOpen = new Map();
  var cards = new Map();
  // Expanded rows: thread key -> { at, thread, error } from the detail route,
  // and the function that repaints that row once its detail arrives.
  var details = new Map();
  var detailLoading = new Set();
  var painters = new Map();
  var DETAIL_TTL_MS = 20000;
  var MUTE_HOURS = 24;
  var APP_NAME = { conductor: 'Conductor', codex: 'Codex', claude: 'Claude Code', antigravity: 'Antigravity' };

  function $(id) { return document.getElementById(id); }

  function el(tag, cls, text, parent) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null && text !== '') node.textContent = String(text);
    if (parent) parent.append(node);
    return node;
  }

  function button(label, cls, parent, handler) {
    var b = el('button', cls, label, parent);
    b.type = 'button';
    b.addEventListener('click', handler);
    return b;
  }

  function say(text, isError) {
    var s = $('status');
    s.textContent = text || '';
    s.className = 'status' + (isError ? ' err' : '');
    errorShown = Boolean(isError && text);
  }

  function clip(value, max) {
    var text = String(value === undefined || value === null ? '' : value).replace(/\s+/g, ' ').trim();
    return text.length > max ? text.slice(0, max - 1) + '…' : text;
  }

  function secs(sec) {
    if (typeof sec !== 'number' || !isFinite(sec)) return '';
    if (sec < 60) return Math.max(0, Math.round(sec)) + 's';
    var m = Math.round(sec / 60);
    if (m < 60) return m + 'm';
    var h = Math.round(m / 60);
    if (h < 48) return h + 'h';
    return Math.round(h / 24) + 'd';
  }

  function ago(iso) {
    var t = Date.parse(iso || '');
    if (!isFinite(t)) return '';
    return secs(Math.max(0, (Date.now() - t) / 1000)) + ' ago';
  }

  // How long since iso, without "ago": "23m", "2h".
  function dur(iso) {
    var t = Date.parse(iso || '');
    if (!isFinite(t)) return '';
    return secs(Math.max(0, (Date.now() - t) / 1000));
  }

  // "on BuildBot3 full run for 23m", "for 1h": the row's watch line.
  function watchText(w) {
    if (!w) return '';
    var d = dur(w.since);
    var on = w.waitingOn && w.group === 'waiting' ? 'on ' + w.waitingOn + ' ' : '';
    return d ? on + 'for ' + d : on.trim();
  }

  function when(iso) {
    var t = Date.parse(iso || '');
    return isFinite(t) ? new Date(t).toLocaleString() : '';
  }

  function shortRef(ref) {
    var m = /^[\w.-]+\/([\w.-]+)#(\d+)$/.exec(String(ref || ''));
    return m ? m[1] + '#' + m[2] : String(ref || '');
  }

  // Only GitHub pull request URLs become links; anything else stays text.
  function prHref(pr, ref) {
    var url = pr && typeof pr.url === 'string' ? pr.url : '';
    if (/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(url)) return url;
    var m = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(String(ref || ''));
    return m ? 'https://github.com/' + m[1] + '/pull/' + m[2] : '';
  }

  function link(text, href, parent) {
    if (!href) return el('span', null, text, parent);
    var a = el('a', null, text, parent);
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    return a;
  }

  // Only the app links the server builds open a chat (conductor:// and
  // codex://, the ones its own sends navigate by); anything else stays text.
  function chatHref(oc) {
    var url = oc && typeof oc.url === 'string' ? oc.url : '';
    return /^(?:conductor|codex):\/\/[^\s"'<>]+$/.test(url) ? url : '';
  }

  // "Open chat" for a chat a link opens. Same tab: the link hands off to the app.
  function openChatLink(oc, cls, parent) {
    var href = chatHref(oc);
    if (!href) return null;
    var a = el('a', cls, 'Open chat', parent);
    a.href = href;
    a.title = 'Opens ' + (oc.label || 'the chat') + ' on this Mac';
    return a;
  }

  // Which chat, by workspace and app; for one no link opens, why not.
  function chatNote(oc, parent) {
    if (!oc) return;
    el('p', 'note', 'Chat: ' + (oc.label || 'unknown'), parent);
    if (!chatHref(oc) && oc.note) el('p', 'note', oc.note, parent);
  }

  // Where a question that only the agent's app takes is answered.
  function appNote(q) {
    var app = q.openChat && APP_NAME[q.openChat.app] ? APP_NAME[q.openChat.app] : 'the app';
    return 'Answer this in ' + app + '. Nothing is sent from here.';
  }

  function questionsFor(key) {
    var list = current && Array.isArray(current.questions) ? current.questions : [];
    return list.filter(function (q) {
      return q.threadKey === key || (Array.isArray(q.threadKeys) && q.threadKeys.indexOf(key) >= 0);
    });
  }

  function threadName(t) {
    return clip(t.title || t.workspace || t.key || 'Untitled thread', 120);
  }

  function errorText(value) {
    if (!value) return '';
    if (typeof value === 'string') return value;
    return typeof value.message === 'string' ? value.message : '';
  }

  async function api(path, body) {
    var init = body === undefined
      ? { headers: { accept: 'application/json' }, cache: 'no-store' }
      : { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) };
    var res = await fetch(path, init);
    var data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (!res.ok) {
      var message = data && data.error === 'main-pairing-required' ? 'Reconnect this desktop to your agent to see the same work as your phone. Your phone connection is unchanged.' : res.status === 401 ? 'Signed out. Reload to sign in.' : ((data && data.error) || ('Request failed (' + res.status + ').'));
      var err = new Error(message);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  function deliveryNote(delivery, fallback) {
    var status = delivery && delivery.status;
    var detail = delivery && typeof delivery.detail === 'string' ? clip(delivery.detail, 140) : '';
    if (status === 'sent') return { text: 'Sent to the agent.', bad: false };
    if (status === 'dry-run') return { text: 'Saved. Dry run, nothing sent.', bad: false };
    if (status === 'blocked') return { text: 'Saved. Could not reach the agent' + (detail ? ': ' + detail : '.'), bad: true };
    if (status === 'failed') return { text: 'Saved. Send failed' + (detail ? ': ' + detail : '.'), bad: true };
    return { text: fallback, bad: false };
  }

  // ─── header ──────────────────────────────────────────────────────────────

  function paintScan() {
    var busy = scanning || Boolean(current && current.running);
    var b = $('scan');
    b.disabled = busy;
    b.textContent = busy ? 'Scanning…' : 'Scan now';
  }

  function paintModes() {
    MODES.forEach(function (m) {
      var b = $('mode-' + m);
      b.setAttribute('aria-pressed', current && current.mode === m ? 'true' : 'false');
      b.disabled = modeBusy;
    });
    $('modeHint').textContent = current ? (MODE_HINT[current.mode] || '') : '';
  }

  function renderHeader(s) {
    paintModes();
    paintScan();
    $('scanned').textContent = s.lastTickAt ? 'Scanned ' + ago(s.lastTickAt) : 'Not scanned yet';
    $('timer').textContent = s.enabled ? 'Auto-scan on' : 'Auto-scan off';
    var last = errorText(s.lastError);
    $('lastError').textContent = last ? 'Last scan failed: ' + clip(last, 200) : '';
  }

  // ─── needs you ───────────────────────────────────────────────────────────

  function renderNeeds(questions, byKey) {
    var box = $('needsList');
    box.replaceChildren();
    cards.clear();
    $('needsCount').textContent = questions.length ? String(questions.length) : '';
    if (!questions.length) { el('p', 'clear', 'Nothing needs you.', box); return; }
    questions.forEach(function (q) {
      var card = el('article', 'card', null, box);
      card.dataset.id = q.id;
      cards.set(q.id, card);
      el('h3', null, q.title || 'Question', card);
      var ctx = el('div', 'ctx', null, card);
      var t = q.threadKey ? byKey.get(q.threadKey) : null;
      // In which chat (workspace and app), else the thread's workspace.
      var chat = q.chatLabel || (q.openChat && q.openChat.label) || (t ? t.workspace || threadName(t) : '');
      if (chat) el('span', null, 'in ' + chat, ctx);
      if (q.prRef) link(shortRef(q.prRef), prHref(t && t.pr, q.prRef), ctx);
      var asked = q.askedAt || q.createdAt;
      if (asked) el('span', null, 'asked ' + ago(asked), ctx).title = when(asked);
      var inApp = q.answerIn ? q.answerIn === 'agent app' : q.kind === 'agent-card';
      if (!inApp) openChatLink(q.openChat, null, ctx);
      askText(q, card);
      reviewNote(q, card);
      if (q.openChat && !chatHref(q.openChat) && q.openChat.note) el('p', 'note', q.openChat.note, card);
      chatList(q, card);
      var opts = el('div', 'opts', null, card);
      // Answered only in the agent's app: the way there comes first.
      if (inApp) openChatLink(q.openChat, 'btn primary', opts);
      answerButtons(q, opts, !inApp);
      if (inApp) {
        el('p', 'note', appNote(q), card);
      } else if (q.kind === 'agent-ask') {
        el('p', 'note', 'Your answer goes to the agent.', card);
      }
    });
  }

  // The question's words. A risky ask (merge, release, deploy, delete) says
  // so and shows all of it, the agent's own message too, before any button.
  function askText(q, parent) {
    if (q.risky) el('p', 'risk', 'Risky: read all of it before you answer.', parent);
    if (q.body) el('p', null, q.body, parent);
    var plan = q.meta && q.meta.plan;
    if (plan) {
      el('span', 'chip', plan.label, parent);
      el('p', null, plan.nextAction, parent);
      el('p', 'note', 'Success check: ' + plan.acceptance, parent);
      if (plan.issueDraft) {
        var draft = el('details', null, null, parent);
        el('summary', null, 'Local issue draft — nothing submitted', draft);
        el('p', null, plan.issueDraft.title, draft);
        el('pre', null, plan.issueDraft.body, draft);
      }
    }
    var clarification = q.meta && q.meta.clarification;
    if (clarification && clarification.answer) {
      el('p', 'note', 'Your clarification: ' + clarification.answer, parent);
      el('p', 'note', clarification.reconsideredAt ? 'Diagnosis reconsidered your answer; the finding still needs verification.' : 'Waiting for the next diagnosis. The finding is still unresolved.', parent);
    }
    if (typeof q.askContext === 'string' && q.askContext && q.askContext !== q.body) {
      el('p', 'k', 'The agent wrote:', parent);
      el('blockquote', q.risky ? 'quote' : 'quote clamp', q.askContext, parent);
    }
  }

  // A grouped question names each of its chats, each with its own link.
  function chatList(q, parent) {
    var chats = Array.isArray(q.chats) ? q.chats : [];
    if (!chats.length) return;
    var box = el('div', 'chats', null, parent);
    chats.forEach(function (c) {
      var row = el('div', null, null, box);
      el('span', null, c.label || c.threadKey || 'chat', row);
      openChatLink(c, null, row);
    });
  }

  // The question's options and Dismiss. On a risky ask no option is the
  // highlighted default.
  function answerButtons(q, parent, primary) {
    var buttons = [];
    var options = Array.isArray(q.options) ? q.options.filter(function (o) { return o && o !== 'dismiss' && o !== 'open thread'; }) : [];
    options.forEach(function (option, index) {
      buttons.push(button(option, 'btn' + (primary && index === 0 && !q.risky ? ' primary' : ''), parent, function () {
        return decide(q, { answer: option }, buttons);
      }));
    });
    buttons.push(button('Dismiss', 'btn ghost', parent, function () { return decide(q, { dismiss: true }, buttons); }));
    return buttons;
  }

  // Why the supervisor's review kept an open question (live), or the close
  // the owner overrode with Reopen; the full reason and time on hover.
  function reviewNote(q, card) {
    var why = typeof q.reviewReason === 'string' ? q.reviewReason : '';
    if (!why) return;
    var overridden = q.pinned && q.reviewCategory && q.reviewCategory !== 'live';
    var note = el('p', 'note', (overridden ? 'You reopened it. The supervisor had said: ' : 'Supervisor: ') + clip(why, 160), card);
    note.title = why + (q.reviewedAt ? ' (reviewed ' + when(q.reviewedAt) + ')' : '');
  }

  // Questions the supervisor's review cleared in the last day (or still
  // holding back an ask that keeps coming), newest first. Reopen brings one
  // back and the review keeps it from then on.
  function renderReviewed(list, open) {
    var box = $('reviewedList');
    box.replaceChildren();
    $('reviewedBox').hidden = !list.length;
    $('reviewedCount').textContent = list.length ? String(list.length) : '';
    var titles = new Map(open.map(function (q) { return [q.id, q.title]; }));
    list.forEach(function (q) {
      var row = el('div', 'item cleared', null, box);
      var head = el('div', 'head', null, row);
      el('span', 't', q.title || 'Question', head);
      var b = button('Reopen', 'btn sm', head, function () { return reopen(q, b); });
      var sub = el('div', 'sub', null, row);
      if (q.reviewCategory) el('span', 'chip dim', CLEARED_LABEL[q.reviewCategory] || q.reviewCategory, sub);
      if (q.answeredAt) el('span', null, 'cleared ' + ago(q.answeredAt), sub).title = when(q.answeredAt);
      if (q.duplicateOf && titles.has(q.duplicateOf)) el('span', null, 'same as: ' + clip(titles.get(q.duplicateOf), 80), sub);
      if (typeof q.reviewReason === 'string' && q.reviewReason) el('p', 'why', clip(q.reviewReason, 200), row);
    });
  }

  async function reopen(q, b) {
    b.disabled = true;
    try {
      var r = await api('/fleet/api/questions/' + encodeURIComponent(q.id), { reopen: true });
      // Show where it went: back under Needs you.
      focusId = q.id;
      if (r && r.state) render(r.state); else await load();
      say('Reopened. The supervisor keeps it now.');
    } catch (e) {
      b.disabled = false;
      // Reload first: a clean reload clears the status line.
      if (e.status === 404 || e.status === 409) await load();
      say(e.message, true);
    }
  }

  async function decide(q, body, buttons) {
    if (q.kind === 'suggestion' && body.answer === 'Answer question') {
      var answer = window.prompt(q.meta && q.meta.plan ? q.meta.plan.nextAction : 'What should the diagnosis know?', q.meta && q.meta.clarification ? q.meta.clarification.answer : '');
      if (!answer || !answer.trim()) return;
      if (answer.length > 2000) { say('Keep your clarification within 2000 characters.', true); return; }
      body.clarification = answer.trim();
    }
    if (q.kind === 'self-fix' && body.answer === 'Request changes') {
      var instructions = window.prompt('What should the fixer change?');
      if (!instructions || !instructions.trim()) return;
      body.instructions = instructions.trim();
    }
    buttons.forEach(function (b) { b.disabled = true; });
    try {
      var r = await api('/fleet/api/questions/' + encodeURIComponent(q.id), body);
      var note = body.answer === 'Review plan' ? { text: 'Plan shown on the card. No action taken.', bad: false } : body.answer === 'Answer question' ? { text: 'Clarification saved for the next diagnosis. The finding is still unresolved.', bad: false } : body.dismiss ? { text: 'Dismissed.', bad: false } : deliveryNote(r && r.delivery, 'Answered.');
      if (r && r.state) render(r.state); else await load();
      say(note.text, note.bad);
    } catch (e) {
      buttons.forEach(function (b) { b.disabled = false; });
      say(e.message, true);
      if (e.status === 404 || e.status === 409) await load();
    }
  }

  // ─── doing ───────────────────────────────────────────────────────────────

  function targetName(a, byKey) {
    var about = byKey.get(a.threadKey);
    var name = about ? threadName(about) : (INFRA_NAME[a.threadKey] || a.threadKey || (a.kind === 'review' ? 'Needs-you review' : 'Unknown thread'));
    if (a.targetKey && a.targetKey !== a.threadKey) {
      var to = byKey.get(a.targetKey);
      name += ', to ' + (to ? threadName(to) : a.targetKey);
    }
    return name;
  }

  function renderDoing(actions, byKey) {
    var box = $('doingList');
    box.replaceChildren();
    var list = actions.slice().sort(function (a, b) {
      var pa = a.status === 'proposed' ? 0 : 1;
      var pb = b.status === 'proposed' ? 0 : 1;
      if (pa !== pb) return pa - pb;
      return String(b.at || '').localeCompare(String(a.at || ''));
    }).slice(0, DOING_MAX);
    $('doingCount').textContent = actions.length ? String(actions.length) : '';
    if (!list.length) { el('p', 'empty', 'No actions yet. Nudges show up here after a scan.', box); return; }
    var wrap = el('div', 'list', null, box);
    list.forEach(function (a) {
      var row = el('div', 'item', null, wrap);
      var head = el('div', 'head', null, row);
      el('span', 't', targetName(a, byKey), head);
      var label = a.kind === 'judge' ? 'Judge: ' + (a.verdict || a.status) : (ACTION_LABEL[a.status] || a.status || 'Unknown');
      el('span', 'chip ' + (ACTION_TONE[a.status] || 'dim'), label, head);
      var sub = el('div', 'sub', null, row);
      if (a.playbook) el('span', null, a.playbook, sub);
      if (a.route) el('span', null, ROUTE_LABEL[a.route] || a.route, sub);
      if (a.at) el('span', null, ago(a.at), sub);
      if (a.message) el('p', 'msg', a.message, row);
      var why = typeof a.detail === 'string' && a.detail ? a.detail : (typeof a.reason === 'string' ? a.reason : '');
      if (why) el('p', 'why', clip(why, 220), row);
      if (a.status === 'proposed') {
        var send = button('Send', 'btn primary', row, function () { return sendAction(a, send); });
      }
    });
  }

  async function sendAction(a, b) {
    b.disabled = true;
    b.textContent = 'Sending…';
    try {
      var r = await api('/fleet/api/actions/' + encodeURIComponent(a.id) + '/send', {});
      var note = deliveryNote(r && r.delivery, 'Sent.');
      if (r && r.state) render(r.state); else await load();
      say(note.text, note.bad);
    } catch (e) {
      b.disabled = false;
      b.textContent = 'Send';
      say(e.message, true);
      if (e.status === 404 || e.status === 409) await load();
    }
  }

  // ─── infra ───────────────────────────────────────────────────────────────

  function pill(parent, label, value, tone) {
    var p = el('div', 'pill', label, parent);
    el('b', tone || 'dim', value, p);
    return p;
  }

  function count(value) {
    return typeof value === 'number' && isFinite(value) ? String(value) : '?';
  }

  function renderInfra(snap) {
    var box = $('infraStrip');
    box.replaceChildren();
    if (!snap) { el('p', 'empty', 'No scan yet.', box); return; }
    var infra = snap.infra || {};
    var bb3 = infra.bb3 || null;
    if (!bb3) {
      pill(box, 'BuildBot3', 'unknown', 'dim');
    } else if (bb3.reachable === false) {
      pill(box, 'BuildBot3', 'unreachable', 'hot');
    } else {
      var gate = bb3.gate && bb3.gate.state ? String(bb3.gate.state) : 'unknown';
      var gateTone = /block|fail|closed|red|down/i.test(gate) ? 'hot' : (/open|ok|pass|green|clear|idle/i.test(gate) ? 'good' : 'dim');
      var since = gateTone === 'hot' && bb3.gate && bb3.gate.since ? ' ' + ago(bb3.gate.since) : '';
      pill(box, 'Gate', gate + since, gateTone);
      var full = typeof bb3.fullQueue === 'number' ? bb3.fullQueue : 0;
      pill(box, 'Queue', count(bb3.fullQueue) + ' full, ' + count(bb3.quickQueue) + ' quick', full >= 5 ? 'warn' : 'dim');
      var runs = (Array.isArray(bb3.runs) ? bb3.runs : []).filter(function (r) { return r && !r.queued; });
      var isSlow = function (r) { return (r.ageSec || 0) >= (r.kind === 'full' ? SLOW_SEC.full : SLOW_SEC.quick); };
      // The limits differ by kind, so a slow quick run outranks an older full one.
      var slowRuns = runs.filter(isSlow);
      var oldest = (slowRuns.length ? slowRuns : runs).reduce(function (best, r) { return !best || (r.ageSec || 0) > (best.ageSec || 0) ? r : best; }, null);
      if (oldest) {
        var slow = isSlow(oldest);
        pill(box, 'Oldest run', secs(oldest.ageSec) + ' ' + (oldest.kind || '') + (oldest.pr ? ' #' + oldest.pr : ''), slow ? 'warn' : 'dim');
      } else {
        pill(box, 'Oldest run', 'none', 'dim');
      }
      var dead = Array.isArray(bb3.timersDead) ? bb3.timersDead : [];
      if (dead.length) pill(box, 'Timers dead', dead.join(', '), 'hot');
      if (bb3.error) pill(box, 'BuildBot3', clip(bb3.error, 100), 'hot');
    }
    var lb = infra.lb || null;
    var lbHealthy = lb ? lb.healthy : null;
    pill(box, 'LB', lbHealthy === true ? 'ok' : (lbHealthy === false ? 'down' : 'unknown'), lbHealthy === true ? 'good' : (lbHealthy === false ? 'hot' : 'dim'));
    var local = Array.isArray(infra.localVerify) ? infra.localVerify.length : 0;
    pill(box, 'Laptop verify', String(local), local ? 'warn' : 'dim');
    var storage = snap.storage || null;
    var vols = storage && Array.isArray(storage.volumes) ? storage.volumes : [];
    vols.forEach(function (v) {
      var name = v.id === 'sd' ? 'SD card' : 'Disk';
      if (v.mounted === false) { pill(box, name, 'not mounted', 'dim'); return; }
      var free = typeof v.freeGb === 'number' ? v.freeGb : null;
      // low and critical come from the manager's live thresholds.
      var low = typeof v.low === 'boolean' ? v.low : free !== null && free < (v.id === 'sd' ? 50 : 100);
      var critical = typeof v.critical === 'boolean' ? v.critical : v.id !== 'sd' && free !== null && free < 15;
      var tone = free === null ? 'dim' : (critical ? 'hot' : (low ? 'warn' : 'good'));
      var text = free === null ? 'unknown' : Math.round(free) + ' GB free';
      if (v.id === 'sd' && v.identityOk === false) text += ', unverified';
      pill(box, name, text, tone);
    });
    if (storage && storage.lastFreed && typeof storage.lastFreed.gb === 'number') pill(box, 'Freed', storage.lastFreed.gb + ' GB ' + ago(storage.lastFreed.at), 'dim');
    var errors = snap.sourceErrors || {};
    Object.keys(errors).forEach(function (source) {
      pill(box, source, clip(errors[source], 120), 'hot');
    });
  }

  // ─── fleet ───────────────────────────────────────────────────────────────

  function line(parent, key, value) {
    if (value === undefined || value === null || value === '') return;
    var p = el('p', null, null, parent);
    el('span', 'k', key, p);
    el('span', null, value, p);
  }

  function ciText(ci) {
    if (!ci) return '';
    if (typeof ci === 'string') return ci;
    return typeof ci.state === 'string' ? ci.state : '';
  }

  function ciLine(ci) {
    if (!ci) return '';
    if (typeof ci === 'string') return 'CI ' + ci;
    var bits = [typeof ci.state === 'string' ? 'CI ' + ci.state : ''];
    if (Array.isArray(ci.failing) && ci.failing.length) bits.push('failing: ' + ci.failing.join(', '));
    if (Array.isArray(ci.pending) && ci.pending.length) bits.push('pending: ' + ci.pending.join(', '));
    return bits.filter(Boolean).join(', ');
  }

  function prLine(parent, pr) {
    if (!pr || (!pr.ref && !pr.url)) return;
    var p = el('p', null, null, parent);
    el('span', 'k', 'PR', p);
    link(pr.ref ? shortRef(pr.ref) : 'pull request', prHref(pr, pr.ref), p);
    var bits = [pr.state, ciLine(pr.ci), typeof pr.unresolvedThreads === 'number' ? pr.unresolvedThreads + ' open threads' : '', pr.mergeState];
    var rest = bits.filter(Boolean).join(', ');
    if (rest) el('span', null, ' ' + rest, p);
    if (pr.title) el('p', 'why', pr.title, parent);
  }

  // A row's expanded context: the last scan's row, and once it arrives the
  // thread's detail for the longer message and fields the row lacks.
  function paintMore(more, t, entry) {
    var x = entry && entry.thread ? entry.thread : null;
    function field(name) {
      return Object.prototype.hasOwnProperty.call(t, name) ? t[name] : (x && x[name]);
    }
    var w = field('watch');
    if (w && w.group) {
      var since = w.waitSince || w.since;
      var what = (WATCH_LABEL[w.group] || w.group) + (w.waitingOn ? ': ' + w.waitingOn : '');
      line(more, 'Waits on', what + (since ? ', for ' + dur(since) + ' (since ' + when(since) + ')' : ''));
    }
    line(more, 'Agent', [t.kind, field('agentStatus')].filter(Boolean).join(', '));
    if (w && w.runningSince) line(more, 'Turn running', 'for ' + dur(w.runningSince) + ' (since ' + when(w.runningSince) + ')');
    var spoke = (x && x.lastAgentMessage && x.lastAgentMessage.at) || t.lastAgentAt;
    if (spoke) line(more, 'Agent last spoke', ago(spoke));
    var owner = field('lastOwnerAt');
    if (owner) line(more, 'You last wrote', ago(owner));
    if (t.lastActivityAt) line(more, 'Last activity', ago(t.lastActivityAt));
    line(more, 'Branch', t.branch);
    prLine(more, field('pr'));
    var blockers = Array.isArray(t.blockers) ? t.blockers : [];
    if (blockers.length > 1) line(more, 'Blockers', blockers.join('; '));
    var dec = field('decision');
    if (dec && dec.action && dec.action !== 'none') {
      line(more, 'Next', dec.action + (dec.playbook ? ' (' + dec.playbook + ')' : '') + (dec.notBefore ? ', not before ' + when(dec.notBefore) : ''));
    }
    if (dec && dec.reason) line(more, 'Why', dec.reason);
    var muted = field('muted');
    if (muted) line(more, 'Muted until', when(muted));
    chatNote(field('openChat'), more);
    var said = x && x.lastAgentMessage && typeof x.lastAgentMessage.text === 'string' ? x.lastAgentMessage.text : t.lastAgentText;
    if (said) {
      el('p', 'k', 'Last agent message (unverified):', more);
      el('blockquote', 'quote', said, more);
    }
    if (x && x.scannedAt) el('p', 'note', 'As of the scan ' + ago(x.scannedAt) + '.', more);
    if (entry && entry.error) el('p', 'note', 'More detail could not load: ' + clip(entry.error, 160), more);
    else if (!x && detailLoading.has(t.key)) el('p', 'note', 'Loading the latest…', more);
  }

  function threadPath(key) {
    return '/fleet/api/threads/' + encodeURIComponent(key);
  }

  // Fetch a row's detail when it opens (and again on a later render once it
  // is stale), then repaint just that row.
  async function wantDetail(key, maxAgeMs) {
    var have = details.get(key);
    if (detailLoading.has(key) || (have && Date.now() - have.at < maxAgeMs)) return;
    detailLoading.add(key);
    var paint = painters.get(key);
    if (paint) paint();
    try {
      var r = await api(threadPath(key));
      details.set(key, { at: Date.now(), thread: r && r.thread ? r.thread : null, error: '' });
    } catch (e) {
      details.set(key, { at: Date.now(), thread: null, error: e.status === 404 ? 'not in the last scan; scan again' : e.message });
    } finally {
      detailLoading.delete(key);
    }
    paint = painters.get(key);
    if (paint) paint();
  }

  // What the owner can do from the row: answer or dismiss the question it
  // waits on, Push now (only a planned nudge, the words shown first), Mute or
  // Unmute. Open chat sits on the row itself.
  var pushing = new Set();
  function rowActions(t, parent) {
    var group = t.watch ? t.watch.group : '';
    var asks = group === 'you' ? questionsFor(t.key) : [];
    asks.forEach(function (q) {
      var box = el('div', 'ask', null, parent);
      el('span', 't', q.title || 'Question', box);
      var asked = q.askedAt || q.createdAt;
      if (asked) el('div', 'sub', 'asked ' + ago(asked) + (q.chatLabel ? ' in ' + q.chatLabel : ''), box);
      askText(q, box);
      var inApp = q.answerIn ? q.answerIn === 'agent app' : q.kind === 'agent-card';
      var acts = el('div', 'acts', null, box);
      if (inApp) openChatLink(q.openChat, 'btn primary', acts);
      answerButtons(q, acts, !inApp);
      if (inApp) el('p', 'note', appNote(q), box);
    });
    if (!t.watch) return;
    var dec = t.pushPreview || null;
    var why = dec || t.decision || null;
    var plan = dec && dec.action === 'nudge' && typeof dec.message === 'string' ? dec.message : '';
    var canPush = Boolean(plan) && !t.muted && group !== 'you';
    if (canPush) {
      el('p', 'k', 'Push now sends:', parent);
      el('blockquote', 'quote', plan, parent);
    } else if (group === 'push' && !t.muted) {
      el('p', 'why', 'No nudge planned yet' + (why && why.reason ? ': ' + clip(why.reason, 160) : '.'), parent);
    }
    var acts = el('div', 'acts', null, parent);
    if (canPush) {
      var push = button('Push now', 'btn primary', acts, function () { return pushNow(t, push); });
      push.disabled = t.pushing || pushing.has(t.key);
    }
    if (t.muted) {
      var un = button('Unmute', 'btn', acts, function () { return mute(t, false, un); });
    } else {
      var mu = button('Mute ' + MUTE_HOURS + 'h', 'btn', acts, function () { return mute(t, true, mu); });
    }
  }

  function renderThread(t, parent) {
    var d = el('details', 'thread item', null, parent);
    d.open = openThreads.has(t.key);
    var s = el('summary', null, null, d);
    var head = el('div', 'head', null, s);
    el('span', 't', threadName(t), head);
    if (t.live) el('span', 'live', 'live', head);
    if (t.muted) el('span', 'chip dim', 'muted', head).title = 'Muted until ' + when(t.muted);
    var sub = el('div', 'sub', null, s);
    if (t.openChat && t.openChat.label) el('span', null, t.openChat.label, sub);
    else if (t.workspace) el('span', null, t.workspace, sub);
    else if (t.repo) el('span', null, t.repo, sub);
    if (t.pr && t.pr.ref) link(shortRef(t.pr.ref), prHref(t.pr, t.pr.ref), sub);
    if (t.watch && t.watch.since) el('span', 'since', watchText(t.watch), sub);
    else if (t.lastActivityAt) el('span', null, ago(t.lastActivityAt), sub);
    // A link inside summary opens the chat without toggling the row.
    openChatLink(t.openChat, null, sub);
    var blockers = Array.isArray(t.blockers) ? t.blockers : [];
    var top = blockers[0] || t.reason;
    if (top) el('div', 'blocker ' + (STATE_TONE[t.state] || 'dim'), clip(top, 160), s);

    rowActions(t, d);
    var more = el('div', 'more', null, d);
    var paint = function () {
      more.replaceChildren();
      paintMore(more, t, details.get(t.key));
    };
    painters.set(t.key, paint);
    paint();
    // A row the owner just opened wants fresh detail; one a re-render keeps
    // open (its toggle fires too) refetches only once the detail is stale.
    d.addEventListener('toggle', function () {
      if (!d.open) { openThreads.delete(t.key); return; }
      var fresh = !openThreads.has(t.key);
      openThreads.add(t.key);
      wantDetail(t.key, fresh ? BUSY_POLL_MS : DETAIL_TTL_MS);
    });
    if (d.open) wantDetail(t.key, DETAIL_TTL_MS);
  }

  function pushNote(delivery) {
    var status = delivery && delivery.status;
    var detail = delivery && typeof delivery.detail === 'string' ? clip(delivery.detail, 160) : '';
    var card = delivery && delivery.prompt && delivery.prompt.text ? ' The chat shows a card: ' + clip(delivery.prompt.text, 120) : '';
    if (status === 'sent') return { text: 'Pushed. Sent to the agent.', bad: false };
    if (status === 'blocked') return { text: 'Not pushed' + (detail ? ': ' + detail : '.') + card, bad: true };
    if (status === 'failed') return { text: 'Push failed' + (detail ? ': ' + detail : '.') + card, bad: true };
    return { text: 'Push sent.', bad: false };
  }

  // The owner's Push now: the planned nudge goes out at once, as theirs.
  async function pushNow(t, b) {
    if (pushing.has(t.key)) return;
    pushing.add(t.key);
    b.disabled = true;
    b.textContent = 'Pushing…';
    try {
      var r = await api(threadPath(t.key) + '/push', {});
      var note = pushNote(r && r.delivery);
      details.delete(t.key);
      pushing.delete(t.key);
      if (r && r.state) render(r.state); else await load();
      say(note.text, note.bad);
    } catch (e) {
      b.disabled = false;
      b.textContent = 'Push now';
      say(e.message, true);
      if (e.status === 404) await load();
    } finally { pushing.delete(t.key); }
  }

  async function mute(t, on, b) {
    b.disabled = true;
    try {
      var r = await api(threadPath(t.key) + (on ? '/mute' : '/unmute'), on ? { hours: MUTE_HOURS } : {});
      details.delete(t.key);
      if (r && r.state) render(r.state); else await load();
      say(on ? 'Muted until ' + when(r && r.muted) + '. No nudges or questions for it till then.' : 'Unmuted.');
    } catch (e) {
      b.disabled = false;
      say(e.message, true);
    }
  }

  function renderFleet(snap) {
    var box = $('fleetList');
    box.replaceChildren();
    painters.clear();
    var threads = snap && Array.isArray(snap.threads) ? snap.threads : [];
    var counts = snap && snap.counts ? snap.counts : null;
    var inScope = counts && typeof counts.inScope === 'number' ? counts.inScope : threads.length;
    $('fleetCount').textContent = threads.length ? String(inScope) : '';
    if (!snap) { el('p', 'empty', 'No scan yet. Tap Scan now.', box); return; }
    if (!threads.length) { el('p', 'empty', 'No recent coding threads.', box); return; }
    // Grouped by what the supervisor watches each thread for; a snapshot from
    // before watch existed groups by state as it used to. Out of scope last.
    var byWatch = threads.some(function (t) { return t.watch; });
    var groups = new Map();
    threads.forEach(function (t) {
      var st = byWatch ? (t.watch ? t.watch.group : 'excluded') : (t.state || 'unknown');
      if (!groups.has(st)) groups.set(st, []);
      groups.get(st).push(t);
    });
    var order = (byWatch ? WATCH_ORDER.concat(['excluded']) : STATE_ORDER).filter(function (st) { return groups.has(st); });
    groups.forEach(function (_list, st) { if (order.indexOf(st) < 0) order.push(st); });
    order.forEach(function (st) {
      // Longest-waiting first where time matters; newest activity first otherwise.
      var list = groups.get(st).slice().sort(function (a, b) {
        if (byWatch && st !== 'quiet' && st !== 'excluded' && a.watch && b.watch) {
          return String(a.watch.since || '').localeCompare(String(b.watch.since || ''));
        }
        return String(b.lastActivityAt || '').localeCompare(String(a.lastActivityAt || ''));
      });
      var g = el('details', 'group', null, box);
      g.open = groupOpen.has(st) ? groupOpen.get(st) : !COLLAPSED[st];
      g.addEventListener('toggle', function () { groupOpen.set(st, g.open); });
      var sum = el('summary', null, null, g);
      var label = byWatch ? (WATCH_LABEL[st] || STATE_LABEL[st] || st) : (STATE_LABEL[st] || st);
      var tone = byWatch ? (WATCH_TONE[st] || STATE_TONE[st] || 'dim') : (STATE_TONE[st] || 'dim');
      el('span', 'chip ' + tone, label, sum);
      el('span', 'n', String(list.length), sum);
      var wrap = el('div', 'list', null, g);
      list.forEach(function (t) { renderThread(t, wrap); });
    });
  }

  // ─── page ────────────────────────────────────────────────────────────────

  function focusQuestion() {
    if (!focusId) return;
    var id = focusId;
    focusId = '';
    var card = cards.get(id);
    if (!card) { say('That question is already closed.'); return; }
    card.classList.add('flash');
    var reduce = Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    card.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
    setTimeout(function () { card.classList.remove('flash'); }, 2600);
  }

  function render(s) {
    if (!s || typeof s !== 'object') return;
    current = s;
    var snap = s.snapshot || null;
    var byKey = new Map();
    (snap && Array.isArray(snap.threads) ? snap.threads : []).forEach(function (t) { byKey.set(t.key, t); });
    renderHeader(s);
    var questions = Array.isArray(s.questions) ? s.questions : [];
    renderNeeds(questions, byKey);
    renderReviewed(Array.isArray(s.reviewClosed) ? s.reviewClosed : [], questions);
    renderDoing(Array.isArray(s.actions) ? s.actions : [], byKey);
    renderInfra(snap);
    renderFleet(snap);
    var fixes = document.getElementById('self-fixes');
    if (fixes) {
      fixes.textContent = '';
      (Array.isArray(s.fixes) ? s.fixes : []).forEach(function (fix) {
        var row = document.createElement('p');
        row.textContent = fix.title + ' · ' + fix.state + ' · round ' + (fix.round || 0);
        if (fix.prUrl && /^https:\/\/github\.com\/Spshulem\/openAGI\/pull\/[0-9]+$/i.test(fix.prUrl)) {
          var link = document.createElement('a'); link.href = fix.prUrl; link.textContent = ' Review PR'; row.appendChild(link);
        }
        fixes.appendChild(row);
      });
    }
    focusQuestion();
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(load, current && current.running ? BUSY_POLL_MS : POLL_MS);
  }

  async function load() {
    try {
      render(await api('/fleet/api/state'));
      if (errorShown) say('');
    } catch (e) {
      say(e.status ? e.message : 'Cannot reach OpenAGI. Retrying.', true);
      if (e.data && e.data.error === 'main-pairing-required') {
        var link = document.getElementById('reconnect'); link.hidden = false;
        try {
          var roster = await api('/nodes');
          var origin = new URL(roster.pairedTo);
          if ((origin.protocol === 'https:' || origin.protocol === 'http:') && !origin.username && !origin.password) {
            link.href = origin.origin; link.textContent = 'Open your connected agent';
          }
        } catch (_) { /* The connection settings link remains available. */ }
      }
    } finally {
      schedule();
    }
  }

  async function scan() {
    if (scanning) return;
    scanning = true;
    paintScan();
    say('Scanning…');
    try {
      var s = await api('/fleet/api/scan', {});
      scanning = false;
      render(s);
      say('Scan done.');
    } catch (e) {
      scanning = false;
      if (e.data && e.data.state) render(e.data.state); else paintScan();
      say(e.message, true);
    }
  }

  async function setMode(mode) {
    if (modeBusy || (current && current.mode === mode)) return;
    if (mode === 'auto' && !confirm('Auto mode sends nudges to agents without asking you. Turn it on?')) return;
    modeBusy = true;
    paintModes();
    try {
      var s = await api('/fleet/api/mode', { mode: mode });
      modeBusy = false;
      render(s);
      say('Mode: ' + mode + '.');
    } catch (e) {
      modeBusy = false;
      paintModes();
      say(e.message, true);
    }
  }

  $('scan').addEventListener('click', function () { return scan(); });
  MODES.forEach(function (m) {
    $('mode-' + m).addEventListener('click', function () { return setMode(m); });
  });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') load();
  });
  load();
})();
</script>
</body></html>`
  .replace("FLEET_FULL_SLOW_SEC", String(DEFAULTS.fullRunSlowMs / 1000))
  .replace("FLEET_QUICK_SLOW_SEC", String(DEFAULTS.quickVerifyEscalateMs / 1000));
