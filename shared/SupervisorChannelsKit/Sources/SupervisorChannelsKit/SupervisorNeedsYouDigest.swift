import Foundation

/// What counts as "Needs You", shared by the Mac and iPhone clients.
///
/// The hub marks every card and question with `needsYou`. FYIs, completions
/// without a verified owner blocker, and cards held for missing context come
/// through with `needsYou: false`: they stay addressable (Context, archive),
/// but they are not waiting on the owner. A missing flag means an older hub
/// and counts as actionable, the same default the decoders use.
///
/// Every badge, title count, and list in Needs You should go through this so
/// the sidebar number always equals the rows the owner can act on.
public enum SupervisorAttentionCounting {
    public static func isActionable(needsYou: Bool?) -> Bool {
        needsYou != false
    }

    /// Actionable decisions plus pending tool approvals: the one number the
    /// sidebar badge, window subtitle, toolbar pill, and Dock badge show.
    public static func needsYouTotal(needsYouFlags: [Bool?], pendingApprovals: Int) -> Int {
        needsYouFlags.filter(isActionable).count + max(0, pendingApprovals)
    }
}

/// A small, restrained marker for a Needs You row. Plain decisions carry no
/// badge at all: everything in the list is a decision, so saying so again on
/// every row is noise. A badge appears only when it changes what the owner
/// should do first.
public struct SupervisorNeedsYouBadge: Equatable, Sendable {
    public enum Tone: String, Equatable, Sendable {
        /// Informational (PR ready, approval): secondary text color.
        case neutral
        /// Needs a careful read (merge, deploy, delete, force-push).
        case caution
        /// Something is failing.
        case alert
    }

    public let text: String
    public let tone: Tone

    public init(text: String, tone: Tone) {
        self.text = text
        self.tone = tone
    }

    public static func make(kind: String?, risky: Bool, ciState: String?) -> SupervisorNeedsYouBadge? {
        let lowerKind = kind?.lowercased() ?? ""
        let ci = ciState?.uppercased() ?? ""
        if lowerKind == "ci_failed" || ci == "FAILURE" || ci == "ERROR" {
            return SupervisorNeedsYouBadge(text: "Checks failing", tone: .alert)
        }
        if lowerKind == "session-error" || lowerKind == "session_error" {
            return SupervisorNeedsYouBadge(text: "Session error", tone: .alert)
        }
        if risky {
            return SupervisorNeedsYouBadge(text: "Risky", tone: .caution)
        }
        if lowerKind == "merge_ready" || lowerKind == "pr_ready" || lowerKind == "ready" {
            return SupervisorNeedsYouBadge(text: "PR ready", tone: .neutral)
        }
        if lowerKind == "preference" {
            return SupervisorNeedsYouBadge(text: "Preference", tone: .neutral)
        }
        return nil
    }
}

/// One Needs You item, reduced to what a compact row needs (title plus one
/// line of why) and the ordered sections its detail surface shows.
///
/// Both clients feed it whatever their payload has; it drops empty and
/// repeated text so the same sentence never shows twice (the old cards
/// repeated the headline as the fact, the brief, and the agent context).
public struct SupervisorNeedsYouDigest: Equatable, Sendable {
    public enum SectionKind: String, CaseIterable, Equatable, Sendable {
        case goal
        case state
        case blocker
        case decision
        case recommendation
        case evidence

        public var title: String {
            switch self {
            case .goal: return "Goal"
            case .state: return "Where it stands"
            case .blocker: return "Why it needs you"
            case .decision: return "Decision"
            case .recommendation: return "Recommended"
            case .evidence: return "Evidence"
            }
        }
    }

    public struct Section: Identifiable, Equatable, Sendable {
        public let kind: SectionKind
        public let text: String
        /// Position in the digest: evidence can repeat, ids must not.
        public let ordinal: Int
        public var id: String { "\(kind.rawValue)-\(ordinal)" }
        public var title: String { kind.title }

        public init(kind: SectionKind, text: String, ordinal: Int = 0) {
            self.kind = kind
            self.text = text
            self.ordinal = ordinal
        }
    }

    public let title: String
    /// One plain line of why, for the row. Nil when nothing says more than
    /// the title already does.
    public let reason: String?
    /// Goal, where it stands, why it needs you, the decision, the
    /// recommendation, then evidence. Empty and repeated parts are dropped.
    public let sections: [Section]

    public static let reasonLimit = 160

    public init(
        headline: String,
        goal: String? = nil,
        state: String? = nil,
        blocker: String? = nil,
        decision: String? = nil,
        recommendation: String? = nil,
        evidence: [String?] = []
    ) {
        let cleanTitle = Self.clean(headline) ?? "Needs your decision"
        var seen: [String] = [Self.normalized(cleanTitle)]
        var out: [Section] = []

        func add(_ kind: SectionKind, _ raw: String?) {
            guard let text = Self.clean(raw) else { return }
            let norm = Self.normalized(text)
            guard !norm.isEmpty, !seen.contains(where: { Self.repeats(norm, $0) }) else { return }
            seen.append(norm)
            out.append(Section(kind: kind, text: text, ordinal: out.count))
        }

        add(.goal, goal)
        add(.state, state)
        add(.blocker, blocker)
        add(.decision, decision)
        add(.recommendation, recommendation)
        for item in evidence { add(.evidence, item) }

        self.title = cleanTitle
        self.sections = out
        let why: [Section] = [.blocker, .decision, .state].compactMap { kind in out.first(where: { $0.kind == kind }) }
        self.reasonCandidates = why.map { Self.oneLine($0.text, limit: Self.reasonLimit) }.filter { !$0.isEmpty }
        self.reason = reasonCandidates.first
    }

    /// The row's why-line candidates, best first: why it needs you, the
    /// decision, where it stands.
    public let reasonCandidates: [String]

    /// One reason per row for a whole list. A reason that several rows share
    /// (a hub's generic "waiting for your answer") says nothing about any one
    /// of them, so such a row shows its own next candidate instead, when it
    /// has one that is not shared too.
    public static func rowReasons(for digests: [SupervisorNeedsYouDigest]) -> [String?] {
        guard digests.count > 2 else { return digests.map(\.reason) }
        var uses: [String: Int] = [:]
        for digest in digests {
            for candidate in Set(digest.reasonCandidates.map(normalized)) { uses[candidate, default: 0] += 1 }
        }
        return digests.map { digest in
            digest.reasonCandidates.first(where: { uses[normalized($0), default: 0] < 2 }) ?? digest.reason
        }
    }

    /// All sections of one kind, in order (evidence can have several).
    public func sections(_ kind: SectionKind) -> [Section] {
        sections.filter { $0.kind == kind }
    }

    // MARK: - Text helpers

    static func clean(_ raw: String?) -> String? {
        guard let raw else { return nil }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    /// Lowercased, whitespace-collapsed, without trailing punctuation: the
    /// form two texts are compared in.
    static func normalized(_ text: String) -> String {
        let collapsed = text
            .lowercased()
            .components(separatedBy: .whitespacesAndNewlines)
            .filter { !$0.isEmpty }
            .joined(separator: " ")
        return collapsed.trimmingCharacters(in: CharacterSet(charactersIn: " .!?:;…"))
    }

    /// True when `text` adds nothing to `earlier`: the same words, or a
    /// fragment wholly contained in it.
    static func repeats(_ text: String, _ earlier: String) -> Bool {
        if text == earlier { return true }
        return text.count >= 12 && earlier.contains(text)
    }

    /// The first line, cut at a word boundary to `limit` characters.
    public static func oneLine(_ text: String, limit: Int) -> String {
        let firstLine = text
            .split(whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .first(where: { !$0.isEmpty && !$0.allSatisfy { "#*-_>`".contains($0) } }) ?? ""
        let plain = firstLine
            .replacingOccurrences(of: "**", with: "")
            .replacingOccurrences(of: "__", with: "")
            .replacingOccurrences(of: "`", with: "")
            .trimmingCharacters(in: CharacterSet(charactersIn: "#>-* ").union(.whitespaces))
        guard plain.count > limit else { return plain }
        let cut = plain.prefix(limit)
        if let space = cut.lastIndex(of: " "), cut.distance(from: cut.startIndex, to: space) > limit / 2 {
            return String(cut[..<space]) + "…"
        }
        return String(cut) + "…"
    }
}
