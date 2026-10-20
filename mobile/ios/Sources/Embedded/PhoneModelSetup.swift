import Foundation

enum PhoneModelSetup {
    enum Failure: LocalizedError {
        case unavailable
        case selectionNotSaved
        case testFailed(String)

        var errorDescription: String? {
            switch self {
            case .unavailable: "Apple Intelligence isn't ready. Check its status and try again, or choose a cloud model."
            case .selectionNotSaved: "Couldn't select this iPhone's model. Try again."
            case .testFailed(let message): message
            }
        }
    }

    static func useLocal(client: DaemonClient, availability: OnDeviceModelStatus) async throws {
        guard availability == .available else { throw Failure.unavailable }
        let saved = try await client.updateModelSettings(.init(preference: "on-device"))
        guard saved.preference == "on-device", saved.active.provider == "on-device" else {
            throw Failure.selectionNotSaved
        }
        let result = try await client.testModel()
        guard result.ok else {
            throw Failure.testFailed(result.message ?? "Apple Intelligence couldn't answer yet. Try again in a moment.")
        }
    }
}
