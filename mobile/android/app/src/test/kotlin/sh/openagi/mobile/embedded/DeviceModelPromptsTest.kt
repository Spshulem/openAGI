package sh.openagi.mobile.embedded

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class DeviceModelPromptsTest {
    private val request = Json.parseToJsonElement("""{"system":"Keep work local","tools":[{"name":"add_task","parameters":{}}],"messages":[{"role":"user","content":"Add milk"},{"role":"tool","content":"Saved"}]}""").jsonObject
    @Test fun modelSeesActualConversationAndToolResults() {
        val prompt = DeviceModelPrompts.render(request)
        assertTrue(prompt.contains("user: Add milk"))
        assertTrue(prompt.contains("tool: Saved"))
        assertTrue(prompt.contains("add_task"))
    }
    @Test fun toolChoiceIsPassedToTheDaemon() {
        val result = DeviceModelPrompts.result("""{"toolCall":{"name":"add_task","arguments":{"title":"Milk"}}}""", request)
        assertEquals("Milk", result["toolCall"]!!.jsonObject["arguments"]!!.jsonObject["title"]!!.jsonPrimitive.content)
    }
    @Test(expected = IllegalArgumentException::class) fun modelCannotInventTools() {
        DeviceModelPrompts.result("""{"toolCall":{"name":"run_shell","arguments":{}}}""", request)
    }
    @Test fun ordinaryAnswerIsNotExecuted() {
        assertEquals("Hello", DeviceModelPrompts.result("Hello", request)["text"]!!.jsonPrimitive.content)
    }
    @Test fun finalTurnDoesNotAdvertiseAnotherToolCall() {
        val prompt = DeviceModelPrompts.render(buildJsonObject { put("tools", JsonArray(emptyList())); put("messages", request["messages"]!!) })
        assertTrue(prompt.contains("Do not call a tool"))
        assertFalse(prompt.contains("Available tools"))
    }
}
