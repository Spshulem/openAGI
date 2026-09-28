package sh.openagi.mobile.sync

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import sh.openagi.mobile.protocol.FleetQuestion

class SupervisorAlertsTest {
    private fun question(id: String, title: String? = "T $id", body: String? = null, options: List<String> = emptyList()) =
        FleetQuestion(id = id, title = title, body = body, options = options)

    @Test
    fun postsOnlyOpenQuestionsNotAlreadyNotifiedInServerOrder() {
        val plan = SupervisorAlerts.plan(
            open = listOf(question("fq_c"), question("fq_a"), question("fq_b")),
            notified = setOf("fq_a"),
        )
        assertEquals(listOf("fq_c", "fq_b"), plan.post.map { it.id })
        assertEquals(emptyList<String>(), plan.cancel)
    }

    // A question the owner already swiped away must not ping again on the
    // next check: "notified" is the memory that stops that.
    @Test
    fun nothingToDoWhenEveryOpenQuestionWasAlreadyNotified() {
        val plan = SupervisorAlerts.plan(listOf(question("fq_a")), setOf("fq_a"))
        assertTrue(plan.post.isEmpty())
        assertTrue(plan.cancel.isEmpty())
    }

    @Test
    fun cancelsNotifiedQuestionsThatAreNoLongerOpen() {
        val plan = SupervisorAlerts.plan(
            open = listOf(question("fq_b")),
            notified = linkedSetOf("fq_a", "fq_b", "fq_c"),
        )
        assertTrue(plan.post.isEmpty())
        assertEquals(listOf("fq_a", "fq_c"), plan.cancel)
    }

    @Test
    fun anEmptyOpenListCancelsEverything() {
        val plan = SupervisorAlerts.plan(emptyList(), linkedSetOf("fq_a", "fq_b"))
        assertEquals(listOf("fq_a", "fq_b"), plan.cancel)
    }

    // FleetQuestion.id defaults to "" when the daemon omits it; a blank id can
    // neither be answered nor remembered, so it never becomes a notification.
    @Test
    fun blankIdsAreNeverPosted() {
        val plan = SupervisorAlerts.plan(listOf(question(""), question("  "), question("fq_a")), emptySet())
        assertEquals(listOf("fq_a"), plan.post.map { it.id })
    }

    @Test
    fun aDuplicatedIdPostsOnce() {
        val plan = SupervisorAlerts.plan(listOf(question("fq_a"), question("fq_a")), emptySet())
        assertEquals(listOf("fq_a"), plan.post.map { it.id })
    }

    // A backlog (first run, or a phone that was off for a day) must not fire
    // a wall of pings at once; the rest post on the following checks.
    @Test
    fun postsAtMostFivePerCallAndTheRestOnTheNext() {
        val open = (1..8).map { question("fq_$it") }
        val first = SupervisorAlerts.plan(open, emptySet())
        assertEquals((1..5).map { "fq_$it" }, first.post.map { it.id })
        val second = SupervisorAlerts.plan(open, first.post.map { it.id }.toSet())
        assertEquals((6..8).map { "fq_$it" }, second.post.map { it.id })
    }

    @Test
    fun notificationIdIsStablePositiveAndClearOfTheAppsFixedIds() {
        // "ϩ".hashCode() == 1001 and "\u0000".hashCode() == 0: the two raw
        // hashes a naive `hashCode() and MAX_VALUE` would hand straight back as
        // the ongoing notification's id, or as a non-positive one.
        val ids = listOf("fq_a", "fq_b", "ϩ", "\u0000", "zzzzzzzzzzzz", "fq_" + "x".repeat(77)) +
            (0 until 2_000).map { "fq_$it" }
        ids.forEach { id ->
            val value = SupervisorAlerts.notificationId(id)
            assertTrue("$id -> $value must be positive", value > 0)
            assertNotEquals("$id must not take the ongoing id", 1001, value)
            assertTrue("$id -> $value must sit above the reserved range", value >= SupervisorAlerts.FIRST_QUESTION_ID)
            assertEquals(value, SupervisorAlerts.notificationId(id))
        }
        assertNotEquals(SupervisorAlerts.notificationId("fq_a"), SupervisorAlerts.notificationId("fq_b"))
    }

    // The answer must be exactly one of the question's own options (the route
    // checks options.includes(answer)), so the text is passed through as-is.
    @Test
    fun actionOptionsDropDismissBlanksAndDuplicatesAndCapAtThree() {
        val q = question("fq_a", options = listOf("dismiss", "Retry", " ", "DISMISS", "Retry", "Merge", " Dismiss ", "Skip", "Later"))
        assertEquals(listOf("Retry", "Merge", "Skip"), SupervisorAlerts.actionOptions(q))
    }

    @Test
    fun actionOptionsKeepTheExactOptionText() {
        val q = question("fq_a", options = listOf(" yes "))
        assertEquals(listOf(" yes "), SupervisorAlerts.actionOptions(q))
    }

    @Test
    fun aQuestionWithNoRealOptionsHasNoButtons() {
        assertEquals(emptyList<String>(), SupervisorAlerts.actionOptions(question("fq_a", options = listOf("dismiss"))))
        assertEquals(emptyList<String>(), SupervisorAlerts.actionOptions(question("fq_a")))
    }

    @Test
    fun titleIsTrimmedWithAFallback() {
        assertEquals("CI failing on #112", SupervisorAlerts.title(question("fq_a", title = "  CI failing on #112 \n")))
        assertEquals("Needs you", SupervisorAlerts.title(question("fq_a", title = null)))
        assertEquals("Needs you", SupervisorAlerts.title(question("fq_a", title = "   ")))
    }

    @Test
    fun titleIsCappedAtOneHundredCharacters() {
        val title = SupervisorAlerts.title(question("fq_a", title = "a".repeat(300)))
        assertEquals(100, title.length)
        assertTrue(title.endsWith("…"))
        assertEquals("a".repeat(100), SupervisorAlerts.title(question("fq_a", title = "a".repeat(100))))
    }

    @Test
    fun textIsTrimmedEmptyWhenMissingAndCappedAt220() {
        assertEquals("", SupervisorAlerts.text(question("fq_a", body = null)))
        assertEquals("Pick one.", SupervisorAlerts.text(question("fq_a", body = "\n Pick one.  ")))
        val text = SupervisorAlerts.text(question("fq_a", body = "b".repeat(1_000)))
        assertEquals(220, text.length)
        assertTrue(text.endsWith("…"))
    }

    // Cutting between the two halves of a surrogate pair would put a lone
    // surrogate (drawn as a broken glyph) right before the ellipsis.
    @Test
    fun cappingNeverSplitsAnEmoji() {
        val body = "a".repeat(218) + "😀" + "tail"
        val text = SupervisorAlerts.text(question("fq_a", body = body))
        assertTrue(text.length <= 220)
        assertTrue(text.endsWith("…"))
        assertTrue(!Character.isHighSurrogate(text[text.length - 2]))
    }
}
