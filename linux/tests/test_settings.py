import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from openagi_linux.settings import RuntimeSettings


class RuntimeSettingsTests(unittest.TestCase):
    def test_xdg_paths_and_machine_identity_are_private_and_stable(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            env = {
                "HOME": str(root / "home"),
                "XDG_STATE_HOME": str(root / "state"),
                "XDG_RUNTIME_DIR": str(root / "run"),
                "OPENAGI_LINUX_BASE_URL": "http://127.0.0.1:43210",
                "OPENAGI_LINUX_OCR_INTERVAL": "20",
                "OPENAGI_LINUX_TESSERACT": "/usr/bin/tesseract",
                "OPENAGI_LINUX_EXCLUDED_APPS": "org.example.Vault, org.example.Chat",
                "OPENAGI_LINUX_EXCLUDED_TITLE_TERMS": "Payroll, Client Secret",
            }
            (root / "run").mkdir(mode=0o700)
            with patch.dict(os.environ, env, clear=True):
                first = RuntimeSettings.from_environment()
                second = RuntimeSettings.from_environment()

            self.assertEqual(first.machine_id, second.machine_id)
            self.assertRegex(first.machine_id, r"^linux_[a-f0-9]{32}$")
            self.assertEqual(first.socket_path, root / "run" / "openagi-linux-companion.sock")
            self.assertEqual(first.ocr_interval_seconds, 20)
            self.assertEqual(first.excluded_apps, ("org.example.Vault", "org.example.Chat"))
            self.assertEqual(first.excluded_title_terms, ("Payroll", "Client Secret"))
            identity = root / "state" / "openagi" / "linux-companion" / "machine-id"
            self.assertEqual(stat.S_IMODE(identity.stat().st_mode), 0o600)

    def test_invalid_intervals_and_insecure_remote_urls_fail_closed(self):
        with tempfile.TemporaryDirectory() as temp:
            base = {
                "HOME": temp,
                "XDG_RUNTIME_DIR": temp,
                "OPENAGI_LINUX_OCR_INTERVAL": "0",
                "OPENAGI_LINUX_TESSERACT": "/usr/bin/tesseract",
            }
            with patch.dict(os.environ, base, clear=True):
                with self.assertRaisesRegex(ValueError, "interval"):
                    RuntimeSettings.from_environment()
            with patch.dict(os.environ, {**base, "OPENAGI_LINUX_OCR_INTERVAL": "15", "OPENAGI_LINUX_BASE_URL": "http://192.0.2.2:43210"}, clear=True):
                with self.assertRaisesRegex(ValueError, "HTTPS"):
                    RuntimeSettings.from_environment()

    def test_overlong_runtime_socket_path_is_rejected_before_rpc_bind(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            runtime = root / ("r" * 90)
            runtime.mkdir()
            env = {
                "HOME": str(root / "home"),
                "XDG_STATE_HOME": str(root / "state"),
                "XDG_RUNTIME_DIR": str(runtime),
                "OPENAGI_LINUX_TESSERACT": "/usr/bin/tesseract",
            }
            with patch.dict(os.environ, env, clear=True):
                with self.assertRaisesRegex(ValueError, "socket path"):
                    RuntimeSettings.from_environment()


if __name__ == "__main__":
    unittest.main()
