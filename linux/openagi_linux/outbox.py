from __future__ import annotations

import json
import os
import sqlite3
import threading
import time
from pathlib import Path
from typing import Callable


class ObservationOutbox:
    def __init__(
        self,
        path: Path,
        *,
        max_batches: int = 256,
        max_total_bytes: int = 8 * 1024 * 1024,
        max_age_seconds: float = 24 * 60 * 60,
        clock: Callable[[], float] = time.time,
    ) -> None:
        if max_batches < 1 or max_total_bytes < 1 or max_age_seconds <= 0:
            raise ValueError("observation outbox limits must be positive")
        self.path = Path(path)
        self.max_batches = max_batches
        self.max_total_bytes = max_total_bytes
        self.max_age_seconds = max_age_seconds
        self._clock = clock
        self.dropped_count = 0
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        self._lock = threading.RLock()
        self._closed = False
        self._db = sqlite3.connect(self.path, check_same_thread=False)
        self._db.execute("PRAGMA secure_delete = ON")
        try:
            os.chmod(self.path, 0o600)
        except OSError:
            pass
        self._db.execute(
            "CREATE TABLE IF NOT EXISTS batches ("
            "id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT NOT NULL, created_at REAL NOT NULL)"
        )
        self._db.commit()
        with self._lock:
            self._prune_locked()

    def enqueue(self, envelope: dict) -> int:
        body = json.dumps(envelope, ensure_ascii=False, separators=(",", ":"))
        if len(body.encode("utf-8")) > 2 * 1024 * 1024:
            raise ValueError("observation batch exceeds the transport limit")
        with self._lock:
            self._require_open()
            cursor = self._db.execute(
                "INSERT INTO batches (body, created_at) VALUES (?, ?)",
                (body, self._clock()),
            )
            self._prune_locked()
            self._db.commit()
            if cursor.lastrowid is None:
                raise RuntimeError("observation batch was not persisted")
            return int(cursor.lastrowid)

    def pending_count(self) -> int:
        with self._lock:
            self._require_open()
            self._prune_locked()
            return int(self._db.execute("SELECT COUNT(*) FROM batches").fetchone()[0])

    def flush(self, sender: Callable[[dict], bool], limit: int = 16) -> int:
        with self._lock:
            self._require_open()
            self._prune_locked()
            sent = 0
            rows = self._db.execute("SELECT id, body FROM batches ORDER BY id LIMIT ?", (max(1, min(limit, 256)),)).fetchall()
            for row_id, body in rows:
                envelope = json.loads(body)
                try:
                    accepted = sender(envelope) is True
                except Exception:
                    accepted = False
                if not accepted:
                    break
                self._db.execute("DELETE FROM batches WHERE id = ?", (row_id,))
                self._db.commit()
                sent += 1
            return sent

    def clear(self) -> int:
        with self._lock:
            self._require_open()
            count = int(self._db.execute("SELECT COUNT(*) FROM batches").fetchone()[0])
            self._db.execute("DELETE FROM batches")
            self._db.commit()
            return count

    def close(self) -> None:
        with self._lock:
            if self._closed:
                return
            self._db.close()
            self._closed = True

    def _require_open(self) -> None:
        if self._closed:
            raise RuntimeError("observation outbox is closed")

    def _prune_locked(self) -> None:
        threshold = self._clock() - self.max_age_seconds
        cursor = self._db.execute("DELETE FROM batches WHERE created_at < ?", (threshold,))
        self.dropped_count += max(0, cursor.rowcount)
        rows = self._db.execute("SELECT id, LENGTH(CAST(body AS BLOB)) FROM batches ORDER BY id").fetchall()
        total_bytes = sum(int(row[1]) for row in rows)
        excess_rows = max(0, len(rows) - self.max_batches)
        remove_ids = []
        for row_id, size in rows:
            if excess_rows <= 0 and total_bytes <= self.max_total_bytes:
                break
            remove_ids.append(int(row_id))
            total_bytes -= int(size)
            excess_rows = max(0, excess_rows - 1)
        if remove_ids:
            self._db.executemany("DELETE FROM batches WHERE id = ?", ((row_id,) for row_id in remove_ids))
            self.dropped_count += len(remove_ids)
        self._db.commit()
