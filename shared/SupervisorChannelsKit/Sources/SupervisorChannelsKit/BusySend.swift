import Foundation

/// What Send does while a reply is running (a Settings preference on each
/// device; the iPhone and the Mac use the same key and words).
///
/// - `queue` (default): the message waits its turn behind everything queued.
/// - `sendNow`: the running reply is stopped and this message goes next,
///   ahead of the other queued messages, which keep their order.
///
/// Either way the composer offers the other choice for one message ("Send
/// anyway" / "Queue instead"). When nothing is running, Send just sends.
public enum BusySendBehavior: String, CaseIterable, Identifiable, Sendable {
    case queue
    case sendNow

    public static let defaultsKey = "openagi.chat.busySendBehavior"
    public static let `default`: BusySendBehavior = .queue

    public var id: String { rawValue }

    /// The Settings row's words.
    public var title: String {
        switch self {
        case .queue: return "Queue message"
        case .sendNow: return "Send immediately"
        }
    }

    public var detail: String {
        switch self {
        case .queue: return "Waits until the current reply and earlier queued messages finish."
        case .sendNow: return "Stops the current reply and sends this next. An action already running finishes; nothing is undone."
        }
    }

    /// The composer's label for the main Send button while a reply runs.
    public var busyLabel: String {
        switch self {
        case .queue: return "Queue message"
        case .sendNow: return "Send anyway"
        }
    }

    /// The other choice, offered for one message.
    public var other: BusySendBehavior { self == .queue ? .sendNow : .queue }

    public static func stored(in defaults: UserDefaults = .standard) -> BusySendBehavior {
        defaults.string(forKey: defaultsKey).flatMap(BusySendBehavior.init(rawValue:)) ?? .default
    }

    public func store(in defaults: UserDefaults = .standard) {
        defaults.set(rawValue, forKey: Self.defaultsKey)
    }
}

/// How one Send is handled.
public enum SendDecision: Equatable, Sendable {
    /// Nothing is running: send normally.
    case send
    /// Wait behind the running reply and the queue.
    case queue
    /// Stop the running reply; this message goes next.
    case sendNext

    /// `override` is the composer's one-message choice, if the person made
    /// one; otherwise the Settings preference applies.
    public static func resolve(busy: Bool, preference: BusySendBehavior, override: BusySendBehavior? = nil) -> SendDecision {
        guard busy else { return .send }
        switch override ?? preference {
        case .queue: return .queue
        case .sendNow: return .sendNext
        }
    }
}
