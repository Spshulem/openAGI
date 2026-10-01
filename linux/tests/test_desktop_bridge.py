import os
import subprocess
import sys
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from openagi_linux.desktop_bridge import DesktopBridge


@unittest.skipUnless(os.getenv("DBUS_SESSION_BUS_ADDRESS"), "session D-Bus is unavailable")
class DesktopBridgeTests(unittest.TestCase):
    def test_non_kwin_clients_cannot_report_focus_or_toggle_quick_ask(self):
        reports = []
        toggles = []
        service = f"org.openagi.LinuxCompanion.Test{os.getpid()}"
        bridge = DesktopBridge(service_name=service, on_report=reports.append, on_toggle=lambda: toggles.append(True))
        bridge.start()
        try:
            first = subprocess.run(
                ["busctl", "--user", "call", service, "/org/openagi/LinuxCompanion", "org.openagi.LinuxCompanion", "ReportWindow", "s", '{"caption":"Roadmap"}'],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10, check=False, text=True,
            )
            second = subprocess.run(
                ["busctl", "--user", "call", service, "/org/openagi/LinuxCompanion", "org.openagi.LinuxCompanion", "ToggleQuickAsk"],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10, check=False, text=True,
            )
            self.assertNotEqual(first.returncode, 0)
            self.assertNotEqual(second.returncode, 0)
            time.sleep(0.05)
            self.assertEqual(reports, [])
            self.assertEqual(toggles, [])
        finally:
            bridge.close()


if __name__ == "__main__":
    unittest.main()
