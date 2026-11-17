package sh.openagi.mobile.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

// The working line reads a stream `status` frame as plain words: the tool a
// hop runs, else its stage. Pipeline stage names never show as-is.
class ChatActivityLabelTest {
    @Test
    fun namesTheToolAHopRuns() {
        assertEquals("Using fleet status", chatActivityLabel("""{"stage":"tool","tool":"fleet_status"}"""))
    }

    @Test
    fun saysWhatThePersonSeesForPipelineStages() {
        assertEquals("Thinking", chatActivityLabel("""{"stage":"model","hop":1}"""))
        assertEquals("Thinking", chatActivityLabel("""{"stage":"thinking"}"""))
        assertEquals("Getting started", chatActivityLabel("""{"stage":"queued"}"""))
        assertEquals("Getting started", chatActivityLabel("""{"stage":"routing"}"""))
    }

    @Test
    fun ignoresFramesWithNothingToSay() {
        assertNull(chatActivityLabel("""{"stage":""}"""))
        assertNull(chatActivityLabel("not json"))
    }
}
