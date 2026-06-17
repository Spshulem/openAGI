import Foundation

// Durable consumer of a remote "main" Distiller's proactive-outreach feed.
//
// This points at a SEPARATE host from AppState's local daemon (the remote main
// the user designates), so it keeps its own baseURL/token and its own SSE
// connection rather than piggybacking on SSEDelegate.shared (which is hardwired
// to the local /events stream).
//
// Losslessness comes from the cursor: every item has a monotonic `seq`. We
// persist the highest seq we've folded in (`outreachCursor`) and, on every
// (re)connect, pull `GET /outreach/feed?since=<cursor>` to catch up everything
// that fired while we were offline. The SSE "outreach" event is only a nudge to
// re-pull — the cursor stays authoritative.
@MainActor
final class OutreachConsumer: ObservableObject {
  static let shared = OutreachConsumer()

  @Published private(set) var items: [OutreachItem] = []
  @Published private(set) var configured: Bool = false
  // Server's configurable quiet-hours window (HH:mm). nil until /outreach/config
  // is fetched; inQuietHours() falls back to a 22:00–08:00 default meanwhile.
  @Published private(set) var quietHours: (start: String, end: String)? = nil

  private var baseURL: URL?
  private var token: String = ""
  private var sse: OutreachSSEDelegate?
  private var sseSession: URLSession?

  private var cursor: Int { UserDefaults.standard.integer(forKey: "outreachCursor") }
  private func setCursor(_ v: Int) { UserDefaults.standard.set(v, forKey: "outreachCursor") }

  // Point the consumer at a remote main and start backfill + live stream.
  // Safe to call repeatedly (e.g. when the user changes the URL in settings).
  func reconfigure(url: String, token: String) {
    self.baseURL = URL(string: url)
    self.token = token
    self.configured = (self.baseURL != nil)
    guard configured else { return }
    Task { await backfill() }
    Task { await fetchConfig() }
    startSSE()
  }

  // Pull the server's outreach config so the client quiet-hours window tracks
  // the server's configurable one rather than a hardcoded 22:00–08:00.
  func fetchConfig() async {
    guard let base = baseURL else { return }
    var req = URLRequest(url: base.appendingPathComponent("outreach/config"))
    authed(&req)
    do {
      let (data, _) = try await URLSession.shared.data(for: req)
      let cfg = try JSONDecoder().decode(OutreachConfigResponse.self, from: data)
      if let q = cfg.quietHours {
        quietHours = (start: q.start, end: q.end)
      }
    } catch {
      // Keep whatever we had; inQuietHours() falls back to the default window.
    }
  }

  // Minute-granular, overnight-aware quiet-hours check using the server's window
  // (falls back to 22:00–08:00 until config is fetched).
  func inQuietHours(_ date: Date = Date()) -> Bool {
    guard let q = quietHours else { return defaultQuiet(date) }
    func mins(_ s: String) -> Int {
      let p = s.split(separator: ":")
      return (Int(p.first ?? "0") ?? 0) * 60 + (p.count > 1 ? Int(p[1]) ?? 0 : 0)
    }
    let now = Calendar.current.component(.hour, from: date) * 60 + Calendar.current.component(.minute, from: date)
    let s = mins(q.start), e = mins(q.end)
    return s <= e ? (now >= s && now < e) : (now >= s || now < e)
  }

  private func defaultQuiet(_ date: Date) -> Bool {
    let h = Calendar.current.component(.hour, from: date)
    return h >= 22 || h < 8
  }

  private func authed(_ req: inout URLRequest) {
    if !token.isEmpty { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
  }

  // Pull everything we missed since our last cursor — lossless on reconnect.
  func backfill() async {
    guard let base = baseURL else { return }
    var comps = URLComponents(url: base.appendingPathComponent("outreach/feed"), resolvingAgainstBaseURL: false)
    comps?.queryItems = [URLQueryItem(name: "since", value: String(cursor))]
    guard let feedURL = comps?.url else { return }
    var req = URLRequest(url: feedURL)
    authed(&req)
    do {
      let (data, _) = try await URLSession.shared.data(for: req)
      let feed = try JSONDecoder().decode(OutreachFeedResponse.self, from: data)
      ingest(feed.items)
      if feed.cursor > cursor { setCursor(feed.cursor) }
    } catch {
      // Offline / unreachable: keep the cursor and retry on the next SSE
      // reconnect or reconfigure. Nothing is lost.
    }
  }

  private func ingest(_ incoming: [OutreachItem]) {
    for item in incoming.sorted(by: { $0.seq < $1.seq }) {
      // Drop items already resolved server-side; only surface live ones.
      let resolved = (item.status == "acted" || item.status == "dismissed")
      if resolved {
        items.removeAll { $0.id == item.id }
        continue
      }
      if items.contains(where: { $0.id == item.id }) { continue }
      items.insert(item, at: 0)
      NotificationPresenter.shared.present(item)
    }
  }

  // Server resolved an item out-of-band (cross-device act, cron, auto-resolve).
  // The SSE "outreach-resolved" event carries the item; drop it from the overlay.
  func removeResolved(_ id: String) { items.removeAll { $0.id == id } }

  func act(_ id: String, action: String, note: String? = nil) async {
    var body: [String: Any] = ["action": action]
    if let note { body["note"] = note }
    if await post("outreach/\(id)/act", body: body) {
      items.removeAll { $0.id == id }
    } else {
      await backfill() // failed: don't lose it — reconcile (it may already be resolved, else it stays visible)
    }
  }

  func reply(_ id: String, text: String) async {
    if await post("outreach/\(id)/reply", body: ["text": text]) {
      items.removeAll { $0.id == id }
    } else {
      await backfill()
    }
  }

  @discardableResult
  private func post(_ pathPart: String, body: [String: Any]) async -> Bool {
    guard let base = baseURL else { return false }
    var req = URLRequest(url: base.appendingPathComponent(pathPart))
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    authed(&req)
    req.httpBody = try? JSONSerialization.data(withJSONObject: body)
    do {
      let (_, resp) = try await URLSession.shared.data(for: req)
      return ((resp as? HTTPURLResponse)?.statusCode).map { (200..<300).contains($0) } ?? false
    } catch { return false }
  }

  private func startSSE() {
    // Tear down the previous session before creating a new one so reconnects
    // and reconfigures don't leak sessions or leave overlapping streams.
    sseSession?.invalidateAndCancel()
    sseSession = nil
    sse = nil

    guard let base = baseURL else { return }
    let url = base.appendingPathComponent("events")
    var req = URLRequest(url: url)
    authed(&req)
    let delegate = OutreachSSEDelegate()
    self.sse = delegate
    self.sseSession = delegate.start(req)
  }

  // Called by the SSE delegate after a disconnect: re-pull (lossless) and
  // re-establish the live stream so we keep getting nudges.
  func reconnectSSE() {
    Task { await backfill() }
    startSSE()
  }
}

// Decoding shape for GET /outreach/config. We only need the quiet-hours window;
// other fields (enabled, cadenceHours, stalledDays) are ignored here.
private struct OutreachConfigResponse: Decodable {
  struct QH: Decodable { let start: String; let end: String }
  let quietHours: QH?
}

// Dedicated SSE listener for the remote main's /events stream. On any
// "outreach" / "outreach-resolved" event it asks the consumer to re-pull the
// feed (cursor stays authoritative). Auto-reconnects with a 5s backoff.
final class OutreachSSEDelegate: NSObject, URLSessionDataDelegate {
  private var buffer = ""
  private var session: URLSession?
  private var task: URLSessionDataTask?

  @discardableResult
  func start(_ req: URLRequest) -> URLSession {
    let cfg = URLSessionConfiguration.default
    cfg.timeoutIntervalForRequest = 0
    cfg.timeoutIntervalForResource = 0
    let session = URLSession(configuration: cfg, delegate: self, delegateQueue: nil)
    self.session = session
    let task = session.dataTask(with: req)
    self.task = task
    task.resume()
    return session
  }

  func urlSession(_ s: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    guard let chunk = String(data: data, encoding: .utf8) else { return }
    buffer += chunk
    while let nl = buffer.range(of: "\n\n") {
      let block = String(buffer[..<nl.lowerBound])
      buffer.removeSubrange(buffer.startIndex..<nl.upperBound)
      var event = "message"
      var dataLine = ""
      for raw in block.split(separator: "\n") {
        let line = String(raw)
        if line.hasPrefix("event:") {
          event = line.dropFirst("event:".count).trimmingCharacters(in: .whitespaces)
        } else if line.hasPrefix("data:") {
          dataLine += line.dropFirst("data:".count).trimmingCharacters(in: .whitespaces)
        }
      }
      if event == "outreach" {
        Task { @MainActor in await OutreachConsumer.shared.backfill() }
      } else if event == "outreach-resolved" {
        // resolve() server-side does NOT bump seq, so since=cursor backfill won't
        // surface this resolution. The event's data payload IS the resolved item;
        // pull its id and remove it directly. Fall back to backfill on decode fail.
        if let d = dataLine.data(using: .utf8),
           let obj = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
           let rid = obj["id"] as? String {
          Task { @MainActor in OutreachConsumer.shared.removeResolved(rid) }
        } else {
          Task { @MainActor in await OutreachConsumer.shared.backfill() }
        }
      }
    }
  }

  func urlSession(_ s: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    // An intentional teardown (startSSE invalidating the prior session on
    // reconnect/reconfigure) completes with NSURLErrorCancelled. The replacement
    // stream is already being started, so do NOT schedule another reconnect —
    // otherwise we'd tear down the working session and rebuild it every 5s.
    if (error as NSError?)?.code == NSURLErrorCancelled { return }
    // A genuine drop: reconnect through the consumer so a fresh request (current
    // token/URL) is built and a NEW live stream is established; backfill on
    // reconnect catches up anything missed while down.
    DispatchQueue.main.asyncAfter(deadline: .now() + 5) {
      Task { @MainActor in OutreachConsumer.shared.reconnectSSE() }
    }
  }
}
