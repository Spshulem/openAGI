package sh.openagi.mobile.ui

import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import sh.openagi.mobile.transport.DaemonClient
import java.io.File

// The exact regression DESIGN.md's "Screens must not be mostly empty" calls
// out: "If one of the two [Inbox sections] fails to load, the other still
// renders." The daemon bug this was originally written against (GET
// /tasks/:id swallowing /tasks/clarifications) is fixed at HEAD, but the old
// client code — `try { actions = ...; clarifications = ... } catch { ... }`
// — had its own defect: an exception fetching the first section stopped the
// second from ever being attempted, and a failure on the first, working
// section left the second one blank with no error shown at all. loadInbox
// fetches and catches each section independently, the same way
// fetchInboxBadgeCount already does.
class InboxLoadTest {
    private lateinit var server: MockWebServer
    private val token = "a".repeat(43)

    @Before
    fun start() {
        server = MockWebServer()
        server.start()
    }

    @After
    fun stop() {
        server.shutdown()
    }

    private fun client() = DaemonClient(
        server = server.url("/").toString(),
        nodeId = "mobile:abc",
        token = token,
        enforceAllowlist = false,
    )

    private fun fixture(name: String) = File("../../fixtures/$name.json").readText()

    @Test
    fun aClarificationsFailureLeavesApprovalsPopulated() = runBlocking {
        // /pending-actions succeeds; /tasks/clarifications 404s — exactly the
        // daemon's real route-ordering bug, reproduced at the wire level.
        server.enqueue(MockResponse().setResponseCode(200).setBody(fixture("pending-actions")))
        server.enqueue(MockResponse().setResponseCode(404))

        val result = loadInbox(client(), "mac.tail1234.ts.net")

        assertNotNull(result.actions.items)
        assertEquals(1, result.actions.items!!.size)
        assertNull(result.actions.error)

        assertNull(result.clarifications.items)
        assertNotNull(result.clarifications.error)
    }

    @Test
    fun anApprovalsFailureLeavesClarificationsPopulated() = runBlocking {
        // The reverse order: the first request of the two fails. The old
        // sequential try/catch never even attempted the second call in this
        // case — the whole screen went blank with a single top-level error.
        server.enqueue(MockResponse().setResponseCode(500))
        server.enqueue(
            MockResponse().setResponseCode(200).setBody(
                """[{"id":"clar_1","taskId":"task_1","question":"Done?","status":"pending","sources":[]}]""",
            ),
        )

        val result = loadInbox(client(), "mac.tail1234.ts.net")

        assertNull(result.actions.items)
        assertNotNull(result.actions.error)

        assertNotNull(result.clarifications.items)
        assertEquals(1, result.clarifications.items!!.size)
        assertNull(result.clarifications.error)
    }

    @Test
    fun bothSectionsSucceedWithNoErrors() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(200).setBody(fixture("pending-actions")))
        server.enqueue(
            MockResponse().setResponseCode(200).setBody(
                """[{"id":"clar_1","taskId":"task_1","question":"Done?","status":"pending","sources":[]}]""",
            ),
        )

        val result = loadInbox(client(), "mac.tail1234.ts.net")

        assertNull(result.actions.error)
        assertNull(result.clarifications.error)
        assertEquals(1, result.actions.items?.size)
        assertEquals(1, result.clarifications.items?.size)
    }

    @Test
    fun aFailureNamesWhatToDoNotJustTheStatusCode() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(404))
        server.enqueue(MockResponse().setResponseCode(200).setBody("[]"))

        val result = loadInbox(client(), "mac.tail1234.ts.net")

        val message = result.actions.error!!
        assertTrue(message.headline.isNotBlank())
        assertTrue(message.detail.isNotBlank())
    }
}
