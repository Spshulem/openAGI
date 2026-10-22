export function renderLoginPage(reason, next = "/", { isWorker = false } = {}) {
  // Sanitise the redirect target so an attacker can't bounce the user
  // off-site after sign-in.
  const safeNext = typeof next === "string" && next.startsWith("/") && !next.startsWith("//") ? next : "/";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>OpenAGI · auth</title>
<style>body{font:14px/1.5 ui-sans-serif,system-ui;background:#0e1411;color:#e8efea;display:grid;place-items:center;min-height:100vh;margin:0}
form{background:#161d19;border:1px solid #2a352f;border-radius:10px;padding:24px;width:min(420px,90vw)}
h1{margin:0 0 4px;font-size:18px}p{color:#8da59a;margin:6px 0 16px;font-size:13px}
input{width:100%;padding:9px 12px;background:#0e1411;color:#e8efea;border:1px solid #2a352f;border-radius:6px;font:inherit;margin-bottom:10px}
button{background:#6fe1b1;color:#002219;border:0;padding:9px 14px;border-radius:6px;font-weight:700;cursor:pointer;width:100%}
.err{color:#f08080;margin-bottom:10px;font-size:12px}
.hint{color:#8da59a;font-size:12px;margin-top:14px}
.hint code{background:#0e1411;padding:2px 5px;border-radius:3px;border:1px solid #2a352f}</style></head>
<body><form method="POST" action="/sign-in" id="loginForm" enctype="application/x-www-form-urlencoded">
<h1>Sign in to OpenAGI</h1><p>Use the owner token for this server. Each computer has its own token.</p>
${reason ? `<div class="err">${escapeHtmlForLogin(reason)}</div>` : ""}
<label for="owner-token">Server owner token</label>
<input id="owner-token" name="token" type="password" placeholder="Paste this server’s owner token" autocomplete="current-password" autofocus required spellcheck="false" autocapitalize="off">
<input type="hidden" name="next" value="${escapeHtmlForLogin(safeNext)}">
<button type="submit">Sign in</button>
<div class="hint">${isWorker
  ? "For this Mac, use the OpenAGI menu → <strong>Open dashboard</strong> to sign in automatically. <strong>Copy auth token</strong> copies this Mac’s token only."
  : "Use <code>OPENAGI_AUTH_TOKEN</code> from <strong>this main server’s</strong> active data directory’s <code>.env</code> file. A token copied from a paired Mac or phone will not work here."}</div>
<div class="hint">You stay signed in for 30 days in this browser at this server address, unless its token changes or browser data is cleared. Phone pairing is saved separately.</div>
</form>
</body></html>`;
}

// SEC-4: single quotes too — this value lands in an attribute, and an
// attribute is just as happy to be delimited by ' as by ".
function escapeHtmlForLogin(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]);
}
