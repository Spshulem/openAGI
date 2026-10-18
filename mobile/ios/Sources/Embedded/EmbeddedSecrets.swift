import Foundation
import Security

// Phone-only mode's secrets, in the Keychain next to Credentials but in a
// slot of their own, so connecting to a server (which overwrites
// Credentials) never loses the way back to the daemon on this phone.
//
// - ownerToken: the embedded daemon's OPENAGI_AUTH_TOKEN. Only the app's own
//   setup calls and the model bridge use it.
// - local: the app's mobile-node credential on that daemon, the same kind of
//   credential pairing with a Mac produces. The rest of the app uses this.
struct EmbeddedSecrets: Sendable, Equatable {
    var ownerToken: String
    var nodeID: String?
    var nodeToken: String?

    private static let service = "sh.openagi.mobile.embedded"
    private static let account = "primary"

    // The existing secrets, or fresh ones with a new owner token. The token is
    // saved before Node first starts, so a crash mid-setup can't strand a data
    // dir whose token the app no longer knows.
    static func loadOrCreate() throws -> EmbeddedSecrets {
        if let existing = load() { return existing }
        let created = EmbeddedSecrets(ownerToken: PairingView.generateNodeToken())
        try created.save()
        return created
    }

    func localCredentials(port: Int) -> Credentials? {
        guard let nodeID, let nodeToken, let server = URL(string: "http://127.0.0.1:\(port)") else { return nil }
        return Credentials(server: server, nodeID: nodeID, token: nodeToken)
    }

    func save() throws {
        var object = ["ownerToken": ownerToken]
        if let nodeID { object["nodeID"] = nodeID }
        if let nodeToken { object["nodeToken"] = nodeToken }
        let payload = try JSONSerialization.data(withJSONObject: object)
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Self.service,
            kSecAttrAccount as String: Self.account
        ]
        SecItemDelete(query as CFDictionary)
        query[kSecValueData as String] = payload
        // Background refresh starts Node while the phone may be locked.
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        let status = SecItemAdd(query as CFDictionary, nil)
        guard status == errSecSuccess else { throw CredentialsError.keychain(status) }
    }

    static func load() -> EmbeddedSecrets? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data,
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: String],
              let ownerToken = object["ownerToken"]
        else { return nil }
        return EmbeddedSecrets(ownerToken: ownerToken, nodeID: object["nodeID"], nodeToken: object["nodeToken"])
    }
}

extension EmbeddedSecrets: CustomStringConvertible {
    var description: String { "EmbeddedSecrets(nodeID: \(nodeID ?? "nil"), tokens: <redacted>)" }
}

// Where this app's agent runs. Absent on a fresh install (onboarding asks)
// and on installs from before phone-only mode, which were all paired.
enum AppMode: String, Sendable {
    // The daemon runs inside this app on the phone's own model.
    case onPhone
    // The app is a client of a daemon on a Mac or server.
    case server

    private static let key = "sh.openagi.appMode"

    static var current: AppMode? {
        get { UserDefaults.standard.string(forKey: key).flatMap(AppMode.init(rawValue:)) }
        set { UserDefaults.standard.set(newValue?.rawValue, forKey: key) }
    }

    // A local credential can become active before onboarding finishes (or
    // before its mode is saved). It always needs the embedded daemon started.
    // Existing remote pairings from before this mode existed mean server.
    static func resolved(credentials: Credentials?, storedMode: AppMode? = current) -> AppMode? {
        if credentials?.isEmbedded == true { return .onPhone }
        return storedMode ?? (credentials != nil ? .server : nil)
    }
}
