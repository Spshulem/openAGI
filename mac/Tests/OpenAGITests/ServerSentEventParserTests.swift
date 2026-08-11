import XCTest
@testable import OpenAGI

final class ServerSentEventParserTests: XCTestCase {
  func testParsesNamedEventAndJoinsDataLines() {
    var parser = ServerSentEventParser()
    XCTAssertNil(parser.consume(line: "event: status"))
    XCTAssertNil(parser.consume(line: "data: {\"stage\":"))
    XCTAssertNil(parser.consume(line: "data: \"thinking\"}"))
    XCTAssertEqual(
      parser.consume(line: ""),
      ServerSentEvent(name: "status", data: "{\"stage\":\n\"thinking\"}")
    )
  }

  func testIgnoresHeartbeatsAndResetsEventName() {
    var parser = ServerSentEventParser()
    XCTAssertNil(parser.consume(line: ": keep-alive"))
    XCTAssertNil(parser.consume(line: ""))
    XCTAssertNil(parser.consume(line: "event: session"))
    XCTAssertNil(parser.consume(line: "data: {\"id\":\"s1\"}"))
    XCTAssertEqual(parser.consume(line: "")?.name, "session")
    XCTAssertNil(parser.consume(line: "data: next"))
    XCTAssertEqual(parser.consume(line: ""), ServerSentEvent(name: "message", data: "next"))
  }
}
