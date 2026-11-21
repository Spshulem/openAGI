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
  static func fromLocalImagePath(_ raw: String) -> WorkspaceImageAttachment? {
    var trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    if (trimmed.hasPrefix("\"") && trimmed.hasSuffix("\""))
        || (trimmed.hasPrefix("'") && trimmed.hasSuffix("'")),
       trimmed.count >= 2 {
      trimmed = String(trimmed.dropFirst().dropLast())
    }
    guard !trimmed.isEmpty else { return nil }
    let filePath: String
    if trimmed.lowercased().hasPrefix("file://"),
       let fileURL = URL(string: trimmed),
       fileURL.isFileURL {
      filePath = fileURL.path
    } else if trimmed.hasPrefix("/") {
      filePath = trimmed
    } else if trimmed.hasPrefix("~/") {
      filePath = NSString(string: trimmed).expandingTildeInPath
    } else {
      return nil
    }
    var isDir: ObjCBool = false
    guard FileManager.default.fileExists(atPath: filePath, isDirectory: &isDir), !isDir.boolValue else {
      return nil
    }
    let url = URL(fileURLWithPath: filePath)
    guard let uti = UTType(filenameExtension: url.pathExtension),
          uti.conforms(to: .image),
          let img = NSImage(contentsOf: url) else {
      return nil
    }
    return encode(img, name: url.lastPathComponent)
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
    if let str = pb.string(forType: .string), let fromPath = fromLocalImagePath(str) {
      return [fromPath]
    }
    if let img = NSImage(pasteboard: pb),
       let encoded = encode(img, name: "Pasted image.jpg") {
      return [encoded]
    }
    return []
  }

  /// Resolves image attachments on `Cmd+V` without hijacking normal prose paste
  /// (e.g. rich-text copies that include a string alongside non-image formatting).
  @MainActor
  static func pasteboardImagesForCommandV(_ pb: NSPasteboard = .general, limit: Int = 4) -> [WorkspaceImageAttachment] {
    guard limit > 0 else { return [] }
    if let urls = pb.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL] {
      let fromURLs = urls.prefix(limit).compactMap { url -> WorkspaceImageAttachment? in
        guard let uti = UTType(filenameExtension: url.pathExtension),
              uti.conforms(to: .image),
              let img = NSImage(contentsOf: url) else { return nil }
        return encode(img, name: url.lastPathComponent)
      }
      if !fromURLs.isEmpty { return fromURLs }
    }
    let rawString = pb.string(forType: .string)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    if !rawString.isEmpty, let fromPath = fromLocalImagePath(rawString) {
      return [fromPath]
    }
    let rasterTypes: [NSPasteboard.PasteboardType] = [
      .png,
      .tiff,
      NSPasteboard.PasteboardType("public.jpeg"),
      NSPasteboard.PasteboardType("org.webmproject.webp"),
      NSPasteboard.PasteboardType("public.heic")
    ]
    if pb.availableType(from: rasterTypes) != nil {
      let stringIsFilenameOrEmpty = rawString.isEmpty
        || rawString.lowercased().hasPrefix("http://")
        || rawString.lowercased().hasPrefix("https://")
        || rawString.lowercased().hasPrefix("file://")
        || fromLocalImagePath(rawString) != nil
        || (!rawString.contains(" ") && !rawString.contains("\n") && rawString.count <= 120)
      if stringIsFilenameOrEmpty,
         let img = NSImage(pasteboard: pb),
         let encoded = encode(img, name: "Pasted image.jpg") {
        return [encoded]
      }
    }
    return []
  }

  @MainActor
  static func extractInlineLocalImages(from text: String, limit: Int = 4) -> (cleanedText: String, attachments: [WorkspaceImageAttachment]) {
    guard limit > 0, text.contains("/") else { return (text, []) }
    let pattern = #"(?i)(?:(?<=^)|(?<=[\s"'(]))(?:file://)?((?:~|/)[^\n\r]*?\.(?:png|jpe?g|webp|gif|heic))(?=$|[\s"')\]])"#
    guard let regex = try? NSRegularExpression(pattern: pattern) else {
      return (text, [])
    }
    let nsText = text as NSString
    let fullRange = NSRange(location: 0, length: nsText.length)
    let matches = regex.matches(in: text, options: [], range: fullRange)
    guard !matches.isEmpty else { return (text, []) }

    var attachments: [WorkspaceImageAttachment] = []
    var rangesToRemove: [NSRange] = []
    for match in matches {
      guard attachments.count < limit else { break }
      let pathRange = match.range(at: 1)
      guard pathRange.location != NSNotFound else { continue }
      let rawPath = nsText.substring(with: pathRange)
      let decoded = rawPath.removingPercentEncoding ?? rawPath
      guard let att = fromLocalImagePath(decoded) ?? fromLocalImagePath(rawPath) else { continue }
      if !attachments.contains(att) {
        attachments.append(att)
      }
      var removeRange = match.range(at: 0)
      // Also strip wrapping quotes around the matched path when present.
      if removeRange.location > 0 && removeRange.location + removeRange.length < nsText.length {
        let prev = nsText.substring(with: NSRange(location: removeRange.location - 1, length: 1))
        let next = nsText.substring(with: NSRange(location: removeRange.location + removeRange.length, length: 1))
        if (prev == "'" && next == "'") || (prev == "\"" && next == "\"") {
          removeRange = NSRange(location: removeRange.location - 1, length: removeRange.length + 2)
        }
      }
      rangesToRemove.append(removeRange)
    }
    guard !rangesToRemove.isEmpty else { return (text, []) }

    let mutable = NSMutableString(string: text)
    for r in rangesToRemove.reversed() {
      mutable.replaceCharacters(in: r, with: " ")
    }
    let cleaned = (mutable as String)
      .replacingOccurrences(of: #"[ \t]{2,}"#, with: " ", options: .regularExpression)
      .replacingOccurrences(of: #"^\s+|\s+$"#, with: "", options: .regularExpression)
    return (cleaned, attachments)
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

struct SyncedAttachmentPreview: Decodable, Equatable, Sendable {
  let id: String
  let name: String?
  let mimeType: String?
  let thumbnail: String?
}

struct SyncedSupervisorMessage: Identifiable, Decodable, Equatable, Sendable {
  let id: String
  let role: String
  let text: String
  let at: String?
  let sourceName: String?
  let sourceNodeId: String?
  let attachments: [SyncedAttachmentPreview]?
  var localThumbnailData: [Data] = []

  var thumbnailImageData: [Data] {
    if !localThumbnailData.isEmpty { return localThumbnailData }
    return (attachments ?? []).compactMap { preview in
      guard let encoded = preview.thumbnail, !encoded.isEmpty else { return nil }
      return Data(base64Encoded: encoded)
    }
  }

  enum CodingKeys: String, CodingKey {
    case id, role, text, at, sourceName, sourceNodeId, attachments
  }
}

struct MacModelOption: Identifiable, Equatable, Sendable {
  let id: String
  let label: String

  static let curatedOpenAI: [MacModelOption] = [
    MacModelOption(id: "gpt-6.2-sol", label: "GPT-6.2 Sol"),
    MacModelOption(id: "gpt-6.1-sol", label: "GPT-6.1 Sol"),
    MacModelOption(id: "gpt-6-luna", label: "GPT-6 Luna"),
    MacModelOption(id: "gpt-6.1-terra", label: "GPT-6.1 Terra"),
    MacModelOption(id: "gpt-5.4", label: "GPT-5.4"),
    MacModelOption(id: "gpt-5.4-mini", label: "GPT-5.4 Mini"),
    MacModelOption(id: "gpt-4.1", label: "GPT-4.1")
  ]

  static let curatedClaude: [MacModelOption] = [
    MacModelOption(id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6"),
    MacModelOption(id: "claude-opus-4-7", label: "Claude Opus 4.7")
  ]

  static func displayName(for modelId: String?) -> String {
    guard let id = modelId?.trimmingCharacters(in: .whitespacesAndNewlines), !id.isEmpty else {
      return "Model"
    }
    return curatedOpenAI.first(where: { $0.id == id })?.label
      ?? curatedClaude.first(where: { $0.id == id })?.label
      ?? id
  }
}

private struct ModelSettingsResponse: Decodable {
  struct Active: Decodable {
    let provider: String?
    let model: String?
  }
  struct KeyProvider: Decodable {
    let configured: Bool
    let model: String?
  }
  struct CliProvider: Decodable {
    let available: Bool
    let model: String?
  }
  struct ChatGPTProvider: Decodable {
    let signedIn: Bool
    let email: String?
  }
  struct Providers: Decodable {
    let anthropic: KeyProvider?
    let openai: KeyProvider?
    let chatgpt: ChatGPTProvider?
    let claudeCli: CliProvider?
    let codexCli: CliProvider?
  }
  let preference: String?
  let active: Active?
  let providers: Providers?
}

private struct SupervisorStreamStatus: Decodable {
  let stage: String?
}

private struct SupervisorStreamDelta: Decodable {
  let text: String
  let reset: Bool?
}

private struct SupervisorStreamFailure: Decodable {
  let error: String?
}

struct MacTaskLease: Decodable, Equatable, Sendable {
  let claimedAt: String?
  let expiresAt: String?
  let attempts: Int?
}

struct MacTaskSourceMeta: Decodable, Equatable, Sendable {
  let threadKey: String?
  let project: String?
  let subchannel: String?
  let actor: String?
  let blockedReason: String?
  let agentLease: MacTaskLease?

  private enum CodingKeys: String, CodingKey {
    case threadKey, project, subchannel, actor, blockedReason, agentLease
  }

  init(threadKey: String? = nil, project: String? = nil, subchannel: String? = nil,
       actor: String? = nil, blockedReason: String? = nil, agentLease: MacTaskLease? = nil) {
    self.threadKey = threadKey
    self.project = project
    self.subchannel = subchannel
    self.actor = actor
    self.blockedReason = blockedReason
    self.agentLease = agentLease
  }

  init(from decoder: Decoder) throws {
    let c = try? decoder.container(keyedBy: CodingKeys.self)
    threadKey = (try? c?.decodeIfPresent(String.self, forKey: .threadKey)) ?? nil
    project = (try? c?.decodeIfPresent(String.self, forKey: .project)) ?? nil
    subchannel = (try? c?.decodeIfPresent(String.self, forKey: .subchannel)) ?? nil
    actor = (try? c?.decodeIfPresent(String.self, forKey: .actor)) ?? nil
    blockedReason = (try? c?.decodeIfPresent(String.self, forKey: .blockedReason)) ?? nil
    agentLease = (try? c?.decodeIfPresent(MacTaskLease.self, forKey: .agentLease)) ?? nil
  }
}

struct MacTaskItem: Identifiable, Decodable, Equatable, Sendable {
  let id: String
  let queue: String?
  let title: String
  let description: String?
  let status: String
  let priority: Int?
  let dueAt: String?
  let notes: String?
  let tags: [String]?
  let dependsOn: [String]?
  let sourceMeta: MacTaskSourceMeta?
  let updatedAt: String?
  let completedAt: String?
}

private struct SyncedHistoryResponse: Decodable {
  let messages: [SyncedSupervisorMessage]
}

private struct TasksListResponse: Decodable {
  let tasks: [MacTaskItem]
}

struct QueuedSupervisorMessage: Identifiable, Equatable {
  let id: String
  var text: String
  var focusedCardId: String?
  var attachments: [WorkspaceImageAttachment]
}

struct MacBudgetStatus: Decodable, Equatable, Sendable {
  let today: String
  let dailyUsdLimit: Double
  let bonusUsdToday: Double?
  let effectiveLimitUsd: Double?
  let spentUsd: Double
  let remainingUsd: Double
  let exceeded: Bool?
  let calls: Int

  var effectiveLimit: Double {
    effectiveLimitUsd ?? (dailyUsdLimit + (bonusUsdToday ?? 0))
  }

  var isExceeded: Bool {
    exceeded ?? (spentUsd >= effectiveLimit)
  }
}

/// Keeps Mac Supervisor Quick Ask, Supervisor Workspace Window, Paseo, iPhone,
/// and Even G2 synced via `devices:supervisor:main` + `/tasks`.
@MainActor
final class SharedSupervisorClient: ObservableObject {
  static let shared = SharedSupervisorClient()

  @Published private(set) var messages: [SyncedSupervisorMessage] = []
  @Published private(set) var tasks: [MacTaskItem] = []
  @Published private(set) var allTasks: [MacTaskItem] = []
  @Published private(set) var isSending = false
  @Published private(set) var queuedMessages: [QueuedSupervisorMessage] = []
  @Published private(set) var streamingReplyText: String? = nil
  /// The assistant messages already shown when the current reply started,
  /// and the question it answers. A new assistant message right after that
  /// question is this reply, saved by the server and pulled in by a
  /// transcript sync before the stream ended.
  @Published private(set) var replyBaselineIds: Set<String> = []
  @Published private(set) var replyPromptText: String? = nil
  @Published private(set) var progressStage: String? = nil
  @Published private(set) var activeModelId: String? = nil
  @Published private(set) var activeProvider: String? = nil
  @Published private(set) var modelPreference: String = "auto"
  @Published private(set) var claudeCliAvailable = false
  @Published private(set) var codexCliAvailable = false
  @Published private(set) var chatgptSignedIn = false
  @Published private(set) var anthropicConfigured = false
  @Published private(set) var isSwitchingModel = false
  @Published private(set) var budgetStatus: MacBudgetStatus? = nil
  @Published private(set) var isUpdatingBudget = false
  @Published private(set) var lastError: String? = nil

  var activeModelLabel: String {
    let base = MacModelOption.displayName(for: activeModelId)
    switch activeProvider {
    case "claude-cli":
      return activeModelId == nil ? "Claude Account" : "Claude CLI · \(base)"
    case "codex-cli":
      return activeModelId == nil ? "Codex Account" : "Codex CLI · \(base)"
    case "chatgpt":
      return activeModelId == nil ? "ChatGPT Plan" : "ChatGPT · \(base)"
    default:
      return base
    }
  }

  private struct UnsupportedFieldsError: Error {}

  func clearError() {
    lastError = nil
  }

  func removeQueued(id: String) {
    queuedMessages.removeAll { $0.id == id }
  }

  func popQueuedForEdit(id: String) -> QueuedSupervisorMessage? {
    guard let index = queuedMessages.firstIndex(where: { $0.id == id }) else { return nil }
    return queuedMessages.remove(at: index)
  }

  private init() {}

  /// Builds a `POST /message` payload restricted to fields allowlisted by
  /// `src/hosted-interface.js` (`requestNodeId` gate). Never include client-only
  /// fields like `metadata`, `channel`, or `agentId` here.
  nonisolated static func buildMessagePayload(
    text: String,
    focusedCardId: String? = nil,
    attachments: [WorkspaceImageAttachment] = [],
    includeThread: Bool = true,
    includeFocusedCard: Bool = true
  ) -> [String: Any] {
    var payload: [String: Any] = [
      "text": text,
      "from": "mac-supervisor"
    ]
    if includeThread {
      payload["thread"] = "supervisor"
    }
    if includeFocusedCard,
       let rawCard = focusedCardId?.trimmingCharacters(in: .whitespacesAndNewlines),
       !rawCard.isEmpty,
       rawCard.range(of: "^[A-Za-z0-9:_-]{1,120}$", options: .regularExpression) != nil {
      payload["focusedCardId"] = rawCard
    }
    if !attachments.isEmpty {
      payload["attachments"] = attachments.map(\.agentHostPayload)
    }
    return payload
  }

  func refreshAll() async {
    await withTaskGroup(of: Void.self) { group in
      group.addTask { await self.refreshMessages() }
      group.addTask { await self.refreshTasks() }
      group.addTask { await self.refreshModelSettings() }
      group.addTask { await self.refreshBudget() }
    }
  }

  func refreshBudget() async {
    var req = URLRequest(url: AppState.buildURL(
      base: AppState.shared.baseURL,
      path: "/budget"))
    authed(&req)
    req.timeoutInterval = 8
    do {
      let (data, response) = try await URLSession.shared.data(for: req)
      try AppState.ensureOK(response, data)
      budgetStatus = try JSONDecoder().decode(MacBudgetStatus.self, from: data)
    } catch {
      // Non-fatal on older mains or while restarting.
    }
  }

  @discardableResult
  func updateBudget(dailyUsdLimit: Double? = nil, addUsdToday: Double? = nil, resetTodayBonus: Bool = false) async -> Bool {
    guard !isUpdatingBudget else { return false }
    isUpdatingBudget = true
    defer { isUpdatingBudget = false }
    var body: [String: Any] = [:]
    if let dailyUsdLimit { body["dailyUsdLimit"] = dailyUsdLimit }
    if let addUsdToday { body["addUsdToday"] = addUsdToday }
    if resetTodayBonus { body["resetTodayBonus"] = true }
    var req = URLRequest(url: AppState.buildURL(
      base: AppState.shared.baseURL,
      path: "/budget"))
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.httpBody = try? JSONSerialization.data(withJSONObject: body)
    req.timeoutInterval = 15
    authed(&req)
    do {
      let (data, response) = try await URLSession.shared.data(for: req)
      try AppState.ensureOK(response, data)
      budgetStatus = try JSONDecoder().decode(MacBudgetStatus.self, from: data)
      if let err = lastError, err.localizedCaseInsensitiveContains("daily budget") {
        lastError = nil
      }
      return true
    } catch {
      lastError = error.localizedDescription
      return false
    }
  }

  func refreshModelSettings() async {
    var req = URLRequest(url: AppState.buildURL(
      base: AppState.shared.baseURL,
      path: "/settings/models"))
    authed(&req)
    req.timeoutInterval = 8
    do {
      let (data, response) = try await URLSession.shared.data(for: req)
      try AppState.ensureOK(response, data)
      let decoded = try JSONDecoder().decode(ModelSettingsResponse.self, from: data)
      applyModelSettings(decoded)
    } catch {
      // Non-fatal while daemon or main restarts.
    }
  }

  private func applyModelSettings(_ decoded: ModelSettingsResponse) {
    modelPreference = decoded.preference ?? "auto"
    activeProvider = decoded.active?.provider
    activeModelId = decoded.active?.model
    claudeCliAvailable = decoded.providers?.claudeCli?.available ?? false
    codexCliAvailable = decoded.providers?.codexCli?.available ?? false
    chatgptSignedIn = decoded.providers?.chatgpt?.signedIn ?? false
    anthropicConfigured = decoded.providers?.anthropic?.configured ?? false
  }

  func selectOpenAIModel(_ modelId: String) async {
    await selectModelPreference(preference: "openai", modelField: "openaiModel", modelId: modelId)
  }

  func selectModelPreference(preference: String, modelField: String? = nil, modelId: String? = nil) async {
    guard !isSwitchingModel else { return }
    isSwitchingModel = true
    defer { isSwitchingModel = false }
    var body: [String: Any] = ["preference": preference]
    if let modelField, let modelId {
      body[modelField] = modelId
    }
    var req = URLRequest(url: AppState.buildURL(
      base: AppState.shared.baseURL,
      path: "/settings/models"))
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.httpBody = try? JSONSerialization.data(withJSONObject: body)
    req.timeoutInterval = 15
    authed(&req)
    do {
      let (data, response) = try await URLSession.shared.data(for: req)
      try AppState.ensureOK(response, data)
      let decoded = try JSONDecoder().decode(ModelSettingsResponse.self, from: data)
      applyModelSettings(decoded)
      if activeProvider == nil { activeProvider = preference }
      if activeModelId == nil, let modelId { activeModelId = modelId }
      lastError = nil
    } catch {
      lastError = error.localizedDescription
    }
  }

  func setFleetMode(_ mode: String) async {
    var req = URLRequest(url: AppState.buildURL(
      base: AppState.shared.baseURL,
      path: "/fleet/api/mode"))
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.httpBody = try? JSONSerialization.data(withJSONObject: ["mode": mode])
    req.timeoutInterval = 15
    authed(&req)
    do {
      let (data, response) = try await URLSession.shared.data(for: req)
      try AppState.ensureOK(response, data)
      await FleetConsumer.shared.refresh()
    } catch {
      lastError = error.localizedDescription
    }
  }

  /// The reply's newest streamed text to draw, or nil once the transcript
  /// already holds this reply (one bubble, never two).
  var liveReplyText: String? {
    Self.liveReplyText(streaming: streamingReplyText, messages: messages, baseline: replyBaselineIds, prompt: replyPromptText)
  }

  nonisolated static func liveReplyText(streaming: String?, messages: [SyncedSupervisorMessage], baseline: Set<String>, prompt: String?) -> String? {
    guard let text = streaming, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
    if replyAlreadyShown(messages: messages, baseline: baseline, prompt: prompt) { return nil }
    return text
  }

  /// True only for a new assistant message that directly follows this turn's
  /// own question. A Quick Ask mirrored in meanwhile, or older history a
  /// sync brings back, answers something else and leaves the stream showing.
  nonisolated static func replyAlreadyShown(messages: [SyncedSupervisorMessage], baseline: Set<String>, prompt: String?) -> Bool {
    let asked = prompt?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    guard !asked.isEmpty,
          let question = messages.lastIndex(where: { $0.role == "user" && $0.text.trimmingCharacters(in: .whitespacesAndNewlines) == asked })
    else { return false }
    for message in messages[(question + 1)...] {
      if message.role == "user" { return false }
      if message.role == "assistant" && !baseline.contains(message.id) { return true }
    }
    return false
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
    func fetchQueue(_ queue: String) async -> [MacTaskItem] {
      var req = URLRequest(url: AppState.buildURL(
        base: AppState.shared.baseURL,
        path: "/tasks?queue=\(queue)&limit=100"))
      authed(&req)
      req.timeoutInterval = 8
      do {
        let (data, response) = try await URLSession.shared.data(for: req)
        try AppState.ensureOK(response, data)
        return try JSONDecoder().decode(TasksListResponse.self, from: data).tasks
      } catch {
        return []
      }
    }

    async let userTasks = fetchQueue("user")
    async let agentTasks = fetchQueue("agent")
    let combined = await (userTasks + agentTasks)
    guard !combined.isEmpty || tasks.isEmpty else { return }
    var seen = Set<String>()
    let deduped = combined.filter { seen.insert($0.id).inserted }
    let active = deduped.filter { !["done", "completed", "cancelled"].contains($0.status.lowercased()) }
    let done = deduped
      .filter { ["done", "completed", "cancelled"].contains($0.status.lowercased()) }
      .prefix(30)
    tasks = active
    allTasks = active + done
  }

  @discardableResult
  func sendMessage(_ text: String, focusedCardId: String? = nil, attachments: [WorkspaceImageAttachment] = []) async -> Bool {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty || !attachments.isEmpty else { return false }
    if isSending {
      queuedMessages.append(QueuedSupervisorMessage(
        id: "q-\(UUID().uuidString)",
        text: text,
        focusedCardId: focusedCardId,
        attachments: attachments
      ))
      return true
    }
    isSending = true
    defer {
      isSending = false
      streamingReplyText = nil
      progressStage = nil
    }
    let ok = await executeSingleMessage(text, focusedCardId: focusedCardId, attachments: attachments)
    while !queuedMessages.isEmpty {
      let next = queuedMessages.removeFirst()
      _ = await executeSingleMessage(next.text, focusedCardId: next.focusedCardId, attachments: next.attachments)
    }
    return ok
  }

  private func executeSingleMessage(_ text: String, focusedCardId: String? = nil, attachments: [WorkspaceImageAttachment] = []) async -> Bool {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    let previousAssistantIds = Set(messages.filter { $0.role == "assistant" }.map(\.id))
    replyBaselineIds = previousAssistantIds
    lastError = nil
    streamingReplyText = nil
    progressStage = "queued"

    let displayText = trimmed.isEmpty ? "Please inspect the attached screenshot(s)." : trimmed
    replyPromptText = displayText
    let localId = "local_\(UUID().uuidString)"
    let optimistic = SyncedSupervisorMessage(
      id: localId,
      role: "user",
      text: displayText,
      at: ISO8601DateFormatter().string(from: Date()),
      sourceName: "Mac",
      sourceNodeId: nil,
      attachments: nil,
      localThumbnailData: attachments.map(\.previewData)
    )
    messages.append(optimistic)

    let hasValidCardId = focusedCardId?
      .trimmingCharacters(in: .whitespacesAndNewlines)
      .range(of: "^[A-Za-z0-9:_-]{1,120}$", options: .regularExpression) != nil

    var attempts: [(includeThread: Bool, includeFocusedCard: Bool)] = [(true, true)]
    if hasValidCardId {
      attempts.append((true, false))
    }
    attempts.append((false, false))

    do {
      var replyText: String? = nil
      for (index, attempt) in attempts.enumerated() {
        do {
          let payload = Self.buildMessagePayload(
            text: displayText,
            focusedCardId: focusedCardId,
            attachments: attachments,
            includeThread: attempt.includeThread,
            includeFocusedCard: attempt.includeFocusedCard
          )
          replyText = try await performStreamedMessage(payload: payload)
          break
        } catch is UnsupportedFieldsError {
          if index == attempts.count - 1 {
            throw NSError(domain: "OpenAGI", code: 400, userInfo: [
              NSLocalizedDescriptionKey: "HTTP 400: node message contains unsupported fields"
            ])
          }
          continue
        }
      }
      // A sync during the stream may already have brought the saved reply.
      if let reply = replyText?.trimmingCharacters(in: .whitespacesAndNewlines), !reply.isEmpty,
         !Self.replyAlreadyShown(messages: messages, baseline: previousAssistantIds, prompt: displayText) {
        messages.append(SyncedSupervisorMessage(
          id: "local_reply_\(UUID().uuidString)",
          role: "assistant",
          text: reply,
          at: ISO8601DateFormatter().string(from: Date()),
          sourceName: nil,
          sourceNodeId: nil,
          attachments: nil
        ))
      }
      await refreshMessages()
      await refreshTasks()
      return true
    } catch {
      await refreshMessages()
      let persistedAssistantReply = messages.contains {
        $0.role == "assistant" && !previousAssistantIds.contains($0.id)
      }
      if persistedAssistantReply {
        messages.removeAll { $0.id == localId }
        lastError = nil
        await refreshTasks()
        return true
      }
      messages.removeAll { $0.id == localId }
      lastError = error.localizedDescription
      return false
    }
  }

  private func performStreamedMessage(payload: [String: Any]) async throws -> String? {
    var req = URLRequest(url: AppState.buildURL(base: AppState.shared.baseURL, path: "/message"))
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
    req.httpBody = try JSONSerialization.data(withJSONObject: payload)
    req.timeoutInterval = 180
    authed(&req)

    let (bytes, response) = try await URLSession.shared.bytes(for: req)
    guard let http = response as? HTTPURLResponse else {
      throw NSError(domain: "OpenAGI.Transport", code: -1, userInfo: [
        NSLocalizedDescriptionKey: "The daemon returned an invalid response."
      ])
    }

    if !(200..<300).contains(http.statusCode) {
      var errData = Data()
      for try await byte in bytes {
        errData.append(byte)
        if errData.count >= 4096 { break }
      }
      if http.statusCode == 400,
         AppState.extractErrorMessage(errData).localizedCaseInsensitiveContains("unsupported fields") {
        throw UnsupportedFieldsError()
      }
      try AppState.ensureOK(response, errData)
      return nil
    }

    let contentType = http.value(forHTTPHeaderField: "Content-Type")?.lowercased() ?? ""
    if !contentType.contains("text/event-stream") {
      var data = Data()
      for try await byte in bytes { data.append(byte) }
      try AppState.ensureOK(response, data)
      let decoded = try JSONDecoder().decode(AppState.MessageReply.self, from: data)
      return decoded.reply
    }

    var parser = ServerSentEventParser()
    for try await line in ServerSentEventParser.lines(of: bytes) {
      guard let event = parser.consume(line: line) else { continue }
      let data = Data(event.data.utf8)
      switch event.name {
      case "status", "heartbeat":
        if let status = try? JSONDecoder().decode(SupervisorStreamStatus.self, from: data),
           let stage = status.stage, !stage.isEmpty {
          progressStage = stage
        }
      case "delta":
        if let delta = try? JSONDecoder().decode(SupervisorStreamDelta.self, from: data),
           !delta.text.isEmpty {
          streamingReplyText = delta.reset == true ? delta.text : (streamingReplyText ?? "") + delta.text
        }
      case "final":
        let decoded = try? JSONDecoder().decode(AppState.MessageReply.self, from: data)
        if let reply = decoded?.reply, !reply.isEmpty {
          streamingReplyText = reply
        }
        return decoded?.reply ?? streamingReplyText
      case "failure":
        let failure = try? JSONDecoder().decode(SupervisorStreamFailure.self, from: data)
        let message = failure?.error ?? "Supervisor could not complete that request."
        throw NSError(domain: "OpenAGI.Agent", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
      default:
        continue
      }
    }

    if let trailing = parser.finish(),
       trailing.name == "reply",
       let data = trailing.data.data(using: .utf8),
       let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
       let text = (json["reply"] as? String) ?? (json["text"] as? String),
       !text.isEmpty {
      return text
    }

    if let partial = streamingReplyText, !partial.isEmpty {
      return partial
    }
    throw NSError(domain: "OpenAGI.Transport", code: -1, userInfo: [
      NSLocalizedDescriptionKey: "The connection ended before completion was confirmed."
    ])
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
    await createBoardTask(title: title, startSession: false)
  }

  @discardableResult
  func createBoardTask(
    title: String,
    description: String = "",
    project: String? = nil,
    subchannel: String? = nil,
    labels: [String] = [],
    startSession: Bool = false,
    workspace: String? = nil,
    cwd: String? = nil,
    model: String? = nil,
    effort: String? = nil
  ) async -> Bool {
    let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return false }
    lastError = nil

    if startSession {
      var body: [String: Any] = [
        "title": trimmed,
        "prompt": description.isEmpty ? trimmed : description
      ]
      if !description.isEmpty { body["description"] = description }
      if let project, !project.isEmpty { body["project"] = project }
      if let subchannel, !subchannel.isEmpty { body["subchannel"] = subchannel }
      if !labels.isEmpty { body["labels"] = labels }
      if let workspace, !workspace.isEmpty { body["workspace"] = workspace }
      if let cwd, !cwd.isEmpty { body["cwd"] = cwd }
      if let model, !model.isEmpty { body["model"] = model }
      if let effort, !effort.isEmpty { body["effort"] = effort }

      var req = URLRequest(url: AppState.buildURL(base: AppState.shared.baseURL, path: "/fleet/api/tasks/claim"))
      req.httpMethod = "POST"
      req.setValue("application/json", forHTTPHeaderField: "Content-Type")
      req.httpBody = try? JSONSerialization.data(withJSONObject: body)
      req.timeoutInterval = 45
      authed(&req)
      do {
        let (data, response) = try await URLSession.shared.data(for: req)
        try AppState.ensureOK(response, data)
        await refreshTasks()
        await FleetConsumer.shared.refresh()
        return true
      } catch {
        lastError = error.localizedDescription
        return false
      }
    }

    var body: [String: Any] = [
      "title": trimmed,
      "queue": "user",
      "source": "supervisor"
    ]
    if !description.isEmpty { body["description"] = description }
    if let project, !project.isEmpty { body["project"] = project }
    if let subchannel, !subchannel.isEmpty { body["subchannel"] = subchannel }
    if !labels.isEmpty { body["labels"] = labels }
    var req = URLRequest(url: AppState.buildURL(base: AppState.shared.baseURL, path: "/tasks"))
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.httpBody = try? JSONSerialization.data(withJSONObject: body)
    authed(&req)
    do {
      let (data, response) = try await URLSession.shared.data(for: req)
      try AppState.ensureOK(response, data)
      await refreshTasks()
      return true
    } catch {
      lastError = error.localizedDescription
      return false
    }
  }

  @discardableResult
  func claimTaskInPaseo(
    _ task: MacTaskItem,
    workspace: String? = nil,
    model: String? = nil,
    effort: String? = nil
  ) async -> String? {
    lastError = nil
    var body: [String: Any] = ["taskId": task.id]
    if let ws = workspace ?? task.sourceMeta?.project, !ws.isEmpty { body["workspace"] = ws }
    if let proj = task.sourceMeta?.project, !proj.isEmpty { body["project"] = proj }
    if let sub = task.sourceMeta?.subchannel, !sub.isEmpty { body["subchannel"] = sub }
    if let model, !model.isEmpty { body["model"] = model }
    if let effort, !effort.isEmpty { body["effort"] = effort }

    var req = URLRequest(url: AppState.buildURL(base: AppState.shared.baseURL, path: "/fleet/api/tasks/claim"))
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.httpBody = try? JSONSerialization.data(withJSONObject: body)
    req.timeoutInterval = 45
    authed(&req)
    do {
      let (data, response) = try await URLSession.shared.data(for: req)
      try AppState.ensureOK(response, data)
      await refreshTasks()
      await FleetConsumer.shared.refresh()
      if let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
         let sess = obj["session"] as? [String: Any],
         let key = sess["key"] as? String {
        return key
      }
      return nil
    } catch {
      lastError = error.localizedDescription
      return nil
    }
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
