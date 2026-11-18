import XCTest
@testable import OpenAGI

@MainActor
final class WebSignInTests: XCTestCase {
    func testOnlyTheChatGPTCompletionLinkCanFinishTheBrowser() {
        XCTAssertTrue(WebSignIn.isExpectedCallback(URL(string: "openagi://chatgpt-signed-in")!))
        XCTAssertTrue(WebSignIn.isExpectedCallback(URL(string: "openagi://chatgpt-signed-in?error=chatgpt-access-denied")!))
        for address in [
            "openagi://pair?code=123456", "openagi://supervisor",
            "https://chatgpt-signed-in", "openagi://chatgpt-signed-in.evil.example",
            "openagi://chatgpt-signed-in/other", "openagi://user@chatgpt-signed-in",
            "openagi://chatgpt-signed-in:1234", "openagi://chatgpt-signed-in#other"
        ] {
            XCTAssertFalse(WebSignIn.isExpectedCallback(URL(string: address)!), address)
        }
    }

    func testAnUnsolicitedCompletionDoesNotStartASignIn() {
        XCTAssertFalse(WebSignIn.handleCallback(URL(string: "openagi://chatgpt-signed-in")!))
    }
}
