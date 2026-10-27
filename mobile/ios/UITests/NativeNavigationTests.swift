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
        // On Duo, walking every accessibility type can stall while resolving
        // system toolbar snapshots. Settings is a native button; query it as one.
        let target = id == "open-settings" ? app.buttons[id] : element(app, id)
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
        XCTAssertTrue(target.isHittable, "Not hittable: \(title) tab")
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

    func testNativeAdaptiveTabsAndOptionalChatPane() {
        let app = launch()
        XCTAssertFalse(element(app, "right-navigation").exists, "Use the system tab container in every pose")
        let toggle = app.buttons["toggle-chat-pane"]
        if toggle.exists && toggle.isHittable {
            toggle.tap()
            let close = app.buttons["close-chat-pane"]
            XCTAssertTrue(close.waitForExistence(timeout: 5))
            XCTAssertTrue(close.isHittable, "Supporting chat must keep its Close button visible")
            tab(app, "Tasks")
            XCTAssertTrue(close.waitForExistence(timeout: 5), "Pinned chat stays open while navigating")
            XCTAssertTrue(close.isHittable, "Close must stay accessible after switching tabs")
            capture("native-supporting-chat", app: app)
            close.tap()
            XCTAssertFalse(close.exists)
            capture("native-supporting-chat-closed", app: app)
        }
        tab(app, "Chat")
        XCTAssertTrue(app.navigationBars["Chat"].waitForExistence(timeout: 5))
        XCTAssertFalse(element(app, "supporting-chat-pane").exists, "Chat must not open a second conversation")
        capture("native-adaptive-tabs-chat", app: app)
    }

    func testTabNavigationHistorySurvivesSwitchingTabs() {
        let app = launch()
        // Lifelog is a push on Today's own stack, rather than a sheet.
        app.buttons["Lifelog"].firstMatch.tap()
        XCTAssertTrue(app.navigationBars["Lifelog"].waitForExistence(timeout: 5))
        tab(app, "Tasks")
        XCTAssertTrue(app.navigationBars["Tasks"].waitForExistence(timeout: 5))
        tab(app, "Today")
        XCTAssertTrue(app.navigationBars["Lifelog"].waitForExistence(timeout: 5))
        back(app, from: "Lifelog", to: "Today")
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

    func testQuestionOpensReadOnlyThreadActivityWithoutSubmittingAnAnswer() {
        let app = launch()
        tab(app, "Supervisor")
        XCTAssertTrue(element(app, "supervisor-question-context-context-fixture").waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["yes"].exists, "Read the full context before a thread decision")
        XCTAssertFalse(app.buttons["no"].exists)
        XCTAssertFalse(app.buttons["open thread"].exists, "Opening a thread must be navigation")
        tap(app, "supervisor-question-context-context-fixture")
        XCTAssertTrue(app.navigationBars["Thread"].waitForExistence(timeout: 10))
        let details = element(app, "supervisor-thread-details")
        XCTAssertTrue(details.waitForExistence(timeout: 5))
        let question = details.staticTexts["Read the recent activity before choosing a response."]
        XCTAssertTrue(question.waitForExistence(timeout: 5))
        XCTAssertTrue(question.isHittable, "The sheet must receive its full question on first presentation")
        let message = details.staticTexts["The synthetic change is ready for your review. Nothing has been sent."]
        for _ in 0..<4 {
            if message.exists && message.isHittable { break }
            app.swipeUp()
        }
        XCTAssertTrue(message.waitForExistence(timeout: 10))
        XCTAssertTrue(details.staticTexts["Explain the synthetic change before I decide."].exists)
        XCTAssertFalse(app.staticTexts["Not sent. Couldn't reach the agent"].exists)
        capture("native-thread-context", app: app)
        tap(app, "supervisor-read-conversation", in: "supervisor-thread-details")
        XCTAssertTrue(app.navigationBars["Conversation"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Show the earlier synthetic request."].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["Here is the earlier synthetic explanation."].exists)
        capture("native-thread-conversation", app: app)
        back(app, from: "Conversation", to: "Thread")
        XCTAssertTrue(question.exists, "Reading conversation history must retain the decision")
        let yes = details.buttons["yes"]
        for _ in 0..<6 {
            if yes.exists && yes.isHittable { break }
            details.swipeUp()
        }
        XCTAssertTrue(yes.exists && yes.isHittable, "A thread decision must remain answerable after reading its activity")
        XCTAssertTrue(details.buttons["no"].isHittable)
        XCTAssertFalse(app.buttons["open thread"].exists)
        capture("native-thread-decision", app: app)
        // Duo scrolls the sheet's native navigation controls with the list.
        // Return to its toolbar after reading the activity and responses.
        let done = app.buttons["Done"]
        for _ in 0..<6 {
            if done.exists && done.isHittable { break }
            details.swipeDown()
        }
        XCTAssertTrue(done.exists && done.isHittable)
        done.tap()
        XCTAssertTrue(element(app, "supervisor-question-context-context-fixture").waitForExistence(timeout: 5))
    }

    func testShortBubblesStayCompactAndLongMarkdownWrapsWithoutClipping() {
        let app = launch(["--ui-long-chat"])
        tab(app, "Chat")
        let yes = app.staticTexts["yes"]
        XCTAssertTrue(yes.waitForExistence(timeout: 10))
        let bubble = element(app, "chat-bubble-user")
        XCTAssertTrue(bubble.exists)
        XCTAssertLessThan(bubble.frame.width, 120, "A short answer must use its natural bubble width")
        let text = "This synthetic list item explains the context of a decision in enough detail to wrap naturally across several lines on a phone, including a cover display or one page of a book layout. The entire explanation must remain readable before anyone makes a decision."
        // XCTest's identifier subscript rejects strings over 128 characters.
        // Match the full label without shortening the content under test.
        let bullet = app.staticTexts.matching(NSPredicate(format: "label == %@", text)).firstMatch
        XCTAssertTrue(bullet.waitForExistence(timeout: 10))
        XCTAssertGreaterThan(bullet.frame.height, 50, "The long list item must wrap into multiple lines")
        XCTAssertTrue(app.staticTexts["The final synthetic paragraph remains readable."].exists)
        capture("native-long-chat", app: app)
    }

    func testNativeComposerHistoryKeyboardDraftContinuityAndSending() {
        let app = launch()
        tab(app, "Chat")
        XCTAssertTrue(app.staticTexts["Earlier synthetic answer"].waitForExistence(timeout: 10))
        let composer = element(app, "chat-composer")
        XCTAssertTrue(composer.exists)
        XCTAssertGreaterThan(composer.frame.minY, app.frame.midY,
                             "The composer belongs below history, not over its first message")
        composer.tap()
        composer.typeText("A synthetic message")
        // Keep keyboard assertions scoped to the native control rather
        // than enumerating every accessibility element in the workspace.
        let send = app.buttons["chat-send"]
        XCTAssertTrue(send.isEnabled && send.isHittable)
        if app.keyboards.firstMatch.waitForExistence(timeout: 3) {
            XCTAssertLessThanOrEqual(send.frame.maxY, app.keyboards.firstMatch.frame.minY)
        }
        capture("native-chat-keyboard", app: app)
        // Duo hides system navigation while the keyboard is open. Swipe
        // inside the visible history, rather than the first workspace scroll
        // view: its bounds can extend under the keyboard and tap a suggestion.
        let history = element(app, "chat-history")
        let visible = history.frame.intersection(app.frame)
        let keyboard = app.keyboards.firstMatch
        if keyboard.exists {
            let bottom = min(visible.maxY, keyboard.frame.minY)
            let top = visible.minY
            XCTAssertGreaterThan(bottom - top, 40)
            let origin = app.coordinate(withNormalizedOffset: .zero)
            let start = origin.withOffset(CGVector(dx: visible.midX, dy: top + (bottom - top) * 0.2))
            let end = origin.withOffset(CGVector(dx: visible.midX, dy: app.frame.maxY - 24))
            start.press(forDuration: 0.1, thenDragTo: end)
            let dismissed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: keyboard)
            XCTAssertEqual(XCTWaiter.wait(for: [dismissed], timeout: 5), .completed)
        }
        tab(app, "Tasks")
        tab(app, "Chat")
        XCTAssertEqual(element(app, "chat-composer").value as? String, "A synthetic message")
        send.tap()
        XCTAssertTrue(app.staticTexts["Synthetic reply"].waitForExistence(timeout: 10))
        XCTAssertNotEqual(element(app, "chat-composer").value as? String, "A synthetic message")
        XCTAssertFalse(app.buttons["chat-send"].isEnabled, "Sending clears and resets the native editor")
        capture("native-chat", app: app)
    }

    func testModelLoadFailureExplainsMainUpdateAndRetryRestoresThePicker() {
        let app = launch(["--ui-model-first-fails"])
        tap(app, "open-settings")
        tap(app, "settings-model", in: "settings-form")
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "Update the main server")).firstMatch.waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["model-direct-chat"].exists, "Phone model choices remain available")
        tap(app, "model-retry")
        XCTAssertTrue(element(app, "model-provider").waitForExistence(timeout: 10))
        capture("native-model-retry", app: app)
    }

    func testHistoryOpensAtBottomAndJumpToLatestDisappearsAfterUseAndSend() {
        let app = launch(["--ui-scroll-chat"])
        tab(app, "Chat")
        let latest = app.staticTexts["Latest synthetic message"]
        XCTAssertTrue(latest.waitForExistence(timeout: 10))
        let atBottom = XCTNSPredicateExpectation(predicate: NSPredicate(format: "hittable == true"), object: latest)
        XCTAssertEqual(XCTWaiter.wait(for: [atBottom], timeout: 10), .completed)
        XCTAssertFalse(app.buttons["chat-jump-latest"].exists)
        let history = element(app, "chat-history")
        history.swipeDown()
        history.swipeDown()
        XCTAssertTrue(app.buttons["chat-jump-latest"].waitForExistence(timeout: 5))
        tap(app, "chat-jump-latest")
        let jumpGone = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: app.buttons["chat-jump-latest"])
        XCTAssertEqual(XCTWaiter.wait(for: [jumpGone], timeout: 10), .completed)
        tap(app, "chat-composer")
        element(app, "chat-composer").typeText("Read the newest message")
        tap(app, "chat-send")
        let reply = app.staticTexts["Synthetic reply"]
        XCTAssertTrue(reply.waitForExistence(timeout: 10))
        let replyVisible = XCTNSPredicateExpectation(predicate: NSPredicate(format: "hittable == true"), object: reply)
        XCTAssertEqual(XCTWaiter.wait(for: [replyVisible], timeout: 10), .completed)
        XCTAssertFalse(app.buttons["chat-jump-latest"].exists)
        XCTAssertFalse(app.buttons["chat-send"].isEnabled)
        capture("native-chat-follow-latest", app: app)
    }

    func testImagesCanBeRemovedAndSentWithTheirPixelsInChatAndSupervisor() {
        let app = launch(["--ui-attachment-fixture"])
        tab(app, "Chat")
        for thread in ["agent", "supervisor"] {
            if thread == "supervisor" {
                tab(app, "Supervisor")
                let composer = element(app, "chat-composer")
                if !composer.exists || !composer.isHittable {
                    let ask = app.buttons["Ask supervisor"].firstMatch
                    XCTAssertTrue(ask.waitForExistence(timeout: 10))
                    ask.tap()
                }
            }
            tap(app, "chat-attach")
            XCTAssertTrue(app.buttons["Photo Library"].exists)
            XCTAssertTrue(app.buttons["Choose Image File"].exists)
            app.buttons["Attach synthetic image"].tap()
            XCTAssertTrue(element(app, "chat-draft-image").waitForExistence(timeout: 10))
            tap(app, "chat-remove-image")
            XCTAssertFalse(element(app, "chat-draft-image").exists)
            tap(app, "chat-attach")
            app.buttons["Attach synthetic image"].tap()
            XCTAssertTrue(element(app, "chat-draft-image").waitForExistence(timeout: 10))
            tap(app, "chat-send")
            XCTAssertTrue(app.staticTexts["Synthetic image received in \(thread)"].waitForExistence(timeout: 10))
            XCTAssertFalse(element(app, "chat-draft-image").exists)
            XCTAssertTrue(element(app, "chat-message-image").exists)
            XCTAssertFalse(app.buttons["chat-send"].isEnabled)
            capture("native-image-\(thread)", app: app)
        }
    }

    func testChatModelSheetDismissesBackToTheSameConversation() {
        let app = launch()
        tab(app, "Chat")
        XCTAssertTrue(app.staticTexts["Earlier synthetic answer"].waitForExistence(timeout: 10))
        tap(app, "chat-model")
        XCTAssertTrue(app.navigationBars["Model"].waitForExistence(timeout: 5))
        app.buttons["Done"].tap()
        XCTAssertTrue(app.navigationBars["Chat"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Earlier synthetic answer"].exists)
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
        XCTAssertTrue(app.buttons["chat-send"].isHittable)
        capture("native-chat-accessibility-dark", app: app)
    }
}
