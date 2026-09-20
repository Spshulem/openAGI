import Foundation

// Owns the one long-lived `GET /events` connection and reconnects with
// exponential backoff (capped at 30s) whenever it drops -- mobile/FEATURES.md:
// "Reconnect with backoff when the stream drops. Never silently stay dead."
// `AppModel` is the only caller; kept as its own type so the reconnect loop
// is a single, readable place rather than tangled into the model itself.
@MainActor
public final class EventStreamController {
    private let client: DaemonClient
    private var pumpTask: Task<Void, Never>?
    public private(set) var isConnected = false

    public init(client: DaemonClient) {
        self.client = client
    }

    public func events() -> AsyncStream<DaemonEvent> {
        AsyncStream { continuation in
            let task = Task { [weak self] in
                guard let self else { return }
                await self.run(continuation: continuation)
            }
            pumpTask = task
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    public func stop() {
        pumpTask?.cancel()
        pumpTask = nil
        isConnected = false
    }

    private func run(continuation: AsyncStream<DaemonEvent>.Continuation) async {
        var backoffSeconds: UInt64 = 1
        while !Task.isCancelled {
            do {
                let stream = try await client.eventStream()
                isConnected = true
                backoffSeconds = 1 // a connection that succeeds resets the backoff
                for try await event in stream {
                    if Task.isCancelled { break }
                    continuation.yield(event)
                }
            } catch {
                // Falls through to the backoff-and-retry below regardless of
                // whether this was a transport drop or an auth/server error
                // -- the daemon may come back, and staying dead is the one
                // thing FEATURES.md rules out.
            }
            isConnected = false
            if Task.isCancelled { break }
            try? await Task.sleep(nanoseconds: backoffSeconds * 1_000_000_000)
            backoffSeconds = min(backoffSeconds * 2, 30)
        }
        continuation.finish()
    }
}
