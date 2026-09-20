import Foundation
import Security

// Kept local to this file rather than reusing Sources/Transport's
// DaemonError: Sources/Store compiles standalone into the widget extension
// target, which has no networking code at all ("the widget never performs
// network I/O"), so Store must not depend on a Transport type just to
// describe a Keychain write failure.
public enum CredentialsError: Error, Equatable {
    case keychain(OSStatus)
}

extension CredentialsError: LocalizedError {
    public var errorDescription: String? {
        switch self {
        case .keychain: return "Could not save credentials to the keychain. Try again."
        }
    }
}

// The node token is the whole security boundary of this app. It goes in the
// Keychain, in an access group the widget extension shares, and it is never
// written next to the snapshot.
public struct Credentials: Sendable, Equatable {
    public let server: URL
    public let nodeID: String
    public let token: String

    private static let service = "sh.openagi.mobile.node"
    private static let account = "primary"
    private static let accessGroup = "sh.openagi.mobile"

    public init(server: URL, nodeID: String, token: String) {
        self.server = server
        self.nodeID = nodeID
        self.token = token
    }

    public func save() throws {
        let payload = try JSONSerialization.data(withJSONObject: [
            "server": server.absoluteString, "nodeID": nodeID, "token": token
        ])
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Self.service,
            kSecAttrAccount as String: Self.account,
            kSecAttrAccessGroup as String: Self.accessGroup
        ]
        SecItemDelete(query as CFDictionary)
        query[kSecValueData as String] = payload
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        let status = SecItemAdd(query as CFDictionary, nil)
        guard status == errSecSuccess else { throw CredentialsError.keychain(status) }
    }

    public static func load() -> Credentials? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrAccessGroup as String: accessGroup,
            kSecReturnData as String: true
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data,
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: String],
              let rawServer = object["server"], let server = URL(string: rawServer),
              let nodeID = object["nodeID"], let token = object["token"]
        else { return nil }
        return Credentials(server: server, nodeID: nodeID, token: token)
    }

    public static func clear() {
        SecItemDelete([
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrAccessGroup as String: accessGroup
        ] as CFDictionary)
    }
}
