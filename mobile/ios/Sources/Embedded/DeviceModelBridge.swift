import Foundation

// What answers the daemon's generations: Apple Foundation Models on a
// supported iPhone, a fake in tests.
protocol DeviceModelBackend: Sendable {
    var modelName: String { get }
    func contextSize() async -> Int
    func generate(_ request: DeviceGenerateRequest, onDelta: @escaping @Sendable (String) -> Void) async throws -> DeviceGenerateResult
}

// Holds the app's end of WS /device/model while the embedded daemon runs.
// iOS drops the socket whenever the app is suspended; `connect` is called
// again on every foreground and the loop reconnects after a failure.
actor DeviceModelBridge {
    static let shared = DeviceModelBridge()

    private var socket: URLSessionWebSocketTask?
    private var receiveLoop: Task<Void, Never>?
    private var running: [String: Task<Void, Never>] = [:]
    private var target: (port: Int, ownerToken: String, backend: any DeviceModelBackend, availability: String)?

    func connect(port: Int, ownerToken: String, backend: any DeviceModelBackend, availability: String = "available") {
        let previous = target
        target = (port, ownerToken, backend, availability)
        if let previous, previous.port != port || previous.ownerToken != ownerToken || previous.availability != availability {
            socket?.cancel(with: .goingAway, reason: nil)
            socket = nil
        }
        if let socket, socket.state == .running { return }
        open()
    }

    func disconnect() {
        target = nil
        receiveLoop?.cancel()
        receiveLoop = nil
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
        running.values.forEach { $0.cancel() }
        running.removeAll()
    }

    private func open() {
        guard let target else { return }
        var request = URLRequest(url: URL(string: "ws://127.0.0.1:\(target.port)/device/model")!)
        request.setValue("Bearer \(target.ownerToken)", forHTTPHeaderField: "Authorization")
        let task = URLSession.shared.webSocketTask(with: request)
        task.maximumMessageSize = 1024 * 1024
        socket = task
        task.resume()
        let backend = target.backend
        receiveLoop?.cancel()
        receiveLoop = Task { [weak self] in
            let context = await backend.contextSize()
            try? await task.send(.data(DeviceModelOutbound.hello(model: backend.modelName, contextSize: context, availability: target.availability)))
            while !Task.isCancelled {
                guard let message = try? await task.receive() else { break }
                let data: Data
                switch message {
                case .data(let bytes): data = bytes
                case .string(let text): data = Data(text.utf8)
                @unknown default: continue
                }
                await self?.handle(DeviceModelInbound.decode(data), on: task, backend: backend)
            }
            await self?.dropped(task)
        }
    }

    private func handle(_ frame: DeviceModelInbound, on task: URLSessionWebSocketTask, backend: any DeviceModelBackend) {
        switch frame {
        case .generate(let request):
            running[request.id] = Task { [weak self] in
                // Deltas go out in order, and all of them before the result.
                let (deltas, continuation) = AsyncStream<String>.makeStream()
                let sender = Task {
                    for await text in deltas {
                        try? await task.send(.data(DeviceModelOutbound.delta(id: request.id, text: text)))
                    }
                }
                let reply: Data
                do {
                    let result = try await backend.generate(request) { continuation.yield($0) }
                    continuation.finish()
                    await sender.value
                    reply = DeviceModelOutbound.result(id: request.id, result)
                } catch let failure as DeviceModelFailure {
                    continuation.finish()
                    reply = DeviceModelOutbound.error(id: request.id, failure)
                } catch is CancellationError {
                    continuation.finish()
                    await self?.finished(request.id)
                    return
                } catch {
                    continuation.finish()
                    reply = DeviceModelOutbound.error(id: request.id, DeviceModelFailure(code: "device-model-error", message: error.localizedDescription))
                }
                try? await task.send(.data(reply))
                await self?.finished(request.id)
            }
        case .cancel(let id):
            running.removeValue(forKey: id)?.cancel()
        case .unknown:
            break
        }
    }

    private func finished(_ id: String) {
        running.removeValue(forKey: id)
    }

    private func dropped(_ task: URLSessionWebSocketTask) async {
        guard socket === task else { return }
        socket = nil
        running.values.forEach { $0.cancel() }
        running.removeAll()
        // Still wanted (not disconnected): try again shortly. The daemon
        // waits up to 30 s for a device before failing a generation.
        guard target != nil else { return }
        try? await Task.sleep(for: .seconds(2))
        if target != nil, socket == nil { open() }
    }
}
