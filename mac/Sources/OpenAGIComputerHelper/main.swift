import Darwin
import Foundation
import OpenAGIComputerCore

struct InputPayload: Decodable {
  var x: Double?
  var y: Double?
  var button: String?
  var text: String?
  var chord: String?
  var deltaX: Double?
  var deltaY: Double?
  var focus: ComputerFocusIdentity?
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
      "accessibility": accessibility,
      "consoleActive": console,
      "screenLocked": locked,
      "secureInput": secureInput,
      // The privacy-safe screenshot path identifies the focused window through
      // Accessibility. Do not advertise screenshot readiness when that
      // identity cannot be established fail-closed.
      "screenshotReady": screenshotReady,
      "inputReady": input,
      "operations": ["screenshot", "click", "move", "type", "key", "scroll"],
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
  let data = FileHandle.standardInput.readDataToEndOfFile()
  guard data.count <= 64 * 1024 else {
    throw NSError(domain: "OpenAGIComputerHelper", code: 2, userInfo: [NSLocalizedDescriptionKey: "payload exceeds 64 KiB"])
  }
  let payload = try JSONDecoder().decode(InputPayload.self, from: data)
  guard let focus = payload.focus else {
    throw NSError(domain: "OpenAGIComputerHelper", code: 4, userInfo: [NSLocalizedDescriptionKey: "input requires the exact focused-window identity from a fresh screenshot"])
  }
  switch operation {
  case "click":
    guard let x = payload.x, let y = payload.y, let button = payload.button,
          ["left", "right", "middle"].contains(button) else {
      throw NSError(domain: "OpenAGIComputerHelper", code: 4, userInfo: [NSLocalizedDescriptionKey: "click requires x, y, and a valid button"])
    }
    try ComputerInput.click(x: x, y: y, button: button, focus: focus, cancellation: cancellation)
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
  default:
    throw NSError(domain: "OpenAGIComputerHelper", code: 3, userInfo: [NSLocalizedDescriptionKey: "unsupported operation"])
  }
  try writeJSON(["ok": true])
} catch {
  FileHandle.standardError.write(Data((error.localizedDescription + "\n").utf8))
  exit(1)
}
