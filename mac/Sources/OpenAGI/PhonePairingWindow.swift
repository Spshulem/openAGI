import AppKit
import SwiftUI
import WebKit

/// The Mac owner credential belongs only to loopback. A worker uses a saved
/// owner connection for the exact main origin, never its operational node token.
struct PhonePairingConnection {
  let origin: URL
  let ownerToken: String?

  static func origin(_ value: String) -> URL? {
    guard var url = URLComponents(string: value),
          ["http", "https"].contains(url.scheme?.lowercased() ?? ""),
          let host = url.host, !host.isEmpty, url.user == nil, url.password == nil,
          url.query == nil, url.fragment == nil, ["", "/"].contains(url.path) else { return nil }
    url.scheme = url.scheme?.lowercased()
    url.host = host.lowercased()
    if url.port == (url.scheme == "https" ? 443 : 80) { url.port = nil }
    url.path = ""
    return url.url
  }

  static func resolve(localOwnerToken: String?, nodeConfig: Data?, savedMainURL: String,
                      savedMainToken: String?) throws -> Self {
    struct NodeConfig: Decodable { let remote: String?; let token: String? }
    let config = try nodeConfig.map { try JSONDecoder().decode(NodeConfig.self, from: $0) }
    guard let remote = config?.remote, !remote.isEmpty else {
      return Self(origin: URL(string: "http://127.0.0.1:43210")!, ownerToken: localOwnerToken)
    }
    guard let main = origin(remote) else { throw PhonePairingError.invalidServer }
    let savedToken = origin(savedMainURL) == main ? savedMainToken : nil
    return Self(origin: main, ownerToken: savedToken?.isEmpty == false ? savedToken : config?.token)
  }

  func request(cookies: [HTTPCookie] = []) -> URLRequest {
    var request = URLRequest(url: origin.appendingPathComponent("nodes/enrollment-code"),
                             cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 15)
    request.httpMethod = "POST"
    request.httpBody = Data(#"{"platform":"mobile"}"#.utf8)
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    if let ownerToken, !ownerToken.isEmpty {
      request.setValue("Bearer \(ownerToken)", forHTTPHeaderField: "Authorization")
    } else {
      let matching = cookies.filter {
        $0.name == "openagi_token" && $0.domain.lowercased() == origin.host?.lowercased()
          && $0.path == "/" && (!$0.isSecure || origin.scheme == "https")
          && ($0.expiresDate == nil || $0.expiresDate! > Date())
      }
      for (key, value) in HTTPCookie.requestHeaderFields(with: matching) {
        request.setValue(value, forHTTPHeaderField: key)
      }
    }
    return request
  }
}

enum PhonePairingError: LocalizedError {
  case invalidServer, invalidCode, loopbackAddress, unauthorized, oldServer, refused
  static func message(for error: Error) -> String {
    if error is DecodingError { return PhonePairingError.invalidCode.localizedDescription }
    guard let network = error as? URLError else { return PhonePairingError.refused.localizedDescription }
    switch network.code {
    case .appTransportSecurityRequiresSecureConnection:
      return "macOS blocked this server’s connection. Update OpenAGI, then reopen phone pairing."
    case .serverCertificateUntrusted, .serverCertificateHasBadDate, .serverCertificateHasUnknownRoot,
         .serverCertificateNotYetValid, .secureConnectionFailed:
      return "The server’s secure connection could not be verified. Check its address and certificate."
    case .cannotFindHost, .dnsLookupFailed:
      return "The main-server address could not be found. Check its address and your Wi-Fi or Tailscale connection."
    default:
      return "Couldn’t reach your main server. Check Wi-Fi or Tailscale and allow OpenAGI access in System Settings → Privacy & Security → Local Network, then try again."
    }
  }

  var errorDescription: String? {
    switch self {
    case .invalidServer: return "The saved main-server address is invalid. Check this Mac’s server connection."
    case .invalidCode: return "The server returned an invalid or expired code. Try again."
    case .loopbackAddress: return "Your phone needs a Wi-Fi or Tailscale server address. Set the main server’s public URL, then try again."
    case .unauthorized: return "Authorize this Mac on the main server once. Its sign-in session is remembered for future pairing."
    case .oldServer: return "Update OpenAGI on your main server to enable phone pairing."
    case .refused: return "The server could not create a phone code. Check that this Mac is connected to the main server."
    }
  }
}

struct PhonePairingCode {
  let code: String
  let server: URL
  let expiresAt: Date

  static func decode(_ data: Data, connection: PhonePairingConnection, now: Date = Date()) throws -> Self {
    struct Response: Decodable { let code: String; let publicUrl: String?; let expiresAt: String }
    let response = try JSONDecoder().decode(Response.self, from: data)
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let fractional = formatter.date(from: response.expiresAt)
    formatter.formatOptions = [.withInternetDateTime]
    guard response.code.range(of: #"^\d{6}$"#, options: .regularExpression) != nil,
          let expiry = fractional ?? formatter.date(from: response.expiresAt), expiry > now else {
      throw PhonePairingError.invalidCode
    }
    func reachable(_ url: URL) -> Bool { !["localhost", "127.0.0.1", "::1", "[::1]"].contains(url.host ?? "") }
    let advertised = response.publicUrl.flatMap(PhonePairingConnection.origin)
    let server = advertised.flatMap { reachable($0) ? $0 : nil } ?? connection.origin
    guard reachable(server) else { throw PhonePairingError.loopbackAddress }
    return Self(code: response.code, server: server, expiresAt: expiry)
  }
}

/// Never let URLSession replay an owner credential to a redirect destination.
private final class PhonePairingTransport: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
  func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                  newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
    completionHandler(nil)
  }
}

@MainActor
final class PhonePairingModel: ObservableObject {
  @Published var code: PhonePairingCode?
  @Published var loading = false
  @Published var error: String?
  @Published var needsSignIn = false
  var connection: PhonePairingConnection?
  let cookies = WKWebsiteDataStore.default().httpCookieStore

  func generate() async {
    guard !loading, let connection else { return }
    loading = true; code = nil; error = nil
    defer { loading = false }
    do {
      // A remembered main login takes precedence over a stale saved bearer.
      // Never delete or overwrite the existing worker pairing.
      let savedCookies = await cookies.allCookies()
      let cookieRequest = PhonePairingConnection(origin: connection.origin, ownerToken: nil)
        .request(cookies: savedCookies)
      let hasSession = cookieRequest.value(forHTTPHeaderField: "Cookie") != nil
      let config = URLSessionConfiguration.ephemeral
      config.httpCookieStorage = nil
      let session = URLSession(configuration: config, delegate: PhonePairingTransport(), delegateQueue: nil)
      defer { session.invalidateAndCancel() }
      var (data, response) = try await session.data(for: hasSession ? cookieRequest : connection.request())
      if hasSession, let rejected = response as? HTTPURLResponse,
         [401, 403].contains(rejected.statusCode), connection.ownerToken?.isEmpty == false {
        (data, response) = try await session.data(for: connection.request())
      }
      guard let http = response as? HTTPURLResponse else { throw PhonePairingError.refused }
      if http.statusCode == 401 || http.statusCode == 403 {
        needsSignIn = true
        throw PhonePairingError.unauthorized
      }
      if http.statusCode == 404 { throw PhonePairingError.oldServer }
      guard http.statusCode == 200 else { throw PhonePairingError.refused }
      code = try PhonePairingCode.decode(data, connection: connection)
      needsSignIn = false
    } catch let failure as PhonePairingError { error = failure.localizedDescription }
    catch { self.error = PhonePairingError.message(for: error) }
  }
}

private struct PhonePairingView: View {
  @ObservedObject var model: PhonePairingModel
  let signIn: () -> Void
  var body: some View {
    VStack(alignment: .leading, spacing: 18) {
      Label("Connect a phone", systemImage: "iphone.and.arrow.forward").font(.title2.bold())
      Text("On your iPhone or Android phone, choose Connect to a server.")
        .foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
      if model.loading { ProgressView("Creating a pairing code on your main server…") }
      if let code = model.code {
        TimelineView(.periodic(from: .now, by: 1)) { context in
          if context.date < code.expiresAt {
            Text(code.code).font(.system(size: 48, weight: .medium, design: .monospaced))
              .textSelection(.enabled).accessibilityLabel("Pairing code \(code.code)")
            Text(code.server.absoluteString).textSelection(.enabled)
            Text("Single use · expires at \(code.expiresAt.formatted(date: .omitted, time: .shortened))")
              .font(.caption).foregroundStyle(.secondary)
            Button("Copy code") {
              NSPasteboard.general.clearContents()
              NSPasteboard.general.setString(code.code, forType: .string)
            }
          } else { Text("This code expired. Generate a new code to continue.") }
        }
      }
      if let error = model.error {
        Text(error).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
      }
      HStack {
        if model.needsSignIn { Button("Sign in to main server", action: signIn) }
        Button(model.code == nil ? "Try again" : "Generate another code") { Task { await model.generate() } }
          .disabled(model.loading)
      }
      Text("Each code connects one phone. Your phone remembers its connection after pairing.")
        .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
    }.padding(28).frame(maxWidth: .infinity, alignment: .leading)
  }
}

@MainActor
final class PhonePairingWindowController: NSObject, WKNavigationDelegate {
  static let shared = PhonePairingWindowController()
  private var window: NSWindow?
  private var signInWindow: NSWindow?
  private let model = PhonePairingModel()

  static func makeWindow(model: PhonePairingModel, signIn: @escaping () -> Void) -> NSWindow {
    let controller = NSHostingController(rootView: ScrollView {
      PhonePairingView(model: model, signIn: signIn)
    })
    // AppKit owns the window size. Driving preferred/minimum window sizing
    // from a changing SwiftUI layout can recursively invalidate constraints
    // on macOS 27 as the loading state becomes a code or an error.
    controller.sizingOptions = []
    let window = NSWindow(contentViewController: controller)
    window.title = "OpenAGI · Connect a phone"
    window.styleMask = [.titled, .closable, .miniaturizable, .resizable]
    window.setContentSize(NSSize(width: 520, height: 440))
    window.contentMinSize = NSSize(width: 360, height: 320)
    window.isReleasedWhenClosed = false
    window.center()
    return window
  }

  func show(state: AppState) {
    if let window, window.isVisible {
      window.makeKeyAndOrderFront(nil)
      NSApp.activate(ignoringOtherApps: true)
      return
    }
    if window == nil {
      window = Self.makeWindow(model: model, signIn: { [weak self] in self?.signIn() })
    }
    do {
      let path = AppState.dataDir().appendingPathComponent("node.json")
      let data = FileManager.default.fileExists(atPath: path.path) ? try Data(contentsOf: path) : nil
      model.connection = try PhonePairingConnection.resolve(localOwnerToken: state.authToken(), nodeConfig: data,
        savedMainURL: state.outreachRemoteURL, savedMainToken: state.outreachToken)
      model.needsSignIn = false
      Task { await model.generate() }
    } catch {
      model.connection = nil; model.code = nil
      model.error = PhonePairingError.invalidServer.localizedDescription
    }
    window?.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
  }

  private func signIn() {
    guard let connection = model.connection else { return }
    let web = WKWebView()
    web.navigationDelegate = self
    let controller = NSViewController(); controller.view = web
    let win = NSWindow(contentViewController: controller)
    win.title = "Sign in · \(connection.origin.host ?? "main server")"
    win.setContentSize(NSSize(width: 520, height: 620))
    win.styleMask = [.titled, .closable, .resizable]
    win.isReleasedWhenClosed = false
    signInWindow?.close(); signInWindow = win
    // No local bearer, operational token, or query credential goes to main.
    web.load(URLRequest(url: connection.origin.appendingPathComponent("/")))
    win.center(); win.makeKeyAndOrderFront(nil)
  }

  func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
               decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    guard let url = action.request.url, let main = model.connection?.origin,
          url.scheme == main.scheme, url.host == main.host, url.port == main.port,
          url.user == nil, url.password == nil else { decisionHandler(.cancel); return }
    decisionHandler(.allow)
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    Task {
      await model.generate()
      if model.code != nil { signInWindow?.close(); signInWindow = nil }
    }
  }
}
