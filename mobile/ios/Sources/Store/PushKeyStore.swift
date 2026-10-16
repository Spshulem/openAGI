import Foundation
import Security

// Its own error rather than CredentialsError: the notification service
// extension compiles this file without Credentials.swift.
public enum PushKeyError: Error, Equatable {
    case keychain(OSStatus)
}

// The 32-byte AES key that seals every supervisor push for this phone. The
// phone makes it, hands it to its own daemon over the tailnet, and never
// gives it to the relay. The widget (Live Activity) and the notification
// service extension read it to decrypt, so it lives in the same shared
// keychain group as Credentials and is readable after first unlock: a locked
// phone still has to draw the Live Activity and rewrite an alert.
//
// Same deliberate choice as Credentials: no kSecAttrAccessGroup. The app,
// widget and notification extension each declare exactly one (identical)
// keychain-access-groups entry, so each lands in that shared group by
// default. See the long comment in Credentials.swift for why naming the
// group explicitly breaks every build this project produces.
public enum PushKeyStore {
    static let service = "sh.openagi.mobile.pushkey"
    static let account = "primary"

    public static func load() -> Data? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data, data.count == 32
        else { return nil }
        return data
    }

    // The existing key, or a fresh one saved first. Reusing it across token
    // rotations is fine: the daemon replaces this node's record either way.
    public static func loadOrCreate() throws -> Data {
        if let existing = load() { return existing }
        var bytes = [UInt8](repeating: 0, count: 32)
        let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        guard status == errSecSuccess else { throw PushKeyError.keychain(status) }
        let key = Data(bytes)
        try save(key)
        return key
    }

    static func save(_ key: Data) throws {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
        SecItemDelete(query as CFDictionary)
        query[kSecValueData as String] = key
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        let status = SecItemAdd(query as CFDictionary, nil)
        guard status == errSecSuccess else { throw PushKeyError.keychain(status) }
    }

    public static func clear() {
        SecItemDelete([
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ] as CFDictionary)
    }
}
