// Standalone /fleet mini app: phone-first view of the fleet supervisor.
// String.raw keeps the client script byte-for-byte. Rules for this file:
// no backtick and no dollar-brace anywhere (they would end or interpolate the
// literal), no inline on* handlers (CSP), and every piece of dynamic data is
// rendered with textContent. Client code uses plain string concatenation.

export const fleetPage = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0e1411">
<title>Fleet - OpenAGI</title>
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
@media (prefers-reduced-motion:no-preference){.card{transition:box-shadow .4s ease,border-color .4s ease}}
@media (min-width:700px){.wrap{padding-top:32px}.opts{grid-template-columns:repeat(2,1fr)}.opts .btn.ghost{grid-column:1/-1}}
</style></head>
<body><div class="wrap">
<header>
  <div class="top"><h1>Fleet</h1><button id="scan" class="btn primary" type="button">Scan now</button></div>
  <div class="seg" role="group" aria-label="Mode">
    <button id="mode-observe" type="button" data-mode="observe" aria-pressed="false">Observe</button>
    <button id="mode-propose" type="button" data-mode="propose" aria-pressed="false">Propose</button>
    <button id="mode-auto" type="button" data-mode="auto" aria-pressed="false">Auto</button>
  </div>
  <p id="modeHint" class="hint"></p>
  <div class="meta"><span id="scanned">Loading</span><span id="timer"></span><a href="/">Dashboard</a></div>
  <p id="lastError" class="lasterr"></p>
  <p id="status" class="status" role="status" aria-live="polite"></p>
</header>
<main>
  <section aria-labelledby="needsH"><h2 id="needsH">Needs you <span id="needsCount" class="n"></span></h2><div id="needsList"></div></section>
  <section aria-labelledby="doingH"><h2 id="doingH">Doing <span id="doingCount" class="n"></span></h2><div id="doingList"></div></section>
  <section aria-labelledby="infraH"><h2 id="infraH">Infra</h2><div id="infraStrip" class="strip"></div></section>
  <section aria-labelledby="fleetH"><h2 id="fleetH">Fleet <span id="fleetCount" class="n"></span></h2><div id="fleetList"></div></section>
</main>
</div>
<script>
(function () {
  'use strict';
  var POLL_MS = 30000;
  var BUSY_POLL_MS = 5000;
  var MODES = ['observe', 'propose', 'auto'];
  var MODE_HINT = {
    observe: 'Watching only. Sends nothing.',
    propose: 'Plans nudges. You tap Send.',
    auto: 'Sends nudges on its own, a few per scan.'
  };
  var STATE_ORDER = ['needs-human', 'ready-needs-human', 'asked-in-scope', 'pr-not-ready', 'infra-blocked', 'local-verify',
    'waiting-ci', 'running', 'idle-no-pr', 'done', 'excluded'];
  var STATE_LABEL = {
    'needs-human': 'Needs you', 'ready-needs-human': 'Ready, needs a human', 'asked-in-scope': 'Asked, in scope',
    'pr-not-ready': 'PR not ready', 'infra-blocked': 'Infra blocked', 'local-verify': 'Verifying on laptop',
    'waiting-ci': 'Waiting on CI', running: 'Running', 'idle-no-pr': 'Idle, no PR', done: 'Done', excluded: 'Out of scope'
  };
  var STATE_TONE = {
    'needs-human': 'hot', 'ready-needs-human': 'hot', 'asked-in-scope': 'warn', 'pr-not-ready': 'warn',
    'infra-blocked': 'warn', 'local-verify': 'warn', 'waiting-ci': 'good', running: 'good', 'idle-no-pr': 'dim',
    done: 'dim', excluded: 'dim'
  };
  var COLLAPSED = { done: true, excluded: true, 'idle-no-pr': true };
  var ACTION_LABEL = { planned: 'Planned', proposed: 'Proposed', sent: 'Sent', 'dry-run': 'Dry run', blocked: 'Blocked', failed: 'Failed', done: 'Done' };
  var ACTION_TONE = { planned: 'dim', proposed: 'warn', sent: 'good', 'dry-run': 'dim', blocked: 'hot', failed: 'hot', done: 'good' };
  var ROUTE_LABEL = { 'codex-exec': 'Codex resume', 'peer-relay': 'live relay', 'claude-resume': 'Claude resume' };
  var INFRA_NAME = { 'infra:bb3': 'BuildBot3', 'infra:lb': 'Codex load balancer' };
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
      var message = res.status === 401 ? 'Signed out. Reload to sign in.' : ((data && data.error) || ('Request failed (' + res.status + ').'));
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
      if (t) el('span', null, t.workspace || threadName(t), ctx);
      if (q.prRef) link(shortRef(q.prRef), prHref(t && t.pr, q.prRef), ctx);
      if (q.createdAt) el('span', null, ago(q.createdAt), ctx);
      if (q.body) el('p', null, q.body, card);
      var opts = el('div', 'opts', null, card);
      var buttons = [];
      var options = Array.isArray(q.options) ? q.options.filter(function (o) { return o && o !== 'dismiss'; }) : [];
      options.forEach(function (option, index) {
        buttons.push(button(option, 'btn' + (index === 0 ? ' primary' : ''), opts, function () {
          return decide(q, { answer: option }, buttons);
        }));
      });
      buttons.push(button('Dismiss', 'btn ghost', opts, function () { return decide(q, { dismiss: true }, buttons); }));
      if (q.kind === 'agent-ask') el('p', 'note', 'Your answer goes to the agent.', card);
    });
  }

  async function decide(q, body, buttons) {
    buttons.forEach(function (b) { b.disabled = true; });
    try {
      var r = await api('/fleet/api/questions/' + encodeURIComponent(q.id), body);
      var note = body.dismiss ? { text: 'Dismissed.', bad: false } : deliveryNote(r && r.delivery, 'Answered.');
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
    var name = about ? threadName(about) : (INFRA_NAME[a.threadKey] || a.threadKey || 'Unknown thread');
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
      el('span', 'chip ' + (ACTION_TONE[a.status] || 'dim'), ACTION_LABEL[a.status] || a.status || 'Unknown', head);
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
      var runs = Array.isArray(bb3.runs) ? bb3.runs : [];
      var oldest = runs.reduce(function (best, r) { return !best || (r.ageSec || 0) > (best.ageSec || 0) ? r : best; }, null);
      if (oldest) {
        var slow = (oldest.ageSec || 0) > (oldest.kind === 'full' ? 1800 : 900);
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

  function renderThread(t, parent) {
    var d = el('details', 'thread item', null, parent);
    d.open = openThreads.has(t.key);
    d.addEventListener('toggle', function () {
      if (d.open) openThreads.add(t.key); else openThreads.delete(t.key);
    });
    var s = el('summary', null, null, d);
    var head = el('div', 'head', null, s);
    el('span', 't', threadName(t), head);
    if (t.live) el('span', 'live', 'live', head);
    var sub = el('div', 'sub', null, s);
    if (t.workspace) el('span', null, t.workspace, sub);
    else if (t.repo) el('span', null, t.repo, sub);
    if (t.pr && t.pr.ref) link(shortRef(t.pr.ref), prHref(t.pr, t.pr.ref), sub);
    if (t.lastActivityAt) el('span', null, ago(t.lastActivityAt), sub);
    var blockers = Array.isArray(t.blockers) ? t.blockers : [];
    var top = blockers[0] || t.reason;
    if (top) el('div', 'blocker ' + (STATE_TONE[t.state] || 'dim'), clip(top, 160), s);

    var more = el('div', 'more', null, d);
    line(more, 'Agent', [t.kind, t.agentStatus].filter(Boolean).join(', '));
    line(more, 'Branch', t.branch);
    if (t.pr) {
      var prBits = [t.pr.state, ciText(t.pr.ci) ? 'CI ' + ciText(t.pr.ci) : '',
        typeof t.pr.unresolvedThreads === 'number' ? t.pr.unresolvedThreads + ' open threads' : '', t.pr.mergeState];
      line(more, 'PR', prBits.filter(Boolean).join(', '));
    }
    if (blockers.length > 1) line(more, 'Blockers', blockers.join('; '));
    var dec = t.decision || null;
    if (dec && dec.action && dec.action !== 'none') {
      line(more, 'Next', dec.action + (dec.playbook ? ' (' + dec.playbook + ')' : '') + (dec.notBefore ? ', not before ' + when(dec.notBefore) : ''));
    }
    if (dec && dec.reason) line(more, 'Why', dec.reason);
    if (t.lastAgentText) {
      el('p', 'k', 'Last agent message (unverified):', more);
      el('blockquote', 'quote', t.lastAgentText, more);
    }
  }

  function renderFleet(snap) {
    var box = $('fleetList');
    box.replaceChildren();
    var threads = snap && Array.isArray(snap.threads) ? snap.threads : [];
    var counts = snap && snap.counts ? snap.counts : null;
    var inScope = counts && typeof counts.inScope === 'number' ? counts.inScope : threads.length;
    $('fleetCount').textContent = threads.length ? String(inScope) : '';
    if (!snap) { el('p', 'empty', 'No scan yet. Tap Scan now.', box); return; }
    if (!threads.length) { el('p', 'empty', 'No recent coding threads.', box); return; }
    var groups = new Map();
    threads.forEach(function (t) {
      var st = t.state || 'unknown';
      if (!groups.has(st)) groups.set(st, []);
      groups.get(st).push(t);
    });
    var order = STATE_ORDER.filter(function (st) { return groups.has(st); });
    groups.forEach(function (_list, st) { if (order.indexOf(st) < 0) order.push(st); });
    order.forEach(function (st) {
      var list = groups.get(st).slice().sort(function (a, b) {
        return String(b.lastActivityAt || '').localeCompare(String(a.lastActivityAt || ''));
      });
      var g = el('details', 'group', null, box);
      g.open = groupOpen.has(st) ? groupOpen.get(st) : !COLLAPSED[st];
      g.addEventListener('toggle', function () { groupOpen.set(st, g.open); });
      var sum = el('summary', null, null, g);
      el('span', 'chip ' + (STATE_TONE[st] || 'dim'), STATE_LABEL[st] || st, sum);
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
    renderNeeds(Array.isArray(s.questions) ? s.questions : [], byKey);
    renderDoing(Array.isArray(s.actions) ? s.actions : [], byKey);
    renderInfra(snap);
    renderFleet(snap);
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
</body></html>`;
