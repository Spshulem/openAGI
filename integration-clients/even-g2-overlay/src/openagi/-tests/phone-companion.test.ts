import { beforeEach, expect, it, vi } from 'vitest'
import { OpenAGIPhoneCompanion } from '../../ui/openagi-phone-companion'

beforeEach(() => { document.body.innerHTML = '<div id="app"></div>'; document.head.innerHTML = '' })

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
