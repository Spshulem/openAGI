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

    private func element(_ app: XCUIApplication, _ id: String) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: id).firstMatch
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

    /// Scan, select, read, return: one row opens one decision screen, and
    /// Back lands on the same list with nothing reset.
    func testRowOpensOneDecisionScreenAndBackReturnsToTheList() {
        let app = launch(["--ui-dark"])
        openNeedsYou(app)
        let row = element(app, "needs-you-row-ny-deploy")
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        // The row is one control: title and why-line read together, and it
        // is at least a 44 pt touch target.
        XCTAssertTrue(row.label.contains("checkout redesign"), row.label)
        XCTAssertTrue(row.label.contains("Only you can approve"), row.label)
        XCTAssertGreaterThanOrEqual(row.frame.height, 44)
        // FYIs are not rows of their own until asked for.
        XCTAssertFalse(element(app, "needs-you-row-fyi-docs").exists)

        row.tap()
        XCTAssertTrue(element(app, "needs-you-detail").waitForExistence(timeout: 10))
        XCTAssertTrue(app.navigationBars["Decision"].waitForExistence(timeout: 5))
        // Context first, in this order, then the decision.
        let headings = ["Goal", "Where it stands", "Why it needs you"].map { labelled(app, $0) }
        XCTAssertTrue(headings.allSatisfy(\.exists), "Goal, state, and why come first")
        XCTAssertLessThan(headings[0].frame.minY, headings[1].frame.minY)
        XCTAssertLessThan(headings[1].frame.minY, headings[2].frame.minY)
        // No message bar of its own: replies go through the Supervisor composer.
        XCTAssertFalse(app.textFields["chat-composer"].exists)
        capture("needs-you-detail-dark", app: app)
        var sawReply = element(app, "needs-you-reply").exists
        for _ in 0..<5 where !element(app, "needs-you-conversation").isHittable {
            app.swipeUp()
            sawReply = sawReply || element(app, "needs-you-reply").exists
        }
        XCTAssertTrue(sawReply, "Reply in Supervisor chat is offered")
        XCTAssertTrue(element(app, "needs-you-conversation").isHittable, "Conversation and sources come last")
        capture("needs-you-detail-scrolled-dark", app: app)

        // Duo puts its native Back button in the vertical toolbar, outside
        // the navigation bar; ordinary iPhones keep it in the bar.
        let duoBack = app.buttons["BackButton"].firstMatch
        let back = duoBack.exists ? duoBack : app.navigationBars["Decision"].buttons.element(boundBy: 0)
        XCTAssertTrue(back.waitForExistence(timeout: 5), "Missing Back from Decision")
        back.tap()
        XCTAssertTrue(element(app, "needs-you-row-ny-deploy").waitForExistence(timeout: 5), "Back returns to the list")
        XCTAssertFalse(element(app, "needs-you-detail").exists)

        // Updates sit apart, collapsed, and open on request.
        let updates = element(app, "needs-you-updates")
        for _ in 0..<8 where !(updates.exists && updates.isHittable) { app.swipeUp() }
        XCTAssertTrue(updates.isHittable, "Updates toggle reachable")
        XCTAssertEqual(updates.value as? String, "Collapsed")
        updates.tap()
        let fyi = element(app, "needs-you-row-fyi-docs")
        for _ in 0..<4 where !fyi.exists { app.swipeUp() }
        XCTAssertTrue(fyi.waitForExistence(timeout: 5), "Updates open on request")
        capture("needs-you-updates-expanded-dark", app: app)
    }

    /// The largest accessibility text size: rows wrap instead of clipping,
    /// and the decision screen stays usable.
    func testAccessibilityTextSizeKeepsRowsAndDecisionReadable() {
        let app = launch(["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"])
        openNeedsYou(app)
        let row = element(app, "needs-you-row-ny-deploy")
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        XCTAssertTrue(row.isHittable)
        capture("needs-you-list-ax-xxxl", app: app)
        row.tap()
        XCTAssertTrue(element(app, "needs-you-detail").waitForExistence(timeout: 10))
        capture("needs-you-detail-ax-xxxl", app: app)
    }
}
