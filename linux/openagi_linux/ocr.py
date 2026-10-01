from __future__ import annotations

import csv
import io
import os
import subprocess
from dataclasses import dataclass
from typing import Callable

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
MAX_IMAGE_BYTES = 16 * 1024 * 1024
MAX_TEXT_CHARS = 8_000


@dataclass(frozen=True)
class OcrResult:
    text: str
    confidence: float


class TesseractOcr:
    def __init__(
        self,
        executable: str = "/usr/bin/tesseract",
        languages: str = "eng+spa",
        run: Callable = subprocess.run,
    ) -> None:
        if not os.path.isabs(executable) or "\0" in executable:
            raise ValueError("Tesseract executable must be an absolute path")
        self.executable = executable
        self.languages = languages
        self._run = run

    def recognize(self, png: bytes) -> OcrResult:
        if not isinstance(png, bytes) or not png.startswith(PNG_SIGNATURE):
            raise ValueError("OCR input must be PNG data")
        if len(png) > MAX_IMAGE_BYTES:
            raise ValueError("OCR image exceeds the size limit")
        args = [
            self.executable,
            "stdin",
            "stdout",
            "--dpi",
            "144",
            "-l",
            self.languages,
            "--psm",
            "11",
            "-c",
            "tessedit_create_tsv=1",
        ]
        allowed_environment = {
            key: os.environ[key]
            for key in ("HOME", "LANG", "LANGUAGE", "LC_ALL", "TESSDATA_PREFIX", "OMP_THREAD_LIMIT")
            if os.environ.get(key)
        }
        if "LC_ALL" not in allowed_environment and "LANG" not in allowed_environment:
            allowed_environment["LC_ALL"] = "C.UTF-8"
        try:
            completed = self._run(
                args,
                input=png,
                capture_output=True,
                timeout=5,
                check=True,
                env=allowed_environment,
            )
        except (subprocess.TimeoutExpired, subprocess.CalledProcessError) as error:
            raise RuntimeError("Tesseract OCR failed") from error
        raw = bytes(completed.stdout)
        if len(raw) > 4 * 1024 * 1024:
            raise RuntimeError("Tesseract OCR output exceeded its limit")
        return parse_tsv(raw)


def parse_tsv(raw: bytes) -> OcrResult:
    try:
        text = raw.decode("utf-8", errors="strict")
    except UnicodeDecodeError as error:
        raise RuntimeError("Tesseract returned invalid UTF-8") from error
    words: list[str] = []
    confidences: list[float] = []
    reader = csv.DictReader(io.StringIO(text), delimiter="\t")
    for row in reader:
        word = str(row.get("text") or "").strip()
        if not word:
            continue
        try:
            confidence = float(row.get("conf") or -1)
        except ValueError:
            continue
        if confidence < 0:
            continue
        words.append(word)
        confidences.append(min(100.0, max(0.0, confidence)))
        if sum(len(part) + 1 for part in words) > MAX_TEXT_CHARS:
            break
    joined = " ".join(words).strip()[:MAX_TEXT_CHARS]
    score = sum(confidences) / len(confidences) / 100 if confidences else 0.0
    return OcrResult(text=joined, confidence=round(score, 4))
