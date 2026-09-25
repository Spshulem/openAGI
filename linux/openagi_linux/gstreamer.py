from __future__ import annotations

import io
import os
import threading
import time

import gi
from PIL import Image

gi.require_version("Gst", "1.0")
from gi.repository import Gst

Gst.init(None)


class GstPngSampler:
    def __init__(self, pipeline_description: str) -> None:
        self._closed = False
        self._capture_lock = threading.Lock()
        self._pipeline = Gst.parse_launch(pipeline_description)
        self._sink = self._pipeline.get_by_name("openagi_sink")
        if self._sink is None:
            self._pipeline.set_state(Gst.State.NULL)
            raise RuntimeError("GStreamer pipeline has no OpenAGI app sink")
        result = self._pipeline.set_state(Gst.State.PLAYING)
        if result == Gst.StateChangeReturn.FAILURE:
            self._pipeline.set_state(Gst.State.NULL)
            raise RuntimeError("GStreamer pipeline could not start")

    def capture_png(self, timeout_seconds: float = 3) -> bytes:
        with self._capture_lock:
            if self._closed:
                raise RuntimeError("GStreamer sampler is closed")
            sample = self._pull_fresh_sample(timeout_seconds)
            return self._sample_to_png(sample)

    def _pull_fresh_sample(self, timeout_seconds: float):
        clock = self._pipeline.get_clock()
        base_time = int(self._pipeline.get_base_time())
        if clock is None:
            raise RuntimeError("GStreamer pipeline has no clock")
        clock_time = int(clock.get_time())
        if base_time == Gst.CLOCK_TIME_NONE or clock_time < base_time:
            raise RuntimeError("GStreamer pipeline clock is invalid")
        capture_barrier = clock_time - base_time
        deadline = time.monotonic() + max(0.001, float(timeout_seconds))
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("GStreamer timed out waiting for a fresh portal frame")
            sample = self._sink.emit("try-pull-sample", max(1, int(remaining * Gst.SECOND)))
            if sample is None:
                error = self._pipeline.get_bus().pop_filtered(Gst.MessageType.ERROR)
                if error is not None:
                    raise RuntimeError("GStreamer could not read the portal stream")
                raise TimeoutError("GStreamer timed out waiting for a portal frame")
            buffer = sample.get_buffer()
            presentation_time = int(buffer.pts)
            if presentation_time == Gst.CLOCK_TIME_NONE or presentation_time < capture_barrier:
                continue
            return sample

    def _sample_to_png(self, sample) -> bytes:
        caps = sample.get_caps()
        structure = caps.get_structure(0) if caps else None
        if structure is None:
            raise RuntimeError("GStreamer frame has no video caps")
        width = int(structure.get_value("width"))
        height = int(structure.get_value("height"))
        fmt = str(structure.get_value("format"))
        if fmt != "RGBA" or not (1 <= width <= 16_384 and 1 <= height <= 16_384):
            raise RuntimeError("GStreamer returned an unsupported frame format")
        buffer = sample.get_buffer()
        ok, mapped = buffer.map(Gst.MapFlags.READ)
        if not ok:
            raise RuntimeError("GStreamer frame could not be mapped")
        try:
            raw = bytes(mapped.data)
        finally:
            buffer.unmap(mapped)
        minimum = width * height * 4
        if len(raw) < minimum or len(raw) > 128 * 1024 * 1024:
            raise RuntimeError("GStreamer frame size is invalid")
        stride = len(raw) // height
        if stride < width * 4:
            raise RuntimeError("GStreamer frame stride is invalid")
        image = Image.frombytes("RGBA", (width, height), raw, "raw", "RGBA", stride, 1)
        output = io.BytesIO()
        image.save(output, format="PNG")
        png = output.getvalue()
        if len(png) > 32 * 1024 * 1024:
            raise RuntimeError("portal frame exceeds the PNG safety limit")
        return png

    def close(self) -> None:
        with self._capture_lock:
            if self._closed:
                return
            self._closed = True
            self._pipeline.set_state(Gst.State.NULL)


class PipeWireFrameSource:
    def __init__(self, fd: int, node_id: int) -> None:
        if fd < 0 or node_id <= 0:
            raise ValueError("invalid PipeWire stream")
        self._fd = fd
        self._sampler = GstPngSampler(
            f"pipewiresrc fd={int(fd)} path={int(node_id)} do-timestamp=true ! "
            "queue max-size-buffers=1 leaky=downstream ! "
            "videoconvert ! video/x-raw,format=RGBA ! "
            "appsink name=openagi_sink max-buffers=1 drop=true sync=false"
        )

    def capture_png(self, timeout_seconds: float = 3) -> bytes:
        return self._sampler.capture_png(timeout_seconds)

    def close(self) -> None:
        sampler = getattr(self, "_sampler", None)
        if sampler is not None:
            self._sampler = None
            sampler.close()
        fd = getattr(self, "_fd", -1)
        if fd >= 0:
            self._fd = -1
            try:
                os.close(fd)
            except OSError:
                pass
