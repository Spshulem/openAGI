import Foundation

// The few fields of GET /plan/daily and GET /recap/daily a notification
// needs. Everything is optional: these responses grow over time and a
// missing field should shorten a notification, never fail it.

public struct DailyPlanDigest: Decodable, Sendable, Equatable {
    public struct Item: Decodable, Sendable, Equatable { public let title: String? }
    public struct Counts: Decodable, Sendable, Equatable { public let events: Int?; public let focus: Int? }
    public struct Plan: Decodable, Sendable, Equatable {
        public let dateISO: String?
        public let focus: [Item]?
        public let counts: Counts?
    }
    public let plan: Plan
}

public struct DailyRecapDigest: Decodable, Sendable, Equatable {
    public struct Item: Decodable, Sendable, Equatable { public let title: String? }
    public struct Counts: Decodable, Sendable, Equatable { public let completedTasks: Int? }
    public struct Recap: Decodable, Sendable, Equatable {
        public let dateISO: String?
        public let completedTasks: [Item]?
        public let counts: Counts?
    }
    public let recap: Recap
}

public enum DailyDigestText {
    // "Focus: Call the dentist, Groceries, and 2 more. 3 events on your calendar."
    public static func planBody(_ digest: DailyPlanDigest) -> String {
        let titles = (digest.plan.focus ?? []).compactMap { $0.title?.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
        let events = digest.plan.counts?.events ?? 0
        var parts: [String] = []
        if !titles.isEmpty { parts.append("Focus: " + list(titles) + ".") }
        if events > 0 { parts.append(events == 1 ? "1 event on your calendar." : "\(events) events on your calendar.") }
        return parts.isEmpty ? "Nothing scheduled yet. Tell me what today should hold." : parts.joined(separator: " ")
    }

    public static func recapBody(_ digest: DailyRecapDigest) -> String {
        let titles = (digest.recap.completedTasks ?? []).compactMap { $0.title?.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
        let done = digest.recap.counts?.completedTasks ?? titles.count
        guard done > 0 else { return "No tasks finished yet today. Anything to carry over to tomorrow?" }
        let lead = done == 1 ? "You finished 1 task" : "You finished \(done) tasks"
        return titles.isEmpty ? lead + "." : lead + ": " + list(titles) + "."
    }

    private static func list(_ titles: [String]) -> String {
        let shown = titles.prefix(2).map { $0.count > 40 ? String($0.prefix(39)) + "…" : $0 }
        let rest = titles.count - shown.count
        if rest > 0 { return shown.joined(separator: ", ") + ", and \(rest) more" }
        return shown.count == 2 ? shown.joined(separator: " and ") : shown.joined()
    }
}
