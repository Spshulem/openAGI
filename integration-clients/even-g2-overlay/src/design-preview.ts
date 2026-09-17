// Dev-only entry (not a Vite production input). No SDK, microphone, token, or API.
import { OpenAGIPhoneCompanion } from './ui/openagi-phone-companion'
const noop = (): void => { phone.set('Design preview', 'Sample content only. No microphone or connection is active.') }
let recording = false
const phone = new OpenAGIPhoneCompanion({
  pair: noop, ask: () => { recording = !recording; phone.interaction(recording ? 'recording' : 'idle'); phone.set(recording ? 'Listening…' : 'Ready', 'Design preview only · no microphone or connection'); phone.transcript(recording ? 'What should I focus on this afternoon?' : '') },
  newConversation: noop, unlink: noop, connectAgent: noop, configureAmbient: noop,
  configureInterface: style => phone.interfaceStyle(style), pauseLifelog: noop, returnToLifelog: noop,
}, [])
phone.paired(true); phone.interaction('idle')
phone.set('Ready when you are.', 'Design preview · no microphone or connection')
phone.readiness({ protocol: 1, recovery: true, history: true, mainRole: 'main', speech: { liveTranscriptionConfigured: true, transcriptionConfigured: true } }, 'Design preview — no main is connected.')
phone.memoryStatus(false, 'Off. Turn on when you have participant consent.')
phone.history([{ question: 'Help me plan my afternoon', at: new Date().toISOString() }])
phone.inbox([{ id: 'preview', title: 'A coding task is ready for review', summary: 'Sample notification. Check the changes before deciding what happens next.', category: 'approvals', action: 'review-on-main', seen: false, important: false }])
