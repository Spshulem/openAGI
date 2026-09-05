// Kept separate so the script can be syntax-checked without a browser or model.
export const codingSupervisorUi = String.raw`
let codingRenderGeneration = 0;
async function renderCodingAgents() {
  const generation = ++codingRenderGeneration;
  main.innerHTML = '<div class="pane"><h2>Coding Agents</h2><p>Loading supervisor status…</p></div>';
  let snapshot;
  try {
    const response = await fetch('/coding-agents');
    if (!response.ok && response.status !== 503) throw new Error('unavailable');
    snapshot = await response.json();
  }
  catch { snapshot = { error: 'Could not reach the supervisor. No session was changed.', sessions: [] }; }
  if (generation !== codingRenderGeneration || state.tab !== 'coding-agents') return;
  main.innerHTML = '<div class="pane"><div class="row between"><h2>Coding Agents</h2><button id="codingRefresh">Refresh</button></div><p>Talk to OpenAGI; it coordinates your existing coding sessions. Replies require approval. Reported activity is not proof of completion.</p><p id="codingStatus" role="status"></p><div class="grid" id="codingList"></div><section id="codingDetail"></section></div>';
  $('codingStatus').textContent = snapshot.error || (snapshot.configured ? 'Checked ' + new Date(snapshot.checkedAt).toLocaleTimeString() : 'Not connected. Configure OPENAGI_CODING_SUPERVISOR_DIR using docs/setup/coding-supervisor.md. No extra AI supervisor is required.');
  $('codingRefresh').onclick = renderCodingAgents;
  for (const session of snapshot.sessions || []) {
    const card = document.createElement('div');
    card.className = 'card';
    const title = document.createElement('h3');
    title.textContent = session.project || session.label || 'Coding session';
    const info = document.createElement('p');
    info.textContent = session.provider + ' · ' + session.status + ' · ' + session.attentionBasis + (session.model ? ' · ' + session.model : ' · model not reported');
    const id = document.createElement('code');
    id.textContent = session.sessionId;
    id.style.overflowWrap = 'anywhere';
    const open = document.createElement('button');
    open.textContent = 'Inspect / reply';
    open.onclick = () => inspectCodingAgent({ ...session, replyAvailable: session.replyAvailable && !snapshot.error });
    card.append(title, info, id, document.createElement('br'), open);
    $('codingList').append(card);
  }
  if (snapshot.configured && !snapshot.error && !snapshot.sessions.length) $('codingStatus').textContent += ' · No sessions in the last 24 hours.';
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
