import path from "node:path";
import { PebbleWebhook } from "./integrations/pebble.js";
import { PebblePeriReceiver, PEBBLE_PERI_MAX_BODY_BYTES, WEBHOOK_PATH as PEBBLE_PERI_PATH } from "./integrations/pebble-peri.js";
import { saveEnv } from "./setup-wizard.js";
import { MESSAGING_CONFIG_KEYS, MESSAGING_PROVIDERS } from "./integrations/messaging-config.js";

const CONFIG_KEYS = ["SENDBLUE_API_KEY", "SENDBLUE_API_SECRET", "SENDBLUE_FROM_NUMBER", "SENDBLUE_WEBHOOK_SECRET", ...MESSAGING_CONFIG_KEYS, "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "PEBBLE_WEBHOOK_SECRET"];
const WEBHOOKS = new Map(MESSAGING_PROVIDERS.map(({ id }) => [`/channels/${id}/webhook`, id]));
const json = (res, status, body) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(body)); };
async function rawBody(req, maxBytes) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error("Request body is too large."), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function bodyJson(req) {
  const raw = await rawBody(req, 64 * 1024);
  try { const value = JSON.parse(raw.toString("utf8")); if (value && typeof value === "object" && !Array.isArray(value)) return value; }
  catch { /* mapped below */ }
  throw Object.assign(new Error("Expected a JSON object."), { status: 400 });
}

// Index 01 transcripts travel only over HTTPS. The configured public origin
// must be https, and the request must arrive over TLS or from a loopback
// TLS-terminating proxy (cloudflared, tailscale serve) that did not report
// plain http. Proxy headers grant no other trust.
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
export function pebbleTransportSecure(req, origin) {
  if (!String(origin ?? "").startsWith("https://")) return false;
  if (req.socket?.encrypted) return true;
  const proto = req.headers["x-forwarded-proto"];
  return LOOPBACK.has(req.socket?.remoteAddress) && (proto === undefined || proto === "https");
}

export function createCompanionRoutes({ runtime, dataDir, getChannels, getOrigin, env = process.env, pebble, pebblePeri } = {}) {
  const index = pebble ?? new PebbleWebhook({ runtime, dir: path.join(dataDir, "pebble"), env });
  const peri = pebblePeri ?? new PebblePeriReceiver({ runtime, dir: path.join(dataDir, "pebble"),
    getAgentHost: () => runtime.agentHost ?? getChannels()?.agentHost ?? null });
  if (runtime.google) runtime.google.saveCredentials = values => saveEnv({ dataDir, values });
  return async (req, res, url) => {
    const { pathname } = url, method = req.method;
    const known = ["/connections/config", "/sharing/contacts", "/sharing/groups", "/sharing/revoke", "/sharing/retry", "/integrations/google/connect", "/integrations/google/callback", "/integrations/google/disconnect", "/channels/sendblue/webhook", ...WEBHOOKS.keys(), "/webhooks/pebble"];
    const periWebhook = PEBBLE_PERI_PATH.exec(pathname);
    const periOwnerRoutes = ["/pebble/peri/devices", "/pebble/peri/devices/rotate", "/pebble/peri/devices/revoke", "/pebble/peri/notes"];
    if (!known.includes(pathname) && !periWebhook && !periOwnerRoutes.includes(pathname)) return false;
    const channels = getChannels();
    try {
      if (periWebhook) {
        if (method !== "POST") { json(res, 405, { error: "method_not_allowed" }); return true; }
        if (!pebbleTransportSecure(req, getOrigin())) { json(res, 403, { error: "https_required" }); return true; }
        const declared = Number(req.headers["content-length"]);
        if (Number.isFinite(declared) && declared > PEBBLE_PERI_MAX_BODY_BYTES) { json(res, 413, { error: "payload_too_large" }); return true; }
        const result = await peri.handle(periWebhook[1], req.headers, await rawBody(req, PEBBLE_PERI_MAX_BODY_BYTES));
        json(res, result.status, result.body); return true;
      }
      if (periOwnerRoutes.includes(pathname)) {
        res.setHeader("referrer-policy", "no-referrer");
        if (pathname === "/pebble/peri/devices" && method === "GET") { json(res, 200, peri.status(getOrigin())); return true; }
        if (pathname === "/pebble/peri/notes" && method === "GET") { json(res, 200, { notes: peri.notes() }); return true; }
        if (method !== "POST") { json(res, 405, { error: "method_not_allowed" }); return true; }
        const body = await bodyJson(req);
        if (pathname === "/pebble/peri/devices") {
          if (!String(getOrigin()).startsWith("https://")) { json(res, 409, { error: "https_public_url_required", message: "Set OPENAGI_PUBLIC_URL to an https:// origin first. Index 01 transcripts are only accepted over HTTPS." }); return true; }
          json(res, 201, peri.provision({ label: body.label }, getOrigin())); return true;
        }
        if (typeof body.id !== "string") throw Object.assign(new Error("Choose a Pebble device."), { status: 400 });
        json(res, 200, pathname.endsWith("/rotate") ? peri.rotate(body.id, getOrigin()) : peri.revoke(body.id)); return true;
      }
      if (WEBHOOKS.has(pathname) && method === "POST") {
        const provider = WEBHOOKS.get(pathname), channel = channels?.[provider];
        if (!channel) { json(res, 503, { error: "sharing_unavailable" }); return true; }
        const type = req.headers["content-type"]?.split(";")[0].trim().toLowerCase();
        if (type !== (provider === "twilio" ? "application/x-www-form-urlencoded" : "application/json")) { json(res, 415, { error: "unsupported_webhook_content_type" }); return true; }
        const raw = await rawBody(req, 128 * 1024);
        // The public origin is configured by the owner. Keep the original
        // encoded query string for Twilio; proxy/Host headers grant no trust.
        const callbackUrl = req.url.startsWith("/") ? `${getOrigin()}${req.url}` : null;
        if (!channel.verify(req.headers, raw, callbackUrl)) { json(res, 401, { error: "invalid_webhook_signature" }); return true; }
        let body;
        if (provider === "twilio") body = new URLSearchParams(raw.toString("utf8"));
        else {
          try { body = JSON.parse(raw.toString("utf8")); } catch { throw Object.assign(new Error("Invalid JSON."), { status: 400 }); }
          if (!body || typeof body !== "object" || Array.isArray(body)) throw Object.assign(new Error("Expected an object."), { status: 400 });
        }
        const result = channel.handleWebhook(body);
        if (provider === "twilio") {
          res.writeHead(200, { "content-type": "text/xml; charset=utf-8", "cache-control": "no-store" }); res.end("<Response/>");
        } else json(res, 202, result);
        return true;
      }
      if (pathname === "/channels/sendblue/webhook" && method === "POST") {
        if (!channels?.sendblue) { json(res, 503, { error: "sharing_unavailable" }); return true; }
        if (!channels.sendblue.verify(req.headers["sb-signing-secret"])) { json(res, 401, { error: "invalid_sendblue_secret" }); return true; }
        const result = await channels.sendblue.handleWebhook(await bodyJson(req));
        json(res, 200, result); return true;
      }
      if (pathname === "/webhooks/pebble" && method === "POST") {
        const result = await index.handle(req.headers, await rawBody(req, 12 * 1024 * 1024));
        json(res, result.status, result.body); return true;
      }
      if (pathname === "/integrations/google/callback" && method === "GET") {
        if (!runtime.google) { json(res, 503, { error: "google_unavailable" }); return true; }
        await runtime.google.finish(Object.fromEntries(url.searchParams));
        res.writeHead(303, { location: "/connections", "cache-control": "no-store", "referrer-policy": "no-referrer" }); res.end(); return true;
      }
      if (pathname === "/connections/config" && method === "GET") {
        json(res, 200, { configured: Object.fromEntries(CONFIG_KEYS.map(key => [key, Boolean(env[key])])), google: runtime.google?.status() ?? { configured: false }, sendblue: channels?.sendblue?.status() ?? { configured: false }, ...Object.fromEntries(MESSAGING_PROVIDERS.map(({ id }) => [id, channels?.[id]?.status() ?? { configured: false }])), pebble: index.status(), pebblePeri: peri.status(getOrigin()), sharing: channels?.sharing?.status() ?? { contacts: [], groups: [] }, origin: getOrigin() }); return true;
      }
      if (pathname === "/connections/config" && method === "POST") {
        const body = await bodyJson(req);
        const values = Object.fromEntries(CONFIG_KEYS.filter(key => typeof body[key] === "string").map(key => [key, body[key]]));
        if (Object.values(values).some(value => /[\r\n\0]/.test(value) || value.length > 4096)) throw new Error("Configuration values must be single lines, up to 4096 characters.");
        const result = saveEnv({ dataDir, values });
        for (const [key, value] of Object.entries(values)) if (value.trim()) env[key] = value.trim();
        for (const { id } of MESSAGING_PROVIDERS) channels?.[id]?.start();
        if (Object.keys(values).some(key => key.startsWith("GOOGLE_") && values[key].trim())) runtime.google?.credentialsChanged();
        json(res, 200, { saved: result.keys }); return true;
      }
      if (pathname === "/sharing/retry" && method === "POST") {
        for (const { id } of MESSAGING_PROVIDERS) channels?.[id]?.start();
        json(res, 200, { retryQueued: true, note: "Uncertain sends remain held for provider-dashboard review." }); return true;
      }
      if (pathname === "/integrations/google/connect" && method === "POST") {
        if (!runtime.google) { json(res, 503, { error: "google_unavailable" }); return true; }
        json(res, 200, runtime.google.begin(`${getOrigin()}/integrations/google/callback`)); return true;
      }
      if (pathname === "/integrations/google/disconnect" && method === "POST") {
        saveEnv({ dataDir, values: {}, clear: ["GOOGLE_REFRESH_TOKEN"] });
        if (runtime.google) { delete runtime.google.env.GOOGLE_REFRESH_TOKEN; runtime.google.credentialsChanged(); }
        json(res, 200, { disconnected: true, note: "Local credentials removed. Revoke the app in your Google account to revoke the server-side grant." }); return true;
      }
      if (method === "POST" && ["/sharing/contacts", "/sharing/groups", "/sharing/revoke"].includes(pathname)) {
        if (!channels?.sharing) { json(res, 503, { error: "sharing_unavailable" }); return true; }
        const operation = { "/sharing/contacts": "addContact", "/sharing/groups": "addGroup", "/sharing/revoke": "revoke" }[pathname];
        json(res, 200, channels.sharing[operation](await bodyJson(req))); return true;
      }
      json(res, 405, { error: "method_not_allowed" }); return true;
    } catch (error) {
      const webhook = WEBHOOKS.has(pathname) || ["/channels/sendblue/webhook", "/webhooks/pebble"].includes(pathname) || Boolean(periWebhook);
      // Provider webhooks never receive model errors, private content or keys.
      json(res, error.status ?? (webhook ? 503 : 400), { error: webhook ? "webhook_failed" : error.message }); return true;
    }
  };
}

export function connectionsPage() {
  const providerForms = MESSAGING_PROVIDERS.map(p => `<details><summary>${p.name} · ${p.description}</summary><p><a href="${p.guide}" target="_blank" rel="noreferrer">${p.name} setup guide</a>. ${p.setup}</p><p>Inbound webhook: <code data-url="/channels/${p.id}/webhook"></code></p><form id="${p.id}">${p.fields.map(([key, label, secret]) => `<label>${label}<input name="${key}" type="${secret ? "password" : "text"}" autocomplete="off"${key.endsWith("_FROM_NUMBER") ? ' placeholder="+15555550100"' : ""}></label>`).join("")}<button>Save ${p.name}</button></form></details>`).join("");
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connections · OpenAGI</title>
<style>body{font:16px system-ui;max-width:760px;margin:40px auto;padding:0 20px;color:#172d25;background:#f4f7f5}a{color:#185f46}section{background:white;padding:24px;border:1px solid #d8e2dc;border-radius:16px;margin:20px 0}h1{font-size:32px}h2{font-size:22px;margin-top:0}p{line-height:1.6}label{display:block;margin:12px 0}input{display:block;box-sizing:border-box;width:100%;padding:10px;border:1px solid #9badA3;border-radius:7px;margin-top:5px}button{padding:10px 16px;border:0;border-radius:8px;background:#185f46;color:white;margin:5px 8px 5px 0;cursor:pointer}button:disabled{opacity:.5}code{overflow-wrap:anywhere}#status{white-space:pre-wrap}li{margin:10px 0}</style>
<a href="/">← OpenAGI</a><h1>Connections</h1><p>Give your agent a number, connect your inbox, and send thoughts from your ring.</p><p id="status" role="status" aria-live="polite">Loading…</p>
<section><h2>Partner messaging</h2><p>Get a dedicated agent number from <a href="https://sendblue.com" target="_blank" rel="noreferrer">Sendblue</a>, then add its API credentials below. Set its inbound webhook to <code data-url="/channels/sendblue/webhook"></code> and use the same webhook secret.</p><form id="sendblue"><label>API key<input name="SENDBLUE_API_KEY" type="password" autocomplete="off"></label><label>API secret<input name="SENDBLUE_API_SECRET" type="password" autocomplete="off"></label><label>Agent phone number<input name="SENDBLUE_FROM_NUMBER" placeholder="+15555550100"></label><label>Webhook secret<input name="SENDBLUE_WEBHOOK_SECRET" type="password" autocomplete="off"></label><button>Save Sendblue</button></form>
${providerForms}
<p>Choose a provider and provision a dedicated number in its dashboard. Use a stable public HTTPS origin in OPENAGI_PUBLIC_URL, then restart the daemon. Complete any carrier registration with your provider.</p><p>Approved contacts apply to all configured phone providers. Each provider’s DMs and groups have separate history and facts. Your private memory, email, calendar and computer remain accessible only to you. Group facts are visible to everyone in that group. Approve groups only after checking their membership.</p><button id="retry-messaging" type="button">Retry queued replies</button><p>Failed queued replies retry after configuration is saved, after a restart, or with this button. Uncertain sends remain held: inspect the provider’s dashboard before resending. API acceptance does not prove phone delivery.</p>
<form id="contact"><label>Partner name<input name="name" required maxlength="100"></label><label>Partner phone number<input name="number" required placeholder="+15555550101"></label><button>Approve contact</button></form><ul id="contacts"></ul>
<details><summary>Approve an existing group</summary><p>Add the agent number to an iMessage group, then copy its group/chat ID from Sendblue or Linq. Approve every participant’s phone number. Linq checks current membership before reading group memory and again before sending.</p><form id="group"><label>Provider<select name="provider"><option value="sendblue">Sendblue</option><option value="linq">Linq</option></select></label><label>Group name<input name="name" required></label><label>Group / chat ID<input name="groupId" required></label><button>Approve group</button></form><ul id="groups"></ul></details></section>
<section><h2>Gmail &amp; Google Calendar</h2><p>Create a Web application OAuth client in <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noreferrer">Google Cloud</a>. Enable Gmail API and Google Calendar API, configure the consent screen, add your account as a test user, and allow this redirect URI: <code data-url="/integrations/google/callback"></code>.</p><form id="google"><label>OAuth client ID<input name="GOOGLE_CLIENT_ID" autocomplete="off"></label><label>OAuth client secret<input name="GOOGLE_CLIENT_SECRET" type="password" autocomplete="off"></label><button>Save Google client</button></form><button id="connect-google" type="button">Connect Google</button><button id="disconnect-google" type="button">Disconnect Google</button><p>Try “Find unread emails from my accountant” or “Draft an email to…” after connecting. Email sends and event invitations require your authorization.</p></section>
<section><h2>Pebble Index (memo import)</h2><p>In Index 01 → Webhook, use <code data-url="/webhooks/pebble"></code>, choose <b>Transcription only</b> or <b>Both</b>, and enable <b>Sign requests</b> with the secret below. Tap <b>Send test event</b>, then save. Voice memos go to memory; “remind me to…” also creates a task. Imported tasks do not schedule notifications.</p><form id="pebble"><label>Signing secret<input name="PEBBLE_WEBHOOK_SECRET" type="password" autocomplete="off"></label><button>Save Pebble</button></form></section>
<section><h2>Pebble Index 01 → Peri</h2><p>Talk to Peri with <b>Double click &amp; hold</b>. <b>Hold &amp; talk</b> stays in Pebble notes, so do not configure it here. Each ring gets its own signed HTTPS webhook and a private chat in the iPhone app’s Agent list. Start a recording with “keep this note” to save a private note, or “remember this” to save to private memory. Anything else gets a reply in the chat and is not saved. Recordings cannot approve, run tools or act for you.</p><p>Requires an <code>https://</code> OPENAGI_PUBLIC_URL. The secret is shown once: copy it straight into the Pebble app. Never paste it into a chat.</p><form id="pebble-peri"><label>Ring name<input name="label" maxlength="60" placeholder="Pebble Index 01"></label><button>Add Index 01</button></form><div id="pebble-peri-secret" hidden><p><b>Shown once.</b> In the Pebble app: Index 01 → Webhooks → Double click &amp; hold.</p><label>URL<input id="pebble-peri-url" readonly></label><label>Signing secret<input id="pebble-peri-key" type="password" readonly></label><button type="button" id="pebble-peri-copy-url">Copy URL</button><button type="button" id="pebble-peri-copy-key">Copy secret</button><button type="button" id="pebble-peri-done">Done</button></div><ul id="pebble-peri-devices"></ul><p><a href="/pebble/peri/notes">Pebble notes (JSON)</a></p></section>
<section><h2>Daily routines &amp; subagents</h2><p>Try “Every day at 9am, search my inbox for invoices, run my invoice-review skill, and summarize what needs my attention.” Review the resulting schedule under Cron. It runs in the daemon’s timezone while the daemon is running. Scheduled actions still use the approval queue.</p><p>Try “Use a subagent to research these three options and return the sources.” Subagents use selected read-only tools and share your daily model budget.</p></section>
<script>
const status=document.querySelector('#status');
async function call(url,body){const r=await fetch(url,body===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const d=await r.json();if(!r.ok)throw Error(d.error||'Request failed');return d;}
function error(e){status.textContent=e.message;}
async function refresh(){const d=await call('/connections/config');status.textContent=['sendblue','linq','twilio','telnyx','surge'].map(id=>id+': '+(d[id].configured&&d[id].webhookReady?'configured':'needs setup')+(d[id].pending?' · '+d[id].pending+' pending, '+d[id].failed+' failed, '+d[id].requiresReview+' need review':'')).join(' | ')+' · Google: '+(d.google.configured?'credentials saved':'needs setup')+' · Pebble: '+(d.pebble.configured?'configured':'needs setup');for(const el of document.querySelectorAll('[data-url]'))el.textContent=d.origin+el.dataset.url;for(const input of document.querySelectorAll('input[name]'))if(d.configured[input.name])input.placeholder='Saved — leave blank to keep';for(const [kind,key]of [['contacts','number'],['groups','groupId']]){const list=document.getElementById(kind);list.replaceChildren();for(const item of d.sharing[kind]){const li=document.createElement('li');li.textContent=item.name+' · '+(kind==='groups'?(item.provider||'sendblue')+' · ':'')+item[key]+' ';const b=document.createElement('button');b.type='button';b.textContent='Revoke';b.onclick=()=>call('/sharing/revoke',{[key]:item[key],...(kind==='groups'?{provider:item.provider||'sendblue'}:{})}).then(refresh).catch(error);li.append(b);list.append(li);}}}
for(const id of ['sendblue','linq','twilio','telnyx','surge','google','pebble'])document.getElementById(id).onsubmit=async e=>{e.preventDefault();try{await call('/connections/config',Object.fromEntries(new FormData(e.target)));e.target.reset();await refresh();}catch(e){error(e);}};
for(const [id,url]of [['contact','/sharing/contacts'],['group','/sharing/groups']])document.getElementById(id).onsubmit=async e=>{e.preventDefault();try{await call(url,Object.fromEntries(new FormData(e.target)));e.target.reset();await refresh();}catch(e){error(e);}};
document.getElementById('connect-google').onclick=()=>call('/integrations/google/connect',{}).then(d=>location.assign(d.url)).catch(error);
document.getElementById('disconnect-google').onclick=()=>call('/integrations/google/disconnect',{}).then(refresh).catch(error);
document.getElementById('retry-messaging').onclick=()=>call('/sharing/retry',{}).then(refresh).catch(error);
const periBox=document.getElementById('pebble-peri-secret');
function showPeri(d){document.getElementById('pebble-peri-url').value=d.device.url;document.getElementById('pebble-peri-key').value=d.secret;periBox.hidden=false;}
document.getElementById('pebble-peri-copy-url').onclick=()=>navigator.clipboard.writeText(document.getElementById('pebble-peri-url').value).catch(error);
document.getElementById('pebble-peri-copy-key').onclick=()=>navigator.clipboard.writeText(document.getElementById('pebble-peri-key').value).catch(error);
document.getElementById('pebble-peri-done').onclick=()=>{document.getElementById('pebble-peri-key').value='';document.getElementById('pebble-peri-url').value='';periBox.hidden=true;};
document.getElementById('pebble-peri').onsubmit=async e=>{e.preventDefault();try{showPeri(await call('/pebble/peri/devices',Object.fromEntries(new FormData(e.target))));e.target.reset();await refreshPeri();}catch(e){error(e);}};
async function refreshPeri(){const d=await call('/pebble/peri/devices');const list=document.getElementById('pebble-peri-devices');list.replaceChildren();for(const item of d.devices){const li=document.createElement('li');li.textContent=item.label+' · test '+(item.lastTestAt?'verified '+item.lastTestAt:'not yet received')+' · last recording '+(item.lastDeliveryAt||'none')+(item.ignoredHoldAndTalk?' · '+item.ignoredHoldAndTalk+' Hold & talk deliveries ignored':'')+' ';for(const [label,url,show]of [['Rotate secret','/pebble/peri/devices/rotate',true],['Revoke','/pebble/peri/devices/revoke',false]]){const b=document.createElement('button');b.type='button';b.textContent=label;b.onclick=()=>call(url,{id:item.id}).then(r=>{if(show)showPeri(r);return refreshPeri();}).catch(error);li.append(b);}list.append(li);}}
refreshPeri().catch(error);
refresh().catch(error);
</script></html>`;
}
