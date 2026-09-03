export interface OpenAGIPhoneActions {
  pair(code: string): void
  ask(): void
  newConversation(): void
  unlink(): void
}

export class OpenAGIPhoneCompanion {
  private status: HTMLElement
  private detail: HTMLElement
  private pairSection: HTMLElement
  private actionsSection: HTMLElement

  constructor(actions: OpenAGIPhoneActions, origin: string) {
    const root = document.querySelector<HTMLDivElement>('#app')
    if (!root) throw new Error('Missing app root')
    root.innerHTML = `
      <main class="shell">
        <header><div class="brand">OpenAGI</div><div class="eyebrow">Even G2</div></header>
        <section class="card"><h1 id="status">Starting…</h1><p id="detail">Connecting to OpenAGI.</p></section>
        <section id="pair" class="pair">
          <label for="pair-code">Pairing code</label>
          <div class="pair-row"><input id="pair-code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000"><button id="pair-button">Pair G2</button></div>
          <p>Generate this code in OpenAGI → Nodes. Server: <code>${escapeHtml(origin)}</code></p>
        </section>
        <section id="actions" class="actions" hidden>
          <button data-action="ask">Ask OpenAGI</button><button data-action="newConversation">New conversation</button>
          <button class="secondary" data-action="unlink">Remove this G2 node</button>
        </section>
        <footer>The microphone opens only after you tap Ask. Question audio is transcribed transiently and is not saved by the G2 bridge.</footer>
      </main>`
    this.status = required(root.querySelector('#status'))
    this.detail = required(root.querySelector('#detail'))
    this.pairSection = required(root.querySelector('#pair'))
    this.actionsSection = required(root.querySelector('#actions'))
    const input = root.querySelector<HTMLInputElement>('#pair-code')
    root.querySelector('#pair-button')?.addEventListener('click', () => actions.pair(input?.value.trim() ?? ''))
    for (const name of ['ask', 'newConversation', 'unlink'] as const) root.querySelector(`[data-action="${name}"]`)?.addEventListener('click', () => actions[name]())
    injectStyles()
  }
  set(status: string, detail: string): void { this.status.textContent = status; this.detail.textContent = detail }
  paired(value: boolean): void { this.pairSection.hidden = value; this.actionsSection.hidden = !value }
}

function required(element: Element | null): HTMLElement { if (!(element instanceof HTMLElement)) throw new Error('Missing phone UI element'); return element }
function escapeHtml(value: string): string { return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character) }
function injectStyles(): void {
  const style = document.createElement('style')
  style.textContent = `
    :root{color-scheme:dark;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0d1110;color:#f5f7f5}*{box-sizing:border-box}
    body{margin:0;min-height:100vh;background:radial-gradient(circle at top,#17352a,#0d1110 48%)}.shell{width:min(620px,100%);margin:0 auto;padding:28px 20px;display:grid;gap:20px}
    header{display:flex;align-items:end;justify-content:space-between}.brand{font-size:24px;font-weight:760}.eyebrow{color:#72f5ac;text-transform:uppercase;letter-spacing:.15em;font-size:11px}
    .card,.pair{background:rgba(28,34,31,.94);border:1px solid #30443a;border-radius:18px;padding:24px}.card{min-height:140px}h1{font-size:24px;margin:0 0 12px}p,footer,label{color:#aab7b0;line-height:1.5}
    .pair-row{display:grid;grid-template-columns:1fr auto;gap:10px;margin-top:8px}input{min-width:0;border:1px solid #41564b;background:#111814;color:#fff;border-radius:12px;padding:14px;font:inherit;font-size:20px;letter-spacing:.2em}
    .actions{display:grid;grid-template-columns:1fr 1fr;gap:10px}button{appearance:none;border:1px solid #54f59c;background:#54f59c;color:#07120c;border-radius:12px;padding:14px;font:inherit;font-weight:750}
    button.secondary{grid-column:1/-1;background:transparent;color:#dde5e0;border-color:#41564b}footer{font-size:12px;text-align:center;padding:10px 24px}code{word-break:break-all;color:#d9eee2}`
  document.head.appendChild(style)
}
