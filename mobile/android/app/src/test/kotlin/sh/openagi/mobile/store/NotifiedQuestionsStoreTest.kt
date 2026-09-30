package sh.openagi.mobile.store

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

class NotifiedQuestionsStoreTest {
    @get:Rule val folder = TemporaryFolder()

    private fun store() = NotifiedQuestionsStore(folder.root)

    @Test
    fun emptyWhenNothingWasEverNotified() {
        assertEquals(emptySet<String>(), store().load())
    }

    // The service, the refresh worker and the answer worker each build their
    // own store; what one writes the next must read from a cold start.
    @Test
    fun idsSurviveAFreshInstance() {
        store().add("fq_a")
        store().add("fq_b")
        assertEquals(listOf("fq_a", "fq_b"), NotifiedQuestionsStore(folder.root).load().toList())
    }

    @Test
    fun addingTheSameIdTwiceKeepsOne() {
        store().add("fq_a")
        store().add("fq_a")
        assertEquals(setOf("fq_a"), store().load())
    }

    @Test
    fun blankIdsAreIgnored() {
        store().add("")
        store().add("  ")
        assertEquals(emptySet<String>(), store().load())
    }

    @Test
    fun removeDropsOnlyThatId() {
        store().replace(linkedSetOf("fq_a", "fq_b", "fq_c"))
        store().remove("fq_b")
        store().remove("fq_missing")
        assertEquals(listOf("fq_a", "fq_c"), store().load().toList())
    }

    @Test
    fun replaceOverwritesTheWholeSet() {
        store().add("fq_old")
        store().replace(setOf("fq_new"))
        assertEquals(setOf("fq_new"), store().load())
    }

    @Test
    fun clearDeletesTheFile() {
        store().add("fq_a")
        store().clear()
        assertEquals(emptySet<String>(), store().load())
        assertFalse(File(folder.root, "supervisor-notified.json").exists())
    }

    @Test
    fun aCorruptFileReadsAsEmptyRatherThanCrashing() {
        File(folder.root, "supervisor-notified.json").writeText("not json")
        assertEquals(emptySet<String>(), store().load())
        // And the next write replaces it cleanly.
        store().add("fq_a")
        assertEquals(setOf("fq_a"), store().load())
    }

    @Test
    fun theWrongJsonShapeReadsAsEmpty() {
        File(folder.root, "supervisor-notified.json").writeText("""{"ids":["fq_a"]}""")
        assertEquals(emptySet<String>(), store().load())
    }

    // Every question that ever pinged would otherwise stay in the file for
    // good if its close was never observed (the phone was off that day).
    @Test
    fun keepsTheNewestTwoHundredIds() {
        (1..205).forEach { store().add("fq_$it") }
        val ids = store().load().toList()
        assertEquals(NotifiedQuestionsStore.MAX_IDS, ids.size)
        assertEquals("fq_6", ids.first())
        assertEquals("fq_205", ids.last())
    }

    @Test
    fun replaceIsCappedTheSameWay() {
        store().replace((1..250).map { "fq_$it" }.toCollection(LinkedHashSet()))
        val ids = store().load().toList()
        assertEquals(NotifiedQuestionsStore.MAX_IDS, ids.size)
        assertEquals("fq_51", ids.first())
    }

    // The service's check and an answer worker can write at the same moment
    // through different instances; a lost add would re-ping a question.
    @Test
    fun concurrentAddsFromSeparateInstancesAreNeverLost() {
        val threads = (0 until 8).map { worker ->
            Thread { repeat(20) { store().add("fq_${worker}_$it") } }
        }
        threads.forEach { it.start() }
        threads.forEach { it.join() }
        val ids = store().load()
        assertEquals(160, ids.size)
        assertTrue(ids.contains("fq_7_19"))
    }
}
