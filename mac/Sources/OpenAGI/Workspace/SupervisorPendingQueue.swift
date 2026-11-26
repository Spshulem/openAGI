import AppKit
import Foundation
import SupervisorChannelsKit

/// One Supervisor chat message typed on this Mac that main has not taken yet:
/// still waiting to be uploaded to the hub's queue (offline, main restarting),
/// or waiting in this Mac's own queue on a main without one. Saved so a quit,
/// a crash or a relaunch while offline never loses it. It keeps its turn id,
/// so when it does go, main runs it once however many times it is sent.
///
/// Messages the hub has accepted are not kept here: the hub's queue is
/// durable (src/conversation-queue.js) and the tray mirrors it.
struct SupervisorPendingMessage: Codable, Equatable, Sendable {
  struct Image: Codable, Equatable, Sendable {
    let id: String
    let name: String
    let mimeType: String
    /// The full image, exactly as it is sent (base64 JPEG).
    let data: String
    let thumbnail: String
  }

  var requestId: String
  var text: String
  var focusedCardId: String?
  var images: [Image]
  /// For the hub's queue (true), or this Mac's own queue (false).
  var pendingUpload: Bool
  /// An upload went out and no answer came back: the hub may have it, so
  /// removing it must ask the hub too.
  var uploadAttempted: Bool
  /// The hub's last refusal, shown on its row.
  var error: String?
}

/// The file the pending messages live in. Every change to them is written
/// before anything else happens to the queue, on the main actor.
struct SupervisorPendingQueueStore {
  let url: URL?

  static var defaultURL: URL {
    let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
      ?? URL(fileURLWithPath: NSTemporaryDirectory())
    return support.appendingPathComponent("OpenAGI/supervisor-pending-queue.json")
  }

  /// What in the queue only this Mac has: never mirrored hub items.
  static func pending(_ queue: QueuedTurnQueue<SupervisorQueuedPayload>) -> [SupervisorPendingMessage] {
    queue.items.compactMap { item in
      guard item.origin == nil || item.origin?.pendingUpload == true else { return nil }
      return SupervisorPendingMessage(
        requestId: item.requestID,
        text: item.text,
        focusedCardId: item.payload.focusedCardId,
        images: item.payload.attachments.map {
          SupervisorPendingMessage.Image(id: $0.id, name: $0.name, mimeType: $0.mimeType, data: $0.data, thumbnail: $0.thumbnail)
        },
        pendingUpload: item.origin?.pendingUpload == true,
        uploadAttempted: item.origin?.uploadAttempted == true,
        error: item.origin?.error
      )
    }
  }

  /// Puts saved messages back in the queue, in their order, with their turn
  /// ids. Hub items arrive with the next history refresh.
  static func restore(_ saved: [SupervisorPendingMessage], into queue: inout QueuedTurnQueue<SupervisorQueuedPayload>) {
    for message in saved where queue.item(requestID: message.requestId) == nil {
      let images = message.images.map { image -> WorkspaceImageAttachment in
        let full = Data(base64Encoded: image.data) ?? Data()
        return WorkspaceImageAttachment(
          id: image.id, name: image.name, mimeType: image.mimeType, data: image.data, thumbnail: image.thumbnail,
          previewData: Data(base64Encoded: image.thumbnail) ?? Data(),
          preview: NSImage(data: full) ?? NSImage(size: NSSize(width: 1, height: 1)))
      }
      let origin = message.pendingUpload
        ? QueuedOrigin(mine: true, pendingUpload: true, error: message.error, uploadAttempted: message.uploadAttempted)
        : nil
      queue.enqueue(text: message.text, payload: SupervisorQueuedPayload(focusedCardId: message.focusedCardId, attachments: images),
                    requestID: message.requestId, origin: origin)
    }
  }

  func load() -> [SupervisorPendingMessage] {
    guard let url, let data = try? Data(contentsOf: url) else { return [] }
    // A torn or unknown file costs the pending messages, never the app.
    return (try? JSONDecoder().decode([SupervisorPendingMessage].self, from: data)) ?? []
  }

  func save(_ messages: [SupervisorPendingMessage]) {
    guard let url else { return }
    guard !messages.isEmpty else {
      try? FileManager.default.removeItem(at: url)
      return
    }
    guard let data = try? JSONEncoder().encode(messages) else { return }
    try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try? data.write(to: url, options: [.atomic])
  }
}
