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
  const store = new OpenAGIStore(new BrowserKeyValueStorage())
  const api = new OpenAGIApiClient(config, () => {
    const state = store.snapshot()
    return state.nodeToken ? { nodeId: state.nodeId, nodeToken: state.nodeToken } : null
  })
  let app!: OpenAGIG2App
  const phone = new OpenAGIPhoneCompanion({
    pair: code => { void app.pair(code) },
    ask: () => { void app.startAsk() },
    newConversation: () => { void app.newConversation() },
    unlink: () => { void app.unlink() },
  }, config.origin)
  app = new OpenAGIG2App(api, store, new EvenAudioSource(bridge), renderer, phone)
  const input = bindInput(bridge, app)
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
function bindExit(input: EvenInputController, app: G2InputTarget): void {
  window.addEventListener('beforeunload', () => { input.stop(); void app.systemExit() })
}
