// A small, owner-authenticated destination shared by the desktop menu and
// Devices page. Visiting it never issues a credential; that requires a click.
export function mainPhonePairingUrl(remote) {
  try {
    const url = new URL(remote);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    return new URL("/phone-pairing", url.origin).href;
  } catch { return null; }
}

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
})[c]);

export function renderPhonePairingPage({ remote = null } = {}) {
  const mainUrl = mainPhonePairingUrl(remote);
  const content = remote
    ? `<p>This Mac is a worker. Your main server authorizes new phones so they share its chat, tasks, Today, and Inbox.</p>
      ${mainUrl ? `<a class="button" href="${escapeHtml(mainUrl)}">Open phone pairing on main</a>
      <p class="muted">${escapeHtml(new URL(mainUrl).origin)}</p>` : '<p role="alert">The saved main-server address is invalid. Check this Mac’s server connection.</p>'}
      <p>Sign in to the main server once if asked. Its browser session is remembered for 30 days. This Mac’s auth token is a different credential.</p>
      <details><summary>Only seeing glasses pairing on main?</summary><p>Update OpenAGI on the main server, then reopen this screen. Older dashboards do not show phone pairing. You can also run <code>openagi pair-phone --platform ios</code> or <code>openagi pair-phone --platform android</code> on that main server.</p></details>`
    : `<p>On your iPhone or Android phone, choose <strong>Connect to a server</strong>. Use the server address and six-digit code below.</p>
      <button id="generate">Generate pairing code</button>
      <p id="status" role="status" aria-live="polite"></p>
      <section id="pairing" hidden aria-label="Phone pairing details">
        <label for="server">Server address</label><input id="server" readonly>
        <label for="code">Pairing code</label><output id="code"></output>
        <p id="expiry" class="muted"></p>
        <button id="copy" class="secondary">Copy code</button>
      </section>
      <details><summary>Where does this code come from?</summary><p>This screen creates a one-time phone code on your main server. It lasts 30 minutes. Generate a separate code for each phone; your phone remembers its connection after pairing.</p></details>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Connect a phone · OpenAGI</title><style>
    :root { color-scheme: light dark; font-family: -apple-system, BlinkMacSystemFont, system-ui, sans-serif; }
    body { margin: 0; padding: 28px; line-height: 1.5; } main { max-width: 480px; margin: auto; }
    h1 { font-size: 26px; } button, .button { display: inline-block; font: inherit; padding: 10px 16px; border-radius: 9px; border: 0; background: #1670df; color: white; cursor: pointer; text-decoration: none; }
    button:disabled { opacity: .6; cursor: wait; } .secondary { background: #7773; color: inherit; }
    label { display: block; margin-top: 14px; font-weight: 600; } input { box-sizing: border-box; width: 100%; font: inherit; padding: 10px; }
    output { display: block; font: 42px ui-monospace, monospace; letter-spacing: .12em; user-select: all; }
    .muted { opacity: .7; overflow-wrap: anywhere; } details { margin-top: 24px; } code { overflow-wrap: anywhere; }
    </style></head><body><main><h1>Connect a phone</h1>${content}</main>
    ${remote ? "" : `<script>
    const generate = document.getElementById("generate"), status = document.getElementById("status"), pairing = document.getElementById("pairing");
    let expiresAt = 0, timer;
    function updateExpiry() {
      const remaining = expiresAt - Date.now();
      if (remaining <= 0) {
        pairing.hidden = true; document.getElementById("code").textContent = "";
        status.textContent = "This code has expired. Generate a new code to continue.";
        clearInterval(timer);
      } else document.getElementById("expiry").textContent = "Single use · expires in " + Math.ceil(remaining / 60000) + " minutes";
    }
    generate.addEventListener("click", async () => {
      generate.disabled = true; pairing.hidden = true; clearInterval(timer); status.textContent = "Creating a pairing code…";
      try {
        const response = await fetch("/nodes/enrollment-code", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ platform: "mobile" }) });
        const data = await response.json();
        if (!response.ok) throw new Error(response.status === 401 ? "Your main-server session expired. Reopen phone pairing and sign in." : (data.error || "Could not create a pairing code."));
        if (!/^\\d{6}$/.test(data.code) || !Number.isFinite(Date.parse(data.expiresAt))) throw new Error("The server returned an invalid pairing code. Update the main server and try again.");
        const server = new URL(data.publicUrl || location.origin);
        if (!["http:", "https:"].includes(server.protocol)) throw new Error("The server address must use HTTP or HTTPS.");
        if (["localhost", "127.0.0.1", "[::1]"].includes(server.hostname)) throw new Error("Your phone cannot reach this Mac’s loopback address. Set the main server’s public URL to its LAN or Tailscale DNS address, then try again.");
        document.getElementById("server").value = server.origin;
        document.getElementById("code").textContent = data.code;
        expiresAt = Date.parse(data.expiresAt); pairing.hidden = false;
        generate.textContent = "Generate another code"; status.textContent = "Enter this code on your phone. Each code connects one phone.";
        updateExpiry(); timer = setInterval(updateExpiry, 1000);
      } catch (error) { status.textContent = error.message || "Could not create a pairing code. Try again."; }
      finally { generate.disabled = false; }
    });
    document.getElementById("copy").addEventListener("click", async () => {
      if (expiresAt <= Date.now()) { updateExpiry(); return; }
      try { await navigator.clipboard.writeText(document.getElementById("code").textContent); status.textContent = "Pairing code copied."; }
      catch { status.textContent = "Select and copy the six-digit code above."; }
    });
    </script>`}
    </body></html>`;
}
