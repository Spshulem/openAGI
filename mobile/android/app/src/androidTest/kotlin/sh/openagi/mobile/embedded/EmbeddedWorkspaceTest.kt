package sh.openagi.mobile.embedded

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.runBlocking
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import sh.openagi.mobile.store.Credentials
import sh.openagi.mobile.sync.activateWorkspace
import sh.openagi.mobile.sync.backgroundCredentials
import sh.openagi.mobile.transport.EmbeddedLoopback

@RunWith(AndroidJUnit4::class)
class EmbeddedWorkspaceTest {
    @Test fun actualDaemonServesWorkspaceWithoutAServerOrModelDownload() = runBlocking {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val previous = Credentials.load(context)
        var id: String? = null
        var local: Credentials? = null
        val http = OkHttpClient()
        fun request(credential: Credentials, path: String, body: String? = null, delete: Boolean = false): JsonElement {
            val builder = Request.Builder().url(credential.server + path)
                .header("Authorization", "Bearer ${credential.token}").header("X-OpenAGI-Node-ID", credential.nodeId)
            if (delete) builder.delete() else if (body != null) builder.post(body.toRequestBody("application/json".toMediaType()))
            return http.newCall(builder.build()).execute().use {
                assertEquals("$path must run locally", 200, it.code)
                Json.parseToJsonElement(it.body!!.string())
            }
        }
        try {
            local = EmbeddedAgent.start(context, previous)
            assertTrue(local.isEmbedded)
            // A worker can restore the loopback exception without an Activity.
            EmbeddedLoopback.port = null
            val background = backgroundCredentials(context, local.workspaceId)
            assertEquals(local, background)
            assertEquals(local.server.substringAfterLast(':').toInt(), EmbeddedLoopback.port)
            assertNull(backgroundCredentials(context, "a-different-workspace"))

            // Leaving for server setup must survive a background/relaunch load.
            activateWorkspace(context, null)
            assertNull(Credentials.load(context))
            assertEquals(local, EmbeddedAgent.start(context, activate = false))
            assertNull("A background start must not cancel server setup", Credentials.load(context))
            activateWorkspace(context, local)
            id = request(local, "/tasks", """{"title":"Synthetic phone workspace test","bucket":"today"}""").jsonObject["id"]!!.jsonPrimitive.content
            assertTrue(request(local, "/tasks").jsonObject["tasks"]!!.jsonArray.any { it.jsonObject["id"]!!.jsonPrimitive.content == id })
            assertTrue(request(local, "/mobile/summary").jsonObject["today"]!!.jsonArray.any { it.jsonObject["id"]!!.jsonPrimitive.content == id })
            assertTrue(request(local, "/tasks/clarifications") is JsonArray)
            assertTrue(request(local, "/pending-actions").jsonObject["actions"] is JsonArray)
            assertTrue(request(local, "/conversations/agent/messages").jsonObject["messages"] is JsonArray)
        } finally {
            if (local != null && id != null) request(local, "/tasks/$id", delete = true)
            if (previous != null) Credentials.save(context, previous) else Credentials.clear(context)
            http.dispatcher.executorService.shutdown()
            http.connectionPool.evictAll()
        }
    }
}
