import XCTest
@testable import OpenAGI

// The app's end of WS /device/model must read exactly what
// src/device-model-relay.js sends and answer in its frame shapes.
final class DeviceModelProtocolTests: XCTestCase {
    func testDecodesGenerateFrame() throws {
        let json = """
        {"type":"generate","id":"gen_1","system":"Be brief.","maxOutputTokens":512,
         "messages":[{"role":"user","content":"remember I like tea"},
                     {"role":"assistant","content":"","toolCall":{"name":"remember","arguments":{"content":"likes tea"}}},
                     {"role":"tool","name":"remember","content":"{\\"saved\\":true}"}],
         "tools":[{"name":"remember","description":"Save a note","parameters":{"type":"object","properties":{"content":{"type":"string"}},"required":["content"]}}]}
        """
        guard case .generate(let request) = DeviceModelInbound.decode(Data(json.utf8)) else {
            return XCTFail("not a generate frame")
        }
        XCTAssertEqual(request.id, "gen_1")
        XCTAssertEqual(request.maxOutputTokens, 512)
        XCTAssertEqual(request.messages[1].toolCall, DeviceToolCall(name: "remember", arguments: .object(["content": .string("likes tea")])))
        XCTAssertEqual(request.tools.first?.name, "remember")
    }

    func testDecodesCancelAndIgnoresJunk() {
        XCTAssertEqual(DeviceModelInbound.decode(Data(#"{"type":"cancel","id":"gen_2"}"#.utf8)), .cancel(id: "gen_2"))
        XCTAssertEqual(DeviceModelInbound.decode(Data(#"{"type":"mystery"}"#.utf8)), .unknown)
        XCTAssertEqual(DeviceModelInbound.decode(Data("not json".utf8)), .unknown)
    }

    func testOutboundFrames() throws {
        func object(_ data: Data) throws -> [String: JSONValue] {
            guard case .object(let object) = try JSONDecoder().decode(JSONValue.self, from: data) else { throw CocoaError(.coderInvalidValue) }
            return object
        }
        XCTAssertEqual(try object(DeviceModelOutbound.hello(model: "m", contextSize: 4096)),
                       ["type": .string("hello"), "model": .string("m"), "contextSize": .number(4096),
                        "availability": .string("available")])
        XCTAssertEqual(try object(DeviceModelOutbound.result(id: "g", .text("Hi"))),
                       ["type": .string("result"), "id": .string("g"), "text": .string("Hi")])
        let call = DeviceToolCall(name: "recall", arguments: .object(["query": .string("tea")]))
        XCTAssertEqual(try object(DeviceModelOutbound.result(id: "g", .toolCall(call)))["toolCall"],
                       .object(["name": .string("recall"), "arguments": .object(["query": .string("tea")])]))
        XCTAssertEqual(try object(DeviceModelOutbound.error(id: "g", .unavailable))["code"], .string("device-model-unavailable"))
    }

    func testPromptPutsHistoryFirstAndToolResultsAfterTheRequest() {
        let prompt = DeviceModelPrompt.render([
            DeviceModelMessage(role: "user", content: "hi"),
            DeviceModelMessage(role: "assistant", content: "Hello!"),
            DeviceModelMessage(role: "user", content: "what do I like?"),
            DeviceModelMessage(role: "assistant", content: "", toolCall: DeviceToolCall(name: "recall", arguments: .object([:]))),
            DeviceModelMessage(role: "tool", content: "tea", name: "recall")
        ])
        XCTAssertEqual(prompt, """
        Conversation so far:
        User: hi
        Assistant: Hello!

        what do I like?

        You called recall with {}.
        It returned: tea

        Now reply to the user, or call another tool if you still need one.
        """)
    }

    func testPromptWithoutHistoryIsJustTheRequest() {
        XCTAssertEqual(DeviceModelPrompt.render([DeviceModelMessage(role: "user", content: "hello")]), "hello")
    }
}
