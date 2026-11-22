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

        // Channel pills live in a horizontal strip; scroll one into view before tapping.
        func pill(_ prefix: String) -> Bool {
            let button = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", prefix)).firstMatch
            guard button.waitForExistence(timeout: 5) else { return false }
            let strip = element("supervisor-project-channels", app: app)
            for attempt in 0..<6 where !button.isHittable {
                if attempt < 3 { strip.swipeLeft() } else { strip.swipeRight() }
            }
            guard button.isHittable else { return false }
            button.tap()
            return true
        }
        func closeSheet() {
            let done = app.buttons["Done"].firstMatch
            for _ in 0..<4 where !(done.exists && done.isHittable) { app.swipeDown() }
            if done.exists && done.isHittable { done.tap() }
            settle()
        }
        if pill("#needs-you") { settle(); capture("agents-03-needs-you", app: app) }
        if pill("#sessions") { settle(); capture("agents-04-sessions", app: app) }
        if pill("#activity") { settle(); capture("agents-05-activity", app: app) }
        if pill("#api") { settle(); capture("agents-06-project-api", app: app) }
        if pill("#needs-you") { settle() }
        let review = element("supervisor-card-review-card-dark-mode", app: app)
        if review.waitForExistence(timeout: 5) && review.isHittable {
            review.tap(); settle(3); capture("agents-07-review-dark-mode", app: app)
            app.swipeUp(); settle(); capture("agents-08-review-dark-mode-scrolled", app: app)
            closeSheet()
        }
        let blocked = element("supervisor-card-review-card-webhooks", app: app)
        if blocked.waitForExistence(timeout: 5) && blocked.isHittable {
            blocked.tap(); settle(3); capture("agents-09-review-webhooks", app: app)
            closeSheet()
        }
        let details = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Details")).firstMatch
        if details.waitForExistence(timeout: 4) && details.isHittable {
            details.tap(); settle(3); capture("agents-10-details-checkout", app: app)
            closeSheet()
        }
        let board = element("supervisor-board-button", app: app)
        if board.waitForExistence(timeout: 5) && board.isHittable {
            board.tap(); settle(3); capture("agents-11-board", app: app)
            let project = app.staticTexts["api"].firstMatch
            if project.waitForExistence(timeout: 4) && project.isHittable { project.tap(); settle(3); capture("agents-12-board-project", app: app) }
            closeSheet()
        }
        let todayTab = app.tabBars.buttons["Today"].exists ? app.tabBars.buttons["Today"] : app.buttons["Today"].firstMatch
        if todayTab.waitForExistence(timeout: 5) {
            todayTab.tap()
            settle()
            capture("agents-13-today", app: app)
            if tapIfPresent("open-settings") { settle(2); capture("agents-14-settings", app: app) }
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
