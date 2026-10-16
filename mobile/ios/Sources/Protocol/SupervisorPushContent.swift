import Foundation

// Every decision behind a supervisor alert, kept free of UserNotifications so
// the app's test target can pin it: what the notification service extension
// writes into a delivered alert, which options become buttons, and what a
// button tap asks the daemon to do. Mirrors Android's SupervisorAlerts.kt.
//
// Titles and bodies quote agent transcripts. They are display text only:
// never parsed, never logged.
public enum SupervisorPushContent {
    // The relay's `aps.category`. Registered by the app with no buttons: it is
    // what an alert keeps when the extension could not decrypt it, and a tap
    // still opens Supervisor.
    public static let baseCategory = "SUPERVISOR_QUESTION"
    // Decrypted alerts move to `sq.<n>`, one category per distinct option
    // list, because a category's buttons carry fixed titles.
    public static let categoryPrefix = "sq."
    public static let answerActionPrefix = "answer."
    public static let dismissAction = "dismiss"
    public static let dismissTitle = "Dismiss"

    // userInfo keys the extension adds next to the relay's `sealed`.
    public static let questionIdKey = "questionId"
    public static let optionsKey = "options"
    public static let threadKeyKey = "threadKey"
    public static let sealedKey = "sealed"

    static let titleMax = 100
    static let bodyMax = 220
    static let actionLabelMax = 40
    static let maxActions = 3
    static let fallbackTitle = "Needs you"
    // "open thread" asks the owner to open the agent's own app; posting it as
    // an answer delivers nothing. Tapping the alert opens Supervisor instead.
    static let nonActions: Set<String> = ["dismiss", "open thread"]

    public struct Alert: Equatable, Sendable {
        public var questionId: String
        public var title: String
        public var body: String
        // Exact option strings, in button order; the daemon only accepts an
        // option verbatim, so these are never trimmed or capped.
        public var options: [String]
        public var threadKey: String?

        public var categoryIdentifier: String { SupervisorPushContent.categoryIdentifier(for: options) }
        public var actionTitles: [String] { options.map { SupervisorPushContent.cap($0.trimmingCharacters(in: .whitespacesAndNewlines), actionLabelMax) } }

        // Merged into the delivered notification's userInfo.
        public var userInfo: [String: Any] {
            var info: [String: Any] = [questionIdKey: questionId, optionsKey: options]
            if let threadKey { info[threadKeyKey] = threadKey }
            return info
        }
    }

    // The extension's whole mapping: nil means "leave the relay's generic
    // text alone" (no key, a key from an older pairing, a tampered or
    // malformed envelope).
    public static func alert(userInfo: [AnyHashable: Any], key: Data?) -> Alert? {
        guard let key, let sealed = userInfo[sealedKey] as? String,
              let plaintext = try? PushEnvelope.decode(SupervisorAlertPlaintext.self, from: sealed, key: key, kind: .alert)
        else { return nil }
        return alert(from: plaintext)
    }

    public static func alert(from plaintext: SupervisorAlertPlaintext) -> Alert? {
        let questionId = plaintext.questionId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !questionId.isEmpty else { return nil }
        let rawTitle = plaintext.title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return Alert(
            questionId: questionId,
            title: cap(rawTitle.isEmpty ? fallbackTitle : rawTitle, titleMax),
            body: cap(plaintext.body?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "", bodyMax),
            options: actionOptions(plaintext.options),
            threadKey: plaintext.threadKey
        )
    }

    // Same rule as Android: no blanks, no "dismiss" / "open thread"
    // (case-insensitive, ignoring surrounding space), no duplicates, at most 3.
    public static func actionOptions(_ options: [String]) -> [String] {
        var seen = Set<String>()
        var result: [String] = []
        for option in options {
            let trimmed = option.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty, !nonActions.contains(trimmed.lowercased()), seen.insert(option).inserted else { continue }
            result.append(option)
            if result.count == maxActions { break }
        }
        return result
    }

    // `sq.<n>`, n a stable hash of the exact option list. Two questions with
    // the same buttons share a category; different buttons never overwrite
    // each other's titles on an alert still in the shade. FNV-1a, not
    // `hashValue`, because the extension and the app are different processes
    // and Swift seeds `hashValue` per launch.
    public static func categoryIdentifier(for options: [String]) -> String {
        var hash: UInt64 = 0xcbf29ce484222325
        for byte in options.joined(separator: "\u{0}").utf8 {
            hash ^= UInt64(byte)
            hash = hash &* 0x100000001b3
        }
        return categoryPrefix + String(hash, radix: 16)
    }

    // The ellipsis counts toward the cap; never splits a character.
    static func cap(_ value: String, _ max: Int) -> String {
        guard value.count > max else { return value }
        return String(value.prefix(max - 1)).trimmingCharacters(in: .whitespacesAndNewlines) + "…"
    }
}

// What one tap on a supervisor alert asks for. Built from the notification's
// own userInfo, which the extension filled in: the button index picks the
// exact option string it stored, so the label (capped for display) is never
// what gets sent.
public enum SupervisorAnswerAction: Equatable, Sendable {
    case answer(questionId: String, answer: String)
    case dismiss(questionId: String)
    case open

    // nil for anything that is not ours (a system dismiss, an unknown id).
    public static func from(actionIdentifier: String, defaultActionIdentifier: String, userInfo: [AnyHashable: Any]) -> SupervisorAnswerAction? {
        if actionIdentifier == defaultActionIdentifier { return .open }
        guard let questionId = (userInfo[SupervisorPushContent.questionIdKey] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines), !questionId.isEmpty
        else { return nil }
        if actionIdentifier == SupervisorPushContent.dismissAction { return .dismiss(questionId: questionId) }
        guard actionIdentifier.hasPrefix(SupervisorPushContent.answerActionPrefix),
              let index = Int(actionIdentifier.dropFirst(SupervisorPushContent.answerActionPrefix.count)),
              let options = userInfo[SupervisorPushContent.optionsKey] as? [String],
              options.indices.contains(index)
        else { return nil }
        return .answer(questionId: questionId, answer: options[index])
    }
}
