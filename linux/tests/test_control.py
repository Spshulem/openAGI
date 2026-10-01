import base64
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from openagi_linux.capture import FocusSnapshot, Frame, PrivacyPolicy
from openagi_linux.control import ControlDispatcher


class Registry:
    def __init__(self, focus):
        self.focus = focus

    def current(self, max_age_seconds=5):
        return self.focus


class SequenceRegistry:
    def __init__(self, *focuses):
        self.focuses = list(focuses)

    def current(self, max_age_seconds=5):
        if len(self.focuses) > 1:
            return self.focuses.pop(0)
        return self.focuses[0] if self.focuses else None


class FakeControlSession:
    def __init__(self, ready=False):
        self.ready = ready
        self.calls = []

    def capture_focus(self, focus):
        self.calls.append(("screenshot", focus))
        return Frame(png=b"\x89PNG\r\n\x1a\ncontrol", width=400, height=300)

    def click(self, x, y, button, count, *, cancel_check=None):
        if cancel_check:
            cancel_check()
        self.calls.append(("click", x, y, button, count))

    def move(self, x, y, *, cancel_check=None):
        if cancel_check:
            cancel_check()
        self.calls.append(("move", x, y))

    def type_text(self, text, *, cancel_check=None):
        if cancel_check:
            cancel_check()
        self.calls.append(("type", text))

    def key(self, chord, *, cancel_check=None):
        if cancel_check:
            cancel_check()
        self.calls.append(("key", chord))

    def scroll(self, x, y, delta_x, delta_y, *, cancel_check=None):
        if cancel_check:
            cancel_check()
        self.calls.append(("scroll", x, y, delta_x, delta_y))


class FakeContext:
    def __init__(self):
        self.checks = 0

    def check_active(self):
        self.checks += 1


class ControlDispatcherTests(unittest.TestCase):
    def setUp(self):
        self.focus = FocusSnapshot(
            window_id="99",
            pid=1234,
            app_id="org.kde.kate",
            app_name="Kate",
            title="Roadmap",
            x=100,
            y=50,
            width=800,
            height=600,
            observed_at="2026-09-24T18:00:00.000Z",
        )
        self.registry = Registry(self.focus)
        self.session = FakeControlSession()
        self.dispatcher = ControlDispatcher(
            focus_registry=self.registry,
            control_session=self.session,
            privacy=PrivacyPolicy(),
        )

    def private_focus(self):
        return {
            "windowID": 99,
            "processIdentifier": 1234,
            "bundleIdentifier": "org.kde.kate",
            "title": "Roadmap",
            "x": 100,
            "y": 50,
            "width": 800,
            "height": 600,
        }

    def test_status_is_fail_closed_until_the_user_enables_portal_control(self):
        result = self.dispatcher.handle({"action": "status", "payload": {}})
        self.assertTrue(result["ok"])
        status = result["result"]
        self.assertFalse(status["screenshotReady"])
        self.assertFalse(status["inputReady"])
        self.assertEqual(status["operations"], [])

    def test_screenshot_is_cropped_to_bound_focus_and_reports_global_mapping(self):
        self.session.ready = True
        result = self.dispatcher.handle({"action": "screenshot", "payload": {}})
        shot = result["result"]
        self.assertEqual(base64.b64decode(shot["base64"]), b"\x89PNG\r\n\x1a\ncontrol")
        self.assertEqual((shot["width"], shot["height"]), (400, 300))
        self.assertEqual(shot["scale"], 2)
        self.assertEqual((shot["offsetX"], shot["offsetY"]), (100, 50))
        self.assertEqual(shot["focus"], self.private_focus())
        self.assertEqual(shot["elements"], [])

    def test_screenshot_is_not_returned_if_focus_changes_during_capture(self):
        changed = FocusSnapshot(
            **{**self.focus.__dict__, "window_id": "100", "title": "Secrets"}
        )
        self.session.ready = True
        dispatcher = ControlDispatcher(
            focus_registry=SequenceRegistry(self.focus, changed),
            control_session=self.session,
            privacy=PrivacyPolicy(),
        )

        result = dispatcher.handle({"action": "screenshot", "payload": {}})

        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["code"], "focus_changed")
        self.assertNotIn("base64", str(result))

    def test_baseline_input_requires_exact_current_focus_and_delegates(self):
        self.session.ready = True
        payload = {"x": 150, "y": 75, "button": "left", "count": 2, "focus": self.private_focus()}
        result = self.dispatcher.handle({"action": "click", "payload": payload})
        self.assertEqual(result, {"ok": True, "result": {"ok": True}})
        self.assertEqual(self.session.calls[-1], ("click", 150, 75, "left", 2))

        stale = {**payload, "focus": {**self.private_focus(), "title": "Other"}}
        denied = self.dispatcher.handle({"action": "click", "payload": stale})
        self.assertFalse(denied["ok"])
        self.assertEqual(denied["error"]["code"], "focus_changed")
        self.assertEqual(len(self.session.calls), 1)

    def test_input_checks_rpc_liveness_and_focus_at_dispatch(self):
        self.session.ready = True
        context = FakeContext()
        payload = {"x": 150, "y": 75, "button": "left", "count": 1, "focus": self.private_focus()}

        result = self.dispatcher.handle({"action": "click", "payload": payload}, context=context)

        self.assertTrue(result["ok"])
        self.assertGreaterEqual(context.checks, 2)

    def test_supported_baseline_operations_are_explicit_and_semantic_actions_fail_closed(self):
        self.session.ready = True
        status = self.dispatcher.handle({"action": "status", "payload": {}})["result"]
        self.assertEqual(status["operations"], ["click", "drag", "move", "type", "key", "scroll"])

        unsupported = self.dispatcher.handle({"action": "paste", "payload": {"focus": self.private_focus(), "text": "private"}})
        self.assertFalse(unsupported["ok"])
        self.assertEqual(unsupported["error"]["code"], "unsupported_operation")
        self.assertNotIn("private", str(unsupported))


if __name__ == "__main__":
    unittest.main()
