import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from openagi_linux.focus import FocusRegistry


class FocusRegistryTests(unittest.TestCase):
    def setUp(self):
        self.now = 1_000.0
        self.registry = FocusRegistry(now=lambda: self.now, companion_app_id="sh.openagi.LinuxCompanion")
        self.payload = {
            "internalId": "5bb529f4-6dc8-4f02-9d94-d11a63515f3c",
            "pid": 1234,
            "caption": "Roadmap — Kate",
            "desktopFileName": "org.kde.kate",
            "resourceClass": "kate",
            "resourceName": "kate",
            "frameGeometry": {"x": 10, "y": 20, "width": 800, "height": 600},
            "output": "DP-1",
            "fullScreen": False,
            "minimized": False,
            "specialWindow": False,
        }

    def test_report_normalizes_a_wayland_window_and_produces_stable_private_identity(self):
        accepted = self.registry.report_json(json.dumps(self.payload))
        self.assertTrue(accepted)

        focus = self.registry.current(max_age_seconds=2)
        self.assertEqual(focus.app_id, "org.kde.kate")
        self.assertEqual(focus.app_name, "kate")
        self.assertEqual(focus.title, "Roadmap — Kate")
        self.assertEqual((focus.x, focus.y, focus.width, focus.height), (10, 20, 800, 600))
        self.assertGreater(int(focus.window_id), 0)
        self.assertLessEqual(int(focus.window_id), 9_007_199_254_740_991)

        first_id = focus.window_id
        self.registry.report_json(json.dumps({**self.payload, "caption": "Roadmap v2 — Kate"}))
        self.assertEqual(self.registry.current().window_id, first_id)

    def test_companion_focus_invalidates_the_live_capture_identity(self):
        self.registry.report_json(json.dumps(self.payload))
        companion = {
            **self.payload,
            "internalId": "2472f957-3d9c-4431-a4bc-31e510e0ff99",
            "pid": 9999,
            "desktopFileName": "sh.openagi.LinuxCompanion",
            "caption": "Quick Ask",
        }

        self.assertFalse(self.registry.report_json(json.dumps(companion)))
        self.assertIsNone(self.registry.current())

    def test_stale_or_unverifiable_focus_fails_closed(self):
        self.registry.report_json(json.dumps(self.payload))
        self.now += 3
        self.assertIsNone(self.registry.current(max_age_seconds=2))

        malformed = {**self.payload, "frameGeometry": {"x": 0, "y": 0, "width": 1, "height": 1}}
        self.assertFalse(self.registry.report_json(json.dumps(malformed)))
        self.assertIsNone(self.registry.current(max_age_seconds=2))

    def test_special_or_minimized_windows_are_refused(self):
        for field in ("specialWindow", "minimized"):
            with self.subTest(field=field):
                registry = FocusRegistry(now=lambda: self.now)
                self.assertFalse(registry.report_json(json.dumps({**self.payload, field: True})))
                self.assertIsNone(registry.current())


class KWinScriptContractTests(unittest.TestCase):
    def test_script_is_observation_only_and_registers_quick_ask(self):
        root = Path(__file__).resolve().parents[1]
        script = (root / "kwin" / "contents" / "code" / "main.js").read_text(encoding="utf-8")
        self.assertIn("workspace.windowActivated.connect", script)
        self.assertIn("callDBus", script)
        self.assertIn('"ReportWindow"', script)
        self.assertIn('"ToggleQuickAsk"', script)
        self.assertIn("registerShortcut", script)
        self.assertNotRegex(script, r"workspace\.activeWindow\s*=[^=]")
        self.assertNotIn("window.close", script)
        self.assertNotIn("window.frameGeometry =", script)


if __name__ == "__main__":
    unittest.main()
