// Shared managed-session controls for Coding setup and Supervisor.
// All provider output is rendered as text; no model content becomes markup.
export const codingSessionUi = String.raw`
function renderCodingSessionCards(snapshot, refresh) {
  $('codingList').replaceChildren();
  for (const watch of snapshot.watches || []) {
    if (!watch.active || !(snapshot.sessions || []).some(s => s.provider === watch.provider && s.sessionId === watch.sessionId)) {
      const note = document.createElement('p');
      note.textContent = watch.provider + ' · ' + watch.sessionId + ': watch paused; ' + (watch.active ? 'session is not visible. Missing sessions are not treated as complete.' : 'switch back to its coding node to manage this watch.');
      if (watch.active) {
        const stop = document.createElement('button'); stop.textContent = 'Stop watching';
        stop.onclick = async () => { try { await postJson('/coding-agents/watch', { ...watch, enabled: false }); await refresh(); } catch { stop.textContent = 'Could not stop watch. Retry'; } };
        note.append(stop);
      }
      $('codingList').append(note);
    }
  }
  for (const session of snapshot.sessions || []) {
    const card = document.createElement('div');
    card.className = 'card';
    const title = document.createElement('h3');
    title.textContent = session.project || session.label || 'Coding session';
    const info = document.createElement('p');
    info.textContent = session.provider + ' · ' + ({ idle: 'Response ready', working: 'Working', interrupted: 'Needs review', failed: 'Run failed' }[session.status] || session.status) + (session.model ? ' · ' + session.model : '');
    const details = document.createElement('details');
    const label = document.createElement('summary'); label.textContent = 'Session details';
    const id = document.createElement('code'); id.textContent = session.sessionId; id.style.overflowWrap = 'anywhere';
    const basis = document.createElement('p'); basis.textContent = 'Status source: ' + (session.attentionBasis || 'provider');
    details.append(label, id, basis);
    const open = document.createElement('button');
    open.textContent = 'Inspect / reply';
    open.onclick = () => inspectCodingAgent({ ...session, replyAvailable: session.replyAvailable && !snapshot.error });
    card.append(title, info, details);
    const actions = document.createElement('div'); actions.className = 'coding-actions'; actions.append(open); card.append(actions);
    const watching = (snapshot.watches || []).some(w => w.active && w.provider === session.provider && w.sessionId === session.sessionId);
    const watch = document.createElement('button'); watch.textContent = watching ? 'Stop watching' : 'Watch session';
    watch.disabled = Boolean(snapshot.error);
    const setWatching = async enabled => {
      watch.disabled = true;
      try { await postJson('/coding-agents/watch', { provider: session.provider, sessionId: session.sessionId, enabled }); await refresh(); }
      catch { $('codingStatus').textContent = 'Could not change this watch. Refresh and retry (20 watches maximum).'; watch.disabled = false; }
    };
    watch.onclick = async () => {
      if (watching) return setWatching(false);
      if (card.querySelector('.coding-watch-confirm')) return;
      const confirmation = document.createElement('div'); confirmation.className = 'coding-watch-confirm';
      confirmation.setAttribute('role', 'group'); confirmation.setAttribute('aria-label', 'Confirm session watch');
      const note = document.createElement('p'); note.textContent = 'Save short response previews on your main agent and share them with opted-in G2 devices. Replies still require approval. Watching uses no model calls.';
      const confirm = document.createElement('button'); confirm.textContent = 'Start watching';
      const cancel = document.createElement('button'); cancel.textContent = 'Cancel';
      confirm.onclick = async () => { confirm.disabled = true; await setWatching(true); if (confirmation.isConnected) confirm.disabled = false; };
      cancel.onclick = () => { confirmation.remove(); watch.focus(); };
      confirmation.append(note, confirm, cancel); card.append(confirmation); confirm.focus();
    };
    actions.append(watch);
    if (session.route === 'builtin-cli' && session.status === 'interrupted') {
      const label = document.createElement('label');
      const check = document.createElement('input'); check.type = 'checkbox';
      label.append(check, ' I verified the previous provider process is stopped.');
      const release = document.createElement('button'); release.textContent = 'Release interrupted workspace'; release.disabled = true;
      check.onchange = () => { release.disabled = !check.checked; };
      release.onclick = async () => {
        release.disabled = true;
        try { await postJson('/coding-agents/reconcile', { provider: session.provider, sessionId: session.sessionId, confirmedStopped: check.checked }); await refresh(); }
        catch { $('codingStatus').textContent = 'Reconciliation failed. The workspace remains blocked.'; }
      };
      card.append(label, release);
    }
    if (session.route === 'builtin-cli' && session.status === 'working') {
      const stop = document.createElement('button'); stop.textContent = 'Stop managed run';
      stop.onclick = async () => {
        stop.disabled = true;
        try { await postJson('/coding-agents/stop', { provider: session.provider, sessionId: session.sessionId }); $('codingStatus').textContent = 'Stop requested. Refresh to confirm the process exited.'; }
        catch { $('codingStatus').textContent = 'Stop could not be confirmed. Inspect the session before retrying.'; stop.disabled = false; }
      };
      card.append(stop);
    }
    $('codingList').append(card);
  }
}

let codingInspectGeneration = 0;
async function inspectCodingAgent(session) {
  const generation = ++codingInspectGeneration;
  const detail = $('codingDetail');
  detail.replaceChildren();
  const heading = document.createElement('h3');
  heading.textContent = session.provider + ' · ' + session.sessionId;
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  status.textContent = 'Loading recent conversation…';
  detail.append(heading, status);
  try {
    const params = new URLSearchParams({ provider: session.provider, sessionId: session.sessionId });
    const data = await fetchJson('/coding-agents/session?' + params);
    if (generation !== codingInspectGeneration || !detail.isConnected) return;
    status.textContent = 'Recent conversation (reference only, not permission to act).';
    for (const turn of data.turns) {
      const block = document.createElement('pre');
      block.style.whiteSpace = 'pre-wrap';
      block.textContent = turn.role + ': ' + turn.text;
      detail.append(block);
    }
    if (!session.replyAvailable) {
      const note = document.createElement('p');
      note.textContent = 'This session must be answered in its owning app. OpenAGI will not kill or replace its active writer.';
      detail.append(note);
      return;
    }
    const label = document.createElement('label');
    label.textContent = 'Instruction or reply for this session';
    const input = document.createElement('textarea');
    input.rows = 4; input.maxLength = 4000; input.style.width = '100%';
    label.append(input);
    const submit = document.createElement('button');
    submit.textContent = 'Request approval to send';
    submit.onclick = async () => {
      if (!input.value.trim()) { status.textContent = 'Enter a reply first.'; return; }
      submit.disabled = true;
      try {
        const result = await postJson('/coding-agents/reply', { provider: session.provider, sessionId: session.sessionId, message: input.value });
        if (result.status !== 'awaiting_confirmation') throw new Error('Unexpected response');
        status.textContent = 'Queued for approval. Nothing has been sent yet.';
        const approvals = document.createElement('button');
        approvals.textContent = 'Open approval';
        approvals.onclick = () => switchTab('approvals');
        detail.append(approvals);
      } catch { status.textContent = 'Could not confirm that the request was queued. Check Approvals before trying again.'; submit.disabled = false; }
    };
    detail.append(label, submit);
  } catch { status.textContent = 'Could not inspect this session. Refresh the list; no reply was sent.'; }
}
`;
