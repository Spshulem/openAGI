import io
import sys
import tempfile
import unittest
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from openagi_linux.capture import FocusSnapshot
from openagi_linux.portal_session import ControlPortalSession, RestoreTokenStore


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

    def create_remote_desktop_session(self):
        self.calls.append(("create",))
        return "/session/control"

    def select_sources(self, session, options):
        self.calls.append(("sources", session, options))

    def select_devices(self, session, options):
        self.calls.append(("devices", session, options))

    def start_remote_desktop(self, session, parent_window):
        self.calls.append(("start", session, parent_window))
        return {
            "streams": [(77, {"position": (100, 50), "size": (100, 50), "source_type": 1})],
            "restore_token": "next-control-token",
            "devices": 3,
        }

    def open_pipewire_remote(self, session):
        self.calls.append(("open", session))
        return 10

    def notify_pointer_motion_absolute(self, session, node, x, y):
        self.calls.append(("absolute", session, node, x, y))

    def notify_pointer_button(self, session, button, state):
        self.calls.append(("button", session, button, state))

    def notify_pointer_axis_discrete(self, session, axis, steps):
        self.calls.append(("axis", session, axis, steps))

    def notify_keyboard_keysym(self, session, keysym, state):
        self.calls.append(("key", session, keysym, state))

    def close_session(self, session):
        self.calls.append(("close", session))


class FakeFrames:
    def __init__(self, fd, node_id):
        image = Image.new("RGBA", (200, 100), (10, 20, 30, 255))
        output = io.BytesIO()
        image.save(output, format="PNG")
        self.png = output.getvalue()
        self.closed = False

    def capture_png(self, timeout_seconds=3):
        return self.png

    def close(self):
        self.closed = True


class ControlPortalSessionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.portal = FakePortal()
        self.frames = []
        self.session = ControlPortalSession(
            portal=self.portal,
            token_store=RestoreTokenStore(Path(self.temp.name) / "control-token"),
            frame_source_factory=lambda fd, node: self.frames.append(FakeFrames(fd, node)) or self.frames[-1],
        )
        self.focus = FocusSnapshot(
            window_id="1", pid=2, app_id="org.kde.kate", app_name="Kate", title="Roadmap",
            x=125, y=60, width=50, height=25, observed_at="2026-09-24T18:00:00.000Z",
        )

    def tearDown(self):
        self.session.close()
        self.temp.cleanup()

    def test_start_is_explicit_and_requests_pointer_keyboard_and_one_monitor(self):
        with self.assertRaisesRegex(RuntimeError, "not enabled"):
            self.session.capture_focus(self.focus)
        self.assertEqual(self.portal.calls, [])

        self.session.start(parent_window="wayland:openagi")
        sources = next(call for call in self.portal.calls if call[0] == "sources")[2]
        devices = next(call for call in self.portal.calls if call[0] == "devices")[2]
        self.assertEqual((sources["types"], sources["multiple"]), (1, False))
        self.assertNotIn("persist_mode", sources)
        self.assertNotIn("restore_token", sources)
        self.assertEqual((devices["types"], devices["persist_mode"]), (3, 2))
        self.assertTrue(self.session.ready)
        frame = self.session.capture_focus(self.focus)
        self.assertEqual((frame.width, frame.height), (100, 50))

    def test_start_rejects_non_integer_device_grant(self):
        original_start = self.portal.start_remote_desktop

        def start_with_string_devices(session, parent_window):
            result = original_start(session, parent_window)
            result["devices"] = "3"
            return result

        self.portal.start_remote_desktop = start_with_string_devices
        with self.assertRaisesRegex(ValueError, "device grant"):
            self.session.start()
        self.assertFalse(self.session.ready)
        self.assertIn(("close", "/session/control"), self.portal.calls)

    def test_external_portal_revocation_disables_control_and_closes_frames(self):
        revoked = []
        self.session.on_revoked = lambda: revoked.append(True)
        self.session.start()

        self.portal.emit_closed("/session/control")

        self.assertFalse(self.session.ready)
        self.assertTrue(self.frames[0].closed)
        self.assertEqual(revoked, [True])

    def test_pointer_coordinates_map_to_stream_and_button_events_are_balanced(self):
        self.session.start()
        self.session.click(125, 60, "left", 2)
        expected = [
            ("absolute", "/session/control", 77, 25.0, 10.0),
            ("button", "/session/control", 272, 1),
            ("button", "/session/control", 272, 0),
            ("button", "/session/control", 272, 1),
            ("button", "/session/control", 272, 0),
        ]
        self.assertEqual(self.portal.calls[-5:], expected)

    def test_keyboard_text_and_chord_emit_keysyms_without_process_arguments(self):
        self.session.start()
        self.session.type_text("Añ")
        self.session.key("ctrl+a")
        key_calls = [call for call in self.portal.calls if call[0] == "key"]
        self.assertEqual(key_calls[:4], [
            ("key", "/session/control", 65, 1), ("key", "/session/control", 65, 0),
            ("key", "/session/control", 0x010000F1, 1), ("key", "/session/control", 0x010000F1, 0),
        ])
        self.assertEqual(key_calls[-4:], [
            ("key", "/session/control", 0xFFE3, 1), ("key", "/session/control", 97, 1),
            ("key", "/session/control", 97, 0), ("key", "/session/control", 0xFFE3, 0),
        ])

    def test_cancellation_is_checked_between_typed_characters(self):
        self.session.start()
        checks = 0

        def cancel_check():
            nonlocal checks
            checks += 1
            if checks > 1:
                raise RuntimeError("cancelled")

        with self.assertRaisesRegex(RuntimeError, "cancelled"):
            self.session.type_text("abc", cancel_check=cancel_check)

        key_calls = [call for call in self.portal.calls if call[0] == "key"]
        self.assertEqual(key_calls, [
            ("key", "/session/control", 97, 1),
            ("key", "/session/control", 97, 0),
        ])

    def test_scroll_rechecks_cancellation_after_pointer_motion_before_axis_effect(self):
        self.session.start()
        cancelled = False
        original_motion = self.portal.notify_pointer_motion_absolute

        def motion_then_cancel(session, node, x, y):
            nonlocal cancelled
            original_motion(session, node, x, y)
            cancelled = True

        def cancel_check():
            if cancelled:
                raise RuntimeError("cancelled")

        self.portal.notify_pointer_motion_absolute = motion_then_cancel
        with self.assertRaisesRegex(RuntimeError, "cancelled"):
            self.session.scroll(125, 60, 0, 120, cancel_check=cancel_check)

        self.assertFalse(any(call[0] == "axis" for call in self.portal.calls))

    def test_cancelled_drag_always_releases_the_pointer_button(self):
        self.session.start()
        checks = 0

        def cancel_check():
            nonlocal checks
            checks += 1
            if checks > 3:
                raise RuntimeError("cancelled")

        with self.assertRaisesRegex(RuntimeError, "cancelled"):
            self.session.drag(125, 60, 150, 70, "left", 350, cancel_check=cancel_check)

        button_calls = [call for call in self.portal.calls if call[0] == "button"]
        self.assertEqual(button_calls, [
            ("button", "/session/control", 272, 1),
            ("button", "/session/control", 272, 0),
        ])


if __name__ == "__main__":
    unittest.main()
