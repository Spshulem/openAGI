import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from openagi_linux.portal_backend import DbusPortal


class PortalBackendLifecycleTests(unittest.TestCase):
    def test_failed_connection_closes_owned_event_loop_before_constructor_raises(self):
        loops = []

        import asyncio

        real_new_event_loop = asyncio.new_event_loop

        def capture_loop():
            loop = real_new_event_loop()
            loops.append(loop)
            return loop

        with patch("openagi_linux.portal_backend.asyncio.new_event_loop", side_effect=capture_loop):
            with patch("openagi_linux.portal_backend.MessageBus", side_effect=RuntimeError("no session bus")):
                with self.assertRaisesRegex(RuntimeError, "no session bus"):
                    DbusPortal()

        self.assertEqual(len(loops), 1)
        self.assertTrue(loops[0].is_closed())


@unittest.skipUnless(os.getenv("DBUS_SESSION_BUS_ADDRESS"), "session D-Bus is unavailable")
class LivePortalBackendTests(unittest.TestCase):
    def test_screencast_portal_advertises_monitor_capture_without_prompting(self):
        portal = DbusPortal()
        try:
            source_types = portal.available_source_types()
            cursor_modes = portal.available_cursor_modes()
            device_types = portal.available_device_types()
        finally:
            portal.close()
        self.assertEqual(source_types & 1, 1)
        self.assertGreater(cursor_modes, 0)
        self.assertEqual(device_types & 3, 3)


if __name__ == "__main__":
    unittest.main()
