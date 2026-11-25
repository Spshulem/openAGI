import Foundation

public enum SupervisorBoardTaskState: String, CaseIterable, Identifiable, Sendable {
    case all
    case blocked
    case claimed
    case ready
    case waiting
    case done

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .all: return "All"
        case .blocked: return "Blocked"
        case .claimed: return "Claimed"
        case .ready: return "Ready"
        case .waiting: return "Waiting"
        case .done: return "Done"
        }
    }

    public var systemImage: String {
        switch self {
        case .all: return "tray.full"
        case .blocked: return "hand.raised"
        case .claimed: return "bolt.fill"
        case .ready: return "circle"
        case .waiting: return "clock"
        case .done: return "checkmark.circle.fill"
        }
    }
}

public enum SupervisorBoardTaskClassifier {
    public static func classify(
        status: String?,
        queue: String?,
        hasUnmetDeps: Bool = false,
        hasOpenQuestion: Bool = false,
        leaseExpiresAtISO: String? = nil,
        awaitingReview: Bool = false,
        now: Date = Date()
    ) -> SupervisorBoardTaskState {
        let normalizedStatus = (status ?? "pending").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if normalizedStatus == "completed" || normalizedStatus == "cancelled" {
            return .done
        }
        if normalizedStatus == "blocked" || hasUnmetDeps || hasOpenQuestion {
            return .blocked
        }
        if awaitingReview {
            return .waiting
        }
        if normalizedStatus == "in_progress" {
            if let leaseISO = leaseExpiresAtISO,
               let expiresAt = parseISO8601(leaseISO),
               expiresAt > now {
                return .claimed
            }
            return (queue ?? "user").lowercased() == "agent" ? .claimed : .waiting
        }
        return .ready
    }

    public static func leaseBadgeText(expiresAtISO: String?, now: Date = Date()) -> String? {
        guard let raw = expiresAtISO?.trimmingCharacters(in: .whitespacesAndNewlines),
              !raw.isEmpty,
              let expiresAt = parseISO8601(raw) else {
            return nil
        }
        let remaining = expiresAt.timeIntervalSince(now)
        if remaining <= 0 {
            return "Lease expired"
        }
        let minutes = max(1, Int(ceil(remaining / 60.0)))
        if minutes < 60 {
            return "Claimed · \(minutes)m left"
        }
        let hours = Int(remaining / 3600.0)
        return "Claimed · \(hours)h left"
    }

    public static func parseISO8601(_ string: String) -> Date? {
        let withFractional = ISO8601DateFormatter()
        withFractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = withFractional.date(from: string) { return d }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        return plain.date(from: string)
    }
}

public struct SupervisorBoardLabel: Identifiable, Equatable, Hashable, Sendable {
    public let key: String
    public let value: String

    public var id: String { raw }
    public var raw: String { "\(key)=\(value)" }

    public init(key: String, value: String) {
        self.key = key
        self.value = value
    }

    public static func parse(_ raw: String) -> SupervisorBoardLabel? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let eq = trimmed.firstIndex(of: "="),
              eq > trimmed.startIndex,
              trimmed.index(after: eq) < trimmed.endIndex else {
            return nil
        }
        let k = String(trimmed[..<eq]).trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let v = String(trimmed[trimmed.index(after: eq)...]).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !k.isEmpty, !v.isEmpty, !k.contains(" ") else { return nil }
        return SupervisorBoardLabel(key: k, value: v)
    }

    public static func extract(from tags: [String]) -> [SupervisorBoardLabel] {
        var seen = Set<String>()
        var out: [SupervisorBoardLabel] = []
        for tag in tags {
            guard let label = parse(tag) else { continue }
            let id = label.raw.lowercased()
            if seen.insert(id).inserted {
                out.append(label)
            }
        }
        return out
    }

    public static func matches(tags: [String], activeFilters: Set<String>) -> Bool {
        guard !activeFilters.isEmpty else { return true }
        let normalizedTags = Set(extract(from: tags).map { $0.raw.lowercased() })
        let normalizedFilters = activeFilters.map { $0.lowercased() }
        return normalizedFilters.allSatisfy { normalizedTags.contains($0) }
    }
}

public enum SupervisorMilestoneKind: String, Equatable, Hashable, Sendable {
    case decision
    case question
    case progress
    case blocked
    case pr
    case commit
}

public struct SupervisorMilestoneItem: Identifiable, Equatable, Hashable, Sendable {
    public let id: String
    public let kind: SupervisorMilestoneKind
    public let badge: String
    public let summary: String
    public let ref: String?

    public init(id: String, kind: SupervisorMilestoneKind, badge: String, summary: String, ref: String? = nil) {
        self.id = id
        self.kind = kind
        self.badge = badge
        self.summary = summary
        self.ref = ref
    }
}

public enum SupervisorMilestoneParser {
    private static let tagPrefixes: [(prefix: String, kind: SupervisorMilestoneKind, badge: String)] = [
        ("[decision]", .decision, "Decision"),
        ("[question]", .question, "Question"),
        ("[progress]", .progress, "Progress"),
        ("[blocked]", .blocked, "Blocked")
    ]

    public static func parse(from text: String) -> [SupervisorMilestoneItem] {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return [] }

        var items: [SupervisorMilestoneItem] = []
        var seen = Set<String>()

        for rawLine in trimmed.components(separatedBy: .newlines) {
            var line = rawLine.trimmingCharacters(in: .whitespacesAndNewlines)
            if line.hasPrefix("- ") || line.hasPrefix("* ") || line.hasPrefix("• ") {
                line = String(line.dropFirst(2)).trimmingCharacters(in: .whitespacesAndNewlines)
            }
            let lower = line.lowercased()
            for entry in tagPrefixes {
                if lower.hasPrefix(entry.prefix) {
                    let rest = String(line.dropFirst(entry.prefix.count))
                        .trimmingCharacters(in: CharacterSet.whitespaces.union(CharacterSet(charactersIn: ":-")))
                    let summary = rest.isEmpty ? entry.badge : String(rest.prefix(160))
                    let dedupe = "\(entry.kind.rawValue):\(summary.lowercased())"
                    if seen.insert(dedupe).inserted {
                        items.append(SupervisorMilestoneItem(
                            id: dedupe,
                            kind: entry.kind,
                            badge: entry.badge,
                            summary: summary
                        ))
                    }
                    break
                }
            }
        }

        let ns = trimmed as NSString
        let fullRange = NSRange(location: 0, length: ns.length)

        if let prRegex = try? NSRegularExpression(pattern: #"(?:([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)#(\d+)|https://github\.com/([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)/pull/(\d+)|\bPR\s+#(\d+))"#) {
            for match in prRegex.matches(in: trimmed, range: fullRange) {
                let ref: String
                if match.range(at: 1).location != NSNotFound, match.range(at: 2).location != NSNotFound {
                    ref = "\(ns.substring(with: match.range(at: 1)))#\(ns.substring(with: match.range(at: 2)))"
                } else if match.range(at: 3).location != NSNotFound, match.range(at: 4).location != NSNotFound {
                    ref = "\(ns.substring(with: match.range(at: 3)))#\(ns.substring(with: match.range(at: 4)))"
                } else if match.range(at: 5).location != NSNotFound {
                    ref = "#\(ns.substring(with: match.range(at: 5)))"
                } else {
                    continue
                }
                let dedupe = "pr:\(ref.lowercased())"
                if seen.insert(dedupe).inserted {
                    items.append(SupervisorMilestoneItem(
                        id: dedupe,
                        kind: .pr,
                        badge: "PR",
                        summary: ref,
                        ref: ref
                    ))
                }
            }
        }

        if let shaRegex = try? NSRegularExpression(pattern: #"(?i)\b(?:commit|pushed|head|at|sha)\s+`?([0-9a-f]{7,10})`?\b"#) {
            for match in shaRegex.matches(in: trimmed, range: fullRange) {
                guard match.range(at: 1).location != NSNotFound else { continue }
                let sha = ns.substring(with: match.range(at: 1))
                let dedupe = "commit:\(sha.lowercased())"
                if seen.insert(dedupe).inserted {
                    items.append(SupervisorMilestoneItem(
                        id: dedupe,
                        kind: .commit,
                        badge: "Commit",
                        summary: sha,
                        ref: sha
                    ))
                }
            }
        }

        return Array(items.prefix(8))
    }
}

public enum SupervisorQuietCheckFormatter {
    public static func badge(nextCheckISO: String?, now: Date = Date()) -> String? {
        guard let raw = nextCheckISO?.trimmingCharacters(in: .whitespacesAndNewlines),
              !raw.isEmpty,
              let date = SupervisorBoardTaskClassifier.parseISO8601(raw) else {
            return nil
        }
        return badge(nextCheckDate: date, now: now)
    }

    public static func badge(nextCheckDate: Date?, now: Date = Date()) -> String? {
        guard let nextCheckDate else { return nil }
        let delta = nextCheckDate.timeIntervalSince(now)
        if delta <= 15 {
            return "Quiet check due"
        }
        if delta < 60 {
            return "Next quiet check in \(Int(ceil(delta)))s"
        }
        let minutes = Int(ceil(delta / 60.0))
        if minutes < 60 {
            return "Next quiet check in \(minutes)m"
        }
        let hours = Int(minutes / 60)
        return "Next quiet check in \(hours)h"
    }
}
