package sh.openagi.mobile.ui.components

import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.unit.dp
import sh.openagi.mobile.ui.theme.LocalOpenAGIColors
import sh.openagi.mobile.ui.theme.OpenAGIType

// FEATURES.md's five destinations. Sentence case labels, no icon library —
// NavIconGlyph hand-draws each one at a fixed size, tinted to match
// selection state exactly the way TaskRow's completion control is tinted.
enum class AppTab(val label: String, val icon: NavIcon) {
    TODAY("Today", NavIcon.TODAY),
    TASKS("Tasks", NavIcon.TASKS),
    INBOX("Inbox", NavIcon.INBOX),
    CHAT("Chat", NavIcon.CHAT),
    SETTINGS("Settings", NavIcon.SETTINGS),
}

@Composable
fun AppNavigationBar(selected: AppTab, inboxBadgeCount: Int, onSelect: (AppTab) -> Unit) {
    val colors = LocalOpenAGIColors.current
    NavigationBar(containerColor = MaterialTheme.colorScheme.surface, tonalElevation = 0.dp) {
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
                label = { Text(tab.label, style = OpenAGIType.caption) },
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
