from __future__ import annotations

import json
import os
import re
import select
import socket
import stat
import struct
import threading
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

MAX_REQUEST_BYTES = 1024 * 1024
MAX_RESPONSE_BYTES = 16 * 1024 * 1024
MAX_DEADLINE_AHEAD_MS = 60_000


class RequestCancelled(RuntimeError):
    pass


class RequestExpired(RuntimeError):
    pass


@dataclass(frozen=True)
class RpcContext:
    action_id: str
    deadline_epoch_ms: int
    peer_pid: int
    cancelled: threading.Event
    authorization: dict | None

    def check_active(self) -> None:
        if self.cancelled.is_set():
            raise RequestCancelled("RPC client disconnected")
        if int(time.time() * 1000) >= self.deadline_epoch_ms:
            raise RequestExpired("RPC request expired")


class RpcServer:
    def __init__(
        self,
        path: Path,
        *,
        handler: Callable[[dict, RpcContext], dict],
        peer_authorizer: Callable[[int], bool] | None = None,
    ) -> None:
        self.path = Path(path)
        self.handler = handler
        self.peer_authorizer = peer_authorizer
        self._closed = threading.Event()
        self._ready = threading.Event()
        self._error: BaseException | None = None
        self._socket: socket.socket | None = None
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        if self._thread is not None:
            raise RuntimeError("RPC server is already started")
        self._thread = threading.Thread(target=self._serve, name="openagi-rpc", daemon=True)
        self._thread.start()
        if not self._ready.wait(timeout=5):
            raise TimeoutError("RPC server did not start")
        if self._error is not None:
            raise RuntimeError("RPC server could not start") from self._error

    def close(self) -> None:
        self._closed.set()
        sock = self._socket
        if sock is not None:
            try:
                sock.close()
            except OSError:
                pass
        thread = self._thread
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout=5)
        self._thread = None
        self._socket = None
        try:
            info = self.path.lstat()
            if stat.S_ISSOCK(info.st_mode) and info.st_uid == os.getuid():
                self.path.unlink()
        except FileNotFoundError:
            pass

    def _serve(self) -> None:
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            _remove_stale_owned_socket(self.path)
            sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            self._socket = sock
            sock.bind(str(self.path))
            os.chmod(self.path, 0o600)
            sock.listen(8)
            sock.settimeout(0.25)
        except BaseException as error:
            self._error = error
            self._ready.set()
            return
        self._ready.set()
        while not self._closed.is_set():
            try:
                connection, _ = sock.accept()
            except TimeoutError:
                continue
            except OSError:
                break
            with connection:
                response = self._handle_connection(connection)
                try:
                    encoded = _encode_response(response)
                    connection.sendall(encoded)
                except OSError:
                    pass

    def _handle_connection(self, connection: socket.socket) -> dict:
        try:
            credentials = connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i"))
            pid, uid, _gid = struct.unpack("3i", credentials)
            if uid != os.getuid():
                return _error("access_denied", "RPC peer does not own the companion session")
            raw = _read_bounded(connection, MAX_REQUEST_BYTES)
            wire = json.loads(raw)
            _validate_wire_request(wire)
            if wire["action"] != "status" and self.peer_authorizer is not None and not self.peer_authorizer(pid):
                return _error("access_denied", "RPC peer is outside the authorized OpenAGI service")
            meta = wire["meta"]
            now_ms = int(time.time() * 1000)
            deadline_ms = int(meta["deadlineMs"])
            if deadline_ms <= now_ms:
                return _error("request_expired", "RPC request deadline expired")
            if deadline_ms - now_ms > MAX_DEADLINE_AHEAD_MS:
                return _error("invalid_request", "RPC request deadline is invalid")
            authorization = meta["authorization"]
            if wire["action"] != "status" and authorization is None:
                return _error("approval_required", "computer action is missing node lease authority")
            if authorization is not None:
                if authorization["expiresAtMs"] <= now_ms:
                    return _error("request_expired", "computer-use node lease expired")
                if deadline_ms > authorization["expiresAtMs"]:
                    return _error("invalid_request", "RPC deadline exceeds the node lease")
            cancelled = threading.Event()
            context = RpcContext(
                action_id=meta["actionId"],
                deadline_epoch_ms=deadline_ms,
                peer_pid=pid,
                cancelled=cancelled,
                authorization=authorization,
            )
            monitor_stop = threading.Event()
            monitor = threading.Thread(
                target=_watch_peer_disconnect,
                args=(connection, cancelled, monitor_stop),
                name="openagi-rpc-peer",
                daemon=True,
            )
            monitor.start()
            try:
                context.check_active()
                response = self.handler(
                    {"action": wire["action"], "payload": wire["payload"]},
                    context,
                )
                context.check_active()
            finally:
                monitor_stop.set()
                monitor.join(timeout=1)
            if not isinstance(response, dict):
                raise TypeError("handler response is not an object")
            return response
        except RequestCancelled:
            return _error("request_cancelled", "RPC request was cancelled")
        except RequestExpired:
            return _error("request_expired", "RPC request deadline expired")
        except (ValueError, TypeError, json.JSONDecodeError, UnicodeDecodeError):
            return _error("invalid_request", "RPC request is invalid")
        except BaseException:
            return _error("internal_error", "RPC operation failed")


class RpcClient:
    def __init__(self, path: Path, timeout_seconds: float = 15.0) -> None:
        self.path = Path(path)
        self.timeout_seconds = timeout_seconds

    def call(
        self,
        request: dict,
        *,
        action_id: str | None = None,
        deadline_epoch_ms: int | None = None,
        authorization: dict | None = None,
    ) -> dict:
        _validate_request(request)
        wire = {
            **request,
            "meta": {
                "actionId": action_id or str(uuid.uuid4()),
                "deadlineMs": deadline_epoch_ms or int(time.time() * 1000 + self.timeout_seconds * 1000),
                "authorization": authorization,
            },
        }
        _validate_wire_request(wire)
        encoded = json.dumps(wire, ensure_ascii=False, separators=(",", ":")).encode("utf-8") + b"\n"
        if len(encoded) > MAX_REQUEST_BYTES:
            raise ValueError("RPC request is too large")
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
            sock.settimeout(self.timeout_seconds)
            sock.connect(str(self.path))
            sock.sendall(encoded)
            sock.shutdown(socket.SHUT_WR)
            raw = _read_bounded(sock, MAX_RESPONSE_BYTES)
        response = json.loads(raw)
        if not isinstance(response, dict) or not isinstance(response.get("ok"), bool):
            raise RuntimeError("companion returned an invalid RPC response")
        return response


def _read_bounded(sock: socket.socket, limit: int) -> str:
    output = bytearray()
    while True:
        chunk = sock.recv(min(64 * 1024, limit + 1 - len(output)))
        if not chunk:
            break
        output.extend(chunk)
        if len(output) > limit:
            raise ValueError("RPC message is too large")
        if b"\n" in chunk:
            break
    raw = bytes(output).split(b"\n", 1)[0]
    if not raw:
        raise ValueError("RPC message is empty")
    return raw.decode("utf-8")


def _validate_request(request: dict) -> None:
    if not isinstance(request, dict) or set(request) != {"action", "payload"}:
        raise ValueError("RPC request fields are invalid")
    action = request["action"]
    payload = request["payload"]
    if not isinstance(action, str) or not action or len(action) > 100 or not action.replace("_", "").isalnum():
        raise ValueError("RPC action is invalid")
    if not isinstance(payload, dict):
        raise ValueError("RPC payload is invalid")
    try:
        encoded = json.dumps(request, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
    except (TypeError, ValueError) as error:
        raise ValueError("RPC payload is invalid") from error
    if len(encoded) + 1 > MAX_REQUEST_BYTES:
        raise ValueError("RPC request is too large")


def _validate_wire_request(request: dict) -> None:
    if not isinstance(request, dict) or set(request) != {"action", "payload", "meta"}:
        raise ValueError("RPC request fields are invalid")
    _validate_request({"action": request["action"], "payload": request["payload"]})
    meta = request["meta"]
    if not isinstance(meta, dict) or set(meta) != {"actionId", "deadlineMs", "authorization"}:
        raise ValueError("RPC request metadata is invalid")
    try:
        parsed_id = uuid.UUID(meta["actionId"])
    except (AttributeError, TypeError, ValueError):
        raise ValueError("RPC action identity is invalid") from None
    deadline = meta["deadlineMs"]
    if str(parsed_id) != meta["actionId"] or isinstance(deadline, bool) or not isinstance(deadline, int) or deadline <= 0:
        raise ValueError("RPC request metadata is invalid")
    authorization = meta["authorization"]
    if authorization is None:
        return
    if not isinstance(authorization, dict) or set(authorization) != {
        "leaseId", "actionId", "sequence", "expiresAtMs",
    }:
        raise ValueError("RPC node authority is invalid")
    for key in ("leaseId", "actionId"):
        value = authorization[key]
        if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9:_-]{1,240}", value):
            raise ValueError("RPC node authority is invalid")
    sequence = authorization["sequence"]
    expires_at = authorization["expiresAtMs"]
    if (
        isinstance(sequence, bool) or not isinstance(sequence, int)
        or sequence < 1 or sequence > 9_007_199_254_740_991
        or isinstance(expires_at, bool) or not isinstance(expires_at, int) or expires_at <= 0
    ):
        raise ValueError("RPC node authority is invalid")


def _encode_response(response: dict) -> bytes:
    encoded = json.dumps(response, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8") + b"\n"
    if len(encoded) > MAX_RESPONSE_BYTES:
        return json.dumps(_error("response_too_large", "RPC response exceeded the safety limit")).encode("utf-8") + b"\n"
    return encoded


def _error(code: str, message: str) -> dict:
    return {"ok": False, "error": {"code": code, "message": message}}


def _remove_stale_owned_socket(path: Path) -> None:
    try:
        info = path.lstat()
    except FileNotFoundError:
        return
    if not stat.S_ISSOCK(info.st_mode) or info.st_uid != os.getuid():
        raise RuntimeError("refusing to replace a non-owned RPC path")
    path.unlink()


def _watch_peer_disconnect(connection: socket.socket, cancelled: threading.Event, stop: threading.Event) -> None:
    poller = select.poll()
    poller.register(connection, select.POLLERR | select.POLLHUP | select.POLLNVAL)
    while not stop.is_set():
        events = poller.poll(50)
        if any(flags & (select.POLLERR | select.POLLHUP | select.POLLNVAL) for _fd, flags in events):
            cancelled.set()
            return


def systemd_unit_peer_authorizer(unit: str, *, proc_root: Path = Path("/proc")) -> Callable[[int], bool]:
    if not isinstance(unit, str) or not re.fullmatch(r"[A-Za-z0-9_.@-]{1,128}\.service", unit):
        raise ValueError("authorized systemd unit is invalid")

    def authorize(pid: int) -> bool:
        try:
            raw = (proc_root / str(pid) / "cgroup").read_text(encoding="utf-8")
        except (OSError, UnicodeError):
            return False
        if len(raw.encode("utf-8")) > 64 * 1024:
            return False
        for line in raw.splitlines():
            fields = line.split(":", 2)
            if len(fields) == 3 and fields[2].rstrip("/").rsplit("/", 1)[-1] == unit:
                return True
        return False

    return authorize
