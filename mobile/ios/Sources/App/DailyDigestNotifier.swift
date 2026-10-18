import Foundation
import UserNotifications

// Phone-only mode's morning plan and evening recap. On a Mac the daemon
// pushes these; on the phone nothing leaves the device, so the app keeps
// them scheduled as local notifications.
//
// A week of both is always pending, so they keep arriving even if the app
// isn't opened. Each refresh (foreground, background refresh) rewrites the
// next one of each with what the agent on this iPhone actually knows: today's
// focus for the morning, what got done for the evening.
@MainActor
enum DailyDigestNotifier {
    nonisolated enum Kind: String, CaseIterable, Sendable {
        case plan
        case recap

        // Matches the daemon's daily-plan-morning and daily-recap-evening jobs.
        var hour: Int { self == .plan ? 8 : 18 }
        var title: String { self == .plan ? "Your plan for today" : "Your day in review" }
        var fallbackBody: String {
            self == .plan ? "See what's on today, and what I can take off your plate."
                          : "See what you got done today, and what carries over."
        }
        // Morning opens Today; evening opens Chat, where the recap continues.
        var tab: AppTab { self == .plan ? .today : .chat }
    }

    nonisolated static let userInfoKey = "openagiDigest"
    private static let days = 7

    nonisolated static func tab(for userInfo: [AnyHashable: Any]) -> AppTab? {
        (userInfo[userInfoKey] as? String).flatMap(Kind.init(rawValue:))?.tab
    }

    // Schedules the week with whatever text the daemon gives now. Without a
    // client (or if it's unreachable) the generic text is used.
    static func refresh(client: DaemonClient?, now: Date = Date()) async {
        let center = UNUserNotificationCenter.current()
        guard await center.notificationSettings().authorizationStatus != .denied else { return }
        var bodies: [Kind: String] = [:]
        if let client {
            if let plan = try? await client.dailyPlan() { bodies[.plan] = DailyDigestText.planBody(plan) }
            if let recap = try? await client.dailyRecap() { bodies[.recap] = DailyDigestText.recapBody(recap) }
        }
        for kind in Kind.allCases {
            center.removePendingNotificationRequests(withIdentifiers: identifiers(kind))
            for (offset, fire) in fireDates(kind, from: now).enumerated() {
                let content = UNMutableNotificationContent()
                content.title = kind.title
                // Only the next one is about today; later days keep the
                // generic line until a refresh closer to them.
                content.body = offset == 0 ? bodies[kind] ?? kind.fallbackBody : kind.fallbackBody
                content.sound = .default
                content.userInfo = [userInfoKey: kind.rawValue]
                content.threadIdentifier = "openagi.digest.\(kind.rawValue)"
                let components = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute], from: fire)
                let request = UNNotificationRequest(
                    identifier: identifiers(kind)[offset],
                    content: content,
                    trigger: UNCalendarNotificationTrigger(dateMatching: components, repeats: false)
                )
                try? await center.add(request)
            }
        }
    }

    // Leaving phone mode: a Mac sends its own, so these would double up.
    static func cancelAll() {
        UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: Kind.allCases.flatMap(identifiers))
    }

    static func fireDates(_ kind: Kind, from now: Date, calendar: Calendar = .current) -> [Date] {
        guard var next = calendar.nextDate(after: now, matching: DateComponents(hour: kind.hour, minute: 0), matchingPolicy: .nextTime) else { return [] }
        var dates: [Date] = []
        for _ in 0..<days {
            dates.append(next)
            guard let following = calendar.date(byAdding: .day, value: 1, to: next) else { break }
            next = following
        }
        return dates
    }

    private static func identifiers(_ kind: Kind) -> [String] {
        (0..<days).map { "openagi.digest.\(kind.rawValue).\($0)" }
    }
}
