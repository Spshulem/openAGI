import XCTest
@testable import OpenAGI

// The envelope is a three-way contract (daemon seals, relay forwards, phone
// opens). mobile/fixtures/push-envelope.json is the same file the Node tests
// decrypt, so a change on either side that breaks the other fails here.
final class PushEnvelopeTests: XCTestCase {
    private struct Fixture: Decodable {
        let key: String
        let kind: String
        let plaintext: String
        let wire: String
    }

    private func fixture() throws -> Fixture {
        let url = URL(filePath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appending(path: "fixtures/push-envelope.json")
        return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
    }

    private func fixtureKey() throws -> Data {
        try XCTUnwrap(Data(base64URLEncoded: fixture().key))
    }

    func testSharedFixtureDecryptsToItsPlaintext() throws {
        let fixture = try fixture()
        let key = try fixtureKey()
        XCTAssertEqual(key.count, 32)
        let kind = try XCTUnwrap(PushKind(rawValue: fixture.kind))
        let opened = try PushEnvelope.open(fixture.wire, key: key, kind: kind)
        XCTAssertEqual(String(decoding: opened, as: UTF8.self), fixture.plaintext)
    }

    func testSharedFixtureDecodesAsActivityPlaintext() throws {
        let fixture = try fixture()
        let activity = try PushEnvelope.decode(SupervisorActivityPlaintext.self, from: fixture.wire,
                                               key: try fixtureKey(), kind: .activity)
        XCTAssertEqual(activity.counts, .init(you: 1, working: 2, waiting: 0))
        XCTAssertEqual(activity.rows.count, 1)
        XCTAssertEqual(activity.rows.first?.key, "codex:abc")
        XCTAssertEqual(activity.rows.first?.title, "Fix login")
        XCTAssertEqual(activity.rows.first?.group, "you")
        XCTAssertEqual(activity.rows.first?.waitingOn, "your answer")
        XCTAssertEqual(activity.rows.first?.sinceDate, Date(timeIntervalSince1970: 1_792_065_480))
        XCTAssertEqual(activity.atDate, Date(timeIntervalSince1970: 1_792_065_600))
        XCTAssertEqual(activity.countsLine, "1 needs you · 2 working")
    }

    func testWrongKeyFails() throws {
        var key = try fixtureKey()
        key[0] ^= 0x01
        XCTAssertThrowsError(try PushEnvelope.open(try fixture().wire, key: key, kind: .activity)) {
            XCTAssertEqual($0 as? PushEnvelopeError, .authenticationFailed)
        }
        XCTAssertNil(SupervisorActivityPlaintext.open(sealed: try fixture().wire, key: key))
    }

    func testWrongKindAADFails() throws {
        XCTAssertThrowsError(try PushEnvelope.open(try fixture().wire, key: try fixtureKey(), kind: .alert)) {
            XCTAssertEqual($0 as? PushEnvelopeError, .authenticationFailed)
        }
    }

    func testTamperedCiphertextAndNonceFail() throws {
        let parts = try fixture().wire.split(separator: ".").map(String.init)
        var sealed = try XCTUnwrap(Data(base64URLEncoded: parts[2]))
        sealed[0] ^= 0x80
        let tamperedCipher = "\(parts[0]).\(parts[1]).\(sealed.base64URLEncodedString())"
        XCTAssertThrowsError(try PushEnvelope.open(tamperedCipher, key: try fixtureKey(), kind: .activity))

        var nonce = try XCTUnwrap(Data(base64URLEncoded: parts[1]))
        nonce[11] ^= 0x01
        let tamperedNonce = "\(parts[0]).\(nonce.base64URLEncodedString()).\(parts[2])"
        XCTAssertThrowsError(try PushEnvelope.open(tamperedNonce, key: try fixtureKey(), kind: .activity))

        var tag = try XCTUnwrap(Data(base64URLEncoded: parts[2]))
        tag[tag.count - 1] ^= 0x01
        let tamperedTag = "\(parts[0]).\(parts[1]).\(tag.base64URLEncodedString())"
        XCTAssertThrowsError(try PushEnvelope.open(tamperedTag, key: try fixtureKey(), kind: .activity))
    }

    func testMalformedWireStringsFailWithoutCrashing() throws {
        let key = try fixtureKey()
        let wire = try fixture().wire
        for bad in ["", "v1", "v1..", "v2" + wire.dropFirst(2), "v1.AAAA.AAAA", "v1.!!!.???",
                    wire + ".extra", "v1.8HLLmcpiZvgNxeVI.AAAA"] {
            XCTAssertThrowsError(try PushEnvelope.open(bad, key: key, kind: .activity), bad)
        }
        XCTAssertThrowsError(try PushEnvelope.open(wire, key: Data(count: 16), kind: .activity)) {
            XCTAssertEqual($0 as? PushEnvelopeError, .badKey)
        }
    }

    func testSealOpenRoundTripAndFixedNonceMatchesFixture() throws {
        let fixture = try fixture()
        let key = try fixtureKey()
        let nonce = try XCTUnwrap(Data(base64URLEncoded: String(fixture.wire.split(separator: ".")[1])))
        let resealed = try PushEnvelope.seal(Data(fixture.plaintext.utf8), key: key, kind: .activity, nonce: nonce)
        XCTAssertEqual(resealed, fixture.wire)

        let alert = Data(#"{"questionId":"q1"}"#.utf8)
        let wire = try PushEnvelope.seal(alert, key: key, kind: .alert)
        XCTAssertEqual(try PushEnvelope.open(wire, key: key, kind: .alert), alert)
    }

    func testBase64URLRejectsPaddingAndStandardAlphabet() {
        XCTAssertNil(Data(base64URLEncoded: "AA=="))
        XCTAssertNil(Data(base64URLEncoded: "a+b/"))
        XCTAssertNil(Data(base64URLEncoded: "A"))
        XCTAssertEqual(Data(base64URLEncoded: "-_8"), Data([0xFB, 0xFF]))
        XCTAssertEqual(Data([0xFB, 0xFF]).base64URLEncodedString(), "-_8")
    }

    // MARK: - Plaintext decoding

    func testActivityPlaintextDecodesNullsAndCapsRows() throws {
        let json = #"""
        {"at":"2026-10-15T12:00:00.000Z","counts":{"you":0,"working":4,"waiting":1},
         "rows":[{"key":"a","title":"A","group":"working","waitingOn":null,"since":null},
                 {"key":"b","title":"B","group":"working"},
                 {"key":"c","title":"C","group":"waiting","waitingOn":"CI","since":"2026-10-15T11:00:00Z"},
                 {"key":"d","title":"D","group":"waiting"}]}
        """#
        let activity = try JSONDecoder().decode(SupervisorActivityPlaintext.self, from: Data(json.utf8))
        XCTAssertEqual(activity.rows.map(\.key), ["a", "b", "c"])
        XCTAssertNil(activity.rows[0].waitingOn)
        XCTAssertNil(activity.rows[0].sinceDate)
        XCTAssertEqual(activity.rows[2].sinceDate, Date(timeIntervalSince1970: 1_792_062_000))
        XCTAssertEqual(activity.countsLine, "4 working · 1 waiting")
    }

    func testActivityPlaintextToleratesMissingFields() throws {
        let activity = try JSONDecoder().decode(SupervisorActivityPlaintext.self, from: Data("{}".utf8))
        XCTAssertEqual(activity.counts, .init())
        XCTAssertEqual(activity.rows, [])
        XCTAssertEqual(activity.countsLine, "Nothing running")
    }

    func testAlertPlaintextDecodes() throws {
        let json = #"{"questionId":"fq123","title":"Merge?","body":"PR is green","options":["Approve","Skip"],"threadKey":"codex:abc"}"#
        let alert = try JSONDecoder().decode(SupervisorAlertPlaintext.self, from: Data(json.utf8))
        XCTAssertEqual(alert, SupervisorAlertPlaintext(questionId: "fq123", title: "Merge?", body: "PR is green",
                                                       options: ["Approve", "Skip"], threadKey: "codex:abc"))
        let minimal = try JSONDecoder().decode(SupervisorAlertPlaintext.self, from: Data(#"{"questionId":"q","threadKey":null}"#.utf8))
        XCTAssertEqual(minimal.options, [])
        XCTAssertNil(minimal.threadKey)
        XCTAssertThrowsError(try JSONDecoder().decode(SupervisorAlertPlaintext.self, from: Data(#"{"title":"x"}"#.utf8)))
    }

    func testActivityAttributesKeepTheWireShape() throws {
        let attributes = try JSONSerialization.jsonObject(with: JSONEncoder().encode(SupervisorActivityAttributes())) as? [String: String]
        XCTAssertEqual(attributes, ["slot": "fleet"])
        let state = try JSONSerialization.jsonObject(with: JSONEncoder().encode(SupervisorActivityAttributes.ContentState(sealed: "v1.a.b"))) as? [String: String]
        XCTAssertEqual(state, ["sealed": "v1.a.b"])
        XCTAssertEqual(String(describing: SupervisorActivityAttributes.self), "SupervisorActivityAttributes")
    }
}
