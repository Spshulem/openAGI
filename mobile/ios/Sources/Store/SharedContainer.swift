import Foundation

public enum SharedContainer {
    // Each target's Info.plist carries the OPENAGI_APP_GROUP build setting,
    // so a team that registered a different group id needs no code change.
    public static let appGroup = Bundle.main.object(forInfoDictionaryKey: "OpenAGIAppGroup") as? String
        ?? "group.sh.openagi.mobile"

    // The widget extension is a different process with a different sandbox.
    // The App Group container is the only place both can see.
    public static var url: URL {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup)
            ?? URL(filePath: NSTemporaryDirectory())
    }
}
