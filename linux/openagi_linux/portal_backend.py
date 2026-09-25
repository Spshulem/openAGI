from __future__ import annotations

import asyncio
import concurrent.futures
import os
import secrets
import threading
from typing import Any

from dbus_next.aio.message_bus import MessageBus
from dbus_next.constants import BusType, MessageType
from dbus_next.message import Message
from dbus_next.signature import Variant

PORTAL_SERVICE = "org.freedesktop.portal.Desktop"
PORTAL_PATH = "/org/freedesktop/portal/desktop"
SCREENCAST_INTERFACE = "org.freedesktop.portal.ScreenCast"
REMOTE_DESKTOP_INTERFACE = "org.freedesktop.portal.RemoteDesktop"
REQUEST_INTERFACE = "org.freedesktop.portal.Request"
SESSION_INTERFACE = "org.freedesktop.portal.Session"
PROPERTIES_INTERFACE = "org.freedesktop.DBus.Properties"


class DbusPortal:
    """Thread-confined xdg-desktop-portal ScreenCast adapter.

    The public methods are synchronous so capture ownership can live in one
    companion worker. No permission dialogue is opened until start_screen_cast.
    """

    def __init__(self, timeout_seconds: float = 120.0) -> None:
        self.timeout_seconds = timeout_seconds
        self._session_callbacks: dict[str, Any] = {}
        self._session_callbacks_lock = threading.Lock()
        self._loop = asyncio.new_event_loop()
        self._ready: concurrent.futures.Future = concurrent.futures.Future()
        self._closed = False
        self._thread = threading.Thread(target=self._thread_main, name="openagi-portal", daemon=True)
        self._thread.start()
        self._ready.result(timeout=10)

    def available_source_types(self) -> int:
        return int(self._run(self._property(SCREENCAST_INTERFACE, "AvailableSourceTypes"), timeout=10))

    def available_cursor_modes(self) -> int:
        return int(self._run(self._property(SCREENCAST_INTERFACE, "AvailableCursorModes"), timeout=10))

    def available_device_types(self) -> int:
        return int(self._run(self._property(REMOTE_DESKTOP_INTERFACE, "AvailableDeviceTypes"), timeout=10))

    def create_screen_cast_session(self) -> str:
        return str(self._run(self._create_session(SCREENCAST_INTERFACE)))

    def create_remote_desktop_session(self) -> str:
        return str(self._run(self._create_session(REMOTE_DESKTOP_INTERFACE)))

    def select_sources(self, session: str, options: dict) -> None:
        self._run(self._select_sources(session, options))

    def start_screen_cast(self, session: str, parent_window: str) -> dict:
        return self._run(self._start(session, parent_window))

    def select_devices(self, session: str, options: dict) -> None:
        self._run(self._select_devices(session, options))

    def start_remote_desktop(self, session: str, parent_window: str) -> dict:
        return self._run(self._start_remote_desktop(session, parent_window))

    def notify_pointer_motion_absolute(self, session: str, node_id: int, x: float, y: float) -> None:
        self._run(self._notify("NotifyPointerMotionAbsolute", "oa{sv}udd", [session, {}, node_id, x, y]), timeout=10)

    def notify_pointer_button(self, session: str, button: int, state: int) -> None:
        self._run(self._notify("NotifyPointerButton", "oa{sv}iu", [session, {}, button, state]), timeout=10)

    def notify_pointer_axis_discrete(self, session: str, axis: int, steps: int) -> None:
        self._run(self._notify("NotifyPointerAxisDiscrete", "oa{sv}ui", [session, {}, axis, steps]), timeout=10)

    def notify_keyboard_keysym(self, session: str, keysym: int, state: int) -> None:
        self._run(self._notify("NotifyKeyboardKeysym", "oa{sv}iu", [session, {}, keysym, state]), timeout=10)

    def open_pipewire_remote(self, session: str) -> int:
        return int(self._run(self._open_pipewire(session)))

    def close_session(self, session: str) -> None:
        self._run(self._close_session(session), timeout=10)

    def watch_session_closed(self, session: str, callback) -> None:
        if not isinstance(session, str) or not session.startswith("/org/freedesktop/portal/desktop/session/"):
            raise ValueError("portal session handle is invalid")
        if not callable(callback):
            raise TypeError("portal close callback must be callable")
        with self._session_callbacks_lock:
            self._session_callbacks[session] = callback

    def unwatch_session_closed(self, session: str) -> None:
        with self._session_callbacks_lock:
            self._session_callbacks.pop(session, None)

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        try:
            self._run(self._disconnect(), timeout=10, allow_closed=True)
        finally:
            self._loop.call_soon_threadsafe(self._loop.stop)
            self._thread.join(timeout=10)

    def _thread_main(self) -> None:
        asyncio.set_event_loop(self._loop)
        try:
            self._loop.run_until_complete(self._connect())
        except BaseException as error:
            if hasattr(self, "_bus"):
                try:
                    self._loop.run_until_complete(self._disconnect())
                except BaseException:
                    pass
            self._loop.close()
            self._ready.set_exception(error)
            return
        self._ready.set_result(True)
        self._loop.run_forever()
        pending = asyncio.all_tasks(self._loop)
        for task in pending:
            task.cancel()
        if pending:
            self._loop.run_until_complete(asyncio.gather(*pending, return_exceptions=True))
        self._loop.close()

    async def _connect(self) -> None:
        self._bus = await MessageBus(bus_type=BusType.SESSION, negotiate_unix_fd=True).connect()
        owner_reply = await self._bus.call(Message(
            destination="org.freedesktop.DBus",
            path="/org/freedesktop/DBus",
            interface="org.freedesktop.DBus",
            member="GetNameOwner",
            signature="s",
            body=[PORTAL_SERVICE],
        ))
        if owner_reply is None or owner_reply.message_type is MessageType.ERROR or not owner_reply.body:
            raise RuntimeError("desktop portal D-Bus owner is unavailable")
        self._portal_owner = str(owner_reply.body[0])
        match_reply = await self._bus.call(Message(
            destination="org.freedesktop.DBus",
            path="/org/freedesktop/DBus",
            interface="org.freedesktop.DBus",
            member="AddMatch",
            signature="s",
            body=[f"type='signal',interface='{SESSION_INTERFACE}',member='Closed'"],
        ))
        if match_reply is None or match_reply.message_type is MessageType.ERROR:
            raise RuntimeError("desktop portal session signal subscription failed")
        self._bus.add_message_handler(self._on_message)
        self._waiters: dict[str, asyncio.Future] = {}
        self._early_responses: dict[str, tuple[int, dict]] = {}

    def _on_message(self, message):
        if (
            message.message_type is MessageType.SIGNAL
            and message.interface == REQUEST_INTERFACE
            and message.member == "Response"
            and message.sender == self._portal_owner
            and message.path
            and len(message.body) == 2
        ):
            value = (int(message.body[0]), _unbox(message.body[1]))
            waiter = self._waiters.pop(message.path, None)
            if waiter is None:
                self._early_responses[message.path] = value
            elif not waiter.done():
                waiter.set_result(value)
        elif (
            message.message_type is MessageType.SIGNAL
            and message.interface == SESSION_INTERFACE
            and message.member == "Closed"
            and message.sender == self._portal_owner
            and message.path
        ):
            with self._session_callbacks_lock:
                callback = self._session_callbacks.pop(message.path, None)
            if callback is not None:
                try:
                    callback()
                except BaseException:
                    pass
        return False

    async def _property(self, portal_interface: str, name: str) -> int:
        reply = await self._call(
            path=PORTAL_PATH,
            interface=PROPERTIES_INTERFACE,
            member="Get",
            signature="ss",
            body=[portal_interface, name],
        )
        variant = reply.body[0]
        return int(variant.value)

    async def _create_session(self, portal_interface: str) -> str:
        request_token = _token("create")
        session_token = _token("session")
        response = await self._request(
            self._call(
                path=PORTAL_PATH,
                interface=portal_interface,
                member="CreateSession",
                signature="a{sv}",
                body=[{
                    "handle_token": Variant("s", request_token),
                    "session_handle_token": Variant("s", session_token),
                }],
            )
        )
        handle = response.get("session_handle")
        if not isinstance(handle, str) or not handle.startswith("/org/freedesktop/portal/desktop/session/"):
            raise RuntimeError("portal did not create a valid desktop session")
        return handle

    async def _select_sources(self, session: str, options: dict) -> None:
        variants = {
            "handle_token": Variant("s", _token("sources")),
            "types": Variant("u", int(options["types"])),
            "multiple": Variant("b", bool(options["multiple"])),
            "cursor_mode": Variant("u", int(options["cursor_mode"])),
        }
        if "persist_mode" in options:
            variants["persist_mode"] = Variant("u", int(options["persist_mode"]))
        if options.get("restore_token"):
            variants["restore_token"] = Variant("s", str(options["restore_token"]))
        await self._request(
            self._call(
                path=PORTAL_PATH,
                interface=SCREENCAST_INTERFACE,
                member="SelectSources",
                signature="oa{sv}",
                body=[session, variants],
            )
        )

    async def _select_devices(self, session: str, options: dict) -> None:
        variants = {
            "handle_token": Variant("s", _token("devices")),
            "types": Variant("u", int(options["types"])),
            "persist_mode": Variant("u", int(options["persist_mode"])),
        }
        if options.get("restore_token"):
            variants["restore_token"] = Variant("s", str(options["restore_token"]))
        await self._request(
            self._call(
                path=PORTAL_PATH,
                interface=REMOTE_DESKTOP_INTERFACE,
                member="SelectDevices",
                signature="oa{sv}",
                body=[session, variants],
            )
        )

    async def _start(self, session: str, parent_window: str) -> dict:
        return await self._request(
            self._call(
                path=PORTAL_PATH,
                interface=SCREENCAST_INTERFACE,
                member="Start",
                signature="osa{sv}",
                body=[
                    session,
                    str(parent_window or ""),
                    {"handle_token": Variant("s", _token("start"))},
                ],
            )
        )

    async def _start_remote_desktop(self, session: str, parent_window: str) -> dict:
        return await self._request(
            self._call(
                path=PORTAL_PATH,
                interface=REMOTE_DESKTOP_INTERFACE,
                member="Start",
                signature="osa{sv}",
                body=[
                    session,
                    str(parent_window or ""),
                    {"handle_token": Variant("s", _token("remote_start"))},
                ],
            )
        )

    async def _notify(self, member: str, signature: str, body: list) -> None:
        await self._call(
            path=PORTAL_PATH,
            interface=REMOTE_DESKTOP_INTERFACE,
            member=member,
            signature=signature,
            body=body,
        )

    async def _open_pipewire(self, session: str) -> int:
        reply = await self._call(
            path=PORTAL_PATH,
            interface=SCREENCAST_INTERFACE,
            member="OpenPipeWireRemote",
            signature="oa{sv}",
            body=[session, {}],
        )
        index = reply.body[0]
        if not isinstance(index, int) or index < 0 or index >= len(reply.unix_fds):
            raise RuntimeError("portal did not return a PipeWire file descriptor")
        return reply.unix_fds[index]

    async def _close_session(self, session: str) -> None:
        await self._call(path=session, interface=SESSION_INTERFACE, member="Close")

    async def _request(self, call) -> dict:
        reply = await call
        path = reply.body[0]
        if not isinstance(path, str) or not path.startswith("/org/freedesktop/portal/desktop/request/"):
            raise RuntimeError("portal returned an invalid request handle")
        response = self._early_responses.pop(path, None)
        if response is None:
            waiter = self._loop.create_future()
            self._waiters[path] = waiter
            try:
                response = await asyncio.wait_for(waiter, timeout=self.timeout_seconds)
            finally:
                self._waiters.pop(path, None)
        code, results = response
        if code == 1:
            raise PermissionError("portal request was cancelled")
        if code != 0:
            raise RuntimeError("portal request failed")
        return results

    async def _call(
        self,
        *,
        path: str,
        interface: str,
        member: str,
        signature: str = "",
        body: list | None = None,
    ):
        reply = await self._bus.call(
            Message(
                destination=PORTAL_SERVICE,
                path=path,
                interface=interface,
                member=member,
                signature=signature,
                body=body or [],
            )
        )
        if reply is None or reply.message_type is MessageType.ERROR:
            raise RuntimeError(f"portal {member} call failed")
        return reply

    async def _disconnect(self) -> None:
        with self._session_callbacks_lock:
            self._session_callbacks.clear()
        self._bus.disconnect()
        await self._bus.wait_for_disconnect()
        fd = self._bus._sock.detach()
        if fd >= 0:
            os.close(fd)

    def _run(self, coroutine, *, timeout: float | None = None, allow_closed: bool = False):
        if self._closed and not allow_closed:
            coroutine.close()
            raise RuntimeError("portal transport is closed")
        future = asyncio.run_coroutine_threadsafe(coroutine, self._loop)
        try:
            return future.result(timeout=timeout or self.timeout_seconds + 5)
        except concurrent.futures.TimeoutError as error:
            future.cancel()
            raise TimeoutError("portal operation timed out") from error


def _token(prefix: str) -> str:
    return f"openagi_{prefix}_{secrets.token_hex(12)}"


def _unbox(value: Any):
    if isinstance(value, Variant):
        return _unbox(value.value)
    if isinstance(value, dict):
        return {str(key): _unbox(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return type(value)(_unbox(item) for item in value)
    return value
