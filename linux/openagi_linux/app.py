from __future__ import annotations

import argparse
import json
import os
import re
import signal
import shutil
import sys
from pathlib import Path

from PySide6.QtCore import QObject, QTimer, Signal
from PySide6.QtWidgets import QApplication, QSystemTrayIcon

from .capture import CapturePipeline, PrivacyPolicy
from .client import DaemonClient
from .control import ControlDispatcher
from .desktop_bridge import DesktopBridge
from .focus import FocusRegistry
from .gstreamer import PipeWireFrameSource
from .observer import ObservationLoop, ObservationWorker
from .ocr import TesseractOcr
from .outbox import ObservationOutbox
from .portal_backend import DbusPortal
from .portal_session import ControlPortalSession, RestoreTokenStore, ScreenCastSession
from .quick_ask import QuickAskContextProvider
from .rpc import RpcServer, systemd_unit_peer_authorizer
from .runtime import CompanionRuntime
from .settings import RuntimeSettings
from .ui import CompanionTray, QuickAskWindow


class _RuntimeSignals(QObject):
    quick_ask_requested = Signal()
    capture_revoked = Signal()
    control_revoked = Signal()


def _install_signal_handlers(application: QApplication) -> QTimer:
    def request_shutdown(_signum, _frame) -> None:
        application.quit()

    signal.signal(signal.SIGINT, request_shutdown)
    signal.signal(signal.SIGTERM, request_shutdown)
    timer = QTimer(application)
    timer.timeout.connect(lambda: None)
    timer.start(250)
    return timer


def doctor() -> dict:
    portal = DbusPortal()
    try:
        source_types = portal.available_source_types()
        cursor_modes = portal.available_cursor_modes()
        device_types = portal.available_device_types()
    finally:
        portal.close()
    tesseract = shutil.which("tesseract")
    wayland = os.environ.get("XDG_SESSION_TYPE", "").casefold() == "wayland" or bool(os.environ.get("WAYLAND_DISPLAY"))
    screen_ready = bool(source_types & 1) and bool(cursor_modes)
    control_ready = device_types & 3 == 3
    return {
        "ok": bool(wayland and screen_ready and control_ready and tesseract),
        "wayland": wayland,
        "tesseract": bool(tesseract),
        "portal": {
            "screenCastMonitor": bool(source_types & 1),
            "cursorModes": cursor_modes,
            "remoteDesktopKeyboardPointer": control_ready,
        },
        "systemTray": QSystemTrayIcon.isSystemTrayAvailable(),
    }


def build_runtime(application: QApplication, settings: RuntimeSettings) -> CompanionRuntime:
    client = DaemonClient(settings.client)
    focus = FocusRegistry()
    privacy = PrivacyPolicy(
        excluded_apps=PrivacyPolicy.DEFAULT_EXCLUDED_APPS + settings.excluded_apps,
        title_patterns=PrivacyPolicy.DEFAULT_TITLE_PATTERNS
        + tuple(re.escape(term) for term in settings.excluded_title_terms),
    )
    ocr = TesseractOcr(executable=settings.tesseract_path, languages=settings.ocr_language)
    outbox = ObservationOutbox(settings.state_dir / "observations.sqlite3")
    portal = DbusPortal()
    signals = _RuntimeSignals()
    capture = ScreenCastSession(
        portal=portal,
        token_store=RestoreTokenStore(settings.state_dir / "screencast-restore-token"),
        frame_source_factory=PipeWireFrameSource,
        on_revoked=signals.capture_revoked.emit,
    )
    control = ControlPortalSession(
        portal=portal,
        token_store=RestoreTokenStore(settings.state_dir / "remote-desktop-restore-token"),
        frame_source_factory=PipeWireFrameSource,
        on_revoked=signals.control_revoked.emit,
    )
    pipeline = CapturePipeline(
        machine_id=settings.machine_id,
        policy=privacy,
        ocr=ocr,
        outbox=outbox,
        sender=client.push_observations,
    )
    observer = ObservationWorker(
        focus_registry=focus,
        capture_session=capture,
        pipeline=pipeline,
        privacy=privacy,
        ocr_interval_seconds=settings.ocr_interval_seconds,
    )
    observer_loop = ObservationLoop(observer)
    context_provider = QuickAskContextProvider(focus, capture, ocr, privacy)
    quick_ask = QuickAskWindow(client=client, context_provider=context_provider)
    signals.quick_ask_requested.connect(quick_ask.show_quick_ask)
    desktop_bridge = DesktopBridge(on_report=focus.report_json, on_toggle=signals.quick_ask_requested.emit)
    dispatcher = ControlDispatcher(focus_registry=focus, control_session=control, privacy=privacy)
    rpc_server = RpcServer(
        settings.socket_path,
        handler=lambda request, context: dispatcher.handle(request, context=context),
        peer_authorizer=systemd_unit_peer_authorizer("openagi.service"),
    )

    holder: dict[str, CompanionRuntime] = {}
    tray = CompanionTray(
        on_quick_ask=quick_ask.show_quick_ask,
        on_capture_toggle=lambda _checked=False: holder["runtime"].toggle_capture(),
        on_control_toggle=lambda _checked=False: holder["runtime"].toggle_control(),
        on_pause_toggle=lambda paused: holder["runtime"].set_paused(paused),
        on_clear_context=lambda _checked=False: holder["runtime"].clear_context(),
        on_quit=application.quit,
    )
    runtime = CompanionRuntime(
        observer_loop=observer_loop,
        rpc_server=rpc_server,
        desktop_bridge=desktop_bridge,
        capture_session=capture,
        control_session=control,
        portal=portal,
        outbox=outbox,
        tray=tray,
        owned_objects=(quick_ask, signals),
    )
    holder["runtime"] = runtime
    signals.capture_revoked.connect(runtime.capture_revoked)
    signals.control_revoked.connect(runtime.control_revoked)
    return runtime


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="openagi-linux-companion")
    parser.add_argument("--doctor", action="store_true", help="check local dependencies without requesting permissions")
    parser.add_argument("--version", action="store_true")
    args = parser.parse_args(argv)
    if args.version:
        from . import __version__
        print(__version__)
        return 0
    existing = QApplication.instance()
    application = existing if isinstance(existing, QApplication) else QApplication(["openagi-linux-companion"])
    application.setApplicationName("OpenAGI Linux Companion")
    application.setDesktopFileName("sh.openagi.LinuxCompanion")
    application.setQuitOnLastWindowClosed(False)
    if args.doctor:
        try:
            report = doctor()
        except BaseException:
            report = {"ok": False, "error": "local companion dependency check failed"}
        print(json.dumps(report, separators=(",", ":"), sort_keys=True))
        return 0 if report.get("ok") else 1
    try:
        settings = RuntimeSettings.from_environment()
        runtime = build_runtime(application, settings)
        application.aboutToQuit.connect(runtime.close)
        runtime.start()
        shutdown_timer = _install_signal_handlers(application)
    except BaseException:
        print("openagi-linux-companion: startup failed", file=sys.stderr)
        return 1
    try:
        return application.exec()
    finally:
        shutdown_timer.stop()


if __name__ == "__main__":
    raise SystemExit(main())
