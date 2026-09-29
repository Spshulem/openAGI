import { beforeEach, expect, it, vi } from 'vitest'
import { OpenAGIPhoneCompanion } from '../../ui/openagi-phone-companion'

beforeEach(() => { document.body.innerHTML = '<div id="app"></div>'; document.head.innerHTML = '' })

it('labels recovered drafts honestly and disables all review actions during a send', () => {
  const phone = new OpenAGIPhoneCompanion({ pair: vi.fn(), ask: vi.fn(), newConversation: vi.fn(), unlink: vi.fn(), connectAgent: vi.fn() }, [])
  phone.draft('Saved question', 'delivery')
  expect(document.querySelector('#draft-review h2')!.textContent).toContain('Delivery uncertain')
  expect(document.querySelector('#send-draft')!.textContent).toContain('may repeat actions')
  phone.requestActive(true)
  for (const id of ['send-draft', 'discard-draft', 'rerecord-draft']) expect(document.querySelector<HTMLButtonElement>(`#${id}`)!.disabled).toBe(true)
  phone.requestActive(false); phone.draft('Partial words', 'speech')
  expect(document.querySelector('#draft-review h2')!.textContent).toContain('may be incomplete')
  phone.draft('Normal text'); expect(document.querySelector('#draft-review h2')!.textContent).toBe('Review question · not sent')
})

it('offers exactly three glasses modes and reflects the saved one', () => {
  const configureHomeMode = vi.fn()
  const phone = new OpenAGIPhoneCompanion({ pair: vi.fn(), ask: vi.fn(), newConversation: vi.fn(), unlink: vi.fn(), connectAgent: vi.fn(), configureHomeMode }, [])
  phone.paired(true)
  const radios = [...document.querySelectorAll<HTMLInputElement>('input[name="home-mode"]')]
  expect(radios.map(r => r.value)).toEqual(['talk', 'lifelog', 'supervisor'])
  phone.homeMode('supervisor'); expect(radios.find(r => r.checked)?.value).toBe('supervisor')
  radios[1].click(); expect(configureHomeMode).toHaveBeenLastCalledWith('lifelog')
  for (const id of ['#idle-tap', '#lifelog-talk-mode', '#listening-mode', '#ambient-enabled', '#background-listening', '#memory-enabled', '#memory-resume']) expect(document.querySelector(id)).toBeNull()
})

it('shows the remembered consent box only in Lifelog and reports each change', () => {
  const recordingConsent = vi.fn()
  const phone = new OpenAGIPhoneCompanion({ pair: vi.fn(), ask: vi.fn(), newConversation: vi.fn(), unlink: vi.fn(), connectAgent: vi.fn(), recordingConsent }, [])
  phone.paired(true)
  const consent = document.querySelector<HTMLInputElement>('#recording-consent')!
  const card = document.querySelector<HTMLElement>('#lifelog-simple')!
  phone.homeMode('talk'); expect(getComputedStyle(card).display).toBe('none')
  phone.homeMode('lifelog'); expect(getComputedStyle(card).display).not.toBe('none')
  phone.recordingConsent(true); expect(consent.checked).toBe(true)
  // Switching layout keeps both the mode and the remembered consent.
  phone.interfaceStyle('classic'); phone.interfaceStyle('focused')
  expect(document.querySelector<HTMLInputElement>('#recording-consent')!.checked).toBe(true)
  expect(document.querySelector<HTMLElement>('#app')!.dataset.homeMode).toBe('lifelog')
  consent.click(); expect(recordingConsent).toHaveBeenLastCalledWith(false)
  consent.click(); expect(recordingConsent).toHaveBeenLastCalledWith(true)
})

it('one lifelog button pauses while listening and resumes otherwise', () => {
  const pauseLifelog = vi.fn(), resumeLifelog = vi.fn()
  const phone = new OpenAGIPhoneCompanion({ pair: vi.fn(), ask: vi.fn(), newConversation: vi.fn(), unlink: vi.fn(), connectAgent: vi.fn(), pauseLifelog, resumeLifelog }, [])
  const button = document.querySelector<HTMLButtonElement>('#pause-lifelog')!
  phone.lifelogState('consent'); expect(button.disabled).toBe(true)
  phone.lifelogState('listening'); expect(button.textContent).toBe('Pause listening'); button.click()
  expect(pauseLifelog).toHaveBeenCalledOnce()
  phone.lifelogState('paused'); expect(button.textContent).toBe('Resume listening'); button.click()
  phone.lifelogState('waiting', 'Main unreachable'); button.click()
  expect(resumeLifelog).toHaveBeenCalledTimes(2)
  expect(document.querySelector('#memory-status')!.textContent).toBe('Main unreachable')
})

it('provides peer pages and bounded, collapsed inbox details without hiding lifelog behind tasks', () => {
  const phone = new OpenAGIPhoneCompanion({ pair: vi.fn(), ask: vi.fn(), newConversation: vi.fn(), unlink: vi.fn(), connectAgent: vi.fn() }, [])
  phone.paired(true)
  expect(document.querySelectorAll('[data-page-link]')).toHaveLength(4)
  phone.inbox(Array.from({ length: 80 }, (_, i) => ({ id: String(i), title: `Task ${i}`, summary: 'Details', category: 'tasks', action: 'complete-task', important: false, seen: false })))
  expect(document.querySelectorAll('#proactive-items details:not([open])')).toHaveLength(80)
  expect(parseFloat(getComputedStyle(document.querySelector('#proactive-items')!).maxHeight)).toBeCloseTo(window.innerHeight * 0.55)
  document.querySelector<HTMLButtonElement>('#read-lifelog')!.click()
  expect(document.querySelector<HTMLElement>('#lifelog-panel')!.hidden).toBe(false)
  expect(document.querySelector<HTMLElement>('[data-page="inbox"]')!.hidden).toBe(true)
  phone.saveStatus('Saved on main at noon')
  expect(document.querySelector('#save-status')!.textContent).toBe('Saved on main at noon')
})

it('keeps Older and Previous bound to the submitted search, including offset zero', () => {
  const readLifelog = vi.fn()
  const phone = new OpenAGIPhoneCompanion({ pair: vi.fn(), ask: vi.fn(), newConversation: vi.fn(), unlink: vi.fn(), connectAgent: vi.fn(), readLifelog }, [])
  const input = document.querySelector<HTMLInputElement>('#lifelog-query')!
  input.value = 'first'; document.querySelector<HTMLButtonElement>('#lifelog-search')!.click()
  phone.lifelog({ nextOffset: 25 }); input.value = 'unsubmitted'
  document.querySelector<HTMLButtonElement>('#lifelog-next')!.click(); expect(readLifelog).toHaveBeenLastCalledWith('first', 25)
  document.querySelector<HTMLButtonElement>('#lifelog-previous')!.click(); expect(readLifelog).toHaveBeenLastCalledWith('first', 0)
  document.querySelector<HTMLButtonElement>('#lifelog-search')!.click(); expect(readLifelog).toHaveBeenLastCalledWith('unsubmitted', 0)
})

it('offers paired lifelog reading without a token link', () => {
  const readLifelog = vi.fn()
  const phone = new OpenAGIPhoneCompanion({ pair: vi.fn(), ask: vi.fn(), newConversation: vi.fn(), unlink: vi.fn(), connectAgent: vi.fn(), readLifelog }, [])
  phone.paired(true)
  document.querySelector<HTMLButtonElement>('#read-lifelog')?.click()
  expect(readLifelog).toHaveBeenCalledWith('', 0)
  phone.lifelog({ total: 1, moments: [{ id: 'one', at: 1, title: '<img src=x>', segments: [{ text: '<script>untrusted</script>' }] }] })
  expect(document.querySelector('#lifelog-moments img')).toBeNull()
  expect(document.querySelector('#lifelog-moments script')).toBeNull()
  expect(document.querySelector('#lifelog-moments')?.textContent).toContain('untrusted')
  expect(document.querySelector('#lifelog-panel a')).toBeNull()
  phone.paired(false); expect(document.querySelector('#lifelog-moments')?.textContent).toBe('')
})

it('deletes memory only after confirmation and renders inbox evidence safely', () => {
  const deleteMemory = vi.fn(), inboxAction = vi.fn()
  const phone = new OpenAGIPhoneCompanion({ pair: vi.fn(), ask: vi.fn(), newConversation: vi.fn(), unlink: vi.fn(), connectAgent: vi.fn(), deleteMemory, inboxAction }, [])
  expect(document.querySelector<HTMLInputElement>('#recording-consent')?.checked).toBe(false)
  phone.memoryStatus(false, 'Consent required')
  phone.inbox([{ id: 'candidate', title: '<img src=x>', summary: 'Unverified speaker', important: false, seen: false, action: 'accept-task', category: 'memory' }])
  expect(document.querySelector('#proactive-items img')).toBeNull()
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
  document.querySelector<HTMLButtonElement>('[data-inbox-op="accept-task"]')?.click()
  document.querySelector<HTMLButtonElement>('#delete-memory')?.click()
  expect(inboxAction).not.toHaveBeenCalled(); expect(deleteMemory).not.toHaveBeenCalled()
  confirm.mockReturnValue(true); document.querySelector<HTMLButtonElement>('[data-inbox-op="accept-task"]')?.click()
  expect(inboxAction).toHaveBeenCalledWith('accept-task', 'candidate')
  document.querySelector<HTMLButtonElement>('#delete-memory')?.click()
  expect(deleteMemory).toHaveBeenCalledOnce(); expect(inboxAction).not.toHaveBeenCalledWith('delete-memory')
  confirm.mockRestore()
  phone.mainInbox('https://main.example.test')
  expect(document.querySelector<HTMLAnchorElement>('#main-inbox')?.href).toBe('https://main.example.test/g2/proactive')
})

it('exposes auto-send and labels Talk and Stop according to the saved setting', () => {
  const configureAutoSend = vi.fn()
  const phone = new OpenAGIPhoneCompanion({ pair: vi.fn(), ask: vi.fn(), newConversation: vi.fn(), unlink: vi.fn(), connectAgent: vi.fn(), configureAutoSend }, [])
  phone.autoSend(true); phone.interaction('recording'); phone.set('Any translated status', '')
  expect(document.querySelector('[data-action="ask"]')?.textContent).toBe('Stop & send')
  document.querySelector<HTMLInputElement>('#auto-send')?.click()
  expect(configureAutoSend).toHaveBeenCalledWith(false)
  phone.autoSend(false)
  expect(document.querySelector('[data-action="ask"]')?.textContent).toBe('Stop & review')
  phone.interaction('idle'); phone.set('Ready', '')
  expect(document.querySelector('[data-action="ask"]')?.textContent).toBe('Talk')
})
function fixture() {
  const selectAnswer = vi.fn()
  const phone = new OpenAGIPhoneCompanion({ pair: vi.fn(), ask: vi.fn(), newConversation: vi.fn(), unlink: vi.fn(), connectAgent: vi.fn(), selectAnswer }, [])
  phone.paired(true)
  phone.history([
    { question: 'An earlier question', at: '2026-09-05T19:00:00Z' },
    { question: 'Can you help me plan my week?', at: '2026-09-05T20:00:00Z' },
  ])
  return { phone, selectAnswer }
}

it('renders distinct history cards with timestamps separate from questions', () => {
  fixture()
  const cards = document.querySelectorAll('#recent-answers button.recent-answer')
  expect(cards).toHaveLength(2)
  expect(cards[0].querySelector('time')?.getAttribute('datetime')).toBe('2026-09-05T20:00:00.000Z')
  expect(cards[0].querySelector('.recent-question')?.textContent).toBe('Can you help me plan my week?')
  expect(cards[0].querySelector('.recent-resume')?.textContent).toBe('Resume conversation →')
  expect(getComputedStyle(document.querySelector('#recent-answers')!).gap).toBe('12px')
  expect(getComputedStyle(cards[0]).textAlign).toBe('left')
})

it('preserves the correct history index when tapping a timestamp, question, or resume label', () => {
  const { selectAnswer } = fixture()
  for (const selector of ['time', '.recent-question', '.recent-resume']) {
    document.querySelector<HTMLElement>(`#recent-answers button ${selector}`)?.click()
    expect(selectAnswer).toHaveBeenLastCalledWith(1)
  }
  document.querySelectorAll<HTMLButtonElement>('#recent-answers button')[1].click()
  expect(selectAnswer).toHaveBeenLastCalledWith(0)
})

it('handles invalid timestamps and renders questions as text, not HTML', () => {
  const { phone } = fixture()
  phone.history([{ question: '<img src=x onerror=alert(1)>', at: 'invalid' }])
  expect(document.querySelector('#recent-answers img')).toBeNull()
  expect(document.querySelector('#recent-answers time')?.textContent).toBe('Saved answer')
  expect(document.querySelector('.recent-question')?.textContent).toContain('<img')
  phone.history([])
  expect(document.querySelectorAll('#recent-answers button')).toHaveLength(0)
})

it('shows a safe transcript review with explicit send, re-record and discard controls', () => {
  const sendDraft = vi.fn(), discardDraft = vi.fn(), rerecordDraft = vi.fn()
  const phone = new OpenAGIPhoneCompanion({ pair: vi.fn(), ask: vi.fn(), newConversation: vi.fn(), unlink: vi.fn(), connectAgent: vi.fn(), sendDraft, discardDraft, rerecordDraft }, [])
  phone.paired(true); phone.draft('<img src=x>'); phone.set('Review question · not sent', 'Tap to send')
  expect(document.querySelector('#draft-text')?.textContent).toBe('<img src=x>')
  expect(document.querySelector('#draft-text img')).toBeNull()
  for (const id of ['send-draft', 'rerecord-draft', 'discard-draft']) document.querySelector<HTMLButtonElement>(`#${id}`)?.click()
  expect(sendDraft).toHaveBeenCalledOnce(); expect(rerecordDraft).toHaveBeenCalledOnce(); expect(discardDraft).toHaveBeenCalledOnce()
  phone.draft(null)
  expect(document.querySelector<HTMLElement>('#draft-review')?.hidden).toBe(true)
})

it('answers a supervisor question from the phone with its fixed choices', async () => {
  const answerQuestion = vi.fn().mockResolvedValue({ ok: true, detail: 'sent' })
  const inboxAction = vi.fn()
  const phone = new OpenAGIPhoneCompanion({ pair: vi.fn(), ask: vi.fn(), newConversation: vi.fn(), unlink: vi.fn(), connectAgent: vi.fn(), answerQuestion, inboxAction }, [])
  phone.inbox([{ id: 'q1', title: '#6522 ready. Merge?', summary: 'CI green', important: true, seen: false, action: 'answer-fleet', category: 'approvals', supervisor: true, options: ['merged', 'later'] }])
  const buttons = [...document.querySelectorAll<HTMLButtonElement>('#proactive-items button[data-answer]')].map(b => b.textContent)
  expect(buttons).toEqual(['merged', 'later'])
  expect(document.querySelector('#proactive-items')?.textContent).not.toContain('approve any actions on your main')
  document.querySelector<HTMLButtonElement>('button[data-answer="later"]')?.click()
  expect(answerQuestion).toHaveBeenCalledWith('q1', 'later')
  await Promise.resolve(); await Promise.resolve()
  expect(document.querySelector('.answer-status')?.textContent).toBe('Sent: later.')
  expect(inboxAction).not.toHaveBeenCalled()
})
