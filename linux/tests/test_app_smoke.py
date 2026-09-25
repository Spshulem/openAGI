import json
import os
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
LINUX = ROOT / "linux"


class AppSmokeTests(unittest.TestCase):
    def test_daemon_serves_helper_status_and_shuts_down_cleanly_on_sigterm(self):
        session_bus = os.environ.get("DBUS_SESSION_BUS_ADDRESS") or (
            f"unix:path={os.environ.get('XDG_RUNTIME_DIR', f'/run/user/{os.getuid()}')}/bus"
        )
        bus_env = {**os.environ, "DBUS_SESSION_BUS_ADDRESS": session_bus}
        try:
            owner = subprocess.run(
                ["busctl", "--user", "status", "org.openagi.LinuxCompanion"],
                env=bus_env,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=2,
                check=False,
            )
        except (FileNotFoundError, subprocess.TimeoutExpired):
            owner = None
        if owner is not None and owner.returncode == 0:
            self.skipTest("an installed OpenAGI Linux companion already owns the session D-Bus name")

        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            runtime_dir = root / "run"
            runtime_dir.mkdir(mode=0o700)
            env = {
                **os.environ,
                "PYTHONPATH": str(LINUX),
                "QT_QPA_PLATFORM": "offscreen",
                "HOME": str(root / "home"),
                "XDG_STATE_HOME": str(root / "state"),
                "XDG_RUNTIME_DIR": str(runtime_dir),
                "DBUS_SESSION_BUS_ADDRESS": session_bus,
                "OPENAGI_LINUX_TESSERACT": "/usr/bin/tesseract",
            }
            process = subprocess.Popen(
                [sys.executable, "-m", "openagi_linux.app"],
                cwd=LINUX,
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            socket_path = runtime_dir / "openagi-linux-companion.sock"
            try:
                deadline = time.monotonic() + 10
                while not socket_path.exists() and process.poll() is None and time.monotonic() < deadline:
                    time.sleep(0.05)
                if process.poll() is not None:
                    _stdout, stderr = process.communicate(timeout=5)
                    self.fail(stderr)
                self.assertTrue(socket_path.exists())

                helper_env = {**env, "OPENAGI_LINUX_SOCKET": str(socket_path)}
                helper = subprocess.run(
                    [sys.executable, "-m", "openagi_linux.helper", "status"],
                    cwd=LINUX,
                    env=helper_env,
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                    timeout=5,
                    check=False,
                )
                self.assertEqual(helper.returncode, 0, helper.stderr)
                status = json.loads(helper.stdout)
                self.assertFalse(status["screenshotReady"])
                self.assertFalse(status["inputReady"])

                authority_env = {
                    **helper_env,
                    "OPENAGI_LINUX_LEASE_ID": "culease_smoke",
                    "OPENAGI_LINUX_APPROVAL_ACTION_ID": "action_smoke",
                    "OPENAGI_LINUX_SEQUENCE": "1",
                    "OPENAGI_LINUX_LEASE_EXPIRES_MS": str(int(time.time() * 1000) + 20_000),
                }
                denied = subprocess.run(
                    [sys.executable, "-m", "openagi_linux.helper", "click"],
                    cwd=LINUX,
                    env=authority_env,
                    input=json.dumps({"x": 10, "y": 10, "focus": {}}),
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                    timeout=5,
                    check=False,
                )
                self.assertNotEqual(denied.returncode, 0)
                self.assertIn("access_denied", denied.stderr)

                process.send_signal(signal.SIGTERM)
                self.assertEqual(process.wait(timeout=10), 0)
                self.assertFalse(socket_path.exists())
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait(timeout=5)
                process.communicate(timeout=5)


if __name__ == "__main__":
    unittest.main()
