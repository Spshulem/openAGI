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

    /// The row sits inside the browser and clear of a search field floating
    /// over the list's bottom edge. A row's frame can reach past either.
    private func isClear(_ row: XCUIElement, in browser: XCUIElement, app: XCUIApplication) -> Bool {
        guard row.exists && row.isHittable else { return false }
        var bottom = browser.frame.maxY
        let search = app.searchFields.firstMatch
        if search.exists && search.frame.minY > row.frame.minY {
            bottom = min(bottom, search.frame.minY)
        }
        return row.frame.minY >= browser.frame.minY && row.frame.maxY <= bottom
    }

    private func openSupervisorConversation(_ app: XCUIApplication) {
        tapButton(app, "chat-conversations")
        let browser = element(app, "conversation-browser")
        XCTAssertTrue(browser.waitForExistence(timeout: 10), "Missing conversation-browser")
        let row = element(app, "conversation-supervisor")
        XCTAssertTrue(row.waitForExistence(timeout: 10), "Missing conversation-supervisor")
        // At the largest text sizes on a 6.9" iPhone the Supervisor row
        // starts below the fold, under the floating search field, with a
        // 33 pt sliver showing. XCTest tapped that sliver and the browser
        // stayed open. Scroll the row into the clear first, as a person
        // would. Short drags without a fling, so the row cannot overshoot
        // past the top.
        let lower = browser.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.65))
        let upper = browser.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.35))
        for _ in 0..<8 where !isClear(row, in: browser, app: app) {
            if row.exists && row.frame.minY < browser.frame.minY {
                upper.press(forDuration: 0.1, thenDragTo: lower)
            } else {
                lower.press(forDuration: 0.1, thenDragTo: upper)
            }
        }
        XCTAssertTrue(isClear(row, in: browser, app: app), "The Supervisor conversation can be scrolled fully into view")
        row.tap()
    }

    private func openNeedsYou(_ app: XCUIApplication) {
        tab(app, "Chat")
        openSupervisorConversation(app)
        // The #needs-you chip, not the navigation title: at the largest
        // accessibility sizes the bar's title is not exposed by name.
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

    // MARK: - Decision contract (`--ui-decision-view-fixture`)

    private func pipeTexts(in root: XCUIElement) -> XCUIElementQuery {
        root.descendants(matching: .staticText).matching(NSPredicate(format: "label CONTAINS %@", "|"))
    }

    private func scrollUntilHittable(_ target: XCUIElement, in app: XCUIApplication, attempts: Int = 6) {
        for _ in 0..<attempts where !(target.exists && target.isHittable) { app.swipeUp() }
    }

    private func backFromDecision(_ app: XCUIApplication) {
        let duoBack = app.buttons["BackButton"].firstMatch
        let back = duoBack.exists ? duoBack : app.navigationBars["Decision"].buttons.element(boundBy: 0)
        XCTAssertTrue(back.waitForExistence(timeout: 5), "Missing Back from Decision")
        back.tap()
    }

    /// The regression: a merge-or-wait decision once printed a raw PR table,
    /// internal routing, a recommendation that contradicted the primary
    /// button, duplicate option rows and a prefilled bypass reply. The card,
    /// the Thread sheet and the decision screen now show Goal, Status,
    /// Decision and Recommendation first, each option once, the recommended
    /// one tagged, the bypass captioned, and an empty reply composer.
    func testDecisionContractRegressionCardSparseAndOlderCards() {
        let app = launch(["--ui-decision-view-fixture"])
        tab(app, "Chat")
        openSupervisorConversation(app)

        // The deck card.
        let deck = element(app, "supervisor-card-deck")
        XCTAssertTrue(deck.waitForExistence(timeout: 10), "The decision deck is shown")
        XCTAssertTrue(labelled(app, "merge or wait").waitForExistence(timeout: 5), "The regression card leads")
        XCTAssertEqual(pipeTexts(in: deck).count, 0, "No raw Markdown table on the card")
        XCTAssertFalse(labelled(app, "paseo:").exists, "No internal routing on the card")
        let recommended = element(app, "supervisor-card-choice-0")
        XCTAssertTrue(recommended.waitForExistence(timeout: 5))
        XCTAssertEqual(recommended.label, "Wait for teammate review")
        XCTAssertTrue((recommended.value as? String ?? "").contains("Recommended"), "The recommended option is tagged")
        let bypass = element(app, "supervisor-card-choice-1")
        XCTAssertEqual(bypass.label, "Merge both")
        XCTAssertTrue((bypass.value as? String ?? "").contains("Admin bypass"), "The bypass is labelled plainly")
        XCTAssertFalse((bypass.value as? String ?? "").contains("Recommended"))
        // Scoped to this card: a wide layout can show the same decision in a
        // second pane, which is not a duplicated row on the card.
        let mergeButtons = deck.buttons.matching(NSPredicate(format: "label CONTAINS[c] %@", "Merge both"))
        if mergeButtons.count != 1 {
            let found = mergeButtons.allElementsBoundByIndex.map { "\($0.identifier) | \($0.label) | \($0.frame)" }.joined(separator: "\n")
            let attachment = XCTAttachment(string: "Merge both buttons on the card:\n\(found)\n\n\(deck.debugDescription)")
            attachment.name = "decision-regression-card-merge-buttons"
            attachment.lifetime = .keepAlways
            add(attachment)
        }
        XCTAssertEqual(mergeButtons.count, 1, "Merge both is offered once on the card")
        capture("decision-regression-card", app: app)

        // The Thread sheet: the contract, each option once, an empty composer.
        tapButton(app, "supervisor-card-review-fq_regression")
        let sheet = element(app, "supervisor-thread-details")
        XCTAssertTrue(sheet.waitForExistence(timeout: 10), "Details opens the Thread sheet")
        let contract = element(app, "decision-contract")
        XCTAssertTrue(contract.waitForExistence(timeout: 5), "The Thread sheet shows the decision contract")
        XCTAssertEqual(pipeTexts(in: contract).count, 0, "No raw Markdown table in the decision")
        capture("decision-regression-thread", app: app)
        let threadRecommended = element(app, "thread-decision-choice-0")
        scrollUntilHittable(threadRecommended, in: app)
        XCTAssertEqual(threadRecommended.label, "Wait for teammate review")
        XCTAssertTrue((threadRecommended.value as? String ?? "").contains("Recommended"))
        XCTAssertEqual(sheet.buttons.matching(NSPredicate(format: "label CONTAINS[c] %@", "Merge both")).count, 1, "Merge both is offered once in the Thread sheet")
        let reply = element(app, "thread-decision-reply")
        scrollUntilHittable(reply, in: app)
        reply.tap()
        let field = element(app, "thread-reply-field")
        XCTAssertTrue(field.waitForExistence(timeout: 5), "Reply opens the composer")
        let typed = field.value as? String ?? ""
        XCTAssertTrue(typed.isEmpty || typed == field.placeholderValue, "The reply composer opens empty, got: \(typed)")
        XCTAssertFalse(typed.localizedCaseInsensitiveContains("bypass"))
        capture("decision-regression-thread-reply", app: app)
        // Opening the composer scrolls the sheet: cancel the reply, then
        // close the sheet from its Done button (scrolled back into view) or
        // by swiping it down.
        let cancel = app.buttons["Cancel"].firstMatch
        if cancel.exists && cancel.isHittable { cancel.tap() }
        let done = app.buttons["Done"].firstMatch
        for _ in 0..<4 where !(done.exists && done.isHittable) { sheet.swipeDown() }
        if done.exists && done.isHittable { done.tap() }
        XCTAssertTrue(deck.waitForExistence(timeout: 10), "Back on the deck after closing the Thread sheet")

        // The other cards on the deck.
        for index in 2...4 {
            let next = app.buttons["Next decision"].firstMatch
            guard next.waitForExistence(timeout: 5), next.isHittable else { break }
            next.tap()
            capture("decision-deck-card-\(index)", app: app)
        }

        // The decision screens.
        tapButton(app, "supervisor-channel-needs-you")
        tapButton(app, "needs-you-row-fq_regression")
        XCTAssertTrue(element(app, "needs-you-detail").waitForExistence(timeout: 10))
        let sections = ["goal", "status", "decision", "recommendation"].map { element(app, "decision-section-\($0)") }
        XCTAssertTrue(sections[0].waitForExistence(timeout: 5), "Goal comes first")
        XCTAssertEqual(pipeTexts(in: app).count, 0, "No raw Markdown table on the decision screen")
        XCTAssertFalse(labelled(app, "paseo:").exists, "No internal routing on the decision screen")
        capture("decision-regression-detail", app: app)
        // The screen is a lazy List: each section is checked as it scrolls in.
        for (index, name) in ["Status", "Decision", "Recommendation"].enumerated() {
            scrollUntilHittable(sections[index + 1], in: app)
            XCTAssertTrue(sections[index + 1].exists, "\(name) is shown")
        }
        let detailRecommended = element(app, "needs-you-action-0")
        scrollUntilHittable(detailRecommended, in: app)
        XCTAssertEqual(detailRecommended.label, "Wait for teammate review")
        XCTAssertTrue((detailRecommended.value as? String ?? "").contains("Recommended"))
        let detailBypass = element(app, "needs-you-action-1")
        XCTAssertEqual(detailBypass.label, "Merge both")
        XCTAssertTrue((detailBypass.value as? String ?? "").contains("Admin bypass"))
        XCTAssertEqual(element(app, "needs-you-detail").buttons.matching(NSPredicate(format: "label CONTAINS[c] %@", "Merge both")).count, 1, "Merge both is offered once on the decision screen")
        XCTAssertFalse(app.textFields["chat-composer"].exists, "Replies go through the Supervisor composer")
        capture("decision-regression-detail-scrolled", app: app)
        backFromDecision(app)

        // Sparse: every section is shown and labelled, nothing invented.
        tapButton(app, "needs-you-row-fq_sparse")
        XCTAssertTrue(element(app, "needs-you-detail").waitForExistence(timeout: 10))
        XCTAssertTrue(element(app, "decision-section-goal").waitForExistence(timeout: 5))
        XCTAssertTrue(labelled(app, "Not stated").exists, "Unknown sections read Not stated")
        capture("decision-sparse-detail", app: app)
        app.swipeUp()
        capture("decision-sparse-detail-scrolled", app: app)
        backFromDecision(app)

        // Unknown recommendation: no option is promoted, the bypass is labelled.
        tapButton(app, "needs-you-row-fq_old")
        XCTAssertTrue(element(app, "needs-you-detail").waitForExistence(timeout: 10))
        capture("decision-older-detail", app: app)
        let oldFirst = element(app, "needs-you-action-0")
        scrollUntilHittable(oldFirst, in: app)
        XCTAssertFalse((oldFirst.value as? String ?? "").contains("Recommended"))
        XCTAssertFalse((element(app, "needs-you-action-1").value as? String ?? "").contains("Recommended"))
        capture("decision-older-detail-scrolled", app: app)
        backFromDecision(app)

        // An older hub (no decisionView): the previous rendering.
        tapButton(app, "needs-you-row-fq_legacy")
        XCTAssertTrue(element(app, "needs-you-detail").waitForExistence(timeout: 10))
        XCTAssertFalse(element(app, "decision-section-goal").exists, "Older cards keep their previous rendering")
        capture("decision-legacy-detail", app: app)
    }

    // MARK: - Asks with several questions (`--ui-question-items-fixture`)

    /// Group answers that once hid ten separate decisions: never a button
    /// or a label anywhere on these screens.
    private func assertNoGroupAnswer(_ app: XCUIApplication, _ screen: String) {
        for phrase in ["Approve recommended", "Answer all", "Accept recommendations", "Approve all"] {
            XCTAssertFalse(labelled(app, phrase).exists, "\(screen): no \"\(phrase)\"")
        }
    }

    private func value(_ element: XCUIElement) -> String { element.value as? String ?? "" }

    /// The release ask with ten questions: the card lists each question with
    /// its state and offers "Review 10 questions"; the walkthrough shows one
    /// question at a time, keeps picks as drafts, and sends only what was
    /// answered or skipped. The partially answered ask shows Delivered,
    /// Failed (answer kept, Retry) and Skipped; a single question keeps its
    /// options; nothing anywhere approves the recommendations in bulk.
    func testQuestionWalkthroughAnswersTwoSkipsOneAndShowsItemStates() {
        let app = launch(["--ui-question-items-fixture"])
        tab(app, "Chat")
        openSupervisorConversation(app)

        // The deck card.
        let deck = element(app, "supervisor-card-deck")
        XCTAssertTrue(deck.waitForExistence(timeout: 10), "The decision deck is shown")
        let review = element(app, "supervisor-card-review-items-fq_release")
        for _ in 0..<4 where !review.waitForExistence(timeout: 2) {
            let next = app.buttons["Next decision"].firstMatch
            guard next.exists, next.isHittable else { break }
            next.tap()
        }
        XCTAssertTrue(review.waitForExistence(timeout: 5), "The ten-question card offers a walkthrough")
        XCTAssertEqual(review.label, "Review 10 questions")
        XCTAssertTrue(element(app, "question-items-compact").exists, "Each question is listed on the card")
        XCTAssertTrue(element(app, "question-item-row-1").exists)
        XCTAssertEqual(value(element(app, "question-item-row-1")), "Not answered")
        XCTAssertTrue(element(app, "supervisor-card-secondary-fq_release").exists, "Later is offered")
        assertNoGroupAnswer(app, "card")
        capture("question-items-card", app: app)

        // The walkthrough: one question per page.
        review.tap()
        XCTAssertTrue(element(app, "question-walkthrough").waitForExistence(timeout: 10), "Review opens the walkthrough")
        let progress = element(app, "question-walkthrough-progress")
        XCTAssertTrue(progress.waitForExistence(timeout: 5))
        XCTAssertEqual(progress.label, "1 of 10")
        let send = element(app, "question-walkthrough-send")
        XCTAssertFalse(send.isEnabled, "Nothing to send before an answer")

        // 1: typed answer.
        let field = element(app, "question-free-text")
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap()
        field.typeText("Alex and Sam")
        tapButton(app, "question-walkthrough-next")
        XCTAssertEqual(progress.label, "2 of 10")

        // 2: skipped (stays open).
        tapButton(app, "question-walkthrough-skip")
        XCTAssertEqual(progress.label, "3 of 10")

        // 3: a choice; the recommendation is text and nothing is preselected.
        XCTAssertTrue(element(app, "question-walkthrough-recommendation").exists, "The agent's recommendation is shown")
        let choice = element(app, "question-choice-1")
        XCTAssertTrue(choice.waitForExistence(timeout: 5))
        XCTAssertEqual(choice.label, "Separate documents")
        XCTAssertFalse(value(choice).contains("Selected"), "A recommendation never preselects a choice")
        XCTAssertFalse(value(element(app, "question-choice-0")).contains("Selected"))
        choice.tap()
        XCTAssertTrue(value(choice).contains("Selected"), "A tapped choice is the draft")
        assertNoGroupAnswer(app, "walkthrough")
        capture("question-walkthrough-page", app: app)

        XCTAssertEqual(send.label, "Send 2 answers, skip 1")
        send.tap()
        let state = element(app, "question-walkthrough-state")
        let delivered = NSPredicate(format: "label == %@", "Delivered")
        expectation(for: delivered, evaluatedWith: state)
        waitForExpectations(timeout: 10)
        XCTAssertTrue(element(app, "question-walkthrough-sent").exists, "A delivered answer is read-only")
        XCTAssertFalse(element(app, "question-choice-1").exists, "No choices on a delivered question")
        capture("question-walkthrough-sent", app: app)
        tapButton(app, "question-walkthrough-back")
        tapButton(app, "question-walkthrough-back")
        XCTAssertEqual(state.label, "Sent, waiting to be delivered", "A typed answer waits for the Mac")
        tapButton(app, "question-walkthrough-done")

        // Back on the card: each item's state, the rest still open.
        XCTAssertTrue(review.waitForExistence(timeout: 10))
        let reviewEight = NSPredicate(format: "label == %@", "Review 8 questions")
        expectation(for: reviewEight, evaluatedWith: review)
        waitForExpectations(timeout: 10)
        XCTAssertEqual(value(element(app, "question-item-row-1")), "Queued")
        XCTAssertEqual(value(element(app, "question-item-row-2")), "Skipped")
        XCTAssertEqual(value(element(app, "question-item-row-3")), "Delivered")
        XCTAssertEqual(value(element(app, "question-item-row-4")), "Not answered")
        assertNoGroupAnswer(app, "card after sending")
        capture("question-items-card-after-send", app: app)

        // The partially answered ask on the decision screen.
        tapButton(app, "supervisor-channel-needs-you")
        tapButton(app, "needs-you-row-fq_release_partial")
        XCTAssertTrue(element(app, "needs-you-detail").waitForExistence(timeout: 10))
        let detailReview = element(app, "needs-you-review-items")
        scrollUntilHittable(detailReview, in: app, attempts: 8)
        XCTAssertEqual(detailReview.label, "Review 9 questions")
        XCTAssertFalse(element(app, "needs-you-action-0").exists, "No group answer buttons")
        let failed = element(app, "needs-you-question-item-full-4")
        scrollUntilHittable(failed, in: app, attempts: 10)
        XCTAssertEqual(value(failed), "Failed")
        XCTAssertTrue(failed.label.contains("Yes"), "The failed answer is kept")
        XCTAssertEqual(value(element(app, "needs-you-question-item-full-3")), "Delivered")
        XCTAssertEqual(value(element(app, "needs-you-question-item-full-1")), "Skipped")
        assertNoGroupAnswer(app, "decision screen")
        capture("question-items-partial-detail", app: app)
        let retry = element(app, "needs-you-question-item-retry-4")
        XCTAssertTrue(retry.exists, "A failed answer offers Retry")
        retry.tap()
        let nowDelivered = NSPredicate(format: "value == %@", "Delivered")
        expectation(for: nowDelivered, evaluatedWith: failed)
        waitForExpectations(timeout: 10)
        capture("question-items-partial-detail-retried", app: app)
        backFromDecision(app)

        // A single question keeps the decision contract and its options.
        tapButton(app, "needs-you-row-fq_single")
        XCTAssertTrue(element(app, "needs-you-detail").waitForExistence(timeout: 10))
        let deploy = element(app, "needs-you-action-0")
        scrollUntilHittable(deploy, in: app, attempts: 8)
        XCTAssertEqual(deploy.label, "Deploy")
        XCTAssertFalse(element(app, "needs-you-review-items").exists, "No walkthrough for a single question")
        backFromDecision(app)

        // A completed FYI carrying items is an update, never a walkthrough.
        let updates = element(app, "needs-you-updates")
        for _ in 0..<8 where !(updates.exists && updates.isHittable) { app.swipeUp() }
        if updates.exists && updates.isHittable {
            updates.tap()
            let fyi = element(app, "needs-you-row-fq_fyi_done")
            for _ in 0..<4 where !fyi.exists { app.swipeUp() }
            XCTAssertTrue(fyi.waitForExistence(timeout: 5), "The completion sits under Updates")
            fyi.tap()
            XCTAssertTrue(element(app, "needs-you-detail").waitForExistence(timeout: 10))
            XCTAssertFalse(element(app, "needs-you-review-items").exists, "A completion never offers the walkthrough")
            XCTAssertFalse(element(app, "question-items-compact").exists)
        } else {
            XCTFail("Updates toggle reachable")
        }
    }
}
