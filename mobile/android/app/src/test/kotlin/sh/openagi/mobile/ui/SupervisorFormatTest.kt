package sh.openagi.mobile.ui

import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import sh.openagi.mobile.protocol.FleetAction
import sh.openagi.mobile.protocol.FleetCi
import sh.openagi.mobile.protocol.FleetDelivery
import sh.openagi.mobile.protocol.FleetPr
import sh.openagi.mobile.protocol.FleetSnapshot
import sh.openagi.mobile.protocol.FleetState
import sh.openagi.mobile.protocol.FleetThread
import java.time.Instant

class SupervisorFormatTest {
    private val now = Instant.parse("2026-09-27T10:00:00Z")

    private fun thread(key: String, state: String, minutesAgo: Long? = null, workspace: String? = null) = FleetThread(
        key = key,
        state = state,
        workspace = workspace,
        lastActivityAt = minutesAgo?.let { now.minusSeconds(it * 60) },
    )

    @Test
    fun threadsSortRedYellowGreenGrayThenMostRecentFirst() {
        val sorted = SupervisorFormat.sorted(
            listOf(
                thread("gray", "excluded", 1),
                thread("green-old", "running", 30),
                thread("yellow", "pr-not-ready", 5),
                thread("green-new", "waiting-ci", 2),
                thread("red", "needs-human", 90),
                thread("green-undated", "done"),
            ),
        )
        assertEquals(listOf("red", "yellow", "green-new", "green-old", "green-undated", "gray"), sorted.map { it.key })
    }

    @Test
    fun theDaemonsHealthDrivesTheSortWhenPresent() {
        val sorted = SupervisorFormat.sorted(
            listOf(FleetThread(key = "a", state = "running", health = "green"), FleetThread(key = "b", state = "running", health = "red")),
        )
        assertEquals(listOf("b", "a"), sorted.map { it.key })
    }

    @Test
    fun summaryCountsEachColourAndLeavesOutZeros() {
        val threads = listOf(
            thread("a", "needs-human"), thread("b", "infra-blocked"), thread("c", "pr-not-ready"),
            thread("d", "running"), thread("e", "running"), thread("f", "done"),
        )
        assertEquals("2 red · 1 yellow · 3 green", SupervisorFormat.summary(threads))
        assertEquals("", SupervisorFormat.summary(emptyList()))
    }

    @Test
    fun aThreadIsNamedByWorkspaceThenTitleThenKey() {
        assertEquals("amman", SupervisorFormat.name(FleetThread(key = "k", workspace = "amman", title = "Fix it")))
        assertEquals("Fix it", SupervisorFormat.name(FleetThread(key = "k", workspace = " ", title = "Fix it")))
        assertEquals("k", SupervisorFormat.name(FleetThread(key = "k")))
        assertEquals("Untitled thread", SupervisorFormat.name(FleetThread()))
    }

    @Test
    fun statesReadAsPlainWords() {
        assertEquals("Needs you", SupervisorFormat.stateLabel("needs-human"))
        assertEquals("Waiting on CI", SupervisorFormat.stateLabel("waiting-ci"))
        assertEquals("Out of scope", SupervisorFormat.stateLabel("excluded"))
        assertEquals("Brand new state", SupervisorFormat.stateLabel("brand-new-state"))
        assertEquals("Unknown", SupervisorFormat.stateLabel(null))
    }

    @Test
    fun thePrChipIsTheNumberAndCiState() {
        val pr = FleetPr(ref = "openagi/openagi#112", ci = FleetCi(state = "FAILURE", failing = listOf("unit")))
        assertEquals("#112 · CI failing", SupervisorFormat.prChip(pr))
        assertEquals("#7", SupervisorFormat.prChip(FleetPr(ref = "a/b#7")))
        assertEquals("#7 · CI passing", SupervisorFormat.prChip(FleetPr(ref = "a/b#7", ci = FleetCi(state = "SUCCESS"))))
        assertEquals("#7 · CI running", SupervisorFormat.prChip(FleetPr(ref = "a/b#7", ci = FleetCi(state = "PENDING"))))
        assertNull(SupervisorFormat.prChip(null))
        assertNull(SupervisorFormat.prChip(FleetPr(ref = null)))
        assertTrue(SupervisorFormat.ciFailing(pr.ci))
        assertFalse(SupervisorFormat.ciFailing(FleetCi(state = "SUCCESS")))
    }

    @Test
    fun onlyAGithubPullRequestUrlOpensOtherwiseOneIsBuiltFromTheRef() {
        assertEquals(
            "https://github.com/a/b/pull/7",
            SupervisorFormat.prUrl(FleetPr(ref = "a/b#7", url = "https://github.com/a/b/pull/7")),
        )
        assertEquals("https://github.com/a/b/pull/7", SupervisorFormat.prUrl(FleetPr(ref = "a/b#7", url = null)))
        assertEquals("https://github.com/a/b/pull/7", SupervisorFormat.prUrl(FleetPr(ref = "a/b#7", url = "javascript:alert(1)")))
        assertNull(SupervisorFormat.prUrl(FleetPr(ref = "not a ref", url = "http://example.com")))
    }

    @Test
    fun deliveryNotesSayWhatHappened() {
        assertEquals(SupervisorFormat.Note("Sent to the agent.", false), SupervisorFormat.deliveryNote(FleetDelivery(status = "sent"), "Answered."))
        assertEquals(
            SupervisorFormat.Note("Saved. Couldn't reach the agent: no live route", true),
            SupervisorFormat.deliveryNote(FleetDelivery(status = "blocked", detail = "no live route"), "Answered."),
        )
        assertEquals(SupervisorFormat.Note("Saved. Couldn't reach the agent.", true), SupervisorFormat.deliveryNote(FleetDelivery(status = "blocked"), "Answered."))
        assertEquals(SupervisorFormat.Note("Saved. Send failed.", true), SupervisorFormat.deliveryNote(FleetDelivery(status = "failed"), "Answered."))
        assertEquals(SupervisorFormat.Note("Answered.", false), SupervisorFormat.deliveryNote(null, "Answered."))
    }

    @Test
    fun theScanLineNamesAgeAndTimer() {
        assertEquals("Not scanned yet · Auto-scan off", SupervisorFormat.scanLine(null, autoScan = false, now = now))
        assertEquals("Scanned just now · Auto-scan on", SupervisorFormat.scanLine(now.minusSeconds(20), autoScan = true, now = now))
        assertEquals("Scanned 3m ago · Auto-scan on", SupervisorFormat.scanLine(now.minusSeconds(180), autoScan = true, now = now))
    }

    @Test
    fun aFailedScanOutranksUnreadableSources() {
        val sources = FleetSnapshot(sourceErrors = mapOf("github" to JsonPrimitive("rate limited"), "git" to JsonPrimitive("x")))
        assertEquals("Couldn't read git, github on the last scan.", SupervisorFormat.warning(FleetState(snapshot = sources)))
        assertEquals("Last scan failed: boom", SupervisorFormat.warning(FleetState(lastError = JsonPrimitive("boom"), snapshot = sources)))
        assertNull(SupervisorFormat.warning(FleetState(snapshot = FleetSnapshot())))
    }

    @Test
    fun proposedNudgesMatchTheThreadAsSubjectOrTarget() {
        val t = FleetThread(key = "codex:abc")
        val actions = listOf(
            FleetAction(id = "1", status = "proposed", threadKey = "codex:abc"),
            FleetAction(id = "2", status = "proposed", threadKey = "infra:bb3", targetKey = "codex:abc"),
            FleetAction(id = "3", status = "sent", threadKey = "codex:abc"),
            FleetAction(id = "4", status = "proposed", threadKey = "claude:other"),
        )
        assertEquals(listOf("1", "2"), SupervisorFormat.proposedFor(t, actions).map { it.id })
    }
}
