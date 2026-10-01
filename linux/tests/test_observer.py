import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from openagi_linux.capture import CapturePipeline, FocusSnapshot, Frame, PipelineResult, PrivacyPolicy
from openagi_linux.observer import ObservationLoop, ObservationWorker
from openagi_linux.ocr import OcrResult
from openagi_linux.outbox import ObservationOutbox


class FakeRegistry:
    def __init__(self, focus):
        self.focus = focus

    def current(self, max_age_seconds=5):
        return self.focus


class FakeCapture:
    def __init__(self, ready=False):
        self.ready = ready
        self.calls = []

    def capture_focus(self, focus):
        self.calls.append(focus)
        return Frame(png=b"\x89PNG\r\n\x1a\n pixels", width=800, height=600)


class FakePipeline:
    def __init__(self):
        self.activity = []
        self.frames = []
        self.flushes = 0

    def flush(self):
        self.flushes += 1
        return 0

    def process_activity(self, focus):
        self.activity.append(focus)
        return PipelineResult("sent")

    def process_frame(self, focus, frame):
        self.frames.append((focus, frame))
        return PipelineResult("sent")


class ObservationWorkerTests(unittest.TestCase):
    def setUp(self):
        self.focus = FocusSnapshot(
            window_id="9",
            pid=123,
            app_id="org.kde.kate",
            app_name="Kate",
            title="Roadmap",
            x=0,
            y=0,
            width=800,
            height=600,
            observed_at="2026-09-24T18:00:00.000Z",
        )

    def test_activity_works_without_capture_and_capture_is_never_started_implicitly(self):
        capture = FakeCapture(ready=False)
        pipeline = FakePipeline()
        worker = ObservationWorker(
            focus_registry=FakeRegistry(self.focus),
            capture_session=capture,
            pipeline=pipeline,
            privacy=PrivacyPolicy(),
            clock=lambda: 100.0,
        )

        status = worker.run_once()
        self.assertEqual(status, "activity")
        self.assertEqual(pipeline.activity, [self.focus])
        self.assertEqual(capture.calls, [])

    def test_pending_outbox_is_retried_periodically_without_new_focus(self):
        now = [100.0]
        pipeline = FakePipeline()
        worker = ObservationWorker(
            focus_registry=FakeRegistry(None),
            capture_session=FakeCapture(ready=False),
            pipeline=pipeline,
            privacy=PrivacyPolicy(),
            clock=lambda: now[0],
            flush_interval_seconds=30,
        )

        worker.run_once()
        now[0] += 20
        worker.run_once()
        now[0] += 11
        worker.run_once()

        self.assertEqual(pipeline.flushes, 2)

    def test_allowed_ready_window_is_captured_only_after_activity_is_admitted(self):
        capture = FakeCapture(ready=True)
        pipeline = FakePipeline()
        worker = ObservationWorker(
            focus_registry=FakeRegistry(self.focus),
            capture_session=capture,
            pipeline=pipeline,
            privacy=PrivacyPolicy(),
            clock=lambda: 100.0,
            ocr_interval_seconds=10,
        )

        self.assertEqual(worker.run_once(), "frame")
        self.assertEqual(pipeline.activity, [self.focus])
        self.assertEqual(capture.calls, [self.focus])
        self.assertEqual(pipeline.frames[0][0], self.focus)

    def test_sensitive_window_is_rejected_before_any_capture_or_observation(self):
        sensitive = self.focus.__class__(**{**self.focus.__dict__, "app_id": "org.keepassxc.KeePassXC"})
        capture = FakeCapture(ready=True)
        pipeline = FakePipeline()
        worker = ObservationWorker(
            focus_registry=FakeRegistry(sensitive),
            capture_session=capture,
            pipeline=pipeline,
            privacy=PrivacyPolicy(),
            clock=lambda: 100.0,
        )

        self.assertEqual(worker.run_once(), "privacy-excluded")
        self.assertEqual(pipeline.activity, [])
        self.assertEqual(pipeline.frames, [])
        self.assertEqual(capture.calls, [])

    def test_focus_is_rechecked_after_capture_before_ocr(self):
        sensitive = self.focus.__class__(**{**self.focus.__dict__, "app_id": "org.keepassxc.KeePassXC"})

        class ChangingRegistry:
            def __init__(self, first):
                self.first = first
                self.calls = 0

            def current(self, max_age_seconds=5):
                self.calls += 1
                return self.first if self.calls == 1 else sensitive

        capture = FakeCapture(ready=True)
        pipeline = FakePipeline()
        worker = ObservationWorker(
            focus_registry=ChangingRegistry(self.focus),
            capture_session=capture,
            pipeline=pipeline,
            privacy=PrivacyPolicy(),
            clock=lambda: 100.0,
        )

        self.assertEqual(worker.run_once(), "privacy-excluded")
        self.assertEqual(capture.calls, [self.focus])
        self.assertEqual(pipeline.frames, [])

    def test_ocr_interval_is_monotonic_and_does_not_duplicate_unchanged_activity(self):
        now = [100.0]
        capture = FakeCapture(ready=True)
        pipeline = FakePipeline()
        worker = ObservationWorker(
            focus_registry=FakeRegistry(self.focus),
            capture_session=capture,
            pipeline=pipeline,
            privacy=PrivacyPolicy(),
            clock=lambda: now[0],
            ocr_interval_seconds=10,
        )
        self.assertEqual(worker.run_once(), "frame")
        now[0] = 105.0
        self.assertEqual(worker.run_once(), "idle")
        now[0] = 111.0
        self.assertEqual(worker.run_once(), "frame")
        self.assertEqual(len(pipeline.activity), 1)
        self.assertEqual(len(pipeline.frames), 2)

    def test_capture_failure_logs_only_the_safe_stage_and_exception_type(self):
        class FailingCapture(FakeCapture):
            def capture_focus(self, focus):
                raise RuntimeError("PRIVATE WINDOW CONTENT")

        worker = ObservationWorker(
            focus_registry=FakeRegistry(self.focus),
            capture_session=FailingCapture(ready=True),
            pipeline=FakePipeline(),
            privacy=PrivacyPolicy(),
            clock=lambda: 100.0,
        )

        with self.assertLogs("openagi_linux.observer", level="WARNING") as captured:
            self.assertEqual(worker.run_once(), "capture-error")
        joined = "\n".join(captured.output)
        self.assertIn("portal-frame", joined)
        self.assertIn("RuntimeError", joined)
        self.assertNotIn("PRIVATE WINDOW CONTENT", joined)

    def test_empty_local_ocr_is_reported_without_frame_content(self):
        class EmptyOcrPipeline(FakePipeline):
            def process_frame(self, focus, frame):
                return PipelineResult("skipped", "ocr-empty")

        worker = ObservationWorker(
            focus_registry=FakeRegistry(self.focus),
            capture_session=FakeCapture(ready=True),
            pipeline=EmptyOcrPipeline(),
            privacy=PrivacyPolicy(),
            clock=lambda: 100.0,
        )

        with self.assertLogs("openagi_linux.observer", level="WARNING") as captured:
            self.assertEqual(worker.run_once(), "ocr-empty")
        self.assertIn("local-ocr", "\n".join(captured.output))


class ObservationLoopTests(unittest.TestCase):
    def test_loop_can_pause_resume_and_stop_without_leaking_a_thread(self):
        calls = []

        class Worker:
            def run_once(self):
                calls.append(time.monotonic())

        loop = ObservationLoop(Worker(), interval_seconds=0.02)
        loop.start()
        deadline = time.monotonic() + 1
        while len(calls) < 2 and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertGreaterEqual(len(calls), 2)

        loop.set_paused(True)
        paused_count = len(calls)
        time.sleep(0.08)
        self.assertEqual(len(calls), paused_count)

        loop.set_paused(False)
        deadline = time.monotonic() + 1
        while len(calls) == paused_count and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertGreater(len(calls), paused_count)

        loop.close()
        stopped_count = len(calls)
        time.sleep(0.05)
        self.assertEqual(len(calls), stopped_count)

    def test_real_pipeline_delivers_from_the_observer_thread(self):
        focus = FocusSnapshot(
            window_id="9", pid=123, app_id="org.kde.kate", app_name="Kate", title="Roadmap",
            x=0, y=0, width=800, height=600, observed_at="2026-09-24T18:00:00.000Z",
        )
        delivered = []

        class NoOcr:
            def recognize(self, _png):
                return OcrResult("", 0.0)

        with tempfile.TemporaryDirectory() as temp:
            outbox = ObservationOutbox(Path(temp) / "outbox.sqlite3")
            pipeline = CapturePipeline(
                machine_id="linux-thread-test",
                policy=PrivacyPolicy(),
                ocr=NoOcr(),
                outbox=outbox,
                sender=lambda envelope: delivered.append(envelope) or True,
            )
            worker = ObservationWorker(
                focus_registry=FakeRegistry(focus),
                capture_session=FakeCapture(ready=False),
                pipeline=pipeline,
                privacy=PrivacyPolicy(),
            )
            loop = ObservationLoop(worker, interval_seconds=0.02)
            try:
                loop.start()
                deadline = time.monotonic() + 1
                while not delivered and time.monotonic() < deadline:
                    time.sleep(0.01)
                self.assertEqual(len(delivered), 1)
                self.assertIsNone(loop.last_error)
            finally:
                loop.close()
                outbox.close()


if __name__ == "__main__":
    unittest.main()
