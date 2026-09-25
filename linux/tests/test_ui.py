import os
import sys
import time
import unittest
from pathlib import Path

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from PySide6.QtWidgets import QApplication

from openagi_linux.client import AskResult
from openagi_linux.ui import CompanionTray, QuickAskWindow


class ContextProvider:
    def __init__(self):
        self.calls = 0

    def freeze(self):
        self.calls += 1
        return {"app": "Kate", "window": "Roadmap", "text": "Visible text"}


class Client:
    def __init__(self):
        self.calls = []

    def ask(self, text, *, screen_context=None, on_event=None):
        self.calls.append((text, screen_context))
        if on_event:
            on_event("delta", {"text": "Partial"})
        return AskResult("Final answer", "overlay:user:main")


class QuickAskWindowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QApplication.instance() or QApplication([])

    def setUp(self):
        self.context = ContextProvider()
        self.client = Client()
        self.window = QuickAskWindow(client=self.client, context_provider=self.context)

    def tearDown(self):
        self.window.close()
        self.app.processEvents()

    def wait_until(self, predicate, timeout=2):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            self.app.processEvents()
            if predicate():
                return
            time.sleep(0.01)
        self.fail("timed out waiting for Qt state")

    def test_context_is_frozen_before_window_takes_focus(self):
        self.window.show_quick_ask()
        self.app.processEvents()
        self.assertEqual(self.context.calls, 1)
        self.assertEqual(self.window.frozen_context["window"], "Roadmap")
        self.assertTrue(self.window.isVisible())

    def test_submit_uses_frozen_context_and_renders_terminal_response(self):
        self.window.show_quick_ask()
        self.window.prompt.setPlainText("What am I looking at?")
        self.window.submit()
        self.wait_until(lambda: self.window.submit_button.isEnabled())

        self.assertEqual(self.client.calls, [
            ("What am I looking at?", {"app": "Kate", "window": "Roadmap", "text": "Visible text"})
        ])
        self.assertEqual(self.window.response.toPlainText(), "Final answer")
        self.assertEqual(self.window.prompt.toPlainText(), "")


class CompanionTrayTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QApplication.instance() or QApplication([])

    def test_tray_exposes_quick_ask_privacy_control_pause_and_quit_actions(self):
        calls = []
        tray = CompanionTray(
            on_quick_ask=lambda: calls.append("ask"),
            on_capture_toggle=lambda: calls.append("capture"),
            on_control_toggle=lambda: calls.append("control"),
            on_pause_toggle=lambda paused: calls.append(("pause", paused)),
            on_clear_context=lambda: calls.append("clear"),
            on_quit=lambda: calls.append("quit"),
        )
        try:
            self.assertEqual(tray.capture_action.text(), "Enable screen context…")
            self.assertEqual(tray.control_action.text(), "Enable computer control…")
            tray.quick_ask_action.trigger()
            tray.capture_action.trigger()
            tray.control_action.trigger()
            tray.pause_action.trigger()
            tray.clear_context_action.trigger()
            tray.quit_action.trigger()
            self.assertEqual(calls, ["ask", "capture", "control", ("pause", True), "clear", "quit"])

            tray.set_capture_enabled(True)
            tray.set_control_enabled(True)
            self.assertEqual(tray.capture_action.text(), "Disable screen context")
            self.assertEqual(tray.control_action.text(), "Disable computer control")
        finally:
            tray.hide()


if __name__ == "__main__":
    unittest.main()
