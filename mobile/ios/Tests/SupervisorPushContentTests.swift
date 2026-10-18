import UserNotifications
import XCTest
@testable import OpenAGI

// What the notification service extension writes into a supervisor alert,
// and what a tap on it asks the daemon for. The extension itself only applies
// SupervisorPushContent.alert, so pinning that pins the extension.
final class SupervisorPushContentTests: XCTestCase {
    private let key = Data((0..<32).map { UInt8($0) })

    private func sealedAlert(_ json: String, key: Data? = nil) throws -> [AnyHashable: Any] {
        let wire = try PushEnvelope.seal(Data(json.utf8), key: key ?? self.key, kind: .alert)
        return ["aps": ["category": "SUPERVISOR_QUESTION"], "sealed": wire]
    }

    // MARK: - Extension mapping

    func testDecryptedAlertBecomesTitleBodyButtonsAndUserInfo() throws {
        let userInfo = try sealedAlert(#"{"questionId":"fq123","title":"  Merge PR #12?  ","body":"CI is green.","options":["Approve","Skip","dismiss"],"threadKey":"codex:abc"}"#)
        let alert = try XCTUnwrap(SupervisorPushContent.alert(userInfo: userInfo, key: key))
        XCTAssertEqual(alert.questionId, "fq123")
        XCTAssertEqual(alert.title, "Merge PR #12?")
        XCTAssertEqual(alert.body, "CI is green.")
        XCTAssertEqual(alert.options, ["Approve", "Skip"])
        XCTAssertEqual(alert.actionTitles, ["Approve", "Skip"])
        XCTAssertTrue(alert.categoryIdentifier.hasPrefix("sq."))
        XCTAssertEqual(alert.userInfo["questionId"] as? String, "fq123")
        XCTAssertEqual(alert.userInfo["options"] as? [String], ["Approve", "Skip"])
        XCTAssertEqual(alert.userInfo["threadKey"] as? String, "codex:abc")
    }

    func testUndecryptableAlertsKeepTheGenericText() throws {
        let userInfo = try sealedAlert(#"{"questionId":"q1","title":"t"}"#)
        XCTAssertNil(SupervisorPushContent.alert(userInfo: userInfo, key: nil), "no key yet")
        XCTAssertNil(SupervisorPushContent.alert(userInfo: userInfo, key: Data(repeating: 9, count: 32)), "another pairing's key")
        XCTAssertNil(SupervisorPushContent.alert(userInfo: [:], key: key), "no sealed field")
        XCTAssertNil(SupervisorPushContent.alert(userInfo: ["sealed": 42], key: key), "wrong type")

        // An activity envelope replayed as an alert fails the AAD check.
        let activity = try PushEnvelope.seal(Data(#"{"questionId":"q1"}"#.utf8), key: key, kind: .activity)
        XCTAssertNil(SupervisorPushContent.alert(userInfo: ["sealed": activity], key: key))

        // Decrypts, but is not an alert / has no question.
        XCTAssertNil(SupervisorPushContent.alert(userInfo: try sealedAlert("not json"), key: key))
        XCTAssertNil(SupervisorPushContent.alert(userInfo: try sealedAlert(#"{"questionId":"  "}"#), key: key))
    }

    func testBlankTitleFallsBackAndLongTextIsCapped() throws {
        let long = String(repeating: "a", count: 300)
        let alert = try XCTUnwrap(SupervisorPushContent.alert(from: .init(questionId: "q", title: "   ", body: long,
                                                                          options: [String(repeating: "o", count: 60)])))
        XCTAssertEqual(alert.title, "Needs you")
        XCTAssertEqual(alert.body.count, 220)
        XCTAssertTrue(alert.body.hasSuffix("…"))
        // The button label is capped; the option sent stays exact.
        XCTAssertEqual(alert.actionTitles.first?.count, 40)
        XCTAssertEqual(alert.options.first?.count, 60)

        let titled = try XCTUnwrap(SupervisorPushContent.alert(from: .init(questionId: "q", title: String(repeating: "t", count: 150))))
        XCTAssertEqual(titled.title.count, 100)
        XCTAssertEqual(titled.body, "")
    }

    func testCapNeverSplitsAnEmoji() {
        let value = String(repeating: "a", count: 98) + "👩‍💻👩‍💻👩‍💻"
        let capped = SupervisorPushContent.cap(value, 100)
        XCTAssertEqual(capped, String(repeating: "a", count: 98) + "👩‍💻…")
    }

    // MARK: - Option filtering (same rule as Android's SupervisorAlerts.actionOptions)

    func testOptionFiltering() {
        XCTAssertEqual(SupervisorPushContent.actionOptions(["Approve", " DISMISS ", "Open Thread", "", "  ", "Skip", "Approve", "Later", "Fourth"]),
                       ["Approve", "Skip", "Later"])
        // Exact strings: the daemon only accepts an option verbatim.
        XCTAssertEqual(SupervisorPushContent.actionOptions([" yes "]), [" yes "])
        XCTAssertEqual(SupervisorPushContent.actionOptions(["dismiss"]), [])
        XCTAssertEqual(SupervisorPushContent.actionOptions([]), [])
    }

    // MARK: - Categories

    func testCategoryIdentifierIsStablePerOptionList() {
        let a = SupervisorPushContent.categoryIdentifier(for: ["Approve", "Skip"])
        XCTAssertEqual(a, SupervisorPushContent.categoryIdentifier(for: ["Approve", "Skip"]))
        XCTAssertNotEqual(a, SupervisorPushContent.categoryIdentifier(for: ["Skip", "Approve"]))
        XCTAssertNotEqual(a, SupervisorPushContent.categoryIdentifier(for: ["Approve", "Later"]))
        // Pinned so the extension and the app (different processes) agree.
        XCTAssertEqual(SupervisorPushContent.categoryIdentifier(for: []), "sq.cbf29ce484222325")
    }

    func testCategoryHasOneButtonPerOptionThenDismiss() throws {
        let alert = try XCTUnwrap(SupervisorPushContent.alert(from: .init(questionId: "q", options: ["Approve", "Skip"])))
        let category = SupervisorCategories.category(for: alert)
        XCTAssertEqual(category.identifier, alert.categoryIdentifier)
        XCTAssertEqual(category.actions.map(\.identifier), ["answer.0", "answer.1", "dismiss"])
        XCTAssertEqual(category.actions.map(\.title), ["Approve", "Skip", "Dismiss"])
        XCTAssertTrue(category.actions.allSatisfy { $0.options.contains(.authenticationRequired) })
        XCTAssertTrue(SupervisorCategories.base().actions.isEmpty)
        XCTAssertEqual(SupervisorCategories.base().identifier, "SUPERVISOR_QUESTION")
    }

    func testCategoryMergeKeepsOthersAndPrunesUnusedQuestionCategories() {
        func category(_ id: String) -> UNNotificationCategory {
            UNNotificationCategory(identifier: id, actions: [], intentIdentifiers: [])
        }
        let existing: Set = [category("SUPERVISOR_QUESTION"), category("sq.old"), category("sq.shown"), category("other")]
        let merged = SupervisorCategories.merged(existing: existing, adding: category("sq.new"), inUse: ["sq.shown"])
        XCTAssertEqual(Set(merged.map(\.identifier)), ["SUPERVISOR_QUESTION", "sq.shown", "other", "sq.new"])

        let replaced = SupervisorCategories.merged(existing: [category("SUPERVISOR_QUESTION")],
                                                   adding: category("SUPERVISOR_QUESTION"), inUse: [])
        XCTAssertEqual(replaced.map(\.identifier), ["SUPERVISOR_QUESTION"])
    }

    func testConcurrentAlertRegistrationsKeepEveryOptionCategoryBeforeDelivery() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        let center = UNUserNotificationCenter.current()
        defer {
            center.setNotificationCategories([])
            try? FileManager.default.removeItem(at: directory)
        }
        let identifiers = Set((0..<8).map { "sq.concurrent.\($0)" })
        let registered = expectation(description: "all concurrent categories registered")
        registered.expectedFulfillmentCount = identifiers.count
        for identifier in identifiers {
            let category = UNNotificationCategory(identifier: identifier, actions: [], intentIdentifiers: [])
            SupervisorCategories.register(category, center: center, coordinationDirectory: directory) { registered.fulfill() }
        }
        let registration = await XCTWaiter.fulfillment(of: [registered], timeout: 5)
        XCTAssertEqual(registration, .completed)
        let verified = expectation(description: "all categories retained before their notifications are delivered")
        center.getNotificationCategories { categories in
            XCTAssertTrue(identifiers.isSubset(of: Set(categories.map(\.identifier))))
            verified.fulfill()
        }
        let verification = await XCTWaiter.fulfillment(of: [verified], timeout: 2)
        XCTAssertEqual(verification, .completed)
    }

    // MARK: - Tap → action

    private let defaultID = UNNotificationDefaultActionIdentifier

    func testAnswerButtonPicksTheStoredExactOption() {
        let userInfo: [AnyHashable: Any] = ["questionId": "fq123", "options": ["Approve", " yes "]]
        XCTAssertEqual(SupervisorAnswerAction.from(actionIdentifier: "answer.0", defaultActionIdentifier: defaultID, userInfo: userInfo),
                       .answer(questionId: "fq123", answer: "Approve"))
        XCTAssertEqual(SupervisorAnswerAction.from(actionIdentifier: "answer.1", defaultActionIdentifier: defaultID, userInfo: userInfo),
                       .answer(questionId: "fq123", answer: " yes "))
        XCTAssertEqual(SupervisorAnswerAction.from(actionIdentifier: "dismiss", defaultActionIdentifier: defaultID, userInfo: userInfo),
                       .dismiss(questionId: "fq123"))
        XCTAssertEqual(SupervisorAnswerAction.from(actionIdentifier: defaultID, defaultActionIdentifier: defaultID, userInfo: [:]),
                       .open)
    }

    func testUnknownOrIncompleteActionsDoNothing() {
        let userInfo: [AnyHashable: Any] = ["questionId": "fq123", "options": ["Approve"]]
        for id in ["answer.1", "answer.-1", "answer.x", "answer.", "something", UNNotificationDismissActionIdentifier] {
            XCTAssertNil(SupervisorAnswerAction.from(actionIdentifier: id, defaultActionIdentifier: defaultID, userInfo: userInfo), id)
        }
        XCTAssertNil(SupervisorAnswerAction.from(actionIdentifier: "answer.0", defaultActionIdentifier: defaultID, userInfo: ["options": ["Approve"]]))
        XCTAssertNil(SupervisorAnswerAction.from(actionIdentifier: "dismiss", defaultActionIdentifier: defaultID, userInfo: ["questionId": " "]))
    }

    // The whole extension path end to end: sealed push → mapped userInfo →
    // the action a button tap produces.
    func testSealedAlertToButtonTapRoundTrip() throws {
        var userInfo = try sealedAlert(#"{"questionId":"fq9","title":"Ship?","body":"","options":["open thread","Ship it","Hold"]}"#)
        let alert = try XCTUnwrap(SupervisorPushContent.alert(userInfo: userInfo, key: key))
        for (k, v) in alert.userInfo { userInfo[k] = v }
        XCTAssertEqual(SupervisorAnswerAction.from(actionIdentifier: "answer.1", defaultActionIdentifier: defaultID, userInfo: userInfo),
                       .answer(questionId: "fq9", answer: "Hold"))
    }
}
