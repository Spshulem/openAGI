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
    @State private var showingDenyNote = false
    @State private var denyNote = ""
    @State private var resultMessage: String?
    @State private var resultIsError = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.x5) {
                VStack(alignment: .leading, spacing: Theme.Spacing.x1) {
                    Text(action.summary)
                        .font(Theme.Typography.section)
                        .foregroundStyle(Theme.ink)
                    if let reason = action.reason, !reason.isEmpty {
                        Text(reason)
                            .font(Theme.Typography.secondary)
                            .foregroundStyle(Theme.muted)
                    }
                }

                RowGroup {
                    detailRow(label: "Tool", value: action.toolName)
                    if let args = action.args {
                        RowHairline()
                        detailRow(label: "Arguments", value: args.displayDescription)
                    }
                }
                .padding(.horizontal, Theme.gutter)

                if let resultMessage {
                    Text(resultMessage)
                        .font(Theme.Typography.secondary)
                        .foregroundStyle(resultIsError ? Theme.alert : Theme.live)
                        .padding(.horizontal, Theme.gutter)
                }

                if action.status == "pending" {
                    VStack(spacing: Theme.Spacing.x2) {
                        PrimaryButton(title: "Approve", isLoading: isWorking) {
                            Task { await approve() }
                        }
                        if showingDenyNote {
                            TextField("Reason (optional)", text: $denyNote)
                                .textFieldStyle(.roundedBorder)
                            PrimaryButton(title: "Confirm deny") {
                                Task { await deny() }
                            }
                        } else {
                            DestructiveTextButton(title: "Deny") { showingDenyNote = true }
                        }
                    }
                    .padding(.horizontal, Theme.gutter)
                    .disabled(isWorking)
                }
            }
            .padding(.vertical, Theme.Spacing.x5)
        }
        .background(Theme.canvas)
        .navigationTitle("Approval")
    }

    private func detailRow(label: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.x1) {
            Text(label)
                .font(Theme.Typography.caption)
                .foregroundStyle(Theme.muted)
            Text(value)
                .font(Theme.Typography.body)
                .foregroundStyle(Theme.ink)
        }
        .padding(Theme.Spacing.x4)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func approve() async {
        isWorking = true
        defer { isWorking = false }
        do {
            let outcome = try await model.client.approvePendingAction(id: action.id)
            resultIsError = !outcome.ok
            resultMessage = outcome.ok ? "Approved." : (outcome.error ?? "The action failed.")
            await onDecided()
            if outcome.ok { dismiss() }
        } catch let error as DaemonError {
            resultIsError = true
            resultMessage = ApprovalError.message(for: error)
        } catch {
            resultIsError = true
            resultMessage = "Can't reach OpenAGI."
        }
    }

    private func deny() async {
        isWorking = true
        defer { isWorking = false }
        do {
            _ = try await model.client.denyPendingAction(id: action.id, reason: denyNote.isEmpty ? nil : denyNote)
            await onDecided()
            dismiss()
        } catch let error as DaemonError {
            resultIsError = true
            resultMessage = ApprovalError.message(for: error)
        } catch {
            resultIsError = true
            resultMessage = "Can't reach OpenAGI."
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
                    VStack(spacing: Theme.Spacing.x2) {
                        ForEach(ClarificationAnswer.allCases) { answer in
                            PrimaryButton(title: answer.label, isLoading: false) {
                                Task { await respond(answer) }
                            }
                            .opacity(answer == .yes ? 1 : 0.85)
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
        default: return "Can't reach OpenAGI."
        }
    }
}
