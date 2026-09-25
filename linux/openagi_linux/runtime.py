from __future__ import annotations


class CompanionRuntime:
    def __init__(
        self,
        *,
        observer_loop,
        rpc_server,
        desktop_bridge,
        capture_session,
        control_session,
        portal,
        outbox,
        tray,
        owned_objects=(),
    ) -> None:
        self.observer_loop = observer_loop
        self.rpc_server = rpc_server
        self.desktop_bridge = desktop_bridge
        self.capture_session = capture_session
        self.control_session = control_session
        self.portal = portal
        self.outbox = outbox
        self.tray = tray
        self.owned_objects = tuple(owned_objects)
        self._started = False
        self._closed = False

    def start(self) -> None:
        if self._started:
            return
        self.desktop_bridge.start()
        self.rpc_server.start()
        self.observer_loop.start()
        self.tray.show()
        self._started = True

    def toggle_capture(self, _checked: bool = False) -> None:
        if self.capture_session.ready:
            self.capture_session.close()
            self.tray.set_capture_enabled(False)
            return
        try:
            self.capture_session.start()
        except BaseException:
            self.tray.showMessage("OpenAGI", "Screen context permission was not granted.")
            self.tray.set_capture_enabled(False)
            return
        self.tray.set_capture_enabled(True)

    def toggle_control(self, _checked: bool = False) -> None:
        if self.control_session.ready:
            self.control_session.close()
            self.tray.set_control_enabled(False)
            return
        try:
            self.control_session.start()
        except BaseException:
            self.tray.showMessage("OpenAGI", "Computer-control permission was not granted.")
            self.tray.set_control_enabled(False)
            return
        self.tray.set_control_enabled(True)

    def set_paused(self, paused: bool) -> None:
        self.observer_loop.set_paused(paused)

    def capture_revoked(self) -> None:
        self.tray.set_capture_enabled(False)
        self.tray.showMessage("OpenAGI", "Screen-context permission was revoked.")

    def control_revoked(self) -> None:
        self.tray.set_control_enabled(False)
        self.tray.showMessage("OpenAGI", "Computer-control permission was revoked.")

    def clear_context(self) -> None:
        deleted = self.outbox.clear()
        noun = "batch" if deleted == 1 else "batches"
        self.tray.showMessage("OpenAGI", f"Deleted {deleted} queued observation {noun}.")

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        self.tray.hide()
        for component in (
            self.observer_loop,
            self.rpc_server,
            self.desktop_bridge,
            self.capture_session,
            self.control_session,
            self.portal,
            self.outbox,
        ):
            try:
                component.close()
            except BaseException:
                pass
        for qt_object in (*self.owned_objects, self.tray):
            close = getattr(qt_object, "close", None)
            if callable(close):
                try:
                    close()
                except BaseException:
                    pass
            delete_later = getattr(qt_object, "deleteLater", None)
            if callable(delete_later):
                try:
                    delete_later()
                except BaseException:
                    pass
        self.owned_objects = ()
