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

    private func tap(_ app: XCUIApplication, _ id: String) {
        let target = element(app, id)
        XCTAssertTrue(target.waitForExistence(timeout: 10), "Missing \(id)")
        for _ in 0..<5 where !target.isHittable { app.swipeUp() }
        XCTAssertTrue(target.isHittable, "Not hittable: \(id)")
        target.tap()
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
        for (id, title) in [("model", "Model"), ("instructions", "Instructions"), ("skills", "Skills"), ("scheduled", "Scheduled")] {
            tap(app, "settings-\(id)")
            XCTAssertTrue(app.navigationBars[title].waitForExistence(timeout: 5))
            let back = app.navigationBars[title].buttons["Settings"]
            XCTAssertTrue(back.exists, "\(title) must go straight back to Settings")
            back.tap()
            XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 5))
            XCTAssertFalse(app.navigationBars[title].exists)
        }
        tap(app, "settings-done")
        XCTAssertTrue(app.navigationBars["Today"].waitForExistence(timeout: 5))
    }

    func testModelProviderSelectionSavesAndLeavesTheModelScreenUsable() {
        let app = launch()
        tap(app, "open-settings")
        tap(app, "settings-model")
        tap(app, "model-provider")
        let option = app.buttons["OpenAI"]
        let openAI = option.exists ? option : app.staticTexts["OpenAI"].firstMatch
        XCTAssertTrue(openAI.waitForExistence(timeout: 5))
        openAI.tap()
        XCTAssertTrue(app.staticTexts["OpenAI · demo-model"].waitForExistence(timeout: 10))
        capture("native-model-selection", app: app)
        tap(app, "model-test")
        XCTAssertTrue(app.staticTexts["Works. demo-model answered."].waitForExistence(timeout: 10))
        app.navigationBars["Model"].buttons["Settings"].tap()
        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 5))
    }

    func testTodayAndTasksRenderDataAndEachTaskHasItsOwnNavigationRow() {
        let app = launch()
        XCTAssertTrue(app.staticTexts["Plan a synthetic demo"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["Review a synthetic demo"].exists)
        capture("native-today", app: app)
        tab(app, "Tasks")
        tap(app, "tasks-task-demo-one")
        XCTAssertTrue(app.navigationBars["Edit task"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.textFields["Title"].value as? String, "Plan a synthetic demo")
        app.navigationBars["Edit task"].buttons["Tasks"].tap()
        XCTAssertTrue(app.navigationBars["Tasks"].waitForExistence(timeout: 5))
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
        app.navigationBars["Approval"].buttons["Inbox"].tap()
        XCTAssertTrue(app.navigationBars["Inbox"].waitForExistence(timeout: 5))
        tap(app, "inbox-question-question-one")
        XCTAssertTrue(app.navigationBars["Clarification"].waitForExistence(timeout: 5))
        app.navigationBars["Clarification"].buttons["Inbox"].tap()
        XCTAssertTrue(app.navigationBars["Inbox"].waitForExistence(timeout: 5))
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
        tap(app, "settings-model")
        XCTAssertTrue(app.navigationBars["Model"].waitForExistence(timeout: 5))
        app.navigationBars["Model"].buttons["Settings"].tap()
        capture("native-settings-accessibility-dark", app: app)
        tap(app, "settings-done")
        tab(app, "Chat")
        tap(app, "chat-composer")
        element(app, "chat-composer").typeText("Large text")
        XCTAssertTrue(element(app, "chat-send").isHittable)
        capture("native-chat-accessibility-dark", app: app)
    }
}
