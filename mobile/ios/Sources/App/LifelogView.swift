import SwiftUI

// What the owner's G2 glasses heard, as moments: `GET /lifelog/moments` for
// one day, optionally filtered by words, person, or topic. Newest first, one
// row per moment (title, time, device, summary); tapping a row opens its
// transcript in place. Read-only: the phone never edits the lifelog.
struct LifelogView: View {
    @Environment(AppModel.self) private var model

    @State private var day = Date()
    @State private var query = ""
    @State private var moments: [LifelogMoment] = []
    @State private var loadError: DaemonError?
    @State private var hasLoaded = false
    @State private var isLoading = false
    @State private var expanded: Set<String> = []

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.x4) {
                DatePicker("Day", selection: $day, in: ...Date(), displayedComponents: .date)
                    .font(Theme.Typography.body)
                    .foregroundStyle(Theme.ink)
                content
            }
            .padding(Theme.gutter)
        }
        .background(Theme.canvas)
        .navigationTitle("Lifelog")
        .navigationBarTitleDisplayMode(.inline)
        .searchable(text: $query, prompt: "Search words, people, topics")
        .refreshable { await load() }
        // Typing in search debounces here: a new key cancels the pending
        // load before it is sent.
        .task(id: LifelogFormat.dayString(day) + "\u{0}" + query) {
            if hasLoaded { try? await Task.sleep(for: .milliseconds(350)) }
            guard !Task.isCancelled else { return }
            await load()
        }
    }

    @ViewBuilder
    private var content: some View {
        if let loadError, moments.isEmpty {
            let copy = LifelogFormat.errorCopy(loadError)
            EmptyStateView(headline: copy.headline, detail: copy.detail)
        } else if !hasLoaded {
            EmptyStateView(headline: "Loading…", detail: "Reading the lifelog on your main.")
        } else if moments.isEmpty {
            EmptyStateView(
                headline: query.isEmpty ? "Nothing recorded this day." : "No moments match.",
                detail: query.isEmpty ? "Conversations your G2 glasses capture appear here." : "Try other words or another day."
            )
        } else {
            if let loadError {
                Text(LifelogFormat.errorCopy(loadError).headline)
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.alert)
            }
            RowGroup {
                ForEach(Array(moments.enumerated()), id: \.element.id) { index, moment in
                    MomentRow(moment: moment, isExpanded: expanded.contains(moment.id)) {
                        if expanded.contains(moment.id) { expanded.remove(moment.id) } else { expanded.insert(moment.id) }
                    }
                    if index < moments.count - 1 { RowHairline() }
                }
            }
        }
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        let dayString = LifelogFormat.dayString(day)
        let search = query
        do {
            let fresh = try await model.client.lifelogMoments(date: dayString, query: search)
            // A slower answer for an older day or query must not replace a newer one.
            guard dayString == LifelogFormat.dayString(day), search == query else { return }
            moments = fresh
            loadError = nil
        } catch let error as DaemonError {
            guard dayString == LifelogFormat.dayString(day), search == query else { return }
            // A different day failed: don't keep showing the previous day's list.
            moments = []
            loadError = error
        } catch {
            loadError = .transport(error)
        }
        hasLoaded = true
    }
}

private struct MomentRow: View {
    let moment: LifelogMoment
    let isExpanded: Bool
    let toggle: () -> Void

    var body: some View {
        Button(action: toggle) {
            VStack(alignment: .leading, spacing: Theme.Spacing.x1) {
                HStack(alignment: .firstTextBaseline) {
                    Text(LifelogFormat.title(moment))
                        .font(Theme.Typography.body)
                        .foregroundStyle(Theme.ink)
                        .lineLimit(isExpanded ? nil : 2)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(Theme.muted)
                }
                let meta = LifelogFormat.meta(moment)
                if !meta.isEmpty {
                    Text(meta)
                        .font(Theme.Typography.caption)
                        .foregroundStyle(Theme.muted)
                }
                if let summary = moment.summary, !summary.isEmpty {
                    Text(summary)
                        .font(Theme.Typography.secondary)
                        .foregroundStyle(Theme.muted)
                        .lineLimit(isExpanded ? nil : 3)
                }
                if isExpanded {
                    transcript
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, Theme.Spacing.x4)
            .padding(.vertical, Theme.Spacing.x3)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityHint(isExpanded ? "Hide transcript" : "Show transcript")
    }

    @ViewBuilder
    private var transcript: some View {
        if let text = moment.transcript, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            // Untrusted evidence of what was said, shown as heard: plain text,
            // never Markdown, selectable for copying.
            Text(text)
                .font(Theme.Typography.secondary)
                .foregroundStyle(Theme.ink)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(Theme.Spacing.x3)
                .background(Theme.canvas)
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                .padding(.top, Theme.Spacing.x2)
        } else {
            Text("No transcript for this moment.")
                .font(Theme.Typography.caption)
                .foregroundStyle(Theme.muted)
                .padding(.top, Theme.Spacing.x2)
        }
    }
}

// Pure wording and formatting for the Lifelog screen, pinned by tests.
enum LifelogFormat {
    // The route's `date`: the local calendar day, "2026-09-28".
    static func dayString(_ date: Date, calendar: Calendar = .current) -> String {
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
    }

    static func title(_ moment: LifelogMoment) -> String {
        if let title = moment.title?.trimmingCharacters(in: .whitespacesAndNewlines), !title.isEmpty { return title }
        return "Conversation"
    }

    // "3:40 PM – 3:52 PM · Spencer's G2"
    static func meta(_ moment: LifelogMoment, calendar: Calendar = .current) -> String {
        var parts: [String] = []
        if let at = moment.at {
            var range = time(at, calendar: calendar)
            if let end = moment.endAt, end > at { range += " – " + time(end, calendar: calendar) }
            parts.append(range)
        }
        if let device = moment.deviceName?.trimmingCharacters(in: .whitespacesAndNewlines), !device.isEmpty {
            parts.append(device)
        }
        return parts.joined(separator: " · ")
    }

    static func time(_ date: Date, calendar: Calendar = .current) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = calendar.timeZone
        formatter.dateFormat = "h:mm a"
        return formatter.string(from: date)
    }

    static func errorCopy(_ error: DaemonError) -> (headline: String, detail: String) {
        switch error {
        case .notFound:
            return ("Update OpenAGI on your main.", "This main doesn't share the lifelog with phones yet.")
        case .unauthorized:
            return ("Lifelog isn't open to this phone.", "Update OpenAGI on your main. If the other tabs fail too, re-pair in Settings.")
        default:
            return ("Can't reach OpenAGI.", "Check your connection and pull to refresh.")
        }
    }
}
