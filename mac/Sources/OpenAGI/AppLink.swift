import Foundation

// Links only reveal controls. They never grant permission or change capture.
enum AppLink {
  static func opensPrivacy(_ url: URL) -> Bool {
    matches(url, host: "privacy")
  }

  static func opensSupervisor(_ url: URL) -> Bool {
    matches(url, host: "supervisor")
  }

  private static func matches(_ url: URL, host: String) -> Bool {
    url.scheme?.lowercased() == "openagi"
      && url.host?.lowercased() == host
      && (url.path.isEmpty || url.path == "/")
      && url.user == nil && url.password == nil && url.port == nil
      && url.query == nil && url.fragment == nil
  }
}
