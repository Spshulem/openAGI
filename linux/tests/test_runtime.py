import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from openagi_linux.runtime import CompanionRuntime


class Component:
    def __init__(self, name, calls, ready=False):
        self.name = name
        self.calls = calls
        self.ready = ready

    def start(self, *args, **kwargs):
        self.calls.append((self.name, "start"))
        self.ready = True

    def close(self):
        self.calls.append((self.name, "close"))
        self.ready = False

    def clear(self):
        self.calls.append((self.name, "clear"))
        return 3


class Tray(Component):
    def show(self):
        self.calls.append((self.name, "show"))

    def hide(self):
        self.calls.append((self.name, "hide"))

    def set_capture_enabled(self, value):
        self.calls.append((self.name, "capture", value))

    def set_control_enabled(self, value):
        self.calls.append((self.name, "control", value))

    def showMessage(self, title, message):
        self.calls.append((self.name, "message", title, message))


class RuntimeTests(unittest.TestCase):
    def test_start_never_opens_portal_sessions_and_user_toggles_are_explicit(self):
        calls = []
        runtime = CompanionRuntime(
            observer_loop=Component("observer", calls),
            rpc_server=Component("rpc", calls),
            desktop_bridge=Component("bridge", calls),
            capture_session=Component("capture", calls),
            control_session=Component("control", calls),
            portal=Component("portal", calls),
            outbox=Component("outbox", calls),
            tray=Tray("tray", calls),
        )

        runtime.start()
        self.assertNotIn(("capture", "start"), calls)
        self.assertNotIn(("control", "start"), calls)

        runtime.toggle_capture()
        runtime.toggle_control()
        self.assertIn(("capture", "start"), calls)
        self.assertIn(("control", "start"), calls)
        self.assertIn(("tray", "capture", True), calls)
        self.assertIn(("tray", "control", True), calls)

        runtime.toggle_capture()
        runtime.toggle_control()
        self.assertIn(("capture", "close"), calls)
        self.assertIn(("control", "close"), calls)

    def test_close_releases_background_and_portal_resources(self):
        calls = []
        runtime = CompanionRuntime(
            observer_loop=Component("observer", calls),
            rpc_server=Component("rpc", calls),
            desktop_bridge=Component("bridge", calls),
            capture_session=Component("capture", calls),
            control_session=Component("control", calls),
            portal=Component("portal", calls),
            outbox=Component("outbox", calls),
            tray=Tray("tray", calls),
        )
        runtime.start()
        runtime.close()
        for name in ("observer", "rpc", "bridge", "capture", "control", "portal", "outbox"):
            self.assertIn((name, "close"), calls)
        self.assertIn(("tray", "hide"), calls)

    def test_portal_revocation_updates_tray_state_and_warns_user(self):
        calls = []
        runtime = CompanionRuntime(
            observer_loop=Component("observer", calls),
            rpc_server=Component("rpc", calls),
            desktop_bridge=Component("bridge", calls),
            capture_session=Component("capture", calls),
            control_session=Component("control", calls),
            portal=Component("portal", calls),
            outbox=Component("outbox", calls),
            tray=Tray("tray", calls),
        )

        runtime.capture_revoked()
        runtime.control_revoked()

        self.assertIn(("tray", "capture", False), calls)
        self.assertIn(("tray", "control", False), calls)
        messages = [call for call in calls if call[:2] == ("tray", "message")]
        self.assertEqual(len(messages), 2)

    def test_clear_context_removes_queued_observations_and_notifies_user(self):
        calls = []
        runtime = CompanionRuntime(
            observer_loop=Component("observer", calls),
            rpc_server=Component("rpc", calls),
            desktop_bridge=Component("bridge", calls),
            capture_session=Component("capture", calls),
            control_session=Component("control", calls),
            portal=Component("portal", calls),
            outbox=Component("outbox", calls),
            tray=Tray("tray", calls),
        )

        runtime.clear_context()

        self.assertIn(("outbox", "clear"), calls)
        self.assertIn(("tray", "message", "OpenAGI", "Deleted 3 queued observation batches."), calls)


if __name__ == "__main__":
    unittest.main()
