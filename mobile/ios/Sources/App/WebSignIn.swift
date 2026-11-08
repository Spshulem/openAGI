import SafariServices
import UIKit

// Present the system browser inside OpenAGI while the browser signs in.
// The OAuth provider returns to its HTTP loopback listener first; only
// after validating/exchanging the code does that listener reopen OpenAGI.
@MainActor
enum WebSignIn {
    enum Cancelled: Error { case cancelled }
    enum Failure: Error { case alreadyRunning, noWindow, pageUnavailable }

    private static var current: Session?

    static func run(url: URL) async throws -> URL {
        guard current == nil else { throw Failure.alreadyRunning }
        guard var presenter = UIApplication.shared.connectedScenes
            .compactMap({ $0 as? UIWindowScene })
            .flatMap(\.windows).first(where: \.isKeyWindow)?.rootViewController
        else { throw Failure.noWindow }
        while let presented = presenter.presentedViewController { presenter = presented }
        return try await withCheckedThrowingContinuation { continuation in
            let session = Session(url: url, continuation: continuation)
            current = session
            presenter.present(session.browser, animated: true)
            session.browser.presentationController?.delegate = session
        }
    }

    static func isExpectedCallback(_ url: URL) -> Bool {
        url.scheme == "openagi" && url.host == "chatgpt-signed-in"
            && (url.path.isEmpty || url.path == "/")
            && url.user == nil && url.password == nil && url.port == nil && url.fragment == nil
    }

    // This app link reports completion only. OAuth state, PKCE and ID-token
    // validation stay in the daemon; no credentials cross the app link.
    static func handleCallback(_ url: URL) -> Bool {
        guard isExpectedCallback(url), let session = current else { return false }
        session.finish(.success(url))
        return true
    }

    @MainActor
    private final class Session: NSObject, SFSafariViewControllerDelegate, UIAdaptivePresentationControllerDelegate {
        let browser: SFSafariViewController
        private var continuation: CheckedContinuation<URL, Error>?

        init(url: URL, continuation: CheckedContinuation<URL, Error>) {
            self.browser = SFSafariViewController(url: url)
            self.continuation = continuation
            super.init()
            browser.delegate = self
        }

        func finish(_ result: Result<URL, Error>) {
            guard let continuation else { return }
            self.continuation = nil
            if current === self { current = nil }
            if browser.presentingViewController != nil {
                browser.dismiss(animated: true) { continuation.resume(with: result) }
            } else { continuation.resume(with: result) }
        }

        nonisolated func safariViewControllerDidFinish(_ controller: SFSafariViewController) {
            Task { @MainActor in finish(.failure(Cancelled.cancelled)) }
        }

        func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
            finish(.failure(Cancelled.cancelled))
        }

        nonisolated func safariViewController(_ controller: SFSafariViewController, didCompleteInitialLoad didLoadSuccessfully: Bool) {
            if !didLoadSuccessfully {
                Task { @MainActor in finish(.failure(Failure.pageUnavailable)) }
            }
        }
    }
}
