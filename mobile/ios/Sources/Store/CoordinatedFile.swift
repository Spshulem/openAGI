import Foundation

// Serializes access to a single file that two different processes — the app
// and the widget extension — read and write with no synchronization between
// them beyond this. Without it, a read-modify-write (load, mutate, save) done
// by one process can silently clobber a write the other process made in
// between the read and the write: exactly the "a tap while offline survives"
// guarantee the outbound queue exists to keep.
//
// A coordination failure degrades the same way a corrupt file already does
// elsewhere in this store: the caller loses only this one operation, never
// crashes. This is what keeps a widget — which the OS stops scheduling if it
// crashes — safe to call this from.
enum CoordinatedFile {
    static func read<T>(_ url: URL, _ body: (URL) -> T?) -> T? {
        let coordinator = NSFileCoordinator(filePresenter: nil)
        var coordinationError: NSError?
        var outcome: T?
        coordinator.coordinate(readingItemAt: url, options: [], error: &coordinationError) { coordinatedURL in
            outcome = body(coordinatedURL)
        }
        return coordinationError == nil ? outcome : nil
    }

    // `.forMerging` is the option Apple documents for a read-modify-write:
    // the accessor is expected to read the file's current contents before
    // writing its own changes back, and the coordinator serializes this
    // against any other coordinated reader or writer of the same URL.
    static func write<T>(_ url: URL, _ body: (URL) throws -> T) throws -> T {
        let coordinator = NSFileCoordinator(filePresenter: nil)
        var coordinationError: NSError?
        var thrown: Error?
        var outcome: T?
        coordinator.coordinate(writingItemAt: url, options: .forMerging, error: &coordinationError) { coordinatedURL in
            do {
                outcome = try body(coordinatedURL)
            } catch {
                thrown = error
            }
        }
        if let coordinationError { throw coordinationError }
        if let thrown { throw thrown }
        guard let outcome else {
            // Coordination reported success but the accessor never ran and
            // never threw — not expected, but fail loudly rather than
            // silently returning a bogus value.
            throw CocoaError(.fileWriteUnknown)
        }
        return outcome
    }
}
