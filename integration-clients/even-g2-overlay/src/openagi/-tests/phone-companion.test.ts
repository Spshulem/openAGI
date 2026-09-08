import { beforeEach, expect, it, vi } from 'vitest'
import { OpenAGIPhoneCompanion } from '../../ui/openagi-phone-companion'

beforeEach(() => { document.body.innerHTML = '<div id="app"></div>'; document.head.innerHTML = '' })

it('offers a separate persisted lifelog hold mode without changing auto-send', () => {
  const configureLifelogTalkMode = vi.fn(), configureAutoSend = vi.fn()
  const phone = new OpenAGIPhoneCompanion({ pair: vi.fn(), ask: vi.fn(), newConversation: vi.fn(), unlink: vi.fn(), connectAgent: vi.fn(), configureAmbient: vi.fn(), configureLifelogTalkMode, configureAutoSend }, [])
  const select = document.querySelector<HTMLSelectElement>('#lifelog-talk-mode')!
  phone.lifelogTalkMode('hold'); expect(select.value).toBe('hold')
  select.dispatchEvent(new Event('change'))
  expect(configureLifelogTalkMode).toHaveBeenCalledWith('hold'); expect(configureAutoSend).not.toHaveBeenCalled()
})

it('resumes lifelog with current explicit consent and disables duplicate requests while starting', () => {
  const returnToLifelog = vi.fn()
  const phone = new OpenAGIPhoneCompanion({ pair: vi.fn(), ask: vi.fn(), newConversation: vi.fn(), unlink: vi.fn(), connectAgent: vi.fn(), configureAmbient: vi.fn(), returnToLifelog }, [])
  const resume = document.querySelector<HTMLButtonElement>('#memory-resume')!
  resume.click(); expect(returnToLifelog).toHaveBeenLastCalledWith(false)
  document.querySelector<HTMLInputElement>('#recording-consent')!.click()
  resume.click(); expect(returnToLifelog).toHaveBeenLastCalledWith(true)
  returnToLifelog.mockClear(); phone.memoryPending(true); resume.click()
  expect(returnToLifelog).not.toHaveBeenCalled()
  phone.memoryPending(false); resume.click(); expect(returnToLifelog).toHaveBeenCalledOnce()
})

it('provides peer pages and bounded, collapsed inbox details without hiding lifelog behind tasks', () => {
  const phone = new OpenAGIPhoneCompanion({ pair: vi.fn(), ask: vi.fn(), newConversation: vi.fn(), unlink: vi.fn(), connectAgent: vi.fn(), configureAmbient: vi.fn() }, [])
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
  const phone = new OpenAGIPhoneCompanion({ pair: vi.fn(), ask: vi.fn(), newConversation: vi.fn(), unlink: vi.fn(), connectAgent: vi.fn(), configureAmbient: vi.fn(), readLifelog }, [])
  const input = document.querySelector<HTMLInputElement>('#lifelog-query')!
  input.value = 'first'; document.querySelector<HTMLButtonElement>('#lifelog-search')!.click()
  phone.lifelog({ nextOffset: 25 }); input.value = 'unsubmitted'
  document.querySelector<HTMLButtonElement>('#lifelog-next')!.click(); expect(readLifelog).toHaveBeenLastCalledWith('first', 25)
  document.querySelector<HTMLButtonElement>('#lifelog-previous')!.click(); expect(readLifelog).toHaveBeenLastCalledWith('first', 0)
  document.querySelector<HTMLButtonElement>('#lifelog-search')!.click(); expect(readLifelog).toHaveBeenLastCalledWith('unsubmitted', 0)
})

it('offers paired lifelog reading without a token link and separates wake responses', () => {
  const readLifelog = vi.fn(), configureListeningMode = vi.fn()
  const phone = new OpenAGIPhoneCompanion({ pair: vi.fn(), ask: vi.fn(), newConversation: vi.fn(), unlink: vi.fn(), connectAgent: vi.fn(), configureAmbient: vi.fn(), readLifelog, configureListeningMode }, [])
  phone.paired(true); phone.listeningMode('passive')
  expect(document.querySelector<HTMLElement>('#wake-settings')?.hidden).toBe(true)
  document.querySelector<HTMLButtonElement>('#read-lifelog')?.click()
  expect(readLifelog).toHaveBeenCalledWith('', 0)
  phone.lifelog({ total: 1, moments: [{ id: 'one', at: 1, title: '<img src=x>', segments: [{ text: '<script>untrusted</script>' }] }] })
  expect(document.querySelector('#lifelog-moments img')).toBeNull()
  expect(document.querySelector('#lifelog-moments script')).toBeNull()
  expect(document.querySelector('#lifelog-moments')?.textContent).toContain('untrusted')
  expect(document.querySelector('#lifelog-panel a')).toBeNull()
  phone.paired(false); expect(document.querySelector('#lifelog-moments')?.textContent).toBe('')
})

it('keeps memory separate from wake listening and renders inbox evidence safely', () => {
  const memoryConsent = vi.fn(), inboxAction = vi.fn()
  const phone = new OpenAGIPhoneCompanion({ pair: vi.fn(), ask: vi.fn(), newConversation: vi.fn(), unlink: vi.fn(), connectAgent: vi.fn(), configureAmbient: vi.fn(), memoryConsent, inboxAction }, [])
  expect(document.querySelector<HTMLInputElement>('#memory-enabled')?.checked).toBe(false)
  expect(document.querySelector<HTMLInputElement>('#recording-consent')?.checked).toBe(false)
  document.querySelector<HTMLInputElement>('#memory-enabled')?.click()
  expect(memoryConsent).toHaveBeenCalledWith(true, false)
  document.querySelector<HTMLInputElement>('#recording-consent')?.click()
  document.querySelector<HTMLInputElement>('#recording-consent')?.click()
  expect(memoryConsent).toHaveBeenLastCalledWith(false, false)
  phone.memoryStatus(false, 'Consent required')
  phone.inbox([{ id: 'candidate', title: '<img src=x>', summary: 'Unverified speaker', important: false, seen: false, action: 'accept-task', category: 'memory' }])
  expect(document.querySelector('#proactive-items img')).toBeNull()
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
  document.querySelector<HTMLButtonElement>('[data-inbox-op="accept-task"]')?.click()
  expect(inboxAction).not.toHaveBeenCalled()
  confirm.mockReturnValue(true); document.querySelector<HTMLButtonElement>('[data-inbox-op="accept-task"]')?.click()
  expect(inboxAction).toHaveBeenCalledWith('accept-task', 'candidate')
  confirm.mockRestore()
  phone.mainInbox('https://main.example.test')
  expect(document.querySelector<HTMLAnchorElement>('#main-inbox')?.href).toBe('https://main.example.test/g2/proactive')
})

it('exposes auto-send and labels Talk and Stop according to the saved setting', () => {
  const configureAutoSend = vi.fn()
  const phone = new OpenAGIPhoneCompanion({ pair: vi.fn(), ask: vi.fn(), newConversation: vi.fn(), unlink: vi.fn(), connectAgent: vi.fn(), configureAmbient: vi.fn(), configureAutoSend }, [])
  phone.autoSend(true); phone.set('Recording question · live', '')
  expect(document.querySelector('[data-action="ask"]')?.textContent).toBe('Stop talking · send')
  document.querySelector<HTMLInputElement>('#auto-send')?.click()
  expect(configureAutoSend).toHaveBeenCalledWith(false)
  phone.autoSend(false); phone.set('Recording question', '')
  expect(document.querySelector('[data-action="ask"]')?.textContent).toBe('Stop talking · review')
  phone.set('Ready', '')
  expect(document.querySelector('[data-action="ask"]')?.textContent).toBe('Talk')
})
function fixture() {
  const selectAnswer = vi.fn()
  const phone = new OpenAGIPhoneCompanion({ pair: vi.fn(), ask: vi.fn(), newConversation: vi.fn(), unlink: vi.fn(), connectAgent: vi.fn(), configureAmbient: vi.fn(), selectAnswer }, [])
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
  const phone = new OpenAGIPhoneCompanion({ pair: vi.fn(), ask: vi.fn(), newConversation: vi.fn(), unlink: vi.fn(), connectAgent: vi.fn(), configureAmbient: vi.fn(), sendDraft, discardDraft, rerecordDraft }, [])
  phone.paired(true); phone.draft('<img src=x>'); phone.set('Review question · not sent', 'Tap to send')
  expect(document.querySelector('#draft-text')?.textContent).toBe('<img src=x>')
  expect(document.querySelector('#draft-text img')).toBeNull()
  for (const id of ['send-draft', 'rerecord-draft', 'discard-draft']) document.querySelector<HTMLButtonElement>(`#${id}`)?.click()
  expect(sendDraft).toHaveBeenCalledOnce(); expect(rerecordDraft).toHaveBeenCalledOnce(); expect(discardDraft).toHaveBeenCalledOnce()
  phone.draft(null)
  expect(document.querySelector<HTMLElement>('#draft-review')?.hidden).toBe(true)
})
