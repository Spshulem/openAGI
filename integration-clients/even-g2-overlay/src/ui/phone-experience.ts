// Layout only: move the existing controls and listeners, do not replace audio,
// consent, credentials or navigation state when comparing interfaces.
export class PhoneExperience {
  private restores: (() => void)[] = []
  private focused: HTMLElement | null = null
  constructor(private readonly root: HTMLElement, private readonly show: (page: string) => void) {}
  set(style: 'focused' | 'classic'): void {
    for (const restore of this.restores.reverse()) restore()
    this.restores = []; this.focused?.remove(); this.focused = null
    this.root.dataset.experience = style
    const legacy = this.root.querySelector<HTMLElement>('.page-nav')
    if (legacy) legacy.hidden = style === 'focused'
    if (style === 'classic') { this.show('listen'); return }
    const actions = this.root.querySelector<HTMLElement>('#actions')!
    const focused = document.createElement('div'); focused.id = 'focused-experience'; this.focused = focused
    focused.innerHTML = `<nav class="experience-nav" aria-label="Main navigation"><button data-destination="talk">Talk</button><button data-destination="inbox">Inbox</button><button data-destination="history">History</button><button data-destination="settings" aria-label="Settings">⚙</button></nav>
      <section data-page="talk" class="talk-page"><div id="talk-primary"></div><div id="talk-result"></div><details id="talk-activity"><summary>Activity</summary></details><section id="lifelog-simple" class="ambient"><h2>Lifelog</h2><p>Keep a quiet record. Ask only when you choose.</p><div id="lifelog-primary"></div></section></section>
      <section data-page="history" class="history-page"><h2>History</h2><p>Your conversations and saved moments.</p><div id="history-destinations"></div><div id="history-main"></div><div id="history-local"></div></section>
      <section data-page="settings" class="settings-page"><h2>Settings</h2><div id="settings-content"></div></section>`
    actions.prepend(focused)
    const move = (selector: string, destination: string): void => {
      const node = this.root.querySelector<HTMLElement>(selector), target = focused.querySelector(destination)
      if (!node || !target) return
      const anchor = document.createComment('classic position'); node.before(anchor); target.append(node)
      this.restores.push(() => { anchor.replaceWith(node) })
    }
    const moveLabel = (id: string, destination: string): void => {
      const node = this.root.querySelector<HTMLElement>(`#${id}`)?.closest('label')
      if (!node) return
      node.dataset.controlLabel = id; move(`[data-control-label="${id}"]`, destination)
    }
    for (const selector of ['[data-action="ask"]', '#cancel-request', '#pending-question', '#draft-review', '[data-action="newConversation"]']) move(selector, '#talk-primary')
    for (const selector of ['#live-transcript', '#speech-timing', '#answer-preview', '#previous-page', '#next-page']) move(selector, '#talk-result')
    move('#activity-log', '#talk-activity')
    for (const id of ['memory-enabled', 'recording-consent']) moveLabel(id, '#lifelog-primary')
    for (const selector of ['#memory-status', '#save-status', '#memory-resume', '#pause-lifelog', '#mark-moment']) move(selector, '#lifelog-primary')
    move('#history-controls', '#history-main'); move('#main-history', '#history-main')
    move('#recent-answers', '#history-local'); move('#read-lifelog', '#history-destinations')
    // Advanced cards remain intact, and restore to their exact Classic position.
    for (const panel of [...actions.querySelectorAll<HTMLElement>(':scope > [data-page="listen"]')]) {
      const page = panel.dataset.page; panel.dataset.page = 'settings'
      this.restores.push(() => { panel.dataset.page = page })
    }
    for (const selector of ['#connection-readiness', '#blank-display', '[data-action="unlink"]', '#exit-agents']) {
      move(selector, '#settings-content')
    }
    const recent = actions.querySelector<HTMLElement>(':scope > [data-page="recent"]')
    if (recent) { recent.hidden = true; this.restores.push(() => { recent.hidden = false }) }
    for (const button of focused.querySelectorAll<HTMLButtonElement>('[data-destination]')) button.addEventListener('click', () => {
      const page = button.dataset.destination!
      this.show(page)
      for (const b of focused.querySelectorAll('nav button')) b.setAttribute('aria-pressed', String(b === button))
    })
    this.show('talk')
    focused.querySelector('nav button')?.setAttribute('aria-pressed', 'true')
  }
}

export const experienceStyles = `
  [data-experience="focused"]{--ink:#e9edef;--muted:#a4b0b9;color:var(--ink)}
  [data-experience="focused"] .brand{font-size:22px;letter-spacing:-.035em}
  [data-experience="focused"] .eyebrow{color:var(--muted);letter-spacing:.06em}
  [data-experience="focused"] .card,[data-experience="focused"] .ambient,[data-experience="focused"] .pair{background:#192127;border:1px solid #334049;box-shadow:none}
  [data-experience="focused"] p,[data-experience="focused"] label{color:var(--muted)}
  #focused-experience{display:contents}.talk-page,.history-page,.settings-page{display:grid;gap:20px;grid-column:1/-1}
  .experience-nav{grid-column:1/-1;display:grid;grid-template-columns:1fr 1fr 1fr 48px;gap:6px;position:sticky;top:0;background:#10171c;z-index:3;padding:10px 0}
  [data-experience="focused"] button{background:#263943;border-color:#415766;color:#e9edef;cursor:pointer;font-weight:550}
  [data-experience="focused"] button[aria-pressed="true"],[data-experience="focused"] [data-action="ask"]{background:#e8eef2;color:#15232c;border-color:#e8eef2}
  #talk-primary{display:grid;grid-template-columns:1fr 1fr;gap:12px}#talk-primary [data-action="ask"]{grid-column:1/-1;min-height:76px;font-size:22px}
  #talk-primary #draft-review,#talk-primary #pending-question{grid-column:1/-1}
  #talk-primary [data-action="newConversation"]{background:transparent;grid-column:1/-1}
  #talk-result{display:grid;grid-template-columns:1fr 1fr;gap:12px}#talk-result p{grid-column:1/-1;white-space:pre-wrap;line-height:1.6;overflow-wrap:anywhere}
  #talk-result #answer-preview{max-height:40vh;overflow:auto;margin:0;padding:18px 0}
  #talk-activity{border-top:1px solid #334049;padding:14px 0;font-size:14px}
  #lifelog-primary,#settings-content,#history-main,#main-history,#history-controls{display:grid;gap:14px;min-width:0}
  #lifelog-primary label{display:flex;gap:12px;align-items:center;min-height:44px}
  [data-experience="focused"] #lifelog-primary:has(#memory-enabled:not(:checked)) #save-status{display:none}
  #lifelog-primary input[type=checkbox]{width:22px;height:22px;flex-shrink:0;accent-color:#abc8dc}
  #main-history{max-height:55vh;overflow:auto;overscroll-behavior:contain}
  #main-history button{text-align:left;display:grid;gap:8px}#main-history p{white-space:pre-wrap}
  [data-experience="focused"] footer,[data-experience="focused"] #last-answer{display:none}
  [data-experience="focused"] .ambient{padding:20px;gap:16px}
  [data-experience="focused"] .ambient details{border-top:1px solid #334049;padding-top:16px}
  [data-experience="focused"] .ambient>label{display:grid;gap:8px}
  [data-experience="focused"] .ambient>label:has(input[type=checkbox]){display:flex;align-items:center;gap:12px;min-height:44px}
  [data-experience="focused"] :focus-visible{outline:3px solid #b9d8ed;outline-offset:3px}
  .interface-switch{display:flex;align-items:center;gap:10px;font-size:12px}.interface-switch select{padding:8px;min-height:44px}
  #connection-card{min-height:100px;width:100%;font:inherit;padding:14px;background:#111b23;color:#edf4fa;border:1px solid #516573;border-radius:12px}
  #connection-readiness{grid-column:1/-1;line-height:1.6;white-space:pre-wrap;font-size:14px}
  @media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important}}
  @media(max-width:360px){.experience-nav button{padding:9px 4px;font-size:13px}.shell{padding:18px 14px}}
`
