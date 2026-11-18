import { codingSessionUi } from "./coding-session-ui.js";

// Kept separate so the script can be syntax-checked without a browser or model.
export const codingSupervisorUi = codingSessionUi + String.raw`
let codingRenderGeneration = 0;
async function renderCodingAgents() {
  const generation = ++codingRenderGeneration;
  main.innerHTML = '<div class="pane coding-pane"><h2>Coding setup</h2><p>Loading coding tools…</p></div>';
  let snapshot;
  try {
    const response = await fetch('/coding-agents');
    if (!response.ok && response.status !== 503) throw new Error('unavailable');
    snapshot = await response.json();
  }
  catch { snapshot = { error: 'Could not reach the supervisor. No session was changed.', sessions: [] }; }
  if (generation !== codingRenderGeneration || state.tab !== 'coding-agents') return;
  main.innerHTML = '<div class="pane coding-pane"><div class="row between"><h2>Coding setup</h2><button id="codingRefresh">Refresh</button></div><p>Connect a coding tool, choose a project, then review the first run. <a href="/fleet">Open Supervisor</a> to inspect and watch your sessions.</p><p id="codingStatus" role="status"></p><div class="grid" id="codingList"></div><section id="codingDetail"></section></div>';
  $('codingStatus').textContent = snapshot.error || snapshot.warning || (snapshot.configured ? 'Checked ' + new Date(snapshot.checkedAt).toLocaleTimeString() : 'Set up the built-in supervisor below. No separate supervisor or G2 installation is required.');
  $('codingRefresh').onclick = renderCodingAgents;
  const setupPanel = document.createElement('section');
  $('codingList').before(setupPanel);
  void renderCodingSetup(setupPanel);
  renderCodingSessionCards(snapshot, renderCodingAgents);
  if (snapshot.configured && !snapshot.error && !snapshot.sessions.length) $('codingStatus').textContent += ' · No sessions reported.';
  const params = new URLSearchParams(window.location.search);
  const selected = (snapshot.sessions || []).find(s => s.provider === params.get('provider') && s.sessionId === params.get('sessionId'));
  if (selected && !snapshot.error) void inspectCodingAgent(selected);
}

async function renderCodingSetup(panel) {
  try {
    const setup = await fetchJson('/coding-agents/setup');
    if (!panel.isConnected) return;
    const guide = document.createElement('a');
    guide.href = 'https://github.com/Spshulem/openAGI/blob/main/docs/setup/coding-supervisor.md';
    guide.target = '_blank'; guide.rel = 'noopener noreferrer'; guide.textContent = 'Open coding-agent setup guide';
    panel.append(guide);
    if (setup.external) { const note = document.createElement('p'); note.textContent = 'Using the optional external supervisor adapter. See the setup guide to switch to the built-in supervisor.'; panel.append(note); return; }
    const details = document.createElement('details'); details.open = !setup.enabled;
    const summary = document.createElement('summary'); summary.textContent = '1. Connect your coding tool and project'; details.append(summary);
    const requirements = document.createElement('p');
    requirements.textContent = (setup.providers || []).map(p => p.provider + ': ' + (p.lastSuccessfulRunAt ? 'responded successfully on ' + new Date(p.lastSuccessfulRunAt).toLocaleDateString() : p.installed ? 'CLI found; sign in before the first run' : 'install the official CLI first') + ' · ' + p.loginCommand).join(' — ');
    const limits = document.createElement('details'); const limitsTitle = document.createElement('summary'); limitsTitle.textContent = 'Permissions and billing'; const limitsText = document.createElement('p'); limitsText.textContent = setup.limitation; limits.append(limitsTitle, limitsText);
    const saved = setup.workspaces || [];
    const current = document.createElement('p');
    current.textContent = saved.length ? 'Saved projects: ' + saved.map(w => w.label).join(', ') : 'No projects selected yet.';
    const location = document.createElement('p'); location.textContent = 'Use Codex CLI or Claude Code on the computer running OpenAGI. Sign in there with the command below. This login is separate from your chat API key. For a remote coding node, use that computer’s project paths.';
    const label = document.createElement('label'); label.textContent = 'Git project folders';
    const folders = document.createElement('textarea'); folders.rows = 3; folders.placeholder = '/Users/you/Projects/my-app or C:\\Users\\you\\Projects\\my-app'; folders.style.width = '100%'; label.append(folders);
    const save = document.createElement('button');
    const updateSave = () => { save.textContent = folders.value.trim() ? 'Replace folders and enable' : saved.length ? 'Keep saved folders and enable' : 'Save folders and enable'; };
    folders.oninput = updateSave; updateSave();
    const status = document.createElement('p'); status.setAttribute('role', 'status');
    save.onclick = async () => {
      const paths = folders.value.split('\n').map(x => x.trim()).filter(Boolean);
      if (!paths.length && !saved.length) { status.textContent = 'Choose at least one existing Git project folder first.'; return; }
      save.disabled = true;
      try { await postJson('/coding-agents/configure', { enabled: true, ...(paths.length ? { workspaces: paths } : {}) }); await renderCodingAgents(); }
      catch { status.textContent = 'Could not save setup. Choose existing absolute Git project paths and stop managed runs first.'; save.disabled = false; }
    };
    const pathHelp = document.createElement('p'); pathHelp.textContent = 'Enter existing absolute paths, one per line. This replaces the saved list; leave blank to keep your projects.';
    details.append(location, requirements, current, label, pathHelp, save, status, limits); panel.append(details);
    if (!setup.enabled) return;
    const off = document.createElement('button'); off.textContent = 'Disable built-in supervisor';
    off.onclick = async () => { try { await postJson('/coding-agents/configure', { enabled: false }); await renderCodingAgents(); } catch { status.textContent = 'Stop managed runs before disabling.'; } };
    details.append(off);
    if (!(setup.providers || []).some(p => p.installed) || !saved.length) {
      const blocked = document.createElement('p'); blocked.setAttribute('role', 'status');
      blocked.textContent = !saved.length ? 'Choose a Git project folder before starting an agent.' : 'No provider CLI found. Install Claude Code or Codex, sign in on the supervisor computer, then Refresh. No agent can start yet.';
      panel.append(blocked); return;
    }
    const form = document.createElement('details'); form.open = true;
    const formTitle = document.createElement('summary'); formTitle.textContent = '2. Start a coding session'; form.append(formTitle);
    const advanced = document.createElement('details');
    const advancedTitle = document.createElement('summary'); advancedTitle.textContent = 'Advanced options'; advanced.append(advancedTitle);
    const addSelect = (title, options, parent = form) => {
      const label = document.createElement('label'); label.textContent = title + ' ';
      const select = document.createElement('select');
      for (const option of options) { const node = document.createElement('option'); node.value = option.value; node.textContent = option.label; select.append(node); }
      label.append(select); parent.append(label); return select;
    };
    const workspace = addSelect('Project', saved.map(w => ({ value: w.id, label: w.label })));
    const provider = addSelect('Coding tool', (setup.providers || []).filter(p => p.installed).map(p => ({ value: p.provider, label: p.provider })));
    const effort = addSelect('Reasoning effort', ['low', 'medium', 'high'].map(x => ({ value: x, label: x })), advanced); effort.value = 'medium';
    const modelLabel = document.createElement('label'); modelLabel.textContent = 'Model (optional provider model ID)';
    const model = document.createElement('input'); model.maxLength = 100; modelLabel.append(model); advanced.append(modelLabel); form.append(advanced);
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
    const billing = document.createElement('p'); billing.textContent = 'Review the project and permissions before running. Coding CLI usage is billed separately from your OpenAGI chat budget.';
    form.append(billing, start, result); panel.append(form);
  } catch { if (panel.isConnected) panel.textContent = 'Setup could not be loaded. Refresh when OpenAGI is online.'; }
}

`;
