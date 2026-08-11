import XCTest
@testable import OpenAGI

@MainActor
final class BriefContextTests: XCTestCase {
  func testOlderBriefPayloadDefaultsMenuActionsAndEntityRef() throws {
    let item = try decode("""
      {"id":"task:old","kind":"task","title":"Old row","why":"","score":0,
       "source":"manual","actions":[],"deepLink":"/?tab=tasks"}
      """)
    XCTAssertTrue(item.menuActions.isEmpty)
    XCTAssertNil(item.entityRef)
  }

  func testSelectingARowScopesTheComposerAndRequestsFocus() throws {
    let item = try decode("""
      {"id":"task:task_1","kind":"task","title":"Ship the release","why":"today","score":1,
       "source":"manual","actions":[],"menuActions":[],"deepLink":"/?tab=tasks",
       "entityRef":{"kind":"task","id":"task_1"}}
      """)
    let state = OverlayState.shared
    state.clearBriefContext()
    let before = state.composerFocusRequest

    state.chatAbout(item)

    XCTAssertEqual(state.briefContext?.title, "Ship the release")
    XCTAssertEqual(state.briefContext?.entityRef?.id, "task_1")
    XCTAssertGreaterThan(state.composerFocusRequest, before)
    let json = state.briefContext?.jsonObject
    XCTAssertEqual(json?["kind"] as? String, "task")
    XCTAssertEqual((json?["entityRef"] as? [String: String])?["id"], "task_1")
  }

  func testAddRelatedTaskPrefillsWithoutLosingSelectedIdentity() throws {
    let item = try decode("""
      {"id":"suggestion:s1","kind":"suggestion","title":"Review this pattern","why":"seen 4x","score":1,
       "source":"observer","actions":[],"deepLink":"/?tab=suggestions",
       "entityRef":{"kind":"suggestion","id":"s1"}}
      """)
    let state = OverlayState.shared
    state.question = ""
    state.addRelatedTask(to: item)
    XCTAssertEqual(state.question, "Add a related task: ")
    XCTAssertEqual(state.briefContext?.entityRef?.id, "s1")
  }

  private func decode(_ json: String) throws -> BriefItem {
    try JSONDecoder().decode(BriefItem.self, from: Data(json.utf8))
  }
}
