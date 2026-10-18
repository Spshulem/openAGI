package sh.openagi.mobile.ui.components

import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.NavigationRail
import androidx.compose.material3.NavigationRailItem
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import sh.openagi.mobile.ui.theme.LocalOpenAGIColors
import sh.openagi.mobile.ui.theme.OpenAGIType

// FEATURES.md's six destinations. Sentence case labels, no icon library —
// NavIconGlyph hand-draws each one at a fixed size, tinted to match
// selection state exactly the way TaskRow's completion control is tinted.
enum class AppTab(val label: String, val icon: NavIcon) {
    TODAY("Today", NavIcon.TODAY),
    TASKS("Tasks", NavIcon.TASKS),
    INBOX("Inbox", NavIcon.INBOX),
    CHAT("Chat", NavIcon.CHAT),
    SUPERVISOR("Supervisor", NavIcon.SUPERVISOR),
    SETTINGS("Settings", NavIcon.SETTINGS),
}

@Composable
fun AppNavigationBar(selected: AppTab, inboxBadgeCount: Int, onSelect: (AppTab) -> Unit) {
    val colors = LocalOpenAGIColors.current
    NavigationBar(modifier = Modifier.testTag("bottom-navigation"), containerColor = MaterialTheme.colorScheme.surface, tonalElevation = 0.dp) {
        AppTab.entries.forEach { tab ->
            val isSelected = tab == selected
            val tint = if (isSelected) colors.live else MaterialTheme.colorScheme.onSurfaceVariant
            NavigationBarItem(
                selected = isSelected,
                onClick = { onSelect(tab) },
                icon = {
                    if (tab == AppTab.INBOX && inboxBadgeCount > 0) {
                        BadgedBox(badge = { Badge(containerColor = colors.alert) { Text("$inboxBadgeCount") } }) {
                            NavIconGlyph(tab.icon, tint)
                        }
                    } else {
                        NavIconGlyph(tab.icon, tint)
                    }
                },
                // One line, always: six items leave "Supervisor" little room,
                // and a label broken mid-word reads worse than a clipped one.
                label = { Text(tab.label, style = OpenAGIType.caption, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                colors = NavigationBarItemDefaults.colors(
                    selectedIconColor = colors.live,
                    selectedTextColor = colors.live,
                    unselectedIconColor = MaterialTheme.colorScheme.onSurfaceVariant,
                    unselectedTextColor = MaterialTheme.colorScheme.onSurfaceVariant,
                    indicatorColor = MaterialTheme.colorScheme.surface,
                ),
            )
        }
    }
}

@Composable
fun AppNavigationRail(selected: AppTab, inboxBadgeCount: Int, onSelect: (AppTab) -> Unit) {
    val colors = LocalOpenAGIColors.current
    NavigationRail(modifier = Modifier.testTag("navigation-rail"), containerColor = MaterialTheme.colorScheme.surface) {
        AppTab.entries.forEach { tab ->
            val tint = if (tab == selected) colors.live else MaterialTheme.colorScheme.onSurfaceVariant
            NavigationRailItem(
                selected = tab == selected,
                onClick = { onSelect(tab) },
                icon = {
                    if (tab == AppTab.INBOX && inboxBadgeCount > 0) {
                        BadgedBox(badge = { Badge(containerColor = colors.alert) { Text("$inboxBadgeCount") } }) {
                            NavIconGlyph(tab.icon, tint)
                        }
                    } else NavIconGlyph(tab.icon, tint)
                },
                label = { Text(tab.label, style = OpenAGIType.caption, maxLines = 1, overflow = TextOverflow.Ellipsis) },
            )
        }
    }
}

// Whether the tab bar shows. An open conversation (the Supervisor chat, reached
// with a back arrow) gets the whole height, as in ChatGPT; back returns to the
// tab with the bar. The bar never rides above the keyboard either: while the
// keyboard is up, the screen being typed into gets that space. The Chat tab is
// a tab in its own right (no back arrow), so it keeps the bar.
fun tabBarVisible(selected: AppTab, supervisorChatOpen: Boolean, keyboardOpen: Boolean): Boolean {
    if (keyboardOpen) return false
    return !(selected == AppTab.SUPERVISOR && supervisorChatOpen)
}
