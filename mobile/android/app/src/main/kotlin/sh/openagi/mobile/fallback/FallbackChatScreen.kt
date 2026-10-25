package sh.openagi.mobile.fallback

import android.content.Context
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.google.mlkit.genai.common.FeatureStatus
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import sh.openagi.mobile.ui.components.FoldSafeSinglePane

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FallbackChatScreen(context: Context, localAgentMode: Boolean = false, onDismiss: () -> Unit) {
    var provider by remember { mutableStateOf(FallbackProvider.LOCAL) }
    var model by remember { mutableStateOf(provider.defaultModel) }
    var modelDraft by remember { mutableStateOf(model) }
    var lines by remember { mutableStateOf<List<FallbackLine>>(emptyList()) }
    var draft by remember { mutableStateOf("") }
    var key by remember { mutableStateOf("") }
    var hasKey by remember { mutableStateOf(false) }
    var options by remember { mutableStateOf(true) }
    var busy by remember { mutableStateOf(false) }
    var localStatus by remember { mutableStateOf<Int?>(null) }
    var localNote by remember { mutableStateOf("Checking Gemini Nano availability…") }
    var localProgress by remember { mutableStateOf<LocalModelProgress?>(null) }
    var localRequest by remember { mutableIntStateOf(0) }
    var preparingLocal by remember { mutableStateOf(false) }
    var localPreparation by remember { mutableStateOf<Job?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var vault by remember { mutableStateOf<FallbackVault?>(null) }
    var loading by remember { mutableStateOf(true) }
    val scope = rememberCoroutineScope()
    val scroll = rememberLazyListState()

    LaunchedEffect(Unit) {
        try {
            val loaded = withContext(Dispatchers.IO) { FallbackVault(context.applicationContext) }
            provider = withContext(Dispatchers.IO) { loaded.provider() }
            vault = loaded
        }
        catch (_: Exception) { error = "Secure storage is unavailable. Close and reopen the app to try again; no API key or conversation has been stored." }
    }
    LaunchedEffect(provider, vault) {
        loading = true
        lines = emptyList()
        hasKey = false
        if (provider == FallbackProvider.LOCAL) localNote = "Checking Gemini Nano availability…"
        key = ""
        error = null
        if (vault == null) return@LaunchedEffect
        val request = ++localRequest
        try {
            val selectedProvider = provider
            val loaded = withContext(Dispatchers.IO) {
                val selectedModel = vault?.model(selectedProvider) ?: selectedProvider.defaultModel
                Triple(selectedModel, vault?.key(selectedProvider) != null, vault?.history(selectedProvider, selectedModel).orEmpty())
            }
            model = loaded.first
            hasKey = loaded.second
            lines = loaded.third
            modelDraft = model
            if (provider == FallbackProvider.LOCAL) {
                localStatus = withTimeout(20_000) { LocalChat.status() }
                localProgress = null
                localNote = when (localStatus) {
                    FeatureStatus.AVAILABLE -> "Ready on this phone"
                    FeatureStatus.DOWNLOADABLE -> "Gemini Nano needs to download before your first chat."
                    FeatureStatus.DOWNLOADING -> "Google AICore is downloading Gemini Nano. Check to follow its progress."
                    else -> "Gemini Nano isn't supported or ready on this device. You can use a hosted provider."
                }
            }
        } catch (_: TimeoutCancellationException) {
            localNote = "Google AICore is taking too long to respond. Check Gemini Nano again or choose a hosted provider."
        } catch (e: CancellationException) { throw e }
        catch (_: Exception) {
            lines = emptyList()
            error = "Couldn't load this conversation securely. No previous provider history will be sent. Try selecting the model again."
        }
        finally { if (request == localRequest) loading = false }
    }
    LaunchedEffect(lines.size, busy) { if (lines.isNotEmpty()) scroll.animateScrollToItem(lines.lastIndex) }

    fun send() {
        val text = draft.trim()
        if (text.isEmpty() || busy) return
        val selectedProvider = provider
        val selectedModel = model
        draft = ""
        busy = true
        error = null
        lines = lines + FallbackLine("user", text)
        scope.launch {
            try {
                withContext(Dispatchers.IO) { vault?.saveHistory(selectedProvider, selectedModel, lines) }
                val result = if (selectedProvider == FallbackProvider.LOCAL) withTimeout(90_000) { LocalChat.reply(lines) }
                else {
                    val secret = withContext(Dispatchers.IO) { vault?.key(selectedProvider) } ?: throw FallbackException("Save your ${selectedProvider.title} API key first.")
                    FallbackTransport.reply(selectedProvider, selectedModel, secret, lines)
                }
                lines = lines + FallbackLine("assistant", result)
                withContext(Dispatchers.IO) { vault?.saveHistory(selectedProvider, selectedModel, lines) }
            } catch (_: TimeoutCancellationException) { error = "The local model took too long to reply. Your message is saved; you can retry or choose a hosted provider." }
            catch (e: CancellationException) { throw e }
            catch (e: FallbackException) { error = e.message }
            catch (_: Exception) { error = "Couldn't finish the reply. Your message is saved. Check your connection or choose another model." }
            finally { busy = false }
        }
    }

    fun selectProvider(choice: FallbackProvider) {
        if (provider == choice) return
        localRequest++
        localPreparation?.cancel()
        localPreparation = null
        preparingLocal = false
        localProgress = null
        loading = true
        lines = emptyList()
        hasKey = false
        provider = choice
    }

    fun cancelLocal() {
        localRequest++
        localPreparation?.cancel()
        localPreparation = null
        preparingLocal = false
        localProgress = null
        localNote = "Setup stopped here. Google AICore may continue a system download; check Gemini Nano to resume."
    }

    fun prepareLocal() {
        if (preparingLocal || loading) return
        val request = ++localRequest
        preparingLocal = true
        localProgress = null
        localNote = "Checking Gemini Nano with Google AICore…"
        localPreparation = scope.launch {
            try {
                val status = withTimeout(20_000) { LocalChat.status() }
                if (status == FeatureStatus.DOWNLOADABLE || status == FeatureStatus.DOWNLOADING) {
                    localNote = "Starting Gemini Nano download…"
                    withTimeout(15 * 60_000L) {
                        LocalChat.download().collect { progress ->
                            if (request == localRequest) localProgress = progress
                        }
                    }
                    localProgress = null
                    localNote = "Getting Gemini Nano ready on this phone…"
                }
                val ready = withTimeout(20_000) { LocalChat.status() }
                if (request == localRequest) {
                    localStatus = ready
                    localNote = if (ready == FeatureStatus.AVAILABLE) "Gemini Nano is ready on this phone" else "Gemini Nano isn't ready. Keep Wi-Fi on and check again, or choose a hosted provider."
                }
            } catch (_: TimeoutCancellationException) {
                if (request == localRequest) localNote = "Gemini Nano setup timed out. Check again to resume, or choose a hosted provider."
            } catch (e: CancellationException) { throw e }
            catch (e: FallbackException) {
                if (request == localRequest) localNote = e.message ?: "Gemini Nano couldn't download. Check Wi-Fi and try again."
            } catch (_: Exception) {
                if (request == localRequest) localNote = "Couldn't prepare Gemini Nano. Update Android System Intelligence / AICore and try again, or choose a hosted provider."
            } finally {
                if (request == localRequest) {
                    localProgress = null
                    preparingLocal = false
                    localPreparation = null
                }
            }
        }
    }

    Dialog(onDismissRequest = { if (!busy) onDismiss() }, properties = DialogProperties(usePlatformDefaultWidth = false, dismissOnBackPress = !busy, dismissOnClickOutside = false)) {
        Surface(modifier = Modifier.fillMaxSize()) {
            FoldSafeSinglePane {
                Scaffold(topBar = {
                    TopAppBar(title = { Text(if (localAgentMode) "Gemini Nano" else if (options) "Chat options" else "Chat without server") },
                        navigationIcon = { TextButton(onClick = { if (localAgentMode) onDismiss() else if (options) { options = false; key = "" } else onDismiss() }, enabled = !busy) { Text(if (options || localAgentMode) "Back" else "Server") } },
                        actions = { if (!options) TextButton(onClick = { modelDraft = model; options = true }, enabled = !busy) { Text("Options") } })
                }) { padding ->
                    Column(Modifier.padding(padding).fillMaxSize().imePadding().padding(horizontal = 16.dp)) {
                        Text(if (provider == FallbackProvider.LOCAL) "On this phone · Gemini Nano" else "Direct · ${provider.title} · $model", style = MaterialTheme.typography.titleSmall)
                        Text(if (localAgentMode) "Gemini Nano powers your phone agent. Tasks, Today, Inbox and history stay in its local workspace." else "Separate chat on this phone. Server tasks, integrations and shared history need your server connection.", style = MaterialTheme.typography.bodySmall)
                        Spacer(Modifier.height(12.dp))
                        if (options) {
                            LazyColumn(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                                if (provider == FallbackProvider.LOCAL) {
                                    item {
                                        LocalModelCard(
                                            note = localNote,
                                            progress = localProgress,
                                            working = preparingLocal || loading,
                                            canPrepare = !busy && !loading,
                                            needsDownload = localStatus == FeatureStatus.DOWNLOADABLE,
                                            onPrepare = { prepareLocal() },
                                            onCancel = if (preparingLocal) ({ cancelLocal() }) else null,
                                        )
                                    }
                                }
                                item { Text("Choose a model", style = MaterialTheme.typography.titleMedium) }
                                itemsIndexed(if (localAgentMode) listOf(FallbackProvider.LOCAL) else FallbackProvider.entries) { _, choice ->
                                    Row(Modifier.fillMaxWidth()) {
                                        RadioButton(selected = provider == choice, onClick = { selectProvider(choice) }, enabled = !busy)
                                        TextButton(onClick = { selectProvider(choice) }, enabled = !busy) { Text(choice.title) }
                                    }
                                }
                                if (provider != FallbackProvider.LOCAL) {
                                    item { OutlinedTextField(value = modelDraft, onValueChange = { modelDraft = it }, label = { Text("Model ID") }, enabled = !busy && !loading, singleLine = true, modifier = Modifier.fillMaxWidth()) }
                                    item { OutlinedTextField(value = key, onValueChange = { key = it }, label = { Text(if (hasKey) "Replace saved API key" else "API key") }, enabled = !busy && !loading, visualTransformation = PasswordVisualTransformation(), singleLine = true, modifier = Modifier.fillMaxWidth()) }
                                    item {
                                        Button(enabled = key.isNotBlank() && vault != null && !busy && !loading, onClick = {
                                            val selectedProvider = provider
                                            val enteredKey = key
                                            busy = true
                                            scope.launch {
                                                try { withContext(Dispatchers.IO) { vault!!.saveKey(selectedProvider, enteredKey) }; key = ""; hasKey = true; error = null }
                                                catch (_: Exception) { error = "Couldn't save the key securely on this phone." }
                                                finally { busy = false }
                                            }
                                        }) { Text("Save key securely on this phone") }
                                    }
                                    if (hasKey) item {
                                        Text("API key saved in Android Keystore-protected storage")
                                        TextButton(enabled = !busy && !loading, onClick = {
                                            val selectedProvider = provider
                                            busy = true
                                            scope.launch { try { withContext(Dispatchers.IO) { vault?.removeKey(selectedProvider) }; hasKey = false } catch (_: Exception) { error = "Couldn't remove the saved key." } finally { busy = false } }
                                        }) { Text("Remove saved key") }
                                    }
                                }
                                item { Text("Only messages written in this separate chat go to the selected provider. Keys are encrypted on this device and sent only to that provider. Provider usage may be billed to your account. Your OpenAGI pairing and server history stay saved.", style = MaterialTheme.typography.bodySmall) }
                            }
                            Button(modifier = Modifier.fillMaxWidth(), enabled = !busy && !loading && vault != null && (if (provider == FallbackProvider.LOCAL) localStatus == FeatureStatus.AVAILABLE && !preparingLocal else hasKey && modelDraft.isNotBlank()), onClick = {
                                busy = true
                                scope.launch {
                                    lines = emptyList()
                                    try {
                                        model = if (provider == FallbackProvider.LOCAL) provider.defaultModel else modelDraft.trim()
                                        val selectedProvider = provider
                                        val selectedModel = model
                                        lines = withContext(Dispatchers.IO) {
                                            vault?.saveModel(selectedProvider, selectedModel)
                                            vault?.history(selectedProvider, selectedModel).orEmpty()
                                        }
                                        key = ""
                                        if (localAgentMode) onDismiss() else options = false
                                    } catch (_: Exception) {
                                        lines = emptyList()
                                        hasKey = false
                                        error = "Couldn't load this conversation securely. Try selecting the model again."
                                    }
                                    finally { busy = false }
                                }
                            }) { Text("Use ${provider.title}") }
                        } else {
                            LazyColumn(Modifier.weight(1f), state = scroll, verticalArrangement = Arrangement.spacedBy(12.dp), contentPadding = PaddingValues(vertical = 12.dp)) {
                                itemsIndexed(lines) { _, line ->
                                    Column {
                                        Text(if (line.role == "user") "You" else provider.title, style = MaterialTheme.typography.labelSmall)
                                        SelectionContainer { Text(line.text) }
                                    }
                                }
                            }
                            if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
                            Row(Modifier.fillMaxWidth().padding(vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                OutlinedTextField(value = draft, onValueChange = { draft = it }, label = { Text("Message ${provider.title}") }, maxLines = 5, modifier = Modifier.weight(1f))
                                Button(onClick = { send() }, enabled = draft.isNotBlank() && !busy && (provider == FallbackProvider.LOCAL || hasKey)) { Text("Send") }
                            }
                        }
                        error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(vertical = 8.dp)) }
                    }
                }
            }
        }
    }
}
