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

    // Real tasks carry a bare calendar date as their dueDate. The decoder once
    // accepted only full timestamps and failed the entire summary on a real
    // daemon, while every fixture-based test passed. The fixture now carries
    // one; this asserts it decodes to the start of that day in UTC.
    @Test
    fun aBareCalendarDueDateDecodesToStartOfDayUtc() {
        val summary = ProtocolJson.json.decodeFromString(MobileSummary.serializer(), fixture("summary-populated"))
        val taxes = summary.today.first { it.title == "File the quarterly taxes" }
        assertEquals(java.time.Instant.parse("2020-04-15T00:00:00Z"), taxes.dueDate)
    }

    // An optional date that is present but malformed means "no date", not a
    // reason to drop every other task on the screen.
    @Test
    fun aMalformedOptionalDateDoesNotFailTheSummary() {
        val raw = fixture("summary-populated").replace("\"2020-04-15\"", "\"not a date\"")
        val summary = ProtocolJson.json.decodeFromString(MobileSummary.serializer(), raw)
        assertEquals(3, summary.today.size)
        assertEquals(null, summary.today.first { it.title == "File the quarterly taxes" }.dueDate)
    }

    // The task store holds "" for a cleared due date and /tasks returns it raw.
    @Test
    fun aClearedDueDateInTheTasksListDecodesAsNull() {
        val tasks = ProtocolJson.json.decodeFromString(TasksListResponse.serializer(), fixture("tasks-list")).tasks
        assertEquals(5, tasks.size)
        assertEquals(null, tasks.first { it.title == "Call the accountant back" }.dueDate)
    }

    @Test
    fun decodesPopulatedSummary() {
        val summary = ProtocolJson.json.decodeFromString(MobileSummary.serializer(), fixture("summary-populated"))
        assertEquals(3, summary.today.size)
        assertEquals("Ship the widget", summary.today.first().title)
        assertEquals(3, summary.counts.today)
        assertEquals(2, summary.counts.overdue)
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
        assertEquals(3, summary.today.size)
    }
}
