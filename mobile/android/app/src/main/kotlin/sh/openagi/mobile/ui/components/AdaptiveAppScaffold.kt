package sh.openagi.mobile.ui.components

import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.*
import androidx.compose.material3.Scaffold
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.repeatOnLifecycle
import androidx.window.layout.FoldingFeature
import androidx.window.layout.WindowInfoTracker
import kotlinx.coroutines.flow.collect
import kotlin.math.roundToInt
import sh.openagi.mobile.ui.theme.OpenAGITheme

internal val LocalFoldInfo = staticCompositionLocalOf<FoldInfo?> { null }

@Composable
internal fun FoldAwareApp(activity: ComponentActivity, content: @Composable () -> Unit) {
    CompositionLocalProvider(LocalFoldInfo provides rememberFoldInfo(activity)) {
        OpenAGITheme(content = content)
    }
}

@Composable
internal fun rememberFoldInfo(activity: ComponentActivity): FoldInfo? {
    val density = LocalDensity.current.density
    val fold by produceState<FoldInfo?>(null, activity, density) {
        activity.lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            WindowInfoTracker.getOrCreate(activity).windowLayoutInfo(activity).collect { info ->
                val feature = info.displayFeatures.filterIsInstance<FoldingFeature>()
                    .firstOrNull { it.isSeparating || it.occlusionType == FoldingFeature.OcclusionType.FULL }
                value = feature?.let {
                    FoldInfo(PaneBounds(it.bounds.left / density, it.bounds.top / density,
                        it.bounds.right / density, it.bounds.bottom / density),
                        if (it.orientation == FoldingFeature.Orientation.HORIZONTAL) FoldAxis.HORIZONTAL else FoldAxis.VERTICAL)
                }
            }
        }
    }
    return fold
}

@Composable
@OptIn(ExperimentalLayoutApi::class)
internal fun AdaptiveAppScaffold(
    selected: AppTab,
    inboxBadgeCount: Int,
    supervisorChatOpen: Boolean,
    onSelect: (AppTab) -> Unit,
    supportingPane: @Composable () -> Unit,
    content: @Composable (Boolean) -> Unit,
) {
    val fold = LocalFoldInfo.current
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val rail = usesNavigationRail(maxWidth.value, maxHeight.value, fold?.axis == FoldAxis.HORIZONTAL)
        val expanded = maxWidth >= 840.dp
        val inlineSupervisor = (expanded && maxHeight >= 480.dp) || fold != null
        Row(Modifier.fillMaxSize()) {
            if (rail) AppNavigationRail(selected, inboxBadgeCount, onSelect)
            Scaffold(
                modifier = Modifier.weight(1f),
                bottomBar = {
                    if (!rail && tabBarVisible(selected, supervisorChatOpen && !inlineSupervisor, WindowInsets.isImeVisible)) {
                        AppNavigationBar(selected, inboxBadgeCount, onSelect)
                    }
                },
                contentWindowInsets = WindowInsets.statusBars,
            ) { padding ->
                var origin by remember { mutableStateOf(PaneBounds(0f, 0f, 0f, 0f)) }
                val density = LocalDensity.current.density
                BoxWithConstraints(Modifier.padding(padding).consumeWindowInsets(padding).fillMaxSize()
                    .onGloballyPositioned {
                        val r = it.boundsInWindow()
                        origin = PaneBounds(r.left / density, r.top / density, r.right / density, r.bottom / density)
                    }) {
                    // The Chat tab places its own history above a horizontal
                    // fold and composer below it. Other tabs gain a chat pane.
                    val localFold = fold?.takeUnless { selected == AppTab.CHAT && it.axis == FoldAxis.HORIZONTAL }
                        ?.relativeTo(origin)
                    val panes = paneLayout(maxWidth.value, maxHeight.value, localFold,
                        supporting = selected != AppTab.SETTINGS,
                        expanded = expanded && !(selected == AppTab.CHAT && fold?.axis == FoldAxis.HORIZONTAL),
                        rtl = LocalLayoutDirection.current == LayoutDirection.Rtl)
                    PaneLayoutContent(panes, main = { content(panes.supporting != null) }, supporting = supportingPane)
                }
            }
        }
    }
}

private fun FoldInfo.relativeTo(origin: PaneBounds) = copy(bounds = PaneBounds(
    bounds.left - origin.left, bounds.top - origin.top, bounds.right - origin.left, bounds.bottom - origin.top))

@Composable
internal fun FoldSafeSinglePane(content: @Composable () -> Unit) {
    val fold = LocalFoldInfo.current
    val density = LocalDensity.current.density
    var origin by remember { mutableStateOf(PaneBounds(0f, 0f, 0f, 0f)) }
    BoxWithConstraints(Modifier.fillMaxSize().imePadding().onGloballyPositioned {
        val r = it.boundsInWindow()
        origin = PaneBounds(r.left / density, r.top / density, r.right / density, r.bottom / density)
    }) {
        val panes = paneLayout(maxWidth.value, maxHeight.value, fold?.relativeTo(origin),
            supporting = false, expanded = false, rtl = LocalLayoutDirection.current == LayoutDirection.Rtl)
        PaneLayoutContent(panes, main = content, supporting = {})
    }
}

@Composable
internal fun PaneLayoutContent(panes: PaneLayout, main: @Composable () -> Unit, supporting: @Composable () -> Unit) {
    val density = LocalDensity.current.density
    Layout(modifier = Modifier.fillMaxSize(), content = {
        Box(Modifier.fillMaxSize().testTag("main-pane"), contentAlignment = Alignment.TopCenter) {
            Box(Modifier.widthIn(max = 840.dp).fillMaxSize()) { main() }
        }
        if (panes.supporting != null) Box(Modifier.fillMaxSize().testTag("supporting-pane")) { supporting() }
    }) { measurables, constraints ->
        val regions = listOfNotNull(panes.main, panes.supporting)
        val placed = measurables.zip(regions).map { (child, rect) ->
            val left = (rect.left * density).roundToInt()
            val top = (rect.top * density).roundToInt()
            val width = ((rect.right * density).roundToInt() - left).coerceAtLeast(0)
            val height = ((rect.bottom * density).roundToInt() - top).coerceAtLeast(0)
            Triple(child.measure(Constraints.fixed(width, height)), left, top)
        }
        layout(constraints.maxWidth, constraints.maxHeight) { placed.forEach { (child, x, y) -> child.place(x, y) } }
    }
}

// A tabletop conversation keeps the message history upright and its input
// on the lower surface. Keep the same slots when folding, preserving scroll
// state, focus and the caller's saved draft.
@Composable
internal fun FoldAwareChatColumn(messages: @Composable () -> Unit, composer: @Composable () -> Unit) {
    val fold = LocalFoldInfo.current
    val density = LocalDensity.current.density
    var origin by remember { mutableStateOf(PaneBounds(0f, 0f, 0f, 0f)) }
    BoxWithConstraints(Modifier.fillMaxSize().imePadding().onGloballyPositioned {
        val r = it.boundsInWindow()
        origin = PaneBounds(r.left / density, r.top / density, r.right / density, r.bottom / density)
    }) {
        val localFold = fold?.takeIf { it.axis == FoldAxis.HORIZONTAL }?.relativeTo(origin)
        val panes = paneLayout(maxWidth.value, maxHeight.value, localFold, supporting = true, expanded = false)
        Layout(modifier = Modifier.fillMaxSize(), content = {
            Box(Modifier.fillMaxSize()) { messages() }
            Box(Modifier.fillMaxWidth()) { composer() }
        }) { children, constraints ->
            val lower = panes.supporting
            val composerWidth = ((lower?.width ?: maxWidth.value) * density).roundToInt()
            val composerHeight = ((lower?.height ?: maxHeight.value) * density).roundToInt()
            val input = children[1].measure(Constraints(minWidth = composerWidth, maxWidth = composerWidth,
                maxHeight = composerHeight))
            val historyHeight = lower?.let { (panes.main.height * density).roundToInt() }
                ?: (constraints.maxHeight - input.height).coerceAtLeast(0)
            val history = children[0].measure(Constraints.fixed(constraints.maxWidth, historyHeight))
            layout(constraints.maxWidth, constraints.maxHeight) {
                history.place(0, 0)
                input.place(0, constraints.maxHeight - input.height)
            }
        }
    }
}
