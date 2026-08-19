import Foundation
import XCTest
@testable import OpenAGI

final class BriefOlderTests: XCTestCase {
  func testOlderDaemonKeepsAggregateAndUsesAnItemLabel() throws {
    let response = try decode("""
      {"items":[],"older":{"count":1199,"oldestAt":null},"degraded":[]}
      """)

    XCTAssertNil(response.older.byKind)
    XCTAssertEqual(response.older.disclosureLabel, "\(number(1199)) more items")
    XCTAssertFalse(response.older.disclosureLabel.contains("task"))
  }

  func testNewDaemonBreakdownOmitsZeroKindsAndNamesTheBacklog() throws {
    let response = try decode("""
      {"items":[],"older":{"count":1199,"oldestAt":null,"byKind":{
        "clarifications":0,"drafts":6,"tasks":3,"suggestions":1190
      }},"degraded":[]}
      """)

    XCTAssertEqual(
      response.older.disclosureLabel,
      "\(number(1199)) more items · 6 drafts · 3 tasks · \(number(1190)) suggestions"
    )
    XCTAssertFalse(response.older.disclosureLabel.contains("clarification"))
  }

  func testMalformedBreakdownDoesNotDiscardCompatibleAggregate() throws {
    let response = try decode("""
      {"items":[],"older":{"count":12,"byKind":"newer-wire-shape"},"degraded":[]}
      """)

    XCTAssertEqual(response.older.count, 12)
    XCTAssertNil(response.older.byKind)
    XCTAssertEqual(response.older.disclosureLabel, "12 more items")
  }

  private func decode(_ json: String) throws -> BriefResponse {
    try JSONDecoder().decode(BriefResponse.self, from: Data(json.utf8))
  }

  private func number(_ value: Int) -> String {
    NumberFormatter.localizedString(from: NSNumber(value: value), number: .decimal)
  }
}
