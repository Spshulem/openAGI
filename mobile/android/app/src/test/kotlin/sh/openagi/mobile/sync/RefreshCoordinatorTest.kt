package sh.openagi.mobile.sync

import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import sh.openagi.mobile.store.OutboundQueue
import sh.openagi.mobile.store.PendingOp
import sh.openagi.mobile.store.SnapshotStore
import sh.openagi.mobile.transport.DaemonClient
import java.io.File

class RefreshCoordinatorTest {
    @get:Rule val folder = TemporaryFolder()
    private lateinit var server: MockWebServer

    @Before fun start() { server = MockWebServer(); server.start() }
    @After fun stop() { server.shutdown() }

    private fun fixture(name: String) = File("../../fixtures/$name.json").readText()

    private fun coordinator(): RefreshCoordinator {
        val client = DaemonClient(server.url("/").toString(), "mobile:abc", "a".repeat(43), enforceAllowlist = false)
        return RefreshCoordinator(client, SnapshotStore(folder.root), OutboundQueue(folder.root))
    }

    @Test
    fun refreshWritesTheSnapshotAndReturnsUpdated() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(200).setHeader("ETag", "\"e1\"").setBody(fixture("summary-populated")))
        val outcome = coordinator().refresh()
        assertTrue(outcome is RefreshOutcome.Updated)
        assertEquals(2, SnapshotStore(folder.root).load()!!.summary.today.size)
        assertEquals("\"e1\"", SnapshotStore(folder.root).load()!!.etag)
    }

    @Test
    fun unchangedLeavesTheExistingSnapshotAlone() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(200).setHeader("ETag", "\"e1\"").setBody(fixture("summary-populated")))
        coordinator().refresh()
        server.enqueue(MockResponse().setResponseCode(304))
        assertTrue(coordinator().refresh() is RefreshOutcome.Unchanged)
        val snapshot = SnapshotStore(folder.root).load()!!
        assertEquals(2, snapshot.summary.today.size)
        // The conditional request must have carried the stored ETag.
        server.takeRequest()
        assertEquals("\"e1\"", server.takeRequest().getHeader("If-None-Match"))
    }

    @Test
    fun drainSendsQueuedCompletionsBeforeFetching() = runBlocking {
        OutboundQueue(folder.root).enqueue(PendingOp.completeTask("task_0"))
        server.enqueue(MockResponse().setResponseCode(200).setBody("{}"))
        server.enqueue(MockResponse().setResponseCode(200).setBody(fixture("summary-populated")))
        coordinator().refresh()
        assertTrue(OutboundQueue(folder.root).all().isEmpty())
        // Order matters: send what the user already did, then ask what is true.
        assertEquals("/tasks/task_0/complete", server.takeRequest().path)
        assertEquals("/mobile/summary", server.takeRequest().path)
    }

    @Test
    fun a404DuringDrainRetiresTheOpRatherThanRetrying() = runBlocking {
        OutboundQueue(folder.root).enqueue(PendingOp.completeTask("task_gone"))
        server.enqueue(MockResponse().setResponseCode(404))
        coordinator().drainQueue()
        assertTrue(OutboundQueue(folder.root).all().isEmpty())
    }

    @Test
    fun aTransportFailureDuringDrainKeepsTheOpAndCountsAnAttempt() = runBlocking {
        OutboundQueue(folder.root).enqueue(PendingOp.completeTask("task_1"))
        server.enqueue(MockResponse().setResponseCode(500))
        coordinator().drainQueue()
        assertEquals(1, OutboundQueue(folder.root).all().single().attempts)
    }

    @Test
    fun anUnauthorizedRefreshKeepsTheCachedSnapshot() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(200).setBody(fixture("summary-populated")))
        coordinator().refresh()
        server.enqueue(MockResponse().setResponseCode(401))
        assertTrue(coordinator().refresh() is RefreshOutcome.Unauthorized)
        // The user must still see their tasks while they re-pair.
        assertNotNull(SnapshotStore(folder.root).load())
    }
}
