// Included in the dashboard script; dynamic provider content uses textContent.
export const vocaleoUi = String.raw`
async function renderVocaleoSetup(panel) {
  panel.className = 'card';
  panel.style.padding = '14px';
  panel.style.marginBottom = '12px';
  panel.innerHTML = '<h3>Vocaleo · phone calls <span class="badge">optional</span></h3><p>Let OpenAGI make calls on your behalf. Connect your own Vocaleo account using your phone number or an existing API key.</p><p class="muted">Your number verifies account ownership; it does not become the outgoing caller ID. Calls use Vocaleo credit, separate from your OpenAGI model budget. US, Canada, and UK destinations only. Each call requires your approval and identifies the AI on a recorded line.</p><p role="status" aria-live="polite" data-status>Loading…</p><div data-content></div>';
  const status = panel.querySelector('[data-status]');
  const content = panel.querySelector('[data-content]');
  const request = async (path, body) => {
    const response = await fetch('/integrations/vocaleo/' + path, body === undefined
      ? { cache: 'no-store' }
      : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const result = await response.json();
    if (!response.ok) throw new Error((result.error || 'Vocaleo is unavailable.') + (result.retry_after_seconds ? ' Retry in ' + result.retry_after_seconds + ' seconds.' : ''));
    return result;
  };
  function field(form, title, type, placeholder) {
    const label = document.createElement('label'); label.style.display = 'block'; label.textContent = title;
    const input = document.createElement('input'); input.className = 'ui-input'; input.type = type; input.placeholder = placeholder;
    input.required = true; input.autocomplete = type === 'password' ? 'off' : 'tel';
    label.append(input); form.append(label); return input;
  }
  function button(parent, label, type = 'button') {
    const btn = document.createElement('button'); btn.className = 'ui-btn ui-btn-sm'; btn.type = type; btn.textContent = label;
    btn.style.marginTop = '8px'; parent.append(btn); return btn;
  }
  function showAccount(account) {
    const old = content.querySelector('[data-account]'); if (old) old.remove();
    const box = document.createElement('div'); box.dataset.account = '';
    const text = document.createElement('p');
    text.textContent = 'Balance: ' + account.balance_cents + '¢. Standard: ' + account.price_cents_per_minute + '¢ per started minute, ' + account.max_charge_cents_per_call + '¢ temporary hold per call. Pro (only when selected): ' + account.pro_price_cents_per_minute + '¢ per started minute, ' + account.pro_max_charge_cents_per_call + '¢ temporary hold. Unused held credit is returned after settlement.';
    box.append(text);
    if (account.payment_url) {
      try {
        const url = new URL(account.payment_url);
        if (url.protocol === 'https:' && !url.username && !url.password) {
          const link = document.createElement('a'); link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer';
          link.textContent = 'Add Vocaleo credit'; box.append(link);
        }
      } catch { /* invalid provider payment URL */ }
    }
    content.append(box);
  }
  async function connected(snapshot, account) {
    content.replaceChildren();
    status.textContent = 'Credentials saved privately in OpenAGI' + (snapshot.phone_number ? ' for ' + snapshot.phone_number : '') + '. Phone tools are enabled.';
    const tip = document.createElement('p'); tip.textContent = 'In chat, give OpenAGI a destination number, your name, and what to ask. For example: “Call +14155550123 for Alex and ask whether they have a table for two tonight.”'; content.append(tip);
    const refresh = button(content, 'Check connection and credit');
    refresh.onclick = async () => {
      refresh.disabled = true;
      try { showAccount(await request('account')); status.textContent = 'Vocaleo connection verified. Phone tools are ready.'; }
      catch (err) { status.textContent = err.message; }
      finally { refresh.disabled = false; }
    };
    const disconnect = button(content, 'Disconnect');
    const note = document.createElement('p'); note.className = 'muted'; note.textContent = 'Disconnect removes the saved credentials and tools from OpenAGI. Your Vocaleo account, credit, active calls, and any number subscription remain with Vocaleo.'; content.append(note);
    disconnect.onclick = async () => {
      disconnect.disabled = true;
      try { await request('disconnect', {}); await renderVocaleoSetup(panel); }
      catch (err) { status.textContent = err.message; disconnect.disabled = false; }
    };
    if (account) showAccount(account);
  }
  try {
    const snapshot = await request('status');
    if (!panel.isConnected) return;
    if (snapshot.configured) { await connected(snapshot); return; }
    status.textContent = 'Not connected. Set this up only if you want phone calls.';
    const form = document.createElement('form'); content.append(form);
    const phone = field(form, 'Your phone number', 'tel', '+14155550123');
    const note = document.createElement('p'); note.className = 'muted';
    note.textContent = 'Vocaleo will text a verification code to this number. Verifying an existing account creates a new key and invalidates its previous key; use the existing-key option below to keep it.'; form.append(note);
    const send = button(form, 'Text me a code', 'submit');
    let verifyingPhone = null;
    const codeForm = document.createElement('form'); codeForm.hidden = true; content.append(codeForm);
    const code = field(codeForm, 'Verification code', 'text', '4–8 digit SMS code');
    code.inputMode = 'numeric'; code.autocomplete = 'one-time-code'; code.pattern = '[0-9]{4,8}';
    const verify = button(codeForm, 'Verify and connect', 'submit');
    let busy = false;
    async function run(operation) {
      if (busy) return; busy = true;
      send.disabled = verify.disabled = connect.disabled = true;
      try { await operation(); }
      catch (err) { status.textContent = err.message; }
      finally { busy = false; send.disabled = verify.disabled = connect.disabled = false; }
    }
    form.onsubmit = (event) => {
      event.preventDefault();
      void run(async () => {
        status.textContent = 'Requesting a text message…';
        const result = await request('request-code', { phone_number: phone.value.trim() });
        verifyingPhone = result.phone_number; code.value = ''; codeForm.hidden = false;
        status.textContent = 'Code sent to ' + verifyingPhone + (result.expires_in_seconds ? '. Expires in ' + result.expires_in_seconds + ' seconds.' : '.');
        verify.textContent = 'Verify ' + verifyingPhone + ' and connect'; code.focus();
      });
    };
    codeForm.onsubmit = (event) => {
      event.preventDefault();
      void run(async () => {
        const enteredCode = code.value.trim(); code.value = '';
        const result = await request('verify', { phone_number: verifyingPhone, code: enteredCode });
        await connected(result, result.account);
      });
    };
    const details = document.createElement('details'); content.append(details);
    const summary = document.createElement('summary'); summary.textContent = 'Already have a Vocaleo API key?'; details.append(summary);
    const keyForm = document.createElement('form'); details.append(keyForm);
    const key = field(keyForm, 'Vocaleo API key', 'password', 'Paste your Vocaleo API key');
    const connect = button(keyForm, 'Connect existing account', 'submit');
    keyForm.onsubmit = (event) => {
      event.preventDefault();
      void run(async () => {
        const enteredKey = key.value.trim(); key.value = '';
        const result = await request('connect', { api_key: enteredKey });
        await connected(result, result.account);
      });
    };
  } catch (err) { status.textContent = err.message; }
}
`;
