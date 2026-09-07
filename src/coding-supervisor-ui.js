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
  $('codingStatus').textContent = snapshot.error || snapshot.warning || (snapshot.configured ? 'Checked ' + new Date(snapshot.checkedAt).toLocaleTimeString() : 'Set up the built-in supervisor below. No separate supervisor or G2 installation is required.');
  $('codingRefresh').onclick = renderCodingAgents;
  const setupPanel = document.createElement('section');
  $('codingList').before(setupPanel);
  void renderCodingSetup(setupPanel);
  const watchNote = document.createElement('p');
  watchNote.textContent = 'Watch selected sessions for new responses or attention. Short output previews are saved on main and shared with opted-in G2 devices (Discoveries). No automatic nudges or paid model polling. Stop watching does not delete existing outreach history.';
  $('codingList').before(watchNote);
  for (const watch of snapshot.watches || []) {
    if (!watch.active || !(snapshot.sessions || []).some(s => s.provider === watch.provider && s.sessionId === watch.sessionId)) {
      const note = document.createElement('p');
      note.textContent = watch.provider + ' · ' + watch.sessionId + ': watch paused; ' + (watch.active ? 'session is not visible. Missing sessions are not treated as complete.' : 'switch back to its coding node to manage this watch.');
      if (watch.active) {
        const stop = document.createElement('button'); stop.textContent = 'Stop watching';
        stop.onclick = async () => { try { await postJson('/coding-agents/watch', { ...watch, enabled: false }); await renderCodingAgents(); } catch { stop.textContent = 'Could not stop watch. Retry'; } };
        note.append(stop);
      }
      $('codingList').before(note);
    }
  }
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
    const watching = (snapshot.watches || []).some(w => w.active && w.provider === session.provider && w.sessionId === session.sessionId);
    const watch = document.createElement('button'); watch.textContent = watching ? 'Stop watching' : 'Watch session';
    watch.disabled = Boolean(snapshot.error);
    watch.onclick = async () => {
      if (!watching && !confirm('Watch this session and save short output previews on main, visible to opted-in G2 devices? Replies will still require approval.')) return;
      watch.disabled = true;
      try { await postJson('/coding-agents/watch', { provider: session.provider, sessionId: session.sessionId, enabled: !watching }); await renderCodingAgents(); }
      catch { $('codingStatus').textContent = 'Could not change this watch. Refresh and retry (20 watches maximum).'; watch.disabled = false; }
    };
    card.append(watch);
    if (session.route === 'builtin-cli' && session.status === 'interrupted') {
      const label = document.createElement('label');
      const check = document.createElement('input'); check.type = 'checkbox';
      label.append(check, ' I verified the previous provider process is stopped.');
      const release = document.createElement('button'); release.textContent = 'Release interrupted workspace'; release.disabled = true;
      check.onchange = () => { release.disabled = !check.checked; };
      release.onclick = async () => {
        release.disabled = true;
        try { await postJson('/coding-agents/reconcile', { provider: session.provider, sessionId: session.sessionId, confirmedStopped: check.checked }); await renderCodingAgents(); }
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
  if (snapshot.configured && !snapshot.error && !snapshot.sessions.length) $('codingStatus').textContent += ' · No sessions reported.';
  const params = new URLSearchParams(window.location.search);
  const selected = (snapshot.sessions || []).find(s => s.provider === params.get('provider') && s.sessionId === params.get('sessionId'));
  if (selected && !snapshot.error) void inspectCodingAgent(selected);
}

async function renderCodingSetup(panel) {
  try {
    const setup = await fetchJson('/coding-agents/setup');
    if (!panel.isConnected) return;
    if (setup.external) { panel.textContent = 'Using the optional external supervisor adapter. See the setup guide to switch to the built-in supervisor.'; return; }
    const details = document.createElement('details'); details.open = !setup.enabled;
    const summary = document.createElement('summary'); summary.textContent = 'Setup and provider requirements'; details.append(summary);
    const requirements = document.createElement('p');
    requirements.textContent = (setup.providers || []).map(p => p.provider + ': ' + (p.installed ? 'CLI found; sign-in not yet verified' : 'install the official CLI first') + ' · ' + p.loginCommand).join(' — ');
    const limits = document.createElement('p'); limits.textContent = setup.limitation;
    const label = document.createElement('label'); label.textContent = 'Git project folders (absolute paths, one per line; replaces the selected list)';
    const folders = document.createElement('textarea'); folders.rows = 3; folders.style.width = '100%'; label.append(folders);
    const save = document.createElement('button'); save.textContent = 'Save folders and enable';
    const status = document.createElement('p'); status.setAttribute('role', 'status');
    save.onclick = async () => {
      save.disabled = true;
      try { await postJson('/coding-agents/configure', { enabled: true, workspaces: folders.value.split('\n').map(x => x.trim()).filter(Boolean) }); await renderCodingAgents(); }
      catch { status.textContent = 'Could not save setup. Choose existing absolute Git project paths and stop managed runs first.'; save.disabled = false; }
    };
    details.append(requirements, limits, label, save, status); panel.append(details);
    if (!setup.enabled) return;
    const off = document.createElement('button'); off.textContent = 'Disable built-in supervisor';
    off.onclick = async () => { try { await postJson('/coding-agents/configure', { enabled: false }); await renderCodingAgents(); } catch { status.textContent = 'Stop managed runs before disabling.'; } };
    details.append(off);
    const form = document.createElement('section');
    const addSelect = (title, options) => {
      const label = document.createElement('label'); label.textContent = title + ' ';
      const select = document.createElement('select');
      for (const option of options) { const node = document.createElement('option'); node.value = option.value; node.textContent = option.label; select.append(node); }
      label.append(select); form.append(label); return select;
    };
    const provider = addSelect('Provider', (setup.providers || []).filter(p => p.installed).map(p => ({ value: p.provider, label: p.provider })));
    const workspace = addSelect('Workspace', setup.workspaces.map(w => ({ value: w.id, label: w.label })));
    const effort = addSelect('Reasoning effort', ['low', 'medium', 'high'].map(x => ({ value: x, label: x }))); effort.value = 'medium';
    const modelLabel = document.createElement('label'); modelLabel.textContent = 'Model (optional provider model ID)';
    const model = document.createElement('input'); model.maxLength = 100; modelLabel.append(model); form.append(modelLabel);
    const instructionLabel = document.createElement('label'); instructionLabel.textContent = 'Instruction for a new managed session';
    const instruction = document.createElement('textarea'); instruction.rows = 4; instruction.maxLength = 4000; instruction.style.width = '100%'; instructionLabel.append(instruction); form.append(instructionLabel);
    const start = document.createElement('button'); start.textContent = 'Review start approval'; start.disabled = !provider.value || !workspace.value;
    const result = document.createElement('p'); result.setAttribute('role', 'status');
    start.onclick = async () => {
      if (!instruction.value.trim()) { result.textContent = 'Enter an instruction first.'; return; }
      start.disabled = true;
      try {
        const queued = await postJson('/coding-agents/start', { provider: provider.value, workspaceId: workspace.value, effort: effort.value, model: model.value.trim(), message: instruction.value });
        if (queued.status !== 'awaiting_confirmation') throw new Error('Unexpected response');
        switchTab('approvals');
      } catch { result.textContent = 'Start was not confirmed. Check Approvals before trying again.'; start.disabled = false; }
    };
    form.append(start, result); panel.append(form);
  } catch { if (panel.isConnected) panel.textContent = 'Setup could not be loaded. Refresh when OpenAGI is online.'; }
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
