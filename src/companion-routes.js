import path from "node:path";
import { PebbleWebhook } from "./integrations/pebble.js";
import { saveEnv } from "./setup-wizard.js";

const CONFIG_KEYS = ["SENDBLUE_API_KEY", "SENDBLUE_API_SECRET", "SENDBLUE_FROM_NUMBER", "SENDBLUE_WEBHOOK_SECRET", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "PEBBLE_WEBHOOK_SECRET"];
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

export function createCompanionRoutes({ runtime, dataDir, getChannels, getOrigin, env = process.env, pebble } = {}) {
  const index = pebble ?? new PebbleWebhook({ runtime, dir: path.join(dataDir, "pebble"), env });
  if (runtime.google) runtime.google.saveCredentials = values => saveEnv({ dataDir, values });
  return async (req, res, url) => {
    const { pathname } = url, method = req.method;
    const known = ["/connections", "/connections/config", "/sharing/contacts", "/sharing/groups", "/sharing/revoke", "/integrations/google/connect", "/integrations/google/callback", "/integrations/google/disconnect", "/channels/sendblue/webhook", "/webhooks/pebble"];
    if (!known.includes(pathname)) return false;
    const channels = getChannels();
    try {
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
      if (pathname === "/connections" && method === "GET") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" }); res.end(connectionsPage()); return true;
      }
      if (pathname === "/connections/config" && method === "GET") {
        json(res, 200, { configured: Object.fromEntries(CONFIG_KEYS.map(key => [key, Boolean(env[key])])), google: runtime.google?.status() ?? { configured: false }, sendblue: channels?.sendblue?.status() ?? { configured: false }, pebble: index.status(), sharing: channels?.sharing?.status() ?? { contacts: [], groups: [] }, origin: getOrigin() }); return true;
      }
      if (pathname === "/connections/config" && method === "POST") {
        const body = await bodyJson(req);
        const values = Object.fromEntries(CONFIG_KEYS.filter(key => typeof body[key] === "string").map(key => [key, body[key]]));
        if (Object.values(values).some(value => /[\r\n\0]/.test(value) || value.length > 4096)) throw new Error("Configuration values must be single lines, up to 4096 characters.");
        const result = saveEnv({ dataDir, values });
        if (runtime.google) runtime.google.access = null;
        json(res, 200, { saved: result.keys }); return true;
      }
      if (pathname === "/integrations/google/connect" && method === "POST") {
        if (!runtime.google) { json(res, 503, { error: "google_unavailable" }); return true; }
        json(res, 200, runtime.google.begin(`${getOrigin()}/integrations/google/callback`)); return true;
      }
      if (pathname === "/integrations/google/disconnect" && method === "POST") {
        saveEnv({ dataDir, values: {}, clear: ["GOOGLE_REFRESH_TOKEN"] });
        if (runtime.google) { runtime.google.access = null; runtime.google.flows.clear(); }
        json(res, 200, { disconnected: true, note: "Local credentials removed. Revoke the app in your Google account to revoke the server-side grant." }); return true;
      }
      if (method === "POST" && ["/sharing/contacts", "/sharing/groups", "/sharing/revoke"].includes(pathname)) {
        if (!channels?.sharing) { json(res, 503, { error: "sharing_unavailable" }); return true; }
        const operation = { "/sharing/contacts": "addContact", "/sharing/groups": "addGroup", "/sharing/revoke": "revoke" }[pathname];
        json(res, 200, channels.sharing[operation](await bodyJson(req))); return true;
      }
      json(res, 405, { error: "method_not_allowed" }); return true;
    } catch (error) {
      const webhook = ["/channels/sendblue/webhook", "/webhooks/pebble"].includes(pathname);
      // Provider webhooks never receive model errors, private content or keys.
      json(res, error.status ?? (webhook ? 503 : 400), { error: webhook ? "webhook_failed" : error.message }); return true;
    }
  };
}

export function connectionsPage() {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connections · OpenAGI</title>
<style>body{font:16px system-ui;max-width:760px;margin:40px auto;padding:0 20px;color:#172d25;background:#f4f7f5}a{color:#185f46}section{background:white;padding:24px;border:1px solid #d8e2dc;border-radius:16px;margin:20px 0}h1{font-size:32px}h2{font-size:22px;margin-top:0}p{line-height:1.6}label{display:block;margin:12px 0}input{display:block;box-sizing:border-box;width:100%;padding:10px;border:1px solid #9badA3;border-radius:7px;margin-top:5px}button{padding:10px 16px;border:0;border-radius:8px;background:#185f46;color:white;margin:5px 8px 5px 0;cursor:pointer}button:disabled{opacity:.5}code{overflow-wrap:anywhere}#status{white-space:pre-wrap}li{margin:10px 0}</style>
<a href="/">← OpenAGI</a><h1>Connections</h1><p>Give your agent a number, connect your inbox, and send thoughts from your ring.</p><p id="status" role="status" aria-live="polite">Loading…</p>
<section><h2>Partner messaging</h2><p>Get a dedicated agent number from <a href="https://sendblue.com" target="_blank" rel="noreferrer">Sendblue</a>, then add its API credentials below. Set its inbound webhook to <code data-url="/channels/sendblue/webhook"></code> and use the same webhook secret.</p><form id="sendblue"><label>API key<input name="SENDBLUE_API_KEY" type="password" autocomplete="off"></label><label>API secret<input name="SENDBLUE_API_SECRET" type="password" autocomplete="off"></label><label>Agent phone number<input name="SENDBLUE_FROM_NUMBER" placeholder="+15555550100"></label><label>Webhook secret<input name="SENDBLUE_WEBHOOK_SECRET" type="password" autocomplete="off"></label><button>Save Sendblue</button></form>
<p>Approved contacts can chat and save facts in their own conversation. Your private memory, email, calendar and computer remain accessible only to you. Group facts are visible to everyone in that group. Approve groups only after checking their membership.</p>
<form id="contact"><label>Partner name<input name="name" required maxlength="100"></label><label>Partner phone number<input name="number" required placeholder="+15555550101"></label><button>Approve contact</button></form><ul id="contacts"></ul>
<details><summary>Approve an existing group</summary><p>Add the agent number to an iMessage group, then copy its group ID from the Sendblue dashboard. Each person whose messages the agent should answer must also be an approved contact.</p><form id="group"><label>Group name<input name="name" required></label><label>Sendblue group ID<input name="groupId" required></label><button>Approve group</button></form><ul id="groups"></ul></details></section>
<section><h2>Gmail &amp; Google Calendar</h2><p>Create a Web application OAuth client in <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noreferrer">Google Cloud</a>. Enable Gmail API and Google Calendar API, configure the consent screen, add your account as a test user, and allow this redirect URI: <code data-url="/integrations/google/callback"></code>.</p><form id="google"><label>OAuth client ID<input name="GOOGLE_CLIENT_ID" autocomplete="off"></label><label>OAuth client secret<input name="GOOGLE_CLIENT_SECRET" type="password" autocomplete="off"></label><button>Save Google client</button></form><button id="connect-google" type="button">Connect Google</button><button id="disconnect-google" type="button">Disconnect Google</button><p>Try “Find unread emails from my accountant” or “Draft an email to…” after connecting. Email sends and event invitations require your authorization.</p></section>
<section><h2>Pebble Index</h2><p>In Index 01 → Webhook, use <code data-url="/webhooks/pebble"></code>, choose <b>Transcription only</b> or <b>Both</b>, and enable <b>Sign requests</b> with the secret below. Tap <b>Send test event</b>, then save. Voice memos go to memory; “remind me to…” also creates a task. Imported tasks do not schedule notifications.</p><form id="pebble"><label>Signing secret<input name="PEBBLE_WEBHOOK_SECRET" type="password" autocomplete="off"></label><button>Save Pebble</button></form></section>
<section><h2>Daily routines &amp; subagents</h2><p>Try “Every day at 9am, search my inbox for invoices, run my invoice-review skill, and summarize what needs my attention.” Review the resulting schedule under Cron. It runs in the daemon’s timezone while the daemon is running. Scheduled actions still use the approval queue.</p><p>Try “Use a subagent to research these three options and return the sources.” Subagents use selected read-only tools and share your daily model budget.</p></section>
<script>
const status=document.querySelector('#status');
async function call(url,body){const r=await fetch(url,body===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const d=await r.json();if(!r.ok)throw Error(d.error||'Request failed');return d;}
function error(e){status.textContent=e.message;}
async function refresh(){const d=await call('/connections/config');status.textContent='Sendblue: '+(d.sendblue.configured&&d.sendblue.webhookReady?'configured':'needs setup')+' · Google: '+(d.google.configured?'credentials saved':'needs setup')+' · Pebble: '+(d.pebble.configured?'configured':'needs setup');for(const el of document.querySelectorAll('[data-url]'))el.textContent=d.origin+el.dataset.url;for(const input of document.querySelectorAll('input[name]'))if(d.configured[input.name])input.placeholder='Saved — leave blank to keep';for(const [kind,key]of [['contacts','number'],['groups','groupId']]){const list=document.getElementById(kind);list.replaceChildren();for(const item of d.sharing[kind]){const li=document.createElement('li');li.textContent=item.name+' · '+item[key]+' ';const b=document.createElement('button');b.type='button';b.textContent='Revoke';b.onclick=()=>call('/sharing/revoke',{[key]:item[key]}).then(refresh).catch(error);li.append(b);list.append(li);}}}
for(const id of ['sendblue','google','pebble'])document.getElementById(id).onsubmit=async e=>{e.preventDefault();try{await call('/connections/config',Object.fromEntries(new FormData(e.target)));e.target.reset();await refresh();}catch(e){error(e);}};
for(const [id,url]of [['contact','/sharing/contacts'],['group','/sharing/groups']])document.getElementById(id).onsubmit=async e=>{e.preventDefault();try{await call(url,Object.fromEntries(new FormData(e.target)));e.target.reset();await refresh();}catch(e){error(e);}};
document.getElementById('connect-google').onclick=()=>call('/integrations/google/connect',{}).then(d=>location.assign(d.url)).catch(error);
document.getElementById('disconnect-google').onclick=()=>call('/integrations/google/disconnect',{}).then(refresh).catch(error);
refresh().catch(error);
</script></html>`;
}
