package sh.openagi.mobile.protocol

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

class FleetDecodingTest {
    private fun decode(json: String): FleetState = FleetJson.json.decodeFromString(FleetState.serializer(), json)

    // Every key the contract names, at every level. Hand-written here because
    // mobile/fixtures holds only shapes generated from a real daemon.
    private val fullState = """
        {
          "mode": "propose",
          "enabled": true,
          "running": false,
          "lastTickAt": "2026-09-27T10:00:00.000Z",
          "lastError": null,
          "snapshot": {
            "at": "2026-09-27T10:00:00.000Z",
            "counts": {"threads": 3, "inScope": 2, "byState": {"needs-human": 1, "running": 1}, "needsYou": 1, "actions": 1},
            "threads": [
              {
                "key": "codex:abc", "kind": "codex", "title": "Fix the flaky test", "workspace": "amman",
                "repo": "openagi/openagi", "branch": "spencer/flaky", "agentStatus": "idle",
                "state": "needs-human", "health": "red", "reason": "CI red twice", "blockers": ["CI red: unit"],
                "pr": {"ref": "openagi/openagi#112", "url": "https://github.com/openagi/openagi/pull/112", "state": "OPEN",
                       "title": "Fleet supervisor", "ci": {"state": "FAILURE", "failing": ["unit"], "pending": []},
                       "unresolvedThreads": 2, "mergeState": "BLOCKED", "head": "6525ad8abc"},
                "lastActivityAt": "2026-09-27T09:58:00.000Z", "lastAgentText": "I pushed the fix.",
                "error": {"kind": "usage-limit", "resetAt": "2026-09-27T12:00:00.000Z"},
                "live": true, "route": "peer-relay",
                "decision": {"action": "nudge", "playbook": "ci-fix", "reason": "CI failed", "notBefore": "2026-09-27T10:05:00.000Z"}
              },
              {
                "key": "claude:def", "kind": "claude", "title": "Docs", "workspace": null, "repo": null, "branch": null,
                "agentStatus": "running", "state": "running", "health": "green", "reason": "turn in progress", "blockers": [],
                "pr": null, "lastActivityAt": null, "lastAgentText": null, "error": null, "live": false, "route": null, "decision": null
              }
            ],
            "infra": {"bb3": {"reachable": true}},
            "sourceErrors": {"github": "rate limited"}
          },
          "questions": [
            {"id": "fq_1", "title": "Merge #112?", "body": "Only a human can merge.", "options": ["merged", "open thread"],
             "kind": "merge", "threadKey": "codex:abc", "threadKeys": null, "prRef": "openagi/openagi#112",
             "createdAt": "2026-09-27T09:59:00.000Z"}
          ],
          "actions": [
            {"id": "fa_1", "status": "proposed", "playbook": "ci-fix", "threadKey": "codex:abc", "targetKey": null,
             "message": "CI is red on unit. Fix it and push.", "reason": "CI failed", "detail": null, "at": "2026-09-27T10:00:00.000Z"}
          ],
          "settings": {"tickMinutes": 5, "lookbackHours": 48}
        }
    """.trimIndent()

    @Test
    fun decodesTheFullContractShape() {
        val state = decode(fullState)
        assertEquals("propose", state.mode)
        assertTrue(state.enabled)
        assertEquals(Instant.parse("2026-09-27T10:00:00Z"), state.lastTickAt)
        val snapshot = state.snapshot!!
        assertEquals(1, snapshot.counts.byState["needs-human"])
        assertEquals(1, snapshot.counts.needsYou)
        val thread = snapshot.threads.first()
        assertEquals("amman", thread.workspace)
        assertEquals("red", thread.health)
        assertEquals(listOf("unit"), thread.pr!!.ci!!.failing)
        assertEquals(2, thread.pr.unresolvedThreads)
        assertEquals("usage-limit", thread.error!!.kind)
        assertEquals(Instant.parse("2026-09-27T10:05:00Z"), thread.decision!!.notBefore)
        assertNull(snapshot.threads[1].pr)
        assertEquals(mapOf("github" to "rate limited"), snapshot.sourceErrorTexts)
        assertEquals(listOf("merged", "open thread"), state.questions.single().options)
        assertEquals("proposed", state.actions.single().status)
    }

    // A daemon that has not scanned yet, or predates half these fields.
    @Test
    fun anEmptyObjectDecodesToAnEmptyState() {
        val state = decode("{}")
        assertNull(state.mode)
        assertNull(state.snapshot)
        assertTrue(state.questions.isEmpty())
        assertTrue(state.actions.isEmpty())
        assertNull(state.lastErrorText)
    }

    @Test
    fun missingNestedFieldsFallBackToDefaults() {
        val state = decode("""{"snapshot": {"threads": [{"key": "k"}, {}]}, "questions": [{"id": "q"}], "actions": [{}]}""")
        val threads = state.snapshot!!.threads
        assertEquals(2, threads.size)
        assertNull(threads[0].state)
        assertTrue(threads[0].blockers.isEmpty())
        assertEquals("", threads[1].key)
        assertEquals(0, state.snapshot.counts.threads)
        assertTrue(state.questions.single().options.isEmpty())
    }

    // An explicit null in a defaulted field is the default, not a crash.
    @Test
    fun explicitNullsInDefaultedFieldsAreCoerced() {
        val state = decode(
            """{"enabled": null, "questions": null, "snapshot": {"counts": null, "threads": [{"key": "k", "blockers": null, "live": null}], "sourceErrors": null}}""",
        )
        assertFalse(state.enabled)
        assertTrue(state.questions.isEmpty())
        assertTrue(state.snapshot!!.threads.single().blockers.isEmpty())
        assertTrue(state.snapshot.sourceErrorTexts.isEmpty())
    }

    @Test
    fun unknownFieldsAreIgnoredAtEveryLevel() {
        val state = decode(
            """{"mode": "auto", "brandNew": {"x": 1}, "snapshot": {"manager": {"key": "m"}, "infraDecisions": [],
               "threads": [{"key": "k", "somethingElse": [1, 2], "pr": {"ref": "a/b#1", "extra": true}}]}}""",
        )
        assertEquals("auto", state.mode)
        assertEquals("a/b#1", state.snapshot!!.threads.single().pr!!.ref)
    }

    @Test
    fun aMalformedOptionalTimestampIsDroppedNotFatal() {
        val state = decode("""{"lastTickAt": "not a time", "snapshot": {"threads": [{"key": "k", "lastActivityAt": ""}]}}""")
        assertNull(state.lastTickAt)
        assertNull(state.snapshot!!.threads.single().lastActivityAt)
    }

    @Test
    fun lastErrorReadsAsAStringOrAMessageObject() {
        assertEquals("boom", decode("""{"lastError": "boom"}""").lastErrorText)
        assertEquals("boom", decode("""{"lastError": {"message": "boom"}}""").lastErrorText)
        assertNull(decode("""{"lastError": ""}""").lastErrorText)
    }

    @Test
    fun questionAndActionResultsDecode() {
        val answered = FleetJson.json.decodeFromString(
            FleetQuestionResult.serializer(),
            """{"question": {"id": "fq_1", "options": []}, "delivery": {"status": "blocked", "route": null, "detail": "no live route"}, "state": {"mode": "observe"}}""",
        )
        assertEquals("blocked", answered.delivery!!.status)
        assertEquals("observe", answered.state!!.mode)
        val dismissed = FleetJson.json.decodeFromString(FleetQuestionResult.serializer(), """{"question": {"id": "fq_1"}, "state": {}}""")
        assertNull(dismissed.delivery)
        val sent = FleetJson.json.decodeFromString(FleetActionResult.serializer(), """{"action": {"id": "fa_1", "status": "sent"}, "delivery": {"status": "sent"}}""")
        assertEquals("sent", sent.action!!.status)
        assertNull(sent.state)
    }

    // ─── Health ───────────────────────────────────────────────────────────

    private fun thread(state: String?, health: String? = null, error: FleetThreadError? = null) =
        FleetThread(key = "k", state = state, health = health, error = error)

    @Test
    fun theDaemonsHealthWinsWhenPresent() {
        assertEquals(FleetHealth.YELLOW, FleetHealth.of(thread("running", health = "yellow")))
    }

    @Test
    fun anUnknownHealthValueFallsBackToTheMapping() {
        assertEquals(FleetHealth.GREEN, FleetHealth.of(thread("running", health = "blue")))
    }

    @Test
    fun fallbackMatchesTheContractTable() {
        listOf("running", "waiting-ci", "local-verify", "asked-in-scope", "done").forEach {
            assertEquals(it, FleetHealth.GREEN, FleetHealth.of(thread(it)))
        }
        listOf("pr-not-ready", "idle-no-pr", "ready-needs-human").forEach {
            assertEquals(it, FleetHealth.YELLOW, FleetHealth.of(thread(it)))
        }
        listOf("needs-human", "infra-blocked").forEach {
            assertEquals(it, FleetHealth.RED, FleetHealth.of(thread(it)))
        }
        assertEquals(FleetHealth.GRAY, FleetHealth.of(thread("excluded")))
        assertEquals(FleetHealth.GRAY, FleetHealth.of(thread("something-new")))
        assertEquals(FleetHealth.GRAY, FleetHealth.of(thread(null)))
    }

    @Test
    fun anErrorTurnsAnyStateButRunningRed() {
        val error = FleetThreadError(kind = "usage-limit")
        assertEquals(FleetHealth.RED, FleetHealth.of(thread("done", error = error)))
        assertEquals(FleetHealth.RED, FleetHealth.of(thread("idle-no-pr", error = error)))
        assertEquals(FleetHealth.GREEN, FleetHealth.of(thread("running", error = error)))
        assertEquals(FleetHealth.GRAY, FleetHealth.of(thread("excluded", error = error)))
        assertEquals(FleetHealth.GRAY, FleetHealth.of(thread("something-new", error = error)))
    }
}
