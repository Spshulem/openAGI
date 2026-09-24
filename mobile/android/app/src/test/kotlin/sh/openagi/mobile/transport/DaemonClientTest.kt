package sh.openagi.mobile.transport

import kotlinx.coroutines.flow.take
import kotlinx.coroutines.flow.toList
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

    // ─── Tasks ────────────────────────────────────────────────────────────

    private val taskJson = """
        {"id":"task_1","queue":"user","title":"Ship the widget","description":"","bucket":"today",
         "priority":80,"category":null,"tags":[],"source":"manual","sourceId":null,"sourceUrl":null,
         "sourceMeta":null,"status":"pending","dueDate":null,"scheduledFor":null,"parentGoalId":null,
         "dependsOn":[],"createdAt":"2026-09-20T04:48:28.116Z","updatedAt":"2026-09-20T04:48:28.116Z",
         "completedAt":null,"completedVia":null}
    """.trimIndent()

    @Test
    fun tasksListsWithTheQueueParameterAlwaysSet() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(200).setBody(fixture("tasks-list")))
        val tasks = client().tasks()
        assertEquals(5, tasks.size)
        assertEquals("Ship the widget", tasks.first().title)
        val request = server.takeRequest()
        assertEquals("/tasks?queue=user", request.path)
    }

    @Test
    fun tasksForwardsOptionalFilters() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"tasks":[]}"""))
        client().tasks(bucket = "this_week", status = "pending", limit = 5)
        val path = server.takeRequest().path!!
        assertTrue(path.contains("bucket=this_week"))
        assertTrue(path.contains("status=pending"))
        assertTrue(path.contains("limit=5"))
    }

    @Test
    fun createTaskPostsAndDecodesTheCreatedTask() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(200).setBody(taskJson))
        val task = client().createTask(sh.openagi.mobile.protocol.CreateTaskRequest(title = "Ship the widget", bucket = "today"))
        assertEquals("task_1", task.id)
        val request = server.takeRequest()
        assertEquals("/tasks", request.path)
        assertTrue(request.body.readUtf8().contains("\"title\":\"Ship the widget\""))
    }

    @Test
    fun getTaskFetchesById() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(200).setBody(taskJson))
        assertEquals("task_1", client().getTask("task_1").id)
        assertEquals("/tasks/task_1", server.takeRequest().path)
    }

    @Test
    fun updateTaskOmitsUntouchedFieldsFromTheBody() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(200).setBody(taskJson))
        client().updateTask("task_1", sh.openagi.mobile.protocol.UpdateTaskRequest(status = "in_progress"))
        val request = server.takeRequest()
        assertEquals("PATCH", request.method)
        val body = request.body.readUtf8()
        assertEquals("""{"status":"in_progress"}""", body)
    }

    @Test
    fun completeTaskReturnsTheFullUpdatedTask() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(200).setBody(taskJson))
        val task = client().completeTask("task_1")
        assertEquals("task_1", task.id)
        val request = server.takeRequest()
        assertEquals("/tasks/task_1/complete", request.path)
        assertEquals("""{"completedVia":"mobile"}""", request.body.readUtf8())
    }

    @Test
    fun deleteTaskSendsDeleteAndReturnsTrueOnSuccess() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"ok":true,"id":"task_1"}"""))
        assertTrue(client().deleteTask("task_1"))
        val request = server.takeRequest()
        assertEquals("DELETE", request.method)
        assertEquals("/tasks/task_1", request.path)
    }

    @Test
    fun deleteTaskOnAMissingTaskThrowsNotFound() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(404).setBody("""{"ok":false,"id":"task_1"}"""))
        try {
            client().deleteTask("task_1")
            fail("expected a throw")
        } catch (expected: DaemonException.NotFound) {
        }
    }

    // ─── Pending actions ──────────────────────────────────────────────────

    @Test
    fun pendingActionsListsWithStatusParameter() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(200).setBody(fixture("pending-actions")))
        val actions = client().pendingActions()
        assertEquals(1, actions.size)
        assertEquals("send_email", actions.first().toolName)
        assertEquals("/pending-actions?status=pending", server.takeRequest().path)
    }

    @Test
    fun approveActionOnSuccessDecodesTheOkEnvelope() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"ok":true,"result":{"sent":true}}"""))
        val result = client().approveAction("act_1")
        assertTrue(result.ok)
        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/pending-actions/act_1/approve", request.path)
    }

    // The one case the whole-branch review would have caught: the daemon
    // returns HTTP 400 (not 200) with a legitimate {ok:false, error} body
    // when the approved tool itself failed. That body must still decode,
    // not be discarded as a generic DaemonException.Server(400).
    @Test
    fun approveActionOnA400StillDecodesTheFailureEnvelopeRatherThanThrowing() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(400).setBody("""{"ok":false,"error":"tool execution failed"}"""))
        val result = client().approveAction("act_1")
        assertEquals(false, result.ok)
        assertEquals("tool execution failed", result.error)
    }

    @Test
    fun approveActionStatusCodesMapToTypedErrors() = runBlocking {
        val cases = listOf(401 to DaemonException.Unauthorized::class, 404 to DaemonException.NotFound::class, 409 to DaemonException.Conflict::class, 410 to DaemonException.Server::class)
        cases.forEach { (code, type) ->
            server.enqueue(MockResponse().setResponseCode(code))
            try {
                client().approveAction("act_1")
                fail("expected a throw for $code")
            } catch (error: DaemonException) {
                assertEquals(type, error::class)
            }
        }
    }

    @Test
    fun denyActionSendsTheOptionalReason() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"id":"act_1","status":"denied"}"""))
        val result = client().denyAction("act_1", "not now")
        assertEquals("denied", result.status)
        val request = server.takeRequest()
        assertEquals("""{"reason":"not now"}""", request.body.readUtf8())
    }

    // ─── Clarifications ───────────────────────────────────────────────────

    @Test
    fun clarificationsDecodesABareJsonArray() = runBlocking {
        server.enqueue(
            MockResponse().setResponseCode(200).setBody(
                """[{"id":"clar_1","taskId":"task_1","question":"Did you finish this?","status":"pending","sources":[]}]""",
            ),
        )
        val clarifications = client().clarifications()
        assertEquals(1, clarifications.size)
        assertEquals("Did you finish this?", clarifications.first().question)
        assertEquals("/tasks/clarifications?status=pending", server.takeRequest().path)
    }

    @Test
    fun answerClarificationPostsTheLiteralAnswer() = runBlocking {
        server.enqueue(
            MockResponse().setResponseCode(200).setBody(
                """{"clarification":{"id":"clar_1","taskId":"task_1","question":"Done?","status":"answered","sources":[]}}""",
            ),
        )
        val result = client().answerClarification("clar_1", sh.openagi.mobile.protocol.ClarificationAnswer.YES)
        assertEquals("answered", result.clarification.status)
        val request = server.takeRequest()
        assertEquals("""{"answer":"yes"}""", request.body.readUtf8())
    }

    // ─── Streaming (SSE) ──────────────────────────────────────────────────

    @Test
    fun eventsStreamsFramesAsTheyArrive() = runBlocking {
        server.enqueue(
            MockResponse()
                .setResponseCode(200)
                .setHeader("Content-Type", "text/event-stream")
                .setChunkedBody("event: hello\ndata: {}\n\nevent: task-updated\ndata: {\"op\":\"create\"}\n\n", 1024)
                .setSocketPolicy(okhttp3.mockwebserver.SocketPolicy.KEEP_OPEN),
        )
        // Guards against a hang, not just a wrong answer: cancelling a
        // collector mid-stream must actually close the OkHttp call rather
        // than leaving the reader thread blocked forever on the next byte.
        val frames = kotlinx.coroutines.withTimeout(5_000) {
            client().events().take(2).toList()
        }
        assertEquals(listOf("hello", "task-updated"), frames.map { it.event })
        val request = server.takeRequest()
        assertEquals("/events", request.path)
        assertEquals("text/event-stream", request.getHeader("Accept"))
    }

    @Test
    fun sendMessageStreamPostsWithEventStreamAcceptHeader() = runBlocking {
        server.enqueue(
            MockResponse()
                .setResponseCode(200)
                .setChunkedBody("event: final\ndata: {\"reply\":\"hi there\"}\n\n", 1024)
                .setSocketPolicy(okhttp3.mockwebserver.SocketPolicy.KEEP_OPEN),
        )
        val frames = kotlinx.coroutines.withTimeout(5_000) {
            client().sendMessageStream("hello").take(1).toList()
        }
        assertEquals("final", frames.first().event)
        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/message", request.path)
        assertEquals("text/event-stream", request.getHeader("Accept"))
        assertEquals("""{"text":"hello"}""", request.body.readUtf8())
    }

    @Test
    fun eventsStatusCodesArriveAsTypedErrorsNotSilentEmptyStreams() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(401))
        try {
            kotlinx.coroutines.withTimeout(5_000) { client().events().toList() }
            fail("expected a throw")
        } catch (expected: DaemonException.Unauthorized) {
        }
    }
}
