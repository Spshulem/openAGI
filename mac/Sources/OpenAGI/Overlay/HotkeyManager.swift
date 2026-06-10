import AppKit
import Carbon.HIToolbox

// System-wide hotkey via Carbon RegisterEventHotKey (needs no Accessibility
// permission). Default: ⌥Space. Fires onHotkey on the main actor.
@MainActor
final class HotkeyManager {
  static let shared = HotkeyManager()
  private var ref: EventHotKeyRef?
  private var handler: EventHandlerRef?
  var onHotkey: () -> Void = {}

  func register() {
    var eventType = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: OSType(kEventHotKeyPressed))
    InstallEventHandler(GetApplicationEventTarget(), { _, _, userData -> OSStatus in
      let me = Unmanaged<HotkeyManager>.fromOpaque(userData!).takeUnretainedValue()
      Task { @MainActor in me.onHotkey() }
      return noErr
    }, 1, &eventType, Unmanaged.passUnretained(self).toOpaque(), &handler)

    let hotKeyID = EventHotKeyID(signature: OSType(0x4F41_4749), id: 1)
    let status = RegisterEventHotKey(UInt32(kVK_Space), UInt32(optionKey), hotKeyID, GetApplicationEventTarget(), 0, &ref)
    if status != noErr { NSLog("OpenAGI: hotkey registration failed (\(status)) — tray-only") }
  }

  func unregister() {
    if let ref { UnregisterEventHotKey(ref) }
    if let handler { RemoveEventHandler(handler) }
    ref = nil; handler = nil
  }
}
