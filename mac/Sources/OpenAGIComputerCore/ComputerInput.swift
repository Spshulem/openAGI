import AppKit
import ApplicationServices
import Carbon
import CoreGraphics
import Foundation

public enum ComputerInputError: LocalizedError {
  case accessibilityRequired
  case consoleSessionRequired
  case screenLocked
  case secureInputEnabled
  case focusChanged
  case cancelled
  case invalidButton(String)
  case invalidClickCount
  case invalidDuration
  case invalidPoint
  case invalidText
  case unknownKey(String)

  public var errorDescription: String? {
    switch self {
    case .accessibilityRequired:
      return "Accessibility permission is required for computer input"
    case .consoleSessionRequired:
      return "computer input requires the active console session"
    case .screenLocked:
      return "computer input is unavailable while the screen is locked"
    case .secureInputEnabled:
      return "computer input is unavailable while Secure Event Input is enabled"
    case .focusChanged:
      return "the focused window changed after the approved screenshot; take a new screenshot"
    case .cancelled:
      return "computer input was cancelled"
    case .invalidButton(let button):
      return "unknown mouse button '\(button)'"
    case .invalidClickCount:
      return "click count must be between 1 and 3"
    case .invalidDuration:
      return "drag duration must be between 0 and 2000 milliseconds"
    case .invalidPoint:
      return "coordinates are outside the main display"
    case .invalidText:
      return "text must be at most 16 KiB and must not contain NUL"
    case .unknownKey(let name):
      return "unknown key '\(name)'"
    }
  }
}

public final class ComputerInputCancellation: @unchecked Sendable {
  private let lock = NSLock()
  private var cancelled = false

  public init() {}

  public func cancel() {
    lock.lock()
    cancelled = true
    lock.unlock()
  }

  public func check() throws {
    lock.lock()
    let value = cancelled
    lock.unlock()
    if value { throw ComputerInputError.cancelled }
  }
}

public enum ComputerInput {
  public static var screenRecordingGranted: Bool { CGPreflightScreenCaptureAccess() }
  public static var accessibilityGranted: Bool { AXIsProcessTrusted() }
  public static var displayAvailable: Bool {
    let bounds = CGDisplayBounds(CGMainDisplayID())
    return bounds.width > 0 && bounds.height > 0
  }
  public static var secureInputEnabled: Bool { IsSecureEventInputEnabled() }
  public static var consoleSessionActive: Bool {
    guard let session = CGSessionCopyCurrentDictionary() as? [String: Any] else { return false }
    return session[kCGSessionOnConsoleKey as String] as? Bool ?? false
  }
  public static var screenLocked: Bool {
    guard let session = CGSessionCopyCurrentDictionary() as? [String: Any] else { return true }
    return session["CGSSessionScreenIsLocked"] as? Bool ?? false
  }

  public static func click(x: Double, y: Double, button: String, count: Int = 1,
                           focus: ComputerFocusIdentity? = nil,
                           cancellation: ComputerInputCancellation? = nil) throws {
    try requirePoint(x: x, y: y)
    guard (1...3).contains(count) else { throw ComputerInputError.invalidClickCount }
    let point = CGPoint(x: x, y: y)
    let source = CGEventSource(stateID: .hidSystemState)
    let downType: CGEventType
    let upType: CGEventType
    let mouseButton: CGMouseButton
    switch button.lowercased() {
    case "right":
      downType = .rightMouseDown; upType = .rightMouseUp; mouseButton = .right
    case "middle":
      downType = .otherMouseDown; upType = .otherMouseUp; mouseButton = .center
    case "left":
      downType = .leftMouseDown; upType = .leftMouseUp; mouseButton = .left
    default:
      throw ComputerInputError.invalidButton(button)
    }
    for clickState in 1...count {
      let down = CGEvent(mouseEventSource: source, mouseType: downType, mouseCursorPosition: point, mouseButton: mouseButton)
      let up = CGEvent(mouseEventSource: source, mouseType: upType, mouseCursorPosition: point, mouseButton: mouseButton)
      down?.setIntegerValueField(.mouseEventClickState, value: Int64(clickState))
      up?.setIntegerValueField(.mouseEventClickState, value: Int64(clickState))
      try postPhysicalPair(down, up, focus: focus, cancellation: cancellation)
    }
  }

  public static func drag(fromX: Double, fromY: Double, toX: Double, toY: Double,
                          button: String, durationMs: Int = 350,
                          focus: ComputerFocusIdentity? = nil,
                          cancellation: ComputerInputCancellation? = nil) throws {
    try requirePoint(x: fromX, y: fromY)
    try requirePoint(x: toX, y: toY)
    guard (0...2_000).contains(durationMs) else { throw ComputerInputError.invalidDuration }
    let source = CGEventSource(stateID: .hidSystemState)
    let downType: CGEventType
    let dragType: CGEventType
    let upType: CGEventType
    let mouseButton: CGMouseButton
    switch button.lowercased() {
    case "right":
      downType = .rightMouseDown; dragType = .rightMouseDragged; upType = .rightMouseUp; mouseButton = .right
    case "middle":
      downType = .otherMouseDown; dragType = .otherMouseDragged; upType = .otherMouseUp; mouseButton = .center
    case "left":
      downType = .leftMouseDown; dragType = .leftMouseDragged; upType = .leftMouseUp; mouseButton = .left
    default:
      throw ComputerInputError.invalidButton(button)
    }
    try cancellation?.check()
    try requireActionTimeReadiness(focus: focus)
    var current = CGPoint(x: fromX, y: fromY)
    let down = CGEvent(mouseEventSource: source, mouseType: downType, mouseCursorPosition: current, mouseButton: mouseButton)
    down?.post(tap: .cghidEventTap)
    // Once mouse-down is posted, mouse-up is an unconditional cleanup boundary.
    // Cancellation or a focus change can stop movement, but can never strand a
    // pressed mouse button in the system event stream.
    defer {
      let up = CGEvent(mouseEventSource: source, mouseType: upType, mouseCursorPosition: current, mouseButton: mouseButton)
      up?.post(tap: .cghidEventTap)
    }
    let steps = max(1, min(120, durationMs == 0 ? 1 : durationMs / 16))
    let delay = steps > 0 ? Double(durationMs) / Double(steps) / 1_000.0 : 0
    for step in 1...steps {
      try cancellation?.check()
      try requireActionTimeReadiness(focus: focus)
      let progress = Double(step) / Double(steps)
      current = CGPoint(
        x: fromX + ((toX - fromX) * progress),
        y: fromY + ((toY - fromY) * progress)
      )
      let movement = CGEvent(mouseEventSource: source, mouseType: dragType, mouseCursorPosition: current, mouseButton: mouseButton)
      movement?.post(tap: .cghidEventTap)
      if delay > 0 && step < steps { Thread.sleep(forTimeInterval: delay) }
    }
  }

  public static func move(x: Double, y: Double, focus: ComputerFocusIdentity? = nil,
                          cancellation: ComputerInputCancellation? = nil) throws {
    try requirePoint(x: x, y: y)
    if let event = CGEvent(
      mouseEventSource: CGEventSource(stateID: .hidSystemState),
      mouseType: .mouseMoved,
      mouseCursorPosition: CGPoint(x: x, y: y),
      mouseButton: .left
    ) {
      try postPhysicalEvent(event, focus: focus, cancellation: cancellation)
    }
  }

  public static func scroll(x: Double, y: Double, deltaX: Int32, deltaY: Int32,
                            focus: ComputerFocusIdentity? = nil,
                            cancellation: ComputerInputCancellation? = nil) throws {
    try requirePoint(x: x, y: y)
    guard let event = CGEvent(
      scrollWheelEvent2Source: CGEventSource(stateID: .hidSystemState),
      units: .line,
      wheelCount: 2,
      wheel1: deltaY,
      wheel2: deltaX,
      wheel3: 0
    ) else { return }
    event.location = CGPoint(x: x, y: y)
    try postPhysicalEvent(event, focus: focus, cancellation: cancellation)
  }

  public static func sendShortcut(_ spec: String, focus: ComputerFocusIdentity? = nil,
                                  cancellation: ComputerInputCancellation? = nil) throws {
    guard !spec.isEmpty, spec.utf8.count <= 80, !spec.contains("\0") else {
      throw ComputerInputError.unknownKey(spec)
    }
    let parts = spec.lowercased()
      .split(separator: "+", omittingEmptySubsequences: false)
      .map { $0.trimmingCharacters(in: .whitespaces) }
    guard !parts.contains(where: { $0.isEmpty }) else {
      throw ComputerInputError.unknownKey(spec)
    }
    var modifiers: CGEventFlags = []
    var key: String?
    for part in parts {
      switch part {
      case "cmd", "command", "⌘": modifiers.insert(.maskCommand)
      case "shift", "⇧": modifiers.insert(.maskShift)
      case "alt", "option", "opt", "⌥": modifiers.insert(.maskAlternate)
      case "ctrl", "control", "⌃": modifiers.insert(.maskControl)
      default:
        if key != nil { throw ComputerInputError.unknownKey(spec) }
        key = part
      }
    }
    guard let key else { throw ComputerInputError.unknownKey(spec) }
    try sendKey(named: key, modifiers: modifiers, focus: focus, cancellation: cancellation)
  }

  public static func sendKey(named name: String, modifiers: CGEventFlags = [],
                             focus: ComputerFocusIdentity? = nil,
                             cancellation: ComputerInputCancellation? = nil) throws {
    guard let code = keyCode(for: name) else { throw ComputerInputError.unknownKey(name) }
    let source = CGEventSource(stateID: .hidSystemState)
    let down = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true)
    let up = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false)
    down?.flags = modifiers
    up?.flags = modifiers
    try postPhysicalPair(down, up, focus: focus, cancellation: cancellation,
                         inspectFocusedElement: true)
  }

  public static func sendType(_ text: String, focus: ComputerFocusIdentity? = nil,
                              cancellation: ComputerInputCancellation? = nil) throws {
    guard text.utf8.count <= 16 * 1024, !text.contains("\0") else {
      throw ComputerInputError.invalidText
    }
    let source = CGEventSource(stateID: .hidSystemState)
    for character in text.unicodeScalars {
      let utf16 = Array(String(character).utf16)
      let down = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true)
      let up = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false)
      down?.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: utf16)
      up?.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: utf16)
      // Check before every character pair. Once key-down is posted, key-up is
      // an uninterruptible cleanup boundary so cancellation or a focus change
      // cannot strand a pressed key in the system event stream.
      try postPhysicalPair(down, up, focus: focus, cancellation: cancellation,
                           inspectFocusedElement: true)
    }
  }

  public static func validateInputReadiness(
    accessibilityGranted: Bool,
    consoleSessionActive: Bool,
    screenLocked: Bool,
    secureInputEnabled: Bool
  ) throws {
    guard accessibilityGranted else { throw ComputerInputError.accessibilityRequired }
    guard consoleSessionActive else { throw ComputerInputError.consoleSessionRequired }
    guard !screenLocked else { throw ComputerInputError.screenLocked }
    guard !secureInputEnabled else { throw ComputerInputError.secureInputEnabled }
  }

  static func requireActionTimeReadiness(focus: ComputerFocusIdentity?) throws {
    try validateInputReadiness(
      accessibilityGranted: accessibilityGranted,
      consoleSessionActive: consoleSessionActive,
      screenLocked: screenLocked,
      secureInputEnabled: secureInputEnabled
    )
    if let focus {
      guard ComputerScreenshot.focusStillMatches(focus) else {
        throw ComputerInputError.focusChanged
      }
    }
  }

  private static func requireTextInputReady(focus: ComputerFocusIdentity?) throws {
    try requireActionTimeReadiness(focus: focus)
    if let focus {
      guard try !ComputerAccessibility.focusedElementIsSecure(
        processIdentifier: focus.processIdentifier
      ) else { throw ComputerAccessibilityError.secureElement }
    }
  }

  private static func postPhysicalEvent(_ event: CGEvent, focus: ComputerFocusIdentity?,
                                        cancellation: ComputerInputCancellation?) throws {
    try cancellation?.check()
    try requireActionTimeReadiness(focus: focus)
    event.post(tap: .cghidEventTap)
  }

  private static func postPhysicalPair(_ down: CGEvent?, _ up: CGEvent?,
                                       focus: ComputerFocusIdentity?,
                                       cancellation: ComputerInputCancellation?,
                                       inspectFocusedElement: Bool = false) throws {
    try cancellation?.check()
    if inspectFocusedElement {
      try requireTextInputReady(focus: focus)
    } else {
      try requireActionTimeReadiness(focus: focus)
    }
    // Never insert a cancellation/readiness check between these posts. A Stop
    // request is observed before the next pair, after the release is complete.
    down?.post(tap: .cghidEventTap)
    up?.post(tap: .cghidEventTap)
  }

  private static func requirePoint(x: Double, y: Double) throws {
    let bounds = CGDisplayBounds(CGMainDisplayID())
    guard x.isFinite, y.isFinite, bounds.contains(CGPoint(x: x, y: y)) else {
      throw ComputerInputError.invalidPoint
    }
  }

  private static func keyCode(for name: String) -> CGKeyCode? {
    let map: [String: CGKeyCode] = [
      "return": 36, "enter": 36, "tab": 48, "space": 49, "delete": 51, "backspace": 51,
      "escape": 53, "esc": 53, "left": 123, "right": 124, "down": 125, "up": 126,
      "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
      "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
      "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17,
      "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "9": 25, "7": 26, "8": 28, "0": 29,
      "o": 31, "u": 32, "i": 34, "p": 35, "l": 37, "j": 38, "k": 40, "n": 45, "m": 46,
      ",": 43, ".": 47, "/": 44, ";": 41, "'": 39, "[": 33, "]": 30, "-": 27, "=": 24, "`": 50
    ]
    return map[name.lowercased()]
  }
}
