from __future__ import annotations


class SseDecoder:
    def __init__(self, max_event_bytes: int = 256 * 1024) -> None:
        self.max_event_bytes = max(1, max_event_bytes)
        self._buffer = bytearray()
        self._pending_cr = False

    def feed(self, chunk: bytes) -> list[dict[str, str]]:
        if not isinstance(chunk, bytes):
            raise TypeError("SSE chunks must be bytes")
        normalized = chunk
        if self._pending_cr:
            self._buffer.extend(b"\n")
            if normalized.startswith(b"\n"):
                normalized = normalized[1:]
            self._pending_cr = False
        if normalized.endswith(b"\r"):
            normalized = normalized[:-1]
            self._pending_cr = True
        self._buffer.extend(normalized.replace(b"\r\n", b"\n").replace(b"\r", b"\n"))
        if len(self._buffer) > self.max_event_bytes and b"\n\n" not in self._buffer:
            raise ValueError("SSE event exceeded its limit")
        events: list[dict[str, str]] = []
        while True:
            marker = self._buffer.find(b"\n\n")
            if marker < 0:
                break
            raw = bytes(self._buffer[:marker])
            del self._buffer[: marker + 2]
            if len(raw) > self.max_event_bytes:
                raise ValueError("SSE event exceeded its limit")
            event = self._decode(raw)
            if event is not None:
                events.append(event)
        return events

    @staticmethod
    def _decode(raw: bytes) -> dict[str, str] | None:
        try:
            text = raw.decode("utf-8", errors="strict")
        except UnicodeDecodeError as error:
            raise ValueError("SSE event was not valid UTF-8") from error
        name = "message"
        data: list[str] = []
        for line in text.split("\n"):
            if not line or line.startswith(":"):
                continue
            field, separator, value = line.partition(":")
            if separator and value.startswith(" "):
                value = value[1:]
            if field == "event":
                name = value
            elif field == "data":
                data.append(value)
        if not data:
            return None
        return {"event": name, "data": "\n".join(data)}
