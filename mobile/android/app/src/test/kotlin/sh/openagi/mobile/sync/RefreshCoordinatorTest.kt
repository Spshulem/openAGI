package sh.openagi.mobile.sync

import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
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
import java.util.concurrent.TimeUnit

class RefreshCoordinatorTest {
    @get:Rule val folder = TemporaryFolder()
    private lateinit var server: MockWebServer

    @Before fun start() { server = MockWebServer(); server.start() }
    @After fun stop() { server.shutdown() }

    private fun fixture(name: String) = File("../../fixtures/$name.json").readText()

    private fun enqueueHeartbeat() {
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"ok":true}"""))
    }

    private fun coordinator(onSnapshotChanged: suspend () -> Unit = {}): RefreshCoordinator {
        val client = DaemonClient(server.url("/").toString(), "mobile:abc", "a".repeat(43), enforceAllowlist = false)
        return RefreshCoordinator(client, SnapshotStore(folder.root), OutboundQueue(folder.root), onSnapshotChanged)
    }

    // Every request this test doesn't care about the exact position of, taken
    // off the queue until one matching `path` shows up. Needed because
    // refresh() now always issues a trailing heartbeat request in addition to
    // the summary fetch, and this suite should not be rewritten every time
    // another best-effort call is added to the same method.
    private fun takeRequestFor(path: String): RecordedRequest {
        while (true) {
            val request = server.takeRequest(2, TimeUnit.SECONDS) ?: error("no request arrived for $path")
            if (request.path == path) return request
        }
    }

    @Test
    fun refreshWritesTheSnapshotAndReturnsUpdated() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(200).setHeader("ETag", "\"e1\"").setBody(fixture("summary-populated")))
        enqueueHeartbeat()
        val outcome = coordinator().refresh()
        assertTrue(outcome is RefreshOutcome.Updated)
        assertEquals(3, SnapshotStore(folder.root).load()!!.summary.today.size)
        assertEquals("\"e1\"", SnapshotStore(folder.root).load()!!.etag)
    }

    @Test
    fun unchangedLeavesTheExistingSnapshotAlone() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(200).setHeader("ETag", "\"e1\"").setBody(fixture("summary-populated")))
        enqueueHeartbeat()
        coordinator().refresh()
        server.enqueue(MockResponse().setResponseCode(304))
        enqueueHeartbeat()
        assertTrue(coordinator().refresh() is RefreshOutcome.Unchanged)
        val snapshot = SnapshotStore(folder.root).load()!!
        assertEquals(3, snapshot.summary.today.size)
        // The first fetch had nothing cached yet; the second must carry the
        // ETag the first one returned.
        assertEquals(null, takeRequestFor("/mobile/summary").getHeader("If-None-Match"))
        assertEquals("\"e1\"", takeRequestFor("/mobile/summary").getHeader("If-None-Match"))
    }

    @Test
    fun drainSendsQueuedCompletionsBeforeFetching() = runBlocking {
        OutboundQueue(folder.root).enqueue(PendingOp.completeTask("task_0"))
        server.enqueue(MockResponse().setResponseCode(200).setBody("{}"))
        server.enqueue(MockResponse().setResponseCode(200).setBody(fixture("summary-populated")))
        enqueueHeartbeat()
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
    fun a409DuringDrainRetiresTheOpRatherThanRetrying() = runBlocking {
        // The server has already decided the matter (e.g. the task was
        // deleted and recreated) — replaying a stale completion cannot help,
        // same as the 404 case just above.
        OutboundQueue(folder.root).enqueue(PendingOp.completeTask("task_moved"))
        server.enqueue(MockResponse().setResponseCode(409))
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
        enqueueHeartbeat()
        coordinator().refresh()
        server.enqueue(MockResponse().setResponseCode(401))
        enqueueHeartbeat()
        assertTrue(coordinator().refresh() is RefreshOutcome.Unauthorized)
        // The user must still see their tasks while they re-pair.
        assertNotNull(SnapshotStore(folder.root).load())
    }

    @Test
    fun everyRefreshSendsAHeartbeatRegardlessOfOutcome() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(401))
        enqueueHeartbeat()
        coordinator().refresh()
        takeRequestFor("/nodes/heartbeat") // must not hang: the request really was sent
        Unit
    }

    @Test
    fun aFailingHeartbeatDoesNotFailTheRefresh() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(200).setBody(fixture("summary-populated")))
        server.enqueue(MockResponse().setResponseCode(500)) // heartbeat itself fails
        val outcome = coordinator().refresh()
        assertTrue(outcome is RefreshOutcome.Updated)
    }

    @Test
    fun onSnapshotChangedFiresAfterAWrittenSnapshotButNotOnFailure() = runBlocking {
        var fired = 0
        server.enqueue(MockResponse().setResponseCode(200).setBody(fixture("summary-populated")))
        enqueueHeartbeat()
        coordinator { fired++ }.refresh()
        assertEquals(1, fired)

        server.enqueue(MockResponse().setResponseCode(401))
        enqueueHeartbeat()
        coordinator { fired++ }.refresh()
        assertEquals(1, fired) // unchanged from before: an unauthorized refresh writes nothing
    }

    @Test
    fun anOfflineRefreshMarksTheExistingSnapshotAsFailedRatherThanLookingHealthy() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(200).setBody(fixture("summary-populated")))
        enqueueHeartbeat()
        coordinator().refresh()
        assertEquals(false, SnapshotStore(folder.root).load()!!.lastRefreshFailed)

        server.enqueue(MockResponse().setSocketPolicy(okhttp3.mockwebserver.SocketPolicy.DISCONNECT_AT_START))
        server.enqueue(MockResponse().setSocketPolicy(okhttp3.mockwebserver.SocketPolicy.DISCONNECT_AT_START))
        assertTrue(coordinator().refresh() is RefreshOutcome.Offline)
        assertEquals(true, SnapshotStore(folder.root).load()!!.lastRefreshFailed)
    }
}
