package sh.openagi.mobile.ui

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import sh.openagi.mobile.transport.DiscoveredServer
import sh.openagi.mobile.transport.ServerDiscovery

@Composable
fun ServerDiscoverySection(address: String, savedAddress: String?, onSelect: (String) -> Unit) {
    val context = LocalContext.current
    val discovery = remember { ServerDiscovery(context.applicationContext) }
    val scope = rememberCoroutineScope()
    var servers by remember { mutableStateOf<List<DiscoveredServer>>(emptyList()) }
    var searching by remember { mutableStateOf(false) }
    var note by remember { mutableStateOf<String?>(null) }
    var search by remember { mutableStateOf<Job?>(null) }
    DisposableEffect(discovery) { onDispose { search?.cancel(); discovery.stop() } }

    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        OutlinedButton(enabled = !searching, onClick = {
            searching = true
            note = "Looking on this Wi-Fi network and checking your saved or entered address…"
            servers = emptyList()
            search = scope.launch {
                val addresses = (listOfNotNull(savedAddress) + address.takeIf { it.isNotBlank() }).filterNotNull().distinct()
                fun add(server: DiscoveredServer) { servers = (servers + server).distinctBy { it.address }.take(12) }
                discovery.start(onServer = { add(it) }, onError = { note = "Local discovery is unavailable. You can still enter and check a server address." })
                addresses.forEach { candidate ->
                    launch {
                        if (ServerDiscovery.reachable(candidate)) add(DiscoveredServer(candidate, "Reachable saved or entered server"))
                    }
                }
                delay(8_000)
                discovery.stop()
                searching = false
                note = if (servers.isEmpty()) "No servers found. Turn on Tailscale and Use Tailscale DNS, or join the same Wi-Fi as your server. You can also enter its address below." else "Check that the address matches your main server before entering its pairing code."
            }
        }) { Text(if (searching) "Searching…" else "Find servers · Wi-Fi / saved Tailscale") }
        servers.forEach { server ->
            TextButton(onClick = { onSelect(server.address) }, modifier = Modifier.fillMaxWidth()) {
                Column(Modifier.fillMaxWidth()) {
                    Text(server.name)
                    Text(server.address, style = MaterialTheme.typography.bodySmall)
                }
            }
        }
        note?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
        Text("Nearby discovery uses Bonjour. Tailscale servers are checked by their saved or entered address; keep Tailscale and its DNS enabled.", style = MaterialTheme.typography.bodySmall)
    }
}
