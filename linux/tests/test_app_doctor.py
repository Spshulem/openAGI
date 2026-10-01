import json
import os
import subprocess
import sys
import unittest
from pathlib import Path


class AppDoctorTests(unittest.TestCase):
    def test_doctor_checks_dependencies_without_opening_portal_sessions(self):
        linux_root = Path(__file__).resolve().parents[1]
        session_bus = os.environ.get(
            "DBUS_SESSION_BUS_ADDRESS",
            f"unix:path={os.environ.get('XDG_RUNTIME_DIR', f'/run/user/{os.getuid()}')}/bus",
        )
        env = {
            **os.environ,
            "PYTHONPATH": str(linux_root),
            "QT_QPA_PLATFORM": "offscreen",
            "DBUS_SESSION_BUS_ADDRESS": session_bus,
        }
        process = subprocess.run(
            [sys.executable, "-m", "openagi_linux.app", "--doctor"],
            cwd=linux_root,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=20,
            check=False,
            text=True,
        )
        self.assertEqual(process.returncode, 0, process.stderr)
        report = json.loads(process.stdout)
        self.assertTrue(report["ok"])
        self.assertEqual(report["portal"]["screenCastMonitor"], True)
        self.assertEqual(report["portal"]["remoteDesktopKeyboardPointer"], True)
        self.assertEqual(report["tesseract"], True)
        self.assertEqual(report["wayland"], True)
        self.assertNotIn("restore", process.stdout.casefold())


if __name__ == "__main__":
    unittest.main()
