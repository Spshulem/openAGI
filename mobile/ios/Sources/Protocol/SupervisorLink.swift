import Foundation

// One handoff for notification, widget and Live Activity navigation. Links
// only select a session; they never answer or approve anything.
public enum SupervisorLink {
    public static func url(threadKey: String? = nil) -> URL {
        var parts = URLComponents()
        parts.scheme = "openagi"
        parts.host = "supervisor"
        if let threadKey, !threadKey.isEmpty {
            parts.queryItems = [URLQueryItem(name: "thread", value: threadKey)]
        }
        return parts.url!
    }

    public static func threadKey(in url: URL) -> String? {
        guard url.scheme == "openagi", url.host == "supervisor",
              let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems,
              let value = items.first(where: { $0.name == "thread" })?.value,
              !value.isEmpty, value.count <= 512 else { return nil }
        return value
    }
}
