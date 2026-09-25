from __future__ import annotations

import logging
import time
import threading


LOGGER = logging.getLogger(__name__)


class ObservationWorker:
    def __init__(
        self,
        *,
        focus_registry,
        capture_session,
        pipeline,
        privacy,
        clock=time.monotonic,
        ocr_interval_seconds: float = 15.0,
        flush_interval_seconds: float = 30.0,
    ) -> None:
        if ocr_interval_seconds < 1:
            raise ValueError("OCR interval must be at least one second")
        if flush_interval_seconds < 1:
            raise ValueError("flush interval must be at least one second")
        self.focus_registry = focus_registry
        self.capture_session = capture_session
        self.pipeline = pipeline
        self.privacy = privacy
        self.clock = clock
        self.ocr_interval_seconds = ocr_interval_seconds
        self.flush_interval_seconds = flush_interval_seconds
        self._last_focus_key = None
        self._last_ocr_at = float("-inf")
        self._last_flush_at = float("-inf")

    def run_once(self) -> str:
        now = self.clock()
        if now - self._last_flush_at >= self.flush_interval_seconds:
            self._last_flush_at = now
            self.pipeline.flush()
        focus = self.focus_registry.current(max_age_seconds=10)
        if focus is None:
            self._last_focus_key = None
            return "focus-unavailable"
        reason = self.privacy.reason(focus)
        if reason:
            self._last_focus_key = None
            return reason
        key = (focus.window_id, focus.app_id, focus.title)
        activity_sent = False
        if key != self._last_focus_key:
            self.pipeline.process_activity(focus)
            self._last_focus_key = key
            activity_sent = True
        if self.capture_session.ready and now - self._last_ocr_at >= self.ocr_interval_seconds:
            try:
                frame = self.capture_session.capture_focus(focus)
            except (RuntimeError, TimeoutError, ValueError) as error:
                LOGGER.warning(
                    "screen observation failed stage=portal-frame error=%s",
                    type(error).__name__,
                )
                return "capture-error"
            latest = self.focus_registry.current(max_age_seconds=10)
            if latest is None:
                return "focus-unavailable"
            reason = self.privacy.reason(latest)
            if reason:
                return reason
            if latest != focus:
                return "focus-changed"
            try:
                result = self.pipeline.process_frame(focus, frame)
            except (RuntimeError, TimeoutError, ValueError) as error:
                LOGGER.warning(
                    "screen observation failed stage=local-ocr-pipeline error=%s",
                    type(error).__name__,
                )
                return "capture-error"
            self._last_ocr_at = now
            if result.status == "skipped" and result.reason == "ocr-empty":
                LOGGER.warning("screen observation produced no text stage=local-ocr")
                return "ocr-empty"
            return "frame"
        return "activity" if activity_sent else "idle"


class ObservationLoop:
    def __init__(self, worker, interval_seconds: float = 2.0) -> None:
        if interval_seconds <= 0:
            raise ValueError("observation interval must be positive")
        self.worker = worker
        self.interval_seconds = interval_seconds
        self._stop = threading.Event()
        self._paused = threading.Event()
        self._wake = threading.Event()
        self._run_lock = threading.Lock()
        self._thread: threading.Thread | None = None
        self.last_error: str | None = None

    def start(self) -> None:
        if self._thread is not None:
            raise RuntimeError("observation loop is already started")
        self._thread = threading.Thread(target=self._run, name="openagi-observer", daemon=True)
        self._thread.start()

    def set_paused(self, paused: bool) -> None:
        if paused:
            self._paused.set()
        else:
            self._paused.clear()
        with self._run_lock:
            pass
        self._wake.set()

    @property
    def paused(self) -> bool:
        return self._paused.is_set()

    def close(self) -> None:
        self._stop.set()
        self._wake.set()
        thread = self._thread
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout=max(5, self.interval_seconds + 1))
        self._thread = None

    def _run(self) -> None:
        while not self._stop.is_set():
            if not self._paused.is_set():
                with self._run_lock:
                    if not self._paused.is_set() and not self._stop.is_set():
                        try:
                            self.worker.run_once()
                            self.last_error = None
                        except BaseException as error:
                            # Avoid exception text: it may contain local
                            # window metadata or another sensitive value.
                            self.last_error = type(error).__name__
            self._wake.wait(self.interval_seconds)
            self._wake.clear()
