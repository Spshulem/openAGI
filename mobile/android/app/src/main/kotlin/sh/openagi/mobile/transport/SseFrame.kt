package sh.openagi.mobile.transport

// One dispatched Server-Sent Event frame: `event: <name>` (defaults to
// "message" per the SSE spec when the field is absent) and `data:` (multiple
// `data:` lines within one frame join with "\n", per the spec).
data class SseFrame(val event: String, val data: String)

// Pure line-by-line SSE framing (PROTOCOL.md §7's exact format:
// "event: <name>\ndata: <json>\n\n", comment lines starting with ':'
// ignored, a blank line dispatches the accumulated frame). No OkHttp, no
// Android — SseClient feeds this one line at a time as it reads the
// response body as a stream; SseFrameParserTest feeds it a fixed multi-line
// string instead, which is what makes this worth pulling out on its own.
class SseFrameParser {
    private val eventLines = mutableListOf<String>()
    private val dataLines = mutableListOf<String>()

    // Feed exactly one line, with no trailing newline. Returns the dispatched
    // frame when this line was the blank line ending one, else null.
    fun feed(line: String): SseFrame? {
        if (line.isEmpty()) {
            if (eventLines.isEmpty() && dataLines.isEmpty()) return null
            val frame = SseFrame(
                event = eventLines.lastOrNull() ?: "message",
                data = dataLines.joinToString("\n"),
            )
            eventLines.clear()
            dataLines.clear()
            return frame
        }
        if (line.startsWith(":")) return null // comment / ": ping" heartbeat
        val colon = line.indexOf(':')
        val field = if (colon == -1) line else line.substring(0, colon)
        // The SSE spec strips exactly one leading space after the colon, not
        // all leading whitespace.
        val value = if (colon == -1) "" else line.substring(colon + 1).removePrefix(" ")
        when (field) {
            "event" -> eventLines.add(value)
            "data" -> dataLines.add(value)
            else -> Unit // id/retry: not used by this protocol, ignored rather than erroring
        }
        return null
    }

    companion object {
        // Convenience for tests and for feeding an already-buffered chunk: split
        // on "\n" (a raw SSE stream may use bare \n between frames; OkHttp's
        // readUtf8Line already normalizes \r\n) and feed each line in order.
        fun parseAll(text: String): List<SseFrame> {
            val parser = SseFrameParser()
            val frames = mutableListOf<SseFrame>()
            text.split("\n").forEach { line -> parser.feed(line)?.let { frames.add(it) } }
            return frames
        }
    }
}
