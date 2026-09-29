import { waitForEvenAppBridge, type EvenAppBridge } from '@evenrealities/even_hub_sdk'
import { OpenAGIG2App } from './app/openagi-g2-app'
import { OpenAGIApiClient } from './openagi/api-client'
import { loadOpenAGIConfig, safeOpenAGIError } from './openagi/config'
import { OpenAGIStore } from './openagi/store'
import { SerializedAudioSource } from './openagi/audio-source'
import { AgentsInputController } from './openagi/input-controller'
import { AgentsDisplayController } from './openagi/display-controller'
import { EvenKeyValueStorage } from './openagi/persistent-storage'
import { BrowserKeyValueStorage } from './storage/recovery-store'
import { OpenAGIGlassesRenderer } from './ui/openagi-glasses-renderer'
import { OpenAGIPhoneCompanion } from './ui/openagi-phone-companion'


const bridge = await waitForEvenAppBridge()
await launchOpenAGI(bridge)

async function launchOpenAGI(bridge: EvenAppBridge): Promise<void> {
  const config = loadOpenAGIConfig()
  const display = new AgentsDisplayController(bridge)
  await display.initialize('OpenAGI\n\nStarting…')
  const renderer = new OpenAGIGlassesRenderer(display)
  const store = new OpenAGIStore(new EvenKeyValueStorage(bridge, new BrowserKeyValueStorage()))
  const api = new OpenAGIApiClient(config, () => {
    const state = store.snapshot()
    if (!state.nodeToken) return null
    return state.connectionMode === 'direct'
      ? { nodeToken: state.nodeToken }
      : { nodeId: state.nodeId, nodeToken: state.nodeToken }
  }, globalThis.fetch, () => store.snapshot().agentOrigin ?? config.origin)
  let app!: OpenAGIG2App
  const phone = new OpenAGIPhoneCompanion({
    pair: (code, origin) => { void app.pair(code, origin) },
    ask: () => { void app.startAsk() },
    configureInterface: style => { void app.configureInterface(style) },
    pauseLifelog: () => { void app.pauseLifelog() },
    resumeLifelog: () => { void app.resumeLifelog() },
    resumeRequest: () => { void app.resumeRequest() },
    dismissRequest: () => { void app.dismissRequest() },
    readHistory: (continuation, offset, query) => { void app.readHistory(continuation, offset, query) },
    continueHistory: continuation => { void app.continueHistory(continuation) },
    configureSpeech: (model, transport) => { void app.configureSpeech(model, transport) },
    toggleDisplay: () => app.toggleDisplay(),
    newConversation: () => { void app.newConversation() },
    selectAnswer: (index) => { void app.selectAnswer(index) },
    cancel: () => app.cancelRequest(),
    sendDraft: () => { void app.sendDraft() },
    discardDraft: () => { void app.discardDraft() },
    rerecordDraft: () => { void app.rerecordDraft() },
    configureAutoSend: enabled => { void app.configureAutoSend(enabled) },
    configureProactive: settings => { void app.proactive.configure(settings) },
    refreshInbox: () => { void app.proactive.refresh() },
    openInbox: () => app.openInbox(),
    recordingConsent: consent => { void app.configureRecordingConsent(consent) },
    deleteMemory: () => { void app.deleteMemory() },
    readLifelog: (query, offset) => { void app.readLifelog(query, offset) },
    inboxAction: (op, id, extra) => { void app.proactive.action(op, id, extra) },
    answerQuestion: (id, answer) => app.proactive.answer(id, answer),
    markMoment: () => { void app.markMoment() },
    configureHomeMode: mode => { void app.configureHomeMode(mode) },
    previousPage: () => app.scrollUp(),
    nextPage: () => app.scrollDown(),
    recentAnswer: () => { void app.recentAnswer() },
    exit: () => { void app.requestExit() },
    unlink: () => { void app.unlink() },
    connectAgent: (origin, token) => { void app.connectAgent(origin, token) },
  }, config.allowedOrigins)
  app = new OpenAGIG2App(api, store, new SerializedAudioSource(bridge), renderer, phone, config.allowedOrigins)
  const input = new AgentsInputController(bridge, { input: () => app.glassesInput(), tap: () => app.tap(), holdStart: () => app.holdStart(), holdRelease: () => app.holdRelease(), holdCancel: () => app.cancelHold(), scrollUp: () => app.scrollUp(), scrollDown: () => app.scrollDown(), doubleTap: () => app.doubleTap(), foreground: active => app.setForeground(active), systemExit: () => { void app.systemExit() } })
  input.start()
  try { await app.boot() }
  catch (error) { renderer.message('OpenAGI could not start', safeOpenAGIError(error)); phone.set('Startup failed', safeOpenAGIError(error)) }
  window.addEventListener('beforeunload', () => { input.stop(); void app.systemExit() })
}
