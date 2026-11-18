import AppKit
import Foundation
import UniformTypeIdentifiers

struct WorkspaceImageAttachment: Identifiable, Equatable {
  let id: String
  let name: String
  let mimeType: String
  let data: String
  let thumbnail: String
  let previewData: Data
  let preview: NSImage

  static func == (lhs: WorkspaceImageAttachment, rhs: WorkspaceImageAttachment) -> Bool {
    lhs.id == rhs.id && lhs.data == rhs.data
  }

  var agentHostPayload: [String: Any] {
    [
      "id": id,
      "name": name,
      "mimeType": mimeType,
      "data": data,
      "thumbnail": thumbnail
    ]
  }

  var fleetPayload: [String: Any] {
    [
      "id": id,
      "name": name,
      "mimeType": mimeType,
      "data": data
    ]
  }

  static func encode(_ image: NSImage, name: String) -> WorkspaceImageAttachment? {
    let rawSize = image.size
    guard rawSize.width > 0, rawSize.height > 0 else { return nil }

    let maxDim: CGFloat = 1440
    let thumbDim: CGFloat = 140
    guard let mainData = renderJPEG(image, maxDimension: maxDim, maxBytes: 700_000),
          let thumbData = renderJPEG(image, maxDimension: thumbDim, maxBytes: 18_000),
          mainData.count < 950_000,
          mainData.prefix(3) == Data([0xFF, 0xD8, 0xFF]),
          let previewImg = NSImage(data: mainData) else {
      return nil
    }

    let cleanedName = String(
      name.unicodeScalars.filter { $0.value >= 0x20 && $0.value != 0x7F }
    ).trimmingCharacters(in: .whitespacesAndNewlines)
    let safeName = cleanedName.isEmpty ? "Image.jpg" : String(cleanedName.prefix(80))
    let cleanId = "img_\(UUID().uuidString.replacingOccurrences(of: "-", with: "").prefix(16))"

    return WorkspaceImageAttachment(
      id: cleanId,
      name: safeName,
      mimeType: "image/jpeg",
      data: mainData.base64EncodedString(),
      thumbnail: thumbData.base64EncodedString(),
      previewData: thumbData,
      preview: previewImg
    )
  }

  private static func renderJPEG(_ image: NSImage, maxDimension: CGFloat, maxBytes: Int) -> Data? {
    let size = image.size
    guard size.width > 0, size.height > 0 else { return nil }
    var scale = min(1.0, maxDimension / max(size.width, size.height))

    for attempt in 0..<4 {
      let targetW = max(1, Int((size.width * scale).rounded()))
      let targetH = max(1, Int((size.height * scale).rounded()))
      guard let rep = NSBitmapImageRep(
        bitmapDataPlanes: nil,
        pixelsWide: targetW,
        pixelsHigh: targetH,
        bitsPerSample: 8,
        samplesPerPixel: 4,
        hasAlpha: true,
        isPlanar: false,
        colorSpaceName: .deviceRGB,
        bytesPerRow: 0,
        bitsPerPixel: 0
      ) else { return nil }
      rep.size = NSSize(width: targetW, height: targetH)
      NSGraphicsContext.saveGraphicsState()
      NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
      NSColor.white.setFill()
      NSRect(x: 0, y: 0, width: targetW, height: targetH).fill()
      image.draw(
        in: NSRect(x: 0, y: 0, width: targetW, height: targetH),
        from: .zero,
        operation: .sourceOver,
        fraction: 1.0
      )
      NSGraphicsContext.restoreGraphicsState()

      for quality in [0.78, 0.62, 0.48] {
        if let encoded = rep.representation(using: .jpeg, properties: [.compressionFactor: quality]),
           encoded.count <= maxBytes {
          return encoded
        }
      }
      scale *= (attempt == 0 ? 0.72 : 0.75)
    }
    return nil
  }

  @MainActor
  static func pickImages(limit: Int = 4) -> [WorkspaceImageAttachment] {
    let panel = NSOpenPanel()
    panel.canChooseFiles = true
    panel.canChooseDirectories = false
    panel.allowsMultipleSelection = limit > 1
    panel.allowedContentTypes = [.image]
    panel.prompt = "Attach"
    guard panel.runModal() == .OK else { return [] }
    return panel.urls.prefix(limit).compactMap { url in
      guard let img = NSImage(contentsOf: url) else { return nil }
      return encode(img, name: url.lastPathComponent)
    }
  }

  @MainActor
  static func fromPasteboard(_ pb: NSPasteboard = .general, limit: Int = 4) -> [WorkspaceImageAttachment] {
    if let urls = pb.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL] {
      let fromURLs = urls.prefix(limit).compactMap { url -> WorkspaceImageAttachment? in
        guard let uti = UTType(filenameExtension: url.pathExtension),
              uti.conforms(to: .image),
              let img = NSImage(contentsOf: url) else { return nil }
        return encode(img, name: url.lastPathComponent)
      }
      if !fromURLs.isEmpty { return fromURLs }
    }
    if let img = NSImage(pasteboard: pb),
       let encoded = encode(img, name: "Pasted image.jpg") {
      return [encoded]
    }
    return []
  }

  static func fromDropProviders(_ providers: [NSItemProvider], limit: Int = 4) async -> [WorkspaceImageAttachment] {
    var result: [WorkspaceImageAttachment] = []
    for provider in providers.prefix(limit) {
      if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
        let loadedURL: URL? = await withCheckedContinuation { cont in
          provider.loadItem(forTypeIdentifier: UTType.fileURL.identifier, options: nil) { item, _ in
            if let data = item as? Data, let url = URL(dataRepresentation: data, relativeTo: nil) {
              cont.resume(returning: url)
            } else if let url = item as? URL {
              cont.resume(returning: url)
            } else {
              cont.resume(returning: nil)
            }
          }
        }
        if let url = loadedURL,
           let uti = UTType(filenameExtension: url.pathExtension),
           uti.conforms(to: .image) {
          let att = await MainActor.run { () -> WorkspaceImageAttachment? in
            guard let img = NSImage(contentsOf: url) else { return nil }
            return encode(img, name: url.lastPathComponent)
          }
          if let att { result.append(att); continue }
        }
      }
      if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
        let imageData: Data? = await withCheckedContinuation { cont in
          provider.loadDataRepresentation(forTypeIdentifier: UTType.image.identifier) { data, _ in
            cont.resume(returning: data)
          }
        }
        if let data = imageData {
          let att = await MainActor.run { () -> WorkspaceImageAttachment? in
            guard let img = NSImage(data: data) else { return nil }
            return encode(img, name: "Dropped image.jpg")
          }
          if let att { result.append(att) }
        }
      }
    }
    return Array(result.prefix(limit))
  }
}

struct SyncedSupervisorMessage: Identifiable, Decodable, Equatable, Sendable {
  let id: String
  let role: String
  let text: String
  let at: String?
  let sourceName: String?
  let sourceNodeId: String?
  var localThumbnailData: [Data] = []

  enum CodingKeys: String, CodingKey {
    case id, role, text, at, sourceName, sourceNodeId
  }
}

struct MacTaskItem: Identifiable, Decodable, Equatable, Sendable {
  let id: String
  let title: String
  let status: String
  let priority: Int?
  let dueAt: String?
  let notes: String?
}

private struct SyncedHistoryResponse: Decodable {
  let messages: [SyncedSupervisorMessage]
}

private struct TasksListResponse: Decodable {
  let tasks: [MacTaskItem]
}

/// Keeps Mac Supervisor Quick Ask, Supervisor Workspace Window, Paseo, iPhone,
/// and Even G2 synced via `devices:supervisor:main` + `/tasks`.
@MainActor
final class SharedSupervisorClient: ObservableObject {
  static let shared = SharedSupervisorClient()

  @Published private(set) var messages: [SyncedSupervisorMessage] = []
  @Published private(set) var tasks: [MacTaskItem] = []
  @Published private(set) var isSending = false
  @Published private(set) var lastError: String? = nil

  private init() {}

  func refreshAll() async {
    await withTaskGroup(of: Void.self) { group in
      group.addTask { await self.refreshMessages() }
      group.addTask { await self.refreshTasks() }
    }
  }

  func refreshMessages() async {
    var req = URLRequest(url: AppState.buildURL(
      base: AppState.shared.baseURL,
      path: "/conversations/supervisor/messages?limit=50"))
    authed(&req)
    req.timeoutInterval = 8
    do {
      let (data, response) = try await URLSession.shared.data(for: req)
      try AppState.ensureOK(response, data)
      let decoded = try JSONDecoder().decode(SyncedHistoryResponse.self, from: data)
      messages = decoded.messages
      lastError = nil
    } catch {
      // Keep cached transcript cleanly when daemon is restarting.
    }
  }

  func refreshTasks() async {
    var req = URLRequest(url: AppState.buildURL(
      base: AppState.shared.baseURL,
      path: "/tasks?queue=user"))
    authed(&req)
    req.timeoutInterval = 8
    do {
      let (data, response) = try await URLSession.shared.data(for: req)
      try AppState.ensureOK(response, data)
      let decoded = try JSONDecoder().decode(TasksListResponse.self, from: data)
      tasks = decoded.tasks.filter { $0.status != "done" && $0.status != "completed" }
    } catch {
      // Non-fatal while daemon starts up.
    }
  }

  func sendMessage(_ text: String, focusedCardId: String? = nil, attachments: [WorkspaceImageAttachment] = []) async {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard (!trimmed.isEmpty || !attachments.isEmpty), !isSending else { return }
    isSending = true
    lastError = nil
    defer { isSending = false }

    let displayText = trimmed.isEmpty ? "Please inspect the attached screenshot(s)." : trimmed
    let optimistic = SyncedSupervisorMessage(
      id: "local_\(UUID().uuidString)",
      role: "user",
      text: displayText,
      at: ISO8601DateFormatter().string(from: Date()),
      sourceName: "Mac",
      sourceNodeId: nil,
      localThumbnailData: attachments.map(\.previewData)
    )
    messages.append(optimistic)

    var payload: [String: Any] = [
      "text": displayText,
      "thread": "supervisor",
      "metadata": ["sourceName": "Mac"]
    ]
    if let focusedCardId, !focusedCardId.isEmpty {
      payload["focusedCardId"] = focusedCardId
    }
    if !attachments.isEmpty {
      payload["attachments"] = attachments.map(\.agentHostPayload)
    }
    var req = URLRequest(url: AppState.buildURL(base: AppState.shared.baseURL, path: "/message"))
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.httpBody = try? JSONSerialization.data(withJSONObject: payload)
    req.timeoutInterval = 180
    authed(&req)

    do {
      let (data, response) = try await URLSession.shared.data(for: req)
      try AppState.ensureOK(response, data)
      await refreshMessages()
      await refreshTasks()
    } catch {
      lastError = error.localizedDescription
    }
  }

  func appendMirror(userText: String, assistantText: String) async {
    let u = userText.trimmingCharacters(in: .whitespacesAndNewlines)
    let a = assistantText.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !u.isEmpty || !a.isEmpty else { return }
    var batch: [[String: Any]] = []
    if !u.isEmpty {
      batch.append(["id": "mac_\(UUID().uuidString)", "role": "user", "text": u])
    }
    if !a.isEmpty {
      batch.append(["id": "mac_\(UUID().uuidString)", "role": "assistant", "text": a])
    }
    var req = URLRequest(url: AppState.buildURL(
      base: AppState.shared.baseURL,
      path: "/conversations/supervisor/append"))
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.httpBody = try? JSONSerialization.data(withJSONObject: [
      "sourceName": "Mac",
      "messages": batch
    ])
    req.timeoutInterval = 8
    authed(&req)
    _ = try? await URLSession.shared.data(for: req)
    await refreshMessages()
  }

  func createTask(title: String) async {
    let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return }
    var req = URLRequest(url: AppState.buildURL(base: AppState.shared.baseURL, path: "/tasks"))
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.httpBody = try? JSONSerialization.data(withJSONObject: [
      "title": trimmed,
      "queue": "user",
      "source": "supervisor"
    ])
    authed(&req)
    _ = try? await URLSession.shared.data(for: req)
    await refreshTasks()
  }

  func completeTask(_ id: String) async {
    var req = URLRequest(url: AppState.buildURL(
      base: AppState.shared.baseURL,
      path: "/tasks/\(id)/complete"))
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.httpBody = Data("{}".utf8)
    authed(&req)
    _ = try? await URLSession.shared.data(for: req)
    await refreshTasks()
  }

  private func authed(_ req: inout URLRequest) {
    if let token = AppState.shared.authToken(), !token.isEmpty {
      req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    }
  }
}
