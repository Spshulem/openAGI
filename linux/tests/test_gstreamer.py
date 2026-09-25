import io
import sys
import unittest
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from openagi_linux.gstreamer import GstPngSampler


class GstPngSamplerTests(unittest.TestCase):
    def test_sampler_converts_rgba_samples_to_bounded_png(self):
        sampler = GstPngSampler(
            "videotestsrc is-live=true pattern=red ! "
            "video/x-raw,width=160,height=90,format=RGBA ! "
            "appsink name=openagi_sink max-buffers=1 drop=true sync=false"
        )
        try:
            png = sampler.capture_png(timeout_seconds=3)
        finally:
            sampler.close()

        image = Image.open(io.BytesIO(png))
        self.assertEqual(image.size, (160, 90))
        self.assertEqual(image.mode, "RGBA")
        self.assertLess(len(png), 1024 * 1024)

    def test_sampler_discards_queued_samples_older_than_the_capture_barrier(self):
        class Buffer:
            def __init__(self, pts):
                self.pts = pts

        class Sample:
            def __init__(self, pts):
                self.buffer = Buffer(pts)

            def get_buffer(self):
                return self.buffer

        stale = Sample(899)
        fresh = Sample(900)

        class Sink:
            def __init__(self):
                self.samples = [Sample((1 << 64) - 1), stale, fresh]

            def emit(self, _name, _timeout):
                return self.samples.pop(0)

        class Clock:
            def get_time(self):
                return 1_000

        class Pipeline:
            def get_clock(self):
                return Clock()

            def get_base_time(self):
                return 100

        sampler = GstPngSampler.__new__(GstPngSampler)
        sampler._closed = False
        sampler._pipeline = Pipeline()
        sampler._sink = Sink()

        selected = sampler._pull_fresh_sample(timeout_seconds=1)

        self.assertIs(selected, fresh)
        self.assertEqual(sampler._sink.samples, [])

    def test_sampler_rejects_capture_after_close(self):
        sampler = GstPngSampler(
            "videotestsrc num-buffers=1 ! video/x-raw,width=64,height=64,format=RGBA ! "
            "appsink name=openagi_sink"
        )
        sampler.close()
        with self.assertRaisesRegex(RuntimeError, "closed"):
            sampler.capture_png()


if __name__ == "__main__":
    unittest.main()
