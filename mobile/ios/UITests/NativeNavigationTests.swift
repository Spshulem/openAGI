import XCTest

@MainActor
final class NativeNavigationTests: XCTestCase {
    private func launch(_ arguments: [String] = []) -> XCUIApplication {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing"] + arguments
        app.launch()
        XCTAssertTrue(app.navigationBars["Today"].waitForExistence(timeout: 15))
        return app
    }

    private func element(_ app: XCUIApplication, _ id: String) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: id).firstMatch
    }

    private func tap(_ app: XCUIApplication, _ id: String, in listID: String? = nil) {
        let target = element(app, id)
        if let listID {
            let list = element(app, listID)
            XCTAssertTrue(list.waitForExistence(timeout: 5), "Missing list \(listID)")
            // Native lists create offscreen accessibility elements lazily.
            // Scroll the active form, rather than the presenting screen.
            for _ in 0..<8 {
                // Duo's settings rows can be hittable while their center is
                // clipped by the form's bottom edge. Other forms keep native
                // swipes: a coordinate drag can land in an API-key field.
                let viewport = list.frame.insetBy(dx: 16, dy: 88)
                if target.exists && target.isHittable && (listID != "settings-form" || viewport.contains(target.frame)) {
                    target.tap()
                    return
                }
                if listID != "settings-form" {
                    list.swipeUp()
                    continue
                }
                let start = list.coordinate(withNormalizedOffset: CGVector(dx: 0.45, dy: 0.65))
                let end = list.coordinate(withNormalizedOffset: CGVector(dx: 0.45, dy: 0.35))
                if target.exists && target.frame.midY < viewport.minY {
                    end.press(forDuration: 0.1, thenDragTo: start)
                } else {
                    start.press(forDuration: 0.1, thenDragTo: end)
                }
            }
        }
        XCTAssertTrue(target.waitForExistence(timeout: 10), "Missing \(id)")
        XCTAssertTrue(target.isHittable, "Not hittable: \(id)")
        target.tap()
    }

    private func back(_ app: XCUIApplication, from title: String, to parent: String) {
        // Duo places its native Back button in the vertical toolbar, outside
        // UINavigationBar. Ordinary iPhones can expose the parent title.
        let native = element(app, "BackButton")
        let target = native.exists ? native : app.navigationBars[title].buttons[parent]
        XCTAssertTrue(target.waitForExistence(timeout: 5), "Missing Back from \(title)")
        target.tap()
        XCTAssertTrue(app.navigationBars[parent].waitForExistence(timeout: 5),
                      "One Back from \(title) must return directly to \(parent)")
        XCTAssertFalse(app.navigationBars[title].exists)
    }

    private func tab(_ app: XCUIApplication, _ title: String) {
        let tab = app.tabBars.buttons[title]
        let target = tab.exists ? tab : app.buttons[title].firstMatch
        XCTAssertTrue(target.waitForExistence(timeout: 10), "Missing \(title) tab")
        target.tap()
    }

    private func capture(_ name: String, app: XCUIApplication) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    func testEverySettingsRowPushesOneDestinationAndBackReturnsToSettings() {
        let app = launch()
        tap(app, "open-settings")
        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 5))
        capture("native-settings", app: app)
        for (id, title) in [("model", "Model"), ("instructions", "Instructions"), ("integrations", "Integrations"), ("skills", "Skills"), ("scheduled", "Scheduled")] {
            tap(app, "settings-\(id)", in: "settings-form")
            XCTAssertTrue(app.navigationBars[title].waitForExistence(timeout: 5))
            back(app, from: title, to: "Settings")
        }
        tap(app, "settings-done")
        XCTAssertTrue(app.navigationBars["Today"].waitForExistence(timeout: 5))
    }

    func testWideNavigationIsOnTheRightAndChatCanBeClosed() {
        let app = launch()
        let rail = element(app, "right-navigation")
        guard app.frame.width >= 760 && app.frame.height >= 600 else {
            // Compact Duo uses a native vertical tab toolbar, which XCTest
            // exposes as buttons rather than a UITabBar.
            tab(app, "Chat")
            XCTAssertTrue(app.navigationBars["Chat"].waitForExistence(timeout: 5))
            return
        }
        XCTAssertTrue(rail.waitForExistence(timeout: 5), "Expanded windows must use right-side navigation")
        XCTAssertGreaterThan(rail.frame.minX, app.frame.midX)
        let close = app.buttons["close-chat-pane"]
        if close.exists { close.tap() }
        tap(app, "toggle-chat-pane")
        XCTAssertTrue(close.waitForExistence(timeout: 5))
        tab(app, "Supervisor")
        XCTAssertTrue(close.exists, "Pinned chat stays open while navigating")
        close.tap()
        XCTAssertFalse(close.exists)
        tab(app, "Chat")
        XCTAssertFalse(element(app, "supporting-chat-pane").exists, "Chat must not open a second conversation")
        capture("right-navigation-chat", app: app)
    }

    func testModelProviderSelectionSavesAndLeavesTheModelScreenUsable() {
        let app = launch()
        tap(app, "open-settings")
        tap(app, "settings-model", in: "settings-form")
        tap(app, "model-provider")
        let option = app.buttons["OpenAI"]
        let openAI = option.exists ? option : app.staticTexts["OpenAI"].firstMatch
        XCTAssertTrue(openAI.waitForExistence(timeout: 5))
        openAI.tap()
        let active = element(app, "model-active")
        let selected = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "label CONTAINS %@", "OpenAI · demo-model"), object: active)
        XCTAssertEqual(XCTWaiter.wait(for: [selected], timeout: 10), .completed)
        capture("native-model-selection", app: app)
        tap(app, "model-test", in: "model-form")
        XCTAssertTrue(app.staticTexts["Works. demo-model answered."].waitForExistence(timeout: 10))
        back(app, from: "Model", to: "Settings")
    }

    func testNativeIntegrationCanSaveAKeyAndSyncThenReturnToSettings() {
        let app = launch()
        tap(app, "open-settings")
        tap(app, "settings-integrations", in: "settings-form")
        tap(app, "integration-linear")
        let key = app.secureTextFields["API key"]
        XCTAssertTrue(key.waitForExistence(timeout: 5))
        key.tap()
        key.typeText("synthetic-integration-key")
        app.buttons["Save API key"].tap()
        XCTAssertTrue(app.staticTexts["Saved. Sync tasks now to check access."].waitForExistence(timeout: 10))
        app.buttons["Sync tasks now"].tap()
        XCTAssertTrue(app.staticTexts["Synced. 1 new tasks."].waitForExistence(timeout: 10))
        capture("native-integration", app: app)
        back(app, from: "Linear", to: "Integrations")
        back(app, from: "Integrations", to: "Settings")
    }

    func testTodayAndTasksRenderDataAndEachTaskHasItsOwnNavigationRow() {
        let app = launch()
        XCTAssertTrue(app.staticTexts["Plan a synthetic demo"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["Review a synthetic demo"].exists)
        capture("native-today", app: app)
        tab(app, "Tasks")
        tap(app, "tasks-task-demo-one", in: "tasks-list")
        XCTAssertTrue(app.navigationBars["Edit task"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.textFields["Title"].value as? String, "Plan a synthetic demo")
        back(app, from: "Edit task", to: "Tasks")
        capture("native-tasks", app: app)
        app.segmentedControls.buttons["Agent's"].tap()
        XCTAssertTrue(app.staticTexts["Prepare a synthetic report"].waitForExistence(timeout: 10))
    }

    func testInboxRowsNavigateIndependentlyAndShowApprovalsAndQuestions() {
        let app = launch()
        tab(app, "Inbox")
        XCTAssertTrue(app.staticTexts["Approve the first synthetic action"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["Is the synthetic demo ready?"].exists)
        capture("native-inbox", app: app)
        tap(app, "inbox-approval-approval-one")
        XCTAssertTrue(app.navigationBars["Approval"].waitForExistence(timeout: 5))
        back(app, from: "Approval", to: "Inbox")
        tap(app, "inbox-question-question-one")
        XCTAssertTrue(app.navigationBars["Clarification"].waitForExistence(timeout: 5))
        back(app, from: "Clarification", to: "Inbox")
    }

    func testNativeComposerHistoryKeyboardDraftContinuityAndSending() {
        let app = launch()
        tab(app, "Chat")
        XCTAssertTrue(app.staticTexts["Earlier synthetic answer"].waitForExistence(timeout: 10))
        let composer = element(app, "chat-composer")
        XCTAssertTrue(composer.exists)
        composer.tap()
        composer.typeText("A synthetic message")
        let send = element(app, "chat-send")
        XCTAssertTrue(send.isEnabled && send.isHittable)
        if app.keyboards.firstMatch.waitForExistence(timeout: 3) {
            XCTAssertLessThanOrEqual(send.frame.maxY, app.keyboards.firstMatch.frame.minY)
        }
        capture("native-chat-keyboard", app: app)
        app.scrollViews.firstMatch.swipeDown()
        tab(app, "Tasks")
        tab(app, "Chat")
        XCTAssertEqual(element(app, "chat-composer").value as? String, "A synthetic message")
        tap(app, "chat-send")
        XCTAssertTrue(app.staticTexts["Synthetic reply"].waitForExistence(timeout: 10))
        capture("native-chat", app: app)
    }

    func testAnEmptyTodayDoesNotHideTheInboxLink() {
        let app = launch(["--ui-empty-today"])
        XCTAssertTrue(element(app, "today-empty").waitForExistence(timeout: 10))
        tap(app, "today-open-inbox")
        XCTAssertTrue(app.navigationBars["Inbox"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Approve the first synthetic action"].waitForExistence(timeout: 10))
    }

    func testUnauthorizedDataIsNotPresentedAsConnectedAndEmpty() {
        let app = launch(["--ui-unauthorized"])
        XCTAssertTrue(app.staticTexts["Pairing needs attention"].waitForExistence(timeout: 10))
        tap(app, "open-settings")
        XCTAssertTrue(app.staticTexts["Needs re-pairing"].waitForExistence(timeout: 5))
        capture("native-connection-error", app: app)
    }

    func testSettingsAndComposerRemainUsableInDarkModeWithAccessibilityText() {
        let app = launch(["--ui-dark", "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"])
        tap(app, "open-settings")
        tap(app, "settings-model", in: "settings-form")
        XCTAssertTrue(app.navigationBars["Model"].waitForExistence(timeout: 5))
        back(app, from: "Model", to: "Settings")
        capture("native-settings-accessibility-dark", app: app)
        tap(app, "settings-done")
        tab(app, "Chat")
        tap(app, "chat-composer")
        element(app, "chat-composer").typeText("Large text")
        XCTAssertTrue(element(app, "chat-send").isHittable)
        capture("native-chat-accessibility-dark", app: app)
    }
}
