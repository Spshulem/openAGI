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
    fun decodesWatchAndLastAgentAt() {
        val state = decode(
            """
            {"snapshot": {"counts": {"byWatch": {"you": 1, "waiting": 1, "quiet": 0}}, "threads": [
              {"key": "a", "state": "waiting-ci", "lastAgentAt": "2026-10-12T21:50:00.000Z",
               "watch": {"group": "waiting", "since": "2026-10-12T21:37:00.000Z", "waitingOn": "BuildBot3 full run",
                         "waitSince": "2026-10-12T21:37:00.000Z", "runningSince": null, "later": 1}},
              {"key": "b", "state": "excluded", "watch": null},
              {"key": "c", "state": "running", "watch": {"group": "working", "since": "not a time"}}
            ]}}
            """.trimIndent(),
        )
        val snapshot = state.snapshot!!
        assertEquals(mapOf("you" to 1, "waiting" to 1, "quiet" to 0), snapshot.counts.byWatch)
        val watch = snapshot.threads[0].watch!!
        assertEquals("waiting", watch.group)
        assertEquals(Instant.parse("2026-10-12T21:37:00Z"), watch.since)
        assertEquals("BuildBot3 full run", watch.waitingOn)
        assertEquals(Instant.parse("2026-10-12T21:37:00Z"), watch.waitSince)
        assertNull(watch.runningSince)
        assertEquals(Instant.parse("2026-10-12T21:50:00Z"), snapshot.threads[0].lastAgentAt)
        assertNull(snapshot.threads[1].watch)
        assertEquals("working", snapshot.threads[2].watch!!.group)
        assertNull(snapshot.threads[2].watch!!.since)
    }

    @Test
    fun anOlderDaemonHasNoWatch() {
        val thread = decode(fullState).snapshot!!.threads.first()
        assertNull(thread.watch)
        assertNull(thread.lastAgentAt)
        assertTrue(decode(fullState).snapshot!!.counts.byWatch.isEmpty())
    }

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

    // The open-chat, mute and live-question fields the Supervisor tab reads
    // (src/fleet/supervisor.js getState and questionView).
    @Test
    fun decodesOpenChatMuteAndQuestionContext() {
        val state = decode(
            """
            {
              "snapshot": {"threads": [{
                "key": "conductor:d1dbe71a", "state": "needs-human",
                "openChat": {"app": "conductor", "url": "conductor://workspace?id=w1&session=s1", "label": "remote-dev · Codex LB Transcript open (Conductor)", "note": null},
                "muted": "2026-10-15T00:00:00Z", "lastOwnerAt": "2026-10-13T20:00:00Z",
                "decision": {"action": "nudge", "playbook": "pr-ci-failing", "reason": "CI red", "message": "CI is red: fix it."},
                "watch": {"group": "you", "since": "2026-10-14T00:21:00Z", "otherwise": {"group": "push", "waitingOn": null}}
              }]},
              "questions": [
                {"id": "fq_4", "title": "Which BuildBot3 capacity fix should be applied?", "options": ["A", "B"], "kind": "agent-ask",
                 "threadKey": "conductor:d1dbe71a", "askedAt": "2026-10-14T00:21:00Z", "chatLabel": "remote-dev · Codex LB Transcript open (Conductor)",
                 "answerIn": "here", "openChat": {"app": "conductor", "url": "conductor://workspace?id=w1&session=s1", "label": "remote-dev", "note": null},
                 "risky": false, "askContext": "Two options: raise slots or move the queue."},
                {"id": "fq_5", "title": "cut production release?", "options": ["open thread"], "kind": "agent-card",
                 "threadKeys": ["codex:a", "claude:b"], "answerIn": "agent app", "risky": true, "openChat": null,
                 "chats": [{"threadKey": "codex:a", "app": "codex", "url": "codex://threads/a", "label": "docs (Codex)", "note": null},
                           {"threadKey": "claude:b", "app": "claude", "url": null, "label": "docs (Claude Code)", "note": "open it in its terminal"}]}
              ]
            }
            """,
        )
        val thread = state.snapshot!!.threads.single()
        assertEquals("conductor://workspace?id=w1&session=s1", thread.openChat!!.url)
        assertEquals(Instant.parse("2026-10-15T00:00:00Z"), thread.muted)
        assertEquals(Instant.parse("2026-10-13T20:00:00Z"), thread.lastOwnerAt)
        assertEquals("CI is red: fix it.", thread.decision!!.message)
        assertEquals("push", thread.watch!!.otherwise!!.group)
        val (ask, card) = state.questions
        assertEquals(Instant.parse("2026-10-14T00:21:00Z"), ask.askedAt)
        assertEquals("remote-dev · Codex LB Transcript open (Conductor)", ask.chatLabel)
        assertFalse(ask.answeredInAgentApp)
        assertFalse(ask.risky)
        assertEquals("Two options: raise slots or move the queue.", ask.askContext)
        assertTrue(card.answeredInAgentApp)
        assertTrue(card.risky)
        assertNull(card.openChat)
        assertEquals(listOf("codex://threads/a", null), card.chats.map { it.openChat.url })
        assertEquals("open it in its terminal", card.chats[1].note)
    }

    // A daemon from before these fields: everything empty, nothing thrown.
    @Test
    fun anOlderDaemonLeavesTheNewFieldsEmpty() {
        val state = decode("""{"snapshot":{"threads":[{"key":"codex:x"}]},"questions":[{"id":"q"}]}""")
        val thread = state.snapshot!!.threads.single()
        assertNull(thread.openChat)
        assertNull(thread.muted)
        assertNull(thread.decision?.message)
        val question = state.questions.single()
        assertFalse(question.risky)
        assertFalse(question.answeredInAgentApp)
        assertTrue(question.chats.isEmpty())
    }

    @Test
    fun decodesTheThreadDetail() {
        val detail = FleetJson.json.decodeFromString(
            FleetThreadDetailResult.serializer(),
            """
            {"thread": {"key": "codex:01a13388", "kind": "codex", "title": "Download Amex Statements for Amazon", "live": false,
              "lastAgentMessage": {"text": "I need you to log in.", "at": "2026-10-13T19:38:00Z"},
              "lastOwnerAt": null, "pr": {"ref": "x/y#3", "url": null, "state": null},
              "watch": {"group": "quiet", "since": "2026-10-13T19:38:00Z"},
              "decision": {"action": "none", "playbook": null, "reason": "nothing to do", "notBefore": null, "message": null},
              "muted": null, "questions": [], "openChat": {"app": "codex", "url": "codex://threads/01a13388", "label": "Download Amex Statements for Amazon (Codex)", "note": null},
              "scannedAt": "2026-10-14T04:03:50Z", "prompt": {"kind": "card"}}}
            """,
        ).thread!!
        assertEquals("I need you to log in.", detail.lastAgentMessage!!.text)
        assertEquals("quiet", detail.watch!!.group)
        assertNull(detail.pr!!.url)
        assertEquals("codex://threads/01a13388", detail.openChat!!.url)
        assertEquals(Instant.parse("2026-10-14T04:03:50Z"), detail.scannedAt)
    }

    @Test
    fun anOlderDaemonAppOnlyQuestionKeepsItsHint() {
        val question = decode("""{"questions":[{"id":"q","options":["open thread"]}]}""").questions.single()
        assertNull(question.answerIn)
        assertTrue(question.answeredInAgentApp)
    }


    private fun detail(json: String): FleetThreadDetail =
        FleetJson.json.decodeFromString(FleetThreadDetailResult.serializer(), json).thread!!

    @Test
    fun decodesTheConversation() {
        val thread = detail(
            """
            {"thread": {"key": "codex:abc", "conversation": {"truncated": true, "unavailableReason": null, "messages": [
              {"id": "m1", "role": "user", "text": "Fix the test", "at": "2026-11-10T09:00:00.000Z"},
              {"id": "m2", "role": "assistant", "text": "Which one?", "at": "2026-11-10T09:01:00.000Z", "extra": 1}
            ]}}}
            """,
        )
        val conversation = thread.conversation!!
        assertTrue(conversation.truncated)
        assertNull(conversation.unavailableReason)
        assertEquals(listOf("m1", "m2"), conversation.messages.map { it.id })
        assertTrue(conversation.messages[0].fromOwner)
        assertFalse(conversation.messages[1].fromOwner)
        assertEquals(Instant.parse("2026-11-10T09:01:00Z"), conversation.messages[1].at)
    }

    @Test
    fun aConversationIsReadLossily() {
        val thread = detail(
            """
            {"thread": {"key": "codex:abc", "conversation": {"truncated": "yes", "unavailableReason": "Only the last exchange could be read.",
              "messages": [{"role": "assistant", "text": "kept", "at": "not a date"}, {"role": "user", "text": {"x": 1}}, 7, null,
                           {"role": "assistant", "text": "   "}, {"text": "no role"}]}}}
            """,
        )
        val conversation = thread.conversation!!
        assertFalse(conversation.truncated)
        assertEquals("Only the last exchange could be read.", conversation.unavailableReason)
        assertEquals(listOf("kept", "no role"), conversation.messages.map { it.text })
        assertNull(conversation.messages[0].at)
        assertFalse(conversation.messages[1].fromOwner)
    }

    @Test
    fun noConversationOnAnOlderHubOrAnOddShape() {
        assertNull(detail("""{"thread": {"key": "codex:abc"}}""").conversation)
        assertNull(detail("""{"thread": {"key": "codex:abc", "conversation": null}}""").conversation)
        assertNull(detail("""{"thread": {"key": "codex:abc", "conversation": "text"}}""").conversation)
        val empty = detail("""{"thread": {"key": "codex:abc", "conversation": {"messages": "nope"}}}""").conversation!!
        assertTrue(empty.messages.isEmpty())
    }

    @Test
    fun canReplyDefaultsToFalse() {
        val questions = decode("""{"questions":[{"id":"a"},{"id":"b","canReply":true},{"id":"c","canReply":null}]}""").questions
        assertEquals(listOf(false, true, false), questions.map { it.canReply })
    }
}
