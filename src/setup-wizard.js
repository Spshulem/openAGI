import path from "node:path";
import fs from "node:fs";
import { ensureDir, writeTextAtomic } from "./file-utils.js";
import { generateToken } from "./auth.js";

// Cross-platform first-run setup wizard. When the daemon detects no API keys
// configured (no ANTHROPIC_API_KEY, no OPENAI_API_KEY) AND no auth token, every
// route except /setup, /setup/save, /setup/test, /health, and webhooks
// redirects to the wizard.

const WIZARD_FIELDS = [
  "OPENAGI_PROVIDER",
  "ANTHROPIC_API_KEY", "ANTHROPIC_MODEL",
  "OPENAI_API_KEY", "OPENAI_MODEL",
  "OPENAGI_AUTH_TOKEN",
  "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM_NUMBER",
  "TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET", "TELEGRAM_POLLING",
  "RIZE_API_KEY",
  "OPENAGI_PUBLIC_URL",
  "OPENAGI_DAILY_USD_LIMIT"
];

export function isFirstRun() {
  // Considered a first run if both:
  //   - no provider API key in env
  //   - no auth token in env
  // (We don't use the .env file directly here because env-loading already
  // happened at boot; the wizard saves to .env so subsequent boots have it.)
  const hasProvider = Boolean(process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY);
  const hasAuth = Boolean(process.env.OPENAGI_AUTH_TOKEN);
  return !hasProvider && !hasAuth;
}

export function envFilePath(dataDir) {
  return path.join(dataDir ?? process.env.OPENAGI_DATA_DIR ?? ".openagi", ".env");
}

export function readExistingEnv(dataDir) {
  const file = envFilePath(dataDir);
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

export function saveEnv({ dataDir, values }) {
  const file = envFilePath(dataDir);
  ensureDir(path.dirname(file));
  const safeKeys = WIZARD_FIELDS.filter((k) => values[k] !== undefined && values[k] !== null && String(values[k]).length > 0);
  const lines = [
    `# Written by OpenAGI setup wizard at ${new Date().toISOString()}`,
    "# Edit by hand or rerun /setup to change values.",
    ""
  ];
  for (const key of safeKeys) {
    const value = String(values[key]).replace(/\n/g, " ").trim();
    lines.push(`${key}=${value}`);
    process.env[key] = value;
  }
  writeTextAtomic(file, `${lines.join("\n")}\n`, 0o600);
  return { written: file, keys: safeKeys };
}

export function renderWizard({ proposedToken } = {}) {
  const token = proposedToken ?? generateToken(32);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>OpenAGI · setup</title>
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body { margin:0; background:#0e1411; color:#e8efea; font:14px/1.45 ui-sans-serif,system-ui,-apple-system,sans-serif; min-height:100vh; }
    .wrap { max-width: 720px; margin: 0 auto; padding: 32px 20px 80px; }
    header { display:flex; align-items:baseline; gap:12px; margin-bottom: 18px; }
    h1 { margin:0; font-size: 22px; letter-spacing: -0.01em; }
    .sub { color:#8da59a; font-size: 13px; }
    .step { background:#161d19; border:1px solid #2a352f; border-radius:10px; padding:18px 20px; margin-bottom:16px; }
    .step h2 { margin:0 0 4px; font-size: 15px; letter-spacing: 0.02em; text-transform: uppercase; color:#6fe1b1; }
    .step h3 { margin: 0 0 10px; font-size: 17px; }
    .step p { color:#8da59a; margin: 4px 0 12px; }
    label { display:block; font-size:12px; color:#8da59a; margin-bottom:4px; }
    input, textarea, select {
      width:100%; padding:9px 12px; background:#0e1411; color:#e8efea;
      border:1px solid #2a352f; border-radius:6px; font:inherit; outline:none;
    }
    input:focus, textarea:focus, select:focus { border-color:#6fe1b1; }
    .row { display:flex; gap:10px; }
    .row > * { flex: 1; }
    .grid { display: grid; gap: 10px; margin-bottom: 12px; }
    .opt { display: flex; align-items: center; gap: 10px; padding: 8px 0; }
    .opt input[type="checkbox"] { width:auto; }
    button {
      background:#6fe1b1; color:#002219; border:0; padding:10px 16px;
      border-radius:8px; font-weight:700; cursor:pointer; font-size: 14px;
    }
    button.secondary { background:#1d2722; color:#e8efea; border:1px solid #2a352f; }
    button:disabled { opacity:0.5; cursor:not-allowed; }
    .actions { display:flex; gap:8px; justify-content: flex-end; margin-top: 12px; }
    .token { font: 13px ui-monospace, Menlo, monospace; padding: 10px; background: #0e1411; border:1px solid #2a352f; border-radius: 6px; word-break: break-all; }
    .pill { display:inline-block; padding:2px 8px; border-radius:999px; background:#14322a; color:#6fe1b1; font-size:11px; font-weight:700; margin-left:8px; vertical-align:middle; }
    .out { white-space: pre-wrap; word-break: break-word; font: 12px ui-monospace, Menlo, monospace; color:#e8efea; padding:10px; background:#0e1411; border:1px solid #2a352f; border-radius:6px; max-height: 240px; overflow:auto; }
    .ok { color:#6fe1b1; }
    .err { color:#f08080; }
    details > summary { cursor:pointer; color:#8da59a; padding:4px 0; }
  </style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>OpenAGI</h1>
    <span class="sub">first-run setup</span>
  </header>

  <form id="form">
    <div class="step">
      <h2>1 / 6</h2>
      <h3>Welcome</h3>
      <p>OpenAGI is an always-on local agent: chat, scheduled prompts, MCP tools, SMS/Telegram channels.<br>
      Everything runs on this machine. State stays in <code>${escapeHtml(envFilePath().replace(/\\/g, "/"))}</code>.</p>
      <p>This wizard takes ~2 minutes. You can change anything later by re-running <code>/setup</code>.</p>
    </div>

    <div class="step">
      <h2>2 / 6 · model</h2>
      <h3>Pick a primary provider</h3>
      <p>You can supply both — but pick which one drives chat and tool calls. Switch later from the dashboard.</p>
      <div class="grid">
        <label class="opt"><input type="radio" name="OPENAGI_PROVIDER" value="auto" checked> Auto · use whichever has a key (Anthropic preferred)</label>
        <label class="opt"><input type="radio" name="OPENAGI_PROVIDER" value="anthropic"> Anthropic · Claude Sonnet 4.6</label>
        <label class="opt"><input type="radio" name="OPENAGI_PROVIDER" value="openai"> OpenAI · ChatGPT (GPT-5)</label>
      </div>

      <h3 style="margin-top:14px;">Anthropic key</h3>
      <p>Get one at <a href="https://console.anthropic.com/" target="_blank" rel="noopener">console.anthropic.com</a>.</p>
      <label>ANTHROPIC_API_KEY</label>
      <input type="password" name="ANTHROPIC_API_KEY" placeholder="sk-ant-…" autocomplete="off">
      <label style="margin-top:8px;">Model</label>
      <input type="text" name="ANTHROPIC_MODEL" value="claude-sonnet-4-6">

      <h3 style="margin-top:14px;">OpenAI / ChatGPT key</h3>
      <p>Get one at <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener">platform.openai.com</a>. Works with Zero Data Retention orgs.</p>
      <label>OPENAI_API_KEY</label>
      <input type="password" name="OPENAI_API_KEY" placeholder="sk-proj-…" autocomplete="off">
      <label style="margin-top:8px;">Model</label>
      <input type="text" name="OPENAI_MODEL" value="gpt-5">
    </div>

    <div class="step">
      <h2>3 / 6 · auth</h2>
      <h3>Bearer token</h3>
      <p>This is the password for your dashboard. Save it now — you'll need it to log in. We auto-generated a strong one for you, or paste your own.</p>
      <div class="token" id="tokenView">${escapeHtml(token)}</div>
      <input type="hidden" name="OPENAGI_AUTH_TOKEN" id="tokenInput" value="${escapeHtml(token)}">
      <div class="actions">
        <button type="button" class="secondary" id="copyToken">Copy</button>
        <button type="button" class="secondary" id="regenToken">Regenerate</button>
      </div>
    </div>

    <div class="step">
      <h2>4 / 6 · channels</h2>
      <h3>Where can the agent reach you? <span class="sub">all optional</span></h3>

      <details>
        <summary>Twilio SMS — text the agent and get texts back</summary>
        <div style="padding-top:10px;" class="grid">
          <div><label>TWILIO_ACCOUNT_SID</label><input type="text" name="TWILIO_ACCOUNT_SID" placeholder="AC..."></div>
          <div><label>TWILIO_AUTH_TOKEN</label><input type="password" name="TWILIO_AUTH_TOKEN" autocomplete="off"></div>
          <div><label>TWILIO_FROM_NUMBER</label><input type="text" name="TWILIO_FROM_NUMBER" placeholder="+15551234567"></div>
        </div>
      </details>

      <details style="margin-top:8px;">
        <summary>Telegram — bot from @BotFather</summary>
        <div style="padding-top:10px;" class="grid">
          <div><label>TELEGRAM_BOT_TOKEN</label><input type="password" name="TELEGRAM_BOT_TOKEN" autocomplete="off"></div>
          <div><label>TELEGRAM_WEBHOOK_SECRET (any random string)</label><input type="text" name="TELEGRAM_WEBHOOK_SECRET"></div>
          <div class="opt"><input type="checkbox" id="tgPoll" name="TELEGRAM_POLLING" value="1"><label for="tgPoll" style="margin:0;">Long-poll instead of webhook (works without a tunnel)</label></div>
        </div>
      </details>

      <details style="margin-top:8px;">
        <summary>Rize.io — pull what you worked on today</summary>
        <div style="padding-top:10px;">
          <label>RIZE_API_KEY</label>
          <input type="password" name="RIZE_API_KEY" autocomplete="off">
        </div>
      </details>
    </div>

    <div class="step">
      <h2>5 / 6 · public access</h2>
      <h3>Tunnel <span class="sub">required for SMS/Telegram webhooks</span></h3>
      <p>If you want Twilio or Telegram webhooks to reach this machine, expose it via a tunnel. <code>cloudflared</code> on macOS: <code>brew install cloudflared</code>; on Linux: <a href="https://pkg.cloudflare.com/index.html" target="_blank" rel="noopener">pkg.cloudflare.com</a>.</p>
      <p>Then run <code>npm run tunnel</code> in another terminal and paste the URL it prints below.</p>
      <label>OPENAGI_PUBLIC_URL <span class="sub">leave blank to skip</span></label>
      <input type="text" name="OPENAGI_PUBLIC_URL" placeholder="https://abcd.trycloudflare.com">
    </div>

    <div class="step">
      <h2>6 / 6 · spending</h2>
      <h3>Daily budget</h3>
      <p>Hard ceiling on LLM spend per day. Provider calls throw <code>BUDGET_EXCEEDED</code> past this. Default $10/day.</p>
      <label>OPENAGI_DAILY_USD_LIMIT</label>
      <input type="number" name="OPENAGI_DAILY_USD_LIMIT" value="10" min="0.5" step="0.5">
    </div>

    <div class="step">
      <h3>Save and test</h3>
      <p>This writes your settings to <code>${escapeHtml(envFilePath().replace(/\\/g, "/"))}</code>, sets the auth cookie in this browser, and sends a "hi" through the agent to confirm it works.</p>
      <div class="actions">
        <button type="submit" id="saveBtn">Save and continue</button>
      </div>
      <div id="output" class="out" style="display:none;margin-top:12px;"></div>
    </div>
  </form>
</div>
<script>
  function refreshToken() {
    const len = 32;
    const arr = new Uint8Array(len);
    crypto.getRandomValues(arr);
    const b64 = btoa(String.fromCharCode(...arr)).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
    document.getElementById("tokenView").textContent = b64;
    document.getElementById("tokenInput").value = b64;
  }
  document.getElementById("regenToken").addEventListener("click", refreshToken);
  document.getElementById("copyToken").addEventListener("click", async () => {
    await navigator.clipboard.writeText(document.getElementById("tokenInput").value);
    const btn = document.getElementById("copyToken");
    const orig = btn.textContent;
    btn.textContent = "✓ copied"; setTimeout(() => btn.textContent = orig, 1500);
  });

  document.getElementById("form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const obj = {};
    for (const [k, v] of fd.entries()) if (v !== "") obj[k] = v;

    const out = document.getElementById("output");
    out.style.display = "block";
    out.textContent = "Saving…";
    const btn = document.getElementById("saveBtn");
    btn.disabled = true;

    try {
      const saveRes = await fetch("/setup/save", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(obj) });
      const saveBody = await saveRes.json();
      if (!saveRes.ok) throw new Error(saveBody.error ?? "save failed");
      out.innerHTML = '<span class="ok">Saved.</span> Now testing the agent…';

      // Set the auth cookie so subsequent requests work in this browser.
      document.cookie = "openagi_token=" + encodeURIComponent(obj.OPENAGI_AUTH_TOKEN) + "; path=/; max-age=2592000; SameSite=Strict";

      const testRes = await fetch("/setup/test", {
        method: "POST",
        headers: { "content-type": "application/json", "authorization": "Bearer " + obj.OPENAGI_AUTH_TOKEN },
        body: JSON.stringify({ text: "Say hi in one short sentence." })
      });
      const testBody = await testRes.json();
      if (!testRes.ok) throw new Error(testBody.error ?? "test failed");

      out.innerHTML = '<span class="ok">✓ Agent reply:</span>\\n\\n' + (testBody.reply ?? "(empty)") + '\\n\\n<span class="ok">Setup complete. Loading dashboard…</span>';
      setTimeout(() => { window.location.href = "/"; }, 1500);
    } catch (err) {
      out.innerHTML = '<span class="err">Error:</span> ' + (err.message ?? err);
      btn.disabled = false;
    }
  });
</script>
</body></html>`;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]);
}

export const SETUP_FIELDS = WIZARD_FIELDS;
