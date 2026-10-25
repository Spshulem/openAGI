import AppKit
import WebKit

/// Pairing stays in a dedicated desktop window. The daemon's normal owner
/// sign-in gate and persistent WebKit cookies authorize code generation.
@MainActor
final class PhonePairingWindowController: NSObject, WKNavigationDelegate, WKUIDelegate {
  static let shared = PhonePairingWindowController()
  private var window: NSWindow?
  private var webView: WKWebView?

  func show(state: AppState) {
    if let window, window.isVisible {
      window.makeKeyAndOrderFront(nil)
      NSApp.activate(ignoringOtherApps: true)
      return
    }
    if window == nil {
      let web = WKWebView(frame: .zero)
      web.navigationDelegate = self
      web.uiDelegate = self
      let back = NSButton(title: "Back", target: self, action: #selector(goBack))
      let restart = NSButton(title: "Start over", target: self, action: #selector(startOver))
      let controls = NSStackView(views: [back, restart])
      controls.spacing = 8
      controls.edgeInsets = NSEdgeInsets(top: 8, left: 12, bottom: 8, right: 12)
      let content = NSStackView(views: [controls, web])
      content.orientation = .vertical
      content.alignment = .leading
      web.widthAnchor.constraint(equalTo: content.widthAnchor).isActive = true
      let controller = NSViewController()
      controller.view = content
      let win = NSWindow(contentViewController: controller)
      win.title = "OpenAGI · Connect a phone"
      win.styleMask = [.titled, .closable, .miniaturizable, .resizable]
      win.setContentSize(NSSize(width: 540, height: 620))
      win.minSize = NSSize(width: 400, height: 420)
      win.center()
      win.isReleasedWhenClosed = false
      window = win
      webView = web
    }
    // Always authenticate only to the fixed loopback origin. A worker's
    // pairing page links to main without forwarding its local owner token.
    let request = Self.localRequest(ownerToken: state.authToken())
    if let cookie = Self.localCookie(ownerToken: state.authToken()), let webView {
      webView.configuration.websiteDataStore.httpCookieStore.setCookie(cookie) {
        webView.load(request)
      }
    } else {
      webView?.load(request)
    }
    window?.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
  }

  @objc private func goBack() { webView?.goBack() }
  @objc private func startOver() {
    webView?.load(URLRequest(url: URL(string: "http://127.0.0.1:43210/phone-pairing")!))
  }

  func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
               decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
    if navigationResponse.isForMainFrame,
       let response = navigationResponse.response as? HTTPURLResponse,
       response.statusCode == 404, response.url?.path == "/phone-pairing" {
      decisionHandler(.cancel)
      let alert = NSAlert()
      alert.messageText = "Update OpenAGI on your main server"
      alert.informativeText = "This server has an older dashboard without the phone-pairing screen. Update OpenAGI there, then choose Start over. You can also run openagi pair-phone --platform ios (or android) in a terminal on that main server."
      alert.addButton(withTitle: "OK")
      if let window { alert.beginSheetModal(for: window) }
      return
    }
    decisionHandler(.allow)
  }

  nonisolated static func localRequest(ownerToken: String?) -> URLRequest {
    var request = URLRequest(url: URL(string: "http://127.0.0.1:43210/phone-pairing")!)
    if let ownerToken, !ownerToken.isEmpty {
      request.setValue("Bearer \(ownerToken)", forHTTPHeaderField: "Authorization")
    }
    return request
  }

  nonisolated static func localCookie(ownerToken: String?) -> HTTPCookie? {
    guard let ownerToken, !ownerToken.isEmpty else { return nil }
    let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()")
    guard let encoded = ownerToken.addingPercentEncoding(withAllowedCharacters: allowed) else { return nil }
    return HTTPCookie(properties: [
      .domain: "127.0.0.1", .path: "/", .name: "openagi_token", .value: encoded,
      .expires: Date(timeIntervalSinceNow: 30 * 24 * 60 * 60),
      HTTPCookiePropertyKey("HttpOnly"): "TRUE", HTTPCookiePropertyKey("SameSite"): "Strict"
    ])
  }

  /// Rebuild navigations to another origin rather than carrying the local
  /// request's Authorization header across a link or redirect.
  nonisolated static func cleanNavigation(_ request: URLRequest) -> URLRequest? {
    guard let url = request.url, ["http", "https"].contains(url.scheme?.lowercased() ?? ""),
          var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
    if url.scheme == "http", url.host == "127.0.0.1", url.port == 43210 { return request }
    components.user = nil
    components.password = nil
    guard let cleanURL = components.url else { return nil }
    var clean = request
    clean.url = cleanURL
    clean.setValue(nil, forHTTPHeaderField: "Authorization")
    return clean
  }

  func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
               decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    guard let clean = Self.cleanNavigation(navigationAction.request) else {
      decisionHandler(.cancel)
      return
    }
    if clean != navigationAction.request || navigationAction.targetFrame == nil {
      decisionHandler(.cancel)
      webView.load(clean)
      return
    }
    decisionHandler(.allow)
  }

  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
    guard (error as NSError).code != NSURLErrorCancelled else { return }
    let alert = NSAlert()
    alert.messageText = "Could not open phone pairing"
    alert.informativeText = "Check that OpenAGI is running and that your main server is reachable over Wi-Fi or Tailscale, then reopen Connect a phone."
    alert.addButton(withTitle: "OK")
    if let window { alert.beginSheetModal(for: window) }
  }
}
