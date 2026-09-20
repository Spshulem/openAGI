import Foundation

// DESIGN.md's Chat section: "Consecutive messages from the same speaker
// tighten to 2pt apart; a change of speaker opens to 12. No timestamp
// unless more than 15 minutes passed, and then it is a centred `caption` in
// `muted` between the two groups." Pure and SwiftUI-free by design, like
// `RelativeTime`, so the exact spacing/threshold rules are directly
// testable rather than only visible by eye in a running app.
enum MessageGrouping {
    static let sameSpeakerSpacing: Double = 2
    static let newSpeakerSpacing: Double = 12
    static let timestampDividerThreshold: TimeInterval = 15 * 60

    // Spacing to place above a message, given the role of the message
    // immediately before it. `nil` means "first message in the list" -- the
    // container's own top padding handles that case, not this value.
    static func spacing(previousRole: ChatMessage.Role?, currentRole: ChatMessage.Role) -> Double {
        guard let previousRole else { return 0 }
        return previousRole == currentRole ? sameSpeakerSpacing : newSpeakerSpacing
    }

    // Whether a timestamp divider belongs between two consecutive messages.
    static func needsTimestampDivider(previousTimestamp: Date?, currentTimestamp: Date) -> Bool {
        guard let previousTimestamp else { return false }
        return currentTimestamp.timeIntervalSince(previousTimestamp) > timestampDividerThreshold
    }

    struct DisplayItem: Equatable {
        let message: ChatMessage
        let spacingBefore: Double
        let timestampDividerText: String?
    }

    // The whole list, precomputed in one pass -- what ChatView actually
    // iterates over, so its body never re-derives grouping/timestamp
    // decisions inline where they'd be untestable.
    static func displayItems(for messages: [ChatMessage],
                                     timestampFormatter: (Date) -> String = defaultTimestampLabel) -> [DisplayItem] {
        var items: [DisplayItem] = []
        items.reserveCapacity(messages.count)
        var previous: ChatMessage?
        for message in messages {
            let spacing = spacing(previousRole: previous?.role, currentRole: message.role)
            let showsDivider = needsTimestampDivider(previousTimestamp: previous?.timestamp, currentTimestamp: message.timestamp)
            items.append(DisplayItem(
                message: message,
                spacingBefore: spacing,
                timestampDividerText: showsDivider ? timestampFormatter(message.timestamp) : nil
            ))
            previous = message
        }
        return items
    }

    static func defaultTimestampLabel(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.dateStyle = .none
        formatter.timeStyle = .short
        return formatter.string(from: date)
    }
}
