package sh.openagi.mobile.transport

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Handler
import android.os.Looper
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.util.concurrent.TimeUnit

data class DiscoveredServer(val address: String, val name: String)

// Only DNS-SD announcements and addresses supplied/saved by the person are
// checked. No subnet sweep, tailnet credentials, pairing codes or owner tokens.
class ServerDiscovery(context: Context) {
    private val manager = context.getSystemService(NsdManager::class.java)
    private val main = Handler(Looper.getMainLooper())
    private var listener: NsdManager.DiscoveryListener? = null
    private var generation = 0
    private val pending = ArrayDeque<NsdServiceInfo>()
    private var resolving = false
    private var seen = 0

    fun start(onServer: (DiscoveredServer) -> Unit, onError: () -> Unit) {
        stop()
        val run = generation
        fun resolveNext() {
            if (generation != run || resolving || pending.isEmpty()) return
            resolving = true
            @Suppress("DEPRECATION")
            manager.resolveService(pending.removeFirst(), object : NsdManager.ResolveListener {
                override fun onResolveFailed(service: NsdServiceInfo, error: Int) = finish(null)
                override fun onServiceResolved(service: NsdServiceInfo) = finish(service)
                private fun finish(service: NsdServiceInfo?) {
                    main.post {
                        if (generation != run) return@post
                        resolving = false
                        service?.let {
                            val advertised = (it.attributes["main"] ?: it.attributes["url"])?.toString(Charsets.UTF_8)
                            val host = it.host?.hostAddress?.takeUnless { h -> h.contains('%') }
                            val address = advertised ?: host?.let { h ->
                                "http://${if (h.contains(':')) "[$h]" else h}:${it.port}"
                            }
                            if (address != null) runCatching { HostAllowlist.validate(address).toString() }
                                .getOrNull()?.let { url -> onServer(DiscoveredServer(url, it.serviceName.take(80))) }
                        }
                        resolveNext()
                    }
                }
            })
        }
        val discovery = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(type: String) {}
            override fun onDiscoveryStopped(type: String) {}
            override fun onServiceLost(service: NsdServiceInfo) {}
            override fun onStartDiscoveryFailed(type: String, error: Int) { main.post { if (generation == run) onError() } }
            override fun onStopDiscoveryFailed(type: String, error: Int) {}
            override fun onServiceFound(service: NsdServiceInfo) {
                main.post {
                    if (generation != run || seen >= 12 || service.serviceType.trimEnd('.') != "_openagi._tcp") return@post
                    seen++
                    pending.addLast(service)
                    resolveNext()
                }
            }
        }
        listener = discovery
        try { manager.discoverServices("_openagi._tcp.", NsdManager.PROTOCOL_DNS_SD, discovery) }
        catch (_: RuntimeException) { onError() }
    }

    fun stop() {
        generation++
        listener?.let { runCatching { manager.stopServiceDiscovery(it) } }
        listener = null
        pending.clear()
        resolving = false
        seen = 0
    }

    companion object {
        private val healthClient = OkHttpClient.Builder()
            .followRedirects(false).followSslRedirects(false)
            .connectTimeout(3, TimeUnit.SECONDS).readTimeout(3, TimeUnit.SECONDS)
            .callTimeout(4, TimeUnit.SECONDS).build()

        suspend fun reachable(raw: String): Boolean = withContext(Dispatchers.IO) {
            runCatching {
                val origin = HostAllowlist.validate(raw)
                val request = Request.Builder().url(origin.newBuilder().addPathSegment("health").build()).build()
                healthClient.newCall(request).execute().use { response ->
                    response.code == 200 && response.body?.source()?.let { source ->
                        source.request(16_385)
                        source.buffer.size <= 16_384 && JSONObject(source.buffer.readUtf8()).optBoolean("ok")
                    } == true
                }
            }.getOrDefault(false)
        }
    }
}
