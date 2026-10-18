import AuthenticationServices
import UIKit

// ASWebAuthenticationSession as async/await: opens a sign-in page and
// returns the callback URL once the page redirects to `callbackScheme`.
@MainActor
enum WebSignIn {
    enum Cancelled: Error { case cancelled }

    private static var current: ASWebAuthenticationSession?
    private static let anchor = PresentationAnchor()

    static func run(url: URL, callbackScheme: String) async throws -> URL {
        try await withCheckedThrowingContinuation { continuation in
            let session = ASWebAuthenticationSession(url: url, callback: .customScheme(callbackScheme)) { callback, error in
                Task { @MainActor in current = nil }
                if let callback {
                    continuation.resume(returning: callback)
                } else if let error = error as? ASWebAuthenticationSessionError, error.code == .canceledLogin {
                    continuation.resume(throwing: Cancelled.cancelled)
                } else {
                    continuation.resume(throwing: error ?? Cancelled.cancelled)
                }
            }
            session.presentationContextProvider = anchor
            session.prefersEphemeralWebBrowserSession = false
            current = session
            session.start()
        }
    }

    private final class PresentationAnchor: NSObject, ASWebAuthenticationPresentationContextProviding {
        func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
            MainActor.assumeIsolated {
                UIApplication.shared.connectedScenes
                    .compactMap { $0 as? UIWindowScene }
                    .flatMap(\.windows)
                    .first(where: \.isKeyWindow) ?? ASPresentationAnchor()
            }
        }
    }
}
