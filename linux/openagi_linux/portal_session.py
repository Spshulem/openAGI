from __future__ import annotations

import os
import tempfile
import time
from collections.abc import Callable
from pathlib import Path

from .capture import FocusSnapshot, Frame
from .portal import PortalStartResult, _strict_int, crop_logical_window, parse_start_result


class RestoreTokenStore:
    def __init__(self, path: Path) -> None:
        self.path = Path(path)

    def load(self) -> str | None:
        try:
            token = self.path.read_text(encoding="utf-8").strip()
        except FileNotFoundError:
            return None
        if not token or len(token) > 16_384:
            return None
        return token

    def save(self, token: str) -> None:
        if not token or len(token) > 16_384:
            raise ValueError("restore token is invalid")
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        fd, temp_name = tempfile.mkstemp(prefix=self.path.name + ".", dir=self.path.parent)
        try:
            os.fchmod(fd, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                handle.write(token)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temp_name, self.path)
            os.chmod(self.path, 0o600)
        except Exception:
            try:
                os.close(fd)
            except OSError:
                pass
            try:
                os.unlink(temp_name)
            except FileNotFoundError:
                pass
            raise


class ScreenCastSession:
    def __init__(self, *, portal, token_store: RestoreTokenStore, frame_source_factory, on_revoked=None) -> None:
        self.portal = portal
        self.token_store = token_store
        self.frame_source_factory = frame_source_factory
        self.session_handle: str | None = None
        self.start_result: PortalStartResult | None = None
        self.frames = None
        self.on_revoked = on_revoked or (lambda: None)

    @property
    def ready(self) -> bool:
        return self.session_handle is not None and self.start_result is not None and self.frames is not None

    def start(self, parent_window: str = "") -> PortalStartResult:
        if self.ready:
            return self.start_result
        session = self.portal.create_screen_cast_session()
        self.session_handle = session
        self.portal.watch_session_closed(session, lambda: self._portal_closed(session))
        frames = None
        try:
            options = {
                "types": 1,
                "multiple": False,
                "cursor_mode": 1,
                "persist_mode": 2,
            }
            restore_token = self.token_store.load()
            if restore_token:
                options["restore_token"] = restore_token
            self.portal.select_sources(session, options)
            result = parse_start_result(self.portal.start_screen_cast(session, parent_window))
            fd = self.portal.open_pipewire_remote(session)
            frames = self.frame_source_factory(fd, result.stream.pipewire_serial or result.stream.node_id)
            if result.restore_token:
                self.token_store.save(result.restore_token)
        except Exception:
            self.portal.unwatch_session_closed(session)
            if frames is not None:
                frames.close()
            self.session_handle = None
            try:
                self.portal.close_session(session)
            except Exception:
                pass
            raise
        if self.session_handle != session:
            frames.close()
            raise RuntimeError("screen capture portal session was revoked")
        self.start_result = result
        self.frames = frames
        return result

    def capture_focus(self, focus: FocusSnapshot) -> Frame:
        if not self.ready:
            raise RuntimeError("screen capture is not enabled; grant it from the companion settings")
        png = self.frames.capture_png(timeout_seconds=3)
        return crop_logical_window(png, self.start_result.stream, focus)

    def close(self) -> None:
        frames, session = self.frames, self.session_handle
        self.frames = None
        self.session_handle = None
        self.start_result = None
        if frames is not None:
            try:
                frames.close()
            except Exception:
                pass
        if session is not None:
            try:
                self.portal.unwatch_session_closed(session)
                self.portal.close_session(session)
            except Exception:
                pass

    def _portal_closed(self, session: str) -> None:
        if self.session_handle != session:
            return
        frames = self.frames
        self.frames = None
        self.session_handle = None
        self.start_result = None
        if frames is not None:
            try:
                frames.close()
            except Exception:
                pass
        self.on_revoked()


class ControlPortalSession:
    def __init__(
        self, *, portal, token_store: RestoreTokenStore, frame_source_factory,
        sleep=time.sleep, on_revoked=None,
    ) -> None:
        self.portal = portal
        self.token_store = token_store
        self.frame_source_factory = frame_source_factory
        self.sleep = sleep
        self.session_handle: str | None = None
        self.start_result: PortalStartResult | None = None
        self.frames = None
        self.on_revoked = on_revoked or (lambda: None)

    @property
    def ready(self) -> bool:
        return self.session_handle is not None and self.start_result is not None and self.frames is not None

    def start(self, parent_window: str = "") -> PortalStartResult:
        if self.ready:
            assert self.start_result is not None
            return self.start_result
        session = self.portal.create_remote_desktop_session()
        self.session_handle = session
        self.portal.watch_session_closed(session, lambda: self._portal_closed(session))
        frames = None
        try:
            common = {"persist_mode": 2}
            restore_token = self.token_store.load()
            if restore_token:
                common["restore_token"] = restore_token
            self.portal.select_devices(session, {**common, "types": 3})
            self.portal.select_sources(
                session,
                {"types": 1, "multiple": False, "cursor_mode": 1},
            )
            raw = self.portal.start_remote_desktop(session, parent_window)
            devices = _strict_int(raw.get("devices", 0), "device grant")
            if devices & 3 != 3:
                raise PermissionError("portal did not grant pointer and keyboard control")
            result = parse_start_result(raw)
            fd = self.portal.open_pipewire_remote(session)
            frames = self.frame_source_factory(fd, result.stream.pipewire_serial or result.stream.node_id)
            if result.restore_token:
                self.token_store.save(result.restore_token)
        except Exception:
            self.portal.unwatch_session_closed(session)
            if frames is not None:
                frames.close()
            self.session_handle = None
            try:
                self.portal.close_session(session)
            except Exception:
                pass
            raise
        if self.session_handle != session:
            frames.close()
            raise RuntimeError("computer control portal session was revoked")
        self.start_result = result
        self.frames = frames
        return result

    def capture_focus(self, focus: FocusSnapshot) -> Frame:
        if not self.ready:
            raise RuntimeError("Wayland computer control is not enabled")
        assert self.frames is not None and self.start_result is not None
        return crop_logical_window(
            self.frames.capture_png(timeout_seconds=3),
            self.start_result.stream,
            focus,
        )

    def move(self, x: float, y: float, *, cancel_check: Callable[[], None] | None = None) -> None:
        _check_active(cancel_check)
        session, stream = self._active()
        local_x, local_y = _stream_point(stream, x, y)
        self.portal.notify_pointer_motion_absolute(session, stream.node_id, local_x, local_y)

    def click(
        self, x: float, y: float, button: str, count: int,
        *, cancel_check: Callable[[], None] | None = None,
    ) -> None:
        session, _stream = self._active()
        self.move(x, y, cancel_check=cancel_check)
        code = {"left": 272, "right": 273, "middle": 274}[button]
        for index in range(count):
            _check_active(cancel_check)
            self.portal.notify_pointer_button(session, code, 1)
            try:
                _check_active(cancel_check)
            finally:
                self.portal.notify_pointer_button(session, code, 0)
            if index + 1 < count:
                self.sleep(0.08)

    def drag(
        self,
        from_x: float,
        from_y: float,
        to_x: float,
        to_y: float,
        button: str,
        duration_ms: int,
        *,
        cancel_check: Callable[[], None] | None = None,
    ) -> None:
        session, _stream = self._active()
        self.move(from_x, from_y, cancel_check=cancel_check)
        _check_active(cancel_check)
        code = {"left": 272, "right": 273, "middle": 274}[button]
        self.portal.notify_pointer_button(session, code, 1)
        try:
            steps = max(1, min(120, round(duration_ms / 16)))
            for step in range(1, steps + 1):
                _check_active(cancel_check)
                ratio = step / steps
                self.move(
                    from_x + ((to_x - from_x) * ratio),
                    from_y + ((to_y - from_y) * ratio),
                    cancel_check=cancel_check,
                )
                if duration_ms:
                    self.sleep(duration_ms / steps / 1000)
        finally:
            self.portal.notify_pointer_button(session, code, 0)

    def scroll(
        self, x: float, y: float, delta_x: int, delta_y: int,
        *, cancel_check: Callable[[], None] | None = None,
    ) -> None:
        session, _stream = self._active()
        self.move(x, y, cancel_check=cancel_check)
        horizontal = _scroll_steps(delta_x)
        vertical = _scroll_steps(delta_y)
        if vertical:
            _check_active(cancel_check)
            self.portal.notify_pointer_axis_discrete(session, 0, vertical)
        if horizontal:
            _check_active(cancel_check)
            self.portal.notify_pointer_axis_discrete(session, 1, horizontal)

    def type_text(self, text: str, *, cancel_check: Callable[[], None] | None = None) -> None:
        session, _stream = self._active()
        for character in text:
            _check_active(cancel_check)
            keysym = _text_keysym(character)
            self.portal.notify_keyboard_keysym(session, keysym, 1)
            try:
                _check_active(cancel_check)
            finally:
                self.portal.notify_keyboard_keysym(session, keysym, 0)

    def key(self, chord: str, *, cancel_check: Callable[[], None] | None = None) -> None:
        session, _stream = self._active()
        parts = [part.strip() for part in chord.casefold().split("+") if part.strip()]
        modifier_map = {
            "ctrl": 0xFFE3, "control": 0xFFE3,
            "alt": 0xFFE9, "opt": 0xFFE9, "option": 0xFFE9,
            "shift": 0xFFE1,
            "cmd": 0xFFE7, "command": 0xFFE7, "meta": 0xFFE7,
        }
        modifiers = [modifier_map[part] for part in parts if part in modifier_map]
        keys = [part for part in parts if part not in modifier_map]
        if len(keys) != 1:
            raise ValueError("key chord is invalid")
        target = _named_keysym(keys[0])
        pressed_modifiers = []
        try:
            for keysym in modifiers:
                _check_active(cancel_check)
                self.portal.notify_keyboard_keysym(session, keysym, 1)
                pressed_modifiers.append(keysym)
            _check_active(cancel_check)
            self.portal.notify_keyboard_keysym(session, target, 1)
            try:
                _check_active(cancel_check)
            finally:
                self.portal.notify_keyboard_keysym(session, target, 0)
        finally:
            for keysym in reversed(pressed_modifiers):
                self.portal.notify_keyboard_keysym(session, keysym, 0)

    def close(self) -> None:
        frames, session = self.frames, self.session_handle
        self.frames = None
        self.session_handle = None
        self.start_result = None
        if frames is not None:
            try:
                frames.close()
            except Exception:
                pass
        if session is not None:
            try:
                self.portal.unwatch_session_closed(session)
                self.portal.close_session(session)
            except Exception:
                pass

    def _portal_closed(self, session: str) -> None:
        if self.session_handle != session:
            return
        frames = self.frames
        self.frames = None
        self.session_handle = None
        self.start_result = None
        if frames is not None:
            try:
                frames.close()
            except Exception:
                pass
        self.on_revoked()

    def _active(self):
        if not self.ready:
            raise RuntimeError("Wayland computer control is not enabled")
        assert self.session_handle is not None and self.start_result is not None
        return self.session_handle, self.start_result.stream


def _stream_point(stream, x: float, y: float) -> tuple[float, float]:
    local_x = float(x) - stream.position[0]
    local_y = float(y) - stream.position[1]
    if local_x < 0 or local_y < 0 or local_x >= stream.logical_size[0] or local_y >= stream.logical_size[1]:
        raise ValueError("pointer is outside the granted portal stream")
    return local_x, local_y


def _check_active(cancel_check: Callable[[], None] | None) -> None:
    if cancel_check is not None:
        cancel_check()


def _scroll_steps(value: int) -> int:
    if value == 0:
        return 0
    steps = round(value / 120)
    return steps if steps else (1 if value > 0 else -1)


def _text_keysym(character: str) -> int:
    codepoint = ord(character)
    return codepoint if 0x20 <= codepoint <= 0x7E else 0x01000000 | codepoint


def _named_keysym(value: str) -> int:
    names = {
        "enter": 0xFF0D, "return": 0xFF0D, "esc": 0xFF1B, "escape": 0xFF1B,
        "tab": 0xFF09, "space": 0x20, "delete": 0xFFFF, "backspace": 0xFF08,
        "left": 0xFF51, "up": 0xFF52, "right": 0xFF53, "down": 0xFF54,
        "pageup": 0xFF55, "pagedown": 0xFF56, "home": 0xFF50, "end": 0xFF57,
    }
    if value in names:
        return names[value]
    if len(value) == 1 and 0x20 <= ord(value) <= 0x7E:
        return ord(value)
    raise ValueError("key chord is unsupported")
