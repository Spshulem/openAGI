package sh.openagi.mobile.embedded

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import java.io.File
import java.net.InetAddress
import java.net.ServerSocket
import java.time.ZoneId
import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.*
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import sh.openagi.mobile.store.Credentials
import sh.openagi.mobile.store.MobileNodeIdentity
import sh.openagi.mobile.transport.EmbeddedLoopback

// The same daemon, stores and approval gates as iOS. No subprocess, downloaded
// executable, network scan, shared owner key or parallel task implementation.
object EmbeddedAgent {
    private val mutex = Mutex()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val http = OkHttpClient.Builder().callTimeout(4, java.util.concurrent.TimeUnit.SECONDS).build()
    private var started = false
    @Volatile private var exitCode: Int? = null
    @Volatile private var ready: Credentials? = null
    private var bridge: DeviceModelBridge? = null
    private var owner = ""
    private var port = 0
    private external fun startNode(root: String, data: String, token: String, port: Int, zone: String): Int

    private fun prefs(context: Context) = EncryptedSharedPreferences.create(context, "sh.openagi.embedded-agent",
        MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM)

    suspend fun serverBackup(context: Context): Credentials? = withContext(Dispatchers.IO) {
        val prefs = prefs(context)
        val server = prefs.getString("server", null) ?: return@withContext null
        val node = prefs.getString("serverNode", null) ?: return@withContext null
        val token = prefs.getString("serverToken", null) ?: return@withContext null
        Credentials(server, node, token)
    }

    suspend fun start(context: Context, previous: Credentials? = null, activate: Boolean = true): Credentials = withContext(Dispatchers.IO) {
        mutex.withLock {
            check(exitCode == null) { "The phone agent stopped. Close and reopen OpenAGI to restart it." }
            val secrets = prefs(context)
            if (previous != null && !previous.isEmbedded) {
                check(secrets.edit().putString("server", previous.server).putString("serverNode", previous.nodeId)
                    .putString("serverToken", previous.token).commit()) { "Couldn't preserve your server pairing securely." }
            }
            ready?.takeIf { credentialWorks(it) }?.let {
                EmbeddedLoopback.port = port
                if (activate) check(Credentials.save(context, it)) { "Couldn't save the phone agent securely." }
                bridge?.connect()
                return@withLock it
            }
            if (!started) {
                owner = secrets.getString("owner", null) ?: MobileNodeIdentity.newToken().also {
                    check(secrets.edit().putString("owner", it).commit()) { "Couldn't save the phone agent securely." }
                }
                val bundle = File(context.filesDir, "embedded-runtime")
                val stamp = context.packageManager.getPackageInfo(context.packageName, 0).lastUpdateTime.toString()
                if (File(bundle, ".version").takeIf { it.exists() }?.readText() != stamp) {
                    bundle.deleteRecursively() // Owned app bundle only; never the agent's data.
                    copyAssets(context, "openagi-daemon", bundle)
                    File(bundle, ".version").writeText(stamp)
                }
                val data = File(context.filesDir, "openagi").apply { mkdirs() }
                port = ServerSocket(0, 1, InetAddress.getByName("127.0.0.1")).use { it.localPort }
                System.loadLibrary("node")
                System.loadLibrary("openagi_node")
                started = true
                Thread(null, {
                    val code = startNode(bundle.absolutePath, data.absolutePath, owner, port, ZoneId.systemDefault().id)
                    exitCode = code
                    EmbeddedLoopback.port = null
                    ready = null
                    bridge?.close()
                }, "openagi-node", 16L * 1024 * 1024).start()
            }
            withTimeout(30_000) {
                while (true) {
                    check(exitCode == null) { "The phone agent stopped. Close and reopen OpenAGI." }
                    val healthy = runCatching { http.newCall(Request.Builder().url("http://127.0.0.1:$port/health").build()).execute().use { it.isSuccessful } }.getOrDefault(false)
                    if (healthy) break
                    delay(250)
                }
            }
            EmbeddedLoopback.port = port
            val savedNode = secrets.getString("node", null)
            val savedToken = secrets.getString("nodeToken", null)
            val savedWorks = if (savedNode != null && savedToken != null) runCatching {
                http.newCall(Request.Builder().url("http://127.0.0.1:$port/tasks")
                    .header("Authorization", "Bearer $savedToken").header("X-OpenAGI-Node-ID", savedNode).build())
                    .execute().use { it.isSuccessful }
            }.getOrDefault(false) else false
            val credential = if (savedWorks) Credentials("http://127.0.0.1:$port", savedNode!!, savedToken!!) else {
                val code = post("/nodes/enrollment-code", buildJsonObject { put("platform", "mobile") })["code"]!!.jsonPrimitive.content
                val node = MobileNodeIdentity.newNodeId()
                val token = MobileNodeIdentity.newToken()
                val enrolled = post("/nodes/enroll/exchange", buildJsonObject {
                    put("code", code); put("platform", "mobile"); put("nodeId", node); put("nodeToken", token); put("name", "This Android phone")
                })
                Credentials("http://127.0.0.1:$port", enrolled["node"]!!.jsonObject["id"]!!.jsonPrimitive.content,
                    enrolled["nodeToken"]!!.jsonPrimitive.content).also {
                    check(secrets.edit().putString("node", it.nodeId).putString("nodeToken", it.token).commit()) { "Couldn't save the local pairing." }
                }
            }
            bridge?.close()
            bridge = DeviceModelBridge(scope, port, owner).also { it.connect() }
            // An explicit local choice must not silently use a saved cloud key.
            post("/settings/models", buildJsonObject { put("preference", "on-device") })
            if (activate) check(Credentials.save(context, credential)) { "Couldn't save the phone agent securely." }
            ready = credential
            credential
        }
    }

    fun reconnect() { bridge?.connect() }

    private fun credentialWorks(credentials: Credentials): Boolean = runCatching {
        http.newCall(Request.Builder().url(credentials.server + "/tasks")
            .header("Authorization", "Bearer ${credentials.token}").header("X-OpenAGI-Node-ID", credentials.nodeId).build())
            .execute().use { it.isSuccessful }
    }.getOrDefault(false)

    private fun post(path: String, body: JsonObject): JsonObject {
        val request = Request.Builder().url("http://127.0.0.1:$port$path").header("Authorization", "Bearer $owner")
            .post(body.toString().toRequestBody("application/json".toMediaType())).build()
        return http.newCall(request).execute().use { response ->
            check(response.isSuccessful) { "The phone agent couldn't complete setup (HTTP ${response.code})." }
            Json.parseToJsonElement(response.body!!.string()).jsonObject
        }
    }

    private fun copyAssets(context: Context, source: String, target: File) {
        val children = context.assets.list(source).orEmpty()
        if (children.isEmpty()) {
            target.parentFile?.mkdirs()
            context.assets.open(source).use { input -> target.outputStream().use { input.copyTo(it) } }
        } else {
            target.mkdirs()
            children.forEach { copyAssets(context, "$source/$it", File(target, it)) }
        }
    }
}
