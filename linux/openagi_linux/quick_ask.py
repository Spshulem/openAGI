from __future__ import annotations


class QuickAskContextProvider:
    def __init__(self, focus_registry, capture_session, ocr, privacy) -> None:
        self.focus_registry = focus_registry
        self.capture_session = capture_session
        self.ocr = ocr
        self.privacy = privacy

    def freeze(self) -> dict | None:
        focus = self.focus_registry.current(max_age_seconds=5)
        if focus is None or self.privacy.reason(focus) or not self.capture_session.ready:
            return None
        try:
            frame = self.capture_session.capture_focus(focus)
            latest = self.focus_registry.current(max_age_seconds=5)
            if latest != focus or latest is None or self.privacy.reason(latest):
                return None
            result = self.ocr.recognize(frame.png)
        except (RuntimeError, TimeoutError, ValueError):
            return None
        if not result.text:
            return None
        return {
            "app": focus.app_name or focus.app_id,
            "window": focus.title,
            "text": result.text,
        }
