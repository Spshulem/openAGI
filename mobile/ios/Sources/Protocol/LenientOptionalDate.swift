import Foundation

// For OPTIONAL dates only. The task store holds "" for a cleared due date and
// /tasks returns it raw, so an empty or malformed value must mean "no date",
// not "fail the whole payload" — one bad field was enough to blank the Today
// screen over fifty real tasks, while every fixture-based test passed.
//
// Synthesized `Decodable` conformances call `decodeIfPresent(_:forKey:)` with
// the concrete `Date.Type`, so this more specific overload is the one they
// bind to, for every `Date?` property in this module at once. Required dates
// go through `decode(_:forKey:)`, which this does not touch: a payload
// missing `generatedAt` is genuinely broken and should still say so.
extension KeyedDecodingContainer {
    public func decodeIfPresent(_ type: Date.Type, forKey key: Key) throws -> Date? {
        guard contains(key), try !decodeNil(forKey: key) else { return nil }
        return try? decode(Date.self, forKey: key)
    }
}
