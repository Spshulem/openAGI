package sh.openagi.mobile.transport

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SseFrameParserTest {
    @Test
    fun aSingleFrameDispatchesOnTheBlankLine() {
        val parser = SseFrameParser()
        assertNull(parser.feed("event: hello"))
        assertNull(parser.feed("data: {\"at\":\"now\"}"))
        val frame = parser.feed("")
        assertEquals(SseFrame("hello", "{\"at\":\"now\"}"), frame)
    }

    @Test
    fun eventDefaultsToMessageWhenAbsent() {
        assertEquals(listOf(SseFrame("message", "hi")), SseFrameParser.parseAll("data: hi\n\n"))
    }

    @Test
    fun multipleDataLinesJoinWithNewline() {
        val frames = SseFrameParser.parseAll("event: delta\ndata: line one\ndata: line two\n\n")
        assertEquals(listOf(SseFrame("delta", "line one\nline two")), frames)
    }

    @Test
    fun commentLinesAreIgnoredIncludingThePingHeartbeat() {
        // PROTOCOL.md §7: ": ping" arrives every 15s and is not a named event.
        val frames = SseFrameParser.parseAll(": ping\n\nevent: hello\ndata: {}\n\n")
        assertEquals(listOf(SseFrame("hello", "{}")), frames)
    }

    @Test
    fun consecutiveFramesEachDispatchIndependently() {
        val text = "event: hello\ndata: {\"at\":1}\n\nevent: task-updated\ndata: {\"op\":\"create\"}\n\n"
        val frames = SseFrameParser.parseAll(text)
        assertEquals(2, frames.size)
        assertEquals("hello", frames[0].event)
        assertEquals("task-updated", frames[1].event)
        assertEquals("{\"op\":\"create\"}", frames[1].data)
    }

    @Test
    fun aRealMessageStreamTranscriptParsesFrameByFrame() {
        // A representative transcript from streamLocalMessage
        // (src/hosted-interface.js): status, session, a couple of deltas, final.
        val transcript = """
            event: status
            data: {"stage":"queued","at":"2026-09-20T00:00:00Z"}

            event: session
            data: {"id":"sess_1","messageCount":2,"agent":"main"}

            event: delta
            data: {"text":"Sure","reset":false,"sessionId":"sess_1"}

            event: delta
            data: {"text":", I'll do that.","reset":false,"sessionId":"sess_1"}

            event: final
            data: {"reply":"Sure, I'll do that.","session":{"id":"sess_1","messageCount":2}}

        """.trimIndent()
        val frames = SseFrameParser.parseAll(transcript)
        assertEquals(listOf("status", "session", "delta", "delta", "final"), frames.map { it.event })
        assertTrue(frames[4].data.contains("Sure, I'll do that."))
    }

    @Test
    fun aLineWithNoColonIsTreatedAsAFieldNameWithEmptyValue() {
        // Malformed input must not throw; it's simply not "event" or "data" so
        // it's ignored, same as an id/retry field would be.
        assertEquals(emptyList<SseFrame>(), SseFrameParser.parseAll("garbage\n\n"))
    }

    @Test
    fun feedReturnsNullForEveryNonBlankLine() {
        val parser = SseFrameParser()
        assertNull(parser.feed("event: x"))
        assertNull(parser.feed("data: y"))
        assertNull(parser.feed(": comment"))
    }
}
