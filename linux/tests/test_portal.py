import io
import sys
import unittest
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from openagi_linux.capture import FocusSnapshot
from openagi_linux.portal import PortalStream, crop_logical_window, parse_start_result


class PortalMappingTests(unittest.TestCase):
    def setUp(self):
        self.focus = FocusSnapshot(
            window_id="9",
            pid=42,
            app_id="org.kde.kate",
            app_name="Kate",
            title="Roadmap",
            x=125,
            y=60,
            width=50,
            height=25,
            observed_at="2026-09-24T18:00:00.000Z",
        )
        image = Image.new("RGBA", (200, 100), (255, 0, 0, 255))
        self.png = io.BytesIO()
        image.save(self.png, format="PNG")

    def test_focus_geometry_is_mapped_from_logical_monitor_to_pixels(self):
        stream = PortalStream(node_id=77, position=(100, 50), logical_size=(100, 50), source_type=1)

        cropped = crop_logical_window(self.png.getvalue(), stream, self.focus)

        image = Image.open(io.BytesIO(cropped.png))
        self.assertEqual(image.size, (100, 50))
        self.assertEqual((cropped.width, cropped.height), (100, 50))

    def test_focus_outside_selected_stream_fails_closed(self):
        stream = PortalStream(node_id=77, position=(0, 0), logical_size=(100, 50), source_type=1)
        with self.assertRaisesRegex(ValueError, "outside"):
            crop_logical_window(self.png.getvalue(), stream, self.focus)

    def test_start_result_requires_one_well_formed_stream_and_rotates_restore_token(self):
        result = parse_start_result(
            {
                "streams": [(77, {
                    "position": (0, 0), "size": (1920, 1080), "source_type": 1,
                    "pipewire-serial": 9001,
                })],
                "restore_token": "new-single-use-token",
            }
        )
        self.assertEqual(result.stream.node_id, 77)
        self.assertEqual(result.stream.pipewire_serial, 9001)
        self.assertEqual(result.stream.logical_size, (1920, 1080))
        self.assertEqual(result.restore_token, "new-single-use-token")

        with self.assertRaisesRegex(ValueError, "exactly one"):
            parse_start_result({"streams": []})
        with self.assertRaisesRegex(ValueError, "PipeWire serial"):
            parse_start_result({
                "streams": [(77, {
                    "position": (0, 0),
                    "size": (1920, 1080),
                    "source_type": 1,
                    "pipewire-serial": "912345",
                })],
            })
        malformed_numeric_streams = [
            ("77", {"position": (0, 0), "size": (1920, 1080), "source_type": 1}),
            (77, {"position": (0.0, 0), "size": (1920, 1080), "source_type": 1}),
            (77, {"position": (0, 0), "size": ("1920", 1080), "source_type": 1}),
            (77, {"position": (0, 0), "size": (1920, 1080), "source_type": True}),
            (77, {"position": (0, 0), "size": (1920, 1080), "source_type": 1, "pipewire-serial": True}),
        ]
        for malformed_stream in malformed_numeric_streams:
            with self.subTest(malformed_stream=malformed_stream):
                with self.assertRaises(ValueError):
                    parse_start_result({"streams": [malformed_stream]})
        malformed_text_metadata = [
            {"mapping_id": True},
            {"mapping_id": 123},
        ]
        for malformed_props in malformed_text_metadata:
            with self.subTest(malformed_props=malformed_props):
                with self.assertRaises(ValueError):
                    parse_start_result({
                        "streams": [(77, {
                            "position": (0, 0), "size": (1920, 1080), "source_type": 1,
                            **malformed_props,
                        })],
                    })
        with self.assertRaisesRegex(ValueError, "restore token"):
            parse_start_result({
                "streams": [(77, {
                    "position": (0, 0), "size": (1920, 1080), "source_type": 1,
                })],
                "restore_token": 123,
            })
        with self.assertRaisesRegex(ValueError, "exactly one"):
            parse_start_result({"streams": [(1, {}), (2, {})]})


if __name__ == "__main__":
    unittest.main()
