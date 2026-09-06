import type { SpeechModel } from '../openagi/live-speech'

export interface OpenAGIPhoneActions {
  pair(code: string, origin: string): void
  ask(): void
  newConversation(): void
  unlink(): void
  connectAgent(origin: string, token: string): void
  configureAmbient(enabled: boolean, wakePhrase: string, answerQuestions: boolean): void
  selectAnswer?(index: number): void
  cancel?(): void
  previousPage?(): void
  nextPage?(): void
  recentAnswer?(): void
  exit?(): void
  configureSpeech?(model: SpeechModel, transport: 'relay' | 'direct'): void
  toggleDisplay?(): void
}

export class OpenAGIPhoneCompanion {
  private status: HTMLElement
  private detail: HTMLElement
  private pairSection: HTMLElement
  private actionsSection: HTMLElement

  constructor(actions: OpenAGIPhoneActions, allowedOrigins: string[]) {
    const root = document.querySelector<HTMLDivElement>('#app')
    if (!root) throw new Error('Missing app root')
    root.innerHTML = `
      <main class="shell">
        <header><div class="brand">Agents</div><div class="eyebrow">Even G2</div></header>
        <section class="card" role="status" aria-live="polite"><h1 id="status">Starting…</h1><p id="detail">Connecting to your agent.</p></section>
        <section id="pair" class="pair">
          <h2>Connect to your OpenAGI main</h2>
          <label for="agent-origin">Main server URL</label>
          <input id="agent-origin" type="url" autocomplete="off" placeholder="https://your-main.example.com" value="${escapeHtml(allowedOrigins[0] ?? '')}">
          <p>Use the machine that hosts your main, not another node. G2 will connect as a node. Choose ONE method below.</p>
          <h2>Option 1: Pair with a code</h2>
          <label for="pair-code">Pairing code</label>
          <div class="pair-row"><input id="pair-code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000"><button id="pair-button">Pair G2</button></div>
          <p>Generate this code on your main in OpenAGI → Nodes. No bearer token is needed for this option.</p>
          <details><summary>Option 2: Use an existing scoped token</summary>
          <label for="agent-token">Scoped bearer token</label>
          <input id="agent-token" type="password" autocomplete="off" placeholder="Paste token">
          <button id="agent-connect">Add agent</button>
          <p>No pairing code is needed for this option. Use a G2-scoped token from your main, never its owner token. Connection details stay in this app's local phone storage.</p></details>
        </section>
        <section id="actions" class="actions" hidden>
          <button data-action="ask">Ask agent</button><button data-action="newConversation">New conversation</button>
          <button id="cancel-request" hidden>Cancel request</button>
          <button id="last-answer">Last answer</button>
          <button id="previous-page">Previous page</button><button id="next-page">Next page</button>
          <button id="blank-display">Blank glasses display</button>
          <section class="ambient"><h2>Speech recognition</h2>
            <label for="speech-model">Speech model (not the agent's reasoning model)</label>
            <select id="speech-model"><option value="openai-buffered">OpenAI · buffered recording</option><option value="nova-3">Deepgram Nova 3 · live</option><option value="nova-2">Deepgram Nova 2 · live</option></select>
            <label for="speech-transport">Live speech connection</label>
            <select id="speech-transport"><option value="relay">Through OpenAGI main · standard key</option><option value="direct">Direct to Deepgram · Member key required</option></select>
            <p>Through main works with a regular Deepgram speech key. Audio is forwarded live, not saved or uploaded as a whole recording. Direct mode skips that network hop but needs permission to create temporary tokens. Neither mode stores your permanent Deepgram key on the phone.</p>
            <h2>Speech heard</h2><p id="live-transcript">Waiting for speech.</p><p id="speech-timing">Select Deepgram for live words, or OpenAI for transcription after recording.</p><h2>Activity</h2><ol id="activity-log"></ol></section>
          <section class="ambient"><h2>Recent answers</h2><p>Select an answer to resume its conversation. Stored on this phone; disconnect clears history.</p><div id="recent-answers"></div><p id="answer-preview"></p></section>
          <section class="ambient">
            <label><input id="ambient-enabled" type="checkbox"> Always listening while this app is open</label>
            <button id="ambient-retry">Retry listening</button>
            <label for="wake-phrase">Wake phrase</label><input id="wake-phrase" maxlength="40" value="open agi">
            <label><input id="answer-questions" type="checkbox" checked> Also answer clearly phrased questions</label>
            <p>While enabled, your speech provider receives all microphone audio, even before the wake phrase. OpenAGI does not save this audio. Provider retention terms apply. Blank display hides text only; it does not pause the microphone.</p>
          </section>
          <button class="secondary" data-action="unlink">Disconnect agent</button>
          <button class="secondary" id="exit-agents">Exit Agents (keep pairing)</button>
        </section>
        <footer>Tap-to-talk is the default. Always listening is optional, foreground-only, and can be paused from the phone or glasses. Audio is not saved by the G2 bridge.</footer>
      </main>`
    this.status = required(root.querySelector('#status'))
    this.detail = required(root.querySelector('#detail'))
    this.pairSection = required(root.querySelector('#pair'))
    this.actionsSection = required(root.querySelector('#actions'))
    const input = root.querySelector<HTMLInputElement>('#pair-code')
    const agentOrigin = root.querySelector<HTMLInputElement>('#agent-origin')
    const agentToken = root.querySelector<HTMLInputElement>('#agent-token')
    const ambient = root.querySelector<HTMLInputElement>('#ambient-enabled')
    const wakePhrase = root.querySelector<HTMLInputElement>('#wake-phrase')
    const answerQuestions = root.querySelector<HTMLInputElement>('#answer-questions')
    root.querySelector('#pair-button')?.addEventListener('click', () => actions.pair(input?.value.trim() ?? '', agentOrigin?.value.trim() ?? ''))
    root.querySelector('#agent-connect')?.addEventListener('click', () => {
      actions.connectAgent(agentOrigin?.value ?? '', agentToken?.value ?? '')
    })
    for (const name of ['ask', 'newConversation', 'unlink'] as const) root.querySelector(`[data-action="${name}"]`)?.addEventListener('click', () => actions[name]())
    root.querySelector('#cancel-request')?.addEventListener('click', () => actions.cancel?.())
    root.querySelector('#previous-page')?.addEventListener('click', () => actions.previousPage?.())
    root.querySelector('#next-page')?.addEventListener('click', () => actions.nextPage?.())
    root.querySelector('#last-answer')?.addEventListener('click', () => actions.recentAnswer?.())
    root.querySelector('#exit-agents')?.addEventListener('click', () => actions.exit?.())
    root.querySelector('#blank-display')?.addEventListener('click', () => actions.toggleDisplay?.())
    const configureSpeech = (): void => actions.configureSpeech?.(requiredSelect(root, '#speech-model').value as SpeechModel, requiredSelect(root, '#speech-transport').value as 'relay' | 'direct')
    root.querySelector('#speech-model')?.addEventListener('change', configureSpeech)
    root.querySelector('#speech-transport')?.addEventListener('change', configureSpeech)
    root.querySelector('#recent-answers')?.addEventListener('click', event => {
      const target = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button[data-answer]') : null
      if (target?.dataset.answer !== undefined) actions.selectAnswer?.(Number(target.dataset.answer))
    })
    const configure = (): void => actions.configureAmbient(ambient?.checked === true, wakePhrase?.value.trim() || 'open agi', answerQuestions?.checked === true)
    ambient?.addEventListener('change', configure)
    root.querySelector('#ambient-retry')?.addEventListener('click', () => actions.configureAmbient(true, wakePhrase?.value.trim() || 'open agi', answerQuestions?.checked === true))
    wakePhrase?.addEventListener('change', configure)
    answerQuestions?.addEventListener('change', configure)
    injectStyles()
  }
  set(status: string, detail: string): void {
    this.status.textContent = status; this.detail.textContent = detail
    const ask = this.actionsSection.querySelector<HTMLButtonElement>('[data-action="ask"]')
    if (ask) ask.textContent = /Opening microphone|Recording question/.test(status) ? 'Stop and send' : 'Ask agent'
    if (/failed|could not|check|not allowed/i.test(status)) this.status.scrollIntoView?.({ block: 'center' })
  }
  paired(value: boolean): void { this.pairSection.hidden = value; this.actionsSection.hidden = !value }
  requestActive(active: boolean): void {
    const cancel = this.actionsSection.querySelector<HTMLButtonElement>('#cancel-request')
    if (cancel) cancel.hidden = !active
    for (const selector of ['[data-action="ask"]', '[data-action="newConversation"]', '[data-action="unlink"]', '#last-answer', '#ambient-retry']) {
      const input = this.actionsSection.querySelector<HTMLButtonElement | HTMLInputElement>(selector)
      if (input) input.disabled = active
    }
  }
  transcript(text: string): void { const node = this.actionsSection.querySelector('#live-transcript'); if (node) node.textContent = text }
  speechModel(model: SpeechModel): void { const select = this.actionsSection.querySelector<HTMLSelectElement>('#speech-model'); if (select) select.value = model }
  speechTransport(transport: 'relay' | 'direct'): void { const select = this.actionsSection.querySelector<HTMLSelectElement>('#speech-transport'); if (select) select.value = transport }
  speechTiming(text: string): void { const node = this.actionsSection.querySelector('#speech-timing'); if (node) node.textContent = text }
  displaySleeping(sleeping: boolean): void {
    const button = this.actionsSection.querySelector('#blank-display')
    if (button) button.textContent = sleeping ? 'Wake display (or double-tap glasses)' : 'Blank glasses display'
  }
  activity(text: string): void {
    const list = this.actionsSection.querySelector('#activity-log')
    if (!list) return
    const item = document.createElement('li'); item.textContent = `${new Date().toLocaleTimeString()} · ${text}`
    list.prepend(item)
    while (list.children.length > 12) list.lastChild?.remove()
  }
  history(entries: { question: string; at: string }[]): void {
    const root = this.actionsSection.querySelector('#recent-answers')
    if (!root) return
    root.replaceChildren()
    entries.map((entry, index) => ({ ...entry, index })).reverse().forEach(entry => {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'recent-answer'
      button.dataset.answer = String(entry.index)
      const timestamp = document.createElement('time')
      const date = new Date(entry.at)
      if (!Number.isNaN(date.getTime())) {
        timestamp.dateTime = date.toISOString()
        timestamp.textContent = `${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} · ${date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`
      } else timestamp.textContent = 'Saved answer'
      const question = document.createElement('span')
      question.className = 'recent-question'
      question.textContent = entry.question
      const action = document.createElement('span')
      action.className = 'recent-resume'
      action.textContent = 'Resume conversation →'
      button.append(timestamp, question, action)
      root.append(button)
    })
  }
  preview(text: string): void { const root = this.actionsSection.querySelector('#answer-preview'); if (root) root.textContent = text }
  ambient(enabled: boolean, wakePhrase: string, answerQuestions: boolean): void {
    const enabledInput = document.querySelector<HTMLInputElement>('#ambient-enabled')
    const phraseInput = document.querySelector<HTMLInputElement>('#wake-phrase')
    const questionsInput = document.querySelector<HTMLInputElement>('#answer-questions')
    if (enabledInput) enabledInput.checked = enabled
    if (phraseInput) phraseInput.value = wakePhrase
    if (questionsInput) questionsInput.checked = answerQuestions
  }
}

function requiredSelect(root: HTMLElement, selector: string): HTMLSelectElement { const select = root.querySelector<HTMLSelectElement>(selector); if (!select) throw new Error('Missing speech selector'); return select }
function required(element: Element | null): HTMLElement { if (!(element instanceof HTMLElement)) throw new Error('Missing phone UI element'); return element }
function escapeHtml(value: string): string { return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character) }
function injectStyles(): void {
  const style = document.createElement('style')
  style.textContent = `
    [hidden]{display:none!important}
    :root{color-scheme:dark;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0d1110;color:#f5f7f5}*{box-sizing:border-box}
    body{margin:0;min-height:100vh;background:radial-gradient(circle at top,#17352a,#0d1110 48%)}.shell{width:min(620px,100%);margin:0 auto;padding:28px 20px;display:grid;gap:20px}
    header{display:flex;align-items:end;justify-content:space-between}.brand{font-size:24px;font-weight:760}.eyebrow{color:#72f5ac;text-transform:uppercase;letter-spacing:.15em;font-size:11px}
    .card,.pair{background:rgba(28,34,31,.94);border:1px solid #30443a;border-radius:18px;padding:24px}.card{min-height:140px}h1{font-size:24px;margin:0 0 12px}h2{font-size:18px;margin:0 0 14px}p,footer,label{color:#aab7b0;line-height:1.5}.divider{text-align:center;color:#718078;border-top:1px solid #30443a;margin:22px 0;padding-top:18px}
    .pair{display:grid;gap:10px}.pair-row{display:grid;grid-template-columns:1fr auto;gap:10px}input,select{min-width:0;border:1px solid #41564b;background:#111814;color:#fff;border-radius:12px;padding:14px;font:inherit}#pair-code{font-size:20px;letter-spacing:.2em}
    .actions{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.ambient{grid-column:1/-1;min-width:0;display:grid;gap:14px;background:rgba(28,34,31,.94);border:1px solid #30443a;border-radius:18px;padding:20px}.ambient h2{margin:0}.ambient input[type="checkbox"]{width:auto}.ambient p{font-size:13px;margin:0;overflow-wrap:anywhere}button{appearance:none;min-height:48px;border:1px solid #54f59c;background:#54f59c;color:#07120c;border-radius:12px;padding:14px;font:inherit;font-weight:650;line-height:1.4;overflow-wrap:anywhere}
    .actions>button:not([data-action="ask"]){background:#17241d;border-color:#3b5043;color:#e5eee8}
    button:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid #92ffc0;outline-offset:3px}button:disabled{opacity:.5;cursor:not-allowed}
    #recent-answers{display:grid;gap:12px;min-width:0}#recent-answers:empty{display:none}
    button.recent-answer{display:grid;gap:8px;width:100%;min-width:0;padding:16px;text-align:left;background:#121b16;border:1px solid #364d3e;color:#f0f5f1;font-size:15px;font-weight:500}
    .recent-answer time{font-size:12px;font-weight:400;color:#a4b6aa;line-height:1.4}.recent-question{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;overflow:hidden;overflow-wrap:anywhere;line-height:1.5;font-weight:600}.recent-resume{font-size:12px;font-weight:500;color:#8bd6a8}
    @media(hover:hover){button.recent-answer:hover{background:#1b2b21;border-color:#6d967b}}button.recent-answer:active{background:#243b2c;border-color:#8bd6a8}
    #answer-preview:not(:empty){border-top:1px solid #364d3e;padding-top:18px;margin-top:4px;font-size:14px;line-height:1.65;white-space:pre-wrap}#answer-preview:empty{display:none}
    @media(max-width:360px){.shell{padding:20px 14px}.ambient{padding:16px}button{padding:12px;font-size:14px}}
    button.secondary{grid-column:1/-1;background:transparent;color:#dde5e0;border-color:#41564b}footer{font-size:12px;text-align:center;padding:10px 24px}code{word-break:break-all;color:#d9eee2}`
  document.head.appendChild(style)
}
