package sh.openagi.mobile.protocol

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class SummaryDecodingTest {
    // Unit tests run with the module directory as the working directory, so the
    // shared fixtures are two levels up. Decoding the same bytes the Swift tests
    // decode is what keeps the two clients honest.
    private fun fixture(name: String): String =
        File("../../fixtures/$name.json").readText()

    @Test
    fun decodesPopulatedSummary() {
        val summary = ProtocolJson.json.decodeFromString(MobileSummary.serializer(), fixture("summary-populated"))
        assertEquals(2, summary.today.size)
        assertEquals("Ship the widget", summary.today.first().title)
        assertEquals(2, summary.counts.today)
        assertEquals(1, summary.counts.overdue)
        assertTrue(summary.today.any { it.overdue })
        assertFalse(summary.brief.headline.isEmpty())
    }

    @Test
    fun decodesEmptySummary() {
        val summary = ProtocolJson.json.decodeFromString(MobileSummary.serializer(), fixture("summary-empty"))
        assertTrue(summary.today.isEmpty())
        assertEquals(0, summary.counts.pendingActions)
    }

    @Test
    fun snakeCaseCountKeyMapsToThisWeek() {
        val summary = ProtocolJson.json.decodeFromString(MobileSummary.serializer(), fixture("summary-populated"))
        assertTrue(summary.counts.thisWeek >= 0)
    }

    @Test
    fun datesDecodeAsRealInstants() {
        val summary = ProtocolJson.json.decodeFromString(MobileSummary.serializer(), fixture("summary-populated"))
        assertTrue(summary.generatedAt.epochSecond > 1_600_000_000L)
        assertNotNull(summary.today.first { it.overdue }.dueDate)
    }

    @Test
    fun unknownFieldsDoNotBreakDecoding() {
        // A daemon that grows a field must not brick every installed phone.
        val withExtra = fixture("summary-populated").trimEnd().removeSuffix("}") + ""","somethingNew":{"nested":true}}"""
        val summary = ProtocolJson.json.decodeFromString(MobileSummary.serializer(), withExtra)
        assertEquals(2, summary.today.size)
    }
}
