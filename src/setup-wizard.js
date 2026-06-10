import path from "node:path";
import fs from "node:fs";
import { ensureDir, writeTextAtomic } from "./file-utils.js";
import { generateToken } from "./auth.js";
import { MCP_CATALOG, CATEGORIES } from "./mcp-catalog.js";
import { resolveDataDir } from "./data-dir.js";

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
  "CALENDAR_ICS_URL",
  "LINEAR_API_KEY",
  "BUILDBETTER_API_KEY", "BUILDBETTER_USER_EMAIL", "BUILDBETTER_USER_NAME", "BUILDBETTER_WEBHOOK_SECRET",
  "IMESSAGE_ENABLED", "IMESSAGE_SELF_HANDLE", "IMESSAGE_INTERVAL_MS", "IMESSAGE_MODE", "IMESSAGE_BACKFILL_DAYS",
  "OPENAGI_COMPUTER_USE",
  "OPENAGI_PUBLIC_URL",
  "OPENAGI_DAILY_USD_LIMIT",
  "EXA_API_KEY", "TAVILY_API_KEY", "FIRECRAWL_API_KEY", "BRAVE_API_KEY",
  "PERPLEXITY_API_KEY", "SERPAPI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_CSE_ID",
  "WEB_SEARCH_PROVIDER",
  "BUILDBETTER_INGEST_MODE",
  // Per-MCP bearer keys, declared by catalog entries via apiKeyEnvVar.
  // Kept in this allowlist so the wizard's /setup/save can write them.
  ...MCP_CATALOG.filter((e) => e.apiKeyEnvVar).map((e) => e.apiKeyEnvVar)
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
  return path.join(dataDir ?? resolveDataDir(), ".env");
}

export function readExistingEnv(dataDir) {
  const file = envFilePath(dataDir);
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

export function saveEnv({ dataDir, values, clear = [] }) {
  const file = envFilePath(dataDir);
  ensureDir(path.dirname(file));

  // Merge: read existing env (if any), overlay the new values, write back.
  // Only allow-listed keys can be set this way. Other keys already in the
  // file are preserved verbatim (including comments / unknown vars from
  // hand-edits). Empty-string values are SKIPPED (wizard's blank-field =
  // "don't change") — use the `clear` list to remove a key explicitly.
  const existing = parseEnvText(readExistingEnv(dataDir));
  const incoming = {};
  for (const key of WIZARD_FIELDS) {
    if (values[key] === undefined || values[key] === null) continue;
    const v = String(values[key]).replace(/\n/g, " ").trim();
    if (v.length === 0) continue;
    incoming[key] = v;
    process.env[key] = v;
  }

  const merged = { ...existing, ...incoming };
  for (const key of clear) {
    if (!WIZARD_FIELDS.includes(key)) continue; // still allowlisted
    delete merged[key];
    delete process.env[key];
  }
  const lines = [
    `# Written by OpenAGI setup wizard at ${new Date().toISOString()}`,
    "# Edit by hand or rerun /setup to change values.",
    ""
  ];
  for (const [k, v] of Object.entries(merged)) {
    lines.push(`${k}=${v}`);
  }
  writeTextAtomic(file, `${lines.join("\n")}\n`, 0o600);
  return { written: file, keys: Object.keys(incoming), totalKeys: Object.keys(merged).length };
}

function parseEnvText(text) {
  const out = {};
  if (!text) return out;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    out[key] = value;
  }
  return out;
}

export function renderWizard({ proposedToken, existingEnv = {} } = {}) {
  // Re-running /setup must NOT rotate the auth token: every save used to
  // overwrite OPENAGI_AUTH_TOKEN with a fresh value because the hidden field
  // always submitted. Keep the existing token when there is one.
  const token = proposedToken ?? existingEnv.OPENAGI_AUTH_TOKEN ?? generateToken(32);
  const hasExistingToken = Boolean(existingEnv.OPENAGI_AUTH_TOKEN);
  const val = (key, fallback = "") => escapeHtml(existingEnv[key] ?? fallback);
  // "✓ saved" marker for secret fields that already have a value — blank
  // means "keep what's saved", so the user can see what's configured
  // without us echoing the secret back into the page.
  const saved = (key) => (existingEnv[key] ? ' <span class="pill">✓ saved — blank keeps it</span>' : "");
  const providerChecked = (p) => ((existingEnv.OPENAGI_PROVIDER ?? "auto") === p ? "checked" : "");
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
    .wrap { max-width: 720px; margin: 0 auto; padding: 0 20px 80px; }
    /* Sticky progress bar — keeps a sense of how far through 8 steps the
       user is even when they scroll deep into a long step (esp. step 6
       MCPs which is the densest). */
    .progress-shell { position: sticky; top: 0; background:#0e1411; z-index: 10; padding: 24px 0 12px; }
    .progress-shell header { display:flex; align-items:baseline; gap:12px; margin: 0 0 12px; }
    .progress-bar { height: 4px; background:#1d2722; border-radius: 999px; overflow: hidden; }
    .progress-fill { height: 100%; background:#6fe1b1; width: 12.5%; transition: width .25s ease; }
    .progress-label { display:flex; justify-content: space-between; font-size: 11px; color:#8da59a; margin-top: 6px; }
    h1 { margin:0; font-size: 22px; letter-spacing: -0.01em; }
    .sub { color:#8da59a; font-size: 13px; }
    .step { background:#161d19; border:1px solid #2a352f; border-radius:10px; padding:18px 20px; margin-bottom:16px; scroll-margin-top: 80px; }
    .step.active { border-color:#3d5b4d; box-shadow: 0 0 0 1px rgba(111,225,177,0.10); }
    .step h2 { margin:0 0 4px; font-size: 12px; letter-spacing: 0.06em; text-transform: uppercase; color:#6fe1b1; font-weight: 700; }
    .step h3 { margin: 0 0 10px; font-size: 17px; }
    .step p { color:#8da59a; margin: 4px 0 12px; }
    label { display:block; font-size:12px; color:#8da59a; margin-bottom:4px; }
    input, textarea, select {
      width:100%; padding:9px 12px; background:#0e1411; color:#e8efea;
      border:1px solid #2a352f; border-radius:6px; font:inherit; outline:none;
    }
    input[type="radio"], input[type="checkbox"] {
      width: auto; padding: 0; margin: 0; flex: 0 0 auto;
    }
    input:focus, textarea:focus, select:focus { border-color:#6fe1b1; }
    .row { display:flex; gap:10px; }
    .row > * { flex: 1; }
    .grid { display: grid; gap: 6px; margin-bottom: 12px; }
    .mcp-grid { grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 8px; }
    .opt {
      display: flex; align-items: center; gap: 10px; padding: 8px 10px;
      border: 1px solid #2a352f; border-radius: 6px; cursor: pointer;
      background: #0e1411;
    }
    .opt:hover { border-color: #3a4a42; }
    .opt:has(input:checked) { border-color: #6fe1b1; background: #14322a; }
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
  <div class="progress-shell">
    <header>
      <h1>OpenAGI</h1>
      <span class="sub">first-run setup</span>
    </header>
    <div class="progress-bar"><div class="progress-fill" id="progressFill"></div></div>
    <div class="progress-label"><span id="progressStep">Step 1 of 8</span><span id="progressName">welcome</span></div>
  </div>

  <form id="form">
    <div class="step">
      <h2>1 / 8</h2>
      <h3>Welcome</h3>
      <p>OpenAGI is an always-on local agent: chat, scheduled prompts, MCP tools, SMS/Telegram channels, automatic task tracking from your calls/issues/notes.<br>
      Everything runs on this machine. State stays in <code>${escapeHtml(envFilePath().replace(/\\/g, "/"))}</code>.</p>
      <p>This wizard takes ~3 minutes. You can change anything later by re-running <code>/setup</code> or via the <code>Integrations</code> tab.</p>
    </div>

    <div class="step">
      <h2>2 / 8 · model</h2>
      <h3>Pick a primary provider</h3>
      <p>You can supply both — but pick which one drives chat and tool calls. Switch later from the dashboard.</p>
      <div class="grid">
        <label class="opt"><input type="radio" name="OPENAGI_PROVIDER" value="auto" ${providerChecked("auto")}> Auto · use whichever has a key (Anthropic preferred)</label>
        <label class="opt"><input type="radio" name="OPENAGI_PROVIDER" value="anthropic" ${providerChecked("anthropic")}> Anthropic · Claude Sonnet 4.6</label>
        <label class="opt"><input type="radio" name="OPENAGI_PROVIDER" value="openai" ${providerChecked("openai")}> OpenAI · ChatGPT (GPT-5)</label>
      </div>

      <h3 style="margin-top:14px;">Anthropic key</h3>
      <p>Get one at <a href="https://console.anthropic.com/" target="_blank" rel="noopener">console.anthropic.com</a>.</p>
      <label>ANTHROPIC_API_KEY${saved("ANTHROPIC_API_KEY")}</label>
      <input type="password" name="ANTHROPIC_API_KEY" placeholder="sk-ant-…" autocomplete="off">
      <label style="margin-top:8px;">Model</label>
      <input type="text" name="ANTHROPIC_MODEL" value="${val("ANTHROPIC_MODEL", "claude-sonnet-4-6")}">

      <h3 style="margin-top:14px;">OpenAI / ChatGPT key</h3>
      <p>Get one at <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener">platform.openai.com</a>. Works with Zero Data Retention orgs.</p>
      <label>OPENAI_API_KEY${saved("OPENAI_API_KEY")}</label>
      <input type="password" name="OPENAI_API_KEY" placeholder="sk-proj-…" autocomplete="off">
      <label style="margin-top:8px;">Model</label>
      <input type="text" name="OPENAI_MODEL" value="${val("OPENAI_MODEL", "gpt-5")}">
    </div>

    <div class="step">
      <h2>3 / 8 · auth</h2>
      <h3>Bearer token</h3>
      <p>${hasExistingToken
        ? "This is your <strong>existing</strong> dashboard token — saving keeps it unchanged. Regenerate only if you want to rotate it (other signed-in browsers will need the new one)."
        : "This is the password for your dashboard. Save it now — you'll need it to log in. We auto-generated a strong one for you, or paste your own."}</p>
      <div class="token" id="tokenView">${escapeHtml(token)}</div>
      <input type="hidden" name="OPENAGI_AUTH_TOKEN" id="tokenInput" value="${escapeHtml(token)}">
      <div class="actions">
        <button type="button" class="secondary" id="copyToken">Copy</button>
        <button type="button" class="secondary" id="regenToken">Regenerate</button>
      </div>
      <div style="margin-top:14px; padding-top:12px; border-top:1px solid #2a352f;">
        <p class="sub" style="margin-bottom:8px;">That's the minimum viable setup — a model key + this token. Everything below (channels, sources, MCPs, tunnel, budget) can wait.</p>
        <button type="submit" class="secondary">Save now — set up the rest later</button>
      </div>
    </div>

    <div class="step">
      <h2>4 / 8 · channels</h2>
      <h3>Where can the agent reach you? <span class="sub">all optional</span></h3>
      <p class="sub">Channels are how messages get to/from you. (Data sources — where tasks come from — live in step 5.)</p>

      <details>
        <summary>Twilio SMS — text the agent and get texts back</summary>
        <div style="padding-top:10px;" class="grid">
          <div><label>TWILIO_ACCOUNT_SID${saved("TWILIO_ACCOUNT_SID")}</label><input type="text" name="TWILIO_ACCOUNT_SID" placeholder="AC..."></div>
          <div><label>TWILIO_AUTH_TOKEN${saved("TWILIO_AUTH_TOKEN")}</label><input type="password" name="TWILIO_AUTH_TOKEN" autocomplete="off"></div>
          <div><label>TWILIO_FROM_NUMBER${saved("TWILIO_FROM_NUMBER")}</label><input type="text" name="TWILIO_FROM_NUMBER" placeholder="+15551234567"></div>
        </div>
      </details>

      <details style="margin-top:8px;">
        <summary>Telegram — bot from @BotFather</summary>
        <div style="padding-top:10px;" class="grid">
          <div><label>TELEGRAM_BOT_TOKEN${saved("TELEGRAM_BOT_TOKEN")}</label><input type="password" name="TELEGRAM_BOT_TOKEN" autocomplete="off"></div>
          <div><label>TELEGRAM_WEBHOOK_SECRET (any random string)</label><input type="text" name="TELEGRAM_WEBHOOK_SECRET"></div>
          <div class="opt"><input type="checkbox" id="tgPoll" name="TELEGRAM_POLLING" value="1"><label for="tgPoll" style="margin:0;">Long-poll instead of webhook (works without a tunnel)</label></div>
        </div>
      </details>
    </div>

    <div class="step">
      <h2>5 / 8 · sources</h2>
      <h3>Where do tasks + activity come from? <span class="sub">all optional</span></h3>
      <p class="sub">Sources feed the task system + activity log. The agent uses these to know what's on your plate. You can edit any of these later from <code>Integrations</code> in the dashboard.</p>

      <details>
        <summary>Linear — assigned issues become tasks</summary>
        <div style="padding-top:10px;">
          <p class="sub">Get a personal API key at <a href="https://linear.app/settings/api" target="_blank" rel="noopener">linear.app/settings/api</a>. Polls every 5 min.</p>
          <label>LINEAR_API_KEY${saved("LINEAR_API_KEY")}</label>
          <input type="password" name="LINEAR_API_KEY" placeholder="lin_api_…" autocomplete="off">
        </div>
      </details>

      <details style="margin-top:8px;">
        <summary>BuildBetter — call action items become tasks</summary>
        <div style="padding-top:10px;" class="grid">
          <p class="sub">Pulls action_item / commitment / follow_up extractions from your recent calls. Polls every 15 min, and (optionally) syncs instantly via webhook.</p>
          <p class="sub">Already connected BuildBetter on the <code>MCP</code> tab? You can leave everything below blank — OpenAGI reuses that login.</p>
          <div><label>BUILDBETTER_API_KEY <span class="sub">(optional if connected via MCP)</span>${saved("BUILDBETTER_API_KEY")}</label><input type="password" name="BUILDBETTER_API_KEY" autocomplete="off"></div>
          <div><label>BUILDBETTER_USER_EMAIL <span class="sub">(optional — auto-detected from your login)</span></label><input type="email" name="BUILDBETTER_USER_EMAIL" placeholder="you@example.com" value="${val("BUILDBETTER_USER_EMAIL")}"></div>
          <div><label>BUILDBETTER_USER_NAME <span class="sub">(optional — only needed if auto-detect can't pinpoint you)</span></label><input type="text" name="BUILDBETTER_USER_NAME" placeholder="Your Name" value="${val("BUILDBETTER_USER_NAME")}"></div>
          <div><label>BUILDBETTER_WEBHOOK_SECRET <span class="sub">(optional — enables instant push)</span>${saved("BUILDBETTER_WEBHOOK_SECRET")}</label><input type="password" name="BUILDBETTER_WEBHOOK_SECRET" autocomplete="off" placeholder="a long random string"><p class="sub">Set this, then point a BuildBetter webhook at <code>&lt;your public URL&gt;/webhooks/buildbetter?secret=…</code> (shown on the Channels tab once a public URL is set) to sync the moment a call is processed instead of waiting for the poll.</p></div>
        </div>
      </details>

      <details style="margin-top:8px;">
        <summary>Rize.io — what you worked on today</summary>
        <div style="padding-top:10px;">
          <p class="sub">Activity tracking surfaces "what did I work on today?" via the <code>rize_*</code> agent tools. Get a key at <a href="https://my.rize.io/settings/api" target="_blank" rel="noopener">my.rize.io/settings/api</a>.</p>
          <label>RIZE_API_KEY${saved("RIZE_API_KEY")}</label>
          <input type="password" name="RIZE_API_KEY" autocomplete="off">
        </div>
      </details>

      <details>
        <summary>Calendar — did the meeting happen?</summary>
        <div style="padding-top:10px;">
          <p class="sub">Paste your calendar's <strong>secret iCal/ICS URL</strong> (Google: Settings → your calendar → "Secret address in iCal format"; Outlook/Apple have an equivalent). Used to reconcile whether scheduled meetings occurred and to plan your day. Comma-separate multiple calendars. No OAuth required.</p>
          <label>CALENDAR_ICS_URL${saved("CALENDAR_ICS_URL")}</label>
          <input type="password" name="CALENDAR_ICS_URL" autocomplete="off" placeholder="https://calendar.google.com/calendar/ical/.../basic.ics">
        </div>
      </details>

      <details style="margin-top:8px;">
        <summary>Inbox folder — drop files for tasks <span class="sub">no setup needed</span></summary>
        <div style="padding-top:10px;">
          <p class="sub">Always-on. Drop any <code>.md</code> or <code>.txt</code> file into <code>~/Library/Application Support/OpenAGI/inbox/</code> and OpenAGI parses GitHub-style checkboxes (<code>- [ ] foo</code>) and <code>TODO:</code> / <code>TASK:</code> / <code>REMINDER:</code> prefixes into tasks. Sweeps every 30 seconds. Works for reMarkable (point your Dropbox sync at the inbox folder), Obsidian, Bear, scanned paper notes.</p>
        </div>
      </details>

      <details style="margin-top:8px;">
        <summary>iMessage — text yourself as an inbox <span class="sub">macOS only · opt-in · needs Full Disk Access</span></summary>
        <div style="padding-top:10px;">
          <p class="sub"><strong>What this does:</strong> reads the local iMessage SQLite database at <code>~/Library/Messages/chat.db</code> (read-only) and turns texts you send to yourself into tasks. Convenient for capturing thoughts from your phone or watch. Sweeps every 60s.</p>
          <p class="sub"><strong>Privacy:</strong> only messages from your declared self-handle in chats with no one else are imported. Group chats, threads with other contacts, and incoming messages from anyone but you are skipped — they're never read. State stays on your machine.</p>
          <p class="sub"><strong>Permission required:</strong> macOS gates <code>chat.db</code> behind Full Disk Access. After saving this wizard, open <strong>System Settings → Privacy &amp; Security → Full Disk Access</strong> and toggle on <strong>OpenAGI</strong>. The dashboard's Integrations tab will tell you when it's working.</p>
          <p class="sub"><strong>History:</strong> by default, only messages sent <em>after</em> you enable this are imported — your existing iMessage history is left alone. Set <code>IMESSAGE_BACKFILL_DAYS</code> below to seed the last N days as a one-time catch-up (e.g. <code>7</code> for the past week).</p>
          <div class="opt" style="margin-top:8px;">
            <input type="checkbox" id="imEnabled" name="IMESSAGE_ENABLED" value="1">
            <label for="imEnabled" style="margin:0;">Enable iMessage sync</label>
          </div>
          <label style="margin-top:8px;">IMESSAGE_SELF_HANDLE <span class="sub">— your iCloud email or phone (e.g. <code>+14155551234</code> or <code>you@icloud.com</code>); the address you text yourself <em>to</em></span></label>
          <input type="text" name="IMESSAGE_SELF_HANDLE" placeholder="+14155551234 or you@icloud.com">
          <label style="margin-top:8px;">IMESSAGE_BACKFILL_DAYS <span class="sub">— optional; leave blank for forward-only. Set to e.g. <code>7</code> to also seed the last week's self-texts</span></label>
          <input type="number" name="IMESSAGE_BACKFILL_DAYS" placeholder="0" min="0" max="365">
        </div>
      </details>
    </div>

    <div class="step">
      <h2>6 / 8 · MCPs <span class="sub">optional, but easy to add later</span></h2>
      <h3>Connect tools the agent can use</h3>
      <p class="sub">MCP servers give the agent extra tools (read your Linear issues, search Stripe customers, query PostHog, etc). Check the ones you want and we'll register them when you save. OAuth handshakes will run once you visit the dashboard.</p>
      ${renderMcpCatalogStep()}
    </div>

    <div class="step">
      <h2>7 / 8 · public access</h2>
      <h3>Tunnel <span class="sub">required for SMS/Telegram webhooks</span></h3>
      <p>If you want Twilio or Telegram webhooks to reach this machine, expose it via a tunnel. <code>cloudflared</code> on macOS: <code>brew install cloudflared</code>; on Linux: <a href="https://pkg.cloudflare.com/index.html" target="_blank" rel="noopener">pkg.cloudflare.com</a>.</p>
      <p>Then run <code>npm run tunnel</code> in another terminal and paste the URL it prints below.</p>
      <label>OPENAGI_PUBLIC_URL <span class="sub">leave blank to skip</span></label>
      <input type="text" name="OPENAGI_PUBLIC_URL" placeholder="https://abcd.trycloudflare.com" value="${val("OPENAGI_PUBLIC_URL")}">
    </div>

    <div class="step">
      <h2>8 / 8 · spending</h2>
      <h3>Daily budget</h3>
      <p>Hard ceiling on LLM spend per day. Provider calls throw <code>BUDGET_EXCEEDED</code> past this. Default $10/day.</p>
      <label>OPENAGI_DAILY_USD_LIMIT</label>
      <input type="number" name="OPENAGI_DAILY_USD_LIMIT" value="${val("OPENAGI_DAILY_USD_LIMIT", "10")}" min="0.5" step="0.5">
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
  // Walk each .step div, observe which is the topmost one in view, update
  // the sticky progress bar. Uses IntersectionObserver so it costs nothing
  // when the user isn't scrolling. We add .active to the visible step
  // for a subtle border highlight so the step you're filling in feels
  // distinct from the ones you've passed.
  (function initProgress() {
    const steps = Array.from(document.querySelectorAll('.step'));
    if (steps.length === 0) return;
    const fill = document.getElementById('progressFill');
    const stepLabel = document.getElementById('progressStep');
    const nameLabel = document.getElementById('progressName');
    const total = steps.length;
    function setActive(idx) {
      const clamped = Math.max(0, Math.min(total - 1, idx));
      steps.forEach((el, i) => el.classList.toggle('active', i === clamped));
      fill.style.width = (((clamped + 1) / total) * 100).toFixed(2) + '%';
      stepLabel.textContent = 'Step ' + (clamped + 1) + ' of ' + total;
      // Pull a friendly name out of the step's h2 ("2 / 8 · model" → "model").
      const h2 = steps[clamped].querySelector('h2');
      const parts = (h2?.textContent ?? '').split('·');
      nameLabel.textContent = (parts[1] ?? parts[0] ?? '').trim().toLowerCase();
    }
    const visible = new Map();
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) visible.set(e.target, e.intersectionRatio);
        else visible.delete(e.target);
      }
      if (visible.size === 0) return;
      // Topmost visible step wins.
      let best = null; let bestY = Infinity;
      for (const [el] of visible) {
        const y = el.getBoundingClientRect().top;
        if (y >= 0 && y < bestY) { bestY = y; best = el; }
      }
      if (best) setActive(steps.indexOf(best));
    }, { rootMargin: '-80px 0px -50% 0px', threshold: [0, 0.1, 0.5, 1] });
    steps.forEach((s) => io.observe(s));
    setActive(0);
  })();

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

  // Reveal the inline API-key input when its parent MCP checkbox is ticked.
  document.querySelectorAll('input[data-mcp-toggle]').forEach((cb) => {
    const id = cb.dataset.mcpToggle;
    const field = document.querySelector('.mcp-key-field[data-for="' + CSS.escape(id) + '"]');
    if (!field) return;
    cb.addEventListener("change", () => {
      field.style.display = cb.checked ? "" : "none";
    });
  });

  document.getElementById("form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const obj = {};
    for (const [k, v] of fd.entries()) if (v !== "") obj[k] = v;

    const out = document.getElementById("output");
    out.style.display = "block";
    out.textContent = "Saving…";
    out.scrollIntoView({ behavior: "smooth", block: "center" });
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

      // Register every MCP the user checked. OAuth-shaped ones will surface
      // their auth URLs on /?tab=mcp and /?tab=integrations once we land.
      // Parallel by Promise.all — order doesn't matter and serial would
      // add a noticeable delay when 6+ entries are checked.
      const checkedMcps = Array.from(document.querySelectorAll('input[name^="mcp_"]:checked'))
        .map((el) => el.name.replace(/^mcp_/, ""));
      const mcpResults = await Promise.all(checkedMcps.map(async (catalogId) => {
        try {
          const r = await fetch("/integrations/connect-mcp", {
            method: "POST",
            headers: { "content-type": "application/json", "authorization": "Bearer " + obj.OPENAGI_AUTH_TOKEN },
            body: JSON.stringify({ catalogId })
          });
          const rb = await r.json();
          return { catalogId, ok: r.ok, name: rb.name, error: rb.error };
        } catch (err) {
          return { catalogId, ok: false, error: err.message };
        }
      }));
      const mcpSummary = mcpResults.length === 0 ? "" :
        '\\n\\n<span class="ok">MCPs registered:</span> ' +
        mcpResults.filter((r) => r.ok).map((r) => r.name ?? r.catalogId).join(", ") +
        (mcpResults.some((r) => !r.ok) ? '\\n<span class="err">Failed:</span> ' + mcpResults.filter((r) => !r.ok).map((r) => r.catalogId + " (" + r.error + ")").join(", ") : "");
      const target = checkedMcps.length > 0 ? "/?tab=integrations" : "/";

      // Bounce the daemon so existing integrations (Linear/BuildBetter/Twilio
      // etc) re-read their .env values. The Mac app's DaemonController auto-
      // respawns. For bare-metal users running 'npm run serve', they'll need
      // to relaunch — we surface a fallback message after a generous timeout.
      out.innerHTML = '<span class="ok">✓ Agent reply:</span>\\n\\n' + (testBody.reply ?? "(empty)") + mcpSummary + '\\n\\n<span class="ok">Restarting daemon to apply new settings…</span>';
      try {
        await fetch("/control/restart", {
          method: "POST",
          headers: { "content-type": "application/json", "authorization": "Bearer " + obj.OPENAGI_AUTH_TOKEN },
          body: "{}"
        });
      } catch { /* the daemon exits before flushing — expected */ }

      // Poll /health until the new process answers, then redirect. Fall
      // back to a manual link after 30s so the user isn't stuck.
      const deadline = Date.now() + 30000;
      let backUp = false;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 500));
        try {
          const h = await fetch("/health", { cache: "no-store" });
          if (h.ok) { backUp = true; break; }
        } catch { /* still down, keep polling */ }
      }
      if (backUp) {
        out.innerHTML += '\\n<span class="ok">✓ Daemon back up. Loading dashboard…</span>';
        setTimeout(() => { window.location.href = target; }, 600);
      } else {
        out.innerHTML += '\\n<span class="err">Daemon didn\\'t come back automatically.</span> Open it from the menu bar (or relaunch your terminal serve), then <a href="' + target + '">continue to dashboard</a>.';
      }
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

// Renders the MCP catalog as a checkbox grid, grouped by category.
// "available" entries get a checkbox; "coming-soon" entries are listed
// so the user knows they're on the roadmap, but disabled.
function renderMcpCatalogStep() {
  return CATEGORIES.map((cat) => {
    const inCat = MCP_CATALOG.filter((e) => e.category === cat.id);
    if (inCat.length === 0) return "";
    return `
      <div style="margin-top:14px;">
        <h3 style="font-size:11px; text-transform:uppercase; letter-spacing:0.5px; color:#8da59a; margin-bottom:8px;">${escapeHtml(cat.name)}</h3>
        <div class="grid mcp-grid">
          ${inCat.map((entry) => renderMcpCard(entry)).join("")}
        </div>
      </div>
    `;
  }).join("");
}

function renderMcpCard(entry) {
  const connectable = entry.status === "available" && Boolean(entry.register);
  const checkboxId = `mcp_${entry.id}`;
  if (connectable) {
    const isOauth = entry.authType === "oauth";
    const authPill = isOauth ? "OAuth" : "API key";
    // For bearer-auth entries we need an inline password field. Hide it
    // unless the parent checkbox is checked (no point asking for a key
    // the user hasn't opted into).
    const keyField = entry.apiKeyEnvVar
      ? `
        <div class="mcp-key-field" data-for="${escapeHtml(checkboxId)}" style="display:none; padding-left:24px; width:100%;">
          <label style="font-size:11px; color:#8da59a; margin-bottom:3px;">${escapeHtml(entry.apiKeyEnvVar)}${entry.apiKeyHelp ? ` <span class="sub">— ${escapeHtml(entry.apiKeyHelp)}</span>` : ""}</label>
          <input type="password" name="${escapeHtml(entry.apiKeyEnvVar)}" autocomplete="off" placeholder="paste your key" style="font-size:12px; padding:6px 9px;">
        </div>
      `
      : "";
    return `
      <label class="opt" style="display:flex; gap:10px; align-items:flex-start; flex-direction:column;">
        <div style="display:flex; gap:8px; align-items:center; width:100%;">
          <input type="checkbox" name="${escapeHtml(checkboxId)}" value="1" data-mcp-toggle="${escapeHtml(checkboxId)}">
          <span style="font-weight:600; flex:1;">${escapeHtml(entry.name)}</span>
          <span class="pill" style="background:#0e1411; color:#8da59a;">${escapeHtml(authPill)}</span>
        </div>
        <div class="sub" style="font-size:11px; line-height:1.4; padding-left:24px;">${escapeHtml(entry.description ?? "")}</div>
        ${keyField}
      </label>
    `;
  }
  // coming-soon — show but disabled
  return `
    <label class="opt" style="display:flex; gap:10px; align-items:flex-start; flex-direction:column; opacity:0.55; cursor:not-allowed;">
      <div style="display:flex; gap:8px; align-items:center; width:100%;">
        <input type="checkbox" disabled>
        <span style="font-weight:600; flex:1;">${escapeHtml(entry.name)}</span>
        <span class="pill" style="background:#0e1411; color:#8da59a;">soon</span>
      </div>
      <div class="sub" style="font-size:11px; line-height:1.4; padding-left:24px;">${escapeHtml(entry.description ?? "")}</div>
    </label>
  `;
}

export const SETUP_FIELDS = WIZARD_FIELDS;
