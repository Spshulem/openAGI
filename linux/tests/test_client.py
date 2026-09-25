import json
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from openagi_linux.client import CompanionConfig, DaemonClient
from openagi_linux.sse import SseDecoder


class FakeHeaders:
    def __init__(self, values):
        self.values = {key.lower(): value for key, value in values.items()}

    def get(self, key, default=None):
        return self.values.get(key.lower(), default)


class FakeResponse:
    def __init__(self, chunks, content_type="text/event-stream", status=200):
        self._chunks = list(chunks)
        self.headers = FakeHeaders({"content-type": content_type})
        self.status = status

    def read(self, size=-1):
        return self._chunks.pop(0) if self._chunks else b""

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False


class FakeOpener:
    def __init__(self, response):
        self.response = response
        self.requests = []

    def open(self, request, timeout):
        self.requests.append((request, timeout))
        return self.response


class SseDecoderTests(unittest.TestCase):
    def test_fragmented_multiline_events_and_comments_are_decoded(self):
        decoder = SseDecoder(max_event_bytes=1024)
        events = []
        events += decoder.feed(b": heartbeat\n\nevent: sta")
        events += decoder.feed(b"tus\ndata: {\"stage\":\"tool\"}\n\n")
        events += decoder.feed(b"event: delta\ndata: {\"text\":\"Hola\"}\ndata: {\"continued\":true}\n\n")

        self.assertEqual(events[0], {"event": "status", "data": '{"stage":"tool"}'})
        self.assertEqual(
            events[1],
            {"event": "delta", "data": '{"text":"Hola"}\n{"continued":true}'},
        )

    def test_oversized_event_fails_closed(self):
        decoder = SseDecoder(max_event_bytes=8)
        with self.assertRaisesRegex(ValueError, "limit"):
            decoder.feed(b"event: delta\ndata: too-long\n\n")

    def test_crlf_delimiters_can_be_split_across_chunks(self):
        decoder = SseDecoder(max_event_bytes=1024)
        events = []
        for chunk in (b"event: delta\r", b"\ndata: {\"text\":\"Hola\"}\r", b"\n\r", b"\n"):
            events.extend(decoder.feed(chunk))

        self.assertEqual(events, [
            {"event": "delta", "data": '{"text":"Hola"}'},
        ])


class DaemonClientTests(unittest.TestCase):
    def test_default_transport_refuses_redirects_before_releasing_private_payload_or_token(self):
        sink_hits = []

        class SinkHandler(BaseHTTPRequestHandler):
            def do_GET(self):
                sink_hits.append(True)
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(b'{"count":1}')

            def do_POST(self):
                sink_hits.append(True)
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(b'{"count":1}')

            def log_message(self, format, *args):
                return

        sink = ThreadingHTTPServer(("127.0.0.1", 0), SinkHandler)
        sink_thread = threading.Thread(target=sink.serve_forever, daemon=True)
        sink_thread.start()

        class RedirectHandler(BaseHTTPRequestHandler):
            def do_POST(self):
                self.send_response(302)
                self.send_header("Location", f"http://127.0.0.1:{sink.server_port}/collect")
                self.end_headers()

            def log_message(self, format, *args):
                return

        source = ThreadingHTTPServer(("127.0.0.1", 0), RedirectHandler)
        source_thread = threading.Thread(target=source.serve_forever, daemon=True)
        source_thread.start()
        try:
            client = DaemonClient(CompanionConfig(
                base_url=f"http://127.0.0.1:{source.server_port}",
                auth_token="owner-token",
            ))
            delivered = client.push_observations({
                "sourceMachineId": "linux-test",
                "observations": [{
                    "kind": "frame",
                    "app": "PrivateApp",
                    "window": "Private Window",
                    "ocrText": "private redirect sentinel",
                }],
            })
            self.assertFalse(delivered)
            self.assertEqual(sink_hits, [])
        finally:
            source.shutdown()
            sink.shutdown()
            source.server_close()
            sink.server_close()
            source_thread.join(timeout=2)
            sink_thread.join(timeout=2)

    def test_quick_ask_preserves_overlay_contract_and_streams_terminal_reply(self):
        response = FakeResponse([
            b"event: status\ndata: {\"stage\":\"thinking\"}\n\n",
            b"event: delta\ndata: {\"text\":\"Hola\",\"reset\":false}\n\n",
            b"event: final\ndata: {\"reply\":\"Hola mundo\",\"session\":{\"id\":\"overlay:user:main\"}}\n\n",
        ])
        opener = FakeOpener(response)
        client = DaemonClient(
            CompanionConfig(base_url="http://127.0.0.1:43210", auth_token="owner-token"),
            opener=opener,
        )
        seen = []

        result = client.ask(
            "Resume esta ventana",
            screen_context={"app": "Kate", "window": "Roadmap", "text": "Quarterly plan"},
            on_event=lambda event, data: seen.append((event, data)),
        )

        self.assertEqual(result.reply, "Hola mundo")
        self.assertEqual(result.session_id, "overlay:user:main")
        request, timeout = opener.requests[0]
        self.assertEqual(request.full_url, "http://127.0.0.1:43210/message")
        self.assertEqual(request.get_method(), "POST")
        self.assertEqual(request.get_header("Authorization"), "Bearer owner-token")
        self.assertEqual(request.get_header("Accept"), "text/event-stream")
        payload = json.loads(request.data)
        self.assertEqual(payload["channel"], "overlay")
        self.assertEqual(payload["sessionId"], "overlay:user:main")
        self.assertEqual(payload["metadata"]["requestSource"], "overlay")
        self.assertEqual(payload["metadata"]["screenContext"]["text"], "Quarterly plan")
        self.assertRegex(payload["metadata"]["requestId"], r"^ask_[0-9a-f]{32}$")
        self.assertEqual(timeout, 120)
        self.assertEqual(seen[0], ("status", {"stage": "thinking"}))
        self.assertEqual(seen[1], ("delta", {"text": "Hola", "reset": False}))

    def test_json_fallback_and_observation_delivery_use_bounded_owner_requests(self):
        fallback = FakeResponse(
            [b'{"reply":"fallback","session":{"id":"overlay:user:main"}}'],
            content_type="application/json",
        )
        opener = FakeOpener(fallback)
        client = DaemonClient(CompanionConfig(), opener=opener)
        result = client.ask("hola")
        self.assertEqual(result.reply, "fallback")

        accepted = FakeResponse([b'{"count":1,"mode":"sqlite"}'], content_type="application/json")
        opener.response = accepted
        envelope = {
            "sourceMachineId": "linux-a",
            "observations": [{"kind": "activity", "app": "Kate", "window": "Roadmap"}],
        }
        self.assertTrue(client.push_observations(envelope))
        request, timeout = opener.requests[-1]
        self.assertEqual(request.full_url, "http://127.0.0.1:43210/observations")
        self.assertEqual(request.get_header("Content-type"), "application/json")
        self.assertEqual(json.loads(request.data), envelope)
        self.assertEqual(timeout, 10)


if __name__ == "__main__":
    unittest.main()
