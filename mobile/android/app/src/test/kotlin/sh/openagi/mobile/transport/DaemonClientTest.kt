package sh.openagi.mobile.transport

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import sh.openagi.mobile.protocol.ProtocolJson
import java.io.File

class DaemonClientTest {
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

    // MockWebServer binds 127.0.0.1, which the allowlist refuses on purpose.
    // Tests opt out of the allowlist explicitly rather than weakening it.
    private fun client() = DaemonClient(
        server = server.url("/").toString(),
        nodeId = "mobile:abc",
        token = token,
        enforceAllowlist = false,
    )

    private fun fixture(name: String) = File("../../fixtures/$name.json").readText()

    @Test
    fun summarySendsCredentialsAndDecodes() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(200).setHeader("ETag", "\"abc\"").setBody(fixture("summary-populated")))
        val result = client().summary(ifNoneMatch = null)
        val fresh = result as SummaryResponse.Fresh
        assertEquals("Ship the widget", fresh.summary.today.first().title)
        assertEquals("\"abc\"", fresh.etag)
        val request = server.takeRequest()
        assertEquals("/mobile/summary", request.path)
        assertEquals("Bearer $token", request.getHeader("Authorization"))
        assertEquals("mobile:abc", request.getHeader("X-OpenAGI-Node-ID"))
    }

    @Test
    fun notModifiedIsNotAnError() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(304))
        assertTrue(client().summary(ifNoneMatch = "\"abc\"") is SummaryResponse.Unchanged)
        assertEquals("\"abc\"", server.takeRequest().getHeader("If-None-Match"))
    }

    @Test
    fun completeSendsCompletedViaMobile() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(200).setBody("{}"))
        client().complete("task_abc")
        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/tasks/task_abc/complete", request.path)
        assertEquals("""{"completedVia":"mobile"}""", request.body.readUtf8())
    }

    @Test
    fun heartbeatSendsRoleNode() = runBlocking {
        // The daemon rejects a heartbeat whose role is not exactly "node" with a
        // 400. Nothing else in this suite would notice if role were dropped or
        // misspelled, and the plan's own first draft omitted it — so assert the
        // body bytes, not merely that the call succeeded.
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"ok":true}"""))
        client().heartbeat()
        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/nodes/heartbeat", request.path)
        assertEquals("""{"nodeId":"mobile:abc","role":"node"}""", request.body.readUtf8())
    }

    @Test
    fun aTransportFailureArrivesAsDaemonException() = runBlocking {
        // A dropped connection must not escape as a bare IOException, or every
        // caller that catches DaemonException misses the commonest failure there
        // is on a phone.
        server.enqueue(MockResponse().setSocketPolicy(okhttp3.mockwebserver.SocketPolicy.DISCONNECT_AT_START))
        try {
            client().heartbeat()
            fail("expected a transport failure")
        } catch (expected: DaemonException.Transport) {
        }
        Unit
    }

    @Test
    fun aTransportFailureDuringSummaryArrivesAsDaemonException() = runBlocking {
        // summary() calls execute() directly rather than through post() — a
        // separate code path that must not let an IOException past it either.
        server.enqueue(MockResponse().setSocketPolicy(okhttp3.mockwebserver.SocketPolicy.DISCONNECT_AT_START))
        try {
            client().summary(ifNoneMatch = null)
            fail("expected a transport failure")
        } catch (expected: DaemonException.Transport) {
        }
        Unit
    }

    @Test
    fun aTransportFailureDuringEnrollArrivesAsDaemonException() = runBlocking {
        // enroll() is a companion function with its own network call, and pairing
        // is the very first network request the app ever makes — it must not
        // crash the app with a bare IOException on a bad connection.
        server.enqueue(MockResponse().setSocketPolicy(okhttp3.mockwebserver.SocketPolicy.DISCONNECT_AT_START))
        try {
            DaemonClient.enroll(
                server = server.url("/").toString(),
                code = "004221",
                nodeId = "mobile:abc",
                nodeToken = "b".repeat(43),
                name = "iPhone",
                enforceAllowlist = false,
            )
            fail("expected a transport failure")
        } catch (expected: DaemonException.Transport) {
        }
        Unit
    }

    @Test
    fun statusCodesMapToTypedErrors() = runBlocking {
        val cases = listOf(401 to DaemonException.Unauthorized::class, 404 to DaemonException.NotFound::class, 409 to DaemonException.Conflict::class)
        cases.forEach { (code, type) ->
            server.enqueue(MockResponse().setResponseCode(code))
            try {
                client().complete("task_abc")
                fail("expected a throw for $code")
            } catch (error: DaemonException) {
                assertEquals(type, error::class)
            }
        }
    }

    @Test
    fun anUnreachableHostIsRefusedBeforeAnyRequest() = runBlocking {
        val hostile = DaemonClient(server = "http://evil.example.com", nodeId = "mobile:abc", token = token)
        try {
            hostile.summary(null)
            fail("expected a refusal")
        } catch (expected: DaemonException.UnreachableHost) {
        }
        assertEquals(0, server.requestCount)
    }

    @Test
    fun enrollPostsThePlatformAndCode() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(200).setBody(fixture("enroll-exchange")))
        val enrollment = DaemonClient.enroll(
            server = server.url("/").toString(),
            code = "004221",
            nodeId = "mobile:abc",
            nodeToken = "b".repeat(43),
            name = "iPhone",
            enforceAllowlist = false,
        )
        assertTrue(enrollment.nodeToken.isNotEmpty())
        val request = server.takeRequest()
        assertEquals("/nodes/enroll/exchange", request.path)
        assertTrue(request.body.readUtf8().contains("\"platform\":\"mobile\""))
    }

    @Test
    fun enrollNameContainingAQuoteRoundTrips() = runBlocking {
        // name is free-text the user typed, unlike nodeId which is pattern-
        // constrained. Hand-interpolating it into a JSON literal would let a
        // quote either break the JSON or, worse, smuggle a sibling key in. The
        // body must be built by a real encoder, so a quote in the name must
        // come back out exactly as it went in.
        val nameWithQuote = """My "Pixel" Phone"""
        server.enqueue(MockResponse().setResponseCode(200).setBody(fixture("enroll-exchange")))
        DaemonClient.enroll(
            server = server.url("/").toString(),
            code = "004221",
            nodeId = "mobile:abc",
            nodeToken = "b".repeat(43),
            name = nameWithQuote,
            enforceAllowlist = false,
        )
        val request = server.takeRequest()
        val bodyJson = ProtocolJson.json.parseToJsonElement(request.body.readUtf8()).jsonObject
        assertEquals(nameWithQuote, bodyJson["name"]!!.jsonPrimitive.content)
    }

    @Test
    fun enrollStatusCodesMapToTypedErrors() = runBlocking {
        val cases = listOf(
            401 to DaemonException.Unauthorized::class,
            403 to DaemonException.Unauthorized::class,
            429 to DaemonException.Unauthorized::class,
            409 to DaemonException.Conflict::class,
            500 to DaemonException.Server::class,
        )
        cases.forEach { (code, type) ->
            server.enqueue(MockResponse().setResponseCode(code))
            try {
                DaemonClient.enroll(
                    server = server.url("/").toString(),
                    code = "004221",
                    nodeId = "mobile:abc",
                    nodeToken = "b".repeat(43),
                    name = "iPhone",
                    enforceAllowlist = false,
                )
                fail("expected a throw for $code")
            } catch (error: DaemonException) {
                assertEquals(type, error::class)
                if (error is DaemonException.Server) assertEquals(code, error.code)
            }
        }
    }
}
