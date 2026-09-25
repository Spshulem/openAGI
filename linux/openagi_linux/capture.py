from __future__ import annotations

import re
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Callable

from .ocr import OcrResult
from .outbox import ObservationOutbox


@dataclass(frozen=True)
class FocusSnapshot:
    window_id: str
    pid: int
    app_id: str
    app_name: str
    title: str
    x: float
    y: float
    width: float
    height: float
    observed_at: str


@dataclass(frozen=True)
class Frame:
    png: bytes
    width: int
    height: int


@dataclass(frozen=True)
class PipelineResult:
    status: str
    reason: str | None = None


class PrivacyPolicy:
    DEFAULT_EXCLUDED_APPS = (
        "1password",
        "bitwarden",
        "keepass",
        "kwallet",
        "password",
        "seahorse",
        "signal",
        "telegram",
        "whatsapp",
    )
    DEFAULT_TITLE_PATTERNS = (
        r"\b(private|incognito)\b",
        r"\bpasswords?\b|\bpasskeys?\b",
        r"\b(2fa|otp|authenticator)\b",
        r"\b(recovery|seed) phrase\b",
        r"\bapi[ _-]?keys?\b",
        r"\b(card number|accounts?|bank(?:ing)?|wallets?|payments?)\b",
    )

    def __init__(self, excluded_apps=None, title_patterns=None) -> None:
        apps = self.DEFAULT_EXCLUDED_APPS if excluded_apps is None else excluded_apps
        patterns = self.DEFAULT_TITLE_PATTERNS if title_patterns is None else title_patterns
        self.excluded_apps = tuple(str(value).casefold() for value in apps)
        self.title_patterns = tuple(re.compile(str(value), re.IGNORECASE) for value in patterns)

    def reason(self, focus: FocusSnapshot) -> str | None:
        if (
            not focus.window_id
            or focus.pid <= 0
            or not focus.app_id.strip()
            or not focus.title.strip()
            or focus.width < 32
            or focus.height < 32
        ):
            return "focus-unverified"
        app = f"{focus.app_id}\n{focus.app_name}".casefold()
        title = focus.title.casefold()
        if any(marker in app or marker in title for marker in self.excluded_apps):
            return "privacy-excluded"
        if any(pattern.search(focus.title) for pattern in self.title_patterns):
            return "privacy-excluded"
        return None


class CapturePipeline:
    def __init__(
        self,
        *,
        machine_id: str,
        policy: PrivacyPolicy,
        ocr,
        outbox: ObservationOutbox,
        sender: Callable[[dict], bool],
        now: Callable[[], datetime] = lambda: datetime.now(timezone.utc),
    ) -> None:
        if not machine_id or len(machine_id) > 200:
            raise ValueError("machine_id is invalid")
        self.machine_id = machine_id
        self.policy = policy
        self.ocr = ocr
        self.outbox = outbox
        self.sender = sender
        self.now = now

    def process(self, focus: FocusSnapshot, frame: Frame) -> PipelineResult:
        reason = self.policy.reason(focus)
        if reason:
            return PipelineResult("skipped", reason)
        result: OcrResult = self.ocr.recognize(frame.png)
        captured_at = self.now().isoformat(timespec="milliseconds").replace("+00:00", "Z")
        observations = [self._activity_observation(focus)]
        if result.text:
            observations.append(self._frame_observation(focus, result, captured_at))
        return self._enqueue(observations)

    def process_activity(self, focus: FocusSnapshot) -> PipelineResult:
        reason = self.policy.reason(focus)
        if reason:
            return PipelineResult("skipped", reason)
        return self._enqueue([self._activity_observation(focus)])

    def process_frame(self, focus: FocusSnapshot, frame: Frame) -> PipelineResult:
        reason = self.policy.reason(focus)
        if reason:
            return PipelineResult("skipped", reason)
        result: OcrResult = self.ocr.recognize(frame.png)
        if not result.text:
            return PipelineResult("skipped", "ocr-empty")
        captured_at = self.now().isoformat(timespec="milliseconds").replace("+00:00", "Z")
        return self._enqueue([self._frame_observation(focus, result, captured_at)])

    def _enqueue(self, observations: list[dict]) -> PipelineResult:
        self.outbox.enqueue({"sourceMachineId": self.machine_id, "observations": observations})
        self.flush()
        return PipelineResult("sent" if self.outbox.pending_count() == 0 else "queued")

    @staticmethod
    def _activity_observation(focus: FocusSnapshot) -> dict:
        return {
            "kind": "activity",
            "at": focus.observed_at,
            "app": focus.app_name or focus.app_id,
            "window": focus.title,
            "event": "focus",
        }

    @staticmethod
    def _frame_observation(focus: FocusSnapshot, result: OcrResult, captured_at: str) -> dict:
        return {
            "kind": "frame",
            "frameId": f"linux_{uuid.uuid4().hex}",
            "at": captured_at,
            "app": focus.app_name or focus.app_id,
            "window": focus.title,
            "confidence": result.confidence,
            "ocrText": result.text,
        }

    def flush(self) -> int:
        return self.outbox.flush(self.sender)
