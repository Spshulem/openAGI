import asyncio
import concurrent.futures
import os
import threading

from dbus_next.aio.message_bus import MessageBus
from dbus_next.constants import BusType, ErrorType, MessageType, NameFlag, RequestNameReply
from dbus_next.message import Message
from dbus_next.service import ServiceInterface, method

OBJECT_PATH = "/org/openagi/LinuxCompanion"
INTERFACE_NAME = "org.openagi.LinuxCompanion"
KWIN_SERVICE = "org.kde.KWin"


class _CompanionInterface(ServiceInterface):
    def __init__(self, on_report, on_toggle):
        super().__init__(INTERFACE_NAME)
        self._on_report = on_report
        self._on_toggle = on_toggle

    @method()
    def ReportWindow(self, payload: "s") -> "b":
        return bool(self._on_report(payload))

    @method()
    def ToggleQuickAsk(self) -> "":
        self._on_toggle()


class DesktopBridge:
    def __init__(self, *, on_report, on_toggle, service_name: str = "org.openagi.LinuxCompanion") -> None:
        self.on_report = on_report
        self.on_toggle = on_toggle
        self.service_name = service_name
        self._loop = asyncio.new_event_loop()
        self._ready: concurrent.futures.Future = concurrent.futures.Future()
        self._closed = False
        self._thread = None

    def start(self) -> None:
        if self._thread is not None:
            raise RuntimeError("desktop bridge is already started")
        self._thread = threading.Thread(target=self._thread_main, name="openagi-desktop-bridge", daemon=True)
        self._thread.start()
        self._ready.result(timeout=10)

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        if self._thread is None:
            return
        future = asyncio.run_coroutine_threadsafe(self._disconnect(), self._loop)
        future.result(timeout=10)
        self._loop.call_soon_threadsafe(self._loop.stop)
        self._thread.join(timeout=10)
        self._thread = None

    def _thread_main(self) -> None:
        asyncio.set_event_loop(self._loop)
        try:
            self._loop.run_until_complete(self._connect())
        except BaseException as error:
            self._ready.set_exception(error)
            return
        self._ready.set_result(True)
        self._loop.run_forever()
        self._loop.close()

    async def _connect(self) -> None:
        self._bus = await MessageBus(bus_type=BusType.SESSION).connect()
        owner_reply = await self._bus.call(Message(
            destination="org.freedesktop.DBus",
            path="/org/freedesktop/DBus",
            interface="org.freedesktop.DBus",
            member="GetNameOwner",
            signature="s",
            body=[KWIN_SERVICE],
        ))
        if owner_reply is None or owner_reply.message_type is MessageType.ERROR or not owner_reply.body:
            raise RuntimeError("KWin D-Bus owner is unavailable")
        self._kwin_owner = str(owner_reply.body[0])
        self._bus.add_message_handler(self._authorize_message)
        self._interface = _CompanionInterface(self.on_report, self.on_toggle)
        self._bus.export(OBJECT_PATH, self._interface)
        result = await self._bus.request_name(self.service_name, NameFlag.DO_NOT_QUEUE)
        if result not in {RequestNameReply.PRIMARY_OWNER, RequestNameReply.ALREADY_OWNER}:
            raise RuntimeError("another OpenAGI Linux companion owns the desktop bridge")

    async def _disconnect(self) -> None:
        self._bus.remove_message_handler(self._authorize_message)
        self._bus.unexport(OBJECT_PATH, self._interface)
        await self._bus.release_name(self.service_name)
        self._bus.disconnect()
        await self._bus.wait_for_disconnect()
        fd = self._bus._sock.detach()
        if fd >= 0:
            os.close(fd)

    def _authorize_message(self, message):
        protected = (
            message.message_type is MessageType.METHOD_CALL
            and message.path == OBJECT_PATH
            and message.interface == INTERFACE_NAME
            and message.member in {"ReportWindow", "ToggleQuickAsk"}
        )
        if not protected or message.sender == self._kwin_owner:
            return None
        return Message.new_error(
            message,
            ErrorType.ACCESS_DENIED.value,
            "OpenAGI desktop reports are accepted only from KWin",
        )
