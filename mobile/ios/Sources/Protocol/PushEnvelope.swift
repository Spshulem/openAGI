import CryptoKit
import Foundation

// The end-to-end envelope every supervisor push carries
// (docs/superpowers/specs/2026-10-15-ios-supervisor-push-design.md, "Envelope").
// The daemon seals with the 32-byte key this phone generated; the relay and
// APNs only ever see the wire string. Compiled into the app, the widget
// extension (Live Activity) and the notification service extension, so it
// depends on Foundation and CryptoKit only.
//
// Wire: `v1.<base64url(nonce)>.<base64url(ciphertext || tag)>`, AES-256-GCM,
// 12-byte nonce, 16-byte tag, AAD `openagi-push:v1:<kind>`. The AAD binds the
// kind, so an activity payload can never be replayed as an alert.
public enum PushKind: String, Sendable {
    case activity, alert
}

public enum PushEnvelopeError: Error, Equatable {
    case malformed
    case badKey
    case authenticationFailed
}

public enum PushEnvelope {
    static let version = "v1"
    static let nonceSize = 12
    static let tagSize = 16
    public static let keySize = 32

    public static func aad(_ kind: PushKind) -> Data {
        Data("openagi-push:v1:\(kind.rawValue)".utf8)
    }

    public static func open(_ wire: String, key: Data, kind: PushKind) throws -> Data {
        guard key.count == keySize else { throw PushEnvelopeError.badKey }
        let parts = wire.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 3, parts[0] == version,
              let nonceData = Data(base64URLEncoded: String(parts[1])), nonceData.count == nonceSize,
              let sealed = Data(base64URLEncoded: String(parts[2])), sealed.count >= tagSize
        else { throw PushEnvelopeError.malformed }
        do {
            let box = try AES.GCM.SealedBox(
                nonce: AES.GCM.Nonce(data: nonceData),
                ciphertext: sealed.prefix(sealed.count - tagSize),
                tag: sealed.suffix(tagSize)
            )
            return try AES.GCM.open(box, using: SymmetricKey(data: key), authenticating: aad(kind))
        } catch {
            throw PushEnvelopeError.authenticationFailed
        }
    }

    // The daemon is the only real sealer; this exists so tests can build
    // envelopes (and tampered ones) without a Node round-trip.
    public static func seal(_ plaintext: Data, key: Data, kind: PushKind, nonce: Data? = nil) throws -> String {
        guard key.count == keySize else { throw PushEnvelopeError.badKey }
        let gcmNonce = try nonce.map { try AES.GCM.Nonce(data: $0) } ?? AES.GCM.Nonce()
        let box = try AES.GCM.seal(plaintext, using: SymmetricKey(data: key), nonce: gcmNonce, authenticating: aad(kind))
        let nonceData = Data(gcmNonce)
        return "\(version).\(nonceData.base64URLEncodedString()).\((box.ciphertext + box.tag).base64URLEncodedString())"
    }

    public static func decode<T: Decodable>(_ type: T.Type, from wire: String, key: Data, kind: PushKind) throws -> T {
        let plaintext = try open(wire, key: key, kind: kind)
        do {
            return try JSONDecoder().decode(type, from: plaintext)
        } catch {
            throw PushEnvelopeError.malformed
        }
    }
}

// MARK: - Plaintexts

// Kind `activity`. Dates stay ISO-8601 strings on the wire and are parsed on
// read, so one odd timestamp blanks one "since", never the whole activity.
public struct SupervisorActivityPlaintext: Codable, Sendable, Equatable {
    public struct Counts: Codable, Sendable, Equatable {
        public var you: Int
        public var working: Int
        public var waiting: Int
        public var blocked: Int

        public init(you: Int = 0, working: Int = 0, waiting: Int = 0, blocked: Int = 0) {
            self.you = you
            self.working = working
            self.waiting = waiting
            self.blocked = blocked
        }

        private enum CodingKeys: String, CodingKey { case you, working, waiting, blocked }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            you = (try? c.decodeIfPresent(Int.self, forKey: .you)) ?? 0
            working = (try? c.decodeIfPresent(Int.self, forKey: .working)) ?? 0
            waiting = (try? c.decodeIfPresent(Int.self, forKey: .waiting)) ?? 0
            blocked = (try? c.decodeIfPresent(Int.self, forKey: .blocked)) ?? 0
        }
    }

    public struct Row: Codable, Sendable, Equatable, Identifiable {
        public var key: String
        public var title: String
        // `you` | `blocked` | `working` | `waiting`.
        public var group: String
        public var waitingOn: String?
        public var since: String?

        public var id: String { key }
        public var sinceDate: Date? { since.flatMap(PushDates.parse) }

        public init(key: String, title: String, group: String, waitingOn: String? = nil, since: String? = nil) {
            self.key = key
            self.title = title
            self.group = group
            self.waitingOn = waitingOn
            self.since = since
        }
    }

    public var at: String?
    public var counts: Counts
    public var rows: [Row]
    public var observedAt: String?
    public var partial: Bool

    public var atDate: Date? { at.flatMap(PushDates.parse) }
    public var observedDate: Date? { observedAt.flatMap(PushDates.parse) }

    public init(at: String? = nil, counts: Counts = Counts(), rows: [Row] = [], observedAt: String? = nil, partial: Bool = false) {
        self.at = at
        self.counts = counts
        self.rows = rows
        self.observedAt = observedAt ?? at
        self.partial = partial
    }

    private enum CodingKeys: String, CodingKey { case at, counts, rows, observedAt, partial }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        at = try? c.decodeIfPresent(String.self, forKey: .at)
        counts = (try? c.decodeIfPresent(Counts.self, forKey: .counts)) ?? Counts()
        rows = Array(((try? c.decodeIfPresent([Row].self, forKey: .rows)) ?? []).prefix(3))
        // Old daemons sent only `at`. An explicit null from a new daemon
        // means no source scan exists, rather than a fresh observation.
        observedAt = c.contains(.observedAt) ? (try? c.decodeIfPresent(String.self, forKey: .observedAt)) : at
        partial = (try? c.decodeIfPresent(Bool.self, forKey: .partial)) ?? false
    }
}

extension SupervisorActivityPlaintext {
    // What the Live Activity draws from its sealed content state. nil (no
    // key, another pairing's key, tampered) shows the fallback line instead.
    public static func open(sealed: String, key: Data?) -> SupervisorActivityPlaintext? {
        guard let key else { return nil }
        return try? PushEnvelope.decode(SupervisorActivityPlaintext.self, from: sealed, key: key, kind: .activity)
    }

    public static let unreadableLine = "Open OpenAGI to refresh"

    // "1 needs you · 2 working · 1 waiting", zero counts left out.
    public var countsLine: String {
        let parts = [
            counts.you > 0 ? "\(counts.you) needs you" : nil,
            counts.blocked > 0 ? "\(counts.blocked) blocked" : nil,
            counts.working > 0 ? "\(counts.working) working" : nil,
            counts.waiting > 0 ? "\(counts.waiting) waiting" : nil
        ].compactMap { $0 }
        return parts.isEmpty ? "Nothing running" : parts.joined(separator: " · ")
    }

    public func isOutdated(now: Date = Date()) -> Bool {
        guard let observedDate else { return true }
        return now.timeIntervalSince(observedDate) >= 30 * 60
    }
}

// Kind `alert`.
public struct SupervisorAlertPlaintext: Codable, Sendable, Equatable {
    public var questionId: String
    public var title: String?
    public var body: String?
    public var options: [String]
    public var threadKey: String?

    public init(questionId: String, title: String? = nil, body: String? = nil, options: [String] = [], threadKey: String? = nil) {
        self.questionId = questionId
        self.title = title
        self.body = body
        self.options = options
        self.threadKey = threadKey
    }

    private enum CodingKeys: String, CodingKey { case questionId, title, body, options, threadKey }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        questionId = try c.decode(String.self, forKey: .questionId)
        title = try? c.decodeIfPresent(String.self, forKey: .title)
        body = try? c.decodeIfPresent(String.self, forKey: .body)
        options = (try? c.decodeIfPresent([String].self, forKey: .options)) ?? []
        threadKey = try? c.decodeIfPresent(String.self, forKey: .threadKey)
    }
}

enum PushDates {
    static func parse(_ raw: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: raw) { return date }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        return plain.date(from: raw)
    }
}

// MARK: - base64url (RFC 4648 §5, no padding)

extension Data {
    public init?(base64URLEncoded string: String) {
        guard !string.contains("="), !string.contains("+"), !string.contains("/") else { return nil }
        var base64 = string.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        let remainder = base64.count % 4
        if remainder == 1 { return nil }
        if remainder > 0 { base64 += String(repeating: "=", count: 4 - remainder) }
        self.init(base64Encoded: base64)
    }

    public func base64URLEncodedString() -> String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
