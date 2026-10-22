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
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import sh.openagi.mobile.ui.components.FoldSafeSinglePane

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FallbackChatScreen(context: Context, onDismiss: () -> Unit) {
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
    var localNote by remember { mutableStateOf("Checking local model…") }
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
        key = ""
        error = null
        if (vault == null) return@LaunchedEffect
        try {
            withContext(Dispatchers.IO) {
                model = vault?.model(provider) ?: provider.defaultModel
                hasKey = vault?.key(provider) != null
                lines = vault?.history(provider, model).orEmpty()
            }
            modelDraft = model
            if (provider == FallbackProvider.LOCAL) {
                localStatus = LocalChat.status()
                localNote = when (localStatus) {
                    FeatureStatus.AVAILABLE -> "Ready on this phone"
                    FeatureStatus.DOWNLOADABLE -> "Model download needed"
                    FeatureStatus.DOWNLOADING -> "Model is downloading. Check again shortly."
                    else -> "Gemini Nano isn't supported or ready on this device. You can use a hosted provider."
                }
            }
        } catch (e: CancellationException) { throw e }
        catch (_: Exception) { localNote = "The local model isn't available right now. Update Android System Intelligence / AICore and check again, or choose a hosted provider." }
        finally { loading = false }
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
                val result = if (selectedProvider == FallbackProvider.LOCAL) LocalChat.reply(lines)
                else {
                    val secret = withContext(Dispatchers.IO) { vault?.key(selectedProvider) } ?: throw FallbackException("Save your ${selectedProvider.title} API key first.")
                    FallbackTransport.reply(selectedProvider, selectedModel, secret, lines)
                }
                lines = lines + FallbackLine("assistant", result)
                withContext(Dispatchers.IO) { vault?.saveHistory(selectedProvider, selectedModel, lines) }
            } catch (e: CancellationException) { throw e }
            catch (e: FallbackException) { error = e.message }
            catch (_: Exception) { error = "Couldn't finish the reply. Your message is saved. Check your connection or choose another model." }
            finally { busy = false }
        }
    }

    Dialog(onDismissRequest = { if (!busy) onDismiss() }, properties = DialogProperties(usePlatformDefaultWidth = false, dismissOnBackPress = !busy, dismissOnClickOutside = false)) {
        Surface(modifier = Modifier.fillMaxSize()) {
            FoldSafeSinglePane {
                Scaffold(topBar = {
                    TopAppBar(title = { Text(if (options) "Chat options" else "Chat without server") },
                        navigationIcon = { TextButton(onClick = { if (options) { options = false; key = "" } else onDismiss() }, enabled = !busy) { Text(if (options) "Back" else "Server") } },
                        actions = { if (!options) TextButton(onClick = { modelDraft = model; options = true }, enabled = !busy) { Text("Options") } })
                }) { padding ->
                    Column(Modifier.padding(padding).fillMaxSize().imePadding().padding(horizontal = 16.dp)) {
                        Text(if (provider == FallbackProvider.LOCAL) "On this phone · Gemini Nano" else "Direct · ${provider.title} · $model", style = MaterialTheme.typography.titleSmall)
                        Text("Separate chat on this phone. Server tasks, integrations and shared history need your server connection.", style = MaterialTheme.typography.bodySmall)
                        Spacer(Modifier.height(12.dp))
                        if (options) {
                            LazyColumn(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                                item { Text("Choose a model", style = MaterialTheme.typography.titleMedium) }
                                itemsIndexed(FallbackProvider.entries) { _, choice ->
                                    Row(Modifier.fillMaxWidth()) {
                                        RadioButton(selected = provider == choice, onClick = { if (provider != choice) { loading = true; provider = choice } }, enabled = !busy)
                                        TextButton(onClick = { if (provider != choice) { loading = true; provider = choice } }, enabled = !busy) { Text(choice.title) }
                                    }
                                }
                                if (provider == FallbackProvider.LOCAL) {
                                    item { Text(localNote) }
                                    item {
                                        OutlinedButton(enabled = !busy && !loading, onClick = {
                                            busy = true
                                            scope.launch {
                                                try {
                                                    if (LocalChat.status() == FeatureStatus.DOWNLOADABLE) LocalChat.download { localNote = it }
                                                    localStatus = LocalChat.status()
                                                    localNote = if (localStatus == FeatureStatus.AVAILABLE) "Ready on this phone" else "Model isn't ready. Keep Wi-Fi on and check again shortly, or choose a hosted provider."
                                                } catch (e: CancellationException) { throw e }
                                                catch (_: Exception) { localNote = "Couldn't prepare Gemini Nano on this device. You can use a hosted provider." }
                                                finally { busy = false }
                                            }
                                        }) { Text(if (localStatus == FeatureStatus.DOWNLOADABLE) "Download local model" else "Check local model") }
                                    }
                                } else {
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
                            Button(modifier = Modifier.fillMaxWidth(), enabled = !busy && !loading && vault != null && (provider == FallbackProvider.LOCAL || (hasKey && modelDraft.isNotBlank())), onClick = {
                                busy = true
                                scope.launch {
                                    try {
                                        model = if (provider == FallbackProvider.LOCAL) provider.defaultModel else modelDraft.trim()
                                        withContext(Dispatchers.IO) { vault?.saveModel(provider, model); lines = vault?.history(provider, model).orEmpty() }
                                        key = ""
                                        options = false
                                    } catch (_: Exception) { error = "Couldn't load this conversation securely." }
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
