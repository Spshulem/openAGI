import Foundation
import Darwin

enum LegacyLaunchAgentCleanup {
  private static let labels = [
    "app.openagi.imessage-bridge": "imessage-bridge",
    "app.openagi.imessage-server": "imessage-server",
  ]

  static func run() {
    let manager = FileManager.default
    let home = manager.homeDirectoryForCurrentUser
    let domain = "gui/\(getuid())"
    for (label, expectedCommand) in labels {
      let plist = home.appendingPathComponent("Library/LaunchAgents/\(label).plist")
      guard let dictionary = NSDictionary(contentsOf: plist),
            owns(dictionary: dictionary, label: label, expectedCommand: expectedCommand) else { continue }

      let loaded = launchctl(["print", "\(domain)/\(label)"]) == 0
      if loaded && launchctl(["bootout", "\(domain)/\(label)"]) != 0 {
        NSLog("OpenAGI: could not stop owned legacy launch agent \(label); leaving its plist intact")
        continue
      }
      do {
        try manager.removeItem(at: plist)
        NSLog("OpenAGI: removed owned legacy launch agent \(label); signed daemon now owns this service")
      } catch {
        NSLog("OpenAGI: could not remove owned legacy launch agent \(label): \(error.localizedDescription)")
      }
    }
  }

  static func owns(dictionary: NSDictionary, label: String, expectedCommand: String) -> Bool {
    guard dictionary["Label"] as? String == label,
          let arguments = dictionary["ProgramArguments"] as? [String] else { return false }
    return arguments.contains(expectedCommand)
      && arguments.contains(where: { $0.hasSuffix("/bin/openagi.js") })
  }

  @discardableResult
  private static func launchctl(_ arguments: [String]) -> Int32 {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
    process.arguments = arguments
    process.standardOutput = FileHandle.nullDevice
    process.standardError = FileHandle.nullDevice
    do {
      try process.run()
      let deadline = Date().addingTimeInterval(2)
      while process.isRunning && Date() < deadline {
        Thread.sleep(forTimeInterval: 0.02)
      }
      if process.isRunning {
        process.terminate()
        Thread.sleep(forTimeInterval: 0.1)
        if process.isRunning { kill(process.processIdentifier, SIGKILL) }
        return -1
      }
      return process.terminationStatus
    } catch {
      return -1
    }
  }
}
