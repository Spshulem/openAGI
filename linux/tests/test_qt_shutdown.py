import os
import subprocess
import sys
import textwrap
import unittest
from pathlib import Path

LINUX = Path(__file__).resolve().parents[1]


class QtShutdownTests(unittest.TestCase):
    def test_real_qt_objects_are_disposed_during_event_loop_shutdown(self):
        worker = textwrap.dedent(
            """
            from PySide6.QtCore import QObject, QTimer
            from PySide6.QtWidgets import QApplication

            from openagi_linux.runtime import CompanionRuntime
            from openagi_linux.ui import CompanionTray, QuickAskWindow


            class Component:
                def close(self):
                    return None


            class ContextProvider:
                def freeze(self):
                    return None


            class Client:
                pass


            application = QApplication([])
            quick_ask = QuickAskWindow(client=Client(), context_provider=ContextProvider())
            signals = QObject()
            tray = CompanionTray(
                on_quick_ask=quick_ask.show_quick_ask,
                on_capture_toggle=lambda: None,
                on_control_toggle=lambda: None,
                on_pause_toggle=lambda _paused: None,
                on_clear_context=lambda: None,
                on_quit=application.quit,
            )
            runtime = CompanionRuntime(
                observer_loop=Component(),
                rpc_server=Component(),
                desktop_bridge=Component(),
                capture_session=Component(),
                control_session=Component(),
                portal=Component(),
                outbox=Component(),
                tray=tray,
                owned_objects=(quick_ask, signals),
            )
            application.aboutToQuit.connect(runtime.close)
            QTimer.singleShot(100, application.quit)
            raise SystemExit(application.exec())
            """
        )
        env = {
            **os.environ,
            "PYTHONPATH": str(LINUX),
            "QT_QPA_PLATFORM": "offscreen",
            "PYTHONDONTWRITEBYTECODE": "1",
        }
        result = subprocess.run(
            [sys.executable, "-c", worker],
            cwd=LINUX,
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=15,
            check=False,
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("segmentation fault", result.stderr.casefold())
        self.assertNotIn("core dumped", result.stderr.casefold())


if __name__ == "__main__":
    unittest.main()
