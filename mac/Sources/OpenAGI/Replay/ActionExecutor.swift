import AppKit
import Foundation
import OpenAGIComputerCore

// Action vocabulary executor. Each step is a single-key dictionary; the key
// names the action and the value is its argument. Unknown keys are logged
// and skipped (they pass server-side validation, but we belt-and-suspenders).
//
// Implemented:
//   open_app: "Linear"               — NSWorkspace.shared.openApplication
//   wait: 1.5                        — sleep N seconds
//   keyboard_shortcut: "cmd+k"       — synthesized via CGEvent
//   type: "OpenAGI roadmap"          — synthesized character-by-character
//   press: "Return"                  — single named key
//   applescript: "tell …"            — NSAppleScript
//   shortcut: "MyShortcut"           — `shortcuts run "MyShortcut"` (CLI)
//   say: "ready"                     — `say "..."` (NSSpeechSynthesizer alternative)
//   browser: "https://…"             — open URL in default browser
//   comment: "anything"              — no-op, captured in the log
//
// All key-emitting actions require Accessibility permission. The executor
// prompts the user on first use via NSApp foreground.

@MainActor
final class ActionExecutor {
  struct Outcome {
    var executed: Int
    var error: String?
    var log: [String]
  }

  func run(steps: [[String: Any]], dryRun: Bool) async -> Outcome {
    var log: [String] = []
    var executed = 0
    for (i, step) in steps.enumerated() {
      guard let kv = step.first else { continue }
      let action = kv.key
      let value = kv.value
      let line = "\(i + 1). \(action): \(describe(value))"
      log.append(line)
      if dryRun { continue }
      do {
        try await dispatch(action: action, value: value)
        executed += 1
      } catch {
        return Outcome(executed: executed, error: "step \(i + 1) (\(action)): \(error.localizedDescription)", log: log)
      }
    }
    return Outcome(executed: executed, error: nil, log: log)
  }

  // MARK: — dispatch

  private func dispatch(action: String, value: Any) async throws {
    switch action {
    case "open_app":
      try await openApp(name: stringValue(value))
    case "wait":
      let secs = (value as? Double) ?? Double(stringValue(value)) ?? 0
      if secs > 0 { try? await Task.sleep(nanoseconds: UInt64(secs * 1_000_000_000)) }
    case "keyboard_shortcut":
      try sendShortcut(stringValue(value))
    case "type":
      try sendType(stringValue(value))
    case "press":
      try sendKey(named: stringValue(value), modifiers: [])
    case "applescript":
      try runAppleScript(stringValue(value))
    case "shortcut":
      try runShortcutsApp(name: stringValue(value))
    case "say":
      let p = Process()
      p.executableURL = URL(fileURLWithPath: "/usr/bin/say")
      p.arguments = [stringValue(value)]
      try p.run()
    case "browser":
      if let url = URL(string: stringValue(value)) { NSWorkspace.shared.open(url) }
    case "comment":
      break // no-op, kept for human-readable logs
    default:
      throw NSError(domain: "OpenAGI.replay", code: 1, userInfo: [NSLocalizedDescriptionKey: "unknown action '\(action)'"])
    }
  }

  // MARK: — helpers

  private func openApp(name: String) async throws {
    let workspace = NSWorkspace.shared
    // Try by bundle id first, then by visible name
    if let appURL = workspace.urlForApplication(withBundleIdentifier: name) {
      _ = try await workspace.openApplication(at: appURL, configuration: NSWorkspace.OpenConfiguration())
      return
    }
    if let appURL = workspace.urlForApplication(toOpen: URL(fileURLWithPath: "/Applications/\(name).app")) {
      _ = try await workspace.openApplication(at: appURL, configuration: NSWorkspace.OpenConfiguration())
      return
    }
    // Last resort — `open -a "Name"`
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/bin/open")
    p.arguments = ["-a", name]
    try p.run()
    p.waitUntilExit()
    if p.terminationStatus != 0 {
      throw NSError(domain: "OpenAGI.replay", code: 2, userInfo: [NSLocalizedDescriptionKey: "could not open app '\(name)'"])
    }
  }

  private func runAppleScript(_ src: String) throws {
    var error: NSDictionary?
    let script = NSAppleScript(source: src)
    _ = script?.executeAndReturnError(&error)
    if let err = error {
      throw NSError(domain: "OpenAGI.replay.applescript", code: 3, userInfo: [NSLocalizedDescriptionKey: "\(err)"])
    }
  }

  private func runShortcutsApp(name: String) throws {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/bin/shortcuts")
    p.arguments = ["run", name]
    try p.run()
    p.waitUntilExit()
    if p.terminationStatus != 0 {
      throw NSError(domain: "OpenAGI.replay.shortcuts", code: 4, userInfo: [NSLocalizedDescriptionKey: "shortcut '\(name)' failed"])
    }
  }

  private func sendShortcut(_ spec: String) throws {
    try ComputerInput.sendShortcut(spec)
  }

  private func sendKey(named name: String, modifiers: CGEventFlags) throws {
    try ComputerInput.sendKey(named: name, modifiers: modifiers)
  }

  private func sendType(_ text: String) throws {
    try ComputerInput.sendType(text)
  }

  private func stringValue(_ v: Any) -> String {
    if let s = v as? String { return s }
    return "\(v)"
  }

  private func describe(_ v: Any) -> String {
    if let s = v as? String { return "\"\(s.prefix(60))\"" }
    return "\(v)"
  }
}
