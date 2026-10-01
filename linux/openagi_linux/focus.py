from __future__ import annotations

import hashlib
import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path

from .capture import FocusSnapshot


class FocusRegistry:
    def __init__(self, *, now=time.time, companion_app_id="sh.openagi.LinuxCompanion") -> None:
        self._now = now
        self.companion_app_id = companion_app_id.casefold()
        self._focus: FocusSnapshot | None = None
        self._received_at = 0.0

    def report_json(self, raw: str) -> bool:
        # Every compositor activation advances the focus generation. Until a
        # complete, admissible snapshot replaces it, capture must fail closed.
        self._focus = None
        self._received_at = 0.0
        if not isinstance(raw, str) or len(raw.encode("utf-8")) > 64 * 1024:
            return False
        try:
            value = json.loads(raw)
            geometry = value["frameGeometry"]
            internal_id = str(value["internalId"]).strip().strip("{}")
            pid = int(value["pid"])
            title = str(value["caption"]).strip()
            desktop_file = _desktop_id(value.get("desktopFileName"))
            resource_class = str(value.get("resourceClass") or "").strip()
            resource_name = str(value.get("resourceName") or "").strip()
            app_id = desktop_file or resource_class or resource_name
            app_name = resource_class or resource_name or app_id
            x = float(geometry["x"])
            y = float(geometry["y"])
            width = float(geometry["width"])
            height = float(geometry["height"])
        except (KeyError, TypeError, ValueError, json.JSONDecodeError):
            return False
        if (
            not internal_id
            or len(internal_id) > 200
            or pid <= 0
            or not title
            or len(title) > 1_024
            or not app_id
            or len(app_id) > 512
            or width < 32
            or height < 32
            or any(abs(number) > 1_000_000 for number in (x, y, width, height))
            or value.get("specialWindow") is True
            or value.get("minimized") is True
        ):
            return False
        if app_id.casefold() == self.companion_app_id:
            return False
        timestamp = datetime.fromtimestamp(self._now(), timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        self._focus = FocusSnapshot(
            window_id=str(_stable_positive_id(internal_id)),
            pid=pid,
            app_id=app_id,
            app_name=app_name,
            title=title,
            x=x,
            y=y,
            width=width,
            height=height,
            observed_at=timestamp,
        )
        self._received_at = self._now()
        return True

    def current(self, max_age_seconds: float = 5.0) -> FocusSnapshot | None:
        if self._focus is None or max_age_seconds <= 0:
            return None
        if self._now() - self._received_at > max_age_seconds:
            return None
        return self._focus


def _stable_positive_id(raw: str) -> int:
    value = int.from_bytes(hashlib.blake2s(raw.encode("utf-8"), digest_size=8).digest(), "big")
    # This identifier crosses JSON into JavaScript, so keep it within
    # Number.MAX_SAFE_INTEGER without exposing KWin's internal identifier.
    return (value & 0x001F_FFFF_FFFF_FFFF) or 1


def _desktop_id(value) -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""
    name = os.path.basename(raw)
    return name[:-8] if name.endswith(".desktop") else name
