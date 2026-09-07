import { waitForEvenAppBridge, type EvenAppBridge } from '@evenrealities/even_hub_sdk'
import { G2App } from './app/g2-app'
import { OpenAGIG2App } from './app/openagi-g2-app'
import { BuildBetterApiClient } from './buildbetter/api-client'
import { loadConfig, safeErrorMessage } from './config'
import { EvenAudioSource } from './even/audio-source'
import { EvenDisplayController } from './even/display-controller'
import { EvenInputController } from './even/input-controller'
import { OpenAGIApiClient } from './openagi/api-client'
import { loadOpenAGIConfig, safeOpenAGIError } from './openagi/config'
import { OpenAGIStore } from './openagi/store'
import { SerializedAudioSource } from './openagi/audio-source'
import { AgentsInputController } from './openagi/input-controller'
import { EvenKeyValueStorage } from './openagi/persistent-storage'
import { BrowserKeyValueStorage, RecoveryStore } from './storage/recovery-store'
import { GlassesRenderer } from './ui/glasses-renderer'
import { OpenAGIGlassesRenderer } from './ui/openagi-glasses-renderer'
import { OpenAGIPhoneCompanion } from './ui/openagi-phone-companion'
import { PhoneCompanion } from './ui/phone-companion'

const bridge = await waitForEvenAppBridge()
if (import.meta.env.VITE_G2_MODE === 'openagi') await launchOpenAGI(bridge)
else await launchBuildBetter(bridge)

async function launchOpenAGI(bridge: EvenAppBridge): Promise<void> {
  const config = loadOpenAGIConfig()
  const display = new EvenDisplayController(bridge)
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
    configureSpeech: (model, transport) => { void app.configureSpeech(model, transport) },
    toggleDisplay: () => app.toggleDisplay(),
    newConversation: () => { void app.newConversation() },
    selectAnswer: (index) => { void app.selectAnswer(index) },
    cancel: () => app.cancelRequest(),
    sendDraft: () => { void app.sendDraft() },
    discardDraft: () => { void app.discardDraft() },
    rerecordDraft: () => { void app.rerecordDraft() },
    previousPage: () => app.scrollUp(),
    nextPage: () => app.scrollDown(),
    recentAnswer: () => { void app.recentAnswer() },
    exit: () => { void app.systemExit().then(() => bridge.shutDownPageContainer(1)).catch(error => phone.set('Exit failed', safeOpenAGIError(error))) },
    unlink: () => { void app.unlink() },
    connectAgent: (origin, token) => { void app.connectAgent(origin, token) },
    configureAmbient: (enabled, wakePhrase, answerQuestions) => { void app.configureAmbient(enabled, wakePhrase, answerQuestions) },
  }, config.allowedOrigins)
  app = new OpenAGIG2App(api, store, new SerializedAudioSource(bridge), renderer, phone, config.allowedOrigins)
  const input = new AgentsInputController(bridge, { tap: () => app.tap(), scrollUp: () => app.scrollUp(), scrollDown: () => app.scrollDown(), doubleTap: () => app.doubleTap(), systemExit: () => { void app.systemExit() } })
  input.start()
  try { await app.boot() }
  catch (error) { renderer.message('OpenAGI could not start', safeOpenAGIError(error)); phone.set('Startup failed', safeOpenAGIError(error)) }
  bindExit(input, app)
}

async function launchBuildBetter(bridge: EvenAppBridge): Promise<void> {
  const display = new EvenDisplayController(bridge)
  await display.initialize('BuildBetter\n\nStarting…')
  const renderer = new GlassesRenderer(display)
  const store = new RecoveryStore(new BrowserKeyValueStorage())
  let credential: string | null = null
  let app!: G2App
  const api = new BuildBetterApiClient(loadConfig(), () => credential ?? store.snapshot().deviceCredential)
  const phone = new PhoneCompanion({
    link: () => { void app.link() }, record: () => { void app.startRecording() }, ask: () => { void app.startAsk() },
    live: () => { void app.startLive() }, unlink: () => { void app.unlink() },
  })
  app = new G2App(api, store, new EvenAudioSource(bridge), renderer, phone)
  const input = bindInput(bridge, app)
  try { await app.boot(); credential = store.snapshot().deviceCredential }
  catch (error) { renderer.message('BuildBetter could not start', safeErrorMessage(error)); phone.set('Startup failed', safeErrorMessage(error)) }
  bindExit(input, app)
}

interface G2InputTarget { tap(): void; scrollUp(): void; scrollDown(): void; doubleTap(): void; systemExit(): Promise<void> }
function bindInput(bridge: EvenAppBridge, app: G2InputTarget): EvenInputController {
  const input = new EvenInputController(bridge, { tap: () => app.tap(), scrollUp: () => app.scrollUp(), scrollDown: () => app.scrollDown(), doubleTap: () => app.doubleTap(), systemExit: () => { void app.systemExit() } })
  input.start()
  return input
}
function bindExit(input: { stop(): void }, app: G2InputTarget): void {
  window.addEventListener('beforeunload', () => { input.stop(); void app.systemExit() })
}
