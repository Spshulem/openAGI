package sh.openagi.mobile.ui

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Job
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import sh.openagi.mobile.transport.DiscoveredServer
import sh.openagi.mobile.transport.ServerDiscovery
import sh.openagi.mobile.transport.SERVER_DISCOVERY_HELP
import sh.openagi.mobile.transport.SERVER_DISCOVERY_NETWORK_HELP
import sh.openagi.mobile.transport.serverDiscoveryNote

@Composable
fun ServerDiscoverySection(address: String, savedAddress: String?, onSelect: (String) -> Unit) {
    val context = LocalContext.current
    val discovery = remember { ServerDiscovery(context.applicationContext) }
    val scope = rememberCoroutineScope()
    var servers by remember { mutableStateOf<List<DiscoveredServer>>(emptyList()) }
    var searching by remember { mutableStateOf(false) }
    var finished by remember { mutableStateOf(false) }
    var discoveryUnavailable by remember { mutableStateOf(false) }
    var search by remember { mutableStateOf<Job?>(null) }
    DisposableEffect(discovery) { onDispose { search?.cancel(); discovery.stop() } }

    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(SERVER_DISCOVERY_HELP, style = MaterialTheme.typography.bodySmall)
        OutlinedButton(enabled = !searching, onClick = {
            searching = true
            finished = false
            discoveryUnavailable = false
            servers = emptyList()
            search = scope.launch {
                val addresses = (listOfNotNull(savedAddress) + address.takeIf { it.isNotBlank() }).filterNotNull().distinct()
                fun add(server: DiscoveredServer) {
                    servers = if (servers.any { it.address == server.address }) servers.map { if (it.address == server.address) server else it }
                    else (servers + server).take(12)
                }
                try {
                    coroutineScope {
                        fun check(server: DiscoveredServer) {
                            add(server)
                            launch { add(server.copy(reachable = ServerDiscovery.reachable(server.address))) }
                        }
                        discovery.start(onServer = { check(it) }, onError = { discoveryUnavailable = true })
                        addresses.forEach { check(DiscoveredServer(it, "Saved or entered server")) }
                        delay(8_000)
                        discovery.stop()
                    }
                } finally {
                    discovery.stop()
                    searching = false
                    finished = true
                }
            }
        }) { Text(if (searching) "Searching…" else "Find and check servers") }
        servers.forEach { server ->
            TextButton(onClick = { onSelect(server.address) }, modifier = Modifier.fillMaxWidth()) {
                Column(Modifier.fillMaxWidth()) {
                    Text(server.name)
                    Text(server.address, style = MaterialTheme.typography.bodySmall)
                    Text(when (server.reachable) {
                        true -> "OpenAGI is responding"
                        false -> "Not reachable · check server and network"
                        null -> "Checking connection…"
                    }, style = MaterialTheme.typography.bodySmall)
                }
            }
        }
        serverDiscoveryNote(searching, finished, discoveryUnavailable, servers)?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
        Text(SERVER_DISCOVERY_NETWORK_HELP, style = MaterialTheme.typography.bodySmall)
    }
}
