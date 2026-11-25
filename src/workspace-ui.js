// Shared recovery copy for the desktop's main-backed views. Never substitute
// an empty local queue for a failed request to the user's agent.
async function renderWorkspaceUnavailable(title, error, retry) {
  const view = state.tab;
  const pane = document.createElement('div'); pane.className = 'pane';
  const heading = document.createElement('h2'); heading.textContent = title;
  const message = document.createElement('p'); message.setAttribute('role', 'status');
  const reconnect = error?.code === 'main-pairing-required';
  message.textContent = reconnect
    ? 'This desktop needs to reconnect to your agent. Your phone connection and saved work are unchanged.'
    : 'This view could not be loaded. Your saved work has not been changed.';
  const again = document.createElement('button'); again.className = 'ui-btn'; again.textContent = 'Try again';
  again.onclick = retry;
  pane.append(heading, message, again); main.replaceChildren(pane);
  if (!reconnect) return;
  const help = document.createElement('p');
  help.textContent = 'This Mac is still paired and its heartbeat can reach main, but desktop workspace authorization needs an owner decision. Run `openagi reconnect` on this Mac and approve the short-lived request from an already paired owner phone. No phone code or owner token is needed.';
  pane.append(help);
  try {
    const nodes = await fetchJson('/nodes');
    if (!pane.isConnected || state.tab !== view) return;
    const href = safeLinkHref(nodes.pairedTo);
    if (href) {
      const link = document.createElement('a'); link.href = href;
      link.textContent = 'Open your connected agent'; link.target = '_blank'; link.rel = 'noopener noreferrer';
      pane.append(link);
    }
  } catch { /* Phone settings remain a recovery path if discovery is offline. */ }
}

function renderSupervisor() {
  // Use the complete, shared Supervisor view directly. The workspace keeps
  // frame-src and frame-ancestors disabled rather than embedding trusted UI.
  window.location.href = '/fleet';
}

export const workspaceUi = [renderWorkspaceUnavailable, renderSupervisor].map(fn => fn.toString()).join('\n');
