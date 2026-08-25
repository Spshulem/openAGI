import Darwin
import Foundation
import OpenAGIComputerCore

struct InputPayload: Decodable {
  var x: Double?
  var y: Double?
  var button: String?
  var count: Int?
  var fromX: Double?
  var fromY: Double?
  var toX: Double?
  var toY: Double?
  var durationMs: Int?
  var text: String?
  var chord: String?
  var deltaX: Double?
  var deltaY: Double?
  var focus: ComputerFocusIdentity?
  var locator: ComputerAccessibilityElement?
  var bundleIdentifier: String?
  var format: String?
  var action: String?
  var prefix: String?
  var suffix: String?
  var selectionType: String?
  var direction: String?
  var pages: Int?
}

func writeJSON(_ value: Any) throws {
  let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data("\n".utf8))
}

do {
  let cancellation = ComputerInputCancellation()
  signal(SIGTERM, SIG_IGN)
  signal(SIGINT, SIG_IGN)
  let termSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .global(qos: .userInitiated))
  let intSource = DispatchSource.makeSignalSource(signal: SIGINT, queue: .global(qos: .userInitiated))
  termSource.setEventHandler { cancellation.cancel() }
  intSource.setEventHandler { cancellation.cancel() }
  termSource.resume()
  intSource.resume()
  defer {
    termSource.cancel()
    intSource.cancel()
  }
  let arguments = CommandLine.arguments
  guard arguments.count == 2 else { throw NSError(domain: "OpenAGIComputerHelper", code: 1, userInfo: [NSLocalizedDescriptionKey: "exactly one operation argument is required; payload belongs on stdin"]) }
  let operation = arguments[1]
  if operation == "status" {
    let console = ComputerInput.consoleSessionActive
    let locked = ComputerInput.screenLocked
    let secureInput = ComputerInput.secureInputEnabled
    let screenRecording = ComputerInput.screenRecordingGranted
    let accessibility = ComputerInput.accessibilityGranted
    let display = ComputerInput.displayAvailable
    let privacyReady = screenRecording && display && console && !locked
      ? ComputerScreenshot.focusedWindowPrivacyReady()
      : false
    let screen = screenRecording && display && console && !locked
    let input = accessibility && console && !locked && !secureInput
    let screenshotReady = screen && privacyReady
    var blockers: [String] = []
    if !screenRecording { blockers.append("grant Screen Recording to OpenAGI") }
    if !accessibility { blockers.append("grant Accessibility to OpenAGI") }
    if !display { blockers.append("connect an active display") }
    if !console { blockers.append("sign in to the active console session") }
    if locked { blockers.append("unlock the screen") }
    if secureInput { blockers.append("disable Secure Input") }
    if screen && !privacyReady { blockers.append("focus a window allowed by Capture privacy settings") }
    try writeJSON([
      "screenRecording": screen,
      "capturePrerequisitesReady": screen,
      "accessibility": accessibility,
      "consoleActive": console,
      "screenLocked": locked,
      "secureInput": secureInput,
      // The privacy-safe screenshot path identifies the focused window through
      // Accessibility. Do not advertise screenshot readiness when that
      // identity cannot be established fail-closed.
      "screenshotReady": screenshotReady,
      "inputReady": input,
      "operations": [
        "screenshot", "list_apps", "activate_app", "click", "click_element", "drag", "move",
        "type", "paste", "set_value", "select_text", "secondary_action", "key", "scroll", "scroll_element"
      ],
      "detail": screenshotReady && input ? "ready" : blockers.joined(separator: "; ")
    ])
    exit(0)
  }
  if operation == "screenshot" {
    let screenshot = try await ComputerScreenshot.captureFrontmostWindow()
    let encoded = try JSONEncoder().encode(screenshot)
    FileHandle.standardOutput.write(encoded)
    FileHandle.standardOutput.write(Data("\n".utf8))
    exit(0)
  }
  if operation == "list_apps" {
    let encoded = try JSONEncoder().encode(["apps": ComputerApplications.list()])
    FileHandle.standardOutput.write(encoded)
    FileHandle.standardOutput.write(Data("\n".utf8))
    exit(0)
  }
  let data = FileHandle.standardInput.readDataToEndOfFile()
  guard data.count <= 96 * 1024 else {
    throw NSError(domain: "OpenAGIComputerHelper", code: 2, userInfo: [NSLocalizedDescriptionKey: "payload exceeds 96 KiB"])
  }
  let payload = try JSONDecoder().decode(InputPayload.self, from: data)
  if operation == "activate_app" {
    guard let bundleIdentifier = payload.bundleIdentifier else {
      throw NSError(domain: "OpenAGIComputerHelper", code: 4, userInfo: [NSLocalizedDescriptionKey: "activate_app requires a bundleIdentifier"])
    }
    let app = try await ComputerApplications.activate(bundleIdentifier: bundleIdentifier)
    let encoded = try JSONEncoder().encode(app)
    FileHandle.standardOutput.write(encoded)
    FileHandle.standardOutput.write(Data("\n".utf8))
    exit(0)
  }
  guard let focus = payload.focus else {
    throw NSError(domain: "OpenAGIComputerHelper", code: 4, userInfo: [NSLocalizedDescriptionKey: "input requires the exact focused-window identity from a fresh screenshot"])
  }
  switch operation {
  case "click":
    guard let x = payload.x, let y = payload.y, let button = payload.button,
          ["left", "right", "middle"].contains(button) else {
      throw NSError(domain: "OpenAGIComputerHelper", code: 4, userInfo: [NSLocalizedDescriptionKey: "click requires x, y, and a valid button"])
    }
    let count = payload.count ?? 1
    guard (1...3).contains(count) else {
      throw NSError(domain: "OpenAGIComputerHelper", code: 4, userInfo: [NSLocalizedDescriptionKey: "click count must be between 1 and 3"])
    }
    try ComputerInput.click(x: x, y: y, button: button, count: count, focus: focus, cancellation: cancellation)
  case "click_element":
    guard let locator = payload.locator else {
      throw NSError(domain: "OpenAGIComputerHelper", code: 4, userInfo: [NSLocalizedDescriptionKey: "click_element requires a fresh element locator"])
    }
    try ComputerAccessibility.click(locator: locator, focus: focus, cancellation: cancellation)
  case "drag":
    guard let fromX = payload.fromX, let fromY = payload.fromY,
          let toX = payload.toX, let toY = payload.toY,
          let button = payload.button, ["left", "right", "middle"].contains(button) else {
      throw NSError(domain: "OpenAGIComputerHelper", code: 4, userInfo: [NSLocalizedDescriptionKey: "drag requires fromX, fromY, toX, toY, and a valid button"])
    }
    let durationMs = payload.durationMs ?? 350
    guard (0...2_000).contains(durationMs) else {
      throw NSError(domain: "OpenAGIComputerHelper", code: 4, userInfo: [NSLocalizedDescriptionKey: "drag durationMs must be between 0 and 2000"])
    }
    try ComputerInput.drag(
      fromX: fromX, fromY: fromY, toX: toX, toY: toY,
      button: button, durationMs: durationMs, focus: focus, cancellation: cancellation
    )
  case "move":
    guard let x = payload.x, let y = payload.y else {
      throw NSError(domain: "OpenAGIComputerHelper", code: 4, userInfo: [NSLocalizedDescriptionKey: "move requires x and y"])
    }
    try ComputerInput.move(x: x, y: y, focus: focus, cancellation: cancellation)
  case "type":
    guard let text = payload.text, text.utf8.count <= 16 * 1024, !text.contains("\0") else {
      throw NSError(domain: "OpenAGIComputerHelper", code: 4, userInfo: [NSLocalizedDescriptionKey: "type requires text of at most 16 KiB without NUL"])
    }
    try ComputerInput.sendType(text, focus: focus, cancellation: cancellation)
  case "paste":
    guard let locator = payload.locator, let text = payload.text, let format = payload.format else {
      throw NSError(domain: "OpenAGIComputerHelper", code: 4, userInfo: [NSLocalizedDescriptionKey: "paste requires a fresh element, text, and format"])
    }
    try ComputerAccessibility.paste(
      locator: locator, text: text, format: format,
      focus: focus, cancellation: cancellation
    )
  case "set_value":
    guard let locator = payload.locator, let text = payload.text else {
      throw NSError(domain: "OpenAGIComputerHelper", code: 4, userInfo: [NSLocalizedDescriptionKey: "set_value requires a fresh element and value"])
    }
    try ComputerAccessibility.setValue(
      locator: locator, value: text, focus: focus, cancellation: cancellation
    )
  case "select_text":
    guard let locator = payload.locator, let text = payload.text,
          let selectionType = payload.selectionType else {
      throw NSError(domain: "OpenAGIComputerHelper", code: 4, userInfo: [NSLocalizedDescriptionKey: "select_text requires a fresh element, text, and selectionType"])
    }
    try ComputerAccessibility.selectText(
      locator: locator, text: text, prefix: payload.prefix, suffix: payload.suffix,
      selectionType: selectionType, focus: focus, cancellation: cancellation
    )
  case "secondary_action":
    guard let locator = payload.locator, let action = payload.action else {
      throw NSError(domain: "OpenAGIComputerHelper", code: 4, userInfo: [NSLocalizedDescriptionKey: "secondary_action requires a fresh element and action"])
    }
    try ComputerAccessibility.performSecondaryAction(
      locator: locator, action: action, focus: focus, cancellation: cancellation
    )
  case "key":
    guard let chord = payload.chord, !chord.isEmpty else {
      throw NSError(domain: "OpenAGIComputerHelper", code: 4, userInfo: [NSLocalizedDescriptionKey: "key requires a chord"])
    }
    try ComputerInput.sendShortcut(chord, focus: focus, cancellation: cancellation)
  case "scroll":
    guard let x = payload.x, let y = payload.y,
          let deltaX = payload.deltaX, deltaX.isFinite, abs(deltaX) <= 1_000,
          let deltaY = payload.deltaY, deltaY.isFinite, abs(deltaY) <= 1_000 else {
      throw NSError(domain: "OpenAGIComputerHelper", code: 4, userInfo: [NSLocalizedDescriptionKey: "scroll requires x, y, deltaX, and deltaY"])
    }
    try ComputerInput.scroll(
      x: x,
      y: y,
      deltaX: Int32(clamping: Int(deltaX)),
      deltaY: Int32(clamping: Int(deltaY)),
      focus: focus,
      cancellation: cancellation
    )
  case "scroll_element":
    guard let locator = payload.locator, let direction = payload.direction else {
      throw NSError(domain: "OpenAGIComputerHelper", code: 4, userInfo: [NSLocalizedDescriptionKey: "scroll_element requires a fresh element and direction"])
    }
    try ComputerAccessibility.scroll(
      locator: locator, direction: direction, pages: payload.pages ?? 1,
      focus: focus, cancellation: cancellation
    )
  default:
    throw NSError(domain: "OpenAGIComputerHelper", code: 3, userInfo: [NSLocalizedDescriptionKey: "unsupported operation"])
  }
  try writeJSON(["ok": true])
} catch {
  FileHandle.standardError.write(Data((error.localizedDescription + "\n").utf8))
  exit(1)
}
