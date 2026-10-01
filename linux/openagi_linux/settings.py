from __future__ import annotations

import os
import secrets
import shutil
from dataclasses import dataclass
from pathlib import Path

from .client import CompanionConfig


@dataclass(frozen=True)
class RuntimeSettings:
    client: CompanionConfig
    state_dir: Path
    socket_path: Path
    machine_id: str
    ocr_interval_seconds: float
    tesseract_path: str
    ocr_language: str
    excluded_apps: tuple[str, ...]
    excluded_title_terms: tuple[str, ...]

    @classmethod
    def from_environment(cls) -> "RuntimeSettings":
        home = Path(os.environ.get("HOME") or Path.home())
        state_root = Path(os.environ.get("XDG_STATE_HOME") or home / ".local" / "state")
        state_dir = state_root / "openagi" / "linux-companion"
        state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(state_dir, 0o700)

        runtime = os.environ.get("XDG_RUNTIME_DIR")
        if not runtime:
            raise ValueError("XDG_RUNTIME_DIR is required")
        runtime_dir = Path(runtime)
        if not runtime_dir.is_absolute() or not runtime_dir.is_dir():
            raise ValueError("XDG_RUNTIME_DIR is invalid")
        socket_path = runtime_dir / "openagi-linux-companion.sock"
        if len(os.fsencode(socket_path)) > 107:
            raise ValueError("companion Unix socket path is too long")

        base_url = os.environ.get("OPENAGI_LINUX_BASE_URL", "http://127.0.0.1:43210")
        token = os.environ.get("OPENAGI_AUTH_TOKEN") or None
        client = CompanionConfig(base_url=base_url, auth_token=token)

        raw_interval = os.environ.get("OPENAGI_LINUX_OCR_INTERVAL", "15")
        try:
            interval = float(raw_interval)
        except ValueError as error:
            raise ValueError("OCR interval is invalid") from error
        if not 1 <= interval <= 3_600:
            raise ValueError("OCR interval must be between 1 and 3600 seconds")

        tesseract = os.environ.get("OPENAGI_LINUX_TESSERACT") or shutil.which("tesseract")
        if not tesseract:
            raise ValueError("tesseract is unavailable")
        language = os.environ.get("OPENAGI_LINUX_OCR_LANGUAGE", "spa+eng").strip()
        if not language or len(language) > 100 or not all(part.isalnum() for part in language.split("+")):
            raise ValueError("OCR language list is invalid")

        return cls(
            client=client,
            state_dir=state_dir,
            socket_path=socket_path,
            machine_id=_machine_id(state_dir / "machine-id"),
            ocr_interval_seconds=interval,
            tesseract_path=tesseract,
            ocr_language=language,
            excluded_apps=_csv_values("OPENAGI_LINUX_EXCLUDED_APPS"),
            excluded_title_terms=_csv_values("OPENAGI_LINUX_EXCLUDED_TITLE_TERMS"),
        )


def _machine_id(path: Path) -> str:
    try:
        value = path.read_text(encoding="ascii").strip()
    except FileNotFoundError:
        value = ""
    if value.startswith("linux_") and len(value) == 38 and all(char in "0123456789abcdef" for char in value[6:]):
        os.chmod(path, 0o600)
        return value
    value = f"linux_{secrets.token_hex(16)}"
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    try:
        fd = os.open(path, flags, 0o600)
    except FileExistsError:
        existing = path.read_text(encoding="ascii").strip()
        if existing.startswith("linux_") and len(existing) == 38 and all(char in "0123456789abcdef" for char in existing[6:]):
            return existing
        raise ValueError("machine identity is invalid") from None
    with os.fdopen(fd, "w", encoding="ascii") as handle:
        handle.write(value)
        handle.flush()
        os.fsync(handle.fileno())
    return value


def _csv_values(name: str) -> tuple[str, ...]:
    values = tuple(part.strip() for part in os.environ.get(name, "").split(",") if part.strip())
    if len(values) > 100 or any(len(value) > 200 or any(ord(char) < 32 for char in value) for value in values):
        raise ValueError(f"{name} is invalid")
    return values
