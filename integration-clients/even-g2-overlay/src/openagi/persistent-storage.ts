import type { EvenAppBridge } from '@evenrealities/even_hub_sdk'
import type { KeyValueStorage } from '../storage/recovery-store'

/** Native app storage survives replacement of the embedded browser session. */
export class EvenKeyValueStorage implements KeyValueStorage {
  constructor(
    private readonly bridge: Pick<EvenAppBridge, 'getLocalStorage' | 'setLocalStorage'>,
    private readonly legacy: KeyValueStorage,
  ) {}

  async get(key: string): Promise<string | null> {
    const native = await this.bridge.getLocalStorage(key)
    if (native) return native
    const previous = await this.legacy.get(key)
    if (previous) await this.set(key, previous)
    return previous
  }

  async set(key: string, value: string): Promise<void> {
    if (!await this.bridge.setLocalStorage(key, value)) {
      throw new Error('Could not save your connection in the Even app. Please retry before closing the app.')
    }
    // Do not leave an old credential available for migration after disconnect.
    try { await this.legacy.remove(key) } catch { /* Native storage is authoritative. */ }
  }

  async remove(key: string): Promise<void> {
    // A nonempty tombstone prevents an obsolete browser value being restored.
    await this.set(key, 'null')
  }
}
