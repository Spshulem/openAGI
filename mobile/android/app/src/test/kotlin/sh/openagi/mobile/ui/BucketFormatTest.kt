package sh.openagi.mobile.ui

import org.junit.Assert.assertEquals
import org.junit.Test

class BucketFormatTest {
    @Test
    fun orderMatchesTheDaemonsSevenValidBuckets() {
        assertEquals(
            listOf("today", "this_week", "this_month", "this_quarter", "this_year", "someday", "done"),
            BucketFormat.ORDER,
        )
    }

    @Test
    fun labelsAreSentenceCaseNotSnakeCase() {
        assertEquals("This week", BucketFormat.label("this_week"))
        assertEquals("Today", BucketFormat.label("today"))
        assertEquals("Done", BucketFormat.label("done"))
    }

    @Test
    fun anUnknownBucketFallsBackToItsRawValueRatherThanCrashing() {
        assertEquals("weird_bucket", BucketFormat.label("weird_bucket"))
    }

    @Test
    fun statusLabelsAreSentenceCase() {
        assertEquals("In progress", BucketFormat.statusLabel("in_progress"))
        assertEquals("Pending", BucketFormat.statusLabel("pending"))
    }
}
