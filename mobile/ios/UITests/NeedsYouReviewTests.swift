import XCTest

/// Needs You with long, noisy synthetic data (`--ui-needs-you-fixture`):
/// the list is scannable, and the screens are attached for review.
@MainActor
final class NeedsYouReviewTests: XCTestCase {
    private func launch(_ arguments: [String] = []) -> XCUIApplication {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--ui-needs-you-fixture"] + arguments
        app.launch()
        XCTAssertTrue(app.navigationBars["Today"].waitForExistence(timeout: 15))
        return app
    }

    private func button(_ app: XCUIApplication, _ id: String) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: id).firstMatch
    }

    private func tapButton(_ app: XCUIApplication, _ id: String) {
        let target = button(app, id)
        XCTAssertTrue(target.waitForExistence(timeout: 10), "Missing \(id)")
        target.tap()
    }

    private func tab(_ app: XCUIApplication, _ title: String) {
        let tabBarButton = app.tabBars.buttons[title]
        let target = tabBarButton.exists ? tabBarButton : app.buttons[title].firstMatch
        XCTAssertTrue(target.waitForExistence(timeout: 10), "Missing \(title) tab")
        target.tap()
    }

    private func capture(_ name: String, app: XCUIApplication) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func labelled(_ app: XCUIApplication, _ fragment: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS[c] %@", fragment)).firstMatch
    }

    private func openNeedsYou(_ app: XCUIApplication) {
        tab(app, "Chat")
        tapButton(app, "chat-conversations")
        tapButton(app, "conversation-supervisor")
        XCTAssertTrue(app.navigationBars["Supervisor chat"].waitForExistence(timeout: 10))
        tapButton(app, "supervisor-channel-needs-you")
    }

    func testNeedsYouListWithLongNoisyData() {
        for (suffix, arguments) in [("dark", ["--ui-dark"]), ("light", [])] {
            let app = launch(arguments)
            openNeedsYou(app)
            XCTAssertTrue(labelled(app, "checkout redesign").waitForExistence(timeout: 10), "The fixture's first decision is listed")
            capture("needs-you-list-\(suffix)", app: app)
            app.swipeUp()
            capture("needs-you-list-scrolled-\(suffix)", app: app)
            app.terminate()
        }
    }
}
