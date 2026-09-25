from __future__ import annotations

from PySide6.QtCore import QObject, QRunnable, QThreadPool, Qt, Signal, Slot
from PySide6.QtGui import QAction, QColor, QIcon, QKeySequence, QPainter, QPixmap, QShortcut
from PySide6.QtWidgets import (
    QDialog,
    QHBoxLayout,
    QLabel,
    QMenu,
    QPushButton,
    QSystemTrayIcon,
    QTextBrowser,
    QTextEdit,
    QVBoxLayout,
)


class _AskSignals(QObject):
    succeeded = Signal(str)
    failed = Signal(str)
    delta = Signal(str)


class _AskTask(QRunnable):
    def __init__(self, client, text: str, context: dict | None) -> None:
        super().__init__()
        self.client = client
        self.text = text
        self.context = context
        self.signals = _AskSignals()

    @Slot()
    def run(self) -> None:
        try:
            result = self.client.ask(
                self.text,
                screen_context=self.context,
                on_event=self._on_event,
            )
        except BaseException:
            self.signals.failed.emit("Quick Ask could not reach OpenAGI.")
            return
        self.signals.succeeded.emit(result.reply)

    def _on_event(self, name: str, data: dict) -> None:
        if name == "delta":
            text = data.get("text") or data.get("delta") or data.get("content")
            if isinstance(text, str) and text:
                self.signals.delta.emit(text[:32_000])


class QuickAskWindow(QDialog):
    def __init__(self, *, client, context_provider, thread_pool: QThreadPool | None = None) -> None:
        super().__init__()
        self.client = client
        self.context_provider = context_provider
        self.thread_pool = thread_pool or QThreadPool.globalInstance()
        self.frozen_context: dict | None = None
        self._active_task = None

        self.setWindowTitle("OpenAGI Quick Ask")
        self.setObjectName("openagiQuickAsk")
        self.setWindowFlag(Qt.WindowType.WindowStaysOnTopHint, True)
        self.setWindowFlag(Qt.WindowType.Tool, True)
        self.resize(620, 440)

        self.status = QLabel("Ask OpenAGI about what you were working on.")
        self.prompt = QTextEdit()
        self.prompt.setPlaceholderText("Ask OpenAGI…")
        self.prompt.setAcceptRichText(False)
        self.prompt.setMaximumHeight(130)
        self.response = QTextBrowser()
        self.response.setOpenExternalLinks(False)
        self.submit_button = QPushButton("Ask")
        self.close_button = QPushButton("Hide")

        buttons = QHBoxLayout()
        buttons.addStretch(1)
        buttons.addWidget(self.close_button)
        buttons.addWidget(self.submit_button)
        layout = QVBoxLayout(self)
        layout.addWidget(self.status)
        layout.addWidget(self.prompt)
        layout.addLayout(buttons)
        layout.addWidget(self.response, 1)

        self.submit_button.clicked.connect(self.submit)
        self.close_button.clicked.connect(self.hide)
        QShortcut(QKeySequence("Ctrl+Return"), self, activated=self.submit)
        QShortcut(QKeySequence("Escape"), self, activated=self.hide)

    @Slot()
    def show_quick_ask(self) -> None:
        self.frozen_context = self.context_provider.freeze()
        self.status.setText(
            "Screen context captured locally." if self.frozen_context else "No screen context attached."
        )
        self.show()
        self.raise_()
        self.activateWindow()
        self.prompt.setFocus(Qt.FocusReason.ShortcutFocusReason)

    @Slot()
    def submit(self) -> None:
        text = self.prompt.toPlainText().strip()
        if not text or not self.submit_button.isEnabled():
            return
        self.submit_button.setEnabled(False)
        self.prompt.setEnabled(False)
        self.response.setPlainText("Thinking…")
        self.status.setText("OpenAGI is answering…")
        task = _AskTask(self.client, text, self.frozen_context)
        self._active_task = task
        task.signals.delta.connect(self._show_delta)
        task.signals.succeeded.connect(self._show_result)
        task.signals.failed.connect(self._show_error)
        self.thread_pool.start(task)

    @Slot(str)
    def _show_delta(self, text: str) -> None:
        if self.response.toPlainText() == "Thinking…":
            self.response.clear()
        self.response.insertPlainText(text)

    @Slot(str)
    def _show_result(self, text: str) -> None:
        self.response.setPlainText(text)
        self.prompt.clear()
        self.status.setText("Answer complete.")
        self._finish()

    @Slot(str)
    def _show_error(self, text: str) -> None:
        self.response.setPlainText(text)
        self.status.setText("Quick Ask failed.")
        self._finish()

    def _finish(self) -> None:
        self.submit_button.setEnabled(True)
        self.prompt.setEnabled(True)
        self._active_task = None


class CompanionTray(QSystemTrayIcon):
    def __init__(
        self,
        *,
        on_quick_ask,
        on_capture_toggle,
        on_control_toggle,
        on_pause_toggle,
        on_clear_context,
        on_quit,
    ) -> None:
        super().__init__(_tray_icon())
        self.setToolTip("OpenAGI Linux companion")
        menu = QMenu()
        self.quick_ask_action = QAction("Quick Ask", menu)
        self.capture_action = QAction("Enable screen context…", menu)
        self.control_action = QAction("Enable computer control…", menu)
        self.pause_action = QAction("Pause observations", menu)
        self.pause_action.setCheckable(True)
        self.clear_context_action = QAction("Delete queued screen context", menu)
        self.quit_action = QAction("Quit companion", menu)
        menu.addAction(self.quick_ask_action)
        menu.addSeparator()
        menu.addAction(self.capture_action)
        menu.addAction(self.control_action)
        menu.addAction(self.pause_action)
        menu.addAction(self.clear_context_action)
        menu.addSeparator()
        menu.addAction(self.quit_action)
        self.setContextMenu(menu)
        self.quick_ask_action.triggered.connect(on_quick_ask)
        self.capture_action.triggered.connect(on_capture_toggle)
        self.control_action.triggered.connect(on_control_toggle)
        self.pause_action.toggled.connect(on_pause_toggle)
        self.clear_context_action.triggered.connect(on_clear_context)
        self.quit_action.triggered.connect(on_quit)
        self.activated.connect(self._activated)
        self._on_quick_ask = on_quick_ask

    @Slot(bool)
    def set_capture_enabled(self, enabled: bool) -> None:
        self.capture_action.setText("Disable screen context" if enabled else "Enable screen context…")

    @Slot(bool)
    def set_control_enabled(self, enabled: bool) -> None:
        self.control_action.setText("Disable computer control" if enabled else "Enable computer control…")

    @Slot(QSystemTrayIcon.ActivationReason)
    def _activated(self, reason) -> None:
        if reason == QSystemTrayIcon.ActivationReason.Trigger:
            self._on_quick_ask()


def _tray_icon() -> QIcon:
    pixmap = QPixmap(32, 32)
    pixmap.fill(QColor("#111827"))
    painter = QPainter(pixmap)
    painter.setPen(QColor("#60a5fa"))
    font = painter.font()
    font.setBold(True)
    font.setPixelSize(15)
    painter.setFont(font)
    painter.drawText(pixmap.rect(), Qt.AlignmentFlag.AlignCenter, "AG")
    painter.end()
    return QIcon(pixmap)
