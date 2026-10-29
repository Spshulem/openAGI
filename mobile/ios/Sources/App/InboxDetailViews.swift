import SwiftUI

// mobile/FEATURES.md: "Detail shows the full arguments and the reason it was
// proposed, so you are approving something you have actually read." Approve
// waits for the server rather than resolving optimistically — "a wrongly-
// shown approval is worse than a slow one."
struct ApprovalDetailView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(AppModel.self) private var model
    let action: PendingAction
    let onDecided: () async -> Void

    @State private var isWorking = false
    @State private var isChecking = true
    @State private var decisionConsumed = false
    @State private var needsStatusCheck = false
    @State private var showingDenyNote = false
    @State private var denyNote = ""
    @State private var resultMessage: String?
    @State private var technicalError: String?
    @State private var resultIsError = false

    private var isComputerRequest: Bool { action.toolName == "start_computer_use_session" }
    private func argument(_ key: String) -> String? {
        guard let args = action.args, case .object(let values) = args,
              case .string(let value)? = values[key], !value.isEmpty else { return nil }
        return value
    }
    private var canDecide: Bool {
        action.status == "pending" && !decisionConsumed && !needsStatusCheck
    }

    var body: some View {
        Form {
            Section(isComputerRequest ? "Computer access" : "Request") {
                Text(isComputerRequest ? (argument("goal") ?? action.summary) : action.summary)
                    .font(.body)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
                    .accessibilityIdentifier("approval-request")
                if isComputerRequest, let computer = argument("nodeName") ?? argument("node") ?? argument("nodeId") {
                    detailRow(label: "Computer", value: computer)
                }
                if let reason = action.reason, !reason.isEmpty {
                    detailRow(label: "Why approval is needed", value: reason)
                }
                if !isComputerRequest, let args = action.args {
                    detailRow(label: "Details", value: args.displayDescription)
                }
            }

            if let message = resultMessage ?? action.error {
                Section("Request status") {
                    Text(message)
                        .foregroundStyle(resultIsError || action.error != nil ? Color.red : .primary)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("approval-result")
                    if needsStatusCheck {
                        Button("Check request status") { Task { await checkStatus() } }
                            .accessibilityIdentifier("approval-check-status")
                            .disabled(isChecking || isWorking)
                    }
                }
            } else if decisionConsumed || action.status != "pending" {
                Section("Request status") {
                    Text("This request is no longer waiting for approval.")
                }
            }

            if canDecide {
                Section {
                    Button { Task { await approve() } } label: {
                        HStack {
                            Text("Approve")
                            if isWorking { Spacer(); ProgressView() }
                        }
                    }
                    .accessibilityIdentifier("approval-approve")
                    if showingDenyNote {
                        TextField("Reason (optional)", text: $denyNote, axis: .vertical)
                            .lineLimit(1...4)
                        Button("Confirm deny", role: .destructive) { Task { await deny() } }
                    } else {
                        Button("Deny", role: .destructive) { showingDenyNote = true }
                            .accessibilityIdentifier("approval-deny")
                    }
                } footer: {
                    if isComputerRequest {
                        Text("Approve only the request shown above. The selected computer must be online and ready for control.")
                    }
                }
                .disabled(isWorking || isChecking)
            }

            Section {
                DisclosureGroup("Technical details") {
                    detailRow(label: "Tool", value: action.toolName)
                    if let args = action.args { detailRow(label: "Arguments", value: args.displayDescription) }
                    if let technicalError { detailRow(label: "Error", value: technicalError) }
                }
            }
        }
        .accessibilityIdentifier("approval-form")
        .navigationTitle("Approval")
        .navigationBarTitleDisplayMode(.inline)
        .task { if action.status == "pending" { await checkStatus() } else { isChecking = false } }
    }

    private func detailRow(label: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label).font(.subheadline).foregroundStyle(.secondary)
            Text(value).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
        }
    }

    private func checkStatus() async {
        isChecking = true
        defer { isChecking = false }
        do {
            let pending = try await model.client.pendingActions()
            needsStatusCheck = false
            if !pending.contains(where: { $0.id == action.id }) {
                decisionConsumed = true
                if resultMessage == nil { resultMessage = "This request is no longer waiting for approval. Return to Inbox for current requests." }
                await onDecided()
            } else if !decisionConsumed {
                resultMessage = nil
                resultIsError = false
            }
        } catch {
            needsStatusCheck = true
            resultIsError = true
            let message = (error as? DaemonError).map(ApprovalError.message) ?? "Can't reach OpenAGI."
            resultMessage = message + " Check this request's status before making a decision."
        }
    }

    private func approve() async {
        guard canDecide, !isWorking, !isChecking else { return }
        isWorking = true
        defer { isWorking = false }
        do {
            let outcome = try await model.client.approvePendingAction(id: action.id)
            // The server consumes an approval even when its tool fails. Keep
            // that failure readable without offering to replay the decision.
            decisionConsumed = true
            resultIsError = !outcome.ok
            technicalError = outcome.error
            if outcome.ok { resultMessage = "Approved." }
            else if outcome.error?.contains("no longer online and control-ready") == true {
                resultMessage = "The selected computer is unavailable. Open OpenAGI on that computer and check its connection, then ask your agent for a new access request. This approval has been used and will not run again."
            } else {
                resultMessage = (outcome.error ?? "The action failed.") + " This approval has been used. Ask your agent for a new request if you want to try again."
            }
            await onDecided()
            if outcome.ok { dismiss() }
        } catch { await handleDecisionError(error) }
    }

    private func deny() async {
        guard canDecide, !isWorking, !isChecking else { return }
        isWorking = true
        defer { isWorking = false }
        do {
            _ = try await model.client.denyPendingAction(id: action.id, reason: denyNote.isEmpty ? nil : denyNote)
            decisionConsumed = true
            await onDecided()
            dismiss()
        } catch { await handleDecisionError(error) }
    }

    private func handleDecisionError(_ error: Error) async {
        resultIsError = true
        if let daemon = error as? DaemonError {
            resultMessage = ApprovalError.message(for: daemon)
            if daemon == .notFound || daemon == .conflict || daemon == .server(410) {
                decisionConsumed = true
                await onDecided()
                return
            }
        }
        needsStatusCheck = true
        if let daemon = error as? DaemonError, daemon == .unauthorized {
            resultMessage = ApprovalError.message(for: daemon)
        } else if case .mainConnection(let issue) = error as? DaemonError {
            resultMessage = issue.message
        } else {
            resultMessage = "Couldn't confirm the decision. Check this request's status before trying again."
        }
    }
}

// mobile/FEATURES.md's Clarifications: "The question, the task it belongs
// to, and a free-text answer." The daemon's actual contract only accepts one
// of four fixed values (src/clarification-store.js's `VALID_ANSWERS`) --
// this offers exactly those, not a text field. See the phase report.
struct ClarificationDetailView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(AppModel.self) private var model
    let clarification: Clarification
    let onAnswered: () async -> Void

    @State private var isWorking = false
    @State private var errorMessage: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.x5) {
                VStack(alignment: .leading, spacing: Theme.Spacing.x1) {
                    Text(clarification.question)
                        .font(Theme.Typography.section)
                        .foregroundStyle(Theme.ink)
                    if !clarification.context.isEmpty {
                        Text(clarification.context)
                            .font(Theme.Typography.secondary)
                            .foregroundStyle(Theme.muted)
                    }
                }

                if let errorMessage {
                    Text(errorMessage)
                        .font(Theme.Typography.secondary)
                        .foregroundStyle(Theme.alert)
                }

                if clarification.status == "pending" {
                    // DESIGN.md spends its one bold moment on completion --
                    // four identical filled buttons here would be louder
                    // than that. "Yes" (the common case) gets the primary
                    // treatment; the other three are quiet rows instead.
                    VStack(spacing: Theme.Spacing.x4) {
                        PrimaryButton(title: ClarificationAnswer.yes.label, isLoading: false) {
                            Task { await respond(.yes) }
                        }
                        RowGroup {
                            let rest = ClarificationAnswer.allCases.filter { $0 != .yes }
                            ForEach(Array(rest.enumerated()), id: \.element) { index, answer in
                                Button {
                                    Task { await respond(answer) }
                                } label: {
                                    Text(answer.label)
                                        .font(Theme.Typography.body)
                                        .foregroundStyle(Theme.ink)
                                        .frame(maxWidth: .infinity, minHeight: Theme.rowMinHeight, alignment: .leading)
                                        .padding(.horizontal, Theme.Spacing.x4)
                                }
                                .buttonStyle(.plain)
                                if index < rest.count - 1 { RowHairline() }
                            }
                        }
                    }
                    .disabled(isWorking)
                } else {
                    Text("Already answered.")
                        .font(Theme.Typography.secondary)
                        .foregroundStyle(Theme.muted)
                }
            }
            .padding(Theme.gutter)
        }
        .background(Theme.canvas)
        .navigationTitle("Clarification")
    }

    private func respond(_ answer: ClarificationAnswer) async {
        isWorking = true
        defer { isWorking = false }
        do {
            _ = try await model.client.answerClarification(id: clarification.id, answer: answer)
            await onAnswered()
            dismiss()
        } catch let error as DaemonError {
            errorMessage = ApprovalError.message(for: error)
        } catch {
            errorMessage = "Can't reach OpenAGI."
        }
    }
}

enum ApprovalError {
    static func message(for error: DaemonError) -> String {
        switch error {
        case .unauthorized: return "Needs re-pairing — revoke and pair again in Settings."
        case .notFound: return "This item is gone — someone else may have already decided it."
        case .conflict: return "Already decided — probably from another device."
        case .server(410): return "This request expired. Ask your agent for a new request."
        case .mainConnection(let issue): return issue.message
        default: return "Can't reach OpenAGI."
        }
    }
}
