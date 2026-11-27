import SwiftUI

// Needs You asks that carry several independent questions (card.questionItems,
// src/fleet/decision-items.js). Each question is shown on its own: compactly
// on the deck card, in full on the decision screen and the Thread sheet, and
// one at a time in the walkthrough sheet ("Review N questions"). Answers are
// drafts on this phone until the owner sends them, and only the questions
// the owner answered or skipped are sent (`answer_items`). A recommendation
// is text: nothing is preselected, approved in bulk, or sent for the owner.
// Cards with a single question keep the decision contract (#391) unchanged.

// MARK: - Drafts

/// What the owner has picked or typed for one question, not yet sent.
struct QuestionItemDraft: Codable, Equatable, Sendable {
    var answer: String?
    var skip: Bool = false

    /// The answer as it would be sent: trimmed, nil when blank.
    var sendableAnswer: String? {
        guard let text = answer?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else { return nil }
        return text
    }

    var isEmpty: Bool { sendableAnswer == nil && !skip }
}

/// Drafts kept on this phone per question id and item id, so closing the
/// walkthrough and opening it again resumes where the owner left off.
struct QuestionItemsDraftStore {
    let defaults: UserDefaults

    init(defaults: UserDefaults) {
        self.defaults = defaults
    }

    /// The app's store. UI tests get their own domain, emptied once per
    /// launch, so a previous run's drafts never leak into the next.
    @MainActor static let shared: QuestionItemsDraftStore = {
        guard ProcessInfo.processInfo.arguments.contains("--ui-testing") else {
            return QuestionItemsDraftStore(defaults: .standard)
        }
        let suite = "openagi.uitest.question-items"
        UserDefaults().removePersistentDomain(forName: suite)
        return QuestionItemsDraftStore(defaults: UserDefaults(suiteName: suite) ?? .standard)
    }()

    static func key(questionID: String, itemID: String) -> String {
        "openagi.questionItems.\(questionID).item.\(itemID)"
    }

    static func pageKey(questionID: String) -> String {
        "openagi.questionItems.\(questionID).page"
    }

    func draft(questionID: String, itemID: String) -> QuestionItemDraft? {
        guard let data = defaults.data(forKey: Self.key(questionID: questionID, itemID: itemID)),
              let draft = try? JSONDecoder().decode(QuestionItemDraft.self, from: data),
              !draft.isEmpty else { return nil }
        return draft
    }

    func drafts(questionID: String, items: [SupervisorQuestionItem]) -> [String: QuestionItemDraft] {
        var out: [String: QuestionItemDraft] = [:]
        for item in items {
            if let draft = draft(questionID: questionID, itemID: item.itemId) { out[item.itemId] = draft }
        }
        return out
    }

    func save(_ draft: QuestionItemDraft?, questionID: String, itemID: String) {
        let key = Self.key(questionID: questionID, itemID: itemID)
        if let draft, !draft.isEmpty, let data = try? JSONEncoder().encode(draft) {
            defaults.set(data, forKey: key)
        } else {
            defaults.removeObject(forKey: key)
        }
    }

    func page(questionID: String) -> Int? {
        defaults.object(forKey: Self.pageKey(questionID: questionID)) as? Int
    }

    func savePage(_ page: Int, questionID: String) {
        defaults.set(page, forKey: Self.pageKey(questionID: questionID))
    }

    func clearAll(questionID: String, items: [SupervisorQuestionItem]) {
        for item in items { save(nil, questionID: questionID, itemID: item.itemId) }
        defaults.removeObject(forKey: Self.pageKey(questionID: questionID))
    }
}

// MARK: - Payload

/// What one `answer_items` request carries: each answered question with its
/// own answer, and the ids the owner chose to skip. Questions already sent
/// (queued or delivered) and questions without a draft are left out; there
/// is no group reply and no recommendation applied on the owner's behalf.
struct QuestionItemsPayload: Equatable {
    var answers: [SupervisorQuestionItemAnswer]
    var skip: [String]

    var isEmpty: Bool { answers.isEmpty && skip.isEmpty }

    static func build(items: [SupervisorQuestionItem], drafts: [String: QuestionItemDraft]) -> QuestionItemsPayload {
        var answers: [SupervisorQuestionItemAnswer] = []
        var skip: [String] = []
        for item in items where !item.state.isSent {
            guard let draft = drafts[item.itemId] else { continue }
            if let answer = draft.sendableAnswer {
                answers.append(SupervisorQuestionItemAnswer(itemId: item.itemId, answer: answer))
            } else if draft.skip && item.state.status != "skipped" {
                skip.append(item.itemId)
            }
        }
        return QuestionItemsPayload(answers: answers, skip: skip)
    }

    /// "Send 2 answers", "Send 2 answers, skip 1", "Skip 1 question".
    var sendLabel: String {
        func plural(_ n: Int, _ word: String) -> String { "\(n) \(word)\(n == 1 ? "" : "s")" }
        switch (answers.count, skip.count) {
        case (0, 0): return "Send answers"
        case (let n, 0): return "Send \(plural(n, "answer"))"
        case (0, let k): return "Skip \(plural(k, "question"))"
        case (let n, let k): return "Send \(plural(n, "answer")), skip \(k)"
        }
    }
}

// MARK: - State labels

/// How a question's state reads everywhere: what was sent and confirmed,
/// what is waiting, what failed (answer kept, retry offered), what was
/// skipped, and what is only a draft on this phone.
struct QuestionItemStatusStyle: Equatable {
    let text: String
    let symbol: String
    let tone: Tone
    let spoken: String

    enum Tone: Equatable { case muted, live, done, alert }

    var color: Color {
        switch tone {
        case .muted: return Theme.muted
        case .live: return Theme.live
        case .done: return .green
        case .alert: return Theme.alert
        }
    }

    static func of(_ item: SupervisorQuestionItem, draft: QuestionItemDraft? = nil) -> QuestionItemStatusStyle {
        switch item.state.status {
        case "delivered":
            return .init(text: "Delivered", symbol: "checkmark.circle.fill", tone: .done, spoken: "Delivered")
        case "queued":
            return .init(text: "Queued", symbol: "clock", tone: .live, spoken: "Sent, waiting to be delivered")
        case "failed":
            if draft?.sendableAnswer != nil && draft?.sendableAnswer != item.state.answer {
                return .init(text: "Draft", symbol: "pencil", tone: .live, spoken: "Changed answer, not sent")
            }
            return .init(text: "Failed", symbol: "exclamationmark.triangle.fill", tone: .alert, spoken: "Failed to send, answer kept")
        default:
            if draft?.sendableAnswer != nil {
                return .init(text: "Draft", symbol: "pencil", tone: .live, spoken: "Draft, not sent")
            }
            if draft?.skip == true && item.state.status != "skipped" {
                return .init(text: "Will skip", symbol: "forward", tone: .muted, spoken: "Will be skipped, not sent")
            }
            if item.state.status == "skipped" {
                return .init(text: "Skipped", symbol: "forward", tone: .muted, spoken: "Skipped, still open")
            }
            return .init(text: "Not answered", symbol: "circle", tone: .muted, spoken: "Not answered")
        }
    }
}

struct QuestionItemStatusBadge: View {
    let style: QuestionItemStatusStyle

    var body: some View {
        Label(style.text, systemImage: style.symbol)
            .font(.caption2.weight(.semibold))
            .foregroundStyle(style.color)
            .lineLimit(1)
            .fixedSize()
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(style.spoken)
    }
}

enum QuestionItemsText {
    /// "3 · Canvas pages", or "Main decision" for index 0.
    static func title(_ item: SupervisorQuestionItem) -> String {
        item.index == 0 ? item.displayLabel : "\(item.index) · \(item.displayLabel)"
    }

    /// "10 questions · 1 delivered · 1 skipped · 1 failed".
    static func summary(_ counts: SupervisorQuestionItemsSummary) -> String {
        var parts = ["\(counts.total) question\(counts.total == 1 ? "" : "s")"]
        if counts.delivered > 0 { parts.append("\(counts.delivered) delivered") }
        if counts.queued > 0 { parts.append("\(counts.queued) queued") }
        if counts.failed > 0 { parts.append("\(counts.failed) failed") }
        if counts.skipped > 0 { parts.append("\(counts.skipped) skipped") }
        if counts.unanswered > 0 { parts.append("\(counts.unanswered) not answered") }
        return parts.joined(separator: " · ")
    }

    /// "Review 9 questions": the open ones, else all of them.
    static func reviewLabel(_ counts: SupervisorQuestionItemsSummary) -> String {
        let n = counts.open > 0 ? counts.open : counts.total
        return "Review \(n) question\(n == 1 ? "" : "s")"
    }

    /// A choice the recommendation names exactly (case and a final period
    /// aside). Anything looser stays text only.
    static func isRecommended(_ choice: String, by recommendation: String?) -> Bool {
        func key(_ text: String) -> String {
            var t = DecisionContract.normalized(text)
            while t.hasSuffix(".") { t.removeLast() }
            return t
        }
        guard let recommendation, !key(recommendation).isEmpty else { return false }
        return key(choice) == key(recommendation)
    }
}

// MARK: - Result relay

/// Hands an `answer_items` result (with the hub's fresh state) back to the
/// Supervisor so every surface shows the new item states at once.
struct QuestionItemsResultHandler: @unchecked Sendable {
    let handle: @MainActor (FleetCardActResult) -> Void
}

private struct QuestionItemsResultHandlerKey: EnvironmentKey {
    static let defaultValue = QuestionItemsResultHandler(handle: { _ in })
}

extension EnvironmentValues {
    var questionItemsResultHandler: QuestionItemsResultHandler {
        get { self[QuestionItemsResultHandlerKey.self] }
        set { self[QuestionItemsResultHandlerKey.self] = newValue }
    }
}

/// Which card's walkthrough is open, and at which question.
struct QuestionWalkthroughStart: Identifiable {
    let card: SupervisorCard
    var itemID: String? = nil

    var id: String { card.id + "#" + (itemID ?? "") }
}

// MARK: - Walkthrough model

@MainActor
@Observable
final class QuestionWalkthroughModel {
    typealias Sender = @MainActor (_ answers: [SupervisorQuestionItemAnswer], _ skip: [String]) async throws -> FleetCardActResult

    let cardID: String
    let questionID: String
    private(set) var items: [SupervisorQuestionItem]
    private(set) var drafts: [String: QuestionItemDraft]
    private(set) var sending = false
    private(set) var note: SupervisorFormat.Note?
    private(set) var pageIndex: Int

    private let store: QuestionItemsDraftStore

    init(card: SupervisorCard, startItemID: String? = nil, store: QuestionItemsDraftStore) {
        let questionKey = card.questionId ?? card.id
        let list = card.questionItems
        let saved = store.drafts(questionID: questionKey, items: list)
        self.cardID = card.id
        self.questionID = questionKey
        self.items = list
        self.store = store
        self.drafts = saved
        if let startItemID, let index = list.firstIndex(where: { $0.itemId == startItemID }) {
            self.pageIndex = index
        } else if let page = store.page(questionID: questionKey), list.indices.contains(page) {
            self.pageIndex = page
        } else {
            // Resume at the first question still waiting for the owner.
            self.pageIndex = list.firstIndex { $0.state.isOpen && saved[$0.itemId] == nil }
                ?? list.firstIndex { $0.state.isOpen }
                ?? 0
        }
    }

    var current: SupervisorQuestionItem? {
        items.indices.contains(pageIndex) ? items[pageIndex] : nil
    }

    var payload: QuestionItemsPayload { QuestionItemsPayload.build(items: items, drafts: drafts) }

    var counts: SupervisorQuestionItemsSummary { SupervisorQuestionItemsSummary(items: items) }

    func draft(for itemID: String) -> QuestionItemDraft? { drafts[itemID] }

    /// Picks a choice as the draft answer; picking it again clears it.
    func select(_ choice: String, for itemID: String) {
        guard isEditable(itemID) else { return }
        if drafts[itemID]?.answer == choice {
            setDraft(nil, for: itemID)
        } else {
            setDraft(QuestionItemDraft(answer: choice, skip: false), for: itemID)
        }
    }

    func setText(_ text: String, for itemID: String) {
        guard isEditable(itemID) else { return }
        setDraft(text.isEmpty ? nil : QuestionItemDraft(answer: text, skip: false), for: itemID)
    }

    /// Marks the current question to be skipped (it stays open) and moves on.
    func skipCurrent() {
        guard let item = current, isEditable(item.itemId) else { return }
        setDraft(QuestionItemDraft(answer: nil, skip: true), for: item.itemId)
        next()
    }

    func clearDraft(for itemID: String) {
        setDraft(nil, for: itemID)
    }

    func next() {
        go(to: pageIndex + 1)
    }

    func back() {
        go(to: pageIndex - 1)
    }

    /// Moves to a page and remembers it, so reopening resumes there.
    func go(to index: Int) {
        guard items.indices.contains(index) else { return }
        pageIndex = index
        store.savePage(index, questionID: questionID)
    }

    var canGoBack: Bool { pageIndex > 0 }
    var canGoNext: Bool { pageIndex < items.count - 1 }

    private func isEditable(_ itemID: String) -> Bool {
        guard let item = items.first(where: { $0.itemId == itemID }) else { return false }
        return !item.state.isSent && !sending
    }

    private func setDraft(_ draft: QuestionItemDraft?, for itemID: String) {
        let kept = (draft?.isEmpty ?? true) ? nil : draft
        drafts[itemID] = kept
        store.save(kept, questionID: questionID, itemID: itemID)
    }

    /// Sends every drafted answer and skip in one request.
    @discardableResult
    func send(using sender: Sender) async -> FleetCardActResult? {
        await deliver(payload, using: sender)
    }

    /// Sends one failed question again with its kept (or changed) answer.
    @discardableResult
    func retry(_ itemID: String, using sender: Sender) async -> FleetCardActResult? {
        guard let item = items.first(where: { $0.itemId == itemID }), item.state.status == "failed",
              let answer = drafts[itemID]?.sendableAnswer ?? item.state.answer?.trimmingCharacters(in: .whitespacesAndNewlines),
              !answer.isEmpty else { return nil }
        return await deliver(QuestionItemsPayload(answers: [SupervisorQuestionItemAnswer(itemId: itemID, answer: answer)], skip: []),
                             using: sender)
    }

    private func deliver(_ payload: QuestionItemsPayload, using sender: Sender) async -> FleetCardActResult? {
        guard !payload.isEmpty, !sending else { return nil }
        sending = true
        note = nil
        defer { sending = false }
        do {
            let result = try await sender(payload.answers, payload.skip)
            apply(result, sent: payload)
            return result
        } catch let error as DaemonError {
            let failure = SupervisorFormat.failureNote(error)
            note = .init(text: failure.text + " Your answers are kept on this phone.", isAlert: failure.isAlert)
        } catch {
            note = .init(text: "Can't reach OpenAGI. Your answers are kept on this phone.", isAlert: true)
        }
        return nil
    }

    /// Takes the hub's item states. Drafts of questions that were sent or
    /// skipped are cleared; a failed question keeps its answer for Retry.
    func apply(_ result: FleetCardActResult, sent: QuestionItemsPayload) {
        if !result.items.isEmpty {
            let byID = Dictionary(result.items.map { ($0.itemId, $0) }, uniquingKeysWith: { first, _ in first })
            items = items.map { byID[$0.itemId] ?? $0 }
        }
        let touched = Set(sent.answers.map(\.itemId) + sent.skip)
        for item in items where touched.contains(item.itemId) {
            switch item.state.status {
            case "delivered", "queued":
                setDraft(nil, for: item.itemId)
            case "skipped":
                if drafts[item.itemId]?.sendableAnswer == nil { setDraft(nil, for: item.itemId) }
            default:
                break
            }
        }
        if items.allSatisfy(\.state.isSent) {
            store.clearAll(questionID: questionID, items: items)
        }
        let fallback: String
        switch result.status {
        case "delivered": fallback = "Delivered to the agent."
        case "queued": fallback = "Sent. It reaches the agent once the Mac can type."
        case "skipped": fallback = "Skipped questions stay open."
        default: fallback = result.ok ? "Sent." : "Could not deliver the answers; they are kept to retry."
        }
        note = .init(text: result.message ?? fallback, isAlert: !result.ok)
    }
}

// MARK: - Card (compact)

/// The questions on the deck card: one line each with its state.
struct QuestionItemsCompactList: View {
    let card: SupervisorCard
    var drafts: [String: QuestionItemDraft] = [:]

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(QuestionItemsText.summary(card.questionItemsCounts).uppercased())
                .font(.caption2.weight(.bold))
                .foregroundStyle(Theme.muted)
                .accessibilityIdentifier("question-items-summary")
            ForEach(card.questionItems) { item in
                let style = QuestionItemStatusStyle.of(item, draft: drafts[item.itemId])
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text("\(Text(QuestionItemsText.title(item)).fontWeight(.semibold)): \(DecisionContract.clean(item.question) ?? item.question)")
                        .font(.caption)
                        .foregroundStyle(item.state.isSent ? Theme.muted : Theme.ink)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    QuestionItemStatusBadge(style: style)
                }
                .accessibilityElement(children: .combine)
                .accessibilityValue(style.text)
                .accessibilityIdentifier("question-item-row-\(item.index)")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("question-items-compact")
    }
}

// MARK: - Detail / Thread (full)

/// Every question in full: its choices or free text, the agent's
/// recommendation (text only), what it unblocks, and its state. Each row
/// opens the walkthrough at that question; a failed one offers Retry.
/// The body is one row per question so it sits in a List section.
struct QuestionItemsFullList: View {
    let card: SupervisorCard
    let drafts: [String: QuestionItemDraft]
    var idPrefix = "question-item"
    let onOpen: (String?) -> Void
    let onRetry: (SupervisorQuestionItem) -> Void
    var retryingItemID: String? = nil

    var body: some View {
        ForEach(card.questionItems) { item in
            QuestionItemFullRow(item: item, draft: drafts[item.itemId], idPrefix: idPrefix,
                                retrying: retryingItemID == item.itemId,
                                onOpen: { onOpen(item.itemId) },
                                onRetry: { onRetry(item) })
        }
    }
}

struct QuestionItemFullRow: View {
    let item: SupervisorQuestionItem
    let draft: QuestionItemDraft?
    var idPrefix = "question-item"
    var retrying = false
    let onOpen: () -> Void
    let onRetry: () -> Void

    var body: some View {
        let style = QuestionItemStatusStyle.of(item, draft: draft)
        VStack(alignment: .leading, spacing: 5) {
            VStack(alignment: .leading, spacing: 5) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(QuestionItemsText.title(item))
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(Theme.muted)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    QuestionItemStatusBadge(style: style)
                }
                Text(DecisionContract.clean(item.question) ?? item.question)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(Theme.ink)
                    .fixedSize(horizontal: false, vertical: true)
                if let context = DecisionContract.clean(item.context),
                   context.caseInsensitiveCompare(DecisionContract.clean(item.question) ?? "") != .orderedSame {
                    Text(context)
                        .font(.footnote)
                        .foregroundStyle(Theme.muted)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if !item.choices.isEmpty {
                    Text("Choices: \(item.choices.joined(separator: " · "))\(item.freeText ? " · or type an answer" : "")")
                        .font(.footnote)
                        .foregroundStyle(Theme.ink.opacity(0.9))
                        .fixedSize(horizontal: false, vertical: true)
                } else {
                    Text("Typed answer")
                        .font(.footnote)
                        .foregroundStyle(Theme.muted)
                }
                if let rec = DecisionContract.clean(item.recommendation) {
                    Text("\(Text("Agent's recommendation:").fontWeight(.semibold)) \(rec)")
                        .font(.footnote)
                        .foregroundStyle(Theme.live)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let unblocks = DecisionContract.clean(item.unblocks) {
                    Text("\(Text("Unblocks:").fontWeight(.semibold)) \(unblocks)")
                        .font(.footnote)
                        .foregroundStyle(Theme.ink.opacity(0.9))
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let answer = item.state.answer, item.state.status != "unanswered" && item.state.status != "skipped" {
                    Text("\(Text("Your answer:").fontWeight(.semibold)) \(answer)")
                        .font(.footnote)
                        .foregroundStyle(Theme.ink)
                        .fixedSize(horizontal: false, vertical: true)
                } else if let drafted = draft?.sendableAnswer {
                    Text("\(Text("Draft (not sent):").fontWeight(.semibold)) \(drafted)")
                        .font(.footnote)
                        .foregroundStyle(Theme.ink)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if item.state.status == "failed", let detail = DecisionContract.clean(item.state.detail) {
                    Text("Not delivered: \(detail)")
                        .font(.footnote)
                        .foregroundStyle(Theme.alert)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .accessibilityElement(children: .combine)
            .accessibilityValue(style.text)
            .accessibilityIdentifier("\(idPrefix)-full-\(item.index)")

            // Separate buttons, never wrapped in another accessible element.
            HStack(spacing: 12) {
                Button(item.state.isSent ? "View" : (draft == nil && item.state.status != "failed" ? "Answer" : "Change")) {
                    onOpen()
                }
                .buttonStyle(.borderless)
                .font(.footnote.weight(.semibold))
                .accessibilityIdentifier("\(idPrefix)-open-\(item.index)")
                if item.state.status == "failed", item.state.answer != nil || draft?.sendableAnswer != nil {
                    Button(retrying ? "Retrying…" : "Retry") {
                        onRetry()
                    }
                    .buttonStyle(.borderless)
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Theme.alert)
                    .disabled(retrying)
                    .accessibilityIdentifier("\(idPrefix)-retry-\(item.index)")
                }
            }
        }
        .padding(.vertical, 2)
    }
}

/// Retry one failed question from a list (outside the walkthrough).
@MainActor
enum QuestionItemsRetry {
    static func answer(for item: SupervisorQuestionItem, questionID: String,
                       store: QuestionItemsDraftStore = .shared) -> String? {
        let drafted = store.draft(questionID: questionID, itemID: item.itemId)?.sendableAnswer
        let kept = item.state.answer?.trimmingCharacters(in: .whitespacesAndNewlines)
        let answer = drafted ?? kept
        return (answer?.isEmpty ?? true) ? nil : answer
    }

    static func run(_ item: SupervisorQuestionItem, card: SupervisorCard, client: DaemonClient,
                    store: QuestionItemsDraftStore = .shared) async -> FleetCardActResult? {
        guard item.state.status == "failed",
              let answer = answer(for: item, questionID: card.questionId ?? card.id, store: store) else { return nil }
        do {
            let result = try await client.fleetAnswerCardItems(
                id: card.id, answers: [SupervisorQuestionItemAnswer(itemId: item.itemId, answer: answer)])
            let status = result.items.first { $0.itemId == item.itemId }?.state.status
            if status == "delivered" || status == "queued" {
                store.save(nil, questionID: card.questionId ?? card.id, itemID: item.itemId)
            }
            return result
        } catch {
            return FleetCardActResult(ok: false, status: "failed", message: "Can't reach OpenAGI. The answer is kept to retry.")
        }
    }
}

/// The questions section shared by the decision screen and the Thread
/// sheet: a summary, "Review N questions", and every question in full. It
/// owns the walkthrough sheet so it can open from inside another sheet.
struct QuestionItemsSection: View {
    let card: SupervisorCard
    /// "needs-you" or "thread": prefixes the accessibility identifiers.
    var idPrefix: String

    @Environment(AppModel.self) private var model
    @Environment(\.questionItemsResultHandler) private var resultHandler
    @State private var walkthrough: QuestionWalkthroughStart?
    @State private var retryingItemID: String?
    @State private var retryNote: SupervisorFormat.Note?
    @State private var draftsVersion = 0

    var body: some View {
        let questionID = card.questionId ?? card.id
        let _ = draftsVersion
        let drafts = QuestionItemsDraftStore.shared.drafts(questionID: questionID, items: card.questionItems)
        let counts = card.questionItemsCounts
        VStack(alignment: .leading, spacing: 6) {
            Text(QuestionItemsText.summary(counts))
                .font(.footnote.weight(.semibold))
                .foregroundStyle(Theme.muted)
                .accessibilityIdentifier("\(idPrefix)-question-items-summary")
            Text("Each question is answered on its own. Skipped ones stay open; nothing is approved in bulk.")
                .font(.footnote)
                .foregroundStyle(Theme.muted)
                .fixedSize(horizontal: false, vertical: true)
            Button {
                walkthrough = QuestionWalkthroughStart(card: card)
            } label: {
                Text(QuestionItemsText.reviewLabel(counts))
                    .font(.subheadline.weight(.semibold))
                    .frame(maxWidth: .infinity, minHeight: 36)
            }
            .buttonStyle(.borderedProminent)
            .accessibilityIdentifier("\(idPrefix)-review-items")
            if let retryNote {
                NoteText(note: retryNote)
            }
        }
        .sheet(item: $walkthrough, onDismiss: { draftsVersion += 1 }) { start in
            QuestionWalkthroughSheet(card: start.card, startItemID: start.itemID)
        }
        QuestionItemsFullList(
            card: card,
            drafts: drafts,
            idPrefix: "\(idPrefix)-question-item",
            onOpen: { itemID in walkthrough = QuestionWalkthroughStart(card: card, itemID: itemID) },
            onRetry: { item in
                guard retryingItemID == nil else { return }
                retryingItemID = item.itemId
                Task {
                    let result = await QuestionItemsRetry.run(item, card: card, client: model.client)
                    retryingItemID = nil
                    draftsVersion += 1
                    if let result {
                        retryNote = .init(text: result.message ?? (result.ok ? "Sent." : "Could not deliver the answer; it is kept to retry."),
                                          isAlert: !result.ok)
                        resultHandler.handle(result)
                    }
                }
            },
            retryingItemID: retryingItemID
        )
    }
}

private struct NoteText: View {
    let note: SupervisorFormat.Note

    var body: some View {
        Text(note.text)
            .font(.footnote)
            .foregroundStyle(note.isAlert ? Theme.alert : Theme.muted)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityIdentifier("question-items-note")
    }
}

// MARK: - Walkthrough sheet

/// One question per page. A tapped choice or typed text is a draft; only
/// "Send" sends, and only what the owner drafted.
struct QuestionWalkthroughSheet: View {
    @Environment(AppModel.self) private var appModel
    @Environment(\.questionItemsResultHandler) private var resultHandler
    @Environment(\.dismiss) private var dismiss
    @State private var model: QuestionWalkthroughModel

    init(card: SupervisorCard, startItemID: String? = nil, store: QuestionItemsDraftStore? = nil) {
        _model = State(initialValue: QuestionWalkthroughModel(card: card, startItemID: startItemID,
                                                              store: store ?? .shared))
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                if let item = model.current {
                    page(item)
                        .padding(.horizontal, 20)
                        .padding(.vertical, 16)
                        .id(item.itemId)
                }
            }
            .scrollDismissesKeyboard(.interactively)
            .safeAreaInset(edge: .bottom) { footer }
            .navigationTitle("Questions")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                        .accessibilityIdentifier("question-walkthrough-done")
                }
            }
        }
        .accessibilityIdentifier("question-walkthrough")
    }

    private var sender: QuestionWalkthroughModel.Sender {
        let client = appModel.client
        let cardID = model.cardID
        return { answers, skip in
            try await client.fleetAnswerCardItems(id: cardID, answers: answers, skip: skip)
        }
    }

    private func page(_ item: SupervisorQuestionItem) -> some View {
        let draft = model.draft(for: item.itemId)
        let style = QuestionItemStatusStyle.of(item, draft: draft)
        let editable = !item.state.isSent
        return VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 6) {
                Text("\(model.pageIndex + 1) of \(model.items.count)")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Theme.muted)
                    .monospacedDigit()
                    .accessibilityIdentifier("question-walkthrough-progress")
                ProgressView(value: Double(model.pageIndex + 1), total: Double(max(model.items.count, 1)))
                    .accessibilityHidden(true)
            }

            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .firstTextBaseline) {
                    Text(QuestionItemsText.title(item))
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(Theme.muted)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    QuestionItemStatusBadge(style: style)
                        .accessibilityIdentifier("question-walkthrough-state")
                }
                Text(DecisionContract.clean(item.question) ?? item.question)
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(Theme.ink)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
                    .accessibilityIdentifier("question-walkthrough-question")
                if let context = DecisionContract.clean(item.context),
                   context.caseInsensitiveCompare(DecisionContract.clean(item.question) ?? "") != .orderedSame {
                    Text(context)
                        .font(.subheadline)
                        .foregroundStyle(Theme.muted)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            if let rec = DecisionContract.clean(item.recommendation) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Agent's recommendation")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(Theme.live)
                    Text(rec)
                        .font(.subheadline)
                        .foregroundStyle(Theme.ink)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("question-walkthrough-recommendation")
            }
            if let unblocks = DecisionContract.clean(item.unblocks) {
                Text("\(Text("Unblocks:").fontWeight(.semibold)) \(unblocks)")
                    .font(.subheadline)
                    .foregroundStyle(Theme.ink.opacity(0.9))
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("question-walkthrough-unblocks")
            }

            stateBanner(item, draft: draft)

            if editable {
                if !item.choices.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(Array(item.choices.enumerated()), id: \.offset) { index, choice in
                            QuestionChoiceButton(
                                text: choice,
                                selected: draft?.answer == choice,
                                recommended: QuestionItemsText.isRecommended(choice, by: item.recommendation),
                                enabled: !model.sending
                            ) {
                                model.select(choice, for: item.itemId)
                            }
                            .accessibilityIdentifier("question-choice-\(index)")
                        }
                    }
                }
                if item.freeText {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(item.choices.isEmpty ? "Your answer" : "Or type an answer")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(Theme.muted)
                        TextField("Type your answer", text: textBinding(for: item), axis: .vertical)
                            .lineLimit(2...6)
                            .textFieldStyle(.roundedBorder)
                            .disabled(model.sending)
                            .accessibilityIdentifier("question-free-text")
                    }
                }
                if draft?.sendableAnswer != nil || draft?.skip == true {
                    HStack {
                        Text(draft?.skip == true ? "Will be skipped when you send. It stays open." : "Draft — not sent until you tap Send.")
                            .font(.footnote)
                            .foregroundStyle(Theme.muted)
                        Spacer(minLength: 8)
                        Button("Clear") { model.clearDraft(for: item.itemId) }
                            .font(.footnote.weight(.semibold))
                            .accessibilityIdentifier("question-walkthrough-clear")
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func stateBanner(_ item: SupervisorQuestionItem, draft: QuestionItemDraft?) -> some View {
        switch item.state.status {
        case "delivered", "queued":
            VStack(alignment: .leading, spacing: 2) {
                Text(item.state.status == "delivered" ? "Delivered to the agent" : "Sent — waiting to be delivered")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(item.state.status == "delivered" ? Color.green : Theme.live)
                if let answer = item.state.answer {
                    Text("Your answer: \(answer)")
                        .font(.subheadline)
                        .foregroundStyle(Theme.ink)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("question-walkthrough-sent")
        case "failed":
            VStack(alignment: .leading, spacing: 6) {
                Text("Not delivered\(DecisionContract.clean(item.state.detail).map { ": \($0)" } ?? "")")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Theme.alert)
                    .fixedSize(horizontal: false, vertical: true)
                if let answer = item.state.answer {
                    Text("Your answer (kept): \(answer)")
                        .font(.subheadline)
                        .foregroundStyle(Theme.ink)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Button(model.sending ? "Retrying…" : "Retry") {
                    Task {
                        if let result = await model.retry(item.itemId, using: sender) { resultHandler.handle(result) }
                    }
                }
                .buttonStyle(.bordered)
                .disabled(model.sending)
                .accessibilityIdentifier("question-walkthrough-retry")
            }
        case "skipped":
            Text("Skipped earlier. It is still open; answer it now or leave it.")
                .font(.footnote)
                .foregroundStyle(Theme.muted)
                .fixedSize(horizontal: false, vertical: true)
        default:
            EmptyView()
        }
    }

    private func textBinding(for item: SupervisorQuestionItem) -> Binding<String> {
        Binding(
            get: {
                guard let answer = model.draft(for: item.itemId)?.answer else { return "" }
                // A picked choice shows as the selected button, not as typed text.
                return item.choices.contains(answer) ? "" : answer
            },
            set: { model.setText($0, for: item.itemId) }
        )
    }

    private var footer: some View {
        let payload = model.payload
        let current = model.current
        let canSkip = current.map { !$0.state.isSent } ?? false
        return VStack(spacing: 8) {
            if let note = model.note {
                NoteText(note: note)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            HStack(spacing: 10) {
                Button {
                    model.back()
                } label: {
                    Label("Back", systemImage: "chevron.left")
                }
                .disabled(!model.canGoBack)
                .accessibilityIdentifier("question-walkthrough-back")
                Spacer()
                Button("Skip") {
                    model.skipCurrent()
                }
                .disabled(!canSkip || model.sending)
                .accessibilityIdentifier("question-walkthrough-skip")
                Spacer()
                Button {
                    model.next()
                } label: {
                    Label("Next", systemImage: "chevron.right")
                        .labelStyle(TrailingIconLabelStyle())
                }
                .disabled(!model.canGoNext)
                .accessibilityIdentifier("question-walkthrough-next")
            }
            .font(.subheadline.weight(.semibold))
            Button {
                Task {
                    if let result = await model.send(using: sender) { resultHandler.handle(result) }
                }
            } label: {
                Text(model.sending ? "Sending…" : payload.sendLabel)
                    .font(.subheadline.weight(.semibold))
                    .frame(maxWidth: .infinity, minHeight: 40)
            }
            .buttonStyle(.borderedProminent)
            .disabled(payload.isEmpty || model.sending)
            .accessibilityIdentifier("question-walkthrough-send")
        }
        .padding(.horizontal, 20)
        .padding(.top, 10)
        .padding(.bottom, 8)
        .background(.bar)
    }
}

private struct TrailingIconLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 4) {
            configuration.title
            configuration.icon
        }
    }
}

/// One choice as one button. Selected is a draft (filled, checkmark); the
/// recommended tag marks a choice the agent named exactly, and never
/// selects it.
struct QuestionChoiceButton: View {
    let text: String
    let selected: Bool
    let recommended: Bool
    var enabled = true
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(selected ? Color.white : Theme.muted)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 3) {
                    Text(text)
                        .font(.subheadline.weight(selected ? .semibold : .medium))
                        .foregroundStyle(selected ? Color.white : (enabled ? Theme.ink : Theme.muted))
                        .multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)
                    if recommended {
                        DecisionRecommendedTag(onFilled: selected)
                            .accessibilityHidden(true)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .frame(minHeight: 44)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background {
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(selected ? Theme.live.opacity(enabled ? 1 : 0.45) : Color.clear)
            }
            .overlay {
                if !selected {
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .strokeBorder(Theme.edge.opacity(enabled ? 0.9 : 0.35), lineWidth: 1)
                }
            }
            .contentShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        // One accessible button per choice (#391): label is the choice,
        // value says whether it is the draft and whether it is recommended.
        .accessibilityLabel(text)
        .accessibilityValue([selected ? "Selected" : nil, recommended ? "Recommended" : nil].compactMap { $0 }.joined(separator: ", "))
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}
