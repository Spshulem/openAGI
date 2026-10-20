import Foundation

// Links only reveal controls. They never grant permission or change capture.
enum AppLink {
  static func opensPrivacy(_ url: URL) -> Bool {
    url.scheme?.lowercased() == "openagi"
      && url.host?.lowercased() == "privacy"
      && (url.path.isEmpty || url.path == "/")
      && url.user == nil && url.password == nil && url.port == nil
      && url.query == nil && url.fragment == nil
  }
}
