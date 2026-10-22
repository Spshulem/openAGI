import CryptoKit
import Foundation
import Observation
import Security
import SwiftUI

// Direct chat is deliberately separate from the paired agent. Switching a
// provider never uploads the server's history, tools, memory or credentials.
enum FallbackProvider: String, CaseIterable, Identifiable, Codable {
    case local, openAI, anthropic, openRouter, gemini
    var id: String { rawValue }
    var title: String {
        switch self {
        case .local: "Apple Intelligence"
        case .openAI: "OpenAI"
        case .anthropic: "Claude"
        case .openRouter: "OpenRouter"
        case .gemini: "Gemini"
        }
    }
    var defaultModel: String {
        switch self {
        case .local: "apple-foundation-models"
        case .openAI: "gpt-5-mini"
        case .anthropic: "claude-sonnet-4-6"
        case .openRouter: "openai/gpt-5-mini"
        case .gemini: "gemini-2.5-flash"
        }
    }
}

struct FallbackLine: Codable, Identifiable, Equatable {
    var id = UUID()
    let role: String
    let text: String
}

enum FallbackFailure: Error, LocalizedError {
    case message(String)
    var errorDescription: String? { if case .message(let text) = self { text } else { nil } }
}

enum FallbackKeyStore {
    private static func query(_ provider: FallbackProvider) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: "sh.openagi.direct-provider",
         kSecAttrAccount as String: provider.rawValue]
    }
    static func load(_ provider: FallbackProvider) -> String? {
        var q = query(provider)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var value: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &value) == errSecSuccess, let data = value as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }
    static func save(_ raw: String, provider: FallbackProvider) throws {
        let key = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !key.isEmpty, !key.contains("\n"), !key.contains("\r") else {
            throw FallbackFailure.message("Enter a valid API key.")
        }
        let q = query(provider)
        let attributes: [String: Any] = [kSecValueData as String: Data(key.utf8),
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
        let status = SecItemUpdate(q as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var item = q
            attributes.forEach { item[$0.key] = $0.value }
            guard SecItemAdd(item as CFDictionary, nil) == errSecSuccess else {
                throw FallbackFailure.message("Couldn't save the key in this iPhone's Keychain.")
            }
        } else if status != errSecSuccess {
            throw FallbackFailure.message("Couldn't update the key in this iPhone's Keychain.")
        }
    }
    static func remove(_ provider: FallbackProvider) { SecItemDelete(query(provider) as CFDictionary) }
}

// No redirects, cookies or disk URL cache: a provider key can only go to the
// exact HTTPS endpoint selected here. Error response bodies are never shown.
private final class FallbackRedirects: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}

enum FallbackTransport {
    static let instructions = "You are OpenAGI in direct chat mode. You can help with writing, reasoning and planning. You have no access to the user's server, tasks, integrations, files or tools. Never claim to have performed actions there."

    static func request(provider: FallbackProvider, model: String, key: String, lines: [FallbackLine]) throws -> URLRequest {
        guard provider != .local, !key.isEmpty, !model.isEmpty, model.count <= 160,
              !model.contains(where: { $0.isWhitespace }) else { throw FallbackFailure.message("Choose a model and save its API key first.") }
        let messages = lines.suffix(20).map { ["role": $0.role, "content": String($0.text.prefix(12_000))] }
        let url: URL
        var body: [String: Any]
        switch provider {
        case .openAI:
            url = URL(string: "https://api.openai.com/v1/responses")!
            body = ["model": model, "instructions": instructions, "input": messages, "store": false, "max_output_tokens": 2048]
        case .anthropic:
            url = URL(string: "https://api.anthropic.com/v1/messages")!
            body = ["model": model, "system": instructions, "messages": messages, "max_tokens": 2048]
        case .openRouter:
            url = URL(string: "https://openrouter.ai/api/v1/chat/completions")!
            body = ["model": model, "messages": [["role": "system", "content": instructions]] + messages, "max_tokens": 2048]
        case .gemini:
            guard model.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || "-_.".contains($0)) }) else {
                throw FallbackFailure.message("Enter a Gemini model ID, without a URL or path.")
            }
            url = URL(string: "https://generativelanguage.googleapis.com/v1beta/models/\(model):generateContent")!
            body = ["systemInstruction": ["parts": [["text": instructions]]],
                    "contents": lines.suffix(20).map { ["role": $0.role == "assistant" ? "model" : "user", "parts": [["text": String($0.text.prefix(12_000))]]] },
                    "generationConfig": ["maxOutputTokens": 2048]]
        case .local: throw FallbackFailure.message("The local model doesn't use a network connection.")
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 90
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if provider == .anthropic {
            request.setValue(key, forHTTPHeaderField: "x-api-key")
            request.setValue("2023-06-01", forHTTPHeaderField: "anthropic-version")
        } else if provider == .gemini { request.setValue(key, forHTTPHeaderField: "x-goog-api-key") }
        else { request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization") }
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        return request
    }

    static func decode(_ data: Data, provider: FallbackProvider) throws -> String {
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw FallbackFailure.message("The provider returned an unreadable reply.") }
        let text: String
        switch provider {
        case .openAI:
            text = (object["output"] as? [[String: Any]] ?? []).flatMap { $0["content"] as? [[String: Any]] ?? [] }
                .filter { $0["type"] as? String == "output_text" }.compactMap { $0["text"] as? String }.joined(separator: "\n")
        case .anthropic:
            text = (object["content"] as? [[String: Any]] ?? []).filter { $0["type"] as? String == "text" }.compactMap { $0["text"] as? String }.joined(separator: "\n")
        case .openRouter:
            text = ((object["choices"] as? [[String: Any]])?.first?["message"] as? [String: Any])?["content"] as? String ?? ""
        case .gemini:
            let content = (object["candidates"] as? [[String: Any]])?.first?["content"] as? [String: Any]
            text = (content?["parts"] as? [[String: Any]] ?? []).compactMap { $0["text"] as? String }.joined(separator: "\n")
        case .local: text = ""
        }
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw FallbackFailure.message("The model returned no text. Try a shorter message or another model.") }
        return text
    }

    static func reply(provider: FallbackProvider, model: String, lines: [FallbackLine]) async throws -> String {
        if provider == .local {
            guard await OnDeviceModelStatus.current() == .available else { throw FallbackFailure.message("Apple Intelligence isn't ready. Enable it in iPhone Settings and wait for its model download.") }
            let messages = lines.suffix(8).map { DeviceModelMessage(role: $0.role, content: String($0.text.suffix(1200))) }
            let backend = await OnDeviceModelStatus.backend()
            let result = try await backend.generate(DeviceGenerateRequest(id: UUID().uuidString, system: instructions, messages: messages, tools: [], maxOutputTokens: 1024), onDelta: { _ in })
            if case .text(let text) = result { return text }
            throw FallbackFailure.message("The local model returned no text.")
        }
        guard let key = FallbackKeyStore.load(provider) else { throw FallbackFailure.message("Save your \(provider.title) API key first.") }
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil
        config.urlCache = nil
        let session = URLSession(configuration: config, delegate: FallbackRedirects(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        let (data, response) = try await session.data(for: request(provider: provider, model: model, key: key, lines: lines))
        guard let status = (response as? HTTPURLResponse)?.statusCode else { throw FallbackFailure.message("Couldn't reach the provider.") }
        guard (200...299).contains(status) else {
            switch status {
            case 401, 403: throw FallbackFailure.message("The provider rejected this API key. Replace it in Chat options.")
            case 429: throw FallbackFailure.message("The provider's quota or rate limit was reached. Try later or choose the local model.")
            default: throw FallbackFailure.message("The provider couldn't reply (HTTP \(status)). Your server pairing is preserved.")
            }
        }
        return try decode(data, provider: provider)
    }
}

@MainActor @Observable
final class FallbackChatModel {
    var provider: FallbackProvider = .local
    var model = FallbackProvider.local.defaultModel
    var lines: [FallbackLine] = []
    var draft = ""
    var error: String?
    var sending = false
    var savedKey = false
    private var historyURL: URL {
        let name = SHA256.hash(data: Data("\(provider.rawValue):\(model)".utf8)).map { String(format: "%02x", $0) }.joined()
        return FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("direct-chat-\(name).json")
    }
    func select(_ provider: FallbackProvider) {
        self.provider = provider
        model = UserDefaults.standard.string(forKey: "direct-chat.model.\(provider.rawValue)") ?? provider.defaultModel
        load()
    }
    func load() {
        lines = (try? JSONDecoder().decode([FallbackLine].self, from: Data(contentsOf: historyURL))) ?? []
        savedKey = FallbackKeyStore.load(provider) != nil
        error = nil
    }
    func save() {
        do {
            try FileManager.default.createDirectory(at: historyURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            try JSONEncoder().encode(lines).write(to: historyURL, options: [.atomic, .completeFileProtection])
        } catch { self.error = "Couldn't save this conversation on the iPhone." }
    }
    func send() async {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !sending else { return }
        sending = true
        error = nil
        draft = ""
        lines.append(FallbackLine(role: "user", text: text))
        save()
        defer { sending = false }
        do {
            let reply = try await FallbackTransport.reply(provider: provider, model: model, lines: lines)
            lines.append(FallbackLine(role: "assistant", text: reply))
            save()
        } catch is CancellationError { error = "Reply stopped. Your message is saved." }
        catch let failure as FallbackFailure { error = failure.localizedDescription }
        catch { error = "Couldn't finish the reply. Check your internet connection or choose a local model. Your message is saved." }
    }
}

struct FallbackChatView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var chat = FallbackChatModel()
    @State private var options = true
    @State private var key = ""
    @State private var modelID = ""

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                VStack(alignment: .leading, spacing: 4) {
                    Label(chat.provider == .local ? "On this iPhone · Apple Intelligence" : "Direct · \(chat.provider.title) · \(chat.model)", systemImage: chat.provider == .local ? "iphone" : "cloud")
                        .font(.subheadline.weight(.semibold))
                    Text("Separate chat saved on this phone. Server tasks, integrations and shared history need your server connection.")
                        .font(.caption).foregroundStyle(.secondary)
                }.frame(maxWidth: .infinity, alignment: .leading).padding()
                List(chat.lines) { line in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(line.role == "user" ? "You" : chat.provider.title).font(.caption).foregroundStyle(.secondary)
                        Text(line.text).textSelection(.enabled)
                    }.listRowSeparator(.hidden)
                }.listStyle(.plain)
                if let error = chat.error { Text(error).font(.footnote).foregroundStyle(.red).padding(.horizontal) }
                if chat.sending { ProgressView("Replying…").padding(8) }
                HStack(alignment: .bottom) {
                    TextField("Message \(chat.provider.title)", text: $chat.draft, axis: .vertical)
                        .textFieldStyle(.roundedBorder).lineLimit(1...5)
                    Button("Send", systemImage: "arrow.up") { Task { await chat.send() } }
                        .labelStyle(.iconOnly).buttonStyle(.borderedProminent)
                        .disabled(chat.sending || chat.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || (chat.provider != .local && !chat.savedKey))
                }.padding()
            }
            .navigationTitle("Chat without server")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Back to server") { dismiss() }.disabled(chat.sending) }
                ToolbarItem(placement: .primaryAction) { Button("Chat options", systemImage: "slider.horizontal.3") { modelID = chat.model; options = true }.disabled(chat.sending) }
            }
            .sheet(isPresented: $options) { configuration }
            .onAppear { chat.load(); modelID = chat.model }
            .interactiveDismissDisabled(chat.sending)
        }
    }

    private var configuration: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("Use", selection: Binding(get: { chat.provider }, set: { provider in chat.select(provider); key = ""; modelID = chat.model })) {
                        ForEach(FallbackProvider.allCases) { Text($0.title).tag($0) }
                    }
                    if chat.provider == .local {
                        LabeledContent("Availability", value: OnDeviceModelStatus.current() == .available ? "Ready on this iPhone" : "Not ready")
                        Text("Runs on this iPhone using Apple Intelligence. No API key or server required.").foregroundStyle(.secondary)
                    } else {
                        TextField("Model ID", text: $modelID).textInputAutocapitalization(.never).autocorrectionDisabled()
                        SecureField(chat.savedKey ? "Replace saved API key" : "API key", text: $key).textInputAutocapitalization(.never).autocorrectionDisabled()
                        Button("Save key on this iPhone") {
                            do { try FallbackKeyStore.save(key, provider: chat.provider); key = ""; chat.savedKey = true; chat.error = nil }
                            catch { chat.error = error.localizedDescription }
                        }.disabled(key.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        if chat.savedKey {
                            Label("API key saved in Keychain", systemImage: "lock.shield")
                            Button("Remove saved key", role: .destructive) { FallbackKeyStore.remove(chat.provider); chat.savedKey = false }
                        }
                    }
                } footer: {
                    Text("Only messages written in this separate chat go to the selected provider. Your API key stays in this device's secure storage and is sent only to that provider. Provider usage may be billed to your account. Your OpenAGI pairing and server history stay saved.")
                }
                if let error = chat.error { Text(error).foregroundStyle(.red) }
            }
            .navigationTitle("Chat options")
            .toolbar { ToolbarItem(placement: .confirmationAction) {
                Button("Done") {
                    chat.model = chat.provider == .local ? chat.provider.defaultModel : modelID.trimmingCharacters(in: .whitespacesAndNewlines)
                    UserDefaults.standard.set(chat.model, forKey: "direct-chat.model.\(chat.provider.rawValue)")
                    chat.load()
                    options = false
                }.disabled(chat.provider != .local && (!chat.savedKey || modelID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty))
            } }
        }.onDisappear { key = "" }
    }
}
