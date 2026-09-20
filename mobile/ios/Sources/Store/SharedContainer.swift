import Foundation

public enum SharedContainer {
    public static let appGroup = "group.sh.openagi.mobile"

    // The widget extension is a different process with a different sandbox.
    // The App Group container is the only place both can see.
    public static var url: URL {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup)
            ?? URL(filePath: NSTemporaryDirectory())
    }
}
