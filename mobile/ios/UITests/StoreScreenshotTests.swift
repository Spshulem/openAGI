import XCTest

// Capture the shipping native views with fictional content, independently of
// the deliberately literal strings used by the navigation regression suite.
@MainActor
final class StoreScreenshotTests: XCTestCase {
    private func capture(_ name: String, app: XCUIApplication) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = "store-\(name)"
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func element(_ id: String, app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: id).firstMatch
    }

    private func tab(_ title: String, app: XCUIApplication) {
        let regular = app.tabBars.buttons[title]
        let target = regular.exists ? regular : app.buttons[title].firstMatch
        XCTAssertTrue(target.waitForExistence(timeout: 10))
        target.tap()
        XCTAssertTrue(app.navigationBars[title].waitForExistence(timeout: 5))
    }

    // The Supervisor views with a fictional coding-agent fleet
    // (StoreScreenshotFleet). Steps are soft: a capture run reports what it
    // found instead of stopping at the first missing control.
    func testCaptureSupervisorAgentScreens() {
        continueAfterFailure = true
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--store-screenshots", "--store-paired-mac", "-AppleInterfaceStyle", "Light"]
        app.launch()
        func tapIfPresent(_ id: String, timeout: TimeInterval = 8) -> Bool {
            let target = element(id, app: app)
            guard target.waitForExistence(timeout: timeout) else {
                XCTContext.runActivity(named: "missing \(id)") { _ in }
                return false
            }
            target.tap()
            return true
        }
        func settle(_ seconds: TimeInterval = 2) { _ = XCTWaiter.wait(for: [XCTestExpectation()], timeout: seconds) }

        tab("Chat", app: app)
        if !element("conversation-supervisor", app: app).exists { _ = tapIfPresent("chat-conversations") }
        _ = tapIfPresent("conversation-supervisor")
        XCTAssertTrue(app.staticTexts["What needs me across my projects?"].waitForExistence(timeout: 15))
        settle()
        capture("agents-01-supervisor-chat", app: app)

        if tapIfPresent("supervisor-expand-deck", timeout: 3) { settle(); capture("agents-02-deck-expanded", app: app) }
        if tapIfPresent("supervisor-channel-needs-you") { settle(); capture("agents-03-needs-you", app: app) }
        let sessions = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "#sessions")).firstMatch
        if sessions.waitForExistence(timeout: 5) { sessions.tap(); settle(); capture("agents-04-sessions", app: app) }
        let activity = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "#activity")).firstMatch
        if activity.waitForExistence(timeout: 5) { activity.tap(); settle(); capture("agents-05-activity", app: app) }
        let api = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "#api")).firstMatch
        if api.waitForExistence(timeout: 5) { api.tap(); settle(); capture("agents-06-project-api", app: app) }
        if tapIfPresent("supervisor-channel-needs-you") { settle() }

        if tapIfPresent("supervisor-card-review-card-checkout", timeout: 5) {
            settle(3); capture("agents-07-review-checkout", app: app)
            for _ in 0..<2 { app.swipeUp() }
            settle(); capture("agents-08-review-checkout-scrolled", app: app)
            let done = app.buttons["Done"].firstMatch
            for _ in 0..<4 where !(done.exists && done.isHittable) { app.swipeDown() }
            if done.exists { done.tap() } else { app.swipeDown(velocity: .fast) }
            settle()
        }
        if tapIfPresent("supervisor-question-context-q-dark-mode", timeout: 4) {
            settle(3); capture("agents-09-thread-dark-mode", app: app)
            let done = app.buttons["Done"].firstMatch
            for _ in 0..<4 where !(done.exists && done.isHittable) { app.swipeDown() }
            if done.exists { done.tap() }
            settle()
        }
        if tapIfPresent("supervisor-board-button") {
            settle(3); capture("agents-10-board", app: app)
            let project = app.staticTexts["api"].firstMatch
            if project.waitForExistence(timeout: 4) && project.isHittable { project.tap(); settle(3); capture("agents-11-board-project", app: app) }
            if app.buttons["Done"].exists { app.buttons["Done"].tap(); settle() }
        }
        let todayTab = app.tabBars.buttons["Today"].exists ? app.tabBars.buttons["Today"] : app.buttons["Today"].firstMatch
        if todayTab.waitForExistence(timeout: 5) {
            todayTab.tap()
            settle()
            capture("agents-12-today", app: app)
            if tapIfPresent("open-settings") { settle(2); capture("agents-13-settings", app: app) }
        }
        let tree = app.debugDescription
        let attachment = XCTAttachment(string: tree)
        attachment.name = "agents-hierarchy"
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    func testCaptureNativeLocalAgentScreens() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["STORE_LEGACY"] == "1", "legacy planner captures")
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--store-screenshots", "-AppleInterfaceStyle", "Light"]
        app.launch()
        XCTAssertTrue(app.staticTexts["Outline the new project"].waitForExistence(timeout: 15))
        capture("02-today", app: app)

        tab("Tasks", app: app)
        XCTAssertTrue(app.staticTexts["Make time for a new book"].waitForExistence(timeout: 10))
        capture("03-tasks", app: app)

        tab("Inbox", app: app)
        XCTAssertTrue(app.staticTexts["How much time would you like for the project outline?"].waitForExistence(timeout: 10))
        capture("04-inbox", app: app)

        tab("Chat", app: app)
        XCTAssertTrue(app.staticTexts["Help me plan my morning. I need to outline a project, review my notes, and get outside."].waitForExistence(timeout: 10))
        XCTAssertTrue(element("chat-composer", app: app).exists)
        capture("01-chat", app: app)

        tab("Today", app: app)
        element("open-settings", app: app).tap()
        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["This iPhone"].firstMatch.exists)
        capture("05-settings", app: app)
        let model = element("settings-model", app: app)
        XCTAssertTrue(model.isHittable)
        model.tap()
        let active = element("model-active", app: app)
        let localModel = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "label CONTAINS %@", "This iPhone's model"), object: active)
        XCTAssertEqual(XCTWaiter.wait(for: [localModel], timeout: 10), .completed)
        capture("06-apple-intelligence", app: app)
    }
}
