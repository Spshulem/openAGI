import WidgetKit
import SwiftUI

struct TodayWidget: Widget {
    var body: some WidgetConfiguration {
        // TodayWidgetKind.value must match the string RefreshCoordinator and
        // CompleteTaskIntent both call `WidgetCenter.shared.reloadTimelines(ofKind:)`
        // with -- a mismatch here means a completed refresh never redraws this widget.
        StaticConfiguration(kind: TodayWidgetKind.value, provider: TodayTimelineProvider()) { entry in
            TodayWidgetView(entry: entry)
        }
        .configurationDisplayName("Today")
        .description("Your tasks for today, from OpenAGI.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}
