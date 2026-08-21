import Foundation

enum CaptureHealthState: Equatable {
  case disabled
  case paused(until: Date)
  case permissionRequired
  case waitingForFirstFrame
  case healthy(latestFrameAt: Date)
  case stale(latestFrameAt: Date)
}

/// A permission grant and an enabled toggle are prerequisites, not proof that
/// screenshots are being persisted. This pure evaluator keeps the UI honest by
/// requiring a recent saved frame before it calls capture healthy.
enum CaptureHealth {
  nonisolated static func evaluate(
    enabled: Bool,
    pausedUntil: Date?,
    screenRecordingGranted: Bool,
    latestFrameAt: Date?,
    captureIntervalSeconds: Double,
    now: Date = Date()
  ) -> CaptureHealthState {
    guard enabled else { return .disabled }
    if let pausedUntil, pausedUntil > now { return .paused(until: pausedUntil) }
    guard screenRecordingGranted else { return .permissionRequired }
    guard let latestFrameAt else { return .waitingForFirstFrame }

    // Allow several capture intervals plus OCR/storage time before declaring a
    // failure. A hard 60-second floor avoids noisy state changes at the default
    // five-second interval while still detecting a dead timer promptly.
    let freshnessBudget = max(60, captureIntervalSeconds * 6)
    if now.timeIntervalSince(latestFrameAt) <= freshnessBudget {
      return .healthy(latestFrameAt: latestFrameAt)
    }
    return .stale(latestFrameAt: latestFrameAt)
  }
}
