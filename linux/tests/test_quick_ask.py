import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from openagi_linux.capture import FocusSnapshot, Frame, PrivacyPolicy
from openagi_linux.ocr import OcrResult
from openagi_linux.quick_ask import QuickAskContextProvider


class Registry:
    def __init__(self, focus):
        self.focus = focus

    def current(self, max_age_seconds=5):
        return self.focus


class Capture:
    def __init__(self, ready=True):
        self.ready = ready
        self.calls = []

    def capture_focus(self, focus):
        self.calls.append(focus)
        return Frame(b"\x89PNG\r\n\x1a\nquick", 800, 600)


class Ocr:
    def __init__(self):
        self.calls = []

    def recognize(self, png):
        self.calls.append(png)
        return OcrResult("Visible roadmap", 0.92)


class QuickAskContextProviderTests(unittest.TestCase):
    def setUp(self):
        self.focus = FocusSnapshot(
            window_id="7", pid=42, app_id="org.kde.kate", app_name="Kate", title="Roadmap",
            x=0, y=0, width=800, height=600, observed_at="2026-09-24T18:00:00.000Z",
        )

    def test_freezes_context_before_ui_focus_changes(self):
        registry = Registry(self.focus)
        capture = Capture()
        ocr = Ocr()
        provider = QuickAskContextProvider(registry, capture, ocr, PrivacyPolicy())

        frozen = provider.freeze()
        registry.focus = self.focus.__class__(**{**self.focus.__dict__, "app_id": "sh.openagi.LinuxCompanion", "title": "Quick Ask"})

        self.assertEqual(frozen, {"app": "Kate", "window": "Roadmap", "text": "Visible roadmap"})
        self.assertEqual(capture.calls, [self.focus])

    def test_without_capture_permission_quick_ask_has_no_screen_context_and_opens_no_portal(self):
        capture = Capture(ready=False)
        provider = QuickAskContextProvider(Registry(self.focus), capture, Ocr(), PrivacyPolicy())
        self.assertIsNone(provider.freeze())
        self.assertEqual(capture.calls, [])

    def test_sensitive_focus_is_rejected_before_capture(self):
        sensitive = self.focus.__class__(**{**self.focus.__dict__, "app_id": "org.keepassxc.KeePassXC"})
        capture = Capture()
        provider = QuickAskContextProvider(Registry(sensitive), capture, Ocr(), PrivacyPolicy())
        self.assertIsNone(provider.freeze())
        self.assertEqual(capture.calls, [])

    def test_privacy_is_rechecked_after_capture_before_ocr(self):
        capture = Capture()
        ocr = Ocr()

        class PrivacyChanged:
            def __init__(self):
                self.calls = 0

            def reason(self, _focus):
                self.calls += 1
                return None if self.calls == 1 else "private"

        provider = QuickAskContextProvider(Registry(self.focus), capture, ocr, PrivacyChanged())

        self.assertIsNone(provider.freeze())
        self.assertEqual(capture.calls, [self.focus])
        self.assertEqual(ocr.calls, [])


if __name__ == "__main__":
    unittest.main()
