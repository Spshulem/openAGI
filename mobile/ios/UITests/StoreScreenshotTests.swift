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

    func testCaptureNativeLocalAgentScreens() {
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
