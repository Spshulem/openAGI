import Foundation

// Persistent capture settings — written to ~/Library/Application Support/OpenAGI/capture/settings.json.
// Loaded at app start; mutated from the SwiftUI privacy panel and the tray menu.
//
// This file also owns the CAPTURE EXCLUSION POLICY: the single decision
// procedure that says which windows must never reach the screenshot (and when
// no screenshot may be taken at all). It lives here, as pure `nonisolated
// static` functions over plain values, for one reason: ScreenCapturer has two
// capture paths (the 5-second ambient timer and Quick Ask), they used to each
// carry their own copy of the check, and they drifted — the ambient path
// checked only the FRONTMOST app and then captured the whole display with
// `excludingWindows: []`, so a password manager or a Messages window sitting
// beside the focused window was captured and OCR'd every 5 seconds. Both paths
// now call decideCapture(); there is no second copy to drift.

/// One window as the exclusion policy sees it.
///
/// Deliberately not `SCWindow`: the decision has to be reachable without a
/// WindowServer so it can be tested, and both capture paths must be able to
/// produce it from the same adapter. `bundleId` and `title` are optional on
/// purpose — "we could not read this" is a distinct and dangerous state from
/// "this is empty", and the policy fails closed on it.
struct CaptureWindowInfo: Equatable {
  let windowID: UInt32
  let bundleId: String?
  let title: String?
  let isOnScreen: Bool

  init(windowID: UInt32, bundleId: String?, title: String?, isOnScreen: Bool = true) {
    self.windowID = windowID
    self.bundleId = bundleId
    self.title = title
    self.isOnScreen = isOnScreen
  }
}

/// What capture is allowed to do right now.
enum CaptureDecision: Equatable {
  /// Capture nothing at all. `reason` is user-facing — the screen state could
  /// not be evaluated, and "we could not check" is not "nothing to exclude".
  case skip(reason: String)
  /// Capturing is safe provided every one of these windows is excluded from
  /// the content filter. Sorted, de-duplicated.
  case capture(excludedWindowIDs: [UInt32])
}

@MainActor
final class CaptureSettings: ObservableObject {
  static let shared = CaptureSettings()

  @Published var enabled: Bool {
    didSet { persist() }
  }
  @Published var pausedUntil: Date? {
    didSet { persist() }
  }
  @Published var captureIntervalSeconds: Double {
    didSet { persist() }
  }
  @Published var excludedBundleIds: [String] {
    didSet { persist() }
  }
  @Published var excludedWindowPatterns: [String] {
    didSet { persist() }
  }
  @Published var frameRetentionDays: Int {
    didSet { persist() }
  }
  @Published var textRetentionDays: Int {
    didSet { persist() }
  }
  @Published var maxDiskBytes: Int {
    didSet { persist() }
  }

  /// The default exclusion lists this install has already had merged in. Not
  /// user-visible; it is what lets a NEW default reach an EXISTING user without
  /// resurrecting a default they deliberately deleted. See applyNewDefaults().
  private var appliedDefaultBundleIds: [String]
  private var appliedDefaultWindowPatterns: [String]

  // Pure file-system path — no main-actor isolation needed.
  nonisolated static var captureDir: URL {
    let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
    let dir = support.appendingPathComponent("OpenAGI/capture", isDirectory: true)
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir
  }

  private static var settingsPath: URL {
    captureDir.appendingPathComponent("settings.json")
  }

  // MARK: — default exclusion policy
  //
  // Matching is case-insensitive and covers child bundle ids (see
  // bundleIdIsExcluded), so entries here are written in their canonical casing
  // and a vendor-level id such as "com.1password" also covers helpers like
  // "com.1password.browser-helper". Only use a vendor-level id when EVERY
  // product from that vendor is sensitive.

  /// Password managers, secure messengers and system credential UI that must
  /// never be OCR'd. Widened in the 2026-07 privacy pass; the previous list was
  /// 8 exact, case-sensitive ids and missed Messages, Signal, Keychain Access,
  /// Keeper, Dashlane, KeePassXC and Proton Pass among others.
  nonisolated static let defaultExcludedBundleIds: [String] = [
    // — password managers / vaults
    "com.1password",                    // covers 1password 8 + browser helpers
    "com.agilebits",                    // covers onepassword4/6/7
    "com.lastpass.LastPass",
    "com.lastpass.lastpassmacdesktop",
    "com.bitwarden.desktop",
    "com.dashlane",                     // dashlane, dashlanephonefinal
    "org.keepassxc.keepassxc",
    "org.keepassx.keepassx",
    "com.keepassium.KeePassium",
    "com.callpod.keeperdesktop",
    "com.keepersecurity.KeeperDesktop",
    "me.proton.pass",
    "ch.protonmail.pass",
    "com.nordsecurity.nordpass",
    "com.nordpass.macos",
    "in.sinew.Enpass-Desktop",
    "com.markmcguill.strongbox",
    "com.outercorner.Secrets",
    "com.roboform.RoboForm",
    "com.authy.authy-mac",
    // — secure messengers
    "com.apple.MobileSMS",              // Messages
    "com.apple.iChat",                  // Messages (legacy id)
    "org.whispersystems.signal-desktop",
    "net.whatsapp.WhatsApp",
    "desktop.WhatsApp",
    "ph.telegra.Telegraph",             // Telegram for macOS
    "org.telegram.desktop",
    "ch.threema.threema-desktop",
    "com.wire.desktop",
    // — system credential / payment UI
    "com.apple.keychainaccess",
    "com.apple.Passwords",
    "com.apple.Passwords-Settings.extension",
    "com.apple.Wallet",
    "com.apple.SecurityAgent",          // admin + unlock password prompts
    "com.apple.CryptoTokenKit.CTKPINPad",
    "com.apple.loginwindow"
  ]

  /// Window-title rules. Matched case-insensitively regardless of an inline
  /// `(?i)`; see titleIsExcluded.
  nonisolated static let defaultExcludedWindowPatterns: [String] = [
    "(?i)private browsing",
    "(?i)\\bprivate window\\b",
    "(?i)incognito",
    "(?i)password",
    "(?i)\\bpasskey",
    "(?i)\\bkeychain\\b",
    "(?i)2FA",
    "(?i)\\b(otp|verification code)\\b",
    "(?i)\\bone[- ]time (pass)?code\\b",
    "(?i)\\bauthenticator\\b",
    "(?i)\\b(seed|recovery) phrase\\b",
    "(?i)\\bmnemonic\\b",
    "(?i)\\b(api[ _-]?key|secret key|access token)\\b",
    "(?i)\\b(credit card|card number|cvv)\\b",
    "(?i)\\bonline banking\\b",
    "(?i)\\b(ssn|social security)\\b"
  ]

  /// The lists shipped before the 2026-07 widening. Used as the assumed
  /// "already applied" baseline for installs whose settings.json predates the
  /// marker keys, so the widening lands on them exactly once.
  nonisolated static let legacyDefaultExcludedBundleIds: [String] = [
    "com.1password.1password",
    "com.1password.1password7",
    "com.agilebits.onepassword7",
    "com.agilebits.onepassword4",
    "com.lastpass.LastPass",
    "com.bitwarden.desktop",
    "com.apple.Wallet",
    "com.apple.Passwords"
  ]

  nonisolated static let legacyDefaultExcludedWindowPatterns: [String] = [
    "(?i)private browsing",
    "(?i)incognito",
    "(?i)password",
    "(?i)2FA",
    "(?i)\\b(otp|verification code)\\b"
  ]

  private init() {
    let raw = try? Data(contentsOf: Self.settingsPath)
    let parsed = raw.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any]
    let loaded = parsed ?? [:]
    // A settings.json that is absent OR unreadable is treated as a fresh
    // install for defaults purposes: the widened defaults apply in full. That
    // is the fail-closed direction (more exclusions, not fewer).
    let isFreshInstall = parsed == nil

    self.enabled = (loaded["enabled"] as? Bool) ?? false
    if let s = loaded["pausedUntil"] as? String, let d = ISO8601DateFormatter().date(from: s) {
      self.pausedUntil = d
    } else {
      self.pausedUntil = nil
    }
    self.captureIntervalSeconds = (loaded["captureIntervalSeconds"] as? Double) ?? 5.0

    // Defaults migration. An existing user has a persisted list, so shipping a
    // wider default must not mean "fresh installs only". We record which
    // defaults have already been offered; on launch, any default NOT in that
    // record is appended to the user's list. A default the user deleted stays
    // deleted (it is in the record), and a genuinely new default reaches every
    // install exactly once.
    let storedIds = (loaded["excludedBundleIds"] as? [String]) ?? Self.defaultExcludedBundleIds
    let storedPatterns = (loaded["excludedWindowPatterns"] as? [String]) ?? Self.defaultExcludedWindowPatterns
    let appliedIds = (loaded["appliedDefaultBundleIds"] as? [String])
      ?? (isFreshInstall ? Self.defaultExcludedBundleIds : Self.legacyDefaultExcludedBundleIds)
    let appliedPatterns = (loaded["appliedDefaultWindowPatterns"] as? [String])
      ?? (isFreshInstall ? Self.defaultExcludedWindowPatterns : Self.legacyDefaultExcludedWindowPatterns)

    let mergedIds = Self.mergingNewDefaults(into: storedIds,
                                            defaults: Self.defaultExcludedBundleIds,
                                            alreadyApplied: appliedIds)
    let mergedPatterns = Self.mergingNewDefaults(into: storedPatterns,
                                                 defaults: Self.defaultExcludedWindowPatterns,
                                                 alreadyApplied: appliedPatterns)
    self.excludedBundleIds = mergedIds
    self.excludedWindowPatterns = mergedPatterns
    self.appliedDefaultBundleIds = Self.defaultExcludedBundleIds
    self.appliedDefaultWindowPatterns = Self.defaultExcludedWindowPatterns

    self.frameRetentionDays = (loaded["frameRetentionDays"] as? Int) ?? 7
    self.textRetentionDays = (loaded["textRetentionDays"] as? Int) ?? 90
    self.maxDiskBytes = (loaded["maxDiskBytes"] as? Int) ?? (5 * 1024 * 1024 * 1024)

    // Property observers do not fire during init, so the merge above is only in
    // memory until we write it. Persist when the file is missing anything —
    // otherwise every launch would re-offer the same defaults and undo the
    // user's deletions.
    let markersMissing = loaded["appliedDefaultBundleIds"] == nil || loaded["appliedDefaultWindowPatterns"] == nil
    if markersMissing || mergedIds != storedIds || mergedPatterns != storedPatterns {
      persist()
    }
  }

  func isActiveNow() -> Bool {
    if !enabled { return false }
    if let until = pausedUntil, Date() < until { return false }
    return true
  }

  // MARK: — matching primitives (pure, case-insensitive)

  private nonisolated static func normalized(_ s: String?) -> String {
    (s ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
  }

  /// Does `bundleId` match one of `list`?
  ///
  /// Case-insensitive (bundle ids are case-insensitive in practice, and the old
  /// exact `contains` check missed "com.1Password.1Password"), and a listed id
  /// also covers its children: "com.1password" matches
  /// "com.1password.browser-helper". A nil/blank bundle id matches nothing —
  /// that is an UNKNOWN, and unknowns are handled by decideCapture(), which
  /// fails closed on them rather than treating them as "not excluded".
  nonisolated static func bundleIdIsExcluded(_ bundleId: String?, in list: [String]) -> Bool {
    let bid = normalized(bundleId)
    if bid.isEmpty { return false }
    for entry in list {
      let e = normalized(entry)
      if e.isEmpty { continue }
      if bid == e || bid.hasPrefix(e + ".") { return true }
    }
    return false
  }

  /// Does `title` match one of `patterns`?
  ///
  /// Always case-insensitive, whether or not the pattern carries an inline
  /// `(?i)`. A pattern that fails to compile falls back to a literal
  /// case-insensitive substring test instead of being silently dropped — a
  /// typo in a user's regex used to turn that exclusion into a no-op.
  nonisolated static func titleIsExcluded(_ title: String?, patterns: [String]) -> Bool {
    guard let title, !title.isEmpty else { return false }
    let range = NSRange(location: 0, length: title.utf16.count)
    for pattern in patterns {
      let p = pattern.trimmingCharacters(in: .whitespacesAndNewlines)
      if p.isEmpty { continue }
      if let re = try? NSRegularExpression(pattern: p, options: [.caseInsensitive]) {
        if re.firstMatch(in: title, range: range) != nil { return true }
      } else if title.range(of: p, options: [.caseInsensitive]) != nil {
        return true
      }
    }
    return false
  }

  /// Exclusion test for a single known app/window pair (activity logging, and
  /// the frontmost pre-check in ScreenCapturer). Screen capture must use
  /// decideCapture() instead — this call cannot see the other windows on the
  /// display, and that blind spot was the bug.
  func isExcluded(bundleId: String?, windowTitle: String?) -> Bool {
    if Self.bundleIdIsExcluded(bundleId, in: excludedBundleIds) { return true }
    return Self.titleIsExcluded(windowTitle, patterns: excludedWindowPatterns)
  }

  // MARK: — the capture decision (single source of truth for both paths)

  /// Instance wrapper over `decideCapture` using the live exclusion lists.
  func captureDecision(windows: [CaptureWindowInfo]?,
                       alwaysExcludeWindowIDs: [UInt32] = []) -> CaptureDecision {
    Self.decideCapture(windows: windows,
                       excludedBundleIds: excludedBundleIds,
                       excludedWindowPatterns: excludedWindowPatterns,
                       alwaysExcludeWindowIDs: alwaysExcludeWindowIDs)
  }

  /// Decide what may be captured, given every window ScreenCaptureKit can see.
  ///
  /// FAIL-CLOSED RULES — each one covers a state where we could not evaluate
  /// the user's exclusions, and "we could not check" is not "nothing to
  /// exclude":
  ///   * `windows == nil` (the window list could not be enumerated) -> skip.
  ///   * no on-screen windows enumerated at all -> skip; we cannot attribute
  ///     anything that is on the display.
  ///   * title rules are configured but NOT ONE on-screen window has a
  ///     readable title -> skip. Titles are what the regex rules (private
  ///     browsing / password / OTP) act on; they come from ScreenCaptureKit's
  ///     window list, with the Accessibility API as the only other source, and
  ///     when neither yields anything a banking or 2FA window is
  ///     indistinguishable from a text editor. Capture stops until titles are
  ///     readable again, and the reason is surfaced rather than swallowed.
  ///   * an individual window whose owning application is unknown -> that
  ///     window is excluded from the capture (we cannot rule it out).
  ///   * an individual on-screen window with no readable title while title
  ///     rules are configured -> excluded from the capture, same reason.
  ///
  /// Off-screen windows are never captured, so they are only excluded when they
  /// positively match a rule; they do not trigger the fail-closed cases.
  nonisolated static func decideCapture(
    windows: [CaptureWindowInfo]?,
    excludedBundleIds: [String],
    excludedWindowPatterns: [String],
    alwaysExcludeWindowIDs: [UInt32] = []
  ) -> CaptureDecision {
    guard let windows else {
      return .skip(reason: "the window list could not be read, so the exclusion list could not be checked")
    }
    let onScreen = windows.filter { $0.isOnScreen }
    if onScreen.isEmpty {
      return .skip(reason: "no on-screen windows could be read, so the exclusion list could not be checked")
    }
    let activePatterns = excludedWindowPatterns.filter {
      !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
    if !activePatterns.isEmpty && !onScreen.contains(where: { !($0.title ?? "").isEmpty }) {
      return .skip(reason: "window titles are unreadable (grant Accessibility to OpenAGI), so the title exclusion rules could not be checked")
    }

    var excluded = Set(alwaysExcludeWindowIDs)
    for w in windows {
      if excluded.contains(w.windowID) { continue }
      if bundleIdIsExcluded(w.bundleId, in: excludedBundleIds) { excluded.insert(w.windowID); continue }
      if titleIsExcluded(w.title, patterns: activePatterns) { excluded.insert(w.windowID); continue }
      guard w.isOnScreen else { continue }
      if normalized(w.bundleId).isEmpty { excluded.insert(w.windowID); continue }
      if !activePatterns.isEmpty && (w.title ?? "").isEmpty { excluded.insert(w.windowID) }
    }
    return .capture(excludedWindowIDs: excluded.sorted())
  }

  // MARK: — defaults migration

  /// Append every entry of `defaults` that is neither already in `list` nor
  /// recorded in `alreadyApplied`. Comparison is case-insensitive and
  /// whitespace-trimmed; the user's own ordering and entries are preserved.
  nonisolated static func mergingNewDefaults(into list: [String],
                                             defaults: [String],
                                             alreadyApplied: [String]) -> [String] {
    var present = Set(list.map { normalized($0) })
    let applied = Set(alreadyApplied.map { normalized($0) })
    var out = list
    for d in defaults {
      let key = normalized(d)
      if key.isEmpty || present.contains(key) || applied.contains(key) { continue }
      out.append(d)
      present.insert(key)
    }
    return out
  }

  private func persist() {
    var payload: [String: Any] = [
      "enabled": enabled,
      "captureIntervalSeconds": captureIntervalSeconds,
      "excludedBundleIds": excludedBundleIds,
      "excludedWindowPatterns": excludedWindowPatterns,
      "appliedDefaultBundleIds": appliedDefaultBundleIds,
      "appliedDefaultWindowPatterns": appliedDefaultWindowPatterns,
      "frameRetentionDays": frameRetentionDays,
      "textRetentionDays": textRetentionDays,
      "maxDiskBytes": maxDiskBytes
    ]
    if let until = pausedUntil { payload["pausedUntil"] = ISO8601DateFormatter().string(from: until) }
    let data = try? JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted, .sortedKeys])
    if let data = data { try? data.write(to: Self.settingsPath, options: [.atomic]) }
  }
}
