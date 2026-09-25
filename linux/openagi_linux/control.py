from __future__ import annotations

import base64
import math
import re

from .rpc import RequestCancelled, RequestExpired

BASELINE_OPERATIONS = ["click", "drag", "move", "type", "key", "scroll"]


class ControlDispatcher:
    def __init__(self, *, focus_registry, control_session, privacy) -> None:
        self.focus_registry = focus_registry
        self.control_session = control_session
        self.privacy = privacy

    def handle(self, request: dict, *, context=None) -> dict:
        action = request.get("action")
        payload = request.get("payload")
        if not isinstance(action, str) or not isinstance(payload, dict):
            return _error("invalid_request", "computer request is invalid")
        try:
            if action == "status":
                return _ok(self._status())
            if action == "screenshot":
                return _ok(self._screenshot(context))
            if action not in BASELINE_OPERATIONS:
                return _error("unsupported_operation", "computer operation is not supported on this Linux companion")
            return _ok(self._input(action, payload, context))
        except (RequestCancelled, RequestExpired):
            raise
        except FocusChanged:
            return _error("focus_changed", "focused window changed; take a fresh screenshot")
        except PermissionError:
            return _error("privacy_excluded", "focused window is excluded by the privacy policy")
        except (ValueError, TypeError):
            return _error("invalid_request", "computer action payload is invalid")
        except (RuntimeError, TimeoutError):
            return _error("operation_failed", "computer operation failed")

    def _status(self) -> dict:
        ready = bool(self.control_session.ready)
        focus = self.focus_registry.current(max_age_seconds=10) if ready else None
        capture_ready = ready and focus is not None and self.privacy.reason(focus) is None
        return {
            "screenshotReady": capture_ready,
            "capturePrerequisitesReady": True,
            "inputReady": ready,
            "operations": list(BASELINE_OPERATIONS) if ready else [],
            "detail": "ready" if capture_ready else "enable Wayland computer control from the OpenAGI tray",
        }

    def _screenshot(self, context=None) -> dict:
        if not self.control_session.ready:
            raise RuntimeError("control session is not ready")
        if context is not None:
            context.check_active()
        focus = self._focus()
        frame = self.control_session.capture_focus(focus)
        if context is not None:
            context.check_active()
        if self._focus() != focus:
            raise FocusChanged()
        scale_x = focus.width / frame.width
        scale_y = focus.height / frame.height
        if not math.isfinite(scale_x) or not math.isfinite(scale_y) or scale_x <= 0 or abs(scale_x - scale_y) > 0.05:
            raise RuntimeError("capture mapping is invalid")
        return {
            "format": "png",
            "base64": base64.b64encode(frame.png).decode("ascii"),
            "width": frame.width,
            "height": frame.height,
            "bytes": len(frame.png),
            "scale": scale_x,
            "offsetX": focus.x,
            "offsetY": focus.y,
            "accessibility": "",
            "elements": [],
            "focus": _private_focus(focus),
        }

    def _input(self, action: str, payload: dict, context=None) -> dict:
        if not self.control_session.ready:
            raise RuntimeError("control session is not ready")
        focus = self._focus()
        _require_same_focus(payload.get("focus"), focus)

        def guard() -> None:
            if context is not None:
                context.check_active()
            if self._focus() != focus:
                raise FocusChanged()

        guard()
        if action == "click":
            button = str(payload.get("button", ""))
            count = _integer(payload.get("count", 1), minimum=1, maximum=3)
            if button not in {"left", "right", "middle"}:
                raise ValueError("button")
            self.control_session.click(
                _number(payload.get("x")), _number(payload.get("y")), button, count,
                cancel_check=guard,
            )
        elif action == "drag":
            button = str(payload.get("button", ""))
            duration = _integer(payload.get("durationMs", 350), minimum=0, maximum=2_000)
            if button not in {"left", "right", "middle"}:
                raise ValueError("button")
            self.control_session.drag(
                _number(payload.get("fromX")), _number(payload.get("fromY")),
                _number(payload.get("toX")), _number(payload.get("toY")),
                button, duration, cancel_check=guard,
            )
        elif action == "move":
            self.control_session.move(
                _number(payload.get("x")), _number(payload.get("y")), cancel_check=guard,
            )
        elif action == "type":
            text = payload.get("text")
            if not isinstance(text, str) or len(text.encode("utf-8")) > 16 * 1024 or "\0" in text:
                raise ValueError("text")
            self.control_session.type_text(text, cancel_check=guard)
        elif action == "key":
            chord = str(payload.get("chord", "")).casefold().strip()
            if not chord or len(chord) > 80 or not re.fullmatch(r"[a-z0-9`=\-\[\]\\;',./+ ]+", chord):
                raise ValueError("chord")
            self.control_session.key(chord, cancel_check=guard)
        elif action == "scroll":
            self.control_session.scroll(
                _number(payload.get("x")), _number(payload.get("y")),
                _integer(payload.get("deltaX", 0), minimum=-1_000, maximum=1_000),
                _integer(payload.get("deltaY", 0), minimum=-1_000, maximum=1_000),
                cancel_check=guard,
            )
        guard()
        return {"ok": True}

    def _focus(self):
        focus = self.focus_registry.current(max_age_seconds=5)
        if focus is None:
            raise FocusChanged()
        if self.privacy.reason(focus):
            raise PermissionError("excluded")
        return focus


class FocusChanged(Exception):
    pass


def _private_focus(focus) -> dict:
    return {
        "windowID": int(focus.window_id),
        "processIdentifier": int(focus.pid),
        "bundleIdentifier": focus.app_id,
        "title": focus.title,
        "x": focus.x,
        "y": focus.y,
        "width": focus.width,
        "height": focus.height,
    }


def _require_same_focus(raw, focus) -> None:
    if not isinstance(raw, dict):
        raise FocusChanged()
    expected = _private_focus(focus)
    for key in ("windowID", "processIdentifier", "bundleIdentifier", "title"):
        if raw.get(key) != expected[key]:
            raise FocusChanged()
    for key in ("x", "y", "width", "height"):
        try:
            if abs(float(raw.get(key)) - float(expected[key])) > 0.5:
                raise FocusChanged()
        except (TypeError, ValueError):
            raise FocusChanged() from None


def _number(value) -> float:
    number = float(value)
    if not math.isfinite(number) or abs(number) > 1_000_000:
        raise ValueError("number")
    return number


def _integer(value, *, minimum: int, maximum: int) -> int:
    if isinstance(value, bool):
        raise ValueError("integer")
    number = int(value)
    if number != float(value) or number < minimum or number > maximum:
        raise ValueError("integer")
    return number


def _ok(result: dict) -> dict:
    return {"ok": True, "result": result}


def _error(code: str, message: str) -> dict:
    return {"ok": False, "error": {"code": code, "message": message}}
