import io
import os
import sys
import tempfile
import unittest
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from openagi_linux.capture import FocusSnapshot
from openagi_linux.portal_session import RestoreTokenStore, ScreenCastSession


class FakePortal:
    def __init__(self):
        self.calls = []
        self.closed_callbacks = {}

    def watch_session_closed(self, session, callback):
        self.closed_callbacks[session] = callback

    def unwatch_session_closed(self, session):
        self.closed_callbacks.pop(session, None)

    def emit_closed(self, session):
        self.closed_callbacks.pop(session)()

    def create_screen_cast_session(self):
        self.calls.append(("create",))
        return "/session/1"

    def select_sources(self, session, options):
        self.calls.append(("select", session, options))

    def start_screen_cast(self, session, parent_window):
        self.calls.append(("start", session, parent_window))
        return {
            "streams": [(77, {"position": (0, 0), "size": (100, 50), "source_type": 1})],
            "restore_token": "rotated-token",
        }

    def open_pipewire_remote(self, session):
        self.calls.append(("open", session))
        return 11

    def close_session(self, session):
        self.calls.append(("close", session))


class FakeFrames:
    def __init__(self, fd, node_id):
        self.fd = fd
        self.node_id = node_id
        self.closed = False
        image = Image.new("RGBA", (200, 100), (1, 2, 3, 255))
        buffer = io.BytesIO()
        image.save(buffer, format="PNG")
        self.png = buffer.getvalue()

    def capture_png(self, timeout_seconds=3):
        return self.png

    def close(self):
        self.closed = True


class ScreenCastSessionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.token_path = Path(self.temp.name) / "screen-token"
        self.token_path.write_text("old-token", encoding="utf-8")
        os.chmod(self.token_path, 0o600)
        self.portal = FakePortal()
        self.frames = []

        def frame_factory(fd, node_id):
            frame = FakeFrames(fd, node_id)
            self.frames.append(frame)
            return frame

        self.session = ScreenCastSession(
            portal=self.portal,
            token_store=RestoreTokenStore(self.token_path),
            frame_source_factory=frame_factory,
        )
        self.focus = FocusSnapshot(
            window_id="1",
            pid=42,
            app_id="org.kde.kate",
            app_name="Kate",
            title="Roadmap",
            x=25,
            y=10,
            width=50,
            height=25,
            observed_at="2026-09-24T18:00:00.000Z",
        )

    def tearDown(self):
        self.session.close()
        self.temp.cleanup()

    def test_capture_never_opens_a_permission_prompt_implicitly(self):
        with self.assertRaisesRegex(RuntimeError, "not enabled"):
            self.session.capture_focus(self.focus)
        self.assertEqual(self.portal.calls, [])

    def test_explicit_start_restores_persistent_consent_and_rotates_token(self):
        result = self.session.start(parent_window="wayland:openagi")
        self.assertEqual(result.stream.node_id, 77)
        select = next(call for call in self.portal.calls if call[0] == "select")
        options = select[2]
        self.assertEqual(options["types"], 1)
        self.assertFalse(options["multiple"])
        self.assertEqual(options["cursor_mode"], 1)
        self.assertEqual(options["persist_mode"], 2)
        self.assertEqual(options["restore_token"], "old-token")
        self.assertEqual(self.token_path.read_text(encoding="utf-8"), "rotated-token")
        self.assertEqual(os.stat(self.token_path).st_mode & 0o777, 0o600)

        frame = self.session.capture_focus(self.focus)
        self.assertEqual((frame.width, frame.height), (100, 50))
        self.assertEqual((self.frames[0].fd, self.frames[0].node_id), (11, 77))

        self.session.close()
        self.assertTrue(self.frames[0].closed)
        self.assertIn(("close", "/session/1"), self.portal.calls)

    def test_external_portal_revocation_disables_capture_and_closes_frames(self):
        revoked = []
        self.session.on_revoked = lambda: revoked.append(True)
        self.session.start()

        self.portal.emit_closed("/session/1")

        self.assertFalse(self.session.ready)
        self.assertTrue(self.frames[0].closed)
        self.assertEqual(revoked, [True])
        with self.assertRaisesRegex(RuntimeError, "not enabled"):
            self.session.capture_focus(self.focus)


if __name__ == "__main__":
    unittest.main()
