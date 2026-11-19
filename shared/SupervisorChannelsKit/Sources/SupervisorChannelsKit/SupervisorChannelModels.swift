import Foundation

public enum SupervisorChannelKind: Equatable, Hashable, Sendable {
    case general
    case needsYou
    case tasks
    case sessions
    case activity
    case project(String)
    case subchannel(project: String, subchannel: String)
}

public struct SupervisorChannelSummary: Identifiable, Equatable, Hashable, Sendable {
    public let id: String
    public let kind: SupervisorChannelKind
    public let displayName: String
    public let waitingCount: Int
    public let runningCount: Int
    public let totalCount: Int

    public init(
        id: String,
        kind: SupervisorChannelKind,
        displayName: String,
        waitingCount: Int = 0,
        runningCount: Int = 0,
        totalCount: Int = 0
    ) {
        self.id = id
        self.kind = kind
        self.displayName = displayName
        self.waitingCount = waitingCount
        self.runningCount = runningCount
        self.totalCount = totalCount
    }
}

public struct SupervisorDecisionItem: Identifiable, Equatable, Sendable {
    public let id: String
    public let project: String
    public let subchannel: String?
    public let headline: String
    public let kindLabel: String
    public let risky: Bool
    public let noticedAtISO: String?

    public init(
        id: String,
        project: String,
        subchannel: String? = nil,
        headline: String,
        kindLabel: String = "Needs you",
        risky: Bool = false,
        noticedAtISO: String? = nil
    ) {
        self.id = id
        self.project = project
        self.subchannel = subchannel
        self.headline = headline
        self.kindLabel = kindLabel
        self.risky = risky
        self.noticedAtISO = noticedAtISO
    }
}

public struct SupervisorChannelGroup: Identifiable, Equatable, Sendable {
    public let id: String
    public let project: String
    public let items: [SupervisorDecisionItem]

    public init(project: String, items: [SupervisorDecisionItem]) {
        self.id = project.lowercased()
        self.project = project
        self.items = items
    }
}

public struct SupervisorSessionBrief: Identifiable, Equatable, Sendable {
    public let id: String
    public let project: String
    public let subchannel: String?
    public let theme: String
    public let title: String
    public let host: String?
    public let cwd: String?
    public let state: String
    public let lastActivityISO: String?

    public init(
        id: String,
        project: String,
        subchannel: String? = nil,
        theme: String = "General",
        title: String,
        host: String? = nil,
        cwd: String? = nil,
        state: String = "idle",
        lastActivityISO: String? = nil
    ) {
        self.id = id
        self.project = project
        self.subchannel = subchannel
        self.theme = theme
        self.title = title
        self.host = host
        self.cwd = cwd
        self.state = state
        self.lastActivityISO = lastActivityISO
    }
}

public struct SupervisorSubchannelSummary: Identifiable, Equatable, Hashable, Sendable {
    public let id: String
    public let project: String
    public let subchannel: String
    public let displayName: String
    public let waitingCount: Int
    public let runningCount: Int
    public let totalCount: Int

    public init(
        id: String,
        project: String,
        subchannel: String,
        displayName: String,
        waitingCount: Int = 0,
        runningCount: Int = 0,
        totalCount: Int = 0
    ) {
        self.id = id
        self.project = project
        self.subchannel = subchannel
        self.displayName = displayName
        self.waitingCount = waitingCount
        self.runningCount = runningCount
        self.totalCount = totalCount
    }
}

public struct SupervisorOverlapNotice: Identifiable, Equatable, Sendable {
    public let id: String
    public let project: String
    public let targetPath: String
    public let detail: String

    public init(id: String, project: String, targetPath: String, detail: String) {
        self.id = id
        self.project = project
        self.targetPath = targetPath
        self.detail = detail
    }
}

public enum SupervisorChannelGrouping {
    private static func looksLikeProjectSlug(_ raw: String) -> Bool {
        !raw.isEmpty && raw.count <= 36 && !raw.contains(": ") && !raw.contains(" ") && !raw.contains("(") && !raw.contains(")")
    }

    public static func normalizeProject(
        explicit: String? = nil,
        repo: String? = nil,
        workspace: String? = nil,
        cwd: String? = nil
    ) -> String {
        if let raw = explicit?.trimmingCharacters(in: .whitespacesAndNewlines),
           looksLikeProjectSlug(raw),
           raw.caseInsensitiveCompare("General") != .orderedSame {
            return raw
        }
        if let repoRaw = repo?.trimmingCharacters(in: .whitespacesAndNewlines), !repoRaw.isEmpty {
            let parts = repoRaw.split(separator: "/").map(String.init).filter { !$0.isEmpty }
            if let last = parts.last, looksLikeProjectSlug(last) {
                return last
            }
        }
        for dirCandidate in [cwd, workspace].compactMap({ $0?.trimmingCharacters(in: .whitespacesAndNewlines) }).filter({ !$0.isEmpty }) {
            let cleaned = dirCandidate.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            let isPath = cleaned.contains("/")
            let base = isPath ? (cleaned.split(separator: "/").last.map(String.init) ?? "") : cleaned
            if !base.isEmpty,
               base.caseInsensitiveCompare("workspace") != .orderedSame,
               isPath || looksLikeProjectSlug(base) {
                return base
            }
        }
        return "general"
    }

    public static func groupByProject(_ items: [SupervisorDecisionItem]) -> [SupervisorChannelGroup] {
        var order: [String] = []
        var canonicalName: [String: String] = [:]
        var buckets: [String: [SupervisorDecisionItem]] = [:]

        for item in items {
            let project = normalizeProject(explicit: item.project)
            let key = project.lowercased()
            if buckets[key] == nil {
                order.append(key)
                canonicalName[key] = project
                buckets[key] = []
            }
            buckets[key, default: []].append(item)
        }

        let sortedKeys = order.sorted { lhs, rhs in
            if lhs == "general" && rhs != "general" { return false }
            if rhs == "general" && lhs != "general" { return true }
            let lc = buckets[lhs]?.count ?? 0
            let rc = buckets[rhs]?.count ?? 0
            if lc != rc { return lc > rc }
            return (canonicalName[lhs] ?? lhs).localizedCaseInsensitiveCompare(canonicalName[rhs] ?? rhs) == .orderedAscending
        }

        return sortedKeys.map { key in
            SupervisorChannelGroup(
                project: canonicalName[key] ?? key,
                items: buckets[key] ?? []
            )
        }
    }

    public static func projectChannels(
        from items: [SupervisorDecisionItem],
        sessions: [SupervisorSessionBrief] = []
    ) -> [SupervisorChannelSummary] {
        var displayNames: [String: String] = [:]
        var waiting: [String: Int] = [:]
        var running: [String: Int] = [:]
        var total: [String: Int] = [:]

        for item in items {
            let proj = normalizeProject(explicit: item.project)
            let key = proj.lowercased()
            displayNames[key] = displayNames[key] ?? proj
            waiting[key, default: 0] += 1
        }
        for s in sessions {
            let proj = normalizeProject(explicit: s.project, cwd: s.cwd)
            let key = proj.lowercased()
            displayNames[key] = displayNames[key] ?? proj
            total[key, default: 0] += 1
            if s.state.lowercased() == "running" {
                running[key, default: 0] += 1
            }
        }

        return displayNames.keys.filter { $0 != "general" }.sorted { lhs, rhs in
            let lw = waiting[lhs, default: 0], rw = waiting[rhs, default: 0]
            if lw != rw { return lw > rw }
            let lr = running[lhs, default: 0], rr = running[rhs, default: 0]
            if lr != rr { return lr > rr }
            return (displayNames[lhs] ?? lhs).localizedCaseInsensitiveCompare(displayNames[rhs] ?? rhs) == .orderedAscending
        }.map { key in
            SupervisorChannelSummary(
                id: "project:\(key)",
                kind: .project(displayNames[key] ?? key),
                displayName: "# \(displayNames[key] ?? key)",
                waitingCount: waiting[key, default: 0],
                runningCount: running[key, default: 0],
                totalCount: total[key, default: 0]
            )
        }
    }

    public static func subchannels(
        forProject project: String,
        from items: [SupervisorDecisionItem],
        sessions: [SupervisorSessionBrief]
    ) -> [SupervisorSubchannelSummary] {
        let projKey = normalizeProject(explicit: project).lowercased()
        var waiting: [String: Int] = [:]
        var running: [String: Int] = [:]
        var total: [String: Int] = [:]
        var displaySlug: [String: String] = [:]

        func leaf(of raw: String?) -> String? {
            guard let raw = raw?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty else { return nil }
            let clean = raw.hasPrefix("#") ? String(raw.dropFirst()) : raw
            let parts = clean.split(separator: "/").map(String.init)
            let candidate = parts.count > 1 ? parts.dropFirst().joined(separator: "/") : clean
            guard !candidate.isEmpty, candidate.lowercased() != projKey, candidate.lowercased() != "general" else { return nil }
            return candidate
        }

        for item in items {
            guard normalizeProject(explicit: item.project).lowercased() == projKey,
                  let sub = leaf(of: item.subchannel) else { continue }
            let key = "\(projKey)/\(sub.lowercased())"
            displaySlug[key] = displaySlug[key] ?? sub
            waiting[key, default: 0] += 1
        }
        for session in sessions {
            guard normalizeProject(explicit: session.project, cwd: session.cwd).lowercased() == projKey,
                  let sub = leaf(of: session.subchannel) else { continue }
            let key = "\(projKey)/\(sub.lowercased())"
            displaySlug[key] = displaySlug[key] ?? sub
            total[key, default: 0] += 1
            if session.state.lowercased() == "running" {
                running[key, default: 0] += 1
            }
        }

        return displaySlug.keys.sorted { lhs, rhs in
            let lw = waiting[lhs, default: 0], rw = waiting[rhs, default: 0]
            if lw != rw { return lw > rw }
            let lr = running[lhs, default: 0], rr = running[rhs, default: 0]
            if lr != rr { return lr > rr }
            return (displaySlug[lhs] ?? lhs).localizedCaseInsensitiveCompare(displaySlug[rhs] ?? rhs) == .orderedAscending
        }.map { key in
            let sub = displaySlug[key] ?? key
            return SupervisorSubchannelSummary(
                id: "subchannel:\(key)",
                project: project,
                subchannel: key,
                displayName: "/\(sub)",
                waitingCount: waiting[key, default: 0],
                runningCount: running[key, default: 0],
                totalCount: total[key, default: 0]
            )
        }
    }

    public static func filterSessions(
        _ sessions: [SupervisorSessionBrief],
        project: String?,
        subchannel: String? = nil,
        theme: String? = nil
    ) -> [SupervisorSessionBrief] {
        sessions.filter { s in
            if let project, !project.isEmpty {
                let targetKey = normalizeProject(explicit: project).lowercased()
                let sKey = normalizeProject(explicit: s.project, cwd: s.cwd).lowercased()
                if sKey != targetKey { return false }
            }
            if let subchannel, !subchannel.isEmpty {
                let targetSub = subchannel.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
                let sSub = (s.subchannel ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
                if sSub != targetSub && !sSub.hasSuffix("/\(targetSub)") { return false }
            }
            if let theme, !theme.isEmpty {
                if s.theme.caseInsensitiveCompare(theme) != .orderedSame { return false }
            }
            return true
        }
    }

    /// Calm overlap detection: emits only when >= 2 actively RUNNING sessions target
    /// the exact same working directory on the same host. Idle and multi-host work never warn.
    public static func calmOverlaps(for sessions: [SupervisorSessionBrief]) -> [SupervisorOverlapNotice] {
        struct BucketKey: Hashable {
            let projectKey: String
            let host: String
            let cwd: String
        }
        var counts: [BucketKey: [SupervisorSessionBrief]] = [:]
        for s in sessions where s.state.lowercased() == "running" {
            guard let rawCwd = s.cwd?.trimmingCharacters(in: .whitespacesAndNewlines), !rawCwd.isEmpty else {
                continue
            }
            let normalizedCwd = rawCwd.count > 1 && rawCwd.hasSuffix("/") ? String(rawCwd.dropLast()) : rawCwd
            let hostKey = (s.host?.trimmingCharacters(in: .whitespacesAndNewlines)).flatMap { $0.isEmpty ? nil : $0 } ?? "local"
            let projKey = normalizeProject(explicit: s.project, cwd: normalizedCwd)
            let bucket = BucketKey(projectKey: projKey, host: hostKey, cwd: normalizedCwd)
            counts[bucket, default: []].append(s)
        }

        return counts.compactMap { bucket, list in
            guard list.count >= 2 else { return nil }
            let folder = bucket.cwd.split(separator: "/").last.map(String.init) ?? bucket.cwd
            return SupervisorOverlapNotice(
                id: "\(bucket.projectKey):\(bucket.host):\(bucket.cwd)",
                project: bucket.projectKey,
                targetPath: bucket.cwd,
                detail: "\(list.count) running chats are editing \(folder) simultaneously"
            )
        }
        .sorted { $0.id < $1.id }
    }

    /// Overlay surface filter for pending actions: stale (>2h) `chat` ("yes NN")
    /// confirmations and zombie (>24h) queue requests are hidden so the Mac pill
    /// and Dock badge do not accumulate dead noise from months-old sessions.
    public static func shouldShowInOverlay(
        mode: String?,
        raisedAtISO: String?,
        createdAtISO: String?,
        now: Date = Date(),
        maxChatAgeSeconds: TimeInterval = 7200,
        maxQueueAgeSeconds: TimeInterval = 86_400
    ) -> Bool {
        let iso = (raisedAtISO?.isEmpty == false ? raisedAtISO : nil)
            ?? (createdAtISO?.isEmpty == false ? createdAtISO : nil)
        if mode == "chat" {
            guard let iso, let date = parseFlexibleISO8601(iso) else { return false }
            return now.timeIntervalSince(date) < maxChatAgeSeconds
        }
        guard let iso, let date = parseFlexibleISO8601(iso) else { return true }
        return now.timeIntervalSince(date) < maxQueueAgeSeconds
    }

    private static func parseFlexibleISO8601(_ string: String) -> Date? {
        let withFractional = ISO8601DateFormatter()
        withFractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = withFractional.date(from: string) { return d }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        return plain.date(from: string)
    }
}
