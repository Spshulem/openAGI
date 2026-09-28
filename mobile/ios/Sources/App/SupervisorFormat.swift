import Foundation

// Everything the Supervisor screen decides about words and order, kept pure
// so it can be pinned by tests: health order, thread names, state labels in
// plain words, PR chips and links, and what a delivery result says. Mirrors
// Android's SupervisorFormat.kt word for word, which follows the /fleet web
// page (src/fleet/page.js), so the phones and the dashboard describe the
// same thread the same way.
enum SupervisorFormat {
    static let starters = ["What's running?", "What needs me?", "Which threads are red?"]

    // Worst first: what needs a person, then what needs a look, then what is
    // fine, then what is out of scope. Within a colour, most recent first.
    static let healthOrder: [FleetHealth] = [.red, .yellow, .green, .gray]

    static func sorted(_ threads: [FleetThread]) -> [FleetThread] {
        threads.sorted { lhs, rhs in
            let left = healthOrder.firstIndex(of: FleetHealth.of(lhs)) ?? healthOrder.count
            let right = healthOrder.firstIndex(of: FleetHealth.of(rhs)) ?? healthOrder.count
            if left != right { return left < right }
            let leftAt = lhs.lastActivityAt ?? .distantPast
            let rightAt = rhs.lastActivityAt ?? .distantPast
            if leftAt != rightAt { return leftAt > rightAt }
            return name(lhs).lowercased() < name(rhs).lowercased()
        }
    }

    // "3 red · 5 yellow · 12 green", zero counts left out.
    static func summary(_ threads: [FleetThread]) -> String {
        var counts: [FleetHealth: Int] = [:]
        for thread in threads { counts[FleetHealth.of(thread), default: 0] += 1 }
        return healthOrder.compactMap { health in counts[health].map { "\($0) \(health.rawValue)" } }
            .joined(separator: " · ")
    }

    static func healthLabel(_ health: FleetHealth) -> String {
        switch health {
        case .red: return "Red"
        case .yellow: return "Yellow"
        case .green: return "Green"
        case .gray: return "Gray"
        }
    }

    static func name(_ thread: FleetThread) -> String {
        if let workspace = nonBlank(thread.workspace) { return workspace }
        if let title = nonBlank(thread.title) { return title }
        if let key = nonBlank(thread.key) { return key }
        return "Untitled thread"
    }

    static func stateLabel(_ state: String?) -> String {
        switch state {
        case "needs-human": return "Needs you"
        case "ready-needs-human": return "Ready, needs a human"
        case "asked-in-scope": return "Asked, in scope"
        case "pr-not-ready": return "PR not ready"
        case "infra-blocked": return "Infra blocked"
        case "local-verify": return "Verifying on laptop"
        case "waiting-ci": return "Waiting on CI"
        case "running": return "Running"
        case "idle-no-pr": return "Idle, no PR"
        case "done": return "Done"
        case "excluded": return "Out of scope"
        case nil, "": return "Unknown"
        case let other?: return capitalizedFirst(other.replacingOccurrences(of: "-", with: " "))
        }
    }

    // "Scanned 3m ago · Auto-scan on" -- the header's one line of freshness.
    static func scanLine(lastTickAt: Date?, autoScan: Bool, now: Date) -> String {
        let scanned: String
        if let lastTickAt {
            let minutes = Int(now.timeIntervalSince(lastTickAt) / 60)
            scanned = minutes <= 0 ? "Scanned just now" : "Scanned \(RelativeTime.compact(minutes: minutes)) ago"
        } else {
            scanned = "Not scanned yet"
        }
        return scanned + (autoScan ? " · Auto-scan on" : " · Auto-scan off")
    }

    // At most one warning line: a failed last scan outranks sources that
    // could not be read, since it means nothing on screen is current.
    static func warning(_ state: FleetState) -> String? {
        if let error = state.lastErrorText { return "Last scan failed: \(error)" }
        let failed = (state.snapshot?.sourceErrorTexts.keys).map(Array.init) ?? []
        guard !failed.isEmpty else { return nil }
        return "Couldn't read " + failed.sorted().joined(separator: ", ") + " on the last scan."
    }

    static func modeLabel(_ mode: FleetMode) -> String {
        switch mode {
        case .observe: return "Observe"
        case .propose: return "Propose"
        case .auto: return "Auto"
        }
    }

    static func modeHint(_ mode: String?) -> String? {
        switch mode.flatMap(FleetMode.init(rawValue:)) {
        case .observe?: return "Watching only. Sends nothing."
        case .propose?: return "Plans nudges. You tap Send."
        case .auto?: return "Sends nudges on its own, a few per scan."
        case nil: return nil
        }
    }

    // "owner/repo#123" -> "#123"; anything else is shown as it came.
    static func prNumber(_ ref: String?) -> String? {
        guard let ref = nonBlank(ref) else { return nil }
        if let match = prRefParts(ref) { return "#" + match.number }
        return ref
    }

    static func ciLabel(_ ci: FleetCI?) -> String? {
        guard let state = nonBlank(ci?.state) else { return nil }
        switch state.uppercased() {
        case "SUCCESS": return "CI passing"
        case "FAILURE", "ERROR": return "CI failing"
        case "PENDING", "EXPECTED": return "CI running"
        default: return "CI " + state.lowercased()
        }
    }

    static func ciFailing(_ ci: FleetCI?) -> Bool {
        guard let ci else { return false }
        return ["FAILURE", "ERROR"].contains(ci.state?.uppercased() ?? "") || !ci.failing.isEmpty
    }

    // "#123 · CI failing" -- the chip on a thread row.
    static func prChip(_ pr: FleetPR?) -> String? {
        guard let number = prNumber(pr?.ref) else { return nil }
        return [number, ciLabel(pr?.ci)].compactMap { $0 }.joined(separator: " · ")
    }

    // Only a GitHub pull request URL opens; otherwise one is built from the
    // ref, and anything else stays text -- the same rule as the web page.
    static func prURL(_ pr: FleetPR?) -> URL? {
        if let url = pr?.url, url.range(of: #"^https://github\.com/[\w.-]+/[\w.-]+/pull/\d+$"#, options: .regularExpression) != nil {
            return URL(string: url)
        }
        guard let ref = pr?.ref, let parts = prRefParts(ref) else { return nil }
        return URL(string: "https://github.com/\(parts.repo)/pull/\(parts.number)")
    }

    // Proposed nudges waiting on Send that concern this thread.
    static func proposed(for thread: FleetThread, in actions: [FleetAction]) -> [FleetAction] {
        actions.filter { $0.status == "proposed" && ($0.threadKey == thread.key || $0.targetKey == thread.key) }
    }

    struct Note: Equatable {
        let text: String
        let isAlert: Bool
    }

    // What happened to an answer or a sent nudge, in one line.
    static func deliveryNote(_ delivery: FleetDelivery?, fallback: String) -> Note {
        let detail = nonBlank(delivery?.detail?.trimmingCharacters(in: .whitespacesAndNewlines))
        switch delivery?.status {
        case "sent": return Note(text: "Sent to the agent.", isAlert: false)
        case "dry-run": return Note(text: "Saved. Dry run, nothing sent.", isAlert: false)
        case "blocked": return Note(text: "Saved. Couldn't reach the agent" + (detail.map { ": \($0)" } ?? "."), isAlert: true)
        case "failed": return Note(text: "Saved. Send failed" + (detail.map { ": \($0)" } ?? "."), isAlert: true)
        default: return Note(text: fallback, isAlert: false)
        }
    }

    static func errorKindLabel(_ kind: String?) -> String {
        switch kind {
        case "session-limit": return "Session limit"
        case "model-limit": return "Model limit"
        case "usage-limit": return "Usage limit"
        case "overloaded": return "Provider overloaded"
        case "network": return "Network error"
        case "lb": return "Load balancer error"
        case "logged-out": return "Logged out"
        case "disk-full": return "Disk full"
        case nil, "": return "Error"
        case let other?: return capitalizedFirst(other.replacingOccurrences(of: "-", with: " "))
        }
    }

    // "Needs you" wording when the daemon can't serve these routes. 503, or
    // 404 on state/scan/mode, means no supervisor on this daemon; a refused
    // phone credential on these routes alone most likely means a main from
    // before the supervisor was opened to phones, not a revoked pairing.
    static func errorCopy(_ error: DaemonError) -> (headline: String, detail: String) {
        switch error {
        case .server(503), .notFound:
            return ("Supervisor isn't running on this daemon.", "Turn it on from the dashboard on your main, then pull to refresh.")
        case .unauthorized:
            return ("Supervisor isn't open to this phone.", "Update OpenAGI on your main. If the other tabs fail too, re-pair in Settings.")
        case .conflict:
            return ("That's already been handled.", "Someone or something else got there first — refresh to see the current state.")
        default:
            return ("Can't reach OpenAGI.", "Check your connection and pull to refresh.")
        }
    }

    static func isUnavailable(_ error: DaemonError) -> Bool {
        error == .server(503) || error == .notFound
    }

    static func isTimeout(_ error: DaemonError) -> Bool {
        if case .transport(let underlying) = error, (underlying as? URLError)?.code == .timedOut { return true }
        return false
    }

    // Why an answer or a Send did not go through. A timeout is not a
    // failure: the relay may still be delivering it. On a question or a
    // nudge, 404 (no longer open) and 409 (closed elsewhere while this ran)
    // mean the same thing to a person.
    static func failureNote(_ error: DaemonError) -> Note {
        if isTimeout(error) {
            return Note(text: "No word from the agent yet. Pull to refresh to see if it went through.", isAlert: false)
        }
        if error == .conflict || error == .notFound {
            return Note(text: errorCopy(.conflict).headline, isAlert: false)
        }
        return Note(text: errorCopy(error).headline, isAlert: true)
    }

    // "3:40 PM" today, "Sep 28, 3:40 PM" otherwise.
    static func clockTime(_ date: Date, now: Date = Date(), calendar: Calendar = .current) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = calendar.timeZone
        formatter.dateFormat = calendar.isDate(date, inSameDayAs: now) ? "h:mm a" : "MMM d, h:mm a"
        return formatter.string(from: date)
    }

    static func agoPhrase(_ date: Date, now: Date = Date()) -> String {
        let minutes = Int(now.timeIntervalSince(date) / 60)
        return minutes <= 0 ? "just now" : RelativeTime.compact(minutes: minutes) + " ago"
    }

    private static func prRefParts(_ ref: String) -> (repo: String, number: String)? {
        guard ref.range(of: #"^[\w.-]+/[\w.-]+#\d+$"#, options: .regularExpression) != nil,
              let hash = ref.lastIndex(of: "#") else { return nil }
        return (String(ref[..<hash]), String(ref[ref.index(after: hash)...]))
    }

    private static func nonBlank(_ text: String?) -> String? {
        guard let text, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        return text
    }

    private static func capitalizedFirst(_ text: String) -> String {
        guard let first = text.first else { return text }
        return first.uppercased() + text.dropFirst()
    }
}
