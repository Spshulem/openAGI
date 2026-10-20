import { designTokens } from "./app-shell.js";

const escape = value => String(value ?? "").replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);

export function renderModelSetup({ proposedToken, existingEnv = {} }) {
  const value = (key, fallback = "") => escape(existingEnv[key] ?? fallback);
  const saved = key => existingEnv[key] ? '<span class="saved">Saved key · leave blank to keep</span>' : '';
  const selected = ['anthropic','openai','local','on-device','chatgpt'].includes(existingEnv.OPENAGI_PROVIDER)
    ? existingEnv.OPENAGI_PROVIDER : existingEnv.ANTHROPIC_API_KEY ? 'anthropic' : existingEnv.OPENAI_API_KEY ? 'openai' : 'anthropic';
  const choice = (id, name, description, badge) => `<label class="model-choice"><input type="radio" name="OPENAGI_PROVIDER" value="${id}" ${id === selected ? 'checked' : ''}><span><strong>${name}</strong><small>${description}</small></span><span class="choice-badge">${badge}</span></label>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect your model · OpenAGI</title><style>
${designTokens}
body { margin:0; background:var(--panel); color:var(--text); font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
a { color:var(--accent); text-decoration:none; } a:hover { text-decoration:underline; }
.setup-top { display:flex; align-items:center; justify-content:flex-end; max-width:1160px; margin:auto; padding:28px 32px; }
.setup-top>a { color:var(--muted); font-size:12px; }
.setup-layout { max-width:1000px; margin:52px auto; padding:0 32px; display:grid; grid-template-columns:270px minmax(0,1fr); gap:72px; }
.setup-context { padding-top:24px; }
.eyebrow { color:var(--accent); font-size:12px; font-weight:600; margin:0 0 16px; }
.setup-context h1 { font-size:34px; line-height:1.15; letter-spacing:-1.1px; font-weight:600; margin:0 0 20px; }
.setup-context p { color:var(--muted); line-height:1.7; }
.setup-steps { list-style:none; padding:0; margin:36px 0; display:grid; gap:20px; }
.setup-steps li { display:flex; align-items:center; gap:12px; color:var(--muted); font-size:13px; }
.setup-steps span { display:grid; place-items:center; height:26px; width:26px; border:1px solid var(--line); border-radius:50%; font-size:11px; }
.setup-steps li[aria-current="step"] { color:var(--text); font-weight:600; }
.setup-steps li[aria-current="step"] span { background:var(--accent); border-color:var(--accent); color:var(--primary-foreground); }
.setup-card { padding:36px; background:var(--bg); border:1px solid var(--line); border-radius:16px; box-shadow:var(--shadow-sm); min-width:0; }
.setup-card h2 { font-size:23px; line-height:1.3; letter-spacing:-.6px; font-weight:600; margin:0 0 8px; }
.subtext { color:var(--muted); margin:0 0 24px; font-size:13px; }
.model-options { display:grid; gap:10px; }
.model-choice { display:flex; gap:12px; align-items:center; border:1px solid var(--line); border-radius:9px; padding:15px; cursor:pointer; }
.model-choice:has(input:checked) { border-color:var(--accent); background:var(--accent-soft); }
.model-choice input { accent-color:var(--accent); margin:0; flex-shrink:0; }
.model-choice strong { display:block; font-size:13px; font-weight:600; }
.model-choice small { display:block; color:var(--muted); font-size:12px; margin-top:3px; }
.choice-badge { font-size:10px; color:var(--muted); margin-left:auto; white-space:nowrap; }
.field { display:block; font-size:12px; font-weight:600; margin:20px 0 7px; }
input[type=password],input[type=text],input[type=url],input[type=number] { width:100%; background:var(--bg); border:1px solid var(--line); border-radius:7px; padding:11px 12px; color:var(--text); font-size:13px; }
.saved { color:var(--muted); display:block; font-size:11px; font-weight:400; margin:4px 0; }
.hint { color:var(--muted); font-size:12px; margin:8px 0; }
.note { background:var(--panel); border-radius:8px; padding:16px; margin:20px 0; color:var(--muted); font-size:12px; line-height:1.7; }
.note strong { color:var(--text); } .note code { font-size:11px; color:var(--text); overflow-wrap:anywhere; }
fieldset { border:0; padding:0; margin:0; min-width:0; }
details { margin-top:22px; font-size:12px; color:var(--muted); } summary { cursor:pointer; }
.actions { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-top:28px; padding-top:22px; border-top:1px solid var(--line); }
button,.primary-link { border:1px solid var(--line); background:var(--bg); color:var(--text); border-radius:7px; padding:10px 16px; cursor:pointer; font-weight:550; font-size:13px; display:inline-block; text-align:center; }
button.primary,.primary-link { background:var(--accent); border-color:var(--accent); color:var(--primary-foreground); }
button:disabled { opacity:.55; cursor:wait; } .actions .back { border:0; padding-left:0; color:var(--muted); }
.footnote { text-align:center; color:var(--muted); font-size:11px; margin:18px 0 0; }
#output { margin-top:20px; padding:14px; background:var(--panel); border:1px solid var(--line); border-radius:8px; font-size:12px; overflow-wrap:anywhere; }
#output.error { color:var(--err); } .ready-mark { color:var(--accent); display:grid; place-items:center; width:44px; height:44px; border-radius:50%; background:var(--accent-soft); font-size:22px; margin-bottom:20px; }
.ready-list { display:grid; gap:16px; margin:28px 0; color:var(--muted); font-size:13px; }
.ready-list strong { color:var(--text); display:block; font-weight:550; margin-bottom:3px; }
.token-actions { display:flex; gap:8px; align-items:center; margin-top:8px; } .token-actions button { flex-shrink:0; }
@media(max-width:760px) { .setup-top { padding:20px; } .setup-layout { margin:12px auto 32px; grid-template-columns:1fr; gap:16px; padding:0 20px; max-width:600px; } .setup-context { padding:0; } .setup-context h1 { font-size:28px; margin-bottom:12px; } .setup-context>p:not(.eyebrow) { display:none; } .setup-steps { display:flex; margin:22px 0 12px; gap:20px; } .setup-steps li { gap:7px; font-size:12px; } .setup-steps span { height:22px; width:22px; } .setup-card { padding:24px; } .choice-badge { display:none; } }
</style></head><body>
<header class="setup-top"><a href="https://github.com/Spshulem/openAGI/blob/main/docs/INSTALL.md" target="_blank" rel="noopener noreferrer">Setup guide ↗</a></header>
<main class="setup-layout"><aside class="setup-context"><p class="eyebrow">A little setup. A lot of possibility.</p><h1>Your agent.<br>Your choice of model.</h1><p>Start with a model that works for you. Then we’ll help you put it to work, one conversation at a time.</p>
<ol class="setup-steps" aria-label="Setup progress"><li aria-current="step"><span>1</span>Choose</li><li><span>2</span>Connect</li><li><span>3</span>Start</li></ol><p class="hint">Keys stay on your agent’s host. Requests go to the model you choose.</p></aside>
<div><form class="setup-card" id="form" data-selected="${selected}" data-has-auth="${Boolean(existingEnv.OPENAGI_AUTH_TOKEN)}"><input type="hidden" name="OPENAGI_AUTH_TOKEN" id="tokenInput" value="${escape(proposedToken)}">
<section data-step="0"><h2>Choose your model</h2><p class="subtext">Use a cloud provider or keep inference on your device.</p><div class="model-options">
${choice('anthropic','Anthropic','Claude with your API key','Cloud')}${choice('openai','OpenAI','GPT with your API key','Cloud')}${choice('local','Local model','Ollama, LM Studio, or a compatible server','Your computer')}${choice('on-device','Apple Intelligence','Built-in model on a compatible Mac or iPhone','No API key')}${choice('chatgpt','ChatGPT plan','Connect an eligible ChatGPT account','Sign in')}
</div><div class="actions"><span class="hint">You can change this later.</span><button class="primary" type="button" id="chooseNext">Continue →</button></div></section>
<section data-step="1" hidden><h2 id="connectTitle">Connect your model</h2><p class="subtext" id="connectDescription">We’ll check the connection before you start chatting.</p>
<fieldset data-provider="anthropic" disabled hidden><label class="field" for="anthropicKey">Anthropic API key ${saved('ANTHROPIC_API_KEY')}</label><input id="anthropicKey" name="ANTHROPIC_API_KEY" type="password" autocomplete="off" placeholder="sk-ant-…"><p class="hint">Get a key at <a href="https://console.anthropic.com/" target="_blank" rel="noopener noreferrer">console.anthropic.com ↗</a></p><details><summary>Model options</summary><label class="field" for="anthropicModel">Model</label><input id="anthropicModel" name="ANTHROPIC_MODEL" type="text" value="${value('ANTHROPIC_MODEL','claude-sonnet-4-6')}"></details></fieldset>
<fieldset data-provider="openai" disabled hidden><label class="field" for="openaiKey">OpenAI API key ${saved('OPENAI_API_KEY')}</label><input id="openaiKey" name="OPENAI_API_KEY" type="password" autocomplete="off" placeholder="sk-…"><p class="hint">Get a key at <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener noreferrer">platform.openai.com ↗</a></p><details><summary>Model options</summary><label class="field" for="openaiModel">Model</label><input id="openaiModel" name="OPENAI_MODEL" type="text" value="${value('OPENAI_MODEL','gpt-5')}"><label class="field" for="openaiBaseUrl">Responses-compatible base URL</label><input id="openaiBaseUrl" name="OPENAI_BASE_URL" type="url" value="${value('OPENAI_BASE_URL','https://api.openai.com/v1')}"><p class="hint">Use the endpoint and model supplied by your provider. An OpenRouter key cannot use the default OpenAI endpoint.</p></details></fieldset>
<fieldset data-provider="local" disabled hidden><label class="field" for="localUrl">Model server URL</label><input id="localUrl" name="OPENAGI_LOCAL_BASE_URL" type="url" value="${value('OPENAGI_LOCAL_BASE_URL','http://localhost:11434/v1')}" required><label class="field" for="localModel">Installed model name</label><input id="localModel" name="OPENAGI_LOCAL_MODEL" type="text" value="${value('OPENAGI_LOCAL_MODEL')}" placeholder="e.g. llama3.2" required><div class="note"><strong>Using Ollama?</strong><br>Start <a href="https://ollama.com/download" target="_blank" rel="noopener noreferrer">Ollama</a>, run <code>ollama pull llama3.2</code>, then enter <code>llama3.2</code> above. For LM Studio, start its local server and use its URL ending in <code>/v1</code>.<br>Choose a model with tool support to let your agent take actions. Screen tools also require a model with vision support.</div><details><summary>Server authentication (optional)</summary><label class="field" for="localKey">Server API key ${saved('OPENAGI_LOCAL_API_KEY')}</label><input id="localKey" name="OPENAGI_LOCAL_API_KEY" type="password" autocomplete="off" placeholder="Only if your server requires one"></details></fieldset>
<fieldset data-provider="on-device" disabled hidden><div class="note"><strong>Apple Intelligence</strong><p id="appleAvailability">Checking the native model connection…</p>Requires the OpenAGI Mac or iPhone app, macOS 26 or iOS 26, a compatible device, and Apple Intelligence enabled with its model downloaded. Small on-device models have a shorter context and a smaller tool set.</div><p class="hint">No API key or cloud model account is required.</p></fieldset>
<fieldset data-provider="chatgpt" disabled hidden><div class="note">Sign in to connect your eligible ChatGPT plan. Your plan’s usage limits apply.</div><button type="button" id="chatgptSignIn">Sign in with ChatGPT ↗</button><p class="hint" id="signInStatus">Return here after signing in, then check the connection.</p></fieldset>
${!existingEnv.OPENAGI_AUTH_TOKEN ? `<details id="bootstrapAccess" hidden open><summary>Save your dashboard login</summary><p class="hint">Native models and ChatGPT sign-in need a dashboard login before model verification. Copy this token now so you can return even if the connection fails. Keep it private.</p><div class="token-actions"><input type="password" readonly value="${escape(proposedToken)}" aria-label="Dashboard access token"><button type="button" data-copy-token>Copy</button></div></details>` : ''}
<div class="actions"><button class="back" type="button" id="connectBack">← Back</button><button class="primary" type="submit" id="saveBtn">Connect & verify →</button></div><p class="hint">Verification sends one short test message to your selected model.</p></section>
<section data-step="2" hidden><div class="ready-mark" aria-hidden="true">✓</div><h2>Your agent is ready.</h2><p class="subtext" id="verifiedModel"></p><div class="ready-list"><div><strong>Start with one useful result</strong>Tell your agent what you’re working on. It will guide you from there.</div><div><strong>Make it yours over time</strong>Add memory, tools, coding agents, or other devices when you need them.</div></div><details><summary>Save your dashboard access</summary><p class="hint">We auto-generated a strong one for this dashboard. Save this token to sign in from another browser. Keep it private; don’t paste it into chat.</p><div class="token-actions"><input id="tokenView" type="password" readonly value="${escape(proposedToken)}" aria-label="Dashboard access token"><button id="copyToken" data-copy-token type="button">Copy</button></div></details><div class="actions"><button class="back" type="button" id="readyBack">← Change model</button><a class="primary-link" href="/?tab=chat&onboarding=1">Meet your agent →</a></div></section>
<div id="output" role="status" aria-live="polite" hidden></div></form><p class="footnote">Screen access and connected accounts are optional.</p>${existingEnv.OPENAGI_AUTH_TOKEN ? '<p class="footnote"><a href="/">Back to workspace</a> · <a href="/setup?advanced=1">Advanced settings</a></p>' : ''}</div></main>
<script>(${setupClient.toString()})();</script></body></html>`;
}

function setupClient() {
  const form = document.getElementById('form');
  const output = document.getElementById('output');
  const button = document.getElementById('saveBtn');
  let busy = false;
  const provider = () => form.querySelector('input[name="OPENAGI_PROVIDER"]:checked').value;
  const selectedValues = () => Object.fromEntries([...new FormData(form)].filter(([, v]) => v !== ''));
  const show = step => {
    form.querySelectorAll('[data-step]').forEach(el => { el.hidden = Number(el.dataset.step) !== step; });
    document.querySelectorAll('.setup-steps li').forEach((el, i) => {
      if (i === step) el.setAttribute('aria-current', 'step'); else el.removeAttribute('aria-current');
    });
    output.hidden = true;
    form.querySelector('[data-step="' + step + '"] h2').focus({ preventScroll: true });
  };
  const message = (text, error = false) => { output.hidden = false; output.textContent = text; output.className = error ? 'error' : ''; };
  const post = async (path, body) => {
    const res = await fetch(path, { method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok || data.ok === false) throw new Error(data.message || data.error || 'Could not connect. Check your settings and try again.');
    return data;
  };
  const save = async () => {
    const values = selectedValues();
    await post('/setup/save', { ...values, setupModel: true });
    document.cookie = 'openagi_token=' + encodeURIComponent(values.OPENAGI_AUTH_TOKEN) + '; path=/; max-age=2592000; SameSite=Strict';
  };
  const bootstrapAuth = async () => {
    if (form.dataset.hasAuth === 'true') return;
    const token = document.getElementById('tokenInput').value;
    await post('/setup/save', { OPENAGI_AUTH_TOKEN: token });
    document.cookie = 'openagi_token=' + encodeURIComponent(token) + '; path=/; max-age=2592000; SameSite=Strict';
    form.dataset.hasAuth = 'true';
  };
  const configure = async () => {
    const p = provider();
    const access = document.getElementById('bootstrapAccess');
    if (access) access.hidden = !['on-device','chatgpt'].includes(p);
    const names = { anthropic:'Anthropic', openai:'OpenAI', local:'your local model', 'on-device':'Apple Intelligence', chatgpt:'your ChatGPT plan' };
    document.getElementById('connectTitle').textContent = 'Connect ' + names[p];
    form.querySelectorAll('[data-provider]').forEach(el => { el.hidden = el.dataset.provider !== p; el.disabled = el.hidden; });
    show(1);
    if (p === 'on-device') {
      try {
        const r = await fetch('/setup/status'); const s = await r.json();
        const unavailable = { 'not-enabled': 'Enable Apple Intelligence in System Settings, then retry.', downloading: 'Apple Intelligence is downloading its model. Let it finish, then retry.', unsupported: 'This device or OS does not support Apple Intelligence. Choose an API or local model instead.' };
        document.getElementById('appleAvailability').textContent = s.onDevice
          ? 'The native model is connected. Ready to verify.'
          : unavailable[s.availability] || 'No native model connected yet. Open the OpenAGI app on this host and enable Apple Intelligence. Connecting below will retry after saving setup.';
      } catch { document.getElementById('appleAvailability').textContent = 'Could not check availability. Open the native app and try connecting.'; }
    }
  };
  document.getElementById('chooseNext').onclick = configure;
  document.getElementById('connectBack').onclick = () => { if (!busy) show(0); };
  document.getElementById('readyBack').onclick = () => show(0);
  form.querySelectorAll('h2').forEach(el => { el.tabIndex = -1; });
  form.onsubmit = async event => {
    event.preventDefault(); if (busy) return; busy = true; button.disabled = true;
    document.getElementById('connectBack').disabled = true;
    message('Checking the model connection. This can take a moment…');
    try {
      if (['on-device','chatgpt'].includes(provider())) await bootstrapAuth();
      const result = await post('/setup/test', { ...selectedValues(), setupModel: true });
      await save();
      document.getElementById('verifiedModel').textContent = result.model + ' answered successfully. You’re connected.';
      show(2);
    } catch (error) { message(error.message + ' You can edit these settings and retry.', true); }
    finally { busy = false; button.disabled = false; document.getElementById('connectBack').disabled = false; }
  };
  document.getElementById('chatgptSignIn').onclick = async () => {
    const signIn = document.getElementById('chatgptSignIn');
    const popup = window.open('about:blank','_blank');
    try {
      signIn.disabled = true; await bootstrapAuth();
      const auth = await post('/auth/chatgpt/start', {});
      if (!auth.authorizeUrl) throw new Error('Sign-in could not start.');
      if (popup) { popup.opener = null; popup.location.href = auth.authorizeUrl; }
      else {
        const link = document.createElement('a'); link.href = auth.authorizeUrl; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = 'Open ChatGPT sign-in';
        document.getElementById('signInStatus').replaceChildren(link);
      }
    } catch (error) { popup?.close(); message(error.message, true); }
    finally { signIn.disabled = false; }
  };
  form.querySelectorAll('[data-copy-token]').forEach(copy => { copy.onclick = async () => {
    try { await navigator.clipboard.writeText(document.getElementById('tokenInput').value); copy.textContent = 'Copied'; }
    catch { const input = copy.parentElement.querySelector('input'); input.type = 'text'; input.select(); }
  }; });
}
